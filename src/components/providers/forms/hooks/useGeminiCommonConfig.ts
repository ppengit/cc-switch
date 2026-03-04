import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { configApi } from "@/lib/api";

const LEGACY_STORAGE_KEY = "cc-switch:gemini-common-config-snippet";
const DEFAULT_GEMINI_COMMON_CONFIG_SNIPPET = "{}";

const GEMINI_COMMON_ENV_FORBIDDEN_KEYS = [
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_API_KEY",
] as const;
type GeminiForbiddenEnvKey = (typeof GEMINI_COMMON_ENV_FORBIDDEN_KEYS)[number];

interface UseGeminiCommonConfigProps {
  envValue: string;
  onEnvChange: (env: string) => void;
  configValue?: string;
  onConfigChange?: (config: string) => void;
  envStringToObj: (envString: string) => Record<string, string>;
  envObjToString: (envObj: Record<string, unknown>) => string;
  initialData?: {
    settingsConfig?: Record<string, unknown>;
  };
  selectedPresetId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * 管理 Gemini 通用配置片段 (JSON 格式)
 * 写入 Gemini 的 .env，但会排除以下敏感字段：
 * - GOOGLE_GEMINI_BASE_URL
 * - GEMINI_API_KEY
 */
export function useGeminiCommonConfig({
  envValue,
  onEnvChange,
  configValue,
  onConfigChange,
  envStringToObj,
  envObjToString,
  initialData,
  selectedPresetId,
}: UseGeminiCommonConfigProps) {
  const { t } = useTranslation();
  const [useCommonConfig, setUseCommonConfig] = useState(false);
  const [commonConfigSnippet, setCommonConfigSnippetState] = useState<string>(
    DEFAULT_GEMINI_COMMON_CONFIG_SNIPPET,
  );
  const [commonConfigError, setCommonConfigError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);

  // 用于跟踪是否正在通过通用配置更新
  const isUpdatingFromCommonConfig = useRef(false);
  // 用于跟踪新建模式是否已初始化默认勾选
  const hasInitializedNewMode = useRef(false);

  // 当预设变化时，重置初始化标记，使新预设能够重新触发初始化逻辑
  useEffect(() => {
    hasInitializedNewMode.current = false;
  }, [selectedPresetId]);

  const parseSnippet = useCallback(
    (
      snippetString: string,
    ): {
      env: Record<string, string>;
      config: Record<string, unknown>;
      error?: string;
    } => {
      const trimmed = snippetString.trim();
      if (!trimmed) {
        return { env: {}, config: {} };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return {
          env: {},
          config: {},
          error: t("geminiConfig.invalidJsonFormat"),
        };
      }

      if (!isPlainObject(parsed)) {
        return {
          env: {},
          config: {},
          error: t("geminiConfig.invalidJsonFormat"),
        };
      }

      const parsedObj = parsed as Record<string, unknown>;
      const hasStructured =
        Object.prototype.hasOwnProperty.call(parsedObj, "env") ||
        Object.prototype.hasOwnProperty.call(parsedObj, "config");

      const envSource = hasStructured ? parsedObj.env : parsedObj;
      const configSource = hasStructured ? parsedObj.config : undefined;

      const env: Record<string, string> = {};
      if (envSource !== undefined && envSource !== null) {
        if (!isPlainObject(envSource)) {
          return {
            env: {},
            config: {},
            error: t("geminiConfig.invalidJsonFormat"),
          };
        }
        const keys = Object.keys(envSource);
        const forbiddenKeys = keys.filter((key) =>
          GEMINI_COMMON_ENV_FORBIDDEN_KEYS.includes(
            key as GeminiForbiddenEnvKey,
          ),
        );
        if (forbiddenKeys.length > 0) {
          return {
            env: {},
            config: {},
            error: t("geminiConfig.commonConfigInvalidKeys", {
              keys: forbiddenKeys.join(", "),
            }),
          };
        }

        for (const [key, value] of Object.entries(envSource)) {
          if (typeof value !== "string") {
            return {
              env: {},
              config: {},
              error: t("geminiConfig.commonConfigInvalidValues"),
            };
          }
          const normalized = value.trim();
          if (!normalized) continue;
          env[key] = normalized;
        }
      }

      const config: Record<string, unknown> = {};
      if (configSource !== undefined && configSource !== null) {
        if (!isPlainObject(configSource)) {
          return {
            env: {},
            config: {},
            error: t("geminiConfig.invalidJsonFormat"),
          };
        }
        Object.assign(config, configSource as Record<string, unknown>);
      }

      return { env, config };
    },
    [t],
  );

  const hasEnvCommonConfigSnippet = useCallback(
    (envObj: Record<string, string>, snippetEnv: Record<string, string>) => {
      const entries = Object.entries(snippetEnv);
      if (entries.length === 0) return false;
      return entries.every(([key, value]) => envObj[key] === value);
    },
    [],
  );

  const applySnippetToEnv = useCallback(
    (envObj: Record<string, string>, snippetEnv: Record<string, string>) => {
      const updated = { ...envObj };
      for (const [key, value] of Object.entries(snippetEnv)) {
        if (typeof value === "string") {
          updated[key] = value;
        }
      }
      return updated;
    },
    [],
  );

  const removeSnippetFromEnv = useCallback(
    (envObj: Record<string, string>, snippetEnv: Record<string, string>) => {
      const updated = { ...envObj };
      for (const [key, value] of Object.entries(snippetEnv)) {
        if (typeof value === "string" && updated[key] === value) {
          delete updated[key];
        }
      }
      return updated;
    },
    [],
  );

  const parseConfigValue = useCallback((value: string | undefined) => {
    try {
      const parsed = JSON.parse(value || "{}");
      return isPlainObject(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }, []);

  const mergeConfigSnippet = useCallback(
    (
      configObj: Record<string, unknown>,
      snippetConfig: Record<string, unknown>,
    ) => {
      const next = { ...configObj };
      for (const [key, value] of Object.entries(snippetConfig)) {
        if (isPlainObject(value) && isPlainObject(next[key])) {
          next[key] = mergeConfigSnippet(
            next[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          );
        } else {
          next[key] = value;
        }
      }
      return next;
    },
    [],
  );

  const removeConfigSnippet = useCallback(
    (
      configObj: Record<string, unknown>,
      snippetConfig: Record<string, unknown>,
    ) => {
      const next = { ...configObj };
      for (const [key, value] of Object.entries(snippetConfig)) {
        if (!(key in next)) continue;
        if (isPlainObject(value) && isPlainObject(next[key])) {
          const nested = removeConfigSnippet(
            next[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          );
          if (Object.keys(nested).length === 0) {
            delete next[key];
          } else {
            next[key] = nested;
          }
        } else if (next[key] === value) {
          delete next[key];
        }
      }
      return next;
    },
    [],
  );

  const hasConfigSnippet = useCallback(
    (
      configObj: Record<string, unknown>,
      snippetConfig: Record<string, unknown>,
    ) => {
      for (const [key, value] of Object.entries(snippetConfig)) {
        if (!(key in configObj)) return false;
        if (isPlainObject(value) && isPlainObject(configObj[key])) {
          if (
            !hasConfigSnippet(
              configObj[key] as Record<string, unknown>,
              value as Record<string, unknown>,
            )
          ) {
            return false;
          }
        } else if (configObj[key] !== value) {
          return false;
        }
      }
      return true;
    },
    [],
  );

  // 初始化：从 config.json 加载，支持从 localStorage 迁移
  useEffect(() => {
    let mounted = true;

    const loadSnippet = async () => {
      try {
        // 使用统一 API 加载
        const snippet = await configApi.getCommonConfigSnippet("gemini");

        if (snippet && snippet.trim()) {
          if (mounted) {
            setCommonConfigSnippetState(snippet);
          }
        } else {
          // 如果 config.json 中没有，尝试从 localStorage 迁移
          if (typeof window !== "undefined") {
            try {
              const legacySnippet =
                window.localStorage.getItem(LEGACY_STORAGE_KEY);
              if (legacySnippet && legacySnippet.trim()) {
                const parsed = parseSnippet(legacySnippet);
                if (parsed.error) {
                  console.warn(
                    "[迁移] legacy Gemini 通用配置片段格式不符合当前规则，跳过迁移",
                  );
                  return;
                }
                // 迁移到 config.json
                await configApi.setCommonConfigSnippet("gemini", legacySnippet);
                if (mounted) {
                  setCommonConfigSnippetState(legacySnippet);
                }
                // 清理 localStorage
                window.localStorage.removeItem(LEGACY_STORAGE_KEY);
                console.log(
                  "[迁移] Gemini 通用配置已从 localStorage 迁移到 config.json",
                );
              }
            } catch (e) {
              console.warn("[迁移] 从 localStorage 迁移失败:", e);
            }
          }
        }
      } catch (error) {
        console.error("加载 Gemini 通用配置失败:", error);
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    loadSnippet();

    return () => {
      mounted = false;
    };
  }, [parseSnippet]);

  // 初始化时检查通用配置片段（编辑模式）
  useEffect(() => {
    if (!initialData?.settingsConfig || isLoading) return;
    try {
      const env =
        isPlainObject(initialData.settingsConfig.env) &&
        Object.keys(initialData.settingsConfig.env).length > 0
          ? (initialData.settingsConfig.env as Record<string, string>)
          : {};
      const parsed = parseSnippet(commonConfigSnippet);
      if (parsed.error) return;

      const envMatches =
        Object.keys(parsed.env).length === 0 ||
        hasEnvCommonConfigSnippet(env, parsed.env as Record<string, string>);

      const configFromSettings = isPlainObject(
        initialData.settingsConfig.config,
      )
        ? (initialData.settingsConfig.config as Record<string, unknown>)
        : parseConfigValue(configValue);
      const configMatches =
        Object.keys(parsed.config).length === 0 ||
        hasConfigSnippet(configFromSettings, parsed.config);

      setUseCommonConfig(envMatches && configMatches);
    } catch {
      // ignore parse error
    }
  }, [
    commonConfigSnippet,
    hasEnvCommonConfigSnippet,
    hasConfigSnippet,
    initialData,
    isLoading,
    parseSnippet,
    configValue,
    parseConfigValue,
  ]);

  // 新建模式：如果通用配置片段存在且有效，默认启用
  useEffect(() => {
    // 仅新建模式、加载完成、尚未初始化过
    if (!initialData && !isLoading && !hasInitializedNewMode.current) {
      hasInitializedNewMode.current = true;

      const parsed = parseSnippet(commonConfigSnippet);
      if (parsed.error) return;
      const hasContent =
        Object.keys(parsed.env).length > 0 ||
        Object.keys(parsed.config).length > 0;
      if (!hasContent) return;

      setUseCommonConfig(true);
      const currentEnv = envStringToObj(envValue);
      const merged = applySnippetToEnv(currentEnv, parsed.env);
      const nextEnvString = envObjToString(merged);

      isUpdatingFromCommonConfig.current = true;
      onEnvChange(nextEnvString);

      if (configValue !== undefined && onConfigChange) {
        const currentConfig = parseConfigValue(configValue);
        const mergedConfig = mergeConfigSnippet(currentConfig, parsed.config);
        onConfigChange(JSON.stringify(mergedConfig, null, 2));
      }
      setTimeout(() => {
        isUpdatingFromCommonConfig.current = false;
      }, 0);
    }
  }, [
    initialData,
    isLoading,
    commonConfigSnippet,
    envValue,
    envStringToObj,
    envObjToString,
    applySnippetToEnv,
    onEnvChange,
    parseSnippet,
    configValue,
    onConfigChange,
    parseConfigValue,
    mergeConfigSnippet,
  ]);

  // 处理通用配置开关
  const handleCommonConfigToggle = useCallback(
    (checked: boolean) => {
      const parsed = parseSnippet(commonConfigSnippet);
      if (parsed.error) {
        setCommonConfigError(parsed.error);
        setUseCommonConfig(false);
        return;
      }
      if (
        Object.keys(parsed.env).length === 0 &&
        Object.keys(parsed.config).length === 0
      ) {
        setCommonConfigError(t("geminiConfig.noCommonConfigToApply"));
        setUseCommonConfig(false);
        return;
      }

      const currentEnv = envStringToObj(envValue);
      const updatedEnvObj = checked
        ? applySnippetToEnv(currentEnv, parsed.env)
        : removeSnippetFromEnv(currentEnv, parsed.env);

      setCommonConfigError("");
      setUseCommonConfig(checked);

      isUpdatingFromCommonConfig.current = true;
      onEnvChange(envObjToString(updatedEnvObj));
      if (configValue !== undefined && onConfigChange) {
        const currentConfig = parseConfigValue(configValue);
        const updatedConfig = checked
          ? mergeConfigSnippet(currentConfig, parsed.config)
          : removeConfigSnippet(currentConfig, parsed.config);
        onConfigChange(JSON.stringify(updatedConfig, null, 2));
      }
      setTimeout(() => {
        isUpdatingFromCommonConfig.current = false;
      }, 0);
    },
    [
      applySnippetToEnv,
      commonConfigSnippet,
      envObjToString,
      envStringToObj,
      envValue,
      onEnvChange,
      parseSnippet,
      removeSnippetFromEnv,
      t,
      configValue,
      onConfigChange,
      parseConfigValue,
      mergeConfigSnippet,
      removeConfigSnippet,
    ],
  );

  // 处理通用配置片段变化
  const handleCommonConfigSnippetChange = useCallback(
    (value: string) => {
      const previousSnippet = commonConfigSnippet;
      setCommonConfigSnippetState(value);

      if (!value.trim()) {
        setCommonConfigError("");
        // 保存到 config.json（清空）
        configApi
          .setCommonConfigSnippet("gemini", "")
          .catch((error: unknown) => {
            console.error("保存 Gemini 通用配置失败:", error);
            setCommonConfigError(
              t("geminiConfig.saveFailed", { error: String(error) }),
            );
          });

        if (useCommonConfig) {
          const parsed = parseSnippet(previousSnippet);
          if (!parsed.error) {
            const currentEnv = envStringToObj(envValue);
            const updatedEnv = removeSnippetFromEnv(currentEnv, parsed.env);
            onEnvChange(envObjToString(updatedEnv));

            if (configValue !== undefined && onConfigChange) {
              const currentConfig = parseConfigValue(configValue);
              const updatedConfig = removeConfigSnippet(
                currentConfig,
                parsed.config,
              );
              onConfigChange(JSON.stringify(updatedConfig, null, 2));
            }
          }
          setUseCommonConfig(false);
        }
        return;
      }

      // 校验 JSON 格式
      const parsed = parseSnippet(value);
      if (parsed.error) {
        setCommonConfigError(parsed.error);
        return;
      }

      setCommonConfigError("");
      configApi
        .setCommonConfigSnippet("gemini", value)
        .catch((error: unknown) => {
          console.error("保存 Gemini 通用配置失败:", error);
          setCommonConfigError(
            t("geminiConfig.saveFailed", { error: String(error) }),
          );
        });

      // 若当前启用通用配置，需要替换为最新片段
      if (useCommonConfig) {
        const prevParsed = parseSnippet(previousSnippet);
        const prevEnv = prevParsed.error ? {} : prevParsed.env;
        const prevConfig = prevParsed.error ? {} : prevParsed.config;
        const nextEnv = parsed.env;
        const nextConfig = parsed.config;
        const currentEnv = envStringToObj(envValue);

        const withoutOldEnv =
          Object.keys(prevEnv).length > 0
            ? removeSnippetFromEnv(currentEnv, prevEnv)
            : currentEnv;
        const withNewEnv =
          Object.keys(nextEnv).length > 0
            ? applySnippetToEnv(withoutOldEnv, nextEnv)
            : withoutOldEnv;

        isUpdatingFromCommonConfig.current = true;
        onEnvChange(envObjToString(withNewEnv));

        if (configValue !== undefined && onConfigChange) {
          const currentConfig = parseConfigValue(configValue);
          const withoutOldConfig =
            Object.keys(prevConfig).length > 0
              ? removeConfigSnippet(currentConfig, prevConfig)
              : currentConfig;
          const withNewConfig =
            Object.keys(nextConfig).length > 0
              ? mergeConfigSnippet(withoutOldConfig, nextConfig)
              : withoutOldConfig;
          onConfigChange(JSON.stringify(withNewConfig, null, 2));
        }

        setTimeout(() => {
          isUpdatingFromCommonConfig.current = false;
        }, 0);
      }
    },
    [
      applySnippetToEnv,
      commonConfigSnippet,
      envObjToString,
      envStringToObj,
      envValue,
      onEnvChange,
      parseSnippet,
      removeSnippetFromEnv,
      t,
      useCommonConfig,
      configValue,
      onConfigChange,
      parseConfigValue,
      removeConfigSnippet,
      mergeConfigSnippet,
    ],
  );

  // 当 env 变化时检查是否包含通用配置（但避免在通过通用配置更新时检查）
  useEffect(() => {
    if (isUpdatingFromCommonConfig.current || isLoading) {
      return;
    }
    const parsed = parseSnippet(commonConfigSnippet);
    if (parsed.error) return;
    const envObj = envStringToObj(envValue);
    const envMatches =
      Object.keys(parsed.env).length === 0 ||
      hasEnvCommonConfigSnippet(envObj, parsed.env as Record<string, string>);
    const configMatches =
      Object.keys(parsed.config).length === 0 ||
      (configValue !== undefined &&
        hasConfigSnippet(parseConfigValue(configValue), parsed.config));
    setUseCommonConfig(envMatches && configMatches);
  }, [
    envValue,
    commonConfigSnippet,
    envStringToObj,
    hasEnvCommonConfigSnippet,
    isLoading,
    parseSnippet,
    configValue,
    parseConfigValue,
    hasConfigSnippet,
  ]);

  // 从编辑器当前内容提取通用配置片段
  const handleExtract = useCallback(async () => {
    setIsExtracting(true);
    setCommonConfigError("");

    try {
      const extracted = await configApi.extractCommonConfigSnippet("gemini", {
        settingsConfig: JSON.stringify({
          env: envStringToObj(envValue),
          config:
            configValue !== undefined ? parseConfigValue(configValue) : {},
        }),
      });

      if (!extracted || extracted === "{}") {
        setCommonConfigError(t("geminiConfig.extractNoCommonConfig"));
        return;
      }

      // 验证 JSON 格式
      const parsed = parseSnippet(extracted);
      if (parsed.error) {
        setCommonConfigError(t("geminiConfig.extractedConfigInvalid"));
        return;
      }

      // 更新片段状态
      setCommonConfigSnippetState(extracted);

      // 保存到后端
      await configApi.setCommonConfigSnippet("gemini", extracted);
    } catch (error) {
      console.error("提取 Gemini 通用配置失败:", error);
      setCommonConfigError(
        t("geminiConfig.extractFailed", { error: String(error) }),
      );
    } finally {
      setIsExtracting(false);
    }
  }, [
    envStringToObj,
    envValue,
    parseSnippet,
    t,
    configValue,
    parseConfigValue,
  ]);

  return {
    useCommonConfig,
    commonConfigSnippet,
    commonConfigError,
    isLoading,
    isExtracting,
    handleCommonConfigToggle,
    handleCommonConfigSnippetChange,
    handleExtract,
  };
}
