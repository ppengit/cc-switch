//! Live configuration operations
//!
//! Handles reading and writing live configuration files for Claude, Codex, and Gemini.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::app_config::AppType;
use crate::codex_config::{get_codex_auth_path, get_codex_config_path};
use crate::config::{delete_file, get_claude_settings_path, read_json_file, write_json_file};
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::services::mcp::McpService;
use crate::store::AppState;

use super::gemini_auth::{
    detect_gemini_auth_type, ensure_google_oauth_security_flag, GeminiAuthType,
};
use super::normalize_claude_models_in_value;

pub(crate) fn sanitize_claude_settings_for_live(settings: &Value) -> Value {
    let mut v = settings.clone();
    if let Some(obj) = v.as_object_mut() {
        // Internal-only fields - never write to Claude Code settings.json
        obj.remove("api_format");
        obj.remove("apiFormat");
        obj.remove("openrouter_compat_mode");
        obj.remove("openrouterCompatMode");
    }
    v
}

const CODEX_PROVIDER_CONFIG_PLACEHOLDER: &str = "{{provider.config}}";
const CODEX_MCP_CONFIG_PLACEHOLDER: &str = "{{mcp.config}}";

fn parse_common_config_snippet_json(db: &Database, app_type: &str) -> Result<Value, AppError> {
    let Some(snippet) = db.get_config_snippet(app_type)? else {
        return Ok(json!({}));
    };

    if snippet.trim().is_empty() {
        return Ok(json!({}));
    }

    serde_json::from_str::<Value>(&snippet)
        .map_err(|e| AppError::Message(format!("解析 {app_type} 通用配置片段失败: {e}")))
}

fn merge_json_values(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(base_obj), Value::Object(overlay_obj)) => {
            for (key, value) in overlay_obj {
                match base_obj.get_mut(key) {
                    Some(existing) => merge_json_values(existing, value),
                    None => {
                        base_obj.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (base_slot, overlay_value) => {
            *base_slot = overlay_value.clone();
        }
    }
}

fn remove_json_subset(target: &mut Value, subset: &Value) -> bool {
    match (target, subset) {
        (Value::Object(target_obj), Value::Object(subset_obj)) => {
            let keys: Vec<String> = subset_obj.keys().cloned().collect();
            for key in keys {
                let Some(subset_value) = subset_obj.get(&key) else {
                    continue;
                };
                let should_remove = target_obj
                    .get_mut(&key)
                    .map(|target_value| remove_json_subset(target_value, subset_value))
                    .unwrap_or(false);

                if should_remove {
                    target_obj.remove(&key);
                }
            }

            target_obj.is_empty()
        }
        (target_value, subset_value) => target_value == subset_value,
    }
}

fn parse_gemini_common_config_snippet(
    db: &Database,
) -> Result<
    (
        serde_json::Map<String, Value>,
        serde_json::Map<String, Value>,
    ),
    AppError,
> {
    let common = parse_common_config_snippet_json(db, "gemini")?;
    let Some(common_obj) = common.as_object() else {
        return Err(AppError::Message(
            "Gemini 通用配置片段必须是 JSON 对象".to_string(),
        ));
    };

    let has_structured = common_obj.contains_key("env") || common_obj.contains_key("config");

    let env_obj = if has_structured {
        common_obj
            .get("env")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    } else {
        common_obj.clone()
    };

    let config_obj = if has_structured {
        common_obj
            .get("config")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };

    Ok((env_obj, config_obj))
}

fn extract_codex_mcp_fragment(config_text: &str) -> Option<String> {
    use toml_edit::{DocumentMut, Item};

    if config_text.trim().is_empty() {
        return None;
    }

    let existing_doc = config_text.parse::<DocumentMut>().ok()?;
    let mut out = DocumentMut::new();

    if let Some(item) = existing_doc.get("mcp_servers") {
        out["mcp_servers"] = item.clone();
        let text = out.to_string();
        return Some(text.trim().to_string());
    }

    if let Some(mcp_item) = existing_doc.get("mcp") {
        if let Some(mcp_tbl) = mcp_item.as_table_like() {
            if let Some(servers_item) = mcp_tbl.get("servers") {
                if let Item::Table(_) = servers_item {
                    out["mcp_servers"] = servers_item.clone();
                    let text = out.to_string();
                    return Some(text.trim().to_string());
                }
            }
        }
    }

    None
}

fn render_codex_config_template(
    template: Option<&str>,
    provider_fragment: &str,
    mcp_fragment: &str,
) -> String {
    let rendered = match template.map(str::trim).filter(|s| !s.is_empty()) {
        Some(template_str) => {
            let mut output = template_str
                .replace(CODEX_PROVIDER_CONFIG_PLACEHOLDER, provider_fragment)
                .replace(CODEX_MCP_CONFIG_PLACEHOLDER, mcp_fragment);

            if !template_str.contains(CODEX_PROVIDER_CONFIG_PLACEHOLDER) {
                if !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push('\n');
                output.push_str(provider_fragment);
            }

            if !template_str.contains(CODEX_MCP_CONFIG_PLACEHOLDER)
                && !mcp_fragment.trim().is_empty()
            {
                if !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push('\n');
                output.push_str(mcp_fragment);
            }

            output
        }
        None => {
            let mut output = provider_fragment.trim().to_string();
            if !mcp_fragment.trim().is_empty() {
                if !output.is_empty() {
                    output.push_str("\n\n");
                }
                output.push_str(mcp_fragment.trim());
            }
            output
        }
    };

    let mut final_text = String::new();
    let mut blank_run = 0usize;
    for line in rendered.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                final_text.push('\n');
            }
            continue;
        }
        blank_run = 0;
        final_text.push_str(line);
        final_text.push('\n');
    }

    let trimmed = final_text.trim().to_string();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    }
}

