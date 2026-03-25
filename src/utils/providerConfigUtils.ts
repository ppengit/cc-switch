// 供应商配置处理工具函数

import type { TemplateValueConfig } from "../config/claudeProviderPresets";
import { normalizeTomlText } from "@/utils/textNormalization";
import { validateToml as validateTomlText } from "@/utils/tomlUtils";

const isPlainObject = (value: unknown): value is Record<string, any> => {
  return Object.prototype.toString.call(value) === "[object Object]";
};

const deepMerge = (
  target: Record<string, any>,
  source: Record<string, any>,
): Record<string, any> => {
  Object.entries(source).forEach(([key, value]) => {
    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
    } else {
      // 直接覆盖非对象字段（数组/基础类型）
      target[key] = value;
    }
  });
  return target;
};

const deepRemove = (
  target: Record<string, any>,
  source: Record<string, any>,
) => {
  Object.entries(source).forEach(([key, value]) => {
    if (!(key in target)) return;

    if (isPlainObject(value) && isPlainObject(target[key])) {
      // 只移除完全匹配的嵌套属性
      deepRemove(target[key], value);
      if (Object.keys(target[key]).length === 0) {
        delete target[key];
      }
    } else if (isSubset(target[key], value)) {
      // 只有当值完全匹配时才删除
      delete target[key];
    }
  });
};

const isSubset = (target: any, source: any): boolean => {
  if (isPlainObject(source)) {
    if (!isPlainObject(target)) return false;
    return Object.entries(source).every(([key, value]) =>
      isSubset(target[key], value),
    );
  }

  if (Array.isArray(source)) {
    if (!Array.isArray(target) || target.length !== source.length) return false;
    return source.every((item, index) => isSubset(target[index], item));
  }

  return target === source;
};

// 深拷贝函数
const deepClone = <T>(obj: T): T => {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as T;
  if (obj instanceof Array) return obj.map((item) => deepClone(item)) as T;
  if (obj instanceof Object) {
    const clonedObj = {} as T;
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = deepClone(obj[key]);
      }
    }
    return clonedObj;
  }
  return obj;
};

export interface UpdateCommonConfigResult {
  updatedConfig: string;
  error?: string;
}

const JSON_PROVIDER_CONFIG_PLACEHOLDER = "{{provider.config}}";
const JSON_MCP_CONFIG_PLACEHOLDER = "{{mcp.config}}";

const DEFAULT_JSON_COMMON_CONFIG_TEMPLATES = {
  claude: {
    [JSON_PROVIDER_CONFIG_PLACEHOLDER]: {},
    includeCoAuthoredBy: false,
    mcpServers: JSON_MCP_CONFIG_PLACEHOLDER,
  },
  gemini: {
    [JSON_PROVIDER_CONFIG_PLACEHOLDER]: {},
    config: {
      ui: {
        inlineThinkingMode: "full",
      },
    },
    mcpServers: JSON_MCP_CONFIG_PLACEHOLDER,
  },
} as const;

export interface JsonCommonConfigTemplateParseResult {
  commonConfig: Record<string, any>;
  hasMcpPlaceholder: boolean;
  template: Record<string, any>;
}

const countJsonTemplatePlaceholderValues = (
  value: unknown,
  placeholder: string,
): number => {
  if (value === placeholder) {
    return 1;
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) =>
        count + countJsonTemplatePlaceholderValues(item, placeholder),
      0,
    );
  }

  if (isPlainObject(value)) {
    return Object.values(value).reduce(
      (count, item) =>
        count + countJsonTemplatePlaceholderValues(item, placeholder),
      0,
    );
  }

  return 0;
};

const stripJsonTemplatePlaceholderValues = (
  value: unknown,
  placeholder: string,
): unknown => {
  if (value === placeholder) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => stripJsonTemplatePlaceholderValues(item, placeholder))
      .filter((item) => item !== undefined);
  }

  if (isPlainObject(value)) {
    const next: Record<string, unknown> = {};
    Object.entries(value).forEach(([key, item]) => {
      const stripped = stripJsonTemplatePlaceholderValues(item, placeholder);
      if (stripped !== undefined) {
        next[key] = stripped;
      }
    });
    return next;
  }

  return value;
};

const parseJsonCommonConfigTemplateInternal = (
  appId: "claude" | "gemini",
  value: string,
  fieldName: string,
):
  | { error: string }
  | {
      result: JsonCommonConfigTemplateParseResult;
    } => {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      result: {
        commonConfig: {},
        hasMcpPlaceholder: false,
        template: {},
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      error: `${fieldName}JSON格式错误，请检查语法`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      error: `${fieldName}必须是 JSON 对象`,
    };
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      parsed,
      JSON_PROVIDER_CONFIG_PLACEHOLDER,
    )
  ) {
    return {
      error: `${appId === "claude" ? "Claude" : "Gemini"} 应用配置模板必须包含顶层 ${JSON_PROVIDER_CONFIG_PLACEHOLDER} 占位符`,
    };
  }

  const mcpPlaceholderCount = countJsonTemplatePlaceholderValues(
    parsed,
    JSON_MCP_CONFIG_PLACEHOLDER,
  );
  if (mcpPlaceholderCount > 1) {
    return {
      error: `${appId === "claude" ? "Claude" : "Gemini"} 应用配置模板最多只能包含一个 ${JSON_MCP_CONFIG_PLACEHOLDER} 占位符`,
    };
  }

  const template = deepClone(parsed);
  delete template[JSON_PROVIDER_CONFIG_PLACEHOLDER];
  const commonConfig = stripJsonTemplatePlaceholderValues(
    template,
    JSON_MCP_CONFIG_PLACEHOLDER,
  );

  return {
    result: {
      commonConfig: isPlainObject(commonConfig) ? commonConfig : {},
      hasMcpPlaceholder: mcpPlaceholderCount === 1,
      template: parsed,
    },
  };
};

