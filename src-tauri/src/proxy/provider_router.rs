//! 供应商路由器模块
//!
//! 负责选择和管理代理目标供应商，实现智能故障转移

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::circuit_breaker::{
    AllowResult, CircuitBreaker, CircuitBreakerConfig, CircuitState,
};
use crate::proxy::types::{
    AppProxyConfig, SessionRoutingBindingSnapshot, SessionRoutingProviderSnapshot,
    SessionRoutingSnapshot,
};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
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
    session_active_requests: HashMap<ProviderRouteKey, u32>,
    anonymous_active_requests: HashMap<ProviderRouteKey, u32>,
}

impl SessionRoutingState {
    fn cleanup_expired(&mut self, now: Instant, ttl: Duration) {
        self.bindings
            .retain(|_, binding| now.duration_since(binding.last_seen) <= ttl);
        self.session_active_requests.retain(|_, active| *active > 0);
        self.anonymous_active_requests
            .retain(|_, active| *active > 0);
    }

    fn provider_occupancy(&self, app_type: &str, provider_id: &str) -> u32 {
        let (session_count, anonymous_count) = self.provider_occupancy_parts(app_type, provider_id);
        session_count.saturating_add(anonymous_count)
    }

    fn provider_occupancy_parts(&self, app_type: &str, provider_id: &str) -> (u32, u32) {
        let bound_session_count = self
            .bindings
            .iter()
            .filter(|(key, binding)| {
                key.app_type == app_type && binding.provider_id.as_str() == provider_id
            })
            .count() as u32;
        let route_key = ProviderRouteKey {
            app_type: app_type.to_string(),
            provider_id: provider_id.to_string(),
        };
        let session_active_count = self
            .session_active_requests
            .get(&route_key)
            .copied()
            .unwrap_or(0);
        let anonymous_count = self
            .anonymous_active_requests
            .get(&route_key)
            .copied()
            .unwrap_or(0);

        (
            bound_session_count.max(session_active_count),
            anonymous_count,
        )
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

    fn increment_active(
        &mut self,
        app_type: &str,
        provider_id: &str,
        kind: SessionRoutingActiveKind,
    ) -> ProviderRouteKey {
        let key = ProviderRouteKey {
            app_type: app_type.to_string(),
            provider_id: provider_id.to_string(),
        };
        let active_requests = match kind {
            SessionRoutingActiveKind::Session => &mut self.session_active_requests,
            SessionRoutingActiveKind::Anonymous => &mut self.anonymous_active_requests,
        };
        let active = active_requests.entry(key.clone()).or_insert(0);
        *active = active.saturating_add(1);
        key
    }

    fn decrement_active(&mut self, key: &ProviderRouteKey, kind: SessionRoutingActiveKind) {
        let active_requests = match kind {
            SessionRoutingActiveKind::Session => &mut self.session_active_requests,
            SessionRoutingActiveKind::Anonymous => &mut self.anonymous_active_requests,
        };
        if let Some(active) = active_requests.get_mut(key) {
            *active = active.saturating_sub(1);
            if *active == 0 {
                active_requests.remove(key);
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum SessionRoutingActiveKind {
    Session,
    Anonymous,
}

/// 会话路由请求占用 guard。
///
/// 对客户端显式会话，请求期间占用一个会话请求槽，绑定本身由 TTL 保留/释放；
/// 对没有稳定 sessionId 的请求，只在请求生命周期内临时占用一个匿名槽位。
pub(crate) struct SessionRoutingRequestGuard {
    state: Arc<RwLock<SessionRoutingState>>,
    active_key: Option<(ProviderRouteKey, SessionRoutingActiveKind)>,
}

impl Drop for SessionRoutingRequestGuard {
    fn drop(&mut self) {
        let Some((key, kind)) = self.active_key.take() else {
            return;
        };
        let state = self.state.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut state = state.write().await;
                state.decrement_active(&key, kind);
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
            let mut half_open_provider_ids = Vec::new();

            for provider_id in ordered_ids {
                let Some(provider) = all_providers.get(&provider_id).cloned() else {
                    continue;
                };

                let circuit_key = format!("{app_type}:{}", provider.id);
                let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
                let admission_retry_enabled = provider_upstream_admission_retry_enabled(&provider);
                let admission_retry_can_bypass = admission_retry_enabled
                    && !self
                        .is_api_key_auth_circuit_tripped(&provider.id, app_type)
                        .await;
                let available = if admission_retry_can_bypass {
                    true
                } else {
                    breaker.is_available().await
                };

                if available {
                    if !admission_retry_can_bypass
                        && breaker.get_state().await == CircuitState::HalfOpen
                    {
                        half_open_provider_ids.push(provider.id.clone());
                    }
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
                        &half_open_provider_ids,
                    )
                    .await;
            }
        } else {
            // 故障转移关闭：仅使用当前供应商。
            // 普通单供应商接管沿用既有语义，不因通用熔断而停摆；只有已经达到
            // 认证错误阈值时才等待冷却并走 HalfOpen 探测，避免持续请求坏 Key。
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
                    let auth_circuit_tripped = self
                        .is_api_key_auth_circuit_tripped(&current.id, app_type)
                        .await;
                    if auth_circuit_tripped && !breaker.is_available().await {
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

        let active_kind = if should_bind_session {
            state.bind_session(
                app_type,
                session_id,
                &provider.id,
                now,
                project_name,
                project_path,
            );
            SessionRoutingActiveKind::Session
        } else {
            SessionRoutingActiveKind::Anonymous
        };
        let active_key = state.increment_active(app_type, &provider.id, active_kind);

        Some(SessionRoutingRequestGuard {
            state: self.session_routing.clone(),
            active_key: Some((active_key, active_kind)),
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

        if !matches!(app_type, "claude" | "codex" | "grokbuild") {
            return Ok(SessionRoutingSnapshot {
                app_type: app_type.to_string(),
                enabled: false,
                proxy_running: true,
                client_session_only: config.session_routing_client_session_only,
                idle_ttl_seconds: config.session_routing_idle_ttl_seconds,
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
            proxy_running: true,
            client_session_only: config.session_routing_client_session_only,
            idle_ttl_seconds: config.session_routing_idle_ttl_seconds,
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
        if !matches!(app_type, "claude" | "codex" | "grokbuild") {
            return Err(AppError::InvalidInput(
                "会话路由仅支持 Claude、Codex 和 Grok Build".to_string(),
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

    async fn record_result_inner(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<(), AppError> {
        // 1. 按应用独立获取熔断器配置
        let failure_threshold = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(app_config) => app_config.circuit_failure_threshold,
            Err(_) => 5, // 默认值
        };

        // 2. 更新熔断器状态
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        let is_api_key_auth_failure = !success && is_api_key_auth_error(error_msg.as_deref());
        let auth_circuit_was_tripped =
            self.api_key_error_count(&circuit_key).await >= API_KEY_ERROR_DISABLE_THRESHOLD;

        if success {
            breaker.record_success(used_half_open_permit).await;
            if !auth_circuit_was_tripped || breaker.get_state().await == CircuitState::Closed {
                self.reset_api_key_error_count(&circuit_key).await;
            }
        } else {
            breaker.record_failure(used_half_open_permit).await;
            if !is_api_key_auth_failure && !auth_circuit_was_tripped {
                self.reset_api_key_error_count(&circuit_key).await;
            }
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

        if is_api_key_auth_failure {
            let count = self.increment_api_key_error_count(&circuit_key).await;
            if count >= API_KEY_ERROR_DISABLE_THRESHOLD {
                breaker.force_open().await;
                log::warn!(
                    "[{app_type}] Provider {provider_id} 出现 {count} 次 API Key 认证错误，已熔断；保留故障转移队列位置并在冷却后自动探测"
                );
                if count == API_KEY_ERROR_DISABLE_THRESHOLD {
                    self.emit_provider_auth_circuit_opened(app_type, provider_id);
                }
            }
        }

        Ok(())
    }

    /// 同步更新成功请求的内存态，供转发器在返回首包前确定性地释放 HalfOpen
    /// permit 并更新认证错误 streak；数据库健康状态可随后异步持久化。
    pub(crate) async fn record_success_runtime(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
    ) {
        let circuit_key = format!("{app_type}:{provider_id}");
        let breaker = self.get_or_create_circuit_breaker(&circuit_key).await;
        let auth_circuit_was_tripped =
            self.api_key_error_count(&circuit_key).await >= API_KEY_ERROR_DISABLE_THRESHOLD;

        breaker.record_success(used_half_open_permit).await;
        if !auth_circuit_was_tripped || breaker.get_state().await == CircuitState::Closed {
            self.reset_api_key_error_count(&circuit_key).await;
        }
    }

    pub(crate) async fn persist_provider_success(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Result<(), AppError> {
        self.db
            .update_provider_health(provider_id, app_type, true, None)
            .await
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

    /// 入场重试只绕过普通拥挤类熔断；认证错误达到阈值后必须等待冷却探测。
    pub(crate) async fn is_api_key_auth_circuit_tripped(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> bool {
        let circuit_key = format!("{app_type}:{provider_id}");
        self.api_key_error_count(&circuit_key).await >= API_KEY_ERROR_DISABLE_THRESHOLD
    }

    /// 非认证的中性结果只打断尚未达到阈值的认证错误 streak；已经触发的认证
    /// 熔断必须保持锁存，直到 HalfOpen 成功次数满足配置并真正回到 Closed。
    pub(crate) async fn reset_untripped_api_key_auth_streak(
        &self,
        provider_id: &str,
        app_type: &str,
    ) {
        let circuit_key = format!("{app_type}:{provider_id}");
        let mut counts = self.api_key_error_counts.write().await;
        if counts
            .get(&circuit_key)
            .is_some_and(|count| *count < API_KEY_ERROR_DISABLE_THRESHOLD)
        {
            counts.remove(&circuit_key);
        }
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

    /// 批量获取指定应用已创建的熔断器统计。
    ///
    /// 先克隆匹配的熔断器，再释放全局 map 的读锁，避免读取各熔断器状态时长期占用
    /// map 锁而阻塞路由侧创建或清理熔断器。
    pub async fn get_circuit_breaker_stats_for_app(
        &self,
        app_type: &str,
    ) -> HashMap<String, crate::proxy::circuit_breaker::CircuitBreakerStats> {
        let prefix = format!("{app_type}:");
        let matching_breakers: Vec<(String, Arc<CircuitBreaker>)> = {
            let breakers = self.circuit_breakers.read().await;
            breakers
                .iter()
                .filter_map(|(key, breaker)| {
                    key.strip_prefix(&prefix)
                        .map(|provider_id| (provider_id.to_string(), breaker.clone()))
                })
                .collect()
        };

        let mut stats = HashMap::with_capacity(matching_breakers.len());
        for (provider_id, breaker) in matching_breakers {
            stats.insert(provider_id, breaker.get_stats().await);
        }
        stats
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

    fn emit_provider_auth_circuit_opened(&self, app_type: &str, provider_id: &str) {
        let Some(app_handle) = &self.app_handle else {
            return;
        };

        let event_data = serde_json::json!({
            "appType": app_type,
            "providerId": provider_id,
            "source": "apiKeyAuthCircuitBreaker"
        });
        if let Err(e) = app_handle.emit("provider-switched", event_data) {
            log::debug!("发射 API Key 认证熔断事件失败: {e}");
        }
    }

    async fn order_session_routed_providers(
        &self,
        app_type: &str,
        session_id: &str,
        session_client_provided: bool,
        config: &AppProxyConfig,
        providers: Vec<Provider>,
        half_open_provider_ids: &[String],
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
            let bound_provider_id = state.bindings.get_mut(&session_key).map(|binding| {
                binding.last_seen = now;
                binding.provider_id.clone()
            });
            if let Some(bound_provider_id) = bound_provider_id {
                if let Some(bound_provider) = providers
                    .iter()
                    .find(|provider| provider.id.as_str() == bound_provider_id.as_str())
                {
                    if provider_has_capacity(&state, app_type, bound_provider) {
                        if let Some(probe_provider_id) = higher_priority_half_open_provider_id(
                            &state,
                            app_type,
                            &providers,
                            &bound_provider_id,
                            half_open_provider_ids,
                        ) {
                            return move_provider_to_front(providers, &probe_provider_id);
                        }
                        return move_provider_to_front(providers, &bound_provider_id);
                    }
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
            if let Some(probe_provider_id) = higher_priority_half_open_provider_id(
                &state,
                app_type,
                &providers,
                &selected_id,
                half_open_provider_ids,
            ) {
                return move_provider_to_front(providers, &probe_provider_id);
            }
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
    matches!(app_type, "claude" | "codex" | "grokbuild")
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

fn higher_priority_half_open_provider_id(
    state: &SessionRoutingState,
    app_type: &str,
    providers: &[Provider],
    selected_provider_id: &str,
    half_open_provider_ids: &[String],
) -> Option<String> {
    let selected_index = providers
        .iter()
        .position(|provider| provider.id == selected_provider_id)?;

    providers[..selected_index]
        .iter()
        .find(|provider| {
            half_open_provider_ids.contains(&provider.id)
                && provider_has_capacity(state, app_type, provider)
        })
        .map(|provider| provider.id.clone())
}

pub(crate) fn is_api_key_auth_error(error_msg: Option<&str>) -> bool {
    let Some(error_msg) = error_msg else {
        return false;
    };

    let lower = error_msg.to_ascii_lowercase();
    [
        "invalid_api_key",
        "invalid api key",
        "incorrect api key",
        "invalid x-api-key",
        "x-api-key is invalid",
        "api key is disabled",
        "api key is invalid",
        "api key not valid",
        "api key has expired",
        "api key expired",
        "expired api key",
        "api key has been revoked",
        "api key revoked",
        "revoked api key",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
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
    async fn grokbuild_session_routing_supports_capacity_snapshot_and_rebind() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(1));

        db.save_provider("grokbuild", &provider_a).unwrap();
        db.save_provider("grokbuild", &provider_b).unwrap();
        db.add_to_failover_queue("grokbuild", "a").unwrap();
        db.add_to_failover_queue("grokbuild", "b").unwrap();
        enable_failover_with_session_routing(&db, "grokbuild").await;

        let router = ProviderRouter::new(db.clone());
        let first = router
            .select_providers_for_session("grokbuild", "grok-session-1", true)
            .await
            .unwrap();
        let second = router
            .select_providers_for_session("grokbuild", "grok-session-2", true)
            .await
            .unwrap();

        assert_eq!(first[0].id, "a");
        assert_eq!(second[0].id, "b");

        let snapshot = router
            .session_routing_snapshot("grokbuild", HashMap::new())
            .await
            .unwrap();
        assert!(snapshot.enabled);
        assert_eq!(snapshot.bindings.len(), 2);

        let rebound = router
            .rebind_session_route("grokbuild", "grok-session-1", "b")
            .await
            .unwrap();
        assert_eq!(
            rebound
                .bindings
                .iter()
                .find(|binding| binding.session_id == "grok-session-1")
                .map(|binding| binding.provider_id.as_str()),
            Some("b")
        );
    }

    #[tokio::test]
    #[serial]
    async fn session_routing_counts_concurrent_requests_for_same_session_capacity() {
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
        assert_eq!(first[0].id, "a");
        let _first_guard = router
            .acquire_session_route_request("claude", "session-1", true, &first[0], None, None)
            .await
            .expect("first request should acquire a session route slot");

        let second = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        assert_eq!(second[0].id, "a");
        let _second_guard = router
            .acquire_session_route_request("claude", "session-1", true, &second[0], None, None)
            .await
            .expect("second request should acquire a session route slot");

        let third = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();

        assert_eq!(
            third[0].id, "b",
            "same-session in-flight requests must count toward max_concurrent_requests"
        );
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
    async fn session_routing_snapshot_lists_client_codex_session_binding() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider_a = limited_provider("a", "Provider A", 1, Some(1));
        let provider_b = limited_provider("b", "Provider B", 2, Some(1));
        let session_id = "019f21ad-bc7e-70c2-97e2-5f9e0e9fc3a8";

        db.save_provider("codex", &provider_a).unwrap();
        db.save_provider("codex", &provider_b).unwrap();
        db.add_to_failover_queue("codex", "a").unwrap();
        db.add_to_failover_queue("codex", "b").unwrap();
        db.upsert_session_snapshot(
            "codex",
            session_id,
            None,
            Some("Continue current task"),
            Some("D:\\Solution\\cc-switch"),
            Some(1_780_000_000),
        )
        .unwrap();
        enable_failover_with_session_routing(&db, "codex").await;

        let router = ProviderRouter::new(db.clone());
        let providers = router
            .select_providers_for_session("codex", session_id, true)
            .await
            .unwrap();
        assert_eq!(providers[0].id, "a");

        let snapshot = router
            .session_routing_snapshot("codex", HashMap::new())
            .await
            .unwrap();

        assert_eq!(snapshot.bindings.len(), 1);
        let binding = &snapshot.bindings[0];
        assert_eq!(binding.session_id, session_id);
        assert_eq!(binding.provider_id, "a");
        assert_eq!(
            binding.session_title.as_deref(),
            Some("Continue current task")
        );
        assert_eq!(binding.project_name.as_deref(), Some("cc-switch"));
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
    async fn half_open_higher_priority_provider_preempts_sticky_fallback_session() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.session_routing_enabled = true;
        config.session_routing_client_session_only = true;
        config.circuit_failure_threshold = 1;
        config.circuit_success_threshold = 2;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();

        let router = ProviderRouter::new(db.clone());
        router
            .record_result("a", "claude", false, false, Some("unavailable".to_string()))
            .await
            .unwrap();

        let fallback = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        assert_eq!(
            fallback
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );

        let guard = router
            .acquire_session_route_request("claude", "session-1", true, &fallback[0], None, None)
            .await;
        drop(guard);

        config.circuit_timeout_seconds = 0;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();
        router
            .update_app_configs("claude", CircuitBreakerConfig::from(&config))
            .await;

        let recovered = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        assert_eq!(
            recovered
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"],
            "a higher-priority HalfOpen provider must receive a probe before the sticky fallback"
        );

        let permit = router.allow_provider_request("a", "claude").await;
        assert!(permit.allowed);
        assert!(permit.used_half_open_permit);
        router
            .record_result("a", "claude", permit.used_half_open_permit, true, None)
            .await
            .unwrap();
        assert_eq!(
            router
                .get_circuit_breaker_stats("a", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::HalfOpen,
            "the configured success threshold requires a second recovery probe"
        );

        let second_recovery = router
            .select_providers_for_session("claude", "session-1", true)
            .await
            .unwrap();
        assert_eq!(
            second_recovery
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"],
            "the recovering provider must keep preempting the sticky fallback until Closed"
        );

        let second_permit = router.allow_provider_request("a", "claude").await;
        assert!(second_permit.allowed);
        assert!(second_permit.used_half_open_permit);
        router
            .record_result(
                "a",
                "claude",
                second_permit.used_half_open_permit,
                true,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            router
                .get_circuit_breaker_stats("a", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::Closed
        );
    }

    #[tokio::test]
    #[serial]
    async fn full_half_open_provider_does_not_preempt_sticky_fallback_session() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let mut provider_a =
            Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None);
        provider_a.meta = Some(ProviderMeta {
            max_concurrent_requests: Some(1),
            ..Default::default()
        });
        let provider_b =
            Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None);
        db.save_provider("claude", &provider_a).unwrap();
        db.save_provider("claude", &provider_b).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();
        db.add_to_failover_queue("claude", "b").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.session_routing_enabled = true;
        config.session_routing_client_session_only = true;
        config.circuit_failure_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();

        let router = ProviderRouter::new(db.clone());
        router
            .record_result("a", "claude", false, false, Some("unavailable".to_string()))
            .await
            .unwrap();

        let fallback = router
            .select_providers_for_session("claude", "sticky-session", true)
            .await
            .unwrap();
        assert_eq!(fallback[0].id, "b");
        let fallback_guard = router
            .acquire_session_route_request(
                "claude",
                "sticky-session",
                true,
                &fallback[0],
                None,
                None,
            )
            .await;
        drop(fallback_guard);

        config.circuit_timeout_seconds = 0;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();
        router
            .update_app_configs("claude", CircuitBreakerConfig::from(&config))
            .await;

        let probe_candidates = router
            .select_providers_for_session("claude", "probe-session", true)
            .await
            .unwrap();
        assert_eq!(probe_candidates[0].id, "a");
        let permit = router.allow_provider_request("a", "claude").await;
        assert!(permit.allowed);
        assert!(permit.used_half_open_permit);
        let probe_guard = router
            .acquire_session_route_request(
                "claude",
                "probe-session",
                true,
                &probe_candidates[0],
                None,
                None,
            )
            .await;

        let sticky_candidates = router
            .select_providers_for_session("claude", "sticky-session", true)
            .await
            .unwrap();
        assert_eq!(
            sticky_candidates[0].id, "b",
            "a full HalfOpen provider must not steal traffic from a healthy sticky fallback"
        );

        drop(probe_guard);
        router
            .release_permit_neutral("a", "claude", permit.used_half_open_permit)
            .await;
    }

    #[tokio::test]
    #[serial]
    async fn batched_circuit_stats_are_scoped_without_creating_breakers() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let router = ProviderRouter::new(db);

        assert!(
            router
                .allow_provider_request("claude-a", "claude")
                .await
                .allowed
        );
        assert!(
            router
                .allow_provider_request("codex-a", "codex")
                .await
                .allowed
        );

        let claude_stats = router.get_circuit_breaker_stats_for_app("claude").await;
        assert_eq!(claude_stats.len(), 1);
        assert!(claude_stats.contains_key("claude-a"));
        assert!(!claude_stats.contains_key("codex-a"));

        let unknown_stats = router.get_circuit_breaker_stats_for_app("unknown").await;
        assert!(unknown_stats.is_empty());
        assert!(router
            .get_circuit_breaker_stats("missing", "unknown")
            .await
            .is_none());
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
                ..Default::default()
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
    async fn admission_retry_waits_for_auth_circuit_cooldown() {
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
                ..Default::default()
            }),
            ..Default::default()
        });

        db.save_provider("claude", &provider).unwrap();
        db.add_to_failover_queue("claude", "a").unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        config.circuit_failure_threshold = 20;
        config.circuit_success_threshold = 2;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();

        let router = ProviderRouter::new(db.clone());
        for _ in 0..3 {
            router
                .record_result(
                    "a",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .unwrap();
        }

        assert!(router.is_api_key_auth_circuit_tripped("a", "claude").await);
        assert!(matches!(
            router.select_providers("claude").await,
            Err(AppError::AllProvidersCircuitOpen)
        ));

        config.circuit_timeout_seconds = 0;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();
        router
            .update_app_configs("claude", CircuitBreakerConfig::from(&config))
            .await;

        let recovered = router.select_providers("claude").await.unwrap();
        assert_eq!(recovered[0].id, "a");
        let permit = router.allow_provider_request("a", "claude").await;
        assert!(permit.allowed);
        assert!(permit.used_half_open_permit);
        router
            .record_result("a", "claude", permit.used_half_open_permit, true, None)
            .await
            .unwrap();

        assert!(router.is_api_key_auth_circuit_tripped("a", "claude").await);
        assert_eq!(
            router
                .get_circuit_breaker_stats("a", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::HalfOpen,
            "the authentication latch must remain until the configured success threshold closes the circuit"
        );

        let second_permit = router.allow_provider_request("a", "claude").await;
        assert!(second_permit.allowed);
        assert!(second_permit.used_half_open_permit);
        router
            .record_result(
                "a",
                "claude",
                second_permit.used_half_open_permit,
                true,
                None,
            )
            .await
            .unwrap();

        assert!(!router.is_api_key_auth_circuit_tripped("a", "claude").await);
        assert_eq!(
            router
                .get_circuit_breaker_stats("a", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::Closed
        );
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
    async fn api_key_auth_errors_trip_breaker_but_keep_provider_in_failover_queue() {
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
        config.circuit_success_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();

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

        assert!(
            db.is_in_failover_queue("claude", "auth-bad").unwrap(),
            "authentication failures must not silently remove a configured failover provider"
        );
        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-bad", "claude")
                .await
                .unwrap()
                .state,
            crate::proxy::circuit_breaker::CircuitState::Open
        );

        assert!(matches!(
            router.select_providers("claude").await,
            Err(AppError::AllProvidersCircuitOpen)
        ));

        config.circuit_timeout_seconds = 0;
        db.update_proxy_config_for_app(config.clone())
            .await
            .unwrap();
        router
            .update_app_configs("claude", CircuitBreakerConfig::from(&config))
            .await;

        let recovered = router.select_providers("claude").await.unwrap();
        assert_eq!(recovered[0].id, "auth-bad");
        let permit = router.allow_provider_request("auth-bad", "claude").await;
        assert!(permit.allowed);
        assert!(permit.used_half_open_permit);
        router
            .record_result(
                "auth-bad",
                "claude",
                permit.used_half_open_permit,
                true,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-bad", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::Closed
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
    async fn api_key_auth_error_count_resets_after_non_auth_failure() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());

        let provider = Provider::with_id(
            "auth-reset-non-auth".to_string(),
            "Auth Reset Non Auth".to_string(),
            json!({}),
            None,
        );
        db.save_provider("claude", &provider).unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.circuit_failure_threshold = 20;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db);

        for _ in 0..2 {
            router
                .record_result(
                    "auth-reset-non-auth",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .unwrap();
        }

        router
            .record_result(
                "auth-reset-non-auth",
                "claude",
                false,
                false,
                Some("rate limit exceeded".to_string()),
            )
            .await
            .unwrap();

        for _ in 0..2 {
            router
                .record_result(
                    "auth-reset-non-auth",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .unwrap();
        }

        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-reset-non-auth", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::Closed,
            "a different failure between authentication errors must restart the consecutive count"
        );

        router
            .record_result(
                "auth-reset-non-auth",
                "claude",
                false,
                false,
                Some("API Key is disabled".to_string()),
            )
            .await
            .unwrap();

        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-reset-non-auth", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::Open
        );
    }

    #[tokio::test]
    #[serial]
    async fn auth_circuit_half_open_non_auth_failure_keeps_latch() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().unwrap());
        let provider = Provider::with_id(
            "auth-half-open".to_string(),
            "Auth Half Open".to_string(),
            json!({}),
            None,
        );
        db.save_provider("claude", &provider).unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.circuit_failure_threshold = 20;
        config.circuit_timeout_seconds = 0;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = ProviderRouter::new(db);
        for _ in 0..3 {
            router
                .record_result(
                    "auth-half-open",
                    "claude",
                    false,
                    false,
                    Some("invalid_api_key".to_string()),
                )
                .await
                .unwrap();
        }

        let permit = router
            .allow_provider_request("auth-half-open", "claude")
            .await;
        assert!(permit.allowed);
        assert!(permit.used_half_open_permit);
        router
            .record_result(
                "auth-half-open",
                "claude",
                permit.used_half_open_permit,
                false,
                Some("rate limit exceeded".to_string()),
            )
            .await
            .unwrap();

        assert!(
            router
                .is_api_key_auth_circuit_tripped("auth-half-open", "claude")
                .await
        );
        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-half-open", "claude")
                .await
                .unwrap()
                .state,
            CircuitState::Open
        );
    }

    #[tokio::test]
    #[serial]
    async fn api_key_auth_circuit_keeps_failover_queue_and_active_target_when_proxy_is_running() {
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
                .record_result(
                    "a",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .expect("record auth failure");
        }

        assert!(db.is_in_failover_queue("claude", "a").unwrap());
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
            active.provider_id, "a",
            "authentication circuit opening must preserve the configured active target until normal routing fails over"
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
    async fn api_key_auth_circuit_last_failover_provider_keeps_takeover_live() {
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
                .record_result(
                    "solo",
                    "claude",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .expect("record auth failure");
        }

        assert!(db.is_in_failover_queue("claude", "solo").unwrap());

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
                .any(|target| target.app_type == "claude" && target.provider_id == "solo"),
            "authentication circuit opening must not rewrite the configured active target"
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
    async fn api_key_auth_circuit_last_codex_failover_provider_keeps_takeover_live() {
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
                .record_result(
                    "codex-solo",
                    "codex",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .expect("record auth failure");
        }

        assert!(db.is_in_failover_queue("codex", "codex-solo").unwrap());

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
                .any(|target| target.app_type == "codex" && target.provider_id == "codex-solo"),
            "authentication circuit opening must not rewrite the configured active target"
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
    async fn api_key_auth_circuit_last_gemini_failover_provider_keeps_takeover_live() {
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
                .record_result(
                    "gemini-solo",
                    "gemini",
                    false,
                    false,
                    Some("Invalid API Key".to_string()),
                )
                .await
                .expect("record auth failure");
        }

        assert!(db.is_in_failover_queue("gemini", "gemini-solo").unwrap());

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
                .any(|target| target.app_type == "gemini" && target.provider_id == "gemini-solo"),
            "authentication circuit opening must not rewrite the configured active target"
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
    async fn single_provider_mode_keeps_generic_breaker_bypass() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let provider = Provider::with_id(
            "generic-open".to_string(),
            "Generic Open".to_string(),
            json!({}),
            None,
        );
        db.save_provider("codex", &provider).expect("save provider");
        db.set_current_provider("codex", "generic-open")
            .expect("set db current");
        crate::settings::set_current_provider(&AppType::Codex, Some("generic-open"))
            .expect("set local current");

        let mut config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get proxy config");
        config.enabled = true;
        config.auto_failover_enabled = false;
        config.circuit_failure_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config)
            .await
            .expect("save proxy config");

        let router = ProviderRouter::new(db);
        router
            .record_result(
                "generic-open",
                "codex",
                false,
                false,
                Some("connection reset".to_string()),
            )
            .await
            .unwrap();

        assert_eq!(
            router
                .get_circuit_breaker_stats("generic-open", "codex")
                .await
                .unwrap()
                .state,
            CircuitState::Open
        );
        assert!(
            !router
                .is_api_key_auth_circuit_tripped("generic-open", "codex")
                .await
        );
        let selected = router.select_providers("codex").await.unwrap();
        assert_eq!(selected[0].id, "generic-open");
    }

    #[tokio::test]
    #[serial]
    async fn single_provider_auth_circuit_recovers_after_cooldown() {
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
        config.circuit_success_threshold = 1;
        config.circuit_timeout_seconds = 3600;
        config.circuit_min_requests = 100;
        db.update_proxy_config_for_app(config.clone())
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

        config.circuit_timeout_seconds = 0;
        db.update_proxy_config_for_app(config.clone())
            .await
            .expect("enable immediate recovery probe");
        router
            .update_app_configs("codex", CircuitBreakerConfig::from(&config))
            .await;

        let recovered = router
            .select_providers("codex")
            .await
            .expect("cooled authentication circuit should be eligible for a probe");
        assert_eq!(recovered[0].id, "auth-bad");
        let permit = router.allow_provider_request("auth-bad", "codex").await;
        assert!(permit.allowed);
        assert!(permit.used_half_open_permit);
        router
            .record_result(
                "auth-bad",
                "codex",
                permit.used_half_open_permit,
                true,
                None,
            )
            .await
            .expect("successful probe should close the circuit");
        assert_eq!(
            router
                .get_circuit_breaker_stats("auth-bad", "codex")
                .await
                .expect("breaker stats")
                .state,
            CircuitState::Closed
        );
    }

    #[test]
    fn detects_api_key_auth_error_messages_case_insensitively() {
        assert!(is_api_key_auth_error(Some("Invalid API Key")));
        assert!(is_api_key_auth_error(Some(
            r#"{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}"#
        )));
        assert!(is_api_key_auth_error(Some("invalid x-api-key")));
        assert!(is_api_key_auth_error(Some("API key has expired")));
        assert!(is_api_key_auth_error(Some("API key has been revoked")));
        assert!(is_api_key_auth_error(Some(
            r#"{"error":{"message":"api key is disabled"}}"#
        )));
        assert!(!is_api_key_auth_error(Some("unauthorized model access")));
        assert!(!is_api_key_auth_error(Some("permission denied")));
        assert!(!is_api_key_auth_error(Some("rate limit exceeded")));
        assert!(!is_api_key_auth_error(None));
    }
}
