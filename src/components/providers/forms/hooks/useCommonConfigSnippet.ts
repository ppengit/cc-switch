import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  getDefaultJsonCommonConfigTemplate,
  normalizeJsonCommonConfigTemplateForEditing,
  parseJsonCommonConfigTemplate,
  validateJsonCommonConfigTemplate,
} from "@/utils/providerConfigUtils";
import { configApi } from "@/lib/api";

const LEGACY_STORAGE_KEY = "cc-switch:common-config-snippet";

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
    getDefaultJsonCommonConfigTemplate("claude"),
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
            setCommonConfigSnippetState(
              normalizeJsonCommonConfigTemplateForEditing("claude", snippet),
            );
          }
          return;
        }

        if (typeof window !== "undefined") {
          try {
            const legacySnippet =
              window.localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacySnippet && legacySnippet.trim()) {
              const normalizedLegacySnippet =
                normalizeJsonCommonConfigTemplateForEditing(
                  "claude",
                  legacySnippet,
                );
              await configApi.setCommonConfigSnippet(
                "claude",
                normalizedLegacySnippet,
              );
              if (mounted) {
                setCommonConfigSnippetState(normalizedLegacySnippet);
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

    const validationError = validateJsonCommonConfigTemplate(
      "claude",
      commonConfigSnippet,
      "应用配置模板",
    );
    if (validationError) {
      return false;
    }

    try {
      const parsed = parseJsonCommonConfigTemplate(
        "claude",
        commonConfigSnippet,
      );
      if ("error" in parsed) {
        return false;
      }
      return (
        Object.keys(parsed.result.commonConfig).length > 0 ||
        parsed.result.hasMcpPlaceholder
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

      const validationError = validateJsonCommonConfigTemplate(
        "claude",
        value,
        "应用配置模板",
      );
      if (validationError) {
        setCommonConfigError(validationError);
        return;
      }

      setCommonConfigError("");
      setCommonConfigSnippetState(
        normalizeJsonCommonConfigTemplateForEditing("claude", value),
      );
      configApi
        .setCommonConfigSnippet(
          "claude",
          normalizeJsonCommonConfigTemplateForEditing("claude", value),
        )
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

      const normalizedExtracted = normalizeJsonCommonConfigTemplateForEditing(
        "claude",
        extracted,
      );
      const validationError = validateJsonCommonConfigTemplate(
        "claude",
        normalizedExtracted,
        "提取的配置",
      );
      if (validationError) {
        setCommonConfigError(validationError);
        return;
      }

      setCommonConfigSnippetState(normalizedExtracted);
      await configApi.setCommonConfigSnippet("claude", normalizedExtracted);
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
