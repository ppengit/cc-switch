import { http, HttpResponse } from "msw";
import type { AppId } from "@/lib/api/types";
import type { McpServer, Provider, SessionMeta, Settings } from "@/types";
import type { AppProxyConfig, GlobalProxyConfig } from "@/types/proxy";
import {
  addSkillRepoState,
  addProvider,
  addProviderToLiveConfig,
  deleteProvider,
  deleteMcpServerState,
  deleteSession,
  deleteSkillBackupState,
  getAppConfigTemplate,
  getAppProxyConfigState,
  getAutoFailoverEnabled,
  getAvailableProvidersForFailoverState,
  getDiscoverableSkillsState,
  getFailoverQueueState,
  getGlobalProxyConfigState,
  getInstalledSkillsState,
  getManagedAuthStatus,
  getProviderDefaultTemplate,
  getCurrentProviderId,
  getLiveProviderIds,
  getMcpServersState,
  getProxyTakeoverStatusState,
  getProxyStatusState,
  getSkillBackupsState,
  getSkillReposState,
  getSkillUpdatesState,
  getSkillsShResultsState,
  getUnmanagedSkillsState,
  getAppConfigDirOverride,
  getMcpConfig,
  getSessionMessages,
  getSettings,
  getProviders,
  getSwitchLiveSettings,
  importMcpFromAppsState,
  importSkillsFromAppsState,
  installSkillFromDiscoveryState,
  installSkillsFromZipState,
  isLiveTakeoverActiveState,
  isProxyRunningState,
  listProviders,
  listSessions,
  getWebdavRemoteInfoState,
  recordSettingsSave,
  recordDeleteSessionsRequest,
  recordSessionMarkdownExport,
  recordSessionTerminalLaunch,
  resetProviderState,
  recordWebdavDownload,
  recordWebdavSaveSettings,
  recordWebdavTestConnection,
  recordWebdavUpload,
  removeSkillRepoState,
  removeFromFailoverQueueState,
  removeProviderFromLiveConfigState,
  restoreSkillBackupState,
  setAppConfigTemplateState,
  setAppProxyConfigState,
  setAutoFailoverEnabledState,
  setCurrentProviderId,
  setGlobalProxyConfigState,
  setAppConfigDirOverrideState,
  deleteMcpServer,
  setMcpServerEnabled,
  setProviderDefaultTemplateState,
  setProxyTakeoverForAppState,
  setSessionTitleMappingState,
  setSettings,
  startProxyServerState,
  stopProxyServerState,
  syncCurrentProvidersLiveState,
  toggleMcpAppState,
  toggleSkillAppState,
  uninstallSkillState,
  updateSkillState,
  upsertMcpServer,
  upsertMcpServerState,
  clearSessionTitleMappingState,
  updateProvider,
  updateSortOrder,
  addToFailoverQueueState,
} from "./state";

const TAURI_ENDPOINT = "http://tauri.local";

const withJson = async <T>(request: Request): Promise<T> => {
  try {
    const body = await request.text();
    if (!body) return {} as T;
    return JSON.parse(body) as T;
  } catch {
    return {} as T;
  }
};

const success = <T>(payload: T) => HttpResponse.json(payload as any);