export const getDefaultJsonCommonConfigTemplate = (
  appId: "claude" | "gemini",
): string =>
  JSON.stringify(DEFAULT_JSON_COMMON_CONFIG_TEMPLATES[appId], null, 2);

export const parseJsonCommonConfigTemplate = (
  appId: "claude" | "gemini",
  value: string,
  fieldName: string = "应用配置模板",
):
  | { error: string }
  | {
      result: JsonCommonConfigTemplateParseResult;
    } => parseJsonCommonConfigTemplateInternal(appId, value, fieldName);

export const validateJsonCommonConfigTemplate = (
  appId: "claude" | "gemini",
  value: string,
  fieldName: string = "应用配置模板",
): string => {
  if (!value.trim()) {
    return "";
  }

  const parsed = parseJsonCommonConfigTemplateInternal(appId, value, fieldName);
  return "error" in parsed ? parsed.error : "";
};

export const normalizeJsonCommonConfigTemplateForEditing = (
  appId: "claude" | "gemini",
  value: string | null | undefined,
): string => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return getDefaultJsonCommonConfigTemplate(appId);
  }

  const parsed = parseJsonCommonConfigTemplateInternal(
    appId,
    trimmed,
    "应用配置模板",
  );
  if (!("error" in parsed)) {
    return JSON.stringify(parsed.result.template, null, 2);
  }

  try {
    const legacyParsed = JSON.parse(trimmed);
    if (!isPlainObject(legacyParsed)) {
      return value ?? "";
    }

    const migrated: Record<string, unknown> = {
      [JSON_PROVIDER_CONFIG_PLACEHOLDER]: {},
      ...legacyParsed,
    };
    if (!Object.prototype.hasOwnProperty.call(migrated, "mcpServers")) {
      migrated.mcpServers = JSON_MCP_CONFIG_PLACEHOLDER;
    }

    const validationError = validateJsonCommonConfigTemplate(
      appId,
      JSON.stringify(migrated, null, 2),
    );
    if (!validationError) {
      return JSON.stringify(migrated, null, 2);
    }
  } catch {
    return value ?? "";
  }

  return value ?? "";
};

// 验证JSON配置格式
export const validateJsonConfig = (
  value: string,
  fieldName: string = "配置",
): string => {
  if (!value.trim()) {
    return "";
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `${fieldName}必须是 JSON 对象`;
    }
    return "";
  } catch {
    return `${fieldName}JSON格式错误，请检查语法`;
  }
};

// 将通用配置片段写入/移除 settingsConfig
export const updateCommonConfigSnippet = (
  jsonString: string,
  snippetString: string,
  enabled: boolean,
): UpdateCommonConfigResult => {
  let config: Record<string, any>;
  try {
    config = jsonString ? JSON.parse(jsonString) : {};
  } catch (err) {
    return {
      updatedConfig: jsonString,
      error: "配置 JSON 解析失败，无法写入通用配置",
    };
  }

  if (!snippetString.trim()) {
    return {
      updatedConfig: JSON.stringify(config, null, 2),
    };
  }

  // 使用统一的验证函数
  const snippetError = validateJsonConfig(snippetString, "通用配置片段");
  if (snippetError) {
    return {
      updatedConfig: JSON.stringify(config, null, 2),
      error: snippetError,
    };
  }

  const snippet = JSON.parse(snippetString) as Record<string, any>;

  if (enabled) {
    const merged = deepMerge(deepClone(config), snippet);
    return {
      updatedConfig: JSON.stringify(merged, null, 2),
    };
  }

  const cloned = deepClone(config);
  deepRemove(cloned, snippet);
  return {
    updatedConfig: JSON.stringify(cloned, null, 2),
  };
};

// 检查当前配置是否已包含通用配置片段
export const hasCommonConfigSnippet = (
  jsonString: string,
  snippetString: string,
): boolean => {
  try {
    if (!snippetString.trim()) return false;
    const config = jsonString ? JSON.parse(jsonString) : {};
    const snippet = JSON.parse(snippetString);
    if (!isPlainObject(snippet)) return false;
    return isSubset(config, snippet);
  } catch (err) {
    return false;
  }
};

