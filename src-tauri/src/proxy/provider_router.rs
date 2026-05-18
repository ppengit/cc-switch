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
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

const API_KEY_ERROR_DISABLE_THRESHOLD: u32 = 3;

/// 供应商路由器
pub struct ProviderRouter {
    /// 数据库连接
    db: Arc<Database>,
    /// 熔断器管理器 - key 格式: "app_type:provider_id"
    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreaker>>>>,
    /// API Key 认证错误计数 - key 格式: "app_type:provider_id"
    api_key_error_counts: Arc<RwLock<HashMap<String, u32>>>,
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
            app_handle,
        }
    }

    /// 选择可用的供应商（支持故障转移）
    ///
    /// 返回按优先级排序的可用供应商列表：
    /// - 故障转移关闭时：仅返回当前供应商
    /// - 故障转移开启时：仅使用故障转移队列，按队列顺序依次尝试（P1 → P2 → ...）
    pub async fn select_providers(&self, app_type: &str) -> Result<Vec<Provider>, AppError> {
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
            let current_id = AppType::from_str(app_type)
                .ok()
                .and_then(|app_enum| {
                    crate::settings::get_effective_current_provider(&self.db, &app_enum)
                        .ok()
                        .flatten()
                })
                .or_else(|| self.db.get_current_provider(app_type).ok().flatten());

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
            if let Ok(Some(app)) = self
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
                let _ = app;
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

#[cfg(test)]
mod tests {
    use super::*;
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
