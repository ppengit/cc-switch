#![allow(non_snake_case)]
#![allow(dead_code)]

use crate::app_config::AppType;
use crate::init_status::{InitErrorPayload, SkillsMigrationPayload};
use crate::services::ProviderService;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn escape_shell_path(value: &str) -> String {
    value.replace('"', "\\\"")
}

/// 打开外部链接
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<bool, String> {
    let url = if url.starts_with("http://") || url.starts_with("https://") {
        url
    } else {
        format!("https://{url}")
    };

    app.opener()
        .open_url(&url, None::<String>)
        .map_err(|e| format!("打开链接失败: {e}"))?;

    Ok(true)
}

/// 检查更新
#[tauri::command]
pub async fn check_for_updates(handle: AppHandle) -> Result<bool, String> {
    handle
        .opener()
        .open_url(
            "https://github.com/ppengit/cc-switch/releases/latest",
            None::<String>,
        )
        .map_err(|e| format!("打开更新页面失败: {e}"))?;

    Ok(true)
}

const UPSTREAM_RELEASE_REPO: &str = "farion1231/cc-switch";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamReleaseInfo {
    repo: String,
    tag_name: Option<String>,
    version: Option<String>,
    name: Option<String>,
    published_at: Option<String>,
    html_url: Option<String>,
    prerelease: bool,
    draft: bool,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct GithubLatestReleaseResponse {
    tag_name: Option<String>,
    name: Option<String>,
    published_at: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

#[tauri::command]
pub async fn get_upstream_release_info() -> Result<UpstreamReleaseInfo, String> {
    let client = crate::proxy::http_client::get();
    let url = format!("https://api.github.com/repos/{UPSTREAM_RELEASE_REPO}/releases/latest");
    let fallback_url = format!("https://github.com/{UPSTREAM_RELEASE_REPO}/releases/latest");

    let response = match client
        .get(&url)
        .header("User-Agent", "cc-switch")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(err) => {
            return Ok(UpstreamReleaseInfo {
                repo: UPSTREAM_RELEASE_REPO.to_string(),
                tag_name: None,
                version: None,
                name: None,
                published_at: None,
                html_url: Some(fallback_url),
                prerelease: false,
                draft: false,
                error: Some(err.to_string()),
            });
        }
    };

    if !response.status().is_success() {
        return Ok(UpstreamReleaseInfo {
            repo: UPSTREAM_RELEASE_REPO.to_string(),
            tag_name: None,
            version: None,
            name: None,
            published_at: None,
            html_url: Some(fallback_url),
            prerelease: false,
            draft: false,
            error: Some(format!("GitHub API returned status {}", response.status())),
        });
    }

    let parsed = match response.json::<GithubLatestReleaseResponse>().await {
        Ok(json) => json,
        Err(err) => {
            return Ok(UpstreamReleaseInfo {
                repo: UPSTREAM_RELEASE_REPO.to_string(),
                tag_name: None,
                version: None,
                name: None,
                published_at: None,
                html_url: Some(fallback_url),
                prerelease: false,
                draft: false,
                error: Some(err.to_string()),
            });
        }
    };

    let version = parsed
        .tag_name
        .as_deref()
        .map(|tag| tag.strip_prefix('v').unwrap_or(tag).to_string());

    Ok(UpstreamReleaseInfo {
        repo: UPSTREAM_RELEASE_REPO.to_string(),
        tag_name: parsed.tag_name,
        version,
        name: parsed.name,
        published_at: parsed.published_at,
        html_url: parsed.html_url.or(Some(fallback_url)),
        prerelease: parsed.prerelease,
        draft: parsed.draft,
        error: None,
    })
}

/// 判断是否为便携版（绿色版）运行
#[tauri::command]
pub async fn is_portable_mode() -> Result<bool, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("获取可执行路径失败: {e}"))?;
    if let Some(dir) = exe_path.parent() {
        Ok(dir.join("portable.ini").is_file())
    } else {
        Ok(false)
    }
}

/// 获取应用启动阶段的初始化错误（若有）。
/// 用于前端在早期主动拉取，避免事件订阅竞态导致的提示缺失。
#[tauri::command]
pub async fn get_init_error() -> Result<Option<InitErrorPayload>, String> {
    Ok(crate::init_status::get_init_error())
}

/// 获取 JSON→SQLite 迁移结果（若有）。
/// 只返回一次 true，之后返回 false，用于前端显示一次性 Toast 通知。
#[tauri::command]
pub async fn get_migration_result() -> Result<bool, String> {
    Ok(crate::init_status::take_migration_success())
}

