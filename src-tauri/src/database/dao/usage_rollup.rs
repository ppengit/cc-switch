//! Usage rollup DAO
//!
//! Aggregates proxy_request_logs into daily rollups and prunes old detail rows.

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::services::sql_helpers::{fresh_input_sql, INPUT_TOKEN_SEMANTICS_FRESH};
use crate::services::usage_stats::{
    effective_archive_usage_log_filter, effective_usage_log_filter,
    SESSION_PROXY_DEDUP_WINDOW_SECONDS,
};
use chrono::{Duration, Local, TimeZone};
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};

const REQUEST_LOG_RETENTION_SETTING_KEY: &str = "usage_request_log_retention_v1";
const USAGE_ARCHIVE_UPSERT_SQL: &str = "ON CONFLICT(request_id, created_at) DO UPDATE SET
        provider_id = excluded.provider_id,
        app_type = excluded.app_type,
        model = excluded.model,
        request_model = excluded.request_model,
        pricing_model = excluded.pricing_model,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        input_token_semantics = excluded.input_token_semantics,
        input_cost_usd = excluded.input_cost_usd,
        output_cost_usd = excluded.output_cost_usd,
        cache_read_cost_usd = excluded.cache_read_cost_usd,
        cache_creation_cost_usd = excluded.cache_creation_cost_usd,
        total_cost_usd = excluded.total_cost_usd,
        cost_multiplier = excluded.cost_multiplier,
        latency_ms = excluded.latency_ms,
        status_code = excluded.status_code,
        data_source = excluded.data_source";
/// Raw request logs are rendered in the UI and therefore deliberately kept
/// tiny. Historical statistics move to the archive/daily-rollup tiers.
pub const DEFAULT_REQUEST_LOG_RETAIN_COUNT: u32 = 50;
pub const MIN_REQUEST_LOG_RETAIN_COUNT: u32 = 1;
pub const MAX_REQUEST_LOG_RETAIN_COUNT: u32 = 1_000_000;
/// Avoid opening a write transaction for every few requests during sustained
/// traffic. The explicit cleanup command and retention-setting update still
/// call `prune_request_logs_to_minimum` directly and converge immediately.
const REQUEST_LOG_RETENTION_HYSTERESIS_ROWS: i64 = 100;
/// Precise per-request facts are retained long enough for recent queries and
/// cross-source deduplication. Older facts are compacted into daily rollups.
pub const MAX_REQUEST_STATS_ARCHIVE_ROWS: i64 = 50_000;

// A compacted proxy fact keeps a short fingerprint guard so a delayed session
// import cannot reintroduce it as a second usage record after the precise row
// has moved to the minute tier.
const PROXY_DEDUP_GUARD_TTL_SECONDS: i64 = SESSION_PROXY_DEDUP_WINDOW_SECONDS * 2;
const SESSION_DATA_SOURCE_FILTER: &str =
    "'session_log', 'codex_session', 'gemini_session', 'hermes_session', 'opencode_session'";
const ARCHIVE_COMPACTION_CANDIDATES: &str = "usage_archive_compaction_candidates";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRetentionConfig {
    auto_cleanup_enabled: bool,
    retain_count: u32,
}

impl Default for StoredRetentionConfig {
    fn default() -> Self {
        Self {
            auto_cleanup_enabled: true,
            retain_count: DEFAULT_REQUEST_LOG_RETAIN_COUNT,
        }
    }
}

impl StoredRetentionConfig {
    fn normalized(mut self) -> Self {
        self.retain_count = self
            .retain_count
            .clamp(MIN_REQUEST_LOG_RETAIN_COUNT, MAX_REQUEST_LOG_RETAIN_COUNT);
        self
    }
}

/// Compute the rollup/prune cutoff aligned to a local-day boundary.
///
/// Anything strictly older than the returned timestamp will be aggregated into
/// `usage_daily_rollups` and deleted from `proxy_request_logs`. Aligning to the
/// next local midnight after `(now - retain_days)` guarantees that the youngest
/// rollup row always represents a *complete* local day. Without this alignment
/// the cutoff falls mid-day, leaving the day half-rolled-up and half-pruned —
/// which would silently under-count any range query that touches that day
/// after `compute_rollup_date_bounds` trims partial-coverage rollup days.
fn compute_local_midnight_cutoff(
    now: chrono::DateTime<Local>,
    retain_days: i64,
) -> Result<i64, AppError> {
    let target_day = now
        .checked_sub_signed(Duration::days(retain_days))
        .ok_or_else(|| AppError::Database("rollup cutoff overflow".to_string()))?
        .date_naive();

    // Use the *next* day's midnight so anything before it has fully been bucketed.
    let next_day = target_day
        .succ_opt()
        .ok_or_else(|| AppError::Database("rollup cutoff next-day overflow".to_string()))?;
    let naive_midnight = next_day
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| AppError::Database("rollup cutoff midnight overflow".to_string()))?;

    let local_dt = match Local.from_local_datetime(&naive_midnight) {
        chrono::LocalResult::Single(dt) => dt,
        chrono::LocalResult::Ambiguous(earliest, _) => earliest,
        chrono::LocalResult::None => {
            // DST gap: fall back to one hour later, which always exists.
            let bumped = naive_midnight + Duration::hours(1);
            match Local.from_local_datetime(&bumped) {
                chrono::LocalResult::Single(dt) => dt,
                chrono::LocalResult::Ambiguous(earliest, _) => earliest,
                chrono::LocalResult::None => {
                    return Err(AppError::Database(
                        "rollup cutoff fell into DST gap".to_string(),
                    ))
                }
            }
        }
    };

    Ok(local_dt.timestamp())
}

impl Database {
    /// Aggregate proxy_request_logs older than `retain_days` into usage_daily_rollups,
    /// then delete the aggregated detail rows.
    /// Returns the number of deleted detail rows.
    pub fn rollup_and_prune(&self, retain_days: i64) -> Result<u64, AppError> {
        let cutoff = compute_local_midnight_cutoff(Local::now(), retain_days)?;
        let mut deleted =
            self.rollup_and_prune_before(cutoff, &format!("retain_days={retain_days}"))?;

        let (auto_cleanup_enabled, retain_count) = self.get_request_log_retention_config()?;
        if auto_cleanup_enabled {
            deleted += self.prune_request_logs_to_minimum(retain_count)?;
        }
        Ok(deleted)
    }

    pub fn get_request_log_retention_config(&self) -> Result<(bool, u32), AppError> {
        let config = match self.get_setting(REQUEST_LOG_RETENTION_SETTING_KEY)? {
            Some(raw) => match serde_json::from_str::<StoredRetentionConfig>(&raw) {
                Ok(config) => config.normalized(),
                Err(error) => {
                    log::warn!("Ignoring invalid request-log retention setting: {error}");
                    StoredRetentionConfig::default()
                }
            },
            None => StoredRetentionConfig::default(),
        };
        Ok((config.auto_cleanup_enabled, config.retain_count))
    }

    pub fn set_request_log_retention_config(
        &self,
        auto_cleanup_enabled: bool,
        retain_count: u32,
    ) -> Result<(bool, u32), AppError> {
        let config = StoredRetentionConfig {
            auto_cleanup_enabled,
            retain_count,
        }
        .normalized();
        let json = serde_json::to_string(&config).map_err(|e| {
            AppError::Database(format!(
                "serialize request-log retention setting failed: {e}"
            ))
        })?;
        self.set_setting(REQUEST_LOG_RETENTION_SETTING_KEY, &json)?;
        Ok((config.auto_cleanup_enabled, config.retain_count))
    }

