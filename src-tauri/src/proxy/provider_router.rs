//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{AllowResult, CircuitBreaker, CircuitBreakerConfig};
use crate::proxy::types::AppProxyConfig;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 供应商路由器
pub struct ProviderRouter {
    /// 数据库连接
    db: Arc<Database>,
    /// 熔断器管理器 - key 格式: "app_type:provider_id"
    circuit_breakers: Arc<RwLock<HashMap<String, Arc<CircuitBreaker>>>>,
}

impl ProviderRouter {
    fn is_zero_token_anomaly_error(message: &str) -> bool {
        message.to_ascii_lowercase().contains("zero token usage")
    }

    async fn should_block_current_provider_without_failover(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> bool {
        let config = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config,
            Err(_) => return false,
        };

        if !config.zero_token_anomaly_enabled {
            return false;
        }

        match self.db.get_provider_health(provider_id, app_type).await {
            Ok(health) => {
                !health.is_healthy
                    && health
                        .last_error
                        .as_deref()
                        .map(Self::is_zero_token_anomaly_error)
                        .unwrap_or(false)
            }
            Err(_) => false,
        }
    }

    fn prioritize_stable_public_provider_ids(
        ordered_provider_ids: &[String],
        stable_public_provider_ids: &HashSet<String>,
    ) -> Vec<String> {
        if stable_public_provider_ids.is_empty() {
            return ordered_provider_ids.to_vec();
        }

        let mut prioritized = Vec::with_capacity(ordered_provider_ids.len());
        for provider_id in ordered_provider_ids {
            if stable_public_provider_ids.contains(provider_id) {
                prioritized.push(provider_id.clone());
            }
        }
        for provider_id in ordered_provider_ids {
            if !stable_public_provider_ids.contains(provider_id) {
                prioritized.push(provider_id.clone());
            }
        }
        prioritized
    }