// 读取配置中的 API Key（支持 Claude, Codex, Gemini）
export const getApiKeyFromConfig = (
  jsonString: string,
  appType?: string,
): string => {
  try {
    const config = JSON.parse(jsonString);

    // 优先检查顶层 apiKey 字段（用于 Bedrock API Key 等预设）
    if (
      typeof config?.apiKey === "string" &&
      config.apiKey &&
      !config.apiKey.includes("${")
    ) {
      return config.apiKey;
    }

    const env = config?.env;

    if (!env) return "";

    // Gemini API Key
    if (appType === "gemini") {
      const geminiKey = env.GEMINI_API_KEY;
      return typeof geminiKey === "string" ? geminiKey : "";
    }

    // Codex API Key
    if (appType === "codex") {
      const codexKey = env.CODEX_API_KEY;
      return typeof codexKey === "string" ? codexKey : "";
    }

    // Claude API Key (优先 ANTHROPIC_AUTH_TOKEN，其次 ANTHROPIC_API_KEY)
    const token = env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = env.ANTHROPIC_API_KEY;
    const value =
      typeof token === "string"
        ? token
        : typeof apiKey === "string"
          ? apiKey
          : "";
    return value;
  } catch (err) {
    return "";
  }
};

// 模板变量替换
export const applyTemplateValues = (
  config: any,
  templateValues: Record<string, TemplateValueConfig> | undefined,
): any => {
  const resolvedValues = Object.fromEntries(
    Object.entries(templateValues ?? {}).map(([key, value]) => {
      const resolvedValue =
        value.editorValue !== undefined
          ? value.editorValue
          : (value.defaultValue ?? "");
      return [key, resolvedValue];
    }),
  );

  const replaceInString = (str: string): string => {
    return Object.entries(resolvedValues).reduce((acc, [key, value]) => {
      const placeholder = `\${${key}}`;
      if (!acc.includes(placeholder)) {
        return acc;
      }
      return acc.split(placeholder).join(value ?? "");
    }, str);
  };

  const traverse = (obj: any): any => {
    if (typeof obj === "string") {
      return replaceInString(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map(traverse);
    }
    if (obj && typeof obj === "object") {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = traverse(value);
      }
      return result;
    }
    return obj;
  };

  return traverse(config);
};

// 判断配置中是否存在 API Key 字段
export const hasApiKeyField = (
  jsonString: string,
  appType?: string,
): boolean => {
  try {
    const config = JSON.parse(jsonString);

    // 检查顶层 apiKey 字段（用于 Bedrock API Key 等预设）
    if (Object.prototype.hasOwnProperty.call(config, "apiKey")) {
      return true;
    }

    const env = config?.env ?? {};

    if (appType === "gemini") {
      return Object.prototype.hasOwnProperty.call(env, "GEMINI_API_KEY");
    }

    if (appType === "codex") {
      return Object.prototype.hasOwnProperty.call(env, "CODEX_API_KEY");
    }

    return (
      Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_AUTH_TOKEN") ||
      Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_API_KEY")
    );
  } catch (err) {
    return false;
  }
};

// 写入/更新配置中的 API Key，默认不新增缺失字段
export const setApiKeyInConfig = (
  jsonString: string,
  apiKey: string,
  options: {
    createIfMissing?: boolean;
    appType?: string;
    apiKeyField?: string;
  } = {},
): string => {
  const { createIfMissing = false, appType, apiKeyField } = options;
  try {
    const config = JSON.parse(jsonString);

    // 优先检查顶层 apiKey 字段（用于 Bedrock API Key 等预设）
    if (Object.prototype.hasOwnProperty.call(config, "apiKey")) {
      config.apiKey = apiKey;
      return JSON.stringify(config, null, 2);
    }

    if (!config.env) {
      if (!createIfMissing) return jsonString;
      config.env = {};
    }
    const env = config.env as Record<string, any>;

    // Gemini API Key
    if (appType === "gemini") {
      if ("GEMINI_API_KEY" in env) {
        env.GEMINI_API_KEY = apiKey;
      } else if (createIfMissing) {
        env.GEMINI_API_KEY = apiKey;
      } else {
        return jsonString;
      }
      return JSON.stringify(config, null, 2);
    }

    // Codex API Key
    if (appType === "codex") {
      if ("CODEX_API_KEY" in env) {
        env.CODEX_API_KEY = apiKey;
      } else if (createIfMissing) {
        env.CODEX_API_KEY = apiKey;
      } else {
        return jsonString;
      }
      return JSON.stringify(config, null, 2);
    }

    // Claude API Key (优先写入已存在的字段；若两者均不存在且允许创建，则使用 apiKeyField 或默认 AUTH_TOKEN 字段)
    if ("ANTHROPIC_AUTH_TOKEN" in env) {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else if ("ANTHROPIC_API_KEY" in env) {
      env.ANTHROPIC_API_KEY = apiKey;
    } else if (createIfMissing) {
      env[apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"] = apiKey;
    } else {
      return jsonString;
    }
    return JSON.stringify(config, null, 2);
  } catch (err) {
    return jsonString;
  }
};

// ========== TOML Config Utilities ==========

export interface UpdateTomlCommonConfigResult {
  updatedConfig: string;
  error?: string;
}

const CODEX_PROVIDER_CONFIG_PLACEHOLDER = "{{provider.config}}";
const CODEX_MCP_CONFIG_PLACEHOLDER = "{{mcp.config}}";
const DEFAULT_CODEX_COMMON_CONFIG_SNIPPET = `{{provider.config}}

{{mcp.config}}`;

const buildCommonSnippetBlock = (snippetString: string) => {
  const normalizedSnippet = normalizeLineEndings(snippetString).trim();
  if (!normalizedSnippet) {
    return "";
  }

  return [
    "# cc-switch common config start",
    normalizedSnippet,
    "# cc-switch common config end",
    "",
  ].join("\n");
};

const stripManagedTomlCommonSnippetBlock = (tomlString: string) => {
  const lines = normalizeLineEndings(tomlString).split("\n");
  const output: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "# cc-switch common config start") {
      skipping = true;
      continue;
    }

    if (trimmed === "# cc-switch common config end") {
      skipping = false;
      continue;
    }

    if (!skipping) {
      output.push(line);
    }
  }

  return output.join("\n");
};