    /// Keep exactly the newest `retain_count` raw request-log rows. Older rows
    /// are copied into the statistics-only archive before they are deleted;
    /// the archive itself is then capped by atomically folding its oldest
    /// facts into the existing daily rollups.
    pub fn prune_request_logs_to_minimum(&self, retain_count: u32) -> Result<u64, AppError> {
        let retain_count =
            retain_count.clamp(MIN_REQUEST_LOG_RETAIN_COUNT, MAX_REQUEST_LOG_RETAIN_COUNT);
        let conn = lock_conn!(self.conn);
        let (raw_total, archive_total): (i64, i64) = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM proxy_request_logs),
                    (SELECT COUNT(*) FROM usage_request_stats_archive)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let raw_exceeds_limit = raw_total > i64::from(retain_count);
        let archive_exceeds_limit = archive_total > MAX_REQUEST_STATS_ARCHIVE_ROWS;
        if !raw_exceeds_limit && !archive_exceeds_limit {
            return Ok(0);
        }

        // Only the rows that this retention pass will remove need a final
        // pricing attempt. Never scan/update the full archive on this hot
        // path: at sustained traffic that would be the dominant source of UI
        // stalls and write contention.
        if raw_exceeds_limit {
            if let Err(error) =
                Self::backfill_missing_raw_usage_costs_excess_on_conn(&conn, retain_count)
            {
                log::warn!("Pre-retention cost backfill failed, archiving anyway: {error}");
            }
        }

