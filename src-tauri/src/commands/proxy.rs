//! 代理服务相关的 Tauri 命令
//!
//! 提供前端调用的 API 接口

use crate::database::{ProviderSessionOccupancy, SessionProviderBinding};
use crate::error::AppError;
use crate::proxy::types::*;
use crate::proxy::{CircuitBreakerConfig, CircuitBreakerStats};
use crate::store::AppState;
use std::collections::HashSet;
use std::net::IpAddr;

fn is_loopback_listen_address(address: &str) -> bool {
    let trimmed = address.trim();
    if trimmed.eq_ignore_ascii_case("localhost") {
        return true;
    }

    match trimmed.parse::<IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

fn validate_proxy_bind(address: &str, port: u16) -> Result<(), String> {
    if !is_loopback_listen_address(address) {
        return Err(format!(
            "listenAddress must be loopback only (127.0.0.1, ::1, localhost), got {address}"
        ));
    }

    if !(1024..=65535).contains(&port) {
        return Err(format!(
            "listenPort must be between 1024 and 65535, got {port}"
        ));
    }

    Ok(())
}

fn normalize_app_proxy_config(mut config: AppProxyConfig) -> Result<AppProxyConfig, String> {
    config.force_model = config.force_model.trim().to_string();

    if config.force_model_enabled && config.force_model.is_empty() {
        return Err(
            "强制模型已开启时，模型名称不能为空 / forceModel is required when enabled".to_string(),
        );
    }

    Ok(config)
}

/// 启动代理服务器（仅启动服务，不接管 Live 配置）
#[tauri::command]
pub async fn start_proxy_server(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyServerInfo, String> {
    state.proxy_service.start().await
}

/// 停止代理服务器（恢复 Live 配置）
#[tauri::command]
pub async fn stop_proxy_with_restore(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.proxy_service.stop_with_restore().await
}

/// 获取各应用接管状态
#[tauri::command]
pub async fn get_proxy_takeover_status(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyTakeoverStatus, String> {
    state.proxy_service.get_takeover_status().await
}

/// 为指定应用开启/关闭接管
#[tauri::command]
pub async fn set_proxy_takeover_for_app(
    state: tauri::State<'_, AppState>,
    app_type: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .proxy_service
        .set_takeover_for_app(&app_type, enabled)
        .await
}

/// 获取代理服务器状态
#[tauri::command]
pub async fn get_proxy_status(state: tauri::State<'_, AppState>) -> Result<ProxyStatus, String> {
    state.proxy_service.get_status().await
}

/// 获取代理配置
#[tauri::command]
pub async fn get_proxy_config(state: tauri::State<'_, AppState>) -> Result<ProxyConfig, String> {
    state.proxy_service.get_config().await
}

/// 更新代理配置
#[tauri::command]
pub async fn update_proxy_config(
    state: tauri::State<'_, AppState>,
    config: ProxyConfig,
) -> Result<(), String> {
    validate_proxy_bind(&config.listen_address, config.listen_port)?;
    state.proxy_service.update_config(&config).await
}

// ==================== Global & Per-App Config ====================

/// 获取全局代理配置
///
/// 返回统一的全局配置字段（代理开关、监听地址、端口、日志开关）
#[tauri::command]
pub async fn get_global_proxy_config(
    state: tauri::State<'_, AppState>,
) -> Result<GlobalProxyConfig, String> {
    let db = &state.db;
    db.get_global_proxy_config()
        .await
        .map_err(|e| e.to_string())
}

/// 更新全局代理配置
///
/// 更新统一的全局配置字段，会同时更新三行（claude/codex/gemini）
#[tauri::command]
pub async fn update_global_proxy_config(
    state: tauri::State<'_, AppState>,
    config: GlobalProxyConfig,
) -> Result<(), String> {
    validate_proxy_bind(&config.listen_address, config.listen_port)?;
    let db = &state.db;
    db.update_global_proxy_config(config)
        .await
        .map_err(|e| e.to_string())
}

/// 获取指定应用的代理配置
///
/// 返回应用级配置（enabled、auto_failover、超时、熔断器等）
#[tauri::command]
pub async fn get_proxy_config_for_app(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<AppProxyConfig, String> {
    let db = &state.db;
    db.get_proxy_config_for_app(&app_type)
        .await
        .map_err(|e| e.to_string())
}

/// 更新指定应用的代理配置
///
/// 更新应用级配置（enabled、auto_failover、超时、熔断器等）
#[tauri::command]
pub async fn update_proxy_config_for_app(
    state: tauri::State<'_, AppState>,
    config: AppProxyConfig,
) -> Result<(), String> {
    let config = normalize_app_proxy_config(config)?;
    let db = &state.db;
    let previous = db
        .get_proxy_config_for_app(&config.app_type)
        .await
        .map_err(|e| e.to_string())?;

    db.update_proxy_config_for_app(config.clone())
        .await
        .map_err(|e| e.to_string())?;

    if previous.session_routing_enabled != config.session_routing_enabled {
        db.clear_session_provider_bindings_for_app(&config.app_type)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_session_routing_master_enabled(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    state
        .db
        .get_session_routing_master_enabled()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_session_routing_master_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let previous = state
        .db
        .get_session_routing_master_enabled()
        .map_err(|e| e.to_string())?;

    state
        .db
        .set_session_routing_master_enabled(enabled)
        .map_err(|e| e.to_string())?;

    if previous != enabled {
        state
            .db
            .clear_all_session_provider_bindings()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn list_session_provider_bindings_internal(
    state: &AppState,
    app_type: &str,
    idle_ttl_minutes: Option<u32>,
) -> Result<Vec<SessionProviderBinding>, String> {
    let ttl = resolve_session_idle_ttl(state, app_type, idle_ttl_minutes).await?;
    reconcile_session_bindings_for_routing(state, app_type, ttl).await?;
    state
        .db
        .list_session_provider_bindings(app_type, ttl)
        .map_err(|e| e.to_string())
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn list_session_provider_bindings_test_hook(
    state: &AppState,
    app_type: &str,
    idle_ttl_minutes: Option<u32>,
) -> Result<Vec<SessionProviderBinding>, String> {
    list_session_provider_bindings_internal(state, app_type, idle_ttl_minutes).await
}

#[tauri::command]
pub async fn list_session_provider_bindings(
    state: tauri::State<'_, AppState>,
    app_type: String,
    idle_ttl_minutes: Option<u32>,
) -> Result<Vec<SessionProviderBinding>, String> {
    list_session_provider_bindings_internal(&state, &app_type, idle_ttl_minutes).await
}

async fn get_session_provider_binding_internal(
    state: &AppState,
    app_type: &str,
    session_id: &str,
    idle_ttl_minutes: Option<u32>,
) -> Result<Option<SessionProviderBinding>, String> {
    let ttl = resolve_session_idle_ttl(state, app_type, idle_ttl_minutes).await?;
    reconcile_session_bindings_for_routing(state, app_type, ttl).await?;
    state
        .db
        .get_session_provider_binding(app_type, session_id, ttl)
        .map_err(|e| e.to_string())
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn get_session_provider_binding_test_hook(
    state: &AppState,
    app_type: &str,
    session_id: &str,
    idle_ttl_minutes: Option<u32>,
) -> Result<Option<SessionProviderBinding>, String> {
    get_session_provider_binding_internal(state, app_type, session_id, idle_ttl_minutes).await
}

#[tauri::command]
pub async fn get_session_provider_binding(
    state: tauri::State<'_, AppState>,
    app_type: String,
    session_id: String,
    idle_ttl_minutes: Option<u32>,
) -> Result<Option<SessionProviderBinding>, String> {
    get_session_provider_binding_internal(&state, &app_type, &session_id, idle_ttl_minutes).await
}

#[tauri::command]
pub async fn switch_session_provider_binding(
    state: tauri::State<'_, AppState>,
    app_type: String,
    session_id: String,
    provider_id: String,
    pin: Option<bool>,
) -> Result<SessionProviderBinding, String> {
    if state
        .db
        .get_provider_by_id(&provider_id, &app_type)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!(
            "provider not found for app_type={app_type}, provider_id={provider_id}"
        ));
    }

    let ttl = resolve_session_idle_ttl(&state, &app_type, None).await?;
    let existing = state
        .db
        .get_session_provider_binding(&app_type, &session_id, ttl)
        .map_err(|e| e.to_string())?;
    let pinned = pin.unwrap_or_else(|| existing.as_ref().map(|item| item.pinned).unwrap_or(false));
    let now_ms = chrono::Utc::now().timestamp_millis();

    state
        .db
        .upsert_session_provider_binding(&app_type, &session_id, &provider_id, pinned, now_ms)
        .map_err(|e| e.to_string())?;

    state
        .db
        .get_session_provider_binding(&app_type, &session_id, ttl)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "failed to read session binding after switch".to_string())
}

#[tauri::command]
pub async fn set_session_provider_binding_pin(
    state: tauri::State<'_, AppState>,
    app_type: String,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    state
        .db
        .set_session_provider_binding_pin(&app_type, &session_id, pinned, now_ms)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_session_provider_binding(
    state: tauri::State<'_, AppState>,
    app_type: String,
    session_id: String,
) -> Result<(), String> {
    state
        .db
        .remove_session_provider_binding(&app_type, &session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_provider_session_occupancy(
    state: tauri::State<'_, AppState>,
    app_type: String,
    idle_ttl_minutes: Option<u32>,
) -> Result<Vec<ProviderSessionOccupancy>, String> {
    get_provider_session_occupancy_internal(&state, &app_type, idle_ttl_minutes).await
}

async fn get_provider_session_occupancy_internal(
    state: &AppState,
    app_type: &str,
    idle_ttl_minutes: Option<u32>,
) -> Result<Vec<ProviderSessionOccupancy>, String> {
    let ttl = resolve_session_idle_ttl(state, app_type, idle_ttl_minutes).await?;
    reconcile_session_bindings_for_routing(state, app_type, ttl).await?;
    state
        .db
        .get_provider_session_occupancy(app_type, ttl)
        .map_err(|e| e.to_string())
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn get_provider_session_occupancy_test_hook(
    state: &AppState,
    app_type: &str,
    idle_ttl_minutes: Option<u32>,
) -> Result<Vec<ProviderSessionOccupancy>, String> {
    get_provider_session_occupancy_internal(state, app_type, idle_ttl_minutes).await
}

async fn reconcile_session_bindings_for_routing(
    state: &AppState,
    app_type: &str,
    idle_ttl_minutes: u32,
) -> Result<(), String> {
    let app_config = state
        .db
        .get_proxy_config_for_app(app_type)
        .await
        .map_err(|e| e.to_string())?;
    if !app_config.session_routing_enabled {
        return Ok(());
    }

    let bindings = state
        .db
        .list_session_provider_bindings(app_type, idle_ttl_minutes)
        .map_err(|e| e.to_string())?;
    let active_bindings: Vec<SessionProviderBinding> = bindings
        .into_iter()
        .filter(|binding| binding.is_active)
        .collect();

    let ordered_provider_ids = state
        .db
        .list_provider_ids_for_session_routing(app_type)
        .map_err(|e| e.to_string())?;
    if ordered_provider_ids.is_empty() {
        for binding in active_bindings {
            state
                .db
                .remove_session_provider_binding(app_type, &binding.session_id)
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let mut stable_provider_ids = Vec::new();
    let mut degraded_provider_ids = Vec::new();
    for provider_id in ordered_provider_ids {
        let health = state
            .db
            .get_provider_health(&provider_id, app_type)
            .await
            .map_err(|e| e.to_string())?;

        if !health.is_healthy {
            continue;
        }

        if health.consecutive_failures == 0 {
            stable_provider_ids.push(provider_id);
        } else {
            degraded_provider_ids.push(provider_id);
        }
    }

    let candidate_provider_ids = if !stable_provider_ids.is_empty() {
        stable_provider_ids
    } else {
        degraded_provider_ids
    };
    if candidate_provider_ids.is_empty() {
        for binding in active_bindings {
            state
                .db
                .remove_session_provider_binding(app_type, &binding.session_id)
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let candidate_provider_set: HashSet<String> = candidate_provider_ids.iter().cloned().collect();
    for binding in active_bindings
        .into_iter()
        .filter(|binding| !candidate_provider_set.contains(&binding.provider_id))
    {
        let assignment = state
            .db
            .assign_session_provider_from_candidates(
                app_type,
                &binding.session_id,
                &candidate_provider_ids,
                app_config.session_routing_strategy.as_str(),
                app_config.session_max_sessions_per_provider,
                app_config.session_allow_shared_when_exhausted,
                idle_ttl_minutes,
            )
            .map_err(|e| e.to_string())?;

        if assignment.is_none() {
            state
                .db
                .remove_session_provider_binding(app_type, &binding.session_id)
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

async fn resolve_session_idle_ttl(
    state: &AppState,
    app_type: &str,
    idle_ttl_minutes: Option<u32>,
) -> Result<u32, String> {
    if let Some(value) = idle_ttl_minutes {
        return Ok(value.max(1));
    }

    state
        .db
        .get_proxy_config_for_app(app_type)
        .await
        .map(|config| config.session_idle_ttl_minutes.max(1))
        .map_err(|e| e.to_string())
}

async fn get_default_cost_multiplier_internal(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    let db = &state.db;
    db.get_default_cost_multiplier(app_type).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn get_default_cost_multiplier_test_hook(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    get_default_cost_multiplier_internal(state, app_type).await
}

/// 获取默认成本倍率
#[tauri::command]
pub async fn get_default_cost_multiplier(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<String, String> {
    get_default_cost_multiplier_internal(&state, &app_type)
        .await
        .map_err(|e| e.to_string())
}

async fn set_default_cost_multiplier_internal(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    let db = &state.db;
    db.set_default_cost_multiplier(app_type, value).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn set_default_cost_multiplier_test_hook(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    set_default_cost_multiplier_internal(state, app_type, value).await
}

/// 设置默认成本倍率
#[tauri::command]
pub async fn set_default_cost_multiplier(
    state: tauri::State<'_, AppState>,
    app_type: String,
    value: String,
) -> Result<(), String> {
    set_default_cost_multiplier_internal(&state, &app_type, &value)
        .await
        .map_err(|e| e.to_string())
}

async fn get_pricing_model_source_internal(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    let db = &state.db;
    db.get_pricing_model_source(app_type).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn get_pricing_model_source_test_hook(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    get_pricing_model_source_internal(state, app_type).await
}

/// 获取计费模式来源
#[tauri::command]
pub async fn get_pricing_model_source(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<String, String> {
    get_pricing_model_source_internal(&state, &app_type)
        .await
        .map_err(|e| e.to_string())
}

async fn set_pricing_model_source_internal(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    let db = &state.db;
    db.set_pricing_model_source(app_type, value).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn set_pricing_model_source_test_hook(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    set_pricing_model_source_internal(state, app_type, value).await
}

/// 设置计费模式来源
#[tauri::command]
pub async fn set_pricing_model_source(
    state: tauri::State<'_, AppState>,
    app_type: String,
    value: String,
) -> Result<(), String> {
    set_pricing_model_source_internal(&state, &app_type, &value)
        .await
        .map_err(|e| e.to_string())
}

/// 检查代理服务器是否正在运行
#[tauri::command]
pub async fn is_proxy_running(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.proxy_service.is_running().await)
}

/// 检查是否处于 Live 接管模式
#[tauri::command]
pub async fn is_live_takeover_active(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    state.proxy_service.is_takeover_active().await
}

/// 代理模式下切换供应商（热切换）
#[tauri::command]
pub async fn switch_proxy_provider(
    state: tauri::State<'_, AppState>,
    app_type: String,
    provider_id: String,
) -> Result<(), String> {
    state
        .proxy_service
        .switch_proxy_target(&app_type, &provider_id)
        .await
}

// ==================== 故障转移相关命令 ====================

/// 获取供应商健康状态
#[tauri::command]
pub async fn get_provider_health(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    app_type: String,
) -> Result<ProviderHealth, String> {
    let db = &state.db;
    db.get_provider_health(&provider_id, &app_type)
        .await
        .map_err(|e| e.to_string())
}

/// 重置熔断器
///
/// 重置后会检查是否应该切回队列中优先级更高的供应商：
/// 1. 检查自动故障转移是否开启
/// 2. 如果恢复的供应商在队列中优先级更高（queue_order 更小），则自动切换
#[tauri::command]
pub async fn reset_circuit_breaker(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    provider_id: String,
    app_type: String,
) -> Result<(), String> {
    // 1. 重置数据库健康状态
    let db = &state.db;
    db.update_provider_health(&provider_id, &app_type, true, None)
        .await
        .map_err(|e| e.to_string())?;

    // 2. 如果代理正在运行，重置内存中的熔断器状态
    state
        .proxy_service
        .reset_provider_circuit_breaker(&provider_id, &app_type)
        .await?;

    // 3. 检查是否应该切回优先级更高的供应商（从 proxy_config 表读取）
    // 只有当该应用已被代理接管（enabled=true）且开启了自动故障转移时才执行
    let (app_enabled, auto_failover_enabled) = match db.get_proxy_config_for_app(&app_type).await {
        Ok(config) => (config.enabled, config.auto_failover_enabled),
        Err(e) => {
            log::error!("[{app_type}] Failed to read proxy_config: {e}, defaulting to disabled");
            (false, false)
        }
    };

    if app_enabled && auto_failover_enabled && state.proxy_service.is_running().await {
        // 获取当前供应商 ID
        let current_id = db
            .get_current_provider(&app_type)
            .map_err(|e| e.to_string())?;

        if let Some(current_id) = current_id {
            // 获取故障转移队列
            let queue = db
                .get_failover_queue(&app_type)
                .map_err(|e| e.to_string())?;

            // 找到恢复的供应商和当前供应商在队列中的位置（使用 sort_index）
            let restored_order = queue
                .iter()
                .find(|item| item.provider_id == provider_id)
                .and_then(|item| item.sort_index);

            let current_order = queue
                .iter()
                .find(|item| item.provider_id == current_id)
                .and_then(|item| item.sort_index);

            // 如果恢复的供应商优先级更高（sort_index 更小），则切换
            if let (Some(restored), Some(current)) = (restored_order, current_order) {
                if restored < current {
                    log::info!(
                        "[Recovery] 供应商 {provider_id} 已恢复且优先级更高 (P{restored} vs P{current})，自动切换"
                    );

                    // 获取供应商名称用于日志和事件
                    let provider_name = db
                        .get_all_providers(&app_type)
                        .ok()
                        .and_then(|providers| providers.get(&provider_id).map(|p| p.name.clone()))
                        .unwrap_or_else(|| provider_id.clone());

                    // 创建故障转移切换管理器并执行切换
                    let switch_manager =
                        crate::proxy::failover_switch::FailoverSwitchManager::new(db.clone());
                    if let Err(e) = switch_manager
                        .try_switch(Some(&app_handle), &app_type, &provider_id, &provider_name)
                        .await
                    {
                        log::error!("[Recovery] 自动切换失败: {e}");
                    }
                }
            }
        }
    }

    Ok(())
}

/// 获取熔断器配置
#[tauri::command]
pub async fn get_circuit_breaker_config(
    state: tauri::State<'_, AppState>,
) -> Result<CircuitBreakerConfig, String> {
    let db = &state.db;
    db.get_circuit_breaker_config()
        .await
        .map_err(|e| e.to_string())
}

/// 更新熔断器配置
#[tauri::command]
pub async fn update_circuit_breaker_config(
    state: tauri::State<'_, AppState>,
    config: CircuitBreakerConfig,
) -> Result<(), String> {
    let db = &state.db;

    // 1. 更新数据库配置
    db.update_circuit_breaker_config(&config)
        .await
        .map_err(|e| e.to_string())?;

    // 2. 如果代理正在运行，热更新内存中的熔断器配置
    state
        .proxy_service
        .update_circuit_breaker_configs(config)
        .await?;

    Ok(())
}

/// 获取熔断器统计信息（仅当代理服务器运行时）
#[tauri::command]
pub async fn get_circuit_breaker_stats(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    app_type: String,
) -> Result<Option<CircuitBreakerStats>, String> {
    // 这个功能需要访问运行中的代理服务器的内存状态
    // 目前先返回 None，后续可以通过 ProxyService 暴露接口来实现
    let _ = (state, provider_id, app_type);
    Ok(None)
}
