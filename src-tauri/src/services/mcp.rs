use indexmap::IndexMap;
use std::collections::HashMap;

use crate::app_config::{AppType, McpServer};
use crate::error::AppError;
use crate::mcp;
use crate::store::AppState;

/// MCP 相关业务逻辑（v3.7.0 统一结构）
pub struct McpService;

impl McpService {
    /// 获取所有 MCP 服务器（统一结构）
    pub fn get_all_servers(state: &AppState) -> Result<IndexMap<String, McpServer>, AppError> {
        state.db.get_all_mcp_servers()
    }

    /// 添加或更新 MCP 服务器
    pub fn upsert_server(state: &AppState, server: McpServer) -> Result<(), AppError> {
        // 读取旧状态：用于处理“编辑时取消勾选某个应用”的场景（需要从对应 live 配置中移除）
        let prev_apps = state
            .db
            .get_all_mcp_servers()?
            .get(&server.id)
            .map(|s| s.apps.clone())
            .unwrap_or_default();
        let next_apps = server.apps.clone();
        let affected_apps = Self::affected_apps_for_change(&prev_apps, &next_apps);

        state.db.save_mcp_server(&server)?;

        // 处理禁用：若旧版本启用但新版本取消，必须按服务器 ID 直接清理。
        // 随后的 app 级重建会刷新当前供应商模板和代理接管备份。
        for app in &affected_apps {
            if prev_apps.is_enabled_for(app) && !next_apps.is_enabled_for(app) {
                Self::remove_server_from_app(state, &server.id, app)?;
            }
        }

        for app in affected_apps {
            Self::reconcile_app_after_mcp_change(state, &app)?;
        }

        Ok(())
    }

