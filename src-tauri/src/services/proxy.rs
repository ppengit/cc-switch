//! 代理服务业务逻辑层
//!
//! 提供代理服务器的启动、停止和配置管理

use crate::app_config::AppType;
use crate::config::{delete_file, get_claude_settings_path, read_json_file, write_json_file};
use crate::database::Database;
use crate::provider::Provider;
use crate::proxy::server::ProxyServer;
use crate::proxy::switch_lock::SwitchLockManager;
use crate::proxy::types::*;
use crate::services::provider::{
    build_direct_live_settings_with_mcp, build_effective_settings_with_common_config,
    build_effective_settings_without_template, build_proxy_takeover_settings,
    write_live_with_common_config, ProviderService,
};
use serde_json::{json, Map, Value};
use std::str::FromStr;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::RwLock;

/// 用于接管 Live 配置时的占位符（避免客户端提示缺少 key，同时不泄露真实 Token）
const PROXY_TOKEN_PLACEHOLDER: &str = "PROXY_MANAGED";

/// 代理接管模式下历史版本可能残留的 Claude Live 模型覆盖字段。
///
/// 原因：接管模式下 `*_MODEL` 必须由 CC Switch 写成稳定的 Claude 角色别名，
/// 再由本地代理映射到当前供应商真实模型；`*_MODEL_NAME` 也需要同步接管，
/// 否则 Claude Code 模型菜单会残留上一个供应商的显示名称。
const CLAUDE_MODEL_OVERRIDE_ENV_KEYS: [&str; 9] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL", // legacy: 已废弃，但旧配置可能残留
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    // Legacy key (已废弃)：历史版本使用该字段区分 small/fast 模型
    "ANTHROPIC_SMALL_FAST_MODEL",
];

const CLAUDE_TAKEOVER_HAIKU_MODEL: &str = "claude-haiku-4-5";
const CLAUDE_TAKEOVER_SONNET_MODEL: &str = "claude-sonnet-4-6";
const CLAUDE_TAKEOVER_OPUS_MODEL: &str = "claude-opus-4-8";
// 写给 Claude Code 时沿用文档示例的大写形式；解析侧大小写不敏感。
const CLAUDE_ONE_M_MARKER_FOR_CLIENT: &str = "[1M]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum ClaudeTakeoverAuthPolicy {
    PreserveExistingOrAuthToken,
    ManagedAccount,
}

#[derive(Clone)]
pub struct ProxyService {
    db: Arc<Database>,
    server: Arc<RwLock<Option<ProxyServer>>>,
    /// AppHandle，用于传递给 ProxyServer 以支持故障转移时的 UI 更新
    app_handle: Arc<RwLock<Option<tauri::AppHandle>>>,
    switch_locks: SwitchLockManager,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct HotSwitchOutcome {
    pub logical_target_changed: bool,
}

impl ProxyService {
    async fn build_gemini_direct_restore_snapshot(&self) -> Result<Option<Value>, String> {
        let Some(provider) = self
            .takeover_restore_target_provider_for_app(&AppType::Gemini)
            .await?
        else {
            return Ok(None);
        };

        let settings =
            build_direct_live_settings_with_mcp(self.db.as_ref(), &AppType::Gemini, &provider)
                .map_err(|e| format!("构建 Gemini 直连恢复配置失败: {e}"))?;
        Ok(Some(settings))
    }

    fn is_legacy_gemini_env_only_backup(config: &Value) -> bool {
        config.get("env").is_some()
            && config.get("config").is_none()
            && config.as_object().is_some_and(|obj| obj.len() == 1)
    }

    async fn upgrade_legacy_gemini_backup_if_needed(
        &self,
        config: Value,
    ) -> Result<(Value, bool), String> {
        if !Self::is_legacy_gemini_env_only_backup(&config) {
            return Ok((config, false));
        }

        let Some(upgraded) = self.build_gemini_direct_restore_snapshot().await? else {
            return Ok((config, false));
        };

        Ok((upgraded, true))
    }

    async fn load_restorable_live_backup_for_app(
        &self,
        app_type: &AppType,
    ) -> Result<Option<(Value, bool)>, String> {
        let Some(backup) = self
            .db
            .get_live_backup(app_type.as_str())
            .await
            .map_err(|e| format!("获取 {} Live 备份失败: {e}", app_type.as_str()))?
        else {
            return Ok(None);
        };

        let parsed: Value = serde_json::from_str(&backup.original_config)
            .map_err(|e| format!("解析 {} 备份失败: {e}", app_type.as_str()))?;

        if matches!(app_type, AppType::Gemini) {
            let (upgraded, changed) = self.upgrade_legacy_gemini_backup_if_needed(parsed).await?;
            return Ok(Some((upgraded, changed)));
        }

        Ok(Some((parsed, false)))
    }

    async fn persist_live_backup_for_app(
        &self,
        app_type: &AppType,
        config: &Value,
    ) -> Result<(), String> {
        let serialized = serde_json::to_string(config)
            .map_err(|e| format!("序列化 {} 备份失败: {e}", app_type.as_str()))?;
        self.db
            .save_live_backup(app_type.as_str(), &serialized)
            .await
            .map_err(|e| format!("更新 {} 备份失败: {e}", app_type.as_str()))?;
        Ok(())
    }

    fn hydrate_mcp_db_from_app_live(&self, app_type: &AppType) -> Result<usize, String> {
        let state = crate::store::AppState::new(self.db.clone());
        match app_type {
            AppType::Claude => crate::services::mcp::McpService::import_from_claude(&state),
            AppType::Codex => crate::services::mcp::McpService::import_from_codex(&state),
            AppType::Gemini => crate::services::mcp::McpService::import_from_gemini(&state),
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes | AppType::ClaudeDesktop => {
                Ok(0)
            }
        }
        .map_err(|e| format!("导入 {} MCP 配置失败: {e}", app_type.as_str()))
    }