    /// 创建新的供应商路由器
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
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
        let auto_failover_enabled = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config.auto_failover_enabled,
            Err(e) => {
                log::error!("[{app_type}] 读取 proxy_config 失败: {e}，默认禁用故障转移");
                false
            }
        };

        if auto_failover_enabled {
            // 故障转移开启：仅按队列顺序依次尝试（P1 → P2 → ...）
            let all_providers = self.db.get_all_providers(app_type)?;
            let public_provider_priority_enabled = self
                .db
                .get_proxy_config_for_app(app_type)
                .await
                .map(|config| config.public_provider_priority_enabled)
                .unwrap_or(false);

            // 使用 DAO 返回的排序结果，确保和前端展示一致
            let ordered_ids = self.db.filter_provider_ids_for_routing_enablement(
                app_type,
                self.db
                    .get_failover_queue(app_type)?
                    .into_iter()
                    .map(|item| item.provider_id)
                    .collect::<Vec<_>>(),
            )?;

            let ordered_ids = if public_provider_priority_enabled {
                let mut stable_public_provider_ids = HashSet::new();

                for provider_id in ordered_ids.iter() {
                    let Some(provider) = all_providers.get(provider_id) else {
                        continue;
                    };
                    if !provider.is_public {
                        continue;
                    }

                    let circuit_key = format!("{app_type}:{}", provider.id);
                    let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
                    if !breaker.is_available().await {
                        continue;
                    }

                    match self.db.get_provider_health(&provider.id, app_type).await {
                        Ok(health) if health.is_healthy && health.consecutive_failures == 0 => {
                            stable_public_provider_ids.insert(provider.id.clone());
                        }
                        _ => {}
                    }
                }

                Self::prioritize_stable_public_provider_ids(
                    &ordered_ids,
                    &stable_public_provider_ids,
                )
            } else {
                ordered_ids
            };

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
            // 故障转移关闭：仅使用当前供应商，跳过熔断器检查
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
                    if self
                        .should_block_current_provider_without_failover(&current.id, app_type)
                        .await
                    {
                        circuit_open_count = 1;
                        log::warn!(
                            "[{app_type}] 当前供应商 {} 因 0/0 token 异常已被阻断",
                            current.id
                        );
                    } else {
                        result.push(current);
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

    /// 会话路由候选提供商选择
    ///
    /// 与普通故障转移选择不同：
    /// - 自动故障转移开启时，仅使用故障转移队列中已启用的提供商
    /// - 自动故障转移关闭时，使用该应用下全部提供商
    /// - 仍遵循熔断器可用性过滤，保护不可用上游
    pub async fn select_session_routing_providers(
        &self,
        app_type: &str,
    ) -> Result<Vec<Provider>, AppError> {
        let all_providers = self.db.get_all_providers(app_type)?;
        let ordered_provider_ids = self.db.list_provider_ids_for_session_routing(app_type)?;

        if ordered_provider_ids.is_empty() {
            return Err(AppError::NoProvidersConfigured);
        }

        let mut result = Vec::new();
        let mut total_providers = 0usize;
        let mut circuit_open_count = 0usize;

        for provider_id in ordered_provider_ids {
            let Some(provider) = all_providers.get(&provider_id).cloned() else {
                continue;
            };
            total_providers += 1;

            let circuit_key = format!("{app_type}:{}", provider.id);
            let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
            if breaker.is_available().await {
                result.push(provider);
            } else {
                circuit_open_count += 1;
            }
        }

        if result.is_empty() {
            if total_providers > 0 && circuit_open_count == total_providers {
                return Err(AppError::AllProvidersCircuitOpen);
            }
            return Err(AppError::NoProvidersConfigured);
        }

        Ok(result)
    }

    pub async fn select_session_default_providers(
        &self,
        app_type: &str,
        preferred_provider_id: Option<&str>,
        auto_failover_enabled: bool,
        public_provider_priority_enabled: bool,
        explicit_preferred_provider: bool,
    ) -> Result<Vec<Provider>, AppError> {
        let all_providers = self.db.get_all_providers(app_type)?;
        let fallback_provider_ids = if auto_failover_enabled {
            self.db.filter_provider_ids_for_routing_enablement(
                app_type,
                self.db
                    .get_failover_queue(app_type)?
                    .into_iter()
                    .map(|item| item.provider_id)
                    .collect::<Vec<_>>(),
            )?
        } else {
            self.db.list_provider_ids_for_session_routing(app_type)?
        };

        let mut ordered_provider_ids = Vec::new();
        if let Some(provider_id) = preferred_provider_id
            .map(str::trim)
            .filter(|provider_id| !provider_id.is_empty())
        {
            let is_available_for_default = fallback_provider_ids
                .iter()
                .any(|fallback_id| fallback_id == provider_id);
            if is_available_for_default {
                ordered_provider_ids.push(provider_id.to_string());
            }
        }

        if !(explicit_preferred_provider && !auto_failover_enabled) {
            for provider_id in fallback_provider_ids {
                if !ordered_provider_ids.contains(&provider_id) {
                    ordered_provider_ids.push(provider_id);
                }
            }
        } else if ordered_provider_ids.is_empty() {
            ordered_provider_ids = fallback_provider_ids;
        }

        if ordered_provider_ids.is_empty() {
            return Err(AppError::NoProvidersConfigured);
        }

        let mut total_providers = 0usize;
        let mut circuit_open_count = 0usize;
        let mut stable = Vec::new();
        let mut degraded = Vec::new();
        let mut explicit_chain = Vec::new();

        for provider_id in ordered_provider_ids {
            let Some(provider) = all_providers.get(&provider_id).cloned() else {
                continue;
            };
            total_providers += 1;

            let circuit_key = format!("{app_type}:{}", provider.id);
            let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
            if !breaker.is_available().await {
                circuit_open_count += 1;
                continue;
            }

            if explicit_preferred_provider {
                explicit_chain.push(provider);
                continue;
            }

            match self.db.get_provider_health(&provider.id, app_type).await {
                Ok(health) if health.is_healthy && health.consecutive_failures == 0 => {
                    stable.push(provider);
                }
                Ok(health) if health.is_healthy => {
                    degraded.push(provider);
                }
                Ok(_) => {}
                Err(_) => {
                    stable.push(provider);
                }
            }
        }

        let result = if explicit_preferred_provider {
            explicit_chain
        } else if !stable.is_empty() {
            let stable = if public_provider_priority_enabled {
                let stable_public_provider_ids: HashSet<String> = stable
                    .iter()
                    .filter(|provider| provider.is_public)
                    .map(|provider| provider.id.clone())
                    .collect();

                if stable_public_provider_ids.is_empty() {
                    stable
                } else {
                    let mut prioritized = Vec::with_capacity(stable.len());
                    for provider in stable.iter() {
                        if stable_public_provider_ids.contains(&provider.id) {
                            prioritized.push(provider.clone());
                        }
                    }
                    for provider in stable.iter() {
                        if !stable_public_provider_ids.contains(&provider.id) {
                            prioritized.push(provider.clone());
                        }
                    }
                    prioritized
                }
            } else {
                stable
            };

            let mut result = stable;
            result.extend(degraded);
            result
        } else {
            degraded
        };

        if result.is_empty() {
            if total_providers > 0 && circuit_open_count == total_providers {
                return Err(AppError::AllProvidersCircuitOpen);
            }
            return Err(AppError::NoProvidersConfigured);
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
        // 1. 按应用独立获取熔断器配置
        let app_config = self.db.get_proxy_config_for_app(app_type).await.ok();
        let failure_threshold = app_config
            .as_ref()
            .map(|config| config.circuit_failure_threshold)
            .unwrap_or(5);

        // 2. 更新熔断器状态
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;

        if success {
            breaker.record_success(used_half_open_permit).await;
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

        if !success {
            if let Some(app_config) = app_config.as_ref() {
                if app_config.session_routing_enabled {
                    match self.db.get_provider_health(provider_id, app_type).await {
                        Ok(health) if health.consecutive_failures > 0 => {
                            if let Err(error) = self
                                .maybe_reassign_session_routing_bindings(
                                    app_type,
                                    provider_id,
                                    app_config,
                                )
                                .await
                            {
                                log::warn!(
                                    "[{app_type}] session routing reassign failed: provider={}, error={}",
                                    provider_id,
                                    error
                                );
                            }
                        }
                        Ok(_) => {}
                        Err(error) => {
                            log::warn!(
                                "[{app_type}] failed to read provider health after update: provider={}, error={}",
                                provider_id,
                                error
                            );
                        }
                    }
                }
            }
        }

        Ok(())
    }

    pub async fn handle_zero_token_anomaly_threshold_hit(
        &self,
        provider_id: &str,
        app_type: &str,
        error_msg: String,
    ) -> Result<(), AppError> {
        let app_config = self.db.get_proxy_config_for_app(app_type).await?;
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        breaker.force_open().await;

        self.db
            .update_provider_health_with_threshold(provider_id, app_type, false, Some(error_msg), 1)
            .await?;

        if app_config.session_routing_enabled {
            self.maybe_reassign_session_routing_bindings(app_type, provider_id, &app_config)
                .await?;
        }

        Ok(())
    }

    async fn maybe_reassign_session_routing_bindings(
        &self,
        app_type: &str,
        provider_id: &str,
        app_config: &AppProxyConfig,
    ) -> Result<usize, AppError> {
        if !app_config.session_routing_enabled {
            return Ok(0);
        }

        let available = match self.select_session_routing_providers(app_type).await {
            Ok(providers) => providers,
            Err(AppError::NoProvidersConfigured | AppError::AllProvidersCircuitOpen) => {
                return Ok(0)
            }
            Err(error) => return Err(error),
        };

        let public_provider_ids: HashSet<String> = available
            .iter()
            .filter(|provider| provider.is_public)
            .map(|provider| provider.id.clone())
            .collect();

        let mut stable = Vec::new();
        let mut degraded = Vec::new();
        for provider in available {
            match self.db.get_provider_health(&provider.id, app_type).await {
                Ok(health) if health.is_healthy && health.consecutive_failures == 0 => {
                    stable.push(provider.id);
                }
                Ok(health) if health.is_healthy => {
                    degraded.push(provider.id);
                }
                Ok(_) => {}
                Err(error) => {
                    log::warn!(
                        "[{app_type}] failed to read provider health during reassign, keeping provider as candidate: provider={}, error={}",
                        provider.id,
                        error
                    );
                    stable.push(provider.id);
                }
            }
        }

        let mut candidates = if !stable.is_empty() {
            if app_config.public_provider_priority_enabled {
                Self::prioritize_stable_public_provider_ids(&stable, &public_provider_ids)
            } else {
                stable
            }
        } else {
            degraded
        };
        candidates.retain(|id| id != provider_id);
        if candidates.is_empty() {
            return Ok(0);
        }
        let preferred_candidate_provider_ids = if app_config.public_provider_priority_enabled {
            candidates
                .iter()
                .filter(|candidate| public_provider_ids.contains(candidate.as_str()))
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let reassigned = self
            .db
            .reassign_session_provider_bindings_for_provider_with_preferred_pool(
                app_type,
                provider_id,
                &candidates,
                &preferred_candidate_provider_ids,
                app_config.session_routing_strategy.as_str(),
                app_config.session_max_sessions_per_provider,
                app_config.session_allow_shared_when_exhausted,
                app_config.session_idle_ttl_minutes,
            )?;

        if reassigned > 0 {
            log::info!(
                "[{app_type}] session routing reassign completed: provider={}, sessions={}",
                provider_id,
                reassigned
            );
        }

        Ok(reassigned)
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
    async fn test_zero_token_anomaly_blocks_current_provider_even_when_failover_disabled() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a).unwrap();
        db.set_current_provider("claude", "a").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.auto_failover_enabled = false;
        config.zero_token_anomaly_enabled = true;
        config.zero_token_anomaly_threshold = 1;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        router
            .handle_zero_token_anomaly_threshold_hit(
                "a",
                "claude",
                "upstream returned successful response with zero token usage".to_string(),
            )
            .await
            .unwrap();

        let err = router
            .select_providers("claude")
            .await
            .expect_err("provider should be blocked by zero-token anomaly");
        assert!(matches!(err, AppError::AllProvidersCircuitOpen));
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
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router.select_providers("claude").await.unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
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
    async fn test_session_routing_uses_all_providers_even_when_failover_disabled() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.set_current_provider("codex", "a").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_routing_providers("codex")
            .await
            .unwrap();

        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "a");
        assert_eq!(providers[1].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_session_routing_uses_enabled_queue_only_when_failover_enabled() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);
        let mut provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);
        provider_c.sort_index = Some(3);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.save_provider("codex", &provider_c).unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();
        db.add_to_failover_queue("codex", "c").unwrap();

        let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_routing_providers("codex")
            .await
            .unwrap();

        let ids: Vec<String> = providers.into_iter().map(|provider| provider.id).collect();
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[tokio::test]
    #[serial]
    async fn test_session_routing_priority_uses_provider_order_not_failover_queue() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_routing_providers("codex")
            .await
            .unwrap();

        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "a");
        assert_eq!(providers[1].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_session_default_providers_prefers_explicit_default_without_failover() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.set_current_provider("codex", "a").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_default_providers("codex", Some("b"), false, false, true)
            .await
            .unwrap();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_session_default_providers_falls_back_to_current_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.set_current_provider("codex", "a").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_default_providers("codex", Some("a"), false, false, false)
            .await
            .unwrap();

        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "a");
        assert_eq!(providers[1].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn test_session_default_providers_follow_current_skips_degraded_current_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.set_current_provider("codex", "a").unwrap();
        db.update_provider_health_with_threshold("a", "codex", false, Some("soft fail".into()), 3)
            .await
            .unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_default_providers("codex", Some("a"), false, false, false)
            .await
            .unwrap();

        let ids: Vec<String> = providers.into_iter().map(|provider| provider.id).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[tokio::test]
    #[serial]
    async fn test_session_default_providers_prioritize_public_stable_provider_in_follow_current_mode(
    ) {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.is_public = true;

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.set_current_provider("codex", "a").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_default_providers("codex", Some("a"), false, true, false)
            .await
            .unwrap();

        let ids: Vec<String> = providers.into_iter().map(|provider| provider.id).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[tokio::test]
    #[serial]
    async fn test_session_default_providers_uses_failover_queue_as_fallback() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        let provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.save_provider("codex", &provider_c).unwrap();
        db.add_to_failover_queue("codex", "a").unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();
        db.add_to_failover_queue("codex", "c").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_default_providers("codex", Some("a"), true, false, true)
            .await
            .unwrap();

        let ids: Vec<String> = providers.into_iter().map(|provider| provider.id).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[tokio::test]
    #[serial]
    async fn test_session_default_providers_ignore_disabled_preferred_when_failover_enabled() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        let provider_c =
            Provider::with_id("c".to_string(), "Provider C".to_string(), json!({}), None);

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.save_provider("codex", &provider_c).unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();
        db.add_to_failover_queue("codex", "c").unwrap();

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_session_default_providers("codex", Some("a"), true, false, true)
            .await
            .unwrap();

        let ids: Vec<String> = providers.into_iter().map(|provider| provider.id).collect();
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[tokio::test]
    #[serial]
    async fn test_session_routing_reassigns_on_degraded_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.sort_index = Some(1);
        let mut provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        provider_b.sort_index = Some(2);

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();

        let now_ms = chrono::Utc::now().timestamp_millis();
        db.upsert_session_provider_binding("claude", "s1", "a", true, now_ms)
            .expect("seed binding");

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.session_routing_enabled = true;
        config.session_routing_strategy = "priority".to_string();
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());

        router
            .record_result("a", "claude", false, false, Some("fail".to_string()))
            .await
            .unwrap();

        let binding = db
            .get_session_provider_binding("claude", "s1", 30)
            .expect("query binding")
            .expect("binding exists");

        assert_eq!(binding.provider_id, "b");
        assert!(binding.pinned);
        assert_eq!(binding.last_seen_at, now_ms);
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
}
