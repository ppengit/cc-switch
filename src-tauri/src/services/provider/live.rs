//! Live configuration operations
//!
//! Handles reading and writing live configuration files for Claude, Codex, and Gemini.

use std::collections::HashMap;

use serde_json::{json, Value};
use toml_edit::{DocumentMut, Item, TableLike};

use crate::app_config::AppType;
use crate::codex_config::{
    get_codex_auth_path, get_codex_config_path, write_codex_live_atomic_with_stable_provider,
};
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

pub(crate) fn provider_exists_in_live_config(
    app_type: &AppType,
    provider_id: &str,
) -> Result<bool, AppError> {
    match app_type {
        AppType::OpenCode => crate::opencode_config::get_providers()
            .map(|providers| providers.contains_key(provider_id)),
        AppType::OpenClaw => crate::openclaw_config::get_providers()
            .map(|providers| providers.contains_key(provider_id)),
        AppType::Hermes => crate::hermes_config::get_providers()
            .map(|providers| providers.contains_key(provider_id)),
        _ => Ok(false),
    }
}

fn json_is_subset(target: &Value, source: &Value) -> bool {
    match source {
        Value::Object(source_map) => {
            let Some(target_map) = target.as_object() else {
                return false;
            };
            source_map.iter().all(|(key, source_value)| {
                target_map
                    .get(key)
                    .is_some_and(|target_value| json_is_subset(target_value, source_value))
            })
        }
        Value::Array(source_arr) => {
            let Some(target_arr) = target.as_array() else {
                return false;
            };
            json_array_contains_subset(target_arr, source_arr)
        }
        _ => target == source,
    }
}

fn json_array_contains_subset(target_arr: &[Value], source_arr: &[Value]) -> bool {
    let mut matched = vec![false; target_arr.len()];

    source_arr.iter().all(|source_item| {
        if let Some((index, _)) = target_arr.iter().enumerate().find(|(index, target_item)| {
            !matched[*index] && json_is_subset(target_item, source_item)
        }) {
            matched[index] = true;
            true
        } else {
            false
        }
    })
}

fn json_remove_array_items(target_arr: &mut Vec<Value>, source_arr: &[Value]) {
    for source_item in source_arr {
        if let Some(index) = target_arr
            .iter()
            .position(|target_item| json_is_subset(target_item, source_item))
        {
            target_arr.remove(index);
        }
    }
}

fn json_deep_merge(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target_map), Value::Object(source_map)) => {
            for (key, source_value) in source_map {
                match target_map.get_mut(key) {
                    Some(target_value) => json_deep_merge(target_value, source_value),
                    None => {
                        target_map.insert(key.clone(), source_value.clone());
                    }
                }
            }
        }
        (target_value, source_value) => {
            *target_value = source_value.clone();
        }
    }
}

fn json_deep_remove(target: &mut Value, source: &Value) {
    let (Some(target_map), Some(source_map)) = (target.as_object_mut(), source.as_object()) else {
        return;
    };

    for (key, source_value) in source_map {
        let mut remove_key = false;

        if let Some(target_value) = target_map.get_mut(key) {
            if source_value.is_object() && target_value.is_object() {
                json_deep_remove(target_value, source_value);
                remove_key = target_value.as_object().is_some_and(|obj| obj.is_empty());
            } else if let (Some(target_arr), Some(source_arr)) =
                (target_value.as_array_mut(), source_value.as_array())
            {
                json_remove_array_items(target_arr, source_arr);
                remove_key = target_arr.is_empty();
            } else if json_is_subset(target_value, source_value) {
                remove_key = true;
            }
        }

        if remove_key {
            target_map.remove(key);
        }
    }
}

fn toml_value_is_subset(target: &toml_edit::Value, source: &toml_edit::Value) -> bool {
    match (target, source) {
        (toml_edit::Value::String(target), toml_edit::Value::String(source)) => {
            target.value() == source.value()
        }
        (toml_edit::Value::Integer(target), toml_edit::Value::Integer(source)) => {
            target.value() == source.value()
        }
        (toml_edit::Value::Float(target), toml_edit::Value::Float(source)) => {
            target.value() == source.value()
        }
        (toml_edit::Value::Boolean(target), toml_edit::Value::Boolean(source)) => {
            target.value() == source.value()
        }
        (toml_edit::Value::Datetime(target), toml_edit::Value::Datetime(source)) => {
            target.value() == source.value()
        }
        (toml_edit::Value::Array(target), toml_edit::Value::Array(source)) => {
            toml_array_contains_subset(target, source)
        }
        (toml_edit::Value::InlineTable(target), toml_edit::Value::InlineTable(source)) => {
            source.iter().all(|(key, source_item)| {
                target
                    .get(key)
                    .is_some_and(|target_item| toml_value_is_subset(target_item, source_item))
            })
        }
        _ => false,
    }
}

fn toml_array_contains_subset(target: &toml_edit::Array, source: &toml_edit::Array) -> bool {
    let mut matched = vec![false; target.len()];
    let target_items: Vec<&toml_edit::Value> = target.iter().collect();

    source.iter().all(|source_item| {
        if let Some((index, _)) = target_items
            .iter()
            .enumerate()
            .find(|(index, target_item)| {
                !matched[*index] && toml_value_is_subset(target_item, source_item)
            })
        {
            matched[index] = true;
            true
        } else {
            false
        }
    })
}

fn toml_remove_array_items(target: &mut toml_edit::Array, source: &toml_edit::Array) {
    for source_item in source.iter() {
        let index = {
            let target_items: Vec<&toml_edit::Value> = target.iter().collect();
            target_items
                .iter()
                .enumerate()
                .find(|(_, target_item)| toml_value_is_subset(target_item, source_item))
                .map(|(index, _)| index)
        };

        if let Some(index) = index {
            target.remove(index);
        }
    }
}

fn toml_item_is_subset(target: &Item, source: &Item) -> bool {
    if let Some(source_table) = source.as_table_like() {
        let Some(target_table) = target.as_table_like() else {
            return false;
        };
        return source_table.iter().all(|(key, source_item)| {
            target_table
                .get(key)
                .is_some_and(|target_item| toml_item_is_subset(target_item, source_item))
        });
    }

    match (target.as_value(), source.as_value()) {
        (Some(target_value), Some(source_value)) => {
            toml_value_is_subset(target_value, source_value)
        }
        _ => false,
    }
}

fn remove_toml_item(target: &mut Item, source: &Item) {
    if let Some(source_table) = source.as_table_like() {
        if let Some(target_table) = target.as_table_like_mut() {
            remove_toml_table_like(target_table, source_table);
            if target_table.is_empty() {
                *target = Item::None;
            }
            return;
        }
    }

    if let Some(source_value) = source.as_value() {
        let mut remove_item = false;

        if let Some(target_value) = target.as_value_mut() {
            match (target_value, source_value) {
                (toml_edit::Value::Array(target_arr), toml_edit::Value::Array(source_arr)) => {
                    toml_remove_array_items(target_arr, source_arr);
                    remove_item = target_arr.is_empty();
                }
                (target_value, source_value)
                    if toml_value_is_subset(target_value, source_value) =>
                {
                    remove_item = true;
                }
                _ => {}
            }
        }

        if remove_item {
            *target = Item::None;
        }
    }
}

fn remove_toml_table_like(target: &mut dyn TableLike, source: &dyn TableLike) {
    let keys: Vec<String> = source.iter().map(|(key, _)| key.to_string()).collect();

    for key in keys {
        let mut remove_key = false;
        if let (Some(target_item), Some(source_item)) = (target.get_mut(&key), source.get(&key)) {
            remove_toml_item(target_item, source_item);
            remove_key = target_item.is_none()
                || target_item
                    .as_table_like()
                    .is_some_and(|table_like| table_like.is_empty());
        }

        if remove_key {
            target.remove(&key);
        }
    }
}

const CODEX_COMMON_CONFIG_BLOCK_START: &str = "# >>> CC-SWITCH COMMON CONFIG START";
const CODEX_COMMON_CONFIG_BLOCK_END: &str = "# <<< CC-SWITCH COMMON CONFIG END";
const CONFIG_TEMPLATE_PROVIDER_PLACEHOLDER: &str = "{providerConfig}";
const CONFIG_TEMPLATE_MCP_PLACEHOLDER: &str = "{mcpConfig}";
const CONFIG_TEMPLATE_SETTINGS_PLACEHOLDER: &str = "{settingsConfig}";
const GEMINI_TEMPLATE_ENV_SECTION_HEADER: &str = "# .env";
const GEMINI_TEMPLATE_SETTINGS_SECTION_HEADER: &str = "# settings.json";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigTemplateFile {
    key: String,
    label: String,
    content: String,
}