    fn sync_takeover_sidecars_from_db(&self, app_type: &AppType) -> Result<(), String> {
        if !matches!(app_type, AppType::Claude) {
            return Ok(());
        }

        let state = crate::store::AppState::new(self.db.clone());
        crate::services::mcp::McpService::sync_all_enabled(&state)
            .map_err(|e| format!("同步 {} MCP 配置失败: {e}", app_type.as_str()))?;
        Ok(())
    }

    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            server: Arc::new(RwLock::new(None)),
            app_handle: Arc::new(RwLock::new(None)),
            switch_locks: SwitchLockManager::new(),
        }
    }

    pub async fn should_preserve_takeover_live_semantics(&self, app_type: &AppType) -> bool {
        if !matches!(app_type, AppType::Claude | AppType::Codex | AppType::Gemini) {
            return false;
        }

        let proxy_config = self
            .db
            .get_proxy_config_for_app(app_type.as_str())
            .await
            .ok();
        let takeover_enabled = proxy_config
            .as_ref()
            .map(|config| config.enabled)
            .unwrap_or(false);
        let has_backup = self
            .db
            .get_live_backup(app_type.as_str())
            .await
            .ok()
            .flatten()
            .is_some();
        let live_taken_over = self.detect_takeover_in_live_config_for_app(app_type);

        takeover_enabled || has_backup || live_taken_over
    }

    fn clear_failover_current_provider_state(&self, app_type: &AppType) {
        let _ = crate::settings::set_current_provider(app_type, None);
        if let Err(error) = self.db.clear_current_provider(app_type.as_str()) {
            log::warn!(
                "清空 {} current provider 状态失败: {error}",
                app_type.as_str()
            );
        }
    }

    async fn restore_direct_current_from_failover_queue(
        &self,
        app_type: &AppType,
    ) -> Result<bool, String> {
        let Some(queue_head) = self
            .db
            .get_failover_queue(app_type.as_str())
            .map_err(|e| format!("读取 {} 故障转移队列失败: {e}", app_type.as_str()))?
            .into_iter()
            .next()
        else {
            return Ok(false);
        };
        let Some(provider) = self
            .db
            .get_provider_by_id(&queue_head.provider_id, app_type.as_str())
            .map_err(|e| format!("读取 {} 队列头供应商失败: {e}", app_type.as_str()))?
        else {
            return Ok(false);
        };

        self.db
            .set_current_provider(app_type.as_str(), &provider.id)
            .map_err(|e| format!("恢复 {} 当前供应商失败: {e}", app_type.as_str()))?;
        crate::settings::set_current_provider(app_type, Some(&provider.id))
            .map_err(|e| format!("恢复 {} 本地当前供应商失败: {e}", app_type.as_str()))?;
        write_live_with_common_config(self.db.as_ref(), app_type, &provider)
            .map_err(|e| format!("恢复 {} 直连 Live 配置失败: {e}", app_type.as_str()))?;

        Ok(true)
    }

    /// 清理接管模式下 Claude Live 配置中的模型覆盖字段。
    ///
    /// 这可以避免"接管开启后切换供应商仍使用旧模型"的问题。
    /// 注意：此方法不会修改 Token/Base URL 的接管占位符，仅移除模型字段。
    pub fn cleanup_claude_model_overrides_in_live(&self) -> Result<(), String> {
        let mut config = self.read_claude_live()?;

        let Some(env) = config.get_mut("env").and_then(|v| v.as_object_mut()) else {
            return Ok(());
        };

        let mut changed = false;
        for key in CLAUDE_MODEL_OVERRIDE_ENV_KEYS {
            if env.remove(key).is_some() {
                changed = true;
            }
        }

        if changed {
            self.write_claude_live(&config)?;
        }

        Ok(())
    }

    fn apply_claude_takeover_fields(
        config: &mut Value,
        proxy_url: &str,
        model_source: Option<&Value>,
    ) {
        // 必须在 remove/insert 前 snapshot：避免读到自己刚写入的接管别名。
        let takeover_model_fields =
            Self::build_claude_takeover_model_fields(model_source.unwrap_or(config));

        Self::apply_claude_takeover_fields_with_policy_and_models(
            config,
            proxy_url,
            ClaudeTakeoverAuthPolicy::PreserveExistingOrAuthToken,
            takeover_model_fields,
        );
    }

    #[allow(dead_code)]
    fn apply_claude_takeover_fields_for_provider(
        config: &mut Value,
        proxy_url: &str,
        provider: &Provider,
    ) {
        let auth_policy = if provider.uses_managed_account_auth() {
            ClaudeTakeoverAuthPolicy::ManagedAccount
        } else {
            ClaudeTakeoverAuthPolicy::PreserveExistingOrAuthToken
        };
        // Copilot/Codex 接管时 live config 可能还是旧供应商；显示模型必须跟随目标 provider。
        let takeover_model_fields = if provider.uses_managed_account_auth() {
            Self::build_claude_takeover_model_fields(&provider.settings_config)
        } else {
            Self::build_claude_takeover_model_fields(config)
        };

        Self::apply_claude_takeover_fields_with_policy_and_models(
            config,
            proxy_url,
            auth_policy,
            takeover_model_fields,
        );
    }

    #[allow(dead_code)]
    fn apply_claude_takeover_fields_with_policy(
        config: &mut Value,
        proxy_url: &str,
        auth_policy: ClaudeTakeoverAuthPolicy,
    ) {
        let takeover_model_fields = Self::build_claude_takeover_model_fields(config);

        Self::apply_claude_takeover_fields_with_policy_and_models(
            config,
            proxy_url,
            auth_policy,
            takeover_model_fields,
        );
    }

    fn apply_claude_takeover_fields_with_policy_and_models(
        config: &mut Value,
        proxy_url: &str,
        auth_policy: ClaudeTakeoverAuthPolicy,
        takeover_model_fields: Vec<(&'static str, String)>,
    ) {
        if !config.is_object() {
            *config = json!({});
        }

        let root = config
            .as_object_mut()
            .expect("Claude config should be normalized to an object");
        let env = root.entry("env".to_string()).or_insert_with(|| json!({}));
        if !env.is_object() {
            *env = json!({});
        }

        let env = env
            .as_object_mut()
            .expect("Claude env should be normalized to an object");
        env.insert("ANTHROPIC_BASE_URL".to_string(), json!(proxy_url));

        for key in CLAUDE_MODEL_OVERRIDE_ENV_KEYS {
            env.remove(key);
        }

        for (key, value) in takeover_model_fields {
            env.insert(key.to_string(), Value::String(value));
        }

        let token_keys = [
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENAI_API_KEY",
        ];

        match auth_policy {
            ClaudeTakeoverAuthPolicy::PreserveExistingOrAuthToken => {
                let mut replaced_any = false;
                for key in token_keys {
                    if env.contains_key(key) {
                        env.insert(key.to_string(), json!(PROXY_TOKEN_PLACEHOLDER));
                        replaced_any = true;
                    }
                }

                if !replaced_any {
                    env.insert(
                        "ANTHROPIC_AUTH_TOKEN".to_string(),
                        json!(PROXY_TOKEN_PLACEHOLDER),
                    );
                }
            }
            ClaudeTakeoverAuthPolicy::ManagedAccount => {
                for key in token_keys {
                    env.remove(key);
                }
                env.insert(
                    "ANTHROPIC_API_KEY".to_string(),
                    json!(PROXY_TOKEN_PLACEHOLDER),
                );
            }
        }
    }

    fn build_claude_takeover_model_fields(config: &Value) -> Vec<(&'static str, String)> {
        let Some(env) = config.get("env").and_then(Value::as_object) else {
            return Vec::new();
        };

        let default_model = Self::claude_env_string(env, "ANTHROPIC_MODEL");
        let small_fast_model = Self::claude_env_string(env, "ANTHROPIC_SMALL_FAST_MODEL");
        let haiku_model = Self::claude_env_string(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL")
            .or(small_fast_model)
            .or(default_model);
        let sonnet_model = Self::claude_env_string(env, "ANTHROPIC_DEFAULT_SONNET_MODEL")
            .or(default_model)
            .or(small_fast_model);
        let opus_model = Self::claude_env_string(env, "ANTHROPIC_DEFAULT_OPUS_MODEL")
            .or(default_model)
            .or(small_fast_model);

        let mut fields = Vec::with_capacity(6);
        Self::push_claude_takeover_role_fields(
            &mut fields,
            env,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            CLAUDE_TAKEOVER_HAIKU_MODEL,
            false,
            haiku_model,
        );
        Self::push_claude_takeover_role_fields(
            &mut fields,
            env,
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            CLAUDE_TAKEOVER_SONNET_MODEL,
            true,
            sonnet_model,
        );
        Self::push_claude_takeover_role_fields(
            &mut fields,
            env,
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            CLAUDE_TAKEOVER_OPUS_MODEL,
            true,
            opus_model,
        );
        fields
    }

    fn push_claude_takeover_role_fields(
        fields: &mut Vec<(&'static str, String)>,
        env: &Map<String, Value>,
        model_key: &'static str,
        name_key: &'static str,
        takeover_model: &'static str,
        supports_one_m: bool,
        upstream_model: Option<&str>,
    ) {
        let Some(upstream_model) = upstream_model else {
            return;
        };

        let mut client_model = takeover_model.to_string();
        if supports_one_m && Self::has_claude_one_m_marker(upstream_model) {
            client_model.push_str(CLAUDE_ONE_M_MARKER_FOR_CLIENT);
        }
        fields.push((model_key, client_model));

        let display_name = Self::claude_env_string(env, name_key)
            .map(str::to_string)
            .unwrap_or_else(|| Self::strip_claude_one_m_marker(upstream_model));
        if !display_name.is_empty() {
            fields.push((name_key, display_name));
        }
    }

    fn claude_env_string<'a>(env: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
        env.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    fn has_claude_one_m_marker(model: &str) -> bool {
        model
            .trim_end()
            .to_ascii_lowercase()
            .ends_with(crate::claude_desktop_config::ONE_M_CONTEXT_MARKER)
    }

    fn strip_claude_one_m_marker(model: &str) -> String {
        crate::proxy::model_mapper::strip_one_m_suffix_for_upstream(model)
            .trim()
            .to_string()
    }

    fn apply_codex_takeover_fields(config: &mut Value, proxy_codex_base_url: &str) {
        if !config.is_object() {
            *config = json!({});
        }

        let root = config
            .as_object_mut()
            .expect("Codex config should be normalized to an object");
        let auth = root.entry("auth".to_string()).or_insert_with(|| json!({}));
        if !auth.is_object() {
            *auth = json!({});
        }
        auth.as_object_mut()
            .expect("Codex auth should be normalized to an object")
            .insert("OPENAI_API_KEY".to_string(), json!(PROXY_TOKEN_PLACEHOLDER));

        let config_str = root.get("config").and_then(|v| v.as_str()).unwrap_or("");
        let updated_config =
            Self::rewrite_codex_base_urls_for_takeover(config_str, proxy_codex_base_url);
        root.insert("config".to_string(), json!(updated_config));
    }

    fn apply_codex_provider_model_fields(
        config: &mut Value,
        provider: &Provider,
    ) -> Result<(), String> {
        if !config.is_object() {
            *config = json!({});
        }

        let root = config
            .as_object_mut()
            .expect("Codex config should be normalized to an object");
        let target_config = root.get("config").and_then(|v| v.as_str()).unwrap_or("");
        let source_config = provider
            .settings_config
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let updated = crate::codex_config::sync_codex_toml_model_fields_from_source(
            target_config,
            source_config,
        )
        .map_err(|e| format!("同步 Codex 供应商模型字段失败: {e}"))?;
        root.insert("config".to_string(), json!(updated));
        Ok(())
    }

    fn apply_codex_takeover_provider_identity_fields(
        config: &mut Value,
        provider: &Provider,
    ) -> Result<(), String> {
        if !config.is_object() {
            *config = json!({});
        }

        let root = config
            .as_object_mut()
            .expect("Codex config should be normalized to an object");
        let target_config = root.get("config").and_then(|v| v.as_str()).unwrap_or("");
        let source_config = provider
            .settings_config
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let source_doc = if source_config.trim().is_empty() {
            toml_edit::DocumentMut::new()
        } else {
            source_config
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("解析 Codex 供应商 config.toml 失败: {e}"))?
        };

        let Some(provider_id) = source_doc
            .get("model_provider")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            return Self::apply_codex_provider_model_fields(config, provider);
        };
        let provider_id = provider_id.to_string();

        let mut target_doc = if target_config.trim().is_empty() {
            toml_edit::DocumentMut::new()
        } else {
            target_config
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("解析 Codex 接管 config.toml 失败: {e}"))?
        };

        target_doc["model_provider"] = toml_edit::value(provider_id.as_str());

        if target_doc.get("model_providers").is_none() {
            target_doc["model_providers"] = toml_edit::table();
        }

        let provider_item = source_doc
            .get("model_providers")
            .and_then(|item| item.as_table_like())
            .and_then(|table| table.get(provider_id.as_str()))
            .cloned()
            .unwrap_or_else(|| toml_edit::Item::Table(toml_edit::Table::new()));
        let mut provider_item = provider_item;
        if let Some(provider_table) = provider_item.as_table_like_mut() {
            provider_table.remove("base_url");
            provider_table.remove("experimental_bearer_token");
            if provider_table.get("name").is_none() && !provider.name.trim().is_empty() {
                provider_table.insert("name", toml_edit::value(provider.name.trim()));
            }
        }

        let model_providers = target_doc
            .get_mut("model_providers")
            .and_then(|item| item.as_table_like_mut())
            .ok_or_else(|| "Codex 接管 config.toml 的 model_providers 必须是表".to_string())?;
        model_providers.insert(provider_id.as_str(), provider_item);

        root.insert("config".to_string(), json!(target_doc.to_string()));
        Self::apply_codex_provider_model_fields(config, provider)
    }

    #[allow(dead_code)]
    fn normalize_endpoint_for_compare(value: &str) -> String {
        let mut value = value.trim().trim_end_matches('/').to_ascii_lowercase();
        if value.ends_with("/v1") {
            value.truncate(value.len() - 3);
        }
        value
    }

    #[allow(dead_code)]
    fn endpoints_match(left: Option<&str>, right: Option<&str>) -> bool {
        let Some(left) = left else {
            return false;
        };
        let Some(right) = right else {
            return false;
        };
        let left = Self::normalize_endpoint_for_compare(left);
        let right = Self::normalize_endpoint_for_compare(right);
        !left.is_empty() && left == right
    }

    #[allow(dead_code)]
    fn codex_base_url_from_settings(settings: &Value) -> Option<String> {
        let config = settings.get("config").and_then(|v| v.as_str())?;
        let doc = config.parse::<toml_edit::DocumentMut>().ok()?;

        if let Some(provider_id) = doc.get("model_provider").and_then(|v| v.as_str()) {
            if let Some(base_url) = doc
                .get("model_providers")
                .and_then(|v| v.get(provider_id))
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str())
            {
                return Some(base_url.to_string());
            }
        }

        if let Some(base_url) = doc.get("base_url").and_then(|v| v.as_str()) {
            return Some(base_url.to_string());
        }

        doc.get("model_providers")
            .and_then(|v| v.as_table_like())
            .and_then(|providers| {
                providers.iter().find_map(|(_, provider)| {
                    provider
                        .get("base_url")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
            })
    }

    fn live_config_belongs_to_provider(
        db: &Database,
        app_type: &AppType,
        live_config: &Value,
        provider: &Provider,
    ) -> bool {
        ProviderService::live_settings_can_backfill_provider(db, app_type, live_config, provider)
    }

    fn rewrite_codex_base_urls_for_takeover(toml_str: &str, proxy_codex_base_url: &str) -> String {
        let mut doc = match toml_str.parse::<toml_edit::DocumentMut>() {
            Ok(doc) => doc,
            Err(_) => return Self::update_toml_base_url(toml_str, proxy_codex_base_url),
        };

        if let Some(model_providers) = doc
            .get_mut("model_providers")
            .and_then(|item| item.as_table_like_mut())
        {
            let provider_ids: Vec<String> = model_providers
                .iter()
                .map(|(provider_id, _)| provider_id.to_string())
                .collect();

            for provider_id in provider_ids {
                if let Some(provider_table) = model_providers
                    .get_mut(&provider_id)
                    .and_then(|item| item.as_table_like_mut())
                {
                    provider_table.remove("base_url");
                }
            }
        }

        doc.as_table_mut().remove("base_url");

        let active_provider = doc
            .get("model_provider")
            .and_then(|item| item.as_str())
            .map(str::to_string);

        if let Some(provider_id) = active_provider {
            if doc.get("model_providers").is_none() {
                doc["model_providers"] = toml_edit::table();
            }

            if let Some(model_providers) = doc
                .get_mut("model_providers")
                .and_then(|item| item.as_table_like_mut())
            {
                if model_providers.get(&provider_id).is_none() {
                    model_providers.insert(&provider_id, toml_edit::table());
                }

                if let Some(provider_table) = model_providers
                    .get_mut(&provider_id)
                    .and_then(|item| item.as_table_like_mut())
                {
                    provider_table.insert("base_url", toml_edit::value(proxy_codex_base_url));
                    return doc.to_string();
                }
            }
        }

        doc["base_url"] = toml_edit::value(proxy_codex_base_url);
        doc.to_string()
    }

    fn apply_gemini_takeover_fields(config: &mut Value, proxy_url: &str) {
        if !config.is_object() {
            *config = json!({});
        }

        let root = config
            .as_object_mut()
            .expect("Gemini config should be normalized to an object");
        let env = root.entry("env".to_string()).or_insert_with(|| json!({}));
        if !env.is_object() {
            *env = json!({});
        }

        let env = env
            .as_object_mut()
            .expect("Gemini env should be normalized to an object");
        env.insert("GOOGLE_GEMINI_BASE_URL".to_string(), json!(proxy_url));
        env.insert("GEMINI_API_KEY".to_string(), json!(PROXY_TOKEN_PLACEHOLDER));
    }

    #[allow(dead_code)]
    fn claude_provider_with_effective_settings(
        &self,
        provider: &Provider,
    ) -> Result<Provider, String> {
        let mut effective_provider = provider.clone();
        effective_provider.settings_config = build_effective_settings_with_common_config(
            self.db.as_ref(),
            &AppType::Claude,
            provider,
        )
        .map_err(|e| format!("构建 claude 有效配置失败: {e}"))?;
        Ok(effective_provider)
    }

    #[allow(dead_code)]
    fn get_current_provider_for_app(&self, app_type: &AppType) -> Result<Option<Provider>, String> {
        let Some(current_id) = crate::settings::get_effective_current_provider(&self.db, app_type)
            .map_err(|e| format!("获取 {app_type:?} 当前供应商失败: {e}"))?
        else {
            return Ok(None);
        };

        self.db
            .get_provider_by_id(&current_id, app_type.as_str())
            .map_err(|e| format!("读取 {app_type:?} 当前供应商失败: {e}"))
    }

    #[allow(dead_code)]
    fn require_current_provider_for_app(&self, app_type: &AppType) -> Result<Provider, String> {
        self.get_current_provider_for_app(app_type)?
            .ok_or_else(|| format!("{app_type:?} 当前供应商不存在，无法接管 Live 配置"))
    }

    pub async fn sync_live_from_provider_while_proxy_active(
        &self,
        app_type: &AppType,
        provider: &Provider,
    ) -> Result<(), String> {
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;
        let mut effective_settings = build_proxy_takeover_settings(
            self.db.as_ref(),
            app_type,
            &proxy_url,
            &proxy_codex_base_url,
            PROXY_TOKEN_PLACEHOLDER,
        )
        .map_err(|e| format!("构建 {} 代理接入配置失败: {e}", app_type.as_str()))?;

        match app_type {
            AppType::Claude => {
                Self::apply_claude_takeover_fields(
                    &mut effective_settings,
                    &proxy_url,
                    Some(&provider.settings_config),
                );
                self.write_live_config_for_app(app_type, &effective_settings)?;
            }
            AppType::Codex => {
                let existing_live = self.read_codex_live().ok();
                crate::services::provider::inject_db_managed_mcp_into_settings(
                    self.db.as_ref(),
                    &AppType::Codex,
                    &mut effective_settings,
                )
                .map_err(|e| format!("注入 Codex MCP 配置失败: {e}"))?;
                if let Some(existing_live) = existing_live.as_ref() {
                    Self::preserve_codex_mcp_servers_from_existing_config(
                        &mut effective_settings,
                        existing_live,
                    )?;
                }
                Self::apply_codex_takeover_fields(&mut effective_settings, &proxy_codex_base_url);
                Self::apply_codex_takeover_provider_identity_fields(
                    &mut effective_settings,
                    provider,
                )?;
                Self::apply_codex_takeover_fields(&mut effective_settings, &proxy_codex_base_url);
                self.write_codex_takeover_live_for_provider(&effective_settings, Some(provider))?;
            }
            AppType::Gemini => {
                Self::apply_gemini_takeover_fields(&mut effective_settings, &proxy_url);
                self.write_live_config_for_app(app_type, &effective_settings)?;
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes | AppType::ClaudeDesktop => {
                return Err("该应用不支持代理接管".to_string());
            }
        }

        Ok(())
    }

    pub async fn sync_codex_live_from_provider_while_proxy_active(
        &self,
        provider: &Provider,
    ) -> Result<(), String> {
        self.sync_live_from_provider_while_proxy_active(&AppType::Codex, provider)
            .await
    }

    pub async fn sync_live_access_template_for_app(
        &self,
        app_type: &AppType,
    ) -> Result<(), String> {
        if !matches!(app_type, AppType::Claude | AppType::Codex | AppType::Gemini) {
            return Err("该应用不支持代理接管".to_string());
        }

        let current_provider = self
            .takeover_restore_target_provider_for_app(app_type)
            .await?;
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;
        let mut live_config = build_proxy_takeover_settings(
            self.db.as_ref(),
            app_type,
            &proxy_url,
            &proxy_codex_base_url,
            PROXY_TOKEN_PLACEHOLDER,
        )
        .map_err(|e| format!("构建 {} 代理接入配置失败: {e}", app_type.as_str()))?;

        match app_type {
            AppType::Claude => {
                Self::apply_claude_takeover_fields(
                    &mut live_config,
                    &proxy_url,
                    current_provider
                        .as_ref()
                        .map(|provider| &provider.settings_config),
                );
                self.write_live_config_for_app(app_type, &live_config)?;
            }
            AppType::Codex => {
                Self::apply_codex_takeover_fields(&mut live_config, &proxy_codex_base_url);
                if let Some(provider) = current_provider.as_ref() {
                    Self::apply_codex_provider_model_fields(&mut live_config, provider)?;
                }
                self.write_live_config_for_app(app_type, &live_config)?;
            }
            AppType::Gemini => {
                Self::apply_gemini_takeover_fields(&mut live_config, &proxy_url);
                self.write_live_config_for_app(app_type, &live_config)?;
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes | AppType::ClaudeDesktop => {
                unreachable!()
            }
        }

        Ok(())
    }

    pub async fn sync_claude_live_from_provider_while_proxy_active(
        &self,
        provider: &Provider,
    ) -> Result<(), String> {
        self.sync_live_from_provider_while_proxy_active(&AppType::Claude, provider)
            .await
    }

    /// 设置 AppHandle（在应用初始化时调用）
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        futures::executor::block_on(async {
            *self.app_handle.write().await = Some(handle);
        });
    }

    pub(crate) async fn lock_switch_for_app(
        &self,
        app_type: &str,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        self.switch_locks.lock_for_app(app_type).await
    }

    /// 启动代理服务器
    pub async fn start(&self) -> Result<ProxyServerInfo, String> {
        // 1. 启动时自动设置 proxy_enabled = true
        let mut global_config = self
            .db
            .get_global_proxy_config()
            .await
            .map_err(|e| format!("获取全局代理配置失败: {e}"))?;

        if !global_config.proxy_enabled {
            global_config.proxy_enabled = true;
            self.db
                .update_global_proxy_config(global_config.clone())
                .await
                .map_err(|e| format!("更新代理总开关失败: {e}"))?;
        }

        // 2. 获取配置
        let config = self
            .db
            .get_proxy_config()
            .await
            .map_err(|e| format!("获取代理配置失败: {e}"))?;

        // 3. 若已在运行：确保持久化状态（如需要）并返回当前信息
        if let Some(server) = self.server.read().await.as_ref() {
            let status = server.get_status().await;
            return Ok(ProxyServerInfo {
                address: status.address,
                port: status.port,
                // 无法精确取回首次启动时间，返回当前时间用于 UI 展示即可
                started_at: chrono::Utc::now().to_rfc3339(),
            });
        }

        // 4. 创建并启动服务器
        let app_handle = self.app_handle.read().await.clone();
        let server = ProxyServer::new(config.clone(), self.db.clone(), app_handle);
        let info = server
            .start()
            .await
            .map_err(|e| format!("启动代理服务器失败: {e}"))?;

        // 5. 保存服务器实例
        *self.server.write().await = Some(server);

        log::info!("代理服务器已启动: {}:{}", info.address, info.port);
        Ok(info)
    }

    /// 启动代理服务器（带 Live 配置接管）
    pub async fn start_with_takeover(&self) -> Result<ProxyServerInfo, String> {
        // 1. 备份各应用的 Live 配置
        self.backup_live_configs().await?;

        // 2. 同步 Live 配置中的 Token 到数据库（确保代理能读到最新的 Token）
        if let Err(e) = self.sync_live_to_providers().await {
            // 同步失败时尚未写入接管配置，但备份可能包含敏感信息，尽量清理
            if let Err(clean_err) = self.db.delete_all_live_backups().await {
                log::warn!("清理 Live 备份失败: {clean_err}");
            }
            return Err(e);
        }

        // 3. 在写入接管配置之前先落盘接管标志：
        //    这样即使在接管过程中断电/kill，下次启动也能检测到并自动恢复。
        if let Err(e) = self.db.set_live_takeover_active(true).await {
            if let Err(clean_err) = self.db.delete_all_live_backups().await {
                log::warn!("清理 Live 备份失败: {clean_err}");
            }
            return Err(format!("设置接管状态失败: {e}"));
        }

        // 4. 接管各应用的 Live 配置（写入代理地址，清空 Token）
        if let Err(e) = self.takeover_live_configs().await {
            // 接管失败（可能是部分写入），尝试恢复原始配置；若恢复失败则保留标志与备份，等待下次启动自动恢复。
            log::error!("接管 Live 配置失败，尝试恢复原始配置: {e}");
            match self.restore_live_configs().await {
                Ok(()) => {
                    let _ = self.db.set_live_takeover_active(false).await;
                    let _ = self.db.delete_all_live_backups().await;
                }
                Err(restore_err) => {
                    log::error!("恢复原始配置失败，将保留备份以便下次启动恢复: {restore_err}");
                }
            }
            return Err(e);
        }

        // 5. 启动代理服务器
        match self.start().await {
            Ok(info) => Ok(info),
            Err(e) => {
                // 启动失败，恢复原始配置
                log::error!("代理启动失败，尝试恢复原始配置: {e}");
                match self.restore_live_configs().await {
                    Ok(()) => {
                        let _ = self.db.set_live_takeover_active(false).await;
                        let _ = self.db.delete_all_live_backups().await;
                    }
                    Err(restore_err) => {
                        log::error!("恢复原始配置失败，将保留备份以便下次启动恢复: {restore_err}");
                    }
                }
                Err(e)
            }
        }
    }

    /// 获取各应用的接管状态（是否改写该应用的 Live 配置指向本地代理）
    pub async fn get_takeover_status(&self) -> Result<ProxyTakeoverStatus, String> {
        // 从 proxy_config.enabled 读取（优先），兼容旧的 live_backup 备份检测
        let claude_enabled = self
            .db
            .get_proxy_config_for_app("claude")
            .await
            .map(|c| c.enabled)
            .unwrap_or(false);
        let codex_enabled = self
            .db
            .get_proxy_config_for_app("codex")
            .await
            .map(|c| c.enabled)
            .unwrap_or(false);
        let gemini_enabled = self
            .db
            .get_proxy_config_for_app("gemini")
            .await
            .map(|c| c.enabled)
            .unwrap_or(false);
        // OpenCode, OpenClaw and Hermes don't support proxy takeover, always return false
        let opencode_enabled = false;
        let openclaw_enabled = false;
        let hermes_enabled = false;

        Ok(ProxyTakeoverStatus {
            claude: claude_enabled,
            codex: codex_enabled,
            gemini: gemini_enabled,
            opencode: opencode_enabled,
            openclaw: openclaw_enabled,
            hermes: hermes_enabled,
        })
    }

    /// 为指定应用开启/关闭 Live 接管
    ///
    /// - 开启：自动启动代理服务，仅接管当前 app 的 Live 配置
    /// - 关闭：仅恢复当前 app 的 Live 配置；若无其它接管，则自动停止代理服务
    pub async fn set_takeover_for_app(&self, app_type: &str, enabled: bool) -> Result<(), String> {
        let app = AppType::from_str(app_type).map_err(|e| format!("无效的应用类型: {e}"))?;
        let app_type_str = app.as_str();
        let _guard = self.switch_locks.lock_for_app(app_type_str).await;

        if enabled {
            // 1) 代理服务未运行则自动启动
            if !self.is_running().await {
                self.start().await?;
            }

            // 2) 已接管则直接返回（幂等）；但如果缺少备份或占位符残留，需要重建接管
            let current_config = self
                .db
                .get_proxy_config_for_app(app_type_str)
                .await
                .map_err(|e| format!("获取 {app_type_str} 配置失败: {e}"))?;

            if let Err(error) = self.hydrate_mcp_db_from_app_live(&app) {
                log::warn!(
                    "{} 接管前导入当前 MCP 配置失败，将继续接管流程: {error}",
                    app_type_str
                );
            }

            let mut has_existing_backup = self
                .db
                .get_live_backup(app_type_str)
                .await
                .map_err(|e| format!("读取 {app_type_str} 备份失败: {e}"))?
                .is_some();
            let mut restore_existing_backup_before_takeover = false;
            let mut should_backup_live = !has_existing_backup;
            let mut should_sync_live_token = !has_existing_backup;
            let live_has_takeover_placeholder = self.detect_takeover_in_live_config_for_app(&app);

            if current_config.enabled {
                let live_matches_current_proxy =
                    match self.live_takeover_matches_current_proxy(&app).await {
                        Ok(value) => value,
                        Err(e) => {
                            log::warn!("检测 {app_type_str} 接管配置失败（将继续重建接管）: {e}");
                            false
                        }
                    };

                // 必须 backup 存在，且 live 确实指向当前代理地址，才算真接管。
                // 只看占位符会把半接管/旧端口残留误判为可复用。
                if has_existing_backup && live_matches_current_proxy {
                    self.repair_takeover_runtime_state(&app).await?;
                    self.sync_live_access_template_for_app(&app).await?;
                    self.sync_takeover_sidecars_from_db(&app)?;
                    self.sync_failover_active_target(app_type_str).await?;
                    return Ok(());
                }
                restore_existing_backup_before_takeover = has_existing_backup;

                if has_existing_backup {
                    log::warn!(
                        "{app_type_str} 标记为已接管且备份存在，但 Live 配置未指向当前本地代理，正在恢复备份后重写接管配置"
                    );
                } else if live_has_takeover_placeholder {
                    match self.rebuild_live_backup_from_restore_target(&app).await {
                        Ok(true) => {
                            has_existing_backup = true;
                            restore_existing_backup_before_takeover = true;
                            should_backup_live = false;
                            should_sync_live_token = false;
                            log::info!(
                                "{app_type_str} Live 含接管占位符且备份缺失，已从当前恢复目标重建备份"
                            );
                        }
                        Ok(false) => {
                            should_backup_live = false;
                            should_sync_live_token = false;
                            log::warn!(
                                "{app_type_str} Live 含接管占位符且备份缺失，但没有可用恢复目标；将继续重写接管配置"
                            );
                        }
                        Err(error) => {
                            log::warn!(
                                "{app_type_str} Live 含接管占位符且备份缺失，重建备份失败: {error}"
                            );
                            should_backup_live = false;
                            should_sync_live_token = false;
                        }
                    }
                } else {
                    log::warn!(
                        "{app_type_str} 标记为已接管，但缺少备份或占位符，正在重新接管并补齐备份"
                    );
                    should_backup_live = true;
                    should_sync_live_token = true;
                }
            } else if live_has_takeover_placeholder {
                match self.rebuild_live_backup_from_restore_target(&app).await {
                    Ok(true) => {
                        has_existing_backup = true;
                        restore_existing_backup_before_takeover = true;
                        should_backup_live = false;
                        should_sync_live_token = false;
                        log::info!(
                            "{app_type_str} 未标记接管但 Live 含接管占位符，已从当前恢复目标重建备份"
                        );
                    }
                    Ok(false) => {
                        should_backup_live = false;
                        should_sync_live_token = false;
                        log::warn!(
                            "{app_type_str} 未标记接管但 Live 含接管占位符，且没有可用恢复目标；不会把占位符 Live 保存为原始备份"
                        );
                    }
                    Err(error) => {
                        should_backup_live = false;
                        should_sync_live_token = false;
                        log::warn!(
                            "{app_type_str} 未标记接管但 Live 含接管占位符，重建备份失败: {error}"
                        );
                    }
                }
            }

            // 3) 备份 Live 配置（严格：目标 app 不存在则报错）
            if restore_existing_backup_before_takeover {
                self.restore_live_config_for_app_inner(&app).await?;
            } else if should_backup_live && !has_existing_backup {
                self.backup_live_config_strict(&app).await?;
            }

            // 4) 同步 Live Token 到数据库（仅当前 app）
            if should_sync_live_token && !has_existing_backup {
                if let Err(e) = self.sync_live_to_provider(&app).await {
                    let _ = self.db.delete_live_backup(app_type_str).await;
                    return Err(e);
                }
            }

            // 5) 写入接管配置（仅当前 app）
            if let Err(e) = self.takeover_live_config_strict(&app).await {
                log::error!("{app_type_str} 接管 Live 配置失败，尝试恢复: {e}");
                match self.restore_live_config_for_app_inner(&app).await {
                    Ok(()) => {
                        // 恢复成功才清理备份，避免失败场景下丢失唯一可回滚来源
                        let _ = self.db.delete_live_backup(app_type_str).await;
                    }
                    Err(restore_err) => {
                        log::error!(
                            "{app_type_str} 恢复 Live 配置失败，将保留备份以便下次启动恢复: {restore_err}"
                        );
                    }
                }
                return Err(e);
            }

            // 6) 设置 proxy_config.enabled = true
            let mut updated_config = self
                .db
                .get_proxy_config_for_app(app_type_str)
                .await
                .map_err(|e| format!("获取 {app_type_str} 配置失败: {e}"))?;
            updated_config.enabled = true;
            self.db
                .update_proxy_config_for_app(updated_config)
                .await
                .map_err(|e| format!("设置 {app_type_str} enabled 状态失败: {e}"))?;
            self.repair_takeover_runtime_state(&app).await?;
            self.sync_takeover_sidecars_from_db(&app)?;
            self.sync_failover_active_target(app_type_str).await?;

            // 7) 兼容旧逻辑：写入 any-of 标志（失败不影响功能）
            let _ = self.db.set_live_takeover_active(true).await;

            // 8) Warn if the current provider is official (risk of account ban via proxy)
            if let Ok(Some(current_id)) =
                crate::settings::get_effective_current_provider(&self.db, &app)
            {
                if let Ok(Some(provider)) = self.db.get_provider_by_id(&current_id, app_type_str) {
                    if provider.category.as_deref() == Some("official") {
                        if let Some(handle) = self.app_handle.read().await.as_ref() {
                            let _ = handle.emit(
                                "proxy-official-warning",
                                serde_json::json!({
                                    "appType": app_type_str,
                                    "providerName": provider.name,
                                }),
                            );
                        }
                    }
                }
            }

            return Ok(());
        }

        // 关闭接管：检查 enabled 状态
        let current_config = self
            .db
            .get_proxy_config_for_app(app_type_str)
            .await
            .map_err(|e| format!("获取 {app_type_str} 配置失败: {e}"))?;

        if !current_config.enabled {
            let has_backup = self
                .db
                .get_live_backup(app_type_str)
                .await
                .map_err(|e| format!("读取 {app_type_str} Live 备份失败: {e}"))?
                .is_some();
            let live_taken_over = self.detect_takeover_in_live_config_for_app(&app);

            if has_backup || live_taken_over {
                let restored_from_failover_queue = if current_config.auto_failover_enabled {
                    self.restore_direct_current_from_failover_queue(&app)
                        .await?
                } else {
                    false
                };

                if !restored_from_failover_queue {
                    self.restore_live_config_for_app_with_fallback_inner(&app, false)
                        .await?;
                }
                self.db
                    .delete_live_backup(app_type_str)
                    .await
                    .map_err(|e| format!("删除 {app_type_str} Live 备份失败: {e}"))?;
            }

            if current_config.auto_failover_enabled {
                let mut repaired_config = current_config.clone();
                repaired_config.auto_failover_enabled = false;
                self.db
                    .update_proxy_config_for_app(repaired_config)
                    .await
                    .map_err(|e| format!("修复 {app_type_str} 故障转移状态失败: {e}"))?;
            }

            self.db
                .clear_provider_health_for_app(app_type_str)
                .await
                .map_err(|e| format!("清除 {app_type_str} 健康状态失败: {e}"))?;
            self.clear_active_target_only(app_type_str).await;
            return Ok(());
        }

        // 1) 从故障转移关闭回直连时，应优先恢复为队列头 provider 的直连配置，
        // 而不是恢复接管前的旧 backup；否则 current/live 会重新错位。
        let restored_from_failover_queue = if current_config.auto_failover_enabled {
            self.restore_direct_current_from_failover_queue(&app)
                .await?
        } else {
            false
        };

        if !restored_from_failover_queue {
            // 必须走 with_fallback 版本：备份 → SSOT → 清理占位符 的三层兜底。
            self.restore_live_config_for_app_with_fallback_inner(&app, false)
                .await?;
        }

        // 2) 删除该 app 的备份（避免长期存储敏感 Token）
        self.db
            .delete_live_backup(app_type_str)
            .await
            .map_err(|e| format!("删除 {app_type_str} Live 备份失败: {e}"))?;

        // 3) 设置 proxy_config.enabled = false
        let mut updated_config = self
            .db
            .get_proxy_config_for_app(app_type_str)
            .await
            .map_err(|e| format!("获取 {app_type_str} 配置失败: {e}"))?;
        updated_config.enabled = false;
        updated_config.auto_failover_enabled = false;
        self.db
            .update_proxy_config_for_app(updated_config)
            .await
            .map_err(|e| format!("清除 {app_type_str} 接管/故障转移状态失败: {e}"))?;

        // 4) 清除该应用的健康状态（关闭代理时重置队列状态）
        self.db
            .clear_provider_health_for_app(app_type_str)
            .await
            .map_err(|e| format!("清除 {app_type_str} 健康状态失败: {e}"))?;

        // 关闭某个应用的接管后，即使代理服务器因为其它应用仍然运行，
        // 该应用的活动目标也必须清掉，避免 UI/托盘继续显示旧供应商。
        self.clear_active_target_only(app_type_str).await;

        // 5) 若无其它接管，更新旧标志，并停止代理服务
        // 检查是否还有其它 app 的 enabled = true
        let any_enabled = self
            .db
            .is_live_takeover_active()
            .await
            .map_err(|e| format!("检查接管状态失败: {e}"))?;

        if !any_enabled {
            let _ = self.db.set_live_takeover_active(false).await;

            if self.is_running().await {
                // 此时没有任何 app 处于接管状态，停止服务即可
                let _ = self.stop().await;
            }
        }

        Ok(())
    }

    /// 同步 Live 配置中的 Token 到数据库
    ///
    /// 在清空 Live Token 之前调用，确保数据库中的 Provider 配置有最新的 Token。
    /// 这样代理才能从数据库读取到正确的认证信息。
    async fn sync_live_to_provider(&self, app_type: &AppType) -> Result<(), String> {
        let live_config = match app_type {
            AppType::Claude => self.read_claude_live()?,
            AppType::Codex => self.read_codex_live()?,
            AppType::Gemini => self.read_gemini_live()?,
            _ => return Err("该应用不支持代理功能".to_string()),
        };

        self.sync_live_config_to_provider(app_type, &live_config)
            .await
    }

    async fn sync_live_config_to_provider(
        &self,
        app_type: &AppType,
        live_config: &Value,
    ) -> Result<(), String> {
        match app_type {
            AppType::Claude => {
                let provider_id =
                    crate::settings::get_effective_current_provider(&self.db, &AppType::Claude)
                        .map_err(|e| format!("获取 Claude 当前供应商失败: {e}"))?;

                if let Some(provider_id) = provider_id {
                    if let Ok(Some(mut provider)) =
                        self.db.get_provider_by_id(&provider_id, "claude")
                    {
                        if !Self::live_config_belongs_to_provider(
                            self.db.as_ref(),
                            app_type,
                            live_config,
                            &provider,
                        ) {
                            log::warn!(
                                "跳过 Claude Live Token 同步：Live endpoint 与当前供应商不匹配 (provider: {provider_id})"
                            );
                            return Ok(());
                        }

                        if let Some(env) = live_config.get("env").and_then(|v| v.as_object()) {
                            let token_pair = [
                                "ANTHROPIC_AUTH_TOKEN",
                                "ANTHROPIC_API_KEY",
                                "OPENROUTER_API_KEY",
                                "OPENAI_API_KEY",
                            ]
                            .into_iter()
                            .find_map(|key| {
                                env.get(key)
                                    .and_then(|v| v.as_str())
                                    .map(|s| (key, s.trim()))
                            })
                            .filter(|(_, token)| {
                                !token.is_empty() && *token != PROXY_TOKEN_PLACEHOLDER
                            });

                            if let Some((token_key, token)) = token_pair {
                                let env_obj = provider
                                    .settings_config
                                    .get_mut("env")
                                    .and_then(|v| v.as_object_mut());

                                match env_obj {
                                    Some(obj) => {
                                        if token_key == "ANTHROPIC_AUTH_TOKEN"
                                            || token_key == "ANTHROPIC_API_KEY"
                                        {
                                            let mut updated = false;
                                            if obj.contains_key("ANTHROPIC_AUTH_TOKEN") {
                                                obj.insert(
                                                    "ANTHROPIC_AUTH_TOKEN".to_string(),
                                                    json!(token),
                                                );
                                                updated = true;
                                            }
                                            if obj.contains_key("ANTHROPIC_API_KEY") {
                                                obj.insert(
                                                    "ANTHROPIC_API_KEY".to_string(),
                                                    json!(token),
                                                );
                                                updated = true;
                                            }
                                            if !updated {
                                                obj.insert(token_key.to_string(), json!(token));
                                            }
                                        } else {
                                            obj.insert(token_key.to_string(), json!(token));
                                        }
                                    }
                                    None => {
                                        // 至少写入一份可用的 Token
                                        if provider.settings_config.is_null() {
                                            provider.settings_config = json!({});
                                        }

                                        if let Some(root) = provider.settings_config.as_object_mut()
                                        {
                                            root.insert(
                                                "env".to_string(),
                                                json!({ token_key: token }),
                                            );
                                        } else {
                                            log::warn!(
                                                "Claude provider settings_config 格式异常（非对象），跳过写入 Token (provider: {provider_id})"
                                            );
                                        }
                                    }
                                }

                                if let Err(e) = self.db.update_provider_settings_config(
                                    "claude",
                                    &provider_id,
                                    &provider.settings_config,
                                ) {
                                    log::warn!("同步 Claude Token 到数据库失败: {e}");
                                } else {
                                    log::info!(
                                        "已同步 Claude Token 到数据库 (provider: {provider_id})"
                                    );
                                }
                            }
                        }
                    }
                }
            }
            AppType::Codex => {
                let provider_id =
                    crate::settings::get_effective_current_provider(&self.db, &AppType::Codex)
                        .map_err(|e| format!("获取 Codex 当前供应商失败: {e}"))?;

                if let Some(provider_id) = provider_id {
                    if let Ok(Some(mut provider)) =
                        self.db.get_provider_by_id(&provider_id, "codex")
                    {
                        if !Self::live_config_belongs_to_provider(
                            self.db.as_ref(),
                            app_type,
                            live_config,
                            &provider,
                        ) {
                            log::warn!(
                                "跳过 Codex Live Token 同步：Live endpoint 与当前供应商不匹配 (provider: {provider_id})"
                            );
                            return Ok(());
                        }

                        if let Some(token) = live_config
                            .get("auth")
                            .and_then(|v| v.get("OPENAI_API_KEY"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty() && *s != PROXY_TOKEN_PLACEHOLDER)
                        {
                            if let Some(auth_obj) = provider
                                .settings_config
                                .get_mut("auth")
                                .and_then(|v| v.as_object_mut())
                            {
                                auth_obj.insert("OPENAI_API_KEY".to_string(), json!(token));
                            } else {
                                if provider.settings_config.is_null() {
                                    provider.settings_config = json!({});
                                }

                                if let Some(root) = provider.settings_config.as_object_mut() {
                                    root.insert(
                                        "auth".to_string(),
                                        json!({ "OPENAI_API_KEY": token }),
                                    );
                                } else {
                                    log::warn!(
                                        "Codex provider settings_config 格式异常（非对象），跳过写入 Token (provider: {provider_id})"
                                    );
                                }
                            }

                            if let Err(e) = self.db.update_provider_settings_config(
                                "codex",
                                &provider_id,
                                &provider.settings_config,
                            ) {
                                log::warn!("同步 Codex Token 到数据库失败: {e}");
                            } else {
                                log::info!("已同步 Codex Token 到数据库 (provider: {provider_id})");
                            }
                        }
                    }
                }
            }
            AppType::Gemini => {
                let provider_id =
                    crate::settings::get_effective_current_provider(&self.db, &AppType::Gemini)
                        .map_err(|e| format!("获取 Gemini 当前供应商失败: {e}"))?;

                if let Some(provider_id) = provider_id {
                    if let Ok(Some(mut provider)) =
                        self.db.get_provider_by_id(&provider_id, "gemini")
                    {
                        if !Self::live_config_belongs_to_provider(
                            self.db.as_ref(),
                            app_type,
                            live_config,
                            &provider,
                        ) {
                            log::warn!(
                                "跳过 Gemini Live Token 同步：Live endpoint 与当前供应商不匹配 (provider: {provider_id})"
                            );
                            return Ok(());
                        }

                        if let Some(token) = live_config
                            .get("env")
                            .and_then(|v| v.get("GEMINI_API_KEY"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty() && *s != PROXY_TOKEN_PLACEHOLDER)
                        {
                            if let Some(env_obj) = provider
                                .settings_config
                                .get_mut("env")
                                .and_then(|v| v.as_object_mut())
                            {
                                env_obj.insert("GEMINI_API_KEY".to_string(), json!(token));
                            } else {
                                if provider.settings_config.is_null() {
                                    provider.settings_config = json!({});
                                }

                                if let Some(root) = provider.settings_config.as_object_mut() {
                                    root.insert(
                                        "env".to_string(),
                                        json!({ "GEMINI_API_KEY": token }),
                                    );
                                } else {
                                    log::warn!(
                                        "Gemini provider settings_config 格式异常（非对象），跳过写入 Token (provider: {provider_id})"
                                    );
                                }
                            }

                            if let Err(e) = self.db.update_provider_settings_config(
                                "gemini",
                                &provider_id,
                                &provider.settings_config,
                            ) {
                                log::warn!("同步 Gemini Token 到数据库失败: {e}");
                            } else {
                                log::info!(
                                    "已同步 Gemini Token 到数据库 (provider: {provider_id})"
                                );
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        Ok(())
    }

    async fn sync_live_to_providers(&self) -> Result<(), String> {
        if let Ok(live_config) = self.read_claude_live() {
            self.sync_live_config_to_provider(&AppType::Claude, &live_config)
                .await?;
        }

        if let Ok(live_config) = self.read_codex_live() {
            self.sync_live_config_to_provider(&AppType::Codex, &live_config)
                .await?;
        }

        if let Ok(live_config) = self.read_gemini_live() {
            self.sync_live_config_to_provider(&AppType::Gemini, &live_config)
                .await?;
        }

        log::info!("Live 配置 Token 同步完成");
        Ok(())
    }

    /// 停止代理服务器
    pub async fn stop(&self) -> Result<(), String> {
        if let Some(server) = self.server.write().await.take() {
            server
                .stop()
                .await
                .map_err(|e| format!("停止代理服务器失败: {e}"))?;

            // 停止时设置 proxy_enabled = false
            let mut global_config = self
                .db
                .get_global_proxy_config()
                .await
                .map_err(|e| format!("获取全局代理配置失败: {e}"))?;

            if global_config.proxy_enabled {
                global_config.proxy_enabled = false;
                if let Err(e) = self.db.update_global_proxy_config(global_config).await {
                    log::warn!("更新代理总开关失败: {e}");
                }
            }

            log::info!("代理服务器已停止");
            Ok(())
        } else {
            Err("代理服务器未运行".to_string())
        }
    }

    /// 停止代理服务器（恢复 Live 配置，用户手动关闭时使用）
    ///
    /// 会清除 settings 表中的代理状态，下次启动不会自动恢复。
    pub async fn stop_with_restore(&self) -> Result<(), String> {
        let app_restore_modes = {
            let mut modes = Vec::new();
            for app_type in [AppType::Claude, AppType::Codex, AppType::Gemini] {
                if let Ok(config) = self.db.get_proxy_config_for_app(app_type.as_str()).await {
                    modes.push((
                        app_type,
                        config.enabled && config.auto_failover_enabled,
                        config,
                    ));
                }
            }
            modes
        };

        // 1. 停止代理服务器（即使未运行也继续执行恢复逻辑）
        if let Err(e) = self.stop().await {
            log::warn!("停止代理服务器失败（将继续恢复 Live 配置）: {e}");
        }

        // 2. 恢复原始 Live 配置
        self.restore_live_configs().await?;

        // 2.1 对于故障转移模式，手动关闭代理后应回到"队列头直连"，
        //     不能停留在旧备份对应的历史 provider，也不能让 current 为空。
        for (app_type, failover_mode_active, _) in &app_restore_modes {
            if *failover_mode_active {
                self.restore_direct_current_from_failover_queue(app_type)
                    .await?;
            }
        }

        // 3. 清除 proxy_config 表中的接管状态（兼容旧版）
        self.db
            .set_live_takeover_active(false)
            .await
            .map_err(|e| format!("清除接管状态失败: {e}"))?;

        // 4. 清除所有应用的接管和故障转移状态（用户手动关闭，不需要下次自动恢复）。
        // 队列内容保留，但开关状态必须关闭，避免代理已停时 UI/路由仍认为故障转移可用。
        for (app_type, _, mut config) in app_restore_modes {
            let app_type_str = app_type.as_str();
            if config.enabled || config.auto_failover_enabled {
                config.enabled = false;
                config.auto_failover_enabled = false;
                if let Err(e) = self.db.update_proxy_config_for_app(config).await {
                    log::warn!("清除 {app_type_str} 接管/故障转移状态失败: {e}");
                }
            }
            self.clear_active_target_only(app_type_str).await;
        }

        // 5. 删除备份
        self.db
            .delete_all_live_backups()
            .await
            .map_err(|e| format!("删除备份失败: {e}"))?;

        // 6. 重置健康状态（让健康徽章恢复为正常）
        self.db
            .clear_all_provider_health()
            .await
            .map_err(|e| format!("重置健康状态失败: {e}"))?;

        // 注意：不清除故障转移队列，只关闭运行态开关。
        log::info!("代理已停止，Live 配置已恢复");
        Ok(())
    }

    /// 停止代理服务器（恢复 Live 配置，但保留 settings 表中的代理状态）
    ///
    /// 用于程序正常退出时，保留代理状态以便下次启动时自动恢复
    pub async fn stop_with_restore_keep_state(&self) -> Result<(), String> {
        let app_restore_configs = {
            let mut configs = Vec::new();
            for app_type in [AppType::Claude, AppType::Codex, AppType::Gemini] {
                if let Ok(config) = self.db.get_proxy_config_for_app(app_type.as_str()).await {
                    configs.push((app_type, config));
                }
            }
            configs
        };

        // 1. 停止代理服务器（即使未运行也继续执行恢复逻辑）
        if let Err(e) = self.stop().await {
            log::warn!("停止代理服务器失败（将继续恢复 Live 配置）: {e}");
        }

        // 2. 仅恢复那些下次启动前不再保持接管的应用。
        // 对仍启用接管的应用，live 文件应保持 takeover 访问配置，不应回退成某个具体供应商。
        for (app_type, config) in &app_restore_configs {
            if config.enabled {
                if config.auto_failover_enabled {
                    self.clear_failover_current_provider_state(app_type);
                }
                self.clear_active_target_only(app_type.as_str()).await;
                continue;
            }

            let app_key = app_type.as_str();
            let has_backup = self
                .db
                .get_live_backup(app_key)
                .await
                .map_err(|e| format!("读取 {app_key} Live 备份失败: {e}"))?
                .is_some();
            let live_taken_over = self.detect_takeover_in_live_config_for_app(app_type);

            if has_backup || live_taken_over {
                self.restore_live_config_for_app_with_fallback_mode(app_type, false)
                    .await?;
                self.db
                    .delete_live_backup(app_key)
                    .await
                    .map_err(|e| format!("删除 {app_key} Live 备份失败: {e}"))?;
            }

            self.clear_active_target_only(app_key).await;
        }

        // 3. 更新 proxy_config 表中的 live_takeover_active 标志（兼容旧版）
        //    注意：保留 proxy_config.enabled 状态，下次启动时自动恢复
        if let Ok(mut config) = self.db.get_proxy_config().await {
            config.live_takeover_active = false;
            let _ = self.db.update_proxy_config(config).await;
        }

        // 4. 重置健康状态
        self.db
            .clear_all_provider_health()
            .await
            .map_err(|e| format!("重置健康状态失败: {e}"))?;

        log::info!("代理已停止，已保留接管状态，下次启动将自动恢复");
        Ok(())
    }

    /// 备份各应用的 Live 配置
    async fn backup_live_configs(&self) -> Result<(), String> {
        // Claude
        if let Ok(config) = self.read_claude_live() {
            let json_str = serde_json::to_string(&config)
                .map_err(|e| format!("序列化 Claude 配置失败: {e}"))?;
            self.db
                .save_live_backup("claude", &json_str)
                .await
                .map_err(|e| format!("备份 Claude 配置失败: {e}"))?;
        }

        // Codex
        if let Ok(config) = self.read_codex_live() {
            let json_str = serde_json::to_string(&config)
                .map_err(|e| format!("序列化 Codex 配置失败: {e}"))?;
            self.db
                .save_live_backup("codex", &json_str)
                .await
                .map_err(|e| format!("备份 Codex 配置失败: {e}"))?;
        }

        // Gemini
        if let Ok(config) = self.read_gemini_live() {
            let json_str = serde_json::to_string(&config)
                .map_err(|e| format!("序列化 Gemini 配置失败: {e}"))?;
            self.db
                .save_live_backup("gemini", &json_str)
                .await
                .map_err(|e| format!("备份 Gemini 配置失败: {e}"))?;
        }

        log::info!("已备份所有应用的 Live 配置");
        Ok(())
    }

    /// 备份指定应用的 Live 配置（严格模式：目标配置不存在则返回错误）
    async fn backup_live_config_strict(&self, app_type: &AppType) -> Result<(), String> {
        let (app_type_str, config) = match app_type {
            AppType::Claude => ("claude", self.read_claude_live()?),
            AppType::Codex => ("codex", self.read_codex_live()?),
            AppType::Gemini => ("gemini", self.read_gemini_live()?),
            _ => return Err("该应用不支持代理功能".to_string()),
        };

        let json_str = serde_json::to_string(&config)
            .map_err(|e| format!("序列化 {app_type_str} 配置失败: {e}"))?;
        self.db
            .save_live_backup(app_type_str, &json_str)
            .await
            .map_err(|e| format!("备份 {app_type_str} 配置失败: {e}"))?;

        Ok(())
    }

    async fn current_provider_for_app(
        &self,
        app_type: &AppType,
    ) -> Result<Option<Provider>, String> {
        let current_id = crate::settings::get_effective_current_provider(&self.db, app_type)
            .map_err(|e| format!("获取 {} 当前供应商失败: {e}", app_type.as_str()))?;

        let Some(current_id) = current_id else {
            return Ok(None);
        };

        self.db
            .get_provider_by_id(&current_id, app_type.as_str())
            .map_err(|e| format!("读取 {} 当前供应商失败: {e}", app_type.as_str()))
    }

    async fn takeover_restore_target_provider_for_app(
        &self,
        app_type: &AppType,
    ) -> Result<Option<Provider>, String> {
        let proxy_config = self
            .db
            .get_proxy_config_for_app(app_type.as_str())
            .await
            .map_err(|e| format!("读取 {} 代理配置失败: {e}", app_type.as_str()))?;

        if proxy_config.enabled && proxy_config.auto_failover_enabled {
            let queue_head = self
                .db
                .get_failover_queue(app_type.as_str())
                .map_err(|e| format!("读取 {} 故障转移队列失败: {e}", app_type.as_str()))?
                .into_iter()
                .next();

            let Some(queue_head) = queue_head else {
                return Ok(None);
            };

            return self
                .db
                .get_provider_by_id(&queue_head.provider_id, app_type.as_str())
                .map_err(|e| format!("读取 {} 故障转移目标失败: {e}", app_type.as_str()));
        }

        self.current_provider_for_app(app_type).await
    }

    /// 构造写入 Live 的代理地址（处理 0.0.0.0 / IPv6 等特殊情况）
    async fn build_proxy_urls(&self) -> Result<(String, String), String> {
        let config = self
            .db
            .get_proxy_config()
            .await
            .map_err(|e| format!("获取代理配置失败: {e}"))?;

        // listen_address 可能是 0.0.0.0（用于监听所有网卡），但客户端无法用 0.0.0.0 连接；
        // 因此写回到各应用配置时，优先使用本机回环地址。
        let connect_host = match config.listen_address.as_str() {
            "0.0.0.0" => "127.0.0.1".to_string(),
            "::" => "::1".to_string(),
            _ => config.listen_address.clone(),
        };
        let connect_host_for_url = if connect_host.contains(':') && !connect_host.starts_with('[') {
            format!("[{connect_host}]")
        } else {
            connect_host
        };

        let proxy_origin = format!("http://{}:{}", connect_host_for_url, config.listen_port);
        let proxy_url = proxy_origin.clone();
        let proxy_codex_base_url = format!("{}/v1", proxy_origin.trim_end_matches('/'));

        Ok((proxy_url, proxy_codex_base_url))
    }

    /// 接管各应用的 Live 配置（写入代理地址）
    ///
    /// 代理服务器的路由已经根据 API 端点自动区分应用类型：
    /// - `/v1/messages` → Claude
    /// - `/v1/chat/completions`, `/v1/responses` → Codex
    /// - `/v1beta/*` → Gemini
    ///
    /// 因此不需要在 URL 中添加应用前缀。
    async fn takeover_live_configs(&self) -> Result<(), String> {
        for app_type in [AppType::Claude, AppType::Codex, AppType::Gemini] {
            match self.takeover_live_config_best_effort(&app_type).await {
                Ok(()) => {}
                Err(err) => log::warn!("{} Live 配置接管失败: {err}", app_type.as_str()),
            }
        }

        Ok(())
    }

    /// 接管指定应用的 Live 配置（严格模式：目标配置不存在则返回错误）
    async fn takeover_live_config_strict(&self, app_type: &AppType) -> Result<(), String> {
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;
        let current_provider = if matches!(app_type, AppType::Claude | AppType::Codex) {
            self.takeover_restore_target_provider_for_app(app_type)
                .await?
        } else {
            None
        };
        let mut live_config = build_proxy_takeover_settings(
            self.db.as_ref(),
            app_type,
            &proxy_url,
            &proxy_codex_base_url,
            PROXY_TOKEN_PLACEHOLDER,
        )
        .map_err(|e| format!("构建 {} 代理接入配置失败: {e}", app_type.as_str()))?;

        match app_type {
            AppType::Claude => {
                Self::apply_claude_takeover_fields(
                    &mut live_config,
                    &proxy_url,
                    current_provider
                        .as_ref()
                        .map(|provider| &provider.settings_config),
                );
                self.write_live_config_for_app(app_type, &live_config)?;
                log::info!("Claude Live 配置已接管，代理地址: {proxy_url}");
            }
            AppType::Codex => {
                Self::apply_codex_takeover_fields(&mut live_config, &proxy_codex_base_url);
                if let Some(provider) = current_provider.as_ref() {
                    Self::apply_codex_provider_model_fields(&mut live_config, provider)?;
                } else {
                    log::warn!(
                        "未找到 Codex restore target，{} 接管配置将仅保留代理接入模板字段",
                        app_type.as_str()
                    );
                }

                let config_str = live_config
                    .get("config")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let codex_provider = current_provider.as_ref();
                let updated_config = Self::apply_codex_proxy_toml_config_for_provider(
                    config_str,
                    &proxy_codex_base_url,
                    codex_provider,
                );
                live_config["config"] = json!(updated_config);
                Self::attach_codex_model_catalog_from_provider(&mut live_config, codex_provider);

                self.write_codex_takeover_live_for_provider(&live_config, codex_provider)?;
                log::info!("Codex Live 配置已接管，代理地址: {proxy_codex_base_url}");
            }
            AppType::Gemini => {
                Self::apply_gemini_takeover_fields(&mut live_config, &proxy_url);
                self.write_live_config_for_app(app_type, &live_config)?;
                log::info!("Gemini Live 配置已接管，代理地址: {proxy_url}");
            }
            _ => return Err("该应用不支持代理功能".to_string()),
        }

        Ok(())
    }

    /// 接管指定应用的 Live 配置（尽力而为：配置不存在/读取失败则跳过）
    async fn takeover_live_config_best_effort(&self, app_type: &AppType) -> Result<(), String> {
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;
        let current_provider = if matches!(app_type, AppType::Claude | AppType::Codex) {
            match self
                .takeover_restore_target_provider_for_app(app_type)
                .await
            {
                Ok(provider) => provider,
                Err(err) => {
                    log::warn!(
                        "读取 {} 当前供应商失败，接管配置将保留模板模型字段: {err}",
                        app_type.as_str()
                    );
                    None
                }
            }
        } else {
            None
        };
        let live_config = build_proxy_takeover_settings(
            self.db.as_ref(),
            app_type,
            &proxy_url,
            &proxy_codex_base_url,
            PROXY_TOKEN_PLACEHOLDER,
        );

        match app_type {
            AppType::Claude => {
                if let Ok(mut live_config) = live_config {
                    Self::apply_claude_takeover_fields(
                        &mut live_config,
                        &proxy_url,
                        current_provider
                            .as_ref()
                            .map(|provider| &provider.settings_config),
                    );
                    let _ = self.write_live_config_for_app(app_type, &live_config);
                }
            }
            AppType::Codex => {
                if let Ok(mut live_config) = live_config {
                    Self::apply_codex_takeover_fields(&mut live_config, &proxy_codex_base_url);
                    if let Some(provider) = current_provider.as_ref() {
                        if let Err(err) =
                            Self::apply_codex_provider_model_fields(&mut live_config, provider)
                        {
                            log::warn!("同步 Codex 当前供应商模型字段失败: {err}");
                        }
                    } else {
                        log::warn!("未找到 Codex 当前供应商，接管配置将保留模板模型字段");
                    }

                    let config_str = live_config
                        .get("config")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let codex_provider = current_provider.as_ref();
                    let updated_config = Self::apply_codex_proxy_toml_config_for_provider(
                        config_str,
                        &proxy_codex_base_url,
                        codex_provider,
                    );
                    live_config["config"] = json!(updated_config);
                    Self::attach_codex_model_catalog_from_provider(
                        &mut live_config,
                        codex_provider,
                    );

                    let _ =
                        self.write_codex_takeover_live_for_provider(&live_config, codex_provider);
                }
            }
            AppType::Gemini => {
                if let Ok(mut live_config) = live_config {
                    Self::apply_gemini_takeover_fields(&mut live_config, &proxy_url);
                    let _ = self.write_live_config_for_app(app_type, &live_config);
                }
            }
            _ => {}
        }

        Ok(())
    }

    async fn restore_live_config_for_app_inner(&self, app_type: &AppType) -> Result<(), String> {
        if !matches!(app_type, AppType::Claude | AppType::Codex | AppType::Gemini) {
            return Ok(());
        }

        if let Some((config, upgraded)) = self.load_restorable_live_backup_for_app(app_type).await?
        {
            if upgraded {
                self.persist_live_backup_for_app(app_type, &config).await?;
            }
            self.write_live_config_for_app(app_type, &config)?;
            log::info!("{} Live 配置已恢复", app_type.as_str());
        }

        Ok(())
    }

    /// 恢复原始 Live 配置
    async fn restore_live_configs(&self) -> Result<(), String> {
        let mut errors = Vec::new();

        for app_type in [AppType::Claude, AppType::Codex, AppType::Gemini] {
            if let Err(e) = self
                .restore_live_config_for_app_with_fallback_mode(&app_type, false)
                .await
            {
                errors.push(e);
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    async fn restore_live_config_for_app_with_fallback(
        &self,
        app_type: &AppType,
    ) -> Result<(), String> {
        self.restore_live_config_for_app_with_fallback_mode(app_type, true)
            .await
    }

    async fn restore_live_config_for_app_with_fallback_mode(
        &self,
        app_type: &AppType,
        preserve_takeover_if_active: bool,
    ) -> Result<(), String> {
        let _guard = self.switch_locks.lock_for_app(app_type.as_str()).await;
        self.restore_live_config_for_app_with_fallback_inner(app_type, preserve_takeover_if_active)
            .await
    }

    async fn restore_live_config_for_app_with_fallback_inner(
        &self,
        app_type: &AppType,
        preserve_takeover_if_active: bool,
    ) -> Result<(), String> {
        let app_type_str = app_type.as_str();

        if preserve_takeover_if_active
            && matches!(app_type, AppType::Claude | AppType::Codex | AppType::Gemini)
        {
            let takeover_enabled = self
                .db
                .get_proxy_config_for_app(app_type_str)
                .await
                .map(|config| config.enabled)
                .unwrap_or(false);
            if takeover_enabled {
                self.sync_live_access_template_for_app(app_type).await?;
                log::info!("{app_type_str} Live 配置已保持为代理接入模板");
                return Ok(());
            }
        }

        // 1) 优先从 Live 备份恢复（这是"原始 Live"的唯一可靠来源）
        if let Some((config, upgraded)) = self.load_restorable_live_backup_for_app(app_type).await?
        {
            if upgraded {
                self.persist_live_backup_for_app(app_type, &config).await?;
            }
            self.write_live_config_for_app(app_type, &config)?;
            log::info!("{app_type_str} Live 配置已从备份恢复");
            return Ok(());
        }

        // 2) 兜底：备份缺失，但 Live 仍包含接管占位符（异常退出/历史 bug 场景）
        if !self.detect_takeover_in_live_config_for_app(app_type) {
            return Ok(());
        }

        // 2.1) 优先从 SSOT（当前供应商）重建 Live（比"清理字段"更可用）
        match self.restore_live_from_ssot_for_app(app_type) {
            Ok(true) => {
                log::info!("{app_type_str} Live 配置已从 SSOT 恢复（无备份兜底）");
                return Ok(());
            }
            Ok(false) => {
                log::warn!(
                    "{app_type_str} Live 备份缺失，且无法从 SSOT 恢复，将尝试清理接管占位符"
                );
            }
            Err(e) => {
                log::error!(
                    "{app_type_str} Live 备份缺失，SSOT 恢复失败，将尝试清理接管占位符: {e}"
                );
            }
        }

        // 2.2) 最后兜底：尽力清理占位符与本地代理地址，避免长期卡在代理占位符状态
        self.cleanup_takeover_placeholders_in_live_for_app(app_type)?;
        log::info!("{app_type_str} Live 接管占位符已清理（无备份兜底）");
        Ok(())
    }

    pub(crate) fn write_live_config_for_app(
        &self,
        app_type: &AppType,
        config: &Value,
    ) -> Result<(), String> {
        if let Err(error) = self.db.set_live_owner_provider_id(app_type.as_str(), None) {
            log::warn!(
                "清理 {} live owner 锚点失败，继续写入原始 Live 配置: {error}",
                app_type.as_str()
            );
        }
        match app_type {
            AppType::Claude => self.write_claude_live(config),
            AppType::Codex => self.write_codex_live(config),
            AppType::Gemini => self.write_gemini_live(config),
            _ => Err("该应用不支持代理功能".to_string()),
        }
    }

    pub async fn normalize_manual_live_edit_for_takeover(
        &self,
        app_type: &AppType,
        edited_live: &Value,
    ) -> Result<Value, String> {
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;
        let mut normalized = edited_live.clone();

        crate::services::provider::inject_db_managed_mcp_into_settings(
            self.db.as_ref(),
            app_type,
            &mut normalized,
        )
        .map_err(|e| format!("注入 {} MCP 配置失败: {e}", app_type.as_str()))?;

        match app_type {
            AppType::Claude => {
                Self::apply_claude_takeover_fields(&mut normalized, &proxy_url, Some(edited_live));
            }
            AppType::Codex => {
                Self::apply_codex_takeover_fields(&mut normalized, &proxy_codex_base_url);
            }
            AppType::Gemini => {
                Self::apply_gemini_takeover_fields(&mut normalized, &proxy_url);
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes | AppType::ClaudeDesktop => {}
        }

        Ok(normalized)
    }

    pub fn detect_takeover_in_live_config_for_app(&self, app_type: &AppType) -> bool {
        match app_type {
            AppType::Claude => match self.read_claude_live() {
                Ok(config) => Self::is_claude_live_taken_over(&config),
                Err(_) => false,
            },
            AppType::Codex => match self.read_codex_live() {
                Ok(config) => Self::is_codex_live_taken_over(&config),
                Err(_) => false,
            },
            AppType::Gemini => match self.read_gemini_live() {
                Ok(config) => Self::is_gemini_live_taken_over(&config),
                Err(_) => false,
            },
            _ => false,
        }
    }

    #[allow(dead_code)]
    async fn detect_effective_takeover_in_live_config_for_app(
        &self,
        app_type: &AppType,
    ) -> Result<bool, String> {
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;

        Ok(match app_type {
            AppType::Claude => match self.read_claude_live() {
                Ok(config) => Self::is_claude_live_effectively_taken_over(&config, &proxy_url),
                Err(_) => false,
            },
            AppType::Codex => match self.read_codex_live() {
                Ok(config) => {
                    Self::is_codex_live_effectively_taken_over(&config, &proxy_codex_base_url)
                }
                Err(_) => false,
            },
            AppType::Gemini => match self.read_gemini_live() {
                Ok(config) => Self::is_gemini_live_effectively_taken_over(&config, &proxy_url),
                Err(_) => false,
            },
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes | AppType::ClaudeDesktop => {
                false
            }
        })
    }

    /// 当 Live 备份缺失时，尝试用 SSOT（当前供应商）写回 Live。
    ///
    /// 返回值：
    /// - Ok(true)：已成功写回
    /// - Ok(false)：缺少当前供应商/供应商不存在，无法写回
    fn restore_live_from_ssot_for_app(&self, app_type: &AppType) -> Result<bool, String> {
        let current_id = crate::settings::get_effective_current_provider(&self.db, app_type)
            .map_err(|e| format!("获取 {app_type:?} 当前供应商失败: {e}"))?;

        let Some(current_id) = current_id else {
            return Ok(false);
        };

        let providers = self
            .db
            .get_all_providers(app_type.as_str())
            .map_err(|e| format!("读取 {app_type:?} 供应商列表失败: {e}"))?;

        let Some(provider) = providers.get(&current_id) else {
            return Ok(false);
        };

        write_live_with_common_config(self.db.as_ref(), app_type, provider)
            .map_err(|e| format!("写入 {app_type:?} Live 配置失败: {e}"))?;

        Ok(true)
    }

    fn cleanup_takeover_placeholders_in_live_for_app(
        &self,
        app_type: &AppType,
    ) -> Result<(), String> {
        match app_type {
            AppType::Claude => self.cleanup_claude_takeover_placeholders_in_live(),
            AppType::Codex => self.cleanup_codex_takeover_placeholders_in_live(),
            AppType::Gemini => self.cleanup_gemini_takeover_placeholders_in_live(),
            _ => Ok(()),
        }
    }

    fn is_local_proxy_url(url: &str) -> bool {
        let url = url.trim();
        if !url.starts_with("http://") {
            return false;
        }
        let rest = &url["http://".len()..];
        rest.starts_with("127.0.0.1")
            || rest.starts_with("localhost")
            || rest.starts_with("0.0.0.0")
            || rest.starts_with("[::1]")
            || rest.starts_with("[::]")
            || rest.starts_with("::1")
            || rest.starts_with("::")
    }

    fn proxy_urls_match(actual: &str, expected: &str) -> bool {
        actual.trim().trim_end_matches('/') == expected.trim().trim_end_matches('/')
    }

    fn codex_config_has_base_url_matching(
        config_text: &str,
        predicate: impl Fn(&str) -> bool,
    ) -> bool {
        let Ok(doc) = toml::from_str::<toml::Value>(config_text) else {
            return false;
        };

        let active_provider = doc
            .get("model_provider")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty());

        if let Some(provider_id) = active_provider {
            if doc
                .get("model_providers")
                .and_then(|value| value.get(provider_id))
                .and_then(|value| value.get("base_url"))
                .and_then(|value| value.as_str())
                .is_some_and(&predicate)
            {
                return true;
            }
        }

        doc.get("base_url")
            .and_then(|value| value.as_str())
            .is_some_and(predicate)
    }

    async fn live_takeover_matches_current_proxy(
        &self,
        app_type: &AppType,
    ) -> Result<bool, String> {
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;

        match app_type {
            AppType::Claude => {
                let config = self.read_claude_live()?;
                let base_url_matches = config
                    .get("env")
                    .and_then(|value| value.get("ANTHROPIC_BASE_URL"))
                    .and_then(|value| value.as_str())
                    .is_some_and(|url| Self::proxy_urls_match(url, &proxy_url));
                Ok(Self::is_claude_live_taken_over(&config) && base_url_matches)
            }
            AppType::Codex => {
                let config = self.read_codex_live()?;
                let base_url_matches = config
                    .get("config")
                    .and_then(|value| value.as_str())
                    .is_some_and(|config_text| {
                        Self::codex_config_has_base_url_matching(config_text, |url| {
                            Self::proxy_urls_match(url, &proxy_codex_base_url)
                        })
                    });
                Ok(Self::codex_live_has_proxy_placeholder(&config) && base_url_matches)
            }
            AppType::Gemini => {
                let config = self.read_gemini_live()?;
                let base_url_matches = config
                    .get("env")
                    .and_then(|value| value.get("GOOGLE_GEMINI_BASE_URL"))
                    .and_then(|value| value.as_str())
                    .is_some_and(|url| Self::proxy_urls_match(url, &proxy_url));
                Ok(Self::is_gemini_live_taken_over(&config) && base_url_matches)
            }
            _ => Ok(false),
        }
    }

    fn cleanup_claude_takeover_placeholders_in_live(&self) -> Result<(), String> {
        let mut config = self.read_claude_live()?;

        let Some(env) = config.get_mut("env").and_then(|v| v.as_object_mut()) else {
            return Ok(());
        };

        for key in [
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENAI_API_KEY",
        ] {
            if env.get(key).and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER) {
                env.remove(key);
            }
        }

        if env
            .get("ANTHROPIC_BASE_URL")
            .and_then(|v| v.as_str())
            .map(Self::is_local_proxy_url)
            .unwrap_or(false)
        {
            env.remove("ANTHROPIC_BASE_URL");
        }

        self.write_live_config_for_app(&AppType::Claude, &config)?;
        Ok(())
    }

    fn cleanup_codex_takeover_placeholders_in_live(&self) -> Result<(), String> {
        let mut config = self.read_codex_live()?;

        if let Some(auth) = config.get_mut("auth").and_then(|v| v.as_object_mut()) {
            if auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER)
            {
                auth.remove("OPENAI_API_KEY");
            }
        }

        if let Some(cfg_str) = config.get("config").and_then(|v| v.as_str()) {
            let updated = Self::remove_local_toml_base_url(cfg_str);
            let updated =
                crate::codex_config::remove_codex_experimental_bearer_token_if(&updated, |token| {
                    token == PROXY_TOKEN_PLACEHOLDER
                })
                .map_err(|e| format!("清理 Codex 接管占位符失败: {e}"))?;
            config["config"] = json!(updated);
        }

        self.write_live_config_for_app(&AppType::Codex, &config)?;
        Ok(())
    }

    /// Remove local proxy base_url from TOML（委托给 codex_config 共享实现）
    fn remove_local_toml_base_url(toml_str: &str) -> String {
        crate::codex_config::remove_codex_toml_base_url_if(toml_str, Self::is_local_proxy_url)
    }

    fn cleanup_gemini_takeover_placeholders_in_live(&self) -> Result<(), String> {
        let mut config = self.read_gemini_live()?;

        let Some(env) = config.get_mut("env").and_then(|v| v.as_object_mut()) else {
            return Ok(());
        };

        if env.get("GEMINI_API_KEY").and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER) {
            env.remove("GEMINI_API_KEY");
        }

        if env
            .get("GOOGLE_GEMINI_BASE_URL")
            .and_then(|v| v.as_str())
            .map(Self::is_local_proxy_url)
            .unwrap_or(false)
        {
            env.remove("GOOGLE_GEMINI_BASE_URL");
        }

        self.write_live_config_for_app(&AppType::Gemini, &config)?;
        Ok(())
    }

    /// 检查是否处于 Live 接管模式
    pub async fn is_takeover_active(&self) -> Result<bool, String> {
        let status = self.get_takeover_status().await?;
        Ok(status.claude || status.codex || status.gemini)
    }

    /// 从异常退出中恢复（启动时调用）
    ///
    /// 检测到 Live 备份残留时调用此方法。
    /// 若应用仍配置为 takeover，则保留 takeover 文件并修复恢复基线；
    /// 否则恢复直连 live。
    pub async fn recover_from_crash(&self) -> Result<(), String> {
        for app_type in [AppType::Claude, AppType::Codex, AppType::Gemini] {
            let app_key = app_type.as_str();
            let config = self
                .db
                .get_proxy_config_for_app(app_key)
                .await
                .map_err(|e| format!("读取 {app_key} 代理配置失败: {e}"))?;
            let has_backup = self
                .db
                .get_live_backup(app_key)
                .await
                .map_err(|e| format!("读取 {app_key} Live 备份失败: {e}"))?
                .is_some();
            let live_taken_over = self.detect_takeover_in_live_config_for_app(&app_type);

            if !(has_backup || live_taken_over) {
                continue;
            }

            if config.enabled {
                if let Err(error) = self.hydrate_mcp_db_from_app_live(&app_type) {
                    log::warn!(
                        "{} crash recovery failed to hydrate MCP definitions before takeover rebuild: {error}",
                        app_key
                    );
                }
                self.repair_takeover_runtime_state(&app_type).await?;
                self.sync_live_access_template_for_app(&app_type).await?;
                self.sync_takeover_sidecars_from_db(&app_type)?;
                if self.is_running().await {
                    self.sync_failover_active_target(app_key).await?;
                }
                continue;
            }

            self.restore_live_config_for_app_with_fallback_mode(&app_type, false)
                .await?;
            self.db
                .delete_live_backup(app_key)
                .await
                .map_err(|e| format!("删除 {app_key} Live 备份失败: {e}"))?;
        }

        // 2. 清除接管标志
        self.db
            .set_live_takeover_active(false)
            .await
            .map_err(|e| format!("清除接管状态失败: {e}"))?;

        log::info!("已从异常退出中恢复 Live 配置");
        Ok(())
    }

    /// 检测 Live 配置是否处于"被接管"的残留状态
    ///
    /// 用于兜底处理：当数据库备份缺失但 Live 文件已经写成代理占位符时，
    /// 启动流程可以据此触发恢复逻辑。
    pub fn detect_takeover_in_live_configs(&self) -> bool {
        if let Ok(config) = self.read_claude_live() {
            if Self::is_claude_live_taken_over(&config) {
                return true;
            }
        }

        if let Ok(config) = self.read_codex_live() {
            if Self::is_codex_live_taken_over(&config) {
                return true;
            }
        }

        if let Ok(config) = self.read_gemini_live() {
            if Self::is_gemini_live_taken_over(&config) {
                return true;
            }
        }

        false
    }

    fn is_claude_live_taken_over(config: &Value) -> bool {
        let env = match config.get("env").and_then(|v| v.as_object()) {
            Some(env) => env,
            None => return false,
        };

        for key in [
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENAI_API_KEY",
        ] {
            if env.get(key).and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER) {
                return true;
            }
        }

        false
    }

    fn codex_live_has_proxy_placeholder(config: &Value) -> bool {
        if config
            .get("auth")
            .and_then(|v| v.as_object())
            .and_then(|auth| auth.get("OPENAI_API_KEY"))
            .and_then(|v| v.as_str())
            == Some(PROXY_TOKEN_PLACEHOLDER)
        {
            return true;
        }

        config
            .get("config")
            .and_then(|v| v.as_str())
            .and_then(crate::codex_config::extract_codex_experimental_bearer_token)
            .as_deref()
            == Some(PROXY_TOKEN_PLACEHOLDER)
    }

    fn is_codex_live_taken_over(config: &Value) -> bool {
        Self::codex_live_has_proxy_placeholder(config)
    }

    fn is_gemini_live_taken_over(config: &Value) -> bool {
        let env = match config.get("env").and_then(|v| v.as_object()) {
            Some(env) => env,
            None => return false,
        };
        env.get("GEMINI_API_KEY").and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER)
    }

    #[allow(dead_code)]
    fn proxy_urls_equal(actual: &str, expected: &str) -> bool {
        actual.trim().trim_end_matches('/') == expected.trim().trim_end_matches('/')
    }

    #[allow(dead_code)]
    fn is_claude_live_effectively_taken_over(config: &Value, proxy_url: &str) -> bool {
        if !Self::is_claude_live_taken_over(config) {
            return false;
        }

        config
            .get("env")
            .and_then(|v| v.as_object())
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(|v| v.as_str())
            .map(|url| Self::proxy_urls_equal(url, proxy_url))
            .unwrap_or(false)
    }

    #[allow(dead_code)]
    fn is_codex_live_effectively_taken_over(config: &Value, proxy_codex_base_url: &str) -> bool {
        if !Self::is_codex_live_taken_over(config) {
            return false;
        }

        let Some(config_text) = config.get("config").and_then(|v| v.as_str()) else {
            return false;
        };
        let Ok(parsed) = toml::from_str::<toml::Value>(config_text) else {
            return false;
        };

        let matches_expected = |value: Option<&toml::Value>| {
            value
                .and_then(|v| v.as_str())
                .map(|url| Self::proxy_urls_equal(url, proxy_codex_base_url))
                .unwrap_or(false)
        };

        if let Some(active_provider) = parsed
            .get("model_provider")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            if matches_expected(
                parsed
                    .get("model_providers")
                    .and_then(|v| v.get(active_provider))
                    .and_then(|v| v.get("base_url")),
            ) {
                return true;
            }
        }

        if matches_expected(parsed.get("base_url")) {
            return true;
        }

        parsed
            .get("model_providers")
            .and_then(|v| v.as_table())
            .map(|providers| {
                providers
                    .values()
                    .any(|provider| matches_expected(provider.get("base_url")))
            })
            .unwrap_or(false)
    }

    #[allow(dead_code)]
    fn is_gemini_live_effectively_taken_over(config: &Value, proxy_url: &str) -> bool {
        if !Self::is_gemini_live_taken_over(config) {
            return false;
        }

        config
            .get("env")
            .and_then(|v| v.as_object())
            .and_then(|env| env.get("GOOGLE_GEMINI_BASE_URL"))
            .and_then(|v| v.as_str())
            .map(|url| Self::proxy_urls_equal(url, proxy_url))
            .unwrap_or(false)
    }

    /// 从供应商配置更新 Live 备份（用于代理模式下的热切换）
    ///
    /// 与 backup_live_configs() 不同，此方法从供应商的 settings_config 生成备份，
    /// 而不是从 Live 文件读取（因为 Live 文件已被代理接管）。
    pub async fn update_live_backup_from_provider(
        &self,
        app_type: &str,
        provider: &Provider,
    ) -> Result<(), String> {
        let _guard = self.switch_locks.lock_for_app(app_type).await;
        self.update_live_backup_from_provider_inner(app_type, provider)
            .await
    }

    /// 仅供已持有 per-app 切换锁的调用方使用。
    async fn update_live_backup_from_provider_inner(
        &self,
        app_type: &str,
        provider: &Provider,
    ) -> Result<(), String> {
        let app_type_enum =
            AppType::from_str(app_type).map_err(|_| format!("未知的应用类型: {app_type}"))?;
        let mut effective_settings =
            build_direct_live_settings_with_mcp(self.db.as_ref(), &app_type_enum, provider)
                .map_err(|e| format!("构建 {app_type} 直连配置失败: {e}"))?;

        if matches!(app_type_enum, AppType::Codex) {
            let effective_without_template = build_effective_settings_without_template(
                self.db.as_ref(),
                &app_type_enum,
                provider,
            )
            .map_err(|e| format!("构建 {app_type} 原始有效配置失败: {e}"))?;
            Self::overlay_codex_mcp_servers_from_source(
                &mut effective_settings,
                &effective_without_template,
            )?;
            let existing_backup_value = self
                .db
                .get_live_backup(app_type)
                .await
                .map_err(|e| format!("读取 {app_type} 现有备份失败: {e}"))?
                .map(|backup| {
                    serde_json::from_str::<Value>(&backup.original_config)
                        .map_err(|e| format!("解析 {app_type} 现有备份失败: {e}"))
                })
                .transpose()?;

            if let Some(existing_value) = existing_backup_value.as_ref() {
                Self::preserve_codex_mcp_servers_from_existing_config(
                    &mut effective_settings,
                    existing_value,
                )?;
                Self::preserve_codex_oauth_auth_in_backup(&mut effective_settings, existing_value)?;
            }
        }

        let backup_json = match app_type_enum {
            AppType::Claude => serde_json::to_string(&effective_settings)
                .map_err(|e| format!("序列化 Claude 配置失败: {e}"))?,
            AppType::Codex => serde_json::to_string(&effective_settings)
                .map_err(|e| format!("序列化 Codex 配置失败: {e}"))?,
            AppType::Gemini => serde_json::to_string(&effective_settings)
                .map_err(|e| format!("序列化 Gemini 配置失败: {e}"))?,
            _ => return Err(format!("未知的应用类型: {app_type}")),
        };

        self.db
            .save_live_backup(app_type, &backup_json)
            .await
            .map_err(|e| format!("更新 {app_type} 备份失败: {e}"))?;

        log::info!("已更新 {app_type} Live 备份（热切换）");
        Ok(())
    }

    async fn rebuild_live_backup_from_restore_target(
        &self,
        app_type: &AppType,
    ) -> Result<bool, String> {
        if let Some(provider) = self
            .takeover_restore_target_provider_for_app(app_type)
            .await?
        {
            self.update_live_backup_from_provider_inner(app_type.as_str(), &provider)
                .await?;
            return Ok(true);
        }
        Ok(false)
    }

    async fn takeover_backup_matches_restore_target(
        &self,
        app_type: &AppType,
    ) -> Result<bool, String> {
        let Some((backup_value, upgraded)) =
            self.load_restorable_live_backup_for_app(app_type).await?
        else {
            return Ok(false);
        };
        if upgraded {
            self.persist_live_backup_for_app(app_type, &backup_value)
                .await?;
        }
        let Some(provider) = self
            .takeover_restore_target_provider_for_app(app_type)
            .await?
        else {
            return Ok(false);
        };

        Ok(Self::live_config_belongs_to_provider(
            self.db.as_ref(),
            app_type,
            &backup_value,
            &provider,
        ))
    }

    pub async fn repair_takeover_runtime_state(&self, app_type: &AppType) -> Result<(), String> {
        let app_key = app_type.as_str();
        let config = self
            .db
            .get_proxy_config_for_app(app_key)
            .await
            .map_err(|e| format!("读取 {app_key} 代理配置失败: {e}"))?;

        if !config.enabled {
            return Ok(());
        }

        if config.auto_failover_enabled {
            self.clear_failover_current_provider_state(app_type);
        }

        let backup_matches_target = self
            .takeover_backup_matches_restore_target(app_type)
            .await?;
        if !backup_matches_target {
            let rebuilt = self
                .rebuild_live_backup_from_restore_target(app_type)
                .await?;
            if !rebuilt {
                if config.auto_failover_enabled {
                    self.db
                        .delete_live_backup(app_key)
                        .await
                        .map_err(|e| format!("删除 {app_key} 陈旧 Live 备份失败: {e}"))?;
                }
                log::warn!(
                    "{} takeover 模式下缺少可用 restore target，无法重建 Live 备份",
                    app_key
                );
            }
        }

        Ok(())
    }

    pub async fn hot_switch_provider(
        &self,
        app_type: &str,
        provider_id: &str,
    ) -> Result<HotSwitchOutcome, String> {
        let _guard = self.switch_locks.lock_for_app(app_type).await;
        self.hot_switch_provider_inner(app_type, provider_id).await
    }

    pub(crate) async fn hot_switch_provider_inner(
        &self,
        app_type: &str,
        provider_id: &str,
    ) -> Result<HotSwitchOutcome, String> {
        let app_type_enum =
            AppType::from_str(app_type).map_err(|_| format!("无效的应用类型: {app_type}"))?;
        let provider = self
            .db
            .get_provider_by_id(provider_id, app_type)
            .map_err(|e| format!("读取供应商失败: {e}"))?
            .ok_or_else(|| format!("供应商不存在: {provider_id}"))?;

        // Defense-in-depth: block official providers during proxy takeover
        if provider.category.as_deref() == Some("official") {
            return Err(
                "代理接管模式下不能切换到官方供应商 (Cannot switch to official provider during proxy takeover)"
                    .to_string(),
            );
        }

        let logical_target_changed =
            crate::settings::get_effective_current_provider(&self.db, &app_type_enum)
                .map_err(|e| format!("读取当前供应商失败: {e}"))?
                .as_deref()
                != Some(provider_id);

        let has_backup = self
            .db
            .get_live_backup(app_type_enum.as_str())
            .await
            .map_err(|e| format!("读取 {app_type} 备份失败: {e}"))?
            .is_some();
        let live_taken_over = self.detect_takeover_in_live_config_for_app(&app_type_enum);
        let app_takeover_enabled = self
            .db
            .get_proxy_config_for_app(app_type)
            .await
            .map(|config| config.enabled)
            .unwrap_or(false);
        let should_sync_backup = has_backup || live_taken_over || app_takeover_enabled;

        self.db
            .set_current_provider(app_type_enum.as_str(), provider_id)
            .map_err(|e| format!("更新当前供应商失败: {e}"))?;
        crate::settings::set_current_provider(&app_type_enum, Some(provider_id))
            .map_err(|e| format!("更新本地当前供应商失败: {e}"))?;
        self.reset_provider_recovery_state(provider_id, app_type_enum.as_str())
            .await?;

        if should_sync_backup {
            self.update_live_backup_from_provider_inner(app_type, &provider)
                .await?;

            if matches!(
                app_type_enum,
                AppType::Claude | AppType::Codex | AppType::Gemini
            ) {
                self.sync_live_from_provider_while_proxy_active(&app_type_enum, &provider)
                    .await?;
            } else if live_taken_over && matches!(app_type_enum, AppType::Codex) {
                self.sync_codex_live_from_provider_while_proxy_active(&provider)
                    .await?;
            }
        }

        if has_backup && !live_taken_over && matches!(app_type_enum, AppType::Codex) {
            let effective_settings = build_effective_settings_with_common_config(
                self.db.as_ref(),
                &AppType::Codex,
                &provider,
            )
            .map_err(|e| format!("构建 Codex 有效配置失败: {e}"))?;
            let auth = effective_settings
                .get("auth")
                .ok_or_else(|| "Codex 供应商缺少 auth 配置".to_string())?;
            let config_str = effective_settings.get("config").and_then(|v| v.as_str());

            crate::codex_config::write_codex_provider_live_with_catalog(
                &effective_settings,
                provider.category.as_deref(),
                auth,
                config_str,
            )
            .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;
        }

        if let Some(server) = self.server.read().await.as_ref() {
            server
                .set_active_target(app_type_enum.as_str(), &provider.id, &provider.name)
                .await;
            // 切换完成：把 epoch +1，保护后续请求不被旧 inflight 的成功回写覆盖。
            let new_epoch = server.bump_switch_epoch(app_type_enum.as_str()).await;
            log::debug!(
                "[hot_switch] {} switch_epoch -> {} (target={})",
                app_type_enum.as_str(),
                new_epoch,
                provider.id
            );
        }

        Ok(HotSwitchOutcome {
            logical_target_changed,
        })
    }

    #[cfg(test)]
    async fn lock_switch_for_test(&self, app_type: &str) -> tokio::sync::OwnedMutexGuard<()> {
        self.switch_locks.lock_for_app(app_type).await
    }

    fn preserve_codex_mcp_servers_from_existing_config(
        target_settings: &mut Value,
        existing_config: &Value,
    ) -> Result<(), String> {
        let target_obj = target_settings
            .as_object_mut()
            .ok_or_else(|| "Codex 备份必须是 JSON 对象".to_string())?;

        let target_config = target_obj
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut target_doc = if target_config.trim().is_empty() {
            toml_edit::DocumentMut::new()
        } else {
            target_config
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("解析新的 Codex config.toml 失败: {e}"))?
        };

        let existing_config = existing_config
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if existing_config.trim().is_empty() {
            target_obj.insert("config".to_string(), json!(target_doc.to_string()));
            return Ok(());
        }

        let existing_doc = existing_config
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("解析现有 Codex 备份失败: {e}"))?;

        if let Some(existing_mcp_servers) = existing_doc.get("mcp_servers") {
            match target_doc.get_mut("mcp_servers") {
                Some(target_mcp_servers) => {
                    if let (Some(target_table), Some(existing_table)) = (
                        target_mcp_servers.as_table_like_mut(),
                        existing_mcp_servers.as_table_like(),
                    ) {
                        for (server_id, server_item) in existing_table.iter() {
                            if target_table.get(server_id).is_none() {
                                target_table.insert(server_id, server_item.clone());
                            }
                        }
                    } else {
                        log::warn!(
                            "Codex config contains a non-table mcp_servers section; skipping MCP merge"
                        );
                    }
                }
                None => {
                    target_doc["mcp_servers"] = existing_mcp_servers.clone();
                }
            }
        }

        target_obj.insert("config".to_string(), json!(target_doc.to_string()));
        Ok(())
    }

    fn overlay_codex_mcp_servers_from_source(
        target_settings: &mut Value,
        source_settings: &Value,
    ) -> Result<(), String> {
        let target_obj = target_settings
            .as_object_mut()
            .ok_or_else(|| "Codex 备份必须是 JSON 对象".to_string())?;

        let target_config = target_obj
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut target_doc = if target_config.trim().is_empty() {
            toml_edit::DocumentMut::new()
        } else {
            target_config
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("解析新的 Codex config.toml 失败: {e}"))?
        };

        let source_config = source_settings
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if source_config.trim().is_empty() {
            return Ok(());
        }

        let source_doc = source_config
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("解析 Codex 源配置失败: {e}"))?;
        let Some(source_mcp_servers) = source_doc.get("mcp_servers") else {
            return Ok(());
        };

        if target_doc.get("mcp_servers").is_none() {
            target_doc["mcp_servers"] = toml_edit::table();
        }

        let target_mcp_servers = target_doc
            .get_mut("mcp_servers")
            .expect("mcp_servers should be available");
        let (Some(target_table), Some(source_table)) = (
            target_mcp_servers.as_table_like_mut(),
            source_mcp_servers.as_table_like(),
        ) else {
            return Ok(());
        };

        for (server_id, server_item) in source_table.iter() {
            target_table.insert(server_id, server_item.clone());
        }

        target_obj.insert("config".to_string(), json!(target_doc.to_string()));
        Ok(())
    }

    fn preserve_codex_oauth_auth_in_backup(
        target_settings: &mut Value,
        existing_backup: &Value,
    ) -> Result<(), String> {
        if !crate::settings::preserve_codex_official_auth_on_switch() {
            return Ok(());
        }

        let Some(existing_auth) = existing_backup
            .get("auth")
            .filter(|auth| crate::codex_config::codex_auth_has_oauth_login_material(auth))
            .cloned()
        else {
            return Ok(());
        };

        let Some(target_obj) = target_settings.as_object_mut() else {
            return Ok(());
        };

        let provider_auth = target_obj.get("auth").cloned().unwrap_or_else(|| json!({}));
        if let Some(config_text) = target_obj.get("config").and_then(|value| value.as_str()) {
            let live_config = crate::codex_config::prepare_codex_provider_live_config(
                &provider_auth,
                config_text,
            )
            .map_err(|e| format!("更新 Codex 备份配置失败: {e}"))?;
            target_obj.insert("config".to_string(), json!(live_config));
        }
        target_obj.insert("auth".to_string(), existing_auth);

        Ok(())
    }

    /// 代理模式下切换供应商（热切换，并按需刷新代理安全的 Live 显示字段）
    pub async fn switch_proxy_target(
        &self,
        app_type: &str,
        provider_id: &str,
    ) -> Result<(), String> {
        let app_config = self
            .db
            .get_proxy_config_for_app(app_type)
            .await
            .map_err(|e| format!("读取 {app_type} 代理配置失败: {e}"))?;

        if !app_config.enabled {
            return Err(format!("{app_type} 未开启代理接管，不能执行代理热切换"));
        }

        if app_config.auto_failover_enabled {
            let provider = self
                .db
                .get_provider_by_id(provider_id, app_type)
                .map_err(|e| format!("读取供应商失败: {e}"))?
                .ok_or_else(|| format!("供应商不存在: {provider_id}"))?;

            if provider.category.as_deref() == Some("official") {
                return Err(
                    "代理接管模式下不能切换到官方供应商 (Cannot switch to official provider during proxy takeover)"
                        .to_string(),
                );
            }

            self.reset_provider_recovery_state(&provider.id, app_type)
                .await?;
            self.set_active_target_only(app_type, &provider.id, &provider.name)
                .await;
            log::info!(
                "自动故障转移模式：仅更新 {} 的代理活动目标为 {}，不写 Live 配置",
                app_type,
                provider_id
            );
            return Ok(());
        }

        let outcome = self.hot_switch_provider(app_type, provider_id).await?;

        if outcome.logical_target_changed {
            log::info!("代理模式：已切换 {app_type} 的目标供应商为 {provider_id}");
        } else {
            log::debug!("代理模式：{app_type} 已对齐到目标供应商 {provider_id}");
        }
        Ok(())
    }

    // ==================== Live 配置读写辅助方法 ====================

    /// 更新 TOML 字符串中的 base_url（委托给 codex_config 共享实现）
    fn update_toml_base_url(toml_str: &str, new_url: &str) -> String {
        crate::codex_config::update_codex_toml_field(toml_str, "base_url", new_url)
            .unwrap_or_else(|_| toml_str.to_string())
    }

    /// 接管 Codex 时，本地客户端必须继续以 Responses wire API 访问代理。
    /// 真实上游是否走 Chat Completions 由 provider 配置决定，并在代理内部转换。
    fn apply_codex_proxy_toml_config_for_provider(
        toml_str: &str,
        proxy_url: &str,
        provider: Option<&Provider>,
    ) -> String {
        let updated = Self::update_toml_base_url(toml_str, proxy_url);
        let mut updated =
            crate::codex_config::update_codex_toml_field(&updated, "wire_api", "responses")
                .unwrap_or(updated);

        if let Some(upstream_model) =
            provider.and_then(crate::proxy::providers::codex_provider_upstream_model)
        {
            updated =
                crate::codex_config::update_codex_toml_field(&updated, "model", &upstream_model)
                    .unwrap_or(updated);
        }

        updated
    }

    fn attach_codex_model_catalog_from_provider(
        live_config: &mut Value,
        provider: Option<&Provider>,
    ) {
        let Some(provider) = provider else {
            return;
        };

        let model_catalog = provider
            .settings_config
            .get("modelCatalog")
            .cloned()
            .unwrap_or_else(|| json!({ "models": [] }));

        if let Some(root) = live_config.as_object_mut() {
            root.insert("modelCatalog".to_string(), model_catalog);
        }
    }

    fn read_claude_live(&self) -> Result<Value, String> {
        let path = get_claude_settings_path();
        if !path.exists() {
            return Err("Claude 配置文件不存在".to_string());
        }

        let mut value: Value =
            read_json_file(&path).map_err(|e| format!("读取 Claude 配置失败: {e}"))?;

        if value.is_null() {
            value = json!({});
        }

        if !value.is_object() {
            let kind = match &value {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                Value::Array(_) => "array",
                Value::Object(_) => "object",
            };
            return Err(format!(
                "Claude 配置文件格式错误：根节点必须是 JSON 对象（当前为 {kind}），路径: {}",
                path.display()
            ));
        }

        Ok(value)
    }

    fn write_claude_live(&self, config: &Value) -> Result<(), String> {
        let path = get_claude_settings_path();
        let settings = crate::services::provider::sanitize_claude_settings_for_live(config);
        write_json_file(&path, &settings).map_err(|e| format!("写入 Claude 配置失败: {e}"))
    }

    fn read_codex_live(&self) -> Result<Value, String> {
        crate::codex_config::read_codex_live_settings()
            .map_err(|e| format!("读取 Codex Live 配置失败: {e}"))
    }

    fn write_codex_live(&self, config: &Value) -> Result<(), String> {
        self.write_codex_live_verbatim(config)
    }

    fn write_codex_live_for_provider(
        &self,
        config: &Value,
        provider: Option<&Provider>,
    ) -> Result<(), String> {
        let Some(provider) = provider else {
            if crate::settings::preserve_codex_official_auth_on_switch() {
                if let (Some(auth), Some(config_str)) = (
                    config.get("auth"),
                    config.get("config").and_then(|v| v.as_str()),
                ) {
                    if auth.get("OPENAI_API_KEY").and_then(|v| v.as_str())
                        == Some(PROXY_TOKEN_PLACEHOLDER)
                    {
                        let live_config = crate::codex_config::prepare_codex_provider_live_config(
                            auth, config_str,
                        )
                        .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;
                        crate::codex_config::write_codex_live_config_atomic(Some(&live_config))
                            .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;
                        return Ok(());
                    }
                }
            }

            return self.write_codex_live_verbatim(config);
        };

        let auth = config
            .get("auth")
            .ok_or_else(|| "Codex 配置缺少 auth 字段".to_string())?;
        let config_str = config.get("config").and_then(|v| v.as_str());

        crate::codex_config::write_codex_provider_live_with_catalog(
            config,
            provider.category.as_deref(),
            auth,
            config_str,
        )
        .map_err(|e| format!("写入 Codex 配置失败: {e}"))
    }

    fn codex_auth_has_proxy_placeholder(auth: &Value) -> bool {
        auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER)
    }

    fn merge_codex_takeover_auth_with_existing_live_auth(auth: &Value) -> Result<Value, String> {
        let mut merged =
            crate::config::read_json_file::<Value>(&crate::codex_config::get_codex_auth_path())
                .ok()
                .filter(|value| value.is_object())
                .unwrap_or_else(|| json!({}));

        if !merged.is_object() {
            merged = json!({});
        }

        let Some(merged_obj) = merged.as_object_mut() else {
            return Ok(auth.clone());
        };

        if let Some(auth_obj) = auth.as_object() {
            for (key, value) in auth_obj {
                merged_obj.insert(key.clone(), value.clone());
            }
        } else {
            return Err("Codex 接管 auth 模板必须是 JSON 对象".to_string());
        }

        Ok(merged)
    }

    fn write_codex_takeover_live_for_provider(
        &self,
        config: &Value,
        provider: Option<&Provider>,
    ) -> Result<(), String> {
        let result = if !crate::settings::preserve_codex_official_auth_on_switch() {
            if let Some(auth) = config
                .get("auth")
                .filter(|auth| Self::codex_auth_has_proxy_placeholder(auth))
            {
                let mut config = config.clone();
                if let Some(root) = config.as_object_mut() {
                    root.insert(
                        "auth".to_string(),
                        Self::merge_codex_takeover_auth_with_existing_live_auth(auth)?,
                    );
                }
                self.write_codex_live_for_provider(&config, provider)
            } else {
                self.write_codex_live_for_provider(config, provider)
            }
        } else if crate::settings::preserve_codex_official_auth_on_switch() {
            if let Some(auth) = config
                .get("auth")
                .filter(|auth| Self::codex_auth_has_proxy_placeholder(auth))
            {
                let config_str = config.get("config").and_then(|v| v.as_str()).unwrap_or("");
                let prepared_config =
                    crate::codex_config::prepare_codex_live_config_text_with_optional_catalog(
                        config, config_str,
                    )
                    .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;
                let live_config =
                    crate::codex_config::prepare_codex_provider_live_config(auth, &prepared_config)
                        .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;
                crate::codex_config::write_codex_live_config_atomic(Some(&live_config))
                    .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;
                Ok(())
            } else {
                self.write_codex_live_for_provider(config, provider)
            }
        } else {
            self.write_codex_live_for_provider(config, provider)
        };

        result?;
        if let Err(error) = self
            .db
            .set_live_owner_provider_id(AppType::Codex.as_str(), None)
        {
            log::warn!("清理 Codex takeover live owner 锚点失败: {error}");
        }
        Ok(())
    }

    fn write_codex_live_verbatim(&self, config: &Value) -> Result<(), String> {
        use crate::codex_config::{get_codex_auth_path, get_codex_config_path};

        let auth = config.get("auth");
        let config_str = config.get("config").and_then(|v| v.as_str());

        // Decide the config.toml text ONCE, before splitting on auth. A stored
        // Codex backup comes in two shapes needing opposite handling:
        //  - snapshot backup (`read_codex_live_settings`): no inline `modelCatalog`;
        //    the config text already carries the live `model_catalog_json` pointer
        //    → keep raw, or projection would strip it.
        //  - provider-rebuilt backup (`update_live_backup_from_provider`): inline
        //    `modelCatalog` (DB SSOT) with a pointer-less config text → project,
        //    or the mapping is lost on restore.
        // The projection decision is orthogonal to auth: a provider-rebuilt backup
        // can pair an inline `modelCatalog` with empty/absent `auth.json` (the key
        // living in the config's `experimental_bearer_token`). Computing it up here
        // keeps every config-writing branch — write-auth, delete-auth, no-auth —
        // consistent instead of letting the empty-auth path skip projection.
        let prepared_cfg = config_str
            .map(|cfg| {
                crate::codex_config::prepare_codex_live_config_text_with_optional_catalog(
                    config, cfg,
                )
            })
            .transpose()
            .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;

        match (auth, prepared_cfg.as_deref()) {
            (Some(auth), Some(cfg)) => {
                let auth_path = get_codex_auth_path();
                if auth.as_object().is_some_and(|obj| obj.is_empty()) {
                    let _ = crate::config::delete_file(&auth_path);
                    let config_path = get_codex_config_path();
                    crate::config::write_text_file(&config_path, cfg)
                        .map_err(|e| format!("写入 Codex config 失败: {e}"))?;
                } else {
                    crate::codex_config::write_codex_live_atomic(auth, Some(cfg))
                        .map_err(|e| format!("写入 Codex 配置失败: {e}"))?;
                }
            }
            (Some(auth), None) => {
                let auth_path = get_codex_auth_path();
                write_json_file(&auth_path, auth)
                    .map_err(|e| format!("写入 Codex auth 失败: {e}"))?;
            }
            (None, Some(cfg)) => {
                let config_path = get_codex_config_path();
                crate::config::write_text_file(&config_path, cfg)
                    .map_err(|e| format!("写入 Codex config 失败: {e}"))?;
            }
            (None, None) => {}
        }

        Ok(())
    }

    fn read_gemini_live(&self) -> Result<Value, String> {
        use crate::gemini_config::{
            env_to_json, get_gemini_env_path, get_gemini_settings_path, read_gemini_env,
            read_gemini_env_text, GEMINI_RENDERED_ENV_TEXT_FIELD,
        };

        let env_path = get_gemini_env_path();
        if !env_path.exists() {
            return Err("Gemini .env 文件不存在".to_string());
        }

        let env_map = read_gemini_env().map_err(|e| format!("读取 Gemini env 失败: {e}"))?;
        let mut config = env_to_json(&env_map);
        let settings_path = get_gemini_settings_path();
        let settings_value = if settings_path.exists() {
            read_json_file(&settings_path).map_err(|e| format!("读取 Gemini settings 失败: {e}"))?
        } else {
            json!({})
        };

        if let Some(obj) = config.as_object_mut() {
            obj.insert("config".to_string(), settings_value);
            let env_text =
                read_gemini_env_text().map_err(|e| format!("读取 Gemini env 文本失败: {e}"))?;
            if !env_text.is_empty() {
                obj.insert(
                    GEMINI_RENDERED_ENV_TEXT_FIELD.to_string(),
                    Value::String(env_text),
                );
            }
        }

        Ok(config)
    }

    fn write_gemini_live(&self, config: &Value) -> Result<(), String> {
        use crate::gemini_config::{
            env_text_matches_map, get_gemini_settings_path, json_to_env, write_gemini_env_atomic,
            write_gemini_env_text_atomic, GEMINI_RENDERED_ENV_TEXT_FIELD,
        };

        let env_map = json_to_env(config).map_err(|e| format!("转换 Gemini 配置失败: {e}"))?;
        let rendered_env_text = config
            .get(GEMINI_RENDERED_ENV_TEXT_FIELD)
            .and_then(|v| v.as_str());
        let can_write_rendered_env_text = rendered_env_text
            .map(|content| env_text_matches_map(content, &env_map))
            .transpose()
            .map_err(|e| format!("校验 Gemini env 文本失败: {e}"))?
            .unwrap_or(false);

        if can_write_rendered_env_text {
            write_gemini_env_text_atomic(rendered_env_text.unwrap_or_default())
                .map_err(|e| format!("写入 Gemini env 失败: {e}"))?;
        } else {
            write_gemini_env_atomic(&env_map).map_err(|e| format!("写入 Gemini env 失败: {e}"))?;
        }

        let settings_path = get_gemini_settings_path();
        match config.get("config") {
            Some(Value::Object(_)) => {
                write_json_file(&settings_path, &config["config"])
                    .map_err(|e| format!("写入 Gemini settings 失败: {e}"))?;
            }
            Some(Value::Null) => {
                settings_path
                    .exists()
                    .then(|| delete_file(&settings_path))
                    .transpose()
                    .map_err(|e| format!("删除 Gemini settings 失败: {e}"))?;
            }
            Some(_) => {
                return Err(
                    "Gemini settings.json 配置格式错误：config 必须是对象或 null".to_string(),
                );
            }
            None => {}
        }

        Ok(())
    }

    // ==================== 原有方法 ====================

    /// 获取服务器状态
    pub async fn get_status(&self) -> Result<ProxyStatus, String> {
        if let Some(server) = self.server.read().await.as_ref() {
            Ok(server.get_status().await)
        } else {
            // 服务器未运行时返回默认状态
            Ok(ProxyStatus {
                running: false,
                ..Default::default()
            })
        }
    }

    /// 获取代理配置
    pub async fn get_config(&self) -> Result<ProxyConfig, String> {
        self.db
            .get_proxy_config()
            .await
            .map_err(|e| format!("获取代理配置失败: {e}"))
    }

    /// 更新代理配置
    pub async fn update_config(&self, config: &ProxyConfig) -> Result<(), String> {
        // 记录旧配置用于判定是否需要重启
        let previous = self
            .db
            .get_proxy_config()
            .await
            .map_err(|e| format!("获取代理配置失败: {e}"))?;

        // 保存到数据库（保持 live_takeover_active 状态不变）
        let mut new_config = config.clone();
        new_config.live_takeover_active = previous.live_takeover_active;

        self.db
            .update_proxy_config(new_config.clone())
            .await
            .map_err(|e| format!("保存代理配置失败: {e}"))?;

        // 检查服务器当前状态
        let mut server_guard = self.server.write().await;
        if server_guard.is_none() {
            return Ok(());
        }

        // 判断是否需要重启（地址或端口变更）
        let require_restart = new_config.listen_address != previous.listen_address
            || new_config.listen_port != previous.listen_port;

        if require_restart {
            if let Some(server) = server_guard.take() {
                server
                    .stop()
                    .await
                    .map_err(|e| format!("重启前停止代理服务器失败: {e}"))?;
            }

            let app_handle = self.app_handle.read().await.clone();
            let new_server = ProxyServer::new(new_config, self.db.clone(), app_handle);
            new_server
                .start()
                .await
                .map_err(|e| format!("重启代理服务器失败: {e}"))?;

            *server_guard = Some(new_server);
            log::info!("代理配置已更新，服务器已自动重启应用最新配置");

            // 如果当前存在任意 app 的 Live 接管，需要同步更新 Live 中的代理地址（否则客户端仍指向旧端口）
            drop(server_guard);
            if let Ok(takeover) = self.get_takeover_status().await {
                let mut updated_any = false;

                if takeover.claude {
                    self.takeover_live_config_best_effort(&AppType::Claude)
                        .await?;
                    updated_any = true;
                }
                if takeover.codex {
                    self.takeover_live_config_best_effort(&AppType::Codex)
                        .await?;
                    updated_any = true;
                }
                if takeover.gemini {
                    self.takeover_live_config_best_effort(&AppType::Gemini)
                        .await?;
                    updated_any = true;
                }

                if updated_any {
                    log::info!("已同步更新 Live 配置中的代理地址");
                }
            }

            return Ok(());
        } else if let Some(server) = server_guard.as_ref() {
            server.apply_runtime_config(&new_config).await;
            log::info!("代理配置已实时应用，无需重启代理服务器");
        }

        Ok(())
    }

    /// 检查服务器是否正在运行
    pub async fn is_running(&self) -> bool {
        self.server.read().await.is_some()
    }

    /// 仅更新代理服务器内存中的"活动目标"显示，不写 DB.is_current 也不写本地 settings。
    ///
    /// 用于"故障转移开启"场景：路由层只需要 active_targets 在 UI/托盘上反映 P1，
    /// 不应再有当前供应商概念。
    ///
    /// 同时也会 bump 该应用的 switch_epoch，让先前处于 inflight 的旧请求不会再倒写状态。
    pub async fn set_active_target_only(
        &self,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
    ) {
        if let Some(server) = self.server.read().await.as_ref() {
            server
                .set_active_target(app_type, provider_id, provider_name)
                .await;
            let _ = server.bump_switch_epoch(app_type).await;
        }
    }

    pub async fn clear_active_target_only(&self, app_type: &str) {
        if let Some(server) = self.server.read().await.as_ref() {
            server.clear_active_target(app_type).await;
            let _ = server.bump_switch_epoch(app_type).await;
        }
    }

    pub async fn sync_failover_active_target(&self, app_type: &str) -> Result<(), String> {
        let app_config = self
            .db
            .get_proxy_config_for_app(app_type)
            .await
            .map_err(|e| format!("读取 {app_type} 代理配置失败: {e}"))?;

        if !self.is_running().await {
            return Ok(());
        }

        if !app_config.enabled || !app_config.auto_failover_enabled {
            self.clear_active_target_only(app_type).await;
            return Ok(());
        }

        let next_provider = self
            .db
            .get_failover_queue(app_type)
            .map_err(|e| format!("读取 {app_type} 故障转移队列失败: {e}"))?
            .into_iter()
            .next();

        if let Some(provider) = next_provider {
            self.set_active_target_only(app_type, &provider.provider_id, &provider.provider_name)
                .await;
        } else {
            self.clear_active_target_only(app_type).await;
        }

        if let Ok(app_enum) = AppType::from_str(app_type) {
            let _ = self.repair_takeover_runtime_state(&app_enum).await;
        }

        Ok(())
    }

    /// 热更新熔断器配置
    ///
    /// 如果代理服务器正在运行，将新配置应用到所有已创建的熔断器实例
    pub async fn update_circuit_breaker_configs(
        &self,
        config: crate::proxy::CircuitBreakerConfig,
    ) -> Result<(), String> {
        if let Some(server) = self.server.read().await.as_ref() {
            server.update_circuit_breaker_configs(config).await;
            log::info!("已热更新运行中的熔断器配置");
        } else {
            log::debug!("代理服务器未运行，熔断器配置将在下次启动时生效");
        }
        Ok(())
    }

    pub async fn reset_provider_recovery_state(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<(), String> {
        self.db
            .reset_provider_health(provider_id, app_type)
            .await
            .map_err(|e| format!("重置 Provider {provider_id} ({app_type}) 健康状态失败: {e}"))?;
        self.reset_provider_circuit_breaker(provider_id, app_type)
            .await?;
        Ok(())
    }

    /// 热更新指定应用的熔断器配置
    pub async fn update_circuit_breaker_config_for_app(
        &self,
        app_type: &str,
        config: crate::proxy::CircuitBreakerConfig,
    ) -> Result<(), String> {
        if let Some(server) = self.server.read().await.as_ref() {
            server
                .update_circuit_breaker_config_for_app(app_type, config)
                .await;
            log::info!("已热更新 {app_type} 运行中的熔断器配置");
        } else {
            log::debug!("{app_type} 熔断器配置将在下次代理启动时生效");
        }
        Ok(())
    }

    /// 重置指定 Provider 的熔断器
    ///
    /// 如果代理服务器正在运行，立即重置内存中的熔断器状态
    pub async fn reset_provider_circuit_breaker(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<(), String> {
        if let Some(server) = self.server.read().await.as_ref() {
            server
                .reset_provider_circuit_breaker(provider_id, app_type)
                .await;
            log::info!("已重置 Provider {provider_id} (app: {app_type}) 的熔断器");
        }
        Ok(())
    }

    pub async fn clear_provider_runtime_state(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<(), String> {
        if let Some(server) = self.server.read().await.as_ref() {
            server
                .clear_provider_runtime_state(provider_id, app_type)
                .await;
            // 禁用/删除供应商也是一次"路由目标变化"，bump epoch 防止该供应商上正在跑的
            // 旧请求成功后回写 current_providers / 状态。
            let _ = server.bump_switch_epoch(app_type).await;
        }
        Ok(())
    }

    /// 供应商被禁用/删除后，清理运行态并推动故障转移目标重新对齐。
    pub async fn reconcile_failover_after_provider_removal(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<(), String> {
        self.clear_provider_runtime_state(provider_id, app_type)
            .await?;
        self.sync_failover_active_target(app_type).await
    }

    /// 读取运行中代理服务器里的 Provider 熔断器统计。
    pub async fn get_circuit_breaker_stats(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<Option<crate::proxy::CircuitBreakerStats>, String> {
        if let Some(server) = self.server.read().await.as_ref() {
            return Ok(server
                .get_circuit_breaker_stats(provider_id, app_type)
                .await);
        }
        Ok(None)
    }

    pub async fn get_raw_logs(
        &self,
        limit: usize,
        app_type: Option<&str>,
    ) -> Result<Vec<crate::proxy::types::ProxyRawLogEntry>, String> {
        if let Some(server) = self.server.read().await.as_ref() {
            return Ok(server.get_raw_logs(limit, app_type).await);
        }
        Ok(Vec::new())
    }

    pub async fn set_raw_log_retention_minutes(&self, minutes: u64) -> Result<(), String> {
        if let Some(server) = self.server.read().await.as_ref() {
            server.set_raw_log_retention_minutes(minutes).await;
            log::info!("已更新运行中的代理原始日志保留时间: {minutes} 分钟");
        } else {
            log::debug!("代理服务器未运行，代理原始日志保留时间将在下次启动时生效");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;
    use axum::{body::Body, routing::post, Router};
    use bytes::Bytes;
    use futures::StreamExt;
    use serial_test::serial;
    use std::convert::Infallible;
    use std::env;
    use tempfile::TempDir;
    use tokio::task::JoinHandle;
    use tokio::time::{sleep, Duration};

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

    async fn unused_local_port() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local ephemeral port");
        listener.local_addr().expect("read local addr").port()
    }

    async fn start_mock_codex_responses_stream_server() -> (String, JoinHandle<()>) {
        let app = Router::new().route(
            "/v1/responses",
            post(|| async move {
                let stream = async_stream::stream! {
                    yield Ok::<Bytes, Infallible>(Bytes::from(
                        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_live_1\",\"model\":\"gpt-5.3-codex\"}}\n\n",
                    ));
                    sleep(Duration::from_millis(250)).await;
                    yield Ok::<Bytes, Infallible>(Bytes::from(
                        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_live_1\",\"model\":\"gpt-5.3-codex\",\"usage\":{\"input_tokens\":12,\"output_tokens\":3}}}\n\n",
                    ));
                    yield Ok::<Bytes, Infallible>(Bytes::from("data: [DONE]\n\n"));
                };

                axum::response::Response::builder()
                    .status(200)
                    .header(axum::http::header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from_stream(stream))
                    .expect("build mock SSE response")
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("run mock upstream server");
        });

        (format!("http://{addr}"), handle)
    }

    fn assert_env_str(env: &Map<String, Value>, key: &str, expected: Option<&str>) {
        assert_eq!(env.get(key).and_then(|value| value.as_str()), expected);
    }

    fn seed_codex_model_template() {
        let codex_dir = crate::codex_config::get_codex_config_dir();
        std::fs::create_dir_all(&codex_dir).expect("create codex dir");
        std::fs::write(
            codex_dir.join("models_cache.json"),
            serde_json::to_string(&serde_json::json!({
                "models": [{
                    "slug": "gpt-5.5",
                    "display_name": "GPT-5.5",
                    "model_messages": { "instructions_template": "t" },
                    "additional_speed_tiers": [],
                    "context_window": 128000
                }]
            }))
            .expect("serialize models_cache"),
        )
        .expect("write models_cache.json");
    }

    #[test]
    fn managed_account_claude_takeover_uses_api_key_placeholder() {
        let mut provider = Provider::with_id(
            "copilot".to_string(),
            "GitHub Copilot".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://api.githubcopilot.com",
                    "ANTHROPIC_MODEL": "claude-haiku-4.5"
                }
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            provider_type: Some("github_copilot".to_string()),
            ..Default::default()
        });

        let mut live_config = provider.settings_config.clone();
        ProxyService::apply_claude_takeover_fields_for_provider(
            &mut live_config,
            "http://127.0.0.1:15721",
            &provider,
        );

        let env = live_config
            .get("env")
            .and_then(|value| value.as_object())
            .expect("env should exist");
        assert_eq!(
            env.get("ANTHROPIC_API_KEY")
                .and_then(|value| value.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER)
        );
        assert!(
            env.get("ANTHROPIC_AUTH_TOKEN").is_none(),
            "managed OAuth providers should avoid Claude Auth Token login semantics"
        );
    }

    #[test]
    fn managed_account_claude_takeover_sources_copilot_models_from_provider() {
        let mut provider = Provider::with_id(
            "copilot".to_string(),
            "GitHub Copilot".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://api.githubcopilot.com",
                    "ANTHROPIC_MODEL": "claude-sonnet-4.6",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-sonnet-4.6"
                }
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            provider_type: Some("github_copilot".to_string()),
            ..Default::default()
        });

        let mut live_config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://stale.example.com",
                "ANTHROPIC_API_KEY": "stale-key",
                "ANTHROPIC_MODEL": "stale-model",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "stale-haiku",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "Stale Haiku",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "stale-sonnet",
                "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Stale Sonnet",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "stale-opus",
                "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Stale Opus"
            }
        });
        ProxyService::apply_claude_takeover_fields_for_provider(
            &mut live_config,
            "http://127.0.0.1:15721",
            &provider,
        );

        let env = live_config
            .get("env")
            .and_then(|value| value.as_object())
            .expect("env should exist");
        assert_env_str(env, "ANTHROPIC_MODEL", None);
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            Some("claude-haiku-4-5"),
        );
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            Some("claude-haiku-4.5"),
        );
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            Some("claude-sonnet-4-6"),
        );
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            Some("claude-sonnet-4.6"),
        );
        assert_env_str(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", Some("claude-opus-4-8"));
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            Some("claude-sonnet-4.6"),
        );
        assert_env_str(env, "ANTHROPIC_API_KEY", Some(PROXY_TOKEN_PLACEHOLDER));
        assert_env_str(env, "ANTHROPIC_AUTH_TOKEN", None);
    }

    #[test]
    fn managed_account_claude_takeover_sources_codex_models_from_provider() {
        let mut provider = Provider::with_id(
            "codex".to_string(),
            "Codex".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://chatgpt.com/backend-api/codex",
                    "ANTHROPIC_MODEL": "gpt-5.4",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5.4-mini",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.4",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.4"
                }
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            provider_type: Some("codex_oauth".to_string()),
            ..Default::default()
        });

        let mut live_config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://stale.example.com",
                "ANTHROPIC_AUTH_TOKEN": "stale-token",
                "ANTHROPIC_MODEL": "stale-model",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "stale-haiku",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "Stale Haiku",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "stale-sonnet",
                "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Stale Sonnet",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "stale-opus",
                "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Stale Opus"
            }
        });
        ProxyService::apply_claude_takeover_fields_for_provider(
            &mut live_config,
            "http://127.0.0.1:15721",
            &provider,
        );

        let env = live_config
            .get("env")
            .and_then(|value| value.as_object())
            .expect("env should exist");
        assert_env_str(env, "ANTHROPIC_MODEL", None);
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            Some("claude-haiku-4-5"),
        );
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            Some("gpt-5.4-mini"),
        );
        assert_env_str(
            env,
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            Some("claude-sonnet-4-6"),
        );
        assert_env_str(env, "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", Some("gpt-5.4"));
        assert_env_str(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", Some("claude-opus-4-8"));
        assert_env_str(env, "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", Some("gpt-5.4"));
        assert_env_str(env, "ANTHROPIC_API_KEY", Some(PROXY_TOKEN_PLACEHOLDER));
        assert_env_str(env, "ANTHROPIC_AUTH_TOKEN", None);
    }

    #[test]
    fn normal_claude_takeover_without_token_keeps_auth_token_fallback() {
        let mut live_config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://api.example.com",
                "ANTHROPIC_MODEL": "claude-haiku-4.5"
            }
        });

        ProxyService::apply_claude_takeover_fields(
            &mut live_config,
            "http://127.0.0.1:15721",
            None,
        );

        assert_eq!(
            live_config
                .get("env")
                .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
                .and_then(|value| value.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER)
        );
        assert!(
            live_config
                .get("env")
                .and_then(|env| env.get("ANTHROPIC_API_KEY"))
                .is_none(),
            "non-managed providers should retain the legacy fallback behavior"
        );
    }

    async fn start_mock_claude_messages_error_server() -> (String, JoinHandle<()>) {
        let app = Router::new().route(
            "/v1/messages",
            post(|| async move {
                axum::response::Response::builder()
                    .status(500)
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"error":{"type":"upstream_error","message":"forced failure"}}"#,
                    ))
                    .expect("build mock error response")
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("run mock upstream server");
        });

        (format!("http://{addr}"), handle)
    }

    async fn start_mock_codex_responses_error_server() -> (String, JoinHandle<()>) {
        let app = Router::new().route(
            "/v1/responses",
            post(|| async move {
                axum::response::Response::builder()
                    .status(500)
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"error":{"type":"server_error","message":"forced failure"}}"#,
                    ))
                    .expect("build mock error response")
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("run mock upstream server");
        });

        (format!("http://{addr}"), handle)
    }

    async fn start_mock_codex_responses_success_server() -> (String, JoinHandle<()>) {
        let app = Router::new().route(
            "/v1/responses",
            post(|| async move {
                axum::response::Response::builder()
                    .status(200)
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"id":"resp_success_b","object":"response","model":"gpt-5.4","output":[]}"#,
                    ))
                    .expect("build mock success response")
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("run mock upstream server");
        });

        (format!("http://{addr}"), handle)
    }

    async fn start_mock_gemini_error_server() -> (String, JoinHandle<()>) {
        let app = Router::new().route(
            "/v1beta/*path",
            post(|| async move {
                axum::response::Response::builder()
                    .status(500)
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"error":{"code":500,"status":"INTERNAL","message":"forced failure"}}"#,
                    ))
                    .expect("build mock Gemini error response")
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock Gemini upstream");
        let addr = listener.local_addr().expect("mock Gemini local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("run mock Gemini upstream server");
        });

        (format!("http://{addr}"), handle)
    }

    #[test]
    #[serial]
    fn codex_custom_provider_live_write_preserves_oauth_auth_json() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: true,
            ..Default::default()
        })
        .expect("enable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db);
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        crate::codex_config::write_codex_live_atomic(
            &oauth_auth,
            Some(
                r#"model_provider = "openai"
model = "gpt-5-codex"
"#,
            ),
        )
        .expect("seed live OAuth auth");

        let mut provider = Provider::with_id(
            "rightcode".to_string(),
            "RightCode".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "rightcode-key"
                },
                "config": r#"model_provider = "rightcode"
model = "gpt-5-codex"

[model_providers.rightcode]
name = "RightCode"
base_url = "https://rightcode.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("custom".to_string());
        let takeover_settings = json!({
            "auth": {
                "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
            },
            "config": r#"model_provider = "rightcode"
model = "gpt-5-codex"

[model_providers.rightcode]
name = "RightCode"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
"#
        });

        service
            .write_codex_live_for_provider(&takeover_settings, Some(&provider))
            .expect("write provider-driven Codex live config");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "third-party Codex proxy writes must not overwrite ChatGPT OAuth login state"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            live_config.contains("experimental_bearer_token"),
            "proxy placeholder should move into config.toml instead of auth.json"
        );
        assert!(
            live_config.contains(PROXY_TOKEN_PLACEHOLDER),
            "live config should carry the proxy placeholder token"
        );

        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[tokio::test]
    #[serial]
    async fn codex_takeover_preserves_oauth_auth_json_when_preserve_enabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: true,
            ..Default::default()
        })
        .expect("enable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        let service = ProxyService::new(db.clone());
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        let deepseek_live_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
experimental_bearer_token = "deepseek-key"
"#;
        crate::codex_config::write_codex_live_atomic(&oauth_auth, Some(deepseek_live_config))
            .expect("seed live OAuth auth with DeepSeek config");

        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("cn_official".to_string());
        db.save_provider("codex", &provider)
            .expect("save DeepSeek provider");
        db.set_current_provider("codex", "deepseek")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("deepseek"))
            .expect("set local current provider");

        service
            .takeover_live_config_strict(&AppType::Codex)
            .await
            .expect("take over Codex live config");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "Codex takeover should not overwrite ChatGPT OAuth auth when preservation is enabled"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            live_config.contains(PROXY_TOKEN_PLACEHOLDER),
            "takeover placeholder should move into config.toml"
        );
        assert!(
            service.detect_takeover_in_live_config_for_app(&AppType::Codex),
            "Codex takeover detection should recognize config.toml placeholders"
        );

        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[tokio::test]
    #[serial]
    async fn codex_takeover_preserves_oauth_auth_json_even_when_provider_category_is_official() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: true,
            ..Default::default()
        })
        .expect("enable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        let service = ProxyService::new(db.clone());
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        let deepseek_live_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
experimental_bearer_token = "deepseek-key"
"#;
        crate::codex_config::write_codex_live_atomic(&oauth_auth, Some(deepseek_live_config))
            .expect("seed live OAuth auth with DeepSeek config");

        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("official".to_string());
        db.save_provider("codex", &provider)
            .expect("save misclassified DeepSeek provider");
        db.set_current_provider("codex", "deepseek")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("deepseek"))
            .expect("set local current provider");

        service
            .takeover_live_config_strict(&AppType::Codex)
            .await
            .expect("take over Codex live config");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "Codex takeover must not rewrite auth.json when preservation is enabled, even if provider category is stale or misclassified"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            live_config.contains(PROXY_TOKEN_PLACEHOLDER),
            "takeover placeholder should move into config.toml"
        );

        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[tokio::test]
    #[serial]
    async fn codex_set_takeover_for_app_preserves_oauth_auth_json_when_preserve_enabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: true,
            ..Default::default()
        })
        .expect("enable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        let service = ProxyService::new(db.clone());
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        let deepseek_live_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
experimental_bearer_token = "deepseek-key"
"#;
        crate::codex_config::write_codex_live_atomic(&oauth_auth, Some(deepseek_live_config))
            .expect("seed live OAuth auth with DeepSeek config");

        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("official".to_string());
        db.save_provider("codex", &provider)
            .expect("save misclassified DeepSeek provider");
        db.set_current_provider("codex", "deepseek")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("deepseek"))
            .expect("set local current provider");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("enable Codex takeover");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "the public takeover command path must not rewrite auth.json when preservation is enabled"
        );

        service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable Codex takeover");
        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[tokio::test]
    #[serial]
    async fn codex_sync_current_to_live_during_takeover_preserves_oauth_auth_json() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: true,
            ..Default::default()
        })
        .expect("enable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        let state = crate::store::AppState::new(db.clone());
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        let deepseek_live_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
experimental_bearer_token = "deepseek-key"
"#;
        crate::codex_config::write_codex_live_atomic(&oauth_auth, Some(deepseek_live_config))
            .expect("seed live OAuth auth with DeepSeek config");

        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("official".to_string());
        db.save_provider("codex", &provider)
            .expect("save misclassified DeepSeek provider");
        db.set_current_provider("codex", "deepseek")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("deepseek"))
            .expect("set local current provider");

        state
            .proxy_service
            .set_takeover_for_app("codex", true)
            .await
            .expect("enable Codex takeover");

        crate::services::provider::ProviderService::sync_current_to_live(&state)
            .expect("sync current providers while Codex is taken over");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "post-change provider sync must not rewrite Codex auth.json during takeover"
        );

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let backup_value: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup");
        assert_eq!(
            backup_value.get("auth"),
            Some(&oauth_auth),
            "provider-derived takeover backup should preserve official OAuth auth"
        );
        assert!(
            backup_value
                .get("config")
                .and_then(|value| value.as_str())
                .is_some_and(|config| config.contains("deepseek-key")),
            "provider token should be carried by config.toml in the restore backup"
        );

        state
            .proxy_service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable Codex takeover");
        let restored_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read restored auth");
        assert_eq!(
            restored_auth, oauth_auth,
            "turning takeover off should restore the preserved official OAuth auth"
        );

        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[tokio::test]
    #[serial]
    async fn codex_sync_current_to_live_during_takeover_activation_keeps_proxy_live_config() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: true,
            ..Default::default()
        })
        .expect("enable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let state = crate::store::AppState::new(db.clone());
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        let deepseek_live_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
experimental_bearer_token = "deepseek-key"
"#;
        crate::codex_config::write_codex_live_atomic(&oauth_auth, Some(deepseek_live_config))
            .expect("seed live OAuth auth with DeepSeek config");

        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("official".to_string());
        db.save_provider("codex", &provider)
            .expect("save misclassified DeepSeek provider");
        db.set_current_provider("codex", "deepseek")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("deepseek"))
            .expect("set local current provider");

        state
            .proxy_service
            .backup_live_config_strict(&AppType::Codex)
            .await
            .expect("backup Codex live config");
        state
            .proxy_service
            .takeover_live_config_strict(&AppType::Codex)
            .await
            .expect("take over Codex live config");
        assert!(
            !db.get_proxy_config_for_app("codex")
                .await
                .expect("get Codex proxy config")
                .enabled,
            "this reproduces the activation window before set_takeover_for_app marks enabled=true"
        );

        crate::services::provider::ProviderService::sync_current_to_live(&state)
            .expect("sync current providers during takeover activation");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "activation-time provider sync must not rewrite Codex OAuth auth.json"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            live_config.contains(PROXY_TOKEN_PLACEHOLDER),
            "activation-time provider sync must keep the proxy bearer placeholder"
        );
        assert!(
            live_config.contains("http://127.0.0.1"),
            "activation-time provider sync must keep the local proxy base_url"
        );
        assert!(
            state
                .proxy_service
                .detect_takeover_in_live_config_for_app(&AppType::Codex),
            "Codex live config should still be detected as taken over"
        );

        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[tokio::test]
    #[serial]
    async fn codex_set_takeover_rebuilds_stale_enabled_state_without_overwriting_backup() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: true,
            ..Default::default()
        })
        .expect("enable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        let service = ProxyService::new(db.clone());
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        let original_deepseek_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
experimental_bearer_token = "deepseek-key"
"#;
        let stale_live_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
experimental_bearer_token = "PROXY_MANAGED"
"#;
        crate::codex_config::write_codex_live_atomic(&oauth_auth, Some(stale_live_config))
            .expect("seed stale Codex live config");

        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("official".to_string());
        db.save_provider("codex", &provider)
            .expect("save misclassified DeepSeek provider");
        db.set_current_provider("codex", "deepseek")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("deepseek"))
            .expect("set local current provider");
        db.save_live_backup(
            "codex",
            &serde_json::to_string(&json!({
                "auth": oauth_auth,
                "config": original_deepseek_config
            }))
            .expect("serialize original backup"),
        )
        .await
        .expect("seed original live backup");
        let mut proxy_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get Codex proxy config");
        proxy_config.enabled = true;
        db.update_proxy_config_for_app(proxy_config)
            .await
            .expect("mark Codex takeover enabled");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("rebuild Codex takeover");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "repairing stale takeover must restore the preserved OAuth auth from backup"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            live_config.contains(&format!("http://127.0.0.1:{proxy_port}/v1")),
            "stale enabled takeover must be rebuilt to the current proxy base_url"
        );
        assert!(
            live_config.contains(PROXY_TOKEN_PLACEHOLDER),
            "rebuilt takeover should keep the proxy bearer placeholder"
        );
        assert!(
            service
                .live_takeover_matches_current_proxy(&AppType::Codex)
                .await
                .expect("detect rebuilt Codex takeover"),
            "rebuilt Codex live config should match the active proxy address"
        );

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get Codex live backup")
            .expect("backup exists");
        let backup_value: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup");
        assert_eq!(
            backup_value.get("auth"),
            Some(&oauth_auth),
            "rebuilding stale takeover must not overwrite the original OAuth backup"
        );
        assert!(
            backup_value
                .get("config")
                .and_then(|value| value.as_str())
                .is_some_and(|config| config.contains("deepseek-key")
                    && !config.contains("http://127.0.0.1")),
            "backup should remain the restorable DeepSeek config, not the proxy config"
        );

        service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable Codex takeover");
        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[tokio::test]
    #[serial]
    async fn codex_takeover_preserve_disabled_uses_legacy_auth_write_path() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: false,
            ..Default::default()
        })
        .expect("disable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        let deepseek_live_config = r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#;
        crate::codex_config::write_codex_live_atomic(&oauth_auth, Some(deepseek_live_config))
            .expect("seed live OAuth auth with DeepSeek config");

        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("cn_official".to_string());
        db.save_provider("codex", &provider)
            .expect("save DeepSeek provider");
        db.set_current_provider("codex", "deepseek")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("deepseek"))
            .expect("set local current provider");

        service
            .takeover_live_config_strict(&AppType::Codex)
            .await
            .expect("take over Codex live config");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth
                .get("OPENAI_API_KEY")
                .and_then(|value| value.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "disabled preservation should keep the legacy auth.json takeover placeholder"
        );
        assert_eq!(
            live_auth
                .get("tokens")
                .and_then(|tokens| tokens.get("access_token"))
                .and_then(|value| value.as_str()),
            Some("oauth-access"),
            "the new config-only takeover branch must not run when preservation is disabled"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            !live_config.contains(PROXY_TOKEN_PLACEHOLDER),
            "disabled preservation should not move the takeover placeholder into config.toml"
        );

        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[test]
    #[serial]
    fn codex_takeover_cleanup_removes_config_placeholder_without_touching_oauth_auth() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db);
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        crate::codex_config::write_codex_live_atomic(
            &oauth_auth,
            Some(
                r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
experimental_bearer_token = "PROXY_MANAGED"
"#,
            ),
        )
        .expect("seed taken-over Codex live config");

        assert!(
            service.detect_takeover_in_live_config_for_app(&AppType::Codex),
            "config.toml placeholder should be detected before cleanup"
        );

        service
            .cleanup_codex_takeover_placeholders_in_live()
            .expect("cleanup Codex takeover placeholders");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth, oauth_auth,
            "cleanup should preserve ChatGPT OAuth auth"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            !live_config.contains(PROXY_TOKEN_PLACEHOLDER),
            "cleanup should remove config.toml proxy bearer placeholder"
        );
        assert!(
            !live_config.contains("http://127.0.0.1:15721"),
            "cleanup should remove local proxy base_url"
        );
    }

    #[test]
    #[serial]
    fn codex_custom_provider_live_write_can_overwrite_auth_when_preserve_disabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: false,
            ..Default::default()
        })
        .expect("disable Codex official auth preservation");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db);
        let oauth_auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "oauth-id",
                "access_token": "oauth-access"
            }
        });
        crate::codex_config::write_codex_live_atomic(
            &oauth_auth,
            Some(
                r#"model_provider = "openai"
model = "gpt-5-codex"
"#,
            ),
        )
        .expect("seed live OAuth auth");

        let mut provider = Provider::with_id(
            "rightcode".to_string(),
            "RightCode".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "rightcode-key"
                },
                "config": r#"model_provider = "rightcode"
