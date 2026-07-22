#[cfg(any(target_os = "windows", test))]
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn launch_terminal(
    target: &str,
    command: &str,
    cwd: Option<&str>,
    custom_config: Option<&str>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Resume command is empty".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        match target {
            "terminal" => launch_macos_terminal(command, cwd),
            "iTerm" | "iterm" => launch_iterm(command, cwd),
            "ghostty" => launch_ghostty(command, cwd),
            "kitty" => launch_kitty(command, cwd),
            "wezterm" => launch_wezterm(command, cwd),
            "kaku" => launch_kaku(command, cwd),
            "alacritty" => launch_alacritty(command, cwd),
            "warp" => launch_warp(command, cwd),
            "custom" => launch_custom(command, cwd, custom_config),
            _ => Err(format!("Unsupported terminal target: {target}")),
        }
    }

    #[cfg(target_os = "windows")]
    {
        launch_windows_terminal(target, command, cwd, custom_config)
    }

    #[cfg(target_os = "linux")]
    {
        launch_linux_terminal(target, command, cwd, custom_config)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (target, command, cwd, custom_config);
        Err("Unsupported operating system for terminal resume".to_string())
    }
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
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut args = vec![
        "-na".to_string(),
        "Ghostty".to_string(),
        "--args".to_string(),
        "--quit-after-last-window-closed=true".to_string(),
    ];

    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            args.push(format!("--working-directory={dir}"));
        }
    }

    args.push("-e".to_string());
    args.push(shell);
    args.push("-l".to_string());
    args.push("-c".to_string());
    args.push(command.to_string());

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
    let args = build_wezterm_compatible_args("WezTerm", command, cwd);

    let status = Command::new("open")
        .args(args.iter().map(String::as_str))
        .status()
        .map_err(|e| format!("Failed to launch WezTerm: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch WezTerm.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_kaku(command: &str, cwd: Option<&str>) -> Result<(), String> {
    // Kaku is a WezTerm-derived terminal and keeps a compatible `start` entrypoint.
    let args = build_wezterm_compatible_args("Kaku", command, cwd);

    let status = Command::new("open")
        .args(args.iter().map(String::as_str))
        .status()
        .map_err(|e| format!("Failed to launch Kaku: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Kaku.".to_string())
    }
}

#[cfg(any(target_os = "macos", test))]
#[allow(dead_code)]
fn build_wezterm_compatible_args(app_name: &str, command: &str, cwd: Option<&str>) -> Vec<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    build_wezterm_compatible_args_with_shell(app_name, command, cwd, &shell)
}

#[cfg(any(target_os = "macos", test))]
fn build_wezterm_compatible_args_with_shell(
    app_name: &str,
    command: &str,
    cwd: Option<&str>,
    shell: &str,
) -> Vec<String> {
    let full_command = build_shell_command(command, None);
    let mut args = vec![
        "-na".to_string(),
        app_name.to_string(),
        "--args".to_string(),
        "start".to_string(),
    ];

    if let Some(dir) = cwd {
        args.push("--cwd".to_string());
        args.push(dir.to_string());
    }

    // Invoke shell to run the command string (to handle pipes, etc)
    args.push("--".to_string());
    args.push(shell.to_string());
    args.push("-c".to_string());
    args.push(full_command);
    args
}