const stripLegacyLeadingTomlCommonSnippetBlock = (
  tomlString: string,
  snippetString: string,
) => {
  const normalizedConfig = normalizeLineEndings(tomlString);
  const normalizedSnippet = normalizeLineEndings(snippetString).trim();

  if (!normalizedSnippet) {
    return normalizedConfig;
  }

  const configTrimmedStart = normalizedConfig.trimStart();
  if (!configTrimmedStart.startsWith(normalizedSnippet)) {
    return normalizedConfig;
  }

  const leadingWhitespaceLength =
    normalizedConfig.length - configTrimmedStart.length;
  let remainder = configTrimmedStart.slice(normalizedSnippet.length);
  remainder = remainder.replace(/^\s*\n/, "");

  return `${normalizedConfig.slice(0, leadingWhitespaceLength)}${remainder}`;
};

const normalizeLineEndings = (value: string) => value.replace(/\r\n?/g, "\n");

const finalizeTomlCommonSnippetDocument = (tomlString: string) => {
  const normalized = normalizeLineEndings(tomlString)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized ? `${normalized}\n` : "";
};

const CODEX_COMMON_CONFIG_FORBIDDEN_PATTERNS = [
  /^\s*\[mcp_servers(?:\.[^\]]+)?\]\s*$/m,
  /^\s*\[mcp\.servers(?:\.[^\]]+)?\]\s*$/m,
  /^\s*mcp_servers\s*=/m,
];

const CODEX_PROVIDER_CONFIG_STUB = `model_provider = "custom"
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://example.com"`;

const CODEX_MCP_CONFIG_STUB = `[mcp_servers.example]
type = "stdio"
command = "echo"`;

const buildCodexTomlValidationSource = (value: string) =>
  value
    .split(CODEX_PROVIDER_CONFIG_PLACEHOLDER)
    .join(CODEX_PROVIDER_CONFIG_STUB)
    .split(CODEX_MCP_CONFIG_PLACEHOLDER)
    .join(CODEX_MCP_CONFIG_STUB);

const formatTomlValidationError = (error: string, fieldName: string) =>
  `${fieldName}格式错误（TOML）：${error}`;

export const validateCodexCommonConfigSnippet = (
  snippetString: string,
): string => {
  const trimmed = snippetString.trim();
  if (!trimmed) {
    return "";
  }

  const providerPlaceholderCount = (
    trimmed.match(/\{\{provider\.config\}\}/g) ?? []
  ).length;
  if (providerPlaceholderCount !== 1) {
    return "Codex 通用配置必须且只能包含一个 {{provider.config}} 占位符";
  }

  const mcpPlaceholderCount = (trimmed.match(/\{\{mcp\.config\}\}/g) ?? [])
    .length;
  if (mcpPlaceholderCount > 1) {
    return "Codex 通用配置最多只能包含一个 {{mcp.config}} 占位符";
  }

  if (
    CODEX_COMMON_CONFIG_FORBIDDEN_PATTERNS.some((pattern) =>
      pattern.test(trimmed),
    )
  ) {
    return "通用配置片段不能直接包含 mcp_servers，MCP 请使用 {{mcp.config}} 占位符";
  }

  const validationSource = buildCodexTomlValidationSource(trimmed);
  const tomlError = validateTomlText(validationSource);
  if (tomlError) {
    return formatTomlValidationError(tomlError, "通用配置片段");
  }

  return "";
};

export const getDefaultCodexCommonConfigSnippet = () =>
  DEFAULT_CODEX_COMMON_CONFIG_SNIPPET;

export const normalizeCodexCommonConfigSnippetForEditing = (
  snippetString: string | null | undefined,
): string => {
  const trimmed = (snippetString ?? "").trim();
  if (!trimmed) {
    return DEFAULT_CODEX_COMMON_CONFIG_SNIPPET;
  }

  if (!trimmed.includes(CODEX_PROVIDER_CONFIG_PLACEHOLDER)) {
    const migrated = `${trimmed}\n\n${DEFAULT_CODEX_COMMON_CONFIG_SNIPPET}`;
    if (!validateCodexCommonConfigSnippet(migrated)) {
      return migrated;
    }
  }

  return snippetString ?? "";
};

