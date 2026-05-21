import type { AppId } from "@/lib/api/types";

export interface ApiHubSiteRow {
  id: string;
  site_name: string;
  site_url: string;
  site_type: string;
  exchange_rate: number;
  username?: string | null;
  imported_apps?: string[];
  last_synced_at?: number | null;
  last_checked_at?: number | null;
  last_change_at?: number | null;
  last_change_summary?: string | null;
  last_sync_error?: string | null;
  sort_index: number;
  group_count: number;
  aligned_group_count?: number;
  is_aligned?: boolean;
  model_count: number;
  token_count: number;
  model_matches?: ApiHubModelMatchInfo[];
}

export interface ApiHubModelMatchInfo {
  model_name: string;
  groups: string[];
}

export interface ApiHubModelCandidateFilter {
  site_ids?: string[];
  model_search?: string | null;
  site_type?: string | null;
}

export interface ApiHubModelCandidateRow {
  site_id: string;
  site_name: string;
  site_url: string;
  site_type: string;
  imported_apps: string[];
  group: string;
  model: string;
  ratio?: number | null;
  has_api_key: boolean;
  is_aligned: boolean;
}

export interface ApiHubGroupInfo {
  name: string;
  ratio?: number | null;
  description?: string | null;
}

export interface ApiHubModelInfo {
  name: string;
  enable_groups: string[];
}

export interface ApiHubTokenInfo {
  id: number;
  name: string;
  group_name?: string | null;
  key?: string | null;
  status?: number | null;
  remain_quota?: number | null;
  expired_at?: number | null;
}

export interface ApiHubSiteDetail {
  site: ApiHubSiteRow;
  groups: ApiHubGroupInfo[];
  models: ApiHubModelInfo[];
  tokens: ApiHubTokenInfo[];
}

export interface ApiHubSiteFilter {
  search?: string | null;
  site_type?: string | null;
  model_search?: string | null;
  change_filter?: string | null;
  sort_by?: string | null;
  sort_direction?: "asc" | "desc" | null;
  page?: number;
  page_size?: number;
}

export interface ApiHubPaged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface ApiHubAccountsBackup {
  version?: string | null;
  accounts: {
    accounts: Array<{
      id: string;
      site_name: string;
      site_url: string;
      site_type: string;
      exchange_rate?: number | null;
      account_info: {
        id?: number | null;
        access_token: string;
        username?: string | null;
      };
      notes?: string | null;
    }>;
  };
}

export interface ApiHubImportReport {
  new_count: number;
  update_count: number;
  skipped: string[];
}

export interface ApiHubSyncReport {
  site_id: string;
  site_name: string;
  groups_count: number;
  models_count: number;
  tokens_count: number;
  error?: string | null;
  changed: boolean;
  change_summary?: string | null;
  fallback_used: boolean;
}

export interface ApiHubAlignOptions {
  rename_existing: boolean;
  delete_extra: boolean;
}

export interface ApiHubModelSelection {
  group: string;
  model: string;
  app?: AppId;
}

export interface ApiHubImportToAppsReq {
  site_id: string;
  target_apps: AppId[];
  selections: ApiHubModelSelection[];
  auto_align_if_missing: boolean;
  mark_as_imported: boolean;
  settings_configs: Record<string, Record<string, unknown>>;
}

export interface ApiHubImportFailure {
  app: string;
  group: string;
  model: string;
  error: string;
}

export interface ApiHubImportToAppsReport {
  created: number;
  updated: number;
  failed: ApiHubImportFailure[];
  auto_aligned_groups: string[];
}

export interface ApiHubProgressPayload {
  site_id: string;
  site_name: string;
  index: number;
  total: number;
  step?: string | null;
  status: "pending" | "running" | "success" | "failed" | "warn";
  error?: string | null;
}

export interface ApiHubCleanupSiteProvidersReport {
  deleted: number;
  failed: string[];
}