fn default_template_files_for(app_type: &AppType) -> Vec<AppConfigTemplateFile> {
    match app_type {
        AppType::Claude => vec![AppConfigTemplateFile {
            key: "settings".to_string(),
            label: "settings.json".to_string(),
            content: "{providerConfig}\n".to_string(),
        }],
        AppType::Codex => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "config.toml".to_string(),
            content: "{providerConfig}\n\n{mcpConfig}\n".to_string(),
        }],
        AppType::Gemini => vec![
            AppConfigTemplateFile {
                key: "env".to_string(),
                label: ".env".to_string(),
                content: "{providerConfig}\n".to_string(),
            },
            AppConfigTemplateFile {
                key: "settings".to_string(),
                label: "settings.json".to_string(),
                content: "{\n  {settingsConfig}\n  \"mcpServers\": {mcpConfig}\n}\n"
                    .to_string(),
            },
        ],
        AppType::OpenCode => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "opencode.json".to_string(),
            content: "{providerConfig}\n".to_string(),
        }],
        AppType::OpenClaw => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "openclaw.json".to_string(),
            content: "{providerConfig}\n".to_string(),
        }],
        AppType::Hermes => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "config.yaml".to_string(),
            content: "{providerConfig}\n".to_string(),
        }],
    }
}

fn split_legacy_gemini_template(template: &str) -> Vec<AppConfigTemplateFile> {
    #[derive(Clone, Copy)]
    enum Section {
        Env,
        Settings,
    }

    let mut current: Option<Section> = None;
    let mut env_lines = Vec::new();
    let mut settings_lines = Vec::new();

    for line in template.lines() {
        match line.trim() {
            GEMINI_TEMPLATE_ENV_SECTION_HEADER => {
                current = Some(Section::Env);
                continue;
            }
            GEMINI_TEMPLATE_SETTINGS_SECTION_HEADER => {
                current = Some(Section::Settings);
                continue;
            }
            _ => {}
        }

        match current {
            Some(Section::Env) => env_lines.push(line),
            Some(Section::Settings) => settings_lines.push(line),
            None => {}
        }
    }

    if env_lines.is_empty() && settings_lines.is_empty() {
        return default_template_files_for(&AppType::Gemini);
    }

    vec![
        AppConfigTemplateFile {
            key: "env".to_string(),
            label: ".env".to_string(),
            content: format!("{}\n", env_lines.join("\n").trim_matches('\n')),
        },
        AppConfigTemplateFile {
            key: "settings".to_string(),
            label: "settings.json".to_string(),
            content: format!("{}\n", settings_lines.join("\n").trim_matches('\n')),
        },
    ]
}

fn parse_stored_template_files(app_type: &AppType, persisted: Option<String>) -> Vec<AppConfigTemplateFile> {
    let Some(persisted) = persisted else {
        return default_template_files_for(app_type);
    };

    let trimmed = persisted.trim();
    if trimmed.is_empty() {
        return default_template_files_for(app_type);
    }

    if let Ok(files) = serde_json::from_str::<Vec<AppConfigTemplateFile>>(trimmed) {
        return files;
    }

    match app_type {
        AppType::Gemini => split_legacy_gemini_template(&persisted),
        _ => {
            let mut files = default_template_files_for(app_type);
            if let Some(first) = files.first_mut() {
                first.content = persisted;
            }
            files
        }
    }
}

fn get_effective_config_template_files(
    db: &Database,
    app_type: &AppType,
) -> Vec<AppConfigTemplateFile> {
    let persisted = db.get_config_template(app_type.as_str()).ok().flatten();
    parse_stored_template_files(app_type, persisted)
}

fn get_template_content_by_key(db: &Database, app_type: &AppType, key: &str) -> String {
    get_effective_config_template_files(db, app_type)
        .into_iter()
        .find(|file| file.key == key)
        .map(|file| file.content)
        .unwrap_or_else(|| {
            default_template_files_for(app_type)
                .into_iter()
                .find(|file| file.key == key)
                .map(|file| file.content)
                .unwrap_or_else(|| "{providerConfig}\n".to_string())
        })
}

fn codex_strip_managed_common_config_block(config_toml: &str) -> (String, bool) {
    let mut output_lines = Vec::new();
    let mut in_block = false;
    let mut removed = false;

    for line in config_toml.lines() {
        let trimmed = line.trim();
        if trimmed == CODEX_COMMON_CONFIG_BLOCK_START {
            in_block = true;
            removed = true;
            continue;
        }
        if trimmed == CODEX_COMMON_CONFIG_BLOCK_END {
            in_block = false;
            continue;
        }
        if !in_block {
            output_lines.push(line);
        }
    }

    // If start marker exists but end marker is missing, we still treat the
    // trailing content as managed block to avoid polluting provider config.
    let mut normalized = output_lines.join("\n");
    while normalized.ends_with('\n') {
        normalized.pop();
    }
    if !normalized.is_empty() {
        normalized.push('\n');
    }

    (normalized, removed)
}

fn codex_common_config_block_present(config_toml: &str) -> bool {
    config_toml.contains(CODEX_COMMON_CONFIG_BLOCK_START)
        && config_toml.contains(CODEX_COMMON_CONFIG_BLOCK_END)
}

fn json_value_to_toml_item_for_template(value: &Value) -> Option<Item> {
    match value {
        Value::String(s) => Some(toml_edit::value(s.clone())),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(toml_edit::value(i))
            } else if let Some(u) = n.as_u64() {
                Some(toml_edit::value(u as i64))
            } else {
                n.as_f64().map(toml_edit::value)
            }
        }
        Value::Bool(b) => Some(toml_edit::value(*b)),
        Value::Array(arr) => {
            let mut output = toml_edit::Array::default();
            for item in arr {
                match item {
                    Value::String(s) => output.push(s.as_str()),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            output.push(i);
                        } else if let Some(u) = n.as_u64() {
                            output.push(u as i64);
                        } else if let Some(f) = n.as_f64() {
                            output.push(f);
                        } else {
                            return None;
                        }
                    }
                    Value::Bool(b) => output.push(*b),
                    _ => return None,
                }
            }
            Some(Item::Value(toml_edit::Value::Array(output)))
        }
        Value::Object(obj) => {
            let mut table = toml_edit::InlineTable::default();
            for (key, value) in obj {
                let Some(string_value) = value.as_str() else {
                    return None;
                };
                table.insert(key, toml_edit::Value::from(string_value));
            }
            Some(Item::Value(toml_edit::Value::InlineTable(table)))
        }
        Value::Null => None,
    }
}

fn mcp_server_to_codex_table_for_template(spec: &Value) -> Result<toml_edit::Table, AppError> {
    let mut table = toml_edit::Table::new();
    let server_obj = spec.as_object().ok_or_else(|| {
        AppError::Message("MCP server spec must be an object for Codex template".to_string())
    })?;

    let server_type = server_obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    table["type"] = toml_edit::value(server_type);

    match server_type {
        "stdio" => {
            if let Some(command) = server_obj.get("command").and_then(Value::as_str) {
                table["command"] = toml_edit::value(command);
            }

            if let Some(args) = server_obj.get("args").and_then(Value::as_array) {
                let mut output = toml_edit::Array::default();
                for arg in args.iter().filter_map(Value::as_str) {
                    output.push(arg);
                }
                if !output.is_empty() {
                    table["args"] = Item::Value(toml_edit::Value::Array(output));
                }
            }

            if let Some(cwd) = server_obj.get("cwd").and_then(Value::as_str) {
                if !cwd.trim().is_empty() {
                    table["cwd"] = toml_edit::value(cwd);
                }
            }

            if let Some(env) = server_obj.get("env").and_then(Value::as_object) {
                let mut env_table = toml_edit::Table::new();
                for (key, value) in env {
                    if let Some(value) = value.as_str() {
                        env_table[key] = toml_edit::value(value);
                    }
                }
                if !env_table.is_empty() {
                    table["env"] = Item::Table(env_table);
                }
            }
        }
        "http" | "sse" => {
            if let Some(url) = server_obj.get("url").and_then(Value::as_str) {
                table["url"] = toml_edit::value(url);
            }

            if let Some(headers) = server_obj.get("headers").and_then(Value::as_object) {
                let mut headers_table = toml_edit::Table::new();
                for (key, value) in headers {
                    if let Some(value) = value.as_str() {
                        headers_table[key] = toml_edit::value(value);
                    }
                }
                if !headers_table.is_empty() {
                    table["http_headers"] = Item::Table(headers_table);
                }
            }
        }
        _ => {}
    }

    for (key, value) in server_obj {
        if matches!(
            key.as_str(),
            "type" | "command" | "args" | "cwd" | "env" | "url" | "headers" | "http_headers"
        ) {
            continue;
        }

        if let Some(item) = json_value_to_toml_item_for_template(value) {
            table[key] = item;
        }
    }

    Ok(table)
}

