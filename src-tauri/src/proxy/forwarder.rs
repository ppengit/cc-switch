//! 璇锋眰杞彂鍣?//!
//! 璐熻矗灏嗚姹傝浆鍙戝埌涓婃父Provider锛屾敮鎸佹晠闅滆浆绉?
use super::{
    body_filter::filter_private_params_with_whitelist,
    error::*,
    failover_switch::FailoverSwitchManager,
    provider_router::ProviderRouter,
    providers::{get_adapter, ProviderAdapter, ProviderType},
    thinking_budget_rectifier::{rectify_thinking_budget, should_rectify_thinking_budget},
    thinking_rectifier::{
        normalize_thinking_type, rectify_anthropic_request, should_rectify_thinking_signature,
    },
    types::{ProxyStatus, RectifierConfig},
    ProxyError,
};
use crate::{app_config::AppType, provider::Provider};
use reqwest::Response;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Headers 榛戝悕鍗?- 涓嶉€忎紶鍒颁笂娓哥殑 Headers
///
/// 绮剧畝鐗堥粦鍚嶅崟锛屽彧杩囨护蹇呴』瑕嗙洊鎴栧彲鑳藉鑷撮棶棰樼殑 header
/// 鍙傝€冩垚鍔熼€忎紶鐨勮姹傦紝淇濈暀鏇村鍘熷 header
///
/// 娉ㄦ剰锛氬鎴风 IP 绫伙紙x-forwarded-for, x-real-ip锛夐粯璁ら€忎紶
const HEADER_BLACKLIST: &[&str] = &[
    // 璁よ瘉绫伙紙浼氳瑕嗙洊锛?    "authorization",
    "x-api-key",
    "x-goog-api-key",
    // 杩炴帴绫伙紙鐢?HTTP 瀹㈡埛绔鐞嗭級
    "host",
    "content-length",
    "transfer-encoding",
    // 缂栫爜绫伙紙浼氳瑕嗙洊涓?identity锛?    "accept-encoding",
    // 浠ｇ悊杞彂绫伙紙淇濈暀 x-forwarded-for 鍜?x-real-ip锛?    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "forwarded",
    // CDN/浜戞湇鍔″晢鐗瑰畾澶?    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "true-client-ip",
    "fastly-client-ip",
    "x-azure-clientip",
    "x-azure-fdid",
    "x-azure-ref",
    "akamai-origin-hop",
    "x-akamai-config-log-detail",
    // 璇锋眰杩借釜绫?    "x-request-id",
    "x-correlation-id",
    "x-trace-id",
    "x-amzn-trace-id",
    "x-b3-traceid",
    "x-b3-spanid",
    "x-b3-parentspanid",
    "x-b3-sampled",
    "traceparent",
    "tracestate",
    // anthropic 鐗瑰畾澶村崟鐙鐞嗭紝閬垮厤閲嶅
    "anthropic-beta",
    "anthropic-version",
    // 瀹㈡埛绔?IP 鍗曠嫭澶勭悊锛堥粯璁ら€忎紶锛?    "x-forwarded-for",
    "x-real-ip",
];

pub struct ForwardResult {
    pub response: Response,
    pub provider: Provider,
}

pub struct ForwardError {
    pub error: ProxyError,
    pub provider: Option<Provider>,
}

pub struct RequestForwarder {
    /// 鍏变韩鐨?ProviderRouter锛堟寔鏈夌啍鏂櫒鐘舵€侊級
    router: Arc<ProviderRouter>,
    status: Arc<RwLock<ProxyStatus>>,
    current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
    /// 鏁呴殰杞Щ鍒囨崲绠＄悊鍣?    failover_manager: Arc<FailoverSwitchManager>,
    /// AppHandle锛岀敤浜庡彂灏勪簨浠跺拰鏇存柊鎵樼洏
    app_handle: Option<tauri::AppHandle>,
    /// 璇锋眰寮€濮嬫椂鐨?褰撳墠渚涘簲鍟?ID"锛堢敤浜庡垽鏂槸鍚﹂渶瑕佸悓姝?UI/鎵樼洏锛?    current_provider_id_at_start: String,
    suppress_global_failover_switch: bool,
    /// 鏁存祦鍣ㄩ厤缃?    rectifier_config: RectifierConfig,
    /// 闈炴祦寮忚姹傝秴鏃讹紙绉掞級
    non_streaming_timeout: std::time::Duration,
}

