// unused imports removed
use std::path::PathBuf;

use crate::config::{
    atomic_write, delete_file, get_home_dir, sanitize_provider_name, write_json_file,
    write_text_file,
};
use crate::error::AppError;
use serde_json::Value;
use std::fs;
use std::path::Path;

const CODEX_PROVIDER_CONFIG_PLACEHOLDER: &str = "{{provider.config}}";
const CODEX_MCP_CONFIG_PLACEHOLDER: &str = "{{mcp.config}}";

/// 获取 Codex 配置目录路径
pub fn get_codex_config_dir() -> PathBuf {
    if let Some(custom) = crate::settings::get_codex_override_dir() {
        return custom;
    }

    get_home_dir().join(".codex")
}

/// 获取 Codex auth.json 路径
pub fn get_codex_auth_path() -> PathBuf {
    get_codex_config_dir().join("auth.json")
}

/// 获取 Codex config.toml 路径
pub fn get_codex_config_path() -> PathBuf {
    get_codex_config_dir().join("config.toml")
}

/// 获取 Codex 供应商配置文件路径
#[allow(dead_code)]
pub fn get_codex_provider_paths(
    provider_id: &str,
    provider_name: Option<&str>,
) -> (PathBuf, PathBuf) {
    let base_name = provider_name
        .map(sanitize_provider_name)
        .unwrap_or_else(|| sanitize_provider_name(provider_id));

    let auth_path = get_codex_config_dir().join(format!("auth-{base_name}.json"));
    let config_path = get_codex_config_dir().join(format!("config-{base_name}.toml"));

    (auth_path, config_path)
}

/// 删除 Codex 供应商配置文件
#[allow(dead_code)]
pub fn delete_codex_provider_config(
    provider_id: &str,
    provider_name: &str,
) -> Result<(), AppError> {
    let (auth_path, config_path) = get_codex_provider_paths(provider_id, Some(provider_name));

    delete_file(&auth_path).ok();
    delete_file(&config_path).ok();

    Ok(())
}

fn write_codex_live_atomic_with_options(
    auth: &Value,
    config_text_opt: Option<&str>,
    validate_toml: bool,
    preserve_existing_mcp: bool,
) -> Result<(), AppError> {
    let auth_path = get_codex_auth_path();
    let config_path = get_codex_config_path();

    if let Some(parent) = auth_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }

    // 读取旧内容用于回滚
    let old_auth = if auth_path.exists() {
        Some(fs::read(&auth_path).map_err(|e| AppError::io(&auth_path, e))?)
    } else {
        None
    };
    let old_config = if config_path.exists() {
        Some(fs::read(&config_path).map_err(|e| AppError::io(&config_path, e))?)
    } else {
        None
    };

    // 准备写入内容
    let cfg_text = match config_text_opt {
        Some(s) => s.to_string(),
        None => String::new(),
    };
    if validate_toml && !cfg_text.trim().is_empty() {
        toml::from_str::<toml::Table>(&cfg_text).map_err(|e| AppError::toml(&config_path, e))?;
    }

    // Preserve existing MCP servers if the incoming config doesn't include them.
    let cfg_text = if preserve_existing_mcp {
        if let Some(bytes) = old_config.as_ref() {
            match String::from_utf8(bytes.clone()) {
                Ok(existing_text) => {
                    merge_mcp_servers_from_existing(&cfg_text, &existing_text).unwrap_or(cfg_text)
                }
                Err(_) => cfg_text,
            }
        } else {
            cfg_text
        }
    } else {
        cfg_text
    };

    // 第一步：写 auth.json
    write_json_file(&auth_path, auth)?;

    // 第二步：写 config.toml（失败则回滚 auth.json）
    if let Err(e) = write_text_file(&config_path, &cfg_text) {
        // 回滚 auth.json
        if let Some(bytes) = old_auth {
            let _ = atomic_write(&auth_path, &bytes);
        } else {
            let _ = delete_file(&auth_path);
        }
        return Err(e);
    }

    Ok(())
}

/// 原子写 Codex 的 `auth.json` 与 `config.toml`，在第二步失败时回滚第一步
pub fn write_codex_live_atomic(
    auth: &Value,
    config_text_opt: Option<&str>,
) -> Result<(), AppError> {
    write_codex_live_atomic_with_options(auth, config_text_opt, true, true)
}

