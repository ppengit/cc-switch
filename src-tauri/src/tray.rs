//! 托盘菜单管理模块
//!
//! 负责系统托盘图标和菜单的创建、更新和事件处理。

use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

use crate::app_config::AppType;
use crate::error::AppError;
use crate::store::AppState;

/// 托盘菜单文本（国际化）
#[derive(Clone, Copy)]
pub struct TrayTexts {
    pub quit: &'static str,
}

impl TrayTexts {
    pub fn from_language(language: &str) -> Self {
        match language {
            "en" => Self { quit: "Quit" },
            "ja" => Self { quit: "終了" },
            _ => Self { quit: "退出" },
        }
    }
}

/// 托盘应用分区配置
pub struct TrayAppSection {
    pub app_type: AppType,
    pub prefix: &'static str,
    pub header_label: &'static str,
    pub log_name: &'static str,
}

/// Auto 菜单项后缀
pub const AUTO_SUFFIX: &str = "auto";

pub const TRAY_SECTIONS: [TrayAppSection; 3] = [
    TrayAppSection {
        app_type: AppType::Claude,
        prefix: "claude_",
        header_label: "Claude",
        log_name: "Claude",
    },
    TrayAppSection {
        app_type: AppType::Codex,
        prefix: "codex_",
        header_label: "Codex",
        log_name: "Codex",
    },
    TrayAppSection {
        app_type: AppType::Gemini,
        prefix: "gemini_",
        header_label: "Gemini",
        log_name: "Gemini",
    },
];

/// 添加供应商分区到菜单
fn build_provider_submenu(
    app: &tauri::AppHandle,
    manager: &crate::provider::ProviderManager,
    section: &TrayAppSection,
) -> Result<tauri::menu::Submenu<tauri::Wry>, AppError> {
    let mut submenu_builder = SubmenuBuilder::with_id(
        app,
        format!("{}_submenu", section.prefix),
        section.header_label,
    );

    // Auto (Failover) menu item is hidden from tray; the feature is still
    // accessible from the Settings page. Keep the surrounding code intact so
    // it can be re-enabled easily in the future.

    let mut sorted_providers: Vec<_> = manager.providers.iter().collect();
    sorted_providers.sort_by(|(_, a), (_, b)| {
        match (a.sort_index, b.sort_index) {
            (Some(idx_a), Some(idx_b)) => return idx_a.cmp(&idx_b),
            (Some(_), None) => return std::cmp::Ordering::Less,
            (None, Some(_)) => return std::cmp::Ordering::Greater,
            _ => {}
        }

        match (a.created_at, b.created_at) {
            (Some(time_a), Some(time_b)) => return time_a.cmp(&time_b),
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            _ => {}
        }

        a.name.cmp(&b.name)
    });

    for (id, provider) in sorted_providers {
        let is_current = manager.current == *id;
        let item = CheckMenuItem::with_id(
            app,
            format!("{}{}", section.prefix, id),
            &provider.name,
            true,
            is_current,
            None::<&str>,
        )
        .map_err(|e| AppError::Message(format!("创建{}菜单项失败: {e}", section.log_name)))?;
        submenu_builder = submenu_builder.item(&item);
    }

    submenu_builder
        .build()
        .map_err(|e| AppError::Message(format!("构建{}子菜单失败: {e}", section.log_name)))
}

/// 处理供应商托盘事件
pub fn handle_provider_tray_event(app: &tauri::AppHandle, event_id: &str) -> bool {
    for section in TRAY_SECTIONS.iter() {
        if let Some(suffix) = event_id.strip_prefix(section.prefix) {
            // 处理 Auto 点击
            if suffix == AUTO_SUFFIX {
                log::info!("切换到{} Auto模式", section.log_name);
                let app_handle = app.clone();
                let app_type = section.app_type.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(e) = handle_auto_click(&app_handle, &app_type) {
                        log::error!("切换{}Auto模式失败: {e}", section.log_name);
                    }
                });
                return true;
            }

            // 处理供应商点击
            log::info!("切换到{}供应商: {suffix}", section.log_name);
            let app_handle = app.clone();
            let provider_id = suffix.to_string();
            let app_type = section.app_type.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = handle_provider_click(&app_handle, &app_type, &provider_id) {
                    log::error!("切换{}供应商失败: {e}", section.log_name);
                }
            });
            return true;
        }
    }
    false
}

