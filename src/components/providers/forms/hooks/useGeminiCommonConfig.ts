import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { configApi } from "@/lib/api";
import {
  getDefaultJsonCommonConfigTemplate,
  normalizeJsonCommonConfigTemplateForEditing,
  parseJsonCommonConfigTemplate,
} from "@/utils/providerConfigUtils";

const LEGACY_STORAGE_KEY = "cc-switch:gemini-common-config-snippet";

const GEMINI_COMMON_ENV_FORBIDDEN_KEYS = [
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_API_KEY",
] as const;
type GeminiForbiddenEnvKey = (typeof GEMINI_COMMON_ENV_FORBIDDEN_KEYS)[number];

interface UseGeminiCommonConfigProps {
  envValue: string;
  configValue: string;
  onEnvChange: (env: string) => void;
  envStringToObj: (envString: string) => Record<string, string>;
  envObjToString: (envObj: Record<string, unknown>) => string;
  initialData?: {
    settingsConfig?: Record<string, unknown>;
  };
  initialEnabled?: boolean;
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
 * 管理 Gemini 应用配置模板（JSON 格式）
 * 仅负责加载、校验、保存模板本身，不再把模板内容写回供应商 env 片段。
 */
export function useGeminiCommonConfig({
  envValue,
  configValue,
  onEnvChange,
  envStringToObj,
  envObjToString,
  initialData,
  initialEnabled,
  selectedPresetId,
}: UseGeminiCommonConfigProps) {
  void onEnvChange;
  void envObjToString;
  void initialData;
  void initialEnabled;
  void selectedPresetId;

  const { t } = useTranslation();
  const [commonConfigSnippet, setCommonConfigSnippetState] = useState<string>(
    getDefaultJsonCommonConfigTemplate("gemini"),
  );
  const [commonConfigError, setCommonConfigError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);

  const parseSnippet = useCallback(
    (
      snippetString: string,
    ): {
      env: Record<string, string>;
      config: Record<string, unknown>;
      hasContent: boolean;
      normalizedValue: string;
      error?: string;
    } => {
      const trimmed = snippetString.trim();
      if (!trimmed) {
        return {
          env: {},
          config: {},
          hasContent: false,
          normalizedValue: "",
        };
      }

      const templateParsed = parseJsonCommonConfigTemplate("gemini", trimmed);
      if ("error" in templateParsed) {
        return {
          env: {},
          config: {},
          hasContent: false,
          normalizedValue: "",
          error: templateParsed.error,
        };
      }

      const parsed = templateParsed.result.commonConfig;

      const hasStructuredSections =
        Object.prototype.hasOwnProperty.call(parsed, "env") ||
        Object.prototype.hasOwnProperty.call(parsed, "config");

      const envSection = hasStructuredSections ? parsed.env : parsed;
      const configSection = hasStructuredSections ? parsed.config : {};

      if (
        envSection !== undefined &&
        (!isPlainObject(envSection) || Array.isArray(envSection))
      ) {
        return {
          env: {},
          config: {},
          hasContent: false,
          normalizedValue: "",
          error: t("geminiConfig.invalidJsonFormat"),
        };
      }

      if (
        configSection !== undefined &&
        (!isPlainObject(configSection) || Array.isArray(configSection))
      ) {
        return {
          env: {},
          config: {},
          hasContent: false,
          normalizedValue: "",
          error: t("geminiConfig.invalidJsonFormat"),
        };
      }

      const envObject = isPlainObject(envSection)
        ? (envSection as Record<string, unknown>)
        : {};
      const keys = Object.keys(envObject);
      const forbiddenKeys = keys.filter((key) =>
        GEMINI_COMMON_ENV_FORBIDDEN_KEYS.includes(key as GeminiForbiddenEnvKey),
      );
      if (forbiddenKeys.length > 0) {
        return {
          env: {},
          config: {},
          hasContent: false,
          normalizedValue: "",
          error: t("geminiConfig.commonConfigInvalidKeys", {
            keys: forbiddenKeys.join(", "),
          }),
        };
      }

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(envObject)) {
        if (typeof value !== "string") {
          return {
            env: {},
            config: {},
            hasContent: false,
            normalizedValue: "",
            error: t("geminiConfig.commonConfigInvalidValues"),
          };
        }
        const normalized = value.trim();
        if (!normalized) continue;
        env[key] = normalized;
      }

      const config = isPlainObject(configSection)
        ? (configSection as Record<string, unknown>)
        : {};
      const normalizedPayload: Record<string, unknown> = {};
      if (Object.keys(env).length > 0) {
        normalizedPayload.env = env;
      }
      if (Object.keys(config).length > 0) {
        normalizedPayload.config = config;
      }
      if (templateParsed.result.hasMcpPlaceholder) {
        normalizedPayload.mcpServers = "{{mcp.config}}";
      }

      return {
        env,
        config,
        hasContent:
          Object.keys(env).length > 0 ||
          Object.keys(config).length > 0 ||
          templateParsed.result.hasMcpPlaceholder,
        normalizedValue: JSON.stringify(
          {
            "{{provider.config}}": {},
            ...normalizedPayload,
          },
          null,
          2,
        ),
      };
    },
    [t],
  );