model = "gpt-5-codex"

[model_providers.rightcode]
name = "RightCode"
base_url = "https://rightcode.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.category = Some("custom".to_string());
        let takeover_auth = json!({
            "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
        });
        let takeover_settings = json!({
            "auth": takeover_auth,
            "config": r#"model_provider = "rightcode"
model = "gpt-5-codex"

[model_providers.rightcode]
name = "RightCode"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
"#
        });

        service
            .write_codex_live_for_provider(&takeover_settings, Some(&provider))
            .expect("write provider-driven Codex live config");

        let live_auth: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path())
                .expect("read live auth");
        assert_eq!(
            live_auth,
            json!({
                "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
            }),
            "disabled preservation should let third-party switches overwrite auth.json"
        );

        let live_config = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read live config");
        assert!(
            !live_config.contains("experimental_bearer_token"),
            "provider token should stay in auth.json when preservation is disabled"
        );

        crate::settings::update_settings(crate::settings::AppSettings::default())
            .expect("reset settings");
    }

    #[test]
    fn update_toml_base_url_updates_active_model_provider_base_url() {
        let input = r#"
model_provider = "any"
model = "gpt-5.1-codex"
disable_response_storage = true

[model_providers.any]
name = "any"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
requires_openai_auth = true
"#;

        let new_url = "http://127.0.0.1:5000/v1";
        let output = ProxyService::update_toml_base_url(input, new_url);

        let parsed: toml::Value =
            toml::from_str(&output).expect("updated config should be valid TOML");

        let base_url = parsed
            .get("model_providers")
            .and_then(|v| v.get("any"))
            .and_then(|v| v.get("base_url"))
            .and_then(|v| v.as_str())
            .expect("model_providers.any.base_url should exist");

        assert_eq!(base_url, new_url);
        assert!(
            parsed.get("base_url").is_none(),
            "should not write top-level base_url"
        );

        let wire_api = parsed
            .get("model_providers")
            .and_then(|v| v.get("any"))
            .and_then(|v| v.get("wire_api"))
            .and_then(|v| v.as_str())
            .expect("model_providers.any.wire_api should exist");
        assert_eq!(wire_api, "responses");
    }

    #[test]
    fn apply_codex_proxy_toml_config_forces_local_responses_wire_api() {
        let input = r#"
model_provider = "chat_only"
model = "gpt-5.1-codex"

[model_providers.chat_only]
name = "Chat Only"
base_url = "https://chat-only.example/v1"
wire_api = "chat"
"#;

        let proxy_url = "http://127.0.0.1:5000/v1";
        let output =
            ProxyService::apply_codex_proxy_toml_config_for_provider(input, proxy_url, None);
        let parsed: toml::Value =
            toml::from_str(&output).expect("updated config should be valid TOML");

        let provider = parsed
            .get("model_providers")
            .and_then(|v| v.get("chat_only"))
            .expect("model_providers.chat_only should exist");

        assert_eq!(
            provider.get("base_url").and_then(|v| v.as_str()),
            Some(proxy_url)
        );
        assert_eq!(
            provider.get("wire_api").and_then(|v| v.as_str()),
            Some("responses")
        );
    }

    #[test]
    fn apply_codex_proxy_toml_config_keeps_upstream_model_for_chat_provider() {
        let input = r#"
model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
"#;
        let mut provider = Provider::with_id(
            "deepseek".to_string(),
            "DeepSeek".to_string(),
            json!({
                "config": input
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            api_format: Some("openai_chat".to_string()),
            ..Default::default()
        });

        let proxy_url = "http://127.0.0.1:5000/v1";
        let output = ProxyService::apply_codex_proxy_toml_config_for_provider(
            input,
            proxy_url,
            Some(&provider),
        );
        let parsed: toml::Value =
            toml::from_str(&output).expect("updated config should be valid TOML");

        assert_eq!(
            parsed.get("model").and_then(|v| v.as_str()),
            Some("deepseek-v4-flash")
        );
        assert_eq!(
            parsed
                .get("model_providers")
                .and_then(|v| v.get("deepseek"))
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str()),
            Some(proxy_url)
        );
    }

    #[test]
    fn apply_codex_proxy_toml_config_preserves_model_for_responses_provider() {
        let input = r#"
model_provider = "responses"
model = "upstream-responses-model"

[model_providers.responses]
name = "Responses"
base_url = "https://responses.example/v1"
wire_api = "responses"
"#;
        let mut provider = Provider::with_id(
            "responses".to_string(),
            "Responses".to_string(),
            json!({
                "config": input
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            api_format: Some("openai_responses".to_string()),
            ..Default::default()
        });

        let output = ProxyService::apply_codex_proxy_toml_config_for_provider(
            input,
            "http://127.0.0.1:5000/v1",
            Some(&provider),
        );
        let parsed: toml::Value =
            toml::from_str(&output).expect("updated config should be valid TOML");

        assert_eq!(
            parsed.get("model").and_then(|v| v.as_str()),
            Some("upstream-responses-model")
        );
    }

    #[test]
    fn apply_codex_proxy_toml_config_restores_upstream_model_for_responses_provider() {
        let input = r#"
model_provider = "responses"
model = "gpt-5.4"

[model_providers.responses]
name = "Responses"
base_url = "http://127.0.0.1:5000/v1"
wire_api = "responses"
"#;
        let mut provider = Provider::with_id(
            "responses".to_string(),
            "Responses".to_string(),
            json!({
                "config": r#"model_provider = "responses"
model = "upstream-responses-model"

[model_providers.responses]
name = "Responses"
base_url = "https://responses.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            api_format: Some("openai_responses".to_string()),
            ..Default::default()
        });

        let output = ProxyService::apply_codex_proxy_toml_config_for_provider(
            input,
            "http://127.0.0.1:5000/v1",
            Some(&provider),
        );
        let parsed: toml::Value =
            toml::from_str(&output).expect("updated config should be valid TOML");

        assert_eq!(
            parsed.get("model").and_then(|v| v.as_str()),
            Some("upstream-responses-model")
        );
    }

    #[test]
    fn update_toml_base_url_falls_back_to_top_level_base_url() {
        let input = r#"
model = "gpt-5.1-codex"
"#;

        let new_url = "http://127.0.0.1:5000/v1";
        let output = ProxyService::update_toml_base_url(input, new_url);

        let parsed: toml::Value =
            toml::from_str(&output).expect("updated config should be valid TOML");

        let base_url = parsed
            .get("base_url")
            .and_then(|v| v.as_str())
            .expect("base_url should exist");

        assert_eq!(base_url, new_url);
    }

    #[tokio::test]
    #[serial]
    async fn live_codex_stream_request_refreshes_activity_model_to_upstream_model() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let (mock_base_url, mock_handle) = start_mock_codex_responses_stream_server().await;
        let proxy_port = unused_local_port().await;

        let db = Arc::new(Database::memory().expect("init db"));
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("update proxy config");

        let service = ProxyService::new(db.clone());
        let provider = Provider::with_id(
            "codex-live".to_string(),
            "Codex Live".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "test-key"
                },
                "config": format!(
                    "model_provider = \"custom\"\nmodel = \"gpt-5.4\"\nmodel_reasoning_effort = \"xhigh\"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = \"custom\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nbase_url = \"{mock_base_url}/v1\"\n"
                )
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-live")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-live"))
            .expect("set local current provider");

        let info = service.start().await.expect("start proxy service");
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/responses", info.port))
            .json(&json!({
                "model": "gpt-5.4",
                "stream": true,
                "input": "hello"
            }))
            .send()
            .await
            .expect("send proxied request");
        assert!(response.status().is_success());

        let mut stream = response.bytes_stream();
        let first_chunk = stream
            .next()
            .await
            .expect("first stream chunk")
            .expect("read first stream chunk");
        assert!(
            String::from_utf8_lossy(&first_chunk).contains("response.created"),
            "proxy should forward the first upstream SSE frame"
        );

        let mut matched = false;
        for _ in 0..20 {
            let status = service.get_status().await.expect("get proxy status");
            if status.active_request_count == 1
                && status.active_request_targets.iter().any(|target| {
                    target.app_type == "codex"
                        && target.provider_id == "codex-live"
                        && target.inflight_requests == 1
                        && target.last_request_model.as_deref() == Some("gpt-5.3-codex")
                })
            {
                matched = true;
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }

        assert!(
            matched,
            "activity state should refresh from request model gpt-5.4 to upstream model gpt-5.3-codex while the request is still in flight"
        );

        while let Some(chunk) = stream.next().await {
            chunk.expect("consume remaining proxied stream");
        }

        for _ in 0..20 {
            let status = service.get_status().await.expect("get proxy status");
            if status.active_request_count == 0 && status.active_request_targets.is_empty() {
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }

        let final_status = service.get_status().await.expect("get final proxy status");
        assert_eq!(final_status.active_request_count, 0);
        assert!(final_status.active_request_targets.is_empty());

        service.stop().await.expect("stop proxy service");
        mock_handle.abort();
    }

    #[tokio::test]
    #[serial]
    async fn hot_switch_provider_resets_recovery_state_for_target_provider() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "claude-key",
                    "ANTHROPIC_BASE_URL": "https://claude.example"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = false;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover");

        db.update_provider_health("claude-a", "claude", false, Some("Invalid API Key".into()))
            .await
            .expect("seed unhealthy state");
        service
            .reset_provider_circuit_breaker("claude-a", "claude")
            .await
            .expect("ensure breaker exists");

        let server_guard = service.server.read().await;
        server_guard
            .as_ref()
            .expect("server should be running")
            .record_provider_result_for_test(
                "claude-a",
                "claude",
                false,
                Some("Invalid API Key".into()),
            )
            .await
            .expect("seed breaker failure");
        drop(server_guard);

        let before_health = db
            .get_provider_health("claude-a", "claude")
            .await
            .expect("health before hot switch");
        assert!(!before_health.is_healthy || before_health.consecutive_failures > 0);
        let before_breaker = service
            .get_circuit_breaker_stats("claude-a", "claude")
            .await
            .expect("get stats")
            .expect("breaker should exist before hot switch");
        assert!(before_breaker.failed_requests > 0);

        service
            .hot_switch_provider("claude", "claude-a")
            .await
            .expect("hot switch target");

        let after_health = db
            .get_provider_health("claude-a", "claude")
            .await
            .expect("health after hot switch");
        assert!(after_health.is_healthy);
        assert_eq!(after_health.consecutive_failures, 0);

        let after_breaker = service
            .get_circuit_breaker_stats("claude-a", "claude")
            .await
            .expect("get stats after hot switch")
            .expect("breaker should still exist after reset");
        assert_eq!(after_breaker.failed_requests, 0);
        assert_eq!(after_breaker.consecutive_failures, 0);

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn live_codex_stream_request_keeps_original_request_model_in_logs() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let (mock_base_url, mock_handle) = start_mock_codex_responses_stream_server().await;
        let proxy_port = unused_local_port().await;

        let db = Arc::new(Database::memory().expect("init db"));
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("update proxy config");

        let service = ProxyService::new(db.clone());
        let provider = Provider::with_id(
            "codex-live".to_string(),
            "Codex Live".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "test-key"
                },
                "config": format!(
                    "model_provider = \"custom\"\nmodel = \"gpt-5.5\"\nmodel_reasoning_effort = \"xhigh\"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = \"custom\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nbase_url = \"{mock_base_url}/v1\"\n"
                )
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-live")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-live"))
            .expect("set local current provider");

        let info = service.start().await.expect("start proxy service");
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/responses", info.port))
            .json(&json!({
                "model": "gpt-5.5",
                "stream": true,
                "input": "hello"
            }))
            .send()
            .await
            .expect("send proxied request");
        assert!(response.status().is_success());

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            chunk.expect("consume proxied stream");
        }

        for _ in 0..20 {
            let status = service.get_status().await.expect("get proxy status");
            if status.active_request_count == 0 && status.active_request_targets.is_empty() {
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }

        let logs = db
            .get_request_logs(&crate::services::usage_stats::LogFilters::default(), 0, 10)
            .expect("get request logs");
        let codex_log = logs
            .data
            .iter()
            .find(|log| log.provider_id == "codex-live")
            .expect("find codex log");

        assert_eq!(codex_log.request_model.as_deref(), Some("gpt-5.5"));
        assert_eq!(codex_log.model, "gpt-5.3-codex");

        let raw_logs = service
            .get_raw_logs(10, Some("codex"))
            .await
            .expect("get raw logs");
        let raw_log = raw_logs
            .iter()
            .find(|log| log.provider_id == "codex-live")
            .expect("find raw codex log");
        assert_eq!(raw_log.request_model.as_deref(), Some("gpt-5.5"));
        assert_eq!(raw_log.upstream_model.as_deref(), Some("gpt-5.3-codex"));

        service.stop().await.expect("stop proxy service");
        mock_handle.abort();
    }

    #[tokio::test]
    #[serial]
    async fn sync_claude_token_does_not_add_anthropic_api_key() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider = Provider::with_id(
            "p1".to_string(),
            "P1".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                    "ANTHROPIC_AUTH_TOKEN": "stale"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save provider");
        db.set_current_provider("claude", "p1")
            .expect("set current provider");

        let live_config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                "ANTHROPIC_AUTH_TOKEN": "fresh"
            }
        });

        service
            .sync_live_config_to_provider(&AppType::Claude, &live_config)
            .await
            .expect("sync");

        let updated = db
            .get_provider_by_id("p1", "claude")
            .expect("get provider")
            .expect("provider exists");
        let env = updated
            .settings_config
            .get("env")
            .and_then(|v| v.as_object())
            .expect("env object");

        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str()),
            Some("fresh")
        );
        assert!(
            !env.contains_key("ANTHROPIC_API_KEY"),
            "should not add ANTHROPIC_API_KEY when absent"
        );
    }

    #[tokio::test]
    #[serial]
    async fn sync_claude_token_respects_existing_api_key_field() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider = Provider::with_id(
            "p1".to_string(),
            "P1".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                    "ANTHROPIC_API_KEY": "stale"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save provider");
        db.set_current_provider("claude", "p1")
            .expect("set current provider");

        let live_config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                "ANTHROPIC_AUTH_TOKEN": "fresh"
            }
        });

        service
            .sync_live_config_to_provider(&AppType::Claude, &live_config)
            .await
            .expect("sync");

        let updated = db
            .get_provider_by_id("p1", "claude")
            .expect("get provider")
            .expect("provider exists");
        let env = updated
            .settings_config
            .get("env")
            .and_then(|v| v.as_object())
            .expect("env object");

        assert_eq!(
            env.get("ANTHROPIC_API_KEY").and_then(|v| v.as_str()),
            Some("fresh")
        );
        assert!(
            !env.contains_key("ANTHROPIC_AUTH_TOKEN"),
            "should not add ANTHROPIC_AUTH_TOKEN when absent"
        );
    }

    #[tokio::test]
    #[serial]
    async fn sync_codex_live_token_skips_when_live_endpoint_belongs_to_another_provider() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "b-key"
                },
                "config": r#"model_provider = "b"
