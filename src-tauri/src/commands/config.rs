#![allow(non_snake_case)]

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::app_config::AppType;
use crate::codex_config;
use crate::config::{self, get_claude_settings_path, ConfigStatus};
use crate::error::AppError;
use crate::settings;

#[tauri::command]
pub async fn get_claude_config_status() -> Result<ConfigStatus, String> {
    Ok(config::get_claude_config_status())
}

use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;

const PROXY_TOKEN_PLACEHOLDER: &str = "PROXY_MANAGED";
const CLAUDE_MODEL_OVERRIDE_ENV_KEYS: [&str; 6] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
];

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfigFileEntry {
    pub label: String,
    pub path: String,
    pub exists: bool,
    pub modified_at: Option<i64>,
    pub size_bytes: Option<u64>,
}

fn build_live_config_file_entry(label: &str, path: PathBuf) -> LiveConfigFileEntry {
    let metadata = std::fs::metadata(&path).ok();
    let modified_at = metadata
        .as_ref()
        .and_then(|meta| meta.modified().ok())
        .and_then(|ts| ts.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);
    let size_bytes = metadata.as_ref().map(|meta| meta.len());

    LiveConfigFileEntry {
        label: label.to_string(),
        exists: path.exists(),
        path: path.to_string_lossy().to_string(),
        modified_at,
        size_bytes,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigPreviewFile {
    pub label: String,
    pub path: String,
    pub exists: bool,
    pub expected_text: String,
    pub actual_text: String,
    pub differs: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigPreview {
    pub app: String,
    pub current_provider_id: Option<String>,
    pub current_provider_name: Option<String>,
    pub files: Vec<AppConfigPreviewFile>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHealthIssue {
    pub severity: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigHealthReport {
    pub app: String,
    pub ok: bool,
    pub issues: Vec<ConfigHealthIssue>,
}

fn normalize_text_for_compare(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

fn build_config_preview_file(
    label: &str,
    path: PathBuf,
    expected_text: String,
    actual_text: String,
) -> AppConfigPreviewFile {
    AppConfigPreviewFile {
        label: label.to_string(),
        path: path.to_string_lossy().to_string(),
        exists: path.exists(),
        differs: normalize_text_for_compare(&expected_text)
            != normalize_text_for_compare(&actual_text),
        expected_text,
        actual_text,
    }
}

fn stringify_json_pretty(value: &serde_json::Value) -> Result<String, AppError> {
    serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Message(format!("JSON 序列化失败: {e}")))
}

fn merge_claude_mcp_servers(
    rendered: &mut serde_json::Value,
    live_settings: Option<&serde_json::Value>,
) {
    let Some(mcp_servers) = live_settings
        .and_then(|value| value.get("mcpServers"))
        .cloned()
    else {
        return;
    };

    if let Some(obj) = rendered.as_object_mut() {
        obj.insert("mcpServers".to_string(), mcp_servers);
    }
}

fn merge_gemini_settings_with_live(
    rendered_config: Option<&serde_json::Value>,
    live_settings: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut merged = live_settings
        .and_then(|value| value.get("config"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    if let Some(config_obj) = rendered_config.and_then(|value| value.as_object()) {
        if let Some(merged_obj) = merged.as_object_mut() {
            for (key, value) in config_obj {
                merged_obj.insert(key.clone(), value.clone());
            }
        } else {
            merged = serde_json::Value::Object(config_obj.clone());
        }
    }

    merged
}

fn normalize_proxy_connect_host(address: &str) -> String {
    match address {
        "0.0.0.0" => "127.0.0.1".to_string(),
        "::" => "::1".to_string(),
        _ => address.to_string(),
    }
}

fn build_proxy_preview_urls(
    state: &crate::store::AppState,
) -> Result<(String, String, crate::proxy::types::ProxyTakeoverStatus), String> {
    let status = futures::executor::block_on(state.proxy_service.get_status())?;
    let takeover = futures::executor::block_on(state.proxy_service.get_takeover_status())?;

    if !status.running {
        return Err("代理服务未运行".to_string());
    }

    let connect_host = normalize_proxy_connect_host(&status.address);
    let connect_host_for_url = if connect_host.contains(':') && !connect_host.starts_with('[') {
        format!("[{connect_host}]")
    } else {
        connect_host
    };

    let proxy_origin = format!("http://{}:{}", connect_host_for_url, status.port);
    let proxy_codex_base_url = format!("{}/v1", proxy_origin.trim_end_matches('/'));

    Ok((proxy_origin, proxy_codex_base_url, takeover))
}

fn get_live_config_files_for_app(app_type: &AppType) -> Vec<LiveConfigFileEntry> {
    match app_type {
        AppType::Claude => vec![build_live_config_file_entry(
            "settings.json",
            get_claude_settings_path(),
        )],
        AppType::Codex => vec![
            build_live_config_file_entry("config.toml", codex_config::get_codex_config_path()),
            build_live_config_file_entry("auth.json", codex_config::get_codex_auth_path()),
        ],
        AppType::Gemini => vec![
            build_live_config_file_entry(".env", crate::gemini_config::get_gemini_env_path()),
            build_live_config_file_entry(
                "settings.json",
                crate::gemini_config::get_gemini_settings_path(),
            ),
        ],
        AppType::OpenCode => vec![build_live_config_file_entry(
            "opencode.json",
            crate::opencode_config::get_opencode_config_path(),
        )],
        AppType::OpenClaw => vec![build_live_config_file_entry(
            "config.json",
            crate::openclaw_config::get_openclaw_config_path(),
        )],
    }
}

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

fn provider_default_template_key(app_type: &str) -> String {
    format!("provider_default_template_{app_type}")
}

fn default_codex_provider_template() -> &'static str {
    r#"model_provider = "custom"
model = "{{model}}"
model_reasoning_effort = "{{reasoning_effort}}"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "{{base_url}}"
"#
}

fn sanitize_provider_default_template(app_type: &str, template: &str) -> Option<String> {
    if app_type != "codex" {
        return None;
    }

    let trimmed = template.trim();
    if trimmed.is_empty() {
        return None;
    }

    let looks_legacy = trimmed.starts_with('{')
        || trimmed.contains("\"auth\"")
        || trimmed.contains("OPENAI_API_KEY")
        || trimmed.contains("{{provider.config}}")
        || trimmed.contains("{{mcp.config}}")
        || (trimmed.contains("model_provider = \"custom\"")
            && !trimmed.contains("{{base_url}}")
            && !trimmed.contains("{{model}}"));

    if looks_legacy {
        return Some(default_codex_provider_template().to_string());
    }

    None
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
        "codex" => &["base_url", "model", "reasoning_effort"],
        "gemini" => &["api_key", "base_url", "model"],
        _ => return Ok(()),
    };

    let placeholder_re =
        regex::Regex::new(r"\{\{([^{}]+)\}\}").map_err(|e| format!("占位符校验初始化失败: {e}"))?;

    for caps in placeholder_re.captures_iter(template) {
        let placeholder = caps.get(1).map(|m| m.as_str().trim()).unwrap_or_default();
        if !allowed.contains(&placeholder) {
            return Err(format!(
                "默认供应商模板包含不支持的占位符: {{{{{placeholder}}}}}"
            ));
        }
    }

    Ok(())
}

fn validate_common_config_snippet(app_type: &str, snippet: &str) -> Result<(), String> {
    if snippet.trim().is_empty() {
        return Ok(());
    }

    match app_type {
        "claude" | "gemini" | "omo" | "omo-slim" => {
            serde_json::from_str::<serde_json::Value>(snippet)
                .map_err(invalid_json_format_error)?;
        }
        "codex" => {
            codex_config::validate_codex_common_config_template(snippet)
                .map_err(|e| e.to_string())?;
        }
        _ => {}
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
pub async fn get_live_config_files(app: String) -> Result<Vec<LiveConfigFileEntry>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let entries = get_live_config_files_for_app(&app_type);

    Ok(entries)
}

#[tauri::command]
pub async fn open_live_config_file(handle: AppHandle, path: String) -> Result<bool, String> {
    let path = PathBuf::from(path.trim());
    if !path.exists() {
        return Err(format!("配置文件不存在: {}", path.to_string_lossy()));
    }

    handle
        .opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("打开配置文件失败: {e}"))?;

    Ok(true)
}

#[tauri::command]
pub async fn save_live_config_file(
    app: String,
    label: String,
    content: String,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let label = label.trim();

    match app_type {
        AppType::Claude => {
            if label != "settings.json" {
                return Err(format!("不支持的 Claude live 文件: {label}"));
            }
            let parsed = serde_json::from_str::<serde_json::Value>(&content)
                .map_err(invalid_json_format_error)?;
            config::write_json_file(&get_claude_settings_path(), &parsed)
                .map_err(|e| e.to_string())?;
        }
        AppType::Codex => match label {
            "auth.json" => {
                let parsed = serde_json::from_str::<serde_json::Value>(&content)
                    .map_err(invalid_json_format_error)?;
                config::write_json_file(&codex_config::get_codex_auth_path(), &parsed)
                    .map_err(|e| e.to_string())?;
            }
            "config.toml" => {
                codex_config::validate_config_toml(&content).map_err(|e| e.to_string())?;
                config::write_text_file(&codex_config::get_codex_config_path(), &content)
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err(format!("不支持的 Codex live 文件: {label}")),
        },
        AppType::Gemini => match label {
            ".env" => {
                let parsed = crate::gemini_config::parse_env_file_strict(&content)
                    .map_err(|e| e.to_string())?;
                crate::gemini_config::write_gemini_env_atomic(&parsed)
                    .map_err(|e| e.to_string())?;
            }
            "settings.json" => {
                let parsed = serde_json::from_str::<serde_json::Value>(&content)
                    .map_err(invalid_json_format_error)?;
                config::write_json_file(&crate::gemini_config::get_gemini_settings_path(), &parsed)
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err(format!("不支持的 Gemini live 文件: {label}")),
        },
        AppType::OpenCode => {
            if label != "opencode.json" {
                return Err(format!("不支持的 OpenCode live 文件: {label}"));
            }
            let parsed = serde_json::from_str::<serde_json::Value>(&content)
                .map_err(invalid_json_format_error)?;
            config::write_json_file(&crate::opencode_config::get_opencode_config_path(), &parsed)
                .map_err(|e| e.to_string())?;
        }
        AppType::OpenClaw => {
            if label != "config.json" {
                return Err(format!("不支持的 OpenClaw live 文件: {label}"));
            }
            let parsed = serde_json::from_str::<serde_json::Value>(&content)
                .map_err(invalid_json_format_error)?;
            config::write_json_file(&crate::openclaw_config::get_openclaw_config_path(), &parsed)
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(true)
}

fn build_app_config_preview_internal(
    state: &crate::store::AppState,
    app_type: AppType,
) -> Result<AppConfigPreview, AppError> {
    let app = app_type.as_str().to_string();
    let current_provider_id =
        crate::settings::get_effective_current_provider(&state.db, &app_type)?;
    let current_provider = current_provider_id.as_deref().and_then(|id| {
        state
            .db
            .get_provider_by_id(id, app_type.as_str())
            .ok()
            .flatten()
    });
    let current_provider_name = current_provider
        .as_ref()
        .map(|provider| provider.name.clone());
    let live_settings = crate::services::provider::read_live_settings(app_type.clone()).ok();
    let proxy_preview = build_proxy_preview_urls(state).ok();
    let takeover_active = match (&app_type, proxy_preview.as_ref()) {
        (AppType::Claude, Some((_, _, takeover))) => takeover.claude,
        (AppType::Codex, Some((_, _, takeover))) => takeover.codex,
        (AppType::Gemini, Some((_, _, takeover))) => takeover.gemini,
        _ => false,
    };

    if matches!(app_type, AppType::OpenCode | AppType::OpenClaw) {
        let files = get_live_config_files_for_app(&app_type)
            .into_iter()
            .map(|entry| {
                let path = PathBuf::from(&entry.path);
                let actual_text = std::fs::read_to_string(&path).unwrap_or_default();
                build_config_preview_file(&entry.label, path, actual_text.clone(), actual_text)
            })
            .collect();

        return Ok(AppConfigPreview {
            app,
            current_provider_id,
            current_provider_name,
            files,
            note: Some("当前应用使用累加模式，预览显示的是当前 live 配置。".to_string()),
        });
    }

    let Some(provider) = current_provider else {
        return Ok(AppConfigPreview {
            app,
            current_provider_id,
            current_provider_name,
            files: Vec::new(),
            note: Some("当前应用没有可预览的当前供应商。".to_string()),
        });
    };

    let rendered_settings = crate::services::provider::build_effective_settings_with_common_config(
        state.db.as_ref(),
        &app_type,
        &provider,
    )?;

    let files = match app_type {
        AppType::Claude => {
            let mut expected =
                crate::services::provider::sanitize_claude_settings_for_live(&rendered_settings);
            merge_claude_mcp_servers(&mut expected, live_settings.as_ref());
            if takeover_active {
                if let Some((proxy_url, _, _)) = proxy_preview.as_ref() {
                    if let Some(env) = expected
                        .get_mut("env")
                        .and_then(|value| value.as_object_mut())
                    {
                        env.insert(
                            "ANTHROPIC_BASE_URL".to_string(),
                            serde_json::json!(proxy_url),
                        );
                        for key in CLAUDE_MODEL_OVERRIDE_ENV_KEYS {
                            env.remove(key);
                        }

                        let token_keys = [
                            "ANTHROPIC_AUTH_TOKEN",
                            "ANTHROPIC_API_KEY",
                            "OPENROUTER_API_KEY",
                            "OPENAI_API_KEY",
                        ];
                        let mut replaced_any = false;
                        for key in token_keys {
                            if env.contains_key(key) {
                                env.insert(
                                    key.to_string(),
                                    serde_json::json!(PROXY_TOKEN_PLACEHOLDER),
                                );
                                replaced_any = true;
                            }
                        }
                        if !replaced_any {
                            env.insert(
                                "ANTHROPIC_AUTH_TOKEN".to_string(),
                                serde_json::json!(PROXY_TOKEN_PLACEHOLDER),
                            );
                        }
                    } else {
                        expected["env"] = serde_json::json!({
                            "ANTHROPIC_BASE_URL": proxy_url,
                            "ANTHROPIC_AUTH_TOKEN": PROXY_TOKEN_PLACEHOLDER
                        });
                    }
                }
            }
            let actual = live_settings.unwrap_or_else(|| serde_json::json!({}));

            vec![build_config_preview_file(
                "settings.json",
                get_claude_settings_path(),
                stringify_json_pretty(&expected)?,
                stringify_json_pretty(&actual)?,
            )]
        }
        AppType::Codex => {
            let expected_auth = rendered_settings
                .get("auth")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let expected_config_base = rendered_settings
                .get("config")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let expected_auth = if takeover_active {
                let mut auth = expected_auth;
                if let Some(auth_obj) = auth.as_object_mut() {
                    auth_obj.insert(
                        "OPENAI_API_KEY".to_string(),
                        serde_json::json!(PROXY_TOKEN_PLACEHOLDER),
                    );
                }
                auth
            } else {
                expected_auth
            };

            let actual_auth = live_settings
                .as_ref()
                .and_then(|value| value.get("auth"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let actual_config = live_settings
                .as_ref()
                .and_then(|value| value.get("config"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();

            let expected_config_base = if takeover_active {
                if let Some((_, proxy_codex_base_url, _)) = proxy_preview.as_ref() {
                    codex_config::update_codex_toml_field(
                        &expected_config_base,
                        "base_url",
                        proxy_codex_base_url,
                    )
                    .unwrap_or(expected_config_base)
                } else {
                    expected_config_base
                }
            } else {
                expected_config_base
            };

            let expected_config = codex_config::merge_mcp_servers_from_existing(
                &expected_config_base,
                &actual_config,
            )
            .unwrap_or(expected_config_base);

            vec![
                build_config_preview_file(
                    "config.toml",
                    codex_config::get_codex_config_path(),
                    expected_config,
                    actual_config,
                ),
                build_config_preview_file(
                    "auth.json",
                    codex_config::get_codex_auth_path(),
                    stringify_json_pretty(&expected_auth)?,
                    stringify_json_pretty(&actual_auth)?,
                ),
            ]
        }
        AppType::Gemini => {
            let mut expected_env_map = crate::gemini_config::json_to_env(&rendered_settings)?;
            if takeover_active {
                if let Some((proxy_url, _, _)) = proxy_preview.as_ref() {
                    expected_env_map
                        .insert("GOOGLE_GEMINI_BASE_URL".to_string(), proxy_url.to_string());
                    expected_env_map.insert(
                        "GEMINI_API_KEY".to_string(),
                        PROXY_TOKEN_PLACEHOLDER.to_string(),
                    );
                }
            }
            let expected_env_text = crate::gemini_config::serialize_env_file(&expected_env_map);
            let actual_env_text = live_settings
                .as_ref()
                .and_then(|value| value.get("env"))
                .and_then(|value| value.as_object())
                .map(|env| {
                    let mut env_map = HashMap::new();
                    for (key, value) in env {
                        if let Some(text) = value.as_str() {
                            env_map.insert(key.clone(), text.to_string());
                        }
                    }
                    crate::gemini_config::serialize_env_file(&env_map)
                })
                .unwrap_or_default();

            let merged_config = merge_gemini_settings_with_live(
                rendered_settings.get("config"),
                live_settings.as_ref(),
            );
            let actual_settings_json = live_settings
                .as_ref()
                .and_then(|value| value.get("config"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));

            vec![
                build_config_preview_file(
                    ".env",
                    crate::gemini_config::get_gemini_env_path(),
                    expected_env_text,
                    actual_env_text,
                ),
                build_config_preview_file(
                    "settings.json",
                    crate::gemini_config::get_gemini_settings_path(),
                    stringify_json_pretty(&merged_config)?,
                    stringify_json_pretty(&actual_settings_json)?,
                ),
            ]
        }
        AppType::OpenCode | AppType::OpenClaw => unreachable!(),
    };

    Ok(AppConfigPreview {
        app,
        current_provider_id,
        current_provider_name,
        files,
        note: if takeover_active {
            Some(
                "当前应用已启用代理接管，预期结果会显示为本地代理地址，而不是供应商原始请求地址。"
                    .to_string(),
            )
        } else {
            None
        },
    })
}

fn validate_template_for_app(
    state: &crate::store::AppState,
    app_type: &AppType,
) -> Result<(), String> {
    let Some(snippet) = state
        .db
        .get_config_snippet(app_type.as_str())
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };

    if snippet.trim().is_empty() {
        return Ok(());
    }

    match app_type {
        AppType::Claude | AppType::Gemini => {
            serde_json::from_str::<serde_json::Value>(&snippet)
                .map_err(invalid_json_format_error)?;
        }
        AppType::Codex => {
            codex_config::validate_codex_common_config_template(&snippet)
                .map_err(|e| e.to_string())?;
        }
        AppType::OpenCode | AppType::OpenClaw => {}
    }

    Ok(())
}

fn build_config_health_report_for_app(
    state: &crate::store::AppState,
    app_type: &AppType,
) -> AppConfigHealthReport {
    let mut issues = Vec::<ConfigHealthIssue>::new();

    if let Err(err) = validate_template_for_app(state, app_type) {
        issues.push(ConfigHealthIssue {
            severity: "error".to_string(),
            code: "template_invalid".to_string(),
            message: format!("配置模板无效: {err}"),
        });
    }

    for file in get_live_config_files_for_app(app_type) {
        if !file.exists {
            issues.push(ConfigHealthIssue {
                severity: "warning".to_string(),
                code: "live_file_missing".to_string(),
                message: format!("{} 不存在: {}", file.label, file.path),
            });
            continue;
        }

        let path = PathBuf::from(&file.path);
        let parse_result = match app_type {
            AppType::Claude => config::read_json_file::<serde_json::Value>(&path).map(|_| ()),
            AppType::Codex => {
                if file.label == "auth.json" {
                    config::read_json_file::<serde_json::Value>(&path).map(|_| ())
                } else {
                    std::fs::read_to_string(&path)
                        .map_err(|e| AppError::io(&path, e))
                        .and_then(|text| codex_config::validate_config_toml(&text))
                }
            }
            AppType::Gemini => {
                if file.label == ".env" {
                    crate::gemini_config::read_gemini_env().map(|_| ())
                } else {
                    config::read_json_file::<serde_json::Value>(&path).map(|_| ())
                }
            }
            AppType::OpenCode => crate::opencode_config::read_opencode_config().map(|_| ()),
            AppType::OpenClaw => crate::openclaw_config::read_openclaw_config().map(|_| ()),
        };

        if let Err(err) = parse_result {
            issues.push(ConfigHealthIssue {
                severity: "error".to_string(),
                code: "live_file_invalid".to_string(),
                message: format!("{} 解析失败: {err}", file.label),
            });
        }
    }

    if matches!(app_type, AppType::Claude | AppType::Codex | AppType::Gemini) {
        match build_app_config_preview_internal(state, app_type.clone()) {
            Ok(preview) => {
                if preview.current_provider_id.is_none() {
                    issues.push(ConfigHealthIssue {
                        severity: "warning".to_string(),
                        code: "current_provider_missing".to_string(),
                        message: "当前应用没有设置有效的当前供应商".to_string(),
                    });
                }

                for file in preview.files.iter().filter(|file| file.differs) {
                    issues.push(ConfigHealthIssue {
                        severity: "warning".to_string(),
                        code: "live_mismatch".to_string(),
                        message: format!("{} 与预期渲染结果不一致", file.label),
                    });
                }
            }
            Err(err) => issues.push(ConfigHealthIssue {
                severity: "error".to_string(),
                code: "preview_failed".to_string(),
                message: format!("配置预览失败: {err}"),
            }),
        }
    }

    AppConfigHealthReport {
        app: app_type.as_str().to_string(),
        ok: !issues.iter().any(|issue| issue.severity == "error"),
        issues,
    }
}

#[tauri::command]
pub async fn get_app_config_preview(
    app: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<AppConfigPreview, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    build_app_config_preview_internal(state.inner(), app_type).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_config_health_report(
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Vec<AppConfigHealthReport>, String> {
    Ok(AppType::all()
        .into_iter()
        .map(|app_type| build_config_health_report_for_app(state.inner(), &app_type))
        .collect())
}

#[tauri::command]
pub async fn repair_config_health(
    app: Option<String>,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Vec<AppConfigHealthReport>, String> {
    let apps = if let Some(app) = app {
        vec![AppType::from_str(&app).map_err(|e| e.to_string())?]
    } else {
        AppType::all().collect::<Vec<_>>()
    };

    for app_type in apps.iter() {
        if matches!(app_type, AppType::Claude | AppType::Codex | AppType::Gemini) {
            let _ = crate::services::provider::ProviderService::migrate_legacy_common_config_usage_if_needed(
                state.inner(),
                app_type.clone(),
            );
        }

        let _ = crate::services::provider::sync_current_provider_for_app_to_live(
            state.inner(),
            &app_type,
        );
    }

    Ok(AppType::all()
        .into_iter()
        .map(|app_type| build_config_health_report_for_app(state.inner(), &app_type))
        .collect())
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

#[tauri::command]
pub async fn get_provider_default_template(
    app_type: String,
    state: tauri::State<'_, crate::store::AppState>,
) -> Result<Option<String>, String> {
    if !matches!(app_type.as_str(), "claude" | "codex" | "gemini") {
        return Err(format!("不支持的应用类型: {app_type}"));
    }

    let value = state
        .db
        .get_setting(&provider_default_template_key(&app_type))
        .map_err(|e| e.to_string())?;

    if let Some(template) = value.as_deref() {
        if let Some(sanitized) = sanitize_provider_default_template(&app_type, template) {
            state
                .db
                .set_setting(&provider_default_template_key(&app_type), &sanitized)
                .map_err(|e| e.to_string())?;
            return Ok(Some(sanitized));
        }
    }

    Ok(value)
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
        if app_type == "codex" {
            template
                .parse::<toml_edit::DocumentMut>()
                .map_err(invalid_toml_format_error)?;
        } else {
            serde_json::from_str::<serde_json::Value>(&template)
                .map_err(invalid_json_format_error)?;
        }
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

#[cfg(test)]
mod tests {
    use super::{validate_common_config_snippet, validate_provider_default_template_placeholders};

    #[test]
    fn validate_common_config_snippet_accepts_codex_template_with_provider_placeholder() {
        validate_common_config_snippet(
            "codex",
            r#"approval_policy = "never"

{{provider.config}}

{{mcp.config}}"#,
        )
        .expect("codex template with provider placeholder should be valid");
    }

    #[test]
    fn validate_common_config_snippet_rejects_codex_template_without_provider_placeholder() {
        let err = validate_common_config_snippet("codex", "approval_policy = \"never\"")
            .expect_err("codex template without provider placeholder should be rejected");
        assert!(
            err.contains("{{provider.config}}"),
            "expected provider placeholder validation error, got {err}"
        );
    }

    #[test]
    fn validate_provider_default_template_placeholders_rejects_unknown_placeholder() {
        let err =
            validate_provider_default_template_placeholders("codex", r#"model = "{{unknown}}""#)
                .expect_err("unknown placeholder should be rejected");
        assert!(err.contains("unknown"));
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
