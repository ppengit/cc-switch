use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn launch_terminal(
    target: &str,
    command: &str,
    cwd: Option<&str>,
    _custom_config: Option<&str>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Resume command is empty".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        return match target {
            "terminal" => launch_macos_terminal(command, cwd),
            "iTerm" | "iterm" => launch_iterm(command, cwd),
            "ghostty" => launch_ghostty(command, cwd),
            "kitty" => launch_kitty(command, cwd),
            "wezterm" => launch_wezterm(command, cwd),
            "alacritty" => launch_alacritty(command, cwd),
            "custom" => launch_custom(command, cwd, _custom_config),
            _ => Err(format!("Unsupported terminal target: {target}")),
        };
    }

    #[cfg(target_os = "windows")]
    {
        if target == "custom" {
            return Err("Custom terminal resume is not supported on Windows".to_string());
        }
        return launch_windows_terminal_command(command, cwd);
    }

    #[cfg(target_os = "linux")]
    {
        if target == "custom" {
            return Err("Custom terminal resume is not supported on Linux".to_string());
        }
        return launch_linux_terminal_command(command, cwd);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("Unsupported OS for terminal resume".to_string())
}

#[cfg(target_os = "macos")]
fn launch_macos_terminal(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let full_command = build_shell_command(command, cwd);
    let escaped = escape_osascript(&full_command);
    let script = format!(
        r#"tell application "Terminal"
    activate
    do script "{escaped}"
end tell"#
    );

    let status = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| format!("Failed to launch Terminal: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Terminal command execution failed".to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_iterm(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let full_command = build_shell_command(command, cwd);
    let escaped = escape_osascript(&full_command);
    // iTerm2 AppleScript to create a new window and execute command
    let script = format!(
        r#"tell application "iTerm"
    activate
    create window with default profile
    tell current session of current window
        write text "{escaped}"
    end tell
end tell"#
    );

    let status = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| format!("Failed to launch iTerm: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("iTerm command execution failed".to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_ghostty(command: &str, cwd: Option<&str>) -> Result<(), String> {
    // Ghostty usage: open -na Ghostty --args +work-dir=... -e shell -c command

    // Using `open` to launch.
    let mut args = vec!["-na", "Ghostty", "--args"];

    // Ghostty uses --working-directory for working directory (or +work-dir, but --working-directory is standard in newer versions/compat)
    // Note: The user's error output didn't show the working dir arg failure, so we assume flag is okay or we stick to compatible ones.
    // Documentation says --working-directory is supported in CLI.
    let work_dir_arg = if let Some(dir) = cwd {
        format!("--working-directory={dir}")
    } else {
        "".to_string()
    };

    if !work_dir_arg.is_empty() {
        args.push(&work_dir_arg);
    }

    // Command execution
    args.push("-e");

    // We pass the command and its arguments separately.
    // The previous issue was passing the entire "cmd args" string as a single argument to -e,
    // which led Ghostty to look for a binary named "cmd args".
    // Splitting by whitespace allows Ghostty to see ["cmd", "args"].
    // Note: This assumes simple commands without quoted arguments containing spaces.
    let full_command = build_shell_command(command, None);
    for part in full_command.split_whitespace() {
        args.push(part);
    }

    let status = Command::new("open")
        .args(&args)
        .status()
        .map_err(|e| format!("Failed to launch Ghostty: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Ghostty. Make sure it is installed.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_kitty(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let full_command = build_shell_command(command, cwd);

    // 获取用户默认 shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let status = Command::new("open")
        .arg("-na")
        .arg("kitty")
        .arg("--args")
        .arg("-e")
        .arg(&shell)
        .arg("-l")
        .arg("-c")
        .arg(&full_command)
        .status()
        .map_err(|e| format!("Failed to launch Kitty: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Kitty. Make sure it is installed.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_wezterm(command: &str, cwd: Option<&str>) -> Result<(), String> {
    // wezterm start --cwd ... -- command
    // To invoke via `open`, we use `open -na "WezTerm" --args start ...`

    let full_command = build_shell_command(command, None);

    let mut args = vec!["-na", "WezTerm", "--args", "start"];

    if let Some(dir) = cwd {
        args.push("--cwd");
        args.push(dir);
    }

    // Invoke shell to run the command string (to handle pipes, etc)
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    args.push("--");
    args.push(&shell);
    args.push("-c");
    args.push(&full_command);

    let status = Command::new("open")
        .args(&args)
        .status()
        .map_err(|e| format!("Failed to launch WezTerm: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch WezTerm.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_alacritty(command: &str, cwd: Option<&str>) -> Result<(), String> {
    // Alacritty: open -na Alacritty --args --working-directory ... -e shell -c command
    let full_command = build_shell_command(command, None);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut args = vec!["-na", "Alacritty", "--args"];

    if let Some(dir) = cwd {
        args.push("--working-directory");
        args.push(dir);
    }

    args.push("-e");
    args.push(&shell);
    args.push("-c");
    args.push(&full_command);

    let status = Command::new("open")
        .args(&args)
        .status()
        .map_err(|e| format!("Failed to launch Alacritty: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Alacritty.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_custom(
    command: &str,
    cwd: Option<&str>,
    custom_config: Option<&str>,
) -> Result<(), String> {
    let template = custom_config.ok_or("No custom terminal config provided")?;

    if template.trim().is_empty() {
        return Err("Custom terminal command template is empty".to_string());
    }

    let cmd_str = command;
    let dir_str = cwd.unwrap_or(".");

    let final_cmd_line = template
        .replace("{command}", cmd_str)
        .replace("{cwd}", dir_str);

    // Execute via sh -c
    let status = Command::new("sh")
        .arg("-c")
        .arg(&final_cmd_line)
        .status()
        .map_err(|e| format!("Failed to execute custom terminal launcher: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Custom terminal execution returned error code".to_string())
    }
}

#[cfg(target_os = "windows")]
fn launch_windows_terminal_command(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let preferred = crate::settings::get_preferred_terminal();
    let terminal = preferred.as_deref().unwrap_or("cmd");

    let temp_dir = std::env::temp_dir();
    let bat_file = temp_dir.join(format!(
        "cc_switch_session_resume_{}.bat",
        uuid::Uuid::new_v4()
    ));

    let cd_line = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("cd /d \"{}\"\r\n", value.replace('\"', "\"\"")))
        .unwrap_or_default();

    let content = format!(
        "@echo off\r\n\
setlocal\r\n\
{cd_line}\
call {command}\r\n\
endlocal\r\n\
del \"%~f0\" >nul 2>&1\r\n",
        cd_line = cd_line,
        command = command
    );

    std::fs::write(&bat_file, &content)
        .map_err(|e| format!("写入会话恢复脚本失败: {e}"))?;

    let bat_path = bat_file.to_string_lossy().to_string();
    let bat_path_quoted = format!("\"{}\"", bat_path.replace('\"', "\"\""));
    let ps_cmd = format!("& {}", bat_path_quoted);

    let result = match terminal {
        "powershell" => run_windows_start_command(
            &["powershell", "-NoExit", "-Command", &ps_cmd],
            "PowerShell",
        ),
        "wt" => run_windows_start_command(&["wt", "cmd", "/K", &bat_path_quoted], "Windows Terminal"),
        _ => run_windows_start_command(&["cmd", "/K", &bat_path_quoted], "cmd"),
    };

    if result.is_err() && terminal != "cmd" {
        log::warn!(
            "首选终端 {} 启动失败，回退到 cmd: {:?}",
            terminal,
            result.as_ref().err()
        );
        return run_windows_start_command(&["cmd", "/K", &bat_path_quoted], "cmd");
    }

    result
}

#[cfg(target_os = "windows")]
fn run_windows_start_command(args: &[&str], terminal_name: &str) -> Result<(), String> {
    let mut full_args = vec!["/C", "start", ""];
    full_args.extend(args);

    let output = Command::new("cmd")
        .args(&full_args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("启动 {} 失败: {e}", terminal_name))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{} 启动失败 (exit code: {:?}): {}",
            terminal_name,
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn launch_linux_terminal_command(command: &str, cwd: Option<&str>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let preferred = crate::settings::get_preferred_terminal();

    let default_terminals = [
        ("gnome-terminal", vec!["--"]),
        ("konsole", vec!["-e"]),
        ("xfce4-terminal", vec!["-e"]),
        ("mate-terminal", vec!["--"]),
        ("lxterminal", vec!["-e"]),
        ("alacritty", vec!["-e"]),
        ("kitty", vec!["-e"]),
        ("ghostty", vec!["-e"]),
    ];

    let temp_dir = std::env::temp_dir();
    let script_file = temp_dir.join(format!(
        "cc_switch_session_resume_{}.sh",
        uuid::Uuid::new_v4()
    ));

    let cwd_line = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("cd \"{}\"", escape_shell_path(value)))
        .unwrap_or_default();

    let script_content = format!(
        r#"#!/bin/bash
trap 'rm -f "{script_file}"' EXIT
{cwd_line}
{command}
exec bash --norc --noprofile
"#,
        script_file = script_file.display(),
        cwd_line = cwd_line,
        command = command
    );

    std::fs::write(&script_file, &script_content)
        .map_err(|e| format!("写入会话恢复脚本失败: {e}"))?;

    std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("设置脚本权限失败: {e}"))?;

    let terminals_to_try: Vec<(&str, Vec<&str>)> = if let Some(ref pref) = preferred {
        let pref_args = default_terminals
            .iter()
            .find(|(name, _)| *name == pref.as_str())
            .map(|(_, args)| args.iter().map(|s| *s).collect::<Vec<&str>>())
            .unwrap_or_else(|| vec!["-e"]);

        let mut list = vec![(pref.as_str(), pref_args)];
        for (name, args) in &default_terminals {
            if *name != pref.as_str() {
                list.push((*name, args.iter().map(|s| *s).collect()));
            }
        }
        list
    } else {
        default_terminals
            .iter()
            .map(|(name, args)| (*name, args.iter().map(|s| *s).collect()))
            .collect()
    };

    let mut last_error = String::from("未找到可用的终端");
    for (terminal, args) in terminals_to_try {
        let terminal_exists = std::path::Path::new(&format!("/usr/bin/{}", terminal)).exists()
            || std::path::Path::new(&format!("/bin/{}", terminal)).exists()
            || std::path::Path::new(&format!("/usr/local/bin/{}", terminal)).exists()
            || which_command(terminal);

        if terminal_exists {
            let result = Command::new(terminal)
                .args(&args)
                .arg("bash")
                .arg(script_file.to_string_lossy().as_ref())
                .spawn();

            match result {
                Ok(_) => return Ok(()),
                Err(e) => last_error = format!("执行 {} 失败: {}", terminal, e),
            }
        }
    }

    let _ = std::fs::remove_file(&script_file);
    Err(last_error)
}

#[cfg(target_os = "macos")]
fn build_shell_command(command: &str, cwd: Option<&str>) -> String {
    match cwd {
        Some(dir) if !dir.trim().is_empty() => {
            format!("cd {} && {}", shell_escape(dir), command)
        }
        _ => command.to_string(),
    }
}

#[cfg(target_os = "macos")]
fn shell_escape(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(target_os = "macos")]
fn escape_osascript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn escape_shell_path(value: &str) -> String {
    value.replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn which_command(cmd: &str) -> bool {
    use std::env;
    use std::path::Path;

    if let Ok(path_var) = env::var("PATH") {
        for path in env::split_paths(&path_var) {
            let full = path.join(cmd);
            if Path::new(&full).exists() {
                return true;
            }
        }
    }
    false
}