model = "gpt-5.5"

[model_providers.b]
name = "B"
base_url = "https://b.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "b")
            .expect("set current provider");

        let stale_live_from_a = json!({
            "auth": {
                "OPENAI_API_KEY": "a-key"
            },
            "config": r#"model_provider = "a"
model = "gpt-5.4"

[model_providers.a]
name = "A"
base_url = "https://a.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
        });

        service
            .sync_live_config_to_provider(&AppType::Codex, &stale_live_from_a)
            .await
            .expect("sync live to provider");

        let saved = db
            .get_provider_by_id("b", "codex")
            .expect("get provider b")
            .expect("provider b exists");
        assert_eq!(
            saved
                .settings_config
                .pointer("/auth/OPENAI_API_KEY")
                .and_then(|v| v.as_str()),
            Some("b-key"),
            "live token from a different endpoint must not overwrite the current provider"
        );
    }

    #[tokio::test]
    #[serial]
    async fn sync_codex_live_token_skips_when_live_endpoint_is_shared_but_owner_is_other_provider()
    {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "a-key"
                },
                "config": r#"model_provider = "a"
model = "gpt-5.4"

[model_providers.a]
name = "A"
base_url = "https://shared.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "b-key"
                },
                "config": r#"model_provider = "b"
model = "gpt-5.5"

