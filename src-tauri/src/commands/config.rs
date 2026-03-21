#![allow(non_snake_case)]

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::app_config::AppType;
use crate::codex_config;
use crate::config::{self, get_claude_settings_path, ConfigStatus};
use crate::settings;

#[tauri::command]
pub async fn get_claude_config_status() -> Result<ConfigStatus, String> {
    Ok(config::get_claude_config_status())
}

use std::str::FromStr;

fn invalid_json_format_error(error: serde_json::Error) -> String {
    let lang = settings::get_settings()
        .language
        .unwrap_or_else(|| "zh".to_string());

    match lang.as_str() {
        "en" => format!("Invalid JSON format: {error}"),
        "ja" => format!("JSON形式が無効です: {error}"),
        _ => format!("无效的 JSON 格式: {error}"),
    }
}

fn provider_default_template_key(app_type: &str) -> String {
    format!("provider_default_template_{app_type}")
}

fn validate_provider_default_template_placeholders(
    app_type: &str,
    template: &str,
) -> Result<(), String> {
    let allowed: &[&str] = match app_type {
        "claude" => &[
            "api_key",
            "base_url",
            "model",
            "reasoning_model",
            "haiku_model",
            "sonnet_model",
            "opus_model",
        ],
        "codex" => &["api_key", "base_url", "model", "reasoning_effort"],
        "gemini" => &["api_key", "base_url", "model"],
        _ => return Ok(()),
    };

    let placeholder_re =
        regex::Regex::new(r"\{\{([^{}]+)\}\}").map_err(|e| format!("占位符校验初始化失败: {e}"))?;

    for caps in placeholder_re.captures_iter(template) {
        let placeholder = caps
            .get(1)
            .map(|m| m.as_str().trim())
            .unwrap_or_default();
        if !allowed.contains(&placeholder) {
            return Err(format!(
                "默认 Provider 模板包含不支持的占位符: {{{{{placeholder}}}}}"
            ));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_config_status(app: String) -> Result<ConfigStatus, String> {
    match AppType::from_str(&app).map_err(|e| e.to_string())? {
        AppType::Claude => Ok(config::get_claude_config_status()),
        AppType::Codex => {
            let auth_path = codex_config::get_codex_auth_path();
            let exists = auth_path.exists();
            let path = codex_config::get_codex_config_dir()
                .to_string_lossy()
                .to_string();

            Ok(ConfigStatus { exists, path })
        }
        AppType::Gemini => {
            let env_path = crate::gemini_config::get_gemini_env_path();
            let exists = env_path.exists();
            let path = crate::gemini_config::get_gemini_dir()
                .to_string_lossy()
                .to_string();

            Ok(ConfigStatus { exists, path })
        }
        AppType::OpenCode => {
            let config_path = crate::opencode_config::get_opencode_config_path();
            let exists = config_path.exists();
            let path = crate::opencode_config::get_opencode_dir()
                .to_string_lossy()
                .to_string();

            Ok(ConfigStatus { exists, path })
        }
        AppType::OpenClaw => {
            let config_path = crate::openclaw_config::get_openclaw_config_path();
            let exists = config_path.exists();
            let path = crate::openclaw_config::get_openclaw_dir()
                .to_string_lossy()
                .to_string();

            Ok(ConfigStatus { exists, path })
        }
    }
}

#[tauri::command]
pub async fn get_claude_code_config_path() -> Result<String, String> {
    Ok(get_claude_settings_path().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_config_dir(app: String) -> Result<String, String> {
    let dir = match AppType::from_str(&app).map_err(|e| e.to_string())? {
        AppType::Claude => config::get_claude_config_dir(),
        AppType::Codex => codex_config::get_codex_config_dir(),
        AppType::Gemini => crate::gemini_config::get_gemini_dir(),
        AppType::OpenCode => crate::opencode_config::get_opencode_dir(),
        AppType::OpenClaw => crate::openclaw_config::get_openclaw_dir(),
    };

    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_config_folder(handle: AppHandle, app: String) -> Result<bool, String> {
    let config_dir = match AppType::from_str(&app).map_err(|e| e.to_string())? {
        AppType::Claude => config::get_claude_config_dir(),
        AppType::Codex => codex_config::get_codex_config_dir(),
        AppType::Gemini => crate::gemini_config::get_gemini_dir(),
        AppType::OpenCode => crate::opencode_config::get_opencode_dir(),
        AppType::OpenClaw => crate::openclaw_config::get_openclaw_dir(),
    };

    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    handle
        .opener()
        .open_path(config_dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("打开文件夹失败: {e}"))?;

    Ok(true)
}

#[tauri::command]
pub async fn pick_directory(
    app: AppHandle,
    #[allow(non_snake_case)] defaultPath: Option<String>,
) -> Result<Option<String>, String> {
    let initial = defaultPath
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(path) = initial {
            builder = builder.set_directory(path);
        }
        builder.blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("弹出目录选择器失败: {e}"))?;

    match result {
        Some(file_path) => {
            let resolved = file_path
                .simplified()
                .into_path()
                .map_err(|e| format!("解析选择的目录失败: {e}"))?;
            Ok(Some(resolved.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn get_app_config_path() -> Result<String, String> {
    let config_path = config::get_app_config_path();
    Ok(config_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_app_config_folder(handle: AppHandle) -> Result<bool, String> {
    let config_dir = config::get_app_config_dir();

    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    handle
        .opener()
        .open_path(config_dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("打开文件夹失败: {e}"))?;

    Ok(true)
}

#[tauri::command]
pub async fn get_claude_common_config_snippet(
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Option<String>, String> {
    state
        .db
        .get_config_snippet("claude")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_claude_common_config_snippet(
    snippet: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<(), String> {
    if !snippet.trim().is_empty() {
        serde_json::from_str::<serde_json::Value>(&snippet).map_err(invalid_json_format_error)?;
    }

    let value = if snippet.trim().is_empty() {
        None
    } else {
        Some(snippet)
    };

    state
        .db
        .set_config_snippet("claude", value)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_common_config_snippet(
    app_type: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Option<String>, String> {
    state
        .db
        .get_config_snippet(&app_type)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_common_config_snippet(
    app_type: String,
    snippet: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<(), String> {
    if !snippet.trim().is_empty() {
        match app_type.as_str() {
            "claude" | "gemini" | "omo" | "omo-slim" => {
                serde_json::from_str::<serde_json::Value>(&snippet)
                    .map_err(invalid_json_format_error)?;
            }
            "codex" => {
                crate::codex_config::validate_codex_common_config_template(&snippet)
                    .map_err(|e| e.to_string())?;
            }
            _ => {}
        }
    }

    let value = if snippet.trim().is_empty() {
        None
    } else {
        Some(snippet)
    };

    state
        .db
        .set_config_snippet(&app_type, value)
        .map_err(|e| e.to_string())?;

    if matches!(app_type.as_str(), "claude" | "codex" | "gemini") {
        let app_enum = AppType::from_str(&app_type).map_err(|e| e.to_string())?;
        let current_id = crate::settings::get_effective_current_provider(&state.db, &app_enum)
            .map_err(|e| e.to_string())?;

        if let Some(current_id) = current_id {
            if let Some(provider) = state
                .db
                .get_provider_by_id(&current_id, &app_type)
                .map_err(|e| e.to_string())?
            {
                let has_backup = state
                    .db
                    .get_live_backup(&app_type)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_some();
                let live_taken_over = state
                    .proxy_service
                    .detect_takeover_in_live_config_for_app(&app_enum);
                let is_proxy_running = state.proxy_service.is_running().await;

                if (has_backup || live_taken_over) && is_proxy_running {
                    state
                        .proxy_service
                        .update_live_backup_from_provider(&app_type, &provider)
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    crate::services::provider::write_live_snapshot(&state.db, &app_enum, &provider)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    if app_type == "omo"
        && state
            .db
            .get_current_omo_provider("opencode", "omo")
            .map_err(|e| e.to_string())?
            .is_some()
    {
        crate::services::OmoService::write_config_to_file(
            state.inner(),
            &crate::services::omo::STANDARD,
        )
        .map_err(|e| e.to_string())?;
    }
    if app_type == "omo-slim"
        && state
            .db
            .get_current_omo_provider("opencode", "omo-slim")
            .map_err(|e| e.to_string())?
            .is_some()
    {
        crate::services::OmoService::write_config_to_file(
            state.inner(),
            &crate::services::omo::SLIM,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_provider_default_template(
    app_type: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Option<String>, String> {
    if !matches!(app_type.as_str(), "claude" | "codex" | "gemini") {
        return Err(format!("不支持的应用类型: {app_type}"));
    }

    state
        .db
        .get_setting(&provider_default_template_key(&app_type))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_provider_default_template(
    app_type: String,
    template: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<(), String> {
    if !matches!(app_type.as_str(), "claude" | "codex" | "gemini") {
        return Err(format!("不支持的应用类型: {app_type}"));
    }

    if !template.trim().is_empty() {
        serde_json::from_str::<serde_json::Value>(&template).map_err(invalid_json_format_error)?;
        validate_provider_default_template_placeholders(&app_type, &template)?;
    }

    let key = provider_default_template_key(&app_type);
    if template.trim().is_empty() {
        state.db.set_setting(&key, "").map_err(|e| e.to_string())?;
    } else {
        state
            .db
            .set_setting(&key, &template)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn extract_common_config_snippet(
    appType: String,
    settingsConfig: Option<String>,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<String, String> {
    let app = AppType::from_str(&appType).map_err(|e| e.to_string())?;

    if let Some(settings_config) = settingsConfig.filter(|s| !s.trim().is_empty()) {
        let settings: serde_json::Value =
            serde_json::from_str(&settings_config).map_err(invalid_json_format_error)?;

        return crate::services::provider::ProviderService::extract_common_config_snippet_from_settings(
            app,
            &settings,
        )
        .map_err(|e| e.to_string());
    }

    crate::services::provider::ProviderService::extract_common_config_snippet(&state, app)
        .map_err(|e| e.to_string())
}