impl RequestForwarder {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        router: Arc<ProviderRouter>,
        non_streaming_timeout: u64,
        status: Arc<RwLock<ProxyStatus>>,
        current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
        failover_manager: Arc<FailoverSwitchManager>,
        app_handle: Option<tauri::AppHandle>,
        current_provider_id_at_start: String,
        _streaming_first_byte_timeout: u64,
        _streaming_idle_timeout: u64,
        suppress_global_failover_switch: bool,
        rectifier_config: RectifierConfig,
    ) -> Self {
        Self {
            router,
            status,
            current_providers,
            failover_manager,
            app_handle,
            current_provider_id_at_start,
            suppress_global_failover_switch,
            rectifier_config,
            non_streaming_timeout: std::time::Duration::from_secs(non_streaming_timeout),
        }
    }

    /// 杞彂璇锋眰锛堝甫鏁呴殰杞Щ锛?    ///
    /// # Arguments
    /// * `app_type` - 搴旂敤绫诲瀷
    /// * `endpoint` - API 绔偣
    /// * `body` - 璇锋眰浣?    /// * `headers` - 璇锋眰澶?    /// * `providers` - 宸查€夋嫨鐨?Provider 鍒楄〃锛堢敱 RequestContext 鎻愪緵锛岄伩鍏嶉噸澶嶈皟鐢?select_providers锛?    pub async fn forward_with_retry(
        &self,
        app_type: &AppType,
        endpoint: &str,
        mut body: Value,
        headers: axum::http::HeaderMap,
        providers: Vec<Provider>,
    ) -> Result<ForwardResult, ForwardError> {
        // 鑾峰彇閫傞厤鍣?        let adapter = get_adapter(app_type);
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

        // 鏁存祦鍣ㄩ噸璇曟爣璁帮細纭繚鏁存祦鏈€澶氳Е鍙戜竴娆?        let mut rectifier_retried = false;
        let mut budget_rectifier_retried = false;

        // 鍗?Provider 鍦烘櫙涓嬭烦杩囩啍鏂櫒妫€鏌ワ紙鏁呴殰杞Щ鍏抽棴鏃讹級
        let bypass_circuit_breaker = providers.len() == 1;

        // 渚濇灏濊瘯姣忎釜渚涘簲鍟?        for provider in providers.iter() {
            // 鍙戣捣璇锋眰鍓嶅厛鑾峰彇鐔旀柇鍣ㄦ斁琛岃鍙紙HalfOpen 浼氬崰鐢ㄦ帰娴嬪悕棰濓級
            // 鍗?Provider 鍦烘櫙涓嬭烦杩囨妫€鏌ワ紝閬垮厤鐔旀柇鍣ㄩ樆濉炴墍鏈夎姹?            let (allowed, used_half_open_permit) = if bypass_circuit_breaker {
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

            attempted_providers += 1;

            // 鏇存柊鐘舵€佷腑鐨勫綋鍓峆rovider淇℃伅
            {
                let mut status = self.status.write().await;
                status.current_provider = Some(provider.name.clone());
                status.current_provider_id = Some(provider.id.clone());
                status.total_requests += 1;
                status.last_request_at = Some(chrono::Utc::now().to_rfc3339());
            }

            // 杞彂璇锋眰锛堟瘡涓?Provider 鍙皾璇曚竴娆★紝閲嶈瘯鐢卞鎴风鎺у埗锛?            match self
                .forward(provider, endpoint, &body, &headers, adapter.as_ref())
                .await
            {
                Ok(response) => {
                    // 鎴愬姛锛氳褰曟垚鍔熷苟鏇存柊鐔旀柇鍣?                    let _ = self
                        .router
                        .record_result(
                            &provider.id,
                            app_type_str,
                            used_half_open_permit,
                            true,
                            None,
                        )
                        .await;

                    // 鏇存柊褰撳墠搴旂敤绫诲瀷浣跨敤鐨?provider
                    {
                        let mut current_providers = self.current_providers.write().await;
                        current_providers.insert(
                            app_type_str.to_string(),
                            (provider.id.clone(), provider.name.clone()),
                        );
                    }

                    // 鏇存柊鎴愬姛缁熻
                    {
                        let mut status = self.status.write().await;
                        status.success_requests += 1;
                        status.last_error = None;
                        let should_switch =
                            self.current_provider_id_at_start.as_str() != provider.id.as_str();
                        if should_switch {
                            status.failover_count += 1;
                            if !self.suppress_global_failover_switch {
                                // 寮傛瑙﹀彂渚涘簲鍟嗗垏鎹紝鏇存柊 UI/鎵樼洏锛屽苟鎶娾€滃綋鍓嶄緵搴斿晢鈥濆悓姝ヤ负瀹為檯浣跨敤鐨?provider
                                let fm = self.failover_manager.clone();
                                let ah = self.app_handle.clone();
                                let pid = provider.id.clone();
                                let pname = provider.name.clone();
                                let at = app_type_str.to_string();

                                tokio::spawn(async move {
                                    let _ = fm.try_switch(ah.as_ref(), &at, &pid, &pname).await;
                                });
                            }
                        }
                        // 閲嶆柊璁＄畻鎴愬姛鐜?                        if status.total_requests > 0 {
                            status.success_rate = (status.success_requests as f32
                                / status.total_requests as f32)
                                * 100.0;
                        }
                    }

                    return Ok(ForwardResult {
                        response,
                        provider: provider.clone(),
                    });
                }
                Err(e) => {
                    // 妫€娴嬫槸鍚﹂渶瑕佽Е鍙戞暣娴佸櫒锛堜粎 Claude/ClaudeAuth 渚涘簲鍟嗭級
                    let provider_type = ProviderType::from_app_type_and_config(app_type, provider);
                    let is_anthropic_provider = matches!(
                        provider_type,
                        ProviderType::Claude | ProviderType::ClaudeAuth
                    );
                    let mut signature_rectifier_non_retryable_client_error = false;

                    if is_anthropic_provider {
                        let error_message = extract_error_message(&e);
                        if should_rectify_thinking_signature(
                            error_message.as_deref(),
                            &self.rectifier_config,
                        ) {
                            // 宸茬粡閲嶈瘯杩囷細鐩存帴杩斿洖閿欒锛堜笉鍙噸璇曞鎴风閿欒锛?                            if rectifier_retried {
                                log::warn!("[{app_type_str}] [RECT-005] 鏁存祦鍣ㄥ凡瑙﹀彂杩囷紝涓嶅啀閲嶈瘯");
                                // 閲婃斁 HalfOpen permit锛堜笉璁板綍鐔旀柇鍣紝杩欐槸瀹㈡埛绔吋瀹规€ч棶棰橈級
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

                            // 棣栨瑙﹀彂锛氭暣娴佽姹備綋
                            let rectified = rectify_anthropic_request(&mut body);

                            // 鏁存祦鏈敓鏁堬細缁х画灏濊瘯 budget 鏁存祦璺緞锛岄伩鍏嶈鍒ゅ悗鐭矾
                            if !rectified.applied {
                                log::warn!(
                                    "[{app_type_str}] [RECT-006] thinking 绛惧悕鏁存祦鍣ㄨЕ鍙戜絾鏃犲彲鏁存祦鍐呭锛岀户缁鏌?budget锛涜嫢 budget 涔熸湭鍛戒腑鍒欐寜瀹㈡埛绔敊璇繑鍥?
                                );
                                signature_rectifier_non_retryable_client_error = true;
                            } else {
                                log::info!(
                                    "[{}] [RECT-001] thinking 绛惧悕鏁存祦鍣ㄨЕ鍙? 绉婚櫎 {} thinking blocks, {} redacted_thinking blocks, {} signature fields",
                                    app_type_str,
                                    rectified.removed_thinking_blocks,
                                    rectified.removed_redacted_thinking_blocks,
                                    rectified.removed_signature_fields
                                );

                                // 鏍囪宸查噸璇曪紙褰撳墠閫昏緫涓嬮噸璇曞悗蹇呭畾 return锛屼繚鐣欐爣璁颁互澶囧皢鏉ユ墿灞曪級
                                let _ = std::mem::replace(&mut rectifier_retried, true);

                                // 浣跨敤鍚屼竴渚涘簲鍟嗛噸璇曪紙涓嶈鍏ョ啍鏂櫒锛?                                match self
                                    .forward(provider, endpoint, &body, &headers, adapter.as_ref())
                                    .await
                                {
                                    Ok(response) => {
                                        log::info!("[{app_type_str}] [RECT-002] 鏁存祦閲嶈瘯鎴愬姛");
                                        // 璁板綍鎴愬姛
                                        let _ = self
                                            .router
                                            .record_result(
                                                &provider.id,
                                                app_type_str,
                                                used_half_open_permit,
                                                true,
                                                None,
                                            )
                                            .await;

                                        // 鏇存柊褰撳墠搴旂敤绫诲瀷浣跨敤鐨?provider
                                        {
                                            let mut current_providers =
                                                self.current_providers.write().await;
                                            current_providers.insert(
                                                app_type_str.to_string(),
                                                (provider.id.clone(), provider.name.clone()),
                                            );
                                        }

                                        // 鏇存柊鎴愬姛缁熻
                                        {
                                            let mut status = self.status.write().await;
                                            status.success_requests += 1;
                                            status.last_error = None;
                                            let should_switch =
                                                self.current_provider_id_at_start.as_str()
                                                    != provider.id.as_str();
                                            if should_switch {
                                                status.failover_count += 1;
                                                if !self.suppress_global_failover_switch {
                                                    // 寮傛瑙﹀彂渚涘簲鍟嗗垏鎹紝鏇存柊 UI/鎵樼洏
                                                    let fm = self.failover_manager.clone();
                                                    let ah = self.app_handle.clone();
                                                    let pid = provider.id.clone();
                                                    let pname = provider.name.clone();
                                                    let at = app_type_str.to_string();

                                                    tokio::spawn(async move {
                                                        let _ = fm
                                                            .try_switch(
                                                                ah.as_ref(),
                                                                &at,
                                                                &pid,
                                                                &pname,
                                                            )
                                                            .await;
                                                    });
                                                }
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
                                        });
                                    }
                                    Err(retry_err) => {
                                        // 鏁存祦閲嶈瘯浠嶅け璐ワ細鍖哄垎閿欒绫诲瀷鍐冲畾鏄惁璁板綍鐔旀柇鍣?                                        log::warn!(
                                            "[{app_type_str}] [RECT-003] 鏁存祦閲嶈瘯浠嶅け璐? {retry_err}"
                                        );

                                        // 鍖哄垎閿欒绫诲瀷锛歅rovider 闂璁板綍澶辫触锛屽鎴风闂浠呴噴鏀?permit
                                        let is_provider_error = match &retry_err {
                                            ProxyError::Timeout(_)
                                            | ProxyError::ForwardFailed(_) => true,
                                            ProxyError::UpstreamError { status, .. } => {
                                                *status >= 500
                                            }
                                            _ => false,
                                        };

                                        if is_provider_error {
                                            // Provider 闂锛氳褰曞け璐ュ埌鐔旀柇鍣?                                            let _ = self
                                                .router
                                                .record_result(
                                                    &provider.id,
                                                    app_type_str,
                                                    used_half_open_permit,
                                                    false,
                                                    Some(retry_err.to_string()),
                                                )
                                                .await;
                                        } else {
                                            // 瀹㈡埛绔棶棰橈細浠呴噴鏀?permit锛屼笉璁板綍鐔旀柇鍣?                                            self.router
                                                .release_permit_neutral(
                                                    &provider.id,
                                                    app_type_str,
                                                    used_half_open_permit,
                                                )
                                                .await;
                                        }

                                        let mut status = self.status.write().await;
                                        status.failed_requests += 1;
                                        status.last_error = Some(retry_err.to_string());
                                        if status.total_requests > 0 {
                                            status.success_rate = (status.success_requests as f32
                                                / status.total_requests as f32)
                                                * 100.0;
                                        }
                                        return Err(ForwardError {
                                            error: retry_err,
                                            provider: Some(provider.clone()),
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // 妫€娴嬫槸鍚﹂渶瑕佽Е鍙?budget 鏁存祦鍣紙浠?Claude/ClaudeAuth 渚涘簲鍟嗭級
                    if is_anthropic_provider {
                        let error_message = extract_error_message(&e);
                        if should_rectify_thinking_budget(
                            error_message.as_deref(),
                            &self.rectifier_config,
                        ) {
                            // 宸茬粡閲嶈瘯杩囷細鐩存帴杩斿洖閿欒锛堜笉鍙噸璇曞鎴风閿欒锛?                            if budget_rectifier_retried {
                                log::warn!(
                                    "[{app_type_str}] [RECT-013] budget 鏁存祦鍣ㄥ凡瑙﹀彂杩囷紝涓嶅啀閲嶈瘯"
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

                            let budget_rectified = rectify_thinking_budget(&mut body);
                            if !budget_rectified.applied {
                                log::warn!(
                                    "[{app_type_str}] [RECT-014] budget 鏁存祦鍣ㄨЕ鍙戜絾鏃犲彲鏁存祦鍐呭锛屼笉鍋氭棤鎰忎箟閲嶈瘯"
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
                                "[{}] [RECT-010] thinking budget 鏁存祦鍣ㄨЕ鍙? before={:?}, after={:?}",
                                app_type_str,
                                budget_rectified.before,
                                budget_rectified.after
                            );

                            let _ = std::mem::replace(&mut budget_rectifier_retried, true);

                            // 浣跨敤鍚屼竴渚涘簲鍟嗛噸璇曪紙涓嶈鍏ョ啍鏂櫒锛?                            match self
                                .forward(provider, endpoint, &body, &headers, adapter.as_ref())
                                .await
                            {
                                Ok(response) => {
                                    log::info!("[{app_type_str}] [RECT-011] budget 鏁存祦閲嶈瘯鎴愬姛");
                                    let _ = self
                                        .router
                                        .record_result(
                                            &provider.id,
                                            app_type_str,
                                            used_half_open_permit,
                                            true,
                                            None,
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
                                            if !self.suppress_global_failover_switch {
                                                let fm = self.failover_manager.clone();
                                                let ah = self.app_handle.clone();
                                                let pid = provider.id.clone();
                                                let pname = provider.name.clone();
                                                let at = app_type_str.to_string();
                                                tokio::spawn(async move {
                                                    let _ = fm
                                                        .try_switch(
                                                            ah.as_ref(),
                                                            &at,
                                                            &pid,
                                                            &pname,
                                                        )
                                                        .await;
                                                });
                                            }
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
                                    });
                                }
                                Err(retry_err) => {
                                    log::warn!(
                                        "[{app_type_str}] [RECT-012] budget 鏁存祦閲嶈瘯浠嶅け璐? {retry_err}"
                                    );

                                    let is_provider_error = match &retry_err {
                                        ProxyError::Timeout(_) | ProxyError::ForwardFailed(_) => {
                                            true
                                        }
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
                                    } else {
                                        self.router
                                            .release_permit_neutral(
                                                &provider.id,
                                                app_type_str,
                                                used_half_open_permit,
                                            )
                                            .await;
                                    }

                                    let mut status = self.status.write().await;
                                    status.failed_requests += 1;
                                    status.last_error = Some(retry_err.to_string());
                                    if status.total_requests > 0 {
                                        status.success_rate = (status.success_requests as f32
                                            / status.total_requests as f32)
                                            * 100.0;
                                    }
                                    return Err(ForwardError {
                                        error: retry_err,
                                        provider: Some(provider.clone()),
                                    });
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

                    // 澶辫触锛氳褰曞け璐ュ苟鏇存柊鐔旀柇鍣?                    let _ = self
                        .router
                        .record_result(
                            &provider.id,
                            app_type_str,
                            used_half_open_permit,
                            false,
                            Some(e.to_string()),
                        )
                        .await;

                    // 鍒嗙被閿欒
                    let category = self.categorize_proxy_error(&e);

                    match category {
                        ErrorCategory::Retryable => {
                            // 鍙噸璇曪細鏇存柊閿欒淇℃伅锛岀户缁皾璇曚笅涓€涓緵搴斿晢
                            {
                                let mut status = self.status.write().await;
                                status.last_error =
                                    Some(format!("Provider {} 澶辫触: {}", provider.name, e));
                            }

                            log::warn!(
                                "[{}] [FWD-001] Provider {} 澶辫触锛屽垏鎹笅涓€涓?({}/{})",
                                app_type_str,
                                provider.name,
                                attempted_providers,
                                providers.len()
                            );

                            last_error = Some(e);
                            last_provider = Some(provider.clone());
                            // 缁х画灏濊瘯涓嬩竴涓緵搴斿晢
                            continue;
                        }
                        ErrorCategory::NonRetryable | ErrorCategory::ClientAbort => {
                            // 涓嶅彲閲嶈瘯锛氱洿鎺ヨ繑鍥為敊璇?                            {
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
            // providers 鍒楄〃闈炵┖锛屼絾鍏ㄩ儴琚啍鏂櫒鎷掔粷锛堝吀鍨嬶細HalfOpen 鎺㈡祴鍚嶉琚崰鐢級
            {
                let mut status = self.status.write().await;
                status.failed_requests += 1;
                status.last_error = Some("鎵€鏈変緵搴斿晢鏆傛椂涓嶅彲鐢紙鐔旀柇鍣ㄩ檺鍒讹級".to_string());
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

        // 鎵€鏈変緵搴斿晢閮藉け璐ヤ簡
        {
            let mut status = self.status.write().await;
            status.failed_requests += 1;
            status.last_error = Some("鎵€鏈変緵搴斿晢閮藉け璐?.to_string());
            if status.total_requests > 0 {
                status.success_rate =
                    (status.success_requests as f32 / status.total_requests as f32) * 100.0;
            }
        }

        log::warn!("[{app_type_str}] [FWD-002] 鎵€鏈?Provider 鍧囧け璐?);

        Err(ForwardError {
            error: last_error.unwrap_or(ProxyError::MaxRetriesExceeded),
            provider: last_provider,
        })
    }

    /// 杞彂鍗曚釜璇锋眰锛堜娇鐢ㄩ€傞厤鍣級
    async fn forward(
        &self,
        provider: &Provider,
        endpoint: &str,
        body: &Value,
        headers: &axum::http::HeaderMap,
        adapter: &dyn ProviderAdapter,
    ) -> Result<Response, ProxyError> {
        // 浣跨敤閫傞厤鍣ㄦ彁鍙?base_url
        let base_url = adapter.extract_base_url(provider)?;

        // 妫€鏌ユ槸鍚﹂渶瑕佹牸寮忚浆鎹?        let needs_transform = adapter.needs_transform(provider);

        let effective_endpoint =
            if needs_transform && adapter.name() == "Claude" && endpoint == "/v1/messages" {
                "/v1/chat/completions"
            } else {
                endpoint
            };

        // 浣跨敤閫傞厤鍣ㄦ瀯寤?URL
        let url = adapter.build_url(&base_url, effective_endpoint);

        // 搴旂敤妯″瀷鏄犲皠锛堢嫭绔嬩簬鏍煎紡杞崲锛?        let (mapped_body, _original_model, _mapped_model) =
            super::model_mapper::apply_model_mapping(body.clone(), provider);

        // 涓?CCH 瀵归綈锛氳姹傚墠涓嶅仛 thinking 涓诲姩鏀瑰啓锛堜粎淇濈暀鍏煎鍏ュ彛锛?        let mapped_body = normalize_thinking_type(mapped_body);

        // 杞崲璇锋眰浣擄紙濡傛灉闇€瑕侊級
        let request_body = if needs_transform {
            adapter.transform_request(mapped_body, provider)?
        } else {
            mapped_body
        };

        // 杩囨护绉佹湁鍙傛暟锛堜互 `_` 寮€澶寸殑瀛楁锛夛紝闃叉鍐呴儴淇℃伅娉勯湶鍒颁笂娓?        // 榛樿浣跨敤绌虹櫧鍚嶅崟锛岃繃婊ゆ墍鏈?_ 鍓嶇紑瀛楁
        let filtered_body = filter_private_params_with_whitelist(request_body, &[]);

        // 鑾峰彇 HTTP 瀹㈡埛绔細浼樺厛浣跨敤渚涘簲鍟嗗崟鐙唬鐞嗛厤缃紝鍚﹀垯浣跨敤鍏ㄥ眬瀹㈡埛绔?        let proxy_config = provider.meta.as_ref().and_then(|m| m.proxy_config.as_ref());
        let client = super::http_client::get_for_provider(proxy_config);
        let mut request = client.post(&url);

        // 鍙湁褰?timeout > 0 鏃舵墠璁剧疆璇锋眰瓒呮椂
        // Duration::ZERO 鍦?reqwest 涓〃绀?绔嬪埢瓒呮椂"鑰屼笉鏄?绂佺敤瓒呮椂"
        // 鏁呴殰杞Щ鍏抽棴鏃朵細浼犲叆 0锛屾鏃跺簲璇ヤ娇鐢?client 鐨勯粯璁よ秴鏃讹紙600绉掞級
        if !self.non_streaming_timeout.is_zero() {
            request = request.timeout(self.non_streaming_timeout);
        }

        // 杩囨护榛戝悕鍗?Headers锛屼繚鎶ら殣绉佸苟閬垮厤鍐茬獊
        for (key, value) in headers {
            if HEADER_BLACKLIST
                .iter()
                .any(|h| key.as_str().eq_ignore_ascii_case(h))
            {
                continue;
            }
            request = request.header(key, value);
        }

        // 澶勭悊 anthropic-beta Header锛堜粎 Claude锛?        // 鍏抽敭锛氱‘淇濆寘鍚?claude-code-20250219 鏍囪锛岃繖鏄笂娓告湇鍔￠獙璇佽姹傛潵婧愮殑渚濇嵁
        // 濡傛灉瀹㈡埛绔彂閫佺殑 beta 鏍囪涓病鏈夊寘鍚?claude-code-20250219锛岄渶瑕佽ˉ鍏?        if adapter.name() == "Claude" {
            const CLAUDE_CODE_BETA: &str = "claude-code-20250219";
            let beta_value = if let Some(beta) = headers.get("anthropic-beta") {
                if let Ok(beta_str) = beta.to_str() {
                    // 妫€鏌ユ槸鍚﹀凡鍖呭惈 claude-code-20250219
                    if beta_str.contains(CLAUDE_CODE_BETA) {
                        beta_str.to_string()
                    } else {
                        // 琛ュ厖 claude-code-20250219
                        format!("{CLAUDE_CODE_BETA},{beta_str}")
                    }
                } else {
                    CLAUDE_CODE_BETA.to_string()
                }
            } else {
                // 濡傛灉瀹㈡埛绔病鏈夊彂閫侊紝浣跨敤榛樿鍊?                CLAUDE_CODE_BETA.to_string()
            };
            request = request.header("anthropic-beta", &beta_value);
        }

        // 瀹㈡埛绔?IP 閫忎紶锛堥粯璁ゅ紑鍚級
        if let Some(xff) = headers.get("x-forwarded-for") {
            if let Ok(xff_str) = xff.to_str() {
                request = request.header("x-forwarded-for", xff_str);
            }
        }
        if let Some(real_ip) = headers.get("x-real-ip") {
            if let Ok(real_ip_str) = real_ip.to_str() {
                request = request.header("x-real-ip", real_ip_str);
            }
        }

        // 绂佺敤鍘嬬缉锛岄伩鍏?gzip 娴佸紡鍝嶅簲瑙ｆ瀽閿欒
        // 鍙傝€?CCH: undici 鍦ㄨ繛鎺ユ彁鍓嶅叧闂椂浼氬涓嶅畬鏁寸殑 gzip 娴佹姏鍑洪敊璇?        request = request.header("accept-encoding", "identity");

        // 浣跨敤閫傞厤鍣ㄦ坊鍔犺璇佸ご
        if let Some(auth) = adapter.extract_auth(provider) {
            request = adapter.add_auth_headers(request, &auth);
        }

        // anthropic-version 缁熶竴澶勭悊锛堜粎 Claude锛夛細浼樺厛浣跨敤瀹㈡埛绔殑鐗堟湰鍙凤紝鍚﹀垯浣跨敤榛樿鍊?        // 娉ㄦ剰锛氬彧璁剧疆涓€娆★紝閬垮厤閲嶅
        if adapter.name() == "Claude" {
            let version_str = headers
                .get("anthropic-version")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("2023-06-01");
            request = request.header("anthropic-version", version_str);
        }

        // 杈撳嚭璇锋眰淇℃伅鏃ュ織
        let tag = adapter.name();
        let request_model = filtered_body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>");
        log::info!("[{tag}] >>> 璇锋眰 URL: {url} (model={request_model})");
        if let Ok(body_str) = serde_json::to_string(&filtered_body) {
            log::debug!(
                "[{tag}] >>> 璇锋眰浣撳唴瀹?({}瀛楄妭): {}",
                body_str.len(),
                body_str
            );
        }

        // 鍙戦€佽姹?        let response = request.json(&filtered_body).send().await.map_err(|e| {
            if e.is_timeout() {
                ProxyError::Timeout(format!("璇锋眰瓒呮椂: {e}"))
            } else if e.is_connect() {
                ProxyError::ForwardFailed(format!("杩炴帴澶辫触: {e}"))
            } else {
                ProxyError::ForwardFailed(e.to_string())
            }
        })?;

        // 妫€鏌ュ搷搴旂姸鎬?        let status = response.status();

        if status.is_success() {
            Ok(response)
        } else {
            let status_code = status.as_u16();
            let body_text = response.text().await.ok();

            Err(ProxyError::UpstreamError {
                status: status_code,
                body: body_text,
            })
        }
    }

    fn categorize_proxy_error(&self, error: &ProxyError) -> ErrorCategory {
        match error {
            // 缃戠粶鍜屼笂娓搁敊璇細閮藉簲璇ュ皾璇曚笅涓€涓緵搴斿晢
            ProxyError::Timeout(_) => ErrorCategory::Retryable,
            ProxyError::ForwardFailed(_) => ErrorCategory::Retryable,
            ProxyError::ProviderUnhealthy(_) => ErrorCategory::Retryable,
            // 涓婃父 HTTP 閿欒锛氭棤璁虹姸鎬佺爜濡備綍锛岄兘灏濊瘯涓嬩竴涓緵搴斿晢
            // 鍘熷洜锛氫笉鍚屼緵搴斿晢鏈変笉鍚岀殑闄愬埗鍜岃璇侊紝涓€涓緵搴斿晢鐨?4xx 閿欒
            // 涓嶄唬琛ㄥ叾浠栦緵搴斿晢涔熶細澶辫触
            ProxyError::UpstreamError { .. } => ErrorCategory::Retryable,
            // Provider 绾ч厤缃?杞崲闂锛氭崲涓€涓?Provider 鍙兘灏辫兘鎴愬姛
            ProxyError::ConfigError(_) => ErrorCategory::Retryable,
            ProxyError::TransformError(_) => ErrorCategory::Retryable,
            ProxyError::AuthError(_) => ErrorCategory::Retryable,
            ProxyError::StreamIdleTimeout(_) => ErrorCategory::Retryable,
            // 鏃犲彲鐢ㄤ緵搴斿晢锛氭墍鏈変緵搴斿晢閮借瘯杩囦簡锛屾棤娉曢噸璇?            ProxyError::NoAvailableProvider => ErrorCategory::NonRetryable,
            // 鍏朵粬閿欒锛堟暟鎹簱/鍐呴儴閿欒绛夛級锛氫笉鏄崲渚涘簲鍟嗚兘瑙ｅ喅鐨勯棶棰?            _ => ErrorCategory::NonRetryable,
        }
    }
}

/// 浠?ProxyError 涓彁鍙栭敊璇秷鎭?fn extract_error_message(error: &ProxyError) -> Option<String> {
    match error {
        ProxyError::UpstreamError { body, .. } => body.clone(),
        _ => Some(error.to_string()),
    }
}