// 将通用配置片段写入/移除 TOML 配置
export const updateTomlCommonConfigSnippet = (
  tomlString: string,
  snippetString: string,
  enabled: boolean,
): UpdateTomlCommonConfigResult => {
  const trimmedSnippet = snippetString.trim();
  const strippedManaged = stripManagedTomlCommonSnippetBlock(tomlString);

  if (!trimmedSnippet) {
    if (enabled) {
      return {
        updatedConfig: tomlString,
      };
    }

    const updatedConfig = finalizeTomlCommonSnippetDocument(strippedManaged);
    const cleanedError = validateTomlText(
      buildCodexTomlValidationSource(updatedConfig),
    );
    if (cleanedError) {
      return {
        updatedConfig: tomlString,
        error: formatTomlValidationError(cleanedError, "config.toml"),
      };
    }

    return {
      updatedConfig,
    };
  }

  const validationError = validateCodexCommonConfigSnippet(snippetString);
  if (validationError) {
    return {
      updatedConfig: tomlString,
      error: validationError,
    };
  }

  const cleaned = stripLegacyLeadingTomlCommonSnippetBlock(
    strippedManaged,
    trimmedSnippet,
  );

  if (enabled) {
    const block = buildCommonSnippetBlock(snippetString);
    const trimmed = cleaned.trimStart();
    const updatedConfig = trimmed ? block + trimmed : `${block.trimEnd()}\n`;
    const mergedError = validateTomlText(
      buildCodexTomlValidationSource(updatedConfig),
    );
    if (mergedError) {
      return {
        updatedConfig: tomlString,
        error: formatTomlValidationError(mergedError, "合并后的 config.toml"),
      };
    }

    return {
      updatedConfig,
    };
  }

  const updatedConfig = finalizeTomlCommonSnippetDocument(cleaned);
  const cleanedError = validateTomlText(
    buildCodexTomlValidationSource(updatedConfig),
  );
  if (cleanedError) {
    return {
      updatedConfig: tomlString,
      error: formatTomlValidationError(cleanedError, "config.toml"),
    };
  }

  return {
    updatedConfig,
  };
};

// 检查当前配置是否已包含通用配置片段
export const hasTomlCommonConfigSnippet = (
  tomlString: string,
  snippetString: string,
): boolean => {
  const snippet = snippetString.trim();
  if (!snippet) return false;

  const normalizedConfig = normalizeLineEndings(tomlString).trim();
  if (!normalizedConfig) return false;

  const block = buildCommonSnippetBlock(snippetString).trim();
  if (block && normalizedConfig.includes(block)) {
    return true;
  }

  const cleanedConfig = stripManagedTomlCommonSnippetBlock(tomlString);
  return normalizeLineEndings(cleanedConfig).trimStart().startsWith(snippet);
};

// ========== Codex base_url utils ==========

