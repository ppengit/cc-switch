//! 请求转发器
//!
//! 负责将请求转发到上游Provider，支持故障转移

use super::hyper_client::ProxyResponse;
use super::{
    activity::{
        clear_provider, record_admission_retry, route_request_with_metadata, ProxyActivityState,
    },
    body_filter::filter_private_params_with_whitelist,
    content_encoding::{decompress_body, get_content_encoding},
    error::*,
    failover_switch::FailoverSwitchManager,
    json_canonical::{canonicalize_value, short_value_hash},
    log_codes::fwd as log_fwd,
    provider_router::{ProviderRouter, SessionRoutingRequestGuard},
    providers::{
        codex_chat_history::CodexChatHistoryStore, gemini_shadow::GeminiShadowStore, get_adapter,
        AuthInfo, AuthStrategy, ProviderAdapter, ProviderType,
    },
    thinking_budget_rectifier::{rectify_thinking_budget, should_rectify_thinking_budget},
    thinking_rectifier::{
        normalize_thinking_type, rectify_anthropic_request, should_rectify_thinking_signature,
    },
    types::{
        CopilotOptimizerConfig, OptimizerConfig, ProviderAdmissionRetryEvent, ProxyStatus,
        RectifierConfig,
    },
    ProxyError,
};
use crate::commands::{CodexOAuthState, CopilotAuthState};
use crate::proxy::providers::codex_oauth_auth::CodexOAuthManager;
use crate::proxy::providers::copilot_auth::CopilotAuthManager;
use crate::{
    app_config::AppType,
    provider::{LocalProxyRequestOverrides, Provider},
    services::ProviderService,
    store::AppState,
};
use futures::StreamExt;
use http::Extensions;
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;

const PROXY_AUTH_PLACEHOLDER: &str = "PROXY_MANAGED";
type ForwardAttemptOutput = (ProxyResponse, Option<String>, Option<String>);

#[derive(Debug)]
enum AdmissionRetryForwardError {
    /// Normal routing semantics: the admission retry switch was off or was
    /// turned off while retrying, so the caller should resume failover/health
    /// handling exactly as before.
    Normal(ProxyError),
    /// Admission retry handled this provider attempt. The caller should return
    /// the error to the client without failover, degradation, circuit breaking,
    /// or provider disable/error bookkeeping.
    Neutral(ProxyError),
}

impl AdmissionRetryForwardError {
    fn into_inner(self) -> ProxyError {
        match self {
            Self::Normal(error) | Self::Neutral(error) => error,
        }
    }

    fn is_neutral(&self) -> bool {
        matches!(self, Self::Neutral(_))
    }
}

pub struct ForwardResult {
    pub response: ProxyResponse,
    pub provider: Provider,
    pub claude_api_format: Option<String>,
    /// 实际发往上游的模型名（路由接管/模型映射后的真值）。
    ///
    /// usage 归因不能依赖 ctx.request_model（映射前的客户端别名）：上游响应
    /// 缺失 model 或回显别名时，接管流量会被记成 claude-* 并按其定价计费。
    pub outbound_model: Option<String>,
    /// 活跃连接 RAII guard：随响应一起流转到 response_processor / handle_claude_transform，
    /// 最终被 move 进流式 body future（或非流式响应作用域），覆盖整个响应生命周期。
    pub(crate) connection_guard: Option<ActiveConnectionGuard>,
    pub(crate) session_route_guard: Option<SessionRoutingRequestGuard>,
}

pub struct ForwardError {
    pub error: ProxyError,
    pub provider: Option<Provider>,
}

/// 活跃连接 RAII guard
///
/// 构造时把 `ProxyStatus.active_connections` +1；Drop 时在 tokio runtime 上调度
/// 一个异步任务执行 -1，从而支持把 guard move 进流式 body future（stream 自然结束
/// 时 guard 与 future 一起 drop）。
///
/// 设计动机：之前在 `forward_with_retry` 出口处同步 -1，但流式响应的 body 实际
/// 在 `create_logged_passthrough_stream` 内还会继续 yield 字节流，导致 UI 的
/// `active_connections` 计数过早归零。RAII guard 让"减量"由 Rust 类型系统驱动，
/// 不需要每条出口路径都手动调用。
pub(crate) struct ActiveConnectionGuard {
    status: Arc<RwLock<ProxyStatus>>,
    session_route_guard: Option<SessionRoutingRequestGuard>,
}

impl ActiveConnectionGuard {
    pub(crate) async fn acquire(status: Arc<RwLock<ProxyStatus>>) -> Self {
        {
            let mut s = status.write().await;
            s.active_connections = s.active_connections.saturating_add(1);
        }
        Self {
            status,
            session_route_guard: None,
        }
    }

    pub(crate) fn attach_session_route_guard(&mut self, guard: SessionRoutingRequestGuard) {
        self.session_route_guard = Some(guard);
    }
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        // Drop 不能 await：把减量操作调度到 tokio runtime
        let status = self.status.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut s = status.write().await;
                s.active_connections = s.active_connections.saturating_sub(1);
            });
        }
        // 没有 runtime 时静默丢失计数（仅 UI 展示用，可接受最终一致性）
    }
}

pub struct RequestForwarder {
    /// 共享的 ProviderRouter（持有熔断器状态）
    router: Arc<ProviderRouter>,
    status: Arc<RwLock<ProxyStatus>>,
    current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
    proxy_activity: Arc<RwLock<ProxyActivityState>>,
    gemini_shadow: Arc<GeminiShadowStore>,
    codex_chat_history: Arc<CodexChatHistoryStore>,
    /// 故障转移切换管理器
    failover_manager: Arc<FailoverSwitchManager>,
    /// AppHandle，用于发射事件和更新托盘
    app_handle: Option<tauri::AppHandle>,
    /// 请求开始时的"当前供应商 ID"（用于判断是否需要同步 UI/托盘）
    current_provider_id_at_start: String,
    /// 代理内部请求 ID（用于实时活动跟踪）
    request_id: String,
    /// 请求中的模型名称
    request_model: String,
    /// 代理会话 ID（用于 Gemini Native shadow replay）
    session_id: String,
    /// Session ID 是否由客户端提供；生成值不能作为上游缓存身份。
    session_client_provided: bool,
    /// 整流器配置
    rectifier_config: RectifierConfig,
    /// 优化器配置
    optimizer_config: OptimizerConfig,
    /// Copilot 优化器配置
    copilot_optimizer_config: CopilotOptimizerConfig,
    /// 非流式请求超时（秒）
    non_streaming_timeout: std::time::Duration,
    /// 流式请求响应头等待超时（秒）
    streaming_first_byte_timeout: std::time::Duration,
    /// 单个客户端请求最多尝试的 provider 数。
    max_attempts: usize,
    /// per-app 切换代次共享 map（用于回写状态前的 epoch 比较）
    switch_epoch: Arc<RwLock<std::collections::HashMap<String, u64>>>,
    /// 本请求开始时 snapshot 的 epoch
    request_epoch: u64,
    /// 本请求开始时该应用的"是否启用故障转移"快照。
    /// 故障转移开启时本请求成功完成后绝不写 is_current（不再有"当前"概念）。
    auto_failover_enabled_at_start: bool,
}

impl RequestForwarder {
    /// 预防式 media 降级：发送前对 text-only 模型把图片块替换为标记。
    ///
    /// 受 `enabled && request_media_fallback` 管辖；其中"启发式模型名单预测"
    /// 再受 `request_media_heuristic` 单独管辖（显式声明 text-only 始终生效）。
    /// 返回被替换的图片块数量（0 = 未触发或开关关闭）。
    fn apply_media_prevention(&self, body: &mut Value, provider: &Provider) -> usize {
        if !(self.rectifier_config.enabled && self.rectifier_config.request_media_fallback) {
            return 0;
        }
        let replaced_images = super::media_sanitizer::replace_images_for_text_only_model(
            body,
            provider,
            self.rectifier_config.request_media_heuristic,
        );
        if replaced_images > 0 {
            let model = body.get("model").and_then(Value::as_str).unwrap_or("");
            log::info!(
                "[Media] Replaced {replaced_images} image block(s) with {} for text-only provider={}, model={}",
                super::media_sanitizer::UNSUPPORTED_IMAGE_MARKER,
                provider.id,
                model
            );
        }
        replaced_images
    }

    /// 反应式 media 重试判定：上游因图片输入报错后，是否应替换图片块并对同一供应商重试一次。
    ///
    /// 受 `enabled && request_media_fallback` 管辖；不涉及 `request_media_heuristic`——
    /// 这里是上游"实测"错误后的纯恢复，不是预测，故启发式开关与它无关。
    fn media_retry_should_trigger(
        &self,
        adapter_name: &str,
        already_retried: bool,
        provider_body: &Value,
        error: &ProxyError,
    ) -> bool {
        matches!(adapter_name, "Claude" | "Codex")
            && self.rectifier_config.enabled
            && self.rectifier_config.request_media_fallback
            && !already_retried
            && super::media_sanitizer::contains_image_blocks(provider_body)
            && super::media_sanitizer::is_unsupported_image_error(error)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        router: Arc<ProviderRouter>,
        non_streaming_timeout: u64,
        status: Arc<RwLock<ProxyStatus>>,
        current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
        proxy_activity: Arc<RwLock<ProxyActivityState>>,
        gemini_shadow: Arc<GeminiShadowStore>,
        codex_chat_history: Arc<CodexChatHistoryStore>,
        failover_manager: Arc<FailoverSwitchManager>,
        app_handle: Option<tauri::AppHandle>,
        current_provider_id_at_start: String,
        request_id: String,
        request_model: String,
        session_id: String,
        session_client_provided: bool,
        streaming_first_byte_timeout: u64,
        rectifier_config: RectifierConfig,
        optimizer_config: OptimizerConfig,
        copilot_optimizer_config: CopilotOptimizerConfig,
        switch_epoch: Arc<RwLock<std::collections::HashMap<String, u64>>>,
        request_epoch: u64,
        auto_failover_enabled_at_start: bool,
        max_retries: u32,
    ) -> Self {
        // max_retries 是「失败后重试次数」语义，attempt 上限 = retries + 1。
        // saturating_add 防止 u32::MAX + 1 溢出。
        let max_attempts = (max_retries as usize).saturating_add(1);
        Self {
            router,
            status,
            current_providers,
            proxy_activity,
            gemini_shadow,
            codex_chat_history,
            failover_manager,
            app_handle,
            current_provider_id_at_start,
            request_id,
            request_model,
            session_id,
            session_client_provided,
            rectifier_config,
            optimizer_config,
            copilot_optimizer_config,
            non_streaming_timeout: std::time::Duration::from_secs(non_streaming_timeout),
            streaming_first_byte_timeout: std::time::Duration::from_secs(
                streaming_first_byte_timeout,
            ),
            max_attempts,
            switch_epoch,
            request_epoch,
            auto_failover_enabled_at_start,
        }
    }

    /// 检查请求开始时 snapshot 的 epoch 是否仍是最新值。
    ///
    /// 任何会改变路由目标的操作（hot-switch、启停故障转移、从队列移除等）
    /// 都会 bump 该应用的 epoch。请求成功完成后写共享状态前必须先调用此函数：
    /// 返回 false 表示在请求执行期间发生过切换，**当前请求不能再回写**
    /// `current_providers` / `is_current` / 托盘状态，否则会把 UI/状态倒退回旧供应商。
    async fn epoch_is_current(&self, app_type_str: &str) -> bool {
        let epochs = self.switch_epoch.read().await;
        epochs.get(app_type_str).copied().unwrap_or(0) == self.request_epoch
    }

    async fn record_success_result(
        &self,
        provider_id: &str,
        app_type: &str,
        used_half_open_permit: bool,
    ) {
        if used_half_open_permit {
            if let Err(e) = self
                .router
                .record_result(provider_id, app_type, true, true, None)
                .await
            {
                log::warn!(
                    "[{app_type}] 记录 Provider 成功结果失败: provider_id={provider_id}, error={e}"
                );
            }
            return;
        }

        let router = self.router.clone();
        let provider_id = provider_id.to_string();
        let app_type = app_type.to_string();
        tokio::spawn(async move {
            if let Err(e) = router
                .record_result(&provider_id, &app_type, false, true, None)
                .await
            {
                log::warn!(
                    "[{app_type}] 异步记录 Provider 成功结果失败: provider_id={provider_id}, error={e}"
                );
            }
        });
    }

    async fn admission_retry_neutral_failure(
        &self,
        provider: &Provider,
        app_type_str: &str,
        used_half_open_permit: bool,
        error: ProxyError,
    ) -> ForwardError {
        self.router
            .release_permit_neutral(&provider.id, app_type_str, used_half_open_permit)
            .await;
        log::warn!(
            "[{}] 上游入场重试中性结束，不触发故障转移/降级/熔断: provider={}, error={}",
            app_type_str,
            provider.name,
            summarize_proxy_error(&error)
        );
        ForwardError {
            error,
            provider: Some(provider.clone()),
        }
    }

    /// 整流（thinking signature 或 budget）重试失败后的统一收尾。
    ///
    /// `None` 表示已记录熔断器、累积 `last_error`/`last_provider`，
    /// 调用方应 `continue` 让下一家 provider 继续故障转移；
    /// `Some(ForwardError)` 表示是客户端错误，没有 provider 能修复，
    /// 调用方应直接 `return` 把错误返回给客户端。
    #[allow(clippy::too_many_arguments)]
    async fn handle_rectifier_retry_failure(
        &self,
        retry_err: ProxyError,
        provider: &Provider,
        app_type_str: &str,
        used_half_open_permit: bool,
        rectifier_label: &str,
        last_error: &mut Option<ProxyError>,
        last_provider: &mut Option<Provider>,
    ) -> Option<ForwardError> {
        // Provider 错误：本家上游/网络确实出问题，下一家 provider 可能可用 → 继续故障转移。
        // 客户端错误：整流后请求仍违法，下一家也修不好 → 直接返回。
        let is_provider_error = match &retry_err {
            ProxyError::Timeout(_) | ProxyError::ForwardFailed(_) => true,
            ProxyError::UpstreamError { status, .. } => *status >= 500,
            _ => false,
        };

        if is_provider_error {
            let _ = self
                .router
                .record_result(
                    &provider.id,
                    app_type_str,
                    used_half_open_permit,
                    false,
                    Some(retry_err.to_string()),
                )
                .await;
            {
                let mut status = self.status.write().await;
                status.last_error = Some(format!(
                    "Provider {} {rectifier_label}重试失败: {}",
                    provider.name, retry_err
                ));
            }
            *last_error = Some(retry_err);
            *last_provider = Some(provider.clone());
            return None;
        }

        self.router
            .release_permit_neutral(&provider.id, app_type_str, used_half_open_permit)
            .await;
        let mut status = self.status.write().await;
        status.failed_requests += 1;
        status.last_error = Some(retry_err.to_string());
        if status.total_requests > 0 {
            status.success_rate =
                (status.success_requests as f32 / status.total_requests as f32) * 100.0;
        }
        Some(ForwardError {
            error: retry_err,
            provider: Some(provider.clone()),
        })
    }

    /// 转发请求（带故障转移）
    ///
    /// 这是 thin wrapper：在客户端请求维度记一次 `total_requests` / 调整
    /// `active_connections` / 刷新 `last_request_at`，无论 inner 走哪条出口路径，
    /// 出口处都会把 `active_connections` 回收。Per-attempt 维度（成功/失败/熔断
    /// 等）仍由 inner 内自行更新 `success_requests` / `failed_requests`。
    #[allow(clippy::too_many_arguments)]
    pub async fn forward_with_retry(
        &self,
        app_type: &AppType,
        method: http::Method,
        endpoint: &str,
        body: Value,
        headers: axum::http::HeaderMap,
        extensions: Extensions,
        providers: Vec<Provider>,
    ) -> Result<ForwardResult, ForwardError> {
        let mut guard = ActiveConnectionGuard::acquire(self.status.clone()).await;
        {
            let mut s = self.status.write().await;
            s.total_requests = s.total_requests.saturating_add(1);
            s.last_request_at = Some(chrono::Utc::now().to_rfc3339());
        }
        let result = self
            .forward_with_retry_inner(
                app_type, method, endpoint, body, headers, extensions, providers,
            )
            .await;
        // 把 guard 注入到 Ok 结果，让它随响应一起流转到 response_processor，
        // 在流式 body 的 future 内才真正 drop。
        // Err 路径：guard 在函数 scope 内随返回值落地时自动 drop。
        result.map(|mut fr| {
            if let Some(session_route_guard) = fr.session_route_guard.take() {
                guard.attach_session_route_guard(session_route_guard);
            }
            fr.connection_guard = Some(guard);
            fr
        })
    }