/// 获取 Skills 自动导入（SSOT）迁移结果（若有）。
/// 只返回一次 Some({count})，之后返回 None，用于前端显示一次性 Toast 通知。
#[tauri::command]
pub async fn get_skills_migration_result() -> Result<Option<SkillsMigrationPayload>, String> {
    Ok(crate::init_status::take_skills_migration_result())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInstallation {
    source: String,
    version: Option<String>,
    error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersion {
    name: String,
    version: Option<String>,
    latest_version: Option<String>, // 新增字段：最新版本
    error: Option<String>,
    /// 仅 Claude 使用: "native" | "npm"
    install_source: Option<String>,
    /// 工具运行环境: "windows", "wsl", "macos", "linux", "unknown"
    env_type: String,
    /// 当 env_type 为 "wsl" 时，返回该工具绑定的 WSL distro（用于按 distro 探测 shells）
    wsl_distro: Option<String>,
    installations: Option<Vec<ToolInstallation>>,
}

const VALID_TOOLS: [&str; 5] = ["claude", "codex", "gemini", "opencode", "openclaw"];
const CLAUDE_INSTALL_SOURCE_NATIVE: &str = "native";
const CLAUDE_INSTALL_SOURCE_NPM: &str = "npm";

fn update_command_for_tool(tool: &str, install_source: Option<&str>) -> Option<&'static str> {
    match tool {
        "claude" => match install_source {
            Some(CLAUDE_INSTALL_SOURCE_NPM) => Some("npm i -g @anthropic-ai/claude-code@latest"),
            _ => Some("claude update"),
        },
        "codex" => Some("npm i -g @openai/codex@latest"),
        "gemini" => Some("npm i -g @google/gemini-cli@latest"),
        "opencode" => Some("opencode upgrade"),
        "openclaw" => Some("openclaw update"),
        _ => None,
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslShellPreferenceInput {
    #[serde(default)]
    pub wsl_shell: Option<String>,
    #[serde(default)]
    pub wsl_shell_flag: Option<String>,
}

// Keep platform-specific env detection in one place to avoid repeating cfg blocks.
#[cfg(target_os = "windows")]
fn tool_env_type_and_wsl_distro(tool: &str) -> (String, Option<String>) {
    if let Some(distro) = wsl_distro_for_tool(tool) {
        ("wsl".to_string(), Some(distro))
    } else {
        ("windows".to_string(), None)
    }
}

#[cfg(target_os = "macos")]
fn tool_env_type_and_wsl_distro(_tool: &str) -> (String, Option<String>) {
    ("macos".to_string(), None)
}

#[cfg(target_os = "linux")]
fn tool_env_type_and_wsl_distro(_tool: &str) -> (String, Option<String>) {
    ("linux".to_string(), None)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn tool_env_type_and_wsl_distro(_tool: &str) -> (String, Option<String>) {
    ("unknown".to_string(), None)
}

#[tauri::command]
pub async fn get_tool_versions(
    tools: Option<Vec<String>>,
    wsl_shell_by_tool: Option<HashMap<String, WslShellPreferenceInput>>,
) -> Result<Vec<ToolVersion>, String> {
    let requested: Vec<&str> = if let Some(tools) = tools.as_ref() {
        let set: std::collections::HashSet<&str> = tools.iter().map(|s| s.as_str()).collect();
        VALID_TOOLS
            .iter()
            .copied()
            .filter(|t| set.contains(t))
            .collect()
    } else {
        VALID_TOOLS.to_vec()
    };
    let tasks = requested.into_iter().map(|tool| {
        let pref = wsl_shell_by_tool
            .as_ref()
            .and_then(|m| m.get(tool))
            .cloned();
        async move {
            get_single_tool_version_impl(
                tool,
                pref.as_ref().and_then(|p| p.wsl_shell.as_deref()),
                pref.as_ref().and_then(|p| p.wsl_shell_flag.as_deref()),
            )
            .await
        }
    });

    Ok(futures::future::join_all(tasks).await)
}

fn escape_bash_single_quotes(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}

/// One-click update for supported tools.
#[tauri::command]
pub async fn update_tool(
    tool: String,
    #[allow(non_snake_case)] envType: Option<String>,
    #[allow(non_snake_case)] wslDistro: Option<String>,
    #[allow(non_snake_case)] installSource: Option<String>,
) -> Result<bool, String> {
    let tool = tool.to_lowercase();
    if !VALID_TOOLS.contains(&tool.as_str()) {
        return Err(format!("Unsupported tool: {tool}"));
    }

    let command = update_command_for_tool(&tool, installSource.as_deref())
        .ok_or_else(|| format!("No update command for {tool}"))?;

    let final_command = if envType.as_deref() == Some("wsl") {
        let distro = wslDistro.ok_or_else(|| "Missing WSL distro".to_string())?;
        let valid_distro = !distro.is_empty()
            && distro.len() <= 64
            && distro
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
        if !valid_distro {
            return Err(format!("Invalid WSL distro name: {distro}"));
        }
        let escaped = escape_bash_single_quotes(command);
        format!("wsl.exe -d {distro} -- bash -lc '{escaped}'")
    } else {
        command.to_string()
    };

    launch_terminal_with_command(&final_command, None).map_err(|e| format!("启动更新失败: {e}"))?;

    Ok(true)
}

/// 获取单个工具的版本信息（内部实现）
async fn get_single_tool_version_impl(
    tool: &str,
    wsl_shell: Option<&str>,
    wsl_shell_flag: Option<&str>,
) -> ToolVersion {
    debug_assert!(
        VALID_TOOLS.contains(&tool),
        "unexpected tool name in get_single_tool_version_impl: {tool}"
    );

    // 判断该工具的运行环境 & WSL distro（如有）
    let (env_type, wsl_distro) = tool_env_type_and_wsl_distro(tool);

    // 使用全局 HTTP 客户端（已包含代理配置）
    let client = crate::proxy::http_client::get();

    if tool == "claude" {
        let installations = if let Some(distro) = wsl_distro.as_deref() {
            collect_claude_installations_wsl(distro, wsl_shell, wsl_shell_flag)
        } else {
            collect_claude_installations_local()
        };

        let primary = installations.first();

        return ToolVersion {
            name: tool.to_string(),
            version: primary.and_then(|item| item.version.clone()),
            latest_version: fetch_npm_latest_version(&client, "@anthropic-ai/claude-code").await,
            error: primary.and_then(|item| item.error.clone()),
            install_source: primary.map(|item| item.source.clone()),
            env_type,
            wsl_distro,
            installations: Some(installations),
        };
    }

    // 1. 获取本地版本
    let (local_version, local_error) = if let Some(distro) = wsl_distro.as_deref() {
        try_get_version_wsl(tool, distro, wsl_shell, wsl_shell_flag)
    } else {
        let direct_result = try_get_version(tool);
        if direct_result.0.is_some() {
            direct_result
        } else {
            let (version, error, _) = scan_cli_version_with_path(tool);
            (version, error)
        }
    };

    // 2. 获取远程最新版本
    let latest_version = match tool {
        "claude" => fetch_npm_latest_version(&client, "@anthropic-ai/claude-code").await,
        "codex" => fetch_npm_latest_version(&client, "@openai/codex").await,
        "gemini" => fetch_npm_latest_version(&client, "@google/gemini-cli").await,
        "opencode" => fetch_npm_latest_version(&client, "opencode-ai").await,
        "openclaw" => fetch_npm_latest_version(&client, "openclaw").await,
        _ => None,
    };

    ToolVersion {
        name: tool.to_string(),
        version: local_version,
        latest_version,
        error: local_error,
        install_source: None,
        env_type,
        wsl_distro,
        installations: None,
    }
}

fn normalize_claude_install_source(source: Option<&str>) -> String {
    match source.unwrap_or(CLAUDE_INSTALL_SOURCE_NATIVE) {
        CLAUDE_INSTALL_SOURCE_NPM => CLAUDE_INSTALL_SOURCE_NPM.to_string(),
        _ => CLAUDE_INSTALL_SOURCE_NATIVE.to_string(),
    }
}

fn upsert_tool_installation(
    installations: &mut Vec<ToolInstallation>,
    source: String,
    version: Option<String>,
    error: Option<String>,
) {
    if version.is_none() && error.is_none() {
        return;
    }

    if let Some(existing) = installations.iter_mut().find(|item| item.source == source) {
        if existing.version.is_none() && version.is_some() {
            existing.version = version;
        }
        if existing.error.is_none() && error.is_some() {
            existing.error = error;
        }
        return;
    }

    installations.push(ToolInstallation {
        source,
        version,
        error,
    });
}

fn try_get_version_at_path(path: &Path) -> (Option<String>, Option<String>) {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    let output = Command::new(path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new(path).arg("--version").output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if out.status.success() {
                let raw = if stdout.is_empty() { &stderr } else { &stdout };
                if raw.is_empty() {
                    (None, Some("not installed or not executable".to_string()))
                } else {
                    (Some(extract_version(raw)), None)
                }
            } else {
                let err = if stderr.is_empty() { stdout } else { stderr };
                (
                    None,
                    Some(if err.is_empty() {
                        "not installed or not executable".to_string()
                    } else {
                        err
                    }),
                )
            }
        }
        Err(err) => (None, Some(err.to_string())),
    }
}

fn try_get_npm_package_version_local(package: &str) -> (Option<String>, Option<String>) {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    let output = Command::new("cmd")
        .args(["/C", &format!("npm ls -g {package} --depth=0 --json")])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("sh")
        .arg("-c")
        .arg(format!("npm ls -g {package} --depth=0 --json"))
        .output();

    match output {
        Ok(out) => parse_npm_package_version_stdout(
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
            package,
        ),
        Err(err) => (None, Some(err.to_string())),
    }
}

fn parse_npm_package_version_stdout(
    stdout: &str,
    stderr: &str,
    package: &str,
) -> (Option<String>, Option<String>) {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
        let version = json
            .get("dependencies")
            .and_then(|deps| deps.get(package))
            .and_then(|pkg| pkg.get("version"))
            .and_then(|value| value.as_str())
            .map(|value| extract_version(value));

        if version.is_some() {
            return (version, None);
        }
    }

    let err = if stderr.trim().is_empty() {
        "not installed or not executable".to_string()
    } else {
        stderr.trim().to_string()
    };
    (None, Some(err))
}

fn default_claude_native_candidate_paths() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return candidates;
    };

    #[cfg(target_os = "windows")]
    {
        candidates.push(home.join(".local").join("bin").join("claude.exe"));
        candidates.push(home.join(".local").join("bin").join("claude.cmd"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(home.join(".local").join("bin").join("claude"));
    }

    candidates
}

fn collect_claude_installations_local() -> Vec<ToolInstallation> {
    let mut installations = Vec::new();

    let path_source = detect_claude_install_source_local();
    let (path_version, path_error) = try_get_version("claude");
    upsert_tool_installation(
        &mut installations,
        normalize_claude_install_source(path_source.as_deref()),
        path_version,
        path_error,
    );

    let (npm_version, npm_error) = try_get_npm_package_version_local("@anthropic-ai/claude-code");
    upsert_tool_installation(
        &mut installations,
        CLAUDE_INSTALL_SOURCE_NPM.to_string(),
        npm_version,
        npm_error,
    );

    for candidate in default_claude_native_candidate_paths() {
        if !candidate.exists() {
            continue;
        }

        let (version, error) = try_get_version_at_path(&candidate);
        upsert_tool_installation(
            &mut installations,
            CLAUDE_INSTALL_SOURCE_NATIVE.to_string(),
            version,
            error,
        );
    }

    installations
}

#[cfg(target_os = "windows")]
fn try_get_npm_package_version_wsl(
    package: &str,
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> (Option<String>, Option<String>) {
    let command = format!("npm ls -g {package} --depth=0 --json");
    match run_wsl_shell_capture(distro, force_shell, force_shell_flag, &command) {
        Ok((_success, stdout, stderr)) => {
            parse_npm_package_version_stdout(&stdout, &stderr, package)
        }
        Err(err) => (None, Some(err)),
    }
}

#[cfg(target_os = "windows")]
fn try_get_claude_native_version_wsl(
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> (Option<String>, Option<String>) {
    match run_wsl_shell_capture(
        distro,
        force_shell,
        force_shell_flag,
        "if [ -x \"$HOME/.local/bin/claude\" ]; then \"$HOME/.local/bin/claude\" --version; fi",
    ) {
        Ok((success, stdout, stderr)) => {
            if success {
                let raw = if stdout.is_empty() { &stderr } else { &stdout };
                if raw.trim().is_empty() {
                    (None, None)
                } else {
                    (Some(extract_version(raw)), None)
                }
            } else if stderr.trim().is_empty() {
                (None, None)
            } else {
                (None, Some(stderr))
            }
        }
        Err(err) => (None, Some(err)),
    }
}

#[cfg(target_os = "windows")]
fn collect_claude_installations_wsl(
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> Vec<ToolInstallation> {
    let mut installations = Vec::new();

    let path_source = detect_claude_install_source_wsl(distro, force_shell, force_shell_flag);
    let (path_version, path_error) =
        try_get_version_wsl("claude", distro, force_shell, force_shell_flag);
    upsert_tool_installation(
        &mut installations,
        normalize_claude_install_source(path_source.as_deref()),
        path_version,
        path_error,
    );

    let (npm_version, npm_error) = try_get_npm_package_version_wsl(
        "@anthropic-ai/claude-code",
        distro,
        force_shell,
        force_shell_flag,
    );
    upsert_tool_installation(
        &mut installations,
        CLAUDE_INSTALL_SOURCE_NPM.to_string(),
        npm_version,
        npm_error,
    );

    let (native_version, native_error) =
        try_get_claude_native_version_wsl(distro, force_shell, force_shell_flag);
    upsert_tool_installation(
        &mut installations,
        CLAUDE_INSTALL_SOURCE_NATIVE.to_string(),
        native_version,
        native_error,
    );

    installations
}

#[cfg(not(target_os = "windows"))]
fn collect_claude_installations_wsl(
    _distro: &str,
    _force_shell: Option<&str>,
    _force_shell_flag: Option<&str>,
) -> Vec<ToolInstallation> {
    Vec::new()
}

/// Helper function to fetch latest version from npm registry
async fn fetch_npm_latest_version(client: &reqwest::Client, package: &str) -> Option<String> {
    let url = format!("https://registry.npmjs.org/{package}");
    match client.get(&url).send().await {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                json.get("dist-tags")
                    .and_then(|tags| tags.get("latest"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

/// Helper function to fetch latest version from GitHub releases
async fn fetch_github_latest_version(client: &reqwest::Client, repo: &str) -> Option<String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    match client
        .get(&url)
        .header("User-Agent", "cc-switch")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                json.get("tag_name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.strip_prefix('v').unwrap_or(s).to_string())
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

/// 预编译的版本号正则表达式
static VERSION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\d+\.\d+\.\d+(-[\w.]+)?").expect("Invalid version regex"));

/// 从版本输出中提取纯版本号
fn extract_version(raw: &str) -> String {
    VERSION_RE
        .find(raw)
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| raw.to_string())
}

fn first_non_empty_line(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn normalize_match_text(value: &str) -> String {
    value.replace('\\', "/").to_lowercase()
}

fn detect_claude_install_source_from_match_text(value: &str) -> Option<&'static str> {
    let normalized = normalize_match_text(value);

    let npm_markers = [
        "/node_modules/",
        "@anthropic-ai/claude-code",
        "/.npm-global/",
        "/appdata/roaming/npm/",
        "/program files/nodejs/",
        "/.volta/bin/",
        "/.local/state/fnm_multishells/",
        "/.nvm/versions/node/",
        "/n/bin/",
    ];

    if npm_markers.iter().any(|marker| normalized.contains(marker)) {
        return Some(CLAUDE_INSTALL_SOURCE_NPM);
    }

    if normalized.contains("claude") {
        return Some(CLAUDE_INSTALL_SOURCE_NATIVE);
    }

    None
}

fn read_path_prefix(path: &Path, limit: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let prefix = &bytes[..bytes.len().min(limit)];
    Some(String::from_utf8_lossy(prefix).to_string())
}

fn detect_claude_install_source_from_path(path: &Path) -> Option<&'static str> {
    if let Some(source) = detect_claude_install_source_from_match_text(&path.to_string_lossy()) {
        if source == CLAUDE_INSTALL_SOURCE_NPM {
            return Some(source);
        }
    }

    if let Ok(canonical) = path.canonicalize() {
        if let Some(source) =
            detect_claude_install_source_from_match_text(&canonical.to_string_lossy())
        {
            if source == CLAUDE_INSTALL_SOURCE_NPM {
                return Some(source);
            }
        }
    }

    if let Some(content) = read_path_prefix(path, 4096) {
        if let Some(source) = detect_claude_install_source_from_match_text(&content) {
            if source == CLAUDE_INSTALL_SOURCE_NPM {
                return Some(source);
            }
        }
    }

    Some(CLAUDE_INSTALL_SOURCE_NATIVE)
}

fn parse_claude_doctor_install_source(output: &str) -> Option<&'static str> {
    let normalized = normalize_match_text(output);
    if !normalized.contains("installation") && !normalized.contains("install type") {
        return None;
    }

    if normalized.contains("npm") {
        return Some(CLAUDE_INSTALL_SOURCE_NPM);
    }

    if normalized.contains("native") || normalized.contains("local") {
        return Some(CLAUDE_INSTALL_SOURCE_NATIVE);
    }

    None
}

fn resolve_tool_executable_path(tool: &str) -> Option<std::path::PathBuf> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    let output = Command::new("where.exe")
        .arg(tool)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {tool}"))
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let resolved = first_non_empty_line(&stdout).or_else(|| first_non_empty_line(&stderr))?;
    Some(std::path::PathBuf::from(resolved))
}

fn detect_claude_install_source_via_doctor_local() -> Option<String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    let output = Command::new("cmd")
        .args(["/C", "claude doctor"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("sh")
        .arg("-c")
        .arg("claude doctor")
        .output()
        .ok()?;

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    parse_claude_doctor_install_source(&combined).map(str::to_string)
}

fn detect_claude_install_source_local() -> Option<String> {
    resolve_tool_executable_path("claude")
        .as_deref()
        .and_then(detect_claude_install_source_from_path)
        .map(str::to_string)
        .or_else(|| {
            let (npm_version, _) = try_get_npm_package_version_local("@anthropic-ai/claude-code");
            if npm_version.is_some() {
                return Some(CLAUDE_INSTALL_SOURCE_NPM.to_string());
            }

            let has_native_candidate = default_claude_native_candidate_paths()
                .into_iter()
                .any(|candidate| candidate.exists());
            if has_native_candidate {
                return Some(CLAUDE_INSTALL_SOURCE_NATIVE.to_string());
            }

            None
        })
}

/// 尝试直接执行命令获取版本
fn try_get_version(tool: &str) -> (Option<String>, Option<String>) {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    let output = {
        Command::new("cmd")
            .args(["/C", &format!("{tool} --version")])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };

    #[cfg(not(target_os = "windows"))]
    let output = {
        Command::new("sh")
            .arg("-c")
            .arg(format!("{tool} --version"))
            .output()
    };

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if out.status.success() {
                let raw = if stdout.is_empty() { &stderr } else { &stdout };
                if raw.is_empty() {
                    (None, Some("not installed or not executable".to_string()))
                } else {
                    (Some(extract_version(raw)), None)
                }
            } else {
                let err = if stderr.is_empty() { stdout } else { stderr };
                (
                    None,
                    Some(if err.is_empty() {
                        "not installed or not executable".to_string()
                    } else {
                        err
                    }),
                )
            }
        }
        Err(e) => (None, Some(e.to_string())),
    }
}

/// 校验 WSL 发行版名称是否合法
/// WSL 发行版名称只允许字母、数字、连字符和下划线
#[cfg(target_os = "windows")]
fn is_valid_wsl_distro_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Validate that the given shell name is one of the allowed shells.
#[cfg(target_os = "windows")]
fn is_valid_shell(shell: &str) -> bool {
    matches!(
        shell.rsplit('/').next().unwrap_or(shell),
        "sh" | "bash" | "zsh" | "fish" | "dash"
    )
}

/// Validate that the given shell flag is one of the allowed flags.
#[cfg(target_os = "windows")]
fn is_valid_shell_flag(flag: &str) -> bool {
    matches!(flag, "-c" | "-lc" | "-lic")
}

/// Return the default invocation flag for the given shell.
#[cfg(target_os = "windows")]
fn default_flag_for_shell(shell: &str) -> &'static str {
    match shell.rsplit('/').next().unwrap_or(shell) {
        "dash" | "sh" => "-c",
        "fish" => "-lc",
        _ => "-lic",
    }
}

#[cfg(target_os = "windows")]
fn run_wsl_shell_capture(
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
    script: &str,
) -> Result<(bool, String, String), String> {
    use std::process::Command;

    if !is_valid_wsl_distro_name(distro) {
        return Err(format!("[WSL:{distro}] invalid distro name"));
    }

    let (shell, flag, cmd) = if let Some(shell) = force_shell {
        if !is_valid_shell(shell) {
            return Err(format!("[WSL:{distro}] invalid shell: {shell}"));
        }
        let shell = shell.rsplit('/').next().unwrap_or(shell);
        let flag = if let Some(flag) = force_shell_flag {
            if !is_valid_shell_flag(flag) {
                return Err(format!("[WSL:{distro}] invalid shell flag: {flag}"));
            }
            flag
        } else {
            default_flag_for_shell(shell)
        };

        (shell.to_string(), flag, script.to_string())
    } else {
        let cmd = if let Some(flag) = force_shell_flag {
            if !is_valid_shell_flag(flag) {
                return Err(format!("[WSL:{distro}] invalid shell flag: {flag}"));
            }
            format!("\"${{SHELL:-sh}}\" {flag} '{script}'")
        } else {
            format!(
                "\"${{SHELL:-sh}}\" -lic '{script}' 2>/dev/null || \"${{SHELL:-sh}}\" -lc '{script}' 2>/dev/null || \"${{SHELL:-sh}}\" -c '{script}'"
            )
        };

        ("sh".to_string(), "-c", cmd)
    };

    let output = Command::new("wsl.exe")
        .args(["-d", distro, "--", &shell, flag, &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("[WSL:{distro}] exec failed: {e}"))?;

    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

#[cfg(target_os = "windows")]
fn resolve_tool_executable_path_wsl(
    tool: &str,
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> Option<String> {
    let script = format!(
        "tool_path=\"$(command -v {tool})\"; if [ -n \"$tool_path\" ]; then readlink -f \"$tool_path\" 2>/dev/null || printf '%s\\n' \"$tool_path\"; fi"
    );
    let (success, stdout, stderr) =
        run_wsl_shell_capture(distro, force_shell, force_shell_flag, &script).ok()?;
    if !success {
        return None;
    }

    first_non_empty_line(&stdout).or_else(|| first_non_empty_line(&stderr))
}

#[cfg(target_os = "windows")]
fn detect_claude_install_source_wsl(
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> Option<String> {
    resolve_tool_executable_path_wsl("claude", distro, force_shell, force_shell_flag)
        .as_deref()
        .and_then(detect_claude_install_source_from_match_text)
        .map(str::to_string)
        .or_else(|| {
            let (npm_version, _) = try_get_npm_package_version_wsl(
                "@anthropic-ai/claude-code",
                distro,
                force_shell,
                force_shell_flag,
            );
            if npm_version.is_some() {
                return Some(CLAUDE_INSTALL_SOURCE_NPM.to_string());
            }

            let (native_version, _) =
                try_get_claude_native_version_wsl(distro, force_shell, force_shell_flag);
            if native_version.is_some() {
                return Some(CLAUDE_INSTALL_SOURCE_NATIVE.to_string());
            }

            None
        })
}

#[cfg(not(target_os = "windows"))]
fn detect_claude_install_source_wsl(
    _distro: &str,
    _force_shell: Option<&str>,
    _force_shell_flag: Option<&str>,
) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn try_get_version_wsl(
    tool: &str,
    distro: &str,
    force_shell: Option<&str>,
    force_shell_flag: Option<&str>,
) -> (Option<String>, Option<String>) {
    // 防御性断言：tool 只能是预定义的值
    debug_assert!(
        ["claude", "codex", "gemini", "opencode", "openclaw"].contains(&tool),
        "unexpected tool name: {tool}"
    );

    match run_wsl_shell_capture(
        distro,
        force_shell,
        force_shell_flag,
        &format!("{tool} --version"),
    ) {
        Ok((success, stdout, stderr)) => {
            if success {
                let raw = if stdout.is_empty() { &stderr } else { &stdout };
                if raw.is_empty() {
                    (
                        None,
                        Some(format!("[WSL:{distro}] not installed or not executable")),
                    )
                } else {
                    (Some(extract_version(raw)), None)
                }
            } else {
                let err = if stderr.is_empty() { stdout } else { stderr };
                (
                    None,
                    Some(format!(
                        "[WSL:{distro}] {}",
                        if err.is_empty() {
                            "not installed or not executable".to_string()
                        } else {
                            err
                        }
                    )),
                )
            }
        }
        Err(err) => (None, Some(err)),
    }
}

/// 非 Windows 平台的 WSL 版本检测存根
/// 注意：此函数实际上不会被调用，因为 `wsl_distro_from_path` 在非 Windows 平台总是返回 None。
/// 保留此函数是为了保持 API 一致性，防止未来重构时遗漏。
#[cfg(not(target_os = "windows"))]
fn try_get_version_wsl(
    _tool: &str,
    _distro: &str,
    _force_shell: Option<&str>,
    _force_shell_flag: Option<&str>,
) -> (Option<String>, Option<String>) {
    (
        None,
        Some("WSL check not supported on this platform".to_string()),
    )
}

fn push_unique_path(paths: &mut Vec<std::path::PathBuf>, path: std::path::PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }

    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn push_env_single_dir(paths: &mut Vec<std::path::PathBuf>, value: Option<std::ffi::OsString>) {
    if let Some(raw) = value {
        push_unique_path(paths, std::path::PathBuf::from(raw));
    }
}

fn extend_from_path_list(
    paths: &mut Vec<std::path::PathBuf>,
    value: Option<std::ffi::OsString>,
    suffix: Option<&str>,
) {
    if let Some(raw) = value {
        for p in std::env::split_paths(&raw) {
            let dir = match suffix {
                Some(s) => p.join(s),
                None => p,
            };
            push_unique_path(paths, dir);
        }
    }
}

/// OpenCode install.sh 路径优先级（见 https://github.com/anomalyco/opencode README）:
///   $OPENCODE_INSTALL_DIR > $XDG_BIN_DIR > $HOME/bin > $HOME/.opencode/bin
/// 额外扫描 Go 安装路径（~/go/bin、$GOPATH/*/bin）。
fn opencode_extra_search_paths(
    home: &Path,
    opencode_install_dir: Option<std::ffi::OsString>,
    xdg_bin_dir: Option<std::ffi::OsString>,
    gopath: Option<std::ffi::OsString>,
) -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();

    push_env_single_dir(&mut paths, opencode_install_dir);
    push_env_single_dir(&mut paths, xdg_bin_dir);

    if !home.as_os_str().is_empty() {
        push_unique_path(&mut paths, home.join("bin"));
        push_unique_path(&mut paths, home.join(".opencode").join("bin"));
        push_unique_path(&mut paths, home.join("go").join("bin"));
    }

    extend_from_path_list(&mut paths, gopath, Some("bin"));

    paths
}

fn tool_executable_candidates(tool: &str, dir: &Path) -> Vec<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        vec![
            dir.join(format!("{tool}.cmd")),
            dir.join(format!("{tool}.exe")),
            dir.join(tool),
        ]
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![dir.join(tool)]
    }
}

fn build_cli_search_paths(tool: &str) -> Vec<std::path::PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut search_paths: Vec<std::path::PathBuf> = Vec::new();

    if !home.as_os_str().is_empty() {
        push_unique_path(&mut search_paths, home.join(".local/bin"));
        push_unique_path(&mut search_paths, home.join(".npm-global/bin"));
        push_unique_path(&mut search_paths, home.join("n/bin"));
        push_unique_path(&mut search_paths, home.join(".volta/bin"));
    }

    #[cfg(target_os = "macos")]
    {
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("/opt/homebrew/bin"),
        );
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("/usr/local/bin"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("/usr/local/bin"),
        );
        push_unique_path(&mut search_paths, std::path::PathBuf::from("/usr/bin"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = dirs::data_dir() {
            push_unique_path(&mut search_paths, appdata.join("npm"));
        }
        push_unique_path(
            &mut search_paths,
            std::path::PathBuf::from("C:\\Program Files\\nodejs"),
        );
    }

    let fnm_base = home.join(".local/state/fnm_multishells");
    if fnm_base.exists() {
        if let Ok(entries) = std::fs::read_dir(&fnm_base) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.exists() {
                    push_unique_path(&mut search_paths, bin_path);
                }
            }
        }
    }

    let nvm_base = home.join(".nvm/versions/node");
    if nvm_base.exists() {
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.exists() {
                    push_unique_path(&mut search_paths, bin_path);
                }
            }
        }
    }

    if tool == "opencode" {
        let extra_paths = opencode_extra_search_paths(
            &home,
            std::env::var_os("OPENCODE_INSTALL_DIR"),
            std::env::var_os("XDG_BIN_DIR"),
            std::env::var_os("GOPATH"),
        );

        for path in extra_paths {
            push_unique_path(&mut search_paths, path);
        }
    }

    search_paths
}

fn scan_cli_version_with_path(
    tool: &str,
) -> (Option<String>, Option<String>, Option<std::path::PathBuf>) {
    use std::process::Command;

    let search_paths = build_cli_search_paths(tool);
    let current_path = std::env::var("PATH").unwrap_or_default();

    for path in &search_paths {
        #[cfg(target_os = "windows")]
        let new_path = format!("{};{}", path.display(), current_path);

        #[cfg(not(target_os = "windows"))]
        let new_path = format!("{}:{}", path.display(), current_path);

        for tool_path in tool_executable_candidates(tool, path) {
            if !tool_path.exists() {
                continue;
            }

            #[cfg(target_os = "windows")]
            let output = {
                Command::new("cmd")
                    .args(["/C", &format!("\"{}\" --version", tool_path.display())])
                    .env("PATH", &new_path)
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
            };

            #[cfg(not(target_os = "windows"))]
            let output = {
                Command::new(&tool_path)
                    .arg("--version")
                    .env("PATH", &new_path)
                    .output()
            };

            if let Ok(out) = output {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if out.status.success() {
                    let raw = if stdout.is_empty() { &stderr } else { &stdout };
                    if !raw.is_empty() {
                        return (Some(extract_version(raw)), None, Some(tool_path));
                    }
                }
            }
        }
    }

    (
        None,
        Some("not installed or not executable".to_string()),
        None,
    )
}

/// 扫描常见路径查找 CLI
fn scan_cli_version(tool: &str) -> (Option<String>, Option<String>) {
    let (version, error, _) = scan_cli_version_with_path(tool);
    (version, error)
}

#[cfg(target_os = "windows")]
fn wsl_distro_for_tool(tool: &str) -> Option<String> {
    let override_dir = match tool {
        "claude" => crate::settings::get_claude_override_dir(),
        "codex" => crate::settings::get_codex_override_dir(),
        "gemini" => crate::settings::get_gemini_override_dir(),
        "opencode" => crate::settings::get_opencode_override_dir(),
        "openclaw" => crate::settings::get_openclaw_override_dir(),
        _ => None,
    }?;

    wsl_distro_from_path(&override_dir)
}

/// 从 UNC 路径中提取 WSL 发行版名称
/// 支持 `\\wsl$\Ubuntu\...` 和 `\\wsl.localhost\Ubuntu\...` 两种格式
#[cfg(target_os = "windows")]
fn wsl_distro_from_path(path: &Path) -> Option<String> {
    use std::path::{Component, Prefix};
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return None;
    };
    match prefix.kind() {
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            let server_name = server.to_string_lossy();
            if server_name.eq_ignore_ascii_case("wsl$")
                || server_name.eq_ignore_ascii_case("wsl.localhost")
            {
                let distro = share.to_string_lossy().to_string();
                if !distro.is_empty() {
                    return Some(distro);
                }
            }
            None
        }
        _ => None,
    }
}