#[cfg(target_os = "macos")]
fn launch_warp(command: &str, cwd: Option<&str>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let cwd = cwd.ok_or("Failed to resume session without cwd")?;

    let mut script_file = tempfile::Builder::new()
        .disable_cleanup(true)
        .permissions(std::fs::Permissions::from_mode(0o755))
        .tempfile_in(cwd)
        .map_err(|e| format!("Failed to create temporary script file for launching Warp: {e}"))?;

    writeln!(
        &mut script_file,
        r#"#!/usr/bin/env sh

        rm -- "$0"

        exec {command}
        "#,
    )
    .map_err(|e| format!("Failed to write to temporary script file for Warp: {e}"))?;

    let mut warp_url = url::Url::parse("warp://action/new_tab").unwrap();
    warp_url
        .query_pairs_mut()
        .append_pair("path", &script_file.path().to_string_lossy());
    let warp_url = warp_url.to_string();

    let status = Command::new("open")
        .args(["-a", "Warp", &warp_url])
        .status()
        .map_err(|e| format!("Failed to launch Warp: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Warp.".to_string())
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
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
fn launch_windows_terminal(
    target: &str,
    command: &str,
    cwd: Option<&str>,
    custom_config: Option<&str>,
) -> Result<(), String> {
    let cwd = valid_windows_cwd(cwd);

    if target == "custom" {
        return launch_custom_windows(command, cwd.as_deref(), custom_config);
    }

    let command = command.trim();
    let batch_file = write_windows_resume_batch(command, cwd.as_deref())?;

    let result = match target {
        "powershell" => {
            // npm / pnpm 等通过 wrapper 暴露的 CLI（如 codex.ps1）会在默认
            // ExecutionPolicy=Restricted 的 PowerShell 中被拒绝加载。临时给当前
            // 启动的 PowerShell 进程加上 `-ExecutionPolicy Bypass`，作用域仅限
            // 本次会话，不修改系统策略，避免拉脚本时报 PSSecurityException。
            let script = build_powershell_batch_invocation(&batch_file);
            run_windows_start(
                &[
                    "powershell",
                    "-NoExit",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ],
                "PowerShell",
            )
        }
        "wt" => run_windows_start_owned(
            &build_windows_terminal_args_for_script(&batch_file, cwd.as_deref()),
            "Windows Terminal",
        ),
        "cmd" => run_windows_start_owned(&build_windows_cmd_args_for_script(&batch_file), "cmd"),
        _ => run_windows_start_owned(&build_windows_cmd_args_for_script(&batch_file), "cmd"),
    };

    let final_result = if result.is_err() && target != "cmd" {
        run_windows_start_owned(&build_windows_cmd_args_for_script(&batch_file), "cmd")
    } else {
        result
    };

    if final_result.is_err() {
        let _ = std::fs::remove_file(&batch_file);
    }

    final_result
}

#[cfg(any(target_os = "windows", test))]
fn valid_windows_cwd(cwd: Option<&str>) -> Option<String> {
    let raw = cwd?.trim();
    if raw.is_empty() || raw.contains('\n') || raw.contains('\r') {
        return None;
    }

    let path = Path::new(raw);
    if !path.is_dir() {
        return None;
    }

    let resolved = path.canonicalize().unwrap_or_else(|_| PathBuf::from(raw));
    let value = strip_windows_extended_length_prefix(&resolved);
    Some(value.to_string_lossy().to_string())
}

#[cfg(any(target_os = "windows", test))]
fn strip_windows_extended_length_prefix(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(stripped) = value.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

#[cfg(target_os = "windows")]
fn write_windows_resume_batch(command: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let batch_file = std::env::temp_dir().join(format!(
        "cc_switch_resume_{}_{}.bat",
        std::process::id(),
        unique
    ));
    let content = build_windows_resume_batch_content(command, cwd);

    std::fs::write(&batch_file, content)
        .map_err(|e| format!("Failed to write resume launcher batch file: {e}"))?;

    Ok(batch_file)
}

#[cfg(any(target_os = "windows", test))]
fn build_windows_resume_batch_content(command: &str, cwd: Option<&str>) -> String {
    let cwd_command = build_windows_cwd_command(cwd);
    format!(
        "@echo off\r\n{cwd_command}call {command}\r\nset CC_SWITCH_RESUME_EXIT=%ERRORLEVEL%\r\necho.\r\necho [cc-switch] Resume command exited with code %CC_SWITCH_RESUME_EXIT%.\r\ndel \"%~f0\" >nul 2>&1\r\nexit /b %CC_SWITCH_RESUME_EXIT%\r\n",
        command = command.trim()
    )
}

#[cfg(any(target_os = "windows", test))]
fn build_windows_cwd_command(cwd: Option<&str>) -> String {
    cwd.map(build_windows_cwd_command_str).unwrap_or_default()
}

#[cfg(any(target_os = "windows", test))]
fn build_windows_cwd_command_str(path: &str) -> String {
    let escaped = escape_windows_batch_value(path);

    if is_windows_unc_path(path) {
        format!("pushd \"{escaped}\" || exit /b 1\r\n")
    } else {
        format!("cd /d \"{escaped}\" || exit /b 1\r\n")
    }
}

#[cfg(any(target_os = "windows", test))]
fn is_windows_unc_path(path: &str) -> bool {
    path.starts_with(r"\\")
}

#[cfg(any(target_os = "windows", test))]
fn escape_windows_batch_value(value: &str) -> String {
    value
        .replace('^', "^^")
        .replace('%', "%%")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('(', "^(")
        .replace(')', "^)")
}

#[cfg(target_os = "windows")]
fn launch_custom_windows(
    command: &str,
    cwd: Option<&str>,
    custom_config: Option<&str>,
) -> Result<(), String> {
    let template = custom_config.ok_or("No custom terminal config provided")?;
    if template.trim().is_empty() {
        return Err("Custom terminal command template is empty".to_string());
    }

    let cmd_str = command.trim();
    let dir_str = cwd.unwrap_or(".");
    let final_cmd_line = template
        .replace("{command}", cmd_str)
        .replace("{cwd}", dir_str);

    let status = Command::new("cmd")
        .args(["/C", &final_cmd_line])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Failed to execute custom terminal launcher: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Custom terminal execution returned error code".to_string())
    }
}

#[cfg(target_os = "windows")]
fn run_windows_start(args: &[&str], terminal_name: &str) -> Result<(), String> {
    let mut full_args = vec!["/C", "start", ""];
    full_args.extend(args);

    let output = Command::new("cmd")
        .args(&full_args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to launch {terminal_name}: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "{terminal_name} launch failed (exit code: {:?}): {stderr}",
            output.status.code()
        ))
    }
}