[model_providers.b]
name = "B"
base_url = "https://shared.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "b")
            .expect("set current provider");
        db.set_live_owner_provider_id("codex", Some("a"))
            .expect("set live owner provider");

        let stale_live_from_a = json!({
            "auth": {
                "OPENAI_API_KEY": "a-new-key"
            },
            "config": r#"model_provider = "a"
model = "gpt-5.4"

[model_providers.a]
name = "A"
base_url = "https://shared.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
        });

        service
            .sync_live_config_to_provider(&AppType::Codex, &stale_live_from_a)
            .await
            .expect("sync live to provider");

        let saved_b = db
            .get_provider_by_id("b", "codex")
            .expect("get provider b")
            .expect("provider b exists");
        assert_eq!(
            saved_b
                .settings_config
                .pointer("/auth/OPENAI_API_KEY")
                .and_then(|v| v.as_str()),
            Some("b-key"),
            "shared-endpoint live token must not overwrite another provider when live owner anchor points elsewhere"
        );
    }

    #[tokio::test]
    #[serial]
    async fn takeover_live_writes_clear_live_owner_anchor() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "a-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.5"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider).expect("save provider");
        db.set_current_provider("codex", &provider.id)
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some(&provider.id))
            .expect("set local current provider");
        db.set_live_owner_provider_id("codex", Some(&provider.id))
            .expect("seed direct live owner anchor");

        db.update_proxy_config(ProxyConfig {
            listen_port: 15721,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable codex takeover");

        service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &provider)
            .await
            .expect("write codex takeover live");

        assert_eq!(
            db.get_live_owner_provider_id("codex")
                .expect("read live owner anchor after takeover write"),
            None,
            "proxy takeover live writes must clear the direct-live owner anchor"
        );
    }

    #[tokio::test]
    #[serial]
    async fn sync_codex_live_token_skips_when_live_endpoint_is_missing() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "provider-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.5"

[model_providers.codex-a]
name = "Codex A"
base_url = "https://codex-a.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        db.save_provider("codex", &provider).expect("save provider");
        db.set_current_provider("codex", "codex-a")
            .expect("set current provider");

        let endpoint_less_live = json!({
            "auth": {
                "OPENAI_API_KEY": "orphan-live-key"
            },
            "config": r#"model = "gpt-5.4""#
        });

        service
            .sync_live_config_to_provider(&AppType::Codex, &endpoint_less_live)
            .await
            .expect("sync live to provider");

        let saved = db
            .get_provider_by_id("codex-a", "codex")
            .expect("get provider")
            .expect("provider exists");
        assert_eq!(
            saved
                .settings_config
                .pointer("/auth/OPENAI_API_KEY")
                .and_then(|v| v.as_str()),
            Some("provider-key"),
            "live token without an endpoint must not overwrite provider credentials"
        );
    }

    #[tokio::test]
    #[serial]
    async fn switch_proxy_target_updates_live_backup_when_taken_over() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_API_KEY": "a-key"
                }
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_API_KEY": "b-key"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", "a")
            .expect("set current provider");

        // 模拟"已接管"状态：存在 Live 备份（内容不重要，会被热切换更新）
        db.save_live_backup("claude", "{\"env\":{}}")
            .await
            .expect("seed live backup");
        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = false;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("mark claude takeover enabled");

        service
            .switch_proxy_target("claude", "b")
            .await
            .expect("switch proxy target");

        // 断言：本地 settings 的 current provider 已同步
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Claude).as_deref(),
            Some("b")
        );

        // 断言：Live 备份已更新为目标供应商配置（用于 stop_with_restore 恢复）
        let backup = db
            .get_live_backup("claude")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let expected = serde_json::to_string(&provider_b.settings_config).expect("serialize");
        assert_eq!(backup.original_config, expected);
    }

    #[tokio::test]
    #[serial]
    async fn switch_proxy_target_in_auto_failover_does_not_rewrite_codex_live_config() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "a-key"
                },
                "config": r#"model_provider = "a"
model = "gpt-5.3-codex"

[model_providers.a]
name = "A"
base_url = "https://a.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "b-key"
                },
                "config": r#"model_provider = "b"
model = "gpt-5.3-codex"

[model_providers.b]
name = "B"
base_url = "https://b.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "a")
            .expect("set current provider");
        db.save_live_backup(
            "codex",
            &serde_json::to_string(&provider_a.settings_config).expect("serialize provider a"),
        )
        .await
        .expect("seed live backup");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable codex auto failover");

        let original_live = json!({
            "auth": {
                "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
            },
            "config": r#"model_provider = "cc-switch"
model = "gpt-5.3-codex"

[model_providers.cc-switch]
name = "cc-switch"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
requires_openai_auth = true
"#
        });
        service
            .write_codex_live(&original_live)
            .expect("seed taken-over Codex live config");

        service
            .switch_proxy_target("codex", "b")
            .await
            .expect("switch proxy target in auto failover mode");

        let live = service.read_codex_live().expect("read Codex live config");
        assert_eq!(
            live, original_live,
            "auto failover target changes must not rewrite Codex live config.toml"
        );

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup exists");
        assert_eq!(
            backup.original_config,
            serde_json::to_string(&provider_a.settings_config).expect("serialize provider a"),
            "auto failover target changes must not rewrite restore backup"
        );
    }

    #[tokio::test]
    #[serial]
    async fn switch_proxy_target_rejects_stale_failover_flag_when_takeover_is_disabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "a-key"
                },
                "config": r#"model_provider = "a"
model = "gpt-5.3-codex"

[model_providers.a]
name = "A"
base_url = "https://a.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "b-key"
                },
                "config": r#"model_provider = "b"
model = "gpt-5.4"