/// 打开指定提供商的终端
///
/// 根据提供商配置的环境变量启动一个带有该提供商特定设置的终端
/// 无需检查是否为当前激活的提供商，任何提供商都可以打开终端
#[allow(non_snake_case)]
#[tauri::command]
pub async fn open_provider_terminal(
    state: State<'_, crate::store::AppState>,
    app: String,
    #[allow(non_snake_case)] providerId: String,
    #[allow(non_snake_case)] cwd: Option<String>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;

    // 获取提供商配置
    let providers = ProviderService::list(state.inner(), app_type.clone())
        .map_err(|e| format!("获取提供商列表失败: {e}"))?;

    let provider = providers
        .get(&providerId)
        .ok_or_else(|| format!("提供商 {providerId} 不存在"))?;

    // 从提供商配置中提取环境变量
    let config = &provider.settings_config;
    let env_vars = extract_env_vars_from_config(config, &app_type);

    // 根据平台启动终端，传入提供商ID用于生成唯一的配置文件名
    launch_terminal_with_env(env_vars, &providerId, cwd.as_deref())
        .map_err(|e| format!("启动终端失败: {e}"))?;

    Ok(true)
}

/// 打开应用终端（不绑定具体供应商配置）
#[tauri::command]
pub async fn open_app_terminal(
    app: String,
    #[allow(non_snake_case)] cwd: Option<String>,
) -> Result<bool, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    let command = match app_type {
        AppType::Claude => "claude",
        AppType::Codex => "codex",
        AppType::Gemini => "gemini",
        AppType::OpenCode => "opencode",
        AppType::OpenClaw => "openclaw",
    };

    launch_terminal_with_command(command, cwd.as_deref())
        .map_err(|e| format!("启动终端失败: {e}"))?;

    Ok(true)
}