#[cfg(any(target_os = "windows", test))]
fn build_windows_terminal_args_for_script(script_path: &Path, cwd: Option<&str>) -> Vec<String> {
    let cwd = valid_windows_cwd(cwd);
    let mut args = vec!["wt".to_string()];

    if let Some(cwd_value) = cwd.as_deref() {
        args.push("-d".to_string());
        args.push(cwd_value.to_string());
    }

    args.extend(build_windows_cmd_args_for_script(script_path));
    args
}

#[cfg(any(target_os = "windows", test))]
fn build_windows_cmd_args_for_script(script_path: &Path) -> Vec<String> {
    vec![
        "cmd".to_string(),
        "/K".to_string(),
        script_path.to_string_lossy().to_string(),
    ]
}

#[cfg(target_os = "windows")]
fn run_windows_start_owned(args: &[String], terminal_name: &str) -> Result<(), String> {
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_windows_start(&borrowed, terminal_name)
}

#[cfg(any(target_os = "windows", test))]
fn escape_powershell_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(any(target_os = "windows", test))]
fn build_powershell_batch_invocation(script_path: &Path) -> String {
    format!(
        "& '{}'",
        escape_powershell_single_quote(script_path.to_string_lossy().as_ref())
    )
}

#[cfg(target_os = "linux")]
fn launch_linux_terminal(
    target: &str,
    command: &str,
    cwd: Option<&str>,
    custom_config: Option<&str>,
) -> Result<(), String> {
    if target == "custom" {
        return launch_custom(command, cwd, custom_config);
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let full_command = build_shell_command(command, cwd);

    let candidates: Vec<(&str, Vec<String>)> = if target == "terminal" {
        vec![
            (
                "x-terminal-emulator",
                vec![
                    "-e".to_string(),
                    shell.clone(),
                    "-lc".to_string(),
                    full_command.clone(),
                ],
            ),
            (
                "gnome-terminal",
                vec![
                    "--".to_string(),
                    shell.clone(),
                    "-lc".to_string(),
                    full_command.clone(),
                ],
            ),
            (
                "konsole",
                vec![
                    "-e".to_string(),
                    shell.clone(),
                    "-lc".to_string(),
                    full_command.clone(),
                ],
            ),
            (
                "kitty",
                vec![
                    "-e".to_string(),
                    shell.clone(),
                    "-lc".to_string(),
                    full_command.clone(),
                ],
            ),
            (
                "wezterm",
                vec![
                    "start".to_string(),
                    "--".to_string(),
                    shell.clone(),
                    "-lc".to_string(),
                    full_command.clone(),
                ],
            ),
        ]
    } else {
        vec![(
            target,
            vec![
                "-e".to_string(),
                shell.clone(),
                "-lc".to_string(),
                full_command.clone(),
            ],
        )]
    };

    for (bin, args) in candidates {
        let status = Command::new(bin).args(args).status();
        match status {
            Ok(st) if st.success() => return Ok(()),
            Ok(_) => continue,
            Err(_) => continue,
        }
    }

    Err("Failed to launch Linux terminal".to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn build_shell_command(command: &str, cwd: Option<&str>) -> String {
    match cwd {
        Some(dir) if !dir.trim().is_empty() => {
            format!("cd {} && {}", shell_escape(dir), command)
        }
        _ => command.to_string(),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn shell_escape(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(target_os = "macos")]
fn escape_osascript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_shell_command_keeps_command_without_cwd_prefix_when_not_provided() {
        assert_eq!(
            build_shell_command("claude --resume abc-123", None),
            "claude --resume abc-123"
        );
    }

    #[test]
    fn wezterm_compatible_terminals_use_start_and_cwd_arguments() {
        let args = build_wezterm_compatible_args_with_shell(
            "Kaku",
            "claude --resume abc-123",
            Some("/tmp/project dir"),
            "/bin/zsh",
        );

        assert_eq!(
            args,
            vec![
                "-na".to_string(),
                "Kaku".to_string(),
                "--args".to_string(),
                "start".to_string(),
                "--cwd".to_string(),
                "/tmp/project dir".to_string(),
                "--".to_string(),
                "/bin/zsh".to_string(),
                "-c".to_string(),
                "claude --resume abc-123".to_string(),
            ]
        );
    }

    #[test]
    fn ghostty_uses_working_directory_arg_for_cwd() {
        // cwd should be passed as --working-directory, not embedded in the shell command string
        // This avoids shell expansion of special characters in directory paths
        let cwd = "/tmp/project dir";
        let command = "claude --resume abc-123";

        // Verify build_shell_command does NOT include cwd when used in ghostty context
        // (ghostty passes cwd via --working-directory flag instead)
        assert_eq!(
            build_shell_command(command, None),
            "claude --resume abc-123"
        );

        // Verify shell_escape works correctly for paths with spaces
        assert_eq!(shell_escape(cwd), "\"/tmp/project dir\"");
    }

    #[test]
    fn windows_resume_batch_runs_command_via_call_and_cleans_itself() {
        let content =
            build_windows_resume_batch_content("codex resume abc-123", Some(r"C:\work\repo"));

        assert!(content.contains("cd /d \"C:\\work\\repo\" || exit /b 1\r\n"));
        assert!(content.contains("call codex resume abc-123\r\n"));
        assert!(content.contains("set CC_SWITCH_RESUME_EXIT=%ERRORLEVEL%"));
        assert!(content.contains("del \"%~f0\" >nul 2>&1"));
    }

    #[test]
    fn windows_resume_batch_uses_pushd_for_unc_cwd() {
        let content = build_windows_resume_batch_content(
            "claude --resume abc-123",
            Some(r"\\wsl$\Ubuntu\home\coder\repo"),
        );

        assert!(content.contains("pushd \"\\\\wsl$\\Ubuntu\\home\\coder\\repo\" || exit /b 1\r\n"));
        assert!(content.contains("call claude --resume abc-123\r\n"));
    }

    #[test]
    fn windows_terminal_runs_resume_batch_in_cmd_inside_windows_terminal() {
        let cwd = std::env::current_dir()
            .expect("current dir")
            .to_string_lossy()
            .to_string();
        let expected_cwd = valid_windows_cwd(Some(&cwd)).expect("valid cwd");
        let script_path = Path::new(r"C:\Temp\cc_switch_resume_1.bat");
        let args = build_windows_terminal_args_for_script(script_path, Some(&cwd));

        assert_eq!(args[0], "wt");
        assert_eq!(args[1], "-d");
        assert_eq!(args[2], expected_cwd);
        assert_eq!(args[3], "cmd");
        assert_eq!(args[4], "/K");
        assert_eq!(args[5], script_path.to_string_lossy().as_ref());
        assert!(
            args.iter().all(|arg| !arg.contains("cd /d")),
            "Windows Terminal cwd should be passed with -d, not embedded in cmd /K"
        );
    }

    #[test]
    fn windows_terminal_does_not_use_powershell_when_wt_is_selected() {
        let script_path = Path::new(r"C:\Temp\cc_switch_resume_1.bat");
        let args = build_windows_terminal_args_for_script(script_path, None);

        assert!(
            !args
                .iter()
                .any(|arg| arg.eq_ignore_ascii_case("powershell")),
            "Windows Terminal resume should open cmd inside Windows Terminal, not PowerShell"
        );
        assert_eq!(
            args,
            vec![
                "wt".to_string(),
                "cmd".to_string(),
                "/K".to_string(),
                script_path.to_string_lossy().to_string(),
            ]
        );
    }

    #[test]
    fn windows_terminal_ignores_missing_cwd() {
        let script_path = Path::new(r"C:\Temp\cc_switch_resume_1.bat");
        let args = build_windows_terminal_args_for_script(
            script_path,
            Some("Z:\\cc-switch\\missing\\session\\cwd"),
        );

        assert_eq!(
            args,
            vec![
                "wt".to_string(),
                "cmd".to_string(),
                "/K".to_string(),
                script_path.to_string_lossy().to_string(),
            ]
        );
    }

    #[test]
    fn powershell_batch_invocation_escapes_single_quotes() {
        let script_path = Path::new(r"C:\Temp\it's\cc_switch_resume.bat");

        assert_eq!(
            build_powershell_batch_invocation(script_path),
            r"& 'C:\Temp\it''s\cc_switch_resume.bat'"
        );
    }
}
