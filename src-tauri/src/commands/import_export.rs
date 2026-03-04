#![allow(non_snake_case)]

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::commands::sync_support::{
    post_sync_warning_from_result, run_post_import_sync, success_payload_with_warning,
};
use crate::database::backup::BackupEntry;
use crate::database::Database;
use crate::error::AppError;
use crate::services::provider::ProviderService;
use crate::settings;
use crate::store::AppState;

fn build_settings_sidecar_path(sql_path: &Path) -> PathBuf {
    let stem = sql_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("cc-switch-export");
    let file_name = format!("{stem}.settings.json");
    match sql_path.parent() {
        Some(parent) => parent.join(file_name),
        None => PathBuf::from(file_name),
    }
}

fn export_settings_sidecar(sql_path: &Path) -> Result<Option<PathBuf>, AppError> {
    let Some(settings_path) = settings::settings_file_path() else {
        return Ok(None);
    };
    if !settings_path.exists() {
        return Ok(None);
    }

    let sidecar_path = build_settings_sidecar_path(sql_path);
    if let Some(parent) = sidecar_path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    fs::copy(&settings_path, &sidecar_path).map_err(|e| AppError::io(&sidecar_path, e))?;
    Ok(Some(sidecar_path))
}

fn import_settings_sidecar(sql_path: &Path) -> Result<Option<PathBuf>, AppError> {
    let sidecar_path = build_settings_sidecar_path(sql_path);
    if !sidecar_path.exists() {
        return Ok(None);
    }

    if let Some(settings_path) = settings::settings_file_path() {
        if settings_path.exists() {
            let safety_path = settings_path.with_extension("json.bak");
            if let Err(err) = fs::copy(&settings_path, &safety_path) {
                log::warn!(
                    "Failed to create settings safety backup {}: {}",
                    safety_path.display(),
                    err
                );
            }
        }
    }

    let settings_data = settings::load_settings_from_path(&sidecar_path)?;
    settings::update_settings(settings_data)?;
    Ok(Some(sidecar_path))
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
        let mut warning: Option<String> = None;
        let settings_path = match export_settings_sidecar(&target_path) {
            Ok(path) => path,
            Err(err) => {
                warning = Some(format!("导出 settings 失败: {err}"));
                None
            }
        };

        let mut payload = json!({
            "success": true,
            "message": "SQL exported successfully",
            "filePath": filePath
        });
        if let Some(obj) = payload.as_object_mut() {
            if let Some(path) = settings_path {
                obj.insert(
                    "settingsPath".to_string(),
                    Value::String(path.to_string_lossy().to_string()),
                );
            }
            if let Some(msg) = warning {
                obj.insert("warning".to_string(), Value::String(msg));
            }
        }

        Ok::<_, AppError>(payload)
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
    let db_for_sync = db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path_buf = PathBuf::from(&filePath);
        let backup_id = db.import_sql(&path_buf)?;
        let mut warnings: Vec<String> = Vec::new();

        let settings_path = match import_settings_sidecar(&path_buf) {
            Ok(path) => path,
            Err(err) => {
                warnings.push(format!("导入 settings 失败: {err}"));
                None
            }
        };

        let sync_warning = post_sync_warning_from_result(Ok(run_post_import_sync(db_for_sync)));
        if let Some(msg) = sync_warning.as_ref() {
            log::warn!("[Import] post-import sync warning: {msg}");
            warnings.push(msg.clone());
        }

        let warning = if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("；"))
        };

        let mut payload = success_payload_with_warning(backup_id, warning);
        if let Some(obj) = payload.as_object_mut() {
            if let Some(path) = settings_path {
                obj.insert(
                    "settingsPath".to_string(),
                    Value::String(path.to_string_lossy().to_string()),
                );
            }
        }

        Ok::<_, AppError>(payload)
    })
    .await
    .map_err(|e| format!("导入配置失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
}

#[tauri::command]
pub async fn sync_current_providers_live(state: State<'_, AppState>) -> Result<Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = AppState::new(db);
        ProviderService::sync_current_to_live(&app_state)?;
        Ok::<_, AppError>(json!({
            "success": true,
            "message": "Live configuration synchronized"
        }))
    })
    .await
    .map_err(|e| format!("同步当前供应商失败: {e}"))?
    .map_err(|e: AppError| e.to_string())
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
        .add_filter("ZIP", &["zip"])
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
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.restore_from_backup(&filename))
        .await
        .map_err(|e| format!("Restore failed: {e}"))?
        .map_err(|e: AppError| e.to_string())
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
