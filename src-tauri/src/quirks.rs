//! Per-provider 特殊配置（quirks）的应用工具。
//!
//! `quirks` 在两条链路上生效：
//!
//! 1. **直连写盘**（`services/provider/live.rs`）：在把 `settings_config` 写入
//!    本机 CLI 配置文件之前，按 `strip_paths` 删除指定字段。
//! 2. **代理转发**（`proxy/forwarder.rs`）：在请求发出之前，按
//!    `force_model` → `request_body_patches` → `strip_paths(body:)` →
//!    `strip_request_headers` 的顺序应用规则。
//!
//! `strip_paths` 用 `前缀:路径` 语法消歧义：
//! - `env:KEY` —— `settings_config.env.KEY`
//! - `config.toml:section.key` —— Codex `config.toml`（TOML 路径，`.` 分段）
//! - `auth:key` —— Codex `auth.json` 的字段
//! - `body:/json/pointer` —— 转发请求体的 JSON Pointer

use serde_json::Value;
use toml_edit::DocumentMut;

use crate::provider::{JsonPatchOp, ProviderQuirks};

/// `strip_paths` 中合法的前缀。其它前缀按未识别处理（写日志后跳过）。
pub const STRIP_PREFIX_ENV: &str = "env:";
pub const STRIP_PREFIX_AUTH: &str = "auth:";
pub const STRIP_PREFIX_CONFIG_TOML: &str = "config.toml:";
pub const STRIP_PREFIX_BODY: &str = "body:";

/// 写盘前对 `settings_config` 应用 quirks。
///
/// 对应 strip 前缀：
/// - `env:KEY` 删除 `settings_config.env.KEY` 或 `settings_config.config.env.KEY`（兼容 Gemini 嵌套）
/// - `auth:key` 删除 `settings_config.auth.key`（Codex）
/// - `config.toml:path.to.key` 解析 `settings_config.config` 字符串为 TOML，删除路径后回写
///
/// `body:` 前缀在写盘阶段会被忽略（仅转发阶段生效）。
pub fn apply_strip_paths_to_settings(settings: &mut Value, quirks: &ProviderQuirks) {
    let Some(paths) = quirks.strip_paths.as_ref() else {
        return;
    };

    for raw in paths {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }

        if let Some(key) = raw.strip_prefix(STRIP_PREFIX_ENV) {
            strip_env_key(settings, key.trim());
        } else if let Some(key) = raw.strip_prefix(STRIP_PREFIX_AUTH) {
            strip_object_field(settings, "auth", key.trim());
        } else if let Some(path) = raw.strip_prefix(STRIP_PREFIX_CONFIG_TOML) {
            strip_codex_config_toml_path(settings, path.trim());
        } else if raw.starts_with(STRIP_PREFIX_BODY) {
            // body: 前缀在写盘阶段不处理。
            continue;
        } else {
            log::warn!("[quirks] 未识别的 strip_paths 前缀: {raw}");
        }
    }
}

/// 转发请求前对请求体应用 quirks。返回是否对 body 做过修改（暂未使用）。
pub fn apply_request_quirks(body: &mut Value, headers: &mut http::HeaderMap, quirks: &ProviderQuirks) {
    if let Some(model) = quirks.force_model.as_deref() {
        let model = model.trim();
        if !model.is_empty() {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("model".to_string(), Value::String(model.to_string()));
            }
        }
    }

    if let Some(patches) = quirks.request_body_patches.as_ref() {
        for patch in patches {
            if let Err(err) = apply_json_patch(body, patch) {
                log::warn!("[quirks] JSON patch 应用失败: {err}");
                break;
            }
        }
    }

    if let Some(paths) = quirks.strip_paths.as_ref() {
        for raw in paths {
            let raw = raw.trim();
            if let Some(pointer) = raw.strip_prefix(STRIP_PREFIX_BODY) {
                let pointer = pointer.trim();
                if !pointer.is_empty() {
                    remove_by_pointer(body, pointer);
                }
            }
        }
    }

    if let Some(names) = quirks.strip_request_headers.as_ref() {
        for name in names {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(header_name) = http::HeaderName::from_bytes(trimmed.to_lowercase().as_bytes())
            {
                headers.remove(&header_name);
            }
        }
    }
}

