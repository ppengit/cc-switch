//! 故障转移队列命令
//!
//! 管理代理模式下的故障转移队列（基于 providers 表的 in_failover_queue 字段）

use crate::app_config::AppType;
use crate::database::FailoverQueueItem;
use crate::provider::Provider;
use crate::store::AppState;
use std::str::FromStr;
use tauri::Emitter;

/// 获取故障转移队列
#[tauri::command]
pub async fn get_failover_queue(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<Vec<FailoverQueueItem>, String> {
    state
        .db
        .get_failover_queue(&app_type)
        .map_err(|e| e.to_string())
}

/// 获取可添加到故障转移队列的供应商（不在队列中的）
#[tauri::command]
pub async fn get_available_providers_for_failover(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<Vec<Provider>, String> {
    state
        .db
        .get_available_providers_for_failover(&app_type)
        .map_err(|e| e.to_string())
}

/// 添加供应商到故障转移队列
#[tauri::command]
pub async fn add_to_failover_queue(
    state: tauri::State<'_, AppState>,
    app_type: String,
    provider_id: String,
) -> Result<(), String> {
    state
        .db
        .add_to_failover_queue(&app_type, &provider_id)
        .map_err(|e| e.to_string())
}

/// 从故障转移队列移除供应商
#[tauri::command]
pub async fn remove_from_failover_queue(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    app_type: String,
    provider_id: String,
) -> Result<(), String> {
    let was_current_provider = state
        .db
        .get_current_provider(&app_type)
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some(provider_id.as_str());

    state
        .db
        .remove_from_failover_queue(&app_type, &provider_id)
        .map_err(|e| e.to_string())?;

    state
        .proxy_service
        .clear_provider_runtime_state(&provider_id, &app_type)
        .await?;

    let (app_enabled, auto_failover_enabled) =
        match state.db.get_proxy_config_for_app(&app_type).await {
            Ok(config) => (config.enabled, config.auto_failover_enabled),
            Err(error) => {
                log::warn!("[Failover] 读取 {app_type} 代理配置失败，跳过即时切换: {error}");
                (false, false)
            }
        };

    if was_current_provider
        && app_enabled
        && auto_failover_enabled
        && state.proxy_service.is_running().await
    {
        if let Some(next_provider) = state
            .db
            .get_failover_queue(&app_type)
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
        {
            let switch_manager =
                crate::proxy::failover_switch::FailoverSwitchManager::new(state.db.clone());
            if let Err(error) = switch_manager
                .try_switch(
                    Some(&app),
                    &app_type,
                    &next_provider.provider_id,
                    &next_provider.provider_name,
                )
                .await
            {
                log::error!("[Failover] 禁用后切换到下一个供应商失败: {error}");
            }
        }
    }

    Ok(())
}

/// 获取指定应用的自动故障转移开关状态（从 proxy_config 表读取）
#[tauri::command]
pub async fn get_auto_failover_enabled(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<bool, String> {
    state
        .db
        .get_proxy_config_for_app(&app_type)
        .await
        .map(|config| config.auto_failover_enabled)
        .map_err(|e| e.to_string())
}

/// 设置指定应用的自动故障转移开关状态（写入 proxy_config 表）
///
/// 注意：关闭故障转移时不会清除队列，队列内容会保留供下次开启时使用
#[tauri::command]
pub async fn set_auto_failover_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    app_type: String,
    enabled: bool,
) -> Result<(), String> {
    log::info!(
        "[Failover] Setting auto_failover_enabled: app_type='{app_type}', enabled={enabled}"
    );

    let app_enum =
        AppType::from_str(&app_type).map_err(|_| format!("无效的应用类型: {app_type}"))?;

    if enabled {
        if !matches!(app_enum, AppType::Claude | AppType::Codex | AppType::Gemini) {
            return Err("该应用暂不支持代理故障转移".to_string());
        }

        let proxy_config = state
            .db
            .get_proxy_config_for_app(&app_type)
            .await
            .map_err(|e| e.to_string())?;

        if !proxy_config.enabled || !state.proxy_service.is_running().await {
            return Err("请先开启该应用的代理接管；故障转移只在代理接管模式下生效".to_string());
        }
    }

    // 强一致语义：开启故障转移后立即让队列就位（首位作为活动目标显示用）
    //
    // 说明：
    // - 仅在 enabled=true 时执行"准备 P1"
    // - 若队列为空，则尝试把"当前供应商"自动加入队列作为 P1，避免用户在 UI 上陷入死锁（无法先加队列再开启）
    // - 故障转移模式下**不应该**存在"当前供应商"概念，因此本次开启会把
    //   settings.current_provider_xxx 与 DB.is_current 一并清空。
    let p1_provider_id = if enabled {
        let mut queue = state
            .db
            .get_failover_queue(&app_type)
            .map_err(|e| e.to_string())?;

        if queue.is_empty() {
            let current_id = crate::settings::get_effective_current_provider(&state.db, &app_enum)
                .map_err(|e| e.to_string())?;

            let Some(current_id) = current_id else {
                return Err("故障转移队列为空，且未设置当前供应商，无法开启故障转移".to_string());
            };

            state
                .db
                .add_to_failover_queue(&app_type, &current_id)
                .map_err(|e| e.to_string())?;

            queue = state
                .db
                .get_failover_queue(&app_type)
                .map_err(|e| e.to_string())?;
        }

        queue
            .first()
            .map(|item| item.provider_id.clone())
            .ok_or_else(|| "故障转移队列为空，无法开启故障转移".to_string())?
    } else {
        String::new()
    };

    // 读取当前配置
    let mut config = state
        .db
        .get_proxy_config_for_app(&app_type)
        .await
        .map_err(|e| e.to_string())?;

    // 更新 auto_failover_enabled 字段
    config.auto_failover_enabled = enabled;

    // 写回数据库
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .map_err(|e| e.to_string())?;

    if enabled {
        // 故障转移模式下不应该有"当前供应商"概念：清空两端的 is_current 状态。
        // - settings.current_provider_xxx：本地设备级
        // - DB.is_current：跨设备同步默认值
        let _ = crate::settings::set_current_provider(&app_enum, None);
        if let Err(error) = state.db.clear_current_provider(&app_type) {
            log::warn!("[Failover] 清空 {app_type} 的 is_current 失败: {error}");
        }

        // 让 P1 立刻成为路由目标（仅更新内存中的 active_target，不写 is_current）。
        if let Some(provider) = state
            .db
            .get_provider_by_id(&p1_provider_id, &app_type)
            .map_err(|e| e.to_string())?
        {
            state
                .proxy_service
                .set_active_target_only(&app_type, &provider.id, &provider.name)
                .await;
        }

        // 发射 provider-switched 事件（让前端刷新当前活动目标显示）
        let event_data = serde_json::json!({
            "appType": app_type,
            "providerId": p1_provider_id,
            "source": "failoverEnabled"
        });
        let _ = app.emit("provider-switched", event_data);
    } else {
        // 关闭故障转移：把队列首位回填为 current_provider，避免回到关闭模式时无可用目标。
        let queue = state
            .db
            .get_failover_queue(&app_type)
            .map_err(|e| e.to_string())?;
        if let Some(first) = queue.first() {
            let _ = state.db.set_current_provider(&app_type, &first.provider_id);
            let _ = crate::settings::set_current_provider(&app_enum, Some(&first.provider_id));
        }
    }

    // 刷新托盘菜单，确保状态同步
    if let Ok(new_menu) = crate::tray::create_tray_menu(&app, &state) {
        if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
            let _ = tray.set_menu(Some(new_menu));
        }
    }

    Ok(())
}