  useEffect(() => {
    let mounted = true;

    const loadSnippet = async () => {
      try {
        const snippet = await configApi.getCommonConfigSnippet("gemini");

        if (snippet && snippet.trim()) {
          const parsed = parseSnippet(snippet);
          if (mounted) {
            setCommonConfigSnippetState(
              parsed.error
                ? snippet
                : normalizeJsonCommonConfigTemplateForEditing(
                    "gemini",
                    parsed.normalizedValue,
                  ),
            );
          }
          return;
        }

        if (typeof window !== "undefined") {
          try {
            const legacySnippet =
              window.localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacySnippet && legacySnippet.trim()) {
              const parsed = parseSnippet(
                normalizeJsonCommonConfigTemplateForEditing(
                  "gemini",
                  legacySnippet,
                ),
              );
              if (parsed.error) {
                console.warn(
                  "[迁移] legacy Gemini 通用配置片段格式不符合当前规则，跳过迁移",
                );
                return;
              }
              await configApi.setCommonConfigSnippet(
                "gemini",
                parsed.normalizedValue,
              );
              if (mounted) {
                setCommonConfigSnippetState(parsed.normalizedValue);
              }
              window.localStorage.removeItem(LEGACY_STORAGE_KEY);
              console.log(
                "[迁移] Gemini 通用配置已从 localStorage 迁移到 config.json",
              );
            }
          } catch (error) {
            console.warn("[迁移] 从 localStorage 迁移失败:", error);
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

    void loadSnippet();

    return () => {
      mounted = false;
    };
  }, [parseSnippet]);

  const useCommonConfig = useMemo(() => {
    const parsed = parseSnippet(commonConfigSnippet);
    return !parsed.error && parsed.hasContent;
  }, [commonConfigSnippet, parseSnippet]);

  const handleCommonConfigToggle = useCallback((checked: boolean) => {
    void checked;
  }, []);

  const handleCommonConfigSnippetChange = useCallback(
    (value: string): boolean => {
      if (!value.trim()) {
        setCommonConfigError("");
        setCommonConfigSnippetState("");
        configApi
          .setCommonConfigSnippet("gemini", "")
          .catch((error: unknown) => {
            console.error("保存 Gemini 通用配置失败:", error);
            setCommonConfigError(
              t("geminiConfig.saveFailed", { error: String(error) }),
            );
          });
        return true;
      }

      const parsed = parseSnippet(value);
      if (parsed.error) {
        setCommonConfigError(parsed.error);
        return false;
      }

      setCommonConfigError("");
      setCommonConfigSnippetState(
        normalizeJsonCommonConfigTemplateForEditing(
          "gemini",
          parsed.normalizedValue,
        ),
      );
      configApi
        .setCommonConfigSnippet(
          "gemini",
          normalizeJsonCommonConfigTemplateForEditing(
            "gemini",
            parsed.normalizedValue,
          ),
        )
        .catch((error: unknown) => {
          console.error("保存 Gemini 通用配置失败:", error);
          setCommonConfigError(
            t("geminiConfig.saveFailed", { error: String(error) }),
          );
        });

      return true;
    },
    [parseSnippet, t],
  );

  const handleExtract = useCallback(async () => {
    setIsExtracting(true);
    setCommonConfigError("");

    try {
      const currentConfig = configValue.trim() ? JSON.parse(configValue) : {};
      const extracted = await configApi.extractCommonConfigSnippet("gemini", {
        settingsConfig: JSON.stringify({
          env: envStringToObj(envValue),
          config: currentConfig,
        }),
      });

      if (!extracted || extracted === "{}") {
        setCommonConfigError(t("geminiConfig.extractNoCommonConfig"));
        return;
      }

      const parsed = parseSnippet(
        normalizeJsonCommonConfigTemplateForEditing("gemini", extracted),
      );
      if (parsed.error) {
        setCommonConfigError(t("geminiConfig.extractedConfigInvalid"));
        return;
      }

      const normalizedValue = normalizeJsonCommonConfigTemplateForEditing(
        "gemini",
        parsed.normalizedValue,
      );
      setCommonConfigSnippetState(normalizedValue);
      await configApi.setCommonConfigSnippet("gemini", normalizedValue);
    } catch (error) {
      console.error("提取 Gemini 通用配置失败:", error);
      setCommonConfigError(
        t("geminiConfig.extractFailed", { error: String(error) }),
      );
    } finally {
      setIsExtracting(false);
    }
  }, [configValue, envStringToObj, envValue, parseSnippet, t]);

  const clearCommonConfigError = useCallback(() => {
    setCommonConfigError("");
  }, []);

  return {
    useCommonConfig,
    commonConfigSnippet,
    commonConfigError,
    isLoading,
    isExtracting,
    handleCommonConfigToggle,
    handleCommonConfigSnippetChange,
    handleExtract,
    clearCommonConfigError,
  };
}