    /// 删除 MCP 服务器
    pub fn delete_server(state: &AppState, id: &str) -> Result<bool, AppError> {
        let server = state.db.get_all_mcp_servers()?.shift_remove(id);

        if let Some(server) = server {
            state.db.delete_mcp_server(id)?;

            // 从所有应用的 live 配置中移除
            Self::remove_server_from_all_apps(state, id, &server)?;
            for app in server.apps.enabled_apps() {
                Self::reconcile_app_after_mcp_change(state, &app)?;
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 切换指定应用的启用状态
    pub fn toggle_app(
        state: &AppState,
        server_id: &str,
        app: AppType,
        enabled: bool,
    ) -> Result<(), AppError> {
        let mut servers = state.db.get_all_mcp_servers()?;

        if let Some(server) = servers.get_mut(server_id) {
            server.apps.set_enabled_for(&app, enabled);
            state.db.save_mcp_server(server)?;

            // 禁用时需要按 ID 直接清理；启用时由 app 级重建写入。
            if !enabled {
                Self::remove_server_from_app(state, server_id, &app)?;
            }
            Self::reconcile_app_after_mcp_change(state, &app)?;
        }

        Ok(())
    }

    fn affected_apps_for_change(
        prev: &crate::app_config::McpApps,
        next: &crate::app_config::McpApps,
    ) -> Vec<AppType> {
        AppType::all()
            .filter(|app| {
                !matches!(app, AppType::OpenClaw)
                    && (prev.is_enabled_for(app) || next.is_enabled_for(app))
            })
            .collect()
    }

    fn has_syncable_provider(state: &AppState, app: &AppType) -> Result<bool, AppError> {
        if app.is_additive_mode() {
            return Ok(!matches!(app, AppType::OpenClaw));
        }

        let proxy_config =
            futures::executor::block_on(state.db.get_proxy_config_for_app(app.as_str())).ok();
        let takeover_enabled = proxy_config
            .as_ref()
            .map(|config| config.enabled)
            .unwrap_or(false);
        let auto_failover_enabled = proxy_config
            .as_ref()
            .map(|config| config.auto_failover_enabled)
            .unwrap_or(false);

        let current_id = if takeover_enabled && auto_failover_enabled {
            state
                .db
                .get_failover_queue(app.as_str())?
                .into_iter()
                .next()
                .map(|item| item.provider_id)
        } else {
            crate::settings::get_effective_current_provider(&state.db, app)?
        };
        let Some(current_id) = current_id else {
            return Ok(false);
        };

        Ok(state
            .db
            .get_provider_by_id(&current_id, app.as_str())?
            .is_some())
    }

    fn sync_all_for_app_from_db(state: &AppState, app: &AppType) -> Result<(), AppError> {
        let servers = state.db.get_all_mcp_servers()?;

        for server in servers.values() {
            if server.apps.is_enabled_for(app) {
                Self::sync_server_to_app(state, server, app)?;
            } else {
                Self::remove_server_from_app(state, &server.id, app)?;
            }
        }

        Ok(())
    }

    fn is_proxy_takeover_live_owned(state: &AppState, app: &AppType) -> bool {
        if !matches!(app, AppType::Claude | AppType::Codex | AppType::Gemini) {
            return false;
        }

        futures::executor::block_on(
            state
                .proxy_service
                .should_preserve_takeover_live_semantics(app),
        )
    }

    fn reconcile_app_after_mcp_change(state: &AppState, app: &AppType) -> Result<(), AppError> {
        if matches!(app, AppType::OpenClaw) {
            return Ok(());
        }

        if Self::is_proxy_takeover_live_owned(state, app) {
            if let Err(err) =
                crate::services::provider::ProviderService::sync_current_provider_for_app_with_options(
                    state,
                    app.clone(),
                    crate::services::provider::SyncCurrentProviderOptions {
                        sync_mcp: false,
                    },
                )
            {
                log::warn!(
                    "Failed to rebuild {} proxy takeover config after MCP change: {err}",
                    app.as_str()
                );
            }

            // Claude MCP is stored in ~/.claude.json, separate from settings.json.
            // Codex/Gemini receive MCP through the app access template while takeover is active.
            if matches!(app, AppType::Claude) {
                Self::sync_all_for_app_from_db(state, app)?;
            }

            return Ok(());
        }

        let provider_synced = if Self::has_syncable_provider(state, app)? {
            match crate::services::provider::ProviderService::sync_current_provider_for_app_with_options(
                state,
                app.clone(),
                crate::services::provider::SyncCurrentProviderOptions {
                    sync_mcp: false,
                },
            ) {
                Ok(()) => true,
                Err(err) => {
                    log::warn!(
                        "Failed to rebuild {} live config after MCP change: {err}",
                        app.as_str()
                    );
                    false
                }
            }
        } else {
            false
        };

        // Provider sync already performs a full MCP reconciliation in ordinary live mode.
        // For proxy-capable apps we still run the MCP-only path afterwards: Claude MCP is a
        // separate file, and Codex/Gemini need direct live reconciliation when proxy takeover
        // short-circuits the normal provider sync flow.
        if !provider_synced || matches!(app, AppType::Claude | AppType::Codex | AppType::Gemini) {
            Self::sync_all_for_app_from_db(state, app)?;
        }

        Ok(())
    }

    /// 将 MCP 服务器同步到所有启用的应用
    #[allow(dead_code)]
    fn sync_server_to_apps(_state: &AppState, server: &McpServer) -> Result<(), AppError> {
        for app in server.apps.enabled_apps() {
            Self::sync_server_to_app_no_config(server, &app)?;
        }

        Ok(())
    }

    /// 将 MCP 服务器同步到指定应用
    fn sync_server_to_app(
        _state: &AppState,
        server: &McpServer,
        app: &AppType,
    ) -> Result<(), AppError> {
        Self::sync_server_to_app_no_config(server, app)
    }

    fn sync_server_to_app_no_config(server: &McpServer, app: &AppType) -> Result<(), AppError> {
        match app {
            AppType::Claude => {
                mcp::sync_single_server_to_claude(&Default::default(), &server.id, &server.server)?;
            }
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use CC Switch MCP sync, skipping");
            }
            AppType::Codex => {
                // Codex uses TOML format, must use the correct function
                mcp::sync_single_server_to_codex(&Default::default(), &server.id, &server.server)?;
            }
            AppType::Gemini => {
                mcp::sync_single_server_to_gemini(&Default::default(), &server.id, &server.server)?;
            }
            AppType::OpenCode => {
                mcp::sync_single_server_to_opencode(
                    &Default::default(),
                    &server.id,
                    &server.server,
                )?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development (Issue #4834)
                // Skip for now
                log::debug!("OpenClaw MCP support is still in development, skipping sync");
            }
            AppType::Hermes => {
                mcp::sync_single_server_to_hermes(&Default::default(), &server.id, &server.server)?;
            }
        }
        Ok(())
    }

    /// 从所有曾启用过该服务器的应用中移除
    fn remove_server_from_all_apps(
        state: &AppState,
        id: &str,
        server: &McpServer,
    ) -> Result<(), AppError> {
        // 从所有曾启用的应用中移除
        for app in server.apps.enabled_apps() {
            Self::remove_server_from_app(state, id, &app)?;
        }
        Ok(())
    }

    fn remove_server_from_app(_state: &AppState, id: &str, app: &AppType) -> Result<(), AppError> {
        match app {
            AppType::Claude => mcp::remove_server_from_claude(id)?,
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use CC Switch MCP sync, skipping");
            }
            AppType::Codex => mcp::remove_server_from_codex(id)?,
            AppType::Gemini => mcp::remove_server_from_gemini(id)?,
            AppType::OpenCode => {
                mcp::remove_server_from_opencode(id)?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development
                log::debug!("OpenClaw MCP support is still in development, skipping remove");
            }
            AppType::Hermes => {
                mcp::remove_server_from_hermes(id)?;
            }
        }
        Ok(())
    }

    /// 手动同步所有启用的 MCP 服务器到对应的应用。
    ///
    /// Best-effort：单个应用投影失败（如 ~/.claude.json 坏 JSON）不阻断
    /// 其余应用——各应用的 live 文件互相独立，一处损坏没有理由让其他
    /// 应用的 MCP 状态陈旧。全部跑完后若有失败，聚合成一个错误上报，
    /// 保留调用方的可见性。
    pub fn sync_all_enabled(state: &AppState) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;

        let mut failures: Vec<String> = Vec::new();
        for app in AppType::all() {
            if let Err(err) = Self::project_servers_to_app(state, &servers, &app) {
                log::warn!("同步 MCP 到 {app:?} 失败: {err}");
                failures.push(format!("{}: {err}", app.as_str()));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(format!(
                "部分应用 MCP 同步失败: {}",
                failures.join("; ")
            )))
        }
    }

    /// 只把启用状态投影到单个应用。某个应用的 live 被整体重写后用它做
    /// 定向重投影，避免把无关应用的失败面（如 ~/.claude.json 坏 JSON）
    /// 牵连进目标应用的关键路径。
    pub fn sync_enabled_for_app(state: &AppState, app: &AppType) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;
        Self::project_servers_to_app(state, &servers, app)
    }

