//! 使用统计服务
//!
//! 提供使用量数据的聚合查询功能

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use chrono::{Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::str::FromStr;

const REQUEST_LOG_CLEANUP_ENABLED_KEY: &str = "request_log_cleanup_enabled";
const REQUEST_LOG_RETENTION_DAYS_KEY: &str = "request_log_retention_days";
const REQUEST_LOG_LAST_CLEANUP_AT_KEY: &str = "request_log_last_cleanup_at";
const REQUEST_LOG_CLEAR_STATISTICS_KEY: &str = "request_log_cleanup_clear_statistics";
const DEFAULT_REQUEST_LOG_RETENTION_DAYS: u32 = 30;
const MIN_REQUEST_LOG_RETENTION_DAYS: u32 = 1;
const MAX_REQUEST_LOG_RETENTION_DAYS: u32 = 3650;
const REQUEST_LOG_AUTO_CLEANUP_INTERVAL_SECONDS: i64 = 60 * 60;

/// 使用量汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_requests: u64,
    pub total_cost: String,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub success_rate: f32,
}

/// 每日统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStats {
    pub date: String,
    pub request_count: u64,
    pub total_cost: String,
    pub total_tokens: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_cache_read_tokens: u64,
}

/// Provider 统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStats {
    pub provider_id: String,
    pub provider_name: String,
    pub request_count: u64,
    pub total_tokens: u64,
    pub total_cost: String,
    pub success_rate: f32,
    pub avg_latency_ms: u64,
}

/// 模型统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStats {
    pub model: String,
    pub request_count: u64,
    pub total_tokens: u64,
    pub total_cost: String,
    pub avg_cost_per_request: String,
}

/// 请求日志过滤器
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilters {
    pub app_type: Option<String>,
    pub provider_name: Option<String>,
    pub model: Option<String>,
    pub session_query: Option<String>,
    pub status_code: Option<u16>,
    pub session_routing_active: Option<bool>,
    pub start_date: Option<i64>,
    pub end_date: Option<i64>,
}

/// 分页请求日志响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedLogs {
    pub data: Vec<RequestLogDetail>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
}

/// 请求日志详情
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogDetail {
    pub request_id: String,
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub provider_is_public: bool,
    pub app_type: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_model: Option<String>,
    pub cost_multiplier: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_read_tokens: u32,
    pub cache_creation_tokens: u32,
    pub input_cost_usd: String,
    pub output_cost_usd: String,
    pub cache_read_cost_usd: String,
    pub cache_creation_cost_usd: String,
    pub total_cost_usd: String,
    pub is_streaming: bool,
    pub latency_ms: u64,
    pub first_token_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub status_code: u16,
    pub error_message: Option<String>,
    pub session_id: Option<String>,
    pub session_routing_active: bool,
    pub created_at: i64,
}

/// 请求日志清理配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogCleanupConfig {
    pub enabled: bool,
    pub retention_days: u32,
    pub last_cleanup_at: Option<i64>,
    #[serde(default)]
    pub clear_statistics: bool,
}

/// 请求日志清理结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogCleanupResult {
    pub deleted_rows: u64,
    pub cutoff_timestamp: i64,
    pub retention_days: u32,
}

/// 请求日志全量清空结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogClearResult {
    pub deleted_rows: u64,
}

#[derive(Debug, Default, Clone, Copy)]
struct UsageAggregate {
    request_count: i64,
    success_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    total_cost: f64,
}

impl UsageAggregate {
    fn add_assign(&mut self, other: UsageAggregate) {
        self.request_count += other.request_count;
        self.success_count += other.success_count;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.total_cost += other.total_cost;
    }
}

#[derive(Debug, Default, Clone)]
struct ProviderStatsAggregate {
    request_count: i64,
    success_count: i64,
    total_tokens: i64,
    total_cost: f64,
    latency_weighted_sum: f64,
}

#[derive(Debug, Default, Clone)]
struct ModelStatsAggregate {
    request_count: i64,
    total_tokens: i64,
    total_cost: f64,
}

impl Database {
    fn normalize_retention_days(retention_days: u32) -> u32 {
        retention_days.clamp(
            MIN_REQUEST_LOG_RETENTION_DAYS,
            MAX_REQUEST_LOG_RETENTION_DAYS,
        )
    }

    fn local_date_string(timestamp: i64) -> Option<String> {
        Local
            .timestamp_opt(timestamp, 0)
            .single()
            .map(|dt| dt.format("%Y-%m-%d").to_string())
    }

    fn cleanup_request_logs_with_options(
        &self,
        retention_days: u32,
        clear_statistics: bool,
    ) -> Result<RequestLogCleanupResult, AppError> {
        let normalized_retention_days = Self::normalize_retention_days(retention_days);
        let cutoff_timestamp =
            chrono::Utc::now().timestamp() - (normalized_retention_days as i64) * 24 * 60 * 60;

        let deleted_rows = if clear_statistics {
            let cutoff_date = Self::local_date_string(cutoff_timestamp)
                .ok_or_else(|| AppError::Database("无法计算日志清理截止日期".to_string()))?;
            let conn = lock_conn!(self.conn);
            let deleted_rows = conn
                .execute(
                    "DELETE FROM proxy_request_logs WHERE created_at < ?1",
                    params![cutoff_timestamp],
                )
                .map_err(|e| AppError::Database(format!("清理请求日志失败: {e}")))?;
            conn.execute(
                "DELETE FROM usage_daily_rollups WHERE date < ?1",
                params![cutoff_date],
            )
            .map_err(|e| AppError::Database(format!("清理使用统计失败: {e}")))?;
            deleted_rows as u64
        } else {
            self.rollup_and_prune_before_timestamp(cutoff_timestamp)?
        };

        Ok(RequestLogCleanupResult {
            deleted_rows,
            cutoff_timestamp,
            retention_days: normalized_retention_days,
        })
    }

    pub fn get_request_log_cleanup_config(&self) -> Result<RequestLogCleanupConfig, AppError> {
        let enabled = self
            .get_setting(REQUEST_LOG_CLEANUP_ENABLED_KEY)?
            .map(|value| value == "true" || value == "1")
            .unwrap_or(true);

        let retention_days = self
            .get_setting(REQUEST_LOG_RETENTION_DAYS_KEY)?
            .and_then(|value| value.parse::<u32>().ok())
            .map(Self::normalize_retention_days)
            .unwrap_or(DEFAULT_REQUEST_LOG_RETENTION_DAYS);

        let last_cleanup_at = self
            .get_setting(REQUEST_LOG_LAST_CLEANUP_AT_KEY)?
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value > 0);

        let clear_statistics = self
            .get_setting(REQUEST_LOG_CLEAR_STATISTICS_KEY)?
            .map(|value| value == "true" || value == "1")
            .unwrap_or(false);

