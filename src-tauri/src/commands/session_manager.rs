#![allow(non_snake_case)]

use crate::session_manager;
use crate::store::AppState;
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

fn normalize_session_app_type(provider_id: &str) -> &str {
    // Session manager provider_id already matches app_type for supported apps.
    provider_id
}

fn sanitize_export_filename(value: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        "session".to_string()
    } else {
        sanitized
    }
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<session_manager::SessionMeta>, String> {
    let db = state.db.clone();
    let sessions = tauri::async_runtime::spawn_blocking(session_manager::scan_sessions)
        .await
        .map_err(|e| format!("Failed to scan sessions: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut merged = Vec::with_capacity(sessions.len());

        for mut session in sessions {
            let app_type = normalize_session_app_type(&session.provider_id);
            let source_path = session.source_path.clone();

            db.upsert_session_snapshot(
                app_type,
                &session.session_id,
                source_path.as_deref(),
                session.title.as_deref(),
                session.project_dir.as_deref(),
                session.last_active_at.or(session.created_at),
            )
            .map_err(|e| format!("Failed to upsert session snapshot: {e}"))?;

            if let Some(custom_title) = db
                .get_effective_session_title(app_type, &session.session_id, source_path.as_deref())
                .map_err(|e| format!("Failed to read effective session title: {e}"))?
            {
                session.title = Some(custom_title);
            }

            merged.push(session);
        }

        Ok::<Vec<session_manager::SessionMeta>, String>(merged)
    })
    .await
    .map_err(|e| format!("Failed to merge session title mappings: {e}"))?
}

#[tauri::command]
pub async fn list_recent_sessions(
    state: State<'_, AppState>,
    appType: String,
    limit: Option<usize>,
) -> Result<Vec<session_manager::SessionMeta>, String> {
    let db = state.db.clone();
    let app_type = appType.trim().to_string();
    let take = limit.unwrap_or(10).clamp(1, 50);
    let scan_app_type = app_type.clone();

    let sessions = tauri::async_runtime::spawn_blocking(move || {
        session_manager::scan_sessions_for_provider(&scan_app_type)
    })
    .await
    .map_err(|e| format!("Failed to scan recent sessions: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut merged = Vec::with_capacity(sessions.len().min(take));

        for mut session in sessions.into_iter().take(take) {
            let source_path = session.source_path.clone();

            db.upsert_session_snapshot(
                &app_type,
                &session.session_id,
                source_path.as_deref(),
                session.title.as_deref(),
                session.project_dir.as_deref(),
                session.last_active_at.or(session.created_at),
            )
            .map_err(|e| format!("Failed to upsert recent session snapshot: {e}"))?;

            if let Some(custom_title) = db
                .get_effective_session_title(&app_type, &session.session_id, source_path.as_deref())
                .map_err(|e| format!("Failed to read effective recent session title: {e}"))?
            {
                session.title = Some(custom_title);
            }

            merged.push(session);
        }

        Ok::<Vec<session_manager::SessionMeta>, String>(merged)
    })
    .await
    .map_err(|e| format!("Failed to merge recent session title mappings: {e}"))?
}

#[tauri::command]
pub async fn set_session_title_mapping(
    state: State<'_, AppState>,
    appType: String,
    sessionId: String,
    sourcePath: Option<String>,
    customTitle: String,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed_title = customTitle.trim().to_string();
        if trimmed_title.is_empty() {
            db.clear_custom_session_title(appType.trim(), sessionId.trim(), sourcePath.as_deref())
                .map_err(|e| format!("Failed to clear custom session title: {e}"))?;
        } else {
            db.set_custom_session_title(
                appType.trim(),
                sessionId.trim(),
                sourcePath.as_deref(),
                &trimmed_title,
            )
            .map_err(|e| format!("Failed to save custom session title: {e}"))?;
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("Failed to update session title mapping: {e}"))?
}

#[tauri::command]
pub async fn clear_session_title_mapping(
    state: State<'_, AppState>,
    appType: String,
    sessionId: String,
    sourcePath: Option<String>,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.clear_custom_session_title(appType.trim(), sessionId.trim(), sourcePath.as_deref())
            .map_err(|e| format!("Failed to clear custom session title: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("Failed to clear session title mapping: {e}"))?
}

#[tauri::command]
pub async fn get_session_messages(
    providerId: String,
    sourcePath: String,
) -> Result<Vec<session_manager::SessionMessage>, String> {
    let provider_id = providerId.clone();
    let source_path = sourcePath.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_manager::load_messages(&provider_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to load session messages: {e}"))?
}

#[tauri::command]
pub async fn launch_session_terminal(
    command: String,
    cwd: Option<String>,
    custom_config: Option<String>,
) -> Result<bool, String> {
    let command = command.clone();
    let cwd = cwd.clone();
    let custom_config = custom_config.clone();

    // Read preferred terminal from global settings
    let preferred = crate::settings::get_preferred_terminal();
    // Map global setting terminal names to session terminal names
    // Global uses "iterm2", session terminal uses "iterm"
    let target = match preferred.as_deref() {
        Some("iterm2") => "iterm".to_string(),
        Some(t) => t.to_string(),
        None => "terminal".to_string(), // Default to Terminal.app on macOS
    };

    tauri::async_runtime::spawn_blocking(move || {
        session_manager::terminal::launch_terminal(
            &target,
            &command,
            cwd.as_deref(),
            custom_config.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed to launch terminal: {e}"))??;

    Ok(true)
}

#[tauri::command]
pub async fn export_session_markdown(
    app: AppHandle,
    session: session_manager::SessionMeta,
) -> Result<Option<String>, String> {
    let source_path = session
        .source_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "会话缺少 sourcePath，无法导出".to_string())?
        .to_string();
    let provider_id = session.provider_id.clone();
    let default_name = format!(
        "{}.md",
        sanitize_export_filename(session.title.as_deref().unwrap_or(&session.session_id))
    );

    let messages = tauri::async_runtime::spawn_blocking(move || {
        session_manager::load_messages(&provider_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to load session messages for export: {e}"))??;

    let markdown = session_manager::export_session_markdown(&session, &messages);
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name(&default_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };

    let resolved_path = file_path
        .into_path()
        .map_err(|e| format!("解析保存路径失败: {e}"))?;
    crate::config::write_text_file(&resolved_path, &markdown)
        .map_err(|e| format!("写入导出文件失败: {e}"))?;

    Ok(Some(resolved_path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn delete_session(
    providerId: String,
    sessionId: String,
    sourcePath: String,
) -> Result<bool, String> {
    let provider_id = providerId.clone();
    let session_id = sessionId.clone();
    let source_path = sourcePath.clone();

    tauri::async_runtime::spawn_blocking(move || {
        session_manager::delete_session(&provider_id, &session_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to delete session: {e}"))?
}

#[tauri::command]
pub async fn delete_sessions(
    items: Vec<session_manager::DeleteSessionRequest>,
) -> Result<Vec<session_manager::DeleteSessionOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || session_manager::delete_sessions(&items))
        .await
        .map_err(|e| format!("Failed to delete sessions: {e}"))
}
