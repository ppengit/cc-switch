//! 模型映射模块
//!
//! 在请求转发前，根据 Provider 配置替换请求中的模型名称

use crate::claude_desktop_config::ONE_M_CONTEXT_MARKER;
use crate::provider::Provider;
use serde_json::Value;

enum CodexCatalogModelResolution {
    Listed,
    Alias(String),
}

/// 模型映射配置
pub struct ModelMapping {
    pub haiku_model: Option<String>,
    pub sonnet_model: Option<String>,
    pub opus_model: Option<String>,
    pub fable_model: Option<String>,
    pub subagent_model: Option<String>,
    pub default_model: Option<String>,
}

impl ModelMapping {
    /// 从 Provider 配置中提取模型映射
    pub fn from_provider(provider: &Provider) -> Self {
        let env = provider.settings_config.get("env");

        Self {
            haiku_model: env
                .and_then(|e| e.get("ANTHROPIC_DEFAULT_HAIKU_MODEL"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            sonnet_model: env
                .and_then(|e| e.get("ANTHROPIC_DEFAULT_SONNET_MODEL"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            opus_model: env
                .and_then(|e| e.get("ANTHROPIC_DEFAULT_OPUS_MODEL"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            fable_model: env
                .and_then(|e| e.get("ANTHROPIC_DEFAULT_FABLE_MODEL"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            subagent_model: env
                .and_then(|e| e.get("CLAUDE_CODE_SUBAGENT_MODEL"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            default_model: env
                .and_then(|e| e.get("ANTHROPIC_MODEL"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
        }
    }

    /// 检查是否配置了任何模型映射
    pub fn has_mapping(&self) -> bool {
        self.haiku_model.is_some()
            || self.sonnet_model.is_some()
            || self.opus_model.is_some()
            || self.fable_model.is_some()
            || self.subagent_model.is_some()
            || self.default_model.is_some()
    }

    /// 根据原始模型名称获取映射后的模型
    pub fn map_model(&self, original_model: &str) -> String {
        let model_lower = original_model.to_lowercase();

        // 1. 按模型类型匹配
        if model_lower.contains("fable") {
            if let Some(ref m) = self.fable_model {
                return m.clone();
            }
            // 未单独配置 fable 档时归入 opus 档，与 Claude Code 官方
            // 分类器降级方向一致（fable→opus），避免落到 default 失去层级。
            if let Some(ref m) = self.opus_model {
                return m.clone();
            }
        }
        if model_lower.contains("haiku") {
            if let Some(ref m) = self.haiku_model {
                return m.clone();
            }
        }
        if model_lower.contains("opus") {
            if let Some(ref m) = self.opus_model {
                return m.clone();
            }
        }
        if model_lower.contains("sonnet") {
            if let Some(ref m) = self.sonnet_model {
                return m.clone();
            }
        }

        if let Some(ref m) = self.subagent_model {
            if strip_one_m_suffix_for_upstream(original_model) == strip_one_m_suffix_for_upstream(m)
            {
                return original_model.to_string();
            }
        }

        // 2. 默认模型
        if let Some(ref m) = self.default_model {
            return m.clone();
        }

        // 3. 无映射，保持原样
        original_model.to_string()
    }
}

/// 对请求体应用模型映射
///
/// 返回 (映射后的请求体, 原始模型名, 映射后模型名)
pub fn apply_model_mapping(
    mut body: Value,
    provider: &Provider,
) -> (Value, Option<String>, Option<String>) {
    let mapping = ModelMapping::from_provider(provider);

    // 如果没有配置映射，直接返回
    if !mapping.has_mapping() {
        let original = body.get("model").and_then(|m| m.as_str()).map(String::from);
        return (body, original, None);
    }

    // 提取原始模型名
    let original_model = body.get("model").and_then(|m| m.as_str()).map(String::from);

    if let Some(ref original) = original_model {
        let mapped = mapping.map_model(original);

        if mapped != *original {
            log::debug!("[ModelMapper] 模型映射: {original} → {mapped}");
            body["model"] = serde_json::json!(mapped);
            return (body, Some(original.clone()), Some(mapped));
        }
    }

    (body, original_model, None)
}

/// 对 Codex 请求体应用请求级模型映射。
///
/// `meta.codexModelRoutes` 使用精确模型名匹配，且只在
/// `codexModelRoutesEnabled` 未显式关闭时生效。未命中显式 Codex
/// 映射时保持客户端请求模型，避免退回旧的 `ANTHROPIC_MODEL` 默认值
/// 把 Codex CLI 选择的模型误改成供应商默认模型。
pub fn apply_codex_model_mapping(
    mut body: Value,
    provider: &Provider,
) -> (Value, Option<String>, Option<String>) {
    let original_model = body.get("model").and_then(|m| m.as_str()).map(String::from);
    let Some(original) = original_model.as_deref() else {
        return (body, None, None);
    };

    let routes_enabled = codex_model_routes_enabled(provider);
    let local_routing_enabled = codex_local_routing_enabled(provider);

    if routes_enabled {
        if let Some(route) = find_codex_model_route(provider, original) {
            let mapped = route.model.trim();
            if mapped.is_empty() {
                return (body, Some(original.to_string()), None);
            }
            if mapped != original.trim() {
                log::debug!("[ModelMapper] Codex 模型映射: {original} → {mapped}");
                body["model"] = serde_json::json!(mapped);
            }

            let final_model = body
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or(original)
                .to_string();
            if final_model != original {
                return (body, Some(original.to_string()), Some(final_model));
            }
            return (body, Some(original.to_string()), None);
        }
    }

    let catalog_resolution = if local_routing_enabled {
        resolve_codex_catalog_model(provider, original)
    } else {
        None
    };
    let mut route_input = original.to_string();

    if let Some(CodexCatalogModelResolution::Alias(catalog_model)) = catalog_resolution.as_ref() {
        log::debug!("[ModelMapper] Codex 目录模型解析: {original} → {catalog_model}");
        body["model"] = serde_json::json!(catalog_model);
        route_input = catalog_model.clone();
    }

    if routes_enabled {
        if let Some(route) = find_codex_model_route(provider, &route_input) {
            let mapped = route.model.trim();
            if mapped.is_empty() {
                return (body, Some(original.to_string()), None);
            }
            if mapped != route_input {
                log::debug!("[ModelMapper] Codex 模型映射: {route_input} → {mapped}");
                body["model"] = serde_json::json!(mapped);
            }

            let final_model = body
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or(original)
                .to_string();
            if final_model != original {
                return (body, Some(original.to_string()), Some(final_model));
            }
            return (body, Some(original.to_string()), None);
        }
    }

    match catalog_resolution {
        Some(CodexCatalogModelResolution::Alias(_)) => {
            let final_model = body
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or(original)
                .to_string();
            return (body, Some(original.to_string()), Some(final_model));
        }
        Some(CodexCatalogModelResolution::Listed) => {
            return (body, Some(original.to_string()), None);
        }
        None => {}
    }

    (body, Some(original.to_string()), None)
}

fn codex_model_routes_enabled(provider: &Provider) -> bool {
    provider
        .meta
        .as_ref()
        .map(|meta| {
            meta.codex_model_routes_enabled
                .unwrap_or(!meta.codex_model_routes.is_empty())
        })
        .unwrap_or(false)
}

fn codex_local_routing_enabled(provider: &Provider) -> bool {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.codex_local_routing_enabled)
        .unwrap_or_else(|| codex_catalog_count(provider) > 0)
}

fn codex_catalog_count(provider: &Provider) -> usize {
    provider
        .settings_config
        .get("modelCatalog")
        .and_then(|catalog| catalog.get("models"))
        .and_then(|models| models.as_array())
        .map(|models| models.len())
        .unwrap_or(0)
}

fn find_codex_model_route<'a>(
    provider: &'a Provider,
    model: &str,
) -> Option<&'a crate::provider::CodexModelRoute> {
    let lookup = model.trim();
    provider.meta.as_ref().and_then(|meta| {
        meta.codex_model_routes.get(model).or_else(|| {
            meta.codex_model_routes.get(lookup).or_else(|| {
                meta.codex_model_routes
                    .iter()
                    .find(|(key, _)| key.trim().eq_ignore_ascii_case(lookup))
                    .map(|(_, route)| route)
            })
        })
    })
}

fn resolve_codex_catalog_model(
    provider: &Provider,
    request_model: &str,
) -> Option<CodexCatalogModelResolution> {
    let request_model = request_model.trim();
    if request_model.is_empty() {
        return None;
    }

    provider
        .settings_config
        .get("modelCatalog")
        .and_then(|catalog| catalog.get("models"))
        .and_then(|models| models.as_array())
        .and_then(|models| {
            for model_config in models {
                let Some(model) = model_config
                    .get("model")
                    .or_else(|| model_config.get("id"))
                    .or_else(|| model_config.get("slug"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                else {
                    continue;
                };

                if model.eq_ignore_ascii_case(request_model) {
                    return Some(CodexCatalogModelResolution::Listed);
                }

                let display_name = model_config
                    .get("displayName")
                    .or_else(|| model_config.get("display_name"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|name| !name.is_empty());
                if display_name.is_some_and(|name| name.eq_ignore_ascii_case(request_model)) {
                    return Some(CodexCatalogModelResolution::Alias(model.to_string()));
                }
            }

            None
        })
}

/// Claude Code 通过 `[1M]` 后缀声明 100 万上下文能力；上游 API
/// 通常不接受这个本地能力标记，转发前需要剥离。
pub fn strip_one_m_suffix_for_upstream(model: &str) -> &str {
    let trimmed = model.trim_end();
    let marker = ONE_M_CONTEXT_MARKER.as_bytes();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= marker.len()
        && bytes[bytes.len() - marker.len()..].eq_ignore_ascii_case(marker)
    {
        return trimmed[..trimmed.len() - marker.len()].trim_end();
    }
    model
}

pub fn strip_one_m_suffix_for_upstream_from_body(mut body: Value) -> Value {
    let Some(model) = body.get("model").and_then(Value::as_str) else {
        return body;
    };

    let stripped = strip_one_m_suffix_for_upstream(model);
    if stripped != model {
        log::debug!("[ModelMapper] 去除本地 1M 标记: {model} → {stripped}");
        body["model"] = serde_json::json!(stripped);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_provider_with_mapping() -> Provider {
        Provider {
            id: "test".to_string(),
            name: "Test".to_string(),
            settings_config: json!({
                "env": {
                    "ANTHROPIC_MODEL": "default-model",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku-mapped",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet-mapped",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-mapped",
                    "ANTHROPIC_DEFAULT_FABLE_MODEL": "fable-mapped"
                }
            }),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }
    }

    fn create_provider_without_mapping() -> Provider {
        Provider {
            id: "test".to_string(),
            name: "Test".to_string(),
            settings_config: json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }
    }

    #[test]
    fn test_sonnet_mapping() {
        let provider = create_provider_with_mapping();
        let body = json!({"model": "claude-sonnet-4-5-20250929"});
        let (result, original, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "sonnet-mapped");
        assert_eq!(original, Some("claude-sonnet-4-5-20250929".to_string()));
        assert_eq!(mapped, Some("sonnet-mapped".to_string()));
    }

    #[test]
    fn test_haiku_mapping() {
        let provider = create_provider_with_mapping();
        let body = json!({"model": "claude-haiku-4-5"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "haiku-mapped");
        assert_eq!(mapped, Some("haiku-mapped".to_string()));
    }

    #[test]
    fn test_opus_mapping() {
        let provider = create_provider_with_mapping();
        let body = json!({"model": "claude-opus-4-5"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "opus-mapped");
        assert_eq!(mapped, Some("opus-mapped".to_string()));
    }

    #[test]
    fn test_fable_mapping() {
        let provider = create_provider_with_mapping();
        let body = json!({"model": "claude-fable-5"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "fable-mapped");
        assert_eq!(mapped, Some("fable-mapped".to_string()));
    }

    #[test]
    fn test_fable_with_one_m_suffix_mapping() {
        // Claude Code 实际会发 claude-fable-5[1m] 形态（issue #3980）
        let provider = create_provider_with_mapping();
        let body = json!({"model": "claude-fable-5[1m]"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "fable-mapped");
        assert_eq!(mapped, Some("fable-mapped".to_string()));
    }

    #[test]
    fn test_fable_falls_back_to_opus_when_unset() {
        let mut provider = create_provider_with_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_MODEL": "default-model",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-mapped"
            }
        });
        let body = json!({"model": "claude-fable-5"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "opus-mapped");
        assert_eq!(mapped, Some("opus-mapped".to_string()));
    }

    #[test]
    fn test_fable_falls_back_to_default_without_opus() {
        let mut provider = create_provider_with_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_MODEL": "default-model"
            }
        });
        let body = json!({"model": "claude-fable-5"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "default-model");
        assert_eq!(mapped, Some("default-model".to_string()));
    }

    #[test]
    fn test_thinking_does_not_affect_model_mapping() {
        // Issue #2081: thinking 参数不应影响模型映射
        let provider = create_provider_with_mapping();
        let body = json!({
            "model": "claude-sonnet-4-5",
            "thinking": {"type": "enabled"}
        });
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "sonnet-mapped");
        assert_eq!(mapped, Some("sonnet-mapped".to_string()));
    }

    #[test]
    fn test_thinking_adaptive_does_not_affect_model_mapping() {
        // Issue #2081: adaptive thinking 也不应影响模型映射
        let provider = create_provider_with_mapping();
        let body = json!({
            "model": "claude-sonnet-4-5",
            "thinking": {"type": "adaptive"}
        });
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "sonnet-mapped");
        assert_eq!(mapped, Some("sonnet-mapped".to_string()));
    }

    #[test]
    fn test_thinking_disabled() {
        let provider = create_provider_with_mapping();
        let body = json!({
            "model": "claude-sonnet-4-5",
            "thinking": {"type": "disabled"}
        });
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "sonnet-mapped");
        assert_eq!(mapped, Some("sonnet-mapped".to_string()));
    }

    #[test]
    fn test_unknown_model_uses_default() {
        let provider = create_provider_with_mapping();
        let body = json!({"model": "some-unknown-model"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "default-model");
        assert_eq!(mapped, Some("default-model".to_string()));
    }

    #[test]
    fn test_subagent_model_preserved_before_default_fallback() {
        let mut provider = create_provider_with_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_MODEL": "default-model",
                "CLAUDE_CODE_SUBAGENT_MODEL": "gpt-5.4-mini"
            }
        });

        let body = json!({"model": "gpt-5.4-mini"});
        let (result, original, mapped) = apply_model_mapping(body, &provider);

        assert_eq!(result["model"], "gpt-5.4-mini");
        assert_eq!(original, Some("gpt-5.4-mini".to_string()));
        assert!(mapped.is_none());
    }

    #[test]
    fn test_subagent_model_preserved_with_one_m_suffix_before_default_fallback() {
        let mut provider = create_provider_with_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_MODEL": "default-model",
                "CLAUDE_CODE_SUBAGENT_MODEL": "gpt-5.4-mini"
            }
        });

        let body = json!({"model": "gpt-5.4-mini[1M]"});
        let (result, original, mapped) = apply_model_mapping(body, &provider);

        assert_eq!(result["model"], "gpt-5.4-mini[1M]");
        assert_eq!(original, Some("gpt-5.4-mini[1M]".to_string()));
        assert!(mapped.is_none());
    }

    #[test]
    fn test_no_mapping_configured() {
        let provider = create_provider_without_mapping();
        let body = json!({"model": "claude-sonnet-4-5"});
        let (result, original, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "claude-sonnet-4-5");
        assert_eq!(original, Some("claude-sonnet-4-5".to_string()));
        assert!(mapped.is_none());
    }

    #[test]
    fn test_case_insensitive() {
        let provider = create_provider_with_mapping();
        let body = json!({"model": "Claude-SONNET-4-5"});
        let (result, _, mapped) = apply_model_mapping(body, &provider);
        assert_eq!(result["model"], "sonnet-mapped");
        assert_eq!(mapped, Some("sonnet-mapped".to_string()));
    }

    #[test]
    fn codex_model_routes_map_exact_request_model() {
        let mut provider = create_provider_without_mapping();
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_model_routes: std::collections::HashMap::from([(
                "gpt-5.4-mini".to_string(),
                crate::provider::CodexModelRoute {
                    model: "gpt-5.5".to_string(),
                },
            )]),
            ..Default::default()
        });

        let body = json!({"model": "gpt-5.4-mini", "input": "hello"});
        let (result, original, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "gpt-5.5");
        assert_eq!(original.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(mapped.as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn codex_model_routes_match_trimmed_case_insensitive_request_model() {
        let mut provider = create_provider_without_mapping();
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_model_routes: std::collections::HashMap::from([(
                "gpt-5.5".to_string(),
                crate::provider::CodexModelRoute {
                    model: "deepseek-v4-pro".to_string(),
                },
            )]),
            ..Default::default()
        });

        let body = json!({"model": " GPT-5.5 ", "input": "hello"});
        let (result, original, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "deepseek-v4-pro");
        assert_eq!(original.as_deref(), Some(" GPT-5.5 "));
        assert_eq!(mapped.as_deref(), Some("deepseek-v4-pro"));
    }

    #[test]
    fn codex_model_routes_prefer_original_model_before_catalog_alias() {
        let mut provider = create_provider_without_mapping();
        provider.settings_config = json!({
            "modelCatalog": {
                "models": [
                    {
                        "displayName": "gpt-5.5",
                        "model": "catalog-upstream-model"
                    }
                ]
            }
        });
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_model_routes: std::collections::HashMap::from([
                (
                    "gpt-5.5".to_string(),
                    crate::provider::CodexModelRoute {
                        model: "deepseek-v4-pro".to_string(),
                    },
                ),
                (
                    "catalog-upstream-model".to_string(),
                    crate::provider::CodexModelRoute {
                        model: "should-not-win".to_string(),
                    },
                ),
            ]),
            ..Default::default()
        });

        let body = json!({"model": "gpt-5.5", "input": "hello"});
        let (result, original, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "deepseek-v4-pro");
        assert_eq!(original.as_deref(), Some("gpt-5.5"));
        assert_eq!(mapped.as_deref(), Some("deepseek-v4-pro"));
    }

    #[test]
    fn codex_catalog_alias_maps_before_codex_model_routes() {
        let mut provider = create_provider_without_mapping();
        provider.settings_config = json!({
            "modelCatalog": {
                "models": [
                    {
                        "displayName": "aaa",
                        "model": "B"
                    }
                ]
            }
        });
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_model_routes: std::collections::HashMap::from([(
                "B".to_string(),
                crate::provider::CodexModelRoute {
                    model: "C".to_string(),
                },
            )]),
            ..Default::default()
        });

        let body = json!({"model": "aaa", "input": "hello"});
        let (result, original, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "C");
        assert_eq!(original.as_deref(), Some("aaa"));
        assert_eq!(mapped.as_deref(), Some("C"));
    }