fn extract_codex_provider_fragment_from_rendered(
    template: Option<&str>,
    rendered_config: &str,
) -> String {
    let current_mcp = extract_codex_mcp_fragment(rendered_config).unwrap_or_default();

    if let Some(template_str) = template.map(str::trim).filter(|s| !s.is_empty()) {
        let template_with_mcp = template_str.replace(CODEX_MCP_CONFIG_PLACEHOLDER, &current_mcp);
        if let Some((prefix, suffix)) =
            template_with_mcp.split_once(CODEX_PROVIDER_CONFIG_PLACEHOLDER)
        {
            if rendered_config.starts_with(prefix) && rendered_config.ends_with(suffix) {
                let middle = &rendered_config
                    [prefix.len()..rendered_config.len().saturating_sub(suffix.len())];
                let trimmed = middle
                    .trim_matches('\n')
                    .trim_matches('\r')
                    .trim()
                    .to_string();
                if !trimmed.is_empty() {
                    return format!("{trimmed}\n");
                }
                return String::new();
            }
        }
    }

    let without_mcp = if let Some(current_mcp) =
        extract_codex_mcp_fragment(rendered_config).filter(|s| !s.is_empty())
    {
        rendered_config.replace(&current_mcp, "")
    } else {
        rendered_config.to_string()
    };

    let trimmed = without_mcp.trim().to_string();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    }
}

pub(crate) fn build_claude_live_snapshot_from_provider(
    db: &Database,
    provider: &Provider,
) -> Result<Value, AppError> {
    let mut rendered = parse_common_config_snippet_json(db, "claude")?;
    if !rendered.is_object() {
        rendered = json!({});
    }

    let provider_settings = sanitize_claude_settings_for_live(&provider.settings_config);
    merge_json_values(&mut rendered, &provider_settings);

    let path = get_claude_settings_path();
    if path.exists() {
        if let Ok(existing) = read_json_file::<Value>(&path) {
            if let Some(mcp) = existing.get("mcpServers").cloned() {
                if let Some(obj) = rendered.as_object_mut() {
                    obj.insert("mcpServers".to_string(), mcp);
                }
            }
        }
    }

    Ok(rendered)
}

pub(crate) fn build_codex_live_snapshot_from_provider(
    db: &Database,
    provider: &Provider,
) -> Result<Value, AppError> {
    let settings = provider
        .settings_config
        .as_object()
        .ok_or_else(|| AppError::Config("Codex 供应商配置必须是 JSON 对象".to_string()))?;

    let auth = settings
        .get("auth")
        .cloned()
        .ok_or_else(|| AppError::Config("Codex 供应商配置缺少 'auth' 字段".to_string()))?;
    let provider_config = settings
        .get("config")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let common_template = db.get_config_snippet("codex")?;
    let current_live_config = crate::codex_config::read_codex_config_text().unwrap_or_default();
    let current_mcp = extract_codex_mcp_fragment(&current_live_config).unwrap_or_default();
    let rendered_config =
        render_codex_config_template(common_template.as_deref(), provider_config, &current_mcp);

    Ok(json!({
        "auth": auth,
        "config": rendered_config,
    }))
}

