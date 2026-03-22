import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { validateJsonConfig } from "@/utils/providerConfigUtils";
import { configApi } from "@/lib/api";

const LEGACY_STORAGE_KEY = "cc-switch:common-config-snippet";
const DEFAULT_COMMON_CONFIG_SNIPPET = `{
  "includeCoAuthoredBy": false
}`;

interface UseCommonConfigSnippetProps {
  settingsConfig: string;
  onConfigChange: (config: string) => void;
  initialData?: {
    settingsConfig?: Record<string, unknown>;
  };
  initialEnabled?: boolean;
  selectedPresetId?: string;
  enabled?: boolean;
}

/**
 * 管理 Claude 应用配置模板
 * 仅负责加载、校验、保存模板本身，不再把模板内容写回供应商 settingsConfig。
 */
export function useCommonConfigSnippet({
  settingsConfig,
  onConfigChange,
  initialData,
  initialEnabled,
  selectedPresetId,
  enabled = true,
}: UseCommonConfigSnippetProps) {
  void onConfigChange;
  void initialData;
  void initialEnabled;
  void selectedPresetId;

  const { t } = useTranslation();
  const [commonConfigSnippet, setCommonConfigSnippetState] = useState<string>(
    DEFAULT_COMMON_CONFIG_SNIPPET,
  );
  const [commonConfigError, setCommonConfigError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    let mounted = true;

    const loadSnippet = async () => {
      try {
        const snippet = await configApi.getCommonConfigSnippet("claude");

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
              await configApi.setCommonConfigSnippet("claude", legacySnippet);
              if (mounted) {
                setCommonConfigSnippetState(legacySnippet);
              }
              window.localStorage.removeItem(LEGACY_STORAGE_KEY);
              console.log(
                "[迁移] Claude 通用配置已从 localStorage 迁移到 config.json",
              );
            }
          } catch (error) {
            console.warn("[迁移] 从 localStorage 迁移失败:", error);
          }
        }
      } catch (error) {
        console.error("加载通用配置失败:", error);
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
  }, [enabled]);

  const useCommonConfig = useMemo(() => {
    if (!enabled) return false;

    const validationError = validateJsonConfig(
      commonConfigSnippet,
      "应用配置模板",
    );
    if (validationError) {
      return false;
    }

    try {
      const parsed = JSON.parse(commonConfigSnippet);
      return (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length > 0
      );
    } catch {
      return false;
    }
  }, [commonConfigSnippet, enabled]);

  const handleCommonConfigToggle = useCallback((checked: boolean) => {
    void checked;
  }, []);

  const handleCommonConfigSnippetChange = useCallback(
    (value: string) => {
      if (!value.trim()) {
        setCommonConfigError("");
        setCommonConfigSnippetState("");
        configApi
          .setCommonConfigSnippet("claude", "")
          .catch((error: unknown) => {
            console.error("保存通用配置失败:", error);
            setCommonConfigError(
              t("claudeConfig.saveFailed", { error: String(error) }),
            );
          });
        return;
      }

      const validationError = validateJsonConfig(value, "应用配置模板");
      if (validationError) {
        setCommonConfigError(validationError);
        return;
      }

      setCommonConfigError("");
      setCommonConfigSnippetState(value);
      configApi
        .setCommonConfigSnippet("claude", value)
        .catch((error: unknown) => {
          console.error("保存通用配置失败:", error);
          setCommonConfigError(
            t("claudeConfig.saveFailed", { error: String(error) }),
          );
        });
    },
    [t],
  );

  const handleExtract = useCallback(async () => {
    setIsExtracting(true);
    setCommonConfigError("");

    try {
      const extracted = await configApi.extractCommonConfigSnippet("claude", {
        settingsConfig,
      });

      if (!extracted || extracted === "{}") {
        setCommonConfigError(t("claudeConfig.extractNoCommonConfig"));
        return;
      }

      const validationError = validateJsonConfig(extracted, "提取的配置");
      if (validationError) {
        setCommonConfigError(validationError);
        return;
      }

      setCommonConfigSnippetState(extracted);
      await configApi.setCommonConfigSnippet("claude", extracted);
    } catch (error) {
      console.error("提取通用配置失败:", error);
      setCommonConfigError(
        t("claudeConfig.extractFailed", { error: String(error) }),
      );
    } finally {
      setIsExtracting(false);
    }
  }, [settingsConfig, t]);

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
