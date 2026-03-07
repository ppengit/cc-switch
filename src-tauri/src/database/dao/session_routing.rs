use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MASTER_ENABLED_KEY: &str = "session_routing_master_enabled";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProviderBinding {
    pub app_type: String,
    pub session_id: String,
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
    #[serde(default)]
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionOccupancy {
    pub provider_id: String,
    pub provider_name: String,
    pub session_count: usize,
}

impl Database {
    pub fn get_session_routing_master_enabled(&self) -> Result<bool, AppError> {
        match self.get_setting(MASTER_ENABLED_KEY)? {
            Some(value) => Ok(value == "true" || value == "1"),
            None => Ok(false),
        }
    }

    pub fn set_session_routing_master_enabled(&self, enabled: bool) -> Result<(), AppError> {
        self.set_setting(MASTER_ENABLED_KEY, if enabled { "true" } else { "false" })
    }

    pub fn get_session_provider_binding(
        &self,
        app_type: &str,
        session_id: &str,
        idle_ttl_minutes: u32,
    ) -> Result<Option<SessionProviderBinding>, AppError> {
        let (canonical_session_id, legacy_session_id) =
            build_session_id_candidates(app_type, session_id);
        let conn = lock_conn!(self.conn);
        let mut stmt = if legacy_session_id.is_some() {
            conn.prepare(
                "SELECT b.app_type, b.session_id, b.provider_id, p.name, b.pinned,
                        b.created_at, b.updated_at, b.last_seen_at
                 FROM session_provider_bindings b
                 LEFT JOIN providers p ON p.id = b.provider_id AND p.app_type = b.app_type
                 WHERE b.app_type = ?1 AND (b.session_id = ?2 OR b.session_id = ?3)
                 ORDER BY CASE WHEN b.session_id = ?2 THEN 0 ELSE 1 END
                 LIMIT 1",
            )
            .map_err(|e| AppError::Database(e.to_string()))?
        } else {
            conn.prepare(
                "SELECT b.app_type, b.session_id, b.provider_id, p.name, b.pinned,
                        b.created_at, b.updated_at, b.last_seen_at
                 FROM session_provider_bindings b
                 LEFT JOIN providers p ON p.id = b.provider_id AND p.app_type = b.app_type
                 WHERE b.app_type = ?1 AND b.session_id = ?2
                 LIMIT 1",
            )
            .map_err(|e| AppError::Database(e.to_string()))?
        };

        let mut rows = if let Some(legacy_id) = legacy_session_id.as_ref() {
            stmt.query(params![app_type, canonical_session_id, legacy_id])
                .map_err(|e| AppError::Database(e.to_string()))?
        } else {
            stmt.query(params![app_type, canonical_session_id])
                .map_err(|e| AppError::Database(e.to_string()))?
        };

        if let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? {
            let last_seen_at: i64 = row.get(7).map_err(|e| AppError::Database(e.to_string()))?;
            let now_ms = chrono::Utc::now().timestamp_millis();
            let cutoff = now_ms - (idle_ttl_minutes as i64) * 60 * 1000;
            let stored_session_id: String =
                row.get(1).map_err(|e| AppError::Database(e.to_string()))?;
            let display_session_id = normalize_session_id_for_app(app_type, &stored_session_id);
            Ok(Some(SessionProviderBinding {
                app_type: row.get(0).map_err(|e| AppError::Database(e.to_string()))?,
                session_id: display_session_id,
                provider_id: row.get(2).map_err(|e| AppError::Database(e.to_string()))?,
                provider_name: row.get(3).ok(),
                pinned: row.get(4).map_err(|e| AppError::Database(e.to_string()))?,
                created_at: row.get(5).map_err(|e| AppError::Database(e.to_string()))?,
                updated_at: row.get(6).map_err(|e| AppError::Database(e.to_string()))?,
                last_seen_at,
                is_active: last_seen_at >= cutoff,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_session_provider_bindings(
        &self,
        app_type: &str,
        idle_ttl_minutes: u32,
    ) -> Result<Vec<SessionProviderBinding>, AppError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let cutoff = now_ms - (idle_ttl_minutes as i64) * 60 * 1000;

        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT b.app_type, b.session_id, b.provider_id, p.name, b.pinned,
                        b.created_at, b.updated_at, b.last_seen_at
                 FROM session_provider_bindings b
                 LEFT JOIN providers p ON p.id = b.provider_id AND p.app_type = b.app_type
                 WHERE b.app_type = ?1
                 ORDER BY b.last_seen_at DESC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let rows = stmt
            .query_map(params![app_type], |row| {
                let last_seen_at: i64 = row.get(7)?;
                let raw_session_id: String = row.get(1)?;
                let normalized_session_id = normalize_session_id_for_app(app_type, &raw_session_id);
                Ok(SessionProviderBinding {
                    app_type: row.get(0)?,
                    session_id: normalized_session_id,
                    provider_id: row.get(2)?,
                    provider_name: row.get(3).ok(),
                    pinned: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    last_seen_at,
                    is_active: last_seen_at >= cutoff,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut bindings = Vec::new();
        for row in rows {
            bindings.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(bindings)
    }

    pub fn upsert_session_provider_binding(
        &self,
        app_type: &str,
        session_id: &str,
        provider_id: &str,
        pinned: bool,
        timestamp_ms: i64,
    ) -> Result<(), AppError> {
        let (canonical_session_id, legacy_session_id) =
            build_session_id_candidates(app_type, session_id);
        let conn = lock_conn!(self.conn);
        if let Some(legacy_id) = legacy_session_id.as_ref() {
            migrate_legacy_binding_id_on_conn(
                &conn,
                app_type,
                legacy_id,
                canonical_session_id.as_str(),
                timestamp_ms,
            )?;
        }
        conn.execute(
            "INSERT INTO session_provider_bindings
             (app_type, session_id, provider_id, pinned, created_at, updated_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
             ON CONFLICT(app_type, session_id) DO UPDATE SET
               provider_id = excluded.provider_id,
               pinned = excluded.pinned,
               updated_at = excluded.updated_at,
               last_seen_at = excluded.last_seen_at",
            params![
                app_type,
                canonical_session_id,
                provider_id,
                if pinned { 1 } else { 0 },
                timestamp_ms
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn touch_session_provider_binding(
        &self,
        app_type: &str,
        session_id: &str,
        timestamp_ms: i64,
    ) -> Result<(), AppError> {
        let (canonical_session_id, legacy_session_id) =
            build_session_id_candidates(app_type, session_id);
        let conn = lock_conn!(self.conn);
        if let Some(legacy_id) = legacy_session_id.as_ref() {
            conn.execute(
                "UPDATE session_provider_bindings
                 SET last_seen_at = ?4, updated_at = ?4
                 WHERE app_type = ?1 AND (session_id = ?2 OR session_id = ?3)",
                params![app_type, canonical_session_id, legacy_id, timestamp_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        } else {
            conn.execute(
                "UPDATE session_provider_bindings
                 SET last_seen_at = ?3, updated_at = ?3
                 WHERE app_type = ?1 AND session_id = ?2",
                params![app_type, canonical_session_id, timestamp_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    pub fn set_session_provider_binding_pin(
        &self,
        app_type: &str,
        session_id: &str,
        pinned: bool,
        timestamp_ms: i64,
    ) -> Result<(), AppError> {
        let (canonical_session_id, legacy_session_id) =
            build_session_id_candidates(app_type, session_id);
        let conn = lock_conn!(self.conn);
        if let Some(legacy_id) = legacy_session_id.as_ref() {
            conn.execute(
                "UPDATE session_provider_bindings
                 SET pinned = ?4, updated_at = ?5
                 WHERE app_type = ?1 AND (session_id = ?2 OR session_id = ?3)",
                params![
                    app_type,
                    canonical_session_id,
                    legacy_id,
                    if pinned { 1 } else { 0 },
                    timestamp_ms
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        } else {
            conn.execute(
                "UPDATE session_provider_bindings
                 SET pinned = ?3, updated_at = ?4
                 WHERE app_type = ?1 AND session_id = ?2",
                params![
                    app_type,
                    canonical_session_id,
                    if pinned { 1 } else { 0 },
                    timestamp_ms
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    pub fn remove_session_provider_binding(
        &self,
        app_type: &str,
        session_id: &str,
    ) -> Result<(), AppError> {
        let (canonical_session_id, legacy_session_id) =
            build_session_id_candidates(app_type, session_id);
        let conn = lock_conn!(self.conn);
        if let Some(legacy_id) = legacy_session_id.as_ref() {
            conn.execute(
                "DELETE FROM session_provider_bindings
                 WHERE app_type = ?1 AND (session_id = ?2 OR session_id = ?3)",
                params![app_type, canonical_session_id, legacy_id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        } else {
            conn.execute(
                "DELETE FROM session_provider_bindings WHERE app_type = ?1 AND session_id = ?2",
                params![app_type, canonical_session_id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    pub fn clear_session_provider_bindings_for_app(&self, app_type: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM session_provider_bindings WHERE app_type = ?1",
            params![app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn clear_all_session_provider_bindings(&self) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("DELETE FROM session_provider_bindings", [])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn cleanup_expired_session_provider_bindings(
        &self,
        app_type: &str,
        idle_ttl_minutes: u32,
    ) -> Result<usize, AppError> {
        let cutoff = chrono::Utc::now().timestamp_millis() - (idle_ttl_minutes as i64) * 60 * 1000;
        let conn = lock_conn!(self.conn);
        let affected = conn
            .execute(
                "DELETE FROM session_provider_bindings
                 WHERE app_type = ?1 AND last_seen_at < ?2",
                params![app_type, cutoff],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(affected)
    }

    pub fn get_active_session_counts_map(
        &self,
        app_type: &str,
        idle_ttl_minutes: u32,
    ) -> Result<HashMap<String, usize>, AppError> {
        let cutoff = chrono::Utc::now().timestamp_millis() - (idle_ttl_minutes as i64) * 60 * 1000;
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT provider_id, COUNT(*)
                 FROM session_provider_bindings
                 WHERE app_type = ?1 AND last_seen_at >= ?2
                 GROUP BY provider_id",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let rows = stmt
            .query_map(params![app_type, cutoff], |row| {
                let provider_id: String = row.get(0)?;
                let count: i64 = row.get(1)?;
                Ok((provider_id, count.max(0) as usize))
            })
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut counts = HashMap::new();
        for row in rows {
            let (provider_id, count) = row.map_err(|e| AppError::Database(e.to_string()))?;
            counts.insert(provider_id, count);
        }
        Ok(counts)
    }

    pub fn get_provider_session_occupancy(
        &self,
        app_type: &str,
        idle_ttl_minutes: u32,
    ) -> Result<Vec<ProviderSessionOccupancy>, AppError> {
        let providers = self.get_all_providers(app_type)?;
        let counts = self.get_active_session_counts_map(app_type, idle_ttl_minutes)?;

        let mut result = Vec::new();
        for provider in providers.values() {
            result.push(ProviderSessionOccupancy {
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                session_count: *counts.get(&provider.id).unwrap_or(&0),
            });
        }
        Ok(result)
    }

    pub fn get_and_increment_session_round_robin_cursor(
        &self,
        app_type: &str,
    ) -> Result<u64, AppError> {
        let key = format!("session_routing_rr_cursor_{app_type}");
        let conn = lock_conn!(self.conn);

        let current = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key.clone()],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        let next = current.wrapping_add(1);
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, next.to_string()],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(current)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn assign_session_provider_from_candidates(
        &self,
        app_type: &str,
        session_id: &str,
        candidate_provider_ids: &[String],
        strategy: &str,
        max_sessions_per_provider: u32,
        allow_shared_when_exhausted: bool,
        idle_ttl_minutes: u32,
    ) -> Result<Option<SessionProviderBinding>, AppError> {
        if candidate_provider_ids.is_empty() {
            return Ok(None);
        }

        let (canonical_session_id, legacy_session_id) =
            build_session_id_candidates(app_type, session_id);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let cutoff = now_ms - (idle_ttl_minutes as i64) * 60 * 1000;
        let conn = lock_conn!(self.conn);

        let existing = query_binding_on_conn(&conn, app_type, canonical_session_id.as_str())?;
        if let Some(binding) = existing.as_ref() {
            if binding.session_id != canonical_session_id {
                migrate_legacy_binding_id_on_conn(
                    &conn,
                    app_type,
                    binding.session_id.as_str(),
                    canonical_session_id.as_str(),
                    now_ms,
                )?;
            }
        } else if let Some(legacy_id) = legacy_session_id.as_ref() {
            migrate_legacy_binding_id_on_conn(
                &conn,
                app_type,
                legacy_id,
                canonical_session_id.as_str(),
                now_ms,
            )?;
        }

        if let Some(binding) = existing.clone() {
            let in_candidates = candidate_provider_ids
                .iter()
                .any(|candidate| candidate == &binding.provider_id);

            if in_candidates {
                conn.execute(
                    "UPDATE session_provider_bindings
                     SET last_seen_at = ?3, updated_at = ?3
                     WHERE app_type = ?1 AND session_id = ?2",
                    params![app_type, canonical_session_id, now_ms],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;

                return Ok(Some(SessionProviderBinding {
                    app_type: app_type.to_string(),
                    session_id: canonical_session_id.clone(),
                    provider_id: binding.provider_id,
                    provider_name: None,
                    pinned: binding.pinned,
                    created_at: binding.created_at,
                    updated_at: now_ms,
                    last_seen_at: now_ms,
                    is_active: true,
                }));
            }

            // Existing binding is no longer in routing candidates.
            // Continue to reassign so session occupancy can move away from
            // unhealthy/degraded providers when routing policy changes.
        }

        let mut active_counts = HashMap::<String, usize>::new();
        let mut stmt = conn
            .prepare(
                "SELECT provider_id, COUNT(*)
                 FROM session_provider_bindings
                 WHERE app_type = ?1 AND last_seen_at >= ?2
                 GROUP BY provider_id",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![app_type, cutoff], |row| {
                let provider_id: String = row.get(0)?;
                let count: i64 = row.get(1)?;
                Ok((provider_id, count.max(0) as usize))
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        for row in rows {
            let (provider_id, count) = row.map_err(|e| AppError::Database(e.to_string()))?;
            active_counts.insert(provider_id, count);
        }

        let has_limit = max_sessions_per_provider > 0;
        let max_sessions = max_sessions_per_provider as usize;
        let eligible_provider_ids: Vec<String> = candidate_provider_ids
            .iter()
            .filter(|provider_id| {
                !has_limit
                    || active_counts
                        .get(provider_id.as_str())
                        .copied()
                        .unwrap_or(0)
                        < max_sessions
            })
            .cloned()
            .collect();

        let target_pool = if !eligible_provider_ids.is_empty() {
            eligible_provider_ids
        } else if allow_shared_when_exhausted {
            candidate_provider_ids.to_vec()
        } else {
            Vec::new()
        };

        if target_pool.is_empty() {
            return Ok(None);
        }

        let strategy = strategy.trim().to_ascii_lowercase();
        let choose_least_active = |pool: &[String]| -> String {
            let mut chosen = pool[0].clone();
            let mut min_count = active_counts.get(&chosen).copied().unwrap_or(0);
            for provider_id in pool.iter().skip(1) {
                let current = active_counts.get(provider_id).copied().unwrap_or(0);
                if current < min_count {
                    min_count = current;
                    chosen = provider_id.clone();
                }
            }
            chosen
        };
        let chosen_provider_id = match strategy.as_str() {
            "round_robin" => {
                let cursor = get_and_increment_session_round_robin_cursor_on_conn(&conn, app_type)?;
                let index = (cursor as usize) % target_pool.len();
                target_pool[index].clone()
            }
            "least_active" => choose_least_active(&target_pool),
            // Priority should still avoid immediate sharing when there are idle providers.
            // We keep queue order as tie-breaker by scanning in target_pool order.
            "priority" => choose_least_active(&target_pool),
            "fixed" => target_pool[0].clone(),
            _ => target_pool[0].clone(),
        };

        let (created_at, pinned) = match existing {
            Some(binding) => (binding.created_at, binding.pinned),
            None => (now_ms, false),
        };

        conn.execute(
            "INSERT INTO session_provider_bindings
             (app_type, session_id, provider_id, pinned, created_at, updated_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(app_type, session_id) DO UPDATE SET
               provider_id = excluded.provider_id,
               pinned = excluded.pinned,
               updated_at = excluded.updated_at,
               last_seen_at = excluded.last_seen_at",
            params![
                app_type,
                canonical_session_id,
                chosen_provider_id,
                if pinned { 1 } else { 0 },
                created_at,
                now_ms,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(Some(SessionProviderBinding {
            app_type: app_type.to_string(),
            session_id: canonical_session_id,
            provider_id: chosen_provider_id,
            provider_name: None,
            pinned,
            created_at,
            updated_at: now_ms,
            last_seen_at: now_ms,
            is_active: true,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reassign_session_provider_bindings_for_provider(
        &self,
        app_type: &str,
        provider_id: &str,
        candidate_provider_ids: &[String],
        strategy: &str,
        max_sessions_per_provider: u32,
        allow_shared_when_exhausted: bool,
        idle_ttl_minutes: u32,
    ) -> Result<usize, AppError> {
        if candidate_provider_ids.is_empty() {
            return Ok(0);
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        let cutoff = now_ms - (idle_ttl_minutes as i64) * 60 * 1000;
        let conn = lock_conn!(self.conn);

        let candidates: Vec<String> = candidate_provider_ids
            .iter()
            .filter(|candidate| candidate.as_str() != provider_id)
            .cloned()
            .collect();
        if candidates.is_empty() {
            return Ok(0);
        }

        let mut stmt = conn
            .prepare(
                "SELECT session_id
                 FROM session_provider_bindings
                 WHERE app_type = ?1 AND provider_id = ?2 AND last_seen_at >= ?3
                 ORDER BY last_seen_at DESC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![app_type, provider_id, cutoff], |row| {
                Ok(row.get::<_, String>(0)?)
            })
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }

        if sessions.is_empty() {
            return Ok(0);
        }

        let mut active_counts = HashMap::<String, usize>::new();
        let mut stmt = conn
            .prepare(
                "SELECT provider_id, COUNT(*)
                 FROM session_provider_bindings
                 WHERE app_type = ?1 AND last_seen_at >= ?2
                 GROUP BY provider_id",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![app_type, cutoff], |row| {
                let provider_id: String = row.get(0)?;
                let count: i64 = row.get(1)?;
                Ok((provider_id, count.max(0) as usize))
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        for row in rows {
            let (provider_id, count) = row.map_err(|e| AppError::Database(e.to_string()))?;
            active_counts.insert(provider_id, count);
        }

        let has_limit = max_sessions_per_provider > 0;
        let max_sessions = max_sessions_per_provider as usize;
        let strategy = strategy.trim().to_ascii_lowercase();
        let choose_least_active = |pool: &[String], counts: &HashMap<String, usize>| -> String {
            let mut chosen = pool[0].clone();
            let mut min_count = counts.get(&chosen).copied().unwrap_or(0);
            for provider_id in pool.iter().skip(1) {
                let current = counts.get(provider_id).copied().unwrap_or(0);
                if current < min_count {
                    min_count = current;
                    chosen = provider_id.clone();
                }
            }
            chosen
        };

        let mut reassigned = 0usize;
        for session_id in sessions {
            let eligible_provider_ids: Vec<String> = candidates
                .iter()
                .filter(|candidate| {
                    !has_limit
                        || active_counts.get(candidate.as_str()).copied().unwrap_or(0)
                            < max_sessions
                })
                .cloned()
                .collect();

            let pool = if !eligible_provider_ids.is_empty() {
                eligible_provider_ids
            } else if allow_shared_when_exhausted {
                candidates.clone()
            } else {
                continue;
            };

            let chosen_provider_id = match strategy.as_str() {
                "round_robin" => {
                    let cursor =
                        get_and_increment_session_round_robin_cursor_on_conn(&conn, app_type)?;
                    let index = (cursor as usize) % pool.len();
                    pool[index].clone()
                }
                "least_active" => choose_least_active(&pool, &active_counts),
                "priority" => choose_least_active(&pool, &active_counts),
                "fixed" => pool[0].clone(),
                _ => pool[0].clone(),
            };

            conn.execute(
                "UPDATE session_provider_bindings
                 SET provider_id = ?3, updated_at = ?4
                 WHERE app_type = ?1 AND session_id = ?2",
                params![app_type, session_id, chosen_provider_id, now_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

            if let Some(count) = active_counts.get_mut(provider_id) {
                if *count > 0 {
                    *count -= 1;
                }
            }
            *active_counts.entry(chosen_provider_id.clone()).or_insert(0) += 1;
            reassigned += 1;
        }

        Ok(reassigned)
    }

    pub fn sync_session_provider_after_success(
        &self,
        app_type: &str,
        session_id: &str,
        actual_provider_id: &str,
        _idle_ttl_minutes: u32,
    ) -> Result<(), AppError> {
        let (canonical_session_id, legacy_session_id) =
            build_session_id_candidates(app_type, session_id);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let conn = lock_conn!(self.conn);

        let existing = query_binding_on_conn(&conn, app_type, canonical_session_id.as_str())?;
        if let Some(binding) = existing.as_ref() {
            if binding.session_id != canonical_session_id {
                migrate_legacy_binding_id_on_conn(
                    &conn,
                    app_type,
                    binding.session_id.as_str(),
                    canonical_session_id.as_str(),
                    now_ms,
                )?;
            }
        } else if let Some(legacy_id) = legacy_session_id.as_ref() {
            migrate_legacy_binding_id_on_conn(
                &conn,
                app_type,
                legacy_id,
                canonical_session_id.as_str(),
                now_ms,
            )?;
        }

        if existing.is_some() {
            conn.execute(
                "UPDATE session_provider_bindings
                 SET provider_id = ?3, updated_at = ?4, last_seen_at = ?4
                 WHERE app_type = ?1 AND session_id = ?2",
                params![app_type, canonical_session_id, actual_provider_id, now_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
            return Ok(());
        }

        conn.execute(
            "INSERT INTO session_provider_bindings
             (app_type, session_id, provider_id, pinned, created_at, updated_at, last_seen_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4, ?4)",
            params![app_type, canonical_session_id, actual_provider_id, now_ms],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(())
    }
}

#[derive(Debug, Clone)]
struct BindingRow {
    session_id: String,
    provider_id: String,
    pinned: bool,
    created_at: i64,
}

fn query_binding_on_conn(
    conn: &Connection,
    app_type: &str,
    session_id: &str,
) -> Result<Option<BindingRow>, AppError> {
    let (canonical_session_id, legacy_session_id) =
        build_session_id_candidates(app_type, session_id);
    let result = if let Some(legacy_id) = legacy_session_id.as_ref() {
        conn.query_row(
            "SELECT session_id, provider_id, pinned, created_at
             FROM session_provider_bindings
             WHERE app_type = ?1 AND (session_id = ?2 OR session_id = ?3)
             ORDER BY CASE WHEN session_id = ?2 THEN 0 ELSE 1 END
             LIMIT 1",
            params![app_type, canonical_session_id, legacy_id],
            |row| {
                Ok(BindingRow {
                    session_id: row.get(0)?,
                    provider_id: row.get(1)?,
                    pinned: row.get::<_, i32>(2)? != 0,
                    created_at: row.get(3)?,
                })
            },
        )
    } else {
        conn.query_row(
            "SELECT session_id, provider_id, pinned, created_at
             FROM session_provider_bindings
             WHERE app_type = ?1 AND session_id = ?2
             LIMIT 1",
            params![app_type, canonical_session_id],
            |row| {
                Ok(BindingRow {
                    session_id: row.get(0)?,
                    provider_id: row.get(1)?,
                    pinned: row.get::<_, i32>(2)? != 0,
                    created_at: row.get(3)?,
                })
            },
        )
    };

    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AppError::Database(e.to_string())),
    }
}

fn normalize_session_id_for_app(app_type: &str, session_id: &str) -> String {
    if app_type.eq_ignore_ascii_case("codex") {
        if let Some(stripped) = session_id.strip_prefix("codex_") {
            if !stripped.is_empty() {
                return stripped.to_string();
            }
        }
    }
    session_id.to_string()
}

fn build_session_id_candidates(app_type: &str, session_id: &str) -> (String, Option<String>) {
    let canonical = normalize_session_id_for_app(app_type, session_id);
    if app_type.eq_ignore_ascii_case("codex") {
        let legacy = format!("codex_{canonical}");
        if legacy != canonical {
            return (canonical, Some(legacy));
        }
    }
    (canonical, None)
}

fn migrate_legacy_binding_id_on_conn(
    conn: &Connection,
    app_type: &str,
    from_session_id: &str,
    to_session_id: &str,
    timestamp_ms: i64,
) -> Result<(), AppError> {
    if from_session_id == to_session_id {
        return Ok(());
    }

    let target_exists: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM session_provider_bindings
                WHERE app_type = ?1 AND session_id = ?2
            )",
            params![app_type, to_session_id],
            |row| row.get::<_, i32>(0),
        )
        .map(|v| v != 0)
        .map_err(|e| AppError::Database(e.to_string()))?;

    if target_exists {
        conn.execute(
            "DELETE FROM session_provider_bindings
             WHERE app_type = ?1 AND session_id = ?2",
            params![app_type, from_session_id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        return Ok(());
    }

    conn.execute(
        "UPDATE session_provider_bindings
         SET session_id = ?3, updated_at = ?4
         WHERE app_type = ?1 AND session_id = ?2",
        params![app_type, from_session_id, to_session_id, timestamp_ms],
    )
    .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

fn get_and_increment_session_round_robin_cursor_on_conn(
    conn: &Connection,
    app_type: &str,
) -> Result<u64, AppError> {
    let key = format!("session_routing_rr_cursor_{app_type}");
    let current = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key.clone()],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let next = current.wrapping_add(1);
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, next.to_string()],
    )
    .map_err(|e| AppError::Database(e.to_string()))?;

    Ok(current)
}

#[cfg(test)]
mod tests {
    use crate::database::Database;
    use crate::provider::Provider;
    use rusqlite::params;

    fn build_provider(id: &str, name: &str) -> Provider {
        Provider::with_id(
            id.to_string(),
            name.to_string(),
            serde_json::json!({ "env": {} }),
            None,
        )
    }

    #[test]
    fn assign_session_provider_respects_capacity() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let candidates = vec!["a".to_string(), "b".to_string()];
        let first = db
            .assign_session_provider_from_candidates(
                "codex",
                "s1",
                &candidates,
                "least_active",
                1,
                false,
                30,
            )
            .expect("assign first")
            .expect("binding first");
        let second = db
            .assign_session_provider_from_candidates(
                "codex",
                "s2",
                &candidates,
                "least_active",
                1,
                false,
                30,
            )
            .expect("assign second")
            .expect("binding second");

        assert_eq!(first.provider_id, "a");
        assert_eq!(second.provider_id, "b");
    }

    #[test]
    fn assign_session_provider_returns_none_when_exhausted_without_sharing() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");

        let candidates = vec!["a".to_string()];
        let first = db
            .assign_session_provider_from_candidates(
                "codex",
                "s1",
                &candidates,
                "fixed",
                1,
                false,
                30,
            )
            .expect("assign first");
        let second = db
            .assign_session_provider_from_candidates(
                "codex",
                "s2",
                &candidates,
                "fixed",
                1,
                false,
                30,
            )
            .expect("assign second");

        assert!(first.is_some());
        assert!(second.is_none());
    }

    #[test]
    fn get_session_provider_binding_supports_legacy_codex_prefix() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");

        let now_ms = chrono::Utc::now().timestamp_millis();
        {
            let conn = db.conn.lock().expect("lock db connection");
            conn.execute(
                "INSERT INTO session_provider_bindings
                 (app_type, session_id, provider_id, pinned, created_at, updated_at, last_seen_at)
                 VALUES (?1, ?2, ?3, 0, ?4, ?4, ?4)",
                params!["codex", "codex_test-session", "a", now_ms],
            )
            .expect("insert legacy binding");
        }

        let binding = db
            .get_session_provider_binding("codex", "test-session", 30)
            .expect("query binding")
            .expect("binding exists");

        assert_eq!(binding.session_id, "test-session");
        assert_eq!(binding.provider_id, "a");
    }

    #[test]
    fn upsert_session_provider_binding_migrates_legacy_codex_prefix() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let now_ms = chrono::Utc::now().timestamp_millis();
        {
            let conn = db.conn.lock().expect("lock db connection");
            conn.execute(
                "INSERT INTO session_provider_bindings
                 (app_type, session_id, provider_id, pinned, created_at, updated_at, last_seen_at)
                 VALUES (?1, ?2, ?3, 0, ?4, ?4, ?4)",
                params!["codex", "codex_test-session", "a", now_ms],
            )
            .expect("insert legacy binding");
        }

        db.upsert_session_provider_binding("codex", "test-session", "b", false, now_ms + 1000)
            .expect("upsert canonical binding");

        let bindings = db
            .list_session_provider_bindings("codex", 30)
            .expect("list bindings");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].session_id, "test-session");
        assert_eq!(bindings[0].provider_id, "b");
    }

    #[test]
    fn assign_session_provider_prefers_existing_binding_even_after_idle_expired() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let now_ms = chrono::Utc::now().timestamp_millis();
        let stale_ms = now_ms - 120 * 60 * 1000;
        {
            let conn = db.conn.lock().expect("lock db connection");
            conn.execute(
                "INSERT INTO session_provider_bindings
                 (app_type, session_id, provider_id, pinned, created_at, updated_at, last_seen_at)
                 VALUES (?1, ?2, ?3, 0, ?4, ?4, ?4)",
                params!["codex", "sticky-session", "a", stale_ms],
            )
            .expect("insert stale binding");
        }

        let counts_before = db
            .get_active_session_counts_map("codex", 30)
            .expect("counts before");
        assert_eq!(counts_before.get("a").copied().unwrap_or(0), 0);

        let candidates = vec!["a".to_string(), "b".to_string()];
        let binding = db
            .assign_session_provider_from_candidates(
                "codex",
                "sticky-session",
                &candidates,
                "least_active",
                1,
                false,
                30,
            )
            .expect("assign sticky")
            .expect("binding exists");

        assert_eq!(binding.provider_id, "a");

        let counts_after = db
            .get_active_session_counts_map("codex", 30)
            .expect("counts after");
        assert_eq!(counts_after.get("a").copied().unwrap_or(0), 1);
    }

    #[test]
    fn assign_session_provider_reassigns_when_existing_not_in_candidates() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let now_ms = chrono::Utc::now().timestamp_millis();
        db.upsert_session_provider_binding("codex", "switch-session", "a", false, now_ms)
            .expect("seed binding");

        let candidates = vec!["b".to_string()];
        let binding = db
            .assign_session_provider_from_candidates(
                "codex",
                "switch-session",
                &candidates,
                "priority",
                1,
                false,
                30,
            )
            .expect("assign switched")
            .expect("binding exists");

        assert_eq!(binding.provider_id, "b");
    }

    #[test]
    fn assign_session_provider_reassigns_pinned_when_existing_not_in_candidates() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let now_ms = chrono::Utc::now().timestamp_millis();
        db.upsert_session_provider_binding("codex", "switch-pinned-session", "a", true, now_ms)
            .expect("seed pinned binding");

        let candidates = vec!["b".to_string()];
        let binding = db
            .assign_session_provider_from_candidates(
                "codex",
                "switch-pinned-session",
                &candidates,
                "priority",
                1,
                false,
                30,
            )
            .expect("assign switched")
            .expect("binding exists");

        assert_eq!(binding.provider_id, "b");
        assert!(binding.pinned);
    }

    #[test]
    fn reassign_session_provider_bindings_moves_active_sessions() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let now_ms = chrono::Utc::now().timestamp_millis();
        db.upsert_session_provider_binding("codex", "rebalance-s1", "a", true, now_ms)
            .expect("seed binding s1");
        db.upsert_session_provider_binding("codex", "rebalance-s2", "a", false, now_ms)
            .expect("seed binding s2");

        let candidates = vec!["a".to_string(), "b".to_string()];
        let reassigned = db
            .reassign_session_provider_bindings_for_provider(
                "codex",
                "a",
                &candidates,
                "least_active",
                0,
                true,
                30,
            )
            .expect("reassign sessions");

        assert_eq!(reassigned, 2);

        let binding = db
            .get_session_provider_binding("codex", "rebalance-s1", 30)
            .expect("query binding s1")
            .expect("binding s1 exists");
        assert_eq!(binding.provider_id, "b");
        assert!(binding.pinned);
        assert_eq!(binding.last_seen_at, now_ms);

        let binding = db
            .get_session_provider_binding("codex", "rebalance-s2", 30)
            .expect("query binding s2")
            .expect("binding s2 exists");
        assert_eq!(binding.provider_id, "b");
        assert!(!binding.pinned);
        assert_eq!(binding.last_seen_at, now_ms);
    }

    #[test]
    fn assign_session_provider_priority_prefers_idle_provider_before_sharing() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let candidates = vec!["a".to_string(), "b".to_string()];
        let first = db
            .assign_session_provider_from_candidates(
                "codex",
                "priority-s1",
                &candidates,
                "priority",
                2,
                true,
                30,
            )
            .expect("assign first")
            .expect("binding first");
        let second = db
            .assign_session_provider_from_candidates(
                "codex",
                "priority-s2",
                &candidates,
                "priority",
                2,
                true,
                30,
            )
            .expect("assign second")
            .expect("binding second");

        assert_eq!(first.provider_id, "a");
        assert_eq!(second.provider_id, "b");
    }

    #[test]
    fn assign_session_provider_priority_shares_only_when_pool_exhausted() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let candidates = vec!["a".to_string(), "b".to_string()];
        let first = db
            .assign_session_provider_from_candidates(
                "codex",
                "priority-e1",
                &candidates,
                "priority",
                1,
                true,
                30,
            )
            .expect("assign first")
            .expect("binding first");
        let second = db
            .assign_session_provider_from_candidates(
                "codex",
                "priority-e2",
                &candidates,
                "priority",
                1,
                true,
                30,
            )
            .expect("assign second")
            .expect("binding second");
        let third = db
            .assign_session_provider_from_candidates(
                "codex",
                "priority-e3",
                &candidates,
                "priority",
                1,
                true,
                30,
            )
            .expect("assign third")
            .expect("binding third");

        assert_eq!(first.provider_id, "a");
        assert_eq!(second.provider_id, "b");
        assert!(third.provider_id == "a" || third.provider_id == "b");
    }

    #[test]
    fn sync_session_provider_after_success_updates_unpinned_binding() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let now_ms = chrono::Utc::now().timestamp_millis();
        db.upsert_session_provider_binding("codex", "sync-session", "a", false, now_ms)
            .expect("seed binding");

        db.sync_session_provider_after_success("codex", "sync-session", "b", 30)
            .expect("sync after success");

        let binding = db
            .get_session_provider_binding("codex", "sync-session", 30)
            .expect("query binding")
            .expect("binding exists");
        assert_eq!(binding.provider_id, "b");
        assert!(!binding.pinned);
    }

    #[test]
    fn sync_session_provider_after_success_updates_pinned_binding_provider() {
        let db = Database::memory().expect("init database");
        db.save_provider("codex", &build_provider("a", "A"))
            .expect("save provider a");
        db.save_provider("codex", &build_provider("b", "B"))
            .expect("save provider b");

        let now_ms = chrono::Utc::now().timestamp_millis();
        db.upsert_session_provider_binding("codex", "pinned-session", "a", true, now_ms)
            .expect("seed pinned binding");

        db.sync_session_provider_after_success("codex", "pinned-session", "b", 30)
            .expect("sync after success");

        let binding = db
            .get_session_provider_binding("codex", "pinned-session", 30)
            .expect("query binding")
            .expect("binding exists");
        assert_eq!(binding.provider_id, "b");
        assert!(binding.pinned);
    }
}
