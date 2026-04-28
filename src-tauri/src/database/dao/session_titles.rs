use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::OptionalExtension;
use rusqlite::params;

impl Database {
    fn normalize_session_source_path(source_path: Option<&str>) -> String {
        source_path.unwrap_or_default().to_string()
    }

    pub fn upsert_session_snapshot(
        &self,
        app_type: &str,
        session_id: &str,
        source_path: Option<&str>,
        detected_title: Option<&str>,
        project_dir: Option<&str>,
        last_active_at: Option<i64>,
    ) -> Result<(), AppError> {
        if session_id.trim().is_empty() {
            return Ok(());
        }

        let conn = lock_conn!(self.conn);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let normalized_source = Self::normalize_session_source_path(source_path);

        conn.execute(
            "INSERT INTO session_title_mappings (
                app_type, session_id, source_path, detected_title,
                project_dir, last_active_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(app_type, session_id, source_path) DO UPDATE SET
                detected_title = excluded.detected_title,
                project_dir = excluded.project_dir,
                last_active_at = excluded.last_active_at,
                updated_at = excluded.updated_at",
            params![
                app_type,
                session_id,
                normalized_source,
                detected_title,
                project_dir,
                last_active_at,
                now_ms,
            ],
        )
        .map_err(|e| AppError::Database(format!("保存会话快照失败: {e}")))?;

        Ok(())
    }

    pub fn get_custom_session_title(
        &self,
        app_type: &str,
        session_id: &str,
        source_path: Option<&str>,
    ) -> Result<Option<String>, AppError> {
        let conn = lock_conn!(self.conn);
        let normalized_source = Self::normalize_session_source_path(source_path);

        let value = conn
            .query_row(
            "SELECT custom_title
             FROM session_title_mappings
             WHERE app_type = ?1 AND session_id = ?2 AND source_path = ?3",
            params![app_type, session_id, normalized_source],
            |row| row.get::<_, Option<String>>(0),
        )
            .optional()
            .map_err(|e| AppError::Database(format!("读取会话标题映射失败: {e}")))?;

        Ok(value.flatten().filter(|title| !title.trim().is_empty()))
    }

    pub fn set_custom_session_title(
        &self,
        app_type: &str,
        session_id: &str,
        source_path: Option<&str>,
        custom_title: &str,
    ) -> Result<(), AppError> {
        if session_id.trim().is_empty() {
            return Err(AppError::Message("session_id 不能为空".to_string()));
        }

        let conn = lock_conn!(self.conn);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let normalized_source = Self::normalize_session_source_path(source_path);
        let normalized_title = custom_title.trim();

        conn.execute(
            "INSERT INTO session_title_mappings (
                app_type, session_id, source_path, custom_title, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(app_type, session_id, source_path) DO UPDATE SET
                custom_title = excluded.custom_title,
                updated_at = excluded.updated_at",
            params![
                app_type,
                session_id,
                normalized_source,
                normalized_title,
                now_ms,
            ],
        )
        .map_err(|e| AppError::Database(format!("保存会话标题映射失败: {e}")))?;

        Ok(())
    }

    pub fn clear_custom_session_title(
        &self,
        app_type: &str,
        session_id: &str,
        source_path: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let normalized_source = Self::normalize_session_source_path(source_path);

        conn.execute(
            "UPDATE session_title_mappings
             SET custom_title = NULL
             WHERE app_type = ?1 AND session_id = ?2 AND source_path = ?3",
            params![app_type, session_id, normalized_source],
        )
        .map_err(|e| AppError::Database(format!("清除会话标题映射失败: {e}")))?;

        Ok(())
    }

    pub fn get_session_context_for_log(
        &self,
        app_type: &str,
        session_id: &str,
    ) -> Result<(Option<String>, Option<String>), AppError> {
        if session_id.trim().is_empty() {
            return Ok((None, None));
        }

        let conn = lock_conn!(self.conn);
        let row = conn
            .query_row(
                "SELECT
                    COALESCE(NULLIF(custom_title, ''), NULLIF(detected_title, '')),
                    project_dir
                 FROM session_title_mappings
                 WHERE app_type = ?1 AND session_id = ?2
                 ORDER BY COALESCE(last_active_at, 0) DESC, updated_at DESC
                 LIMIT 1",
                params![app_type, session_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| AppError::Database(format!("读取会话日志上下文失败: {e}")))?;

        Ok(row.unwrap_or((None, None)))
    }
}