/// 精确写回 Codex 的 `auth.json` 与 `config.toml`。
///
/// 用于代理接管/恢复等“完整快照”场景：
/// - 不做 TOML 语法校验，允许按备份原样恢复
/// - 不自动合并当前 live 中的 MCP，避免把接管态内容再次掺入恢复结果
pub fn write_codex_live_exact_atomic(
    auth: &Value,
    config_text_opt: Option<&str>,
) -> Result<(), AppError> {
    write_codex_live_atomic_with_options(auth, config_text_opt, false, false)
}

pub(crate) fn merge_mcp_servers_from_existing(
    new_text: &str,
    existing_text: &str,
) -> Option<String> {
    use toml_edit::{DocumentMut, Item};

    let mut new_doc = if new_text.trim().is_empty() {
        DocumentMut::default()
    } else {
        new_text.parse::<DocumentMut>().ok()?
    };

    // If new config already defines MCP servers (correct or legacy), keep as-is.
    let has_mcp_servers = new_doc.get("mcp_servers").is_some()
        || new_doc
            .get("mcp")
            .and_then(|item| item.as_table_like())
            .and_then(|tbl| tbl.get("servers"))
            .is_some();
    if has_mcp_servers {
        return Some(new_doc.to_string());
    }

    let existing_doc = existing_text.parse::<DocumentMut>().ok()?;

    if let Some(item) = existing_doc.get("mcp_servers") {
        new_doc["mcp_servers"] = item.clone();
        return Some(new_doc.to_string());
    }

    if let Some(mcp_item) = existing_doc.get("mcp") {
        if let Some(mcp_tbl) = mcp_item.as_table_like() {
            if let Some(servers_item) = mcp_tbl.get("servers") {
                if let Item::Table(_) = servers_item {
                    new_doc["mcp_servers"] = servers_item.clone();
                    return Some(new_doc.to_string());
                }
            }
        }
    }

    Some(new_doc.to_string())
}

/// Read ~/.codex/config.toml; returns empty string if missing.
pub fn read_codex_config_text() -> Result<String, AppError> {
    let path = get_codex_config_path();
    if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))
    } else {
        Ok(String::new())
    }
}

/// 对非空的 TOML 文本进行语法校验
pub fn validate_config_toml(text: &str) -> Result<(), AppError> {
    if text.trim().is_empty() {
        return Ok(());
    }
    toml::from_str::<toml::Table>(text)
        .map(|_| ())
        .map_err(|e| AppError::toml(Path::new("config.toml"), e))
}

/// 校验 Codex 通用配置模板。
///
/// 规则：
/// - 必须且只能包含一个 `{{provider.config}}`
/// - `{{mcp.config}}` 最多一个
/// - 不能直接定义 `mcp_servers`
/// - 用占位桩替换后必须仍是合法 TOML
pub fn validate_codex_common_config_template(text: &str) -> Result<(), AppError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let provider_count = trimmed.matches(CODEX_PROVIDER_CONFIG_PLACEHOLDER).count();
    if provider_count != 1 {
        return Err(AppError::Message(
            "Codex 通用配置必须且只能包含一个 {{provider.config}} 占位符".to_string(),
        ));
    }

    let mcp_count = trimmed.matches(CODEX_MCP_CONFIG_PLACEHOLDER).count();
    if mcp_count > 1 {
        return Err(AppError::Message(
            "Codex 通用配置最多只能包含一个 {{mcp.config}} 占位符".to_string(),
        ));
    }

    let normalized = trimmed.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.contains("[mcp_servers") || normalized.contains("mcp_servers =") {
        return Err(AppError::Message(
            "Codex 通用配置不能直接包含 mcp_servers，请使用 {{mcp.config}} 占位符".to_string(),
        ));
    }

    let provider_stub = r#"model_provider = "custom"
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://example.com""#;
    let mcp_stub = r#"[mcp_servers.example]
type = "stdio"
command = "echo""#;

    let validation_source = normalized
        .replace(CODEX_PROVIDER_CONFIG_PLACEHOLDER, provider_stub)
        .replace(CODEX_MCP_CONFIG_PLACEHOLDER, mcp_stub);

    toml::from_str::<toml::Table>(&validation_source)
        .map(|_| ())
        .map_err(|e| AppError::toml(Path::new("common_config_codex.toml"), e))
}

/// 读取并校验 `~/.codex/config.toml`，返回文本（可能为空）
pub fn read_and_validate_codex_config_text() -> Result<String, AppError> {
    let s = read_codex_config_text()?;
    validate_config_toml(&s)?;
    Ok(s)
}
