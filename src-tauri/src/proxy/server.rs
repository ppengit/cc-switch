//! HTTP代理服务器
//!
//! 基于Axum的HTTP服务器，处理代理请求
//!
//! Uses a manual hyper HTTP/1.1 accept loop with `preserve_header_case(true)` so
//! that the original header-name casing from the CLI client is captured in a
//! `HeaderCaseMap` extension.  This map is later forwarded to the upstream via
//! the hyper-based HTTP client, producing wire-level header casing identical to
//! a direct (non-proxied) CLI request.

use super::{
    activity::ProxyActivityState,
    failover_switch::FailoverSwitchManager,
    handlers,
    log_codes::srv as log_srv,
    provider_router::ProviderRouter,
    providers::{codex_chat_history::CodexChatHistoryStore, gemini_shadow::GeminiShadowStore},
    types::*,
    ProxyError,
};
use crate::database::Database;
use axum::{
    extract::DefaultBodyLimit,
    routing::{any, get, post},
    Router,
};
use hyper_util::rt::TokioIo;
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::{oneshot, Notify, RwLock};
use tokio::task::JoinHandle;

/// 代理服务器状态（共享）
#[derive(Clone)]
pub struct ProxyState {
    pub db: Arc<Database>,
    pub config: Arc<RwLock<ProxyConfig>>,
    pub status: Arc<RwLock<ProxyStatus>>,
    pub start_time: Arc<RwLock<Option<std::time::Instant>>>,
    /// 每个应用类型当前使用的 provider (app_type -> (provider_id, provider_name))
    pub current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
    /// 共享的 ProviderRouter（持有熔断器状态，跨请求保持）
    pub provider_router: Arc<ProviderRouter>,
    /// Gemini Native shadow state，用于 thoughtSignature / tool call 回放
    pub gemini_shadow: Arc<GeminiShadowStore>,
    /// Codex Chat bridge history，用于恢复 previous_response_id 指向的 tool call
    pub codex_chat_history: Arc<CodexChatHistoryStore>,
    /// AppHandle，用于发射事件和更新托盘菜单
    pub app_handle: Option<tauri::AppHandle>,
    /// 故障转移切换管理器
    pub failover_manager: Arc<FailoverSwitchManager>,
    /// 实时代理活动（仅内存态，不落库）
    pub proxy_activity: Arc<RwLock<ProxyActivityState>>,
    /// 切换代次（per-app 单调递增）：每次显式切换/启停供应商时 +1。
    ///
    /// 转发请求在开始时 snapshot 此值；请求成功完成后写
    /// `current_providers` / `is_current` / 托盘 / `status` 之前必须比较 epoch，
    /// 比 snapshot 大说明"切换已发生"，本次成功完成的 inflight 不应再倒写状态。
    pub switch_epoch: Arc<RwLock<std::collections::HashMap<String, u64>>>,
    /// 代理服务器停止代次。进行中的上游入场重试会捕获启动时的代次，
    /// stop 时递增并唤醒等待者，避免关闭代理/退出应用后继续请求上游。
    pub shutdown_epoch: Arc<AtomicU64>,
    pub shutdown_notify: Arc<Notify>,
}