        Ok(RequestLogCleanupConfig {
            enabled,
            retention_days,
            last_cleanup_at,
            clear_statistics,
        })
    }

    pub fn set_request_log_cleanup_config(
        &self,
        enabled: bool,
        retention_days: u32,
        clear_statistics: bool,
    ) -> Result<RequestLogCleanupConfig, AppError> {
        let normalized_retention_days = Self::normalize_retention_days(retention_days);
        self.set_setting(
            REQUEST_LOG_CLEANUP_ENABLED_KEY,
            if enabled { "true" } else { "false" },
        )?;
        self.set_setting(
            REQUEST_LOG_RETENTION_DAYS_KEY,
            normalized_retention_days.to_string().as_str(),
        )?;
        self.set_setting(
            REQUEST_LOG_CLEAR_STATISTICS_KEY,
            if clear_statistics { "true" } else { "false" },
        )?;
        self.get_request_log_cleanup_config()
    }

    pub fn cleanup_request_logs_with_retention_days(
        &self,
        retention_days: u32,
    ) -> Result<RequestLogCleanupResult, AppError> {
        self.cleanup_request_logs_with_options(retention_days, false)
    }

    pub fn cleanup_request_logs_now(
        &self,
        retention_days: Option<u32>,
        clear_statistics: Option<bool>,
    ) -> Result<RequestLogCleanupResult, AppError> {
        let config = self.get_request_log_cleanup_config()?;
        let effective_retention_days = retention_days
            .map(Self::normalize_retention_days)
            .unwrap_or(config.retention_days);
        let effective_clear_statistics = clear_statistics.unwrap_or(config.clear_statistics);

        let result = self.cleanup_request_logs_with_options(
            effective_retention_days,
            effective_clear_statistics,
        )?;
        self.set_setting(
            REQUEST_LOG_LAST_CLEANUP_AT_KEY,
            chrono::Utc::now().timestamp().to_string().as_str(),
        )?;
        Ok(result)
    }

    pub fn clear_request_logs_all(
        &self,
        clear_statistics: Option<bool>,
    ) -> Result<RequestLogClearResult, AppError> {
        let effective_clear_statistics =
            clear_statistics.unwrap_or(self.get_request_log_cleanup_config()?.clear_statistics);

        let deleted_rows = if effective_clear_statistics {
            let conn = lock_conn!(self.conn);
            let deleted_rows = conn
                .execute("DELETE FROM proxy_request_logs", [])
                .map_err(|e| AppError::Database(format!("清空请求日志失败: {e}")))?;
            conn.execute("DELETE FROM usage_daily_rollups", [])
                .map_err(|e| AppError::Database(format!("清空使用统计失败: {e}")))?;
            deleted_rows as u64
        } else {
            self.rollup_and_prune_before_timestamp(chrono::Utc::now().timestamp() + 1)?
        };

        self.set_setting(
            REQUEST_LOG_LAST_CLEANUP_AT_KEY,
            chrono::Utc::now().timestamp().to_string().as_str(),
        )?;
        Ok(RequestLogClearResult { deleted_rows })
    }

    pub fn maybe_cleanup_request_logs_if_due(
        &self,
        now_timestamp: i64,
    ) -> Result<Option<RequestLogCleanupResult>, AppError> {
        let config = self.get_request_log_cleanup_config()?;
        if !config.enabled {
            return Ok(None);
        }

        if let Some(last_cleanup_at) = config.last_cleanup_at {
            let elapsed = now_timestamp - last_cleanup_at;
            if (0..REQUEST_LOG_AUTO_CLEANUP_INTERVAL_SECONDS).contains(&elapsed) {
                return Ok(None);
            }
        }

        let result =
            self.cleanup_request_logs_with_options(config.retention_days, config.clear_statistics)?;
        self.set_setting(
            REQUEST_LOG_LAST_CLEANUP_AT_KEY,
            now_timestamp.to_string().as_str(),
        )?;
        Ok(Some(result))
    }

    fn build_rollup_date_bounds(
        start_date: Option<i64>,
        end_date: Option<i64>,
    ) -> (Option<String>, Option<String>) {
        (
            start_date.and_then(Self::local_date_string),
            end_date.and_then(Self::local_date_string),
        )
    }

    fn query_usage_aggregate_from_logs(
        conn: &Connection,
        start_date: Option<i64>,
        end_date: Option<i64>,
    ) -> Result<UsageAggregate, AppError> {
        let mut conditions = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(start) = start_date {
            conditions.push("created_at >= ?");
            params.push(Box::new(start));
        }
        if let Some(end) = end_date {
            conditions.push("created_at <= ?");
            params.push(Box::new(end));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let sql = format!(
            "SELECT
                COUNT(*) as total_requests,
                COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
                COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
                COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END), 0) as success_count
             FROM proxy_request_logs
             {where_clause}"
        );

        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.query_row(&sql, params_refs.as_slice(), |row| {
            Ok(UsageAggregate {
                request_count: row.get(0)?,
                total_cost: row.get(1)?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                cache_creation_tokens: row.get(4)?,
                cache_read_tokens: row.get(5)?,
                success_count: row.get(6)?,
            })
        })
        .map_err(|e| AppError::Database(e.to_string()))
    }

    fn query_usage_aggregate_from_rollups(
        conn: &Connection,
        start_date: Option<i64>,
        end_date: Option<i64>,
    ) -> Result<UsageAggregate, AppError> {
        let (start_day, end_day) = Self::build_rollup_date_bounds(start_date, end_date);
        let mut conditions = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(start_day) = start_day {
            conditions.push("date >= ?");
            params.push(Box::new(start_day));
        }
        if let Some(end_day) = end_day {
            conditions.push("date <= ?");
            params.push(Box::new(end_day));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let sql = format!(
            "SELECT
                COALESCE(SUM(request_count), 0) as total_requests,
                COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
                COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
                COALESCE(SUM(success_count), 0) as success_count
             FROM usage_daily_rollups
             {where_clause}"
        );

        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.query_row(&sql, params_refs.as_slice(), |row| {
            Ok(UsageAggregate {
                request_count: row.get(0)?,
                total_cost: row.get(1)?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                cache_creation_tokens: row.get(4)?,
                cache_read_tokens: row.get(5)?,
                success_count: row.get(6)?,
            })
        })
        .map_err(|e| AppError::Database(e.to_string()))
    }

    /// 获取使用量汇总
    pub fn get_usage_summary(
        &self,
        start_date: Option<i64>,
        end_date: Option<i64>,
    ) -> Result<UsageSummary, AppError> {
        let conn = lock_conn!(self.conn);
        let mut aggregate = Self::query_usage_aggregate_from_logs(&conn, start_date, end_date)?;
        aggregate.add_assign(Self::query_usage_aggregate_from_rollups(
            &conn, start_date, end_date,
        )?);

        let success_rate = if aggregate.request_count > 0 {
            (aggregate.success_count as f32 / aggregate.request_count as f32) * 100.0
        } else {
            0.0
        };

        Ok(UsageSummary {
            total_requests: aggregate.request_count as u64,
            total_cost: format!("{:.6}", aggregate.total_cost),
            total_input_tokens: aggregate.input_tokens as u64,
            total_output_tokens: aggregate.output_tokens as u64,
            total_cache_creation_tokens: aggregate.cache_creation_tokens as u64,
            total_cache_read_tokens: aggregate.cache_read_tokens as u64,
            success_rate,
        })
    }

    fn accumulate_daily_stat(
        target: &mut DailyStats,
        request_count: u64,
        total_cost: f64,
        total_tokens: u64,
        total_input_tokens: u64,
        total_output_tokens: u64,
        total_cache_creation_tokens: u64,
        total_cache_read_tokens: u64,
    ) {
        target.request_count += request_count;
        target.total_cost = format!(
            "{:.6}",
            target.total_cost.parse::<f64>().unwrap_or(0.0) + total_cost
        );
        target.total_tokens += total_tokens;
        target.total_input_tokens += total_input_tokens;
        target.total_output_tokens += total_output_tokens;
        target.total_cache_creation_tokens += total_cache_creation_tokens;
        target.total_cache_read_tokens += total_cache_read_tokens;
    }

    /// 获取每日趋势（滑动窗口，<=24h 按小时，>24h 按天，窗口与汇总一致）
    pub fn get_daily_trends(
        &self,
        start_date: Option<i64>,
        end_date: Option<i64>,
    ) -> Result<Vec<DailyStats>, AppError> {
        let conn = lock_conn!(self.conn);

        let end_ts = end_date.unwrap_or_else(|| Local::now().timestamp());
        let mut start_ts = start_date.unwrap_or_else(|| end_ts - 24 * 60 * 60);

        if start_ts >= end_ts {
            start_ts = end_ts - 24 * 60 * 60;
        }

        let duration = end_ts - start_ts;
        let bucket_seconds: i64 = if duration <= 24 * 60 * 60 {
            60 * 60
        } else {
            24 * 60 * 60
        };
        let mut bucket_count: i64 = if duration <= 0 {
            1
        } else {
            ((duration as f64) / bucket_seconds as f64).ceil() as i64
        };

        // 固定 24 小时窗口为 24 个小时桶，避免浮点误差
        if bucket_seconds == 60 * 60 {
            bucket_count = 24;
        }

        if bucket_count < 1 {
            bucket_count = 1;
        }

        let sql = "
            SELECT
                CAST((created_at - ?1) / ?3 AS INTEGER) as bucket_idx,
                COUNT(*) as request_count,
                COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
                COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
                COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens
            FROM proxy_request_logs
            WHERE created_at >= ?1 AND created_at <= ?2
            GROUP BY bucket_idx
            ORDER BY bucket_idx ASC";

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![start_ts, end_ts, bucket_seconds], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                DailyStats {
                    date: String::new(),
                    request_count: row.get::<_, i64>(1)? as u64,
                    total_cost: format!("{:.6}", row.get::<_, f64>(2)?),
                    total_tokens: row.get::<_, i64>(3)? as u64,
                    total_input_tokens: row.get::<_, i64>(4)? as u64,
                    total_output_tokens: row.get::<_, i64>(5)? as u64,
                    total_cache_creation_tokens: row.get::<_, i64>(6)? as u64,
                    total_cache_read_tokens: row.get::<_, i64>(7)? as u64,
                },
            ))
        })?;

        let mut map: HashMap<i64, DailyStats> = HashMap::new();
        for row in rows {
            let (mut bucket_idx, stat) = row?;
            if bucket_idx < 0 {
                continue;
            }
            if bucket_idx >= bucket_count {
                bucket_idx = bucket_count - 1;
            }
            let entry = map.entry(bucket_idx).or_insert_with(|| DailyStats {
                date: String::new(),
                request_count: 0,
                total_cost: "0.000000".to_string(),
                total_tokens: 0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                total_cache_creation_tokens: 0,
                total_cache_read_tokens: 0,
            });
            Self::accumulate_daily_stat(
                entry,
                stat.request_count,
                stat.total_cost.parse::<f64>().unwrap_or(0.0),
                stat.total_tokens,
                stat.total_input_tokens,
                stat.total_output_tokens,
                stat.total_cache_creation_tokens,
                stat.total_cache_read_tokens,
            );
        }

        if bucket_seconds == 24 * 60 * 60 {
            let (start_day, end_day) = Self::build_rollup_date_bounds(Some(start_ts), Some(end_ts));
            let mut conditions = Vec::new();
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

            if let Some(start_day) = start_day {
                conditions.push("date >= ?");
                params.push(Box::new(start_day));
            }
            if let Some(end_day) = end_day {
                conditions.push("date <= ?");
                params.push(Box::new(end_day));
            }

            let where_clause = if conditions.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", conditions.join(" AND "))
            };

            let rollup_sql = format!(
                "SELECT
                    date,
                    COALESCE(SUM(request_count), 0) as request_count,
                    COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
                    COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
                    COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                    COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                    COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
                    COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens
                 FROM usage_daily_rollups
                 {where_clause}
                 GROUP BY date
                 ORDER BY date ASC"
            );

            let params_refs: Vec<&dyn rusqlite::ToSql> =
                params.iter().map(|p| p.as_ref()).collect();
            let mut rollup_stmt = conn.prepare(&rollup_sql)?;
            let rollup_rows = rollup_stmt.query_map(params_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, f64>(2)?,
                    row.get::<_, i64>(3)? as u64,
                    row.get::<_, i64>(4)? as u64,
                    row.get::<_, i64>(5)? as u64,
                    row.get::<_, i64>(6)? as u64,
                    row.get::<_, i64>(7)? as u64,
                ))
            })?;

            for row in rollup_rows {
                let (
                    rollup_date,
                    request_count,
                    total_cost,
                    total_tokens,
                    total_input_tokens,
                    total_output_tokens,
                    total_cache_creation_tokens,
                    total_cache_read_tokens,
                ) = row?;

                let Ok(parsed_date) = NaiveDate::parse_from_str(&rollup_date, "%Y-%m-%d") else {
                    continue;
                };
                let Some(reference_time) = parsed_date.and_hms_opt(12, 0, 0) else {
                    continue;
                };
                let local_reference = Local
                    .from_local_datetime(&reference_time)
                    .earliest()
                    .or_else(|| Local.from_local_datetime(&reference_time).latest());
                let Some(local_reference) = local_reference else {
                    continue;
                };

                let mut bucket_idx = ((local_reference.timestamp() - start_ts) as f64
                    / bucket_seconds as f64)
                    .floor() as i64;
                if bucket_idx < 0 {
                    continue;
                }
                if bucket_idx >= bucket_count {
                    bucket_idx = bucket_count - 1;
                }

                let entry = map.entry(bucket_idx).or_insert_with(|| DailyStats {
                    date: String::new(),
                    request_count: 0,
                    total_cost: "0.000000".to_string(),
                    total_tokens: 0,
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                    total_cache_creation_tokens: 0,
                    total_cache_read_tokens: 0,
                });
                Self::accumulate_daily_stat(
                    entry,
                    request_count,
                    total_cost,
                    total_tokens,
                    total_input_tokens,
                    total_output_tokens,
                    total_cache_creation_tokens,
                    total_cache_read_tokens,
                );
            }
        }

        let mut stats = Vec::with_capacity(bucket_count as usize);
        for i in 0..bucket_count {
            let bucket_start_ts = start_ts + i * bucket_seconds;
            let bucket_start = Local
                .timestamp_opt(bucket_start_ts, 0)
                .single()
                .unwrap_or_else(Local::now);

            let date = bucket_start.to_rfc3339();

            if let Some(mut stat) = map.remove(&i) {
                stat.date = date;
                stats.push(stat);
            } else {
                stats.push(DailyStats {
                    date,
                    request_count: 0,
                    total_cost: "0.000000".to_string(),
                    total_tokens: 0,
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                    total_cache_creation_tokens: 0,
                    total_cache_read_tokens: 0,
                });
            }
        }

        Ok(stats)
    }

    /// 获取 Provider 统计
    pub fn get_provider_stats(&self) -> Result<Vec<ProviderStats>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut aggregates: HashMap<(String, String), ProviderStatsAggregate> = HashMap::new();
        let mut provider_names: HashMap<(String, String), String> = HashMap::new();

        {
            let mut names_stmt = conn.prepare("SELECT id, app_type, name FROM providers")?;
            let name_rows = names_stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in name_rows {
                let (provider_id, app_type, name) = row?;
                provider_names.insert((provider_id, app_type), name);
            }
        }

        {
            let sql = "SELECT
                    provider_id,
                    app_type,
                    COUNT(*) as request_count,
                    COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
                    COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
                    COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END), 0) as success_count,
                    COALESCE(SUM(CAST(latency_ms AS REAL)), 0) as latency_weighted_sum
                 FROM proxy_request_logs
                 GROUP BY provider_id, app_type";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    ProviderStatsAggregate {
                        request_count: row.get(2)?,
                        total_tokens: row.get(3)?,
                        total_cost: row.get(4)?,
                        success_count: row.get(5)?,
                        latency_weighted_sum: row.get(6)?,
                    },
                ))
            })?;

            for row in rows {
                let (provider_id, app_type, aggregate) = row?;
                let entry = aggregates.entry((provider_id, app_type)).or_default();
                entry.request_count += aggregate.request_count;
                entry.total_tokens += aggregate.total_tokens;
                entry.total_cost += aggregate.total_cost;
                entry.success_count += aggregate.success_count;
                entry.latency_weighted_sum += aggregate.latency_weighted_sum;
            }
        }

        {
            let sql = "SELECT
                    provider_id,
                    app_type,
                    COALESCE(SUM(request_count), 0) as request_count,
                    COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
                    COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
                    COALESCE(SUM(success_count), 0) as success_count,
                    COALESCE(SUM(avg_latency_ms * request_count), 0) as latency_weighted_sum
                 FROM usage_daily_rollups
                 GROUP BY provider_id, app_type";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    ProviderStatsAggregate {
                        request_count: row.get(2)?,
                        total_tokens: row.get(3)?,
                        total_cost: row.get(4)?,
                        success_count: row.get(5)?,
                        latency_weighted_sum: row.get(6)?,
                    },
                ))
            })?;

            for row in rows {
                let (provider_id, app_type, aggregate) = row?;
                let entry = aggregates.entry((provider_id, app_type)).or_default();
                entry.request_count += aggregate.request_count;
                entry.total_tokens += aggregate.total_tokens;
                entry.total_cost += aggregate.total_cost;
                entry.success_count += aggregate.success_count;
                entry.latency_weighted_sum += aggregate.latency_weighted_sum;
            }
        }

        let mut stats: Vec<ProviderStats> = aggregates
            .into_iter()
            .map(|((provider_id, app_type), aggregate)| {
                let request_count = aggregate.request_count.max(0) as u64;
                let success_rate = if aggregate.request_count > 0 {
                    (aggregate.success_count as f32 / aggregate.request_count as f32) * 100.0
                } else {
                    0.0
                };
                let avg_latency_ms = if aggregate.request_count > 0 {
                    (aggregate.latency_weighted_sum / aggregate.request_count as f64) as u64
                } else {
                    0
                };

                ProviderStats {
                    provider_id: provider_id.clone(),
                    provider_name: provider_names
                        .get(&(provider_id, app_type))
                        .cloned()
                        .unwrap_or_else(|| "Unknown".to_string()),
                    request_count,
                    total_tokens: aggregate.total_tokens.max(0) as u64,
                    total_cost: format!("{:.6}", aggregate.total_cost),
                    success_rate,
                    avg_latency_ms,
                }
            })
            .collect();

        stats.sort_by(|left, right| {
            let left_cost = f64::from_str(&left.total_cost).unwrap_or(0.0);
            let right_cost = f64::from_str(&right.total_cost).unwrap_or(0.0);
            right_cost
                .partial_cmp(&left_cost)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(stats)
    }

    /// 获取模型统计
    pub fn get_model_stats(&self) -> Result<Vec<ModelStats>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut aggregates: HashMap<String, ModelStatsAggregate> = HashMap::new();

        {
            let sql = "SELECT
                    model,
                    COUNT(*) as request_count,
                    COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
                    COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost
                 FROM proxy_request_logs
                 GROUP BY model";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ModelStatsAggregate {
                        request_count: row.get(1)?,
                        total_tokens: row.get(2)?,
                        total_cost: row.get(3)?,
                    },
                ))
            })?;

            for row in rows {
                let (model, aggregate) = row?;
                let entry = aggregates.entry(model).or_default();
                entry.request_count += aggregate.request_count;
                entry.total_tokens += aggregate.total_tokens;
                entry.total_cost += aggregate.total_cost;
            }
        }

        {
            let sql = "SELECT
                    model,
                    COALESCE(SUM(request_count), 0) as request_count,
                    COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
                    COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost
                 FROM usage_daily_rollups
                 GROUP BY model";

            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ModelStatsAggregate {
                        request_count: row.get(1)?,
                        total_tokens: row.get(2)?,
                        total_cost: row.get(3)?,
                    },
                ))
            })?;

            for row in rows {
                let (model, aggregate) = row?;
                let entry = aggregates.entry(model).or_default();
                entry.request_count += aggregate.request_count;
                entry.total_tokens += aggregate.total_tokens;
                entry.total_cost += aggregate.total_cost;
            }
        }

        let mut stats: Vec<ModelStats> = aggregates
            .into_iter()
            .map(|(model, aggregate)| {
                let avg_cost = if aggregate.request_count > 0 {
                    aggregate.total_cost / aggregate.request_count as f64
                } else {
                    0.0
                };

                ModelStats {
                    model,
                    request_count: aggregate.request_count.max(0) as u64,
                    total_tokens: aggregate.total_tokens.max(0) as u64,
                    total_cost: format!("{:.6}", aggregate.total_cost),
                    avg_cost_per_request: format!("{avg_cost:.6}"),
                }
            })
            .collect();

        stats.sort_by(|left, right| {
            let left_cost = f64::from_str(&left.total_cost).unwrap_or(0.0);
            let right_cost = f64::from_str(&right.total_cost).unwrap_or(0.0);
            right_cost
                .partial_cmp(&left_cost)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(stats)
    }

    /// 获取请求日志列表（分页）
    pub fn get_request_logs(
        &self,
        filters: &LogFilters,
        page: u32,
        page_size: u32,
    ) -> Result<PaginatedLogs, AppError> {
        let conn = lock_conn!(self.conn);

        let mut conditions = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(ref app_type) = filters.app_type {
            conditions.push("l.app_type = ?");
            params.push(Box::new(app_type.clone()));
        }
        if let Some(ref provider_name) = filters.provider_name {
            conditions.push("p.name LIKE ?");
            params.push(Box::new(format!("%{provider_name}%")));
        }
        if let Some(ref model) = filters.model {
            conditions.push("l.model LIKE ?");
            params.push(Box::new(format!("%{model}%")));
        }
        if let Some(ref session_query) = filters.session_query {
            conditions.push("COALESCE(l.session_id, '') LIKE ?");
            params.push(Box::new(format!("%{session_query}%")));
        }
        if let Some(status) = filters.status_code {
            conditions.push("l.status_code = ?");
            params.push(Box::new(status as i64));
        }
        if let Some(session_routing_active) = filters.session_routing_active {
            conditions.push("l.session_routing_active = ?");
            params.push(Box::new(if session_routing_active { 1 } else { 0 }));
        }
        if let Some(start) = filters.start_date {
            conditions.push("l.created_at >= ?");
            params.push(Box::new(start));
        }
        if let Some(end) = filters.end_date {
            conditions.push("l.created_at <= ?");
            params.push(Box::new(end));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        // 获取总数
        let count_sql = format!(
            "SELECT COUNT(*) FROM proxy_request_logs l
             LEFT JOIN providers p ON l.provider_id = p.id AND l.app_type = p.app_type
             {where_clause}"
        );
        let count_params: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let total: u32 = conn.query_row(&count_sql, count_params.as_slice(), |row| {
            row.get::<_, i64>(0).map(|v| v as u32)
        })?;

        // 获取数据
        let offset = page * page_size;
        params.push(Box::new(page_size as i64));
        params.push(Box::new(offset as i64));

        let sql = format!(
            "SELECT l.request_id, l.provider_id, p.name as provider_name, COALESCE(p.is_public, 0), l.app_type, l.model,
                    l.request_model, l.cost_multiplier,
                    l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_creation_tokens,
                    l.input_cost_usd, l.output_cost_usd, l.cache_read_cost_usd, l.cache_creation_cost_usd, l.total_cost_usd,
                    l.is_streaming, l.latency_ms, l.first_token_ms, l.duration_ms,
                    l.status_code, l.error_message, l.session_id, l.session_routing_active, l.created_at
             FROM proxy_request_logs l
             LEFT JOIN providers p ON l.provider_id = p.id AND l.app_type = p.app_type
             {where_clause}
             ORDER BY l.created_at DESC
             LIMIT ? OFFSET ?"
        );

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(RequestLogDetail {
                request_id: row.get(0)?,
                provider_id: row.get(1)?,
                provider_name: row.get(2)?,
                provider_is_public: row.get::<_, i64>(3).unwrap_or(0) != 0,
                app_type: row.get(4)?,
                model: row.get(5)?,
                request_model: row.get(6)?,
                cost_multiplier: row
                    .get::<_, Option<String>>(7)?
                    .unwrap_or_else(|| "1".to_string()),
                input_tokens: row.get::<_, i64>(8)? as u32,
                output_tokens: row.get::<_, i64>(9)? as u32,
                cache_read_tokens: row.get::<_, i64>(10)? as u32,
                cache_creation_tokens: row.get::<_, i64>(11)? as u32,
                input_cost_usd: row.get(12)?,
                output_cost_usd: row.get(13)?,
                cache_read_cost_usd: row.get(14)?,
                cache_creation_cost_usd: row.get(15)?,
                total_cost_usd: row.get(16)?,
                is_streaming: row.get::<_, i64>(17)? != 0,
                latency_ms: row.get::<_, i64>(18)? as u64,
                first_token_ms: row.get::<_, Option<i64>>(19)?.map(|v| v as u64),
                duration_ms: row.get::<_, Option<i64>>(20)?.map(|v| v as u64),
                status_code: row.get::<_, i64>(21)? as u16,
                error_message: row.get(22)?,
                session_id: row.get(23)?,
                session_routing_active: row.get::<_, i64>(24)? != 0,
                created_at: row.get(25)?,
            })
        })?;

        let mut logs = Vec::new();
        let mut provider_cache = HashMap::new();
        let mut pricing_cache = HashMap::new();

        for row in rows {
            let mut log = row?;
            Self::maybe_backfill_log_costs(
                &conn,
                &mut log,
                &mut provider_cache,
                &mut pricing_cache,
            )?;
            logs.push(log);
        }

        Ok(PaginatedLogs {
            data: logs,
            total,
            page,
            page_size,
        })
    }

    /// 获取单个请求详情
    pub fn get_request_detail(
        &self,
        request_id: &str,
    ) -> Result<Option<RequestLogDetail>, AppError> {
        let conn = lock_conn!(self.conn);

        let result = conn.query_row(
            "SELECT l.request_id, l.provider_id, p.name as provider_name, COALESCE(p.is_public, 0), l.app_type, l.model,
                    l.request_model, l.cost_multiplier,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
                    is_streaming, latency_ms, first_token_ms, duration_ms,
                    status_code, error_message, session_id, session_routing_active, created_at
             FROM proxy_request_logs l
             LEFT JOIN providers p ON l.provider_id = p.id AND l.app_type = p.app_type
             WHERE l.request_id = ?",
            [request_id],
            |row| {
                Ok(RequestLogDetail {
                    request_id: row.get(0)?,
                    provider_id: row.get(1)?,
                    provider_name: row.get(2)?,
                    provider_is_public: row.get::<_, i64>(3).unwrap_or(0) != 0,
                    app_type: row.get(4)?,
                    model: row.get(5)?,
                    request_model: row.get(6)?,
                    cost_multiplier: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "1".to_string()),
                    input_tokens: row.get::<_, i64>(8)? as u32,
                    output_tokens: row.get::<_, i64>(9)? as u32,
                    cache_read_tokens: row.get::<_, i64>(10)? as u32,
                    cache_creation_tokens: row.get::<_, i64>(11)? as u32,
                    input_cost_usd: row.get(12)?,
                    output_cost_usd: row.get(13)?,
                    cache_read_cost_usd: row.get(14)?,
                    cache_creation_cost_usd: row.get(15)?,
                    total_cost_usd: row.get(16)?,
                    is_streaming: row.get::<_, i64>(17)? != 0,
                    latency_ms: row.get::<_, i64>(18)? as u64,
                    first_token_ms: row.get::<_, Option<i64>>(19)?.map(|v| v as u64),
                    duration_ms: row.get::<_, Option<i64>>(20)?.map(|v| v as u64),
                    status_code: row.get::<_, i64>(21)? as u16,
                    error_message: row.get(22)?,
                    session_id: row.get(23)?,
                    session_routing_active: row.get::<_, i64>(24)? != 0,
                    created_at: row.get(25)?,
                })
            },
        );

        match result {
            Ok(mut detail) => {
                let mut provider_cache = HashMap::new();
                let mut pricing_cache = HashMap::new();
                Self::maybe_backfill_log_costs(
                    &conn,
                    &mut detail,
                    &mut provider_cache,
                    &mut pricing_cache,
                )?;
                Ok(Some(detail))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Database(e.to_string())),
        }
    }

    /// 检查 Provider 使用限额
    pub fn check_provider_limits(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<ProviderLimitStatus, AppError> {
        let conn = lock_conn!(self.conn);

        // 获取 provider 的限额设置
        let (limit_daily, limit_monthly) = conn
            .query_row(
                "SELECT meta FROM providers WHERE id = ? AND app_type = ?",
                params![provider_id, app_type],
                |row| {
                    let meta_str: String = row.get(0)?;
                    Ok(meta_str)
                },
            )
            .ok()
            .and_then(|meta_str| serde_json::from_str::<serde_json::Value>(&meta_str).ok())
            .map(|meta| {
                let daily = meta
                    .get("limitDailyUsd")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok());
                let monthly = meta
                    .get("limitMonthlyUsd")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok());
                (daily, monthly)
            })
            .unwrap_or((None, None));

        // 计算今日使用量
        let daily_usage: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0)
             FROM proxy_request_logs
             WHERE provider_id = ? AND app_type = ?
               AND date(datetime(created_at, 'unixepoch', 'localtime')) = date('now', 'localtime')",
                params![provider_id, app_type],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        // 计算本月使用量
        let monthly_usage: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0)
             FROM proxy_request_logs
             WHERE provider_id = ? AND app_type = ?
               AND strftime('%Y-%m', datetime(created_at, 'unixepoch', 'localtime')) = strftime('%Y-%m', 'now', 'localtime')",
                params![provider_id, app_type],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        let daily_exceeded = limit_daily
            .map(|limit| daily_usage >= limit)
            .unwrap_or(false);
        let monthly_exceeded = limit_monthly
            .map(|limit| monthly_usage >= limit)
            .unwrap_or(false);

        Ok(ProviderLimitStatus {
            provider_id: provider_id.to_string(),
            daily_usage: format!("{daily_usage:.6}"),
            daily_limit: limit_daily.map(|l| format!("{l:.2}")),
            daily_exceeded,
            monthly_usage: format!("{monthly_usage:.6}"),
            monthly_limit: limit_monthly.map(|l| format!("{l:.2}")),
            monthly_exceeded,
        })
    }
}

