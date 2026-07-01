//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{AllowResult, CircuitBreaker, CircuitBreakerConfig};
use crate::proxy::types::{
    AppProxyConfig, SessionRoutingBindingSnapshot, SessionRoutingProviderSnapshot,
    SessionRoutingSnapshot,
};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

const API_KEY_ERROR_DISABLE_THRESHOLD: u32 = 3;
const DEFAULT_SESSION_ROUTING_IDLE_TTL_SECONDS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionRouteKey {
    app_type: String,
    session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ProviderRouteKey {
    app_type: String,
    provider_id: String,
}

#[derive(Debug, Clone)]
struct SessionRouteBinding {
    provider_id: String,
    last_seen: Instant,
    project_name: Option<String>,
    project_path: Option<String>,
}

#[derive(Debug, Default)]
struct SessionRoutingState {
    bindings: HashMap<SessionRouteKey, SessionRouteBinding>,
    anonymous_active_requests: HashMap<ProviderRouteKey, u32>,
}

impl SessionRoutingState {
    fn cleanup_expired(&mut self, now: Instant, ttl: Duration) {
        self.bindings
            .retain(|_, binding| now.duration_since(binding.last_seen) <= ttl);
        self.anonymous_active_requests
            .retain(|_, active| *active > 0);
    }

    fn provider_occupancy(&self, app_type: &str, provider_id: &str) -> u32 {
        let (session_count, anonymous_count) = self.provider_occupancy_parts(app_type, provider_id);
        session_count.saturating_add(anonymous_count)
    }

    fn provider_occupancy_parts(&self, app_type: &str, provider_id: &str) -> (u32, u32) {
        let session_count = self
            .bindings
            .iter()
            .filter(|(key, binding)| {
                key.app_type == app_type && binding.provider_id.as_str() == provider_id
            })
            .count() as u32;
        let anonymous_count = self
            .anonymous_active_requests
            .get(&ProviderRouteKey {
                app_type: app_type.to_string(),
                provider_id: provider_id.to_string(),
            })
            .copied()
            .unwrap_or(0);

        (session_count, anonymous_count)
    }

    fn bind_session(
        &mut self,
        app_type: &str,
        session_id: &str,
        provider_id: &str,
        now: Instant,
        project_name: Option<String>,
        project_path: Option<String>,
    ) {
        let key = SessionRouteKey {
            app_type: app_type.to_string(),
            session_id: session_id.to_string(),
        };
        let (project_name, project_path) = if let Some(existing) = self.bindings.get(&key) {
            (
                project_name.or_else(|| existing.project_name.clone()),
                project_path.or_else(|| existing.project_path.clone()),
            )
        } else {
            (project_name, project_path)
        };
        self.bindings.insert(
            key,
            SessionRouteBinding {
                provider_id: provider_id.to_string(),
                last_seen: now,
                project_name,
                project_path,
            },
        );
    }

    fn increment_anonymous(&mut self, app_type: &str, provider_id: &str) -> ProviderRouteKey {
        let key = ProviderRouteKey {
            app_type: app_type.to_string(),
            provider_id: provider_id.to_string(),
        };
        let active = self
            .anonymous_active_requests
            .entry(key.clone())
            .or_insert(0);
        *active = active.saturating_add(1);
        key
    }

    fn decrement_anonymous(&mut self, key: &ProviderRouteKey) {
        if let Some(active) = self.anonymous_active_requests.get_mut(key) {
            *active = active.saturating_sub(1);
            if *active == 0 {
                self.anonymous_active_requests.remove(key);
            }
        }
    }
}

/// 会话路由请求占用 guard。
///
/// 对客户端显式会话，请求会刷新会话绑定并由 TTL 释放供应商占用；对没有稳定
/// sessionId 的请求，只在请求生命周期内临时占用一个匿名槽位。
pub(crate) struct SessionRoutingRequestGuard {
    state: Arc<RwLock<SessionRoutingState>>,
    anonymous_key: Option<ProviderRouteKey>,
}

impl Drop for SessionRoutingRequestGuard {
    fn drop(&mut self) {
        let Some(key) = self.anonymous_key.take() else {
            return;
        };
        let state = self.state.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut state = state.write().await;
                state.decrement_anonymous(&key);
            });
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
    /// 会话路由运行态：只保存在内存中，随进程重启释放。
    session_routing: Arc<RwLock<SessionRoutingState>>,
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
            session_routing: Arc::new(RwLock::new(SessionRoutingState::default())),
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
    pub async fn select_providers_for_session(
        &self,
        app_type: &str,
        session_id: &str,
        session_client_provided: bool,
    ) -> Result<Vec<Provider>, AppError> {
        let mut result = Vec::new();
        let mut total_providers = 0usize;
        let mut circuit_open_count = 0usize;

        // 检查该应用的自动故障转移开关是否开启（从 proxy_config 表读取）
        let app_config = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config,
            Err(e) => {
                log::error!("[{app_type}] 读取 proxy_config 失败: {e}，默认禁用故障转移");
                default_app_proxy_config(app_type)
            }
        };
        let app_proxy_enabled = app_config.enabled;
        let auto_failover_enabled = app_config.auto_failover_enabled;

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

                if provider_upstream_admission_retry_enabled(&provider)
                    || breaker.is_available().await
                {
                    result.push(provider);
                } else {
                    circuit_open_count += 1;
                }
            }

            if session_routing_applies(app_type, &app_config) && !result.is_empty() {
                result = self
                    .order_session_routed_providers(
                        app_type,
                        session_id,
                        session_client_provided,
                        &app_config,
                        result,
                    )
                    .await;
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
                    if !provider_upstream_admission_retry_enabled(&current)
                        && self.api_key_error_count(&circuit_key).await
                            >= API_KEY_ERROR_DISABLE_THRESHOLD
                    {
                        circuit_open_count = 1;
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

    /// 在真正向某个供应商发起请求前刷新会话绑定/临时占用。
    pub(crate) async fn acquire_session_route_request(
        &self,
        app_type: &str,
        session_id: &str,
        session_client_provided: bool,
        provider: &Provider,
        project_name: Option<String>,
        project_path: Option<String>,
    ) -> Option<SessionRoutingRequestGuard> {
        let app_config = self.db.get_proxy_config_for_app(app_type).await.ok()?;
        if !session_routing_applies(app_type, &app_config) {
            return None;
        }

        let now = Instant::now();
        let ttl = session_routing_ttl(&app_config);
        let should_bind_session =
            should_bind_session(session_id, session_client_provided, &app_config);
        let mut state = self.session_routing.write().await;
        state.cleanup_expired(now, ttl);

        let anonymous_key = if should_bind_session {
            state.bind_session(
                app_type,
                session_id,
                &provider.id,
                now,
                project_name,
                project_path,
            );
            None
        } else {
            Some(state.increment_anonymous(app_type, &provider.id))
        };

        Some(SessionRoutingRequestGuard {
            state: self.session_routing.clone(),
            anonymous_key,
        })
    }

    /// 获取当前会话路由运行态快照。仅反映内存态，进程重启后为空。
    pub async fn session_routing_snapshot(
        &self,
        app_type: &str,
        activity_session_context: HashMap<String, (Option<String>, Option<String>)>,
    ) -> Result<SessionRoutingSnapshot, AppError> {
        let config = self
            .db
            .get_proxy_config_for_app(app_type)
            .await
            .unwrap_or_else(|_| default_app_proxy_config(app_type));
        let enabled = session_routing_applies(app_type, &config);

        if !matches!(app_type, "claude" | "codex") {
            return Ok(SessionRoutingSnapshot {
                app_type: app_type.to_string(),
                enabled: false,
                bindings: Vec::new(),
                providers: Vec::new(),
            });
        }

        let all_providers = self.db.get_all_providers(app_type)?;
        let queue_items = self.db.get_failover_queue(app_type)?;
        let queue_ids: Vec<String> = queue_items
            .iter()
            .map(|item| item.provider_id.clone())
            .collect();

        let now = Instant::now();
        let ttl = session_routing_ttl(&config);
        let mut state = self.session_routing.write().await;
        state.cleanup_expired(now, ttl);

        let provider_name_by_id: HashMap<String, String> = all_providers
            .iter()
            .map(|(id, provider)| (id.clone(), provider.name.clone()))
            .collect();

        let mut providers: Vec<SessionRoutingProviderSnapshot> = queue_ids
            .iter()
            .filter_map(|provider_id| {
                let provider = all_providers.get(provider_id)?;
                let (session_occupancy, anonymous_occupancy) =
                    state.provider_occupancy_parts(app_type, provider_id);
                Some(SessionRoutingProviderSnapshot {
                    provider_id: provider.id.clone(),
                    provider_name: provider.name.clone(),
                    session_occupancy,
                    anonymous_occupancy,
                    occupancy: session_occupancy.saturating_add(anonymous_occupancy),
                    max_concurrent_requests: provider_max_concurrent_requests(provider),
                    in_failover_queue: true,
                })
            })
            .collect();

        let queued: std::collections::HashSet<&str> =
            queue_ids.iter().map(|id| id.as_str()).collect();
        providers.extend(
            all_providers
                .iter()
                .filter(|(provider_id, _)| !queued.contains(provider_id.as_str()))
                .filter_map(|(provider_id, provider)| {
                    let (session_occupancy, anonymous_occupancy) =
                        state.provider_occupancy_parts(app_type, provider_id);
                    let occupancy = session_occupancy.saturating_add(anonymous_occupancy);
                    (occupancy > 0).then(|| SessionRoutingProviderSnapshot {
                        provider_id: provider.id.clone(),
                        provider_name: provider.name.clone(),
                        session_occupancy,
                        anonymous_occupancy,
                        occupancy,
                        max_concurrent_requests: provider_max_concurrent_requests(provider),
                        in_failover_queue: false,
                    })
                }),
        );

        let mut bindings: Vec<SessionRoutingBindingSnapshot> = state
            .bindings
            .iter()
            .filter(|(key, _)| key.app_type == app_type)
            .map(|(key, binding)| {
                let (activity_name, activity_path) = activity_session_context
                    .get(&key.session_id)
                    .cloned()
                    .unwrap_or((None, None));
                let (db_title, db_project_dir) = self
                    .db
                    .get_session_context_for_log(app_type, &key.session_id)
                    .unwrap_or((None, None));
                let project_path = binding
                    .project_path
                    .clone()
                    .or(activity_path)
                    .or(db_project_dir);
                let project_name = binding
                    .project_name
                    .clone()
                    .or(activity_name)
                    .or_else(|| project_name_from_path(project_path.as_deref()));
                SessionRoutingBindingSnapshot {
                    app_type: key.app_type.clone(),
                    session_id: key.session_id.clone(),
                    provider_id: binding.provider_id.clone(),
                    provider_name: provider_name_by_id
                        .get(&binding.provider_id)
                        .cloned()
                        .unwrap_or_else(|| binding.provider_id.clone()),
                    idle_seconds: now.duration_since(binding.last_seen).as_secs(),
                    session_title: db_title,
                    project_name,
                    project_path,
                }
            })
            .collect();
        bindings.sort_by(|a, b| {
            a.idle_seconds
                .cmp(&b.idle_seconds)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });

        Ok(SessionRoutingSnapshot {
            app_type: app_type.to_string(),
            enabled,
            bindings,
            providers,
        })
    }

    /// 手动把一个会话重新绑定到故障转移队列内的目标供应商。
    pub async fn rebind_session_route(
        &self,
        app_type: &str,
        session_id: &str,
        provider_id: &str,
    ) -> Result<SessionRoutingSnapshot, AppError> {
        if !matches!(app_type, "claude" | "codex") {
            return Err(AppError::InvalidInput(
                "会话路由仅支持 Claude 和 Codex".to_string(),
            ));
        }
        let session_id = session_id.trim();
        let provider_id = provider_id.trim();
        if session_id.is_empty() {
            return Err(AppError::InvalidInput("会话 ID 不能为空".to_string()));
        }
        if provider_id.is_empty() {
            return Err(AppError::InvalidInput("供应商 ID 不能为空".to_string()));
        }

        let config = self.db.get_proxy_config_for_app(app_type).await?;
        if !session_routing_applies(app_type, &config) {
            return Err(AppError::InvalidInput(
                "会话路由未启用或本地路由/故障转移未开启".to_string(),
            ));
        }

        let provider = self
            .db
            .get_provider_by_id(provider_id, app_type)?
            .ok_or_else(|| AppError::InvalidInput(format!("供应商不存在: {provider_id}")))?;
        if !provider.in_failover_queue {
            return Err(AppError::InvalidInput(
                "只能切换到已启用故障转移队列的供应商".to_string(),
            ));
        }

        {
            let now = Instant::now();
            let ttl = session_routing_ttl(&config);
            let mut state = self.session_routing.write().await;
            state.cleanup_expired(now, ttl);
            state.bind_session(app_type, session_id, provider_id, now, None, None);
        }

        self.session_routing_snapshot(app_type, HashMap::new())
            .await
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
                // 被动禁用（认证错误熔断）时保留 provider_health 记录，
                // 让 last_error 仍可在供应商列表展示；仅移出故障转移队列。
                self.db
                    .remove_from_failover_queue_keep_health(app_type, provider_id)?;
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

    async fn api_key_error_count(&self, key: &str) -> u32 {
        let counts = self.api_key_error_counts.read().await;
        counts.get(key).copied().unwrap_or(0)
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

    async fn order_session_routed_providers(
        &self,
        app_type: &str,
        session_id: &str,
        session_client_provided: bool,
        config: &AppProxyConfig,
        providers: Vec<Provider>,
    ) -> Vec<Provider> {
        if providers.len() <= 1 {
            return providers;
        }

        let now = Instant::now();
        let ttl = session_routing_ttl(config);
        let should_bind_session = should_bind_session(session_id, session_client_provided, config);
        let mut state = self.session_routing.write().await;
        state.cleanup_expired(now, ttl);

        if should_bind_session {
            let session_key = SessionRouteKey {
                app_type: app_type.to_string(),
                session_id: session_id.to_string(),
            };
            if let Some(binding) = state.bindings.get_mut(&session_key) {
                if providers
                    .iter()
                    .any(|provider| provider.id == binding.provider_id)
                {
                    binding.last_seen = now;
                    return move_provider_to_front(providers, &binding.provider_id);
                }
            }
        }

        let selected_id = providers
            .iter()
            .find(|provider| provider_has_capacity(&state, app_type, provider))
            .map(|provider| provider.id.clone())
            .or_else(|| {
                config
                    .session_routing_overflow_fallback_enabled
                    .then(|| providers.first().map(|provider| provider.id.clone()))
                    .flatten()
            });

        if let Some(selected_id) = selected_id {
            if should_bind_session {
                state.bind_session(app_type, session_id, &selected_id, now, None, None);
            }
            move_provider_to_front(providers, &selected_id)
        } else {
            providers
        }
    }
}

fn default_app_proxy_config(app_type: &str) -> AppProxyConfig {
    AppProxyConfig {
        app_type: app_type.to_string(),
        enabled: false,
        auto_failover_enabled: false,
        session_routing_enabled: false,
        session_routing_idle_ttl_seconds: DEFAULT_SESSION_ROUTING_IDLE_TTL_SECONDS as u32,
        session_routing_client_session_only: true,
        session_routing_overflow_fallback_enabled: true,
        max_retries: 3,
        streaming_first_byte_timeout: 60,
        streaming_idle_timeout: 120,
        non_streaming_timeout: 600,
        circuit_failure_threshold: 4,
        circuit_success_threshold: 2,
        circuit_timeout_seconds: 60,
        circuit_error_rate_threshold: 0.6,
        circuit_min_requests: 10,
    }
}

fn session_routing_applies(app_type: &str, config: &AppProxyConfig) -> bool {
    matches!(app_type, "claude" | "codex")
        && config.enabled
        && config.auto_failover_enabled
        && config.session_routing_enabled
}

fn session_routing_ttl(config: &AppProxyConfig) -> Duration {
    Duration::from_secs(u64::from(config.session_routing_idle_ttl_seconds).max(1))
}

fn should_bind_session(
    session_id: &str,
    session_client_provided: bool,
    config: &AppProxyConfig,
) -> bool {
    !session_id.is_empty()
        && (!config.session_routing_client_session_only || session_client_provided)
}

fn project_name_from_path(project_path: Option<&str>) -> Option<String> {
    let path = project_path?.trim().trim_matches('"').trim_matches('\'');
    if path.is_empty() {
        return None;
    }
    path.rsplit(['\\', '/'])
        .find(|segment| !segment.trim().is_empty())
        .map(|segment| segment.trim().to_string())
}

fn provider_max_concurrent_requests(provider: &Provider) -> Option<u32> {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.max_concurrent_requests)
        .filter(|limit| *limit > 0)
}

fn provider_has_capacity(state: &SessionRoutingState, app_type: &str, provider: &Provider) -> bool {
    match provider_max_concurrent_requests(provider) {
        Some(limit) => state.provider_occupancy(app_type, &provider.id) < limit,
        None => true,
    }
}

fn move_provider_to_front(mut providers: Vec<Provider>, provider_id: &str) -> Vec<Provider> {
    if let Some(index) = providers
        .iter()
        .position(|provider| provider.id.as_str() == provider_id)
    {
        let selected = providers.remove(index);
        providers.insert(0, selected);
    }
    providers
}

fn is_api_key_auth_error(error_msg: Option<&str>) -> bool {
    let Some(error_msg) = error_msg else {
        return false;
    };

    let lower = error_msg.to_ascii_lowercase();
    lower.contains("invalid api key") || lower.contains("api key is disabled")
}

fn provider_upstream_admission_retry_enabled(provider: &Provider) -> bool {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.upstream_admission_retry.as_ref())
        .is_some_and(|config| config.enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::AppType;
    use crate::codex_config::{get_codex_auth_path, get_codex_config_path};
    use crate::config::{get_claude_settings_path, read_json_file};
    use crate::database::Database;
    use crate::gemini_config::read_gemini_env;
    use crate::provider::{ProviderMeta, UpstreamAdmissionRetryConfig};
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

    fn limited_provider(id: &str, name: &str, sort_index: usize, limit: Option<u32>) -> Provider {
        let mut provider =
            Provider::with_id(id.to_string(), name.to_string(), json!({ "env": {} }), None);
        provider.sort_index = Some(sort_index);
        provider.meta = Some(ProviderMeta {
            max_concurrent_requests: limit,
            ..ProviderMeta::default()
        });
        provider
    }

    async fn enable_failover_with_session_routing(db: &Database, app_type: &str) -> AppProxyConfig {
        let mut config = db.get_proxy_config_for_app(app_type).await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.session_routing_enabled = true;
        config.session_routing_idle_ttl_seconds = 600;
        config.session_routing_client_session_only = true;
        config.session_routing_overflow_fallback_enabled = true;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();
        config
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
    async fn session_routing_keeps_client_session_on_same_provider() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(2));
        let provider_b = limited_provider("b", "Provider B", 2, Some(2));

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();
        enable_failover_with_session_routing(&db, "claude").await;

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn session_routing_uses_next_provider_when_capacity_is_full() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(2));

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.add_to_failover_queue("codex", "a").unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();
        enable_failover_with_session_routing(&db, "codex").await;

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("codex", "codex-session-1", true)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("codex", "codex-session-2", true)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "b");
    }

    #[tokio::test]
    #[serial]
    async fn session_routing_overflows_to_first_available_provider_when_all_limits_are_full() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(1));

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();
        enable_failover_with_session_routing(&db, "claude").await;

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("claude", "session-2", true)
            .await
            .unwrap();
        let overflow = router
            .select_providers_for_session("claude", "session-3", true)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "b");
        assert_eq!(overflow[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn session_routing_disabled_preserves_failover_queue_order() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(1));

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.session_routing_enabled = false;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("claude", "session-2", true)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn session_routing_client_only_does_not_bind_generated_sessions() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(1));

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.add_to_failover_queue("codex", "a").unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();
        enable_failover_with_session_routing(&db, "codex").await;

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("codex", "generated-1", false)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("codex", "generated-2", false)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn session_routing_releases_capacity_after_idle_ttl() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(1));

        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();
        let mut config = enable_failover_with_session_routing(&db, "claude").await;
        config.session_routing_idle_ttl_seconds = 1;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("claude", "session-2", true)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let after_ttl = router
            .select_providers_for_session("claude", "session-3", true)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "b");
        assert_eq!(after_ttl[0].id, "a");
    }

    #[tokio::test]
    #[serial]
    async fn session_routing_does_not_apply_to_gemini_yet() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(1));

        db.save_provider("gemini", &provider_a).unwrap();
        db.save_provider("gemini", &provider_b).unwrap();
        db.add_to_failover_queue("gemini", "a").unwrap();
        db.add_to_failover_queue("gemini", "b").unwrap();
        enable_failover_with_session_routing(&db, "gemini").await;

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("gemini", "session-1", true)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("gemini", "session-2", true)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "a");
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
    async fn admission_retry_provider_is_selected_even_when_circuit_open() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(1),
                initial_delay_ms: Some(0),
                max_delay_ms: Some(0),
                jitter_ms: Some(0),
            }),
            ..Default::default()
        });

        db.save_provider("claude", &provider).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 0;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db.clone());
        router
            .record_result(
                "a",
                "claude",
                false,
                false,
                Some("server is overloaded".to_string()),
            )
            .await
            .unwrap();

        let stats = router
            .get_circuit_breaker_stats("a", "claude")
            .await
            .expect("breaker should exist");
        assert_eq!(
            stats.state,
            crate::proxy::circuit_breaker::CircuitState::Open
        );

        let providers = router.select_providers("claude").await.unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "a");
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
