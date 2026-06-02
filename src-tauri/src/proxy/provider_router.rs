//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{AllowResult, CircuitBreaker, CircuitBreakerConfig};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

const API_KEY_ERROR_DISABLE_THRESHOLD: u32 = 3;
const LOAD_BALANCING_SESSION_TTL_SECS: u64 = 120;

#[derive(Debug, Clone)]
struct SessionAffinity {
    provider_id: String,
    last_seen: Instant,
    active_requests: usize,
}

#[derive(Debug, Clone)]
struct ProviderSessionEntry {
    last_seen: Instant,
    active_requests: usize,
}

#[derive(Debug, Default)]
struct LoadBalancingState {
    affinities: HashMap<String, SessionAffinity>,
    provider_sessions: HashMap<String, HashMap<String, ProviderSessionEntry>>,
}

pub(crate) struct LoadBalancingSlotGuard {
    state: Arc<Mutex<LoadBalancingState>>,
    provider_key: String,
    session_key: String,
    affinity_key: Option<String>,
}

impl Drop for LoadBalancingSlotGuard {
    fn drop(&mut self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.release_slot(
            &self.provider_key,
            &self.session_key,
            self.affinity_key.as_deref(),
            Instant::now(),
        );
    }
}

impl LoadBalancingState {
    fn affinity_key(app_type: &str, session_id: &str) -> String {
        format!("{app_type}:{session_id}")
    }

    fn provider_key(app_type: &str, provider_id: &str) -> String {
        format!("{app_type}:{provider_id}")
    }

    fn temporary_session_key(request_id: &str) -> String {
        format!("request:{request_id}")
    }

    fn prune_expired(&mut self, now: Instant) {
        let ttl = Duration::from_secs(LOAD_BALANCING_SESSION_TTL_SECS);
        let expired: Vec<String> = self
            .affinities
            .iter()
            .filter(|(_, affinity)| {
                affinity.active_requests == 0 && now.duration_since(affinity.last_seen) >= ttl
            })
            .map(|(key, _)| key.clone())
            .collect();

        for affinity_key in expired {
            self.affinities.remove(&affinity_key);
        }

        self.provider_sessions.retain(|_, sessions| {
            sessions.retain(|_, entry| entry.active_requests > 0);
            !sessions.is_empty()
        });
    }

    fn remove_provider_session(&mut self, provider_key: &str, session_key: &str) {
        if let Some(sessions) = self.provider_sessions.get_mut(provider_key) {
            sessions.remove(session_key);
            if sessions.is_empty() {
                self.provider_sessions.remove(provider_key);
            }
        }
    }

    fn active_request_count(&self, app_type: &str, provider_id: &str) -> usize {
        self.provider_sessions
            .get(&Self::provider_key(app_type, provider_id))
            .map(|sessions| {
                sessions
                    .values()
                    .map(|entry| entry.active_requests)
                    .sum::<usize>()
            })
            .unwrap_or(0)
    }

    fn sticky_session_count(&self, app_type: &str, provider_id: &str) -> usize {
        let prefix = format!("{app_type}:");
        self.affinities
            .iter()
            .filter(|(key, affinity)| {
                key.starts_with(&prefix) && affinity.provider_id == provider_id
            })
            .count()
    }