[model_providers.b]
name = "B"
base_url = "https://b.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "a")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("a"))
            .expect("set local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = false;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("seed stale failover flag");

        let error = service
            .switch_proxy_target("codex", "b")
            .await
            .expect_err("stale failover flag must not allow proxy hot switch");

        assert!(
            error.contains("未开启代理接管")
                || error.contains("代理接管")
                || error.contains("takeover"),
            "unexpected error message: {error}"
        );
        assert_eq!(
            db.get_current_provider("codex")
                .expect("get current provider after rejected switch"),
            Some("a".to_string()),
            "rejected proxy hot switch must not change DB current provider"
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex).as_deref(),
            Some("a"),
            "rejected proxy hot switch must not change local current provider"
        );
    }

    #[tokio::test]
    #[serial]
    async fn hot_switch_provider_updates_claude_live_while_preserving_takeover_fields() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_API_KEY": "a-key",
                    "ANTHROPIC_BASE_URL": "https://api.a.example",
                    "ANTHROPIC_MODEL": "claude-old"
                },
                "permissions": { "allow": ["Bash"] }
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_API_KEY": "b-key",
                    "ANTHROPIC_BASE_URL": "https://api.b.example",
                    "ANTHROPIC_MODEL": "claude-new",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "DeepSeek V4 Flash",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1M]",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "DeepSeek V4 Pro",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-ultra [1m]"
                },
                "permissions": { "allow": ["Read"] }
            }),
            None,
        );

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", "a")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some("a"))
            .expect("set local current provider");
        db.save_live_backup(
            "claude",
            &serde_json::to_string(&provider_a.settings_config).expect("serialize provider a"),
        )
        .await
        .expect("seed live backup");
        service
            .write_claude_live(&json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",
                    "ANTHROPIC_AUTH_TOKEN": PROXY_TOKEN_PLACEHOLDER,
                    "ANTHROPIC_API_KEY": PROXY_TOKEN_PLACEHOLDER,
                    "ANTHROPIC_MODEL": "stale-model",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Stale Sonnet"
                },
                "permissions": { "allow": ["Bash"] }
            }))
            .expect("seed taken-over live file");

        service
            .hot_switch_provider("claude", "b")
            .await
            .expect("hot switch provider");

        let live = service.read_claude_live().expect("read live config");
        assert!(
            live.get("permissions").is_none(),
            "takeover live config should stay a stable proxy access config, not provider-specific settings"
        );
        assert_eq!(
            live.get("env")
                .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
                .and_then(|v| v.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "takeover token placeholder should be preserved"
        );
        assert_eq!(
            live.get("env")
                .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
                .and_then(|v| v.as_str()),
            Some("http://127.0.0.1:15721"),
            "takeover proxy URL should remain active"
        );
        assert!(
            live.get("env")
                .and_then(|env| env.get("ANTHROPIC_MODEL"))
                .is_none(),
            "fallback model override should be removed in takeover mode"
        );
        let live_env = live
            .get("env")
            .and_then(|env| env.as_object())
            .expect("live env");
        assert_eq!(
            live_env
                .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
                .and_then(|v| v.as_str()),
            Some("claude-haiku-4-5"),
            "takeover mode should expose a stable Haiku role model"
        );
        assert_eq!(
            live_env
                .get("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME")
                .and_then(|v| v.as_str()),
            Some("DeepSeek V4 Flash"),
            "model menu should show the current provider Haiku display name"
        );
        assert_eq!(
            live_env
                .get("ANTHROPIC_DEFAULT_SONNET_MODEL")
                .and_then(|v| v.as_str()),
            Some("claude-sonnet-4-6[1M]"),
            "Sonnet role should carry the local 1M declaration for Claude Code"
        );
        assert_eq!(
            live_env
                .get("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME")
                .and_then(|v| v.as_str()),
            Some("DeepSeek V4 Pro"),
            "stale model display names should be replaced during hot switch"
        );
        assert_eq!(
            live_env
                .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
                .and_then(|v| v.as_str()),
            Some("claude-opus-4-8[1M]"),
            "Opus role should preserve the current provider 1M capability marker"
        );
        assert_eq!(
            live_env
                .get("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME")
                .and_then(|v| v.as_str()),
            Some("deepseek-v4-ultra"),
            "implicit display names should strip the local 1M marker"
        );

        let backup = db
            .get_live_backup("claude")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let expected = serde_json::to_string(&provider_b.settings_config).expect("serialize");
        assert_eq!(backup.original_config, expected);
    }

    #[tokio::test]
    #[serial]
    async fn hot_switch_provider_repairs_takeover_live_without_backup_when_proxy_is_running() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let service = ProxyService::new(db.clone());
        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://api.a.example",
                    "ANTHROPIC_MODEL": "model-a"
                }
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-b",
                    "ANTHROPIC_BASE_URL": "https://api.b.example",
                    "ANTHROPIC_MODEL": "model-b"
                }
            }),
            None,
        );

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", "a")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some("a"))
            .expect("set local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover");

        service.start().await.expect("start proxy service");
        service
            .write_claude_live(&provider_a.settings_config)
            .expect("seed drifted direct live");
        db.delete_live_backup("claude")
            .await
            .expect("ensure backup is missing");

        service
            .hot_switch_provider("claude", "b")
            .await
            .expect("hot switch provider");

        let live = service.read_claude_live().expect("read live config");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "hot switch should repair a drifted direct live endpoint back to the running local proxy"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "hot switch should preserve the takeover token placeholder even when no backup existed"
        );

        let backup = db
            .get_live_backup("claude")
            .await
            .expect("read live backup")
            .expect("backup should be rebuilt during hot switch");
        let backup_value: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup config");
        assert_eq!(
            backup_value
                .pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some("https://api.b.example"),
            "hot switch should refresh the restore backup to the newly selected provider"
        );
    }

    #[tokio::test]
    #[serial]
    async fn hot_switch_provider_serializes_same_app_switches() {
        use tokio::time::{sleep, Duration};

        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({ "env": { "ANTHROPIC_API_KEY": "a-key" } }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({ "env": { "ANTHROPIC_API_KEY": "b-key" } }),
            None,
        );
        let provider_c = Provider::with_id(
            "c".to_string(),
            "C".to_string(),
            json!({ "env": { "ANTHROPIC_API_KEY": "c-key" } }),
            None,
        );

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.save_provider("claude", &provider_c)
            .expect("save provider c");
        db.set_current_provider("claude", "a")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some("a"))
            .expect("set local current provider");
        db.save_live_backup("claude", "{\"env\":{}}")
            .await
            .expect("seed live backup");

        let guard = service.lock_switch_for_test("claude").await;
        let service_for_b = service.clone();
        let service_for_c = service.clone();

        let switch_b = tokio::spawn(async move {
            service_for_b
                .hot_switch_provider("claude", "b")
                .await
                .expect("switch to b")
        });
        sleep(Duration::from_millis(20)).await;
        let switch_c = tokio::spawn(async move {
            service_for_c
                .hot_switch_provider("claude", "c")
                .await
                .expect("switch to c")
        });

        sleep(Duration::from_millis(20)).await;
        drop(guard);

        let outcome_b = switch_b.await.expect("join switch b");
        let outcome_c = switch_c.await.expect("join switch c");
        assert!(outcome_b.logical_target_changed);
        assert!(outcome_c.logical_target_changed);

        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Claude)
                .expect("effective current"),
            Some("c".to_string())
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Claude).as_deref(),
            Some("c")
        );
        assert_eq!(
            db.get_current_provider("claude").expect("db current"),
            Some("c".to_string())
        );

        let backup = db
            .get_live_backup("claude")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let expected = serde_json::to_string(&provider_c.settings_config).expect("serialize");
        assert_eq!(backup.original_config, expected);
    }

    #[tokio::test]
    #[serial]
    async fn restore_waits_for_hot_switch_and_restores_latest_backup() {
        use tokio::time::{sleep, Duration};

        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "A".to_string(),
            json!({ "env": { "ANTHROPIC_API_KEY": "a-key" } }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "B".to_string(),
            json!({ "env": { "ANTHROPIC_API_KEY": "b-key" } }),
            None,
        );

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", "a")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some("a"))
            .expect("set local current provider");
        db.save_live_backup(
            "claude",
            &serde_json::to_string(&provider_a.settings_config).expect("serialize provider a"),
        )
        .await
        .expect("seed live backup");
        service
            .write_claude_live(&json!({ "env": { "ANTHROPIC_API_KEY": "stale" } }))
            .expect("seed live file");

        let guard = service.lock_switch_for_test("claude").await;
        let service_for_switch = service.clone();
        let service_for_restore = service.clone();

        let switch_to_b = tokio::spawn(async move {
            service_for_switch
                .hot_switch_provider("claude", "b")
                .await
                .expect("switch to b")
        });
        sleep(Duration::from_millis(20)).await;
        let restore = tokio::spawn(async move {
            service_for_restore
                .restore_live_config_for_app_with_fallback(&AppType::Claude)
                .await
                .expect("restore claude live")
        });

        sleep(Duration::from_millis(20)).await;
        drop(guard);

        let outcome = switch_to_b.await.expect("join switch");
        restore.await.expect("join restore");
        assert!(outcome.logical_target_changed);

        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Claude)
                .expect("effective current"),
            Some("b".to_string())
        );

        let backup = db
            .get_live_backup("claude")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let expected = serde_json::to_string(&provider_b.settings_config).expect("serialize");
        assert_eq!(backup.original_config, expected);
        assert_eq!(
            service.read_claude_live().expect("read live"),
            provider_b.settings_config
        );
    }

    #[tokio::test]
    #[serial]
    async fn proxy_active_sync_renders_codex_template_without_leaking_real_credentials() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        db.update_proxy_config(ProxyConfig {
            listen_port: 32123,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "approval_policy = \"never\"\nmodel_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.cc-switch]\nname = \"cc-switch\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nbase_url = \"{proxyCodexBaseUrl}\"\n\n{mcpConfig}\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let service = ProxyService::new(db.clone());
        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "real-codex-key"
                },
                "config": r#"model_provider = "any"
model = "gpt-5"

[model_providers.any]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );

        service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &provider)
            .await
            .expect("sync codex live while proxy active");

        let live = service.read_codex_live().expect("read codex live");
        assert_eq!(
            live.get("auth")
                .and_then(|v| v.get("OPENAI_API_KEY"))
                .and_then(|v| v.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "Codex auth.json must keep the proxy placeholder while takeover is active"
        );
        let config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config.toml should be present");
        assert!(
            config.contains("approval_policy = \"never\""),
            "template content should be rendered into live config"
        );
        assert!(
            config.contains("model = \"gpt-5\""),
            "Codex takeover must use the current provider model, not the access template default"
        );
        assert!(
            !config.contains("model = \"gpt-5.5\""),
            "stale access template model must not override the current provider"
        );
        assert!(
            config.contains("http://127.0.0.1:32123/v1"),
            "Codex live config should point to the local proxy during takeover"
        );
        assert!(
            !config.contains("https://codex.example/v1"),
            "real provider base_url must not be written into live config during takeover"
        );
    }

    #[tokio::test]
    #[serial]
    async fn access_template_sync_rebuilds_codex_live_without_real_credentials_when_live_drifted() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let provider = Provider::with_id(
            "codex-live".to_string(),
            "Codex Live".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "real-codex-key"
                },
                "config": r#"model_provider = "codex-live"
model = "gpt-5.4"

[model_providers.codex-live]
base_url = "https://real-codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-live")
            .expect("set db current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-live"))
            .expect("set local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("mark takeover enabled");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&provider.settings_config)
            .expect("seed drifted provider live config");

        service
            .sync_live_access_template_for_app(&AppType::Codex)
            .await
            .expect("sync access template live");

        let live = service.read_codex_live().expect("read codex live");
        assert_eq!(
            live.get("auth")
                .and_then(|v| v.get("OPENAI_API_KEY"))
                .and_then(|v| v.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "Codex auth.json must be rewritten to the proxy placeholder"
        );
        let config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config.toml should be present");
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "Codex live config should point to the local proxy after template sync"
        );
        assert!(
            !config.contains("https://real-codex.example/v1"),
            "access template sync must not keep the real provider base_url in live config"
        );
        assert!(
            !config.contains("real-codex-key"),
            "access template sync must not keep the real provider API key in live config"
        );
        assert!(
            config.contains("model = \"gpt-5.4\""),
            "Codex takeover should preserve the current provider model"
        );
    }

    #[tokio::test]
    #[serial]
    async fn codex_takeover_best_effort_uses_current_provider_model_fields() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        db.update_proxy_config(ProxyConfig {
            listen_port: 32125,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\nmodel_reasoning_effort = \"high\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let provider = Provider::with_id(
            "codex-current".to_string(),
            "Codex Current".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "real-codex-key"
                },
                "config": r#"model_provider = "custom"
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"

[model_providers.custom]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-current")
            .expect("set db current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-current"))
            .expect("set local current provider");

        let service = ProxyService::new(db.clone());
        service
            .takeover_live_config_best_effort(&AppType::Codex)
            .await
            .expect("takeover codex live config");

        let live = service.read_codex_live().expect("read codex live");
        let config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config.toml should be present");
        let parsed: toml::Value = toml::from_str(config).expect("parse live config");

        assert_eq!(
            parsed.get("model").and_then(|v| v.as_str()),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            parsed
                .get("model_reasoning_effort")
                .and_then(|v| v.as_str()),
            Some("medium")
        );
        assert_eq!(
            parsed
                .get("model_providers")
                .and_then(|v| v.get("cc-switch"))
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str()),
            Some("http://127.0.0.1:32125/v1")
        );
        assert!(
            !config.contains("https://codex.example/v1"),
            "provider endpoint must not leak into taken-over live config"
        );
    }

    #[tokio::test]
    #[serial]
    async fn set_takeover_for_app_repairs_codex_live_drift_when_backup_exists() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let provider = Provider::with_id(
            "codex-direct".to_string(),
            "Codex Direct".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "real-codex-key"
                },
                "config": r#"model_provider = "direct"
model = "gpt-5.4"

[model_providers.direct]
name = "Direct"
base_url = "https://direct.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-direct")
            .expect("set db current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-direct"))
            .expect("set local current provider");

        let service = ProxyService::new(db.clone());
        let drifted_live = provider.settings_config.clone();
        service
            .write_codex_live(&drifted_live)
            .expect("seed drifted direct Codex live config");

        let original_backup =
            serde_json::to_string(&provider.settings_config).expect("serialize backup");
        db.save_live_backup("codex", &original_backup)
            .await
            .expect("seed live backup");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("mark codex takeover enabled");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("repair codex takeover");

        let live = service.read_codex_live().expect("read repaired live");
        assert_eq!(
            live.get("auth")
                .and_then(|v| v.get("OPENAI_API_KEY"))
                .and_then(|v| v.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER)
        );

        let config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config.toml should be present");
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "repaired live config should route Codex through the local proxy"
        );
        assert!(
            !config.contains("https://direct.example/v1"),
            "repaired live config must not keep the direct provider endpoint"
        );

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup should still exist");
        assert_eq!(
            backup.original_config, original_backup,
            "repairing a drifted live config must not overwrite the existing restore backup"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn set_takeover_for_app_repairs_codex_live_when_placeholder_token_but_base_url_drifted() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let provider = Provider::with_id(
            "codex-current".to_string(),
            "Codex Current".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "real-codex-key"
                },
                "config": r#"model_provider = "direct"
model = "gpt-5.4"

[model_providers.direct]
name = "Direct"
base_url = "https://direct.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-current")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-current"))
            .expect("set local current provider");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": r#"model_provider = "direct"
model = "gpt-5.4"

[model_providers.direct]
name = "Direct"
base_url = "https://direct.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }))
            .expect("seed drifted placeholder Codex live config");

        let original_backup =
            serde_json::to_string(&provider.settings_config).expect("serialize backup");
        db.save_live_backup("codex", &original_backup)
            .await
            .expect("seed live backup");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("mark codex takeover enabled");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("repair placeholder drift");

        let live = service.read_codex_live().expect("read repaired live");
        let config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config.toml should be present");

        assert_eq!(
            live.get("auth")
                .and_then(|v| v.get("OPENAI_API_KEY"))
                .and_then(|v| v.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER)
        );
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "placeholder token is not enough; Codex base_url must point at the current local proxy"
        );
        assert!(
            !config.contains("https://direct.example/v1"),
            "stale direct endpoint must be removed from the taken-over live config"
        );

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup should still exist");
        assert_eq!(backup.original_config, original_backup);

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn sync_failover_active_target_tracks_queue_head_and_clears_when_empty() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut provider_a = Provider::with_id(
            "a".to_string(),
            "Provider A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "a",
                    "ANTHROPIC_BASE_URL": "https://a.example"
                }
            }),
            None,
        );
        provider_a.sort_index = Some(20);
        let mut provider_b = Provider::with_id(
            "b".to_string(),
            "Provider B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "b",
                    "ANTHROPIC_BASE_URL": "https://b.example"
                }
            }),
            None,
        );
        provider_b.sort_index = Some(10);

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("claude", "a")
            .expect("add provider a to queue");
        db.add_to_failover_queue("claude", "b")
            .expect("add provider b to queue");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable auto failover");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");

        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync initial active target");
        let status = service.get_status().await.expect("get proxy status");
        let active = status
            .active_targets
            .iter()
            .find(|target| target.app_type == "claude")
            .expect("claude active target should exist");
        assert_eq!(active.provider_id, "b");

        db.remove_from_failover_queue("claude", "b")
            .expect("remove provider b from queue");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync after removing queue head");
        let status = service.get_status().await.expect("get proxy status");
        let active = status
            .active_targets
            .iter()
            .find(|target| target.app_type == "claude")
            .expect("claude active target should still exist");
        assert_eq!(active.provider_id, "a");

        db.remove_from_failover_queue("claude", "a")
            .expect("remove provider a from queue");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync empty queue");
        let status = service.get_status().await.expect("get proxy status");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "claude"),
            "empty failover queue must clear the stale active target"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn sync_failover_active_target_keeps_takeover_live_when_queue_becomes_empty() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example",
                    "ANTHROPIC_MODEL": "model-a"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");
        db.add_to_failover_queue("claude", &provider.id)
            .expect("queue claude provider");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Claude, &provider)
            .await
            .expect("seed takeover live");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync initial queue head");

        db.remove_from_failover_queue("claude", &provider.id)
            .expect("remove last provider from queue");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync after queue becomes empty");

        let live = service.read_claude_live().expect("read claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "empty failover queue while takeover is still enabled must keep Claude live on the local proxy endpoint"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "empty failover queue must preserve takeover token placeholder instead of restoring provider credentials"
        );

        let status = service.get_status().await.expect("get proxy status");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "claude"),
            "queue empty should clear active target without rewriting live"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn real_http_failover_all_upstreams_down_keeps_takeover_live_config() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let (mock_a_base_url, mock_a_handle) = start_mock_claude_messages_error_server().await;
        let (mock_b_base_url, mock_b_handle) = start_mock_claude_messages_error_server().await;

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider_a = Provider::with_id(
            "a".to_string(),
            "Provider A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": mock_a_base_url,
                    "ANTHROPIC_MODEL": "claude-sonnet-4-6"
                }
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "Provider B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-b",
                    "ANTHROPIC_BASE_URL": mock_b_base_url,
                    "ANTHROPIC_MODEL": "claude-sonnet-4-6"
                }
            }),
            None,
        );

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("claude", "a")
            .expect("queue provider a");
        db.add_to_failover_queue("claude", "b")
            .expect("queue provider b");
        db.set_current_provider("claude", "a")
            .expect("seed direct current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some("a"))
            .expect("seed local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        app_config.max_retries = 1;
        app_config.circuit_failure_threshold = 1;
        app_config.circuit_timeout_seconds = 3600;
        app_config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable strict failover");

        let service = ProxyService::new(db.clone());
        let info = service.start().await.expect("start proxy service");
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Claude, &provider_a)
            .await
            .expect("seed takeover live");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync initial failover target");

        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/messages", info.port))
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": "claude-sonnet-4-6",
                "max_tokens": 16,
                "messages": [
                    {
                        "role": "user",
                        "content": "hello"
                    }
                ]
            }))
            .send()
            .await
            .expect("send proxied request through real HTTP server");

        assert!(
            !response.status().is_success(),
            "all failing upstream providers should surface an error response"
        );

        let stats_a = service
            .get_circuit_breaker_stats("a", "claude")
            .await
            .expect("read circuit breaker stats a")
            .expect("breaker a should exist");
        let stats_b = service
            .get_circuit_breaker_stats("b", "claude")
            .await
            .expect("read circuit breaker stats b")
            .expect("breaker b should exist");
        assert_eq!(
            stats_a.state,
            crate::proxy::circuit_breaker::CircuitState::Open,
            "provider a should be circuit-open after the failed real request"
        );
        assert_eq!(
            stats_b.state,
            crate::proxy::circuit_breaker::CircuitState::Open,
            "provider b should be circuit-open after the failed real request"
        );

        let live = service.read_claude_live().expect("read claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{proxy_port}").as_str()),
            "all upstreams failing must keep Claude live on the local proxy endpoint"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "all upstreams failing must keep the takeover token placeholder"
        );

        let live_text = serde_json::to_string(&live).expect("serialize live config");
        assert!(
            !live_text.contains(&mock_a_base_url) && !live_text.contains(&mock_b_base_url),
            "takeover live config must not be overwritten with a provider direct baseUrl"
        );
        assert_eq!(
            db.get_failover_queue("claude")
                .expect("read failover queue")
                .into_iter()
                .map(|item| item.provider_id)
                .collect::<Vec<_>>(),
            vec!["a".to_string(), "b".to_string()],
            "generic upstream failures must not silently rewrite the failover queue"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
        mock_a_handle.abort();
        mock_b_handle.abort();
    }

    #[tokio::test]
    #[serial]
    async fn real_http_codex_failover_all_upstreams_down_keeps_takeover_live_config() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let (mock_a_base_url, mock_a_handle) = start_mock_codex_responses_error_server().await;
        let (mock_b_base_url, mock_b_handle) = start_mock_codex_responses_error_server().await;

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider_a = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "token-a"
                },
                "config": format!(
                    "model_provider = \"codex-a\"\nmodel = \"gpt-5.4\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.codex-a]\nname = \"Codex A\"\nbase_url = \"{}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n",
                    mock_a_base_url
                )
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "codex-b".to_string(),
            "Codex B".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "token-b"
                },
                "config": format!(
                    "model_provider = \"codex-b\"\nmodel = \"gpt-5.4\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.codex-b]\nname = \"Codex B\"\nbase_url = \"{}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n",
                    mock_b_base_url
                )
            }),
            None,
        );

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("codex", "codex-a")
            .expect("queue provider a");
        db.add_to_failover_queue("codex", "codex-b")
            .expect("queue provider b");
        db.set_current_provider("codex", "codex-a")
            .expect("seed direct current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-a"))
            .expect("seed local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        app_config.max_retries = 1;
        app_config.circuit_failure_threshold = 1;
        app_config.circuit_timeout_seconds = 3600;
        app_config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable strict failover");

        let service = ProxyService::new(db.clone());
        let info = service.start().await.expect("start proxy service");
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &provider_a)
            .await
            .expect("seed takeover live");
        service
            .sync_failover_active_target("codex")
            .await
            .expect("sync initial failover target");

        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/responses", info.port))
            .json(&json!({
                "model": "gpt-5.4",
                "input": "hello",
                "stream": false
            }))
            .send()
            .await
            .expect("send proxied Codex request through real HTTP server");

        assert!(
            !response.status().is_success(),
            "all failing Codex upstream providers should surface an error response"
        );

        let stats_a = service
            .get_circuit_breaker_stats("codex-a", "codex")
            .await
            .expect("read circuit breaker stats a")
            .expect("breaker a should exist");
        let stats_b = service
            .get_circuit_breaker_stats("codex-b", "codex")
            .await
            .expect("read circuit breaker stats b")
            .expect("breaker b should exist");
        assert_eq!(
            stats_a.state,
            crate::proxy::circuit_breaker::CircuitState::Open,
            "provider a should be circuit-open after the failed real Codex request"
        );
        assert_eq!(
            stats_b.state,
            crate::proxy::circuit_breaker::CircuitState::Open,
            "provider b should be circuit-open after the failed real Codex request"
        );

        let live = service.read_codex_live().expect("read Codex live");
        assert_eq!(
            live.pointer("/auth/OPENAI_API_KEY").and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "all Codex upstreams failing must keep the takeover token placeholder"
        );
        let config_text = live
            .get("config")
            .and_then(Value::as_str)
            .expect("Codex config.toml should exist");
        assert!(
            config_text.contains(&format!("http://127.0.0.1:{proxy_port}/v1")),
            "all Codex upstreams failing must keep config.toml on the local proxy base_url"
        );
        assert!(
            !config_text.contains(&mock_a_base_url) && !config_text.contains(&mock_b_base_url),
            "Codex takeover config.toml must not be overwritten with a provider direct baseUrl"
        );
        assert_eq!(
            db.get_failover_queue("codex")
                .expect("read failover queue")
                .into_iter()
                .map(|item| item.provider_id)
                .collect::<Vec<_>>(),
            vec!["codex-a".to_string(), "codex-b".to_string()],
            "generic Codex upstream failures must not silently rewrite the failover queue"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
        mock_a_handle.abort();
        mock_b_handle.abort();
    }

    #[tokio::test]
    #[serial]
    async fn real_http_codex_failover_first_upstream_down_second_success_keeps_takeover_live_and_current_empty(
    ) {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let (mock_a_base_url, mock_a_handle) = start_mock_codex_responses_error_server().await;
        let (mock_b_base_url, mock_b_handle) = start_mock_codex_responses_success_server().await;

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider_a = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "token-a"
                },
                "config": format!(
                    "model_provider = \"codex-a\"\nmodel = \"gpt-5.4\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.codex-a]\nname = \"Codex A\"\nbase_url = \"{}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n",
                    mock_a_base_url
                )
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "codex-b".to_string(),
            "Codex B".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "token-b"
                },
                "config": format!(
                    "model_provider = \"codex-b\"\nmodel = \"gpt-5.4\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.codex-b]\nname = \"Codex B\"\nbase_url = \"{}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n",
                    mock_b_base_url
                )
            }),
            None,
        );

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("codex", "codex-a")
            .expect("queue provider a");
        db.add_to_failover_queue("codex", "codex-b")
            .expect("queue provider b");
        db.clear_current_provider("codex")
            .expect("clear DB current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Codex, None)
            .expect("clear local current provider for failover mode");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        app_config.max_retries = 1;
        app_config.circuit_failure_threshold = 1;
        app_config.circuit_timeout_seconds = 3600;
        app_config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable strict failover");

        let service = ProxyService::new(db.clone());
        let info = service.start().await.expect("start proxy service");
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &provider_a)
            .await
            .expect("seed takeover live");
        service
            .sync_failover_active_target("codex")
            .await
            .expect("sync initial failover target");

        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/responses", info.port))
            .json(&json!({
                "model": "gpt-5.4",
                "input": "hello",
                "stream": false
            }))
            .send()
            .await
            .expect("send proxied Codex request through real HTTP server");
        let status = response.status();
        let body = response.text().await.expect("read proxied response body");

        assert!(
            status.is_success(),
            "second Codex provider should satisfy the request after the first provider fails; status={status}, body={body}"
        );
        assert!(
            body.contains("resp_success_b"),
            "response should come from the second upstream provider"
        );

        let stats_a = service
            .get_circuit_breaker_stats("codex-a", "codex")
            .await
            .expect("read circuit breaker stats a")
            .expect("breaker a should exist");
        assert_eq!(
            stats_a.state,
            crate::proxy::circuit_breaker::CircuitState::Open,
            "provider a should be circuit-open after the failed attempt"
        );

        let proxy_status = service.get_status().await.expect("get proxy status");
        let active = proxy_status
            .active_targets
            .iter()
            .find(|target| target.app_type == "codex")
            .expect("Codex active target should be present");
        assert_eq!(
            active.provider_id, "codex-b",
            "successful fallback may update the runtime active target for display"
        );

        assert_eq!(
            db.get_current_provider("codex")
                .expect("read DB current provider"),
            None,
            "auto failover success must not restore DB current provider"
        );
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Codex),
            None,
            "auto failover success must not restore local current provider"
        );

        let live = service.read_codex_live().expect("read Codex live");
        assert_eq!(
            live.pointer("/auth/OPENAI_API_KEY").and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "successful fallback must keep the takeover token placeholder"
        );
        let config_text = live
            .get("config")
            .and_then(Value::as_str)
            .expect("Codex config.toml should exist");
        assert!(
            config_text.contains(&format!("http://127.0.0.1:{proxy_port}/v1")),
            "successful fallback must keep config.toml on the local proxy base_url"
        );
        assert!(
            !config_text.contains(&mock_a_base_url) && !config_text.contains(&mock_b_base_url),
            "successful fallback must not overwrite live config with any provider direct baseUrl"
        );
        assert_eq!(
            db.get_failover_queue("codex")
                .expect("read failover queue")
                .into_iter()
                .map(|item| item.provider_id)
                .collect::<Vec<_>>(),
            vec!["codex-a".to_string(), "codex-b".to_string()],
            "fallback success must not silently rewrite the failover queue"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
        mock_a_handle.abort();
        mock_b_handle.abort();
    }

    #[tokio::test]
    #[serial]
    async fn real_http_gemini_failover_all_upstreams_down_keeps_takeover_live_config() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let (mock_a_base_url, mock_a_handle) = start_mock_gemini_error_server().await;
        let (mock_b_base_url, mock_b_handle) = start_mock_gemini_error_server().await;

        let db = Arc::new(Database::memory().expect("init db"));
        let proxy_port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: proxy_port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider_a = Provider::with_id(
            "gemini-a".to_string(),
            "Gemini A".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "token-a",
                    "GOOGLE_GEMINI_BASE_URL": mock_a_base_url,
                    "GEMINI_MODEL": "gemini-3-pro"
                }
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "gemini-b".to_string(),
            "Gemini B".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "token-b",
                    "GOOGLE_GEMINI_BASE_URL": mock_b_base_url,
                    "GEMINI_MODEL": "gemini-3-pro"
                }
            }),
            None,
        );

        db.save_provider("gemini", &provider_a)
            .expect("save provider a");
        db.save_provider("gemini", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("gemini", "gemini-a")
            .expect("queue provider a");
        db.add_to_failover_queue("gemini", "gemini-b")
            .expect("queue provider b");
        db.set_current_provider("gemini", "gemini-a")
            .expect("seed direct current provider");
        crate::settings::set_current_provider(&AppType::Gemini, Some("gemini-a"))
            .expect("seed local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("gemini")
            .await
            .expect("get Gemini proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        app_config.max_retries = 1;
        app_config.circuit_failure_threshold = 1;
        app_config.circuit_timeout_seconds = 3600;
        app_config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable strict failover");

        let service = ProxyService::new(db.clone());
        let info = service.start().await.expect("start proxy service");
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Gemini, &provider_a)
            .await
            .expect("seed takeover live");
        service
            .sync_failover_active_target("gemini")
            .await
            .expect("sync initial failover target");

        let client = reqwest::Client::new();
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/v1beta/models/gemini-3-pro:generateContent?key=proxy-test",
                info.port
            ))
            .json(&json!({
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {
                                "text": "hello"
                            }
                        ]
                    }
                ]
            }))
            .send()
            .await
            .expect("send proxied Gemini request through real HTTP server");

        assert!(
            !response.status().is_success(),
            "all failing Gemini upstream providers should surface an error response"
        );

        let stats_a = service
            .get_circuit_breaker_stats("gemini-a", "gemini")
            .await
            .expect("read circuit breaker stats a")
            .expect("breaker a should exist");
        let stats_b = service
            .get_circuit_breaker_stats("gemini-b", "gemini")
            .await
            .expect("read circuit breaker stats b")
            .expect("breaker b should exist");
        assert_eq!(
            stats_a.state,
            crate::proxy::circuit_breaker::CircuitState::Open,
            "provider a should be circuit-open after the failed real Gemini request"
        );
        assert_eq!(
            stats_b.state,
            crate::proxy::circuit_breaker::CircuitState::Open,
            "provider b should be circuit-open after the failed real Gemini request"
        );

        let live = service.read_gemini_live().expect("read Gemini live");
        assert_eq!(
            live.pointer("/env/GOOGLE_GEMINI_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{proxy_port}").as_str()),
            "all Gemini upstreams failing must keep live on the local proxy endpoint"
        );
        assert_eq!(
            live.pointer("/env/GEMINI_API_KEY").and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "all Gemini upstreams failing must keep the takeover token placeholder"
        );

        let live_text = serde_json::to_string(&live).expect("serialize live config");
        assert!(
            !live_text.contains(&mock_a_base_url) && !live_text.contains(&mock_b_base_url),
            "Gemini takeover live config must not be overwritten with a provider direct baseUrl"
        );
        assert_eq!(
            db.get_failover_queue("gemini")
                .expect("read failover queue")
                .into_iter()
                .map(|item| item.provider_id)
                .collect::<Vec<_>>(),
            vec!["gemini-a".to_string(), "gemini-b".to_string()],
            "generic Gemini upstream failures must not silently rewrite the failover queue"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
        mock_a_handle.abort();
        mock_b_handle.abort();
    }

    #[tokio::test]
    #[serial]
    async fn clearing_active_failover_provider_then_sync_promotes_next_queue_target() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider_a = Provider::with_id(
            "a".to_string(),
            "Provider A".to_string(),
            json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "a", "ANTHROPIC_BASE_URL": "https://a.example" } }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "Provider B".to_string(),
            json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "b", "ANTHROPIC_BASE_URL": "https://b.example" } }),
            None,
        );

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("claude", "a")
            .expect("queue provider a");
        db.add_to_failover_queue("claude", "b")
            .expect("queue provider b");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable claude failover");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync initial target");

        db.remove_from_failover_queue("claude", "a")
            .expect("remove provider a from queue");
        service
            .clear_provider_runtime_state("a", "claude")
            .await
            .expect("clear provider a runtime state");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync promoted target");

        let status = service.get_status().await.expect("get status");
        let target = status
            .active_targets
            .iter()
            .find(|target| target.app_type == "claude")
            .expect("claude active target");
        assert_eq!(target.provider_id, "b");

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn sync_failover_active_target_clears_when_auto_failover_disabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "a".to_string(),
            "Provider A".to_string(),
            json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "a", "ANTHROPIC_BASE_URL": "https://a.example" } }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save provider");
        db.add_to_failover_queue("claude", "a")
            .expect("add provider to queue");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable auto failover");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");

        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync active target");
        assert!(service
            .get_status()
            .await
            .expect("get proxy status")
            .active_targets
            .iter()
            .any(|target| target.app_type == "claude"));

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.auto_failover_enabled = false;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("disable auto failover");

        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync disabled failover");
        assert!(
            service
                .get_status()
                .await
                .expect("get proxy status")
                .active_targets
                .iter()
                .all(|target| target.app_type != "claude"),
            "disabled failover must clear the stale queue active target"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn disabling_takeover_also_disables_auto_failover_for_that_app() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "codex-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.5"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-a")
            .expect("set current codex provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-a"))
            .expect("set local codex provider");
        db.add_to_failover_queue("codex", "codex-a")
            .expect("add codex provider to queue");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&provider.settings_config)
            .expect("seed codex live");
        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("enable codex takeover");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable codex failover");
        service
            .sync_failover_active_target("codex")
            .await
            .expect("sync failover active target");

        service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable codex takeover");

        let app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config after disable");
        assert!(!app_config.enabled);
        assert!(
            !app_config.auto_failover_enabled,
            "turning off app takeover must also turn off app failover"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn stop_with_restore_disables_all_app_failover_flags() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        for app_type in ["claude", "codex", "gemini"] {
            let mut config = db
                .get_proxy_config_for_app(app_type)
                .await
                .expect("get app config");
            config.enabled = app_type != "gemini";
            config.auto_failover_enabled = true;
            db.update_proxy_config_for_app(config)
                .await
                .expect("seed app config");
        }

        service
            .stop_with_restore()
            .await
            .expect("stop with restore should be idempotent");

        for app_type in ["claude", "codex", "gemini"] {
            let config = db
                .get_proxy_config_for_app(app_type)
                .await
                .expect("get app config after stop");
            assert!(
                !config.enabled,
                "manual proxy shutdown must disable {app_type} takeover"
            );
            assert!(
                !config.auto_failover_enabled,
                "manual proxy shutdown must disable {app_type} failover"
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn stop_with_restore_restores_failover_queue_head_as_direct_current_provider() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut provider_a = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example"
                }
            }),
            None,
        );
        provider_a.sort_index = Some(20);
        let mut provider_b = Provider::with_id(
            "claude-b".to_string(),
            "Claude B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-b",
                    "ANTHROPIC_BASE_URL": "https://b.example"
                }
            }),
            None,
        );
        provider_b.sort_index = Some(10);

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", &provider_a.id)
            .expect("seed db current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider_a.id))
            .expect("seed local current provider");
        db.add_to_failover_queue("claude", &provider_a.id)
            .expect("queue provider a");
        db.add_to_failover_queue("claude", &provider_b.id)
            .expect("queue provider b");

        let service = ProxyService::new(db.clone());
        service
            .write_claude_live(&provider_a.settings_config)
            .expect("seed direct claude live");
        service
            .set_takeover_for_app("claude", true)
            .await
            .expect("enable claude takeover");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable claude failover");
        db.clear_current_provider("claude")
            .expect("clear db current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Claude, None)
            .expect("clear local current provider for failover mode");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync failover queue head");

        service
            .stop_with_restore()
            .await
            .expect("manual proxy shutdown should restore direct mode");

        let repaired = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config after stop");
        assert!(!repaired.enabled);
        assert!(!repaired.auto_failover_enabled);
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Claude)
                .expect("get effective current provider"),
            Some(provider_b.id.clone()),
            "manual proxy shutdown from failover mode must restore queue head as direct current provider"
        );

        let live = service
            .read_claude_live()
            .expect("read restored claude live");
        assert_eq!(
            live, provider_b.settings_config,
            "manual proxy shutdown from failover mode must restore queue head direct live config"
        );

        let status = service
            .get_status()
            .await
            .expect("get proxy status after stop");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "claude"),
            "manual proxy shutdown must clear stale failover active target"
        );
    }

    #[tokio::test]
    #[serial]
    async fn stop_with_restore_keep_state_preserves_takeover_live_when_failover_stays_enabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut provider_a = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example"
                }
            }),
            None,
        );
        provider_a.sort_index = Some(20);
        let mut provider_b = Provider::with_id(
            "claude-b".to_string(),
            "Claude B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-b",
                    "ANTHROPIC_BASE_URL": "https://b.example"
                }
            }),
            None,
        );
        provider_b.sort_index = Some(10);

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", &provider_a.id)
            .expect("seed db current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider_a.id))
            .expect("seed local current provider");
        db.add_to_failover_queue("claude", &provider_a.id)
            .expect("queue provider a");
        db.add_to_failover_queue("claude", &provider_b.id)
            .expect("queue provider b");

        let service = ProxyService::new(db.clone());
        service
            .write_claude_live(&provider_a.settings_config)
            .expect("seed direct claude live");
        service
            .set_takeover_for_app("claude", true)
            .await
            .expect("enable claude takeover");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable claude failover");
        db.clear_current_provider("claude")
            .expect("clear db current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Claude, None)
            .expect("clear local current provider for failover mode");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync failover queue head");

        service
            .stop_with_restore_keep_state()
            .await
            .expect("exit cleanup should preserve takeover mode state");

        let preserved = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config after keep-state stop");
        assert!(
            preserved.enabled,
            "exit cleanup should preserve takeover-enabled state for next startup restore"
        );
        assert!(
            preserved.auto_failover_enabled,
            "exit cleanup should preserve failover-enabled state for next startup restore"
        );
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Claude)
                .expect("get effective current provider after keep-state stop"),
            None,
            "keep-state shutdown from failover mode must not recreate a direct current provider"
        );

        let live = service
            .read_claude_live()
            .expect("read restored claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "keep-state shutdown must preserve Claude takeover live on the local proxy endpoint when failover remains enabled"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "keep-state shutdown must preserve takeover token placeholder instead of restoring a direct provider config"
        );
        assert!(
            !service.is_running().await,
            "keep-state shutdown must stop the proxy process before exit"
        );
    }

    #[tokio::test]
    #[serial]
    async fn keep_state_shutdown_followed_by_takeover_restore_uses_queue_head_as_restart_baseline()
    {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut provider_a = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example",
                    "ANTHROPIC_MODEL": "model-a"
                }
            }),
            None,
        );
        provider_a.sort_index = Some(20);
        let mut provider_b = Provider::with_id(
            "claude-b".to_string(),
            "Claude B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-b",
                    "ANTHROPIC_BASE_URL": "https://b.example",
                    "ANTHROPIC_MODEL": "model-b"
                }
            }),
            None,
        );
        provider_b.sort_index = Some(10);

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", &provider_a.id)
            .expect("seed db current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider_a.id))
            .expect("seed local current provider");
        db.add_to_failover_queue("claude", &provider_a.id)
            .expect("queue provider a");
        db.add_to_failover_queue("claude", &provider_b.id)
            .expect("queue provider b");

        let service = ProxyService::new(db.clone());
        service
            .write_claude_live(&provider_a.settings_config)
            .expect("seed direct claude live");
        service
            .set_takeover_for_app("claude", true)
            .await
            .expect("enable claude takeover");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable claude failover");
        db.clear_current_provider("claude")
            .expect("clear db current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Claude, None)
            .expect("clear local current provider for failover mode");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync failover queue head");

        service
            .stop_with_restore_keep_state()
            .await
            .expect("keep-state shutdown should preserve restart flags");

        let restarted = ProxyService::new(db.clone());
        restarted
            .set_takeover_for_app("claude", true)
            .await
            .expect("startup restore should re-enable claude takeover");

        let live = restarted
            .read_claude_live()
            .expect("read claude live after startup restore");
        let expected_proxy_url = format!("http://127.0.0.1:{port}");
        assert_eq!(
            live.get("env")
                .and_then(|value| value.get("ANTHROPIC_BASE_URL"))
                .and_then(|value| value.as_str()),
            Some(expected_proxy_url.as_str()),
            "startup restore after keep-state shutdown must rebuild Claude live back to the local proxy endpoint"
        );
        assert_eq!(
            live.get("env")
                .and_then(|value| value.get("ANTHROPIC_AUTH_TOKEN"))
                .and_then(|value| value.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "startup restore after keep-state shutdown must preserve the takeover token placeholder"
        );
        assert_ne!(
            live.get("env")
                .and_then(|value| value.get("ANTHROPIC_BASE_URL"))
                .and_then(|value| value.as_str()),
            Some("https://a.example"),
            "startup restore must not regress to the pre-failover provider endpoint"
        );
        assert_ne!(
            live.get("env")
                .and_then(|value| value.get("ANTHROPIC_BASE_URL"))
                .and_then(|value| value.as_str()),
            Some("https://b.example"),
            "startup restore must not leave the queue-head direct endpoint in live after takeover resumes"
        );
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Claude)
                .expect("get effective current provider after startup restore"),
            None,
            "failover takeover restore must clear direct current provider again after rebuilding the proxy live config"
        );

        let status = restarted
            .get_status()
            .await
            .expect("get proxy status after startup restore");
        let active = status
            .active_targets
            .iter()
            .find(|target| target.app_type == "claude")
            .expect("claude active target should be restored from the failover queue");
        assert_eq!(active.provider_id, provider_b.id);

        restarted.stop().await.expect("stop proxy service");
    }

    #[tokio::test]
    #[serial]
    async fn turning_off_app_takeover_in_failover_mode_restores_queue_head_as_direct_current_provider(
    ) {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut provider_a = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example"
                }
            }),
            None,
        );
        provider_a.sort_index = Some(20);
        let mut provider_b = Provider::with_id(
            "claude-b".to_string(),
            "Claude B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-b",
                    "ANTHROPIC_BASE_URL": "https://b.example"
                }
            }),
            None,
        );
        provider_b.sort_index = Some(10);

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.set_current_provider("claude", &provider_a.id)
            .expect("seed db current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider_a.id))
            .expect("seed local current provider");
        db.add_to_failover_queue("claude", &provider_a.id)
            .expect("queue provider a");
        db.add_to_failover_queue("claude", &provider_b.id)
            .expect("queue provider b");

        let service = ProxyService::new(db.clone());
        service
            .write_claude_live(&provider_a.settings_config)
            .expect("seed direct claude live");
        service
            .set_takeover_for_app("claude", true)
            .await
            .expect("enable claude takeover");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable claude failover");
        db.clear_current_provider("claude")
            .expect("clear db current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Claude, None)
            .expect("clear local current provider for failover mode");
        service
            .sync_failover_active_target("claude")
            .await
            .expect("sync failover queue head");

        service
            .set_takeover_for_app("claude", false)
            .await
            .expect("disable claude takeover from failover mode");

        let repaired = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config after disable");
        assert!(!repaired.enabled);
        assert!(!repaired.auto_failover_enabled);
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Claude)
                .expect("get effective current provider"),
            Some(provider_b.id.clone()),
            "turning off takeover from failover mode must restore queue head as the direct current provider"
        );

        let live: Value =
            read_json_file(&get_claude_settings_path()).expect("read restored claude live");
        assert_eq!(
            live, provider_b.settings_config,
            "turning off takeover from failover mode must restore direct live config for the queue head provider"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn disabling_takeover_for_one_app_clears_its_active_target_while_proxy_keeps_running() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let claude_provider = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "a", "ANTHROPIC_BASE_URL": "https://a.example" } }),
            None,
        );
        db.save_provider("claude", &claude_provider)
            .expect("save claude provider");
        db.set_current_provider("claude", "claude-a")
            .expect("set current claude provider");
        crate::settings::set_current_provider(&AppType::Claude, Some("claude-a"))
            .expect("set local claude provider");

        let codex_provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "codex-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.4"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &codex_provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-a")
            .expect("set current codex provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-a"))
            .expect("set local codex provider");

        let service = ProxyService::new(db.clone());
        service
            .write_claude_live(&claude_provider.settings_config)
            .expect("seed claude live");
        service
            .write_codex_live(&codex_provider.settings_config)
            .expect("seed codex live");

        service
            .set_takeover_for_app("claude", true)
            .await
            .expect("enable claude takeover");
        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("enable codex takeover");

        service
            .set_active_target_only("claude", "claude-a", "Claude A")
            .await;
        service
            .set_active_target_only("codex", "codex-a", "Codex A")
            .await;

        service
            .set_takeover_for_app("claude", false)
            .await
            .expect("disable claude takeover");

        let status = service.get_status().await.expect("get proxy status");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "claude"),
            "disabled app must not keep a stale active target while proxy remains running"
        );
        assert!(
            status
                .active_targets
                .iter()
                .any(|target| target.app_type == "codex"),
            "other active app should keep the proxy server running"
        );

        service.stop().await.expect("stop proxy service");
    }

    #[tokio::test]
    #[serial]
    async fn enabling_takeover_syncs_failover_active_target_when_failover_already_enabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "codex-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.4"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-a")
            .expect("set current codex provider");
        db.add_to_failover_queue("codex", "codex-a")
            .expect("add codex provider to queue");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-a"))
            .expect("set local codex provider");

        {
            // 直接模拟旧版本/异常数据库里残留的脏状态：
            // DAO 现在会自动清洗这个组合，所以测试必须绕过 DAO 来验证
            // 接管启动时的修复与同步逻辑。
            let conn = db
                .conn
                .lock()
                .expect("lock db conn for stale proxy config seed");
            conn.execute(
                "UPDATE proxy_config SET
                    enabled = 0,
                    auto_failover_enabled = 1,
                    load_balancing_enabled = 0,
                    updated_at = datetime('now')
                 WHERE app_type = ?1",
                rusqlite::params!["codex"],
            )
            .expect("seed stale codex proxy config");
        }

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&provider.settings_config)
            .expect("seed codex live");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("enable codex takeover");

        let status = service.get_status().await.expect("get proxy status");
        let active = status
            .active_targets
            .iter()
            .find(|target| target.app_type == "codex")
            .expect("codex active target should be synced from failover queue");
        assert_eq!(active.provider_id, "codex-a");
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Codex)
                .expect("get effective current after enabling failover takeover"),
            None,
            "failover mode must not retain a stale current provider after takeover starts"
        );
        assert_eq!(
            db.get_current_provider("codex")
                .expect("get db current after enabling failover takeover"),
            None,
            "failover mode must clear DB is_current when takeover starts with failover already enabled"
        );

        service.stop().await.expect("stop proxy service");
    }

    #[tokio::test]
    #[serial]
    async fn disabling_takeover_repairs_stale_failover_flag_even_when_takeover_was_already_off() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "claude-key",
                    "ANTHROPIC_BASE_URL": "https://claude.example"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");
        db.add_to_failover_queue("claude", "claude-a")
            .expect("queue provider");
        crate::settings::set_current_provider(&AppType::Claude, Some("claude-a"))
            .expect("seed local current");
        db.set_current_provider("claude", "claude-a")
            .expect("seed db current");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = false;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("seed stale failover flag");

        db.update_provider_health("claude-a", "claude", false, Some("boom".into()))
            .await
            .expect("seed health");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");
        service
            .set_active_target_only("claude", "claude-a", "Claude A")
            .await;

        service
            .set_takeover_for_app("claude", false)
            .await
            .expect("disable takeover should repair stale failover state");

        let repaired = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get repaired claude config");
        assert!(!repaired.enabled, "repair path must keep takeover disabled");
        assert!(
            !repaired.auto_failover_enabled,
            "repair path must clear stale failover flag even if takeover was already off"
        );
        let status = service.get_status().await.expect("get proxy status");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "claude"),
            "repair path must clear stale active target"
        );
        let health = db
            .get_provider_health("claude-a", "claude")
            .await
            .expect("get provider health after repair");
        assert_eq!(
            health.consecutive_failures, 0,
            "repair path must clear stale provider health for the disabled app"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn idempotent_takeover_syncs_failover_active_target_when_live_already_taken_over() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "codex-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.4"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.add_to_failover_queue("codex", "codex-a")
            .expect("add codex provider to queue");

        let backup = serde_json::to_string(&provider.settings_config).expect("serialize backup");
        db.save_live_backup("codex", &backup)
            .await
            .expect("seed live backup");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("mark takeover enabled");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": format!(r#"model_provider = "cc-switch"
model = "gpt-5.4"

[model_providers.cc-switch]
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
"#)
            }))
            .expect("seed already taken-over codex live");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("idempotent takeover");

        let status = service.get_status().await.expect("get proxy status");
        let active = status
            .active_targets
            .iter()
            .find(|target| target.app_type == "codex")
            .expect("codex active target should be synced in idempotent takeover path");
        assert_eq!(active.provider_id, "codex-a");

        service.stop().await.expect("stop proxy service");
    }

    #[tokio::test]
    #[serial]
    async fn idempotent_takeover_rebuilds_missing_backup_from_current_provider() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "codex-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.4"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-a")
            .expect("set current codex provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-a"))
            .expect("set local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("mark takeover enabled");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": format!(r#"model_provider = "cc-switch"
model = "gpt-5.4"

[model_providers.cc-switch]
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
"#)
            }))
            .expect("seed already taken-over codex live without backup");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("idempotent takeover should repair missing backup");

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup should be rebuilt from current provider");
        let backup_value: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup");
        let backup_config = backup_value
            .get("config")
            .and_then(|value| value.as_str())
            .expect("backup config should be present");

        assert_eq!(
            backup_value
                .get("auth")
                .and_then(|value| value.get("OPENAI_API_KEY"))
                .and_then(|value| value.as_str()),
            Some("codex-key")
        );
        assert!(
            backup_config.contains("https://codex.example/v1"),
            "rebuilt backup should restore the current provider endpoint"
        );
        assert!(
            !backup_config.contains(PROXY_TOKEN_PLACEHOLDER)
                && !backup_config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "rebuilt backup must not save the already taken-over live config as original"
        );

        service.stop().await.expect("stop proxy service");
    }

    #[tokio::test]
    #[serial]
    async fn restore_live_fallback_keeps_takeover_live_when_app_is_still_enabled() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example",
                    "ANTHROPIC_MODEL": "model-a"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");
        db.set_current_provider("claude", &provider.id)
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider.id))
            .expect("set local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Claude, &provider)
            .await
            .expect("seed takeover live");

        db.delete_live_backup("claude")
            .await
            .expect("ensure live backup is missing");

        service
            .restore_live_config_for_app_with_fallback(&AppType::Claude)
            .await
            .expect("restore live with fallback");

        let live = service.read_claude_live().expect("read claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "fallback restore must keep Claude on proxy takeover endpoint while the app still has takeover enabled"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "fallback restore must keep the takeover token placeholder while takeover remains enabled"
        );

        if service.is_running().await {
            service.stop().await.expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn restore_live_fallback_keeps_takeover_live_when_takeover_is_enabled_but_proxy_stopped()
    {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example",
                    "ANTHROPIC_MODEL": "model-a"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");
        db.set_current_provider("claude", &provider.id)
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider.id))
            .expect("set local current provider");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("keep takeover enabled");

        let service = ProxyService::new(db.clone());
        service
            .write_claude_live(&json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": PROXY_TOKEN_PLACEHOLDER,
                    "ANTHROPIC_BASE_URL": format!("http://127.0.0.1:{port}"),
                    "ANTHROPIC_MODEL": "stale-model"
                }
            }))
            .expect("seed takeover live");
        db.delete_live_backup("claude")
            .await
            .expect("ensure live backup is missing");

        service
            .restore_live_config_for_app_with_fallback(&AppType::Claude)
            .await
            .expect("restore live with fallback while proxy is stopped");

        let live = service.read_claude_live().expect("read claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "fallback restore must keep Claude on the proxy takeover endpoint while enabled=true even if the proxy process is not running yet"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "fallback restore must keep the takeover placeholder while enabled=true even if the proxy process is not running yet"
        );
    }

    #[tokio::test]
    #[serial]
    async fn takeover_does_not_backup_existing_placeholder_live_when_no_restore_target_exists() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
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
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("mark takeover enabled");

        let service = ProxyService::new(db.clone());
        service
            .write_claude_live(&json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": PROXY_TOKEN_PLACEHOLDER,
                    "ANTHROPIC_BASE_URL": "http://127.0.0.1:1"
                }
            }))
            .expect("seed stale taken-over claude live without backup");

        service
            .set_takeover_for_app("claude", true)
            .await
            .expect("repair takeover without restore target");

        assert!(
            db.get_live_backup("claude")
                .await
                .expect("get live backup")
                .is_none(),
            "stale proxy placeholder live must not be saved as the original restore backup"
        );

        service
            .set_takeover_for_app("claude", false)
            .await
            .expect("disable takeover with fallback cleanup");

        let live = service
            .read_claude_live()
            .expect("read cleaned claude live");
        let env = live
            .get("env")
            .and_then(|value| value.as_object())
            .expect("env should be present");
        assert!(
            !env.values()
                .any(|value| value.as_str() == Some(PROXY_TOKEN_PLACEHOLDER)),
            "fallback cleanup should remove proxy placeholders when no backup exists"
        );
        assert!(
            env.get("ANTHROPIC_BASE_URL").is_none(),
            "fallback cleanup should remove stale local proxy base URL"
        );
    }

    #[tokio::test]
    #[serial]
    async fn takeover_rebuilds_backup_when_config_disabled_but_live_still_has_placeholder() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "codex-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.4"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", "codex-a")
            .expect("set current codex provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("codex-a"))
            .expect("set local current provider");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": r#"model_provider = "cc-switch"
model = "gpt-5.5"

[model_providers.cc-switch]
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
"#
            }))
            .expect("seed stale taken-over codex live while config is disabled");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("enable takeover should repair stale placeholder live first");

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup should be rebuilt from current provider");
        let backup_value: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup");
        let backup_config = backup_value
            .get("config")
            .and_then(|value| value.as_str())
            .expect("backup config should be present");

        assert_eq!(
            backup_value
                .get("auth")
                .and_then(|value| value.get("OPENAI_API_KEY"))
                .and_then(|value| value.as_str()),
            Some("codex-key")
        );
        assert!(
            backup_config.contains("https://codex.example/v1"),
            "backup should come from the current provider, not the stale proxy live"
        );
        assert!(
            !backup_config.contains(PROXY_TOKEN_PLACEHOLDER)
                && !backup_config.contains("http://127.0.0.1:1/v1"),
            "stale proxy placeholder live must not be saved as original backup"
        );

        service
            .set_takeover_for_app("codex", false)
            .await
            .expect("disable takeover should restore repaired backup");

        let restored = service.read_codex_live().expect("read restored codex live");
        let restored_config = restored
            .get("config")
            .and_then(|value| value.as_str())
            .expect("restored config should be present");
        assert!(
            restored_config.contains("https://codex.example/v1"),
            "disable takeover should restore the real provider endpoint"
        );
        assert!(
            !restored_config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "disable takeover should not leave the local proxy endpoint behind"
        );
    }

    #[tokio::test]
    #[serial]
    async fn recover_from_crash_refreshes_stale_backup_to_failover_queue_head() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let stale_provider = Provider::with_id(
            "codex-stale".to_string(),
            "Codex Stale".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "stale-key"
                },
                "config": r#"model_provider = "codex-stale"
