//! 故障转移队列命令
//!
//! 管理代理模式下的故障转移队列（基于 providers 表的 in_failover_queue 字段）

use crate::app_config::AppType;
use crate::database::FailoverQueueItem;
use crate::provider::Provider;
use crate::proxy::types::AppProxyConfig;
use crate::store::AppState;
use std::str::FromStr;
use tauri::Emitter;

fn effective_auto_failover_enabled(config: &AppProxyConfig) -> bool {
    config.enabled && config.auto_failover_enabled
}

async fn disable_auto_failover_and_restore_single_target(
    state: &AppState,
    app_type: &str,
    app_enum: &AppType,
) -> Result<Option<String>, String> {
    let queue = state
        .db
        .get_failover_queue(app_type)
        .map_err(|e| e.to_string())?;
    let restored_provider_id = queue.first().map(|item| item.provider_id.clone());

    let takeover_enabled = state
        .db
        .get_proxy_config_for_app(app_type)
        .await
        .map(|config| config.enabled)
        .map_err(|e| e.to_string())?;
    if let Some(provider_id) = restored_provider_id.as_deref() {
        if takeover_enabled {
            state
                .proxy_service
                .hot_switch_provider(app_type, provider_id)
                .await?;
        } else {
            state
                .db
                .set_current_provider(app_type, provider_id)
                .map_err(|e| e.to_string())?;
            crate::settings::set_current_provider(app_enum, Some(provider_id))
                .map_err(|e| e.to_string())?;
        }
    } else {
        let _ = state.db.clear_current_provider(app_type);
        let _ = crate::settings::set_current_provider(app_enum, None);
    }

    if !takeover_enabled {
        state
            .proxy_service
            .sync_failover_active_target(app_type)
            .await?;
    }

    Ok(restored_provider_id)
}

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
        .map_err(|e| e.to_string())?;

    state
        .db
        .reset_provider_health(&provider_id, &app_type)
        .await
        .map_err(|e| e.to_string())?;

    state
        .proxy_service
        .reset_provider_circuit_breaker(&provider_id, &app_type)
        .await?;

    state
        .proxy_service
        .sync_failover_active_target(&app_type)
        .await
}

