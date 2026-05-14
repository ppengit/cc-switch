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
        return match target {
            "terminal" => launch_macos_terminal(command, cwd),
            "iTerm" | "iterm" => launch_iterm(command, cwd),
            "ghostty" => launch_ghostty(command, cwd),
            "kitty" => launch_kitty(command, cwd),
            "wezterm" => launch_wezterm(command, cwd),
            "kaku" => launch_kaku(command, cwd),
            "alacritty" => launch_alacritty(command, cwd),
            "custom" => launch_custom(command, cwd, custom_config),
            _ => Err(format!("Unsupported terminal target: {target}")),
        };
    }

    #[cfg(target_os = "windows")]
    {
        return launch_windows_terminal(target, command, cwd, custom_config);
    }

    #[cfg(target_os = "linux")]
    {
        return launch_linux_terminal(target, command, cwd, custom_config);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (target, command, cwd, custom_config);
        Err("Unsupported operating system for terminal resume".to_string())
    }
}

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

fn build_wezterm_compatible_args(app_name: &str, command: &str, cwd: Option<&str>) -> Vec<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    build_wezterm_compatible_args_with_shell(app_name, command, cwd, &shell)
}

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
    if target == "custom" {
        return launch_custom_windows(command, cwd, custom_config);
    }

    let command = command.trim();
    let cmd_chain = if let Some(cwd_value) = cwd.filter(|value| !value.trim().is_empty()) {
        format!(
            "cd /d \"{}\" && {command}",
            escape_cmd_double_quotes(cwd_value.trim())
        )
    } else {
        command.to_string()
    };

    let result = match target {
        "powershell" => {
            // npm / pnpm 等通过 wrapper 暴露的 CLI（如 codex.ps1）会在默认
            // ExecutionPolicy=Restricted 的 PowerShell 中被拒绝加载。临时给当前
            // 启动的 PowerShell 进程加上 `-ExecutionPolicy Bypass`，作用域仅限
            // 本次会话，不修改系统策略，避免拉脚本时报 PSSecurityException。
            let escaped = escape_powershell_single_quote(command);
            if let Some(cwd_value) = cwd.filter(|value| !value.trim().is_empty()) {
                let escaped_cwd = escape_powershell_single_quote(cwd_value.trim());
                let script = format!(
                    "Set-Location -LiteralPath '{escaped_cwd}'; Invoke-Expression '{escaped}'"
                );
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
            } else {
                run_windows_start(
                    &[
                        "powershell",
                        "-NoExit",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-Command",
                        &format!("Invoke-Expression '{escaped}'"),
                    ],
                    "PowerShell",
                )
            }
        }
        "wt" => run_windows_start_owned(
            &build_windows_terminal_args(command, cwd),
            "Windows Terminal",
        ),
        _ => run_windows_start(&["cmd", "/K", &cmd_chain], "cmd"),
    };

    if result.is_ok() {
        return Ok(());
    }

    if target != "cmd" {
        run_windows_start(&["cmd", "/K", &cmd_chain], "cmd")
    } else {
        result
    }
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

fn build_windows_terminal_args(command: &str, cwd: Option<&str>) -> Vec<String> {
    let command = command.trim();
    let cmd_chain = if let Some(cwd_value) = cwd.filter(|value| !value.trim().is_empty()) {
        format!(
            "cd /d \"{}\" && {command}",
            escape_cmd_double_quotes(cwd_value.trim())
        )
    } else {
        command.to_string()
    };
    let mut args = vec!["wt".to_string()];

    if let Some(cwd_value) = cwd.filter(|value| !value.trim().is_empty()) {
        args.push("-d".to_string());
        args.push(cwd_value.trim().to_string());
    }

    args.extend(["cmd".to_string(), "/K".to_string(), cmd_chain]);
    args
}

#[cfg(target_os = "windows")]
fn run_windows_start_owned(args: &[String], terminal_name: &str) -> Result<(), String> {
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_windows_start(&borrowed, terminal_name)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn escape_cmd_double_quotes(value: &str) -> String {
    value.replace('"', "\"\"")
}

fn escape_powershell_single_quote(value: &str) -> String {
    value.replace('\'', "''")
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

fn build_shell_command(command: &str, cwd: Option<&str>) -> String {
    match cwd {
        Some(dir) if !dir.trim().is_empty() => {
            format!("cd {} && {}", shell_escape(dir), command)
        }
        _ => command.to_string(),
    }
}

fn shell_escape(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

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
    fn windows_terminal_runs_resume_command_in_cmd_inside_windows_terminal() {
        let args =
            build_windows_terminal_args("codex resume abc-123", Some("C:\\Users\\me\\Project"));

        assert_eq!(args[0], "wt");
        assert_eq!(args[1], "-d");
        assert_eq!(args[2], "C:\\Users\\me\\Project");
        assert_eq!(args[3], "cmd");
        assert_eq!(args[4], "/K");
        assert_eq!(
            args[5],
            "cd /d \"C:\\Users\\me\\Project\" && codex resume abc-123"
        );
    }

    #[test]
    fn windows_terminal_does_not_use_powershell_when_wt_is_selected() {
        let args = build_windows_terminal_args("codex resume abc-123", None);

        assert!(
            !args.iter().any(|arg| arg.eq_ignore_ascii_case("powershell")),
            "Windows Terminal resume should open cmd inside Windows Terminal, not PowerShell"
        );
        assert_eq!(args, vec!["wt", "cmd", "/K", "codex resume abc-123"]);
    }
}
