import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { configApi } from "@/lib/api";
import {
  getDefaultCodexCommonConfigSnippet,
  normalizeCodexCommonConfigSnippetForEditing,
  validateCodexCommonConfigSnippet,
} from "@/utils/providerConfigUtils";

const LEGACY_STORAGE_KEY = "cc-switch:codex-common-config-snippet";

interface UseCodexCommonConfigProps {
  codexConfig: string;
  onConfigChange: (config: string) => void;
  initialData?: {
    settingsConfig?: Record<string, unknown>;
  };
  initialEnabled?: boolean;
  selectedPresetId?: string;
}

/**
 * 管理 Codex 应用配置模板（TOML 格式）
 * 仅负责加载、校验、保存模板本身，不再把模板内容写回供应商 config.toml 片段。
 */
export function useCodexCommonConfig({
  codexConfig,
  onConfigChange,
  initialData,
  initialEnabled,
  selectedPresetId,
}: UseCodexCommonConfigProps) {
  void onConfigChange;
  void initialData;
  void initialEnabled;
  void selectedPresetId;

  const { t } = useTranslation();
  const [commonConfigSnippet, setCommonConfigSnippetState] = useState<string>(
    getDefaultCodexCommonConfigSnippet(),
  );
  const [commonConfigError, setCommonConfigError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);

  const parseCommonConfigSnippet = useCallback((snippetString: string) => {
    const trimmed = snippetString.trim();
    if (!trimmed) {
      return {
        hasContent: false,
      };
    }

    const validationError = validateCodexCommonConfigSnippet(snippetString);
    if (validationError) {
      return {
        hasContent: false,
        error: validationError,
      };
    }

    return {
      hasContent: true,
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadSnippet = async () => {
      try {
        const snippet = await configApi.getCommonConfigSnippet("codex");

        if (snippet && snippet.trim()) {
          if (mounted) {
            setCommonConfigSnippetState(
              normalizeCodexCommonConfigSnippetForEditing(snippet),
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
                normalizeCodexCommonConfigSnippetForEditing(legacySnippet);
              await configApi.setCommonConfigSnippet(
                "codex",
                normalizedLegacySnippet,
              );
              if (mounted) {
                setCommonConfigSnippetState(normalizedLegacySnippet);
              }
              window.localStorage.removeItem(LEGACY_STORAGE_KEY);
              console.log(
                "[迁移] Codex 通用配置已从 localStorage 迁移到 config.json",
              );
            }
          } catch (error) {
            console.warn("[迁移] 从 localStorage 迁移失败:", error);
          }
        }
      } catch (error) {
        console.error("加载 Codex 通用配置失败:", error);
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
  }, []);

  const useCommonConfig = useMemo(() => {
    const parsed = parseCommonConfigSnippet(commonConfigSnippet);
    return !parsed.error && parsed.hasContent;
  }, [commonConfigSnippet, parseCommonConfigSnippet]);

  const handleCommonConfigToggle = useCallback((checked: boolean) => {
    void checked;
  }, []);

  const handleCommonConfigSnippetChange = useCallback(
    (value: string): boolean => {
      if (!value.trim()) {
        setCommonConfigError("");
        setCommonConfigSnippetState("");
        configApi
          .setCommonConfigSnippet("codex", "")
          .catch((error: unknown) => {
            console.error("保存 Codex 通用配置失败:", error);
            setCommonConfigError(
              t("codexConfig.saveFailed", { error: String(error) }),
            );
          });
        return true;
      }

      const parsed = parseCommonConfigSnippet(value);
      if (parsed.error) {
        setCommonConfigError(parsed.error);
        return false;
      }

      setCommonConfigError("");
      setCommonConfigSnippetState(value);
      configApi
        .setCommonConfigSnippet("codex", value)
        .catch((error: unknown) => {
          console.error("保存 Codex 通用配置失败:", error);
          setCommonConfigError(
            t("codexConfig.saveFailed", { error: String(error) }),
          );
        });

      return true;
    },
    [parseCommonConfigSnippet, t],
  );

  const handleExtract = useCallback(async () => {
    setIsExtracting(true);
    setCommonConfigError("");

    try {
      const extracted = await configApi.extractCommonConfigSnippet("codex", {
        settingsConfig: JSON.stringify({
          config: codexConfig ?? "",
        }),
      });

      if (!extracted || !extracted.trim()) {
        setCommonConfigError(t("codexConfig.extractNoCommonConfig"));
        return;
      }

      const parsed = parseCommonConfigSnippet(extracted);
      if (parsed.error) {
        setCommonConfigError(parsed.error);
        return;
      }

      setCommonConfigSnippetState(extracted);
      await configApi.setCommonConfigSnippet("codex", extracted);
    } catch (error) {
      console.error("提取 Codex 通用配置失败:", error);
      setCommonConfigError(
        t("codexConfig.extractFailed", { error: String(error) }),
      );
    } finally {
      setIsExtracting(false);
    }
  }, [codexConfig, parseCommonConfigSnippet, t]);

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