fn strip_env_key(settings: &mut Value, key: &str) {
    if key.is_empty() {
        return;
    }
    if let Some(obj) = settings.as_object_mut() {
        if let Some(env) = obj.get_mut("env").and_then(Value::as_object_mut) {
            env.remove(key);
        }
        // Gemini: `config` 节点下也可能藏 env-like 设置（很罕见，但顺带处理）。
        if let Some(cfg) = obj.get_mut("config").and_then(Value::as_object_mut) {
            if let Some(env) = cfg.get_mut("env").and_then(Value::as_object_mut) {
                env.remove(key);
            }
        }
    }
}

fn strip_object_field(settings: &mut Value, top_field: &str, key: &str) {
    if key.is_empty() {
        return;
    }
    if let Some(obj) = settings.as_object_mut() {
        if let Some(target) = obj.get_mut(top_field).and_then(Value::as_object_mut) {
            target.remove(key);
        }
    }
}

fn strip_codex_config_toml_path(settings: &mut Value, path: &str) {
    if path.is_empty() {
        return;
    }

    let Some(obj) = settings.as_object_mut() else {
        return;
    };
    let Some(config_str) = obj.get("config").and_then(Value::as_str) else {
        return;
    };
    if config_str.trim().is_empty() {
        return;
    }

    let mut doc = match config_str.parse::<DocumentMut>() {
        Ok(doc) => doc,
        Err(err) => {
            log::warn!("[quirks] Codex config.toml 解析失败，跳过 strip {path}: {err}");
            return;
        }
    };

    let segments: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return;
    }

    let removed = remove_toml_path(doc.as_table_mut(), &segments);
    if removed {
        obj.insert(
            "config".to_string(),
            Value::String(doc.to_string().trim_end_matches('\n').to_string() + "\n"),
        );
    }
}

fn remove_toml_path(table: &mut toml_edit::Table, segments: &[&str]) -> bool {
    if segments.is_empty() {
        return false;
    }
    let (head, rest) = segments.split_first().expect("segments not empty");

    if rest.is_empty() {
        return table.remove(*head).is_some();
    }

    if let Some(item) = table.get_mut(*head) {
        if let Some(child) = item.as_table_mut() {
            return remove_toml_path(child, rest);
        }
        if let Some(inline) = item.as_inline_table_mut() {
            // Walk inline table by collecting/replacing — simplest: convert via path traversal.
            let _ = inline; // 暂不支持 inline 表的深层删除（罕见，且 Codex 主用 standard table）
        }
    }
    false
}

fn remove_by_pointer(body: &mut Value, pointer: &str) {
    let pointer = if pointer.starts_with('/') {
        pointer.to_string()
    } else {
        format!("/{pointer}")
    };

    let Some((parent_path, last)) = pointer.rsplit_once('/') else {
        return;
    };
    let parent = if parent_path.is_empty() {
        Some(body)
    } else {
        body.pointer_mut(parent_path)
    };

    if let Some(parent) = parent {
        if let Some(obj) = parent.as_object_mut() {
            obj.remove(last);
        } else if let Some(arr) = parent.as_array_mut() {
            if let Ok(idx) = last.parse::<usize>() {
                if idx < arr.len() {
                    arr.remove(idx);
                }
            }
        }
    }
}

fn apply_json_patch(body: &mut Value, patch: &JsonPatchOp) -> Result<(), String> {
    match patch {
        JsonPatchOp::Add { path, value } | JsonPatchOp::Replace { path, value } => {
            set_by_pointer(body, path, value.clone())
        }
        JsonPatchOp::Remove { path } => {
            remove_by_pointer(body, path);
            Ok(())
        }
    }
}