fn build_codex_mcp_template_block(db: &Database) -> Result<String, AppError> {
    let servers = db.get_all_mcp_servers()?;
    let mut mcp_servers = toml_edit::Table::new();
    let mut has_any = false;

    for (id, server) in servers.iter() {
        if !server.apps.codex {
            continue;
        }

        match mcp_server_to_codex_table_for_template(&server.server) {
            Ok(table) => {
                mcp_servers[id.as_str()] = Item::Table(table);
                has_any = true;
            }
            Err(err) => {
                log::warn!("Skip invalid Codex MCP server '{id}' while rendering template: {err}");
            }
        }
    }

    if !has_any {
        return Ok(String::new());
    }

    let mut doc = DocumentMut::new();
    doc["mcp_servers"] = Item::Table(mcp_servers);
    Ok(doc.to_string().trim_end_matches('\n').to_string())
}

fn strip_codex_mcp_servers_section(config_toml: &str) -> Result<String, AppError> {
    if config_toml.trim().is_empty() {
        return Ok(String::new());
    }

    let mut doc = config_toml.parse::<DocumentMut>().map_err(|e| {
        AppError::Message(format!(
            "Invalid Codex provider config.toml while stripping mcp_servers: {e}"
        ))
    })?;
    doc.as_table_mut().remove("mcp_servers");
    Ok(doc.to_string())
}

fn apply_codex_template_to_settings(db: &Database, settings: &Value) -> Result<Value, AppError> {
    let mut result = settings.clone();
    let template = get_template_content_by_key(db, &AppType::Codex, "config");
    let raw_provider_config = settings.get("config").and_then(Value::as_str).unwrap_or("");
    let provider_config = match strip_codex_mcp_servers_section(raw_provider_config) {
        Ok(stripped) => stripped.trim_end_matches('\n').to_string(),
        Err(err) => {
            log::warn!(
                "Failed to strip existing mcp_servers from Codex provider config before template render: {err}"
            );
            raw_provider_config.trim_end_matches('\n').to_string()
        }
    };
    let mcp_config = build_codex_mcp_template_block(db)?;

    let rendered = template
        .replace(CONFIG_TEMPLATE_PROVIDER_PLACEHOLDER, &provider_config)
        .replace(CONFIG_TEMPLATE_MCP_PLACEHOLDER, mcp_config.trim());

    let rendered_trimmed = rendered.trim();
    if !rendered_trimmed.is_empty() {
        rendered_trimmed.parse::<DocumentMut>().map_err(|e| {
            AppError::Message(format!(
                "Invalid rendered Codex template (config.toml): {e}"
            ))
        })?;
    }

    if let Some(obj) = result.as_object_mut() {
        let mut normalized = rendered.trim_end_matches('\n').to_string();
        if !normalized.is_empty() {
            normalized.push('\n');
        }
        obj.insert("config".to_string(), Value::String(normalized));
    }

    Ok(result)
}

fn gemini_provider_env_to_template_text(settings: &Value) -> Result<String, AppError> {
    let env_map = crate::gemini_config::json_to_env(settings)?;
    Ok(crate::gemini_config::serialize_env_file(&env_map))
}

fn clear_gemini_rendered_env_text(settings: &mut Value) {
    if let Some(obj) = settings.as_object_mut() {
        obj.remove(crate::gemini_config::GEMINI_RENDERED_ENV_TEXT_FIELD);
    }
}

fn build_gemini_provider_settings_fragment(settings: &Value) -> Result<Value, AppError> {
    let Some(config_value) = settings.get("config") else {
        return Ok(json!({}));
    };

    if config_value.is_null() {
        return Ok(json!({}));
    }

    let mut config = config_value.clone();
    let Some(obj) = config.as_object_mut() else {
        return Err(AppError::localized(
            "gemini.validation.invalid_config",
            "Gemini 配置格式错误: config 必须是对象或 null",
            "Gemini config invalid: config must be an object or null",
        ));
    };
    obj.remove("mcpServers");
    Ok(config)
}

fn json_object_to_template_members(
    value: &Value,
    include_trailing_comma: bool,
) -> Result<String, AppError> {
    let Some(obj) = value.as_object() else {
        return Ok(String::new());
    };

    if obj.is_empty() {
        return Ok(String::new());
    }

    let mut keys: Vec<_> = obj.keys().cloned().collect();
    keys.sort();

    let mut chunks = Vec::new();
    for key in keys {
        let rendered_key = serde_json::to_string(&key)
            .map_err(|e| AppError::Message(format!("JSON serialization failed: {e}")))?;
        let rendered_value = serde_json::to_string_pretty(
            obj.get(&key)
                .expect("key should exist while rendering Gemini template"),
        )
        .map_err(|e| AppError::Message(format!("JSON serialization failed: {e}")))?;

        let value_lines: Vec<&str> = rendered_value.lines().collect();
        let mut entry = String::new();
        entry.push_str("  ");
        entry.push_str(&rendered_key);
        entry.push_str(": ");
        entry.push_str(value_lines.first().copied().unwrap_or("null"));

        for line in value_lines.iter().skip(1) {
            entry.push('\n');
            entry.push_str("  ");
            entry.push_str(line);
        }

        if include_trailing_comma {
            entry.push(',');
        }
        chunks.push(entry);
    }

    Ok(format!("{}\n", chunks.join("\n")))
}

fn build_gemini_mcp_template_block(db: &Database) -> Result<String, AppError> {
    let servers = db.get_all_mcp_servers()?;
    let mut enabled = HashMap::new();

    for (id, server) in servers {
        if !server.apps.gemini {
            continue;
        }
        enabled.insert(id, server.server);
    }

    if enabled.is_empty() {
        return Ok(String::new());
    }

    let rendered = serde_json::to_string_pretty(&Value::Object(
        crate::gemini_mcp::build_mcp_servers_object(&enabled)?,
    ))
    .map_err(|e| AppError::Message(format!("JSON serialization failed: {e}")))?;

    Ok(rendered)
}

fn render_gemini_settings_template(
    template: &str,
    settings_members: &str,
    mcp_block: &str,
) -> String {
    let template = if mcp_block.trim().is_empty() {
        template
            .lines()
            .filter(|line| !line.contains(CONFIG_TEMPLATE_MCP_PLACEHOLDER))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        template.to_string()
    };

    template
        .replace(CONFIG_TEMPLATE_SETTINGS_PLACEHOLDER, settings_members)
        .replace(CONFIG_TEMPLATE_MCP_PLACEHOLDER, mcp_block)
        .trim()
        .to_string()
}

fn apply_gemini_template_to_settings(db: &Database, settings: &Value) -> Result<Value, AppError> {
    let env_template = get_template_content_by_key(db, &AppType::Gemini, "env");
    let settings_template = get_template_content_by_key(db, &AppType::Gemini, "settings");

    let provider_env_text = gemini_provider_env_to_template_text(settings)?;
    let provider_env_value = settings.get("env").cloned().unwrap_or_else(|| json!({}));
    let provider_settings_fragment = build_gemini_provider_settings_fragment(settings)?;
    let mcp_block = build_gemini_mcp_template_block(db)?;
    let has_mcp = !mcp_block.trim().is_empty();
    let settings_members = json_object_to_template_members(&provider_settings_fragment, has_mcp)?;

    let rendered_env = env_template
        .replace(CONFIG_TEMPLATE_PROVIDER_PLACEHOLDER, &provider_env_text)
        .trim_matches('\n')
        .to_string();
    let mut env_map = if rendered_env.is_empty() {
        HashMap::new()
    } else {
        crate::gemini_config::parse_env_file_strict(&rendered_env)?
    };

    if let Some(provider_env) = provider_env_value.as_object() {
        for (key, value) in provider_env {
            if let Some(value) = value.as_str() {
                env_map.insert(key.clone(), value.to_string());
            }
        }
    }

    let rendered_settings =
        render_gemini_settings_template(&settings_template, &settings_members, &mcp_block);

    let mut config = if rendered_settings.is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&rendered_settings).map_err(|e| {
            AppError::Message(format!(
                "Invalid rendered Gemini template (settings.json): {e}"
            ))
        })?
    };

    json_deep_merge(&mut config, &provider_settings_fragment);
    let Some(config_obj) = config.as_object_mut() else {
        return Err(AppError::localized(
            "gemini.validation.invalid_config",
            "Gemini 配置模板渲染结果必须是 JSON 对象",
            "Rendered Gemini template must be a JSON object",
        ));
    };
    if has_mcp {
        let mcp_value = serde_json::from_str::<Value>(&mcp_block)
            .map_err(|e| AppError::Message(format!("Invalid Gemini MCP template block: {e}")))?;
        config_obj.insert("mcpServers".to_string(), mcp_value);
    } else {
        config_obj.remove("mcpServers");
    }

    let env_value = crate::gemini_config::env_to_json(&env_map)
        .get("env")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut result = json!({
        "env": env_value,
        "config": config
    });

    if !rendered_env.is_empty() {
        if let Some(obj) = result.as_object_mut() {
            obj.insert(
                crate::gemini_config::GEMINI_RENDERED_ENV_TEXT_FIELD.to_string(),
                Value::String(rendered_env),
            );
        }
    }

    Ok(result)
}