        conn.execute("SAVEPOINT retain_request_logs;", [])
            .map_err(|e| AppError::Database(e.to_string()))?;
        let result = (|| {
            let deleted_raw = if raw_exceeds_limit {
                Self::archive_and_delete_excess_request_logs(&conn, retain_count)?
            } else {
                0
            };
            // Keep archive compaction in the same savepoint as the raw copy
            // and delete. A failed daily upsert/delete must roll back every
            // preceding move so statistics can never be double-counted or
            // lost between tiers.
            let deleted_archive = Self::compact_archive_excess_to_minutes(&conn)?;
            Ok::<(u64, u64), AppError>((deleted_raw, deleted_archive))
        })();
        match result {
            Ok((deleted_raw, deleted_archive)) => {
                conn.execute("RELEASE retain_request_logs;", [])
                    .map_err(|e| AppError::Database(e.to_string()))?;
                let deleted = deleted_raw + deleted_archive;
                if deleted > 0 {
                    log::info!(
                        "Archived {deleted_raw} raw request logs and compacted {deleted_archive} archive rows while retaining the newest {retain_count} raw logs"
                    );
                }
                Ok(deleted)
            }
            Err(error) => {
                conn.execute("ROLLBACK TO retain_request_logs;", []).ok();
                conn.execute("RELEASE retain_request_logs;", []).ok();
                Err(error)
            }
        }
    }

    /// Lightweight periodic gate for automatic retention. The actual method
    /// starts a savepoint only when raw or archive storage is above its bound.
    pub fn prune_request_logs_if_needed(&self) -> Result<u64, AppError> {
        let (enabled, retain_count) = self.get_request_log_retention_config()?;
        if !enabled {
            return Ok(0);
        }

        // Keep a small hysteresis band on the periodic path. At high request
        // rates this bounds write-lock churn while still guaranteeing that the
        // next maintenance tick converges to the configured limit once the
        // band is crossed.
        let (raw_total, archive_total): (i64, i64) = {
            let conn = lock_conn!(self.conn);
            conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM proxy_request_logs),
                    (SELECT COUNT(*) FROM usage_request_stats_archive)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| AppError::Database(e.to_string()))?
        };
        let raw_high_watermark = i64::from(retain_count) + REQUEST_LOG_RETENTION_HYSTERESIS_ROWS;
        if raw_total <= raw_high_watermark && archive_total <= MAX_REQUEST_STATS_ARCHIVE_ROWS {
            return Ok(0);
        }
        self.prune_request_logs_to_minimum(retain_count)
    }

    /// Copy every effective request fact into the statistics-only archive and
    /// physically remove all raw request-log rows.
    pub fn clear_request_logs_preserving_statistics(&self) -> Result<u64, AppError> {
        let conn = lock_conn!(self.conn);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                row.get(0)
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        if count == 0 {
            return Ok(0);
        }

        if let Err(e) = Self::backfill_missing_raw_usage_costs_on_conn(&conn) {
            log::warn!("Pre-clear cost backfill failed, archiving anyway: {e}");
        }

        conn.execute("SAVEPOINT clear_request_logs;", [])
            .map_err(|e| AppError::Database(e.to_string()))?;

        let result = (|| {
            Self::archive_all_effective_request_logs(&conn)?;
            let deleted = conn
                .execute("DELETE FROM proxy_request_logs", [])
                .map_err(|e| AppError::Database(format!("clear request logs failed: {e}")))?;
            // The clear can add a large number of precise facts at once. Cap
            // the archive before releasing this savepoint so the operation is
            // atomic from the caller's perspective; retain the return value
            // as the number of raw UI rows actually cleared.
            Self::compact_archive_excess_to_minutes(&conn)?;
            Ok::<u64, AppError>(deleted as u64)
        })();

        match result {
            Ok(deleted) => {
                conn.execute("RELEASE clear_request_logs;", [])
                    .map_err(|e| AppError::Database(e.to_string()))?;
                log::info!("Cleared {deleted} proxy_request_logs after archiving statistics");
                Ok(deleted)
            }
            Err(error) => {
                conn.execute("ROLLBACK TO clear_request_logs;", []).ok();
                conn.execute("RELEASE clear_request_logs;", []).ok();
                Err(error)
            }
        }
    }

    fn archive_all_effective_request_logs(conn: &Connection) -> Result<u64, AppError> {
        let effective_filter = effective_usage_log_filter("l");
        let sql = format!(
            "INSERT INTO usage_request_stats_archive (
                request_id, provider_id, app_type, model, request_model, pricing_model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                input_token_semantics, input_cost_usd, output_cost_usd,
                cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
                cost_multiplier, latency_ms, status_code,
                created_at, data_source
             )
             SELECT
                l.request_id, l.provider_id, l.app_type, l.model,
                l.request_model, l.pricing_model,
                l.input_tokens, l.output_tokens,
                l.cache_read_tokens, l.cache_creation_tokens,
                l.input_token_semantics, l.input_cost_usd, l.output_cost_usd,
                l.cache_read_cost_usd, l.cache_creation_cost_usd, l.total_cost_usd,
                l.cost_multiplier, l.latency_ms, l.status_code, l.created_at,
                COALESCE(l.data_source, 'proxy')
             FROM proxy_request_logs l
             WHERE {effective_filter}
             {USAGE_ARCHIVE_UPSERT_SQL}"
        );
        conn.execute(&sql, [])
            .map(|inserted| inserted as u64)
            .map_err(|e| AppError::Database(format!("archive request statistics failed: {e}")))
    }

    fn archive_and_delete_excess_request_logs(
        conn: &Connection,
        retain_count: u32,
    ) -> Result<u64, AppError> {
        let effective_filter = effective_usage_log_filter("l");
        let archive_sql = format!(
            "INSERT INTO usage_request_stats_archive (
                request_id, provider_id, app_type, model, request_model, pricing_model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                input_token_semantics, input_cost_usd, output_cost_usd,
                cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
                cost_multiplier, latency_ms, status_code,
                created_at, data_source
             )
             SELECT
                l.request_id, l.provider_id, l.app_type, l.model,
                l.request_model, l.pricing_model,
                l.input_tokens, l.output_tokens,
                l.cache_read_tokens, l.cache_creation_tokens,
                l.input_token_semantics, l.input_cost_usd, l.output_cost_usd,
                l.cache_read_cost_usd, l.cache_creation_cost_usd, l.total_cost_usd,
                l.cost_multiplier, l.latency_ms, l.status_code, l.created_at,
                COALESCE(l.data_source, 'proxy')
             FROM proxy_request_logs l
             WHERE l.rowid IN (
                SELECT rowid
                FROM proxy_request_logs
                ORDER BY created_at DESC, rowid DESC
                LIMIT -1 OFFSET ?1
             )
             AND {effective_filter}
             {USAGE_ARCHIVE_UPSERT_SQL}"
        );
        conn.execute(&archive_sql, [i64::from(retain_count)])
            .map_err(|e| {
                AppError::Database(format!("archive retained request statistics failed: {e}"))
            })?;

        let deleted = conn
            .execute(
                "DELETE FROM proxy_request_logs
                 WHERE rowid IN (
                    SELECT rowid
                    FROM proxy_request_logs
                    ORDER BY created_at DESC, rowid DESC
                    LIMIT -1 OFFSET ?1
                 )",
                [i64::from(retain_count)],
            )
            .map_err(|e| AppError::Database(format!("prune retained request logs failed: {e}")))?;
        Ok(deleted as u64)
    }

    fn rollup_and_prune_before(&self, cutoff: i64, reason: &str) -> Result<u64, AppError> {
        // Leave two matching windows in precise storage while the daily task
        // runs. One window covers the proxy/session correlation itself; the
        // second prevents a counterpart just outside the compaction boundary
        // from surviving as a newly-effective independent fact.
        let detail_cutoff = cutoff.saturating_sub(SESSION_PROXY_DEDUP_WINDOW_SECONDS * 2);
        let conn = lock_conn!(self.conn);
        let (detail_count, minute_count): (i64, i64) = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM proxy_request_logs WHERE created_at < ?1) +
                    (SELECT COUNT(*) FROM usage_request_stats_archive WHERE created_at < ?1),
                    (SELECT COUNT(*) FROM usage_minute_rollups WHERE minute_start < ?2)",
                [detail_cutoff, cutoff],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        if detail_count == 0 && minute_count == 0 {
            return Ok(0);
        }

        // Only age-eligible detailed rows need a final price lookup. This
        // preserves the old "backfill before irreversible compaction" rule
        // without scanning the hot archive on every maintenance pass.
        if detail_count > 0 {
            if let Err(e) = Self::backfill_missing_usage_costs_before_on_conn(&conn, detail_cutoff)
            {
                log::warn!("Pre-prune cost backfill failed, pruning anyway: {e}");
            }
        }

        conn.execute("SAVEPOINT rollup_prune;", [])
            .map_err(|e| AppError::Database(e.to_string()))?;
        let result = Self::do_rollup_and_prune(&conn, detail_cutoff, cutoff);

        match result {
            Ok(deleted) => {
                conn.execute("RELEASE rollup_prune;", [])
                    .map_err(|e| AppError::Database(e.to_string()))?;
                if deleted > 0 {
                    log::info!("Compacted {deleted} usage rows into minute/daily tiers ({reason})");
                }
                Ok(deleted)
            }
            Err(e) => {
                conn.execute("ROLLBACK TO rollup_prune;", []).ok();
                conn.execute("RELEASE rollup_prune;", []).ok();
                Err(e)
            }
        }
    }

    fn usage_source_table(source_table: &str) -> Result<(&'static str, bool), AppError> {
        match source_table {
            "proxy_request_logs" => Ok(("proxy_request_logs", false)),
            "usage_request_stats_archive" => Ok(("usage_request_stats_archive", true)),
            _ => Err(AppError::Database(format!(
                "unsupported usage compaction source: {source_table}"
            ))),
        }
    }

    fn aggregate_usage_source_to_minutes<P: rusqlite::Params>(
        conn: &Connection,
        source_table: &str,
        source_selector: &str,
        params: P,
    ) -> Result<(), AppError> {
        let (source_table, archived) = Self::usage_source_table(source_table)?;
        let effective_filter = if archived {
            effective_archive_usage_log_filter("l")
        } else {
            effective_usage_log_filter("l")
        };
        let source_data = if archived {
            "l.data_source"
        } else {
            "COALESCE(l.data_source, 'proxy')"
        };
        let source_dedup_filter = if archived {
            "AND NOT EXISTS (
                SELECT 1 FROM proxy_request_logs detail_same
                WHERE detail_same.request_id = l.request_id
                  AND detail_same.created_at = l.created_at
             )"
        } else {
            ""
        };
        let fresh_input = fresh_input_sql("l");
        let pending_cost = "CASE
            WHEN CAST(l.total_cost_usd AS REAL) <= 0
             AND (l.input_tokens > 0 OR l.output_tokens > 0
                  OR l.cache_read_tokens > 0 OR l.cache_creation_tokens > 0)
            THEN 1 ELSE 0 END";
        let sql = format!(
            "INSERT OR REPLACE INTO usage_minute_rollups (
                minute_start, app_type, provider_id, model, request_model, pricing_model,
                data_source, cost_multiplier, cost_pending,
                request_count, success_count, fresh_input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, total_cost_usd, latency_sum_ms
             )
             SELECT
                grouped.minute_start, grouped.app_type, grouped.provider_id, grouped.model,
                grouped.request_model, grouped.pricing_model, grouped.data_source,
                grouped.cost_multiplier, grouped.cost_pending,
                COALESCE(old.request_count, 0) + grouped.request_count,
                COALESCE(old.success_count, 0) + grouped.success_count,
                COALESCE(old.fresh_input_tokens, 0) + grouped.fresh_input_tokens,
                COALESCE(old.output_tokens, 0) + grouped.output_tokens,
                COALESCE(old.cache_read_tokens, 0) + grouped.cache_read_tokens,
                COALESCE(old.cache_creation_tokens, 0) + grouped.cache_creation_tokens,
                CAST(COALESCE(CAST(old.total_cost_usd AS REAL), 0) + grouped.total_cost AS TEXT),
                COALESCE(old.latency_sum_ms, 0) + grouped.latency_sum_ms
             FROM (
                SELECT
                    (l.created_at / 60) * 60 AS minute_start,
                    l.app_type AS app_type, l.provider_id AS provider_id, l.model AS model,
                    COALESCE(l.request_model, '') AS request_model,
                    COALESCE(l.pricing_model, '') AS pricing_model,
                    {source_data} AS data_source,
                    COALESCE(l.cost_multiplier, '1.0') AS cost_multiplier,
                    {pending_cost} AS cost_pending,
                    COUNT(*) AS request_count,
                    COALESCE(SUM(CASE WHEN l.status_code >= 200 AND l.status_code < 300 THEN 1 ELSE 0 END), 0) AS success_count,
                    COALESCE(SUM({fresh_input}), 0) AS fresh_input_tokens,
                    COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(l.cache_read_tokens), 0) AS cache_read_tokens,
                    COALESCE(SUM(l.cache_creation_tokens), 0) AS cache_creation_tokens,
                    COALESCE(SUM(CAST(l.total_cost_usd AS REAL)), 0) AS total_cost,
                    COALESCE(SUM(l.latency_ms), 0) AS latency_sum_ms
                FROM {source_table} l
                WHERE ({source_selector}) AND {effective_filter}
                {source_dedup_filter}
                GROUP BY minute_start, app_type, provider_id, model, request_model,
                         pricing_model, data_source, cost_multiplier, cost_pending
             ) grouped
             LEFT JOIN usage_minute_rollups old
               ON old.minute_start = grouped.minute_start
              AND old.app_type = grouped.app_type
              AND old.provider_id = grouped.provider_id
              AND old.model = grouped.model
              AND old.request_model = grouped.request_model
              AND old.pricing_model = grouped.pricing_model
              AND old.data_source = grouped.data_source
              AND old.cost_multiplier = grouped.cost_multiplier
              AND old.cost_pending = grouped.cost_pending"
        );
        conn.execute(&sql, params)
            .map_err(|e| AppError::Database(format!("minute usage aggregation failed: {e}")))?;
        Ok(())
    }

    fn insert_proxy_dedup_guards_for_candidates(
        conn: &Connection,
        source_table: &str,
        source_selector: &str,
        params: &[&dyn ToSql],
    ) -> Result<(), AppError> {
        let (source_table, archived) = Self::usage_source_table(source_table)?;
        let source_data = if archived {
            "p.data_source"
        } else {
            "COALESCE(p.data_source, 'proxy')"
        };
        let sql = format!(
            "INSERT OR REPLACE INTO usage_proxy_dedup_guard (
                app_type, model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, created_at, expires_at
             )
             SELECT p.app_type, p.model, p.input_tokens, p.output_tokens,
                    p.cache_read_tokens, p.cache_creation_tokens, p.created_at, ?1
             FROM {source_table} p
             WHERE ({source_selector})
               AND {source_data} = 'proxy'
               AND p.status_code >= 200 AND p.status_code < 300"
        );
        conn.execute(&sql, params)
            .map_err(|e| AppError::Database(format!("write proxy dedup guard failed: {e}")))?;
        Ok(())
    }

    fn delete_existing_session_duplicates_for_candidates(
        conn: &Connection,
        source_table: &str,
        source_selector: &str,
        params: &[&dyn ToSql],
    ) -> Result<u64, AppError> {
        let (source_table, archived) = Self::usage_source_table(source_table)?;
        let proxy_data = if archived {
            "p.data_source"
        } else {
            "COALESCE(p.data_source, 'proxy')"
        };
        let mut deleted = 0u64;
        for (target_table, session_data) in [
            ("proxy_request_logs", "COALESCE(s.data_source, 'proxy')"),
            ("usage_request_stats_archive", "s.data_source"),
        ] {
            let sql = format!(
                "DELETE FROM {target_table} AS s
                 WHERE {session_data} IN ({SESSION_DATA_SOURCE_FILTER})
                   AND EXISTS (
                       SELECT 1
                       FROM {source_table} p
                       WHERE ({source_selector})
                         AND {proxy_data} = 'proxy'
                         AND p.status_code >= 200 AND p.status_code < 300
                         AND p.app_type = s.app_type
                         AND p.input_tokens = s.input_tokens
                         AND p.output_tokens = s.output_tokens
                         AND p.cache_read_tokens = s.cache_read_tokens
                         AND (
                             p.cache_creation_tokens = s.cache_creation_tokens
                             OR (
                                 s.cache_creation_tokens = 0
                                 AND {session_data} IN ('codex_session', 'gemini_session', 'hermes_session', 'opencode_session')
                             )
                         )
                         AND p.created_at BETWEEN s.created_at - {SESSION_PROXY_DEDUP_WINDOW_SECONDS}
                                              AND s.created_at + {SESSION_PROXY_DEDUP_WINDOW_SECONDS}
                         AND (
                             LOWER(p.model) = LOWER(s.model)
                             OR LOWER(p.model) = 'unknown'
                             OR LOWER(s.model) = 'unknown'
                         )
                   )"
            );
            deleted += conn
                .execute(&sql, params)
                .map_err(|e| AppError::Database(format!("delete session duplicate failed: {e}")))?
                as u64;
        }
        Ok(deleted)
    }

    fn cleanup_expired_proxy_dedup_guards(conn: &Connection, now: i64) -> Result<u64, AppError> {
        conn.execute(
            "DELETE FROM usage_proxy_dedup_guard WHERE expires_at < ?1",
            [now],
        )
        .map(|deleted| deleted as u64)
        .map_err(|e| AppError::Database(format!("cleanup proxy dedup guard failed: {e}")))
    }

    fn snapshot_archive_compaction_candidates(
        conn: &Connection,
        count: i64,
    ) -> Result<(), AppError> {
        conn.execute(
            &format!(
                "CREATE TEMP TABLE IF NOT EXISTS {ARCHIVE_COMPACTION_CANDIDATES} (
                    row_id INTEGER PRIMARY KEY
                 )"
            ),
            [],
        )
        .map_err(|e| {
            AppError::Database(format!("create archive compaction snapshot failed: {e}"))
        })?;
        conn.execute(&format!("DELETE FROM {ARCHIVE_COMPACTION_CANDIDATES}"), [])
            .map_err(|e| {
                AppError::Database(format!("reset archive compaction snapshot failed: {e}"))
            })?;
        conn.execute(
            &format!(
                "INSERT INTO {ARCHIVE_COMPACTION_CANDIDATES} (row_id)
                 SELECT rowid
                 FROM usage_request_stats_archive
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT ?1"
            ),
            [count],
        )
        .map_err(|e| {
            AppError::Database(format!(
                "snapshot archive compaction candidates failed: {e}"
            ))
        })?;
        Ok(())
    }

    fn compact_archive_excess_to_minutes(conn: &Connection) -> Result<u64, AppError> {
        let archive_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM usage_request_stats_archive",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(format!("count request-stat archive failed: {e}")))?;
        if archive_count <= MAX_REQUEST_STATS_ARCHIVE_ROWS {
            return Ok(0);
        }

        let excess = archive_count - MAX_REQUEST_STATS_ARCHIVE_ROWS;
        Self::snapshot_archive_compaction_candidates(conn, excess)?;
        let now = Local::now().timestamp();
        let expires_at = now.saturating_add(PROXY_DEDUP_GUARD_TTL_SECONDS);
        let guard_params: [&dyn ToSql; 1] = [&expires_at];
        let no_params: [&dyn ToSql; 0] = [];
        let candidate_selector =
            format!("p.rowid IN (SELECT row_id FROM {ARCHIVE_COMPACTION_CANDIDATES})");
        let aggregation_selector =
            format!("l.rowid IN (SELECT row_id FROM {ARCHIVE_COMPACTION_CANDIDATES})");

        Self::insert_proxy_dedup_guards_for_candidates(
            conn,
            "usage_request_stats_archive",
            &candidate_selector,
            &guard_params,
        )?;
        let deleted_sessions = Self::delete_existing_session_duplicates_for_candidates(
            conn,
            "usage_request_stats_archive",
            &candidate_selector,
            &no_params,
        )?;
        Self::aggregate_usage_source_to_minutes(
            conn,
            "usage_request_stats_archive",
            &aggregation_selector,
            [],
        )?;
        let deleted_archive = conn
            .execute(
                &format!(
                    "DELETE FROM usage_request_stats_archive
                     WHERE rowid IN (SELECT row_id FROM {ARCHIVE_COMPACTION_CANDIDATES})"
                ),
                [],
            )
            .map_err(|e| AppError::Database(format!("compact request-stat archive failed: {e}")))?
            as u64;
        Self::cleanup_expired_proxy_dedup_guards(conn, now)?;
        conn.execute(&format!("DELETE FROM {ARCHIVE_COMPACTION_CANDIDATES}"), [])
            .map_err(|e| {
                AppError::Database(format!("clear archive compaction snapshot failed: {e}"))
            })?;
        Ok(deleted_sessions + deleted_archive)
    }

    fn compact_details_to_minutes_before(conn: &Connection, cutoff: i64) -> Result<u64, AppError> {
        let now = Local::now().timestamp();
        let expires_at = now.saturating_add(PROXY_DEDUP_GUARD_TTL_SECONDS);
        let guard_params: [&dyn ToSql; 2] = [&expires_at, &cutoff];
        let cutoff_params: [&dyn ToSql; 1] = [&cutoff];
        let selector = "p.created_at < ?2";

        for source in ["proxy_request_logs", "usage_request_stats_archive"] {
            Self::insert_proxy_dedup_guards_for_candidates(conn, source, selector, &guard_params)?;
        }

        let mut deleted_sessions = 0u64;
        for source in ["proxy_request_logs", "usage_request_stats_archive"] {
            deleted_sessions += Self::delete_existing_session_duplicates_for_candidates(
                conn,
                source,
                "p.created_at < ?1",
                &cutoff_params,
            )?;
        }

        Self::aggregate_usage_source_to_minutes(
            conn,
            "proxy_request_logs",
            "l.created_at < ?1",
            [cutoff],
        )?;
        Self::aggregate_usage_source_to_minutes(
            conn,
            "usage_request_stats_archive",
            "l.created_at < ?1",
            [cutoff],
        )?;

        let deleted_details = conn
            .execute(
                "DELETE FROM proxy_request_logs WHERE created_at < ?1",
                [cutoff],
            )
            .map_err(|e| AppError::Database(format!("compact old request logs failed: {e}")))?
            as u64;
        let deleted_archive = conn
            .execute(
                "DELETE FROM usage_request_stats_archive WHERE created_at < ?1",
                [cutoff],
            )
            .map_err(|e| AppError::Database(format!("compact old request archive failed: {e}")))?
            as u64;
        Self::cleanup_expired_proxy_dedup_guards(conn, now)?;
        Ok(deleted_sessions + deleted_details + deleted_archive)
    }

    fn compact_minutes_to_daily_before(conn: &Connection, cutoff: i64) -> Result<u64, AppError> {
        let daily_sql = format!(
            "INSERT OR REPLACE INTO usage_daily_rollups
                (date, app_type, provider_id, model, request_model, pricing_model,
                 request_count, success_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, input_token_semantics,
                 total_cost_usd, avg_latency_ms)
             SELECT
                 grouped.date, grouped.app_type, grouped.provider_id, grouped.model,
                 grouped.request_model, grouped.pricing_model,
                 COALESCE(old.request_count, 0) + grouped.request_count,
                 COALESCE(old.success_count, 0) + grouped.success_count,
                 COALESCE(old.input_tokens, 0) + grouped.input_tokens,
                 COALESCE(old.output_tokens, 0) + grouped.output_tokens,
                 COALESCE(old.cache_read_tokens, 0) + grouped.cache_read_tokens,
                 COALESCE(old.cache_creation_tokens, 0) + grouped.cache_creation_tokens,
                 {INPUT_TOKEN_SEMANTICS_FRESH},
                 CAST(COALESCE(CAST(old.total_cost_usd AS REAL), 0) + grouped.total_cost AS TEXT),
                 CASE WHEN COALESCE(old.request_count, 0) + grouped.request_count > 0
                      THEN (COALESCE(old.avg_latency_ms, 0) * COALESCE(old.request_count, 0)
                            + grouped.latency_sum_ms)
                           / (COALESCE(old.request_count, 0) + grouped.request_count)
                      ELSE 0 END
             FROM (
                 SELECT
                     date(m.minute_start, 'unixepoch', 'localtime') AS date,
                     m.app_type, m.provider_id, m.model, m.request_model, m.pricing_model,
                     COALESCE(SUM(m.request_count), 0) AS request_count,
                     COALESCE(SUM(m.success_count), 0) AS success_count,
                     COALESCE(SUM(m.fresh_input_tokens), 0) AS input_tokens,
                     COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
                     COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read_tokens,
                     COALESCE(SUM(m.cache_creation_tokens), 0) AS cache_creation_tokens,
                     COALESCE(SUM(CAST(m.total_cost_usd AS REAL)), 0) AS total_cost,
                     COALESCE(SUM(m.latency_sum_ms), 0) AS latency_sum_ms
                 FROM usage_minute_rollups m
                 WHERE m.minute_start < ?1
                 GROUP BY date, m.app_type, m.provider_id, m.model, m.request_model, m.pricing_model
             ) grouped
             LEFT JOIN usage_daily_rollups old
               ON old.date = grouped.date AND old.app_type = grouped.app_type
              AND old.provider_id = grouped.provider_id AND old.model = grouped.model
              AND old.request_model = grouped.request_model
              AND old.pricing_model = grouped.pricing_model"
        );
        conn.execute(&daily_sql, [cutoff])
            .map_err(|e| AppError::Database(format!("daily usage aggregation failed: {e}")))?;

        let source_sql = "INSERT OR REPLACE INTO usage_daily_data_source_rollups
                (date, data_source, request_count, total_cost_usd)
             SELECT grouped.date, grouped.data_source,
                    COALESCE(old.request_count, 0) + grouped.request_count,
                    CAST(COALESCE(CAST(old.total_cost_usd AS REAL), 0) + grouped.total_cost AS TEXT)
             FROM (
                 SELECT date(m.minute_start, 'unixepoch', 'localtime') AS date,
                        m.data_source,
                        COALESCE(SUM(m.request_count), 0) AS request_count,
                        COALESCE(SUM(CAST(m.total_cost_usd AS REAL)), 0) AS total_cost
                 FROM usage_minute_rollups m
                 WHERE m.minute_start < ?1
                 GROUP BY date, m.data_source
             ) grouped
             LEFT JOIN usage_daily_data_source_rollups old
               ON old.date = grouped.date AND old.data_source = grouped.data_source";
        conn.execute(source_sql, [cutoff]).map_err(|e| {
            AppError::Database(format!("daily data-source usage aggregation failed: {e}"))
        })?;

        conn.execute(
            "DELETE FROM usage_minute_rollups WHERE minute_start < ?1",
            [cutoff],
        )
        .map(|deleted| deleted as u64)
        .map_err(|e| AppError::Database(format!("compact minute usage rows failed: {e}")))
    }

    fn do_rollup_and_prune(
        conn: &Connection,
        detail_cutoff: i64,
        daily_cutoff: i64,
    ) -> Result<u64, AppError> {
        let deleted_details = Self::compact_details_to_minutes_before(conn, detail_cutoff)?;
        // The public return value is the historical contract: count only
        // physically deleted request-detail rows. Minute rows are an internal
        // aggregate tier and must not inflate the reported detail count.
        Self::compact_minutes_to_daily_before(conn, daily_cutoff)?;
        Ok(deleted_details)
    }
}

