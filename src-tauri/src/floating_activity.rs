use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;

pub const PROXY_ACTIVITY_FLOATING_WINDOW_LABEL: &str = "proxy-activity-floating";
const WINDOW_WIDTH: f64 = 292.0;
const WINDOW_HEIGHT: f64 = 144.0;
const WINDOW_MARGIN: f64 = 24.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyActivityFloatingSettings {
    pub visible: bool,
    pub opacity: f64,
}

pub fn current_settings() -> ProxyActivityFloatingSettings {
    let settings = crate::settings::get_settings();
    ProxyActivityFloatingSettings {
        visible: settings.show_proxy_activity_floating_window,
        opacity: crate::settings::clamp_proxy_activity_floating_opacity(
            settings.proxy_activity_floating_opacity,
        ),
    }
}

pub fn sync_on_startup(app: &tauri::AppHandle) {
    let settings = current_settings();
    if settings.visible {
        if let Err(err) = ensure_visible(app) {
            log::warn!("启动实时请求浮窗失败: {err}");
        }
    }
    emit_settings(app);
}

pub fn set_visible(app: &tauri::AppHandle, visible: bool) -> Result<(), AppError> {
    crate::settings::update_settings({
        let mut settings = crate::settings::get_settings();
        settings.show_proxy_activity_floating_window = visible;
        settings
    })?;

    if visible {
        ensure_visible(app)?;
    } else if let Some(window) = app.get_webview_window(PROXY_ACTIVITY_FLOATING_WINDOW_LABEL) {
        window
            .hide()
            .map_err(|e| AppError::Message(format!("隐藏实时请求浮窗失败: {e}")))?;
    }

    emit_settings(app);
    crate::tray::refresh_tray_menu(app);
    Ok(())
}

pub fn set_opacity(app: &tauri::AppHandle, opacity: f64) -> Result<(), AppError> {
    let opacity = crate::settings::clamp_proxy_activity_floating_opacity(opacity);
    crate::settings::update_settings({
        let mut settings = crate::settings::get_settings();
        settings.proxy_activity_floating_opacity = opacity;
        settings
    })?;

    emit_settings(app);
    Ok(())
}

pub fn ensure_visible(app: &tauri::AppHandle) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window(PROXY_ACTIVITY_FLOATING_WINDOW_LABEL) {
        window
            .show()
            .map_err(|e| AppError::Message(format!("显示实时请求浮窗失败: {e}")))?;
        let _ = window.set_always_on_top(true);
        return Ok(());
    }

    let (x, y) = default_window_position(app).unwrap_or((WINDOW_MARGIN, WINDOW_MARGIN));
    let _window = WebviewWindowBuilder::new(
        app,
        PROXY_ACTIVITY_FLOATING_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=proxy-activity-floating".into()),
    )
    .title("CC Switch Requests")
    .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(true)
    .position(x, y)
    .build()
    .map_err(|e| AppError::Message(format!("创建实时请求浮窗失败: {e}")))?;

    emit_settings(app);
    Ok(())
}

fn emit_settings(app: &tauri::AppHandle) {
    if let Err(err) = app.emit(
        "proxy-activity-floating-settings-changed",
        current_settings(),
    ) {
        log::debug!("发送实时请求浮窗设置事件失败: {err}");
    }
}

fn default_window_position(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let position = monitor.position();
    let size = monitor.size();
    Some((
        f64::from(position.x) + f64::from(size.width) - WINDOW_WIDTH - WINDOW_MARGIN,
        f64::from(position.y) + f64::from(size.height) - WINDOW_HEIGHT - WINDOW_MARGIN,
    ))
}