    /// 实际转发逻辑（不包含客户端维度的入口/出口计数）
    ///
    /// # Arguments
    /// * `app_type` - 应用类型
    /// * `method` - 客户端请求的 HTTP 方法（透传给上游，支持 GET/POST 等）
    /// * `endpoint` - API 端点
    /// * `body` - 请求体
    /// * `headers` - 请求头
    /// * `providers` - 已选择的 Provider 列表（由 RequestContext 提供，避免重复调用 select_providers）
    #[allow(clippy::too_many_arguments)]
    async fn forward_with_retry_inner(
        &self,
        app_type: &AppType,
        method: http::Method,
        endpoint: &str,
        body: Value,
        headers: axum::http::HeaderMap,
        extensions: Extensions,
        providers: Vec<Provider>,
    ) -> Result<ForwardResult, ForwardError> {
        // 获取适配器
        let adapter = get_adapter(app_type);
        let app_type_str = app_type.as_str();

        if providers.is_empty() {
            return Err(ForwardError {
                error: ProxyError::NoAvailableProvider,
                provider: None,
            });
        }

        let mut last_error = None;
        let mut last_provider = None;
        let mut attempted_providers = 0usize;

        let provider_count = providers.len();
        let mut providers = providers.into_iter();

        // 非故障转移的单 Provider 场景下跳过熔断器检查，避免普通接管模式被熔断器彻底阻塞。
        // 故障转移开启时，即使队列只有 1 个 Provider，也默认尊重 HalfOpen 探测名额。
        let bypass_circuit_breaker_for_single_takeover =
            provider_count == 1 && !self.auto_failover_enabled_at_start;

        // 依次尝试每个供应商
        loop {
            let Some(provider) = providers.next() else {
                break;
            };

            // 整流器重试标记：每个 provider 独立持有，避免标记跨 provider 短路故障转移
            // —— 首家 provider 整流后被 5xx/timeout 击落时，下家仍能用整流后的请求体走整流流程
            let mut rectifier_retried = false;
            let mut budget_rectifier_retried = false;
            let mut media_rectifier_retried = false;

            // 上限检查：尊重用户在 AppProxyConfig.max_retries 上配置的「重试次数」。
            // 放在熔断器 allow 检查之前，避免在已经超限时还占用 HalfOpen 探测名额。
            let max_attempts_allowed = self.max_attempts;
            if attempted_providers >= max_attempts_allowed {
                log::warn!(
                    "[{app_type_str}] 已达最大尝试次数上限 ({}/{}), 停止故障转移",
                    attempted_providers,
                    max_attempts_allowed
                );
                break;
            }

            // 发起请求前先获取熔断器放行许可（HalfOpen 会占用探测名额）。
            // 入场重试是用户显式临时开启的“挤入上游”模式：开启后不应被既有熔断
            // 拦截，也不应占用 HalfOpen 探测名额；拥挤类失败会在同一 provider
            // 内部持续重试，直到成功、关闭开关或遇到非入场类错误。
            let admission_retry_enabled_at_attempt = self
                .current_admission_retry_policy(app_type, &provider)
                .is_some();
            let bypass_circuit_breaker =
                bypass_circuit_breaker_for_single_takeover || admission_retry_enabled_at_attempt;
            let (allowed, used_half_open_permit) = if bypass_circuit_breaker {
                (true, false)
            } else {
                let permit = self
                    .router
                    .allow_provider_request(&provider.id, app_type_str)
                    .await;
                (permit.allowed, permit.used_half_open_permit)
            };

            if !allowed {
                continue;
            }

            let session_activity_path = activity_project_path(&headers, &body);
            let session_activity_name = activity_project_name(session_activity_path.as_deref())
                .or_else(|| activity_project_name_from_request(&headers, &body));

            let session_route_guard = self
                .router
                .acquire_session_route_request(
                    app_type_str,
                    &self.session_id,
                    self.session_client_provided,
                    &provider,
                    session_activity_name,
                    session_activity_path,
                )
                .await;

            // PRE-SEND 优化器：每个 provider 独立决定是否优化
            // clone body 以避免 Bedrock 优化字段泄漏到非 Bedrock provider（failover 场景）
            let mut provider_body =
                if self.optimizer_config.enabled && is_bedrock_provider(&provider) {
                    let mut b = body.clone();
                    if self.optimizer_config.thinking_optimizer {
                        super::thinking_optimizer::optimize(&mut b, &self.optimizer_config);
                    }
                    if self.optimizer_config.cache_injection {
                        super::cache_injector::inject(&mut b, &self.optimizer_config);
                    }
                    b
                } else {
                    body.clone()
                };

            // 应用 per-provider quirks：force_model / request_body_patches /
            // strip_paths(body:) / strip_request_headers。
            //
            // headers 同样需要 clone 一份，避免修改影响后续 provider 的 fallback。
            let mut provider_headers = headers.clone();
            if let Some(quirks) = provider.meta.as_ref().and_then(|meta| meta.quirks.as_ref()) {
                crate::quirks::apply_request_quirks(
                    &mut provider_body,
                    &mut provider_headers,
                    quirks,
                );
            }

            attempted_providers += 1;

            // 更新状态中的当前 Provider 信息（per-attempt 维度的标识）
            //
            // total_requests / last_request_at / active_connections 已由
            // forward_with_retry wrapper 在客户端请求维度统一处理，这里只刷
            // 新「正在尝试哪个 provider」的展示字段。
            {
                let mut status = self.status.write().await;
                status.current_provider = Some(provider.name.clone());
                status.current_provider_id = Some(provider.id.clone());
            }

            // 转发请求。供应商级入场重试会在临时可恢复错误上持续重试同一
            // provider；关闭开关后立即回到原有 failover 流程。
            match self
                .forward_with_admission_retry(
                    app_type,
                    &method,
                    &provider,
                    endpoint,
                    &provider_body,
                    &provider_headers,
                    &extensions,
                    adapter.as_ref(),
                )
                .await
            {
                Ok((response, claude_api_format, outbound_model)) => {
                    // 成功：普通闭合熔断状态异步记录，避免阻塞流式首包返回；
                    // HalfOpen 探测仍同步等待，保证 permit 与熔断状态及时释放。
                    self.record_success_result(&provider.id, app_type_str, used_half_open_permit)
                        .await;

                    // 比较请求开始时的 epoch；若已过期，说明执行期间发生过切换/启停，
                    // 本次成功结果不应再回写共享状态（current_providers / status / 托盘）。
                    let epoch_fresh = self.epoch_is_current(app_type_str).await;

                    // 更新当前应用类型使用的 provider
                    if epoch_fresh {
                        let mut current_providers = self.current_providers.write().await;
                        current_providers.insert(
                            app_type_str.to_string(),
                            (provider.id.clone(), provider.name.clone()),
                        );
                    }

                    // 更新成功统计
                    {
                        let mut status = self.status.write().await;
                        status.success_requests += 1;
                        status.last_error = None;
                        let should_switch = epoch_fresh
                            && !self.auto_failover_enabled_at_start
                            && self.current_provider_id_at_start.as_str() != provider.id.as_str();
                        if should_switch {
                            status.failover_count += 1;

                            // 异步触发供应商切换，更新 UI/托盘，并把"当前供应商"同步为实际使用的 provider
                            let fm = self.failover_manager.clone();
                            let ah = self.app_handle.clone();
                            let pid = provider.id.clone();
                            let pname = provider.name.clone();
                            let at = app_type_str.to_string();

                            tokio::spawn(async move {
                                let _ = fm.try_switch(ah.as_ref(), &at, &pid, &pname).await;
                            });
                        }
                        // 重新计算成功率
                        if status.total_requests > 0 {
                            status.success_rate = (status.success_requests as f32
                                / status.total_requests as f32)
                                * 100.0;
                        }
                    }

                    return Ok(ForwardResult {
                        response,
                        provider: provider.clone(),
                        claude_api_format,
                        outbound_model,
                        connection_guard: None,
                        session_route_guard,
                    });
                }
                Err(admission_error) => {
                    let admission_retry_neutral = admission_error.is_neutral();
                    let e = admission_error.into_inner();
                    if admission_retry_neutral {
                        return Err(self
                            .admission_retry_neutral_failure(
                                &provider,
                                app_type_str,
                                used_half_open_permit,
                                e,
                            )
                            .await);
                    }

                    // 检测是否需要触发整流器（仅 Claude/ClaudeAuth 供应商）
                    let provider_type = ProviderType::from_app_type_and_config(app_type, &provider);
                    let is_anthropic_provider = matches!(
                        provider_type,
                        ProviderType::Claude | ProviderType::ClaudeAuth
                    );
                    let mut signature_rectifier_non_retryable_client_error = false;

                    if self.media_retry_should_trigger(
                        adapter.name(),
                        media_rectifier_retried,
                        &provider_body,
                        &e,
                    ) {
                        let mut media_body = provider_body.clone();
                        let replaced_images =
                            super::media_sanitizer::replace_image_blocks_with_marker(
                                &mut media_body,
                            );

                        if replaced_images > 0 {
                            let _ = std::mem::replace(&mut media_rectifier_retried, true);
                            let model = media_body
                                .get("model")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            log::info!(
                                "[{app_type_str}] [Media] Upstream rejected image input; retrying provider={} model={} with {replaced_images} image block(s) replaced by {}",
                                provider.id,
                                model,
                                super::media_sanitizer::UNSUPPORTED_IMAGE_MARKER
                            );

                            match self
                                .forward_with_admission_retry(
                                    app_type,
                                    &method,
                                    &provider,
                                    endpoint,
                                    &media_body,
                                    &headers,
                                    &extensions,
                                    adapter.as_ref(),
                                )
                                .await
                            {
                                Ok((response, claude_api_format, outbound_model)) => {
                                    log::info!(
                                        "[{app_type_str}] [Media] Unsupported-image retry succeeded"
                                    );
                                    self.record_success_result(
                                        &provider.id,
                                        app_type_str,
                                        used_half_open_permit,
                                    )
                                    .await;

                                    {
                                        let mut current_providers =
                                            self.current_providers.write().await;
                                        current_providers.insert(
                                            app_type_str.to_string(),
                                            (provider.id.clone(), provider.name.clone()),
                                        );
                                    }

                                    {
                                        let mut status = self.status.write().await;
                                        status.success_requests += 1;
                                        status.last_error = None;
                                        let should_switch =
                                            self.current_provider_id_at_start.as_str()
                                                != provider.id.as_str();
                                        if should_switch {
                                            status.failover_count += 1;
                                            let fm = self.failover_manager.clone();
                                            let ah = self.app_handle.clone();
                                            let pid = provider.id.clone();
                                            let pname = provider.name.clone();
                                            let at = app_type_str.to_string();

                                            tokio::spawn(async move {
                                                let _ = fm
                                                    .try_switch(ah.as_ref(), &at, &pid, &pname)
                                                    .await;
                                            });
                                        }
                                        if status.total_requests > 0 {
                                            status.success_rate = (status.success_requests as f32
                                                / status.total_requests as f32)
                                                * 100.0;
                                        }
                                    }

                                    return Ok(ForwardResult {
                                        response,
                                        provider: provider.clone(),
                                        claude_api_format,
                                        outbound_model,
                                        connection_guard: None,
                                        session_route_guard,
                                    });
                                }
                                Err(retry_error) => {
                                    let admission_retry_neutral = retry_error.is_neutral();
                                    let retry_err = retry_error.into_inner();
                                    log::warn!(
                                        "[{app_type_str}] [Media] Unsupported-image retry still failed: {retry_err}"
                                    );
                                    if admission_retry_neutral {
                                        return Err(self
                                            .admission_retry_neutral_failure(
                                                &provider,
                                                app_type_str,
                                                used_half_open_permit,
                                                retry_err,
                                            )
                                            .await);
                                    }
                                    if let Some(err) = self
                                        .handle_rectifier_retry_failure(
                                            retry_err,
                                            &provider,
                                            app_type_str,
                                            used_half_open_permit,
                                            "media 降级",
                                            &mut last_error,
                                            &mut last_provider,
                                        )
                                        .await
                                    {
                                        return Err(err);
                                    }
                                    continue;
                                }
                            }
                        }
                    }

                    if is_anthropic_provider {
                        let error_message = extract_error_message(&e);
                        if should_rectify_thinking_signature(
                            error_message.as_deref(),
                            &self.rectifier_config,
                        ) {
                            // 已经重试过：直接返回错误（不可重试客户端错误）
                            if rectifier_retried {
                                log::warn!("[{app_type_str}] [RECT-005] 整流器已触发过，不再重试");
                                // 释放 HalfOpen permit（不记录熔断器，这是客户端兼容性问题）
                                self.router
                                    .release_permit_neutral(
                                        &provider.id,
                                        app_type_str,
                                        used_half_open_permit,
                                    )
                                    .await;
                                let mut status = self.status.write().await;
                                status.failed_requests += 1;
                                status.last_error = Some(e.to_string());
                                if status.total_requests > 0 {
                                    status.success_rate = (status.success_requests as f32
                                        / status.total_requests as f32)
                                        * 100.0;
                                }
                                return Err(ForwardError {
                                    error: e,
                                    provider: Some(provider.clone()),
                                });
                            }

                            // 首次触发：整流请求体
                            let rectified = rectify_anthropic_request(&mut provider_body);

                            // 整流未生效：继续尝试 budget 整流路径，避免误判后短路
                            if !rectified.applied {
                                log::warn!(
                                    "[{app_type_str}] [RECT-006] thinking 签名整流器触发但无可整流内容，继续检查 budget；若 budget 也未命中则按客户端错误返回"
                                );
                                signature_rectifier_non_retryable_client_error = true;
                            } else {
                                log::info!(
                                    "[{}] [RECT-001] thinking 签名整流器触发, 移除 {} thinking blocks, {} redacted_thinking blocks, {} signature fields",
                                    app_type_str,
                                    rectified.removed_thinking_blocks,
                                    rectified.removed_redacted_thinking_blocks,
                                    rectified.removed_signature_fields
                                );

                                // 标记已重试（当前逻辑下重试后必定 return，保留标记以备将来扩展）
                                let _ = std::mem::replace(&mut rectifier_retried, true);

                                // 使用同一供应商重试（不计入熔断器）
                                match self
                                    .forward_with_admission_retry(
                                        app_type,
                                        &method,
                                        &provider,
                                        endpoint,
                                        &provider_body,
                                        &provider_headers,
                                        &extensions,
                                        adapter.as_ref(),
                                    )
                                    .await
                                {
                                    Ok((response, claude_api_format, outbound_model)) => {
                                        log::info!("[{app_type_str}] [RECT-002] 整流重试成功");
                                        self.record_success_result(
                                            &provider.id,
                                            app_type_str,
                                            used_half_open_permit,
                                        )
                                        .await;

                                        let epoch_fresh = self.epoch_is_current(app_type_str).await;

                                        // 更新当前应用类型使用的 provider
                                        if epoch_fresh {
                                            let mut current_providers =
                                                self.current_providers.write().await;
                                            current_providers.insert(
                                                app_type_str.to_string(),
                                                (provider.id.clone(), provider.name.clone()),
                                            );
                                        }

                                        // 更新成功统计
                                        {
                                            let mut status = self.status.write().await;
                                            status.success_requests += 1;
                                            status.last_error = None;
                                            let should_switch = epoch_fresh
                                                && !self.auto_failover_enabled_at_start
                                                && self.current_provider_id_at_start.as_str()
                                                    != provider.id.as_str();
                                            if should_switch {
                                                status.failover_count += 1;

                                                // 异步触发供应商切换，更新 UI/托盘
                                                let fm = self.failover_manager.clone();
                                                let ah = self.app_handle.clone();
                                                let pid = provider.id.clone();
                                                let pname = provider.name.clone();
                                                let at = app_type_str.to_string();

                                                tokio::spawn(async move {
                                                    let _ = fm
                                                        .try_switch(ah.as_ref(), &at, &pid, &pname)
                                                        .await;
                                                });
                                            }
                                            if status.total_requests > 0 {
                                                status.success_rate = (status.success_requests
                                                    as f32
                                                    / status.total_requests as f32)
                                                    * 100.0;
                                            }
                                        }

                                        return Ok(ForwardResult {
                                            response,
                                            provider: provider.clone(),
                                            claude_api_format,
                                            outbound_model,
                                            connection_guard: None,
                                            session_route_guard,
                                        });
                                    }
                                    Err(retry_error) => {
                                        let admission_retry_neutral = retry_error.is_neutral();
                                        let retry_err = retry_error.into_inner();
                                        log::warn!(
                                            "[{app_type_str}] [RECT-003] 整流重试仍失败: {retry_err}"
                                        );
                                        if admission_retry_neutral {
                                            return Err(self
                                                .admission_retry_neutral_failure(
                                                    &provider,
                                                    app_type_str,
                                                    used_half_open_permit,
                                                    retry_err,
                                                )
                                                .await);
                                        }
                                        if let Some(err) = self
                                            .handle_rectifier_retry_failure(
                                                retry_err,
                                                &provider,
                                                app_type_str,
                                                used_half_open_permit,
                                                "整流",
                                                &mut last_error,
                                                &mut last_provider,
                                            )
                                            .await
                                        {
                                            return Err(err);
                                        }
                                        continue;
                                    }
                                }
                            }
                        }
                    }

                    // 检测是否需要触发 budget 整流器（仅 Claude/ClaudeAuth 供应商）
                    if is_anthropic_provider {
                        let error_message = extract_error_message(&e);
                        if should_rectify_thinking_budget(
                            error_message.as_deref(),
                            &self.rectifier_config,
                        ) {
                            // 已经重试过：直接返回错误（不可重试客户端错误）
                            if budget_rectifier_retried {
                                log::warn!(
                                    "[{app_type_str}] [RECT-013] budget 整流器已触发过，不再重试"
                                );
                                self.router
                                    .release_permit_neutral(
                                        &provider.id,
                                        app_type_str,
                                        used_half_open_permit,
                                    )
                                    .await;
                                let mut status = self.status.write().await;
                                status.failed_requests += 1;
                                status.last_error = Some(e.to_string());
                                if status.total_requests > 0 {
                                    status.success_rate = (status.success_requests as f32
                                        / status.total_requests as f32)
                                        * 100.0;
                                }
                                return Err(ForwardError {
                                    error: e,
                                    provider: Some(provider.clone()),
                                });
                            }

                            let budget_rectified = rectify_thinking_budget(&mut provider_body);
                            if !budget_rectified.applied {
                                log::warn!(
                                    "[{app_type_str}] [RECT-014] budget 整流器触发但无可整流内容，不做无意义重试"
                                );
                                self.router
                                    .release_permit_neutral(
                                        &provider.id,
                                        app_type_str,
                                        used_half_open_permit,
                                    )
                                    .await;
                                let mut status = self.status.write().await;
                                status.failed_requests += 1;
                                status.last_error = Some(e.to_string());
                                if status.total_requests > 0 {
                                    status.success_rate = (status.success_requests as f32
                                        / status.total_requests as f32)
                                        * 100.0;
                                }
                                return Err(ForwardError {
                                    error: e,
                                    provider: Some(provider.clone()),
                                });
                            }

                            log::info!(
                                "[{}] [RECT-010] thinking budget 整流器触发, before={:?}, after={:?}",
                                app_type_str,
                                budget_rectified.before,
                                budget_rectified.after
                            );

                            let _ = std::mem::replace(&mut budget_rectifier_retried, true);

                            // 使用同一供应商重试（不计入熔断器）
                            match self
                                .forward_with_admission_retry(
                                    app_type,
                                    &method,
                                    &provider,
                                    endpoint,
                                    &provider_body,
                                    &provider_headers,
                                    &extensions,
                                    adapter.as_ref(),
                                )
                                .await
                            {
                                Ok((response, claude_api_format, outbound_model)) => {
                                    log::info!("[{app_type_str}] [RECT-011] budget 整流重试成功");
                                    self.record_success_result(
                                        &provider.id,
                                        app_type_str,
                                        used_half_open_permit,
                                    )
                                    .await;

                                    let epoch_fresh = self.epoch_is_current(app_type_str).await;

                                    if epoch_fresh {
                                        let mut current_providers =
                                            self.current_providers.write().await;
                                        current_providers.insert(
                                            app_type_str.to_string(),
                                            (provider.id.clone(), provider.name.clone()),
                                        );
                                    }

                                    {
                                        let mut status = self.status.write().await;
                                        status.success_requests += 1;
                                        status.last_error = None;
                                        let should_switch = epoch_fresh
                                            && !self.auto_failover_enabled_at_start
                                            && self.current_provider_id_at_start.as_str()
                                                != provider.id.as_str();
                                        if should_switch {
                                            status.failover_count += 1;
                                            let fm = self.failover_manager.clone();
                                            let ah = self.app_handle.clone();
                                            let pid = provider.id.clone();
                                            let pname = provider.name.clone();
                                            let at = app_type_str.to_string();
                                            tokio::spawn(async move {
                                                let _ = fm
                                                    .try_switch(ah.as_ref(), &at, &pid, &pname)
                                                    .await;
                                            });
                                        }
                                        if status.total_requests > 0 {
                                            status.success_rate = (status.success_requests as f32
                                                / status.total_requests as f32)
                                                * 100.0;
                                        }
                                    }

                                    return Ok(ForwardResult {
                                        response,
                                        provider: provider.clone(),
                                        claude_api_format,
                                        outbound_model,
                                        connection_guard: None,
                                        session_route_guard,
                                    });
                                }
                                Err(retry_error) => {
                                    let admission_retry_neutral = retry_error.is_neutral();
                                    let retry_err = retry_error.into_inner();
                                    log::warn!(
                                        "[{app_type_str}] [RECT-012] budget 整流重试仍失败: {retry_err}"
                                    );
                                    if admission_retry_neutral {
                                        return Err(self
                                            .admission_retry_neutral_failure(
                                                &provider,
                                                app_type_str,
                                                used_half_open_permit,
                                                retry_err,
                                            )
                                            .await);
                                    }
                                    if let Some(err) = self
                                        .handle_rectifier_retry_failure(
                                            retry_err,
                                            &provider,
                                            app_type_str,
                                            used_half_open_permit,
                                            "budget 整流",
                                            &mut last_error,
                                            &mut last_provider,
                                        )
                                        .await
                                    {
                                        return Err(err);
                                    }
                                    continue;
                                }
                            }
                        }
                    }

                    if signature_rectifier_non_retryable_client_error {
                        self.router
                            .release_permit_neutral(
                                &provider.id,
                                app_type_str,
                                used_half_open_permit,
                            )
                            .await;
                        let mut status = self.status.write().await;
                        status.failed_requests += 1;
                        status.last_error = Some(e.to_string());
                        if status.total_requests > 0 {
                            status.success_rate = (status.success_requests as f32
                                / status.total_requests as f32)
                                * 100.0;
                        }
                        return Err(ForwardError {
                            error: e,
                            provider: Some(provider.clone()),
                        });
                    }

                    // 先分类错误，决定是否计入 provider 健康度
                    // —— NonRetryable / ClientAbort 是客户端层错误，无论换哪家 provider 都会被拒绝，
                    //    不应污染熔断器和数据库健康度（与 release_permit_neutral 同语义）。
                    let category = self.categorize_proxy_error(app_type, endpoint, &e);

                    match category {
                        ErrorCategory::ProviderCapability => {
                            self.router
                                .release_permit_neutral(
                                    &provider.id,
                                    app_type_str,
                                    used_half_open_permit,
                                )
                                .await;

                            {
                                let mut status = self.status.write().await;
                                status.last_error = Some(format!(
                                    "Provider {} does not support this request capability: {}",
                                    provider.name, e
                                ));
                            }

                            let (log_code, log_message) = build_retryable_failure_log(
                                &provider.name,
                                attempted_providers,
                                provider_count,
                                &e,
                            );
                            log::warn!(
                                "[{app_type_str}] [{log_code}] {log_message} (capability mismatch; health unchanged)"
                            );

                            last_error = Some(e);
                            last_provider = Some(provider.clone());
                            continue;
                        }
                        ErrorCategory::Retryable => {
                            // 可重试：真正的 provider 故障 → 记录失败并更新熔断器/DB 健康度
                            let current_providers = self.current_providers.clone();
                            let proxy_activity = self.proxy_activity.clone();
                            let app_handle = self.app_handle.clone();
                            let switch_epoch = self.switch_epoch.clone();
                            let status_for_disable_hook = self.status.clone();
                            let _ = self
                                .router
                                .record_result_with_disable_hook(
                                    &provider.id,
                                    app_type_str,
                                    used_half_open_permit,
                                    false,
                                    Some(e.to_string()),
                                    move |disabled_app_type, disabled_provider_id| {
                                        let current_providers = current_providers.clone();
                                        let proxy_activity = proxy_activity.clone();
                                        let app_handle = app_handle.clone();
                                        let switch_epoch = switch_epoch.clone();
                                        let status_for_disable_hook =
                                            status_for_disable_hook.clone();
                                        async move {
                                            clear_provider(
                                                &proxy_activity,
                                                app_handle.as_ref(),
                                                &disabled_app_type,
                                                &disabled_provider_id,
                                            )
                                            .await;

                                            {
                                                let mut current_providers =
                                                    current_providers.write().await;
                                                let should_clear = current_providers
                                                    .get(&disabled_app_type)
                                                    .map(|(current_id, _)| {
                                                        current_id == &disabled_provider_id
                                                    })
                                                    .unwrap_or(false);
                                                if should_clear {
                                                    current_providers.remove(&disabled_app_type);
                                                }
                                            }

                                            {
                                                let mut status =
                                                    status_for_disable_hook.write().await;
                                                if status.current_provider_id.as_deref()
                                                    == Some(disabled_provider_id.as_str())
                                                {
                                                    status.current_provider = None;
                                                    status.current_provider_id = None;
                                                }
                                            }

                                            {
                                                let mut epochs = switch_epoch.write().await;
                                                let entry =
                                                    epochs.entry(disabled_app_type).or_insert(0);
                                                *entry = entry.saturating_add(1);
                                            }
                                        }
                                    },
                                )
                                .await;

                            {
                                let mut status = self.status.write().await;
                                status.last_error =
                                    Some(format!("Provider {} 失败: {}", provider.name, e));
                            }

                            let (log_code, log_message) = build_retryable_failure_log(
                                &provider.name,
                                attempted_providers,
                                provider_count,
                                &e,
                            );
                            log::warn!("[{app_type_str}] [{log_code}] {log_message}");

                            last_error = Some(e);
                            last_provider = Some(provider.clone());
                            // 继续尝试下一个供应商
                            continue;
                        }
                        ErrorCategory::NonRetryable | ErrorCategory::ClientAbort => {
                            // 不可重试：客户端层错误或客户端断连 → 不污染健康度，仅释放 HalfOpen permit
                            self.router
                                .release_permit_neutral(
                                    &provider.id,
                                    app_type_str,
                                    used_half_open_permit,
                                )
                                .await;
                            {
                                let mut status = self.status.write().await;
                                status.failed_requests += 1;
                                status.last_error = Some(e.to_string());
                                if status.total_requests > 0 {
                                    status.success_rate = (status.success_requests as f32
                                        / status.total_requests as f32)
                                        * 100.0;
                                }
                            }
                            return Err(ForwardError {
                                error: e,
                                provider: Some(provider.clone()),
                            });
                        }
                    }
                }
            }
        }

        if attempted_providers == 0 {
            // providers 列表非空，但全部被熔断器拒绝（典型：HalfOpen 探测名额被占用）
            {
                let mut status = self.status.write().await;
                status.failed_requests += 1;
                status.last_error = Some("所有供应商暂时不可用（熔断器限制）".to_string());
                if status.total_requests > 0 {
                    status.success_rate =
                        (status.success_requests as f32 / status.total_requests as f32) * 100.0;
                }
            }
            return Err(ForwardError {
                error: ProxyError::NoAvailableProvider,
                provider: None,
            });
        }

        // 所有供应商都失败了
        {
            let mut status = self.status.write().await;
            status.failed_requests += 1;
            status.last_error = Some("所有供应商都失败".to_string());
            if status.total_requests > 0 {
                status.success_rate =
                    (status.success_requests as f32 / status.total_requests as f32) * 100.0;
            }
        }

        if let Some((log_code, log_message)) =
            build_terminal_failure_log(attempted_providers, provider_count, last_error.as_ref())
        {
            log::warn!("[{app_type_str}] [{log_code}] {log_message}");
        }

        Err(ForwardError {
            error: last_error.unwrap_or(ProxyError::MaxRetriesExceeded),
            provider: last_provider,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn forward_with_admission_retry(
        &self,
        app_type: &AppType,
        method: &http::Method,
        provider: &Provider,
        endpoint: &str,
        body: &Value,
        headers: &axum::http::HeaderMap,
        extensions: &Extensions,
        adapter: &dyn ProviderAdapter,
    ) -> Result<ForwardAttemptOutput, AdmissionRetryForwardError> {
        let mut retries_used = 0u32;
        loop {
            let attempt_started_at = std::time::Instant::now();
            match self
                .forward(
                    app_type, method, provider, endpoint, body, headers, extensions, adapter,
                )
                .await
            {
                Ok(result) => {
                    if retries_used > 0 {
                        self.disable_admission_retry_after_admitted(app_type, provider);
                        self.emit_admission_retry_event(
                            app_type,
                            provider,
                            retries_used,
                            0,
                            None,
                            "admitted",
                        )
                        .await;
                    }
                    return Ok(result);
                }
                Err(error) => {
                    let attempt_elapsed_ms =
                        attempt_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
                    let category = self.categorize_proxy_error(app_type, endpoint, &error);
                    let admission_retryable = should_retry_provider_admission(category, &error);
                    let policy = self.current_admission_retry_policy(app_type, provider);
                    let Some(policy) = policy.or_else(|| {
                        if admission_retryable {
                            self.try_auto_enable_admission_retry(app_type, provider, &error)
                        } else {
                            None
                        }
                    }) else {
                        if retries_used > 0 {
                            self.emit_admission_retry_event(
                                app_type,
                                provider,
                                retries_used,
                                0,
                                Some(&error),
                                "cleared",
                            )
                            .await;
                        }
                        return Err(AdmissionRetryForwardError::Normal(error));
                    };

                    // 入场重试语义：开关开着时，对“同一家换个时机重发可能成功”的
                    // 可重试错误（拥挤/限流/超时/连接失败/5xx 等）一律死磕同一 provider，
                    // 不再把错误抛回客户端触发 CLI 侧倒计时退避。两道闸门：
                    //   1) ErrorCategory::Retryable —— 排除客户端层永久错误
                    //      （400/413/422/501 等 NonRetryable）与能力不匹配
                    //      （ProviderCapability），这类换时机也修不好；
                    //   2) body 永久失败信号 —— 排除配额/鉴权/模型不存在等
                    //      “死磕同一家 100% 不会成功”的上游响应，避免无限空等。
                    // 命中任一闸门即中性返回，交回原有流程（含整流器 4xx 修复）。
                    if !admission_retryable {
                        if retries_used > 0 {
                            self.emit_admission_retry_event(
                                app_type,
                                provider,
                                retries_used,
                                0,
                                Some(&error),
                                "cleared",
                            )
                            .await;
                        }
                        return Err(AdmissionRetryForwardError::Neutral(error));
                    }

                    if policy.retry_limit_reached(retries_used) {
                        self.emit_admission_retry_event(
                            app_type,
                            provider,
                            retries_used,
                            0,
                            Some(&error),
                            "cleared",
                        )
                        .await;
                        log::warn!(
                            "[{}] 上游入场重试达到阈值，中性返回: provider={}, retries={}, error={}",
                            app_type.as_str(),
                            provider.name,
                            retries_used,
                            summarize_proxy_error(&error)
                        );
                        return Err(AdmissionRetryForwardError::Neutral(error));
                    }

                    retries_used = retries_used.saturating_add(1);
                    let delay_plan = policy.plan_delay(
                        retries_used,
                        proxy_error_retry_after_ms(&error),
                        attempt_elapsed_ms,
                    );
                    if delay_plan.used_retry_after {
                        log::warn!(
                            "[{}] 上游临时失败，入场重试持续重放同一 Provider: provider={}, retry={}, wait_ms={}, retry_after_ms={}, attempt_ms={}, error={}",
                            app_type.as_str(),
                            provider.name,
                            retries_used,
                            delay_plan.sleep_ms,
                            delay_plan.target_interval_ms,
                            attempt_elapsed_ms,
                            summarize_proxy_error(&error)
                        );
                    } else {
                        log::warn!(
                            "[{}] 上游临时失败，入场重试持续重放同一 Provider: provider={}, retry={}, wait_ms={}, target_interval_ms={}, attempt_ms={}, error={}",
                            app_type.as_str(),
                            provider.name,
                            retries_used,
                            delay_plan.sleep_ms,
                            delay_plan.target_interval_ms,
                            attempt_elapsed_ms,
                            summarize_proxy_error(&error)
                        );
                    }
                    self.emit_admission_retry_event(
                        app_type,
                        provider,
                        retries_used,
                        delay_plan.sleep_ms,
                        Some(&error),
                        "retrying",
                    )
                    .await;
                    if delay_plan.sleep_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(delay_plan.sleep_ms))
                            .await;
                    }
                    if self
                        .current_admission_retry_policy(app_type, provider)
                        .is_none()
                    {
                        self.emit_admission_retry_event(
                            app_type,
                            provider,
                            retries_used,
                            0,
                            Some(&error),
                            "cleared",
                        )
                        .await;
                        return Err(AdmissionRetryForwardError::Normal(error));
                    }
                }
            }
        }
    }

    fn disable_admission_retry_after_admitted(&self, app_type: &AppType, provider: &Provider) {
        let Some(app_handle) = self.app_handle.as_ref() else {
            return;
        };
        let Some(state) = app_handle.try_state::<AppState>() else {
            return;
        };

        match ProviderService::set_upstream_admission_retry_enabled(
            state.inner(),
            app_type,
            &provider.id,
            false,
        ) {
            Ok(true) => log::info!(
                "[{}] 上游入场成功，已自动关闭供应商入场重试: provider={}",
                app_type.as_str(),
                provider.name
            ),
            Ok(false) => log::warn!(
                "[{}] 上游入场成功但未找到供应商，无法自动关闭入场重试: provider={}",
                app_type.as_str(),
                provider.id
            ),
            Err(error) => log::warn!(
                "[{}] 上游入场成功但自动关闭供应商入场重试失败: provider={}, error={}",
                app_type.as_str(),
                provider.id,
                error
            ),
        }
    }

    fn current_admission_retry_policy(
        &self,
        app_type: &AppType,
        provider: &Provider,
    ) -> Option<AdmissionRetryPolicy> {
        if let Some(app_handle) = self.app_handle.as_ref() {
            if let Some(state) = app_handle.try_state::<AppState>() {
                match state.db.get_provider_by_id(&provider.id, app_type.as_str()) {
                    Ok(Some(latest)) => return AdmissionRetryPolicy::from_provider(&latest),
                    Ok(None) => return None,
                    Err(error) => {
                        log::warn!(
                            "[{}] 读取 Provider 入场重试开关失败，使用请求开始时快照: provider={}, error={}",
                            app_type.as_str(),
                            provider.id,
                            error
                        );
                    }
                }
            }
        }

        AdmissionRetryPolicy::from_provider(provider)
    }

    fn try_auto_enable_admission_retry(
        &self,
        app_type: &AppType,
        provider: &Provider,
        error: &ProxyError,
    ) -> Option<AdmissionRetryPolicy> {
        let latest = self.latest_provider_for_policy(app_type, provider);
        let policy_source = latest.as_ref().unwrap_or(provider);
        let policy = AdmissionRetryPolicy::auto_from_provider_for_error(policy_source, error)?;

        let Some(app_handle) = self.app_handle.as_ref() else {
            return Some(policy);
        };
        let Some(state) = app_handle.try_state::<AppState>() else {
            return Some(policy);
        };

        match ProviderService::set_upstream_admission_retry_enabled(
            state.inner(),
            app_type,
            &provider.id,
            true,
        ) {
            Ok(true) => log::info!(
                "[{}] 命中自动入场重试关键词，已开启供应商入场重试: provider={}, error={}",
                app_type.as_str(),
                provider.name,
                summarize_proxy_error(error)
            ),
            Ok(false) => log::warn!(
                "[{}] 命中自动入场重试关键词但未找到供应商: provider={}",
                app_type.as_str(),
                provider.id
            ),
            Err(enable_error) => {
                log::warn!(
                    "[{}] 命中自动入场重试关键词但开启供应商入场重试失败: provider={}, error={}",
                    app_type.as_str(),
                    provider.id,
                    enable_error
                );
                return None;
            }
        }

        Some(policy)
    }

    fn latest_provider_for_policy(
        &self,
        app_type: &AppType,
        provider: &Provider,
    ) -> Option<Provider> {
        let app_handle = self.app_handle.as_ref()?;
        let state = app_handle.try_state::<AppState>()?;
        match state.db.get_provider_by_id(&provider.id, app_type.as_str()) {
            Ok(latest) => latest,
            Err(error) => {
                log::warn!(
                    "[{}] 读取 Provider 入场重试自动开关失败，使用请求开始时快照: provider={}, error={}",
                    app_type.as_str(),
                    provider.id,
                    error
                );
                None
            }
        }
    }

    async fn emit_admission_retry_event(
        &self,
        app_type: &AppType,
        provider: &Provider,
        retry_count: u32,
        delay_ms: u64,
        error: Option<&ProxyError>,
        event: &str,
    ) {
        let payload = ProviderAdmissionRetryEvent {
            request_id: self.request_id.clone(),
            event: event.to_string(),
            app_type: app_type.as_str().to_string(),
            provider_id: provider.id.clone(),
            provider_name: provider.name.clone(),
            retry_count,
            delay_ms,
            status: error.and_then(proxy_error_status),
            error: error.map(summarize_proxy_error),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        record_admission_retry(&self.proxy_activity, self.app_handle.as_ref(), payload).await;
    }

    /// 转发单个请求（使用适配器）
    ///
    /// 成功时返回 `(response, claude_api_format, outbound_model)`，其中
    /// `outbound_model` 是最终发往上游的模型名（所有映射/改写之后）。
    #[allow(clippy::too_many_arguments)]
    async fn forward(
        &self,
        app_type: &AppType,
        method: &http::Method,
        provider: &Provider,
        endpoint: &str,
        body: &Value,
        headers: &axum::http::HeaderMap,
        extensions: &Extensions,
        adapter: &dyn ProviderAdapter,
    ) -> Result<(ProxyResponse, Option<String>, Option<String>), ProxyError> {
        let app_type_str = app_type.as_str();
        // 使用适配器提取 base_url
        let mut base_url = adapter.extract_base_url(provider)?;

        let is_full_url = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.is_full_url)
            .unwrap_or(false);

        // GitHub Copilot API 使用 /chat/completions（无 /v1 前缀）
        let is_copilot = provider
            .meta
            .as_ref()
            .and_then(|m| m.provider_type.as_deref())
            == Some("github_copilot")
            || base_url.contains("githubcopilot.com");

        // 应用模型映射（独立于格式转换）
        // Claude Desktop proxy 模式必须先把 Desktop 可见的 claude-* route
        // 映射成真实上游模型名，并且未知 route 要直接报错，不能使用默认模型兜底。
        let mapped_body = if matches!(app_type, AppType::ClaudeDesktop) {
            crate::claude_desktop_config::map_proxy_request_model(body.clone(), provider)
                .map_err(|e| ProxyError::InvalidRequest(e.to_string()))?
        } else {
            let (mapped_body, _original_model, _mapped_model) =
                apply_scoped_model_mapping(app_type_str, body.clone(), provider);
            let (mapped_body, _default_model) =
                apply_provider_default_model_if_missing(app_type_str, mapped_body, provider);
            mapped_body
        };

        // 与 CCH 对齐：请求前不做 thinking 主动改写（仅保留兼容入口）
        let mut mapped_body = normalize_thinking_type(mapped_body);

        if is_copilot {
            mapped_body =
                super::providers::copilot_model_map::apply_copilot_model_normalization(mapped_body);
            self.apply_copilot_live_model_resolution(provider, &mut mapped_body)
                .await;
        } else {
            mapped_body =
                super::model_mapper::strip_one_m_suffix_for_upstream_from_body(mapped_body);
        }

        // --- Copilot 优化器：分类 + 请求体优化（在格式转换之前执行） ---
        // 注意：确定性 ID 也在此处计算，因为 mapped_body 在格式转换时会被 move
        //
        // 执行顺序（与 copilot-api 对齐）：
        //   1. 先在原始 body 上分类（保留 tool_result 语义，避免误判为 user）
        //   2. 再清洗孤立 tool_result（防止上游 API 报错）
        //   3. 再合并 tool_result + text（减少 premium 计费）
        let copilot_optimization = if is_copilot && self.copilot_optimizer_config.enabled {
            // 1. 在原始 body 上分类 — 必须在清洗/合并之前执行
            //    孤立 tool_result 仍保持 tool_result 类型，分类能正确识别为 agent
            let has_anthropic_beta = headers.contains_key("anthropic-beta");
            let classification = super::copilot_optimizer::classify_request(
                &mapped_body,
                has_anthropic_beta,
                self.copilot_optimizer_config.compact_detection,
                self.copilot_optimizer_config.subagent_detection,
            );

            log::debug!(
                "[Copilot] 优化器分类: initiator={}, is_warmup={}, is_compact={}, is_subagent={}",
                classification.initiator,
                classification.is_warmup,
                classification.is_compact,
                classification.is_subagent
            );

            // 2. 孤立 tool_result 清理 — 分类完成后再清洗
            //    防止上游 API 因不匹配的 tool_result 报错导致重试/重复计费
            mapped_body = super::copilot_optimizer::sanitize_orphan_tool_results(mapped_body);

            // 3. Tool result 合并 — 将 [tool_result, text] 变为 [tool_result(含text)]
            if self.copilot_optimizer_config.tool_result_merging {
                mapped_body = super::copilot_optimizer::merge_tool_results(mapped_body);
            }

            // 3.5. 主动剥离 thinking block — Copilot 走 OpenAI 兼容端点不识别该块
            //      避免上游拒绝后由 rectifier 反应式重试（首次请求已消耗 quota）
            if self.copilot_optimizer_config.strip_thinking {
                mapped_body = super::copilot_optimizer::strip_thinking_blocks(mapped_body);
            }

            // 4. Warmup 小模型降级
            if self.copilot_optimizer_config.warmup_downgrade && classification.is_warmup {
                log::info!(
                    "[Copilot] Warmup 请求降级到模型: {}",
                    self.copilot_optimizer_config.warmup_model
                );
                mapped_body["model"] =
                    serde_json::json!(&self.copilot_optimizer_config.warmup_model);
            }

            // 预计算确定性 Request ID（在 body 被 move 之前）
            // Session 提取优先级（与 session.rs extract_from_metadata 对齐）：
            //   1. metadata.user_id 中的 _session_ 后缀
            //   2. metadata.session_id（直接字段）
            //   3. raw metadata.user_id（整串 fallback）
            //   4. x-session-id header
            let metadata = body.get("metadata");
            let session_id = metadata
                .and_then(|m| m.get("user_id"))
                .and_then(|v| v.as_str())
                .and_then(super::session::parse_session_from_user_id)
                .or_else(|| {
                    metadata
                        .and_then(|m| m.get("session_id"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                })
                .or_else(|| {
                    metadata
                        .and_then(|m| m.get("user_id"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                })
                .or_else(|| {
                    headers
                        .get("x-session-id")
                        .and_then(|v| v.to_str().ok())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            let det_request_id = if self.copilot_optimizer_config.deterministic_request_id {
                Some(super::copilot_optimizer::deterministic_request_id(
                    &mapped_body,
                    &session_id,
                ))
            } else {
                None
            };

            // 从 session ID 派生稳定的 interaction ID（同一主对话共享）
            let interaction_id =
                super::copilot_optimizer::deterministic_interaction_id(&session_id);

            Some((classification, det_request_id, interaction_id))
        } else {
            None
        };

        // GitHub Copilot 动态 endpoint 路由
        // 从 CopilotAuthManager 获取缓存的 API endpoint（支持企业版等非默认 endpoint）
        if is_copilot && !is_full_url {
            if let Some(app_handle) = &self.app_handle {
                let copilot_state = app_handle.state::<CopilotAuthState>();
                let copilot_auth = copilot_state.0.read().await;

                // 从 provider.meta 获取关联的 GitHub 账号 ID
                let account_id = provider
                    .meta
                    .as_ref()
                    .and_then(|m| m.managed_account_id_for("github_copilot"));

                let dynamic_endpoint = match &account_id {
                    Some(id) => copilot_auth.get_api_endpoint(id).await,
                    None => copilot_auth.get_default_api_endpoint().await,
                };

                // 只在动态 endpoint 与当前 base_url 不同时替换
                if dynamic_endpoint != base_url {
                    log::debug!(
                        "[Copilot] 使用动态 API endpoint: {} (原: {})",
                        dynamic_endpoint,
                        base_url
                    );
                    base_url = dynamic_endpoint;
                }
            }
        }
        let resolved_claude_api_format = if adapter.name() == "Claude" {
            Some(
                self.resolve_claude_api_format(provider, &mapped_body, is_copilot)
                    .await,
            )
        } else {
            None
        };
        if adapter.name() == "Claude" {
            if let Some(api_format) = resolved_claude_api_format.as_deref() {
                super::providers::normalize_anthropic_messages_for_provider(
                    &mut mapped_body,
                    provider,
                    api_format,
                );
                self.apply_media_prevention(&mut mapped_body, provider);
            }
        }
        let needs_transform = match resolved_claude_api_format.as_deref() {
            Some(api_format) => super::providers::claude_api_format_needs_transform(api_format),
            None => adapter.needs_transform(provider),
        };
        let codex_responses_to_chat = matches!(app_type, AppType::Codex)
            && super::providers::should_convert_codex_responses_to_chat(provider, endpoint);
        let (effective_endpoint, passthrough_query) = if codex_responses_to_chat {
            rewrite_codex_responses_endpoint_to_chat(endpoint)
        } else if needs_transform && adapter.name() == "Claude" {
            let api_format = resolved_claude_api_format
                .as_deref()
                .unwrap_or_else(|| super::providers::get_claude_api_format(provider));
            rewrite_claude_transform_endpoint(endpoint, api_format, is_copilot, &mapped_body)
        } else {
            (
                endpoint.to_string(),
                split_endpoint_and_query(endpoint)
                    .1
                    .map(ToString::to_string),
            )
        };

        let codex_chat_base_is_full_endpoint = codex_responses_to_chat
            && base_url
                .trim_end_matches('/')
                .to_ascii_lowercase()
                .ends_with("/chat/completions");

        let url = if matches!(resolved_claude_api_format.as_deref(), Some("gemini_native")) {
            super::gemini_url::resolve_gemini_native_url(
                &base_url,
                &effective_endpoint,
                is_full_url,
            )
        } else if is_full_url || codex_chat_base_is_full_endpoint {
            append_query_to_full_url(&base_url, passthrough_query.as_deref())
        } else {
            adapter.build_url(&base_url, &effective_endpoint)
        };
        let route_mode = if self.auto_failover_enabled_at_start {
            "failover"
        } else {
            "takeover"
        };
        let activity_upstream_url = sanitize_activity_upstream_url(&url);

        // 记录映射后的出站模型名（此时 mapped_body 已完成接管映射 / [1m] 剥离 /
        // Copilot 归一化）。格式转换后若 body 仍带 model 字段会在下方刷新覆盖；
        // gemini_native 等模型在 URL 中的格式则保留此处的转换前真值。
        let mut outbound_model = mapped_body
            .get("model")
            .and_then(|m| m.as_str())
            .filter(|m| !m.is_empty())
            .map(str::to_string);

        // 转换请求体（如果需要）
        let mut request_body = if codex_responses_to_chat {
            let mut mapped_body = mapped_body;
            let restored = self
                .codex_chat_history
                .enrich_request(&mut mapped_body)
                .await;
            if restored > 0 {
                log::debug!(
                    "[Codex] Restored or enriched {restored} cached function call item(s) for Chat upstream"
                );
            }
            super::providers::apply_codex_chat_upstream_model(provider, &mut mapped_body);
            let reasoning_config =
                super::providers::resolve_codex_chat_reasoning_config(provider, &mapped_body);
            super::providers::transform_codex_chat::responses_to_chat_completions_with_reasoning(
                mapped_body,
                reasoning_config.as_ref(),
            )?
        } else if needs_transform {
            if adapter.name() == "Claude" {
                let api_format = resolved_claude_api_format
                    .as_deref()
                    .unwrap_or_else(|| super::providers::get_claude_api_format(provider));
                super::providers::transform_claude_request_for_api_format(
                    mapped_body,
                    provider,
                    api_format,
                    self.session_client_provided
                        .then_some(self.session_id.as_str()),
                    Some(self.gemini_shadow.as_ref()),
                )?
            } else {
                adapter.transform_request(mapped_body, provider)?
            }
        } else {
            mapped_body
        };

        if matches!(app_type, AppType::Codex) {
            self.apply_media_prevention(&mut request_body, provider);
        }

        // 过滤私有参数（以 `_` 开头的字段），防止内部信息泄露到上游
        // 默认使用空白名单，过滤所有 _ 前缀字段
        let mut filtered_body = prepare_upstream_request_body(request_body);
        if !is_copilot {
            if let Some(overrides) = provider
                .meta
                .as_ref()
                .and_then(|meta| meta.local_proxy_request_overrides.as_ref())
            {
                if apply_local_proxy_body_overrides(&mut filtered_body, overrides) {
                    filtered_body = prepare_upstream_request_body(filtered_body);
                }
            }
        }
        // 出站 body 定稿后刷新真值（覆盖 Codex chat 上游模型覆写、转换层模型改写）
        if let Some(m) = filtered_body
            .get("model")
            .and_then(|m| m.as_str())
            .filter(|m| !m.is_empty())
        {
            outbound_model = Some(m.to_string());
        }
        let effective_request_model = outbound_model.clone().or_else(|| {
            let trimmed = self.request_model.trim();
            if trimmed.is_empty() || trimmed == "unknown" {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        let activity_request_model = if normalize_activity_model(&self.request_model).is_none() {
            effective_request_model.clone()
        } else {
            None
        };
        let activity_project_path = activity_project_path(headers, &filtered_body);
        let activity_project_name = activity_project_name(activity_project_path.as_deref())
            .or_else(|| activity_project_name_from_request(headers, &filtered_body));
        route_request_with_metadata(
            &self.proxy_activity,
            self.app_handle.as_ref(),
            &self.request_id,
            app_type_str,
            &provider.id,
            &provider.name,
            activity_request_model,
            effective_request_model.clone(),
            Some(route_mode.to_string()),
            Some(activity_upstream_url),
            self.session_client_provided
                .then(|| self.session_id.clone())
                .filter(|value| !value.trim().is_empty()),
            activity_project_name,
            activity_project_path,
        )
        .await;
        log_prompt_cache_trace(
            app_type,
            provider,
            &effective_endpoint,
            resolved_claude_api_format.as_deref(),
            &filtered_body,
            self.session_client_provided,
        );
        let request_is_streaming =
            is_streaming_request(&effective_endpoint, &filtered_body, headers);
        let force_identity_encoding = needs_transform
            || codex_responses_to_chat
            || request_is_streaming
            || should_force_identity_encoding(&effective_endpoint, &filtered_body, headers);

        // Codex OAuth 需要注入的 ChatGPT-Account-Id（在动态 token 获取期间填充）
        let mut codex_oauth_account_id: Option<String> = None;
        let mut should_send_codex_oauth_session_headers = false;

        // 获取认证头（提前准备，用于内联替换）
        let mut auth_headers = if let Some(mut auth) = adapter.extract_auth(provider) {
            // GitHub Copilot 特殊处理：从 CopilotAuthManager 获取真实 token
            if auth.strategy == AuthStrategy::GitHubCopilot {
                if let Some(app_handle) = &self.app_handle {
                    let copilot_state = app_handle.state::<CopilotAuthState>();
                    let copilot_auth: tokio::sync::RwLockReadGuard<'_, CopilotAuthManager> =
                        copilot_state.0.read().await;

                    // 从 provider.meta 获取关联的 GitHub 账号 ID（多账号支持）
                    let account_id = provider
                        .meta
                        .as_ref()
                        .and_then(|m| m.managed_account_id_for("github_copilot"));

                    // 根据账号 ID 获取对应 token（向后兼容：无账号 ID 时使用第一个账号）
                    let token_result = match &account_id {
                        Some(id) => {
                            log::debug!("[Copilot] 使用指定账号 {id} 获取 token");
                            copilot_auth.get_valid_token_for_account(id).await
                        }
                        None => {
                            log::debug!("[Copilot] 使用默认账号获取 token");
                            copilot_auth.get_valid_token().await
                        }
                    };

                    match token_result {
                        Ok(token) => {
                            auth = AuthInfo::new(token, AuthStrategy::GitHubCopilot);
                            log::debug!(
                                "[Copilot] 成功获取 Copilot token (account={})",
                                account_id.as_deref().unwrap_or("default")
                            );
                        }
                        Err(e) => {
                            log::error!(
                                "[Copilot] 获取 Copilot token 失败 (account={}): {e}",
                                account_id.as_deref().unwrap_or("default")
                            );
                            return Err(ProxyError::AuthError(format!(
                                "GitHub Copilot 认证失败: {e}"
                            )));
                        }
                    }
                } else {
                    log::error!("[Copilot] AppHandle 不可用");
                    return Err(ProxyError::AuthError(
                        "GitHub Copilot 认证不可用（无 AppHandle）".to_string(),
                    ));
                }
            }

            // Codex OAuth 特殊处理：从 CodexOAuthManager 获取真实 access_token
            if auth.strategy == AuthStrategy::CodexOAuth {
                if let Some(app_handle) = &self.app_handle {
                    let codex_state = app_handle.state::<CodexOAuthState>();
                    let codex_auth: tokio::sync::RwLockReadGuard<'_, CodexOAuthManager> =
                        codex_state.0.read().await;

                    // 从 provider.meta 获取关联的 ChatGPT 账号 ID
                    let account_id = provider
                        .meta
                        .as_ref()
                        .and_then(|m| m.managed_account_id_for("codex_oauth"));

                    let token_result = match &account_id {
                        Some(id) => {
                            log::debug!("[CodexOAuth] 使用指定账号 {id} 获取 token");
                            codex_auth.get_valid_token_for_account(id).await
                        }
                        None => {
                            log::debug!("[CodexOAuth] 使用默认账号获取 token");
                            codex_auth.get_valid_token().await
                        }
                    };

                    match token_result {
                        Ok(token) => {
                            auth = AuthInfo::new(token, AuthStrategy::CodexOAuth);
                            should_send_codex_oauth_session_headers = true;
                            // 解析使用的 account_id（用于注入 ChatGPT-Account-Id header）
                            codex_oauth_account_id = match account_id {
                                Some(id) => Some(id),
                                None => codex_auth.default_account_id().await,
                            };
                            log::debug!(
                                "[CodexOAuth] 成功获取 access_token (account={})",
                                codex_oauth_account_id.as_deref().unwrap_or("default")
                            );
                        }
                        Err(e) => {
                            log::error!("[CodexOAuth] 获取 access_token 失败: {e}");
                            return Err(ProxyError::AuthError(format!(
                                "Codex OAuth 认证失败: {e}"
                            )));
                        }
                    }
                } else {
                    log::error!("[CodexOAuth] AppHandle 不可用");
                    return Err(ProxyError::AuthError(
                        "Codex OAuth 认证不可用（无 AppHandle）".to_string(),
                    ));
                }
            }

            adapter.get_auth_headers(&auth)?
        } else {
            Vec::new()
        };

        // 注入 Codex OAuth 的 ChatGPT-Account-Id header（如果有 account_id）
        if let Some(ref account_id) = codex_oauth_account_id {
            if let Ok(hv) = http::HeaderValue::from_str(account_id) {
                auth_headers.push((http::HeaderName::from_static("chatgpt-account-id"), hv));
            }
        }

        let codex_oauth_session_headers =
            if should_send_codex_oauth_session_headers && self.session_client_provided {
                build_codex_oauth_session_headers(&self.session_id)
            } else {
                Vec::new()
            };

        // 自定义 User-Agent：与 stream_check / model_fetch 共用 parse_custom_user_agent，
        // 运行时静默忽略非法值（前端在输入处给非阻断提示，不在保存时阻断）。
        // Copilot 指纹 UA 不可覆盖。
        let custom_user_agent = if is_copilot {
            None
        } else {
            provider
                .meta
                .as_ref()
                .and_then(|meta| meta.custom_user_agent_header().ok().flatten())
        };

        // --- Copilot 优化器：动态 header 注入 ---
        if let Some((ref classification, ref det_request_id, ref interaction_id)) =
            copilot_optimization
        {
            for (name, value) in auth_headers.iter_mut() {
                match name.as_str() {
                    "x-initiator" if self.copilot_optimizer_config.request_classification => {
                        *value = http::HeaderValue::from_static(classification.initiator);
                    }
                    "x-interaction-type" if classification.is_subagent => {
                        // 子代理请求：conversation-subagent 不计 premium interaction
                        *value = http::HeaderValue::from_static("conversation-subagent");
                    }
                    "x-request-id" | "x-agent-task-id" => {
                        if let Some(ref det_id) = det_request_id {
                            if let Ok(hv) = http::HeaderValue::from_str(det_id) {
                                *value = hv;
                            }
                        }
                    }
                    _ => {}
                }
            }

            // x-interaction-id：仅在有 session 时注入（不在 get_auth_headers 中）
            if let Some(ref iid) = interaction_id {
                if let Ok(hv) = http::HeaderValue::from_str(iid) {
                    auth_headers.push((http::HeaderName::from_static("x-interaction-id"), hv));
                }
            }

            if classification.is_subagent {
                log::info!(
                    "[Copilot] 子代理请求: x-initiator=agent, x-interaction-type=conversation-subagent"
                );
            }
        }

        // Copilot 指纹头名（由 get_auth_headers 注入，需在原始头中去重）
        let copilot_fingerprint_headers: &[&str] = if is_copilot {
            &[
                "user-agent",
                "editor-version",
                "editor-plugin-version",
                "copilot-integration-id",
                "x-github-api-version",
                "openai-intent",
                // 新增 headers
                "x-initiator",
                "x-interaction-type",
                "x-interaction-id",
                "x-vscode-user-agent-library-version",
                "x-request-id",
                "x-agent-task-id",
            ]
        } else {
            &[]
        };

        // 预计算上游 host 值（用于在原位替换 host header）
        let upstream_host = url
            .parse::<http::Uri>()
            .ok()
            .and_then(|u| u.authority().map(|a| a.to_string()));

        let should_send_anthropic_headers = adapter.name() == "Claude"
            && matches!(resolved_claude_api_format.as_deref(), Some("anthropic"));

        // 预计算 anthropic-beta 值（仅 Claude）
        let anthropic_beta_value = if should_send_anthropic_headers {
            const CLAUDE_CODE_BETA: &str = "claude-code-20250219";
            Some(if let Some(beta) = headers.get("anthropic-beta") {
                if let Ok(beta_str) = beta.to_str() {
                    if beta_str.contains(CLAUDE_CODE_BETA) {
                        beta_str.to_string()
                    } else {
                        format!("{CLAUDE_CODE_BETA},{beta_str}")
                    }
                } else {
                    CLAUDE_CODE_BETA.to_string()
                }
            } else {
                CLAUDE_CODE_BETA.to_string()
            })
        } else {
            None
        };

        // ============================================================
        // 构建有序 HeaderMap — 内联替换，保持客户端原始顺序
        // ============================================================
        let mut ordered_headers = http::HeaderMap::new();
        let mut saw_auth = false;
        let mut saw_accept_encoding = false;
        let mut saw_user_agent = false;
        let mut saw_anthropic_beta = false;
        let mut saw_anthropic_version = false;

        for (key, value) in headers {
            let key_str = key.as_str();

            // --- host — 原位替换为上游 host（保持客户端原始位置） ---
            if key_str.eq_ignore_ascii_case("host") {
                if let Some(ref host_val) = upstream_host {
                    if let Ok(hv) = http::HeaderValue::from_str(host_val) {
                        ordered_headers.append(key.clone(), hv);
                    }
                }
                continue;
            }

            // --- 连接 / 追踪 / CDN 类 — 无条件跳过 ---
            if matches!(
                key_str,
                "content-length"
                    | "transfer-encoding"
                    | "x-forwarded-host"
                    | "x-forwarded-port"
                    | "x-forwarded-proto"
                    | "forwarded"
                    | "cf-connecting-ip"
                    | "cf-ipcountry"
                    | "cf-ray"
                    | "cf-visitor"
                    | "true-client-ip"
                    | "fastly-client-ip"
                    | "x-azure-clientip"
                    | "x-azure-fdid"
                    | "x-azure-ref"
                    | "akamai-origin-hop"
                    | "x-akamai-config-log-detail"
                    | "x-request-id"
                    | "x-correlation-id"
                    | "x-trace-id"
                    | "x-amzn-trace-id"
                    | "x-b3-traceid"
                    | "x-b3-spanid"
                    | "x-b3-parentspanid"
                    | "x-b3-sampled"
                    | "traceparent"
                    | "tracestate"
            ) {
                continue;
            }

            // --- 认证类 — 用 adapter 提供的认证头替换（在原始位置） ---
            if key_str.eq_ignore_ascii_case("authorization")
                || key_str.eq_ignore_ascii_case("x-api-key")
                || key_str.eq_ignore_ascii_case("x-goog-api-key")
            {
                if !saw_auth {
                    saw_auth = true;
                    for (ah_name, ah_value) in &auth_headers {
                        ordered_headers.append(ah_name.clone(), ah_value.clone());
                    }
                }
                continue;
            }

            // --- accept-encoding — transform / SSE 路径强制 identity，其余保留原值 ---
            if key_str.eq_ignore_ascii_case("accept-encoding") {
                if !saw_accept_encoding {
                    saw_accept_encoding = true;
                    if force_identity_encoding {
                        ordered_headers.append(
                            http::header::ACCEPT_ENCODING,
                            http::HeaderValue::from_static("identity"),
                        );
                    } else {
                        ordered_headers.append(key.clone(), value.clone());
                    }
                }
                continue;
            }

            // --- user-agent: provider-level override for local proxy routing ---
            if !is_copilot && key_str.eq_ignore_ascii_case("user-agent") {
                if !saw_user_agent {
                    saw_user_agent = true;
                    if let Some(ref ua) = custom_user_agent {
                        ordered_headers.append(http::header::USER_AGENT, ua.clone());
                    } else {
                        ordered_headers.append(key.clone(), value.clone());
                    }
                }
                continue;
            }

            // --- anthropic-beta — 用重建值替换（确保含 claude-code 标记） ---
            if key_str.eq_ignore_ascii_case("anthropic-beta") {
                if !saw_anthropic_beta {
                    saw_anthropic_beta = true;
                    if let Some(ref beta_val) = anthropic_beta_value {
                        if let Ok(hv) = http::HeaderValue::from_str(beta_val) {
                            ordered_headers.append("anthropic-beta", hv);
                        }
                    }
                }
                continue;
            }

            // --- anthropic-version — 透传客户端值 ---
            if key_str.eq_ignore_ascii_case("anthropic-version") {
                if should_send_anthropic_headers {
                    saw_anthropic_version = true;
                    ordered_headers.append(key.clone(), value.clone());
                }
                continue;
            }

            // --- Copilot 指纹头 — 跳过（由 auth_headers 提供） ---
            if copilot_fingerprint_headers
                .iter()
                .any(|h| key_str.eq_ignore_ascii_case(h))
            {
                continue;
            }

            // --- 默认：透传 ---
            ordered_headers.append(key.clone(), value.clone());
        }

        // 如果原始请求中没有认证头，在末尾追加
        if !saw_auth && !auth_headers.is_empty() {
            for (ah_name, ah_value) in &auth_headers {
                ordered_headers.append(ah_name.clone(), ah_value.clone());
            }
        }

        // transform / SSE 路径在缺失时补 identity；普通透传不主动补 accept-encoding
        if !saw_accept_encoding && force_identity_encoding {
            ordered_headers.append(
                http::header::ACCEPT_ENCODING,
                http::HeaderValue::from_static("identity"),
            );
        }

        if !saw_user_agent {
            if let Some(ref ua) = custom_user_agent {
                ordered_headers.append(http::header::USER_AGENT, ua.clone());
            }
        }

        // 如果原始请求中没有 anthropic-beta 且有值需要添加，追加
        if !saw_anthropic_beta {
            if let Some(ref beta_val) = anthropic_beta_value {
                if let Ok(hv) = http::HeaderValue::from_str(beta_val) {
                    ordered_headers.append("anthropic-beta", hv);
                }
            }
        }

        // anthropic-version：仅在缺失时补充默认值
        if should_send_anthropic_headers && !saw_anthropic_version {
            ordered_headers.append(
                "anthropic-version",
                http::HeaderValue::from_static("2023-06-01"),
            );
        }

        // Codex OAuth 反代尽量对齐官方 Codex CLI 的会话路由信号。
        // 只发送客户端提供的 session_id；生成的 UUID 每次不同，反而会破坏前缀缓存。
        for (name, value) in codex_oauth_session_headers {
            ordered_headers.insert(name, value);
        }

        // 序列化请求体。GET/HEAD 是 idempotent/safe 方法，按 HTTP 语义不应携带 body；
        // 强行附带 JSON body 会让某些上游（如 Google Gemini 的 models.list）拒绝请求。
        let body_bytes = if matches!(method, &http::Method::GET | &http::Method::HEAD) {
            Vec::new()
        } else {
            serde_json::to_vec(&filtered_body).map_err(|e| {
                ProxyError::Internal(format!("Failed to serialize request body: {e}"))
            })?
        };

        // 确保 content-type 存在
        if !ordered_headers.contains_key(http::header::CONTENT_TYPE) {
            ordered_headers.insert(
                http::header::CONTENT_TYPE,
                http::HeaderValue::from_static("application/json"),
            );
        }

        apply_local_proxy_header_overrides(
            &mut ordered_headers,
            provider
                .meta
                .as_ref()
                .and_then(|meta| meta.local_proxy_request_overrides.as_ref()),
            is_copilot,
        );

        reject_proxy_placeholder_for_managed_account_upstream(&url, &ordered_headers)?;

        // 输出请求信息日志
        let tag = adapter.name();
        let request_model = filtered_body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>");
        log::info!("[{tag}] >>> 请求 URL: {url} (model={request_model})");
        if log::log_enabled!(log::Level::Debug) {
            if let Ok(body_str) = serde_json::to_string(&filtered_body) {
                log::debug!(
                    "[{tag}] >>> 请求体内容 ({}字节): {}",
                    body_str.len(),
                    body_str
                );
            }
        }

        // 确定超时
        let timeout = if self.non_streaming_timeout.is_zero() {
            std::time::Duration::from_secs(600) // 默认 600 秒
        } else {
            self.non_streaming_timeout
        };

        // 获取全局代理 URL
        let upstream_proxy_url: Option<String> = super::http_client::get_current_proxy_url();

        // SOCKS5 代理不支持 CONNECT 隧道，需要用 reqwest
        let is_socks_proxy = upstream_proxy_url
            .as_deref()
            .map(|u| u.starts_with("socks5"))
            .unwrap_or(false);

        let preserve_exact_header_case = should_preserve_exact_header_case(
            adapter.name(),
            provider,
            resolved_claude_api_format.as_deref(),
            is_copilot,
        );

        // 发送请求
        let response = if is_socks_proxy || !preserve_exact_header_case {
            // OpenAI / Copilot / Codex 类后端不依赖原始 header 大小写；走 reqwest
            // 连接池，避免 raw TCP/TLS path 每次请求都重新握手。SOCKS5 也只能走 reqwest。
            log::debug!(
                "[Forwarder] Using pooled reqwest client (preserve_exact_header_case={preserve_exact_header_case}, socks_proxy={is_socks_proxy})"
            );
            let client = super::http_client::get();
            let mut request = client.request(method.clone(), &url);
            if request_is_streaming {
                // reqwest 的 timeout 是整请求超时；流式请求交给 response_processor
                // 的首包/静默期超时控制，避免长流被总时长误杀。
                request = request.timeout(std::time::Duration::from_secs(24 * 60 * 60));
            } else if !self.non_streaming_timeout.is_zero() {
                request = request.timeout(self.non_streaming_timeout);
            }
            for (key, value) in &ordered_headers {
                request = request.header(key, value);
            }
            let send = request.body(body_bytes).send();
            let send_result = if request_is_streaming {
                let header_timeout = if self.streaming_first_byte_timeout.is_zero() {
                    timeout
                } else {
                    self.streaming_first_byte_timeout
                };
                tokio::time::timeout(header_timeout, send)
                    .await
                    .map_err(|_| {
                        ProxyError::Timeout(format!(
                            "流式响应首包超时: {}s（上游未返回响应头）",
                            header_timeout.as_secs()
                        ))
                    })?
            } else {
                send.await
            };
            let reqwest_resp = send_result.map_err(map_reqwest_send_error)?;
            ProxyResponse::Reqwest(reqwest_resp)
        } else {
            // HTTP 代理或直连：走 hyper raw write（保持 header 大小写）
            // 如果有 HTTP 代理，hyper_client 会用 CONNECT 隧道穿过代理
            let uri: http::Uri = url
                .parse()
                .map_err(|e| ProxyError::ForwardFailed(format!("Invalid URL '{url}': {e}")))?;
            super::hyper_client::send_request(
                uri,
                method.clone(),
                ordered_headers,
                extensions.clone(),
                body_bytes,
                timeout,
                upstream_proxy_url.as_deref(),
            )
            .await?
        };

        // 检查响应状态
        let status = response.status();

        if status.is_success() {
            let response = self
                .prepare_success_response_for_failover(response, request_is_streaming)
                .await?;
            Ok((response, resolved_claude_api_format, outbound_model))
        } else {
            let status_code = status.as_u16();
            // 错误响应同样可能被上游压缩（content-encoding）。reqwest 未启用任何
            // 自动解压 feature，这里拿到的是原始字节；不解压的话，压缩过的错误体会
            // 在 from_utf8 处变成非 UTF-8 而被丢弃，隐藏掉上游的限流/鉴权等详情。
            let retry_after_ms = retry_after_ms_from_headers(response.headers());
            let encoding = get_content_encoding(response.headers());
            let raw = response.bytes().await?;
            let decoded = match encoding {
                Some(encoding) => match decompress_body(&encoding, &raw) {
                    Ok(Some(decompressed)) => decompressed,
                    // 不支持的编码 / 解压失败：退回原始字节，尽量保留可读信息
                    _ => raw.to_vec(),
                },
                None => raw.to_vec(),
            };
            let body_text = String::from_utf8(decoded).ok();

            Err(ProxyError::UpstreamError {
                status: status_code,
                body: body_text,
                retry_after_ms,
            })
        }
    }

    /// 故障转移开启时，成功不能只看上游响应头。
    ///
    /// - 非流式：先把完整 body 读到内存，读超时/连接中断会回到 retry loop 尝试下一家。
    /// - 流式：至少等首个 chunk 到达，避免上游返回 200 后一直不吐 SSE 时被误记成功。
    async fn prepare_success_response_for_failover(
        &self,
        response: ProxyResponse,
        request_is_streaming: bool,
    ) -> Result<ProxyResponse, ProxyError> {
        if request_is_streaming {
            return self.prime_streaming_response(response).await;
        }

        if self.non_streaming_timeout.is_zero() {
            return Ok(response);
        }

        let status = response.status();
        let headers = response.headers().clone();
        let body_timeout = self.non_streaming_timeout;
        let body = tokio::time::timeout(body_timeout, response.bytes())
            .await
            .map_err(|_| {
                ProxyError::Timeout(format!(
                    "响应体读取超时: {}s（上游发完响应头后 body 未到达）",
                    body_timeout.as_secs()
                ))
            })??;

        Ok(ProxyResponse::buffered(status, headers, body))
    }

    async fn prime_streaming_response(
        &self,
        response: ProxyResponse,
    ) -> Result<ProxyResponse, ProxyError> {
        if self.streaming_first_byte_timeout.is_zero() {
            return Ok(response);
        }

        let status = response.status();
        let headers = response.headers().clone();
        let timeout = self.streaming_first_byte_timeout;
        let mut stream = Box::pin(response.bytes_stream());

        let first = tokio::time::timeout(timeout, stream.next())
            .await
            .map_err(|_| {
                ProxyError::Timeout(format!(
                    "流式响应首包超时: {}s（上游已返回响应头但未返回数据）",
                    timeout.as_secs()
                ))
            })?;

        let Some(first) = first else {
            return Err(ProxyError::ForwardFailed(
                "流式响应在首包到达前结束".to_string(),
            ));
        };

        let first =
            first.map_err(|e| ProxyError::ForwardFailed(format!("读取流式响应首包失败: {e}")))?;

        let replay = futures::stream::once(async move { Ok(first) }).chain(stream);
        Ok(ProxyResponse::streamed(status, headers, replay))
    }

    async fn resolve_claude_api_format(
        &self,
        provider: &Provider,
        body: &Value,
        is_copilot: bool,
    ) -> String {
        if !is_copilot {
            return super::providers::get_claude_api_format(provider).to_string();
        }

        let model = body.get("model").and_then(|value| value.as_str());
        if let Some(model_id) = model {
            if self
                .is_copilot_openai_vendor_model(provider, model_id)
                .await
            {
                return "openai_responses".to_string();
            }
        }

        "openai_chat".to_string()
    }

    /// 用 Copilot live `/models` 列表确认 model ID 真实可用，找不到时按 family 降级。
    /// 命中缓存后是同步的；首次请求或 5 min 缓存过期后会触发一次 HTTP。
    async fn apply_copilot_live_model_resolution(
        &self,
        provider: &Provider,
        body: &mut serde_json::Value,
    ) {
        let Some(model_id) = body.get("model").and_then(|v| v.as_str()) else {
            return;
        };
        let model_id = model_id.to_string();

        let Some(app_handle) = &self.app_handle else {
            return;
        };
        let copilot_state = app_handle.state::<CopilotAuthState>();
        let copilot_auth = copilot_state.0.read().await;
        let account_id = provider
            .meta
            .as_ref()
            .and_then(|m| m.managed_account_id_for("github_copilot"));

        let models_result = match account_id.as_deref() {
            Some(id) => copilot_auth.fetch_models_for_account(id).await,
            None => copilot_auth.fetch_models().await,
        };

        let models = match models_result {
            Ok(m) => m,
            Err(err) => {
                log::debug!("[Copilot] live model list unavailable, skip resolution: {err}");
                return;
            }
        };

        if let Some(resolved) =
            super::providers::copilot_model_map::resolve_against_models(&model_id, &models)
        {
            log::info!("[Copilot] live-model resolve: {model_id} → {resolved}");
            body["model"] = serde_json::Value::String(resolved);
        }
    }

    async fn is_copilot_openai_vendor_model(&self, provider: &Provider, model_id: &str) -> bool {
        let Some(app_handle) = &self.app_handle else {
            log::debug!("[Copilot] AppHandle unavailable, fallback to chat/completions");
            return false;
        };

        let copilot_state = app_handle.state::<CopilotAuthState>();
        let copilot_auth = copilot_state.0.read().await;
        let account_id = provider
            .meta
            .as_ref()
            .and_then(|m| m.managed_account_id_for("github_copilot"));

        let vendor_result = match account_id.as_deref() {
            Some(id) => {
                copilot_auth
                    .get_model_vendor_for_account(id, model_id)
                    .await
            }
            None => copilot_auth.get_model_vendor(model_id).await,
        };

        match vendor_result {
            Ok(Some(vendor)) => vendor.eq_ignore_ascii_case("openai"),
            Ok(None) => {
                log::debug!(
                    "[Copilot] Model vendor unavailable for {model_id}, fallback to chat/completions"
                );
                false
            }
            Err(err) => {
                log::warn!(
                    "[Copilot] Failed to resolve model vendor for {model_id}, fallback to chat/completions: {err}"
                );
                false
            }
        }
    }

    fn categorize_proxy_error(
        &self,
        app_type: &AppType,
        endpoint: &str,
        error: &ProxyError,
    ) -> ErrorCategory {
        match error {
            // 网络和上游错误：都应该尝试下一个供应商
            ProxyError::Timeout(_) => ErrorCategory::Retryable,
            ProxyError::ForwardFailed(_) => ErrorCategory::Retryable,
            ProxyError::ProviderUnhealthy(_) => ErrorCategory::Retryable,
            // 上游 HTTP 错误：按状态码分桶。
            //
            // 客户端请求自身有问题的状态码无论换哪个 provider 都会被拒绝，
            // 继续轮询只会放大错误率、污染熔断器健康度、浪费配额：
            //   400 Bad Request / 422 Unprocessable Entity   ← 请求体格式或语义错误
            //   405 Method Not Allowed / 406 Not Acceptable  ← 方法或 Accept 错误
            //   413 Payload Too Large / 414 URI Too Long     ← 客户端构造超限
            //   415 Unsupported Media Type                    ← Content-Type 错误
            //   501 Not Implemented                           ← 上游协议确实不支持
            //
            // 其他 4xx（401/403/404/408/409/429/451 等）和全部 5xx 都保留
            // Retryable —— 换一家 provider 可能持有不同的 key、配额、地域或模型映射。
            ProxyError::UpstreamError { status, body, .. } => {
                if is_codex_compact_provider_capability_error(app_type, endpoint, *status, body) {
                    ErrorCategory::ProviderCapability
                } else {
                    match *status {
                        400 | 405 | 406 | 413 | 414 | 415 | 422 | 501 => {
                            ErrorCategory::NonRetryable
                        }
                        _ => ErrorCategory::Retryable,
                    }
                }
            }
            // Provider 级配置/转换问题：换一个 Provider 可能就能成功
            ProxyError::ConfigError(_) => ErrorCategory::Retryable,
            ProxyError::TransformError(_) => ErrorCategory::Retryable,
            ProxyError::AuthError(_) => ErrorCategory::Retryable,
            ProxyError::StreamIdleTimeout(_) => ErrorCategory::Retryable,
            // 无可用供应商：所有供应商都试过了，无法重试
            ProxyError::NoAvailableProvider => ErrorCategory::NonRetryable,
            // 其他错误（数据库/内部错误等）：不是换供应商能解决的问题
            _ => ErrorCategory::NonRetryable,
        }
    }
}

#[derive(Debug, Clone)]
struct AdmissionRetryPolicy {
    max_retries: Option<u32>,
    initial_delay_ms: u64,
    retry_interval_ms: u64,
    jitter_ms: u64,
}

const MAX_ADMISSION_RETRY_DELAY_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AdmissionRetryDelayPlan {
    target_interval_ms: u64,
    sleep_ms: u64,
    used_retry_after: bool,
}

impl AdmissionRetryPolicy {
    fn from_provider(provider: &Provider) -> Option<Self> {
        let config = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.upstream_admission_retry.as_ref())?;

        if !config.enabled {
            return None;
        }

        let max_retries = config.max_retries.filter(|value| *value > 0);
        let configured_retry_interval_ms = config
            .max_delay_ms
            .map(|value| value.min(MAX_ADMISSION_RETRY_DELAY_MS));
        let initial_delay_ms = config
            .initial_delay_ms
            .map(|value| value.min(MAX_ADMISSION_RETRY_DELAY_MS))
            .or(configured_retry_interval_ms)
            .unwrap_or(1_000)
            .min(MAX_ADMISSION_RETRY_DELAY_MS);
        let retry_interval_ms = configured_retry_interval_ms
            .or(config.initial_delay_ms)
            .unwrap_or(1_000)
            .min(MAX_ADMISSION_RETRY_DELAY_MS);
        let jitter_ms = config.jitter_ms.unwrap_or(100).min(500);

        Some(Self {
            max_retries,
            initial_delay_ms,
            retry_interval_ms,
            jitter_ms,
        })
    }

    fn auto_from_provider_for_error(provider: &Provider, error: &ProxyError) -> Option<Self> {
        let config = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.upstream_admission_retry.as_ref())?;
        if config.enabled || !config.auto_enabled {
            return None;
        }

        let keywords = normalized_admission_retry_keywords(&config.auto_keywords);
        if keywords.is_empty() || !admission_retry_keywords_match_error(&keywords, error) {
            return None;
        }

        let mut enabled_config = config.clone();
        enabled_config.enabled = true;
        let mut enabled_provider = provider.clone();
        enabled_provider
            .meta
            .get_or_insert_with(Default::default)
            .upstream_admission_retry = Some(enabled_config);
        Self::from_provider(&enabled_provider)
    }

    fn retry_limit_reached(&self, retries_used: u32) -> bool {
        self.max_retries
            .is_some_and(|max_retries| retries_used >= max_retries)
    }

    fn plan_delay(
        &self,
        retry_number: u32,
        retry_after_ms: Option<u64>,
        attempt_elapsed_ms: u64,
    ) -> AdmissionRetryDelayPlan {
        let used_retry_after = retry_after_ms.is_some();
        let target_interval_ms = self.delay_ms(retry_number, retry_after_ms);
        let sleep_ms = if used_retry_after {
            target_interval_ms
        } else {
            target_interval_ms.saturating_sub(attempt_elapsed_ms)
        };

        AdmissionRetryDelayPlan {
            target_interval_ms,
            sleep_ms,
            used_retry_after,
        }
    }

    fn delay_ms(&self, retry_number: u32, retry_after_ms: Option<u64>) -> u64 {
        if let Some(retry_after_ms) = retry_after_ms {
            return retry_after_ms.min(MAX_ADMISSION_RETRY_DELAY_MS);
        }

        let base = if retry_number <= 1 {
            self.initial_delay_ms
        } else {
            self.retry_interval_ms
        };
        let jitter = if self.jitter_ms == 0 {
            0
        } else {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.subsec_nanos() as u64 % (self.jitter_ms + 1))
                .unwrap_or(0)
        };

        base.saturating_add(jitter)
            .min(MAX_ADMISSION_RETRY_DELAY_MS)
    }
}

fn normalized_admission_retry_keywords(values: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        let keyword = value.trim().to_lowercase();
        if keyword.is_empty() || result.contains(&keyword) {
            continue;
        }
        result.push(keyword);
    }
    result
}

fn admission_retry_keywords_match_error(keywords: &[String], error: &ProxyError) -> bool {
    let body = match error {
        ProxyError::UpstreamError { body, .. } => body.as_deref().unwrap_or(""),
        _ => "",
    };
    let haystack = format!("{}\n{}", body, summarize_proxy_error(error)).to_lowercase();
    keywords.iter().any(|keyword| haystack.contains(keyword))
}

fn proxy_error_retry_after_ms(error: &ProxyError) -> Option<u64> {
    match error {
        ProxyError::UpstreamError { retry_after_ms, .. } => *retry_after_ms,
        _ => None,
    }
}

fn retry_after_ms_from_headers(headers: &http::HeaderMap) -> Option<u64> {
    let value = headers
        .get(http::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())?
        .trim();
    if value.is_empty() {
        return None;
    }

    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1000));
    }

    let target = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&chrono::Utc);
    let now = chrono::Utc::now();
    if target <= now {
        return Some(0);
    }
    Some(target.signed_duration_since(now).num_milliseconds().max(0) as u64)
}

/// 上游响应体是否表明这是一类“死磕同一家也永远不会成功”的永久失败：
/// 配额/计费、鉴权/权限、模型不存在、上下文超限、请求非法等。
/// 入场重试遇到这些信号会立即中性返回，避免对永久错误无限重试空等。
fn body_signals_permanent_failure(text: &str) -> bool {
    contains_any(
        text,
        &[
            "insufficient_quota",
            "insufficient quota",
            "quota exceeded",
            "billing",
            "credit",
            "payment required",
            "invalid_api_key",
            "invalid api key",
            "unauthorized",
            "forbidden",
            "permission",
            "model_not_found",
            "model not found",
            "context_length",
            "context length",
            "maximum context",
            "too many tokens",
            "unsupported",
            "invalid_request",
            "bad request",
        ],
    )
}

fn should_retry_provider_admission(category: ErrorCategory, error: &ProxyError) -> bool {
    if !matches!(category, ErrorCategory::Retryable) {
        return false;
    }

    match error {
        ProxyError::UpstreamError { body, .. } => {
            !body_signals_permanent_failure(&body.as_deref().unwrap_or("").to_ascii_lowercase())
        }
        _ => true,
    }
}

// 旧的“仅拥挤类错误”判定：入场重试主流程已改用 categorize_proxy_error +
// body_signals_permanent_failure 两道闸门（覆盖范围更广），此处仅保留供单测
// 校验拥挤关键词/状态码的分桶语义。
#[cfg(test)]
fn is_upstream_admission_retryable(error: &ProxyError) -> bool {
    let ProxyError::UpstreamError { status, body, .. } = error else {
        return false;
    };

    let text = body.as_deref().unwrap_or("").to_ascii_lowercase();
    if body_signals_permanent_failure(&text) {
        return false;
    }

    let admission_keywords = [
        "overload",
        "overloaded",
        "capacity",
        "rate limit",
        "rate_limit",
        "too many requests",
        "temporarily unavailable",
        "try again later",
        "busy",
        "throttle",
        "throttled",
        "congestion",
        "high load",
        "upstream load",
        "server is overloaded",
    ];

    match *status {
        429 | 529 => text.is_empty() || contains_any(&text, &admission_keywords),
        503 => text.is_empty() || contains_any(&text, &admission_keywords),
        500 | 502 | 504 => contains_any(&text, &admission_keywords),
        _ => false,
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

/// 从 ProxyError 中提取错误消息
fn extract_error_message(error: &ProxyError) -> Option<String> {
    match error {
        ProxyError::UpstreamError { body, .. } => body.clone(),
        _ => Some(error.to_string()),
    }
}

/// 检测 Provider 是否为 Bedrock（通过 CLAUDE_CODE_USE_BEDROCK 环境变量判断）
fn is_bedrock_provider(provider: &Provider) -> bool {
    provider
        .settings_config
        .get("env")
        .and_then(|e| e.get("CLAUDE_CODE_USE_BEDROCK"))
        .and_then(|v| v.as_str())
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn build_retryable_failure_log(
    provider_name: &str,
    attempted_providers: usize,
    total_providers: usize,
    error: &ProxyError,
) -> (&'static str, String) {
    let error_summary = summarize_proxy_error(error);

    if total_providers <= 1 {
        (
            log_fwd::SINGLE_PROVIDER_FAILED,
            format!("Provider {provider_name} 请求失败: {error_summary}"),
        )
    } else {
        (
            log_fwd::PROVIDER_FAILED_RETRY,
            format!(
                "Provider {provider_name} 失败，继续尝试下一个 ({attempted_providers}/{total_providers}): {error_summary}"
            ),
        )
    }
}

fn build_terminal_failure_log(
    attempted_providers: usize,
    total_providers: usize,
    last_error: Option<&ProxyError>,
) -> Option<(&'static str, String)> {
    if total_providers <= 1 {
        return None;
    }

    let error_summary = last_error
        .map(summarize_proxy_error)
        .unwrap_or_else(|| "未知错误".to_string());

    Some((
        log_fwd::ALL_PROVIDERS_FAILED,
        format!(
            "已尝试 {attempted_providers}/{total_providers} 个 Provider，均失败。最后错误: {error_summary}"
        ),
    ))
}

fn proxy_error_status(error: &ProxyError) -> Option<u16> {
    match error {
        ProxyError::UpstreamError { status, .. } => Some(*status),
        _ => None,
    }
}

fn summarize_proxy_error(error: &ProxyError) -> String {
    match error {
        ProxyError::UpstreamError { status, body, .. } => {
            let body_summary = body
                .as_deref()
                .map(summarize_upstream_body)
                .filter(|summary| !summary.is_empty());

            match body_summary {
                Some(summary) => format!("上游 HTTP {status}: {summary}"),
                None => format!("上游 HTTP {status}"),
            }
        }
        ProxyError::Timeout(message) => {
            format!("请求超时: {}", summarize_text_for_log(message, 180))
        }
        ProxyError::ForwardFailed(message) => {
            format!("请求转发失败: {}", summarize_text_for_log(message, 180))
        }
        ProxyError::TransformError(message) => {
            format!("响应转换失败: {}", summarize_text_for_log(message, 180))
        }
        ProxyError::ConfigError(message) => {
            format!("配置错误: {}", summarize_text_for_log(message, 180))
        }
        ProxyError::AuthError(message) => {
            format!("认证失败: {}", summarize_text_for_log(message, 180))
        }
        _ => summarize_text_for_log(&error.to_string(), 180),
    }
}

fn summarize_upstream_body(body: &str) -> String {
    if let Ok(json_body) = serde_json::from_str::<Value>(body) {
        if let Some(message) = extract_json_error_message(&json_body) {
            return summarize_text_for_log(&message, 180);
        }

        if let Ok(compact_json) = serde_json::to_string(&json_body) {
            return summarize_text_for_log(&compact_json, 180);
        }
    }

    summarize_text_for_log(body, 180)
}

fn extract_json_error_message(body: &Value) -> Option<String> {
    let candidates = [
        body.pointer("/error/message"),
        body.pointer("/message"),
        body.pointer("/detail"),
        body.pointer("/error"),
    ];

    candidates
        .into_iter()
        .flatten()
        .find_map(|value| value.as_str().map(ToString::to_string))
}

fn split_endpoint_and_query(endpoint: &str) -> (&str, Option<&str>) {
    endpoint
        .split_once('?')
        .map_or((endpoint, None), |(path, query)| (path, Some(query)))
}

fn strip_beta_query(query: Option<&str>) -> Option<String> {
    let filtered = query.map(|query| {
        query
            .split('&')
            .filter(|pair| !pair.is_empty() && !pair.starts_with("beta="))
            .collect::<Vec<_>>()
            .join("&")
    });

    match filtered.as_deref() {
        Some("") | None => None,
        Some(_) => filtered,
    }
}

fn is_claude_messages_path(path: &str) -> bool {
    matches!(path, "/v1/messages" | "/claude/v1/messages")
}

fn rewrite_codex_responses_endpoint_to_chat(endpoint: &str) -> (String, Option<String>) {
    let (_path, query) = split_endpoint_and_query(endpoint);
    let passthrough_query = query.map(ToString::to_string);
    let target_path = "/chat/completions";
    let rewritten = match passthrough_query.as_deref() {
        Some(query) if !query.is_empty() => format!("{target_path}?{query}"),
        _ => target_path.to_string(),
    };

    (rewritten, passthrough_query)
}

fn is_codex_responses_compact_endpoint(endpoint: &str) -> bool {
    let (path, _) = split_endpoint_and_query(endpoint);
    let path = path.trim().trim_end_matches('/');
    let path = path.strip_prefix("/codex").unwrap_or(path);

    matches!(
        path,
        "/responses/compact" | "/v1/responses/compact" | "/v1/v1/responses/compact"
    )
}

fn is_codex_compact_provider_capability_error(
    app_type: &AppType,
    endpoint: &str,
    status: u16,
    body: &Option<String>,
) -> bool {
    if !matches!(app_type, AppType::Codex) || !is_codex_responses_compact_endpoint(endpoint) {
        return false;
    }

    if matches!(status, 404 | 405 | 501) {
        return true;
    }

    if !matches!(status, 400 | 422 | 502) {
        return false;
    }

    let Some(body) = body.as_deref() else {
        return false;
    };
    let body = body.to_ascii_lowercase();
    let mentions_compact = body.contains("responses_compact")
        || body.contains("responses/compact")
        || body.contains("response compact")
        || body.contains("compact");
    let mentions_capability = body.contains("api_format")
        || body.contains("no candidate")
        || body.contains("not found")
        || body.contains("not supported")
        || body.contains("unsupported")
        || body.contains("not implemented")
        || body.contains("does not support")
        || body.contains("unavailable");
    let mentions_model_missing = body.contains("model")
        && (body.contains("not found")
            || body.contains("not available")
            || body.contains("unknown model"));

    (mentions_compact && mentions_capability) || mentions_model_missing
}

fn rewrite_claude_transform_endpoint(
    endpoint: &str,
    api_format: &str,
    is_copilot: bool,
    body: &Value,
) -> (String, Option<String>) {
    let (path, query) = split_endpoint_and_query(endpoint);
    let passthrough_query = if is_claude_messages_path(path) {
        strip_beta_query(query)
    } else {
        query.map(ToString::to_string)
    };

    if !is_claude_messages_path(path) {
        return (endpoint.to_string(), passthrough_query);
    }

    if api_format == "gemini_native" {
        let model =
            super::providers::transform_gemini::extract_gemini_model(body).unwrap_or("unknown");
        // Accept both bare ids (`gemini-2.5-pro`) and the resource-name
        // form (`models/gemini-2.5-pro`) that Gemini SDKs emit. See
        // `normalize_gemini_model_id` for rationale.
        let model = super::gemini_url::normalize_gemini_model_id(model);
        let is_stream = body
            .get("stream")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let target_path = if is_stream {
            format!("/v1beta/models/{model}:streamGenerateContent")
        } else {
            format!("/v1beta/models/{model}:generateContent")
        };

        let rewritten_query = merge_query_params(
            passthrough_query.as_deref(),
            if is_stream { Some("alt=sse") } else { None },
        );

        let rewritten = match rewritten_query.as_deref() {
            Some(query) if !query.is_empty() => format!("{target_path}?{query}"),
            _ => target_path,
        };

        return (rewritten, rewritten_query);
    }

    let target_path = if is_copilot && api_format == "openai_responses" {
        "/v1/responses"
    } else if is_copilot {
        "/chat/completions"
    } else if api_format == "openai_responses" {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };

    let rewritten = match passthrough_query.as_deref() {
        Some(query) if !query.is_empty() => format!("{target_path}?{query}"),
        _ => target_path.to_string(),
    };

    (rewritten, passthrough_query)
}

fn merge_query_params(base_query: Option<&str>, extra_param: Option<&str>) -> Option<String> {
    let mut params: Vec<String> = base_query
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter(|pair| !pair.is_empty())
        .filter(|pair| !pair.starts_with("alt="))
        .map(ToString::to_string)
        .collect();

    if let Some(extra_param) = extra_param {
        params.push(extra_param.to_string());
    }

    if params.is_empty() {
        None
    } else {
        Some(params.join("&"))
    }
}

fn apply_scoped_model_mapping(
    app_type_str: &str,
    body: Value,
    provider: &Provider,
) -> (Value, Option<String>, Option<String>) {
    if app_type_str.eq_ignore_ascii_case(AppType::Codex.as_str()) {
        return super::model_mapper::apply_codex_model_mapping(body, provider);
    }

    if app_type_str.eq_ignore_ascii_case(AppType::Claude.as_str()) {
        return super::model_mapper::apply_model_mapping(body, provider);
    }

    let original = body.get("model").and_then(|m| m.as_str()).map(String::from);
    (body, original, None)
}

fn normalize_activity_model(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("unknown") {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn activity_project_path(headers: &http::HeaderMap, body: &Value) -> Option<String> {
    const HEADER_CANDIDATES: &[&str] = &[
        "x-cc-switch-project-path",
        "x-cc-switch-cwd",
        "x-project-path",
        "x-workspace-path",
        "x-working-directory",
        "x-cwd",
    ];

    HEADER_CANDIDATES
        .iter()
        .find_map(|name| header_text(headers, name))
        .or_else(|| {
            json_text_candidates(
                body,
                &[
                    "cwd",
                    "project_path",
                    "projectPath",
                    "workspace",
                    "workspacePath",
                    "working_directory",
                    "workingDirectory",
                ],
            )
        })
        .or_else(|| extract_project_path_from_request_text(body))
        .map(normalize_project_path_text)
        .filter(|value| !value.is_empty())
}

fn activity_project_name(project_path: Option<&str>) -> Option<String> {
    let path = project_path?.trim().trim_matches('"').trim_matches('\'');
    if path.is_empty() {
        return None;
    }

    path.rsplit(['\\', '/'])
        .find(|segment| !segment.trim().is_empty())
        .map(|segment| segment.trim().to_string())
}

fn activity_project_name_from_request(headers: &http::HeaderMap, body: &Value) -> Option<String> {
    const HEADER_CANDIDATES: &[&str] = &[
        "x-cc-switch-project",
        "x-cc-switch-project-name",
        "x-project",
        "x-project-name",
        "x-workspace-name",
    ];

    HEADER_CANDIDATES
        .iter()
        .find_map(|name| header_text(headers, name))
        .or_else(|| {
            json_text_candidates(
                body,
                &[
                    "project",
                    "project_name",
                    "projectName",
                    "workspace_name",
                    "workspaceName",
                ],
            )
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn header_text(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn json_text_candidates(body: &Value, keys: &[&str]) -> Option<String> {
    fn visit(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
        if depth > 8 {
            return None;
        }

        match value {
            Value::Object(map) => {
                for key in keys {
                    if let Some(text) = map
                        .get(*key)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        return Some(text.to_string());
                    }
                }

                map.values()
                    .find_map(|value| visit(value, keys, depth.saturating_add(1)))
            }
            Value::Array(values) => values
                .iter()
                .find_map(|value| visit(value, keys, depth.saturating_add(1))),
            _ => None,
        }
    }

    visit(body, keys, 0)
}

fn extract_project_path_from_request_text(body: &Value) -> Option<String> {
    collect_short_texts(body, 24)
        .into_iter()
        .find_map(|text| extract_project_path_from_text(&text))
}

fn collect_short_texts(value: &Value, limit: usize) -> Vec<String> {
    fn visit(value: &Value, limit: usize, out: &mut Vec<String>) {
        if out.len() >= limit {
            return;
        }

        match value {
            Value::String(text) => {
                if text.len() <= 16_384 {
                    out.push(text.clone());
                }
            }
            Value::Array(values) => {
                for value in values {
                    visit(value, limit, out);
                    if out.len() >= limit {
                        break;
                    }
                }
            }
            Value::Object(map) => {
                for value in map.values() {
                    visit(value, limit, out);
                    if out.len() >= limit {
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    let mut out = Vec::new();
    visit(value, limit, &mut out);
    out
}

fn extract_project_path_from_text(text: &str) -> Option<String> {
    extract_between(text, "<cwd>", "</cwd>")
        .or_else(|| extract_between(text, "\"cwd\":\"", "\""))
        .or_else(|| extract_after_label(text, "cwd:"))
        .or_else(|| extract_after_label(text, "cwd ="))
        .or_else(|| extract_after_label(text, "current working directory:"))
        .or_else(|| extract_after_label(text, "working directory:"))
        .or_else(|| extract_after_label(text, "workspace:"))
        .map(normalize_project_path_text)
        .filter(|value| !value.is_empty())
}

fn extract_between(text: &str, start: &str, end: &str) -> Option<String> {
    let start_index = text.find(start)? + start.len();
    let rest = &text[start_index..];
    let end_index = rest.find(end)?;
    Some(rest[..end_index].to_string())
}

fn extract_after_label(text: &str, label: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let index = lower.find(&label.to_ascii_lowercase())? + label.len();
    let rest = text[index..].trim_start();
    let line = rest
        .lines()
        .next()
        .unwrap_or(rest)
        .trim()
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    (!line.is_empty()).then(|| line.to_string())
}

fn normalize_project_path_text(value: String) -> String {
    value
        .trim()
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'')
        .replace("\\\\", "\\")
}

fn provider_default_model(app_type_str: &str, provider: &Provider) -> Option<String> {
    let settings = &provider.settings_config;

    if app_type_str.eq_ignore_ascii_case(AppType::Claude.as_str()) {
        return settings
            .pointer("/env/ANTHROPIC_MODEL")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }

    if app_type_str.eq_ignore_ascii_case(AppType::Codex.as_str()) {
        if let Some(model) = settings
            .get("model")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(model.to_string());
        }

        let config = settings.get("config")?;
        if let Some(model) = config
            .get("model")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(model.to_string());
        }

        let config_text = config.as_str()?;
        let doc = config_text.parse::<toml_edit::DocumentMut>().ok()?;
        return doc
            .get("model")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }

    None
}

fn apply_provider_default_model_if_missing(
    app_type_str: &str,
    mut body: Value,
    provider: &Provider,
) -> (Value, Option<String>) {
    let Some(body_obj) = body.as_object_mut() else {
        return (body, None);
    };

    if body_obj
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return (body, None);
    }

    let Some(model) = provider_default_model(app_type_str, provider) else {
        return (body, None);
    };

    body_obj.insert(
        "model".to_string(),
        serde_json::Value::String(model.clone()),
    );
    (body, Some(model))
}

fn append_query_to_full_url(base_url: &str, query: Option<&str>) -> String {
    match query {
        Some(query) if !query.is_empty() => {
            if base_url.contains('?') {
                format!("{base_url}&{query}")
            } else {
                format!("{base_url}?{query}")
            }
        }
        _ => base_url.to_string(),
    }
}

fn sanitize_activity_upstream_url(raw_url: &str) -> String {
    let sensitive_query_keys = [
        "key",
        "api_key",
        "apikey",
        "access_token",
        "token",
        "auth",
        "authorization",
    ];

    let Ok(mut url) = url::Url::parse(raw_url) else {
        return raw_url
            .split_once('?')
            .map(|(path, _)| format!("{path}?***"))
            .unwrap_or_else(|| raw_url.to_string());
    };

    if !url.username().is_empty() {
        let _ = url.set_username("");
    }
    if url.password().is_some() {
        let _ = url.set_password(None);
    }

    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| {
                let sanitized_value = if sensitive_query_keys
                    .iter()
                    .any(|sensitive| key.eq_ignore_ascii_case(sensitive))
                {
                    "***".to_string()
                } else {
                    value.into_owned()
                };
                (key.into_owned(), sanitized_value)
            })
            .collect();
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }

    url.to_string()
}

fn build_codex_oauth_session_headers(
    session_id: &str,
) -> Vec<(http::HeaderName, http::HeaderValue)> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Vec::new();
    }

    let mut headers = Vec::new();
    if let Ok(value) = http::HeaderValue::from_str(session_id) {
        headers.push((http::HeaderName::from_static("session_id"), value.clone()));
        headers.push((http::HeaderName::from_static("x-client-request-id"), value));
    }

    let window_id = format!("{session_id}:0");
    if let Ok(value) = http::HeaderValue::from_str(&window_id) {
        headers.push((http::HeaderName::from_static("x-codex-window-id"), value));
    }

    headers
}

fn reject_proxy_placeholder_for_managed_account_upstream(
    url: &str,
    headers: &http::HeaderMap,
) -> Result<(), ProxyError> {
    if !is_managed_account_upstream_url(url) || !headers_contain_proxy_placeholder(headers) {
        return Ok(());
    }

    Err(ProxyError::AuthError(
        "Managed account proxy auth was not resolved; PROXY_MANAGED must not be sent upstream"
            .to_string(),
    ))
}

fn is_managed_account_upstream_url(url: &str) -> bool {
    let Ok(uri) = url.parse::<http::Uri>() else {
        return false;
    };

    let Some(host) = uri.host().map(str::to_ascii_lowercase) else {
        return false;
    };

    host == "githubcopilot.com"
        || host.ends_with(".githubcopilot.com")
        || (host == "chatgpt.com" && uri.path().starts_with("/backend-api/codex"))
}

fn headers_contain_proxy_placeholder(headers: &http::HeaderMap) -> bool {
    headers.values().any(|value| {
        value
            .to_str()
            .map(|value| value.contains(PROXY_AUTH_PLACEHOLDER))
            .unwrap_or(false)
    })
}

fn should_preserve_exact_header_case(
    adapter_name: &str,
    provider: &Provider,
    resolved_claude_api_format: Option<&str>,
    is_copilot: bool,
) -> bool {
    if matches!(adapter_name, "Codex" | "Gemini") {
        return false;
    }

    if is_copilot || provider.is_codex_oauth() {
        return false;
    }

    matches!(resolved_claude_api_format, None | Some("anthropic"))
}

fn is_streaming_request(endpoint: &str, body: &Value, headers: &axum::http::HeaderMap) -> bool {
    if body
        .get("stream")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return true;
    }

    if endpoint.contains("streamGenerateContent") || endpoint.contains("alt=sse") {
        return true;
    }

    headers
        .get(axum::http::header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .map(|accept| accept.contains("text/event-stream"))
        .unwrap_or(false)
}

fn should_force_identity_encoding(
    endpoint: &str,
    body: &Value,
    headers: &axum::http::HeaderMap,
) -> bool {
    is_streaming_request(endpoint, body, headers)
}

fn map_reqwest_send_error(error: reqwest::Error) -> ProxyError {
    if error.is_timeout() {
        ProxyError::Timeout(format!("请求超时: {error}"))
    } else if error.is_connect() {
        ProxyError::ForwardFailed(format!("连接失败: {error}"))
    } else {
        ProxyError::ForwardFailed(error.to_string())
    }
}

fn summarize_text_for_log(text: &str, max_chars: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = normalized.trim();

    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let truncated: String = trimmed.chars().take(max_chars).collect();
    let truncated = truncated.trim_end();
    format!("{truncated}...")
}

fn apply_local_proxy_body_overrides(
    body: &mut Value,
    overrides: &LocalProxyRequestOverrides,
) -> bool {
    let Some(override_body) = overrides.body.as_ref() else {
        return false;
    };

    if !override_body.is_object() {
        log::warn!("[LocalProxyOverrides] Ignoring body override because it is not an object");
        return false;
    }

    merge_json_override(body, override_body)
}

fn merge_json_override(target: &mut Value, patch: &Value) -> bool {
    merge_json_override_inner(target, patch, true)
}

fn merge_json_override_inner(target: &mut Value, patch: &Value, is_top_level: bool) -> bool {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            let mut changed = false;
            for (key, patch_value) in patch_map {
                if is_top_level && key == "stream" {
                    log::warn!(
                        "[LocalProxyOverrides] Ignoring body override for protected field: stream"
                    );
                    continue;
                }
                match target_map.get_mut(key) {
                    Some(target_value) => {
                        changed |= merge_json_override_inner(target_value, patch_value, false);
                    }
                    None => {
                        target_map.insert(key.clone(), patch_value.clone());
                        changed = true;
                    }
                }
            }
            changed
        }
        (target_value, patch_value) => {
            if target_value == patch_value {
                false
            } else {
                *target_value = patch_value.clone();
                true
            }
        }
    }
}

fn apply_local_proxy_header_overrides(
    headers: &mut http::HeaderMap,
    overrides: Option<&LocalProxyRequestOverrides>,
    is_copilot: bool,
) {
    if is_copilot {
        return;
    }

    let Some(header_overrides) = overrides.map(|overrides| &overrides.headers) else {
        return;
    };

    for (raw_name, raw_value) in header_overrides {
        let header_name = raw_name.trim().to_ascii_lowercase();
        if header_name.is_empty() {
            log::warn!("[LocalProxyOverrides] Ignoring header override with empty name");
            continue;
        }

        let Ok(name) = http::HeaderName::from_bytes(header_name.as_bytes()) else {
            log::warn!("[LocalProxyOverrides] Ignoring invalid header override name: {raw_name}");
            continue;
        };

        if is_protected_local_proxy_override_header(&name) {
            log::debug!(
                "[LocalProxyOverrides] Ignoring protected header override: {}",
                name.as_str()
            );
            continue;
        }

        let Ok(value) = http::HeaderValue::from_str(raw_value) else {
            log::warn!(
                "[LocalProxyOverrides] Ignoring invalid header override value for {}",
                name.as_str()
            );
            continue;
        };

        headers.insert(name, value);
    }
}

fn is_protected_local_proxy_override_header(name: &http::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "te"
            | "trailer"
            | "upgrade"
            | "accept-encoding"
            | "content-type"
            | "authorization"
            | "x-api-key"
            | "x-goog-api-key"
            | "chatgpt-account-id"
            | "session_id"
            | "x-client-request-id"
            | "x-codex-window-id"
            | "x-forwarded-host"
            | "x-forwarded-port"
            | "x-forwarded-proto"
            | "forwarded"
            | "cf-connecting-ip"
            | "cf-ipcountry"
            | "cf-ray"
            | "cf-visitor"
            | "true-client-ip"
            | "fastly-client-ip"
            | "x-azure-clientip"
            | "x-azure-fdid"
            | "x-azure-ref"
            | "akamai-origin-hop"
            | "x-akamai-config-log-detail"
            | "x-request-id"
            | "x-correlation-id"
            | "x-trace-id"
            | "x-amzn-trace-id"
            | "x-b3-traceid"
            | "x-b3-spanid"
            | "x-b3-parentspanid"
            | "x-b3-sampled"
            | "traceparent"
            | "tracestate"
    )
}

fn prepare_upstream_request_body(request_body: Value) -> Value {
    canonicalize_value(filter_private_params_with_whitelist(request_body, &[]))
}

fn log_prompt_cache_trace(
    app_type: &AppType,
    provider: &Provider,
    endpoint: &str,
    api_format: Option<&str>,
    body: &Value,
    session_client_provided: bool,
) {
    if !log::log_enabled!(log::Level::Debug) {
        return;
    }

    let prompt_cache_key = body
        .get("prompt_cache_key")
        .and_then(|value| value.as_str())
        .map(|key| format!("present(len={})", key.len()))
        .unwrap_or_else(|| "absent".to_string());
    let store = body
        .get("store")
        .map(value_for_log)
        .unwrap_or_else(|| "absent".to_string());
    let stream = body
        .get("stream")
        .map(value_for_log)
        .unwrap_or_else(|| "absent".to_string());

    log::debug!(
        "[CacheTrace] app={}, provider={}, endpoint={}, api_format={}, session_client_provided={}, prompt_cache_key={}, store={}, stream={}, instructions_hash={}, tools_hash={}, input_hash={}, include_hash={}, body_hash={}",
        app_type.as_str(),
        provider.id,
        endpoint,
        api_format.unwrap_or("native"),
        session_client_provided,
        prompt_cache_key,
        store,
        stream,
        short_value_hash(body.get("instructions")),
        short_value_hash(body.get("tools")),
        short_value_hash(body.get("input")),
        short_value_hash(body.get("include")),
        short_value_hash(Some(body)),
    );
}

fn value_for_log(value: &Value) -> String {
    match value {
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Null => "null".to_string(),
        Value::Array(values) => format!("array(len={})", values.len()),
        Value::Object(values) => format!("object(len={})", values.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::provider::{LocalProxyRequestOverrides, ProviderMeta, UpstreamAdmissionRetryConfig};
    use crate::proxy::CircuitBreakerConfig;
    use axum::http::header::{HeaderValue, ACCEPT};
    use axum::http::HeaderMap;
    use bytes::Bytes;
    use http::StatusCode;
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::Duration;

    fn test_provider_with_type(provider_type: Option<&str>) -> Provider {
        Provider {
            id: "provider-1".to_string(),
            name: "Provider 1".to_string(),
            settings_config: json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: provider_type.map(|value| crate::provider::ProviderMeta {
                provider_type: Some(value.to_string()),
                ..Default::default()
            }),
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }
    }

    fn test_forwarder(
        non_streaming_timeout: Duration,
        streaming_first_byte_timeout: Duration,
    ) -> RequestForwarder {
        let db = Arc::new(Database::memory().expect("memory db"));

        RequestForwarder {
            router: Arc::new(ProviderRouter::new(db.clone())),
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            current_providers: Arc::new(RwLock::new(HashMap::new())),
            proxy_activity: Arc::new(RwLock::new(ProxyActivityState::default())),
            gemini_shadow: Arc::new(GeminiShadowStore::new()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            failover_manager: Arc::new(FailoverSwitchManager::new(db)),
            app_handle: None,
            current_provider_id_at_start: String::new(),
            request_id: "test-request".to_string(),
            request_model: "test-model".to_string(),
            session_id: String::new(),
            session_client_provided: false,
            rectifier_config: RectifierConfig::default(),
            optimizer_config: OptimizerConfig::default(),
            copilot_optimizer_config: CopilotOptimizerConfig::default(),
            non_streaming_timeout,
            streaming_first_byte_timeout,
            max_attempts: 1,
            switch_epoch: Arc::new(RwLock::new(HashMap::new())),
            request_epoch: 0,
            auto_failover_enabled_at_start: false,
        }
    }

    fn test_forwarder_with_router(
        router: Arc<ProviderRouter>,
        db: Arc<Database>,
        auto_failover_enabled_at_start: bool,
    ) -> RequestForwarder {
        RequestForwarder {
            router,
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            current_providers: Arc::new(RwLock::new(HashMap::new())),
            proxy_activity: Arc::new(RwLock::new(ProxyActivityState::default())),
            gemini_shadow: Arc::new(GeminiShadowStore::new()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            failover_manager: Arc::new(FailoverSwitchManager::new(db)),
            app_handle: None,
            current_provider_id_at_start: String::new(),
            request_id: "test-request".to_string(),
            request_model: "test-model".to_string(),
            session_id: String::new(),
            session_client_provided: false,
            rectifier_config: RectifierConfig::default(),
            optimizer_config: OptimizerConfig::default(),
            copilot_optimizer_config: CopilotOptimizerConfig::default(),
            non_streaming_timeout: Duration::from_secs(1),
            streaming_first_byte_timeout: Duration::from_secs(1),
            max_attempts: 1,
            switch_epoch: Arc::new(RwLock::new(HashMap::new())),
            request_epoch: 0,
            auto_failover_enabled_at_start,
        }
    }

    #[test]
    fn single_provider_retryable_log_uses_single_provider_code() {
        let error = ProxyError::UpstreamError {
            status: 429,
            body: Some(r#"{"error":{"message":"rate limit exceeded"}}"#.to_string()),

            retry_after_ms: None,
        };

        let (code, message) = build_retryable_failure_log("PackyCode-response", 1, 1, &error);

        assert_eq!(code, log_fwd::SINGLE_PROVIDER_FAILED);
        assert!(message.contains("Provider PackyCode-response 请求失败"));
        assert!(message.contains("上游 HTTP 429"));
        assert!(message.contains("rate limit exceeded"));
        assert!(!message.contains("切换下一个"));
    }

    #[test]
    fn multi_provider_retryable_log_keeps_failover_wording() {
        let error = ProxyError::Timeout("upstream timed out after 30s".to_string());

        let (code, message) = build_retryable_failure_log("primary", 1, 3, &error);

        assert_eq!(code, log_fwd::PROVIDER_FAILED_RETRY);
        assert!(message.contains("继续尝试下一个 (1/3)"));
        assert!(message.contains("请求超时"));
    }

    #[test]
    fn single_provider_has_no_terminal_all_failed_log() {
        assert!(build_terminal_failure_log(1, 1, None).is_none());
    }

    #[test]
    fn multi_provider_terminal_log_contains_last_error_summary() {
        let error = ProxyError::ForwardFailed("connection reset by peer".to_string());

        let (code, message) =
            build_terminal_failure_log(2, 2, Some(&error)).expect("expected terminal log");

        assert_eq!(code, log_fwd::ALL_PROVIDERS_FAILED);
        assert!(message.contains("已尝试 2/2 个 Provider，均失败"));
        assert!(message.contains("connection reset by peer"));
    }

    #[test]
    fn upstream_admission_retry_matches_capacity_errors_only() {
        let overloaded = ProxyError::UpstreamError {
            status: 503,
            body: Some(r#"{"error":{"message":"server is overloaded"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert!(is_upstream_admission_retryable(&overloaded));

        let rate_limited = ProxyError::UpstreamError {
            status: 429,
            body: Some(r#"{"error":{"message":"rate limit reached"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert!(is_upstream_admission_retryable(&rate_limited));

        let gateway_capacity = ProxyError::UpstreamError {
            status: 502,
            body: Some(
                r#"{"error":{"message":"upstream capacity temporarily unavailable"}}"#.to_string(),
            ),

            retry_after_ms: None,
        };
        assert!(is_upstream_admission_retryable(&gateway_capacity));

        let quota = ProxyError::UpstreamError {
            status: 429,
            body: Some(r#"{"error":{"code":"insufficient_quota"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert!(!is_upstream_admission_retryable(&quota));

        let invalid_model = ProxyError::UpstreamError {
            status: 404,
            body: Some(r#"{"error":{"message":"model not found"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert!(!is_upstream_admission_retryable(&invalid_model));
    }

    #[test]
    fn body_permanent_failure_signals_block_admission_retry() {
        // 永久失败信号：死磕同一家也不会成功，入场重试必须放行回原流程。
        for body in [
            r#"{"error":{"code":"insufficient_quota"}}"#,
            r#"{"error":{"message":"invalid api key"}}"#,
            r#"{"error":{"message":"model not found"}}"#,
            r#"{"error":{"message":"context length exceeded"}}"#,
            r#"{"error":{"message":"payment required"}}"#,
        ] {
            assert!(
                body_signals_permanent_failure(&body.to_ascii_lowercase()),
                "expected permanent-failure signal for body: {body}"
            );
        }

        // 临时拥挤/容量类响应不应被永久失败信号误伤。
        for body in [
            r#"{"error":{"message":"server is overloaded"}}"#,
            r#"{"error":{"message":"rate limit reached"}}"#,
            r#"{"error":{"message":"please try again later"}}"#,
            "",
        ] {
            assert!(
                !body_signals_permanent_failure(&body.to_ascii_lowercase()),
                "transient body should not be flagged permanent: {body}"
            );
        }
    }

    #[test]
    fn admission_retry_decision_retries_transient_errors_only() {
        let transient_errors = [
            ProxyError::Timeout("upstream timed out".to_string()),
            ProxyError::ForwardFailed("connection reset by peer".to_string()),
            ProxyError::UpstreamError {
                status: 502,
                body: Some(r#"{"error":{"message":"temporary gateway failure"}}"#.to_string()),

                retry_after_ms: None,
            },
            ProxyError::UpstreamError {
                status: 429,
                body: Some(r#"{"error":{"message":"rate limit reached"}}"#.to_string()),

                retry_after_ms: None,
            },
        ];

        for error in transient_errors {
            assert!(
                should_retry_provider_admission(ErrorCategory::Retryable, &error),
                "transient error should stay inside admission retry: {error}"
            );
        }

        let permanent_upstream = ProxyError::UpstreamError {
            status: 429,
            body: Some(r#"{"error":{"code":"insufficient_quota"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert!(!should_retry_provider_admission(
            ErrorCategory::Retryable,
            &permanent_upstream,
        ));

        let non_retryable = ProxyError::UpstreamError {
            status: 400,
            body: Some(r#"{"error":{"message":"invalid request"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert!(!should_retry_provider_admission(
            ErrorCategory::NonRetryable,
            &non_retryable,
        ));

        let provider_capability = ProxyError::UpstreamError {
            status: 404,
            body: Some(r#"{"error":{"message":"Cannot POST /v1/responses/compact"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert!(!should_retry_provider_admission(
            ErrorCategory::ProviderCapability,
            &provider_capability,
        ));
    }

    #[test]
    fn admission_retry_policy_normalizes_timing_and_zero_means_unlimited() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(0),
                initial_delay_ms: Some(20_000),
                max_delay_ms: Some(100),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });

        let policy = AdmissionRetryPolicy::from_provider(&provider).expect("retry policy");

        assert_eq!(policy.max_retries, None);
        assert!(!policy.retry_limit_reached(u32::MAX));
        assert_eq!(policy.initial_delay_ms, 20_000);
        assert_eq!(policy.retry_interval_ms, 100);
        assert_eq!(policy.jitter_ms, 0);
        assert_eq!(policy.delay_ms(1, None), 20_000);
        assert_eq!(policy.delay_ms(2, None), 100);
        assert_eq!(policy.delay_ms(99, None), 100);
    }

    #[test]
    fn admission_retry_policy_uses_retry_interval_when_initial_wait_is_empty() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(0),
                initial_delay_ms: None,
                max_delay_ms: Some(45_000),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });

        let policy = AdmissionRetryPolicy::from_provider(&provider).expect("retry policy");

        assert_eq!(policy.initial_delay_ms, 45_000);
        assert_eq!(policy.retry_interval_ms, 45_000);
        assert_eq!(policy.delay_ms(1, None), 45_000);
        assert_eq!(policy.delay_ms(2, None), 45_000);
    }

    #[test]
    fn admission_retry_policy_uses_initial_delay_as_interval_when_interval_is_empty() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(0),
                initial_delay_ms: Some(12_000),
                max_delay_ms: None,
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });

        let policy = AdmissionRetryPolicy::from_provider(&provider).expect("retry policy");

        assert_eq!(policy.initial_delay_ms, 12_000);
        assert_eq!(policy.retry_interval_ms, 12_000);
        assert_eq!(policy.delay_ms(1, None), 12_000);
        assert_eq!(policy.delay_ms(2, None), 12_000);
    }

    #[test]
    fn admission_retry_policy_caps_retry_after_independently_from_interval() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(1),
                initial_delay_ms: Some(500),
                max_delay_ms: Some(1_000),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });
        let policy = AdmissionRetryPolicy::from_provider(&provider).expect("retry policy");

        assert_eq!(policy.delay_ms(1, Some(45_000)), 45_000);
        assert_eq!(
            policy.delay_ms(1, Some(MAX_ADMISSION_RETRY_DELAY_MS + 1)),
            MAX_ADMISSION_RETRY_DELAY_MS
        );
    }

    #[test]
    fn admission_retry_policy_honors_finite_retry_limit() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(3),
                initial_delay_ms: Some(0),
                max_delay_ms: Some(0),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });

        let policy = AdmissionRetryPolicy::from_provider(&provider).expect("retry policy");

        assert_eq!(policy.max_retries, Some(3));
        assert!(!policy.retry_limit_reached(0));
        assert!(!policy.retry_limit_reached(2));
        assert!(policy.retry_limit_reached(3));
    }

    #[test]
    fn admission_retry_plan_skips_extra_wait_after_slow_failure() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(0),
                initial_delay_ms: Some(1_000),
                max_delay_ms: Some(1_000),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });

        let policy = AdmissionRetryPolicy::from_provider(&provider).expect("retry policy");

        let fast_failure = policy.plan_delay(1, None, 250);
        assert_eq!(fast_failure.target_interval_ms, 1_000);
        assert_eq!(fast_failure.sleep_ms, 750);
        assert!(!fast_failure.used_retry_after);

        let slow_failure = policy.plan_delay(2, None, 5_000);
        assert_eq!(slow_failure.target_interval_ms, 1_000);
        assert_eq!(slow_failure.sleep_ms, 0);
        assert!(!slow_failure.used_retry_after);
    }

    #[test]
    fn admission_retry_plan_keeps_retry_after_relative_to_response_time() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(0),
                initial_delay_ms: Some(1_000),
                max_delay_ms: Some(1_000),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });

        let policy = AdmissionRetryPolicy::from_provider(&provider).expect("retry policy");
        let retry_after_plan = policy.plan_delay(1, Some(2_500), 9_999);

        assert_eq!(retry_after_plan.target_interval_ms, 2_500);
        assert_eq!(retry_after_plan.sleep_ms, 2_500);
        assert!(retry_after_plan.used_retry_after);
    }

    #[test]
    fn admission_retry_policy_auto_opens_from_configured_keywords() {
        let mut provider = test_provider_with_type(None);
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: false,
                auto_enabled: true,
                auto_keywords: vec!["负载已经达到上限".to_string()],
                max_retries: Some(0),
                initial_delay_ms: Some(0),
                max_delay_ms: Some(0),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..ProviderMeta::default()
        });

        let matched_error = ProxyError::UpstreamError {
            status: 503,
            body: Some(r#"{"error":{"message":"负载已经达到上限，请稍后重试"}}"#.to_string()),
            retry_after_ms: None,
        };
        assert!(AdmissionRetryPolicy::from_provider(&provider).is_none());
        assert!(
            AdmissionRetryPolicy::auto_from_provider_for_error(&provider, &matched_error).is_some()
        );

        let unmatched_error = ProxyError::UpstreamError {
            status: 503,
            body: Some(r#"{"error":{"message":"maintenance window"}}"#.to_string()),
            retry_after_ms: None,
        };
        assert!(
            AdmissionRetryPolicy::auto_from_provider_for_error(&provider, &unmatched_error)
                .is_none()
        );
    }

    #[test]
    fn summarize_upstream_body_prefers_json_message() {
        let body = json!({
            "error": {
                "message": "invalid_request_error: unsupported field"
            },
            "request_id": "req_123"
        });

        let summary = summarize_upstream_body(&body.to_string());

        assert_eq!(summary, "invalid_request_error: unsupported field");
    }

    #[test]
    fn summarize_text_for_log_collapses_whitespace_and_truncates() {
        let summary = summarize_text_for_log("line1\n\n line2   line3", 12);

        assert_eq!(summary, "line1 line2...");
    }

    #[test]
    fn canonical_json_sorts_object_keys_for_cache_trace_hashes() {
        let left = json!({
            "tools": [
                {
                    "parameters": {
                        "properties": {
                            "b": {"type": "string"},
                            "a": {"type": "number"}
                        },
                        "type": "object"
                    },
                    "name": "lookup"
                }
            ]
        });
        let right = json!({
            "tools": [
                {
                    "name": "lookup",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "a": {"type": "number"},
                            "b": {"type": "string"}
                        }
                    }
                }
            ]
        });

        assert_eq!(
            crate::proxy::json_canonical::canonical_json_string(&left),
            crate::proxy::json_canonical::canonical_json_string(&right)
        );
        assert_eq!(
            short_value_hash(Some(&left)),
            short_value_hash(Some(&right))
        );
    }

    #[test]
    fn prepare_upstream_request_body_filters_private_fields_and_canonicalizes_order() {
        let body = json!({
            "z": 1,
            "_internal": "drop",
            "tools": [
                {
                    "name": "lookup",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "_id": {
                                "_private_note": "drop",
                                "type": "string"
                            },
                            "b": {"type": "number"},
                            "a": {"type": "string"}
                        }
                    }
                }
            ],
            "a": 2
        });

        let prepared = prepare_upstream_request_body(body);

        assert!(prepared.get("_internal").is_none());
        assert!(prepared["tools"][0]["parameters"]["properties"]
            .get("_id")
            .is_some());
        assert!(prepared["tools"][0]["parameters"]["properties"]["_id"]
            .get("_private_note")
            .is_none());
        assert_eq!(
            serde_json::to_string(&prepared).unwrap(),
            r#"{"a":2,"tools":[{"name":"lookup","parameters":{"properties":{"_id":{"type":"string"},"a":{"type":"string"},"b":{"type":"number"}},"type":"object"}}],"z":1}"#
        );
    }

    #[test]
    fn codex_compact_provider_capability_errors_are_retryable_only_for_compact() {
        let forwarder = test_forwarder(Duration::from_secs(1), Duration::from_secs(1));
        let err = ProxyError::UpstreamError {
            status: 422,
            body: Some(
                r#"{"error":{"message":"no candidate for api_format=openai/responses_compact model not found"}}"#
                    .to_string(),
            ),

        retry_after_ms: None,
        };

        assert_eq!(
            forwarder.categorize_proxy_error(&AppType::Codex, "/v1/responses/compact", &err),
            ErrorCategory::ProviderCapability
        );
        assert_eq!(
            forwarder.categorize_proxy_error(&AppType::Codex, "/v1/responses", &err),
            ErrorCategory::NonRetryable
        );
        assert_eq!(
            forwarder.categorize_proxy_error(&AppType::Claude, "/v1/responses/compact", &err),
            ErrorCategory::NonRetryable
        );

        let model_missing = ProxyError::UpstreamError {
            status: 422,
            body: Some(r#"{"error":{"message":"model gpt-5.5 not found"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert_eq!(
            forwarder.categorize_proxy_error(
                &AppType::Codex,
                "/v1/responses/compact",
                &model_missing,
            ),
            ErrorCategory::ProviderCapability
        );

        let bad_request = ProxyError::UpstreamError {
            status: 400,
            body: Some(r#"{"error":{"message":"invalid input item"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert_eq!(
            forwarder.categorize_proxy_error(
                &AppType::Codex,
                "/v1/responses/compact",
                &bad_request,
            ),
            ErrorCategory::NonRetryable
        );

        let not_implemented = ProxyError::UpstreamError {
            status: 501,
            body: None,

            retry_after_ms: None,
        };
        assert_eq!(
            forwarder.categorize_proxy_error(
                &AppType::Codex,
                "/codex/v1/responses/compact?stream=true",
                &not_implemented,
            ),
            ErrorCategory::ProviderCapability
        );

        let not_found = ProxyError::UpstreamError {
            status: 404,
            body: Some(r#"{"error":{"message":"Cannot POST /v1/responses/compact"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert_eq!(
            forwarder.categorize_proxy_error(&AppType::Codex, "/v1/responses/compact", &not_found),
            ErrorCategory::ProviderCapability
        );

        let method_not_allowed = ProxyError::UpstreamError {
            status: 405,
            body: Some(r#"{"error":{"message":"Method Not Allowed"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert_eq!(
            forwarder.categorize_proxy_error(
                &AppType::Codex,
                "/v1/responses/compact",
                &method_not_allowed,
            ),
            ErrorCategory::ProviderCapability
        );

        let gateway_compact_error = ProxyError::UpstreamError {
            status: 502,
            body: Some(
                r#"{"error":{"message":"upstream responses/compact endpoint unavailable"}}"#
                    .to_string(),
            ),

            retry_after_ms: None,
        };
        assert_eq!(
            forwarder.categorize_proxy_error(
                &AppType::Codex,
                "/v1/responses/compact",
                &gateway_compact_error,
            ),
            ErrorCategory::ProviderCapability
        );

        let unrelated_gateway_error = ProxyError::UpstreamError {
            status: 502,
            body: Some(r#"{"error":{"message":"temporary gateway failure"}}"#.to_string()),

            retry_after_ms: None,
        };
        assert_eq!(
            forwarder.categorize_proxy_error(
                &AppType::Codex,
                "/v1/responses/compact",
                &unrelated_gateway_error,
            ),
            ErrorCategory::Retryable
        );
    }

    #[test]
    fn local_proxy_body_overrides_deep_merge_final_body_without_stream() {
        let mut body = json!({
            "model": "before",
            "stream": false,
            "metadata": {
                "keep": true,
                "temperature": 1
            },
            "messages": [{ "role": "user", "content": "hello" }]
        });
        let overrides = LocalProxyRequestOverrides {
            headers: HashMap::new(),
            body: Some(json!({
                "model": "after",
                "stream": true,
                "metadata": {
                    "temperature": 0.2,
                    "top_p": 0.9
                },
                "messages": []
            })),
        };

        assert!(apply_local_proxy_body_overrides(&mut body, &overrides));

        assert_eq!(body["model"], "after");
        assert_eq!(body["stream"], false);
        assert_eq!(body["metadata"]["keep"], true);
        assert_eq!(body["metadata"]["temperature"], 0.2);
        assert_eq!(body["metadata"]["top_p"], 0.9);
        assert_eq!(body["messages"], json!([]));
    }

    #[test]
    fn local_proxy_header_overrides_replace_allowed_headers_only() {
        let mut headers = http::HeaderMap::new();
        headers.insert(
            http::header::USER_AGENT,
            http::HeaderValue::from_static("original"),
        );
        headers.insert(
            http::header::AUTHORIZATION,
            http::HeaderValue::from_static("Bearer good"),
        );
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );

        let overrides = LocalProxyRequestOverrides {
            headers: HashMap::from([
                ("User-Agent".to_string(), "custom".to_string()),
                ("X-Test".to_string(), "ok".to_string()),
                ("Authorization".to_string(), "Bearer bad".to_string()),
                ("Content-Type".to_string(), "text/plain".to_string()),
                ("X-Bad".to_string(), "bad\nvalue".to_string()),
            ]),
            body: None,
        };

        apply_local_proxy_header_overrides(&mut headers, Some(&overrides), false);

        assert_eq!(
            headers
                .get(http::header::USER_AGENT)
                .and_then(|value| value.to_str().ok()),
            Some("custom")
        );
        assert_eq!(
            headers
                .get(http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer good")
        );
        assert_eq!(
            headers
                .get(http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        assert_eq!(
            headers.get("x-test").and_then(|value| value.to_str().ok()),
            Some("ok")
        );
        assert!(headers.get("x-bad").is_none());
    }

    #[test]
    fn local_proxy_header_overrides_are_skipped_for_copilot() {
        let mut headers = http::HeaderMap::new();
        headers.insert(
            http::header::USER_AGENT,
            http::HeaderValue::from_static("copilot"),
        );
        let overrides = LocalProxyRequestOverrides {
            headers: HashMap::from([("User-Agent".to_string(), "custom".to_string())]),
            body: None,
        };

        apply_local_proxy_header_overrides(&mut headers, Some(&overrides), true);

        assert_eq!(
            headers
                .get(http::header::USER_AGENT)
                .and_then(|value| value.to_str().ok()),
            Some("copilot")
        );
    }

    #[tokio::test]
    async fn non_streaming_success_is_buffered_before_marking_provider_successful() {
        let forwarder = test_forwarder(Duration::from_secs(1), Duration::from_secs(1));
        let response = ProxyResponse::streamed(
            StatusCode::OK,
            HeaderMap::new(),
            futures::stream::once(async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok::<Bytes, std::io::Error>(Bytes::from_static(b"{\"ok\":true}"))
            }),
        );

        let prepared = forwarder
            .prepare_success_response_for_failover(response, false)
            .await
            .expect("response should be buffered");

        assert_eq!(
            prepared.bytes().await.unwrap(),
            Bytes::from_static(b"{\"ok\":true}")
        );
    }

    #[tokio::test]
    async fn non_streaming_body_read_error_is_retryable_before_success_record() {
        let forwarder = test_forwarder(Duration::from_secs(1), Duration::from_secs(1));
        let response = ProxyResponse::streamed(
            StatusCode::OK,
            HeaderMap::new(),
            futures::stream::once(async {
                Err::<Bytes, std::io::Error>(std::io::Error::other("body boom"))
            }),
        );

        let err = match forwarder
            .prepare_success_response_for_failover(response, false)
            .await
        {
            Ok(_) => panic!("body read errors should fail the attempt"),
            Err(err) => err,
        };

        assert!(matches!(err, ProxyError::ForwardFailed(_)));
    }

    #[tokio::test]
    async fn auto_failover_single_provider_respects_half_open_probe_limit() {
        let db = Arc::new(Database::memory().expect("memory db"));
        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let provider = test_provider_with_type(None);
        db.save_provider("claude", &provider).unwrap();
        db.add_to_failover_queue("claude", &provider.id).unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = Arc::new(ProviderRouter::new(db.clone()));
        router
            .record_result(
                &provider.id,
                "claude",
                false,
                false,
                Some("trip breaker".to_string()),
            )
            .await
            .unwrap();

        let occupied_probe = router.allow_provider_request(&provider.id, "claude").await;
        assert!(occupied_probe.allowed);
        assert!(occupied_probe.used_half_open_permit);

        let forwarder = test_forwarder_with_router(router, db, true);
        let err = match forwarder
            .forward_with_retry_inner(
                &AppType::Claude,
                http::Method::POST,
                "/v1/messages",
                json!({ "messages": [] }),
                HeaderMap::new(),
                Extensions::new(),
                vec![provider],
            )
            .await
        {
            Ok(_) => panic!("occupied HalfOpen probe should block the only failover provider"),
            Err(err) => err,
        };

        assert!(matches!(err.error, ProxyError::NoAvailableProvider));
    }

    #[tokio::test]
    async fn upstream_admission_retry_bypasses_existing_half_open_probe_limit() {
        let db = Arc::new(Database::memory().expect("memory db"));
        db.update_circuit_breaker_config(&CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        })
        .await
        .unwrap();

        let mut provider = test_provider_with_type(None);
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
        db.add_to_failover_queue("claude", &provider.id).unwrap();

        let mut config = db.get_proxy_config_for_app("claude").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();

        let router = Arc::new(ProviderRouter::new(db.clone()));
        router
            .record_result(
                &provider.id,
                "claude",
                false,
                false,
                Some("trip breaker".to_string()),
            )
            .await
            .unwrap();

        let occupied_probe = router.allow_provider_request(&provider.id, "claude").await;
        assert!(occupied_probe.allowed);
        assert!(occupied_probe.used_half_open_permit);

        let forwarder = test_forwarder_with_router(router, db, true);
        let err = match forwarder
            .forward_with_retry_inner(
                &AppType::Claude,
                http::Method::POST,
                "/v1/messages",
                json!({ "messages": [] }),
                HeaderMap::new(),
                Extensions::new(),
                vec![provider],
            )
            .await
        {
            Ok(_) => panic!("invalid test provider should not produce a successful response"),
            Err(err) => err,
        };

        assert!(
            !matches!(err.error, ProxyError::NoAvailableProvider),
            "admission retry must not degrade into circuit-open no-provider before trying provider"
        );
    }

    #[tokio::test]
    async fn streaming_success_primes_first_chunk_and_replays_it() {
        let forwarder = test_forwarder(Duration::from_secs(1), Duration::from_secs(1));
        let response = ProxyResponse::streamed(
            StatusCode::OK,
            HeaderMap::new(),
            futures::stream::iter(vec![
                Ok::<Bytes, std::io::Error>(Bytes::from_static(b"first")),
                Ok::<Bytes, std::io::Error>(Bytes::from_static(b"second")),
            ]),
        );

        let prepared = forwarder
            .prepare_success_response_for_failover(response, true)
            .await
            .expect("stream should be primed");

        assert_eq!(
            prepared.bytes().await.unwrap(),
            Bytes::from_static(b"firstsecond")
        );
    }

    #[tokio::test]
    async fn streaming_first_chunk_error_is_retryable_before_success_record() {
        let forwarder = test_forwarder(Duration::from_secs(1), Duration::from_secs(1));
        let response = ProxyResponse::streamed(
            StatusCode::OK,
            HeaderMap::new(),
            futures::stream::once(async {
                Err::<Bytes, std::io::Error>(std::io::Error::other("first chunk boom"))
            }),
        );

        let err = match forwarder
            .prepare_success_response_for_failover(response, true)
            .await
        {
            Ok(_) => panic!("first chunk errors should fail the attempt"),
            Err(err) => err,
        };

        assert!(matches!(err, ProxyError::ForwardFailed(_)));
    }

    #[test]
    fn codex_oauth_session_headers_match_codex_cache_identity() {
        let headers = build_codex_oauth_session_headers("session-123");
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            map.insert(name, value);
        }

        assert_eq!(
            map.get("session_id"),
            Some(&HeaderValue::from_static("session-123"))
        );
        assert_eq!(
            map.get("x-client-request-id"),
            Some(&HeaderValue::from_static("session-123"))
        );
        assert_eq!(
            map.get("x-codex-window-id"),
            Some(&HeaderValue::from_static("session-123:0"))
        );
    }

    #[test]
    fn managed_account_upstream_rejects_proxy_managed_placeholder_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer PROXY_MANAGED"),
        );

        let err = reject_proxy_placeholder_for_managed_account_upstream(
            "https://api.githubcopilot.com/chat/completions",
            &headers,
        )
        .expect_err("placeholder should be rejected before upstream");

        assert!(matches!(
            err,
            ProxyError::AuthError(message) if message.contains("PROXY_MANAGED")
        ));
    }

    #[test]
    fn codex_oauth_upstream_rejects_proxy_managed_placeholder_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer PROXY_MANAGED"),
        );

        let err = reject_proxy_placeholder_for_managed_account_upstream(
            "https://chatgpt.com/backend-api/codex/responses",
            &headers,
        )
        .expect_err("placeholder should be rejected before upstream");

        assert!(matches!(
            err,
            ProxyError::AuthError(message) if message.contains("PROXY_MANAGED")
        ));
    }

    #[test]
    fn non_managed_upstream_allows_proxy_managed_placeholder_guard() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer PROXY_MANAGED"),
        );

        reject_proxy_placeholder_for_managed_account_upstream(
            "https://api.example.com/v1/messages",
            &headers,
        )
        .expect("guard is scoped to managed-account upstreams");
    }

    #[test]
    fn exact_header_case_preserved_for_native_claude_only() {
        let provider = test_provider_with_type(None);

        assert!(should_preserve_exact_header_case(
            "Claude",
            &provider,
            Some("anthropic"),
            false
        ));
        assert!(!should_preserve_exact_header_case(
            "Claude",
            &provider,
            Some("openai_responses"),
            false
        ));
        assert!(!should_preserve_exact_header_case(
            "Codex", &provider, None, false
        ));
        assert!(!should_preserve_exact_header_case(
            "Gemini", &provider, None, false
        ));
    }

    #[test]
    fn exact_header_case_skipped_for_codex_oauth_and_copilot() {
        let codex_oauth = test_provider_with_type(Some("codex_oauth"));
        let copilot = test_provider_with_type(Some("github_copilot"));

        assert!(!should_preserve_exact_header_case(
            "Claude",
            &codex_oauth,
            Some("openai_responses"),
            false
        ));
        assert!(!should_preserve_exact_header_case(
            "Claude",
            &copilot,
            Some("openai_chat"),
            true
        ));
    }

    #[test]
    fn rewrite_claude_transform_endpoint_strips_beta_for_chat_completions() {
        let (endpoint, passthrough_query) = rewrite_claude_transform_endpoint(
            "/v1/messages?beta=true&foo=bar",
            "openai_chat",
            false,
            &json!({ "model": "gpt-5.4" }),
        );

        assert_eq!(endpoint, "/v1/chat/completions?foo=bar");
        assert_eq!(passthrough_query.as_deref(), Some("foo=bar"));
    }

    #[test]
    fn rewrite_claude_transform_endpoint_strips_beta_for_responses() {
        let (endpoint, passthrough_query) = rewrite_claude_transform_endpoint(
            "/claude/v1/messages?beta=true&x-id=1",
            "openai_responses",
            false,
            &json!({ "model": "gpt-5.4" }),
        );

        assert_eq!(endpoint, "/v1/responses?x-id=1");
        assert_eq!(passthrough_query.as_deref(), Some("x-id=1"));
    }

    #[test]
    fn rewrite_codex_responses_endpoint_to_chat_preserves_query() {
        let (endpoint, passthrough_query) =
            rewrite_codex_responses_endpoint_to_chat("/v1/responses?foo=bar");

        assert_eq!(endpoint, "/chat/completions?foo=bar");
        assert_eq!(passthrough_query.as_deref(), Some("foo=bar"));
    }

    #[test]
    fn rewrite_codex_responses_compact_endpoint_to_chat_preserves_query() {
        let (endpoint, passthrough_query) =
            rewrite_codex_responses_endpoint_to_chat("/v1/responses/compact?foo=bar");

        assert_eq!(endpoint, "/chat/completions?foo=bar");
        assert_eq!(passthrough_query.as_deref(), Some("foo=bar"));
    }

    #[test]
    fn rewrite_claude_transform_endpoint_uses_copilot_path() {
        let (endpoint, passthrough_query) = rewrite_claude_transform_endpoint(
            "/v1/messages?beta=true&x-id=1",
            "anthropic",
            true,
            &json!({ "model": "claude-sonnet-4-6" }),
        );

        assert_eq!(endpoint, "/chat/completions?x-id=1");
        assert_eq!(passthrough_query.as_deref(), Some("x-id=1"));
    }

    #[test]
    fn rewrite_claude_transform_endpoint_uses_copilot_responses_path() {
        let (endpoint, passthrough_query) = rewrite_claude_transform_endpoint(
            "/v1/messages?beta=true&x-id=1",
            "openai_responses",
            true,
            &json!({ "model": "gpt-5.4" }),
        );

        assert_eq!(endpoint, "/v1/responses?x-id=1");
        assert_eq!(passthrough_query.as_deref(), Some("x-id=1"));
    }

    #[test]
    fn rewrite_claude_transform_endpoint_maps_gemini_generate_content() {
        let (endpoint, passthrough_query) = rewrite_claude_transform_endpoint(
            "/v1/messages?beta=true&x-id=1",
            "gemini_native",
            false,
            &json!({ "model": "gemini-2.5-pro" }),
        );

        assert_eq!(
            endpoint,
            "/v1beta/models/gemini-2.5-pro:generateContent?x-id=1"
        );
        assert_eq!(passthrough_query.as_deref(), Some("x-id=1"));
    }

    /// Regression: body.model arriving as the resource-name form
    /// `models/gemini-2.5-pro` must not produce a doubled
    /// `/v1beta/models/models/...` path.
    #[test]
    fn rewrite_claude_transform_endpoint_strips_gemini_model_resource_prefix() {
        let (endpoint, _) = rewrite_claude_transform_endpoint(
            "/v1/messages",
            "gemini_native",
            false,
            &json!({ "model": "models/gemini-2.5-pro" }),
        );

        assert_eq!(endpoint, "/v1beta/models/gemini-2.5-pro:generateContent");
    }

    #[test]
    fn rewrite_claude_transform_endpoint_maps_gemini_streaming() {
        let (endpoint, passthrough_query) = rewrite_claude_transform_endpoint(
            "/v1/messages?beta=true",
            "gemini_native",
            false,
            &json!({ "model": "gemini-2.5-flash", "stream": true }),
        );

        assert_eq!(
            endpoint,
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(passthrough_query.as_deref(), Some("alt=sse"));
    }

    #[test]
    fn append_query_to_full_url_preserves_existing_query_string() {
        let url = append_query_to_full_url("https://relay.example/api?foo=bar", Some("x-id=1"));

        assert_eq!(url, "https://relay.example/api?foo=bar&x-id=1");
    }

    #[test]
    fn append_query_to_full_url_preserves_full_chat_completions_path() {
        let url = append_query_to_full_url(
            "https://api.xn--chy-js0fk50c.top/v1/chat/completions",
            Some("request_id=req-1"),
        );

        assert_eq!(
            url,
            "https://api.xn--chy-js0fk50c.top/v1/chat/completions?request_id=req-1"
        );
    }

    #[test]
    fn sanitize_activity_upstream_url_redacts_sensitive_query_and_userinfo() {
        assert_eq!(
            sanitize_activity_upstream_url(
                "https://user:secret@api.example.com/v1/models/gemini:generateContent?key=abc&alt=sse",
            ),
            "https://api.example.com/v1/models/gemini:generateContent?key=***&alt=sse"
        );
    }

    #[test]
    fn sanitize_activity_upstream_url_handles_unparseable_urls_conservatively() {
        assert_eq!(
            sanitize_activity_upstream_url("/v1/responses?api_key=abc&foo=bar"),
            "/v1/responses?***"
        );
    }

    #[test]
    fn codex_model_mapping_uses_provider_env_mapping() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "env": {
                    "ANTHROPIC_MODEL": "gpt-5.4"
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
        };
        let body = json!({ "model": "gpt-5.3-codex", "input": "hello" });

        let (mapped_body, original, mapped) =
            apply_scoped_model_mapping(AppType::Codex.as_str(), body, &provider);

        assert_eq!(mapped_body["model"], "gpt-5.4");
        assert_eq!(original.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(mapped.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn codex_model_mapping_uses_exact_codex_routes_first() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "env": {
                    "ANTHROPIC_MODEL": "legacy-default-model"
                }
            }),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: Some(crate::provider::ProviderMeta {
                codex_model_routes: std::collections::HashMap::from([(
                    "gpt-5.4-mini".to_string(),
                    crate::provider::CodexModelRoute {
                        model: "gpt-5.5".to_string(),
                    },
                )]),
                ..Default::default()
            }),
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };
        let body = json!({ "model": "gpt-5.4-mini", "input": "hello" });

        let (mapped_body, original, mapped) =
            apply_scoped_model_mapping(AppType::Codex.as_str(), body, &provider);

        assert_eq!(mapped_body["model"], "gpt-5.5");
        assert_eq!(original.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(mapped.as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn codex_missing_model_uses_provider_config_model() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "config": r#"model_provider = "custom"
model = "gpt-5.3-codex"

[model_providers.custom]
base_url = "https://api.example.com/v1"
"#
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
        };
        let body = json!({ "input": "hello" });

        let (mapped_body, default_model) =
            apply_provider_default_model_if_missing(AppType::Codex.as_str(), body, &provider);

        assert_eq!(mapped_body["model"], "gpt-5.3-codex");
        assert_eq!(default_model.as_deref(), Some("gpt-5.3-codex"));
    }

    #[test]
    fn codex_existing_model_is_preserved_over_provider_default() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "config": r#"model = "gpt-5.5""#
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
        };
        let body = json!({ "model": "gpt-5.3-codex", "input": "hello" });

        let (mapped_body, default_model) =
            apply_provider_default_model_if_missing(AppType::Codex.as_str(), body, &provider);

        assert_eq!(mapped_body["model"], "gpt-5.3-codex");
        assert_eq!(default_model, None);
    }

    #[test]
    fn codex_model_mapping_applies_before_compact_forwarding() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "env": {
                    "ANTHROPIC_MODEL": "upstream-compact-model"
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
        };
        let body = json!({ "model": "gpt-5.5", "input": "summarize" });

        let (mapped_body, original, mapped) =
            apply_scoped_model_mapping(AppType::Codex.as_str(), body, &provider);

        assert_eq!(mapped_body["model"], "upstream-compact-model");
        assert_eq!(original.as_deref(), Some("gpt-5.5"));
        assert_eq!(mapped.as_deref(), Some("upstream-compact-model"));
    }

    #[test]
    fn gemini_body_without_model_is_not_injected_from_provider_env() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "env": {
                    "GEMINI_MODEL": "gemini-2.5-pro"
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
        };
        let body = json!({ "contents": [] });

        let (mapped_body, default_model) =
            apply_provider_default_model_if_missing(AppType::Gemini.as_str(), body, &provider);

        assert!(mapped_body.get("model").is_none());
        assert_eq!(default_model, None);
    }

    #[test]
    fn default_model_is_not_injected_into_non_object_body() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "config": r#"model = "gpt-5.5""#
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
        };
        let body = json!(["unexpected"]);

        let (mapped_body, default_model) =
            apply_provider_default_model_if_missing(AppType::Codex.as_str(), body, &provider);

        assert_eq!(mapped_body, json!(["unexpected"]));
        assert_eq!(default_model, None);
    }

    #[test]
    fn claude_model_still_uses_claude_env_mapping() {
        let provider = Provider {
            id: "provider-1".to_string(),
            name: "Provider One".to_string(),
            settings_config: json!({
                "env": {
                    "ANTHROPIC_MODEL": "claude-sonnet-4-5"
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
        };
        let body = json!({ "model": "unknown-client-model", "messages": [] });

        let (mapped_body, original, mapped) =
            apply_scoped_model_mapping(AppType::Claude.as_str(), body, &provider);

        assert_eq!(mapped_body["model"], "claude-sonnet-4-5");
        assert_eq!(original.as_deref(), Some("unknown-client-model"));
        assert_eq!(mapped.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn build_gemini_native_url_uses_origin_when_base_ends_with_v1beta() {
        let url = crate::proxy::gemini_url::build_gemini_native_url(
            "https://generativelanguage.googleapis.com/v1beta",
            "/v1beta/models/gemini-2.5-pro:generateContent",
        );

        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
        );
    }

    #[test]
    fn build_gemini_native_url_uses_origin_when_base_already_contains_models_prefix() {
        let url = crate::proxy::gemini_url::build_gemini_native_url(
            "https://generativelanguage.googleapis.com/v1beta/models",
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        );

        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn resolve_gemini_native_url_keeps_opaque_full_url_as_is() {
        let url = crate::proxy::gemini_url::resolve_gemini_native_url(
            "https://relay.example/custom/generate-content",
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
            true,
        );

        assert_eq!(url, "https://relay.example/custom/generate-content?alt=sse");
    }

    #[test]
    fn force_identity_for_stream_flag_requests() {
        let headers = HeaderMap::new();

        assert!(should_force_identity_encoding(
            "/v1/responses",
            &json!({ "stream": true }),
            &headers
        ));
    }

    #[test]
    fn force_identity_for_gemini_stream_endpoints() {
        let headers = HeaderMap::new();

        assert!(should_force_identity_encoding(
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
            &json!({ "model": "gemini-2.5-pro" }),
            &headers
        ));
    }

    #[test]
    fn streaming_request_detects_gemini_sse_without_body_stream_flag() {
        let headers = HeaderMap::new();

        assert!(is_streaming_request(
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
            &json!({ "model": "gemini-2.5-pro" }),
            &headers
        ));
    }

    #[test]
    fn force_identity_for_sse_accept_header() {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));

        assert!(should_force_identity_encoding(
            "/v1/responses",
            &json!({ "model": "gpt-5" }),
            &headers
        ));
    }

    #[test]
    fn non_streaming_requests_allow_automatic_compression() {
        let headers = HeaderMap::new();

        assert!(!should_force_identity_encoding(
            "/v1/responses",
            &json!({ "model": "gpt-5" }),
            &headers
        ));
    }

    // ==================== Copilot 动态 endpoint 路由相关测试 ====================

    /// 验证 is_copilot 检测逻辑：通过 provider_type 判断
    #[test]
    fn copilot_detection_via_provider_type() {
        use crate::provider::{Provider, ProviderMeta};

        let provider = Provider {
            id: "test".to_string(),
            name: "Test Copilot".to_string(),
            settings_config: serde_json::json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: Some(ProviderMeta {
                provider_type: Some("github_copilot".to_string()),
                ..Default::default()
            }),
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };

        let is_copilot = provider
            .meta
            .as_ref()
            .and_then(|m| m.provider_type.as_deref())
            == Some("github_copilot");

        assert!(is_copilot, "应该通过 provider_type 检测为 Copilot");
    }

    /// 验证 is_copilot 检测逻辑：通过 base_url 判断
    #[test]
    fn copilot_detection_via_base_url() {
        let base_url = "https://api.githubcopilot.com";
        let is_copilot = base_url.contains("githubcopilot.com");
        assert!(is_copilot, "应该通过 base_url 检测为 Copilot");

        let non_copilot_url = "https://api.anthropic.com";
        let is_not_copilot = non_copilot_url.contains("githubcopilot.com");
        assert!(!is_not_copilot, "非 Copilot URL 不应被检测为 Copilot");
    }

    /// 验证企业版 endpoint（不包含 githubcopilot.com）场景下 is_copilot 仍然正确
    #[test]
    fn copilot_detection_for_enterprise_endpoint() {
        use crate::provider::{Provider, ProviderMeta};

        // 企业版场景：provider_type 是 github_copilot，但 base_url 可能是企业内部域名
        let provider = Provider {
            id: "enterprise".to_string(),
            name: "Enterprise Copilot".to_string(),
            settings_config: serde_json::json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: Some(ProviderMeta {
                provider_type: Some("github_copilot".to_string()),
                ..Default::default()
            }),
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };

        let enterprise_base_url = "https://copilot-api.corp.example.com";

        // is_copilot 应该通过 provider_type 检测成功，即使 base_url 不包含 githubcopilot.com
        let is_copilot = provider
            .meta
            .as_ref()
            .and_then(|m| m.provider_type.as_deref())
            == Some("github_copilot")
            || enterprise_base_url.contains("githubcopilot.com");

        assert!(
            is_copilot,
            "企业版 Copilot 应该通过 provider_type 被正确检测"
        );
    }

    /// 验证动态 endpoint 替换条件
    #[test]
    fn dynamic_endpoint_replacement_conditions() {
        // 条件：is_copilot && !is_full_url
        let test_cases = [
            (true, false, true, "Copilot + 非 full_url 应该替换"),
            (true, true, false, "Copilot + full_url 不应替换"),
            (false, false, false, "非 Copilot 不应替换"),
            (false, true, false, "非 Copilot + full_url 不应替换"),
        ];

        for (is_copilot, is_full_url, should_replace, desc) in test_cases {
            let will_replace = is_copilot && !is_full_url;
            assert_eq!(will_replace, should_replace, "{desc}");
        }
    }

    // ===== P3: forwarder 层 media 开关回归测试 =====
    // 验证 gate 在 forwarder 这一层的"接线"，而非 media_sanitizer 纯函数本身。

    fn forwarder_with_rectifier(config: RectifierConfig) -> RequestForwarder {
        let mut fwd = test_forwarder(Duration::from_secs(1), Duration::from_secs(1));
        fwd.rectifier_config = config;
        fwd
    }

    fn provider_with_settings(settings_config: Value) -> Provider {
        let mut p = test_provider_with_type(Some("anthropic"));
        p.settings_config = settings_config;
        p
    }

    fn body_with_image(model: &str) -> Value {
        json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "abc" } }
                ]
            }]
        })
    }

    fn body_with_codex_input_image(model: &str) -> Value {
        json!({
            "model": model,
            "input": [{
                "role": "user",
                "content": [
                    { "type": "input_image", "image_url": "data:image/png;base64,abc" }
                ]
            }]
        })
    }

    fn image_unsupported_error() -> ProxyError {
        ProxyError::UpstreamError {
            status: 400,
            body: Some(
                r#"{"error":{"message":"This model does not support image input"}}"#.to_string(),
            ),

            retry_after_ms: None,
        }
    }
    #[test]
    fn prevention_replaces_when_all_switches_on_and_model_in_heuristic_list() {
        let fwd = forwarder_with_rectifier(RectifierConfig::default());
        let provider = provider_with_settings(json!({}));
        let mut body = body_with_image("deepseek-v4-pro");

        let replaced = fwd.apply_media_prevention(&mut body, &provider);

        assert_eq!(replaced, 1, "默认全开 + 名单内模型应预替换");
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
    }

    #[test]
    fn prevention_skipped_when_media_fallback_off() {
        // 关闭 request_media_fallback：即使名单命中也不预替换。
        let fwd = forwarder_with_rectifier(RectifierConfig {
            request_media_fallback: false,
            ..RectifierConfig::default()
        });
        let provider = provider_with_settings(json!({}));
        let mut body = body_with_image("deepseek-v4-pro");

        let replaced = fwd.apply_media_prevention(&mut body, &provider);

        assert_eq!(replaced, 0);
        assert_eq!(body["messages"][0]["content"][0]["type"], "image");
    }

    #[test]
    fn prevention_skipped_when_master_switch_off() {
        let fwd = forwarder_with_rectifier(RectifierConfig {
            enabled: false,
            ..RectifierConfig::default()
        });
        let provider = provider_with_settings(json!({}));
        let mut body = body_with_image("deepseek-v4-pro");

        assert_eq!(fwd.apply_media_prevention(&mut body, &provider), 0);
        assert_eq!(body["messages"][0]["content"][0]["type"], "image");
    }

    #[test]
    fn prevention_heuristic_off_skips_list_but_keeps_explicit_text_only() {
        // 关闭 request_media_heuristic：名单预测失效，但显式声明 text-only 仍预替换。
        let fwd = forwarder_with_rectifier(RectifierConfig {
            request_media_heuristic: false,
            ..RectifierConfig::default()
        });

        // (a) 名单内模型、无显式声明 → 不再预替换
        let bare_provider = provider_with_settings(json!({}));
        let mut list_body = body_with_image("deepseek-v4-pro");
        assert_eq!(
            fwd.apply_media_prevention(&mut list_body, &bare_provider),
            0,
            "heuristic 关闭后名单模型不应被预替换"
        );
        assert_eq!(list_body["messages"][0]["content"][0]["type"], "image");

        // (b) 显式声明 text-only → 仍预替换（声明驱动，不受 heuristic 开关影响）
        let declared_provider = provider_with_settings(json!({
            "models": [ { "id": "some-text-model", "input": ["text"] } ]
        }));
        let mut declared_body = body_with_image("some-text-model");
        assert_eq!(
            fwd.apply_media_prevention(&mut declared_body, &declared_provider),
            1,
            "显式 text-only 即使关闭 heuristic 也应预替换"
        );
        assert_eq!(declared_body["messages"][0]["content"][0]["type"], "text");
    }

    #[test]
    fn reactive_triggers_when_all_switches_on() {
        let fwd = forwarder_with_rectifier(RectifierConfig::default());
        let body = body_with_image("any-model");
        assert!(fwd.media_retry_should_trigger("Claude", false, &body, &image_unsupported_error()));
    }

    #[test]
    fn reactive_triggers_for_codex_image_url_deserialize_errors() {
        let fwd = forwarder_with_rectifier(RectifierConfig::default());
        let body = body_with_codex_input_image("deepseek-v4-flash");
        let error = ProxyError::UpstreamError {
            status: 400,
            body: Some(
                r#"{"error":{"message":"Failed to deserialize the JSON body into the target type: messages[11]: unknown variant image_url, expected text"}}"#
                    .to_string(),
            ),

        retry_after_ms: None,
        };

        assert!(fwd.media_retry_should_trigger("Codex", false, &body, &error));
    }

    #[test]
    fn reactive_skipped_when_media_fallback_off() {
        // 关闭 request_media_fallback：上游报图片错误也不触发兜底重试。
        let fwd = forwarder_with_rectifier(RectifierConfig {
            request_media_fallback: false,
            ..RectifierConfig::default()
        });
        let body = body_with_image("any-model");
        assert!(!fwd.media_retry_should_trigger(
            "Claude",
            false,
            &body,
            &image_unsupported_error()
        ));
    }

    #[test]
    fn reactive_skipped_when_master_switch_off() {
        let fwd = forwarder_with_rectifier(RectifierConfig {
            enabled: false,
            ..RectifierConfig::default()
        });
        let body = body_with_image("any-model");
        assert!(!fwd.media_retry_should_trigger(
            "Claude",
            false,
            &body,
            &image_unsupported_error()
        ));
    }

    #[test]
    fn reactive_unaffected_by_heuristic_switch() {
        // 关闭 request_media_heuristic 不影响反应式兜底——它是上游实测错误后的恢复，不是预测。
        let fwd = forwarder_with_rectifier(RectifierConfig {
            request_media_heuristic: false,
            ..RectifierConfig::default()
        });
        let body = body_with_image("any-model");
        assert!(fwd.media_retry_should_trigger("Claude", false, &body, &image_unsupported_error()));
    }
}