model = "gpt-5.5"

[model_providers.codex-stale]
base_url = "https://stale.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        let queue_head = Provider::with_id(
            "codex-head".to_string(),
            "Codex Head".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "head-key"
                },
                "config": r#"model_provider = "codex-head"
model = "gpt-5.5"

[model_providers.codex-head]
base_url = "https://head.example/v1"
wire_api = "responses"

[mcp_servers.memory]
command = "npx"
"#
            }),
            None,
        );

        db.save_provider("codex", &stale_provider)
            .expect("save stale provider");
        db.save_provider("codex", &queue_head)
            .expect("save queue head provider");
        db.set_current_provider("codex", &stale_provider.id)
            .expect("seed stale db current");
        crate::settings::set_current_provider(&AppType::Codex, Some(&stale_provider.id))
            .expect("seed stale local current");
        db.add_to_failover_queue("codex", &queue_head.id)
            .expect("queue head provider");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        db.save_live_backup(
            "codex",
            &serde_json::to_string(&stale_provider.settings_config)
                .expect("serialize stale backup"),
        )
        .await
        .expect("seed stale backup");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": format!(r#"model_provider = "cc-switch"
model = "gpt-5.5"

[model_providers.cc-switch]
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
"#)
            }))
            .expect("seed takeover live");

        service
            .recover_from_crash()
            .await
            .expect("recover from crash");

        let repaired = db
            .get_live_backup("codex")
            .await
            .expect("get repaired backup")
            .expect("backup should still exist");
        let repaired_value: Value =
            serde_json::from_str(&repaired.original_config).expect("parse repaired backup");
        let repaired_config = repaired_value
            .get("config")
            .and_then(Value::as_str)
            .expect("repaired config should exist");

        assert!(
            repaired_config.contains("https://head.example/v1"),
            "crash recovery should rebuild backup from failover queue head instead of preserving stale provider endpoint"
        );
        assert!(
            repaired_config.contains("[mcp_servers.memory]"),
            "crash recovery should preserve MCP content from the new restore target backup"
        );
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Codex)
                .expect("get effective current"),
            None,
            "failover crash recovery must clear stale current provider state"
        );
    }

    #[tokio::test]
    #[serial]
    async fn recover_from_crash_keeps_codex_takeover_live_when_failover_target_was_deleted() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let provider = Provider::with_id(
            "codex-deleted".to_string(),
            "Codex Deleted".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deleted-key"
                },
                "config": r#"model_provider = "codex-deleted"
model = "gpt-5.4"

[model_providers.codex-deleted]
base_url = "https://deleted.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.add_to_failover_queue("codex", &provider.id)
            .expect("queue provider");
        db.save_mcp_server(&crate::app_config::McpServer {
            id: "memory".to_string(),
            name: "Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: crate::app_config::McpApps {
                codex: true,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save codex mcp server");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        let service = ProxyService::new(db.clone());
        service.start().await.expect("start proxy service");
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &provider)
            .await
            .expect("seed codex takeover live");
        service
            .update_live_backup_from_provider("codex", &provider)
            .await
            .expect("seed codex backup");
        service
            .stop_with_restore_keep_state()
            .await
            .expect("preserve takeover state on shutdown");

        db.delete_provider("codex", &provider.id)
            .expect("delete queued provider after shutdown");

        service
            .recover_from_crash()
            .await
            .expect("recover from crash");
        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("startup restore should rebuild takeover live without deleted provider");

        let auth = service
            .read_codex_live()
            .expect("read codex live after startup restore");
        assert_eq!(
            auth.get("auth")
                .and_then(|value| value.get("OPENAI_API_KEY"))
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "startup restore must keep Codex auth on the proxy placeholder after the queued provider was deleted"
        );

        let config = auth
            .get("config")
            .and_then(Value::as_str)
            .expect("config should exist");
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "startup restore must keep Codex live on the local proxy endpoint after the queued provider was deleted"
        );
        assert!(
            !config.contains("https://deleted.example/v1"),
            "deleted provider endpoint must not reappear in Codex live during startup restore"
        );
        assert!(
            config.contains("[mcp_servers.memory]"),
            "startup restore must preserve DB-managed Codex MCP servers after the queued provider was deleted"
        );
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Codex)
                .expect("get effective current after restore"),
            None,
            "failover-mode startup restore must not recreate a direct current provider after the queued provider was deleted"
        );
    }

    #[tokio::test]
    #[serial]
    async fn startup_takeover_rewrites_stale_direct_codex_live_when_failover_target_is_missing() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let deleted_provider = Provider::with_id(
            "codex-stale".to_string(),
            "Codex Stale".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "stale-key"
                },
                "config": r#"model_provider = "codex-stale"
model = "gpt-5.4"

[model_providers.codex-stale]
base_url = "https://stale.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &deleted_provider)
            .expect("save stale provider");
        db.add_to_failover_queue("codex", &deleted_provider.id)
            .expect("queue stale provider");
        db.set_current_provider("codex", &deleted_provider.id)
            .expect("seed stale db current");
        crate::settings::set_current_provider(&AppType::Codex, Some(&deleted_provider.id))
            .expect("seed stale local current");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&deleted_provider.settings_config)
            .expect("seed stale direct codex live");
        db.save_live_backup(
            "codex",
            &serde_json::to_string(&deleted_provider.settings_config)
                .expect("serialize stale backup"),
        )
        .await
        .expect("seed stale backup");

        db.delete_provider("codex", &deleted_provider.id)
            .expect("delete stale provider before startup restore");

        service
            .recover_from_crash()
            .await
            .expect("recover stale crash state");
        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("startup takeover should rewrite stale direct live");

        let live = service
            .read_codex_live()
            .expect("read rewritten codex live");
        assert_eq!(
            live.get("auth")
                .and_then(|value| value.get("OPENAI_API_KEY"))
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "startup takeover must rewrite auth.json to the proxy placeholder even when the old failover target was deleted"
        );

        let config = live
            .get("config")
            .and_then(Value::as_str)
            .expect("config should exist");
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "startup takeover must rewrite stale direct Codex live to the local proxy endpoint"
        );
        assert!(
            !config.contains("https://stale.example/v1"),
            "deleted provider base_url must not survive startup takeover restore"
        );
    }

    #[tokio::test]
    #[serial]
    async fn startup_takeover_refreshes_codex_mcp_even_when_live_already_points_to_proxy() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n\n{mcpConfig}\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        db.save_mcp_server(&crate::app_config::McpServer {
            id: "memory".to_string(),
            name: "Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: crate::app_config::McpApps {
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
                "auth": {
                    "OPENAI_API_KEY": "real-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.5"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.add_to_failover_queue("codex", &provider.id)
            .expect("queue provider");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        db.save_live_backup(
            "codex",
            &serde_json::to_string(&provider.settings_config).expect("serialize backup"),
        )
        .await
        .expect("seed backup");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": format!(r#"model_provider = "cc-switch"
model = "gpt-5.5"

[model_providers.cc-switch]
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
"#)
            }))
            .expect("seed stale takeover live without mcp");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("startup takeover should refresh existing takeover live");

        let live = service.read_codex_live().expect("read codex live");
        let config = live
            .get("config")
            .and_then(Value::as_str)
            .expect("config should exist");
        assert!(
            config.contains("[mcp_servers.memory]"),
            "startup takeover should refresh Codex takeover template to include latest MCP config even when live already points to the proxy"
        );
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "startup takeover refresh must keep Codex live on the local proxy endpoint"
        );
    }

    #[tokio::test]
    #[serial]
    async fn enabling_codex_takeover_imports_existing_live_mcp_before_rewrite() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "real-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.5"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.set_current_provider("codex", &provider.id)
            .expect("set db current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some(&provider.id))
            .expect("set local current provider");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": "real-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.5"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"

[mcp_servers.memory]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-memory"]
"#
            }))
            .expect("seed codex live with existing mcp");

        service
            .set_takeover_for_app("codex", true)
            .await
            .expect("enable codex takeover");

        let servers = db.get_all_mcp_servers().expect("load mcp servers");
        let server = servers
            .get("memory")
            .expect("memory mcp should be imported");
        assert!(
            server.apps.codex,
            "existing Codex live MCP should be imported into DB before takeover rewrites the live config"
        );

        let live = service.read_codex_live().expect("read codex takeover live");
        let config = live
            .get("config")
            .and_then(Value::as_str)
            .expect("config should exist");
        assert!(
            config.contains("[mcp_servers.memory]"),
            "Codex takeover rewrite should preserve/import the pre-existing live MCP definition"
        );
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "Codex takeover rewrite must still point to the local proxy endpoint"
        );
    }

    #[tokio::test]
    #[serial]
    async fn enabling_gemini_takeover_imports_existing_live_mcp_before_rewrite() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "gemini-a".to_string(),
            "Gemini A".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "real-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                },
                "config": {
                    "general": {
                        "theme": "light"
                    }
                }
            }),
            None,
        );
        db.save_provider("gemini", &provider)
            .expect("save gemini provider");
        db.set_current_provider("gemini", &provider.id)
            .expect("set db current provider");
        crate::settings::set_current_provider(&AppType::Gemini, Some(&provider.id))
            .expect("set local current provider");

        let service = ProxyService::new(db.clone());
        service
            .write_gemini_live(&json!({
                "env": {
                    "GEMINI_API_KEY": "real-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                },
                "config": {
                    "general": {
                        "theme": "light"
                    },
                    "mcpServers": {
                        "memory": {
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-memory"]
                        }
                    }
                }
            }))
            .expect("seed gemini live with existing mcp");

        service
            .set_takeover_for_app("gemini", true)
            .await
            .expect("enable gemini takeover");

        let servers = db.get_all_mcp_servers().expect("load mcp servers");
        let server = servers
            .get("memory")
            .expect("memory mcp should be imported");
        assert!(
            server.apps.gemini,
            "existing Gemini live MCP should be imported into DB before takeover rewrites the live config"
        );

        let live = service
            .read_gemini_live()
            .expect("read gemini takeover live");
        assert_eq!(
            live.pointer("/env/GOOGLE_GEMINI_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "Gemini takeover rewrite must still point to the local proxy endpoint"
        );
        assert_eq!(
            live.pointer("/config/mcpServers/memory/command")
                .and_then(Value::as_str),
            Some("npx"),
            "Gemini takeover rewrite should preserve/import the pre-existing live MCP definition"
        );
    }

    #[tokio::test]
    #[serial]
    async fn keep_state_restart_clears_stale_deleted_codex_current_before_takeover_restore() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let deleted_provider = Provider::with_id(
            "codex-deleted".to_string(),
            "Codex Deleted".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deleted-key"
                },
                "config": r#"model_provider = "codex-deleted"
model = "gpt-5.4"

[model_providers.codex-deleted]
base_url = "https://deleted.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &deleted_provider)
            .expect("save deleted provider");
        db.add_to_failover_queue("codex", &deleted_provider.id)
            .expect("queue deleted provider");
        db.set_current_provider("codex", &deleted_provider.id)
            .expect("seed stale db current");
        crate::settings::set_current_provider(&AppType::Codex, Some(&deleted_provider.id))
            .expect("seed stale local current");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        let service = ProxyService::new(db.clone());
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &deleted_provider)
            .await
            .expect("seed takeover live");
        service
            .update_live_backup_from_provider("codex", &deleted_provider)
            .await
            .expect("seed takeover backup");
        service
            .stop_with_restore_keep_state()
            .await
            .expect("keep-state shutdown");

        db.delete_provider("codex", &deleted_provider.id)
            .expect("delete provider after keep-state shutdown");

        let restarted = ProxyService::new(db.clone());
        restarted
            .set_takeover_for_app("codex", true)
            .await
            .expect("restart takeover restore should tolerate deleted stale current");

        let live = restarted
            .read_codex_live()
            .expect("read codex live after restart restore");
        let config = live
            .get("config")
            .and_then(Value::as_str)
            .expect("config should exist");
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "restart takeover restore must keep Codex live on the local proxy endpoint even when stale DB current pointed to a deleted provider"
        );
        assert!(
            !config.contains("https://deleted.example/v1"),
            "deleted provider base_url must not be reintroduced by stale DB current during restart takeover restore"
        );
        assert_eq!(
            crate::settings::get_effective_current_provider(&db, &AppType::Codex)
                .expect("get effective current after restart restore"),
            None,
            "effective current must clear deleted DB current residues during restart takeover restore"
        );
        assert_eq!(
            db.get_current_provider("codex")
                .expect("get raw db current after restart restore"),
            None,
            "restart takeover restore must clear raw DB is_current when it points to a deleted provider"
        );
    }

    #[tokio::test]
    #[serial]
    async fn recover_from_crash_rewrites_stale_direct_codex_live_back_to_takeover() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let deleted_provider = Provider::with_id(
            "codex-deleted".to_string(),
            "Codex Deleted".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deleted-key"
                },
                "config": r#"model_provider = "codex-deleted"
model = "gpt-5.4"

