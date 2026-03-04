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
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT b.app_type, b.session_id, b.provider_id, p.name, b.pinned,
                        b.created_at, b.updated_at, b.last_seen_at
                 FROM session_provider_bindings b
                 LEFT JOIN providers p ON p.id = b.provider_id AND p.app_type = b.app_type
                 WHERE b.app_type = ?1 AND b.session_id = ?2
                 LIMIT 1",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut rows = stmt
            .query(params![app_type, session_id])
            .map_err(|e| AppError::Database(e.to_string()))?;

        if let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? {
            let last_seen_at: i64 = row.get(7).map_err(|e| AppError::Database(e.to_string()))?;
            let now_ms = chrono::Utc::now().timestamp_millis();
            let cutoff = now_ms - (idle_ttl_minutes as i64) * 60 * 1000;
            Ok(Some(SessionProviderBinding {
                app_type: row.get(0).map_err(|e| AppError::Database(e.to_string()))?,
                session_id: row.get(1).map_err(|e| AppError::Database(e.to_string()))?,
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
                Ok(SessionProviderBinding {
                    app_type: row.get(0)?,
                    session_id: row.get(1)?,
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
        let conn = lock_conn!(self.conn);
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
                session_id,
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
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE session_provider_bindings
             SET last_seen_at = ?3, updated_at = ?3
             WHERE app_type = ?1 AND session_id = ?2",
            params![app_type, session_id, timestamp_ms],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn set_session_provider_binding_pin(
        &self,
        app_type: &str,
        session_id: &str,
        pinned: bool,
        timestamp_ms: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE session_provider_bindings
             SET pinned = ?3, updated_at = ?4
             WHERE app_type = ?1 AND session_id = ?2",
            params![app_type, session_id, if pinned { 1 } else { 0 }, timestamp_ms],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn remove_session_provider_binding(
        &self,
        app_type: &str,
        session_id: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM session_provider_bindings WHERE app_type = ?1 AND session_id = ?2",
            params![app_type, session_id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
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

        let now_ms = chrono::Utc::now().timestamp_millis();
        let cutoff = now_ms - (idle_ttl_minutes as i64) * 60 * 1000;
        let conn = lock_conn!(self.conn);

        conn.execute(
            "DELETE FROM session_provider_bindings
             WHERE app_type = ?1 AND last_seen_at < ?2",
            params![app_type, cutoff],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        let existing = query_binding_on_conn(&conn, app_type, session_id)?;
        if let Some(binding) = existing.clone() {
            let in_candidates = candidate_provider_ids
                .iter()
                .any(|candidate| candidate == &binding.provider_id);

            if in_candidates {
                conn.execute(
                    "UPDATE session_provider_bindings
                     SET last_seen_at = ?3, updated_at = ?3
                     WHERE app_type = ?1 AND session_id = ?2",
                    params![app_type, session_id, now_ms],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;

                return Ok(Some(SessionProviderBinding {
                    app_type: app_type.to_string(),
                    session_id: session_id.to_string(),
                    provider_id: binding.provider_id,
                    provider_name: None,
                    pinned: binding.pinned,
                    created_at: binding.created_at,
                    updated_at: now_ms,
                    last_seen_at: now_ms,
                    is_active: true,
                }));
            }

            if binding.pinned {
                conn.execute(
                    "UPDATE session_provider_bindings
                     SET last_seen_at = ?3, updated_at = ?3
                     WHERE app_type = ?1 AND session_id = ?2",
                    params![app_type, session_id, now_ms],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;

                return Ok(Some(SessionProviderBinding {
                    app_type: app_type.to_string(),
                    session_id: session_id.to_string(),
                    provider_id: binding.provider_id,
                    provider_name: None,
                    pinned: true,
                    created_at: binding.created_at,
                    updated_at: now_ms,
                    last_seen_at: now_ms,
                    is_active: false,
                }));
            }
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
        let chosen_provider_id = match strategy.as_str() {
            "round_robin" => {
                let cursor = get_and_increment_session_round_robin_cursor_on_conn(&conn, app_type)?;
                let index = (cursor as usize) % target_pool.len();
                target_pool[index].clone()
            }
            "least_active" => {
                let mut chosen = target_pool[0].clone();
                let mut min_count = active_counts.get(&chosen).copied().unwrap_or(0);
                for provider_id in target_pool.iter().skip(1) {
                    let current = active_counts.get(provider_id).copied().unwrap_or(0);
                    if current < min_count {
                        min_count = current;
                        chosen = provider_id.clone();
                    }
                }
                chosen
            }
            "fixed" | "priority" => target_pool[0].clone(),
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
                session_id,
                chosen_provider_id,
                if pinned { 1 } else { 0 },
                created_at,
                now_ms,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(Some(SessionProviderBinding {
            app_type: app_type.to_string(),
            session_id: session_id.to_string(),
            provider_id: chosen_provider_id,
            provider_name: None,
            pinned,
            created_at,
            updated_at: now_ms,
            last_seen_at: now_ms,
            is_active: true,
        }))
    }

    pub fn sync_session_provider_after_success(
        &self,
        app_type: &str,
        session_id: &str,
        actual_provider_id: &str,
        idle_ttl_minutes: u32,
    ) -> Result<(), AppError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let cutoff = now_ms - (idle_ttl_minutes as i64) * 60 * 1000;
        let conn = lock_conn!(self.conn);

        conn.execute(
            "DELETE FROM session_provider_bindings
             WHERE app_type = ?1 AND last_seen_at < ?2",
            params![app_type, cutoff],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        let existing = query_binding_on_conn(&conn, app_type, session_id)?;
        if let Some(binding) = existing {
            if binding.pinned && binding.provider_id != actual_provider_id {
                conn.execute(
                    "UPDATE session_provider_bindings
                     SET last_seen_at = ?3, updated_at = ?3
                     WHERE app_type = ?1 AND session_id = ?2",
                    params![app_type, session_id, now_ms],
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
                return Ok(());
            }

            conn.execute(
                "UPDATE session_provider_bindings
                 SET provider_id = ?3, updated_at = ?4, last_seen_at = ?4
                 WHERE app_type = ?1 AND session_id = ?2",
                params![app_type, session_id, actual_provider_id, now_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
            return Ok(());
        }

        conn.execute(
            "INSERT INTO session_provider_bindings
             (app_type, session_id, provider_id, pinned, created_at, updated_at, last_seen_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4, ?4)",
            params![app_type, session_id, actual_provider_id, now_ms],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

        Ok(())
    }
}

#[derive(Debug, Clone)]
struct BindingRow {
    provider_id: String,
    pinned: bool,
    created_at: i64,
}

fn query_binding_on_conn(
    conn: &Connection,
    app_type: &str,
    session_id: &str,
) -> Result<Option<BindingRow>, AppError> {
    let result = conn.query_row(
        "SELECT provider_id, pinned, created_at
         FROM session_provider_bindings
         WHERE app_type = ?1 AND session_id = ?2
         LIMIT 1",
        params![app_type, session_id],
        |row| {
            Ok(BindingRow {
                provider_id: row.get(0)?,
                pinned: row.get::<_, i32>(1)? != 0,
                created_at: row.get(2)?,
            })
        },
    );

    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AppError::Database(e.to_string())),
    }
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
    use super::*;
    use crate::database::Database;
    use crate::provider::Provider;

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
}
