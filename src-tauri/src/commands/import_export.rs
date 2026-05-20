#![allow(non_snake_case)]

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::commands::sync_support::{
    post_sync_warning_from_result, run_post_import_sync, success_payload_with_warning,
};
use crate::database::backup::BackupEntry;
use crate::database::Database;
use crate::error::AppError;
use crate::services::provider::ProviderService;
use crate::store::AppState;

async fn restore_db_backup_inner(state: &AppState, filename: String) -> Result<String, String> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || db.restore_from_backup(&filename))
        .await
        .map_err(|e| format!("Restore failed: {e}"))?
        .map_err(|e: AppError| e.to_string())?;

    let warning = post_sync_warning_from_result(Ok(run_post_import_sync(state)));
    if let Some(msg) = warning.as_ref() {
        log::warn!("[Backup Restore] post-restore sync warning: {msg}");
    }

    Ok(result)
}

// ─── File import/export ──────────────────────────────────────

/// 导出数据库为 SQL 备份
#[tauri::command]
pub async fn export_config_to_file(
    #[allow(non_snake_case)] filePath: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_path = PathBuf::from(&filePath);
        db.export_sql(&target_path)?;
        Ok::<_, AppError>(json!({
            "success": true,
            "message": "SQL exported successfully",
            "filePath": filePath
        }))
    })
    .await
    .map_err(|e| format!("导出配置失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

/// 从 SQL 备份导入数据库
#[tauri::command]
pub async fn import_config_from_file(
    #[allow(non_snake_case)] filePath: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let path_buf = PathBuf::from(&filePath);
        let backup_id = db.import_sql(&path_buf)?;
        Ok::<_, AppError>(backup_id)
    })
    .await
    .map_err(|e| format!("导入配置失败: {e}"))?
    .map_err(|e: AppError| e.to_string())?;

    let warning = post_sync_warning_from_result(Ok(run_post_import_sync(state.inner())));
    if let Some(msg) = warning.as_ref() {
        log::warn!("[Import] post-import sync warning: {msg}");
    }

    Ok(success_payload_with_warning(result, warning))
}

#[tauri::command]
pub async fn sync_current_providers_live(state: State<'_, AppState>) -> Result<Value, String> {
    ProviderService::sync_current_to_live(state.inner()).map_err(|e: AppError| e.to_string())?;
    Ok(json!({
        "success": true,
        "message": "Live configuration synchronized"
    }))
}

// ─── File dialogs ────────────────────────────────────────────

/// 保存文件对话框
#[tauri::command]
pub async fn save_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    #[allow(non_snake_case)] defaultName: String,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("SQL", &["sql"])
        .set_file_name(&defaultName)
        .blocking_save_file();

    Ok(result.map(|p| p.to_string()))
}

/// 打开文件对话框
#[tauri::command]
pub async fn open_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("SQL", &["sql"])
        .blocking_pick_file();

    Ok(result.map(|p| p.to_string()))
}

/// 打开 ZIP 文件选择对话框
#[tauri::command]
pub async fn open_zip_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("ZIP / Skill", &["zip", "skill"])
        .blocking_pick_file();

    Ok(result.map(|p| p.to_string()))
}

// ─── Database backup management ─────────────────────────────

/// Manually create a database backup
#[tauri::command]
pub async fn create_db_backup(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || match db.backup_database_file()? {
        Some(path) => Ok(path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default()),
        None => Err(AppError::Config(
            "Database file not found, backup skipped".to_string(),
        )),
    })
    .await
    .map_err(|e| format!("Backup failed: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

/// List all database backup files
#[tauri::command]
pub fn list_db_backups() -> Result<Vec<BackupEntry>, String> {
    Database::list_backups().map_err(|e| e.to_string())
}

/// Restore database from a backup file
#[tauri::command]
pub async fn restore_db_backup(
    state: State<'_, AppState>,
    filename: String,
) -> Result<String, String> {
    restore_db_backup_inner(state.inner(), filename).await
}

/// Rename a database backup file
#[tauri::command]
pub fn rename_db_backup(
    #[allow(non_snake_case)] oldFilename: String,
    #[allow(non_snake_case)] newName: String,
) -> Result<String, String> {
    Database::rename_backup(&oldFilename, &newName).map_err(|e| e.to_string())
}

/// Delete a database backup file
#[tauri::command]
pub fn delete_db_backup(filename: String) -> Result<(), String> {
    Database::delete_backup(&filename).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::restore_db_backup_inner;
    use crate::app_config::AppType;
    use crate::config::{get_claude_settings_path, read_json_file, write_json_file};
    use crate::database::Database;
    use crate::provider::Provider;
    use crate::proxy::types::ProxyConfig;
    use crate::store::AppState;
    use serde_json::{json, Value};
    use serial_test::serial;
    use std::env;
    use std::sync::Arc;
    use tempfile::TempDir;

    struct TempHome {
        #[allow(dead_code)]
        dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("failed to create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();
            let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();

            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());

            Self {
                dir,
                original_home,
                original_userprofile,
                original_test_home,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            if let Some(value) = &self.original_home {
                env::set_var("HOME", value);
            } else {
                env::remove_var("HOME");
            }

            if let Some(value) = &self.original_userprofile {
                env::set_var("USERPROFILE", value);
            } else {
                env::remove_var("USERPROFILE");
            }

            if let Some(value) = &self.original_test_home {
                env::set_var("CC_SWITCH_TEST_HOME", value);
            } else {
                env::remove_var("CC_SWITCH_TEST_HOME");
            }
        }
    }

    async fn reserve_free_tcp_port() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let port = listener
            .local_addr()
            .expect("read local addr for ephemeral port")
            .port();
        drop(listener);
        port
    }

    #[tokio::test]
    #[serial]
    async fn restore_db_backup_keeps_takeover_live_config_on_proxy_endpoint() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::init().expect("init db"));
        let state = AppState::new(db.clone());

        let provider = Provider::with_id(
            "claude-a".into(),
            "Claude A".into(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://api.a.example",
                    "ANTHROPIC_MODEL": "model-a"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");
        db.add_to_failover_queue("claude", &provider.id)
            .expect("queue claude provider");

        let port = reserve_free_tcp_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        db.clear_current_provider("claude")
            .expect("clear db current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Claude, None)
            .expect("clear local current provider for failover mode");

        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");

        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Claude, &provider)
            .await
            .expect("seed takeover live");

        let backup_path = db
            .backup_database_file()
            .expect("create backup")
            .expect("backup file path");
        let backup_filename = backup_path
            .file_name()
            .expect("backup file name")
            .to_string_lossy()
            .into_owned();

        write_json_file(&get_claude_settings_path(), &provider.settings_config)
            .expect("write stale direct live config");

        let stale_live: Value =
            read_json_file(&get_claude_settings_path()).expect("read stale claude live");
        assert_eq!(
            stale_live
                .pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(serde_json::Value::as_str),
            Some("https://api.a.example"),
            "test setup should reproduce the stale direct provider base url before restore"
        );

        restore_db_backup_inner(&state, backup_filename)
            .await
            .expect("restore backup and run post-sync");

        let live: Value =
            read_json_file(&get_claude_settings_path()).expect("read restored claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(serde_json::Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "backup restore must keep Claude live on the local proxy endpoint while takeover+failover are active"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(serde_json::Value::as_str),
            Some("PROXY_MANAGED"),
            "backup restore must preserve the takeover token placeholder instead of writing provider credentials back to live"
        );
    }
}