[model_providers.codex-deleted]
base_url = "https://deleted.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &deleted_provider)
            .expect("save stale provider");
        db.add_to_failover_queue("codex", &deleted_provider.id)
            .expect("queue stale provider");
        db.set_current_provider("codex", &deleted_provider.id)
            .expect("seed stale db current");
        crate::settings::set_current_provider(&AppType::Codex, Some(&deleted_provider.id))
            .expect("seed stale local current");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        let service = ProxyService::new(db.clone());
        service
            .write_codex_live(&deleted_provider.settings_config)
            .expect("seed stale direct codex live");
        db.save_live_backup(
            "codex",
            &serde_json::to_string(&deleted_provider.settings_config)
                .expect("serialize stale backup"),
        )
        .await
        .expect("seed stale backup");

        db.delete_provider("codex", &deleted_provider.id)
            .expect("delete stale provider before crash recovery");

        service
            .recover_from_crash()
            .await
            .expect("recover from crash");

        let live = service.read_codex_live().expect("read repaired codex live");
        assert_eq!(
            live.get("auth")
                .and_then(|value| value.get("OPENAI_API_KEY"))
                .and_then(Value::as_str),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "crash recovery must restore the takeover auth placeholder instead of leaving a direct provider token in Codex live"
        );

        let config = live
            .get("config")
            .and_then(Value::as_str)
            .expect("config should exist");
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "crash recovery must rewrite stale direct Codex live to the local proxy endpoint while takeover remains enabled"
        );
        assert!(
            !config.contains("https://deleted.example/v1"),
            "crash recovery must not preserve a deleted provider endpoint in Codex live"
        );
    }

    #[tokio::test]
    #[serial]
    async fn proxy_active_sync_renders_gemini_template_without_leaking_real_credentials() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        db.update_proxy_config(ProxyConfig {
            listen_port: 32124,
            ..Default::default()
        })
        .await
        .expect("set proxy config");
        db.set_config_template(
            "gemini",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "env",
                        "label": ".env",
                        "content": "GOOGLE_GEMINI_BASE_URL={proxyBaseUrl}\nGEMINI_API_KEY={proxyToken}\nGEMINI_MODEL=gemini-3.1-pro-preview\nGEMINI_SANDBOX=1\n"
                    },
                    {
                        "key": "settings",
                        "label": "settings.json",
                        "content": "{\n  \"mcpServers\": {mcpConfig}\n}\n"
                    }
                ]))
                .expect("serialize gemini template"),
            ),
        )
        .expect("set gemini template");

        let service = ProxyService::new(db.clone());
        let provider = Provider::with_id(
            "gemini-a".to_string(),
            "Gemini A".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "real-gemini-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3-pro"
                },
                "config": {
                    "general": {
                        "previewFeatures": true
                    }
                }
            }),
            None,
        );

        service
            .sync_live_from_provider_while_proxy_active(&AppType::Gemini, &provider)
            .await
            .expect("sync gemini live while proxy active");

        let live = service.read_gemini_live().expect("read gemini live");
        let env = live
            .get("env")
            .and_then(|v| v.as_object())
            .expect("Gemini env should be present");
        assert_eq!(
            env.get("GEMINI_API_KEY").and_then(|v| v.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER),
            "Gemini .env must keep the proxy placeholder while takeover is active"
        );
        assert_eq!(
            env.get("GOOGLE_GEMINI_BASE_URL").and_then(|v| v.as_str()),
            Some("http://127.0.0.1:32124"),
            "Gemini live env should point to the local proxy during takeover"
        );
        assert_eq!(
            env.get("GEMINI_SANDBOX").and_then(|v| v.as_str()),
            Some("1"),
            "Gemini env template content should be rendered"
        );
        assert!(
            live.get("config").and_then(|v| v.get("general")).is_none(),
            "Gemini takeover settings must not include provider-specific live config"
        );
    }

    #[tokio::test]
    #[serial]
    async fn update_live_backup_from_provider_applies_claude_config_template() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        db.set_config_template(
            "claude",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "settings",
                        "label": "settings.json",
                        "content": "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"{proxyBaseUrl}\",\n    \"ANTHROPIC_AUTH_TOKEN\": \"{proxyToken}\"\n  }\n}\n"
                    }
                ]))
                .expect("serialize claude template"),
            ),
        )
        .expect("set config template");

        let service = ProxyService::new(db.clone());

        let provider = Provider::with_id(
            "p1".to_string(),
            "P1".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token",
                    "ANTHROPIC_BASE_URL": "https://claude.example"
                }
            }),
            None,
        );

        service
            .update_live_backup_from_provider("claude", &provider)
            .await
            .expect("update live backup");

        let backup = db
            .get_live_backup("claude")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let stored: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup json");

        assert_eq!(
            stored
                .pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(|v| v.as_str()),
            Some("token"),
            "restore backup should store direct provider config, not proxy access template"
        );
        assert!(
            stored.get("includeCoAuthoredBy").is_none(),
            "application access template must not be applied to restore backup"
        );
    }

    #[tokio::test]
    #[serial]
    async fn update_live_backup_from_provider_applies_codex_config_template() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "disable_response_storage = true\nmodel_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set config template");

        let service = ProxyService::new(db.clone());

        let provider = Provider::with_id(
            "p1".to_string(),
            "P1".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "token"
                },
                "config": r#"model_provider = "any"
model = "gpt-5"

[model_providers.any]
base_url = "https://codex.example/v1"
"#
            }),
            None,
        );

        service
            .update_live_backup_from_provider("codex", &provider)
            .await
            .expect("update live backup");

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let stored: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup json");
        let config = stored
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config string");

        assert!(config.contains("https://codex.example/v1"));
        assert!(
            !config.contains("disable_response_storage = true"),
            "application access template must not be applied into Codex restore backup"
        );
    }

    #[tokio::test]
    #[serial]
    async fn update_live_backup_from_provider_preserves_codex_mcp_servers() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        db.save_live_backup(
            "codex",
            &serde_json::to_string(&json!({
                "auth": {
                    "OPENAI_API_KEY": "old-token"
                },
                "config": r#"model_provider = "any"
model = "gpt-4"

[model_providers.any]
base_url = "https://old.example/v1"

[mcp_servers.echo]
command = "npx"
args = ["echo-server"]
"#
            }))
            .expect("serialize seed backup"),
        )
        .await
        .expect("seed live backup");

        let provider = Provider::with_id(
            "p2".to_string(),
            "P2".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "new-token"
                },
                "config": r#"model_provider = "any"
model = "gpt-5"

[model_providers.any]
base_url = "https://new.example/v1"
"#
            }),
            None,
        );

        service
            .update_live_backup_from_provider("codex", &provider)
            .await
            .expect("update live backup");

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let stored: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup json");
        let config = stored
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config string");

        assert!(
            config.contains("[mcp_servers.echo]"),
            "existing Codex MCP section should survive proxy hot-switch backup update"
        );
        assert!(
            config.contains("https://new.example/v1"),
            "provider-specific base_url should still update to the new provider"
        );
    }

    #[tokio::test]
    #[serial]
    async fn hot_switch_codex_provider_preserves_provider_model_provider_in_backup_and_restore() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "RightCode".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "rightcode-key"
                },
                "config": r#"model_provider = "rightcode"
model = "gpt-5.5"

[model_providers.rightcode]
name = "RightCode"
base_url = "https://rightcode.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "AiHubMix".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "aihubmix-key"
                },
                "config": r#"model_provider = "aihubmix"
model = "gpt-5.5"

[model_providers.aihubmix]
name = "AiHubMix"
base_url = "https://aihubmix.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "a")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("a"))
            .expect("set local current provider");
        db.save_live_backup(
            "codex",
            &serde_json::to_string(&provider_a.settings_config).expect("serialize provider a"),
        )
        .await
        .expect("seed live backup");
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": r#"model_provider = "rightcode"
model = "gpt-5.5"

[model_providers.rightcode]
name = "RightCode"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }))
            .expect("seed taken-over Codex live config");

        service
            .hot_switch_provider("codex", "b")
            .await
            .expect("hot switch Codex provider");

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let stored: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup json");
        let backup_config = stored
            .get("config")
            .and_then(|v| v.as_str())
            .expect("backup config string");
        let parsed_backup: toml::Value =
            toml::from_str(backup_config).expect("parse backup config");
        assert_eq!(
            parsed_backup.get("model_provider").and_then(|v| v.as_str()),
            Some("aihubmix"),
            "provider-derived restore backup should preserve the provider's model_provider"
        );
        let backup_model_providers = parsed_backup
            .get("model_providers")
            .and_then(|v| v.as_table())
            .expect("backup model_providers");
        assert!(backup_model_providers.get("custom").is_none());
        assert_eq!(
            backup_model_providers
                .get("aihubmix")
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str()),
            Some("https://aihubmix.example/v1"),
            "provider id should point at the hot-switched provider endpoint"
        );

        let live = service.read_codex_live().expect("read Codex live config");
        let live_config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("live config string");
        let parsed_live: toml::Value = toml::from_str(live_config).expect("parse live config");
        assert_eq!(
            parsed_live.get("model_provider").and_then(|v| v.as_str()),
            Some("aihubmix"),
            "hot-switched Codex live config should expose the selected provider"
        );
        assert_eq!(
            parsed_live
                .get("model_providers")
                .and_then(|v| v.get("aihubmix"))
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str()),
            Some("AiHubMix"),
            "Codex app provider label should follow the selected provider"
        );
        assert_eq!(
            parsed_live
                .get("model_providers")
                .and_then(|v| v.get("aihubmix"))
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str()),
            Some("http://127.0.0.1:15721/v1"),
            "taken-over live config should stay pointed at the local proxy"
        );

        service
            .restore_live_config_for_app_with_fallback(&AppType::Codex)
            .await
            .expect("restore Codex live config");

        let live = service.read_codex_live().expect("read Codex live config");
        let live_config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("live config string");
        let parsed_live: toml::Value = toml::from_str(live_config).expect("parse live config");
        assert_eq!(
            parsed_live.get("model_provider").and_then(|v| v.as_str()),
            Some("aihubmix"),
            "restored Codex live config should preserve the provider's model_provider"
        );
        assert_eq!(
            live.get("auth")
                .and_then(|auth| auth.get("OPENAI_API_KEY"))
                .and_then(|v| v.as_str()),
            Some("aihubmix-key"),
            "restore should still use the hot-switched provider auth"
        );
    }

    #[tokio::test]
    #[serial]
    async fn hot_switch_codex_chat_provider_updates_live_provider_display() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider_a = Provider::with_id(
            "a".to_string(),
            "Responses".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "responses-key"
                },
                "config": r#"model_provider = "stable"
model = "responses-model"

[model_providers.stable]
name = "Stable"
base_url = "https://responses.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        let mut provider_b = Provider::with_id(
            "b".to_string(),
            "DeepSeek".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "deepseek-key"
                },
                "config": r#"model_provider = "deepseek"
model = "deepseek-v4-flash"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }),
            None,
        );
        provider_b.meta = Some(ProviderMeta {
            api_format: Some("openai_chat".to_string()),
            ..Default::default()
        });

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "a")
            .expect("set current provider");
        crate::settings::set_current_provider(&AppType::Codex, Some("a"))
            .expect("set local current provider");
        db.save_live_backup(
            "codex",
            &serde_json::to_string(&provider_a.settings_config).expect("serialize provider a"),
        )
        .await
        .expect("seed live backup");
        service
            .write_codex_live(&json!({
                "auth": {
                    "OPENAI_API_KEY": PROXY_TOKEN_PLACEHOLDER
                },
                "config": r#"model_provider = "stable"
model = "responses-model"

[model_providers.stable]
name = "Stable"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
requires_openai_auth = true
"#
            }))
            .expect("seed taken-over Codex live config");

        service
            .hot_switch_provider("codex", "b")
            .await
            .expect("hot switch Codex provider");

        let live = service.read_codex_live().expect("read Codex live config");
        let live_config = live
            .get("config")
            .and_then(|v| v.as_str())
            .expect("live config string");
        let parsed_live: toml::Value = toml::from_str(live_config).expect("parse live config");

        assert_eq!(
            parsed_live.get("model_provider").and_then(|v| v.as_str()),
            Some("deepseek")
        );
        assert_eq!(
            parsed_live
                .get("model_providers")
                .and_then(|v| v.get("deepseek"))
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str()),
            Some("DeepSeek")
        );
        assert_eq!(
            parsed_live
                .get("model_providers")
                .and_then(|v| v.get("deepseek"))
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str()),
            Some("http://127.0.0.1:15721/v1")
        );
        assert_eq!(
            parsed_live.get("model").and_then(|v| v.as_str()),
            Some("deepseek-v4-flash")
        );
        assert_eq!(
            live.get("auth")
                .and_then(|auth| auth.get("OPENAI_API_KEY"))
                .and_then(|v| v.as_str()),
            Some(PROXY_TOKEN_PLACEHOLDER)
        );
    }

    #[tokio::test]
    #[serial]
    async fn update_live_backup_from_provider_keeps_new_codex_mcp_entries_on_conflict() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        db.save_live_backup(
            "codex",
            &serde_json::to_string(&json!({
                "auth": {
                    "OPENAI_API_KEY": "old-token"
                },
                "config": r#"[mcp_servers.shared]
command = "old-command"

[mcp_servers.legacy]
command = "legacy-command"
"#
            }))
            .expect("serialize seed backup"),
        )
        .await
        .expect("seed live backup");

        let provider = Provider::with_id(
            "p2".to_string(),
            "P2".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "new-token"
                },
                "config": r#"[mcp_servers.shared]
command = "new-command"

[mcp_servers.latest]
command = "latest-command"
"#
            }),
            None,
        );

        service
            .update_live_backup_from_provider("codex", &provider)
            .await
            .expect("update live backup");

        let backup = db
            .get_live_backup("codex")
            .await
            .expect("get live backup")
            .expect("backup exists");
        let stored: Value =
            serde_json::from_str(&backup.original_config).expect("parse backup json");
        let config = stored
            .get("config")
            .and_then(|v| v.as_str())
            .expect("config string");
        let parsed: toml::Value = toml::from_str(config).expect("parse merged codex config");

        let mcp_servers = parsed
            .get("mcp_servers")
            .expect("mcp_servers should be present");
        assert_eq!(
            mcp_servers
                .get("shared")
                .and_then(|v| v.get("command"))
                .and_then(|v| v.as_str()),
            Some("new-command"),
            "new provider/common-config MCP definition should win on conflict"
        );
        assert_eq!(
            mcp_servers
                .get("legacy")
                .and_then(|v| v.get("command"))
                .and_then(|v| v.as_str()),
            Some("legacy-command"),
            "backup-only MCP entries should still be preserved"
        );
        assert_eq!(
            mcp_servers
                .get("latest")
                .and_then(|v| v.get("command"))
                .and_then(|v| v.as_str()),
            Some("latest-command"),
            "new MCP entries should remain in the restore backup"
        );
    }

    #[tokio::test]
    #[serial]
    async fn update_live_backup_from_provider_preserves_gemini_settings_and_mcp_servers() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        db.save_mcp_server(&crate::app_config::McpServer {
            id: "memory".to_string(),
            name: "Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: crate::app_config::McpApps {
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
                    "GEMINI_API_KEY": "real-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                },
                "config": {
                    "general": {
                        "theme": "light",
                        "telemetry": false
                    }
                }
            }),
            None,
        );

        service
            .update_live_backup_from_provider("gemini", &provider)
            .await
            .expect("update gemini live backup");

        let backup = db
            .get_live_backup("gemini")
            .await
            .expect("get gemini live backup")
            .expect("gemini backup exists");
        let stored: Value =
            serde_json::from_str(&backup.original_config).expect("parse gemini backup json");

        assert_eq!(
            stored
                .pointer("/env/GOOGLE_GEMINI_BASE_URL")
                .and_then(Value::as_str),
            Some("https://gemini.example"),
            "Gemini restore backup must preserve the provider direct endpoint"
        );
        assert_eq!(
            stored
                .pointer("/config/general/theme")
                .and_then(Value::as_str),
            Some("light"),
            "Gemini restore backup must preserve provider-owned settings.json content"
        );
        assert_eq!(
            stored
                .pointer("/config/mcpServers/memory/command")
                .and_then(Value::as_str),
            Some("npx"),
            "Gemini restore backup must preserve DB-managed MCP definitions for later restore"
        );
    }

    #[tokio::test]
    #[serial]
    async fn restore_live_fallback_upgrades_legacy_gemini_env_only_backup_from_ssot() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let provider = Provider::with_id(
            "gemini-a".to_string(),
            "Gemini A".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "real-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                },
                "config": {
                    "general": {
                        "theme": "light"
                    }
                }
            }),
            None,
        );
        db.save_provider("gemini", &provider)
            .expect("save gemini provider");
        db.set_current_provider("gemini", &provider.id)
            .expect("set gemini current provider");
        crate::settings::set_current_provider(&AppType::Gemini, Some(&provider.id))
            .expect("set local gemini current provider");

        db.save_live_backup(
            "gemini",
            &serde_json::to_string(&json!({
                "env": {
                    "GEMINI_API_KEY": "real-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                }
            }))
            .expect("serialize legacy gemini backup"),
        )
        .await
        .expect("save legacy gemini backup");

        service
            .write_gemini_live(&json!({
                "env": {
                    "GEMINI_API_KEY": PROXY_TOKEN_PLACEHOLDER,
                    "GOOGLE_GEMINI_BASE_URL": "http://127.0.0.1:15721",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                },
                "config": {
                    "mcpServers": {
                        "stale": {
                            "command": "stale"
                        }
                    }
                }
            }))
            .expect("seed taken-over gemini live");

        service
            .restore_live_config_for_app_with_fallback(&AppType::Gemini)
            .await
            .expect("restore gemini with fallback");

        let live = service
            .read_gemini_live()
            .expect("read restored gemini live");
        assert_eq!(
            live.pointer("/env/GOOGLE_GEMINI_BASE_URL")
                .and_then(Value::as_str),
            Some("https://gemini.example"),
            "legacy env-only Gemini backups should be upgraded back to the direct provider endpoint"
        );
        assert_eq!(
            live.pointer("/config/general/theme").and_then(Value::as_str),
            Some("light"),
            "fallback restore should rebuild Gemini settings.json from SSOT when the backup is legacy env-only"
        );
    }

    #[tokio::test]
    #[serial]
    async fn keep_state_restart_repairs_legacy_gemini_backup_before_takeover_restore() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        db.save_mcp_server(&crate::app_config::McpServer {
            id: "memory".to_string(),
            name: "Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: crate::app_config::McpApps {
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
                    "GEMINI_API_KEY": "real-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                },
                "config": {
                    "general": {
                        "theme": "light",
                        "telemetry": false
                    }
                }
            }),
            None,
        );
        db.save_provider("gemini", &provider)
            .expect("save gemini provider");
        db.add_to_failover_queue("gemini", &provider.id)
            .expect("queue gemini provider");
        db.set_current_provider("gemini", &provider.id)
            .expect("set gemini current provider");
        crate::settings::set_current_provider(&AppType::Gemini, Some(&provider.id))
            .expect("set local gemini current provider");

        let mut app_config = db
            .get_proxy_config_for_app("gemini")
            .await
            .expect("get gemini proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable gemini takeover and failover");

        let service = ProxyService::new(db.clone());
        service
            .sync_live_from_provider_while_proxy_active(&AppType::Gemini, &provider)
            .await
            .expect("seed gemini takeover live");

        db.save_live_backup(
            "gemini",
            &serde_json::to_string(&json!({
                "env": {
                    "GEMINI_API_KEY": "real-key",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini.example",
                    "GEMINI_MODEL": "gemini-3.1-pro"
                }
            }))
            .expect("serialize legacy gemini backup"),
        )
        .await
        .expect("save legacy gemini backup");

        service
            .stop_with_restore_keep_state()
            .await
            .expect("keep-state shutdown");

        let restarted = ProxyService::new(db.clone());
        restarted
            .set_takeover_for_app("gemini", true)
            .await
            .expect("restart gemini takeover");

        let repaired_backup = db
            .get_live_backup("gemini")
            .await
            .expect("read repaired gemini backup")
            .expect("repaired gemini backup should exist");
        let repaired_value: Value = serde_json::from_str(&repaired_backup.original_config)
            .expect("parse repaired gemini backup");
        assert_eq!(
            repaired_value
                .pointer("/config/general/theme")
                .and_then(Value::as_str),
            Some("light"),
            "restart takeover repair must upgrade legacy Gemini backups to include settings.json content"
        );
        assert_eq!(
            repaired_value
                .pointer("/config/mcpServers/memory/command")
                .and_then(Value::as_str),
            Some("npx"),
            "restart takeover repair must rebuild Gemini DB-managed MCP definitions into the restore backup"
        );

        let live = restarted
            .read_gemini_live()
            .expect("read gemini live after restart");
        assert_eq!(
            live.pointer("/env/GOOGLE_GEMINI_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "Gemini live should remain on the local proxy endpoint after keep-state restart recovery"
        );
        assert_eq!(
            live.pointer("/config/mcpServers/memory/command")
                .and_then(Value::as_str),
            Some("npx"),
            "Gemini takeover restart should keep MCP definitions available after repairing the restore backup"
        );
    }

    #[tokio::test]
    #[serial]
    async fn provider_switch_with_restored_codex_backup_refreshes_catalog_and_common_config() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        seed_codex_model_template();

        let db = Arc::new(Database::memory().expect("init db"));
        let state = crate::store::AppState::new(db.clone());

        db.set_config_snippet(
            "codex",
            Some(
                r#"[mcp_servers.shared]
command = "shared-command"
"#
                .to_string(),
            ),
        )
        .expect("set common config snippet");

        let proxy_config = ProxyConfig {
            listen_port: 0,
            ..Default::default()
        };
        db.update_proxy_config(proxy_config)
            .await
            .expect("set test proxy config");
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy server");

        let config_a = r#"model_provider = "provider-a"
model = "model-a"

[model_providers.provider-a]
name = "ProviderA"
base_url = "https://provider-a.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#;
        let config_b = r#"model_provider = "provider-b"
model = "model-b"

[model_providers.provider-b]
name = "ProviderB"
base_url = "https://provider-b.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#;

        let provider_a = Provider::with_id(
            "a".to_string(),
            "ProviderA".to_string(),
            serde_json::json!({
                "auth": { "OPENAI_API_KEY": "key-a" },
                "config": config_a,
                "modelCatalog": { "models": [{ "model": "model-a" }] }
            }),
            None,
        );
        let mut provider_b = Provider::with_id(
            "b".to_string(),
            "ProviderB".to_string(),
            serde_json::json!({
                "auth": { "OPENAI_API_KEY": "key-b" },
                "config": config_b,
                "modelCatalog": { "models": [{ "model": "model-b" }] }
            }),
            None,
        );
        provider_b.meta = Some(ProviderMeta {
            common_config_enabled: Some(true),
            ..Default::default()
        });

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "a")
            .expect("set current provider a");
        crate::settings::set_current_provider(&AppType::Codex, Some("a"))
            .expect("set local current provider a");

        state
            .proxy_service
            .write_codex_live_for_provider(&provider_a.settings_config, Some(&provider_a))
            .expect("seed live codex config");
        assert!(
            !state
                .proxy_service
                .detect_takeover_in_live_config_for_app(&AppType::Codex),
            "seeded live config should not be proxy-taken-over"
        );

        db.save_live_backup(
            "codex",
            &serde_json::to_string(&provider_a.settings_config).expect("serialize backup"),
        )
        .await
        .expect("seed restored backup");

        crate::services::provider::ProviderService::switch(&state, AppType::Codex, "b")
            .expect("provider switch to provider b");
        state.proxy_service.stop().await.expect("stop proxy server");

        let catalog_path = crate::codex_config::get_codex_model_catalog_path();
        assert!(
            catalog_path.exists(),
            "cc-switch-model-catalog.json must be created on provider switch"
        );
        let catalog_text = std::fs::read_to_string(&catalog_path).expect("read catalog json");
        let catalog: serde_json::Value =
            serde_json::from_str(&catalog_text).expect("parse catalog json");
        let slugs: Vec<&str> = catalog
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.get("slug").and_then(|s| s.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            slugs.contains(&"model-b"),
            "catalog must contain provider B's model after switch; got: {slugs:?}"
        );
        assert!(
            !slugs.contains(&"model-a"),
            "catalog must not contain stale provider A model after switch; got: {slugs:?}"
        );

        let config_path = crate::codex_config::get_codex_config_path();
        let config_text = std::fs::read_to_string(&config_path).expect("read config.toml");
        assert!(
            config_text.contains("model_catalog_json"),
            "config.toml must reference model_catalog_json after switch"
        );
        assert!(
            config_text.contains("[mcp_servers.shared]"),
            "config.toml must keep common config after switch"
        );
        assert!(
            config_text.contains(r#"command = "shared-command""#),
            "config.toml must include common config content after switch"
        );
    }

    #[tokio::test]
    #[serial]
    async fn provider_switch_with_restored_codex_backup_propagates_catalog_write_errors() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");
        seed_codex_model_template();

        let db = Arc::new(Database::memory().expect("init db"));
        let state = crate::store::AppState::new(db.clone());

        let proxy_config = ProxyConfig {
            listen_port: 0,
            ..Default::default()
        };
        db.update_proxy_config(proxy_config)
            .await
            .expect("set test proxy config");
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy server");

        let config_a = r#"model_provider = "provider-a"
model = "model-a"

[model_providers.provider-a]
name = "ProviderA"
base_url = "https://provider-a.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#;
        let config_b = r#"model_provider = "provider-b"
model = "model-b"

[model_providers.provider-b]
name = "ProviderB"
base_url = "https://provider-b.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#;

        let provider_a = Provider::with_id(
            "a".to_string(),
            "ProviderA".to_string(),
            serde_json::json!({
                "auth": { "OPENAI_API_KEY": "key-a" },
                "config": config_a,
                "modelCatalog": { "models": [{ "model": "model-a" }] }
            }),
            None,
        );
        let provider_b = Provider::with_id(
            "b".to_string(),
            "ProviderB".to_string(),
            serde_json::json!({
                "auth": { "OPENAI_API_KEY": "key-b" },
                "config": config_b,
                "modelCatalog": { "models": [{ "model": "model-b" }] }
            }),
            None,
        );

        db.save_provider("codex", &provider_a)
            .expect("save provider a");
        db.save_provider("codex", &provider_b)
            .expect("save provider b");
        db.set_current_provider("codex", "a")
            .expect("set current provider a");
        crate::settings::set_current_provider(&AppType::Codex, Some("a"))
            .expect("set local current provider a");

        state
            .proxy_service
            .write_codex_live_for_provider(&provider_a.settings_config, Some(&provider_a))
            .expect("seed live codex config");
        assert!(
            !state
                .proxy_service
                .detect_takeover_in_live_config_for_app(&AppType::Codex),
            "seeded live config should not be proxy-taken-over"
        );

        db.save_live_backup(
            "codex",
            &serde_json::to_string(&provider_a.settings_config).expect("serialize backup"),
        )
        .await
        .expect("seed restored backup");

        let catalog_path = crate::codex_config::get_codex_model_catalog_path();
        if catalog_path.exists() {
            std::fs::remove_file(&catalog_path).expect("remove catalog file");
        }
        std::fs::create_dir_all(&catalog_path).expect("turn catalog path into directory");

        let err = crate::services::provider::ProviderService::switch(&state, AppType::Codex, "b")
            .expect_err("provider switch should fail when catalog cannot be written");
        state.proxy_service.stop().await.expect("stop proxy server");

        let message = err.to_string();
        assert!(
            message.contains("写入 Codex 配置失败") || message.contains("原子替换失败"),
            "switch should surface catalog write failure, got: {message}"
        );
    }

    /// Regression: turning proxy takeover off restores Live from the backup. The
    /// backup snapshot is `read_codex_live_settings()` output (`{auth, config}`,
    /// never an inline `modelCatalog`). The restore must NOT route the config
    /// through catalog projection, which would see no specs and strip the
    /// `model_catalog_json` pointer — silently dropping the user's Codex model
    /// mapping from Live even though the DB SSOT still holds it.
    #[tokio::test]
    #[serial]
    async fn codex_restore_from_backup_preserves_model_catalog_pointer() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        // Pre-takeover Live state: config.toml points at the cc-switch generated
        // catalog file, and that file exists on disk (takeover never touches it).
        let catalog_path = crate::codex_config::get_codex_model_catalog_path();
        if let Some(parent) = catalog_path.parent() {
            std::fs::create_dir_all(parent).expect("create codex dir");
        }
        std::fs::write(
            &catalog_path,
            r#"{"models":[{"slug":"deepseek-v4-flash"}]}"#,
        )
        .expect("seed generated catalog file");

        let pointer = catalog_path.to_string_lossy().to_string();
        let pointer_toml = toml_edit::Value::from(pointer.as_str()).to_string();
        let backup_config = format!(
            "model_provider = \"custom\"\n\
             model = \"deepseek-v4-flash\"\n\
             model_catalog_json = {pointer_toml}\n\n\
             [model_providers.custom]\n\
             name = \"DeepSeek\"\n\
             base_url = \"https://api.deepseek.example/v1\"\n\
             wire_api = \"responses\"\n"
        );
        let backup_json = serde_json::to_string(&json!({
            "auth": { "OPENAI_API_KEY": "deepseek-key" },
            "config": backup_config,
        }))
        .expect("serialize backup");
        db.save_live_backup("codex", &backup_json)
            .await
            .expect("seed live backup");

        // Turning takeover off restores Live from this backup.
        service
            .restore_live_config_for_app_with_fallback(&AppType::Codex)
            .await
            .expect("restore codex live from backup");

        let restored = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read restored config.toml");
        assert!(
            restored.contains("model_catalog_json"),
            "restore must preserve the model_catalog_json pointer, got:\n{restored}"
        );
        assert!(
            restored.contains(pointer.as_str()),
            "restored pointer must still reference the cc-switch generated catalog file"
        );
    }

    /// Regression: a hot-switch during takeover rebuilds the backup from the DB
    /// provider (`update_live_backup_from_provider`), so the backup carries an
    /// inline `modelCatalog` (DB SSOT) but a `config.toml` text WITHOUT a
    /// `model_catalog_json` pointer. Restoring that backup must project the
    /// inline catalog — (re)generating both the catalog file and the pointer —
    /// or the Codex model mapping vanishes from Live after takeover-off.
    #[tokio::test]
    #[serial]
    async fn codex_restore_from_backup_projects_inline_model_catalog() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        // Catalog projection needs a model template; seed `models_cache.json`
        // with the template slug so we don't depend on the `codex` CLI.
        let codex_dir = crate::codex_config::get_codex_config_dir();
        std::fs::create_dir_all(&codex_dir).expect("create codex dir");
        std::fs::write(
            codex_dir.join("models_cache.json"),
            r#"{"models":[{"slug":"gpt-5.5"}]}"#,
        )
        .expect("seed models_cache template");

        // Provider-rebuilt backup shape: inline modelCatalog, pointer-less config.
        let backup_json = serde_json::to_string(&json!({
            "auth": { "OPENAI_API_KEY": "deepseek-key" },
            "config": "model_provider = \"custom\"\nmodel = \"deepseek-v4-flash\"\n\n[model_providers.custom]\nname = \"DeepSeek\"\nbase_url = \"https://api.deepseek.example/v1\"\nwire_api = \"responses\"\n",
            "modelCatalog": {
                "models": [
                    { "model": "deepseek-v4-flash", "displayName": "DeepSeek V4 Flash", "contextWindow": 1_000_000 }
                ]
            }
        }))
        .expect("serialize backup");
        db.save_live_backup("codex", &backup_json)
            .await
            .expect("seed live backup");

        service
            .restore_live_config_for_app_with_fallback(&AppType::Codex)
            .await
            .expect("restore codex live from backup");

        let restored = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read restored config.toml");
        let catalog_path = crate::codex_config::get_codex_model_catalog_path();
        assert!(
            restored.contains("model_catalog_json"),
            "restore must (re)generate the model_catalog_json pointer from inline catalog, got:\n{restored}"
        );
        assert!(
            catalog_path.exists(),
            "restore must generate the cc-switch catalog file on disk"
        );
        let catalog: Value = serde_json::from_str(
            &std::fs::read_to_string(&catalog_path).expect("read generated catalog"),
        )
        .expect("parse generated catalog");
        let slugs: Vec<&str> = catalog
            .get("models")
            .and_then(|m| m.as_array())
            .expect("catalog models")
            .iter()
            .filter_map(|m| m.get("slug").and_then(|s| s.as_str()))
            .collect();
        assert!(
            slugs.contains(&"deepseek-v4-flash"),
            "generated catalog must contain the inline model, got slugs: {slugs:?}"
        );
    }

    /// Regression: a provider-rebuilt backup can pair an inline `modelCatalog`
    /// with EMPTY `auth.json` (`{}`) — the bearer-token / Mobile-compat shape
    /// where the API key lives in the config's `experimental_bearer_token`. The
    /// empty-auth restore branch deletes `auth.json` and writes config raw; it
    /// must still project the inline catalog (decision is orthogonal to auth), or
    /// the model mapping vanishes on takeover-off for this provider shape.
    #[tokio::test]
    #[serial]
    async fn codex_restore_empty_auth_backup_still_projects_inline_catalog() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let service = ProxyService::new(db.clone());

        let codex_dir = crate::codex_config::get_codex_config_dir();
        std::fs::create_dir_all(&codex_dir).expect("create codex dir");
        std::fs::write(
            codex_dir.join("models_cache.json"),
            r#"{"models":[{"slug":"gpt-5.5"}]}"#,
        )
        .expect("seed models_cache template");

        // Empty auth.json + key carried in config.toml's experimental_bearer_token,
        // plus the inline modelCatalog (DB SSOT).
        let backup_json = serde_json::to_string(&json!({
            "auth": {},
            "config": "model_provider = \"custom\"\nmodel = \"deepseek-v4-flash\"\n\n[model_providers.custom]\nname = \"DeepSeek\"\nbase_url = \"https://api.deepseek.example/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"sk-deepseek\"\n",
            "modelCatalog": {
                "models": [ { "model": "deepseek-v4-flash", "displayName": "DeepSeek V4 Flash" } ]
            }
        }))
        .expect("serialize backup");
        db.save_live_backup("codex", &backup_json)
            .await
            .expect("seed live backup");

        service
            .restore_live_config_for_app_with_fallback(&AppType::Codex)
            .await
            .expect("restore codex live from backup");

        let restored = std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read restored config.toml");
        assert!(
            restored.contains("model_catalog_json"),
            "empty-auth restore must still project the inline catalog pointer, got:\n{restored}"
        );
        assert!(
            crate::codex_config::get_codex_model_catalog_path().exists(),
            "empty-auth restore must generate the cc-switch catalog file"
        );
        assert!(
            !crate::codex_config::get_codex_auth_path().exists(),
            "empty-auth restore must delete auth.json rather than write an empty one"
        );
    }
}
