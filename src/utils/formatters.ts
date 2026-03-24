/**
 * 格式化 JSON 字符串
 * @param value - 原始 JSON 字符串
 * @returns 格式化后的 JSON 字符串（2 空格缩进）
 * @throws 如果 JSON 格式无效
 */
export function formatJSON(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const parsed = JSON.parse(trimmed);
  return JSON.stringify(parsed, null, 2);
}

/**
 * 安全整理纯文本配置
 *
 * 仅执行不会改变配置语义的空白规范化：
 * - 统一换行符为 LF
 * - 移除每行末尾的空格/Tab
 * - 非空内容确保文件末尾只有一个换行
 *
 * @param value - 原始文本
 * @returns 整理后的文本
 */
export function formatTextConfig(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  const withoutTrailingBlankLines = normalized.replace(/\n+$/g, "");

  if (!withoutTrailingBlankLines.trim()) {
    return "";
  }

  return `${withoutTrailingBlankLines}\n`;
}

/**
 * 智能解析 MCP JSON 配置
 * 支持两种格式：
 * 1. 纯配置对象：{ "command": "npx", "args": [...], ... }
 * 2. 带键名包装：  "server-name": { "command": "npx", ... }  或  { "server-name": {...} }
 *
 * @param jsonText - JSON 字符串
 * @returns { id?: string, config: object, formattedConfig: string }
 * @throws 如果 JSON 格式无效
 */
export function parseSmartMcpJson(jsonText: string): {
  id?: string;
  config: any;
  formattedConfig: string;
} {
  let trimmed = jsonText.trim();
  if (!trimmed) {
    return { config: {}, formattedConfig: "" };
  }

  // 如果是键值对片段（"key": {...}），包装成完整对象
  if (trimmed.startsWith('"') && !trimmed.startsWith("{")) {
    trimmed = `{${trimmed}}`;
  }

  const parsed = JSON.parse(trimmed);

  // 如果是单键对象且值是对象，提取键名和配置
  const keys = Object.keys(parsed);
  if (
    keys.length === 1 &&
    parsed[keys[0]] &&
    typeof parsed[keys[0]] === "object" &&
    !Array.isArray(parsed[keys[0]])
  ) {
    const id = keys[0];
    const config = parsed[id];
    return {
      id,
      config,
      formattedConfig: JSON.stringify(config, null, 2),
    };
  }

  // 否则直接使用
  return {
    config: parsed,
    formattedConfig: JSON.stringify(parsed, null, 2),
  };
}

/**
 * TOML 格式化功能已禁用
 *
 * 原因：smol-toml 的 parse/stringify 会丢失所有注释和原有排版。
 * 由于 TOML 常用于配置文件，注释是重要的文档说明，丢失注释会造成严重的用户体验问题。
 *
 * 未来可选方案：
 * - 使用 @ltd/j-toml（支持注释保留，但需额外依赖和复杂的 API）
 * - 实现仅格式化缩进/空白的轻量级方案
 * - 使用 toml-eslint-parser + 自定义生成器
 *
 * 暂时建议：依赖现有的 TOML 语法校验（useCodexTomlValidation），不提供格式化功能。
 */
