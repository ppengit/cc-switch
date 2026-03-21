// 供应商配置处理工具函数

import type { TemplateValueConfig } from "../config/claudeProviderPresets";
import { normalizeQuotes } from "@/utils/textNormalization";
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

export interface ParseJsonObjectResult {
  value?: Record<string, any>;
  error?: string;
}

export const safeParseJsonObject = (
  value: string,
  fieldName: string = "配置",
): ParseJsonObjectResult => {
  const trimmed = value.trim();
  if (!trimmed) {
    return { value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      error: `${fieldName}JSON格式错误，请检查语法`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      error: `${fieldName}必须是 JSON 对象`,
    };
  }

  return { value: parsed as Record<string, any> };
};

// 验证JSON配置格式
export const validateJsonConfig = (
  value: string,
  fieldName: string = "配置",
): string => {
  return safeParseJsonObject(value, fieldName).error ?? "";
};

// 将通用配置片段写入/移除 settingsConfig
export const updateCommonConfigSnippet = (
  jsonString: string,
  snippetString: string,
  enabled: boolean,
): UpdateCommonConfigResult => {
  const configResult = safeParseJsonObject(jsonString, "配置");
  if (configResult.error) {
    return {
      updatedConfig: jsonString,
      error: "配置 JSON 解析失败，无法写入通用配置",
    };
  }
  const config = configResult.value ?? {};

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

  const snippet =
    safeParseJsonObject(snippetString, "通用配置片段").value ?? {};

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
  if (!snippetString.trim()) {
    return false;
  }

  const config = safeParseJsonObject(jsonString, "配置").value;
  const snippet = safeParseJsonObject(snippetString, "通用配置片段").value;
  if (!config || !snippet) {
    return false;
  }

  return isSubset(config, snippet);
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
  options: { createIfMissing?: boolean; appType?: string } = {},
): string => {
  const { createIfMissing = false, appType } = options;
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

    // Claude API Key (优先写入已存在的字段；若两者均不存在且允许创建，则默认创建 AUTH_TOKEN 字段)
    if ("ANTHROPIC_AUTH_TOKEN" in env) {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else if ("ANTHROPIC_API_KEY" in env) {
      env.ANTHROPIC_API_KEY = apiKey;
    } else if (createIfMissing) {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
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

const formatTomlValidationError = (
  message: string,
  fieldName: string = "TOML 配置",
) => {
  if (!message) {
    return `${fieldName}格式错误，请检查语法`;
  }
  if (message === "mustBeObject" || message === "parseError") {
    return `${fieldName}格式错误，请检查语法`;
  }
  return `TOML 解析错误: ${fieldName}: ${message}`;
};

const COMMON_SNIPPET_START = "# cc-switch common config start";
const COMMON_SNIPPET_END = "# cc-switch common config end";
const CODEX_PROVIDER_CONFIG_PLACEHOLDER = "{{provider.config}}";
const CODEX_MCP_CONFIG_PLACEHOLDER = "{{mcp.config}}";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const COMMON_SNIPPET_REGEX = new RegExp(
  `${escapeRegExp(COMMON_SNIPPET_START)}[\\s\\S]*?${escapeRegExp(
    COMMON_SNIPPET_END,
  )}\\s*\\n?`,
  "g",
);

const normalizeWhitespace = (str: string) => str.replace(/\s+/g, " ").trim();
const normalizeLineEndings = (str: string) => str.replace(/\r\n?/g, "\n");

const buildCommonSnippetBlock = (snippet: string) =>
  `${COMMON_SNIPPET_START}\n${snippet.trim()}\n${COMMON_SNIPPET_END}\n\n`;

const stripManagedTomlCommonSnippetBlock = (tomlString: string) =>
  normalizeLineEndings(tomlString).replace(COMMON_SNIPPET_REGEX, "");

const stripLegacyLeadingTomlCommonSnippetBlock = (
  tomlString: string,
  snippetString: string,
) => {
  const normalizedToml = normalizeLineEndings(tomlString);
  const normalizedSnippet = normalizeLineEndings(snippetString).trim();
  if (!normalizedSnippet) {
    return normalizedToml;
  }

  const legacyLeadingSnippetRegex = new RegExp(
    `^(?:\\s*\\n)*${escapeRegExp(normalizedSnippet)}(?:\\n{1,2})?`,
  );

  return normalizedToml.replace(legacyLeadingSnippetRegex, "");
};

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
    .replaceAll(CODEX_PROVIDER_CONFIG_PLACEHOLDER, CODEX_PROVIDER_CONFIG_STUB)
    .replaceAll(CODEX_MCP_CONFIG_PLACEHOLDER, CODEX_MCP_CONFIG_STUB);

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
    CODEX_COMMON_CONFIG_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(trimmed))
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
    // 添加通用配置（始终插入到文件开头，避免落在表格内造成重复 key）
    const block = buildCommonSnippetBlock(snippetString);
    const trimmed = cleaned.trimStart();
    const updatedConfig = trimmed ? block + trimmed : block.trimEnd() + "\n";
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

// 检查 TOML 配置是否已包含通用配置片段
export const hasTomlCommonConfigSnippet = (
  tomlString: string,
  snippetString: string,
): boolean => {
  const normalizedSnippet = normalizeLineEndings(snippetString).trim();
  if (!normalizedSnippet) return false;

  const normalizedToml = normalizeLineEndings(tomlString);
  const match = normalizedToml.match(COMMON_SNIPPET_REGEX);
  if (match && match[0]) {
    const block = match[0]
      .replace(COMMON_SNIPPET_START, "")
      .replace(COMMON_SNIPPET_END, "")
      .trim();
    return normalizeWhitespace(block) === normalizeWhitespace(normalizedSnippet);
  }

  const legacyLeadingSnippetRegex = new RegExp(
    `^(?:\\s*\\n)*${escapeRegExp(normalizedSnippet)}(?:\\n|$)`,
  );
  return legacyLeadingSnippetRegex.test(normalizedToml);
};

// ========== Codex base_url utils ==========

// 从 Codex 的 TOML 配置文本中提取 base_url（支持单/双引号）
export const extractCodexBaseUrl = (
  configText: string | undefined | null,
): string | undefined => {
  try {
    const raw = typeof configText === "string" ? configText : "";
    // 归一化中文/全角引号，避免正则提取失败
    const text = normalizeQuotes(raw);
    if (!text) return undefined;
    const m = text.match(/base_url\s*=\s*(['"])([^'\"]+)\1/);
    return m && m[2] ? m[2] : undefined;
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
  if (!trimmed) {
    return configText;
  }
  // 归一化原文本中的引号（既能匹配，也能输出稳定格式）
  const normalizedText = normalizeQuotes(configText);

  const normalizedUrl = trimmed.replace(/\s+/g, "");
  const replacementLine = `base_url = "${normalizedUrl}"`;
  const pattern = /base_url\s*=\s*(["'])([^"']+)\1/;

  if (pattern.test(normalizedText)) {
    return normalizedText.replace(pattern, replacementLine);
  }

  const prefix =
    normalizedText && !normalizedText.endsWith("\n")
      ? `${normalizedText}\n`
      : normalizedText;
  return `${prefix}${replacementLine}\n`;
};

// ========== Codex model name utils ==========

// 从 Codex 的 TOML 配置文本中提取 model 字段（支持单/双引号）
export const extractCodexModelName = (
  configText: string | undefined | null,
): string | undefined => {
  try {
    const raw = typeof configText === "string" ? configText : "";
    // 归一化中文/全角引号，避免正则提取失败
    const text = normalizeQuotes(raw);
    if (!text) return undefined;

    // 匹配 model = "xxx" 或 model = 'xxx'
    const m = text.match(/^model\s*=\s*(['"])([^'"]+)\1/m);
    return m && m[2] ? m[2] : undefined;
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
    const text = normalizeQuotes(raw);
    if (!text) return undefined;

    const m = text.match(/^model_reasoning_effort\s*=\s*(['"])([^'"]+)\1/m);
    return m && m[2] ? m[2] : undefined;
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
  if (!trimmed) {
    return configText;
  }

  // 归一化原文本中的引号（既能匹配，也能输出稳定格式）
  const normalizedText = normalizeQuotes(configText);

  const replacementLine = `model = "${trimmed}"`;
  const pattern = /^model\s*=\s*["']([^"']+)["']/m;

  if (pattern.test(normalizedText)) {
    return normalizedText.replace(pattern, replacementLine);
  }

  // 如果不存在 model 字段，尝试在 model_provider 之后插入
  // 如果 model_provider 也不存在，则插入到开头
  const providerPattern = /^model_provider\s*=\s*["'][^"']+["']/m;
  const match = normalizedText.match(providerPattern);

  if (match && match.index !== undefined) {
    // 在 model_provider 行之后插入
    const endOfLine = normalizedText.indexOf("\n", match.index);
    if (endOfLine !== -1) {
      return (
        normalizedText.slice(0, endOfLine + 1) +
        replacementLine +
        "\n" +
        normalizedText.slice(endOfLine + 1)
      );
    }
  }

  // 在文件开头插入
  const lines = normalizedText.split("\n");
  return `${replacementLine}\n${lines.join("\n")}`;
};

// 在 Codex 的 TOML 配置文本中写入或更新 model_reasoning_effort 字段
export const setCodexReasoningEffort = (
  configText: string,
  reasoningEffort: string,
): string => {
  const trimmed = reasoningEffort.trim();
  if (!trimmed) {
    return configText;
  }

  const normalizedText = normalizeQuotes(configText);
  const replacementLine = `model_reasoning_effort = "${trimmed}"`;
  const pattern = /^model_reasoning_effort\s*=\s*["']([^"']+)["']/m;

  if (pattern.test(normalizedText)) {
    return normalizedText.replace(pattern, replacementLine);
  }

  const modelPattern = /^model\s*=\s*["'][^"']+["']/m;
  const modelMatch = normalizedText.match(modelPattern);
  if (modelMatch && modelMatch.index !== undefined) {
    const endOfLine = normalizedText.indexOf("\n", modelMatch.index);
    if (endOfLine !== -1) {
      return (
        normalizedText.slice(0, endOfLine + 1) +
        replacementLine +
        "\n" +
        normalizedText.slice(endOfLine + 1)
      );
    }
  }

  const providerPattern = /^model_provider\s*=\s*["'][^"']+["']/m;
  const providerMatch = normalizedText.match(providerPattern);
  if (providerMatch && providerMatch.index !== undefined) {
    const endOfLine = normalizedText.indexOf("\n", providerMatch.index);
    if (endOfLine !== -1) {
      return (
        normalizedText.slice(0, endOfLine + 1) +
        replacementLine +
        "\n" +
        normalizedText.slice(endOfLine + 1)
      );
    }
  }

  return `${replacementLine}\n${normalizedText}`;
};
