import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ApiHubAccountsBackup,
  ApiHubAlignOptions,
  ApiHubCleanupSiteProvidersReport,
  ApiHubImportReport,
  ApiHubImportToAppsReport,
  ApiHubImportToAppsReq,
  ApiHubPaged,
  ApiHubProgressPayload,
  ApiHubSiteDetail,
  ApiHubSiteFilter,
  ApiHubSiteRow,
  ApiHubSyncReport,
} from "@/types/apiHub";

export const apiHubApi = {
  async importJson(payload: ApiHubAccountsBackup): Promise<ApiHubImportReport> {
    return await invoke("api_hub_import_json", { payload });
  },

  async listSites(
    filter: ApiHubSiteFilter,
  ): Promise<ApiHubPaged<ApiHubSiteRow>> {
    return await invoke("api_hub_list_sites", { filter });
  },

  async getSiteDetail(siteId: string): Promise<ApiHubSiteDetail> {
    return await invoke("api_hub_get_site_detail", { siteId });
  },

  async clearAll(): Promise<void> {
    await invoke("api_hub_clear_all");
  },

  async deleteSite(siteId: string): Promise<void> {
    await invoke("api_hub_delete_site", { siteId });
  },

  async cleanupSiteProviders(
    siteId: string,
  ): Promise<ApiHubCleanupSiteProvidersReport> {
    return await invoke("api_hub_cleanup_site_providers", { siteId });
  },

  async syncSite(siteId: string): Promise<ApiHubSyncReport> {
    return await invoke("api_hub_sync_site", { siteId });
  },

  async syncSites(siteIds: string[]): Promise<void> {
    await invoke("api_hub_sync_sites", { siteIds });
  },

  async alignSites(
    siteIds: string[],
    options: ApiHubAlignOptions = {
      rename_existing: true,
      delete_extra: true,
    },
  ): Promise<void> {
    await invoke("api_hub_align_sites", { siteIds, options });
  },

  async importToApps(
    req: ApiHubImportToAppsReq,
  ): Promise<ApiHubImportToAppsReport> {
    return await invoke("api_hub_import_to_apps", { req });
  },

  async onSyncProgress(
    handler: (payload: ApiHubProgressPayload) => void,
  ): Promise<UnlistenFn> {
    return await listen("api_hub_sync_progress", (event) => {
      handler(event.payload as ApiHubProgressPayload);
    });
  },

  async onAlignProgress(
    handler: (payload: ApiHubProgressPayload) => void,
  ): Promise<UnlistenFn> {
    return await listen("api_hub_align_progress", (event) => {
      handler(event.payload as ApiHubProgressPayload);
    });
  },
};