export const handlers = [
  http.post(`${TAURI_ENDPOINT}/get_migration_result`, () => success(false)),
  http.post(`${TAURI_ENDPOINT}/get_skills_migration_result`, () =>
    success(null),
  ),
  http.post(`${TAURI_ENDPOINT}/get_providers`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(getProviders(app));
  }),

  http.post(`${TAURI_ENDPOINT}/get_current_provider`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(getCurrentProviderId(app));
  }),

  http.post(
    `${TAURI_ENDPOINT}/update_providers_sort_order`,
    async ({ request }) => {
      const { updates = [], app } = await withJson<{
        updates: { id: string; sortIndex: number }[];
        app: AppId;
      }>(request);
      updateSortOrder(app, updates);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/update_tray_menu`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/get_opencode_live_provider_ids`, () =>
    success(getLiveProviderIds("opencode")),
  ),

  http.post(`${TAURI_ENDPOINT}/get_openclaw_live_provider_ids`, () =>
    success(getLiveProviderIds("openclaw")),
  ),

  http.post(`${TAURI_ENDPOINT}/get_hermes_live_provider_ids`, () =>
    success(getLiveProviderIds("hermes")),
  ),

  http.post(`${TAURI_ENDPOINT}/get_openclaw_default_model`, () =>
    success({ primary: null, fallback: [] }),
  ),

  http.post(`${TAURI_ENDPOINT}/scan_openclaw_config_health`, () => success([])),

  http.post(`${TAURI_ENDPOINT}/get_openclaw_model_catalog`, () =>
    success({}),
  ),

  http.post(`${TAURI_ENDPOINT}/set_openclaw_model_catalog`, () =>
    success({ warnings: [] }),
  ),

  http.post(`${TAURI_ENDPOINT}/set_openclaw_default_model`, () =>
    success({ warnings: [] }),
  ),

  http.post(`${TAURI_ENDPOINT}/get_hermes_model_config`, () =>
    success({ provider: null }),
  ),

  http.post(`${TAURI_ENDPOINT}/switch_provider`, async ({ request }) => {
    const { id, app } = await withJson<{ id: string; app: AppId }>(request);
    const providers = listProviders(app);
    if (!providers[id]) {
      return HttpResponse.json(false, { status: 404 });
    }
    if (app === "opencode" || app === "openclaw" || app === "hermes") {
      addProviderToLiveConfig(app, id);
    } else {
      setCurrentProviderId(app, id);
    }
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/add_provider`, async ({ request }) => {
    const { provider, app, addToLive } = await withJson<{
      provider: Provider & { id?: string };
      app: AppId;
      addToLive?: boolean;
    }>(request);

    const newId = provider.id ?? `mock-${Date.now()}`;
    addProvider(app, { ...provider, id: newId });
    if (
      addToLive !== false &&
      (app === "opencode" || app === "openclaw" || app === "hermes")
    ) {
      addProviderToLiveConfig(app, newId);
    }
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/update_provider`, async ({ request }) => {
    const { provider, app, originalId } = await withJson<{
      provider: Provider;
      app: AppId;
      originalId?: string;
    }>(request);
    updateProvider(app, provider, originalId);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/delete_provider`, async ({ request }) => {
    const { id, app } = await withJson<{ id: string; app: AppId }>(request);
    deleteProvider(app, id);
    return success(true);
  }),

  http.post(
    `${TAURI_ENDPOINT}/remove_provider_from_live_config`,
    async ({ request }) => {
      const { id, app } = await withJson<{ id: string; app: AppId }>(request);
      removeProviderFromLiveConfigState(app, id);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/open_provider_terminal`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/import_default_config`, async () => {
    resetProviderState();
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/import_claude_desktop_providers_from_claude`, () =>
    success(0),
  ),
  http.post(`${TAURI_ENDPOINT}/import_opencode_providers_from_live`, () =>
    success(0),
  ),
  http.post(`${TAURI_ENDPOINT}/import_openclaw_providers_from_live`, () =>
    success(0),
  ),
  http.post(`${TAURI_ENDPOINT}/import_hermes_providers_from_live`, () =>
    success(0),
  ),

  http.post(`${TAURI_ENDPOINT}/get_current_omo_provider_id`, () => success("")),
  http.post(`${TAURI_ENDPOINT}/get_current_omo_slim_provider_id`, () =>
    success(""),
  ),
  http.post(`${TAURI_ENDPOINT}/disable_current_omo`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/disable_current_omo_slim`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/open_external`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/list_sessions`, () => success(listSessions())),

  http.post(`${TAURI_ENDPOINT}/list_recent_sessions`, async ({ request }) => {
    const { appType, limit = 10 } = await withJson<{
      appType?: string;
      limit?: number;
    }>(request);
    const normalizedApp = appType === "claude-desktop" ? "claude" : appType;
    const sessions = listSessions()
      .filter((session) =>
        normalizedApp ? session.providerId === normalizedApp : true,
      )
      .slice(0, limit);
    return success(sessions);
  }),

  http.post(`${TAURI_ENDPOINT}/get_session_messages`, async ({ request }) => {
    const { providerId, sourcePath } = await withJson<{
      providerId: string;
      sourcePath: string;
    }>(request);
    return success(getSessionMessages(providerId, sourcePath));
  }),

  http.post(`${TAURI_ENDPOINT}/delete_session`, async ({ request }) => {
    const { providerId, sessionId, sourcePath } = await withJson<{
      providerId: string;
      sessionId: string;
      sourcePath: string;
    }>(request);
    return success(deleteSession(providerId, sessionId, sourcePath));
  }),

  http.post(`${TAURI_ENDPOINT}/delete_sessions`, async ({ request }) => {
    const { items = [] } = await withJson<{
      items?: {
        providerId: string;
        sessionId: string;
        sourcePath: string;
      }[];
    }>(request);

    recordDeleteSessionsRequest(items);

    return success(
      items.map((item) => ({
        providerId: item.providerId,
        sessionId: item.sessionId,
        sourcePath: item.sourcePath,
        success: deleteSession(
          item.providerId,
          item.sessionId,
          item.sourcePath,
        ),
      })),
    );
  }),

  http.post(`${TAURI_ENDPOINT}/set_session_title_mapping`, async ({ request }) => {
    const { appType, sessionId, sourcePath, customTitle } = await withJson<{
      appType: string;
      sessionId: string;
      sourcePath?: string | null;
      customTitle: string;
    }>(request);
    return success(
      setSessionTitleMappingState({
        appType,
        sessionId,
        sourcePath,
        customTitle,
      }),
    );
  }),

  http.post(`${TAURI_ENDPOINT}/clear_session_title_mapping`, async ({ request }) => {
    const { appType, sessionId, sourcePath } = await withJson<{
      appType: string;
      sessionId: string;
      sourcePath?: string | null;
    }>(request);
    return success(
      clearSessionTitleMappingState({
        appType,
        sessionId,
        sourcePath,
      }),
    );
  }),

  http.post(`${TAURI_ENDPOINT}/launch_session_terminal`, async ({ request }) => {
    const { command, cwd, customConfig } = await withJson<{
      command: string;
      cwd?: string | null;
      customConfig?: string | null;
    }>(request);
    return success(
      recordSessionTerminalLaunch({
        command,
        cwd,
        customConfig,
      }),
    );
  }),

  http.post(`${TAURI_ENDPOINT}/export_session_markdown`, async ({ request }) => {
    const { session } = await withJson<{ session: SessionMeta }>(request);
    return success(recordSessionMarkdownExport(session));
  }),

  // MCP APIs
  http.post(`${TAURI_ENDPOINT}/get_mcp_config`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(getMcpConfig(app));
  }),

  http.post(`${TAURI_ENDPOINT}/get_mcp_servers`, () =>
    success(getMcpServersState()),
  ),

  http.post(`${TAURI_ENDPOINT}/toggle_mcp_app`, async ({ request }) => {
    const { serverId, app, enabled } = await withJson<{
      serverId: string;
      app: AppId;
      enabled: boolean;
    }>(request);
    toggleMcpAppState(serverId, app, enabled);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/upsert_mcp_server`, async ({ request }) => {
    const { server } = await withJson<{ server: McpServer }>(request);
    upsertMcpServerState(server);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/delete_mcp_server`, async ({ request }) => {
    const { id } = await withJson<{ id: string }>(request);
    deleteMcpServerState(id);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/import_mcp_from_apps`, () =>
    success(importMcpFromAppsState()),
  ),

  http.post(`${TAURI_ENDPOINT}/import_mcp_from_claude`, () => success(1)),
  http.post(`${TAURI_ENDPOINT}/import_mcp_from_codex`, () => success(1)),

  http.post(`${TAURI_ENDPOINT}/set_mcp_enabled`, async ({ request }) => {
    const { app, id, enabled } = await withJson<{
      app: AppId;
      id: string;
      enabled: boolean;
    }>(request);
    setMcpServerEnabled(app, id, enabled);
    return success(true);
  }),

  http.post(
    `${TAURI_ENDPOINT}/upsert_mcp_server_in_config`,
    async ({ request }) => {
      const { app, id, spec } = await withJson<{
        app: AppId;
        id: string;
        spec: McpServer;
      }>(request);
      upsertMcpServer(app, id, spec);
      return success(true);
    },
  ),

  http.post(
    `${TAURI_ENDPOINT}/delete_mcp_server_in_config`,
    async ({ request }) => {
      const { app, id } = await withJson<{ app: AppId; id: string }>(request);
      deleteMcpServer(app, id);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/restart_app`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/get_settings`, () => success(getSettings())),

  http.post(`${TAURI_ENDPOINT}/webdav_sync_save_settings`, async ({ request }) => {
    const { settings, passwordTouched = false } = await withJson<{
      settings: Parameters<typeof recordWebdavSaveSettings>[0];
      passwordTouched?: boolean;
    }>(request);
    recordWebdavSaveSettings(settings, passwordTouched);
    return success({ success: true });
  }),

  http.post(`${TAURI_ENDPOINT}/webdav_test_connection`, async ({ request }) => {
    const { settings, preserveEmptyPassword = true } = await withJson<{
      settings: Parameters<typeof recordWebdavTestConnection>[0];
      preserveEmptyPassword?: boolean;
    }>(request);
    recordWebdavTestConnection(settings, preserveEmptyPassword);
    return success({ success: true, message: "ok" });
  }),

  http.post(`${TAURI_ENDPOINT}/webdav_sync_fetch_remote_info`, () =>
    success(getWebdavRemoteInfoState()),
  ),

  http.post(`${TAURI_ENDPOINT}/webdav_sync_upload`, () => {
    recordWebdavUpload();
    return success({ status: "uploaded" });
  }),

  http.post(`${TAURI_ENDPOINT}/webdav_sync_download`, () => {
    recordWebdavDownload();
    return success({ status: "downloaded" });
  }),

  http.post(`${TAURI_ENDPOINT}/get_installed_skills`, () =>
    success(getInstalledSkillsState()),
  ),

  http.post(`${TAURI_ENDPOINT}/get_skill_backups`, () =>
    success(getSkillBackupsState()),
  ),

  http.post(`${TAURI_ENDPOINT}/delete_skill_backup`, async ({ request }) => {
    const { backupId } = await withJson<{ backupId: string }>(request);
    return success(deleteSkillBackupState(backupId));
  }),

  http.post(`${TAURI_ENDPOINT}/restore_skill_backup`, async ({ request }) => {
    const { backupId, currentApp } = await withJson<{
      backupId: string;
      currentApp: AppId;
    }>(request);
    const restored = restoreSkillBackupState(backupId, currentApp);
    if (!restored) {
      return HttpResponse.json(false, { status: 404 });
    }
    return success(restored);
  }),

  http.post(`${TAURI_ENDPOINT}/toggle_skill_app`, async ({ request }) => {
    const { id, app, enabled } = await withJson<{
      id: string;
      app: AppId;
      enabled: boolean;
    }>(request);
    toggleSkillAppState(id, app, enabled);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/scan_unmanaged_skills`, () =>
    success(getUnmanagedSkillsState()),
  ),

  http.post(`${TAURI_ENDPOINT}/import_skills_from_apps`, async ({ request }) => {
    const { imports = [] } = await withJson<{
      imports?: Parameters<typeof importSkillsFromAppsState>[0];
    }>(request);
    return success(importSkillsFromAppsState(imports));
  }),

  http.post(`${TAURI_ENDPOINT}/discover_available_skills`, () =>
    success(getDiscoverableSkillsState()),
  ),

  http.post(`${TAURI_ENDPOINT}/check_skill_updates`, () =>
    success(getSkillUpdatesState()),
  ),

  http.post(`${TAURI_ENDPOINT}/update_skill`, async ({ request }) => {
    const { id } = await withJson<{ id: string }>(request);
    return success(updateSkillState(id));
  }),

  http.post(`${TAURI_ENDPOINT}/install_skill_unified`, async ({ request }) => {
    const { skill, currentApp } = await withJson<{
      skill: Parameters<typeof installSkillFromDiscoveryState>[0];
      currentApp: AppId;
    }>(request);
    return success(installSkillFromDiscoveryState(skill, currentApp));
  }),

  http.post(`${TAURI_ENDPOINT}/uninstall_skill_unified`, async ({ request }) => {
    const { id } = await withJson<{ id: string }>(request);
    return success(uninstallSkillState(id));
  }),

  http.post(`${TAURI_ENDPOINT}/get_skill_repos`, () =>
    success(getSkillReposState()),
  ),

  http.post(`${TAURI_ENDPOINT}/add_skill_repo`, async ({ request }) => {
    const { repo } = await withJson<{
      repo: Parameters<typeof addSkillRepoState>[0];
    }>(request);
    addSkillRepoState(repo);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/remove_skill_repo`, async ({ request }) => {
    const { owner, name } = await withJson<{ owner: string; name: string }>(
      request,
    );
    removeSkillRepoState(owner, name);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/open_zip_file_dialog`, () =>
    success("/mock/skills.zip"),
  ),

  http.post(`${TAURI_ENDPOINT}/install_skills_from_zip`, async ({ request }) => {
    const { filePath, currentApp } = await withJson<{
      filePath: string;
      currentApp: AppId;
    }>(request);
    return success(installSkillsFromZipState(filePath, currentApp));
  }),

  http.post(`${TAURI_ENDPOINT}/search_skills_sh`, async ({ request }) => {
    const { query = "", limit = 20, offset = 0 } = await withJson<{
      query?: string;
      limit?: number;
      offset?: number;
    }>(request);
    const filtered = getSkillsShResultsState().filter((skill) =>
      skill.name.toLowerCase().includes(query.toLowerCase()),
    );
    return success({
      skills: filtered.slice(offset, offset + limit),
      totalCount: filtered.length,
      query,
    });
  }),

  http.post(`${TAURI_ENDPOINT}/check_env_conflicts`, () => success([])),

  http.post(`${TAURI_ENDPOINT}/save_settings`, async ({ request }) => {
    const { settings } = await withJson<{ settings: Settings }>(request);
    recordSettingsSave(settings);
    return success(true);
  }),

  http.post(
    `${TAURI_ENDPOINT}/set_app_config_dir_override`,
    async ({ request }) => {
      const { path } = await withJson<{ path: string | null }>(request);
      setAppConfigDirOverrideState(path ?? null);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/get_app_config_dir_override`, () =>
    success(getAppConfigDirOverride()),
  ),

  http.post(
    `${TAURI_ENDPOINT}/apply_claude_plugin_config`,
    async ({ request }) => {
      const { official } = await withJson<{ official: boolean }>(request);
      setSettings({ enableClaudePluginIntegration: !official });
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/apply_claude_onboarding_skip`, () =>
    success(true),
  ),

  http.post(`${TAURI_ENDPOINT}/clear_claude_onboarding_skip`, () =>
    success(true),
  ),

  http.post(`${TAURI_ENDPOINT}/get_config_dir`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(app === "claude" ? "/default/claude" : "/default/codex");
  }),

  http.post(`${TAURI_ENDPOINT}/get_claude_desktop_status`, () =>
    success({
      supported: false,
      configured: false,
      appliedId: null,
      profilePath: null,
      configLibraryPath: null,
      mode: null,
      expectedBaseUrl: null,
      actualBaseUrl: null,
      proxyRunning: false,
      staleRawModels: false,
      missingRouteMappings: false,
      gatewayTokenConfigured: false,
    }),
  ),

  http.post(`${TAURI_ENDPOINT}/get_claude_desktop_default_routes`, () =>
    success([]),
  ),

  http.post(`${TAURI_ENDPOINT}/is_portable_mode`, () => success(false)),

  http.post(
    `${TAURI_ENDPOINT}/select_config_directory`,
    async ({ request }) => {
      const { defaultPath, default_path } = await withJson<{
        defaultPath?: string;
        default_path?: string;
      }>(request);
      const initial = defaultPath ?? default_path;
      return success(initial ? `${initial}/picked` : "/mock/selected-dir");
    },
  ),

  http.post(`${TAURI_ENDPOINT}/pick_directory`, async ({ request }) => {
    const { defaultPath, default_path } = await withJson<{
      defaultPath?: string;
      default_path?: string;
    }>(request);
    const initial = defaultPath ?? default_path;
    return success(initial ? `${initial}/picked` : "/mock/selected-dir");
  }),

  http.post(`${TAURI_ENDPOINT}/open_file_dialog`, () =>
    success("/mock/import-settings.json"),
  ),

  http.post(
    `${TAURI_ENDPOINT}/import_config_from_file`,
    async ({ request }) => {
      const { filePath } = await withJson<{ filePath: string }>(request);
      if (!filePath) {
        return success({ success: false, message: "Missing file" });
      }
      setSettings({ language: "en" });
      return success({ success: true, backupId: "backup-123" });
    },
  ),

  http.post(`${TAURI_ENDPOINT}/export_config_to_file`, async ({ request }) => {
    const { filePath } = await withJson<{ filePath: string }>(request);
    if (!filePath) {
      return success({ success: false, message: "Invalid destination" });
    }
    return success({ success: true, filePath });
  }),

  http.post(`${TAURI_ENDPOINT}/save_file_dialog`, () =>
    success("/mock/export-settings.json"),
  ),

  http.post(`${TAURI_ENDPOINT}/sync_current_providers_live`, () =>
    success(syncCurrentProvidersLiveState()),
  ),

  http.post(`${TAURI_ENDPOINT}/read_live_provider_settings`, async ({ request }) => {
    const { app } = await withJson<{ app: "claude" | "codex" | "gemini" }>(
      request,
    );
    return success(getSwitchLiveSettings(app));
  }),

  http.post(`${TAURI_ENDPOINT}/get_app_config_template`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(getAppConfigTemplate(app));
  }),

  http.post(`${TAURI_ENDPOINT}/list_app_config_files`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success([
      {
        key: "settings",
        label: `${app}.mock.json`,
        path: `/mock/${app}.mock.json`,
      },
    ]);
  }),

  http.post(`${TAURI_ENDPOINT}/read_app_config_file`, async ({ request }) => {
    const { app, fileKey } = await withJson<{
      app: AppId;
      fileKey: string;
    }>(request);
    return success({
      key: fileKey,
      label: `${app}.${fileKey}.json`,
      path: `/mock/${app}.${fileKey}.json`,
      content: "{}",
    });
  }),

  http.post(`${TAURI_ENDPOINT}/write_app_config_file`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/write_app_config_files`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/import_mcp_from_app_live`, () => success(0)),

  http.post(`${TAURI_ENDPOINT}/set_app_config_template`, async ({ request }) => {
    const { app, files = [] } = await withJson<{
      app: AppId;
      files?: { key: string; label: string; content: string }[];
    }>(request);
    setAppConfigTemplateState(app, files);
    return success(true);
  }),

  http.post(
    `${TAURI_ENDPOINT}/get_provider_default_template`,
    async ({ request }) => {
      const { app } = await withJson<{ app: AppId }>(request);
      return success(getProviderDefaultTemplate(app));
    },
  ),

  http.post(
    `${TAURI_ENDPOINT}/set_provider_default_template`,
    async ({ request }) => {
      const { app, template } = await withJson<{
        app: AppId;
        template: string | null;
      }>(request);
      setProviderDefaultTemplateState(app, template ?? null);
      return success(true);
    },
  ),

  // Proxy status (for SettingsPage / ProxyPanel hooks)
  http.post(`${TAURI_ENDPOINT}/start_proxy_server`, () =>
    success(startProxyServerState()),
  ),

  http.post(`${TAURI_ENDPOINT}/stop_proxy_server`, () => {
    stopProxyServerState(false);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/stop_proxy_with_restore`, () => {
    stopProxyServerState(true);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/get_proxy_status`, () =>
    success(getProxyStatusState()),
  ),

  http.post(`${TAURI_ENDPOINT}/get_proxy_takeover_status`, () =>
    success(getProxyTakeoverStatusState()),
  ),

  http.post(
    `${TAURI_ENDPOINT}/set_proxy_takeover_for_app`,
    async ({ request }) => {
      const { appType, enabled } = await withJson<{
        appType: AppId;
        enabled: boolean;
      }>(request);
      setProxyTakeoverForAppState(appType, enabled);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/is_proxy_running`, () =>
    success(isProxyRunningState()),
  ),

  http.post(`${TAURI_ENDPOINT}/get_proxy_raw_logs`, () => success([])),

  http.post(`${TAURI_ENDPOINT}/is_live_takeover_active`, () =>
    success(isLiveTakeoverActiveState()),
  ),

  http.post(`${TAURI_ENDPOINT}/get_global_proxy_config`, () =>
    success(getGlobalProxyConfigState()),
  ),

  http.post(`${TAURI_ENDPOINT}/update_global_proxy_config`, async ({ request }) => {
    const { config } = await withJson<{ config: GlobalProxyConfig }>(request);
    setGlobalProxyConfigState(config);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/get_proxy_config_for_app`, async ({ request }) => {
    const { appType } = await withJson<{ appType: AppId }>(request);
    return success(getAppProxyConfigState(appType));
  }),

  http.post(
    `${TAURI_ENDPOINT}/update_proxy_config_for_app`,
    async ({ request }) => {
      const { config } = await withJson<{ config: AppProxyConfig }>(request);
      setAppProxyConfigState(config);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/switch_proxy_provider`, async ({ request }) => {
    const { appType, providerId } = await withJson<{
      appType: AppId;
      providerId: string;
    }>(request);
    const providers = listProviders(appType);
    if (!providers[providerId]) {
      return HttpResponse.json(false, { status: 404 });
    }
    setCurrentProviderId(appType, providerId);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/stream_check_provider`, async ({ request }) => {
    const { providerId } = await withJson<{ providerId?: string }>(request);
    return success({
      status: "operational",
      success: true,
      message: "ok",
      responseTimeMs: 1,
      modelUsed: providerId ?? "mock",
      testedAt: Date.now(),
      retryCount: 0,
    });
  }),

  http.post(`${TAURI_ENDPOINT}/stream_check_all_providers`, () => success([])),

  http.post(`${TAURI_ENDPOINT}/get_stream_check_config`, () =>
    success({
      timeoutSecs: 30,
      maxRetries: 0,
      degradedThresholdMs: 2000,
      claudeModel: "claude-3-5-sonnet-latest",
      codexModel: "gpt-5",
      geminiModel: "gemini-2.5-pro",
      testPrompt: "ping",
    }),
  ),

  http.post(`${TAURI_ENDPOINT}/save_stream_check_config`, () => success(true)),

  // Failover / circuit breaker defaults
  http.post(`${TAURI_ENDPOINT}/get_failover_queue`, async ({ request }) => {
    const { appType } = await withJson<{ appType: AppId }>(request);
    return success(getFailoverQueueState(appType));
  }),
  http.post(
    `${TAURI_ENDPOINT}/get_available_providers_for_failover`,
    async ({ request }) => {
      const { appType } = await withJson<{ appType: AppId }>(request);
      return success(getAvailableProvidersForFailoverState(appType));
    },
  ),
  http.post(`${TAURI_ENDPOINT}/add_to_failover_queue`, async ({ request }) => {
    const { appType, providerId } = await withJson<{
      appType: AppId;
      providerId: string;
    }>(request);
    if (!addToFailoverQueueState(appType, providerId)) {
      return HttpResponse.json(false, { status: 404 });
    }
    return success(true);
  }),
  http.post(`${TAURI_ENDPOINT}/remove_from_failover_queue`, async ({ request }) => {
    const { appType, providerId } = await withJson<{
      appType: AppId;
      providerId: string;
    }>(request);
    removeFromFailoverQueueState(appType, providerId);
    return success(true);
  }),
  http.post(`${TAURI_ENDPOINT}/reorder_failover_queue`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/set_failover_item_enabled`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/get_auto_failover_enabled`, async ({ request }) => {
    const { appType } = await withJson<{ appType: AppId }>(request);
    return success(getAutoFailoverEnabled(appType));
  }),
  http.post(`${TAURI_ENDPOINT}/set_auto_failover_enabled`, async ({ request }) => {
    const { appType, enabled } = await withJson<{
      appType: AppId;
      enabled: boolean;
    }>(request);
    setAutoFailoverEnabledState(appType, enabled);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/get_circuit_breaker_config`, () =>
    success({
      failureThreshold: 3,
      successThreshold: 2,
      timeoutSeconds: 60,
      errorRateThreshold: 50,
      minRequests: 5,
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/update_circuit_breaker_config`, () =>
    success(true),
  ),
  http.post(`${TAURI_ENDPOINT}/get_provider_health`, () =>
    success({
      provider_id: "mock-provider",
      app_type: "claude",
      is_healthy: true,
      consecutive_failures: 0,
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/reset_circuit_breaker`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/get_circuit_breaker_stats`, () => success(null)),
  http.post(`${TAURI_ENDPOINT}/get_usage_summary`, () =>
    success({
      totalRequests: 0,
      totalCost: "0",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      successRate: 0,
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/get_usage_trends`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_provider_stats`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_model_stats`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_request_logs`, async ({ request }) => {
    const { page = 0, pageSize = 20 } = await withJson<{
      page?: number;
      pageSize?: number;
    }>(request);
    return success({
      data: [],
      total: 0,
      page,
      pageSize,
    });
  }),
  http.post(`${TAURI_ENDPOINT}/get_request_detail`, () => success(null)),
  http.post(`${TAURI_ENDPOINT}/get_model_pricing`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/update_model_pricing`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/delete_model_pricing`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/check_provider_limits`, async ({ request }) => {
    const { providerId } = await withJson<{ providerId: string }>(request);
    return success({
      providerId,
      dailyUsage: "0",
      dailyExceeded: false,
      monthlyUsage: "0",
      monthlyExceeded: false,
    });
  }),
  http.post(`${TAURI_ENDPOINT}/auth_get_status`, async ({ request }) => {
    const { authProvider } = await withJson<{
      authProvider: "github_copilot" | "codex_oauth";
    }>(request);
    return success(getManagedAuthStatus(authProvider));
  }),
];