fn codex_remove_legacy_common_config_structural(
    config_toml: &str,
    snippet: &str,
) -> Result<String, AppError> {
    let mut target_doc = if config_toml.trim().is_empty() {
        DocumentMut::new()
    } else {
        config_toml.parse::<DocumentMut>().map_err(|e| {
            AppError::Message(format!(
                "Invalid Codex config.toml while removing common config: {e}"
            ))
        })?
    };
    let source_doc = snippet.parse::<DocumentMut>().map_err(|e| {
        AppError::Message(format!("Invalid Codex common config snippet: {e}"))
    })?;

    remove_toml_table_like(target_doc.as_table_mut(), source_doc.as_table());
    Ok(target_doc.to_string())
}

fn codex_apply_common_config_with_block(config_toml: &str, snippet: &str) -> Result<String, AppError> {
    // Validate snippet first: if invalid, keep old error behavior.
    snippet
        .parse::<DocumentMut>()
        .map_err(|e| AppError::Message(format!("Invalid Codex common config snippet: {e}")))?;

    let (without_block, _) = codex_strip_managed_common_config_block(config_toml);
    let legacy_stripped = codex_remove_legacy_common_config_structural(&without_block, snippet)?;
    let legacy_trimmed = legacy_stripped.trim_end_matches('\n');
    let snippet_trimmed = snippet.trim_end();

    let mut rendered = String::new();
    if !legacy_trimmed.is_empty() {
        rendered.push_str(legacy_trimmed);
        rendered.push_str("\n\n");
    }
    rendered.push_str(CODEX_COMMON_CONFIG_BLOCK_START);
    rendered.push('\n');
    rendered.push_str(snippet_trimmed);
    rendered.push('\n');
    rendered.push_str(CODEX_COMMON_CONFIG_BLOCK_END);
    rendered.push('\n');

    Ok(rendered)
}

fn settings_contain_common_config(app_type: &AppType, settings: &Value, snippet: &str) -> bool {
    let trimmed = snippet.trim();
    if trimmed.is_empty() {
        return false;
    }

    match app_type {
        AppType::Claude => match serde_json::from_str::<Value>(trimmed) {
            Ok(source) if source.is_object() => json_is_subset(settings, &source),
            _ => false,
        },
        AppType::Codex => {
            let config_toml = settings.get("config").and_then(Value::as_str).unwrap_or("");
            if config_toml.trim().is_empty() {
                return false;
            }
            if codex_common_config_block_present(config_toml) {
                return true;
            }

            let target_doc = match config_toml.parse::<DocumentMut>() {
                Ok(doc) => doc,
                Err(_) => return false,
            };
            let source_doc = match trimmed.parse::<DocumentMut>() {
                Ok(doc) => doc,
                Err(_) => return false,
            };

            toml_item_is_subset(target_doc.as_item(), source_doc.as_item())
        }
        AppType::Gemini => match serde_json::from_str::<Value>(trimmed) {
            Ok(Value::Object(source_map)) => {
                let Some(target_map) = settings.get("env").and_then(Value::as_object) else {
                    return false;
                };
                source_map.iter().all(|(key, source_value)| {
                    target_map
                        .get(key)
                        .is_some_and(|target_value| json_is_subset(target_value, source_value))
                })
            }
            _ => false,
        },
        AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
            match serde_json::from_str::<Value>(trimmed) {
                Ok(source) if source.is_object() => json_is_subset(settings, &source),
                _ => false,
            }
        }
    }
}

pub(crate) fn provider_uses_common_config(
    _app_type: &AppType,
    _provider: &Provider,
    _snippet: Option<&str>,
) -> bool {
    false
}

pub(crate) fn remove_common_config_from_settings(
    app_type: &AppType,
    settings: &Value,
    snippet: &str,
) -> Result<Value, AppError> {
    let trimmed = snippet.trim();
    if trimmed.is_empty() {
        return Ok(settings.clone());
    }

    match app_type {
        AppType::Claude => {
            let source = serde_json::from_str::<Value>(trimmed)
                .map_err(|e| AppError::Message(format!("Invalid Claude common config: {e}")))?;
            let mut result = settings.clone();
            json_deep_remove(&mut result, &source);
            Ok(result)
        }
        AppType::Codex => {
            let mut result = settings.clone();
            let config_toml = settings.get("config").and_then(Value::as_str).unwrap_or("");
            let (without_block, removed_block) = codex_strip_managed_common_config_block(config_toml);
            let normalized = if removed_block {
                without_block
            } else {
                codex_remove_legacy_common_config_structural(config_toml, trimmed)?
            };
            if let Some(obj) = result.as_object_mut() {
                obj.insert("config".to_string(), Value::String(normalized));
            }
            Ok(result)
        }
        AppType::Gemini => {
            let source = serde_json::from_str::<Value>(trimmed)
                .map_err(|e| AppError::Message(format!("Invalid Gemini common config: {e}")))?;
            let mut result = settings.clone();
            if let Some(env) = result.get_mut("env") {
                json_deep_remove(env, &source);
            }
            clear_gemini_rendered_env_text(&mut result);
            Ok(result)
        }
        AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
            let source = serde_json::from_str::<Value>(trimmed).map_err(|e| {
                AppError::Message(format!(
                    "Invalid {} common config: {e}",
                    app_type.as_str()
                ))
            })?;
            let mut result = settings.clone();
            json_deep_remove(&mut result, &source);
            Ok(result)
        }
    }
}

fn apply_common_config_to_settings(
    app_type: &AppType,
    settings: &Value,
    snippet: &str,
) -> Result<Value, AppError> {
    let trimmed = snippet.trim();
    if trimmed.is_empty() {
        return Ok(settings.clone());
    }

    match app_type {
        AppType::Claude => {
            let source = serde_json::from_str::<Value>(trimmed)
                .map_err(|e| AppError::Message(format!("Invalid Claude common config: {e}")))?;
            let mut result = settings.clone();
            json_deep_merge(&mut result, &source);
            Ok(result)
        }
        AppType::Codex => {
            let mut result = settings.clone();
            let config_toml = settings.get("config").and_then(Value::as_str).unwrap_or("");
            let rendered = codex_apply_common_config_with_block(config_toml, trimmed)?;
            if let Some(obj) = result.as_object_mut() {
                obj.insert("config".to_string(), Value::String(rendered));
            }
            Ok(result)
        }
        AppType::Gemini => {
            let source = serde_json::from_str::<Value>(trimmed)
                .map_err(|e| AppError::Message(format!("Invalid Gemini common config: {e}")))?;
            let mut result = settings.clone();
            if let Some(env) = result.get_mut("env") {
                json_deep_merge(env, &source);
            } else if let Some(obj) = result.as_object_mut() {
                obj.insert("env".to_string(), source);
            }
            clear_gemini_rendered_env_text(&mut result);
            Ok(result)
        }
        AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
            let source = serde_json::from_str::<Value>(trimmed).map_err(|e| {
                AppError::Message(format!(
                    "Invalid {} common config: {e}",
                    app_type.as_str()
                ))
            })?;
            let mut result = settings.clone();
            json_deep_merge(&mut result, &source);
            Ok(result)
        }
    }
}

pub(crate) fn provider_uses_config_template(provider: &Provider) -> bool {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.use_config_template)
        .unwrap_or(true)
}