/// 处理 Auto 点击：启用 proxy 和 auto_failover
fn handle_auto_click(app: &tauri::AppHandle, app_type: &AppType) -> Result<(), AppError> {
    if let Some(app_state) = app.try_state::<AppState>() {
        let app_type_str = app_type.as_str();

        // 强一致语义：Auto 模式开启后立即切到队列 P1（P1→P2→...）
        // 若队列为空，则尝试把“当前供应商”自动加入队列作为 P1，避免用户陷入无法开启的死锁。
        let mut queue = app_state.db.get_failover_queue(app_type_str)?;
        if queue.is_empty() {
            let current_id =
                crate::settings::get_effective_current_provider(&app_state.db, app_type)?;
            let Some(current_id) = current_id else {
                return Err(AppError::Message(
                    "故障转移队列为空，且未设置当前供应商，无法启用 Auto 模式".to_string(),
                ));
            };
            app_state
                .db
                .add_to_failover_queue(app_type_str, &current_id)?;
            queue = app_state.db.get_failover_queue(app_type_str)?;
        }

        let p1_provider_id = queue
            .first()
            .map(|item| item.provider_id.clone())
            .ok_or_else(|| AppError::Message("故障转移队列为空，无法启用 Auto 模式".to_string()))?;

        // 真正启用 failover：启动代理服务 + 执行接管 + 开启 auto_failover
        let proxy_service = &app_state.proxy_service;

        // 1) 确保代理服务运行（会自动设置 proxy_enabled = true）
        let is_running = futures::executor::block_on(proxy_service.is_running());
        if !is_running {
            log::info!("[Tray] Auto 模式：启动代理服务");
            if let Err(e) = futures::executor::block_on(proxy_service.start()) {
                log::error!("[Tray] 启动代理服务失败: {e}");
                return Err(AppError::Message(format!("启动代理服务失败: {e}")));
            }
        }

        // 2) 执行 Live 配置接管（确保该 app 被代理接管）
        log::info!("[Tray] Auto 模式：对 {app_type_str} 执行接管");
        if let Err(e) =
            futures::executor::block_on(proxy_service.set_takeover_for_app(app_type_str, true))
        {
            log::error!("[Tray] 执行接管失败: {e}");
            return Err(AppError::Message(format!("执行接管失败: {e}")));
        }

        // 3) 设置 auto_failover_enabled = true
        app_state
            .db
            .set_proxy_flags_sync(app_type_str, true, true)?;

        // 3.1) 立即切到队列 P1（热切换：不写 Live，仅更新 DB/settings/备份）
        if let Err(e) = futures::executor::block_on(
            proxy_service.switch_proxy_target(app_type_str, &p1_provider_id),
        ) {
            log::error!("[Tray] Auto 模式切换到队列 P1 失败: {e}");
            return Err(AppError::Message(format!(
                "Auto 模式切换到队列 P1 失败: {e}"
            )));
        }

        // 4) 更新托盘菜单
        if let Ok(new_menu) = create_tray_menu(app, app_state.inner()) {
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_menu(Some(new_menu));
            }
        }

        // 5) 发射事件到前端
        let event_data = serde_json::json!({
            "appType": app_type_str,
            "proxyEnabled": true,
            "autoFailoverEnabled": true,
            "providerId": p1_provider_id
        });
        if let Err(e) = app.emit("proxy-flags-changed", event_data.clone()) {
            log::error!("发射 proxy-flags-changed 事件失败: {e}");
        }
        // 发射 provider-switched 事件（保持向后兼容，Auto 切换也算一种切换）
        if let Err(e) = app.emit("provider-switched", event_data) {
            log::error!("发射 provider-switched 事件失败: {e}");
        }
    }
    Ok(())
}