    fn project_servers_to_app(
        state: &AppState,
        servers: &IndexMap<String, McpServer>,
        app: &AppType,
    ) -> Result<(), AppError> {
        if matches!(app, AppType::OpenClaw | AppType::ClaudeDesktop) {
            return Ok(());
        }

        if Self::is_proxy_takeover_live_owned(state, app) {
            crate::services::provider::ProviderService::sync_current_provider_for_app_with_options(
                state,
                app.clone(),
                crate::services::provider::SyncCurrentProviderOptions { sync_mcp: false },
            )?;

            if matches!(app, AppType::Claude) {
                Self::sync_all_for_app_from_db(state, app)?;
            }

            return Ok(());
        }

        for server in servers.values() {
            if server.apps.is_enabled_for(app) {
                Self::sync_server_to_app(state, server, app)?;
            } else {
                Self::remove_server_from_app(state, &server.id, app)?;
            }
        }

        Ok(())
    }

    // ========================================================================
    // 兼容层：支持旧的 v3.6.x 命令（已废弃，将在 v4.0 移除）
    // ========================================================================

    /// [已废弃] 获取指定应用的 MCP 服务器（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use get_all_servers instead")]
    pub fn get_servers(
        state: &AppState,
        app: AppType,
    ) -> Result<HashMap<String, serde_json::Value>, AppError> {
        let all_servers = Self::get_all_servers(state)?;
        let mut result = HashMap::new();

        for (id, server) in all_servers {
            if server.apps.is_enabled_for(&app) {
                result.insert(id, server.server);
            }
        }

        Ok(result)
    }

