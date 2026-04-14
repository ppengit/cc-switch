// 配置相关 API
import { invoke } from "@tauri-apps/api/core";

export type AppType =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "openclaw"
  | "omo"
  | "omo_slim";

export interface LiveConfigFileEntry {
  label: string;
  path: string;
  exists: boolean;
  modifiedAt?: number | null;
  sizeBytes?: number | null;
}

export interface AppConfigPreviewFile {
  label: string;
  path: string;
  exists: boolean;
  expectedText: string;
  actualText: string;
  differs: boolean;
}

export interface AppConfigPreview {
  app: string;
  currentProviderId?: string | null;
  currentProviderName?: string | null;
  files: AppConfigPreviewFile[];
  note?: string | null;
}

export interface ConfigHealthIssue {
  severity: string;
  code: string;
  message: string;
}

export interface AppConfigHealthReport {
  app: string;
  ok: boolean;
  issues: ConfigHealthIssue[];
}

/**
 * 获取 Claude 通用配置片段（已废弃，使用 getCommonConfigSnippet）
 * @returns 通用配置片段（JSON 字符串），如果不存在则返回 null
 * @deprecated 使用 getCommonConfigSnippet('claude') 替代
 */
export async function getClaudeCommonConfigSnippet(): Promise<string | null> {
  return invoke<string | null>("get_claude_common_config_snippet");
}

/**
 * 设置 Claude 通用配置片段（已废弃，使用 setCommonConfigSnippet）
 * @param snippet - 通用配置片段（JSON 字符串）
 * @throws 如果 JSON 格式无效
 * @deprecated 使用 setCommonConfigSnippet('claude', snippet) 替代
 */
export async function setClaudeCommonConfigSnippet(
  snippet: string,
): Promise<void> {
  return invoke("set_claude_common_config_snippet", { snippet });
}

/**
 * 获取通用配置片段（统一接口）
 * @param appType - 应用类型（claude/codex/gemini）
 * @returns 通用配置片段（原始字符串），如果不存在则返回 null
 */
export async function getCommonConfigSnippet(
  appType: AppType,
): Promise<string | null> {
  return invoke<string | null>("get_common_config_snippet", { appType });
}

/**
 * 设置通用配置片段（统一接口）
 * @param appType - 应用类型（claude/codex/gemini）
 * @param snippet - 通用配置片段（原始字符串）
 * @throws 如果格式无效（Claude/Gemini 验证 JSON，Codex 暂不验证）
 */
export async function setCommonConfigSnippet(
  appType: AppType,
  snippet: string,
): Promise<void> {
  return invoke("set_common_config_snippet", { appType, snippet });
}

export async function getLiveConfigFiles(
  appType: Exclude<AppType, "omo" | "omo_slim">,
): Promise<LiveConfigFileEntry[]> {
  return invoke<LiveConfigFileEntry[]>("get_live_config_files", {
    app: appType,
  });
}

export async function openLiveConfigFile(path: string): Promise<void> {
  await invoke("open_live_config_file", { path });
}

export async function saveLiveConfigFile(
  appType: Exclude<AppType, "omo" | "omo_slim">,
  label: string,
  content: string,
): Promise<void> {
  await invoke("save_live_config_file", {
    app: appType,
    label,
    content,
  });
}

export async function getAppConfigPreview(
  appType: Exclude<AppType, "omo" | "omo_slim">,
): Promise<AppConfigPreview> {
  return invoke<AppConfigPreview>("get_app_config_preview", { app: appType });
}

export async function getCurrentLiveConfigSnapshot(
  appType: Exclude<AppType, "omo" | "omo_slim">,
): Promise<AppConfigPreview> {
  return invoke<AppConfigPreview>("get_current_live_config_snapshot", {
    app: appType,
  });
}

export async function getConfigHealthReport(): Promise<
  AppConfigHealthReport[]
> {
  return invoke<AppConfigHealthReport[]>("get_config_health_report");
}

export async function repairConfigHealth(
  appType?: Exclude<AppType, "omo" | "omo_slim">,
): Promise<AppConfigHealthReport[]> {
  return invoke<AppConfigHealthReport[]>("repair_config_health", {
    app: appType,
  });
}

export async function getProviderDefaultTemplate(
  appType: Exclude<AppType, "omo" | "omo_slim">,
): Promise<string | null> {
  return invoke<string | null>("get_provider_default_template", { appType });
}

export async function setProviderDefaultTemplate(
  appType: Exclude<AppType, "omo" | "omo_slim">,
  template: string,
): Promise<void> {
  return invoke("set_provider_default_template", { appType, template });
}

/**
 * 提取通用配置片段
 *
 * 默认读取当前激活供应商的配置；若传入 `options.settingsConfig`，则从编辑器当前内容提取。
 * 会自动排除差异化字段（API Key、模型配置、端点等），返回可复用的通用配置片段。
 *
 * @param appType - 应用类型（claude/codex/gemini）
 * @param options - 可选：提取来源
 * @returns 提取的通用配置片段（JSON/TOML 字符串）
 */
export type ExtractCommonConfigSnippetOptions = {
  settingsConfig?: string;
};

export async function extractCommonConfigSnippet(
  appType: Exclude<AppType, "omo">,
  options?: ExtractCommonConfigSnippetOptions,
): Promise<string> {
  const args: Record<string, unknown> = { appType };
  const settingsConfig = options?.settingsConfig;

  if (typeof settingsConfig === "string" && settingsConfig.trim()) {
    args.settingsConfig = settingsConfig;
  }

  return invoke<string>("extract_common_config_snippet", args);
}