/// 处理供应商点击：关闭 auto_failover + 切换供应商
fn handle_provider_click(
    app: &tauri::AppHandle,
    app_type: &AppType,
    provider_id: &str,
) -> Result<(), AppError> {
    if let Some(app_state) = app.try_state::<AppState>() {
        let app_type_str = app_type.as_str();

        // 获取当前 proxy 状态，保持 enabled 不变，只关闭 auto_failover
        let (proxy_enabled, _) = app_state.db.get_proxy_flags_sync(app_type_str);
        app_state
            .db
            .set_proxy_flags_sync(app_type_str, proxy_enabled, false)?;

        // 切换供应商
        crate::commands::switch_provider(
            app_state.clone(),
            app_type_str.to_string(),
            provider_id.to_string(),
        )
        .map_err(AppError::Message)?;

        // 更新托盘菜单
        if let Ok(new_menu) = create_tray_menu(app, app_state.inner()) {
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_menu(Some(new_menu));
            }
        }

        // 发射事件到前端
        let event_data = serde_json::json!({
            "appType": app_type_str,
            "proxyEnabled": proxy_enabled,
            "autoFailoverEnabled": false,
            "providerId": provider_id
        });
        if let Err(e) = app.emit("proxy-flags-changed", event_data.clone()) {
            log::error!("发射 proxy-flags-changed 事件失败: {e}");
        }
        // 发射 provider-switched 事件（保持向后兼容）
        if let Err(e) = app.emit("provider-switched", event_data) {
            log::error!("发射 provider-switched 事件失败: {e}");
        }
    }
    Ok(())
}

/// 创建动态托盘菜单
pub fn create_tray_menu(
    app: &tauri::AppHandle,
    app_state: &AppState,
) -> Result<Menu<tauri::Wry>, AppError> {
    let app_settings = crate::settings::get_settings();
    let tray_texts = TrayTexts::from_language(app_settings.language.as_deref().unwrap_or("zh"));

    // Get visible apps setting, default to all visible
    let visible_apps = app_settings.visible_apps.unwrap_or_default();

    let mut menu_builder = MenuBuilder::new(app);
    let mut has_sections = false;

    // 右键托盘菜单只显示已配置的应用，并在二级菜单中列出供应商
    for section in TRAY_SECTIONS.iter() {
        // Skip hidden apps
        if !visible_apps.is_visible(&section.app_type) {
            continue;
        }

        let app_type_str = section.app_type.as_str();
        let providers = app_state.db.get_all_providers(app_type_str)?;
        if providers.is_empty() {
            continue;
        }

        // 使用有效的当前供应商 ID（验证存在性，自动清理失效 ID）
        let current_id =
            crate::settings::get_effective_current_provider(&app_state.db, &section.app_type)?
                .unwrap_or_default();

        let manager = crate::provider::ProviderManager {
            providers,
            current: current_id,
        };

        let submenu = build_provider_submenu(app, &manager, section)?;
        menu_builder = menu_builder.item(&submenu);
        has_sections = true;
    }

    if has_sections {
        menu_builder = menu_builder.separator();
    }

    // 退出菜单
    let quit_item = MenuItem::with_id(app, "quit", tray_texts.quit, true, None::<&str>)
        .map_err(|e| AppError::Message(format!("创建退出菜单失败: {e}")))?;

    menu_builder = menu_builder.item(&quit_item);

    menu_builder
        .build()
        .map_err(|e| AppError::Message(format!("构建菜单失败: {e}")))
}

pub fn refresh_tray_menu(app: &tauri::AppHandle) {
    if let Some(app_state) = app.try_state::<AppState>() {
        if let Ok(new_menu) = create_tray_menu(app, app_state.inner()) {
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_menu(Some(new_menu));
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn apply_tray_policy(app: &tauri::AppHandle, dock_visible: bool) {
    use tauri::ActivationPolicy;

    let desired_policy = if dock_visible {
        ActivationPolicy::Regular
    } else {
        ActivationPolicy::Accessory
    };

    if let Err(err) = app.set_dock_visibility(dock_visible) {
        log::warn!("设置 Dock 显示状态失败: {err}");
    }

    if let Err(err) = app.set_activation_policy(desired_policy) {
        log::warn!("设置激活策略失败: {err}");
    }
}

/// 处理托盘菜单事件
pub fn handle_tray_menu_event(app: &tauri::AppHandle, event_id: &str) {
    log::info!("处理托盘菜单事件: {event_id}");

    match event_id {
        "show_main" => {
            show_main_window(app);
        }
        "quit" => {
            log::info!("退出应用");
            app.exit(0);
        }
        _ => {
            if handle_provider_tray_event(app, event_id) {
                return;
            }
            log::warn!("未处理的菜单事件: {event_id}");
        }
    }
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        {
            let _ = window.set_skip_taskbar(false);
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        {
            apply_tray_policy(app, true);
        }
    }
}