    fn load_balancing_session_count(
        &self,
        app_type: &str,
        provider_id: &str,
        session_client_provided: bool,
    ) -> usize {
        if session_client_provided {
            self.sticky_session_count(app_type, provider_id)
        } else {
            self.active_request_count(app_type, provider_id)
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn acquire_slot(
        &mut self,
        app_type: &str,
        provider_id: &str,
        session_id: &str,
        client_provided: bool,
        request_id: &str,
        update_affinity_provider: bool,
        state: Arc<Mutex<LoadBalancingState>>,
    ) -> LoadBalancingSlotGuard {
        let now = Instant::now();
        self.prune_expired(now);

        let provider_key = Self::provider_key(app_type, provider_id);
        let affinity_key = if client_provided && !session_id.trim().is_empty() {
            let affinity_key = Self::affinity_key(app_type, session_id);
            if let Some(affinity) = self.affinities.get_mut(&affinity_key) {
                if update_affinity_provider {
                    affinity.provider_id = provider_id.to_string();
                }
                affinity.last_seen = now;
                affinity.active_requests = affinity.active_requests.saturating_add(1);
            } else {
                self.affinities.insert(
                    affinity_key.clone(),
                    SessionAffinity {
                        provider_id: provider_id.to_string(),
                        last_seen: now,
                        active_requests: 1,
                    },
                );
            }

            Some(affinity_key)
        } else {
            None
        };
        let session_key = Self::temporary_session_key(request_id);

        let sessions = self
            .provider_sessions
            .entry(provider_key.clone())
            .or_default();
        let entry = sessions
            .entry(session_key.clone())
            .or_insert_with(|| ProviderSessionEntry {
                last_seen: now,
                active_requests: 0,
            });
        entry.last_seen = now;
        entry.active_requests = entry.active_requests.saturating_add(1);

        LoadBalancingSlotGuard {
            state,
            provider_key,
            session_key,
            affinity_key,
        }
    }

    fn release_slot(
        &mut self,
        provider_key: &str,
        session_key: &str,
        affinity_key: Option<&str>,
        now: Instant,
    ) {
        let mut remove_session = false;
        if let Some(sessions) = self.provider_sessions.get_mut(provider_key) {
            if let Some(entry) = sessions.get_mut(session_key) {
                entry.active_requests = entry.active_requests.saturating_sub(1);
                entry.last_seen = now;
                remove_session = entry.active_requests == 0;
            }
        }
        if remove_session {
            self.remove_provider_session(provider_key, session_key);
        }

        if let Some(affinity_key) = affinity_key {
            if let Some(affinity) = self.affinities.get_mut(affinity_key) {
                affinity.active_requests = affinity.active_requests.saturating_sub(1);
                affinity.last_seen = now;
            }
        }
    }
}

/// 供应商路由器
pub struct ProviderRouter {
    /// 数据库连接
    db: Arc<Database>,
    /// 熔断器管理器 - key 格式: "app_type:provider_id"
    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreaker>>>>,
    /// API Key 认证错误计数 - key 格式: "app_type:provider_id"
    api_key_error_counts: Arc<RwLock<HashMap<String, u32>>>,
    /// 分流运行时状态：会话粘性与供应商当前会话占用。
    load_balancing: Arc<Mutex<LoadBalancingState>>,
    /// AppHandle，用于通知前端刷新故障转移队列
    app_handle: Option<tauri::AppHandle>,
}

impl ProviderRouter {
    /// 创建新的供应商路由器
    #[allow(dead_code)]
    pub fn new(db: Arc<Database>) -> Self {
        Self::with_app_handle(db, None)
    }

    pub fn with_app_handle(db: Arc<Database>, app_handle: Option<tauri::AppHandle>) -> Self {
        Self {
            db,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
            api_key_error_counts: Arc::new(RwLock::new(HashMap::new())),
            load_balancing: Arc::new(Mutex::new(LoadBalancingState::default())),
            app_handle,
        }
    }

    /// 选择可用的供应商（支持故障转移）
    ///
    /// 返回按优先级排序的可用供应商列表：
    /// - 故障转移关闭时：仅返回当前供应商
    /// - 故障转移开启时：仅使用故障转移队列，按队列顺序依次尝试（P1 → P2 → ...）
    pub async fn select_providers(&self, app_type: &str) -> Result<Vec<Provider>, AppError> {
        self.select_providers_for_session(app_type, "", false).await
    }

    /// 选择当前可用供应商。
    ///
    /// 分流不会在这里占用容量；真正的“按会话粘性/容量选择并占用”必须在
    /// `acquire_load_balancing_slot_for_candidates` 中完成，避免并发请求基于旧快照同时选中同一家。
    pub async fn select_providers_for_session(
        &self,
        app_type: &str,
        _session_id: &str,
        _session_client_provided: bool,
    ) -> Result<Vec<Provider>, AppError> {
        let mut result = Vec::new();
        let mut total_providers = 0usize;
        let mut circuit_open_count = 0usize;

        // 检查该应用的自动故障转移开关是否开启（从 proxy_config 表读取）
        let (app_proxy_enabled, auto_failover_enabled) =
            match self.db.get_proxy_config_for_app(app_type).await {
                Ok(config) => (config.enabled, config.auto_failover_enabled),
                Err(e) => {
                    log::error!("[{app_type}] 读取 proxy_config 失败: {e}，默认禁用故障转移");
                    (false, false)
                }
            };

        if app_proxy_enabled && auto_failover_enabled {
            // 故障转移开启：仅按队列顺序依次尝试（P1 → P2 → ...）
            let all_providers = self.db.get_all_providers(app_type)?;

            // 使用 DAO 返回的排序结果，确保和前端展示一致
            let ordered_ids: Vec<String> = self
                .db
                .get_failover_queue(app_type)?
                .into_iter()
                .map(|item| item.provider_id)
                .collect();

            total_providers = ordered_ids.len();

            for provider_id in ordered_ids {
                let Some(provider) = all_providers.get(&provider_id).cloned() else {
                    continue;
                };

                let circuit_key = format!("{app_type}:{}", provider.id);
                let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

                if breaker.is_available().await {
                    result.push(provider);
                } else {
                    circuit_open_count += 1;
                }
            }
        } else {
            // 故障转移关闭：仅使用当前供应商。
            // 但如果该供应商已经因为认证错误或熔断策略被打开断路器，
            // 不能继续把新请求路由给它，否则会在单供应商模式下无限重复打到
            // 一个已知不可用的 key。
            let current_id = AppType::from_str(app_type).ok().and_then(|app_enum| {
                crate::settings::get_effective_current_provider(&self.db, &app_enum)
                    .ok()
                    .flatten()
            });

            if let Some(current_id) = current_id {
                if let Some(current) = self.db.get_provider_by_id(&current_id, app_type)? {
                    total_providers = 1;
                    let circuit_key = format!("{app_type}:{}", current.id);
                    let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
                    if breaker.is_available().await {
                        result.push(current);
                    } else {
                        circuit_open_count = 1;
                    }
                }
            }
        }

        if result.is_empty() {
            if total_providers > 0 && circuit_open_count == total_providers {
                log::warn!("[{app_type}] [FO-004] 所有供应商均已熔断");
                return Err(AppError::AllProvidersCircuitOpen);
            } else {
                log::warn!("[{app_type}] [FO-005] 未配置供应商");
                return Err(AppError::NoProvidersConfigured);
            }
        }

        Ok(result)
    }

    pub(crate) fn acquire_load_balancing_slot_for_candidates(
        &self,
        app_type: &str,
        providers: &[Provider],
        session_id: &str,
        session_client_provided: bool,
        request_id: &str,
    ) -> Option<(usize, LoadBalancingSlotGuard)> {
        if providers.is_empty() {
            return None;
        }

        let mut state = match self.load_balancing.lock() {
            Ok(state) => state,
            Err(e) => {
                log::warn!("[{app_type}] 分流状态锁已污染，回退故障转移队列顺序: {e}");
                return None;
            }
        };
        state.prune_expired(Instant::now());

        if session_client_provided && !session_id.trim().is_empty() {
            let affinity_key = LoadBalancingState::affinity_key(app_type, session_id);
            if let Some(affinity) = state.affinities.get(&affinity_key).cloned() {
                if let Some(index) = providers
                    .iter()
                    .position(|provider| provider.id == affinity.provider_id)
                {
                    let guard = state.acquire_slot(
                        app_type,
                        &providers[index].id,
                        session_id,
                        session_client_provided,
                        request_id,
                        true,
                        self.load_balancing.clone(),
                    );
                    return Some((index, guard));
                } else {
                    state.affinities.remove(&affinity_key);
                }
            }
        }

        let selected_index = providers
            .iter()
            .position(|provider| {
                provider_has_load_balancing_capacity(
                    state.load_balancing_session_count(
                        app_type,
                        &provider.id,
                        session_client_provided,
                    ),
                    provider_max_sessions(provider),
                )
            })
            .unwrap_or(0);

        let guard = state.acquire_slot(
            app_type,
            &providers[selected_index].id,
            session_id,
            session_client_provided,
            request_id,
            true,
            self.load_balancing.clone(),
        );
        Some((selected_index, guard))
    }

    /// 请求执行前获取熔断器“放行许可”
    ///
    /// - Closed：直接放行
    /// - Open：超时到达后切到 HalfOpen 并放行一次探测
    /// - HalfOpen：按限流规则放行探测
    ///
    /// 注意：调用方必须在请求结束后通过 `record_result()` 释放 HalfOpen 名额，
    /// 否则会导致该 Provider 长时间无法进入探测状态。
    pub async fn allow_provider_request(&self, provider_id: &str, app_type: &str) -> AllowResult {
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.allow_request().await
    }

    /// 记录供应商请求结果
    pub async fn record_result(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<(), AppError> {
        self.record_result_inner(
            provider_id,
            app_type,
            used_half_open_permit,
            success,
            error_msg,
        )
        .await?;
        Ok(())
    }

    /// 记录供应商请求结果，并在认证错误熔断禁用时执行运行时清理。
    pub async fn record_result_with_disable_hook<F, Fut>(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
        on_disabled: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce(String, String) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let disabled = self
            .record_result_inner(
                provider_id,
                app_type,
                used_half_open_permit,
                success,
                error_msg,
            )
            .await?;

        if disabled {
            on_disabled(app_type.to_string(), provider_id.to_string()).await;
            if let Ok(Some(())) = self
                .db
                .get_proxy_config_for_app(app_type)
                .await
                .map(|config| {
                    if config.enabled && config.auto_failover_enabled {
                        Some(())
                    } else {
                        None
                    }
                })
            {
                if let Some(app_handle) = &self.app_handle {
                    if let Some(app_state) = app_handle.try_state::<crate::store::AppState>() {
                        let _ = app_state
                            .proxy_service
                            .reconcile_failover_after_provider_removal(provider_id, app_type)
                            .await;
                    }
                }
            }
        }

        Ok(())
    }

    async fn record_result_inner(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<bool, AppError> {
        // 1. 按应用独立获取熔断器配置
        let failure_threshold = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => app_config.circuit_failure_threshold,
            Err(_) => 5, // 默认值
        };

        // 2. 更新熔断器状态
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

        if success {
            breaker.record_success(used_half_open_permit).await;
            self.reset_api_key_error_count(&circuit_key).await;
        } else {
            breaker.record_failure(used_half_open_permit).await;
        }

        // 3. 更新数据库健康状态（使用配置的阈值）
        self.db
            .update_provider_health_with_threshold(
                provider_id,
                app_type,
                success,
                error_msg.clone(),
                failure_threshold,
            )
            .await?;

        let mut disabled = false;
        if !success && is_api_key_auth_error(error_msg.as_deref()) {
            let count = self.increment_api_key_error_count(&circuit_key).await;
            if count >= API_KEY_ERROR_DISABLE_THRESHOLD {
                breaker.force_open().await;
                self.db.remove_from_failover_queue(app_type, provider_id)?;
                log::warn!(
                    "[{app_type}] Provider {provider_id} 出现 {count} 次 API Key 认证错误，已熔断并从故障转移队列禁用"
                );
                self.emit_provider_disabled(app_type, provider_id);
                disabled = true;
            }
        }

        Ok(disabled)
    }

    /// 重置熔断器（手动恢复）
    pub async fn reset_circuit_breaker(&self, circuit_key: &str) {
        let breakers = self.circuit_breakers.read().await;
        if let Some(breaker) = breakers.get(circuit_key) {
            breaker.reset().await;
        }
    }

    /// 重置指定供应商的熔断器
    pub async fn reset_provider_breaker(&self, provider_id: &str, app_type: &str) {
        let circuit_key = format!("{app_type}:{provider_id}");
        self.reset_circuit_breaker(&circuit_key).await;
        self.reset_api_key_error_count(&circuit_key).await;
    }

    /// 仅释放 HalfOpen permit，不影响健康统计（neutral 接口）
    ///
    /// 用于整流器等场景：请求结果不应计入 Provider 健康度，
    /// 但仍需释放占用的探测名额，避免 HalfOpen 状态卡死
    pub async fn release_permit_neutral(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
    ) {
        if !used_half_open_permit {
            return;
        }
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.release_half_open_permit();
    }

    /// 更新所有熔断器的配置（热更新）
    pub async fn update_all_configs(&self, config: CircuitBreakerConfig) {
        let breakers = self.circuit_breakers.read().await;
        for breaker in breakers.values() {
            breaker.update_config(config.clone()).await;
        }
    }

    /// 更新指定应用已创建熔断器的配置（热更新）
    pub async fn update_app_configs(&self, app_type: &str, config: CircuitBreakerConfig) {
        let prefix = format!("{app_type}:");
        let breakers = self.circuit_breakers.read().await;
        for (key, breaker) in breakers.iter() {
            if key.starts_with(&prefix) {
                breaker.update_config(config.clone()).await;
            }
        }
    }

    /// 获取熔断器状态
    #[allow(dead_code)]
    pub async fn get_circuit_breaker_stats(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Option<crate::proxy::circuit_breaker::CircuitBreakerStats> {
        let circuit_key = format!("{app_type}:{provider_id}");
        let breakers = self.circuit_breakers.read().await;

        if let Some(breaker) = breakers.get(&circuit_key) {
            Some(breaker.get_stats().await)
        } else {
            None
        }
    }

    /// 获取或创建熔断器
    async fn get_or_create_circuit_breaker(&self, key: &str) -> Arc<CircuitBreaker> {
        // 先尝试读锁获取
        {
            let breakers = self.circuit_breakers.read().await;
            if let Some(breaker) = breakers.get(key) {
                return breaker.clone();
            }
        }

        // 如果不存在，获取写锁创建
        let mut breakers = self.circuit_breakers.write().await;

        // 双重检查，防止竞争条件
        if let Some(breaker) = breakers.get(key) {
            return breaker.clone();
        }

        // 从 key 中提取 app_type (格式: "app_type:provider_id")
        let app_type = key.split(':').next().unwrap_or("claude");

        // 按应用独立读取熔断器配置
        let config = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => crate::proxy::circuit_breaker::CircuitBreakerConfig {
                failure_threshold: app_config.circuit_failure_threshold,
                success_threshold: app_config.circuit_success_threshold,
                timeout_seconds: app_config.circuit_timeout_seconds as u64,
                error_rate_threshold: app_config.circuit_error_rate_threshold,
                min_requests: app_config.circuit_min_requests,
            },
            Err(_) => crate::proxy::circuit_breaker::CircuitBreakerConfig::default(),
        };

        let breaker = Arc::new(CircuitBreaker::new(config));
        breakers.insert(key.to_string(), breaker.clone());

        breaker
    }

    async fn increment_api_key_error_count(&self, key: &str) -> u32 {
        let mut counts = self.api_key_error_counts.write().await;
        let count = counts.entry(key.to_string()).or_insert(0);
        *count += 1;
        *count
    }

    async fn reset_api_key_error_count(&self, key: &str) {
        let mut counts = self.api_key_error_counts.write().await;
        counts.remove(key);
    }

    fn emit_provider_disabled(&self, app_type: &str, provider_id: &str) {
        let Some(app_handle) = &self.app_handle else {
            return;
        };

        let event_data = serde_json::json!({
            "appType": app_type,
            "providerId": provider_id,
            "source": "apiKeyAuthCircuitBreaker"
        });
        if let Err(e) = app_handle.emit("provider-switched", event_data) {
            log::debug!("发射 API Key 熔断禁用事件失败: {e}");
        }
    }
}

fn is_api_key_auth_error(error_msg: Option<&str>) -> bool {
    let Some(error_msg) = error_msg else {
        return false;
    };

    let lower = error_msg.to_ascii_lowercase();
    lower.contains("invalid api key") || lower.contains("api key is disabled")
}

fn provider_max_sessions(provider: &Provider) -> Option<usize> {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.max_sessions)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
}

fn provider_has_load_balancing_capacity(
    current_sessions: usize,
    max_sessions: Option<usize>,
) -> bool {
    max_sessions
        .map(|max_sessions| current_sessions < max_sessions)
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::AppType;
    use crate::codex_config::{get_codex_auth_path, get_codex_config_path};
    use crate::config::{get_claude_settings_path, read_json_file};
    use crate::database::Database;
    use crate::gemini_config::read_gemini_env;
    use crate::proxy::types::ProxyConfig;
    use crate::services::provider::ProviderService;
    use crate::store::AppState;
    use serde_json::{json, Value};
    use serial_test::serial;
    use std::env;
    use std::fs;
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
            crate::settings::reload_settings().expect("reload settings");

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

    #[tokio::test]
    #[serial]
    async fn test_provider_router_creation() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);

        let breaker = router.get_or_create_circuit_breaker("claude:test").await;
        assert!(breaker.allow_request().await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_disabled_uses_current_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_disabled_prefers_local_settings_current_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        // Simulate stale DB current while local settings has the freshly switched target.
        db.set_current_provider("claude", "a").unwrap();
        crate::settings::set_current_provider(&AppType::Claude, Some("b")).unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_order_ignoring_current() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 设置 sort_index 来控制顺序：b=1, a=2
        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(2);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        db.add_to_failover_queue("claude", "b").unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 2);
        // 故障转移开启时：仅按队列顺序选择（忽略当前供应商）
        assert_eq!(providers[0].id, "b");
        assert_eq!(providers[1].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn test_failover_enabled_uses_queue_only_even_if_current_not_in_queue() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(1);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        // 只把 b 加入故障转移队列（模拟“当前供应商不在队列里”的常见配置）
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn load_balancing_respects_queue_order_max_sessions_and_overflow() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        provider_a.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        provider_b.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(2),
            ..Default::default()
        });
        let mut provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);
        provider_c.sort_index = Some(3);
        provider_c.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(3),
            ..Default::default()
        });

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.save_provider("claude", &provider_c).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();
        db.add_to_failover_queue("claude", "c").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.load_balancing_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let expected = ["a", "b", "b", "c", "c", "c", "a", "a", "a"];
        let mut guards = Vec::new();

        for (index, expected_provider_id) in expected.iter().enumerate() {
            let session_id = format!("session-{}", index + 1);
            let request_id = format!("request-{}", index + 1);
            let providers = router
                .select_providers_for_session("claude", &session_id, true)
                .await
                .unwrap();
            let (selected_index, guard) = router
                .acquire_load_balancing_slot_for_candidates(
                    "claude",
                    &providers,
                    &session_id,
                    true,
                    &request_id,
                )
                .expect("load balancing should never leave a request unassigned");
            assert_eq!(
                providers[selected_index].id, *expected_provider_id,
                "unexpected provider for {session_id}"
            );
            guards.push(guard);
        }

        let providers = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        let (selected_index, _guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "session-1",
                true,
                "request-sticky",
            )
            .expect("client-provided sessions should keep provider affinity");
        assert_eq!(
            providers[selected_index].id, "a",
            "requests above the total configured load-balancing capacity should overflow to the first provider"
        );
    }

    #[tokio::test]
    #[serial]
    async fn load_balancing_keeps_concurrent_requests_on_sticky_session_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        provider_a.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(3),
            ..Default::default()
        });
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        provider_b.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(3),
            ..Default::default()
        });

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.load_balancing_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers_for_session("claude", "same-session", true)
            .await
            .unwrap();
        let expected = ["a", "a", "a", "a", "a", "a"];
        let mut guards = Vec::new();

        for (index, expected_provider_id) in expected.iter().enumerate() {
            let request_id = format!("same-session-request-{}", index + 1);
            let (selected_index, guard) = router
                .acquire_load_balancing_slot_for_candidates(
                    "claude",
                    &providers,
                    "same-session",
                    true,
                    &request_id,
                )
                .expect("concurrent sticky-session request should keep its provider");

            assert_eq!(
                providers[selected_index].id,
                *expected_provider_id,
                "unexpected provider for same-session request {}",
                index + 1
            );
            guards.push(guard);
        }
    }

    #[tokio::test]
    #[serial]
    async fn load_balancing_honors_first_provider_capacity_for_six_requests() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        provider_a.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(3),
            ..Default::default()
        });
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        provider_b.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(2),
            ..Default::default()
        });
        let mut provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);
        provider_c.sort_index = Some(3);
        provider_c.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.save_provider("claude", &provider_c).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();
        db.add_to_failover_queue("claude", "c").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.load_balancing_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let expected = ["a", "a", "a", "b", "b", "c"];
        let mut guards = Vec::new();

        for (index, expected_provider_id) in expected.iter().enumerate() {
            let session_id = format!("capacity-session-{}", index + 1);
            let request_id = format!("capacity-request-{}", index + 1);
            let providers = router
                .select_providers_for_session("claude", &session_id, true)
                .await
                .unwrap();
            let (selected_index, guard) = router
                .acquire_load_balancing_slot_for_candidates(
                    "claude",
                    &providers,
                    &session_id,
                    true,
                    &request_id,
                )
                .expect("load balancing should always assign a provider when capacity exists");

            assert_eq!(
                providers[selected_index].id,
                *expected_provider_id,
                "unexpected provider for request {}",
                index + 1
            );
            guards.push(guard);
        }
    }

    #[tokio::test]
    #[serial]
    async fn load_balancing_counts_sticky_sessions_after_requests_complete() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        provider_a.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        provider_b.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.load_balancing_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let expected = [("session-a", "a"), ("session-b", "b")];

        for (index, (session_id, expected_provider_id)) in expected.iter().enumerate() {
            let providers = router
                .select_providers_for_session("claude", session_id, true)
                .await
                .unwrap();
            let (selected_index, guard) = router
                .acquire_load_balancing_slot_for_candidates(
                    "claude",
                    &providers,
                    session_id,
                    true,
                    &format!("request-{}", index + 1),
                )
                .expect("load balancing should assign completed sticky sessions by capacity");
            assert_eq!(providers[selected_index].id, *expected_provider_id);
            drop(guard);
        }

        let providers = router
            .select_providers_for_session("claude", "session-a", true)
            .await
            .unwrap();
        let (selected_index, _guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "session-a",
                true,
                "request-sticky",
            )
            .expect("existing sticky session should keep its original provider");
        assert_eq!(providers[selected_index].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn load_balancing_without_client_session_uses_active_request_capacity() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        provider_a.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        provider_b.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.load_balancing_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers_for_session("claude", "generated-session", false)
            .await
            .unwrap();

        let (first_index, first_guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "generated-session-1",
                false,
                "generated-request-1",
            )
            .expect("first generated request should acquire a provider");
        assert_eq!(providers[first_index].id, "a");

        let (second_index, second_guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "generated-session-2",
                false,
                "generated-request-2",
            )
            .expect("second concurrent generated request should use active capacity");
        assert_eq!(providers[second_index].id, "b");

        drop(first_guard);

        let (third_index, _third_guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "generated-session-3",
                false,
                "generated-request-3",
            )
            .expect("released generated request capacity should be reusable");
        assert_eq!(providers[third_index].id, "a");

        drop(second_guard);
    }

    #[tokio::test]
    #[serial]
    async fn load_balancing_sticky_session_ignores_new_session_capacity_limit() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        provider_a.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        provider_b.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.load_balancing_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers_for_session("claude", "sticky-session", true)
            .await
            .unwrap();

        let (first_index, first_guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "sticky-session",
                true,
                "sticky-request-1",
            )
            .expect("first sticky request should acquire a provider");
        assert_eq!(providers[first_index].id, "a");

        let (concurrent_index, concurrent_guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "sticky-session",
                true,
                "sticky-request-2",
            )
            .expect("sticky request should stay on its original provider");
        assert_eq!(providers[concurrent_index].id, "a");

        drop(first_guard);
        drop(concurrent_guard);

        let (next_index, _next_guard) = router
            .acquire_load_balancing_slot_for_candidates(
                "claude",
                &providers,
                "sticky-session",
                true,
                "sticky-request-3",
            )
            .expect("sticky session should return to its original provider after slots free");
        assert_eq!(providers[next_index].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn load_balancing_acquire_rechecks_capacity_after_stale_selection() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        provider_a.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(1),
            ..Default::default()
        });
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        provider_b.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(2),
            ..Default::default()
        });
        let mut provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);
        provider_c.sort_index = Some(3);
        provider_c.meta = Some(crate::provider::ProviderMeta {
            max_sessions: Some(3),
            ..Default::default()
        });

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.save_provider("claude", &provider_c).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();
        db.add_to_failover_queue("claude", "c").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.load_balancing_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let provider_lists = [
            router
                .select_providers_for_session("claude", "stale-1", true)
                .await
                .unwrap(),
            router
                .select_providers_for_session("claude", "stale-2", true)
                .await
                .unwrap(),
            router
                .select_providers_for_session("claude", "stale-3", true)
                .await
                .unwrap(),
            router
                .select_providers_for_session("claude", "stale-4", true)
                .await
                .unwrap(),
        ];
        let expected = ["a", "b", "b", "c"];
        let mut guards = Vec::new();

        for (index, providers) in provider_lists.iter().enumerate() {
            let session_id = format!("stale-{}", index + 1);
            let request_id = format!("stale-request-{}", index + 1);
            let (selected_index, guard) = router
                .acquire_load_balancing_slot_for_candidates(
                    "claude",
                    providers,
                    &session_id,
                    true,
                    &request_id,
                )
                .expect("stale selection should still acquire a provider");
            assert_eq!(providers[selected_index].id, expected[index]);
            guards.push(guard);
        }
    }

    #[tokio::test]
    #[serial]
    async fn auto_failover_flag_without_app_takeover_uses_current_provider_not_queue() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.set_current_provider("codex", "a").unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
        config.enabled = false;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("codex").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(
            providers[0].id, "a",
            "failover must not route through queue when app takeover is disabled"
        );
    }

    #[tokio::test]
    #[serial]
    async fn test_select_providers_does_not_consume_half_open_permit() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        // 启用自动故障转移（使用新的 proxy_config API）
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        router
            .record_result("b", "claude", false, false, Some("fail".to_string()))
            .await
            .unwrap();

        let providers = router.select_providers("claude").await.unwrap();
        assert_eq!(providers.len(), 2);

        assert!(router.allow_provider_request("b", "claude").await.allowed);
    }

    #[tokio::test]
    #[serial]
    async fn test_release_permit_neutral_frees_half_open_slot() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        // 配置熔断器：1 次失败即熔断，0 秒超时立即进入 HalfOpen
        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        // 启用自动故障转移
        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        // 触发熔断：1 次失败
        router
            .record_result("a", "claude", false, false, Some("fail".to_string()))
            .await
            .unwrap();

        // 第一次请求：获取 HalfOpen 探测名额
        let first = router.allow_provider_request("a", "claude").await;
        assert!(first.allowed);
        assert!(first.used_half_open_permit);

        // 第二次请求应被拒绝（名额已被占用）
        let second = router.allow_provider_request("a", "claude").await;
        assert!(!second.allowed);

        // 使用 release_permit_neutral 释放名额（不影响健康统计）
        router
            .release_permit_neutral("a", "claude", first.used_half_open_permit)
            .await;

        // 第三次请求应被允许（名额已释放）
        let third = router.allow_provider_request("a", "claude").await;
        assert!(third.allowed);
        assert!(third.used_half_open_permit);
    }

    #[tokio::test]
    #[serial]
    async fn api_key_auth_errors_trip_breaker_and_disable_provider_after_three_failures() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider = Provider::with_id(
            "auth-bad".to_string(),
            "Auth Bad".to_string(),
            json!({}),
            None,
        );
        db.save_provider("claude", &provider).unwrap();
        db.add_to_failover_queue("claude", "auth-bad").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 8;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        for _ in 0..2 {
            router
                .record_result(
                    "auth-bad",
                    "claude",
                    false,
                    false,
                    Some(r#"{"error":{"message":"Invalid API Key"}}"#.to_string()),
                )
                .await
                .unwrap();
        }

        assert!(db.is_in_failover_queue("claude", "auth-bad").unwrap());
        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-bad", "claude")
                .await
                .unwrap()
                .state,
            crate::proxy::circuit_breaker::CircuitState::Closed
        );

        router
            .record_result(
                "auth-bad",
                "claude",
                false,
                false,
                Some("API Key is disabled".to_string()),
            )
            .await
            .unwrap();

        assert!(!db.is_in_failover_queue("claude", "auth-bad").unwrap());
        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-bad", "claude")
                .await
                .unwrap()
                .state,
            crate::proxy::circuit_breaker::CircuitState::Open
        );
    }

    #[tokio::test]
    #[serial]
    async fn api_key_auth_error_count_resets_after_success() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider = Provider::with_id(
            "auth-reset".to_string(),
            "Auth Reset".to_string(),
            json!({}),
            None,
        );
        db.save_provider("claude", &provider).unwrap();
        db.add_to_failover_queue("claude", "auth-reset").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 8;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        for _ in 0..2 {
            router
                .record_result(
                    "auth-reset",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .unwrap();
        }

        router
            .record_result("auth-reset", "claude", false, true, None)
            .await
            .unwrap();

        router
            .record_result(
                "auth-reset",
                "claude",
                false,
                false,
                Some("Invalid API Key".to_string()),
            )
            .await
            .unwrap();

        assert!(db.is_in_failover_queue("claude", "auth-reset").unwrap());
        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-reset", "claude")
                .await
                .unwrap()
                .state,
            crate::proxy::circuit_breaker::CircuitState::Closed
        );
    }

    #[tokio::test]
    #[serial]
    async fn api_key_disable_advances_failover_active_target_when_proxy_is_running() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port()
        };

        db.update_proxy_config(crate::proxy::types::ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("claude", "a")
            .expect("queue provider a");
        db.add_to_failover_queue("claude", "b")
            .expect("queue provider b");

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable failover");

        let state = crate::store::AppState::new(db.clone());
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");
        state
            .proxy_service
            .set_active_target_only("claude", "a", "Provider A")
            .await;

        let router = ProviderRouter::with_app_handle(db.clone(), None);

        for _ in 0..3 {
            router
                .record_result_with_disable_hook(
                    "a",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                    {
                        let state = &state;
                        move |app_type, provider_id| async move {
                            state
                                .proxy_service
                                .reconcile_failover_after_provider_removal(&provider_id, &app_type)
                                .await
                                .expect("reconcile after disable");
                        }
                    },
                )
                .await
                .expect("record auth failure");
        }

        assert!(!db.is_in_failover_queue("claude", "a").unwrap());
        let status = state
            .proxy_service
            .get_status()
            .await
            .expect("get proxy status");
        let active = status
            .active_targets
            .iter()
            .find(|target| target.app_type == "claude")
            .expect("claude active target should remain");
        assert_eq!(
            active.provider_id, "b",
            "disabling queue head must immediately promote next failover target"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn api_key_disable_last_failover_provider_keeps_takeover_live_when_queue_becomes_empty() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port()
        };

        db.update_proxy_config(crate::proxy::types::ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "solo".to_string(),
            "Solo Provider".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-solo",
                    "ANTHROPIC_BASE_URL": "https://solo.example",
                    "ANTHROPIC_MODEL": "model-solo"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save provider");
        db.add_to_failover_queue("claude", "solo")
            .expect("queue provider");

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 8;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable failover");

        let state = crate::store::AppState::new(db.clone());
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");
        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Claude, &provider)
            .await
            .expect("seed takeover live");
        state
            .proxy_service
            .set_active_target_only("claude", "solo", "Solo Provider")
            .await;

        let router = ProviderRouter::with_app_handle(db.clone(), None);

        for _ in 0..3 {
            router
                .record_result_with_disable_hook(
                    "solo",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                    {
                        let state = &state;
                        move |app_type, provider_id| async move {
                            state
                                .proxy_service
                                .reconcile_failover_after_provider_removal(&provider_id, &app_type)
                                .await
                                .expect("reconcile after disable");
                        }
                    },
                )
                .await
                .expect("record auth failure");
        }

        assert!(
            !db.is_in_failover_queue("claude", "solo").unwrap(),
            "last provider should be removed from failover queue after auth disable"
        );

        let live: serde_json::Value =
            read_json_file(&get_claude_settings_path()).expect("read claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(serde_json::Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "disabling the last failover provider must not revert Claude live to the provider direct base_url while takeover remains enabled"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(serde_json::Value::as_str),
            Some("PROXY_MANAGED"),
            "takeover token placeholder must remain after the queue becomes empty"
        );

        let status = state
            .proxy_service
            .get_status()
            .await
            .expect("get proxy status");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "claude"),
            "empty queue after auth disable should clear active target"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn api_key_disable_last_codex_failover_provider_keeps_takeover_live_when_queue_becomes_empty(
    ) {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port()
        };

        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "codex-solo".to_string(),
            "Codex Solo".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "token-solo"
                },
                "config": r#"model_provider = "codex-solo"
