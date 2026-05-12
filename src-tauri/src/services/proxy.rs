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
    build_direct_live_settings_with_mcp, build_effective_settings_without_template,
    build_proxy_takeover_settings, write_live_with_common_config,
};
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::RwLock;

/// 用于接管 Live 配置时的占位符（避免客户端提示缺少 key，同时不泄露真实 Token）
const PROXY_TOKEN_PLACEHOLDER: &str = "PROXY_MANAGED";

/// 代理接管模式下历史版本可能残留的 Claude Live 模型覆盖字段。
///
/// 新配置体系下，接管 Live 配置由“应用接入配置模板”生成，模板内的默认
/// 模型字段是有效配置，不应在热切换时删除。这个列表仅保留给显式旧配置
/// 清理逻辑使用，不参与正常接管渲染。
const CLAUDE_MODEL_OVERRIDE_ENV_KEYS: [&str; 6] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL", // legacy: 已废弃，但旧配置可能残留
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    // Legacy key (已废弃)：历史版本使用该字段区分 small/fast 模型
    "ANTHROPIC_SMALL_FAST_MODEL",
];

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
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            server: Arc::new(RwLock::new(None)),
            app_handle: Arc::new(RwLock::new(None)),
            switch_locks: SwitchLockManager::new(),
        }
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

    fn apply_claude_takeover_fields(config: &mut Value, proxy_url: &str) {
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

        let token_keys = [
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENAI_API_KEY",
        ];

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
                Self::apply_claude_takeover_fields(&mut effective_settings, &proxy_url);
                self.write_claude_live(&effective_settings)?;
            }
            AppType::Codex => {
                Self::apply_codex_takeover_fields(&mut effective_settings, &proxy_codex_base_url);
                Self::apply_codex_provider_model_fields(&mut effective_settings, provider)?;
                self.write_codex_live(&effective_settings)?;
            }
            AppType::Gemini => {
                Self::apply_gemini_takeover_fields(&mut effective_settings, &proxy_url);
                self.write_gemini_live(&effective_settings)?;
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                return Err("该应用不支持代理接管".to_string());
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

            let mut has_existing_backup = false;
            let mut should_backup_live = !current_config.enabled;
            let mut should_sync_live_token = !current_config.enabled;
            let live_has_takeover_placeholder = self.detect_takeover_in_live_config_for_app(&app);
            if !current_config.enabled && live_has_takeover_placeholder {
                match self.rebuild_live_backup_from_restore_target(&app).await {
                    Ok(true) => {
                        has_existing_backup = true;
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
            if current_config.enabled {
                has_existing_backup = match self.db.get_live_backup(app_type_str).await {
                    Ok(v) => v.is_some(),
                    Err(e) => {
                        log::warn!("读取 {app_type_str} 备份失败（将继续重建接管）: {e}");
                        false
                    }
                };
                let live_taken_over = match self
                    .detect_effective_takeover_in_live_config_for_app(&app)
                    .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        log::warn!(
                            "{app_type_str} 有效接管状态检测失败（将继续重建接管）: {error}"
                        );
                        false
                    }
                };

                if live_taken_over {
                    if !has_existing_backup {
                        match self.rebuild_live_backup_from_restore_target(&app).await {
                            Ok(true) => {
                                log::info!(
                                    "{app_type_str} Live 已接管但备份缺失，已从当前恢复目标重建备份"
                                );
                            }
                            Ok(false) => {
                                log::warn!(
                                    "{app_type_str} Live 已接管但备份缺失，且没有可用恢复目标；关闭接管时将使用无备份兜底"
                                );
                            }
                            Err(error) => {
                                log::warn!(
                                    "{app_type_str} Live 已接管但备份缺失，重建备份失败: {error}"
                                );
                            }
                        }
                    }
                    self.sync_failover_active_target(app_type_str).await?;
                    return Ok(());
                }

                if has_existing_backup {
                    log::warn!(
                        "{app_type_str} 标记为已接管且备份存在，但 Live 配置未指向本地代理，正在重写接管配置"
                    );
                } else if live_has_takeover_placeholder {
                    match self.rebuild_live_backup_from_restore_target(&app).await {
                        Ok(true) => {
                            has_existing_backup = true;
                            log::info!(
                                "{app_type_str} Live 含接管占位符且备份缺失，已从当前恢复目标重建备份"
                            );
                        }
                        Ok(false) => {
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
            }

            // 3) 备份 Live 配置（严格：目标 app 不存在则报错）
            if should_backup_live && !has_existing_backup {
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
                match self.restore_live_config_for_app(&app).await {
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
            return Ok(()); // 未接管，幂等返回
        }

        // 1) 恢复 Live 配置
        self.restore_live_config_for_app_with_fallback(&app).await?;

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
        self.db
            .update_proxy_config_for_app(updated_config)
            .await
            .map_err(|e| format!("清除 {app_type_str} enabled 状态失败: {e}"))?;

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
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features
                return Err("该应用不支持代理功能".to_string());
            }
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
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features, skip silently
            }
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
        // 1. 停止代理服务器（即使未运行也继续执行恢复逻辑）
        if let Err(e) = self.stop().await {
            log::warn!("停止代理服务器失败（将继续恢复 Live 配置）: {e}");
        }

        // 2. 恢复原始 Live 配置
        self.restore_live_configs().await?;

        // 3. 清除 proxy_config 表中的接管状态（兼容旧版）
        self.db
            .set_live_takeover_active(false)
            .await
            .map_err(|e| format!("清除接管状态失败: {e}"))?;

        // 4. 清除所有应用的 enabled 状态（用户手动关闭，不需要下次自动恢复）
        for app_type in ["claude", "codex", "gemini"] {
            if let Ok(mut config) = self.db.get_proxy_config_for_app(app_type).await {
                if config.enabled {
                    config.enabled = false;
                    if let Err(e) = self.db.update_proxy_config_for_app(config).await {
                        log::warn!("清除 {app_type} enabled 状态失败: {e}");
                    }
                }
            }
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

        // 注意：不清除故障转移队列和开关状态，保留供下次开启代理时使用
        log::info!("代理已停止，Live 配置已恢复");
        Ok(())
    }

    /// 停止代理服务器（恢复 Live 配置，但保留 settings 表中的代理状态）
    ///
    /// 用于程序正常退出时，保留代理状态以便下次启动时自动恢复
    pub async fn stop_with_restore_keep_state(&self) -> Result<(), String> {
        // 1. 停止代理服务器（即使未运行也继续执行恢复逻辑）
        if let Err(e) = self.stop().await {
            log::warn!("停止代理服务器失败（将继续恢复 Live 配置）: {e}");
        }

        // 2. 恢复原始 Live 配置
        self.restore_live_configs().await?;

        // 3. 更新 proxy_config 表中的 live_takeover_active 标志（兼容旧版）
        //    注意：保留 proxy_config.enabled 状态，下次启动时自动恢复
        if let Ok(mut config) = self.db.get_proxy_config().await {
            config.live_takeover_active = false;
            let _ = self.db.update_proxy_config(config).await;
        }

        // 4. 删除备份（Live 配置已恢复，备份不再需要）
        self.db
            .delete_all_live_backups()
            .await
            .map_err(|e| format!("删除备份失败: {e}"))?;

        // 5. 重置健康状态
        self.db
            .clear_all_provider_health()
            .await
            .map_err(|e| format!("重置健康状态失败: {e}"))?;

        log::info!("代理已停止，Live 配置已恢复（保留代理状态，下次启动将自动恢复）");
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
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features
                return Err("该应用不支持代理功能".to_string());
            }
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
        let current_provider = if matches!(app_type, AppType::Codex) {
            self.current_provider_for_app(app_type).await?
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
                Self::apply_claude_takeover_fields(&mut live_config, &proxy_url);
                self.write_claude_live(&live_config)?;
                log::info!("Claude Live 配置已接管，代理地址: {proxy_url}");
            }
            AppType::Codex => {
                Self::apply_codex_takeover_fields(&mut live_config, &proxy_codex_base_url);
                if let Some(provider) = current_provider.as_ref() {
                    Self::apply_codex_provider_model_fields(&mut live_config, provider)?;
                } else {
                    return Err("Codex 当前供应商不存在，无法接管 Live 配置".to_string());
                }
                self.write_codex_live(&live_config)?;
                log::info!("Codex Live 配置已接管，代理地址: {proxy_codex_base_url}");
            }
            AppType::Gemini => {
                Self::apply_gemini_takeover_fields(&mut live_config, &proxy_url);
                self.write_gemini_live(&live_config)?;
                log::info!("Gemini Live 配置已接管，代理地址: {proxy_url}");
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features
                return Err("该应用不支持代理功能".to_string());
            }
        }

        Ok(())
    }

    /// 接管指定应用的 Live 配置（尽力而为：配置不存在/读取失败则跳过）
    async fn takeover_live_config_best_effort(&self, app_type: &AppType) -> Result<(), String> {
        let (proxy_url, proxy_codex_base_url) = self.build_proxy_urls().await?;
        let current_provider = if matches!(app_type, AppType::Codex) {
            match self.current_provider_for_app(app_type).await {
                Ok(provider) => provider,
                Err(err) => {
                    log::warn!("读取 Codex 当前供应商失败，接管配置将保留模板模型字段: {err}");
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
                    Self::apply_claude_takeover_fields(&mut live_config, &proxy_url);
                    let _ = self.write_claude_live(&live_config);
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
                    let _ = self.write_codex_live(&live_config);
                }
            }
            AppType::Gemini => {
                if let Ok(mut live_config) = live_config {
                    Self::apply_gemini_takeover_fields(&mut live_config, &proxy_url);
                    let _ = self.write_gemini_live(&live_config);
                }
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features, skip silently
            }
        }

        Ok(())
    }

    /// 恢复指定应用的 Live 配置（若无备份则不做任何操作）
    async fn restore_live_config_for_app(&self, app_type: &AppType) -> Result<(), String> {
        let _guard = self.switch_locks.lock_for_app(app_type.as_str()).await;
        self.restore_live_config_for_app_inner(app_type).await
    }

    async fn restore_live_config_for_app_inner(&self, app_type: &AppType) -> Result<(), String> {
        match app_type {
            AppType::Claude => {
                if let Ok(Some(backup)) = self.db.get_live_backup("claude").await {
                    let config: Value = serde_json::from_str(&backup.original_config)
                        .map_err(|e| format!("解析 Claude 备份失败: {e}"))?;
                    self.write_claude_live(&config)?;
                    log::info!("Claude Live 配置已恢复");
                }
            }
            AppType::Codex => {
                if let Ok(Some(backup)) = self.db.get_live_backup("codex").await {
                    let config: Value = serde_json::from_str(&backup.original_config)
                        .map_err(|e| format!("解析 Codex 备份失败: {e}"))?;
                    self.write_codex_live(&config)?;
                    log::info!("Codex Live 配置已恢复");
                }
            }
            AppType::Gemini => {
                if let Ok(Some(backup)) = self.db.get_live_backup("gemini").await {
                    let config: Value = serde_json::from_str(&backup.original_config)
                        .map_err(|e| format!("解析 Gemini 备份失败: {e}"))?;
                    self.write_gemini_live(&config)?;
                    log::info!("Gemini Live 配置已恢复");
                }
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features, skip silently
            }
        }

        Ok(())
    }

    /// 恢复原始 Live 配置
    async fn restore_live_configs(&self) -> Result<(), String> {
        let mut errors = Vec::new();

        for app_type in [AppType::Claude, AppType::Codex, AppType::Gemini] {
            if let Err(e) = self
                .restore_live_config_for_app_with_fallback(&app_type)
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

    async fn restore_live_config_for_app_with_fallback(
        &self,
        app_type: &AppType,
    ) -> Result<(), String> {
        let _guard = self.switch_locks.lock_for_app(app_type.as_str()).await;
        self.restore_live_config_for_app_with_fallback_inner(app_type)
            .await
    }

    async fn restore_live_config_for_app_with_fallback_inner(
        &self,
        app_type: &AppType,
    ) -> Result<(), String> {
        let app_type_str = app_type.as_str();

        // 1) 优先从 Live 备份恢复（这是"原始 Live"的唯一可靠来源）
        let backup = self
            .db
            .get_live_backup(app_type_str)
            .await
            .map_err(|e| format!("获取 {app_type_str} Live 备份失败: {e}"))?;
        if let Some(backup) = backup {
            let config: Value = serde_json::from_str(&backup.original_config)
                .map_err(|e| format!("解析 {app_type_str} 备份失败: {e}"))?;
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

    fn write_live_config_for_app(&self, app_type: &AppType, config: &Value) -> Result<(), String> {
        match app_type {
            AppType::Claude => self.write_claude_live(config),
            AppType::Codex => self.write_codex_live(config),
            AppType::Gemini => self.write_gemini_live(config),
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features
                Err("该应用不支持代理功能".to_string())
            }
        }
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
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy takeover
                false
            }
        }
    }

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
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => false,
        })
    }

    /// 当 Live 备份缺失时，尝试用 SSOT（当前供应商）写回 Live，以解除占位符接管。
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
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                // These apps don't support proxy features
                Ok(())
            }
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

        self.write_claude_live(&config)?;
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
            config["config"] = json!(updated);
        }

        self.write_codex_live(&config)?;
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

        self.write_gemini_live(&config)?;
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
    /// 会恢复 Live 配置、清除接管标志、删除备份。
    pub async fn recover_from_crash(&self) -> Result<(), String> {
        // 1. 恢复 Live 配置
        self.restore_live_configs().await?;

        // 2. 清除接管标志
        self.db
            .set_live_takeover_active(false)
            .await
            .map_err(|e| format!("清除接管状态失败: {e}"))?;

        // 3. 删除备份
        self.db
            .delete_all_live_backups()
            .await
            .map_err(|e| format!("删除备份失败: {e}"))?;

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

    fn is_codex_live_taken_over(config: &Value) -> bool {
        let auth = match config.get("auth").and_then(|v| v.as_object()) {
            Some(auth) => auth,
            None => return false,
        };
        auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER)
    }

    fn is_gemini_live_taken_over(config: &Value) -> bool {
        let env = match config.get("env").and_then(|v| v.as_object()) {
            Some(env) => env,
            None => return false,
        };
        env.get("GEMINI_API_KEY").and_then(|v| v.as_str()) == Some(PROXY_TOKEN_PLACEHOLDER)
    }

    fn proxy_urls_equal(actual: &str, expected: &str) -> bool {
        actual.trim().trim_end_matches('/') == expected.trim().trim_end_matches('/')
    }

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
                Self::preserve_codex_mcp_servers_in_backup(
                    &mut effective_settings,
                    existing_value,
                )?;
            }

            let anchor_config_text = existing_backup_value
                .as_ref()
                .and_then(|value| value.get("config"))
                .and_then(|value| value.as_str());
            crate::codex_config::normalize_codex_settings_config_model_provider(
                &mut effective_settings,
                anchor_config_text,
            )
            .map_err(|e| format!("归一化 Codex restore backup 失败: {e}"))?;
        }

        let backup_json = match app_type_enum {
            AppType::Claude => serde_json::to_string(&effective_settings)
                .map_err(|e| format!("序列化 Claude 配置失败: {e}"))?,
            AppType::Codex => serde_json::to_string(&effective_settings)
                .map_err(|e| format!("序列化 Codex 配置失败: {e}"))?,
            AppType::Gemini => serde_json::to_string(&effective_settings)
                .map_err(|e| format!("序列化 Gemini 配置失败: {e}"))?,
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                return Err(format!("未知的应用类型: {app_type}"));
            }
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
        if let Some(provider) = self.current_provider_for_app(app_type).await? {
            self.update_live_backup_from_provider_inner(app_type.as_str(), &provider)
                .await?;
            return Ok(true);
        }

        let queue_head = self
            .db
            .get_failover_queue(app_type.as_str())
            .map_err(|e| format!("读取 {} 故障转移队列失败: {e}", app_type.as_str()))?
            .into_iter()
            .next();

        let Some(queue_head) = queue_head else {
            return Ok(false);
        };

        let Some(provider) = self
            .db
            .get_provider_by_id(&queue_head.provider_id, app_type.as_str())
            .map_err(|e| format!("读取 {} 恢复目标供应商失败: {e}", app_type.as_str()))?
        else {
            return Ok(false);
        };

        self.update_live_backup_from_provider_inner(app_type.as_str(), &provider)
            .await?;
        Ok(true)
    }

    pub async fn hot_switch_provider(
        &self,
        app_type: &str,
        provider_id: &str,
    ) -> Result<HotSwitchOutcome, String> {
        let _guard = self.switch_locks.lock_for_app(app_type).await;

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
        let should_sync_backup = has_backup || live_taken_over;

        self.db
            .set_current_provider(app_type_enum.as_str(), provider_id)
            .map_err(|e| format!("更新当前供应商失败: {e}"))?;
        crate::settings::set_current_provider(&app_type_enum, Some(provider_id))
            .map_err(|e| format!("更新本地当前供应商失败: {e}"))?;

        if should_sync_backup {
            self.update_live_backup_from_provider_inner(app_type, &provider)
                .await?;

            if matches!(
                app_type_enum,
                AppType::Claude | AppType::Codex | AppType::Gemini
            ) {
                self.sync_live_from_provider_while_proxy_active(&app_type_enum, &provider)
                    .await?;
            }
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

    fn preserve_codex_mcp_servers_in_backup(
        target_settings: &mut Value,
        existing_backup: &Value,
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

        let existing_config = existing_backup
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
                            "Codex config contains a non-table mcp_servers section; skipping backup MCP merge"
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

    /// 代理模式下切换供应商（热切换，不写 Live）
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
        use crate::codex_config::{get_codex_auth_path, get_codex_config_path};

        let auth_path = get_codex_auth_path();
        if !auth_path.exists() {
            return Err("Codex auth.json 不存在".to_string());
        }

        let auth: Value =
            read_json_file(&auth_path).map_err(|e| format!("读取 Codex auth 失败: {e}"))?;

        let config_path = get_codex_config_path();
        let config_str = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .map_err(|e| format!("读取 Codex config 失败: {e}"))?
        } else {
            String::new()
        };

        Ok(json!({
            "auth": auth,
            "config": config_str
        }))
    }

    fn write_codex_live(&self, config: &Value) -> Result<(), String> {
        use crate::codex_config::{
            get_codex_auth_path, get_codex_config_path, write_codex_live_atomic,
        };

        let auth = config.get("auth");
        let config_str = config.get("config").and_then(|v| v.as_str());

        // Proxy restore writes saved live backups verbatim. Provider-driven writes go
        // through write_live_with_common_config(), which normalizes Codex provider ids.
        match (auth, config_str) {
            (Some(auth), Some(cfg)) => write_codex_live_atomic(auth, Some(cfg))
                .map_err(|e| format!("写入 Codex 配置失败: {e}"))?,
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
                if settings_path.exists() {
                    delete_file(&settings_path)
                        .map_err(|e| format!("删除 Gemini settings 失败: {e}"))?;
                }
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
                .clear_provider_runtime_state(app_type, provider_id)
                .await;
            // 禁用/删除供应商也是一次"路由目标变化"，bump epoch 防止该供应商上正在跑的
            // 旧请求成功后回写 current_providers / 状态。
            let _ = server.bump_switch_epoch(app_type).await;
        }
        Ok(())
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
                    "ANTHROPIC_MODEL": "claude-new"
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
                    "ANTHROPIC_MODEL": "stale-model"
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
                .and_then(|v| v.as_str())
                == Some("claude-sonnet-4-6"),
            "takeover mode should rewrite stale Claude model override to the access template default"
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

        service.stop().await.expect("stop proxy service");
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

        service.stop().await.expect("stop proxy service");
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
            json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "a", "ANTHROPIC_BASE_URL": "https://a.example" } }),
            None,
        );
        provider_a.sort_index = Some(20);
        let mut provider_b = Provider::with_id(
            "b".to_string(),
            "Provider B".to_string(),
            json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "b", "ANTHROPIC_BASE_URL": "https://b.example" } }),
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

        service.stop().await.expect("stop proxy service");
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
        assert!(
            service
                .get_status()
                .await
                .expect("get proxy status")
                .active_targets
                .iter()
                .any(|target| target.app_type == "claude")
        );

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

        service.stop().await.expect("stop proxy service");
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

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable auto failover before takeover");

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

        service.stop().await.expect("stop proxy service");
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

        let backup =
            serde_json::to_string(&provider.settings_config).expect("serialize backup");
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

        let live = service.read_claude_live().expect("read cleaned claude live");
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
    async fn hot_switch_codex_provider_keeps_model_provider_stable_in_backup_and_restore() {
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
            Some("rightcode"),
            "provider-derived restore backup should retain stable Codex model_provider"
        );
        let backup_model_providers = parsed_backup
            .get("model_providers")
            .and_then(|v| v.as_table())
            .expect("backup model_providers");
        assert!(backup_model_providers.get("aihubmix").is_none());
        assert_eq!(
            backup_model_providers
                .get("rightcode")
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str()),
            Some("https://aihubmix.example/v1"),
            "stable provider id should point at the hot-switched provider endpoint"
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
            Some("rightcode"),
            "restored Codex live config should not switch history buckets"
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
}
