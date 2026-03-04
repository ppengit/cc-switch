import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import JsonEditor from "@/components/JsonEditor";

interface GeminiEnvSectionProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  useCommonConfig: boolean;
  onCommonConfigToggle: (checked: boolean) => void;
  onEditCommonConfig: () => void;
  commonConfigError?: string;
}

/**
 * GeminiEnvSection - .env editor section for Gemini environment variables
 */
export const GeminiEnvSection: React.FC<GeminiEnvSectionProps> = ({
  value,
  onChange,
  onBlur,
  error,
  useCommonConfig,
  onCommonConfigToggle,
  onEditCommonConfig,
  commonConfigError,
}) => {
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

  const handleChange = (newValue: string) => {
    onChange(newValue);
    if (onBlur) {
      onBlur();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label
          htmlFor="geminiEnv"
          className="block text-sm font-medium text-foreground"
        >
          {t("geminiConfig.envFile", { defaultValue: "环境变量 (.env)" })}
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={useCommonConfig}
            onChange={(e) => onCommonConfigToggle(e.target.checked)}
            className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
          />
          {t("geminiConfig.writeCommonConfig", {
            defaultValue: "写入通用配置",
          })}
        </label>
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onEditCommonConfig}
          className="text-xs text-blue-500 dark:text-blue-400 hover:underline"
        >
          {t("geminiConfig.editCommonConfig", {
            defaultValue: "编辑通用配置",
          })}
        </button>
      </div>

      {commonConfigError && (
        <p className="text-xs text-red-500 dark:text-red-400 text-right">
          {commonConfigError}
        </p>
      )}

      <JsonEditor
        value={value}
        onChange={handleChange}
        placeholder={`GOOGLE_GEMINI_BASE_URL=https://your-api-endpoint.com/
GEMINI_API_KEY=sk-your-api-key-here
GEMINI_MODEL=gemini-3-pro-preview`}
        darkMode={isDarkMode}
        rows={6}
        showValidation={false}
        language="javascript"
      />

      {error && (
        <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
      )}

      {!error && (
        <p className="text-xs text-muted-foreground">
          {t("geminiConfig.envFileHint", {
            defaultValue: "使用 .env 格式配置 Gemini 环境变量",
          })}
        </p>
      )}
    </div>
  );
};

interface GeminiConfigSectionProps {
  value: string;
  onChange: (value: string) => void;
  configError?: string;
}

/**
 * GeminiConfigSection - Config JSON editor section with common config support
 */
export const GeminiConfigSection: React.FC<GeminiConfigSectionProps> = ({
  value,
  onChange,
  configError,
}) => {
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

  const toggleStates = useMemo(() => {
    try {
      const config = JSON.parse(value || "{}");
      return {
        inlineThinking: config?.ui?.inlineThinkingMode === "full",
        showModelInfo: config?.ui?.showModelInfoInChat === true,
        enableAgents: config?.experimental?.enableAgents === true,
      };
    } catch {
      return {
        inlineThinking: false,
        showModelInfo: false,
        enableAgents: false,
      };
    }
  }, [value]);

  const handleToggle = useCallback(
    (
      toggleKey: "inlineThinking" | "showModelInfo" | "enableAgents",
      checked: boolean,
    ) => {
      try {
        const config = JSON.parse(value || "{}");
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

        onChange(JSON.stringify(config, null, 2));
      } catch {
        // ignore invalid JSON
      }
    },
    [value, onChange],
  );

  return (
    <div className="space-y-2">
      <label
        htmlFor="geminiConfig"
        className="block text-sm font-medium text-foreground"
      >
        {t("geminiConfig.configJson", {
          defaultValue: "配置文件 (config.json)",
        })}
      </label>

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
  "timeout": 30000,
  "maxRetries": 3
}`}
        darkMode={isDarkMode}
        rows={8}
        showValidation={true}
        language="json"
      />

      {configError && (
        <p className="text-xs text-red-500 dark:text-red-400">{configError}</p>
      )}

      {!configError && (
        <p className="text-xs text-muted-foreground">
          {t("geminiConfig.configJsonHint", {
            defaultValue: "使用 JSON 格式配置 Gemini 扩展参数（可选）",
          })}
        </p>
      )}
    </div>
  );
};