/// Provider 限额状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimitStatus {
    pub provider_id: String,
    pub daily_usage: String,
    pub daily_limit: Option<String>,
    pub daily_exceeded: bool,
    pub monthly_usage: String,
    pub monthly_limit: Option<String>,
    pub monthly_exceeded: bool,
}

#[derive(Clone)]
struct PricingInfo {
    input: rust_decimal::Decimal,
    output: rust_decimal::Decimal,
    cache_read: rust_decimal::Decimal,
    cache_creation: rust_decimal::Decimal,
}

impl Database {
    fn maybe_backfill_log_costs(
        conn: &Connection,
        log: &mut RequestLogDetail,
        provider_cache: &mut HashMap<(String, String), rust_decimal::Decimal>,
        pricing_cache: &mut HashMap<String, PricingInfo>,
    ) -> Result<(), AppError> {
        let total_cost = rust_decimal::Decimal::from_str(&log.total_cost_usd)
            .unwrap_or(rust_decimal::Decimal::ZERO);
        let has_cost = total_cost > rust_decimal::Decimal::ZERO;
        let has_usage = log.input_tokens > 0
            || log.output_tokens > 0
            || log.cache_read_tokens > 0
            || log.cache_creation_tokens > 0;

        if has_cost || !has_usage {
            return Ok(());
        }

        let pricing = match Self::get_model_pricing_cached(conn, pricing_cache, &log.model)? {
            Some(info) => info,
            None => return Ok(()),
        };
        let multiplier = Self::get_cost_multiplier_cached(
            conn,
            provider_cache,
            &log.provider_id,
            &log.app_type,
        )?;

        let million = rust_decimal::Decimal::from(1_000_000u64);

        // 与 CostCalculator::calculate 保持一致的计算逻辑：
        // 1. input_cost 需要扣除 cache_read_tokens（避免缓存部分被重复计费）
        // 2. 各项成本是基础成本（不含倍率）
        // 3. 倍率只作用于最终总价
        let billable_input_tokens =
            (log.input_tokens as u64).saturating_sub(log.cache_read_tokens as u64);
        let input_cost =
            rust_decimal::Decimal::from(billable_input_tokens) * pricing.input / million;
        let output_cost =
            rust_decimal::Decimal::from(log.output_tokens as u64) * pricing.output / million;
        let cache_read_cost = rust_decimal::Decimal::from(log.cache_read_tokens as u64)
            * pricing.cache_read
            / million;
        let cache_creation_cost = rust_decimal::Decimal::from(log.cache_creation_tokens as u64)
            * pricing.cache_creation
            / million;
        // 总成本 = 基础成本之和 × 倍率
        let base_total = input_cost + output_cost + cache_read_cost + cache_creation_cost;
        let total_cost = base_total * multiplier;

        log.input_cost_usd = format!("{input_cost:.6}");
        log.output_cost_usd = format!("{output_cost:.6}");
        log.cache_read_cost_usd = format!("{cache_read_cost:.6}");
        log.cache_creation_cost_usd = format!("{cache_creation_cost:.6}");
        log.total_cost_usd = format!("{total_cost:.6}");

        conn.execute(
            "UPDATE proxy_request_logs
             SET input_cost_usd = ?1,
                 output_cost_usd = ?2,
                 cache_read_cost_usd = ?3,
                 cache_creation_cost_usd = ?4,
                 total_cost_usd = ?5
             WHERE request_id = ?6",
            params![
                log.input_cost_usd,
                log.output_cost_usd,
                log.cache_read_cost_usd,
                log.cache_creation_cost_usd,
                log.total_cost_usd,
                log.request_id
            ],
        )
        .map_err(|e| AppError::Database(format!("更新请求成本失败: {e}")))?;

        Ok(())
    }