fn set_by_pointer(body: &mut Value, pointer: &str, value: Value) -> Result<(), String> {
    let pointer = if pointer.starts_with('/') {
        pointer.to_string()
    } else {
        format!("/{pointer}")
    };

    let Some((parent_path, last)) = pointer.rsplit_once('/') else {
        return Err(format!("invalid JSON pointer: {pointer}"));
    };
    let parent = if parent_path.is_empty() {
        Some(body)
    } else {
        body.pointer_mut(parent_path)
    };

    let parent = parent.ok_or_else(|| format!("JSON pointer parent not found: {parent_path}"))?;

    if let Some(obj) = parent.as_object_mut() {
        obj.insert(last.to_string(), value);
        Ok(())
    } else if let Some(arr) = parent.as_array_mut() {
        if last == "-" {
            arr.push(value);
            Ok(())
        } else {
            let idx: usize = last
                .parse()
                .map_err(|_| format!("invalid array index in pointer: {last}"))?;
            if idx > arr.len() {
                return Err(format!("array index out of range: {idx}"));
            }
            if idx == arr.len() {
                arr.push(value);
            } else {
                arr[idx] = value;
            }
            Ok(())
        }
    } else {
        Err(format!(
            "JSON pointer parent is not an object/array: {parent_path}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_env_removes_claude_env_key() {
        let mut s = json!({"env": {"ANTHROPIC_API_KEY": "x", "ANTHROPIC_MODEL": "y"}});
        let q = ProviderQuirks {
            strip_paths: Some(vec!["env:ANTHROPIC_MODEL".to_string()]),
            ..Default::default()
        };
        apply_strip_paths_to_settings(&mut s, &q);
        assert_eq!(s["env"]["ANTHROPIC_API_KEY"], json!("x"));
        assert!(s["env"].get("ANTHROPIC_MODEL").is_none());
    }

    #[test]
    fn strip_codex_features_removes_section() {
        let mut s = json!({
            "auth": {"OPENAI_API_KEY": "k"},
            "config": "model = \"gpt-5\"\n[features]\nweb_search = true\n"
        });
        let q = ProviderQuirks {
            strip_paths: Some(vec!["config.toml:features".to_string()]),
            ..Default::default()
        };
        apply_strip_paths_to_settings(&mut s, &q);
        let cfg = s["config"].as_str().expect("config string");
        assert!(cfg.contains("model = \"gpt-5\""));
        assert!(!cfg.contains("[features]"));
        assert!(!cfg.contains("web_search"));
    }

    #[test]
    fn force_model_overwrites_request_body() {
        let mut body = json!({"model": "claude-sonnet-4-5", "stream": true});
        let mut headers = http::HeaderMap::new();
        let q = ProviderQuirks {
            force_model: Some("glm-5.1".to_string()),
            ..Default::default()
        };
        apply_request_quirks(&mut body, &mut headers, &q);
        assert_eq!(body["model"], json!("glm-5.1"));
    }

    #[test]
    fn strip_request_headers_removes_named_headers() {
        let mut body = json!({});
        let mut headers = http::HeaderMap::new();
        headers.insert("X-Test", http::HeaderValue::from_static("1"));
        headers.insert("X-Keep", http::HeaderValue::from_static("ok"));
        let q = ProviderQuirks {
            strip_request_headers: Some(vec!["X-Test".to_string()]),
            ..Default::default()
        };
        apply_request_quirks(&mut body, &mut headers, &q);
        assert!(headers.get("x-test").is_none());
        assert!(headers.get("x-keep").is_some());
    }

    #[test]
    fn body_strip_removes_pointer_field() {
        let mut body = json!({"foo": {"bar": 1, "baz": 2}});
        let mut headers = http::HeaderMap::new();
        let q = ProviderQuirks {
            strip_paths: Some(vec!["body:/foo/bar".to_string()]),
            ..Default::default()
        };
        apply_request_quirks(&mut body, &mut headers, &q);
        assert!(body["foo"].get("bar").is_none());
        assert_eq!(body["foo"]["baz"], json!(2));
    }

    #[test]
    fn json_patch_replace_then_remove_then_add() {
        let mut body = json!({"a": 1, "b": 2});
        let mut headers = http::HeaderMap::new();
        let q = ProviderQuirks {
            request_body_patches: Some(vec![
                JsonPatchOp::Replace {
                    path: "/a".to_string(),
                    value: json!(99),
                },
                JsonPatchOp::Remove {
                    path: "/b".to_string(),
                },
                JsonPatchOp::Add {
                    path: "/c".to_string(),
                    value: json!("new"),
                },
            ]),
            ..Default::default()
        };
        apply_request_quirks(&mut body, &mut headers, &q);
        assert_eq!(body["a"], json!(99));
        assert!(body.get("b").is_none());
        assert_eq!(body["c"], json!("new"));
    }
}