const TOML_SECTION_HEADER_PATTERN = /^\s*\[([^\]\r\n]+)\]\s*$/;
const TOML_BASE_URL_PATTERN =
  /^\s*base_url\s*=\s*(["'])([^"'\r\n]*)\1\s*(?:#.*)?$/;
const TOML_MODEL_PATTERN = /^\s*model\s*=\s*(["'])([^"'\r\n]*)\1\s*(?:#.*)?$/;
const TOML_MODEL_REASONING_PATTERN =
  /^\s*model_reasoning_effort\s*=\s*(["'])([^"'\r\n]*)\1\s*(?:#.*)?$/;
const TOML_MODEL_PROVIDER_LINE_PATTERN =
  /^\s*model_provider\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/;
const TOML_MODEL_PROVIDER_PATTERN =
  /^\s*model_provider\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?$/m;

interface TomlSectionRange {
  bodyEndIndex: number;
  bodyStartIndex: number;
}

interface TomlAssignmentMatch {
  index: number;
  sectionName?: string;
  value: string;
}

const finalizeTomlText = (lines: string[]): string =>
  lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");

const getTomlSectionRange = (
  lines: string[],
  sectionName: string,
): TomlSectionRange | undefined => {
  let headerLineIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(TOML_SECTION_HEADER_PATTERN);
    if (!match) {
      continue;
    }

    if (headerLineIndex === -1) {
      if (match[1] === sectionName) {
        headerLineIndex = index;
      }
      continue;
    }

    return {
      bodyStartIndex: headerLineIndex + 1,
      bodyEndIndex: index,
    };
  }

  if (headerLineIndex === -1) {
    return undefined;
  }

  return {
    bodyStartIndex: headerLineIndex + 1,
    bodyEndIndex: lines.length,
  };
};

const getTopLevelEndIndex = (lines: string[]): number => {
  const firstSectionIndex = lines.findIndex((line) =>
    TOML_SECTION_HEADER_PATTERN.test(line),
  );
  return firstSectionIndex === -1 ? lines.length : firstSectionIndex;
};

const getTomlSectionInsertIndex = (
  lines: string[],
  sectionRange: TomlSectionRange,
): number => {
  let insertIndex = sectionRange.bodyEndIndex;
  while (
    insertIndex > sectionRange.bodyStartIndex &&
    lines[insertIndex - 1].trim() === ""
  ) {
    insertIndex -= 1;
  }
  return insertIndex;
};

const getCodexModelProviderName = (configText: string): string | undefined => {
  const match = configText.match(TOML_MODEL_PROVIDER_PATTERN);
  const providerName = match?.[2]?.trim();
  return providerName || undefined;
};

const getCodexProviderSectionName = (
  configText: string,
): string | undefined => {
  const providerName = getCodexModelProviderName(configText);
  return providerName ? `model_providers.${providerName}` : undefined;
};

const findTomlAssignmentInRange = (
  lines: string[],
  pattern: RegExp,
  startIndex: number,
  endIndex: number,
  sectionName?: string,
): TomlAssignmentMatch | undefined => {
  for (let index = startIndex; index < endIndex; index += 1) {
    const match = lines[index].match(pattern);
    if (match && match.length >= 3) {
      return {
        index,
        sectionName,
        value: match[2] ?? "",
      };
    }
  }

  return undefined;
};

const findTomlAssignments = (
  lines: string[],
  pattern: RegExp,
): TomlAssignmentMatch[] => {
  const assignments: TomlAssignmentMatch[] = [];
  let currentSectionName: string | undefined;

  lines.forEach((line, index) => {
    const sectionMatch = line.match(TOML_SECTION_HEADER_PATTERN);
    if (sectionMatch) {
      currentSectionName = sectionMatch[1];
      return;
    }

    const match = line.match(pattern);
    if (!match || match.length < 3) {
      return;
    }

    assignments.push({
      index,
      sectionName: currentSectionName,
      value: match[2] ?? "",
    });
  });

  return assignments;
};

const findTomlAssignmentIndexesInRange = (
  lines: string[],
  pattern: RegExp,
  startIndex: number,
  endIndex: number,
): number[] => {
  const indexes: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    if (pattern.test(lines[index])) {
      indexes.push(index);
    }
  }
  return indexes;
};

const removeTomlLineIndexes = (lines: string[], indexes: number[]): void => {
  const uniqueIndexes = Array.from(new Set(indexes)).sort((a, b) => b - a);
  uniqueIndexes.forEach((index) => {
    if (index >= 0 && index < lines.length) {
      lines.splice(index, 1);
    }
  });
};

const isMcpServerSection = (sectionName?: string): boolean =>
  sectionName === "mcp_servers" ||
  sectionName?.startsWith("mcp_servers.") === true;

const isOtherProviderSection = (
  sectionName: string | undefined,
  targetSectionName: string | undefined,
): boolean =>
  Boolean(
    sectionName &&
      sectionName !== targetSectionName &&
      (sectionName === "model_providers" ||
        sectionName.startsWith("model_providers.")),
  );

const getRecoverableBaseUrlAssignments = (
  assignments: TomlAssignmentMatch[],
  targetSectionName: string | undefined,
): TomlAssignmentMatch[] =>
  assignments.filter(
    ({ sectionName }) =>
      sectionName !== targetSectionName &&
      !isMcpServerSection(sectionName) &&
      !isOtherProviderSection(sectionName, targetSectionName),
  );

const getTopLevelModelProviderLineIndex = (lines: string[]): number => {
  const topLevelEndIndex = getTopLevelEndIndex(lines);

  for (let index = 0; index < topLevelEndIndex; index += 1) {
    if (TOML_MODEL_PROVIDER_LINE_PATTERN.test(lines[index])) {
      return index;
    }
  }

  return -1;
};

// 从 Codex 的 TOML 配置文本中提取 base_url（支持单/双引号）
export const extractCodexBaseUrl = (
  configText: string | undefined | null,
): string | undefined => {
  try {
    const raw = typeof configText === "string" ? configText : "";
    const text = normalizeTomlText(raw);
    if (!text) return undefined;

    const lines = text.split("\n");
    const targetSectionName = getCodexProviderSectionName(text);

    if (targetSectionName) {
      const sectionRange = getTomlSectionRange(lines, targetSectionName);
      if (sectionRange) {
        const matches = findTomlAssignmentIndexesInRange(
          lines,
          TOML_BASE_URL_PATTERN,
          sectionRange.bodyStartIndex,
          sectionRange.bodyEndIndex,
        );
        if (matches.length > 0) {
          const lastMatchIndex = matches[matches.length - 1];
          const lastMatch = lines[lastMatchIndex].match(TOML_BASE_URL_PATTERN);
          if (lastMatch && lastMatch.length >= 3 && lastMatch[2]) {
            return lastMatch[2];
          }
        }
      }
    }

    const topLevelMatches = findTomlAssignmentIndexesInRange(
      lines,
      TOML_BASE_URL_PATTERN,
      0,
      getTopLevelEndIndex(lines),
    );
    if (topLevelMatches.length > 0) {
      const lastMatch = lines[
        topLevelMatches[topLevelMatches.length - 1]
      ].match(TOML_BASE_URL_PATTERN);
      if (lastMatch && lastMatch.length >= 3 && lastMatch[2]) {
        return lastMatch[2];
      }
    }

    const fallbackAssignments = getRecoverableBaseUrlAssignments(
      findTomlAssignments(lines, TOML_BASE_URL_PATTERN),
      targetSectionName,
    );
    return fallbackAssignments.length === 1
      ? fallbackAssignments[0].value
      : undefined;
  } catch {
    return undefined;
  }
};

// 从 Provider 对象中提取 Codex base_url（当 settingsConfig.config 为 TOML 字符串时）
export const getCodexBaseUrl = (
  provider: { settingsConfig?: Record<string, any> } | undefined | null,
): string | undefined => {
  try {
    const text =
      typeof provider?.settingsConfig?.config === "string"
        ? (provider as any).settingsConfig.config
        : "";
    return extractCodexBaseUrl(text);
  } catch {
    return undefined;
  }
};

// 在 Codex 的 TOML 配置文本中写入或更新 base_url 字段
export const setCodexBaseUrl = (
  configText: string,
  baseUrl: string,
): string => {
  const trimmed = baseUrl.trim();
  const normalizedText = normalizeTomlText(configText);
  const lines = normalizedText ? normalizedText.split("\n") : [];
  const targetSectionName = getCodexProviderSectionName(normalizedText);
  const allAssignments = findTomlAssignments(lines, TOML_BASE_URL_PATTERN);
  const recoverableAssignments = getRecoverableBaseUrlAssignments(
    allAssignments,
    targetSectionName,
  );

  if (!trimmed) {
    if (!normalizedText) return normalizedText;

    const indexesToRemove: number[] = recoverableAssignments.map(
      ({ index }) => index,
    );

    if (targetSectionName) {
      const sectionRange = getTomlSectionRange(lines, targetSectionName);
      const targetMatches = sectionRange
        ? findTomlAssignmentIndexesInRange(
            lines,
            TOML_BASE_URL_PATTERN,
            sectionRange.bodyStartIndex,
            sectionRange.bodyEndIndex,
          )
        : undefined;

      if (targetMatches?.length) {
        indexesToRemove.push(...targetMatches);
      }
    }

    removeTomlLineIndexes(lines, indexesToRemove);
    return finalizeTomlText(lines);
  }

  const normalizedUrl = trimmed.replace(/\s+/g, "");
  const replacementLine = `base_url = "${normalizedUrl}"`;

  if (targetSectionName) {
    removeTomlLineIndexes(
      lines,
      recoverableAssignments.map(({ index }) => index),
    );

    let targetSectionRange = getTomlSectionRange(lines, targetSectionName);
    const targetMatches = targetSectionRange
      ? findTomlAssignmentIndexesInRange(
          lines,
          TOML_BASE_URL_PATTERN,
          targetSectionRange.bodyStartIndex,
          targetSectionRange.bodyEndIndex,
        )
      : undefined;

    if (targetMatches?.length) {
      const keepIndex = targetMatches[targetMatches.length - 1];
      lines[keepIndex] = replacementLine;
      removeTomlLineIndexes(lines, targetMatches.slice(0, -1));
      return finalizeTomlText(lines);
    }

    if (targetSectionRange) {
      const insertIndex = getTomlSectionInsertIndex(lines, targetSectionRange);
      lines.splice(insertIndex, 0, replacementLine);
      return finalizeTomlText(lines);
    }

    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(`[${targetSectionName}]`, replacementLine);
    return finalizeTomlText(lines);
  }

  const topLevelEndIndex = getTopLevelEndIndex(lines);
  removeTomlLineIndexes(
    lines,
    recoverableAssignments.map(({ index }) => index),
  );
  const topLevelMatches = findTomlAssignmentIndexesInRange(
    lines,
    TOML_BASE_URL_PATTERN,
    0,
    topLevelEndIndex,
  );
  if (topLevelMatches.length > 0) {
    const keepIndex = topLevelMatches[topLevelMatches.length - 1];
    lines[keepIndex] = replacementLine;
    removeTomlLineIndexes(lines, topLevelMatches.slice(0, -1));
    return finalizeTomlText(lines);
  }

  const modelProviderIndex = getTopLevelModelProviderLineIndex(lines);
  if (modelProviderIndex !== -1) {
    lines.splice(modelProviderIndex + 1, 0, replacementLine);
    return finalizeTomlText(lines);
  }

  if (lines.length === 0) {
    return `${replacementLine}\n`;
  }

  const insertIndex = topLevelEndIndex;
  lines.splice(insertIndex, 0, replacementLine);
  return finalizeTomlText(lines);
};

// ========== Codex model name utils ==========

// 从 Codex 的 TOML 配置文本中提取 model 字段（支持单/双引号）
export const extractCodexModelName = (
  configText: string | undefined | null,
): string | undefined => {
  try {
    const raw = typeof configText === "string" ? configText : "";
    const text = normalizeTomlText(raw);
    if (!text) return undefined;
    const lines = text.split("\n");
    const topLevelMatches = findTomlAssignmentIndexesInRange(
      lines,
      TOML_MODEL_PATTERN,
      0,
      getTopLevelEndIndex(lines),
    );
    if (topLevelMatches.length === 0) {
      return undefined;
    }
    const lastMatch =
      lines[topLevelMatches[topLevelMatches.length - 1]].match(
        TOML_MODEL_PATTERN,
      );
    return lastMatch?.[2] || undefined;
  } catch {
    return undefined;
  }
};

// 从 Codex 的 TOML 配置文本中提取 model_reasoning_effort 字段（支持单/双引号）
export const extractCodexReasoningEffort = (
  configText: string | undefined | null,
): string | undefined => {
  try {
    const raw = typeof configText === "string" ? configText : "";
    const text = normalizeTomlText(raw);
    if (!text) return undefined;
    const lines = text.split("\n");
    const topLevelMatches = findTomlAssignmentIndexesInRange(
      lines,
      TOML_MODEL_REASONING_PATTERN,
      0,
      getTopLevelEndIndex(lines),
    );
    if (topLevelMatches.length === 0) {
      return undefined;
    }
    const lastMatch = lines[topLevelMatches[topLevelMatches.length - 1]].match(
      TOML_MODEL_REASONING_PATTERN,
    );
    return lastMatch?.[2] || undefined;
  } catch {
    return undefined;
  }
};

// 在 Codex 的 TOML 配置文本中写入或更新 model 字段
export const setCodexModelName = (
  configText: string,
  modelName: string,
): string => {
  const trimmed = modelName.trim();
  const normalizedText = normalizeTomlText(configText);
  const lines = normalizedText ? normalizedText.split("\n") : [];
  const topLevelEndIndex = getTopLevelEndIndex(lines);
  const topLevelMatches = findTomlAssignmentIndexesInRange(
    lines,
    TOML_MODEL_PATTERN,
    0,
    topLevelEndIndex,
  );

  if (!trimmed) {
    if (!normalizedText) return normalizedText;
    removeTomlLineIndexes(lines, topLevelMatches);
    return finalizeTomlText(lines);
  }

  const replacementLine = `model = "${trimmed}"`;
  if (topLevelMatches.length > 0) {
    const keepIndex = topLevelMatches[topLevelMatches.length - 1];
    lines[keepIndex] = replacementLine;
    removeTomlLineIndexes(lines, topLevelMatches.slice(0, -1));
    return finalizeTomlText(lines);
  }

  const modelProviderIndex = getTopLevelModelProviderLineIndex(lines);
  if (modelProviderIndex !== -1) {
    lines.splice(modelProviderIndex + 1, 0, replacementLine);
    return finalizeTomlText(lines);
  }

  if (lines.length === 0) {
    return `${replacementLine}\n`;
  }

  lines.splice(topLevelEndIndex, 0, replacementLine);
  return finalizeTomlText(lines);
};

// 在 Codex 的 TOML 配置文本中写入或更新 model_reasoning_effort 字段
export const setCodexReasoningEffort = (
  configText: string,
  reasoningEffort: string,
): string => {
  const trimmed = reasoningEffort.trim();
  const normalizedText = normalizeTomlText(configText);
  const lines = normalizedText ? normalizedText.split("\n") : [];
  const topLevelEndIndex = getTopLevelEndIndex(lines);
  const topLevelMatches = findTomlAssignmentIndexesInRange(
    lines,
    TOML_MODEL_REASONING_PATTERN,
    0,
    topLevelEndIndex,
  );

  if (!trimmed) {
    if (!normalizedText) return normalizedText;
    removeTomlLineIndexes(lines, topLevelMatches);
    return finalizeTomlText(lines);
  }

  const replacementLine = `model_reasoning_effort = "${trimmed}"`;
  if (topLevelMatches.length > 0) {
    const keepIndex = topLevelMatches[topLevelMatches.length - 1];
    lines[keepIndex] = replacementLine;
    removeTomlLineIndexes(lines, topLevelMatches.slice(0, -1));
    return finalizeTomlText(lines);
  }

  const modelMatch = findTomlAssignmentInRange(
    lines,
    TOML_MODEL_PATTERN,
    0,
    topLevelEndIndex,
  );
  if (modelMatch) {
    lines.splice(modelMatch.index + 1, 0, replacementLine);
    return finalizeTomlText(lines);
  }

  const modelProviderIndex = getTopLevelModelProviderLineIndex(lines);
  if (modelProviderIndex !== -1) {
    lines.splice(modelProviderIndex + 1, 0, replacementLine);
    return finalizeTomlText(lines);
  }

  if (lines.length === 0) {
    return `${replacementLine}\n`;
  }

  lines.splice(topLevelEndIndex, 0, replacementLine);
  return finalizeTomlText(lines);
};

export const normalizeCodexKnownDuplicateFields = (
  configText: string | undefined | null,
): string => {
  const normalizedText = normalizeTomlText(
    typeof configText === "string" ? configText : "",
  );
  if (!normalizedText.trim()) {
    return normalizedText;
  }

  let next = normalizedText;
  next = setCodexBaseUrl(next, extractCodexBaseUrl(next) ?? "");
  next = setCodexModelName(next, extractCodexModelName(next) ?? "");
  next = setCodexReasoningEffort(next, extractCodexReasoningEffort(next) ?? "");
  return next;
};