/// 从提供商配置中提取环境变量
fn extract_env_vars_from_config(
    config: &serde_json::Value,
    app_type: &AppType,
) -> Vec<(String, String)> {
    let mut env_vars = Vec::new();

    let Some(obj) = config.as_object() else {
        return env_vars;
    };

    // 处理 env 字段（Claude/Gemini 通用）
    if let Some(env) = obj.get("env").and_then(|v| v.as_object()) {
        for (key, value) in env {
            if let Some(str_val) = value.as_str() {
                env_vars.push((key.clone(), str_val.to_string()));
            }
        }

        // 处理 base_url: 根据应用类型添加对应的环境变量
        let base_url_key = match app_type {
            AppType::Claude => Some("ANTHROPIC_BASE_URL"),
            AppType::Gemini => Some("GOOGLE_GEMINI_BASE_URL"),
            _ => None,
        };

        if let Some(key) = base_url_key {
            if let Some(url_str) = env.get(key).and_then(|v| v.as_str()) {
                env_vars.push((key.to_string(), url_str.to_string()));
            }
        }
    }

    // Codex 使用 auth 字段转换为 OPENAI_API_KEY
    if *app_type == AppType::Codex {
        if let Some(auth) = obj.get("auth").and_then(|v| v.as_object()) {
            if let Some(api_key) = auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()) {
                env_vars.push(("OPENAI_API_KEY".to_string(), api_key.to_string()));
            }
        } else if let Some(auth) = obj.get("auth").and_then(|v| v.as_str()) {
            // 兼容极早期的字符串写法
            env_vars.push(("OPENAI_API_KEY".to_string(), auth.to_string()));
        }
    }

    // Gemini 使用 api_key 字段转换为 GEMINI_API_KEY
    if *app_type == AppType::Gemini {
        if let Some(api_key) = obj.get("api_key").and_then(|v| v.as_str()) {
            env_vars.push(("GEMINI_API_KEY".to_string(), api_key.to_string()));
        }
    }

    env_vars
}

