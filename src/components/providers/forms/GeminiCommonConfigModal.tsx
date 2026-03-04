import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Save, Download, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { Button } from "@/components/ui/button";
import JsonEditor from "@/components/JsonEditor";

interface GeminiCommonConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  onExtract?: () => void;
  isExtracting?: boolean;
}

/**
 * GeminiCommonConfigModal - Common Gemini configuration editor modal
 * Allows editing of common env snippet shared across Gemini providers
 */
export const GeminiCommonConfigModal: React.FC<
  GeminiCommonConfigModalProps
> = ({ isOpen, onClose, value, onChange, error, onExtract, isExtracting }) => {
  const { t } = useTranslation();
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    setIsDarkMode(document.documentElement.classList.contains("dark"));

    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains("dark"));
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  const parsedSnippet = useMemo(() => {
    try {
      const parsed = JSON.parse(value || "{}");
      const isObject =
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.prototype.toString.call(parsed) === "[object Object]";
      if (!isObject) {
        return { env: {}, config: {} };
      }
      const hasStructured = "env" in parsed || "config" in parsed;
      const env = hasStructured && parsed.env && typeof parsed.env === "object"
        ? (parsed.env as Record<string, unknown>)
        : !hasStructured
          ? (parsed as Record<string, unknown>)
          : {};
      const config =
        hasStructured && parsed.config && typeof parsed.config === "object"
          ? (parsed.config as Record<string, unknown>)
          : {};
      return { env, config };
    } catch {
      return { env: {}, config: {} };
    }
  }, [value]);

  const toggleStates = useMemo(() => {
    const config = parsedSnippet.config as Record<string, any>;
    return {
      inlineThinking: config?.ui?.inlineThinkingMode === "full",
      showModelInfo: config?.ui?.showModelInfoInChat === true,
      enableAgents: config?.experimental?.enableAgents === true,
    };
  }, [parsedSnippet.config]);

  const handleToggle = useCallback(
    (
      toggleKey: "inlineThinking" | "showModelInfo" | "enableAgents",
      checked: boolean,
    ) => {
      const env = parsedSnippet.env ?? {};
      const config = { ...(parsedSnippet.config as Record<string, any>) };
      if (toggleKey === "inlineThinking") {
        config.ui = config.ui || {};
        if (checked) {
          config.ui.inlineThinkingMode = "full";
        } else {
          delete config.ui.inlineThinkingMode;
        }
        if (Object.keys(config.ui).length === 0) delete config.ui;
      }

      if (toggleKey === "showModelInfo") {
        config.ui = config.ui || {};
        if (checked) {
          config.ui.showModelInfoInChat = true;
        } else {
          delete config.ui.showModelInfoInChat;
        }
        if (Object.keys(config.ui).length === 0) delete config.ui;
      }

      if (toggleKey === "enableAgents") {
        config.experimental = config.experimental || {};
        if (checked) {
          config.experimental.enableAgents = true;
        } else {
          delete config.experimental.enableAgents;
        }
        if (Object.keys(config.experimental).length === 0)
          delete config.experimental;
      }

      const nextSnippet = {
        env,
        config,
      };
      onChange(JSON.stringify(nextSnippet, null, 2));
    },
    [parsedSnippet, onChange],
  );

  return (
    <FullScreenPanel
      isOpen={isOpen}
      title={t("geminiConfig.editCommonConfigTitle", {
        defaultValue: "编辑 Gemini 通用配置片段",
      })}
      onClose={onClose}
      footer={
        <>
          {onExtract && (
            <Button
              type="button"
              variant="outline"
              onClick={onExtract}
              disabled={isExtracting}
              className="gap-2"
            >
              {isExtracting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {t("geminiConfig.extractFromCurrent", {
                defaultValue: "从编辑内容提取",
              })}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={onClose} className="gap-2">
            <Save className="w-4 h-4" />
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("geminiConfig.commonConfigHint", {
            defaultValue:
              "该片段支持 env / config 两部分（env 不允许包含 GOOGLE_GEMINI_BASE_URL、GEMINI_API_KEY）",
          })}
        </p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={toggleStates.inlineThinking}
              onChange={(e) => handleToggle("inlineThinking", e.target.checked)}
              className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
            />
            <span>
              {t("geminiConfig.inlineThinking", {
                defaultValue: "扩展思考",
              })}
            </span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={toggleStates.showModelInfo}
              onChange={(e) => handleToggle("showModelInfo", e.target.checked)}
              className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
            />
            <span>
              {t("geminiConfig.showModelInfo", {
                defaultValue: "显示模型信息",
              })}
            </span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={toggleStates.enableAgents}
              onChange={(e) => handleToggle("enableAgents", e.target.checked)}
              className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
            />
            <span>
              {t("geminiConfig.enableAgents", {
                defaultValue: "启用代理模式",
              })}
            </span>
          </label>
        </div>

        <JsonEditor
          value={value}
          onChange={onChange}
          placeholder={`{
  "env": {
    "GEMINI_MODEL": "gemini-3-pro-preview"
  },
  "config": {
    "ui": {
      "inlineThinkingMode": "full"
    }
  }
}`}
          darkMode={isDarkMode}
          rows={16}
          showValidation={true}
          language="json"
        />

        {error && (
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
        )}
      </div>
    </FullScreenPanel>
  );
};