fn apply_json_template_to_settings(
    db: &Database,
    app_type: &AppType,
    settings: &Value,
    file_key: &str,
) -> Result<Value, AppError> {
    let template = get_template_content_by_key(db, app_type, file_key);
    let provider_config = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::Message(format!("JSON serialization failed: {e}")))?;

    let rendered = template
        .replace(CONFIG_TEMPLATE_PROVIDER_PLACEHOLDER, &provider_config)
        .replace(CONFIG_TEMPLATE_SETTINGS_PLACEHOLDER, "")
        .replace(CONFIG_TEMPLATE_MCP_PLACEHOLDER, "{}");

    serde_json::from_str::<Value>(rendered.trim()).map_err(|e| {
        AppError::Message(format!(
            "Invalid rendered {} template ({}): {e}",
            app_type.as_str(),
            file_key
        ))
    })
}

fn apply_hermes_template_to_settings(db: &Database, settings: &Value) -> Result<Value, AppError> {
    let template = get_template_content_by_key(db, &AppType::Hermes, "config");
    let provider_yaml = serde_yaml::to_string(&crate::hermes_config::json_to_yaml(settings)?)
        .map_err(|e| AppError::Message(format!("YAML serialization failed: {e}")))?;

    let rendered = template
        .replace(CONFIG_TEMPLATE_PROVIDER_PLACEHOLDER, provider_yaml.trim_end_matches('\n'))
        .replace(CONFIG_TEMPLATE_SETTINGS_PLACEHOLDER, "")
        .replace(CONFIG_TEMPLATE_MCP_PLACEHOLDER, "{}");

    let yaml_value = serde_yaml::from_str::<serde_yaml::Value>(rendered.trim())
        .map_err(|e| AppError::Message(format!("Invalid rendered Hermes template: {e}")))?;

    crate::hermes_config::yaml_to_json(&yaml_value)
}

pub(crate) fn build_effective_settings_without_template(
    _db: &Database,
    _app_type: &AppType,
    provider: &Provider,
) -> Result<Value, AppError> {
    Ok(provider.settings_config.clone())
}

pub(crate) fn build_effective_settings_with_common_config(
    db: &Database,
    app_type: &AppType,
    provider: &Provider,
) -> Result<Value, AppError> {
    let mut effective_settings = build_effective_settings_without_template(db, app_type, provider)?;

    if !provider_uses_config_template(provider) {
        return Ok(effective_settings);
    }

    match app_type {
        AppType::Claude => match apply_json_template_to_settings(db, app_type, &effective_settings, "settings") {
            Ok(rendered) => effective_settings = sanitize_claude_settings_for_live(&rendered),
            Err(err) => {
                log::warn!(
                    "Failed to apply config template for {} provider '{}': {err}",
                    app_type.as_str(),
                    provider.id
                );
            }
        },
        AppType::Codex => match apply_codex_template_to_settings(db, &effective_settings) {
            Ok(rendered) => effective_settings = rendered,
            Err(err) => {
                log::warn!(
                    "Failed to apply config template for {} provider '{}': {err}",
                    app_type.as_str(),
                    provider.id
                );
            }
        },
        AppType::Gemini => match apply_gemini_template_to_settings(db, &effective_settings) {
            Ok(rendered) => effective_settings = rendered,
            Err(err) => {
                log::warn!(
                    "Failed to apply config template for {} provider '{}': {err}",
                    app_type.as_str(),
                    provider.id
                );
            }
        },
        AppType::OpenCode => match apply_json_template_to_settings(db, app_type, &effective_settings, "config") {
            Ok(rendered) => effective_settings = rendered,
            Err(err) => {
                log::warn!(
                    "Failed to apply config template for {} provider '{}': {err}",
                    app_type.as_str(),
                    provider.id
                );
            }
        },
        AppType::OpenClaw => match apply_json_template_to_settings(db, app_type, &effective_settings, "config") {
            Ok(rendered) => effective_settings = rendered,
            Err(err) => {
                log::warn!(
                    "Failed to apply config template for {} provider '{}': {err}",
                    app_type.as_str(),
                    provider.id
                );
            }
        },
        AppType::Hermes => match apply_hermes_template_to_settings(db, &effective_settings) {
            Ok(rendered) => effective_settings = rendered,
            Err(err) => {
                log::warn!(
                    "Failed to apply config template for {} provider '{}': {err}",
                    app_type.as_str(),
                    provider.id
                );
            }
        },
    }

    Ok(effective_settings)
}

pub(crate) fn write_live_with_common_config(
    db: &Database,
    app_type: &AppType,
    provider: &Provider,
) -> Result<(), AppError> {
    let mut effective_provider = provider.clone();
    effective_provider.settings_config =
        build_effective_settings_with_common_config(db, app_type, provider)?;

    write_live_snapshot(app_type, &effective_provider)
}

pub(crate) fn strip_common_config_from_live_settings(
    db: &Database,
    app_type: &AppType,
    provider: &Provider,
    live_settings: Value,
) -> Value {
    let snippet = match db.get_config_snippet(app_type.as_str()) {
        Ok(snippet) => snippet,
        Err(err) => {
            log::warn!(
                "Failed to load common config for {} while backfilling '{}': {err}",
                app_type.as_str(),
                provider.id
            );
            return restore_live_settings_for_provider_backfill(app_type, provider, live_settings);
        }
    };

    let backfill_settings = if provider_uses_common_config(app_type, provider, snippet.as_deref()) {
        match snippet.as_deref() {
            Some(snippet_text) => {
                match remove_common_config_from_settings(app_type, &live_settings, snippet_text) {
                    Ok(settings) => settings,
                    Err(err) => {
                        log::warn!(
                            "Failed to strip common config for {} provider '{}': {err}",
                            app_type.as_str(),
                            provider.id
                        );
                        live_settings
                    }
                }
            }
            None => live_settings,
        }
    } else {
        live_settings
    };

    restore_live_settings_for_provider_backfill(app_type, provider, backfill_settings)
}

fn restore_live_settings_for_provider_backfill(
    app_type: &AppType,
    provider: &Provider,
    live_settings: Value,
) -> Value {
    if !matches!(app_type, AppType::Codex) {
        return live_settings;
    }

    let mut settings = live_settings;
    if let Err(err) = crate::codex_config::restore_codex_settings_config_model_provider_for_backfill(
        &mut settings,
        &provider.settings_config,
    ) {
        log::warn!(
            "Failed to restore Codex provider id while backfilling '{}': {err}",
            provider.id
        );
    }

    settings
}

pub(crate) fn normalize_provider_common_config_for_storage(
    _db: &Database,
    _app_type: &AppType,
    _provider: &mut Provider,
) -> Result<(), AppError> {
    Ok(())
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
pub(crate) fn write_live_snapshot(app_type: &AppType, provider: &Provider) -> Result<(), AppError> {
    match app_type {
        AppType::Claude => {
            let path = get_claude_settings_path();
            let settings = sanitize_claude_settings_for_live(&provider.settings_config);
            write_json_file(&path, &settings)?;
        }
        AppType::Codex => {
            let obj = provider
                .settings_config
                .as_object()
                .ok_or_else(|| AppError::Config("Codex 供应商配置必须是 JSON 对象".to_string()))?;
            let auth = obj
                .get("auth")
                .ok_or_else(|| AppError::Config("Codex 供应商配置缺少 'auth' 字段".to_string()))?;
            let config_str = obj.get("config").and_then(|v| v.as_str()).ok_or_else(|| {
                AppError::Config("Codex 供应商配置缺少 'config' 字段或不是字符串".to_string())
            })?;

            write_codex_live_atomic_with_stable_provider(auth, Some(config_str))?;
        }
        AppType::Gemini => {
            // Delegate to write_gemini_live which handles env file writing correctly
            write_gemini_live(provider)?;
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
                        return Err(AppError::Message(format!(
                            "OpenCode provider '{}' has invalid config structure for live config (must contain 'npm' or 'options')",
                            provider.id
                        )));
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
                        return Err(AppError::Message(format!(
                            "OpenClaw provider '{}' has invalid config structure for live config (must contain 'baseUrl', 'api', or 'models')",
                            provider.id
                        )));
                    }
                }
            }
        }
        AppType::Hermes => {
            crate::hermes_config::set_provider(&provider.id, provider.settings_config.clone())?;
            log::debug!("Hermes provider '{}' written to live config", provider.id);
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
    let mut synced_count = 0usize;

    for provider in providers.values() {
        if provider
            .meta
            .as_ref()
            .and_then(|meta| meta.live_config_managed)
            == Some(false)
        {
            continue;
        }

        if let Err(e) = write_live_with_common_config(state.db.as_ref(), app_type, provider) {
            log::warn!(
                "Failed to sync {:?} provider '{}' to live: {e}",
                app_type,
                provider.id
            );
            continue;
        }
        synced_count += 1;
    }

    log::info!("Synced {synced_count} {app_type:?} providers to live config");
    Ok(())
}