/// 创建临时配置文件并启动 claude 终端
/// 使用 --settings 参数传入提供商特定的 API 配置
fn launch_terminal_with_env(
    env_vars: Vec<(String, String)>,
    _provider_id: &str,
    cwd: Option<&str>,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let unique_id = uuid::Uuid::new_v4().to_string();
    let config_file = temp_dir.join(format!("claude_{}.json", unique_id));

    // 创建并写入配置文件
    write_claude_config(&config_file, &env_vars)?;

    #[cfg(target_os = "macos")]
    {
        launch_macos_terminal(&config_file, cwd)?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        launch_linux_terminal(&config_file, cwd)?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        launch_windows_terminal(&temp_dir, &config_file, cwd)?;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    Err("不支持的操作系统".to_string())
}

/// 写入 claude 配置文件
fn write_claude_config(
    config_file: &std::path::Path,
    env_vars: &[(String, String)],
) -> Result<(), String> {
    let mut config_obj = serde_json::Map::new();
    let mut env_obj = serde_json::Map::new();

    for (key, value) in env_vars {
        env_obj.insert(key.clone(), serde_json::Value::String(value.clone()));
    }

    config_obj.insert("env".to_string(), serde_json::Value::Object(env_obj));

    let config_json =
        serde_json::to_string_pretty(&config_obj).map_err(|e| format!("序列化配置失败: {e}"))?;

    std::fs::write(config_file, config_json).map_err(|e| format!("写入配置文件失败: {e}"))
}

/// 创建临时脚本并启动终端（不绑定供应商配置）
fn launch_terminal_with_command(command: &str, cwd: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        launch_macos_terminal_command(command, cwd)?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        launch_linux_terminal_command(command, cwd)?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        launch_windows_terminal_command(command, cwd)?;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    Err("不支持的操作系统".to_string())
}

/// macOS: 根据用户首选终端启动（命令模式）
#[cfg(target_os = "macos")]
fn launch_macos_terminal_command(command: &str, cwd: Option<&str>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let preferred = crate::settings::get_preferred_terminal();
    let terminal = preferred.as_deref().unwrap_or("terminal");

    let temp_dir = std::env::temp_dir();
    let script_file = temp_dir.join(format!(
        "cc_switch_app_launcher_{}.sh",
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

    std::fs::write(&script_file, &script_content).map_err(|e| format!("写入启动脚本失败: {e}"))?;

    std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("设置脚本权限失败: {e}"))?;

    let result = match terminal {
        "iterm2" => launch_macos_iterm2(&script_file),
        "alacritty" => launch_macos_open_app("Alacritty", &script_file, true),
        "kitty" => launch_macos_open_app("kitty", &script_file, false),
        "ghostty" => launch_macos_open_app("Ghostty", &script_file, true),
        "wezterm" => launch_macos_open_app("WezTerm", &script_file, true),
        _ => launch_macos_terminal_app(&script_file), // "terminal" or default
    };

    if result.is_err() && terminal != "terminal" {
        log::warn!(
            "首选终端 {} 启动失败，回退到 Terminal.app: {:?}",
            terminal,
            result.as_ref().err()
        );
        return launch_macos_terminal_app(&script_file);
    }

    result
}

/// Linux: 根据用户首选终端启动（命令模式）
#[cfg(target_os = "linux")]
fn launch_linux_terminal_command(command: &str, cwd: Option<&str>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

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
        "cc_switch_app_launcher_{}.sh",
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

    std::fs::write(&script_file, &script_content).map_err(|e| format!("写入启动脚本失败: {e}"))?;

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
                Err(e) => {
                    last_error = format!("执行 {} 失败: {}", terminal, e);
                }
            }
        }
    }

    let _ = std::fs::remove_file(&script_file);
    Err(last_error)
}