model = "gpt-5.4"

[model_providers.codex-solo]
base_url = "https://codex-solo.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider).expect("save provider");
        db.add_to_failover_queue("codex", "codex-solo")
            .expect("queue provider");

        let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 8;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable failover");

        let state = AppState::new(db.clone());
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");
        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &provider)
            .await
            .expect("seed Codex takeover live");
        state
            .proxy_service
            .set_active_target_only("codex", "codex-solo", "Codex Solo")
            .await;

        let router = ProviderRouter::with_app_handle(db.clone(), None);

        for _ in 0..3 {
            router
                .record_result_with_disable_hook(
                    "codex-solo",
                    "codex",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                    {
                        let state = &state;
                        move |app_type, provider_id| async move {
                            state
                                .proxy_service
                                .reconcile_failover_after_provider_removal(&provider_id, &app_type)
                                .await
                                .expect("reconcile after disable");
                        }
                    },
                )
                .await
                .expect("record auth failure");
        }

        assert!(
            !db.is_in_failover_queue("codex", "codex-solo").unwrap(),
            "last Codex provider should be removed from failover queue after auth disable"
        );

        let auth: Value = read_json_file(&get_codex_auth_path()).expect("read Codex auth live");
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("PROXY_MANAGED"),
            "Codex takeover token placeholder must remain after the queue becomes empty"
        );

        let config_text =
            fs::read_to_string(get_codex_config_path()).expect("read Codex config live");
        assert!(
            config_text.contains(&format!("http://127.0.0.1:{port}/v1")),
            "disabling the last Codex failover provider must keep config.toml on the local proxy base_url"
        );
        assert!(
            !config_text.contains("https://codex-solo.example/v1"),
            "disabling the last Codex failover provider must not write the provider direct baseUrl back to live"
        );

        let status = state
            .proxy_service
            .get_status()
            .await
            .expect("get proxy status");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "codex"),
            "empty Codex queue after auth disable should clear active target"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn api_key_disable_last_gemini_failover_provider_keeps_takeover_live_when_queue_becomes_empty(
    ) {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port()
        };

        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let provider = Provider::with_id(
            "gemini-solo".to_string(),
            "Gemini Solo".to_string(),
            json!({
                "env": {
                    "GEMINI_API_KEY": "token-solo",
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini-solo.example",
                    "GEMINI_MODEL": "gemini-3-pro"
                }
            }),
            None,
        );
        db.save_provider("gemini", &provider)
            .expect("save provider");
        db.add_to_failover_queue("gemini", "gemini-solo")
            .expect("queue provider");

        let mut config = db.get_proxy_config_for_app("gemini").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 8;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable failover");

        let state = AppState::new(db.clone());
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");
        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Gemini, &provider)
            .await
            .expect("seed Gemini takeover live");
        state
            .proxy_service
            .set_active_target_only("gemini", "gemini-solo", "Gemini Solo")
            .await;

        let router = ProviderRouter::with_app_handle(db.clone(), None);

        for _ in 0..3 {
            router
                .record_result_with_disable_hook(
                    "gemini-solo",
                    "gemini",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                    {
                        let state = &state;
                        move |app_type, provider_id| async move {
                            state
                                .proxy_service
                                .reconcile_failover_after_provider_removal(&provider_id, &app_type)
                                .await
                                .expect("reconcile after disable");
                        }
                    },
                )
                .await
                .expect("record auth failure");
        }

        assert!(
            !db.is_in_failover_queue("gemini", "gemini-solo").unwrap(),
            "last Gemini provider should be removed from failover queue after auth disable"
        );

        let env = read_gemini_env().expect("read Gemini env live");
        assert_eq!(
            env.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "disabling the last Gemini failover provider must keep .env on the local proxy base URL"
        );
        assert_eq!(
            env.get("GEMINI_API_KEY").map(String::as_str),
            Some("PROXY_MANAGED"),
            "Gemini takeover token placeholder must remain after the queue becomes empty"
        );
        assert_ne!(
            env.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
            Some("https://gemini-solo.example"),
            "disabling the last Gemini failover provider must not write the provider direct baseUrl back to live"
        );

        let status = state
            .proxy_service
            .get_status()
            .await
            .expect("get proxy status");
        assert!(
            status
                .active_targets
                .iter()
                .all(|target| target.app_type != "gemini"),
            "empty Gemini queue after auth disable should clear active target"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn all_circuit_open_failover_queue_keeps_takeover_live_on_proxy_endpoint() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port()
        };

        db.update_proxy_config(ProxyConfig {
            listen_port: port,
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
                    "ANTHROPIC_BASE_URL": "https://a.example",
                    "ANTHROPIC_MODEL": "model-a"
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
                    "ANTHROPIC_BASE_URL": "https://b.example",
                    "ANTHROPIC_MODEL": "model-b"
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

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable failover with strict breaker");

        let state = AppState::new(db.clone());
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");
        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Claude, &provider_a)
            .await
            .expect("seed takeover live");
        state
            .proxy_service
            .set_active_target_only("claude", "a", "Provider A")
            .await;

        let router = ProviderRouter::with_app_handle(db.clone(), None);
        router
            .record_result(
                "a",
                "claude",
                false,
                false,
                Some("upstream timeout".to_string()),
            )
            .await
            .expect("open breaker for provider a");
        router
            .record_result(
                "b",
                "claude",
                false,
                false,
                Some("upstream timeout".to_string()),
            )
            .await
            .expect("open breaker for provider b");

        let error = router
            .select_providers("claude")
            .await
            .expect_err("all queued providers should now be circuit-open");
        assert!(
            matches!(error, AppError::AllProvidersCircuitOpen),
            "expected all providers to be unavailable due to open breakers, got {error:?}"
        );

        ProviderService::sync_current_provider_for_app(&state, AppType::Claude)
            .expect("sync should not rewrite takeover live back to a direct provider");

        let live: Value = read_json_file(&get_claude_settings_path()).expect("read claude live");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "all providers circuit-open must still keep Claude live on the local proxy endpoint"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str),
            Some("PROXY_MANAGED"),
            "all providers circuit-open must keep the takeover token placeholder"
        );
        assert_eq!(
            db.get_failover_queue("claude")
                .expect("read failover queue")
                .into_iter()
                .map(|item| item.provider_id)
                .collect::<Vec<_>>(),
            vec!["a".to_string(), "b".to_string()],
            "generic circuit-open errors must not silently rewrite the failover queue"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn all_circuit_open_codex_failover_keeps_live_on_proxy_base_url() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port()
        };

        db.update_proxy_config(ProxyConfig {
            listen_port: port,
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
                "config": r#"model_provider = "codex-a"
model = "gpt-5.4"

[model_providers.codex-a]
base_url = "https://codex-a.example/v1"
wire_api = "responses"
"#
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
                "config": r#"model_provider = "codex-b"
model = "gpt-5.4"

[model_providers.codex-b]
base_url = "https://codex-b.example/v1"
wire_api = "responses"
"#
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

        let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable failover with strict breaker");

        let state = AppState::new(db.clone());
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");
        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Codex, &provider_a)
            .await
            .expect("seed Codex takeover live");
        state
            .proxy_service
            .set_active_target_only("codex", "codex-a", "Codex A")
            .await;

        let router = ProviderRouter::with_app_handle(db.clone(), None);
        router
            .record_result(
                "codex-a",
                "codex",
                false,
                false,
                Some("upstream timeout".to_string()),
            )
            .await
            .expect("open breaker for provider a");
        router
            .record_result(
                "codex-b",
                "codex",
                false,
                false,
                Some("upstream timeout".to_string()),
            )
            .await
            .expect("open breaker for provider b");

        let error = router
            .select_providers("codex")
            .await
            .expect_err("all queued Codex providers should now be circuit-open");
        assert!(
            matches!(error, AppError::AllProvidersCircuitOpen),
            "expected all Codex providers to be unavailable due to open breakers, got {error:?}"
        );

        ProviderService::sync_current_provider_for_app(&state, AppType::Codex)
            .expect("sync should not rewrite Codex takeover live back to a direct provider");

        let auth: Value = read_json_file(&get_codex_auth_path()).expect("read Codex auth live");
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("PROXY_MANAGED"),
            "all Codex providers circuit-open must keep the takeover token placeholder"
        );

        let config_text =
            fs::read_to_string(get_codex_config_path()).expect("read Codex config live");
        let expected_proxy_base_url = format!("http://127.0.0.1:{port}/v1");
        assert!(
            config_text.contains(&expected_proxy_base_url),
            "all Codex providers circuit-open must keep config.toml on the local proxy base_url"
        );
        assert!(
            !config_text.contains("https://codex-a.example/v1")
                && !config_text.contains("https://codex-b.example/v1"),
            "all Codex providers circuit-open must not write any provider direct baseUrl back to live"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn all_circuit_open_gemini_failover_keeps_live_on_proxy_base_url() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port()
        };

        db.update_proxy_config(ProxyConfig {
            listen_port: port,
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
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini-a.example",
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
                    "GOOGLE_GEMINI_BASE_URL": "https://gemini-b.example",
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

        let mut config = db.get_proxy_config_for_app("gemini").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(config)
            .await
            .expect("enable failover with strict breaker");

        let state = AppState::new(db.clone());
        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");
        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Gemini, &provider_a)
            .await
            .expect("seed Gemini takeover live");
        state
            .proxy_service
            .set_active_target_only("gemini", "gemini-a", "Gemini A")
            .await;

        let router = ProviderRouter::with_app_handle(db.clone(), None);
        router
            .record_result(
                "gemini-a",
                "gemini",
                false,
                false,
                Some("upstream timeout".to_string()),
            )
            .await
            .expect("open breaker for provider a");
        router
            .record_result(
                "gemini-b",
                "gemini",
                false,
                false,
                Some("upstream timeout".to_string()),
            )
            .await
            .expect("open breaker for provider b");

        let error = router
            .select_providers("gemini")
            .await
            .expect_err("all queued Gemini providers should now be circuit-open");
        assert!(
            matches!(error, AppError::AllProvidersCircuitOpen),
            "expected all Gemini providers to be unavailable due to open breakers, got {error:?}"
        );

        ProviderService::sync_current_provider_for_app(&state, AppType::Gemini)
            .expect("sync should not rewrite Gemini takeover live back to a direct provider");

        let env = read_gemini_env().expect("read Gemini env live");
        assert_eq!(
            env.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "all Gemini providers circuit-open must keep .env on the local proxy base URL"
        );
        assert_eq!(
            env.get("GEMINI_API_KEY").map(String::as_str),
            Some("PROXY_MANAGED"),
            "all Gemini providers circuit-open must keep the takeover token placeholder"
        );
        assert_ne!(
            env.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
            Some("https://gemini-a.example"),
            "all Gemini providers circuit-open must not write provider A direct baseUrl back to live"
        );
        assert_ne!(
            env.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
            Some("https://gemini-b.example"),
            "all Gemini providers circuit-open must not write provider B direct baseUrl back to live"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }

    #[tokio::test]
    #[serial]
    async fn single_provider_mode_stops_selecting_auth_disabled_current_provider() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let provider = Provider::with_id(
            "auth-bad".to_string(),
            "Auth Bad".to_string(),
            json!({}),
            None,
        );
        db.save_provider("codex", &provider).expect("save provider");
        db.set_current_provider("codex", "auth-bad")
            .expect("set db current");
        crate::settings::set_current_provider(&AppType::Codex, Some("auth-bad"))
            .expect("set local current");

        let mut config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get proxy config");
        config.enabled = true;
        config.auto_failover_enabled = false;
        config.circuit_failure_threshold = 8;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config)
            .await
            .expect("save proxy config");

        let router = ProviderRouter::new(db.clone());

        for _ in 0..3 {
            router
                .record_result(
                    "auth-bad",
                    "codex",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .expect("record auth failure");
        }

        let error = router
            .select_providers("codex")
            .await
            .expect_err("auth-disabled current provider must not be selected again");
        assert!(
            matches!(error, AppError::AllProvidersCircuitOpen),
            "expected current auth-disabled provider to be treated as unavailable, got {error:?}"
        );
    }

    #[test]
    fn detects_api_key_auth_error_messages_case_insensitively() {
        assert!(is_api_key_auth_error(Some("Invalid API Key")));
        assert!(is_api_key_auth_error(Some(
            r#"{"error":{"message":"api key is disabled"}}"#
        )));
        assert!(!is_api_key_auth_error(Some("rate limit exceeded")));
        assert!(!is_api_key_auth_error(None));
    }
}