    fn get_cost_multiplier_cached(
        conn: &Connection,
        cache: &mut HashMap<(String, String), rust_decimal::Decimal>,
        provider_id: &str,
        app_type: &str,
    ) -> Result<rust_decimal::Decimal, AppError> {
        let key = (provider_id.to_string(), app_type.to_string());
        if let Some(multiplier) = cache.get(&key) {
            return Ok(*multiplier);
        }

        let meta_json: Option<String> = conn
            .query_row(
                "SELECT meta FROM providers WHERE id = ? AND app_type = ?",
                params![provider_id, app_type],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| AppError::Database(format!("查询 provider meta 失败: {e}")))?;

        let multiplier = meta_json
            .and_then(|meta| serde_json::from_str::<Value>(&meta).ok())
            .and_then(|value| value.get("costMultiplier").cloned())
            .and_then(|val| {
                val.as_str()
                    .and_then(|s| rust_decimal::Decimal::from_str(s).ok())
            })
            .unwrap_or(rust_decimal::Decimal::ONE);

        cache.insert(key, multiplier);
        Ok(multiplier)
    }

    fn get_model_pricing_cached(
        conn: &Connection,
        cache: &mut HashMap<String, PricingInfo>,
        model: &str,
    ) -> Result<Option<PricingInfo>, AppError> {
        if let Some(info) = cache.get(model) {
            return Ok(Some(info.clone()));
        }

        let row = find_model_pricing_row(conn, model)?;
        let Some((input, output, cache_read, cache_creation)) = row else {
            return Ok(None);
        };

        let pricing = PricingInfo {
            input: rust_decimal::Decimal::from_str(&input)
                .map_err(|e| AppError::Database(format!("解析输入价格失败: {e}")))?,
            output: rust_decimal::Decimal::from_str(&output)
                .map_err(|e| AppError::Database(format!("解析输出价格失败: {e}")))?,
            cache_read: rust_decimal::Decimal::from_str(&cache_read)
                .map_err(|e| AppError::Database(format!("解析缓存读取价格失败: {e}")))?,
            cache_creation: rust_decimal::Decimal::from_str(&cache_creation)
                .map_err(|e| AppError::Database(format!("解析缓存写入价格失败: {e}")))?,
        };

        cache.insert(model.to_string(), pricing.clone());
        Ok(Some(pricing))
    }
}