/// 代理HTTP服务器
pub struct ProxyServer {
    config: ProxyConfig,
    state: ProxyState,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    /// 服务器任务句柄，用于等待服务器实际关闭
    server_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl ProxyServer {
    pub fn new(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        // 创建共享的 ProviderRouter（熔断器状态将跨所有请求保持）
        let provider_router = Arc::new(ProviderRouter::with_app_handle(
            db.clone(),
            app_handle.clone(),
        ));
        // 创建故障转移切换管理器
        let failover_manager = Arc::new(FailoverSwitchManager::new(db.clone()));
        let raw_log_retention_minutes = db
            .get_log_config()
            .map(|config| config.clamped_raw_proxy_log_retention_minutes())
            .unwrap_or(DEFAULT_RAW_PROXY_LOG_RETENTION_MINUTES);

        let state = ProxyState {
            db,
            config: Arc::new(RwLock::new(config.clone())),
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            start_time: Arc::new(RwLock::new(None)),
            current_providers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            provider_router,
            gemini_shadow: Arc::new(GeminiShadowStore::default()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            app_handle,
            failover_manager,
            proxy_activity: Arc::new(RwLock::new(
                ProxyActivityState::with_raw_log_retention_minutes(raw_log_retention_minutes),
            )),
            switch_epoch: Arc::new(RwLock::new(std::collections::HashMap::new())),
            shutdown_epoch: Arc::new(AtomicU64::new(0)),
            shutdown_notify: Arc::new(Notify::new()),
        };

        Self {
            config,
            state,
            shutdown_tx: Arc::new(RwLock::new(None)),
            server_handle: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start(&self) -> Result<ProxyServerInfo, ProxyError> {
        // 检查是否已在运行
        if self.shutdown_tx.read().await.is_some() {
            return Err(ProxyError::AlreadyRunning);
        }

        let addr: SocketAddr =
            format!("{}:{}", self.config.listen_address, self.config.listen_port)
                .parse()
                .map_err(|e| ProxyError::BindFailed(format!("无效的地址: {e}")))?;

        // 创建关闭通道
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        // 构建路由
        let app = self.build_router();

        // 绑定监听器
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .map_err(|e| ProxyError::BindFailed(e.to_string()))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| ProxyError::BindFailed(e.to_string()))?;
        let actual_port = local_addr.port();

        log::info!("[{}] 代理服务器启动于 {local_addr}", log_srv::STARTED);

        // 更新全局代理端口，用于系统代理检测
        crate::proxy::http_client::set_proxy_port(actual_port);

        // 保存关闭句柄
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        // 更新状态
        let mut status = self.state.status.write().await;
        status.running = true;
        status.address = self.config.listen_address.clone();
        status.port = actual_port;
        drop(status);

        // 记录启动时间
        *self.state.start_time.write().await = Some(std::time::Instant::now());

        // 启动服务器 — 使用手动 hyper HTTP/1.1 accept loop
        // 开启 preserve_header_case 以捕获客户端请求头的原始大小写
        let state = self.state.clone();
        let handle = tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (stream, _remote_addr) = match result {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!("[{SRV}] accept 失败: {e}", SRV = log_srv::ACCEPT_ERR);
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                continue;
                            }
                        };

                        let app = app.clone();
                        tokio::spawn(async move {
                            // Peek raw TCP bytes to capture original header casing
                            // before hyper parses (and lowercases) the header names.
                            let original_cases = {
                                let mut peek_buf = vec![0u8; 8192];
                                match stream.peek(&mut peek_buf).await {
                                    Ok(n) => {
                                        let cases = super::hyper_client::OriginalHeaderCases::from_raw_bytes(&peek_buf[..n]);
                                        log::debug!(
                                            "[ProxyServer] Peeked {} bytes, captured {} header casings",
                                            n, cases.cases.len()
                                        );
                                        cases
                                    }
                                    Err(e) => {
                                        log::debug!("[ProxyServer] peek failed (non-fatal): {e}");
                                        super::hyper_client::OriginalHeaderCases::default()
                                    }
                                }
                            };

                            // service_fn 将 axum Router（tower::Service）桥接到 hyper
                            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                                let mut router = app.clone();
                                let cases = original_cases.clone();
                                async move {
                                    // 将 hyper::body::Incoming 转为 axum::body::Body，保留 extensions
                                    let (mut parts, body) = req.into_parts();

                                    // Insert our own header case map alongside hyper's internal one
                                    parts.extensions.insert(cases);

                                    let body = axum::body::Body::new(body);
                                    let axum_req = http::Request::from_parts(parts, body);
                                    <Router as tower::Service<http::Request<axum::body::Body>>>::call(&mut router, axum_req).await
                                }
                            });

                            if let Err(e) = hyper::server::conn::http1::Builder::new()
                                .preserve_header_case(true)
                                .serve_connection(TokioIo::new(stream), service)
                                .await
                            {
                                // Connection reset / broken pipe 等在代理场景下很常见，debug 级别
                                log::debug!("[{SRV}] connection error: {e}", SRV = log_srv::CONN_ERR);
                            }
                        });
                    }
                    _ = &mut shutdown_rx => {
                        break;
                    }
                }
            }

            // 服务器停止后更新状态
            state.status.write().await.running = false;
            *state.start_time.write().await = None;
        });

        // 保存服务器任务句柄
        *self.server_handle.write().await = Some(handle);

        Ok(ProxyServerInfo {
            address: self.config.listen_address.clone(),
            port: actual_port,
            started_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    pub async fn stop(&self) -> Result<(), ProxyError> {
        self.state.shutdown_epoch.fetch_add(1, Ordering::SeqCst);
        self.state.shutdown_notify.notify_waiters();

        // 1. 发送关闭信号
        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());
        } else {
            return Err(ProxyError::NotRunning);
        }

        // 2. 等待服务器任务结束（带 5 秒超时保护）
        if let Some(handle) = self.server_handle.write().await.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(Ok(())) => {
                    log::info!("[{}] 代理服务器已完全停止", log_srv::STOPPED);
                    Ok(())
                }
                Ok(Err(e)) => {
                    log::warn!("[{}] 代理服务器任务异常终止: {e}", log_srv::TASK_ERROR);
                    Err(ProxyError::StopFailed(e.to_string()))
                }
                Err(_) => {
                    log::warn!(
                        "[{}] 代理服务器停止超时（5秒），强制继续",
                        log_srv::STOP_TIMEOUT
                    );
                    Err(ProxyError::StopTimeout)
                }
            }
        } else {
            Ok(())
        }
    }

    pub async fn get_status(&self) -> ProxyStatus {
        let mut status = self.state.status.read().await.clone();

        // 计算运行时间
        if let Some(start) = *self.state.start_time.read().await {
            status.uptime_seconds = start.elapsed().as_secs();
        }

        // 从 current_providers HashMap 获取每个应用类型当前正在使用的 provider
        let current_providers = self.state.current_providers.read().await;
        status.active_targets = current_providers
            .iter()
            .map(|(app_type, (provider_id, provider_name))| ActiveTarget {
                app_type: app_type.clone(),
                provider_id: provider_id.clone(),
                provider_name: provider_name.clone(),
            })
            .collect();

        let (active_request_count, active_request_targets) =
            super::activity::snapshot(&self.state.proxy_activity).await;
        status.active_request_count = active_request_count;
        status.active_request_targets = active_request_targets;

        status
    }

    pub async fn get_raw_logs(
        &self,
        limit: usize,
        app_type: Option<&str>,
    ) -> Vec<ProxyRawLogEntry> {
        super::activity::raw_logs(&self.state.proxy_activity, limit, app_type).await
    }

    pub async fn get_admission_retry_snapshot(
        &self,
        app_type: Option<&str>,
    ) -> Vec<ProviderAdmissionRetryEvent> {
        super::activity::admission_retry_snapshot(&self.state.proxy_activity, app_type).await
    }

    pub async fn get_session_routing_snapshot(
        &self,
        app_type: &str,
    ) -> Result<SessionRoutingSnapshot, crate::error::AppError> {
        let activity_session_context =
            super::activity::recent_session_context_by_id(&self.state.proxy_activity, app_type)
                .await;
        self.state
            .provider_router
            .session_routing_snapshot(app_type, activity_session_context)
            .await
    }

    pub async fn rebind_session_route(
        &self,
        app_type: &str,
        session_id: &str,
        provider_id: &str,
    ) -> Result<SessionRoutingSnapshot, crate::error::AppError> {
        self.state
            .provider_router
            .rebind_session_route(app_type, session_id, provider_id)
            .await
    }

    pub async fn set_raw_log_retention_minutes(&self, minutes: u64) {
        super::activity::set_raw_log_retention_minutes(&self.state.proxy_activity, minutes).await;
    }

    /// 更新某个应用类型当前“目标供应商”（用于 UI 展示 active_targets）
    ///
    /// 注意：这不代表该供应商一定已经处理过请求，而是用于“热切换/启用故障转移立即切 P1”
    /// 等场景下，让 UI 能立刻反映最新目标。
    pub async fn set_active_target(&self, app_type: &str, provider_id: &str, provider_name: &str) {
        let mut current_providers = self.state.current_providers.write().await;
        current_providers.insert(
            app_type.to_string(),
            (provider_id.to_string(), provider_name.to_string()),
        );
    }

    pub async fn clear_active_target(&self, app_type: &str) {
        let mut current_providers = self.state.current_providers.write().await;
        current_providers.remove(app_type);
    }

    /// 把某个应用类型的"切换代次"加 1，并返回新值。
    ///
    /// 任何会改变路由目标的操作（hot-switch、启停故障转移、从队列移除供应商等）
    /// 都应调用此函数；正在进行中的请求若 epoch snapshot 比当前小，
    /// 必须放弃回写 `current_providers` / `is_current` / 托盘等共享状态。
    pub async fn bump_switch_epoch(&self, app_type: &str) -> u64 {
        let mut epochs = self.state.switch_epoch.write().await;
        let entry = epochs.entry(app_type.to_string()).or_insert(0);
        *entry = entry.saturating_add(1);
        *entry
    }

    /// 读取某个应用类型当前的"切换代次"。从未切换过则返回 0。
    #[allow(dead_code)]
    pub async fn current_switch_epoch(&self, app_type: &str) -> u64 {
        let epochs = self.state.switch_epoch.read().await;
        *epochs.get(app_type).unwrap_or(&0)
    }

    pub async fn clear_provider_runtime_state(&self, provider_id: &str, app_type: &str) {
        super::activity::clear_provider(
            &self.state.proxy_activity,
            self.state.app_handle.as_ref(),
            app_type,
            provider_id,
        )
        .await;

        let mut current_providers = self.state.current_providers.write().await;
        let should_clear = current_providers
            .get(app_type)
            .map(|(current_id, _)| current_id == provider_id)
            .unwrap_or(false);

        if should_clear {
            current_providers.remove(app_type);
        }
    }

    fn build_router(&self) -> Router {
        Router::new()
            // 健康检查
            .route("/health", get(handlers::health_check))
            .route("/status", get(handlers::get_status))
            // Claude API (支持带前缀和不带前缀两种格式)
            .route("/v1/messages", post(handlers::handle_messages))
            .route("/claude/v1/messages", post(handlers::handle_messages))
            // Claude Desktop 3P 本地 gateway（独立 provider namespace）
            .route(
                "/claude-desktop/v1/models",
                get(handlers::handle_claude_desktop_models),
            )
            .route(
                "/claude-desktop/v1/messages",
                post(handlers::handle_claude_desktop_messages),
            )
            // OpenAI Models API (Codex CLI readiness/model catalog probe)
            .route("/models", get(handlers::handle_codex_models))
            .route("/v1/models", get(handlers::handle_codex_models))
            .route("/codex/v1/models", get(handlers::handle_codex_models))
            // OpenAI Chat Completions API (Codex CLI，支持带前缀和不带前缀)
            .route("/chat/completions", post(handlers::handle_chat_completions))
            .route(
                "/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/v1/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/codex/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            // OpenAI Responses API (Codex CLI，支持带前缀和不带前缀)
            .route("/responses", post(handlers::handle_responses))
            .route("/v1/responses", post(handlers::handle_responses))
            .route("/v1/v1/responses", post(handlers::handle_responses))
            .route("/codex/v1/responses", post(handlers::handle_responses))
            // Grok Build uses the Responses protocol but has an independent
            // provider namespace and failover queue.
            .route(
                "/grokbuild/v1/responses",
                post(handlers::handle_grokbuild_responses),
            )
            // OpenAI Responses Compact API (Codex CLI 远程压缩，透传)
            .route(
                "/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/codex/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/grokbuild/v1/responses/compact",
                post(handlers::handle_grokbuild_responses_compact),
            )
            // Gemini API (支持带前缀和不带前缀)
            //
            // 用 `any(..)` 覆盖所有 HTTP 方法：除了 POST `:generateContent` /
            // `:streamGenerateContent` / `:countTokens` 之外，Gemini SDK / CLI 还会发
            // GET `/models`、GET `/models/<id>` 等只读端点。如果只挂 POST，这些 GET
            // 请求会在路由层 404，绕过本地代理的统计、整流和故障转移。
            .route("/v1beta/*path", any(handlers::handle_gemini))
            .route("/gemini/v1beta/*path", any(handlers::handle_gemini))
            // Gemini 的 GA 版本也叫 /v1，给原 SDK 留一条出口
            .route("/gemini/v1/*path", any(handlers::handle_gemini))
            // 提高默认请求体大小限制（避免 413 Payload Too Large）
            .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
            .with_state(self.state.clone())
    }

    /// 在不重启服务的情况下更新运行时配置
    pub async fn apply_runtime_config(&self, config: &ProxyConfig) {
        *self.state.config.write().await = config.clone();
    }

    /// 热更新熔断器配置
    ///
    /// 将新配置应用到所有已创建的熔断器实例
    pub async fn update_circuit_breaker_configs(
        &self,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state.provider_router.update_all_configs(config).await;
    }

    pub async fn update_circuit_breaker_config_for_app(
        &self,
        app_type: &str,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state
            .provider_router
            .update_app_configs(app_type, config)
            .await;
    }

    /// 重置指定 Provider 的熔断器
    pub async fn reset_provider_circuit_breaker(&self, provider_id: &str, app_type: &str) {
        self.state
            .provider_router
            .reset_provider_breaker(provider_id, app_type)
            .await;
    }

    /// 获取指定 Provider 的熔断器统计
    pub async fn get_circuit_breaker_stats(
        &self,
        provider_id: &str,
        app_type: &str,
    ) -> Option<super::circuit_breaker::CircuitBreakerStats> {
        self.state
            .provider_router
            .get_circuit_breaker_stats(provider_id, app_type)
            .await
    }

    /// 批量获取指定应用的熔断器统计。
    pub async fn get_circuit_breaker_stats_for_app(
        &self,
        app_type: &str,
    ) -> std::collections::HashMap<String, super::circuit_breaker::CircuitBreakerStats> {
        self.state
            .provider_router
            .get_circuit_breaker_stats_for_app(app_type)
            .await
    }

    #[cfg(test)]
    pub async fn record_provider_result_for_test(
        &self,
        provider_id: &str,
        app_type: &str,
        success: bool,
        error_msg: Option<String>,
    ) -> Result<(), crate::error::AppError> {
        self.state
            .provider_router
            .record_result(provider_id, app_type, false, success, error_msg)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Provider, ProviderMeta, UpstreamAdmissionRetryConfig};
    use axum::http::StatusCode;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn disconnected_client_does_not_keep_replaying_upstream_request() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let handler_count = request_count.clone();
        let upstream_app = axum::Router::new().route(
            "/v1/responses",
            axum::routing::post(move || {
                let handler_count = handler_count.clone();
                async move {
                    handler_count.fetch_add(1, Ordering::SeqCst);
                    axum::response::Response::builder()
                        .status(StatusCode::TOO_MANY_REQUESTS)
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(axum::body::Body::from(
                            r#"{"error":{"message":"rate limit reached"}}"#,
                        ))
                        .expect("build mock rate-limit response")
                }
            }),
        );
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock upstream");
        let upstream_addr = upstream_listener.local_addr().expect("mock upstream addr");
        let upstream_server = tokio::spawn(async move {
            axum::serve(upstream_listener, upstream_app)
                .await
                .expect("run mock upstream server");
        });

        let db = Arc::new(Database::memory().expect("init memory db"));
        let mut provider = Provider::with_id(
            "codex-disconnect".to_string(),
            "Codex Disconnect".to_string(),
            json!({
                "base_url": format!("http://{upstream_addr}"),
                "apiKey": "test-key"
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            upstream_admission_retry: Some(UpstreamAdmissionRetryConfig {
                enabled: true,
                max_retries: Some(20),
                initial_delay_ms: Some(200),
                max_delay_ms: Some(200),
                jitter_ms: Some(0),
                ..Default::default()
            }),
            ..Default::default()
        });
        db.save_provider("codex", &provider)
            .expect("save test provider");
        db.add_to_failover_queue("codex", &provider.id)
            .expect("queue test provider");
        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("read codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable codex failover");

        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                ..Default::default()
            },
            db,
            None,
        );
        let proxy_info = proxy.start().await.expect("start test proxy");
        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", proxy_info.port))
            .await
            .expect("connect test client");
        let body = r#"{"model":"gpt-5.5","input":"ping"}"#;
        client
            .write_all(
                format!(
                    "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .await
            .expect("send proxy request");
        client.flush().await.expect("flush proxy request");

        tokio::time::timeout(Duration::from_secs(2), async {
            while request_count.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("first upstream attempt should start");
        drop(client);

        tokio::time::sleep(Duration::from_millis(750)).await;
        let final_request_count = request_count.load(Ordering::SeqCst);

        proxy.stop().await.expect("stop test proxy");
        upstream_server.abort();

        assert_eq!(
            final_request_count, 1,
            "dropping the client connection must cancel its admission retry loop"
        );
    }
}
