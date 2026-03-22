import { useState, useEffect, useCallback, useMemo } from "react";
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
    DEFAULT_GEMINI_COMMON_CONFIG_SNIPPET,
  );
  const [commonConfigError, setCommonConfigError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);

  const parseSnippetEnv = useCallback(
    (
      snippetString: string,
    ): { env: Record<string, string>; error?: string } => {
      const trimmed = snippetString.trim();
      if (!trimmed) {
        return { env: {} };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return { env: {}, error: t("geminiConfig.invalidJsonFormat") };
      }

      if (!isPlainObject(parsed)) {
        return { env: {}, error: t("geminiConfig.invalidJsonFormat") };
      }

      const keys = Object.keys(parsed);
      const forbiddenKeys = keys.filter((key) =>
        GEMINI_COMMON_ENV_FORBIDDEN_KEYS.includes(key as GeminiForbiddenEnvKey),
      );
      if (forbiddenKeys.length > 0) {
        return {
          env: {},
          error: t("geminiConfig.commonConfigInvalidKeys", {
            keys: forbiddenKeys.join(", "),
          }),
        };
      }

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
          return {
            env: {},
            error: t("geminiConfig.commonConfigInvalidValues"),
          };
        }
        const normalized = value.trim();
        if (!normalized) continue;
        env[key] = normalized;
      }

      return { env };
    },
    [t],
  );

  useEffect(() => {
    let mounted = true;

    const loadSnippet = async () => {
      try {
        const snippet = await configApi.getCommonConfigSnippet("gemini");

        if (snippet && snippet.trim()) {
          if (mounted) {
            setCommonConfigSnippetState(snippet);
          }
          return;
        }

        if (typeof window !== "undefined") {
          try {
            const legacySnippet =
              window.localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacySnippet && legacySnippet.trim()) {
              const parsed = parseSnippetEnv(legacySnippet);
              if (parsed.error) {
                console.warn(
                  "[迁移] legacy Gemini 通用配置片段格式不符合当前规则，跳过迁移",
                );
                return;
              }
              await configApi.setCommonConfigSnippet("gemini", legacySnippet);
              if (mounted) {
                setCommonConfigSnippetState(legacySnippet);
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
  }, [parseSnippetEnv]);

  const useCommonConfig = useMemo(() => {
    const parsed = parseSnippetEnv(commonConfigSnippet);
    return !parsed.error && Object.keys(parsed.env).length > 0;
  }, [commonConfigSnippet, parseSnippetEnv]);

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

      const parsed = parseSnippetEnv(value);
      if (parsed.error) {
        setCommonConfigError(parsed.error);
        return false;
      }

      setCommonConfigError("");
      setCommonConfigSnippetState(value);
      configApi
        .setCommonConfigSnippet("gemini", value)
        .catch((error: unknown) => {
          console.error("保存 Gemini 通用配置失败:", error);
          setCommonConfigError(
            t("geminiConfig.saveFailed", { error: String(error) }),
          );
        });

      return true;
    },
    [parseSnippetEnv, t],
  );

  const handleExtract = useCallback(async () => {
    setIsExtracting(true);
    setCommonConfigError("");

    try {
      const extracted = await configApi.extractCommonConfigSnippet("gemini", {
        settingsConfig: JSON.stringify({
          env: envStringToObj(envValue),
        }),
      });

      if (!extracted || extracted === "{}") {
        setCommonConfigError(t("geminiConfig.extractNoCommonConfig"));
        return;
      }

      const parsed = parseSnippetEnv(extracted);
      if (parsed.error) {
        setCommonConfigError(t("geminiConfig.extractedConfigInvalid"));
        return;
      }

      setCommonConfigSnippetState(extracted);
      await configApi.setCommonConfigSnippet("gemini", extracted);
    } catch (error) {
      console.error("提取 Gemini 通用配置失败:", error);
      setCommonConfigError(
        t("geminiConfig.extractFailed", { error: String(error) }),
      );
    } finally {
      setIsExtracting(false);
    }
  }, [envStringToObj, envValue, parseSnippetEnv, t]);

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