pub(crate) fn find_model_pricing_row(
    conn: &Connection,
    model_id: &str,
) -> Result<Option<(String, String, String, String)>, AppError> {
    // 清洗模型名称：去前缀(/)、去后缀(:)、@ 替换为 -
    // 例如 moonshotai/gpt-5.2-codex@low:v2 → gpt-5.2-codex-low
    let cleaned = model_id
        .rsplit_once('/')
        .map_or(model_id, |(_, r)| r)
        .split(':')
        .next()
        .unwrap_or(model_id)
        .trim()
        .replace('@', "-");

    // 精确匹配清洗后的名称
    let exact = conn
        .query_row(
            "SELECT input_cost_per_million, output_cost_per_million,
                    cache_read_cost_per_million, cache_creation_cost_per_million
             FROM model_pricing
             WHERE model_id = ?1",
            [&cleaned],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| AppError::Database(format!("查询模型定价失败: {e}")))?;

    if exact.is_none() {
        log::warn!("模型 {model_id}（清洗后: {cleaned}）未找到定价信息，成本将记录为 0");
    }

    Ok(exact)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_usage_log(
        conn: &Connection,
        request_id: &str,
        created_at: i64,
    ) -> Result<(), AppError> {
        conn.execute(
            "INSERT INTO proxy_request_logs (
                request_id, provider_id, app_type, model,
                input_tokens, output_tokens, total_cost_usd,
                latency_ms, status_code, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                request_id,
                "p1",
                "codex",
                "gpt-5.2-codex",
                100,
                20,
                "0.01",
                120,
                200,
                created_at
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    fn count_usage_logs(db: &Database) -> Result<i64, AppError> {
        let conn = lock_conn!(db.conn);
        conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
            row.get(0)
        })
        .map_err(|e| AppError::Database(e.to_string()))
    }

    #[test]
    fn request_log_cleanup_config_defaults() -> Result<(), AppError> {
        let db = Database::memory()?;
        let config = db.get_request_log_cleanup_config()?;
        assert!(config.enabled);
        assert_eq!(config.retention_days, DEFAULT_REQUEST_LOG_RETENTION_DAYS);
        assert!(config.last_cleanup_at.is_none());
        assert!(!config.clear_statistics);
        Ok(())
    }

    #[test]
    fn cleanup_request_logs_respects_retention_days() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 24 * 60 * 60;
        let recent_ts = now - 2 * 24 * 60 * 60;

        {
            let conn = lock_conn!(db.conn);
            insert_usage_log(&conn, "old-log", old_ts)?;
            insert_usage_log(&conn, "recent-log", recent_ts)?;
        }

        let cleanup = db.cleanup_request_logs_with_retention_days(30)?;
        assert_eq!(cleanup.deleted_rows, 1);
        assert_eq!(cleanup.retention_days, 30);

        assert_eq!(count_usage_logs(&db)?, 1);
        let conn = lock_conn!(db.conn);
        let remaining_id: String =
            conn.query_row("SELECT request_id FROM proxy_request_logs", [], |row| {
                row.get(0)
            })?;
        assert_eq!(remaining_id, "recent-log");
        let rollup_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                row.get(0)
            })?;
        assert_eq!(rollup_count, 1, "old logs should be rolled into statistics");

        Ok(())
    }

    #[test]
    fn maybe_cleanup_request_logs_throttles_within_interval() -> Result<(), AppError> {
        let db = Database::memory()?;
        db.set_request_log_cleanup_config(true, 1, false)?;
        let now = chrono::Utc::now().timestamp();
        let stale_ts = now - 2 * 24 * 60 * 60;

        {
            let conn = lock_conn!(db.conn);
            insert_usage_log(&conn, "stale-log-1", stale_ts)?;
        }

        let first_run = db.maybe_cleanup_request_logs_if_due(now)?;
        assert!(first_run.is_some());
        assert_eq!(count_usage_logs(&db)?, 0);

        {
            let conn = lock_conn!(db.conn);
            insert_usage_log(&conn, "stale-log-2", stale_ts)?;
        }

        let throttled = db.maybe_cleanup_request_logs_if_due(now + 30)?;
        assert!(throttled.is_none());
        assert_eq!(count_usage_logs(&db)?, 1);

        let second_run = db.maybe_cleanup_request_logs_if_due(
            now + REQUEST_LOG_AUTO_CLEANUP_INTERVAL_SECONDS + 1,
        )?;
        assert!(second_run.is_some());
        assert_eq!(count_usage_logs(&db)?, 0);

        Ok(())
    }

    #[test]
    fn clear_request_logs_all_preserves_statistics_by_default() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();

        {
            let conn = lock_conn!(db.conn);
            insert_usage_log(&conn, "log-1", now - 1000)?;
            insert_usage_log(&conn, "log-2", now - 500)?;
        }

        let clear_result = db.clear_request_logs_all(None)?;
        assert_eq!(clear_result.deleted_rows, 2);
        assert_eq!(count_usage_logs(&db)?, 0);
        let conn = lock_conn!(db.conn);
        let rollup_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                row.get(0)
            })?;
        assert_eq!(
            rollup_count, 1,
            "clear-all should keep aggregated statistics"
        );
        assert!(db
            .get_request_log_cleanup_config()?
            .last_cleanup_at
            .is_some());

        Ok(())
    }

    #[test]
    fn clear_request_logs_all_can_remove_statistics() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();

        {
            let conn = lock_conn!(db.conn);
            insert_usage_log(&conn, "log-1", now - 1000)?;
            conn.execute(
                "INSERT INTO usage_daily_rollups (
                    date, app_type, provider_id, model,
                    request_count, success_count,
                    input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens,
                    total_cost_usd, avg_latency_ms
                ) VALUES ('2026-01-01', 'codex', 'p1', 'gpt-5.2-codex', 3, 3, 300, 60, 0, 0, '0.03', 120)",
                [],
            )?;
        }

        let clear_result = db.clear_request_logs_all(Some(true))?;
        assert_eq!(clear_result.deleted_rows, 1);
        assert_eq!(count_usage_logs(&db)?, 0);

        let conn = lock_conn!(db.conn);
        let rollup_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                row.get(0)
            })?;
        assert_eq!(
            rollup_count, 0,
            "statistics should also be cleared when requested"
        );

        Ok(())
    }

    #[test]
    fn usage_summary_includes_rollups_after_cleanup() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 24 * 60 * 60;
        let recent_ts = now - 2 * 24 * 60 * 60;

        {
            let conn = lock_conn!(db.conn);
            insert_usage_log(&conn, "old-log", old_ts)?;
            insert_usage_log(&conn, "recent-log", recent_ts)?;
        }

        db.cleanup_request_logs_with_retention_days(30)?;

        let summary = db.get_usage_summary(None, None)?;
        assert_eq!(summary.total_requests, 2);
        assert_eq!(summary.total_input_tokens, 200);
        assert_eq!(summary.total_output_tokens, 40);
        assert_eq!(summary.total_cost, "0.020000");

        Ok(())
    }

    #[test]
    fn provider_and_model_stats_include_rollups_after_cleanup() -> Result<(), AppError> {
        let db = Database::memory()?;
        let now = chrono::Utc::now().timestamp();
        let old_ts = now - 40 * 24 * 60 * 60;
        db.save_provider(
            "codex",
            &crate::provider::Provider::with_id(
                "p1".to_string(),
                "Provider 1".to_string(),
                serde_json::json!({}),
                None,
            ),
        )?;

        {
            let conn = lock_conn!(db.conn);
            insert_usage_log(&conn, "old-log", old_ts)?;
        }

        db.cleanup_request_logs_with_retention_days(30)?;

        let provider_stats = db.get_provider_stats()?;
        assert_eq!(provider_stats.len(), 1);
        assert_eq!(provider_stats[0].provider_id, "p1");
        assert_eq!(provider_stats[0].request_count, 1);

        let model_stats = db.get_model_stats()?;
        assert_eq!(model_stats.len(), 1);
        assert_eq!(model_stats[0].model, "gpt-5.2-codex");
        assert_eq!(model_stats[0].request_count, 1);

        Ok(())
    }

    #[test]
    fn test_get_usage_summary() -> Result<(), AppError> {
        let db = Database::memory()?;

        // 插入测试数据
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params!["req1", "p1", "claude", "claude-3", 100, 50, "0.01", 100, 200, 1000],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params!["req2", "p1", "claude", "claude-3", 200, 100, "0.02", 150, 200, 2000],
            )?;
        }

        let summary = db.get_usage_summary(None, None)?;
        assert_eq!(summary.total_requests, 2);
        assert_eq!(summary.success_rate, 100.0);

        Ok(())
    }

    #[test]
    fn test_get_model_stats() -> Result<(), AppError> {
        let db = Database::memory()?;

        // 插入测试数据
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model,
                    input_tokens, output_tokens, total_cost_usd,
                    latency_ms, status_code, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    "req1",
                    "p1",
                    "claude",
                    "claude-3-sonnet",
                    100,
                    50,
                    "0.01",
                    100,
                    200,
                    1000
                ],
            )?;
        }

        let stats = db.get_model_stats()?;
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].model, "claude-3-sonnet");
        assert_eq!(stats[0].request_count, 1);

        Ok(())
    }

    #[test]
    fn test_model_pricing_matching() -> Result<(), AppError> {
        let db = Database::memory()?;
        let conn = lock_conn!(db.conn);

        // 准备额外定价数据，覆盖前缀/后缀清洗场景
        conn.execute(
            "INSERT OR REPLACE INTO model_pricing (
                model_id, display_name, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_creation_cost_per_million
            ) VALUES (?, ?, ?, ?, ?, ?)",
            params![
                "claude-haiku-4.5",
                "Claude Haiku 4.5",
                "1.0",
                "2.0",
                "0.0",
                "0.0"
            ],
        )?;

        // 测试精确匹配（seed_model_pricing 已预置 claude-sonnet-4-5-20250929）
        let result = find_model_pricing_row(&conn, "claude-sonnet-4-5-20250929")?;
        assert!(
            result.is_some(),
            "应该能精确匹配 claude-sonnet-4-5-20250929"
        );

        // 清洗：去除前缀和冒号后缀
        let result = find_model_pricing_row(&conn, "anthropic/claude-haiku-4.5")?;
        assert!(
            result.is_some(),
            "带前缀的模型 anthropic/claude-haiku-4.5 应能匹配到 claude-haiku-4.5"
        );
        let result = find_model_pricing_row(&conn, "moonshotai/kimi-k2-0905:exa")?;
        assert!(
            result.is_some(),
            "带前缀+冒号后缀的模型应清洗后匹配到 kimi-k2-0905"
        );

        // 清洗：@ 替换为 -（seed_model_pricing 已预置 gpt-5.2-codex-low）
        let result = find_model_pricing_row(&conn, "gpt-5.2-codex@low")?;
        assert!(
            result.is_some(),
            "带 @ 分隔符的模型 gpt-5.2-codex@low 应能匹配到 gpt-5.2-codex-low"
        );

        // 测试不存在的模型
        let result = find_model_pricing_row(&conn, "unknown-model-123")?;
        assert!(result.is_none(), "不应该匹配不存在的模型");

        Ok(())
    }
}