    #[test]
    fn codex_catalog_alias_maps_to_catalog_model_without_route() {
        let mut provider = create_provider_without_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_MODEL": "legacy-default-model"
            },
            "modelCatalog": {
                "models": [
                    {
                        "displayName": "aaa",
                        "model": "B"
                    }
                ]
            }
        });

        let body = json!({"model": "aaa", "input": "hello"});
        let (result, _, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "B");
        assert_eq!(mapped.as_deref(), Some("B"));
    }

    #[test]
    fn codex_catalog_listed_model_preserves_request_without_legacy_default() {
        let mut provider = create_provider_without_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_MODEL": "legacy-default-model"
            },
            "modelCatalog": {
                "models": [
                    {
                        "displayName": "aaa",
                        "model": "B"
                    }
                ]
            }
        });

        let body = json!({"model": "B", "input": "hello"});
        let (result, _, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "B");
        assert!(mapped.is_none());
    }

    #[test]
    fn codex_model_routes_take_priority_over_default_env_mapping() {
        let mut provider = create_provider_with_mapping();
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_model_routes: std::collections::HashMap::from([(
                "gpt-5.4-mini".to_string(),
                crate::provider::CodexModelRoute {
                    model: "gpt-5.5".to_string(),
                },
            )]),
            ..Default::default()
        });

        let body = json!({"model": "gpt-5.4-mini", "input": "hello"});
        let (result, _, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "gpt-5.5");
        assert_eq!(mapped.as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn codex_without_explicit_route_preserves_request_model() {
        let provider = create_provider_with_mapping();
        let body = json!({"model": "gpt-5.4-mini", "input": "hello"});
        let (result, _, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "gpt-5.4-mini");
        assert!(mapped.is_none());
    }

    #[test]
    fn codex_model_routes_disabled_preserves_request_model() {
        let mut provider = create_provider_with_mapping();
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_model_routes_enabled: Some(false),
            codex_model_routes: std::collections::HashMap::from([(
                "gpt-5.4-mini".to_string(),
                crate::provider::CodexModelRoute {
                    model: "gpt-5.5".to_string(),
                },
            )]),
            ..Default::default()
        });

        let body = json!({"model": "gpt-5.4-mini", "input": "hello"});
        let (result, _, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "gpt-5.4-mini");
        assert!(mapped.is_none());
    }

    #[test]
    fn codex_local_routing_disabled_ignores_catalog_alias() {
        let mut provider = create_provider_with_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_MODEL": "legacy-default-model"
            },
            "modelCatalog": {
                "models": [
                    {
                        "displayName": "gpt-5.5",
                        "model": "deepseek-v4-pro"
                    }
                ]
            }
        });
        provider.meta = Some(crate::provider::ProviderMeta {
            codex_local_routing_enabled: Some(false),
            ..Default::default()
        });

        let body = json!({"model": "gpt-5.5", "input": "hello"});
        let (result, _, mapped) = apply_codex_model_mapping(body, &provider);

        assert_eq!(result["model"], "gpt-5.5");
        assert!(mapped.is_none());
    }

    #[test]
    fn strips_one_m_suffix_before_upstream() {
        let body = json!({"model": "deepseek-v4-pro[1M]"});
        let result = strip_one_m_suffix_for_upstream_from_body(body);
        assert_eq!(result["model"], "deepseek-v4-pro");
    }

    #[test]
    fn strips_one_m_suffix_after_mapping() {
        let mut provider = create_provider_with_mapping();
        provider.settings_config = json!({
            "env": {
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro [1M]"
            }
        });

        let body = json!({"model": "claude-sonnet-4-6"});
        let (mapped, _, _) = apply_model_mapping(body, &provider);
        let result = strip_one_m_suffix_for_upstream_from_body(mapped);

        assert_eq!(result["model"], "deepseek-v4-pro");
    }

    #[test]
    fn keeps_model_without_one_m_suffix() {
        let body = json!({"model": "deepseek-v4-pro"});
        let result = strip_one_m_suffix_for_upstream_from_body(body);
        assert_eq!(result["model"], "deepseek-v4-pro");
    }
}
