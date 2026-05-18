#![allow(non_snake_case)]

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::app_config::AppType;
use crate::app_config_templates::{
    normalize_template_files, parse_stored_template_files, AppConfigTemplateFile,
};
use crate::codex_config;
use crate::config::{self, get_claude_mcp_path, get_claude_settings_path, ConfigStatus};
use crate::provider::Provider;
use crate::settings;
use crate::store::AppState;

const DEFAULT_PROVIDER_TEMPLATE_MODEL: &str = "gpt-5.5";
const DEFAULT_CLAUDE_TEMPLATE_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_GEMINI_TEMPLATE_MODEL: &str = "gemini-3.1-pro-preview";

#[tauri::command]
pub async fn get_claude_config_status() -> Result<ConfigStatus, String> {
    Ok(config::get_claude_config_status())
}

use std::path::PathBuf;
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

fn invalid_toml_format_error(error: toml_edit::TomlError) -> String {
    let lang = settings::get_settings()
        .language
        .unwrap_or_else(|| "zh".to_string());

    match lang.as_str() {
        "en" => format!("Invalid TOML format: {error}"),
        "ja" => format!("TOML形式が無効です: {error}"),
        _ => format!("无效的 TOML 格式: {error}"),
    }
}

fn validate_common_config_snippet(app_type: &str, snippet: &str) -> Result<(), String> {
    if snippet.trim().is_empty() {
        return Ok(());
    }

    match app_type {
        "claude" | "gemini" | "opencode" | "openclaw" | "hermes" | "omo" | "omo-slim" => {
            serde_json::from_str::<serde_json::Value>(snippet)
                .map_err(invalid_json_format_error)?;
        }
        "codex" => {
            snippet
                .parse::<toml_edit::DocumentMut>()
                .map_err(invalid_toml_format_error)?;
        }
        _ => {}
    }

    Ok(())
}

fn provider_template_must_be_object_error() -> String {
    let lang = settings::get_settings()
        .language
        .unwrap_or_else(|| "zh".to_string());

    match lang.as_str() {
        "en" => "Provider template must be a JSON object".to_string(),
        "ja" => "プロバイダーテンプレートは JSON オブジェクトである必要があります".to_string(),
        _ => "供应商模板必须是 JSON 对象".to_string(),
    }
}

fn default_provider_template_model_for_app(app_type: &AppType) -> &'static str {
    match app_type {
        AppType::Claude => DEFAULT_CLAUDE_TEMPLATE_MODEL,
        AppType::Gemini => DEFAULT_GEMINI_TEMPLATE_MODEL,
        _ => DEFAULT_PROVIDER_TEMPLATE_MODEL,
    }
}

fn replace_provider_template_tokens_for_app(value: &str, app_type: &AppType) -> String {
    value
        .replace("{baseUrl}", "https://example.com/v1")
        .replace("{apiKey}", "test-key")
        .replace("{model}", default_provider_template_model_for_app(app_type))
}

fn replace_codex_template_tokens(value: &str, app_type: &AppType) -> String {
    [
        ("baseUrl", "https://example.com/v1"),
        ("apiKey", "test-key"),
        ("model", default_provider_template_model_for_app(app_type)),
    ]
    .into_iter()
    .fold(value.to_string(), |acc, (key, replacement)| {
        let bare = format!("{{{key}}}");
        acc.replace(&format!("\"{bare}\""), &format!("\"{replacement}\""))
            .replace(&format!("'{bare}'"), &format!("'{replacement}'"))
            .replace(&bare, &format!("\"{replacement}\""))
    })
}

fn materialize_provider_template_value(
    value: serde_json::Value,
    app_type: &AppType,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => {
            serde_json::Value::String(replace_provider_template_tokens_for_app(&text, app_type))
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|item| materialize_provider_template_value(item, app_type))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if matches!(app_type, AppType::Codex) && key == "config" {
                            match value {
                                serde_json::Value::String(text) => serde_json::Value::String(
                                    replace_codex_template_tokens(&text, app_type),
                                ),
                                other => materialize_provider_template_value(other, app_type),
                            }
                        } else {
                            materialize_provider_template_value(value, app_type)
                        },
                    )
                })
                .collect(),
        ),
        other => other,
    }
}

