// 配置相关 API
import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

export type AppType =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "omo"
  | "omo-slim";

export interface AppConfigFileEntry {
  key: string;
  label: string;
  path: string;
}

export interface AppConfigFileContent {
  key: string;
  label: string;
  path: string;
  content: string;
}

export interface AppConfigTemplateFile {
  key: string;
  label: string;
  content: string;
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

/**
 * 对编辑器里的 config.toml 文本做通用配置片段的合并/剥离
 *
 * 合并/剥离在后端用 toml_edit 完成（保注释、保键序）；前端 smol-toml
 * 的整文档重序列化会破坏用户手写格式，禁止在前端做这类结构化改写。
 *
 * @param configToml - 编辑器当前的 config.toml 文本
 * @param snippetToml - 通用配置片段（TOML 字符串）
 * @param enabled - true 合并片段，false 按值匹配剥离片段
 * @returns 更新后的 config.toml 文本
 */
export async function updateTomlCommonConfigSnippet(
  configToml: string,
  snippetToml: string,
  enabled: boolean,
): Promise<string> {
  return invoke<string>("update_toml_common_config_snippet", {
    configToml,
    snippetToml,
    enabled,
  });
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

export async function listAppConfigFiles(
  appId: AppId,
): Promise<AppConfigFileEntry[]> {
  return invoke<AppConfigFileEntry[]>("list_app_config_files", {
    app: appId,
  });
}

export async function readAppConfigFile(options: {
  appId: AppId;
  fileKey: string;
}): Promise<AppConfigFileContent> {
  const { appId, fileKey } = options;
  return invoke<AppConfigFileContent>("read_app_config_file", {
    app: appId,
    fileKey,
  });
}

export async function writeAppConfigFile(options: {
  appId: AppId;
  fileKey: string;
  content: string;
}): Promise<boolean> {
  const { appId, fileKey, content } = options;
  return invoke<boolean>("write_app_config_file", {
    app: appId,
    fileKey,
    content,
  });
}

export async function writeAppConfigFiles(options: {
  appId: AppId;
  files: Array<{ fileKey: string; content: string }>;
}): Promise<boolean> {
  const { appId, files } = options;
  return invoke<boolean>("write_app_config_files", {
    app: appId,
    files,
  });
}

export async function importMcpFromAppLive(appId: AppId): Promise<number> {
  return invoke<number>("import_mcp_from_app_live", {
    app: appId,
  });
}

export async function getAppConfigTemplate(
  appId: AppId,
): Promise<AppConfigTemplateFile[]> {
  return invoke<AppConfigTemplateFile[]>("get_app_config_template", {
    app: appId,
  });
}

export async function setAppConfigTemplate(options: {
  appId: AppId;
  files: AppConfigTemplateFile[];
  syncToLive?: boolean;
}): Promise<boolean> {
  const { appId, files, syncToLive } = options;
  return invoke<boolean>("set_app_config_template", {
    app: appId,
    files,
    syncToLive,
  });
}

export async function getProviderDefaultTemplate(
  appId: AppId,
): Promise<string | null> {
  return invoke<string | null>("get_provider_default_template", {
    app: appId,
  });
}

export async function setProviderDefaultTemplate(options: {
  appId: AppId;
  template: string | null;
}): Promise<boolean> {
  const { appId, template } = options;
  return invoke<boolean>("set_provider_default_template", {
    app: appId,
    template,
  });
}
