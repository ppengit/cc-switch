use crate::error::AppError;

#[cfg(not(target_os = "windows"))]
use auto_launch::{AutoLaunch, AutoLaunchBuilder};
#[cfg(target_os = "windows")]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(target_os = "windows")]
use winreg::RegKey;

const AUTO_LAUNCH_APP_NAME: &str = "CC Switch";

#[cfg(target_os = "windows")]
const WINDOWS_RUN_REG_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

fn current_exe_path() -> Result<std::path::PathBuf, AppError> {
    std::env::current_exe().map_err(|e| AppError::Message(format!("无法获取应用路径: {e}")))
}

#[cfg(target_os = "macos")]
fn get_macos_app_bundle_path(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let path_str = exe_path.to_string_lossy();
    if let Some(app_pos) = path_str.find(".app/Contents/MacOS/") {
        let app_bundle_end = app_pos + 4;
        Some(std::path::PathBuf::from(&path_str[..app_bundle_end]))
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn get_auto_launch() -> Result<AutoLaunch, AppError> {
    let exe_path = current_exe_path()?;

    #[cfg(target_os = "macos")]
    let app_path = get_macos_app_bundle_path(&exe_path).unwrap_or(exe_path);

    #[cfg(not(target_os = "macos"))]
    let app_path = exe_path;

    AutoLaunchBuilder::new()
        .set_app_name(AUTO_LAUNCH_APP_NAME)
        .set_app_path(&app_path.to_string_lossy())
        .build()
        .map_err(|e| AppError::Message(format!("创建开机自启实例失败: {e}")))
}

#[cfg(target_os = "windows")]
fn windows_auto_launch_value() -> Result<String, AppError> {
    let exe_path = current_exe_path()?;
    Ok(format!("\"{}\"", exe_path.display()))
}

#[cfg(target_os = "windows")]
fn enable_auto_launch_windows() -> Result<(), AppError> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu
        .create_subkey(WINDOWS_RUN_REG_PATH)
        .map_err(|e| AppError::Message(format!("创建开机启动注册表项失败: {e}")))?;
    let value = windows_auto_launch_value()?;
    run_key
        .set_value(AUTO_LAUNCH_APP_NAME, &value)
        .map_err(|e| AppError::Message(format!("写入开机启动注册表失败: {e}")))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn disable_auto_launch_windows() -> Result<(), AppError> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(run_key) =
        hkcu.open_subkey_with_flags(WINDOWS_RUN_REG_PATH, winreg::enums::KEY_SET_VALUE)
    else {
        return Ok(());
    };
    match run_key.delete_value(AUTO_LAUNCH_APP_NAME) {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::Message(format!("删除开机启动注册表失败: {err}"))),
    }
}

#[cfg(target_os = "windows")]
fn is_auto_launch_enabled_windows() -> Result<bool, AppError> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = match hkcu.open_subkey_with_flags(WINDOWS_RUN_REG_PATH, winreg::enums::KEY_READ) {
        Ok(key) => key,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(AppError::Message(format!("读取开机启动注册表失败: {err}"))),
    };

    let value: String = match run_key.get_value(AUTO_LAUNCH_APP_NAME) {
        Ok(v) => v,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => {
            return Err(AppError::Message(format!(
                "读取开机启动注册表值失败: {err}"
            )))
        }
    };

    if value.trim().is_empty() {
        return Ok(false);
    }

    let expected = windows_auto_launch_value()?;
    if value.trim() != expected {
        log::warn!(
            "Startup entry value differs from current executable path. configured={}, expected={}",
            value,
            expected
        );
    }
    Ok(true)
}

pub fn enable_auto_launch() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        enable_auto_launch_windows()?;
        log::info!("已启用开机自启（Windows 注册表）");
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let auto_launch = get_auto_launch()?;
        auto_launch
            .enable()
            .map_err(|e| AppError::Message(format!("启用开机自启失败: {e}")))?;
        log::info!("已启用开机自启");
        Ok(())
    }
}

pub fn disable_auto_launch() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        disable_auto_launch_windows()?;
        log::info!("已禁用开机自启（Windows 注册表）");
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let auto_launch = get_auto_launch()?;
        auto_launch
            .disable()
            .map_err(|e| AppError::Message(format!("禁用开机自启失败: {e}")))?;
        log::info!("已禁用开机自启");
        Ok(())
    }
}

pub fn is_auto_launch_enabled() -> Result<bool, AppError> {
    #[cfg(target_os = "windows")]
    {
        is_auto_launch_enabled_windows()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let auto_launch = get_auto_launch()?;
        auto_launch
            .is_enabled()
            .map_err(|e| AppError::Message(format!("获取开机自启状态失败: {e}")))
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::get_macos_app_bundle_path;
    #[cfg(target_os = "windows")]
    use super::windows_auto_launch_value;

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_valid() {
        let exe_path = std::path::Path::new("/Applications/CC Switch.app/Contents/MacOS/CC Switch");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from("/Applications/CC Switch.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_with_spaces() {
        let exe_path =
            std::path::Path::new("/Users/test/My Apps/CC Switch.app/Contents/MacOS/CC Switch");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from(
                "/Users/test/My Apps/CC Switch.app"
            ))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_not_in_bundle() {
        let exe_path = std::path::Path::new("/usr/local/bin/cc-switch");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(result, None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_auto_launch_value_is_quoted() {
        let value = windows_auto_launch_value().expect("should build startup command");
        assert!(value.starts_with('"'));
        assert!(value.ends_with('"'));
    }
}