pub(crate) fn build_gemini_live_snapshot_from_provider(
    db: &Database,
    provider: &Provider,
) -> Result<Value, AppError> {
    use crate::gemini_config::{get_gemini_settings_path, json_to_env};

    let (common_env, common_config) = parse_gemini_common_config_snippet(db)?;

    let mut env_map: HashMap<String, String> = common_env
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|v| (key, v.to_string())))
        .collect();
    env_map.extend(json_to_env(&provider.settings_config)?);

    let settings_path = get_gemini_settings_path();
    let mut rendered_config = json!({});
    if !rendered_config.is_object() {
        rendered_config = json!({});
    }

    if settings_path.exists() {
        if let Ok(existing) = read_json_file::<Value>(&settings_path) {
            if let Some(existing_obj) = existing.as_object() {
                if let Some(rendered_obj) = rendered_config.as_object_mut() {
                    if let Some(security) = existing_obj.get("security").cloned() {
                        rendered_obj.insert("security".to_string(), security);
                    }
                    if let Some(mcp_servers) = existing_obj.get("mcpServers").cloned() {
                        rendered_obj.insert("mcpServers".to_string(), mcp_servers);
                    }
                }
            }
        }
    }

    merge_json_values(&mut rendered_config, &Value::Object(common_config));
    if let Some(provider_config) = provider.settings_config.get("config") {
        if provider_config.is_object() {
            merge_json_values(&mut rendered_config, provider_config);
        }
    }

    if rendered_config
        .as_object()
        .is_some_and(|obj| obj.is_empty())
    {
        rendered_config = Value::Null;
    }

    Ok(json!({
        "env": env_map,
        "config": rendered_config,
    }))
}

pub(crate) fn extract_provider_settings_from_live(
    db: &Database,
    app_type: &AppType,
    live_config: &Value,
) -> Result<Value, AppError> {
    match app_type {
        AppType::Claude => {
            let mut provider_settings = live_config.clone();
            if let Some(obj) = provider_settings.as_object_mut() {
                obj.remove("mcpServers");
            }
            let common = parse_common_config_snippet_json(db, "claude")?;
            remove_json_subset(&mut provider_settings, &common);
            if provider_settings.is_null() {
                Ok(json!({}))
            } else {
                Ok(provider_settings)
            }
        }
        AppType::Codex => {
            let auth = live_config
                .get("auth")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let rendered_config = live_config
                .get("config")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let common_template = db.get_config_snippet("codex")?;
            let provider_config = extract_codex_provider_fragment_from_rendered(
                common_template.as_deref(),
                rendered_config,
            );

            Ok(json!({
                "auth": auth,
                "config": provider_config,
            }))
        }
        AppType::Gemini => {
            let (common_env, common_config) = parse_gemini_common_config_snippet(db)?;

            let mut env_obj = live_config.get("env").cloned().unwrap_or_else(|| json!({}));
            remove_json_subset(&mut env_obj, &Value::Object(common_env));

            let mut config_obj = live_config
                .get("config")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Some(obj) = config_obj.as_object_mut() {
                obj.remove("mcpServers");
            }
            remove_json_subset(&mut config_obj, &Value::Object(common_config));

            if config_obj.as_object().is_some_and(|obj| obj.is_empty()) {
                config_obj = Value::Null;
            }

            Ok(json!({
                "env": env_obj,
                "config": config_obj,
            }))
        }
        _ => Ok(live_config.clone()),
    }
}

/// Live configuration snapshot for backup/restore
#[derive(Clone)]
#[allow(dead_code)]
pub(crate) enum LiveSnapshot {
    Claude {
        settings: Option<Value>,
    },
    Codex {
        auth: Option<Value>,
        config: Option<String>,
    },
    Gemini {
        env: Option<HashMap<String, String>>,
        config: Option<Value>,
    },
}

