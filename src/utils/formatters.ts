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
 * 智能解析 MCP JSON 配置
 * 支持两种格式：
 * 1. 纯配置对象：{ "command": "npx", "args": [...], ... }
 * 2. 带键名包装：  "server-name": { "command": "npx", ... }  或  { "server-name": {...} }
 * 3. 标准多服务器包装：{ "mcpServers": { "server-a": {...}, "server-b": {...} } }
 *
 * @param jsonText - JSON 字符串
 * @returns 单服务器时返回 id/config；多服务器时返回 servers
 * @throws 如果 JSON 格式无效
 */
export function parseSmartMcpJson(jsonText: string): {
  id?: string;
  config?: any;
  servers?: Record<string, any>;
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON root must be an object");
  }

  // 标准 mcpServers 包裹结构
  if (
    Object.prototype.hasOwnProperty.call(parsed, "mcpServers") &&
    parsed.mcpServers &&
    typeof parsed.mcpServers === "object" &&
    !Array.isArray(parsed.mcpServers)
  ) {
    const servers = parsed.mcpServers as Record<string, any>;
    const ids = Object.keys(servers);
    if (ids.length === 0) {
      throw new Error("mcpServers is empty");
    }

    if (ids.length === 1) {
      const id = ids[0];
      const config = servers[id];
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`mcpServers.${id} must be an object`);
      }
      return {
        id,
        config,
        formattedConfig: JSON.stringify(config, null, 2),
      };
    }

    return {
      servers,
      formattedConfig: JSON.stringify({ mcpServers: servers }, null, 2),
    };
  }

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