fn validate_provider_default_template_payload(
    app_type: &AppType,
    template: Option<String>,
) -> Result<Option<String>, String> {
    let Some(raw_template) = template else {
        return Ok(None);
    };
    let trimmed = raw_template.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let parsed =
        serde_json::from_str::<serde_json::Value>(trimmed).map_err(invalid_json_format_error)?;
    if !parsed.is_object() {
        return Err(provider_template_must_be_object_error());
    }

    let settings_config = materialize_provider_template_value(parsed, app_type);
    let provider = Provider::with_id(
        "__template_validation__".to_string(),
        "__template_validation__".to_string(),
        settings_config,
        None,
    );
    crate::services::ProviderService::validate_provider_settings(app_type, &provider)
        .map_err(|error| error.to_string())?;

    Ok(Some(trimmed.to_string()))
}

#[tauri::command]
pub async fn get_config_status(
    state: State<'_, AppState>,
    app: String,
) -> Result<ConfigStatus, String> {
    match AppType::from_str(&app).map_err(|e| e.to_string())? {
        AppType::Claude => Ok(config::get_claude_config_status()),
        AppType::ClaudeDesktop => {
            let status = crate::claude_desktop_config::get_status(
                state.db.as_ref(),
                state.proxy_service.is_running().await,
            )
            .map_err(|e| e.to_string())?;
            Ok(ConfigStatus {
                exists: status.configured,
                path: status.config_library_path.unwrap_or_default(),
            })
        }
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
        AppType::Hermes => {
            let config_path = crate::hermes_config::get_hermes_config_path();
            let exists = config_path.exists();
            let path = crate::hermes_config::get_hermes_dir()
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
        AppType::ClaudeDesktop => {
            crate::claude_desktop_config::get_config_library_path().map_err(|e| e.to_string())?
        }
        AppType::Codex => codex_config::get_codex_config_dir(),
        AppType::Gemini => crate::gemini_config::get_gemini_dir(),
        AppType::OpenCode => crate::opencode_config::get_opencode_dir(),
        AppType::OpenClaw => crate::openclaw_config::get_openclaw_dir(),
        AppType::Hermes => crate::hermes_config::get_hermes_dir(),
    };

    Ok(dir.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigFileEntry {
    pub key: String,
    pub label: String,
    pub path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigFileContent {
    pub key: String,
    pub label: String,
    pub path: String,
    pub content: String,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigFileWrite {
    pub file_key: String,
    pub content: String,
}

fn app_config_files_for(app_type: &AppType) -> Vec<(String, String, PathBuf)> {
    match app_type {
        AppType::Claude => vec![
            (
                "settings".to_string(),
                "settings.json".to_string(),
                get_claude_settings_path(),
            ),
            (
                "mcp".to_string(),
                ".claude.json".to_string(),
                get_claude_mcp_path(),
            ),
        ],
        AppType::Codex => vec![
            (
                "auth".to_string(),
                "auth.json".to_string(),
                crate::codex_config::get_codex_auth_path(),
            ),
            (
                "config".to_string(),
                "config.toml".to_string(),
                crate::codex_config::get_codex_config_path(),
            ),
        ],
        AppType::Gemini => vec![
            (
                "env".to_string(),
                ".env".to_string(),
                crate::gemini_config::get_gemini_env_path(),
            ),
            (
                "settings".to_string(),
                "settings.json".to_string(),
                crate::gemini_config::get_gemini_settings_path(),
            ),
        ],
        AppType::OpenCode => vec![(
            "config".to_string(),
            "opencode.json".to_string(),
            crate::opencode_config::get_opencode_config_path(),
        )],
        AppType::OpenClaw => vec![(
            "config".to_string(),
            "openclaw.json".to_string(),
            crate::openclaw_config::get_openclaw_config_path(),
        )],
        AppType::Hermes => vec![(
            "config".to_string(),
            "config.yaml".to_string(),
            crate::hermes_config::get_hermes_config_path(),
        )],
    }
}

fn parse_json_object(content: &str, label: &str) -> Result<(), String> {
    let value = serde_json::from_str::<serde_json::Value>(content)
        .map_err(|e| format!("{label} JSON 格式错误: {e}"))?;
    if !value.is_object() {
        return Err(format!("{label} 根节点必须是 JSON 对象"));
    }
    Ok(())
}

fn parse_json5_object(content: &str, label: &str) -> Result<(), String> {
    let value = json5::from_str::<serde_json::Value>(content)
        .map_err(|e| format!("{label} JSON5 格式错误: {e}"))?;
    if !value.is_object() {
        return Err(format!("{label} 根节点必须是对象"));
    }
    Ok(())
}

fn parse_yaml_mapping(content: &str, label: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Ok(());
    }

    let value = serde_yaml::from_str::<serde_yaml::Value>(content)
        .map_err(|e| format!("{label} YAML 格式错误: {e}"))?;
    if !value.is_mapping() {
        return Err(format!("{label} 根节点必须是 YAML 对象"));
    }
    Ok(())
}

fn validate_app_config_file_content(
    app_type: &AppType,
    file_key: &str,
    label: &str,
    content: &str,
) -> Result<(), String> {
    let trimmed = content.trim();

    match (app_type, file_key) {
        (AppType::Claude, "settings") | (AppType::Claude, "mcp") => {
            if trimmed.is_empty() {
                return Err(format!(
                    "{label} 不能为空；如不需要该文件，请保持文件不存在"
                ));
            }
            parse_json_object(content, label)
        }
        (AppType::Codex, "auth") => {
            if trimmed.is_empty() {
                return Err("auth.json 不能为空；Codex 鉴权文件必须是 JSON 对象".to_string());
            }
            parse_json_object(content, label)
        }
        (AppType::Codex, "config") => crate::codex_config::validate_config_toml(content)
            .map_err(|e| format!("{label} TOML 格式错误: {e}")),
        (AppType::Gemini, "env") => crate::gemini_config::parse_env_file_strict(content)
            .map(|_| ())
            .map_err(|e| format!("{label} 格式错误: {e}")),
        (AppType::Gemini, "settings") => {
            if trimmed.is_empty() {
                return Err("settings.json 不能为空；如不需要该文件，请保持文件不存在".to_string());
            }
            parse_json_object(content, label)
        }
        (AppType::OpenCode, "config") => {
            if trimmed.is_empty() {
                return Err("opencode.json 不能为空；如不需要该文件，请保持文件不存在".to_string());
            }
            parse_json5_object(content, label)
        }
        (AppType::OpenClaw, "config") => {
            if trimmed.is_empty() {
                return Err("openclaw.json 不能为空；如不需要该文件，请保持文件不存在".to_string());
            }
            parse_json5_object(content, label)
        }
        (AppType::Hermes, "config") => parse_yaml_mapping(content, label),
        _ => Ok(()),
    }
}

fn render_template_preview(
    template: &str,
    proxy_url: &str,
    proxy_codex_base_url: &str,
    proxy_token: &str,
    mcp_block: &str,
) -> String {
    let template = if mcp_block.trim().is_empty() {
        template
            .lines()
            .filter(|line| !line.contains("{mcpConfig}"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        template.to_string()
    };

    template
        .replace("{proxyBaseUrl}", proxy_url)
        .replace("{proxyCodexBaseUrl}", proxy_codex_base_url)
        .replace("{proxyToken}", proxy_token)
        .replace("{mcpConfig}", mcp_block.trim())
        .trim()
        .to_string()
}

fn validate_app_config_template_files(
    app_type: &AppType,
    files: &[AppConfigTemplateFile],
) -> Result<(), String> {
    let proxy_url = "http://127.0.0.1:15721";
    let proxy_codex_base_url = "http://127.0.0.1:15721/v1";
    let proxy_token = "PROXY_MANAGED";

    for file in files {
        let rendered = match (app_type, file.key.as_str()) {
            (AppType::Claude, "settings") => render_template_preview(
                &file.content,
                proxy_url,
                proxy_codex_base_url,
                proxy_token,
                "",
            ),
            (AppType::Codex, "auth") => render_template_preview(
                &file.content,
                proxy_url,
                proxy_codex_base_url,
                proxy_token,
                "",
            ),
            (AppType::Codex, "config") => render_template_preview(
                &file.content,
                proxy_url,
                proxy_codex_base_url,
                proxy_token,
                "[mcp_servers.example]\ncommand = \"npx\"",
            ),
            (AppType::Gemini, "env") => render_template_preview(
                &file.content,
                proxy_url,
                proxy_codex_base_url,
                proxy_token,
                "",
            ),
            (AppType::Gemini, "settings") => render_template_preview(
                &file.content,
                proxy_url,
                proxy_codex_base_url,
                proxy_token,
                "{}",
            ),
            _ => file.content.clone(),
        };

        validate_app_config_file_content(app_type, &file.key, &file.label, &rendered)?;
    }

    Ok(())
}

fn resolve_app_config_file(
    app_type: &AppType,
    file_key: &str,
) -> Result<(String, String, PathBuf), String> {
    app_config_files_for(app_type)
        .into_iter()
        .find(|(key, _, _)| key == file_key.trim())
        .ok_or_else(|| format!("Unsupported config file key: {}", file_key.trim()))
}

fn should_skip_missing_empty_file(path: &PathBuf, content: &str) -> bool {
    !path.exists() && content.trim().is_empty()
}

fn validate_app_config_writes(
    app_type: &AppType,
    writes: &[(String, String, PathBuf, String)],
) -> Result<(), String> {
    for (key, label, path, content) in writes {
        if should_skip_missing_empty_file(path, content) {
            continue;
        }
        validate_app_config_file_content(app_type, key, label, content)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_app_config_files(app: String) -> Result<Vec<AppConfigFileEntry>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    Ok(app_config_files_for(&app_type)
        .into_iter()
        .map(|(key, label, path)| AppConfigFileEntry {
            key,
            label,
            path: path.to_string_lossy().to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn read_app_config_file(
    app: String,
    #[allow(non_snake_case)] fileKey: String,
) -> Result<AppConfigFileContent, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let target = app_config_files_for(&app_type)
        .into_iter()
        .find(|(key, _, _)| key == fileKey.trim())
        .ok_or_else(|| format!("Unsupported config file key: {}", fileKey.trim()))?;

    let (key, label, path) = target;
    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| format!("读取配置文件失败: {e}"))?
    } else {
        String::new()
    };

    Ok(AppConfigFileContent {
        key,
        label,
        path: path.to_string_lossy().to_string(),
        content,
    })
}

#[tauri::command]
pub async fn write_app_config_file(
    app: String,
    #[allow(non_snake_case)] fileKey: String,
    content: String,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let target = resolve_app_config_file(&app_type, &fileKey)?;

    let (key, label, path) = target;
    if should_skip_missing_empty_file(&path, &content) {
        return Ok(true);
    }
    validate_app_config_file_content(&app_type, &key, &label, &content)?;
    crate::config::write_text_file(&path, &content)
        .map_err(|e| format!("写入配置文件失败: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn write_app_config_files(
    app: String,
    files: Vec<AppConfigFileWrite>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let mut writes = Vec::with_capacity(files.len());

    for file in files {
        let (key, label, path) = resolve_app_config_file(&app_type, &file.file_key)?;
        writes.push((key, label, path, file.content));
    }

    validate_app_config_writes(&app_type, &writes)?;

    for (_, _, path, content) in writes {
        if should_skip_missing_empty_file(&path, &content) {
            continue;
        }
        crate::config::write_text_file(&path, &content)
            .map_err(|e| format!("写入配置文件失败: {e}"))?;
    }

    Ok(true)
}

#[tauri::command]
pub async fn import_mcp_from_app_live(
    app: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<usize, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;

    match app_type {
        AppType::Claude => crate::services::McpService::import_from_claude(state.inner()),
        AppType::Codex => crate::services::McpService::import_from_codex(state.inner()),
        AppType::Gemini => crate::services::McpService::import_from_gemini(state.inner()),
        AppType::OpenCode => crate::services::McpService::import_from_opencode(state.inner()),
        AppType::Hermes => crate::services::McpService::import_from_hermes(state.inner()),
        AppType::OpenClaw => {
            return Err("OpenClaw 当前不支持 MCP 回显导入".to_string());
        }
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_app_config_template(
    app: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Vec<AppConfigTemplateFile>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let stored = state
        .db
        .get_config_template(app_type.as_str())
        .map_err(|e| e.to_string())?;
    Ok(parse_stored_template_files(&app_type, stored))
}

#[tauri::command]
pub async fn set_app_config_template(
    app: String,
    files: Vec<AppConfigTemplateFile>,
    #[allow(non_snake_case)] syncToLive: Option<bool>,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let normalized_files = normalize_template_files(
        &app_type,
        files
            .into_iter()
            .map(|file| AppConfigTemplateFile {
                key: file.key.trim().to_string(),
                label: file.label.trim().to_string(),
                content: file.content,
            })
            .filter(|file| !file.key.is_empty())
            .collect(),
    );

    validate_app_config_template_files(&app_type, &normalized_files)?;

    let value = if normalized_files.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&normalized_files)
                .map_err(|e| format!("配置模板序列化失败: {e}"))?,
        )
    };

    state
        .db
        .set_config_template(app_type.as_str(), value)
        .map_err(|e| e.to_string())?;

    if syncToLive.unwrap_or(true) {
        let takeover_enabled = state
            .db
            .get_proxy_config_for_app(app_type.as_str())
            .await
            .map(|config| config.enabled)
            .unwrap_or(false);

        if takeover_enabled {
            state
                .proxy_service
                .sync_live_access_template_for_app(&app_type)
                .await?;
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn get_provider_default_template(
    app: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Option<String>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    state
        .db
        .get_provider_default_template(app_type.as_str())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_provider_default_template(
    app: String,
    template: Option<String>,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let validated_template = validate_provider_default_template_payload(&app_type, template)?;
    state
        .db
        .set_provider_default_template(app_type.as_str(), validated_template)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn open_config_folder(handle: AppHandle, app: String) -> Result<bool, String> {
    let config_dir = match AppType::from_str(&app).map_err(|e| e.to_string())? {
        AppType::Claude => config::get_claude_config_dir(),
        AppType::ClaudeDesktop => {
            crate::claude_desktop_config::get_config_library_path().map_err(|e| e.to_string())?
        }
        AppType::Codex => codex_config::get_codex_config_dir(),
        AppType::Gemini => crate::gemini_config::get_gemini_dir(),
        AppType::OpenCode => crate::opencode_config::get_opencode_dir(),
        AppType::OpenClaw => crate::openclaw_config::get_openclaw_dir(),
        AppType::Hermes => crate::hermes_config::get_hermes_dir(),
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
    let is_cleared = snippet.trim().is_empty();

    if !snippet.trim().is_empty() {
        serde_json::from_str::<serde_json::Value>(&snippet).map_err(invalid_json_format_error)?;
    }

    let value = if is_cleared { None } else { Some(snippet) };

    state
        .db
        .set_config_snippet("claude", value)
        .map_err(|e| e.to_string())?;
    state
        .db
        .set_config_snippet_cleared("claude", is_cleared)
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
    let is_cleared = snippet.trim().is_empty();
    let old_snippet = state
        .db
        .get_config_snippet(&app_type)
        .map_err(|e| e.to_string())?;

    validate_common_config_snippet(&app_type, &snippet)?;

    let value = if is_cleared { None } else { Some(snippet) };

    if matches!(app_type.as_str(), "claude" | "codex" | "gemini") {
        if let Some(legacy_snippet) = old_snippet
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let app = AppType::from_str(&app_type).map_err(|e| e.to_string())?;
            crate::services::provider::ProviderService::migrate_legacy_common_config_usage(
                state.inner(),
                app,
                legacy_snippet,
            )
            .map_err(|e| e.to_string())?;
        }
    }

    state
        .db
        .set_config_snippet(&app_type, value)
        .map_err(|e| e.to_string())?;
    state
        .db
        .set_config_snippet_cleared(&app_type, is_cleared)
        .map_err(|e| e.to_string())?;

    if matches!(app_type.as_str(), "claude" | "codex" | "gemini") {
        let app = AppType::from_str(&app_type).map_err(|e| e.to_string())?;
        crate::services::provider::ProviderService::sync_current_provider_for_app(
            state.inner(),
            app,
        )
        .map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::{validate_common_config_snippet, validate_provider_default_template_payload};
    use crate::app_config::AppType;

    #[test]
    fn validate_common_config_snippet_accepts_comment_only_codex_snippet() {
        validate_common_config_snippet("codex", "# comment only\n")
            .expect("comment-only codex snippet should be valid");
    }

    #[test]
    fn validate_common_config_snippet_rejects_invalid_codex_snippet() {
        let err = validate_common_config_snippet("codex", "[broken")
            .expect_err("invalid codex snippet should be rejected");
        assert!(
            err.contains("TOML") || err.contains("toml") || err.contains("格式"),
            "expected TOML validation error, got {err}"
        );
    }

    #[test]
    fn provider_default_template_treats_blank_input_as_clear() {
        let result =
            validate_provider_default_template_payload(&AppType::Claude, Some("   ".to_string()))
                .expect("blank template should be treated as clear");
        assert!(result.is_none());
    }

    #[test]
    fn provider_default_template_validates_codex_unquoted_placeholders() {
        validate_provider_default_template_payload(
            &AppType::Codex,
            Some(
                r#"{
  "auth": {
    "OPENAI_API_KEY": "{apiKey}"
  },
  "config": "model_provider = \"custom\"\nmodel = {model}\n\n[model_providers.custom]\nname = \"custom\"\nbase_url = {baseUrl}\nwire_api = \"responses\"\nrequires_openai_auth = true\n"
}"#
                .to_string(),
            ),
        )
        .expect("codex template with placeholders should validate");
    }

    #[test]
    fn provider_default_template_rejects_invalid_codex_shape() {
        let err = validate_provider_default_template_payload(
            &AppType::Codex,
            Some(
                r#"{
  "config": "model = \"gpt-5.5\""
}"#
                .to_string(),
            ),
        )
        .expect_err("missing auth should be rejected");
        assert!(
            err.contains("auth"),
            "expected auth validation error, got {err}"
        );
    }
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