impl LiveSnapshot {
    #[allow(dead_code)]
    pub(crate) fn restore(&self) -> Result<(), AppError> {
        match self {
            LiveSnapshot::Claude { settings } => {
                let path = get_claude_settings_path();
                if let Some(value) = settings {
                    write_json_file(&path, value)?;
                } else if path.exists() {
                    delete_file(&path)?;
                }
            }
            LiveSnapshot::Codex { auth, config } => {
                let auth_path = get_codex_auth_path();
                let config_path = get_codex_config_path();
                if let Some(value) = auth {
                    write_json_file(&auth_path, value)?;
                } else if auth_path.exists() {
                    delete_file(&auth_path)?;
                }

                if let Some(text) = config {
                    crate::config::write_text_file(&config_path, text)?;
                } else if config_path.exists() {
                    delete_file(&config_path)?;
                }
            }
            LiveSnapshot::Gemini { env, .. } => {
                use crate::gemini_config::{
                    get_gemini_env_path, get_gemini_settings_path, write_gemini_env_atomic,
                };
                let path = get_gemini_env_path();
                if let Some(env_map) = env {
                    write_gemini_env_atomic(env_map)?;
                } else if path.exists() {
                    delete_file(&path)?;
                }

                let settings_path = get_gemini_settings_path();
                match self {
                    LiveSnapshot::Gemini {
                        config: Some(cfg), ..
                    } => {
                        write_json_file(&settings_path, cfg)?;
                    }
                    LiveSnapshot::Gemini { config: None, .. } if settings_path.exists() => {
                        delete_file(&settings_path)?;
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
}

/// Write live configuration snapshot for a provider
pub(crate) fn write_live_snapshot(
    db: &Database,
    app_type: &AppType,
    provider: &Provider,
) -> Result<(), AppError> {
    match app_type {
        AppType::Claude => {
            let path = get_claude_settings_path();
            let settings = build_claude_live_snapshot_from_provider(db, provider)?;
            write_json_file(&path, &settings)?;
        }
        AppType::Codex => {
            let rendered = build_codex_live_snapshot_from_provider(db, provider)?;
            let auth = rendered
                .get("auth")
                .ok_or_else(|| AppError::Config("Codex 供应商配置缺少 'auth' 字段".to_string()))?;
            let config_str = rendered
                .get("config")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    AppError::Config("Codex 供应商配置缺少 'config' 字段或不是字符串".to_string())
                })?;

            crate::codex_config::write_codex_live_atomic(auth, Some(config_str))?;
        }
        AppType::Gemini => {
            // Delegate to write_gemini_live which handles env file writing correctly
            let rendered = Provider {
                settings_config: build_gemini_live_snapshot_from_provider(db, provider)?,
                ..provider.clone()
            };
            write_gemini_live(&rendered)?;
        }
        AppType::OpenCode => {
            // OpenCode uses additive mode - write provider to config
            use crate::opencode_config;
            use crate::provider::OpenCodeProviderConfig;

            // Defensive check: if settings_config is a full config structure, extract provider fragment
            let config_to_write = if let Some(obj) = provider.settings_config.as_object() {
                // Detect full config structure (has $schema or top-level provider field)
                if obj.contains_key("$schema") || obj.contains_key("provider") {
                    log::warn!(
                        "OpenCode provider '{}' has full config structure in settings_config, attempting to extract fragment",
                        provider.id
                    );
                    // Try to extract from provider.{id}
                    obj.get("provider")
                        .and_then(|p| p.get(&provider.id))
                        .cloned()
                        .unwrap_or_else(|| provider.settings_config.clone())
                } else {
                    provider.settings_config.clone()
                }
            } else {
                provider.settings_config.clone()
            };

            // Convert settings_config to OpenCodeProviderConfig
            let opencode_config_result =
                serde_json::from_value::<OpenCodeProviderConfig>(config_to_write.clone());

            match opencode_config_result {
                Ok(config) => {
                    opencode_config::set_typed_provider(&provider.id, &config)?;
                    log::info!("OpenCode provider '{}' written to live config", provider.id);
                }
                Err(e) => {
                    log::warn!(
                        "Failed to parse OpenCode provider config for '{}': {}",
                        provider.id,
                        e
                    );
                    // Only write if config looks like a valid provider fragment
                    if config_to_write.get("npm").is_some()
                        || config_to_write.get("options").is_some()
                    {
                        opencode_config::set_provider(&provider.id, config_to_write)?;
                        log::info!(
                            "OpenCode provider '{}' written as raw JSON to live config",
                            provider.id
                        );
                    } else {
                        log::error!(
                            "OpenCode provider '{}' has invalid config structure, skipping write",
                            provider.id
                        );
                    }
                }
            }
        }
        AppType::OpenClaw => {
            // OpenClaw uses additive mode - write provider to config
            use crate::openclaw_config;
            use crate::openclaw_config::OpenClawProviderConfig;

            // Convert settings_config to OpenClawProviderConfig
            let openclaw_config_result =
                serde_json::from_value::<OpenClawProviderConfig>(provider.settings_config.clone());

            match openclaw_config_result {
                Ok(config) => {
                    openclaw_config::set_typed_provider(&provider.id, &config)?;
                    log::info!("OpenClaw provider '{}' written to live config", provider.id);
                }
                Err(e) => {
                    log::warn!(
                        "Failed to parse OpenClaw provider config for '{}': {}",
                        provider.id,
                        e
                    );
                    // Try to write as raw JSON if it looks valid
                    if provider.settings_config.get("baseUrl").is_some()
                        || provider.settings_config.get("api").is_some()
                        || provider.settings_config.get("models").is_some()
                    {
                        openclaw_config::set_provider(
                            &provider.id,
                            provider.settings_config.clone(),
                        )?;
                        log::info!(
                            "OpenClaw provider '{}' written as raw JSON to live config",
                            provider.id
                        );
                    } else {
                        log::error!(
                            "OpenClaw provider '{}' has invalid config structure, skipping write",
                            provider.id
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

/// Sync all providers to live configuration (for additive mode apps)
///
/// Writes all providers from the database to the live configuration file.
/// Used for OpenCode and other additive mode applications.
fn sync_all_providers_to_live(state: &AppState, app_type: &AppType) -> Result<(), AppError> {
    let providers = state.db.get_all_providers(app_type.as_str())?;

    for provider in providers.values() {
        if let Err(e) = write_live_snapshot(&state.db, app_type, provider) {
            log::warn!(
                "Failed to sync {:?} provider '{}' to live: {e}",
                app_type,
                provider.id
            );
            // Continue syncing other providers, don't abort
        }
    }

    log::info!(
        "Synced {} {:?} providers to live config",
        providers.len(),
        app_type
    );
    Ok(())
}

/// Sync current provider to live configuration
///
/// 使用有效的当前供应商 ID（验证过存在性）。
/// 优先从本地 settings 读取，验证后 fallback 到数据库的 is_current 字段。
/// 这确保了配置导入后无效 ID 会自动 fallback 到数据库。
///
/// For additive mode apps (OpenCode), all providers are synced instead of just the current one.
pub fn sync_current_to_live(state: &AppState) -> Result<(), AppError> {
    // Sync providers based on mode
    for app_type in AppType::all() {
        if app_type.is_additive_mode() {
            // Additive mode: sync ALL providers
            sync_all_providers_to_live(state, &app_type)?;
        } else {
            // Switch mode: sync only current provider
            let current_id =
                match crate::settings::get_effective_current_provider(&state.db, &app_type)? {
                    Some(id) => id,
                    None => continue,
                };

            let providers = state.db.get_all_providers(app_type.as_str())?;
            if let Some(provider) = providers.get(&current_id) {
                write_live_snapshot(&state.db, &app_type, provider)?;
            }
            // Note: get_effective_current_provider already validates existence,
            // so providers.get() should always succeed here
        }
    }

    // MCP sync
    McpService::sync_all_enabled(state)?;

    // Skill sync
    for app_type in AppType::all() {
        if let Err(e) = crate::services::skill::SkillService::sync_to_app(&state.db, &app_type) {
            log::warn!("同步 Skill 到 {app_type:?} 失败: {e}");
            // Continue syncing other apps, don't abort
        }
    }

    Ok(())
}

/// Read current live settings for an app type
pub fn read_live_settings(app_type: AppType) -> Result<Value, AppError> {
    match app_type {
        AppType::Codex => {
            let auth_path = get_codex_auth_path();
            if !auth_path.exists() {
                return Err(AppError::localized(
                    "codex.auth.missing",
                    "Codex 配置文件不存在：缺少 auth.json",
                    "Codex configuration missing: auth.json not found",
                ));
            }
            let auth: Value = read_json_file(&auth_path)?;
            let cfg_text = crate::codex_config::read_and_validate_codex_config_text()?;
            Ok(json!({ "auth": auth, "config": cfg_text }))
        }
        AppType::Claude => {
            let path = get_claude_settings_path();
            if !path.exists() {
                return Err(AppError::localized(
                    "claude.live.missing",
                    "Claude Code 配置文件不存在",
                    "Claude settings file is missing",
                ));
            }
            read_json_file(&path)
        }
        AppType::Gemini => {
            use crate::gemini_config::{
                env_to_json, get_gemini_env_path, get_gemini_settings_path, read_gemini_env,
            };

            // Read .env file (environment variables)
            let env_path = get_gemini_env_path();
            if !env_path.exists() {
                return Err(AppError::localized(
                    "gemini.env.missing",
                    "Gemini .env 文件不存在",
                    "Gemini .env file not found",
                ));
            }

            let env_map = read_gemini_env()?;
            let env_json = env_to_json(&env_map);
            let env_obj = env_json.get("env").cloned().unwrap_or_else(|| json!({}));

            // Read settings.json file (MCP config etc.)
            let settings_path = get_gemini_settings_path();
            let config_obj = if settings_path.exists() {
                read_json_file(&settings_path)?
            } else {
                json!({})
            };

            // Return complete structure: { "env": {...}, "config": {...} }
            Ok(json!({
                "env": env_obj,
                "config": config_obj
            }))
        }
        AppType::OpenCode => {
            use crate::opencode_config::{get_opencode_config_path, read_opencode_config};

            let config_path = get_opencode_config_path();
            if !config_path.exists() {
                return Err(AppError::localized(
                    "opencode.config.missing",
                    "OpenCode 配置文件不存在",
                    "OpenCode configuration file not found",
                ));
            }

            let config = read_opencode_config()?;
            Ok(config)
        }
        AppType::OpenClaw => {
            use crate::openclaw_config::{get_openclaw_config_path, read_openclaw_config};

            let config_path = get_openclaw_config_path();
            if !config_path.exists() {
                return Err(AppError::localized(
                    "openclaw.config.missing",
                    "OpenClaw 配置文件不存在",
                    "OpenClaw configuration file not found",
                ));
            }

            let config = read_openclaw_config()?;
            Ok(config)
        }
    }
}

/// Import default configuration from live files
///
/// Returns `Ok(true)` if a provider was actually imported,
/// `Ok(false)` if skipped (providers already exist for this app).
pub fn import_default_config(state: &AppState, app_type: AppType) -> Result<bool, AppError> {
    // Additive mode apps (OpenCode, OpenClaw) should use their dedicated
    // import_xxx_providers_from_live functions, not this generic default config import
    if app_type.is_additive_mode() {
        return Ok(false);
    }

    {
        let providers = state.db.get_all_providers(app_type.as_str())?;
        if !providers.is_empty() {
            return Ok(false); // 已有供应商，跳过
        }
    }

    let settings_config = match app_type {
        AppType::Codex => {
            let auth_path = get_codex_auth_path();
            if !auth_path.exists() {
                return Err(AppError::localized(
                    "codex.live.missing",
                    "Codex 配置文件不存在",
                    "Codex configuration file is missing",
                ));
            }
            let auth: Value = read_json_file(&auth_path)?;
            let config_str = crate::codex_config::read_and_validate_codex_config_text()?;
            json!({ "auth": auth, "config": config_str })
        }
        AppType::Claude => {
            let settings_path = get_claude_settings_path();
            if !settings_path.exists() {
                return Err(AppError::localized(
                    "claude.live.missing",
                    "Claude Code 配置文件不存在",
                    "Claude settings file is missing",
                ));
            }
            let mut v = read_json_file::<Value>(&settings_path)?;
            let _ = normalize_claude_models_in_value(&mut v);
            v
        }
        AppType::Gemini => {
            use crate::gemini_config::{
                env_to_json, get_gemini_env_path, get_gemini_settings_path, read_gemini_env,
            };

            // Read .env file (environment variables)
            let env_path = get_gemini_env_path();
            if !env_path.exists() {
                return Err(AppError::localized(
                    "gemini.live.missing",
                    "Gemini 配置文件不存在",
                    "Gemini configuration file is missing",
                ));
            }

            let env_map = read_gemini_env()?;
            let env_json = env_to_json(&env_map);
            let env_obj = env_json.get("env").cloned().unwrap_or_else(|| json!({}));

            // Read settings.json file (MCP config etc.)
            let settings_path = get_gemini_settings_path();
            let config_obj = if settings_path.exists() {
                read_json_file(&settings_path)?
            } else {
                json!({})
            };

            // Return complete structure: { "env": {...}, "config": {...} }
            json!({
                "env": env_obj,
                "config": config_obj
            })
        }
        // OpenCode and OpenClaw use additive mode and are handled by early return above
        AppType::OpenCode | AppType::OpenClaw => {
            unreachable!("additive mode apps are handled by early return")
        }
    };

    let mut provider = Provider::with_id(
        "default".to_string(),
        "default".to_string(),
        settings_config,
        None,
    );
    provider.category = Some("custom".to_string());

    state.db.save_provider(app_type.as_str(), &provider)?;
    state
        .db
        .set_current_provider(app_type.as_str(), &provider.id)?;

    Ok(true) // 真正导入了
}

/// Write Gemini live configuration with authentication handling
pub(crate) fn write_gemini_live(provider: &Provider) -> Result<(), AppError> {
    use crate::gemini_config::{
        get_gemini_settings_path, json_to_env, validate_gemini_settings_strict,
        write_gemini_env_atomic,
    };

    // One-time auth type detection to avoid repeated detection
    let auth_type = detect_gemini_auth_type(provider);

    let mut env_map = json_to_env(&provider.settings_config)?;

    // Prepare config to write to ~/.gemini/settings.json
    // Behavior:
    // - config is object: use it directly（渲染阶段已决定最终内容）
    // - config is null or absent: preserve existing file content
    let settings_path = get_gemini_settings_path();
    let mut config_to_write: Option<Value> = None;

    if let Some(config_value) = provider.settings_config.get("config") {
        if config_value.is_object() {
            config_to_write = Some(config_value.clone());
        } else if !config_value.is_null() {
            return Err(AppError::localized(
                "gemini.validation.invalid_config",
                "Gemini 配置格式错误: config 必须是对象或 null",
                "Gemini config invalid: config must be an object or null",
            ));
        }
        // config is null: don't modify existing settings.json (preserve mcpServers etc.)
    }

    // If no config specified or config is null, preserve existing file
    if config_to_write.is_none() && settings_path.exists() {
        config_to_write = Some(read_json_file(&settings_path)?);
    }

    match auth_type {
        GeminiAuthType::GoogleOfficial => {
            // Google official uses OAuth, clear env
            env_map.clear();
            write_gemini_env_atomic(&env_map)?;
        }
        GeminiAuthType::Packycode => {
            // PackyCode provider, uses API Key (strict validation on switch)
            validate_gemini_settings_strict(&provider.settings_config)?;
            write_gemini_env_atomic(&env_map)?;
        }
        GeminiAuthType::Generic => {
            // Generic provider, uses API Key (strict validation on switch)
            validate_gemini_settings_strict(&provider.settings_config)?;
            write_gemini_env_atomic(&env_map)?;
        }
    }

    if let Some(config_value) = config_to_write {
        write_json_file(&settings_path, &config_value)?;
    }

    // Set security.auth.selectedType based on auth type
    // - Google Official: OAuth mode
    // - All others: API Key mode
    match auth_type {
        GeminiAuthType::GoogleOfficial => ensure_google_oauth_security_flag(provider)?,
        GeminiAuthType::Packycode | GeminiAuthType::Generic => {
            crate::gemini_config::write_packycode_settings()?;
        }
    }

    Ok(())
}

/// Remove an OpenCode provider from the live configuration
///
/// This is specific to OpenCode's additive mode - removing a provider
/// from the opencode.json file.
pub(crate) fn remove_opencode_provider_from_live(provider_id: &str) -> Result<(), AppError> {
    use crate::opencode_config;

    // Check if OpenCode config directory exists
    if !opencode_config::get_opencode_dir().exists() {
        log::debug!("OpenCode config directory doesn't exist, skipping removal of '{provider_id}'");
        return Ok(());
    }

    opencode_config::remove_provider(provider_id)?;
    log::info!("OpenCode provider '{provider_id}' removed from live config");

    Ok(())
}

/// Import all providers from OpenCode live config to database
///
/// This imports existing providers from ~/.config/opencode/opencode.json
/// into the CC Switch database. Each provider found will be added to the
/// database with is_current set to false.
pub fn import_opencode_providers_from_live(state: &AppState) -> Result<usize, AppError> {
    use crate::opencode_config;

    let providers = opencode_config::get_typed_providers()?;
    if providers.is_empty() {
        return Ok(0);
    }

    let mut imported = 0;
    let existing = state.db.get_all_providers("opencode")?;

    for (id, config) in providers {
        // Skip if already exists in database
        if existing.contains_key(&id) {
            log::debug!("OpenCode provider '{id}' already exists in database, skipping");
            continue;
        }

        // Convert to Value for settings_config
        let settings_config = match serde_json::to_value(&config) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("Failed to serialize OpenCode provider '{id}': {e}");
                continue;
            }
        };

        // Create provider
        let provider = Provider::with_id(
            id.clone(),
            config.name.clone().unwrap_or_else(|| id.clone()),
            settings_config,
            None,
        );

        // Save to database
        if let Err(e) = state.db.save_provider("opencode", &provider) {
            log::warn!("Failed to import OpenCode provider '{id}': {e}");
            continue;
        }

        imported += 1;
        log::info!("Imported OpenCode provider '{id}' from live config");
    }

    Ok(imported)
}

/// Import all providers from OpenClaw live config to database
///
/// This imports existing providers from ~/.openclaw/openclaw.json
/// into the CC Switch database. Each provider found will be added to the
/// database with is_current set to false.
pub fn import_openclaw_providers_from_live(state: &AppState) -> Result<usize, AppError> {
    use crate::openclaw_config;

    let providers = openclaw_config::get_typed_providers()?;
    if providers.is_empty() {
        return Ok(0);
    }

    let mut imported = 0;
    let existing = state.db.get_all_providers("openclaw")?;

    for (id, config) in providers {
        // Validate: skip entries with empty id or no models
        if id.trim().is_empty() {
            log::warn!("Skipping OpenClaw provider with empty id");
            continue;
        }
        if config.models.is_empty() {
            log::warn!("Skipping OpenClaw provider '{id}': no models defined");
            continue;
        }

        // Skip if already exists in database
        if existing.contains_key(&id) {
            log::debug!("OpenClaw provider '{id}' already exists in database, skipping");
            continue;
        }

        // Convert to Value for settings_config
        let settings_config = match serde_json::to_value(&config) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("Failed to serialize OpenClaw provider '{id}': {e}");
                continue;
            }
        };

        // Determine display name: use first model name if available, otherwise use id
        let display_name = config
            .models
            .first()
            .and_then(|m| m.name.clone())
            .unwrap_or_else(|| id.clone());

        // Create provider
        let provider = Provider::with_id(id.clone(), display_name, settings_config, None);

        // Save to database
        if let Err(e) = state.db.save_provider("openclaw", &provider) {
            log::warn!("Failed to import OpenClaw provider '{id}': {e}");
            continue;
        }

        imported += 1;
        log::info!("Imported OpenClaw provider '{id}' from live config");
    }

    Ok(imported)
}

/// Remove an OpenClaw provider from live config
///
/// This removes a specific provider from ~/.openclaw/openclaw.json
/// without affecting other providers in the file.
pub fn remove_openclaw_provider_from_live(provider_id: &str) -> Result<(), AppError> {
    use crate::openclaw_config;

    // Check if OpenClaw config directory exists
    if !openclaw_config::get_openclaw_dir().exists() {
        log::debug!("OpenClaw config directory doesn't exist, skipping removal of '{provider_id}'");
        return Ok(());
    }

    openclaw_config::remove_provider(provider_id)?;
    log::info!("OpenClaw provider '{provider_id}' removed from live config");

    Ok(())
}