#[cfg(test)]
mod tests {
    use super::compute_local_midnight_cutoff;
    use crate::database::Database;
    use crate::error::AppError;
    use chrono::{Local, TimeZone};

    fn local_dt(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> chrono::DateTime<Local> {
        match Local.with_ymd_and_hms(year, month, day, hour, minute, second) {
            chrono::LocalResult::Single(dt) => dt,
            chrono::LocalResult::Ambiguous(earliest, _) => earliest,
            chrono::LocalResult::None => panic!("invalid local datetime in test fixture"),
        }
    }

    #[test]
    fn cutoff_is_aligned_to_local_midnight_after_target_day() -> Result<(), AppError> {
        // now = 2026-04-16 14:32:17 local; retain_days = 30
        // target day = 2026-03-17; cutoff should be 2026-03-18 00:00 local.
        let now = local_dt(2026, 4, 16, 14, 32, 17);
        let cutoff_ts = compute_local_midnight_cutoff(now, 30)?;
        let cutoff_dt = Local.timestamp_opt(cutoff_ts, 0).single().unwrap();
        let expected = local_dt(2026, 3, 18, 0, 0, 0);
        assert_eq!(cutoff_dt, expected);
        Ok(())
    }

    #[test]
    fn cutoff_at_local_midnight_now_still_lands_on_midnight() -> Result<(), AppError> {
        // If `now` is itself local midnight, the math should not introduce drift.
        let now = local_dt(2026, 4, 16, 0, 0, 0);
        let cutoff_ts = compute_local_midnight_cutoff(now, 7)?;
        let cutoff_dt = Local.timestamp_opt(cutoff_ts, 0).single().unwrap();
        // (2026-04-16 - 7d) = 2026-04-09; cutoff = 2026-04-10 00:00 local.
        let expected = local_dt(2026, 4, 10, 0, 0, 0);
        assert_eq!(cutoff_dt, expected);
        Ok(())
    }

    #[test]
    fn test_rollup_and_prune() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 86400; // 40 days ago
        let recent_ts = now - 5 * 86400; // 5 days ago

        {
            let conn = crate::database::lock_conn!(db.conn);
            for i in 0..5 {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                    ) VALUES (?1, 'p1', 'claude', 'claude-3', 100, 50, '0.01', 100, 200, ?2)",
                    rusqlite::params![format!("old-{i}"), old_ts + i as i64],
                )?;
            }
            for i in 0..3 {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                    ) VALUES (?1, 'p1', 'claude', 'claude-3', 200, 100, '0.02', 150, 200, ?2)",
                    rusqlite::params![format!("recent-{i}"), recent_ts + i as i64],
                )?;
            }
        }

        let deleted = db.rollup_and_prune(30)?;
        assert_eq!(deleted, 5);

        // Verify rollup data
        let conn = crate::database::lock_conn!(db.conn);
        let count: i64 = conn.query_row(
            "SELECT request_count FROM usage_daily_rollups WHERE app_type = 'claude'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, 5);

        // Verify recent logs untouched
        let remaining: i64 =
            conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                row.get(0)
            })?;
        assert_eq!(remaining, 3);
        Ok(())
    }

    #[test]
    fn test_rollup_uses_effective_usage_logs() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 86400;

        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    total_cost_usd, latency_ms, status_code, created_at, data_source
                ) VALUES (?1, 'openai', 'codex', 'gpt-5.4', 'gpt-5.4', 100, 20, 10, 0, '0.10', 100, 200, ?2, 'proxy')",
                rusqlite::params!["codex-proxy-old", old_ts],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    total_cost_usd, latency_ms, status_code, created_at, data_source
                ) VALUES (?1, '_codex_session', 'codex', 'gpt-5.4', 'gpt-5.4', 100, 20, 10, 0, '0.10', 0, 200, ?2, 'codex_session')",
                rusqlite::params!["codex-session-old-dup", old_ts + 60],
            )?;
        }

        let deleted = db.rollup_and_prune(30)?;
        assert_eq!(deleted, 2);

        let conn = crate::database::lock_conn!(db.conn);
        let mut stmt = conn.prepare(
            "SELECT provider_id, request_count, input_tokens, output_tokens, cache_read_tokens
             FROM usage_daily_rollups WHERE app_type = 'codex'",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        assert_eq!(rows.len(), 1);
        let (provider_id, request_count, input_tokens, output_tokens, cache_read_tokens) = &rows[0];
        assert_eq!(provider_id, "openai");
        assert_eq!(*request_count, 1);
        assert_eq!(*input_tokens, 90, "rollup stores normalized fresh input");
        assert_eq!(*output_tokens, 20);
        assert_eq!(*cache_read_tokens, 10);

        let remaining: i64 =
            conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                row.get(0)
            })?;
        assert_eq!(remaining, 0);

        Ok(())
    }

    #[test]
    fn rollup_prefers_matching_detail_but_preserves_reused_request_id() -> Result<(), AppError> {
        let db = Database::memory()?;
        let cutoff = local_dt(2026, 2, 20, 0, 0, 0).timestamp();
        let duplicate_ts = cutoff - 3600;
        let reused_ts = cutoff - 7200;

        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO usage_request_stats_archive (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                 ) VALUES ('reused-id', 'archive-provider', 'claude', 'archive-model',
                           10, 5, '0.01', 10, 200, ?1)",
                [duplicate_ts],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                 ) VALUES ('reused-id', 'detail-provider', 'claude', 'detail-model',
                           20, 7, '0.02', 20, 200, ?1)",
                [duplicate_ts],
            )?;
            conn.execute(
                "INSERT INTO usage_request_stats_archive (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                 ) VALUES ('reused-id', 'older-provider', 'claude', 'older-model',
                           30, 9, '0.03', 30, 200, ?1)",
                [reused_ts],
            )?;
        }

        assert_eq!(db.rollup_and_prune_before(cutoff, "test-reused-id")?, 3);
        let conn = crate::database::lock_conn!(db.conn);
        let total_requests: i64 = conn.query_row(
            "SELECT SUM(request_count) FROM usage_daily_rollups",
            [],
            |row| row.get(0),
        )?;
        let detail_count: i64 = conn.query_row(
            "SELECT request_count FROM usage_daily_rollups WHERE model = 'detail-model'",
            [],
            |row| row.get(0),
        )?;
        let stale_archive_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM usage_daily_rollups WHERE model = 'archive-model'",
            [],
            |row| row.get(0),
        )?;
        let reused_count: i64 = conn.query_row(
            "SELECT request_count FROM usage_daily_rollups WHERE model = 'older-model'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(total_requests, 2);
        assert_eq!(detail_count, 1);
        assert_eq!(stale_archive_count, 0);
        assert_eq!(reused_count, 1);
        Ok(())
    }

    #[test]
    fn test_rollup_normalizes_total_cache_semantics_to_fresh() -> Result<(), AppError> {
        let db = Database::memory()?;
        let old_ts = chrono::Utc::now().timestamp() - 40 * 86400;

        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    input_token_semantics, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES ('total-semantics-rollup', 'p1', 'codex', 'gpt-5.5',
                          100, 5, 10, 20, 1, '0.10', 100, 200, ?1)",
                [old_ts],
            )?;
        }

        assert_eq!(db.rollup_and_prune(30)?, 1);

        let conn = crate::database::lock_conn!(db.conn);
        let row: (i64, i64, i64, i64) = conn.query_row(
            "SELECT input_tokens, cache_read_tokens, cache_creation_tokens,
                    input_token_semantics
             FROM usage_daily_rollups WHERE model = 'gpt-5.5'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(row, (70, 10, 20, 2));

        Ok(())
    }

    #[test]
    fn test_rollup_preserves_request_model_dimension() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 86400;

        {
            let conn = crate::database::lock_conn!(db.conn);
            // 路由接管行：model 是真实上游模型，request_model 是客户端别名。
            // 同 model 下两个不同别名必须各自成行，prune 后映射关系仍可审计。
            for (i, request_model) in [
                ("a", "claude-sonnet-4-6"),
                ("b", "claude-sonnet-4-6"),
                ("c", "claude-haiku-4-5"),
            ] {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model, request_model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                    ) VALUES (?1, 'p1', 'claude', 'kimi-k2', ?2, 100, 50, '0.01', 100, 200, ?3)",
                    rusqlite::params![format!("takeover-{i}"), request_model, old_ts],
                )?;
            }
        }

        let deleted = db.rollup_and_prune(30)?;
        assert_eq!(deleted, 3);

        let conn = crate::database::lock_conn!(db.conn);
        let mut stmt = conn.prepare(
            "SELECT request_model, request_count FROM usage_daily_rollups
             WHERE model = 'kimi-k2' ORDER BY request_model",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        assert_eq!(
            rows,
            vec![
                ("claude-haiku-4-5".to_string(), 1),
                ("claude-sonnet-4-6".to_string(), 2),
            ]
        );
        Ok(())
    }

    #[test]
    fn test_rollup_preserves_pricing_model_dimension() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 86400;

        {
            let conn = crate::database::lock_conn!(db.conn);
            // request 计价模式下 pricing_model 与 model 分叉，必须各自成行
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model, pricing_model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES ('pm-a', 'p1', 'claude', 'kimi-k2', 'claude-sonnet-4-6', 'kimi-k2',
                          100, 50, '0.01', 100, 200, ?1)",
                rusqlite::params![old_ts],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model, pricing_model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES ('pm-b', 'p1', 'claude', 'kimi-k2', 'claude-sonnet-4-6', 'claude-sonnet-4-6',
                          100, 50, '0.30', 100, 200, ?1)",
                rusqlite::params![old_ts],
            )?;
        }

        let deleted = db.rollup_and_prune(30)?;
        assert_eq!(deleted, 2);

        let conn = crate::database::lock_conn!(db.conn);
        let mut stmt = conn.prepare(
            "SELECT pricing_model, total_cost_usd FROM usage_daily_rollups
             WHERE model = 'kimi-k2' ORDER BY pricing_model",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "claude-sonnet-4-6");
        assert_eq!(rows[1].0, "kimi-k2");
        Ok(())
    }

    #[test]
    fn test_rollup_backfills_costs_before_pruning() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 86400;

        {
            let conn = crate::database::lock_conn!(db.conn);
            // >30 天的 0 成本行：pricing_model（gpt-5.5）在 seed 定价表中有价。
            // 剪枝是不可逆的，rollup 必须先回填再汇总，否则按 0 永久入账。
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, request_model, pricing_model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES ('prune-backfill', 'p1', 'codex', 'gpt-5.5', 'gpt-5.5', 'gpt-5.5',
                          1000000, 0, '0', 100, 200, ?1)",
                rusqlite::params![old_ts],
            )?;
        }

        let deleted = db.rollup_and_prune(30)?;
        assert_eq!(deleted, 1);

        let conn = crate::database::lock_conn!(db.conn);
        let total_cost: f64 = conn.query_row(
            "SELECT CAST(total_cost_usd AS REAL) FROM usage_daily_rollups
             WHERE model = 'gpt-5.5'",
            [],
            |row| row.get(0),
        )?;
        // gpt-5.5 input $5/M × 1M tokens，回填后再汇总
        assert!(
            (total_cost - 5.0).abs() < 1e-6,
            "expected backfilled cost 5.0, got {total_cost}"
        );
        Ok(())
    }

    #[test]
    fn test_rollup_noop_when_no_old_data() -> Result<(), AppError> {
        let db = Database::memory()?;
        assert_eq!(db.rollup_and_prune(30)?, 0);
        Ok(())
    }

    #[test]
    fn test_rollup_merges_with_existing() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 86400;

        {
            let conn = crate::database::lock_conn!(db.conn);
            let date_str = Local
                .timestamp_opt(old_ts, 0)
                .single()
                .expect("old timestamp should be a valid local datetime")
                .format("%Y-%m-%d")
                .to_string();
            conn.execute(
                "INSERT INTO usage_daily_rollups
                    (date, app_type, provider_id, model, request_count, success_count,
                     input_tokens, output_tokens, total_cost_usd, avg_latency_ms)
                 VALUES (?1, 'claude', 'p1', 'claude-3', 10, 10, 1000, 500, '0.10', 100)",
                [&date_str],
            )?;
            for i in 0..3 {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                    ) VALUES (?1, 'p1', 'claude', 'claude-3', 100, 50, '0.01', 200, 200, ?2)",
                    rusqlite::params![format!("merge-{i}"), old_ts + i as i64],
                )?;
            }
        }

        let deleted = db.rollup_and_prune(30)?;
        assert_eq!(deleted, 3);

        let conn = crate::database::lock_conn!(db.conn);
        let (count, input): (i64, i64) = conn.query_row(
            "SELECT request_count, input_tokens FROM usage_daily_rollups
             WHERE app_type = 'claude' AND provider_id = 'p1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(count, 13, "10 existing + 3 new");
        assert_eq!(input, 1300, "1000 existing + 300 new");
        Ok(())
    }

    #[test]
    fn clear_request_logs_preserves_second_precision_statistics() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = Local::now().timestamp();
        let first_ts = now - 120;
        let second_ts = now - 60;

        {
            let conn = crate::database::lock_conn!(db.conn);
            for (request_id, created_at) in [("clear-1", first_ts), ("clear-2", second_ts)] {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                    ) VALUES (?1, 'p1', 'claude', 'claude-3', 100, 50, '0.01', 100, 200, ?2)",
                    rusqlite::params![request_id, created_at],
                )?;
            }
        }

        let before = db.get_usage_summary(
            Some(first_ts),
            Some(second_ts + 1),
            Some("claude"),
            None,
            None,
        )?;
        assert_eq!(before.total_requests, 2);

        assert_eq!(db.clear_request_logs_preserving_statistics()?, 2);
        let remaining: i64 = {
            let conn = crate::database::lock_conn!(db.conn);
            conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                row.get(0)
            })?
        };
        assert_eq!(remaining, 0);

        let after = db.get_usage_summary(
            Some(first_ts),
            Some(second_ts + 1),
            Some("claude"),
            None,
            None,
        )?;
        assert_eq!(after.total_requests, before.total_requests);
        assert_eq!(after.total_input_tokens, before.total_input_tokens);
        assert_eq!(after.total_output_tokens, before.total_output_tokens);
        assert_eq!(after.total_cost, before.total_cost);

        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES ('clear-new', 'p1', 'claude', 'claude-3', 200, 75, '0.02', 100, 200, ?1)",
                [second_ts + 60],
            )?;
        }

        let with_new_detail = db.get_usage_summary(
            Some(first_ts),
            Some(second_ts + 61),
            Some("claude"),
            None,
            None,
        )?;
        assert_eq!(with_new_detail.total_requests, 3);
        assert_eq!(with_new_detail.total_input_tokens, 400);
        assert_eq!(with_new_detail.total_output_tokens, 175);
        Ok(())
    }

    #[test]
    fn clear_request_logs_rolls_back_when_archive_insert_fails() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                 ) VALUES ('clear-rollback', 'p1', 'claude', 'claude-3',
                           1, 1, '0.01', 10, 200, 1000)",
                [],
            )?;
            conn.execute_batch(
                "CREATE TRIGGER reject_usage_archive
                 BEFORE INSERT ON usage_request_stats_archive
                 BEGIN
                    SELECT RAISE(ABORT, 'archive rejected for test');
                 END;",
            )?;
        }

        assert!(db.clear_request_logs_preserving_statistics().is_err());
        let conn = crate::database::lock_conn!(db.conn);
        let detail_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                row.get(0)
            })?;
        let archive_rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM usage_request_stats_archive",
            [],
            |row| row.get(0),
        )?;
        assert_eq!((detail_rows, archive_rows), (1, 0));
        Ok(())
    }

    #[test]
    fn count_retention_keeps_exact_newest_rows_with_timestamp_ties() -> Result<(), AppError> {
        let db = Database::memory()?;
        let timestamp = local_dt(2026, 2, 11, 12, 0, 0).timestamp();

        {
            let conn = crate::database::lock_conn!(db.conn);
            for i in 0..5 {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                    ) VALUES (?1, 'p1', 'claude', 'claude-3', 20, 10, '0.02', 100, 200, ?2)",
                    rusqlite::params![format!("retention-tie-{i}"), timestamp],
                )?;
            }
        }

        assert_eq!(db.prune_request_logs_to_minimum(2)?, 3);
        let (remaining, archived, remaining_ids): (i64, i64, String) = {
            let conn = crate::database::lock_conn!(db.conn);
            let remaining =
                conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                    row.get(0)
                })?;
            let archived = conn.query_row(
                "SELECT COUNT(*) FROM usage_request_stats_archive",
                [],
                |row| row.get(0),
            )?;
            let remaining_ids = conn.query_row(
                "SELECT GROUP_CONCAT(request_id, ',') FROM (
                    SELECT request_id FROM proxy_request_logs ORDER BY rowid
                 )",
                [],
                |row| row.get(0),
            )?;
            (remaining, archived, remaining_ids)
        };
        assert_eq!(remaining, 2);
        assert_eq!(archived, 3);
        assert_eq!(remaining_ids, "retention-tie-3,retention-tie-4");

        let summary = db.get_usage_summary(None, None, Some("claude"), None, None)?;
        assert_eq!(summary.total_requests, 5);
        Ok(())
    }

    #[test]
    fn retention_upserts_authoritative_detail_without_losing_reused_id() -> Result<(), AppError> {
        let db = Database::memory()?;
        let old_timestamp = local_dt(2026, 2, 10, 12, 0, 0).timestamp();
        let current_timestamp = old_timestamp + 60;
        {
            let conn = crate::database::lock_conn!(db.conn);
            for (created_at, input_tokens, model) in [
                (old_timestamp, 10, "older-fact"),
                (current_timestamp, 20, "stale-fact"),
            ] {
                conn.execute(
                    "INSERT INTO usage_request_stats_archive (
                        request_id, provider_id, app_type, model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                     ) VALUES ('reused-upsert-id', 'p1', 'claude', ?1,
                               ?2, 1, '0.01', 10, 200, ?3)",
                    rusqlite::params![model, input_tokens, created_at],
                )?;
            }
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                 ) VALUES ('reused-upsert-id', 'p2', 'claude', 'authoritative-fact',
                           99, 2, '0.02', 20, 200, ?1)",
                [current_timestamp],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                 ) VALUES ('retained-newest', 'p3', 'claude', 'newest',
                           1, 1, '0.01', 10, 200, ?1)",
                [current_timestamp + 60],
            )?;
        }

        assert_eq!(db.prune_request_logs_to_minimum(1)?, 1);
        let conn = crate::database::lock_conn!(db.conn);
        let archive_rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM usage_request_stats_archive
             WHERE request_id = 'reused-upsert-id'",
            [],
            |row| row.get(0),
        )?;
        let current: (String, String, i64) = conn.query_row(
            "SELECT provider_id, model, input_tokens
             FROM usage_request_stats_archive
             WHERE request_id = 'reused-upsert-id' AND created_at = ?1",
            [current_timestamp],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(archive_rows, 2);
        assert_eq!(current, ("p2".into(), "authoritative-fact".into(), 99));
        Ok(())
    }

    #[test]
    fn automatic_retention_uses_hysteresis_then_converges_to_limit() -> Result<(), AppError> {
        let db = Database::memory()?;
        db.set_request_log_retention_config(true, 3)?;
        let timestamp = chrono::Utc::now().timestamp();

        {
            let conn = crate::database::lock_conn!(db.conn);
            for i in 0..103 {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model,
                        input_tokens, output_tokens, total_cost_usd,
                        latency_ms, status_code, created_at
                    ) VALUES (?1, 'p1', 'claude', 'claude-3', 1, 1, '0.01', 10, 200, ?2)",
                    rusqlite::params![format!("auto-retain-{i}"), timestamp + i],
                )?;
            }
        }

        assert_eq!(db.prune_request_logs_if_needed()?, 0);
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                 ) VALUES ('auto-retain-trigger', 'p1', 'claude', 'claude-3',
                           1, 1, '0.01', 10, 200, ?1)",
                [timestamp + 104],
            )?;
        }

        assert_eq!(db.prune_request_logs_if_needed()?, 101);
        let conn = crate::database::lock_conn!(db.conn);
        let remaining: i64 =
            conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                row.get(0)
            })?;
        let archived: i64 = conn.query_row(
            "SELECT COUNT(*) FROM usage_request_stats_archive",
            [],
            |row| row.get(0),
        )?;
        assert_eq!((remaining, archived), (3, 101));
        Ok(())
    }

    #[test]
    fn rollup_retains_cross_cutoff_dedup_window() -> Result<(), AppError> {
        let db = Database::memory()?;
        let cutoff = local_dt(2026, 2, 11, 0, 0, 0).timestamp();
        {
            let conn = crate::database::lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, cache_read_tokens,
                    total_cost_usd, latency_ms, status_code, created_at, data_source
                 ) VALUES ('boundary-proxy', 'p1', 'codex', 'gpt-5',
                           100, 20, 10, '0.01', 10, 200, ?1, 'proxy')",
                [cutoff - 300],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, cache_read_tokens,
                    total_cost_usd, latency_ms, status_code, created_at, data_source
                 ) VALUES ('boundary-session', '_codex_session', 'codex', 'gpt-5',
                           100, 20, 10, '0.01', 0, 200, ?1, 'codex_session')",
                [cutoff + 100],
            )?;
        }

        assert_eq!(db.rollup_and_prune_before(cutoff, "test-boundary")?, 0);
        let conn = crate::database::lock_conn!(db.conn);
        let remaining: i64 =
            conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
                row.get(0)
            })?;
        let rollups: i64 =
            conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                row.get(0)
            })?;
        assert_eq!((remaining, rollups), (2, 0));
        Ok(())
    }

    #[test]
    fn request_log_retention_config_round_trips_and_clamps() -> Result<(), AppError> {
        let db = Database::memory()?;
        assert_eq!(
            db.get_request_log_retention_config()?,
            (true, super::DEFAULT_REQUEST_LOG_RETAIN_COUNT)
        );

        assert_eq!(db.set_request_log_retention_config(true, 42)?, (true, 42));
        assert_eq!(db.get_request_log_retention_config()?, (true, 42));
        assert_eq!(
            db.set_request_log_retention_config(true, u32::MAX)?,
            (true, super::MAX_REQUEST_LOG_RETAIN_COUNT)
        );
        Ok(())
    }
}