/// Windows: 根据用户首选终端启动（命令模式）
#[cfg(target_os = "windows")]
fn launch_windows_terminal_command(command: &str, cwd: Option<&str>) -> Result<(), String> {
    let preferred = crate::settings::get_preferred_terminal();
    let terminal = preferred.as_deref().unwrap_or("cmd");

    let temp_dir = std::env::temp_dir();
    let bat_file = temp_dir.join(format!(
        "cc_switch_app_launcher_{}.bat",
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
start \"\" /b cmd /c \"ping 127.0.0.1 -n 2 >nul & del /f /q \"%~f0\" >nul 2>&1\"\r\n",
        cd_line = cd_line,
        command = command
    );

    std::fs::write(&bat_file, &content).map_err(|e| format!("写入批处理文件失败: {e}"))?;

    let bat_path = bat_file.to_string_lossy().to_string();
    let bat_path_quoted = format!("\"{}\"", bat_path.replace('\"', "\"\""));
    let ps_cmd = format!("& {}", bat_path_quoted);

    let result = match terminal {
        "powershell" => run_windows_start_command(
            &["powershell", "-NoExit", "-Command", &ps_cmd],
            "PowerShell",
        ),
        "wt" => {
            run_windows_start_command(&["wt", "cmd", "/K", &bat_path_quoted], "Windows Terminal")
        }
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

/// macOS: 根据用户首选终端启动
#[cfg(target_os = "macos")]
fn launch_macos_terminal(config_file: &std::path::Path, cwd: Option<&str>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let preferred = crate::settings::get_preferred_terminal();
    let terminal = preferred.as_deref().unwrap_or("terminal");

    let temp_dir = std::env::temp_dir();
    let script_file = temp_dir.join(format!("cc_switch_launcher_{}.sh", std::process::id()));
    let config_path = escape_shell_path(&config_file.to_string_lossy());
    let cwd_line = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("cd \"{}\"", escape_shell_path(value)))
        .unwrap_or_default();

    // Write the shell script to a temp file
    let script_content = format!(
        r#"#!/bin/bash
trap 'rm -f "{config_path}" "{script_file}"' EXIT
{cwd_line}
echo "Using provider-specific claude config:"
echo "{config_path}"
claude --settings "{config_path}"
exec bash --norc --noprofile
"#,
        config_path = config_path,
        script_file = script_file.display(),
        cwd_line = cwd_line
    );

    std::fs::write(&script_file, &script_content).map_err(|e| format!("写入启动脚本失败: {e}"))?;

    // Make script executable
    std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("设置脚本权限失败: {e}"))?;

    // Try the preferred terminal first, fall back to Terminal.app if it fails
    // Note: Kitty doesn't need the -e flag, others do
    let result = match terminal {
        "iterm2" => launch_macos_iterm2(&script_file),
        "alacritty" => launch_macos_open_app("Alacritty", &script_file, true),
        "kitty" => launch_macos_open_app("kitty", &script_file, false),
        "ghostty" => launch_macos_open_app("Ghostty", &script_file, true),
        "wezterm" => launch_macos_open_app("WezTerm", &script_file, true),
        _ => launch_macos_terminal_app(&script_file), // "terminal" or default
    };

    // If preferred terminal fails and it's not the default, try Terminal.app as fallback
    if result.is_err() && terminal != "terminal" {
        log::warn!(
            "首选终端 {} 启动失败，回退到 Terminal.app: {:?}",
            terminal,
            result.as_ref().err()
        );
        return launch_macos_terminal_app(&script_file);
    }

    result
}

/// macOS: Terminal.app
#[cfg(target_os = "macos")]
fn launch_macos_terminal_app(script_file: &std::path::Path) -> Result<(), String> {
    use std::process::Command;

    let applescript = format!(
        r#"tell application "Terminal"
    activate
    do script "bash '{}'"
end tell"#,
        script_file.display()
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&applescript)
        .output()
        .map_err(|e| format!("执行 osascript 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Terminal.app 执行失败 (exit code: {:?}): {}",
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

/// macOS: iTerm2
#[cfg(target_os = "macos")]
fn launch_macos_iterm2(script_file: &std::path::Path) -> Result<(), String> {
    use std::process::Command;

    let applescript = format!(
        r#"tell application "iTerm"
    activate
    tell current window
        create tab with default profile
        tell current session
            write text "bash '{}'"
        end tell
    end tell
end tell"#,
        script_file.display()
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&applescript)
        .output()
        .map_err(|e| format!("执行 osascript 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "iTerm2 执行失败 (exit code: {:?}): {}",
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

/// macOS: 使用 open -a 启动支持 --args 参数的终端（Alacritty/Kitty/Ghostty）
#[cfg(target_os = "macos")]
fn launch_macos_open_app(
    app_name: &str,
    script_file: &std::path::Path,
    use_e_flag: bool,
) -> Result<(), String> {
    use std::process::Command;

    let mut cmd = Command::new("open");
    cmd.arg("-a").arg(app_name).arg("--args");

    if use_e_flag {
        cmd.arg("-e");
    }
    cmd.arg("bash").arg(script_file);

    let output = cmd
        .output()
        .map_err(|e| format!("启动 {app_name} 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{} 启动失败 (exit code: {:?}): {}",
            app_name,
            output.status.code(),
            stderr
        ));
    }

    Ok(())
}

/// Linux: 根据用户首选终端启动
#[cfg(target_os = "linux")]
fn launch_linux_terminal(config_file: &std::path::Path, cwd: Option<&str>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let preferred = crate::settings::get_preferred_terminal();

    // Default terminal list with their arguments
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

    // Create temp script file
    let temp_dir = std::env::temp_dir();
    let script_file = temp_dir.join(format!("cc_switch_launcher_{}.sh", std::process::id()));
    let config_path = escape_shell_path(&config_file.to_string_lossy());
    let cwd_line = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("cd \"{}\"", escape_shell_path(value)))
        .unwrap_or_default();

    let script_content = format!(
        r#"#!/bin/bash
trap 'rm -f "{config_path}" "{script_file}"' EXIT
{cwd_line}
echo "Using provider-specific claude config:"
echo "{config_path}"
claude --settings "{config_path}"
exec bash --norc --noprofile
"#,
        config_path = config_path,
        script_file = script_file.display(),
        cwd_line = cwd_line
    );

    std::fs::write(&script_file, &script_content).map_err(|e| format!("写入启动脚本失败: {e}"))?;

    std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("设置脚本权限失败: {e}"))?;

    // Build terminal list: preferred terminal first (if specified), then defaults
    let terminals_to_try: Vec<(&str, Vec<&str>)> = if let Some(ref pref) = preferred {
        // Find the preferred terminal's args from default list
        let pref_args = default_terminals
            .iter()
            .find(|(name, _)| *name == pref.as_str())
            .map(|(_, args)| args.iter().map(|s| *s).collect::<Vec<&str>>())
            .unwrap_or_else(|| vec!["-e"]); // Default args for unknown terminals

        let mut list = vec![(pref.as_str(), pref_args)];
        // Add remaining terminals as fallbacks
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
        // Check if terminal exists in common paths
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
                Err(e) => {
                    last_error = format!("执行 {} 失败: {}", terminal, e);
                }
            }
        }
    }

    // Clean up on failure
    let _ = std::fs::remove_file(&script_file);
    let _ = std::fs::remove_file(config_file);
    Err(last_error)
}

/// Check if a command exists using `which`
#[cfg(target_os = "linux")]
fn which_command(cmd: &str) -> bool {
    use std::process::Command;
    Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Windows: 根据用户首选终端启动
#[cfg(target_os = "windows")]
fn launch_windows_terminal(
    temp_dir: &std::path::Path,
    config_file: &std::path::Path,
    cwd: Option<&str>,
) -> Result<(), String> {
    let preferred = crate::settings::get_preferred_terminal();
    let terminal = preferred.as_deref().unwrap_or("cmd");

    let bat_file = temp_dir.join(format!("cc_switch_claude_{}.bat", uuid::Uuid::new_v4()));
    let config_path = config_file.to_string_lossy().to_string();

    let cd_line = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("cd /d \"{}\"\r\n", value.replace('"', "\"\"")))
        .unwrap_or_default();

    let content = format!(
        "@echo off\r\n\
setlocal\r\n\
{cd_line}\
call claude --settings \"{config_path}\"\r\n\
del \"{config_path}\" >nul 2>&1\r\n\
endlocal\r\n\
start \"\" /b cmd /c \"ping 127.0.0.1 -n 2 >nul & del /f /q \"%~f0\" >nul 2>&1\"\r\n",
        config_path = config_path,
        cd_line = cd_line
    );

    std::fs::write(&bat_file, &content).map_err(|e| format!("写入批处理文件失败: {e}"))?;

    let bat_path = bat_file.to_string_lossy().to_string();
    let bat_path_quoted = format!("\"{}\"", bat_path.replace('"', "\"\""));
    let ps_cmd = format!("& {}", bat_path_quoted);

    // Try the preferred terminal first
    let result = match terminal {
        "powershell" => run_windows_start_command(
            &["powershell", "-NoExit", "-Command", &ps_cmd],
            "PowerShell",
        ),
        "wt" => {
            run_windows_start_command(&["wt", "cmd", "/K", &bat_path_quoted], "Windows Terminal")
        }
        _ => run_windows_start_command(&["cmd", "/K", &bat_path_quoted], "cmd"), // "cmd" or default
    };

    // If preferred terminal fails and it's not the default, try cmd as fallback
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

/// Windows: Run a start command with common error handling
#[cfg(target_os = "windows")]
fn run_windows_start_command(args: &[&str], terminal_name: &str) -> Result<(), String> {
    use std::process::Command;

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

/// 设置窗口主题（Windows/macOS 标题栏颜色）
/// theme: "dark" | "light" | "system"
#[tauri::command]
pub async fn set_window_theme(window: tauri::Window, theme: String) -> Result<(), String> {
    use tauri::Theme;

    let tauri_theme = match theme.as_str() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None, // system default
    };

    window.set_theme(tauri_theme).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_extract_version() {
        assert_eq!(extract_version("claude 1.0.20"), "1.0.20");
        assert_eq!(extract_version("v2.3.4-beta.1"), "2.3.4-beta.1");
        assert_eq!(extract_version("no version here"), "no version here");
    }

    #[test]
    fn claude_update_command_uses_install_source() {
        assert_eq!(
            update_command_for_tool("claude", Some(CLAUDE_INSTALL_SOURCE_NPM)),
            Some("npm i -g @anthropic-ai/claude-code@latest")
        );
        assert_eq!(
            update_command_for_tool("claude", Some(CLAUDE_INSTALL_SOURCE_NATIVE)),
            Some("claude update")
        );
        assert_eq!(
            update_command_for_tool("claude", None),
            Some("claude update")
        );
        assert_eq!(
            update_command_for_tool("openclaw", None),
            Some("openclaw update")
        );
        assert_eq!(
            update_command_for_tool("opencode", None),
            Some("opencode upgrade")
        );
    }

    #[test]
    fn parse_claude_doctor_install_source_detects_supported_sources() {
        assert_eq!(
            parse_claude_doctor_install_source("Installation type: npm"),
            Some(CLAUDE_INSTALL_SOURCE_NPM)
        );
        assert_eq!(
            parse_claude_doctor_install_source("Installation type: native"),
            Some(CLAUDE_INSTALL_SOURCE_NATIVE)
        );
        assert_eq!(
            parse_claude_doctor_install_source("Installation type: local"),
            Some(CLAUDE_INSTALL_SOURCE_NATIVE)
        );
    }

    #[test]
    fn detect_claude_install_source_from_match_text_prefers_npm_markers() {
        assert_eq!(
            detect_claude_install_source_from_match_text(
                "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.js"
            ),
            Some(CLAUDE_INSTALL_SOURCE_NPM)
        );
        assert_eq!(
            detect_claude_install_source_from_match_text("/home/tester/.local/bin/claude"),
            Some(CLAUDE_INSTALL_SOURCE_NATIVE)
        );
    }

    #[test]
    fn extract_env_vars_from_codex_object_auth() {
        let config = serde_json::json!({
            "auth": {
                "OPENAI_API_KEY": "sk-test"
            },
            "config": "model = \"gpt-5.4\""
        });

        let env_vars = extract_env_vars_from_config(&config, &AppType::Codex);

        assert!(
            env_vars.contains(&("OPENAI_API_KEY".to_string(), "sk-test".to_string())),
            "expected OPENAI_API_KEY to be extracted from codex auth object"
        );
    }

    #[cfg(target_os = "windows")]
    mod wsl_helpers {
        use super::super::*;

        #[test]
        fn test_is_valid_shell() {
            assert!(is_valid_shell("bash"));
            assert!(is_valid_shell("zsh"));
            assert!(is_valid_shell("sh"));
            assert!(is_valid_shell("fish"));
            assert!(is_valid_shell("dash"));
            assert!(is_valid_shell("/usr/bin/bash"));
            assert!(is_valid_shell("/bin/zsh"));
            assert!(!is_valid_shell("powershell"));
            assert!(!is_valid_shell("cmd"));
            assert!(!is_valid_shell(""));
        }

        #[test]
        fn test_is_valid_shell_flag() {
            assert!(is_valid_shell_flag("-c"));
            assert!(is_valid_shell_flag("-lc"));
            assert!(is_valid_shell_flag("-lic"));
            assert!(!is_valid_shell_flag("-x"));
            assert!(!is_valid_shell_flag(""));
            assert!(!is_valid_shell_flag("--login"));
        }

        #[test]
        fn test_default_flag_for_shell() {
            assert_eq!(default_flag_for_shell("sh"), "-c");
            assert_eq!(default_flag_for_shell("dash"), "-c");
            assert_eq!(default_flag_for_shell("/bin/dash"), "-c");
            assert_eq!(default_flag_for_shell("fish"), "-lc");
            assert_eq!(default_flag_for_shell("bash"), "-lic");
            assert_eq!(default_flag_for_shell("zsh"), "-lic");
            assert_eq!(default_flag_for_shell("/usr/bin/zsh"), "-lic");
        }

        #[test]
        fn test_is_valid_wsl_distro_name() {
            assert!(is_valid_wsl_distro_name("Ubuntu"));
            assert!(is_valid_wsl_distro_name("Ubuntu-22.04"));
            assert!(is_valid_wsl_distro_name("my_distro"));
            assert!(!is_valid_wsl_distro_name(""));
            assert!(!is_valid_wsl_distro_name("distro with spaces"));
            assert!(!is_valid_wsl_distro_name(&"a".repeat(65)));
        }
    }

    #[test]
    fn opencode_extra_search_paths_includes_install_and_fallback_dirs() {
        let home = PathBuf::from("/home/tester");
        let install_dir = Some(std::ffi::OsString::from("/custom/opencode/bin"));
        let xdg_bin_dir = Some(std::ffi::OsString::from("/xdg/bin"));
        let gopath =
            std::env::join_paths([PathBuf::from("/go/path1"), PathBuf::from("/go/path2")]).ok();

        let paths = opencode_extra_search_paths(&home, install_dir, xdg_bin_dir, gopath);

        assert_eq!(paths[0], PathBuf::from("/custom/opencode/bin"));
        assert_eq!(paths[1], PathBuf::from("/xdg/bin"));
        assert!(paths.contains(&PathBuf::from("/home/tester/bin")));
        assert!(paths.contains(&PathBuf::from("/home/tester/.opencode/bin")));
        assert!(paths.contains(&PathBuf::from("/home/tester/go/bin")));
        assert!(paths.contains(&PathBuf::from("/go/path1/bin")));
        assert!(paths.contains(&PathBuf::from("/go/path2/bin")));
    }

    #[test]
    fn opencode_extra_search_paths_deduplicates_repeated_entries() {
        let home = PathBuf::from("/home/tester");
        let same_dir = Some(std::ffi::OsString::from("/same/path"));
        let target = PathBuf::from("/same/path");

        let paths = opencode_extra_search_paths(&home, same_dir.clone(), same_dir.clone(), None);

        let count = paths.iter().filter(|path| path == &&target).count();
        assert_eq!(count, 1);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn tool_executable_candidates_non_windows_uses_plain_binary_name() {
        let dir = PathBuf::from("/usr/local/bin");
        let candidates = tool_executable_candidates("opencode", &dir);

        assert_eq!(candidates, vec![PathBuf::from("/usr/local/bin/opencode")]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tool_executable_candidates_windows_includes_cmd_exe_and_plain_name() {
        let dir = PathBuf::from("C:\\tools");
        let candidates = tool_executable_candidates("opencode", &dir);

        assert_eq!(
            candidates,
            vec![
                PathBuf::from("C:\\tools\\opencode.cmd"),
                PathBuf::from("C:\\tools\\opencode.exe"),
                PathBuf::from("C:\\tools\\opencode"),
            ]
        );
    }
}