/// 从故障转移队列移除供应商
#[tauri::command]
pub async fn remove_from_failover_queue(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    app_type: String,
    provider_id: String,
) -> Result<(), String> {
    state
        .db
        .remove_from_failover_queue(&app_type, &provider_id)
        .map_err(|e| e.to_string())?;

    state
        .proxy_service
        .reconcile_failover_after_provider_removal(&provider_id, &app_type)
        .await?;

    let event_data = serde_json::json!({
        "appType": app_type,
        "providerId": provider_id,
        "source": "failoverQueueChanged"
    });
    let _ = app.emit("provider-switched", event_data);

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
        .map(|config| effective_auto_failover_enabled(&config))
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

    let mut config = state
        .db
        .get_proxy_config_for_app(&app_type)
        .await
        .map_err(|e| e.to_string())?;

    if enabled {
        if !matches!(app_enum, AppType::Claude | AppType::Codex | AppType::Gemini) {
            return Err("该应用暂不支持代理故障转移".to_string());
        }

        if !config.enabled || !state.proxy_service.is_running().await {
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
    let mut auto_added_provider_id: Option<String> = None;
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
            auto_added_provider_id = Some(current_id);

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

    // 开启前先切到 P1。只有切换成功后才写入 auto_failover_enabled=true，
    // 避免 P1 不可切换（例如 official provider）时留下“开关已开但目标未切”的脏状态。
    if enabled {
        if let Err(e) = state
            .proxy_service
            .switch_proxy_target(&app_type, &p1_provider_id)
            .await
        {
            if let Some(provider_id) = auto_added_provider_id {
                let _ = state.db.remove_from_failover_queue(&app_type, &provider_id);
            }
            return Err(e);
        }
    }

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
        let restored_provider_id =
            disable_auto_failover_and_restore_single_target(&state, &app_type, &app_enum).await?;

        if let Some(provider_id) = restored_provider_id {
            let event_data = serde_json::json!({
                "appType": app_type,
                "providerId": provider_id,
                "source": "failoverDisabled"
            });
            let _ = app.emit("provider-switched", event_data);
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

#[cfg(test)]
mod tests {
    use super::{disable_auto_failover_and_restore_single_target, effective_auto_failover_enabled};
    use crate::app_config::AppType;
    use crate::proxy::types::AppProxyConfig;
    use crate::proxy::types::ProxyConfig;
    use crate::proxy::CircuitState;
    use crate::proxy::ProviderRouter;
    use crate::store::AppState;
    use crate::{Database, Provider};
    use serde_json::json;
    use serial_test::serial;
    use std::env;
    use std::sync::Arc;
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

    async fn unused_local_port() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local ephemeral port");
        listener.local_addr().expect("read local addr").port()
    }

    fn sample_config(enabled: bool, auto_failover_enabled: bool) -> AppProxyConfig {
        AppProxyConfig {
            app_type: "claude".to_string(),
            enabled,
            auto_failover_enabled,
            session_routing_enabled: enabled && auto_failover_enabled,
            session_routing_idle_ttl_seconds: 600,
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

    #[test]
    fn effective_auto_failover_enabled_requires_takeover() {
        assert!(!effective_auto_failover_enabled(&sample_config(
            false, true
        )));
        assert!(!effective_auto_failover_enabled(&sample_config(
            false, false
        )));
        assert!(!effective_auto_failover_enabled(&sample_config(
            true, false
        )));
        assert!(effective_auto_failover_enabled(&sample_config(true, true)));
    }

    #[tokio::test]
    async fn add_to_failover_queue_resets_health_and_breaker_state() {
        let db = Arc::new(Database::memory().expect("init db"));
        let router = ProviderRouter::new(db.clone());

        let provider = Provider::with_id(
            "provider-a".to_string(),
            "Provider A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save provider");

        db.update_provider_health("provider-a", "claude", false, Some("boom".into()))
            .await
            .expect("seed unhealthy state");
        router
            .record_result(
                "provider-a",
                "claude",
                false,
                false,
                Some("Invalid API Key".into()),
            )
            .await
            .expect("seed breaker state");
        let before = router
            .get_circuit_breaker_stats("provider-a", "claude")
            .await
            .expect("breaker stats before");
        assert_eq!(before.state, CircuitState::Closed);
        assert_eq!(before.consecutive_failures, 1);
        assert_eq!(before.failed_requests, 1);

        db.add_to_failover_queue("claude", "provider-a")
            .expect("add to failover queue");
        db.reset_provider_health("provider-a", "claude")
            .await
            .expect("queue add should reset health");
        router.reset_provider_breaker("provider-a", "claude").await;

        let health = db
            .get_provider_health("provider-a", "claude")
            .await
            .expect("health after reset");
        assert!(health.is_healthy);
        assert_eq!(health.consecutive_failures, 0);

        let after = router
            .get_circuit_breaker_stats("provider-a", "claude")
            .await
            .expect("breaker stats after");
        assert_eq!(after.state, CircuitState::Closed);
        assert_eq!(after.consecutive_failures, 0);
        assert_eq!(after.consecutive_successes, 0);
        assert_eq!(after.total_requests, 0);
        assert_eq!(after.failed_requests, 0);
    }

    #[tokio::test]
    #[serial]
    async fn disable_auto_failover_while_takeover_enabled_restores_current_provider_and_active_target(
    ) {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());
        let port = unused_local_port().await;

        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("seed proxy config");

        let mut provider_a = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://a.example"
                }
            }),
            None,
        );
        provider_a.sort_index = Some(20);
        let mut provider_b = Provider::with_id(
            "claude-b".to_string(),
            "Claude B".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-b",
                    "ANTHROPIC_BASE_URL": "https://b.example"
                }
            }),
            None,
        );
        provider_b.sort_index = Some(10);

        db.save_provider("claude", &provider_a)
            .expect("save provider a");
        db.save_provider("claude", &provider_b)
            .expect("save provider b");
        db.add_to_failover_queue("claude", &provider_a.id)
            .expect("queue provider a");
        db.add_to_failover_queue("claude", &provider_b.id)
            .expect("queue provider b");
        db.set_current_provider("claude", &provider_a.id)
            .expect("seed db current provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider_a.id))
            .expect("seed local current provider");

        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable failover");

        db.clear_current_provider("claude")
            .expect("clear db current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Claude, None)
            .expect("clear local current provider for failover mode");

        state
            .proxy_service
            .sync_failover_active_target("claude")
            .await
            .expect("sync queue head before disabling failover");

        let status_before = state
            .proxy_service
            .get_status()
            .await
            .expect("get proxy status before disabling failover");
        assert!(
            status_before
                .active_targets
                .iter()
                .any(|target| target.app_type == "claude" && target.provider_id == provider_b.id),
            "precondition: failover mode should point active target at queue head"
        );

        disable_auto_failover_and_restore_single_target(&state, "claude", &AppType::Claude)
            .await
            .expect("disable failover and restore single-target takeover");

        assert_eq!(
            crate::settings::get_effective_current_provider(&state.db, &AppType::Claude)
                .expect("get effective current provider"),
            Some(provider_b.id.clone()),
            "disabling failover while takeover stays enabled must restore queue head as current provider"
        );

        let status_after = state
            .proxy_service
            .get_status()
            .await
            .expect("get proxy status after disabling failover");
        assert!(
            status_after
                .active_targets
                .iter()
                .any(|target| target.app_type == "claude" && target.provider_id == provider_b.id),
            "single-target takeover mode must keep the restored current provider as active target"
        );

        if state.proxy_service.is_running().await {
            state
                .proxy_service
                .stop()
                .await
                .expect("stop proxy service");
        }
    }
}