pub(crate) fn sync_current_provider_for_app_to_live(
    state: &AppState,
    app_type: &AppType,
) -> Result<(), AppError> {
    if app_type.is_additive_mode() {
        sync_all_providers_to_live(state, app_type)?;
    } else {
        let current_id = match crate::settings::get_effective_current_provider(&state.db, app_type)?
        {
            Some(id) => id,
            None => return Ok(()),
        };

        let providers = state.db.get_all_providers(app_type.as_str())?;
        if let Some(provider) = providers.get(&current_id) {
            write_live_with_common_config(state.db.as_ref(), app_type, provider)?;
        }
    }

    McpService::sync_all_enabled(state)?;

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
                write_live_with_common_config(state.db.as_ref(), &app_type, provider)?;
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
                read_gemini_env_text, GEMINI_RENDERED_ENV_TEXT_FIELD,
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
            let mut result = json!({
                "env": env_obj,
                "config": config_obj
            });

            let env_text = read_gemini_env_text()?;
            if !env_text.is_empty() {
                if let Some(obj) = result.as_object_mut() {
                    obj.insert(
                        GEMINI_RENDERED_ENV_TEXT_FIELD.to_string(),
                        Value::String(env_text),
                    );
                }
            }

            Ok(result)
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
        AppType::Hermes => {
            let config_path = crate::hermes_config::get_hermes_config_path();
            if !config_path.exists() {
                return Err(AppError::localized(
                    "hermes.config.missing",
                    "Hermes 配置文件不存在",
                    "Hermes configuration file not found",
                ));
            }
            let yaml_config = crate::hermes_config::read_hermes_config()?;
            let config = crate::hermes_config::yaml_to_json(&yaml_config)?;
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

    // 允许 "只有官方 seed 预设" 的情况下继续导入 live：
    // - 启动编排顺序是先 import 后 seed，新用户启动时 providers 为空，导入照常
    // - 老用户已有非 seed provider，跳过导入（正确）
    // - 用户手动点 ProviderEmptyState 的导入按钮时，与官方 seed 共存而不被阻塞
    if state.db.has_non_official_seed_provider(app_type.as_str())? {
        return Ok(false);
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
                read_gemini_env_text, GEMINI_RENDERED_ENV_TEXT_FIELD,
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
            let mut result = json!({
                "env": env_obj,
                "config": config_obj
            });

            let env_text = read_gemini_env_text()?;
            if !env_text.is_empty() {
                if let Some(obj) = result.as_object_mut() {
                    obj.insert(
                        GEMINI_RENDERED_ENV_TEXT_FIELD.to_string(),
                        Value::String(env_text),
                    );
                }
            }

            result
        }
        // OpenCode, OpenClaw and Hermes use additive mode and are handled by early return above
        AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
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
        env_text_matches_map, get_gemini_settings_path, json_to_env,
        validate_gemini_settings_strict, write_gemini_env_atomic, write_gemini_env_text_atomic,
        GEMINI_RENDERED_ENV_TEXT_FIELD,
    };

    // One-time auth type detection to avoid repeated detection
    let auth_type = detect_gemini_auth_type(provider);

    let env_map = json_to_env(&provider.settings_config)?;
    let rendered_env_text = provider
        .settings_config
        .get(GEMINI_RENDERED_ENV_TEXT_FIELD)
        .and_then(Value::as_str);
    let can_write_rendered_env_text = rendered_env_text
        .map(|content| env_text_matches_map(content, &env_map))
        .transpose()?
        .unwrap_or(false);

    // Prepare config to write to ~/.gemini/settings.json
    // Behavior:
    // - config is object: write it directly, keeping actual config deterministic
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
            // Google Official uses OAuth, no API key validation needed.
            // Write user's env vars as-is (e.g. GEMINI_MODEL, custom vars).
            if can_write_rendered_env_text {
                write_gemini_env_text_atomic(rendered_env_text.unwrap_or_default())?;
            } else {
                write_gemini_env_atomic(&env_map)?;
            }
        }
        GeminiAuthType::Packycode | GeminiAuthType::Generic => {
            // API Key mode -- require GEMINI_API_KEY
            validate_gemini_settings_strict(&provider.settings_config)?;
            if can_write_rendered_env_text {
                write_gemini_env_text_atomic(rendered_env_text.unwrap_or_default())?;
            } else {
                write_gemini_env_atomic(&env_map)?;
            }
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
    let existing_ids = state.db.get_provider_ids("opencode")?;

    for (id, config) in providers {
        // Skip if already exists in database
        if existing_ids.contains(&id) {
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
        let mut provider = Provider::with_id(
            id.clone(),
            config.name.clone().unwrap_or_else(|| id.clone()),
            settings_config,
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            live_config_managed: Some(true),
            ..Default::default()
        });

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
    let existing_ids = state.db.get_provider_ids("openclaw")?;

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
        if existing_ids.contains(&id) {
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
        let mut provider = Provider::with_id(id.clone(), display_name, settings_config, None);
        provider.meta = Some(crate::provider::ProviderMeta {
            live_config_managed: Some(true),
            ..Default::default()
        });

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

/// Import all providers from Hermes live config to database
///
/// This imports existing providers from ~/.hermes/config.yaml
/// into the CC Switch database. Each provider found will be added to the
/// database with is_current set to false.
pub fn import_hermes_providers_from_live(state: &AppState) -> Result<usize, AppError> {
    use crate::hermes_config;

    let providers = hermes_config::get_providers()?;
    if providers.is_empty() {
        return Ok(0);
    }

    let mut imported = 0;
    let existing_ids = state.db.get_provider_ids("hermes")?;

    for (name, config) in providers {
        // Validate: skip entries with empty name
        if name.trim().is_empty() {
            log::warn!("Skipping Hermes provider with empty name");
            continue;
        }

        // Skip if already exists in database
        if existing_ids.contains(&name) {
            log::debug!("Hermes provider '{name}' already exists in database, skipping");
            continue;
        }

        // Create provider
        let mut provider = Provider::with_id(name.clone(), name.clone(), config, None);
        provider.meta = Some(crate::provider::ProviderMeta {
            live_config_managed: Some(true),
            ..Default::default()
        });

        // Save to database
        if let Err(e) = state.db.save_provider("hermes", &provider) {
            log::warn!("Failed to import Hermes provider '{name}': {e}");
            continue;
        }

        imported += 1;
        log::info!("Imported Hermes provider '{name}' from live config");
    }

    Ok(imported)
}

/// Remove a Hermes provider from live config
///
/// This removes a specific provider from ~/.hermes/config.yaml
/// without affecting other providers in the file.
pub fn remove_hermes_provider_from_live(provider_id: &str) -> Result<(), AppError> {
    use crate::hermes_config;

    // Check if Hermes config directory exists
    if !hermes_config::get_hermes_dir().exists() {
        log::debug!("Hermes config directory doesn't exist, skipping removal of '{provider_id}'");
        return Ok(());
    }

    hermes_config::remove_provider(provider_id)?;
    log::info!("Hermes provider '{provider_id}' removed from live config");

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::{McpApps, McpServer};
    use crate::database::Database;
    use serde_json::json;
    use serial_test::serial;
    use std::env;
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
            match &self.original_home {
                Some(value) => env::set_var("HOME", value),
                None => env::remove_var("HOME"),
            }

            match &self.original_userprofile {
                Some(value) => env::set_var("USERPROFILE", value),
                None => env::remove_var("USERPROFILE"),
            }

            match &self.original_test_home {
                Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
                None => env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    #[test]
    fn claude_common_config_apply_and_remove_roundtrip_for_non_overlapping_fields() {
        let settings = json!({
            "env": {
                "ANTHROPIC_API_KEY": "sk-test"
            }
        });
        let snippet = r#"{
  "includeCoAuthoredBy": false,
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1"
  }
}"#;

        let applied =
            apply_common_config_to_settings(&AppType::Claude, &settings, snippet).unwrap();
        assert_eq!(applied["includeCoAuthoredBy"], json!(false));
        assert_eq!(applied["env"]["CLAUDE_CODE_USE_BEDROCK"], json!("1"));

        let stripped =
            remove_common_config_from_settings(&AppType::Claude, &applied, snippet).unwrap();
        assert_eq!(stripped, settings);
    }

    #[test]
    fn codex_common_config_apply_and_remove_roundtrip_for_non_overlapping_fields() {
        let settings = json!({
            "auth": {
                "OPENAI_API_KEY": "sk-test"
            },
            "config": "model_provider = \"openai\"\n[general]\nmodel = \"gpt-5\"\n"
        });
        let snippet = "[shared]\nreasoning = \"medium\"\n";

        let applied = apply_common_config_to_settings(&AppType::Codex, &settings, snippet).unwrap();
        let applied_config = applied["config"].as_str().unwrap_or_default();
        assert!(applied_config.contains("[shared]"));
        assert!(applied_config.contains("reasoning = \"medium\""));

        let stripped =
            remove_common_config_from_settings(&AppType::Codex, &applied, snippet).unwrap();
        assert_eq!(stripped, settings);
    }

    #[test]
    fn codex_common_config_apply_uses_managed_block_and_keeps_base_content_order() {
        let settings = json!({
            "auth": {},
            "config": "# user comment\nmodel_provider = \"openai\"\n[general]\nmodel = \"gpt-5\"\n"
        });
        let snippet = "[shared]\nreasoning = \"medium\"\n";

        let applied = apply_common_config_to_settings(&AppType::Codex, &settings, snippet).unwrap();
        let applied_config = applied["config"].as_str().unwrap_or_default();

        assert!(
            applied_config.contains(CODEX_COMMON_CONFIG_BLOCK_START),
            "managed block start marker should be inserted"
        );
        assert!(
            applied_config.contains(CODEX_COMMON_CONFIG_BLOCK_END),
            "managed block end marker should be inserted"
        );
        assert!(
            applied_config.contains("# user comment\nmodel_provider = \"openai\"\n[general]\nmodel = \"gpt-5\""),
            "existing user content should remain before managed block"
        );
        assert!(
            applied_config.contains("[shared]\nreasoning = \"medium\""),
            "snippet content should be inside managed block"
        );
    }

    #[test]
    fn codex_common_config_remove_strips_managed_block_only() {
        let settings = json!({
            "auth": {},
            "config": "model = \"gpt-5\"\n\n# >>> CC-SWITCH COMMON CONFIG START\n[shared]\nreasoning = \"medium\"\n# <<< CC-SWITCH COMMON CONFIG END\n"
        });
        let snippet = "[shared]\nreasoning = \"medium\"\n";

        let stripped =
            remove_common_config_from_settings(&AppType::Codex, &settings, snippet).unwrap();
        let stripped_config = stripped["config"].as_str().unwrap_or_default();

        assert_eq!(stripped_config, "model = \"gpt-5\"\n");
    }

    #[test]
    fn codex_common_config_apply_rewrites_legacy_structural_merge_into_managed_block() {
        let settings = json!({
            "auth": {},
            "config": "model = \"gpt-5\"\n[shared]\nreasoning = \"medium\"\n"
        });
        let snippet = "[shared]\nreasoning = \"medium\"\n";

        let applied = apply_common_config_to_settings(&AppType::Codex, &settings, snippet).unwrap();
        let applied_config = applied["config"].as_str().unwrap_or_default();

        let shared_count = applied_config.matches("[shared]").count();
        assert_eq!(
            shared_count, 1,
            "legacy merged snippet should be normalized to exactly one managed block copy"
        );
        assert!(applied_config.contains(CODEX_COMMON_CONFIG_BLOCK_START));
    }

    #[test]
    fn explicit_common_config_flag_overrides_legacy_subset_detection() {
        let mut provider = Provider::with_id(
            "claude-test".to_string(),
            "Claude Test".to_string(),
            json!({
                "includeCoAuthoredBy": false
            }),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            common_config_enabled: Some(false),
            ..Default::default()
        });

        assert!(
            !provider_uses_common_config(
                &AppType::Claude,
                &provider,
                Some(r#"{ "includeCoAuthoredBy": false }"#),
            ),
            "explicit false should win over legacy subset detection"
        );
    }

    #[test]
    fn claude_common_config_array_subset_detection_and_strip_preserve_extra_items() {
        let settings = json!({
            "allowedTools": ["tool1", "tool2"]
        });
        let snippet = r#"{
  "allowedTools": ["tool1"]
}"#;

        assert!(
            settings_contain_common_config(&AppType::Claude, &settings, snippet),
            "array subset should be detected for legacy providers"
        );

        let stripped =
            remove_common_config_from_settings(&AppType::Claude, &settings, snippet).unwrap();
        assert_eq!(
            stripped,
            json!({
                "allowedTools": ["tool2"]
            })
        );
    }

    #[test]
    fn codex_common_config_array_subset_detection_and_strip_preserve_extra_items() {
        let settings = json!({
            "auth": {},
            "config": "allowed_tools = [\"tool1\", \"tool2\"]\n"
        });
        let snippet = "allowed_tools = [\"tool1\"]\n";

        assert!(
            settings_contain_common_config(&AppType::Codex, &settings, snippet),
            "TOML array subset should be detected for legacy providers"
        );

        let stripped =
            remove_common_config_from_settings(&AppType::Codex, &settings, snippet).unwrap();
        assert_eq!(stripped["auth"], json!({}));
        let stripped_config = stripped["config"].as_str().unwrap_or_default();
        let parsed = stripped_config
            .parse::<DocumentMut>()
            .expect("stripped codex config should remain valid TOML");
        let allowed_tools = parsed["allowed_tools"]
            .as_array()
            .expect("allowed_tools should remain an array");
        let values: Vec<&str> = allowed_tools
            .iter()
            .map(|value| value.as_str().expect("tool id should be string"))
            .collect();
        assert_eq!(values, vec!["tool2"]);
    }

    #[test]
    fn opencode_common_config_apply_and_remove_roundtrip() {
        let settings = json!({
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": "https://api.example.com/v1",
                "apiKey": "sk-test"
            }
        });
        let snippet = r#"{
  "options": {
    "timeout": 30000
  },
  "models": {
    "gpt-4o": {
      "name": "GPT-4o"
    }
  }
}"#;

        let applied =
            apply_common_config_to_settings(&AppType::OpenCode, &settings, snippet).unwrap();
        assert_eq!(applied["options"]["timeout"], json!(30000));
        assert_eq!(applied["models"]["gpt-4o"]["name"], json!("GPT-4o"));

        let stripped =
            remove_common_config_from_settings(&AppType::OpenCode, &applied, snippet).unwrap();
        assert_eq!(stripped, settings);
    }

    #[test]
    fn openclaw_common_config_apply_and_remove_roundtrip() {
        let settings = json!({
            "baseUrl": "https://api.example.com/v1",
            "apiKey": "sk-test"
        });
        let snippet = r#"{
  "api": "openai-responses",
  "models": [
    { "id": "gpt-4.1" }
  ]
}"#;

        let applied =
            apply_common_config_to_settings(&AppType::OpenClaw, &settings, snippet).unwrap();
        assert_eq!(applied["api"], json!("openai-responses"));
        assert_eq!(applied["models"][0]["id"], json!("gpt-4.1"));

        let stripped =
            remove_common_config_from_settings(&AppType::OpenClaw, &applied, snippet).unwrap();
        assert_eq!(stripped, settings);
    }

    #[test]
    fn hermes_common_config_apply_and_remove_roundtrip() {
        let settings = json!({
            "base_url": "https://api.example.com/v1",
            "api_key": "sk-test"
        });
        let snippet = r#"{
  "models": [
    { "id": "anthropic/claude-sonnet-4" }
  ],
  "max_tokens": 16384
}"#;

        let applied =
            apply_common_config_to_settings(&AppType::Hermes, &settings, snippet).unwrap();
        assert_eq!(applied["models"][0]["id"], json!("anthropic/claude-sonnet-4"));
        assert_eq!(applied["max_tokens"], json!(16384));

        let stripped =
            remove_common_config_from_settings(&AppType::Hermes, &applied, snippet).unwrap();
        assert_eq!(stripped, settings);
    }

    #[test]
    fn codex_template_renders_enabled_mcp_servers() {
        let db = Database::memory().expect("create memory db");
        db.set_config_template(
            "codex",
            Some("{providerConfig}\n\n{mcpConfig}\n".to_string()),
        )
        .expect("set codex template");

        db.save_mcp_server(&McpServer {
            id: "server-a".to_string(),
            name: "Server A".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: McpApps {
                codex: true,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save mcp server");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk-test" },
                "config": "model = \"gpt-5\"\n"
            }),
            None,
        );

        let rendered = build_effective_settings_with_common_config(&db, &AppType::Codex, &provider)
            .expect("render effective settings");
        let rendered_config = rendered
            .get("config")
            .and_then(Value::as_str)
            .expect("config should be string");

        assert!(rendered_config.contains("model = \"gpt-5\""));
        assert!(rendered_config.contains("[mcp_servers.server-a]"));
        assert!(rendered_config.contains("command = \"npx\""));
    }

    #[test]
    fn codex_template_without_mcp_servers_keeps_provider_config_clean() {
        let db = Database::memory().expect("create memory db");
        db.set_config_template(
            "codex",
            Some("{providerConfig}\n\n{mcpConfig}\n".to_string()),
        )
        .expect("set codex template");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk-test" },
                "config": "model = \"gpt-5\"\n"
            }),
            None,
        );

        let rendered = build_effective_settings_with_common_config(&db, &AppType::Codex, &provider)
            .expect("render effective settings");
        let rendered_config = rendered
            .get("config")
            .and_then(Value::as_str)
            .expect("config should be string");

        assert!(rendered_config.contains("model = \"gpt-5\""));
        assert!(!rendered_config.contains("mcp_servers"));
    }

    #[test]
    fn invalid_codex_template_falls_back_to_original_provider_config() {
        let db = Database::memory().expect("create memory db");
        db.set_config_template("codex", Some("[broken".to_string()))
            .expect("set broken codex template");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk-test" },
                "config": "model = \"gpt-5\"\n"
            }),
            None,
        );

        let rendered = build_effective_settings_with_common_config(&db, &AppType::Codex, &provider)
            .expect("render effective settings");
        let rendered_config = rendered
            .get("config")
            .and_then(Value::as_str)
            .expect("config should be string");

        assert_eq!(rendered_config, "model = \"gpt-5\"\n");
    }

    #[test]
    fn codex_template_replaces_existing_mcp_servers_section_with_enabled_set() {
        let db = Database::memory().expect("create memory db");
        db.set_config_template(
            "codex",
            Some("{providerConfig}\n\n{mcpConfig}\n".to_string()),
        )
        .expect("set codex template");

        db.save_mcp_server(&McpServer {
            id: "new-server".to_string(),
            name: "New Server".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: McpApps {
                codex: true,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save mcp server");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk-test" },
                "config": "model = \"gpt-5\"\n[mcp_servers.legacy]\ncommand = \"legacy\"\n"
            }),
            None,
        );

        let rendered = build_effective_settings_with_common_config(&db, &AppType::Codex, &provider)
            .expect("render effective settings");
        let rendered_config = rendered
            .get("config")
            .and_then(Value::as_str)
            .expect("config should be string");

        assert!(!rendered_config.contains("[mcp_servers.legacy]"));
        assert!(rendered_config.contains("[mcp_servers.new-server]"));
    }

    #[test]
    fn gemini_template_renders_provider_settings_and_enabled_mcp_servers() {
        let db = Database::memory().expect("create memory db");
        db.set_config_template(
            "gemini",
            Some(
                "# .env\n# managed by cc-switch\n{providerConfig}\n\n# settings.json\n{\n  {settingsConfig}\n  \"mcpServers\": {mcpConfig}\n}\n"
                    .to_string(),
            ),
        )
        .expect("set gemini template");

        db.save_mcp_server(&McpServer {
            id: "gemini-memory".to_string(),
            name: "Gemini Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: McpApps {
                gemini: true,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save gemini mcp server");

        let provider = Provider::with_id(
            "gemini-a".to_string(),
            "Gemini A".to_string(),
            json!({
                "env": {
                    "GOOGLE_GEMINI_BASE_URL": "https://api.example.com",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                },
                "config": {
                    "general": {
                        "previewFeatures": true
                    },
                    "security": {
                        "auth": {
                            "selectedType": "oauth-personal"
                        }
                    },
                    "mcpServers": {
                        "legacy": {
                            "command": "legacy"
                        }
                    }
                }
            }),
            None,
        );

        let rendered =
            build_effective_settings_with_common_config(&db, &AppType::Gemini, &provider)
                .expect("render gemini effective settings");

        assert_eq!(
            rendered["env"]["GOOGLE_GEMINI_BASE_URL"],
            json!("https://api.example.com")
        );
        assert_eq!(rendered["env"]["GEMINI_MODEL"], json!("gemini-3.1-pro"));
        assert_eq!(
            rendered["config"]["general"]["previewFeatures"],
            json!(true)
        );
        assert_eq!(
            rendered["config"]["security"]["auth"]["selectedType"],
            json!("oauth-personal")
        );
        assert!(rendered["config"]["mcpServers"].get("legacy").is_none());
        assert_eq!(
            rendered["config"]["mcpServers"]["gemini-memory"]["command"],
            json!("npx")
        );
        assert_eq!(
            rendered[crate::gemini_config::GEMINI_RENDERED_ENV_TEXT_FIELD],
            json!(
                "# managed by cc-switch\nGEMINI_MODEL=gemini-3.1-pro\nGOOGLE_GEMINI_BASE_URL=https://api.example.com"
            )
        );
    }

    #[test]
    fn gemini_template_without_settings_placeholder_still_merges_provider_settings() {
        let db = Database::memory().expect("create memory db");
        db.set_config_template(
            "gemini",
            Some(
                "# .env\n{providerConfig}\n\n# settings.json\n{\n  \"general\": {\n    \"previewFeatures\": false\n  }\n}\n"
                    .to_string(),
            ),
        )
        .expect("set gemini template");

        let provider = Provider::with_id(
            "gemini-b".to_string(),
            "Gemini B".to_string(),
            json!({
                "env": {
                    "GEMINI_MODEL": "gemini-3.1-flash"
                },
                "config": {
                    "general": {
                        "previewFeatures": true,
                        "sessionRetention": {
                            "enabled": true
                        }
                    },
                    "security": {
                        "auth": {
                            "selectedType": "gemini-api-key"
                        }
                    }
                }
            }),
            None,
        );

        let rendered =
            build_effective_settings_with_common_config(&db, &AppType::Gemini, &provider)
                .expect("render gemini effective settings");

        assert_eq!(rendered["env"]["GEMINI_MODEL"], json!("gemini-3.1-flash"));
        assert_eq!(
            rendered["config"]["general"]["previewFeatures"],
            json!(true)
        );
        assert_eq!(
            rendered["config"]["general"]["sessionRetention"]["enabled"],
            json!(true)
        );
        assert_eq!(
            rendered["config"]["security"]["auth"]["selectedType"],
            json!("gemini-api-key")
        );
        assert!(
            rendered["config"].get("mcpServers").is_none(),
            "Gemini should not write an empty mcpServers object when no MCP server is enabled"
        );
    }

    #[test]
    #[serial]
    fn write_gemini_live_preserves_rendered_env_text_when_it_matches_env_map() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let provider = Provider::with_id(
            "gemini-live".to_string(),
            "Gemini Live".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "sk-test",
                    "GEMINI_MODEL": "gemini-2.5-pro"
                },
                "config": {},
                "__ccSwitchRenderedEnvText": "# managed by cc-switch\nGEMINI_API_KEY=sk-test\nGEMINI_MODEL=gemini-2.5-pro"
            }),
            None,
        );

        write_gemini_live(&provider).expect("write gemini live");

        let env_text = crate::gemini_config::read_gemini_env_text().expect("read gemini env");
        assert_eq!(
            env_text,
            "# managed by cc-switch\nGEMINI_API_KEY=sk-test\nGEMINI_MODEL=gemini-2.5-pro"
        );
    }

    #[test]
    #[serial]
    fn write_gemini_live_falls_back_when_rendered_env_text_is_stale() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let provider = Provider::with_id(
            "gemini-live-stale".to_string(),
            "Gemini Live Stale".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "sk-new",
                    "GEMINI_MODEL": "gemini-2.5-flash"
                },
                "config": {},
                "__ccSwitchRenderedEnvText": "# stale\nGEMINI_API_KEY=sk-old\nGEMINI_MODEL=gemini-2.5-flash"
            }),
            None,
        );

        write_gemini_live(&provider).expect("write gemini live");

        let env_text = crate::gemini_config::read_gemini_env_text().expect("read gemini env");
        assert!(env_text.contains("GEMINI_API_KEY=sk-new"));
        assert!(!env_text.contains("# stale"));
    }
}