    /// [已废弃] 设置 MCP 服务器在指定应用的启用状态（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use toggle_app instead")]
    pub fn set_enabled(
        state: &AppState,
        app: AppType,
        id: &str,
        enabled: bool,
    ) -> Result<bool, AppError> {
        Self::toggle_app(state, id, app, enabled)?;
        Ok(true)
    }

    /// [已废弃] 同步启用的 MCP 到指定应用（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use sync_all_enabled instead")]
    pub fn sync_enabled(state: &AppState, app: AppType) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;

        for server in servers.values() {
            if server.apps.is_enabled_for(&app) {
                Self::sync_server_to_app(state, server, &app)?;
            }
        }

        Ok(())
    }

    /// 从 Claude 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_claude(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_claude(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Claude，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.claude = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Codex 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_codex(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_codex(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Codex，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.codex = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Gemini 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_gemini(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_gemini(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Gemini，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.gemini = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 OpenCode 导入 MCP（v3.9.2+ 新增）
    pub fn import_from_opencode(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp/opencode.rs）
        let count = crate::mcp::import_from_opencode(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 OpenCode，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.opencode = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Hermes 导入 MCP
    pub fn import_from_hermes(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用导入逻辑（从 mcp/hermes.rs）
        let count = crate::mcp::import_from_hermes(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Hermes，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.hermes = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从所有支持 MCP 的应用导入服务器，返回新导入的数量。
    ///
    /// Best-effort：单个应用导入失败（如坏 config.toml）不阻断其余应用；
    /// 全部跑完后若有失败，聚合成一个错误上报——历史实现逐应用
    /// `unwrap_or(0)` 吞错，坏文件只会表现为"导入成功 0 个"，用户
    /// 无从得知哪个应用出了问题。
    pub fn import_from_all_apps(state: &AppState) -> Result<usize, AppError> {
        let mut total = 0;
        let mut failures: Vec<String> = Vec::new();

        let results: [(&str, Result<usize, AppError>); 5] = [
            ("claude", Self::import_from_claude(state)),
            ("codex", Self::import_from_codex(state)),
            ("gemini", Self::import_from_gemini(state)),
            ("opencode", Self::import_from_opencode(state)),
            ("hermes", Self::import_from_hermes(state)),
        ];
        for (app, result) in results {
            match result {
                Ok(count) => total += count,
                Err(err) => {
                    log::warn!("从 {app} 导入 MCP 失败: {err}");
                    failures.push(format!("{app}: {err}"));
                }
            }
        }

        if failures.is_empty() {
            Ok(total)
        } else {
            Err(AppError::Message(format!(
                "已导入 {total} 个，部分应用导入失败: {}",
                failures.join("; ")
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::McpService;
    use crate::app_config::{AppType, McpApps, McpServer};
    use crate::codex_config::{get_codex_auth_path, get_codex_config_path};
    use crate::config::write_json_file;
    use crate::database::Database;
    use crate::provider::Provider;
    use crate::proxy::types::ProxyConfig;
    use crate::store::AppState;
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

    #[tokio::test]
    #[serial]
    async fn takeover_live_ownership_includes_pending_backup_or_placeholder() {
        let _home = TempHome::new();
        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());

        assert!(
            !McpService::is_proxy_takeover_live_owned(&state, &AppType::Codex),
            "ordinary direct mode must not be treated as takeover-owned"
        );

        db.save_live_backup(
            "codex",
            &serde_json::to_string(&json!({
                "auth": { "OPENAI_API_KEY": "direct-key" },
                "config": "model = \"gpt-5.5\"\n"
            }))
            .expect("serialize backup"),
        )
        .await
        .expect("save pending backup");
        assert!(
            McpService::is_proxy_takeover_live_owned(&state, &AppType::Codex),
            "a pending backup must retain takeover ownership even before enabled=true"
        );

        db.delete_live_backup("codex")
            .await
            .expect("delete pending backup");
        write_json_file(
            &get_codex_auth_path(),
            &json!({ "OPENAI_API_KEY": "PROXY_MANAGED" }),
        )
        .expect("write takeover auth placeholder");
        std::fs::write(
            get_codex_config_path(),
            r#"model_provider = "cc-switch"

[model_providers.cc-switch]
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
"#,
        )
        .expect("write takeover config placeholder");
        assert!(
            McpService::is_proxy_takeover_live_owned(&state, &AppType::Codex),
            "a takeover placeholder must retain ownership when DB flags lag behind"
        );
    }

    #[tokio::test]
    #[serial]
    async fn sync_all_enabled_rebuilds_codex_takeover_mcp_from_failover_queue_head() {
        let _home = TempHome::new();

        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());

        let provider = Provider::with_id(
            "codex-a".to_string(),
            "Codex A".to_string(),
            json!({
                "auth": {
                    "OPENAI_API_KEY": "codex-key"
                },
                "config": r#"model_provider = "codex-a"
model = "gpt-5.5"

[model_providers.codex-a]
base_url = "https://codex.example/v1"
wire_api = "responses"
"#
            }),
            None,
        );
        db.save_provider("codex", &provider)
            .expect("save codex provider");
        db.add_to_failover_queue("codex", &provider.id)
            .expect("add provider to failover queue");
        db.clear_current_provider("codex")
            .expect("clear db current provider");
        crate::settings::set_current_provider(&AppType::Codex, None)
            .expect("clear local current provider");

        db.save_mcp_server(&McpServer {
            id: "memory".to_string(),
            name: "Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: McpApps {
                codex: true,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save mcp server");

        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");

        McpService::sync_all_enabled(&state).expect("sync all enabled mcp");

        let config_path = get_codex_config_path();
        let config = std::fs::read_to_string(&config_path).expect("read codex config.toml");

        assert!(
            config.contains("[mcp_servers.memory]"),
            "Codex takeover config should keep MCP servers even when current provider is cleared in failover mode"
        );
        assert!(
            config.contains("http://127.0.0.1:") && config.contains("/v1"),
            "Codex takeover config should remain on the local proxy endpoint"
        );
    }

    #[tokio::test]
    #[serial]
    async fn sync_all_enabled_rebuilds_codex_takeover_mcp_without_restore_target() {
        let _home = TempHome::new();

        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());

        db.save_mcp_server(&McpServer {
            id: "memory".to_string(),
            name: "Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: McpApps {
                codex: true,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save mcp server");

        db.set_config_template(
            "codex",
            Some(
                serde_json::to_string(&json!([
                    {
                        "key": "auth",
                        "label": "auth.json",
                        "content": "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n"
                    },
                    {
                        "key": "config",
                        "label": "config.toml",
                        "content": "model_provider = \"cc-switch\"\nmodel = \"gpt-5.5\"\n\n[model_providers.cc-switch]\nbase_url = \"{proxyCodexBaseUrl}\"\nwire_api = \"responses\"\n\n{mcpConfig}\n"
                    }
                ]))
                .expect("serialize codex template"),
            ),
        )
        .expect("set codex template");

        let port = unused_local_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut app_config = db
            .get_proxy_config_for_app("codex")
            .await
            .expect("get codex proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        write_json_file(
            &get_codex_auth_path(),
            &json!({
                "OPENAI_API_KEY": "stale-direct-key"
            }),
        )
        .expect("seed stale codex auth");
        std::fs::write(
            get_codex_config_path(),
            r#"model_provider = "deleted-provider"
model = "gpt-5.4"

[model_providers.deleted-provider]
base_url = "https://deleted.example/v1"
wire_api = "responses"
"#,
        )
        .expect("seed stale codex config");

        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");

        McpService::sync_all_enabled(&state).expect("sync all enabled mcp");

        let auth: serde_json::Value =
            crate::config::read_json_file(&get_codex_auth_path()).expect("read codex auth");
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(serde_json::Value::as_str),
            Some("PROXY_MANAGED"),
            "Codex takeover auth should be rebuilt to the proxy placeholder even without a restore target"
        );

        let config = std::fs::read_to_string(get_codex_config_path()).expect("read codex config");
        assert!(
            config.contains("[mcp_servers.memory]"),
            "Codex takeover config should keep MCP servers even when failover has no restore target"
        );
        assert!(
            config.contains(&format!("http://127.0.0.1:{port}/v1")),
            "Codex takeover config should still point to the local proxy without a restore target"
        );
        assert!(
            !config.contains("https://deleted.example/v1"),
            "stale direct provider endpoint must not survive MCP sync in takeover mode"
        );
    }

    #[tokio::test]
    #[serial]
    async fn import_from_claude_recovers_live_mcp_while_takeover_recovery_is_pending() {
        let _home = TempHome::new();

        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());

        db.update_proxy_config(ProxyConfig {
            listen_port: 15721,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        db.save_live_backup(
            "claude",
            &serde_json::to_string(&json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://direct.example",
                    "ANTHROPIC_AUTH_TOKEN": "direct-token"
                }
            }))
            .expect("serialize backup"),
        )
        .await
        .expect("save live backup");

        std::fs::create_dir_all(crate::config::get_claude_config_dir())
            .expect("create claude config dir");
        crate::claude_mcp::set_mcp_servers_map(&std::collections::HashMap::from([(
            "memory".to_string(),
            json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
        )]))
        .expect("seed claude live mcp");

        let imported = McpService::import_from_claude(&state).expect("import from claude");
        assert_eq!(
            imported, 1,
            "MCP import should still recover Claude live MCP definitions while takeover recovery is pending"
        );
        assert!(
            !state
                .db
                .get_all_mcp_servers()
                .expect("load mcp servers")
                .is_empty(),
            "takeover recovery should still import Claude MCP definitions into the database so sidecars can be rebuilt"
        );
    }

    #[tokio::test]
    #[serial]
    async fn sync_all_enabled_rebuilds_claude_takeover_mcp_after_takeover_restore() {
        let _home = TempHome::new();

        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());
        let port = unused_local_port().await;

        db.save_mcp_server(&McpServer {
            id: "memory".to_string(),
            name: "Memory".to_string(),
            server: json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"]
            }),
            apps: McpApps {
                claude: true,
                ..Default::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
        })
        .expect("save claude mcp server");

        let provider = Provider::with_id(
            "claude-a".to_string(),
            "Claude A".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "real-token",
                    "ANTHROPIC_BASE_URL": "https://claude.example",
                    "ANTHROPIC_MODEL": "claude-sonnet-4-6"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");
        db.add_to_failover_queue("claude", &provider.id)
            .expect("queue claude provider");
        crate::settings::set_current_provider(&AppType::Claude, Some(&provider.id))
            .expect("set current claude provider");

        crate::config::write_json_file(
            &crate::config::get_claude_settings_path(),
            &provider.settings_config,
        )
        .expect("seed claude live config");

        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        std::fs::create_dir_all(crate::config::get_claude_config_dir())
            .expect("create claude config dir");
        crate::claude_mcp::set_mcp_servers_map(&std::collections::HashMap::new())
            .expect("seed empty claude mcp");

        state
            .proxy_service
            .set_takeover_for_app("claude", true)
            .await
            .expect("enable claude takeover");

        let text = std::fs::read_to_string(crate::config::get_claude_mcp_path())
            .expect("read rebuilt claude mcp");
        let value: serde_json::Value =
            serde_json::from_str(&text).expect("parse rebuilt claude mcp");
        let command = value
            .pointer("/mcpServers/memory/command")
            .and_then(serde_json::Value::as_str);
        let args = value
            .pointer("/mcpServers/memory/args")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let args_str = args
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        assert!(
            command.is_some(),
            "takeover restore should rebuild Claude MCP sidecar from DB-managed MCP servers"
        );
        assert!(
            command == Some("npx")
                || (command == Some("cmd")
                    && args_str.contains(&"/c")
                    && args_str.contains(&"npx")),
            "takeover restore should rebuild Claude MCP sidecar from DB-managed MCP servers (command={command:?}, args={args_str:?})"
        );
    }
}
