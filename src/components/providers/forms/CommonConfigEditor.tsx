import { useTranslation } from "react-i18next";
import { useEffect, useState, useCallback, useMemo } from "react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Save, Download, Loader2 } from "lucide-react";
import JsonEditor from "@/components/JsonEditor";
import { QuickConfigToggle } from "@/components/providers/forms/QuickConfigToggle";
import {
  CLAUDE_QUICK_TOGGLE_OPTIONS,
  type ClaudeQuickToggleKey,
} from "@/components/providers/forms/configQuickToggles";

interface CommonConfigEditorProps {
  value: string;
  onChange: (value: string) => void;
  useCommonConfig: boolean;
  onCommonConfigToggle: (checked: boolean) => void;
  commonConfigSnippet: string;
  onCommonConfigSnippetChange: (value: string) => void;
  commonConfigError: string;
  onEditClick: () => void;
  isModalOpen: boolean;
  onModalClose: () => void;
  onExtract?: () => void;
  isExtracting?: boolean;
}

export function CommonConfigEditor({
  value,
  onChange,
  useCommonConfig,
  onCommonConfigToggle,
  commonConfigSnippet,
  onCommonConfigSnippetChange,
  commonConfigError,
  onEditClick,
  isModalOpen,
  onModalClose,
  onExtract,
  isExtracting,
}: CommonConfigEditorProps) {
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

  // Mirror value prop to local state so checkbox toggles and JsonEditor stay in sync
  // (parent uses form.getValues which doesn't trigger re-renders)
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleLocalChange = useCallback(
    (newValue: string) => {
      setLocalValue(newValue);
      onChange(newValue);
    },
    [onChange],
  );

  const toggleStates = useMemo(() => {
    try {
      const config = JSON.parse(localValue);
      return {
        hideAttribution:
          config?.attribution?.commit === "" && config?.attribution?.pr === "",
        alwaysThinking: config?.alwaysThinkingEnabled === true,
        teammates:
          config?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1" ||
          config?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 1,
        skipAllPermissions:
          config?.permissions?.defaultMode === "bypassPermissions",
        fastMode: config?.fastMode === true,
      };
    } catch {
      return {
        hideAttribution: false,
        alwaysThinking: false,
        teammates: false,
        skipAllPermissions: false,
        fastMode: false,
      };
    }
  }, [localValue]);

  const handleToggle = useCallback(
    (toggleKey: ClaudeQuickToggleKey, checked: boolean) => {
      try {
        const config = JSON.parse(localValue || "{}");

        switch (toggleKey) {
          case "hideAttribution":
            if (checked) {
              config.attribution = { commit: "", pr: "" };
            } else {
              delete config.attribution;
            }
            break;
          case "alwaysThinking":
            if (checked) {
              config.alwaysThinkingEnabled = true;
            } else {
              delete config.alwaysThinkingEnabled;
            }
            break;
          case "teammates":
            if (!config.env) config.env = {};
            if (checked) {
              config.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
            } else {
              delete config.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
              if (Object.keys(config.env).length === 0) delete config.env;
            }
            break;
          case "skipAllPermissions":
            if (!config.permissions) config.permissions = {};
            if (checked) {
              config.permissions.defaultMode = "bypassPermissions";
              delete config.permissions.disableBypassPermissionsMode;
            } else {
              if (config.permissions.defaultMode === "bypassPermissions") {
                delete config.permissions.defaultMode;
              }
            }
            if (Object.keys(config.permissions).length === 0)
              delete config.permissions;
            break;
          case "fastMode":
            if (checked) {
              config.fastMode = true;
            } else {
              delete config.fastMode;
            }
            break;
        }

        handleLocalChange(JSON.stringify(config, null, 2));
      } catch {
        // Don't modify if JSON is invalid
      }
    },
    [localValue, handleLocalChange],
  );

  const snippetToggleStates = useMemo(() => {
    try {
      const config = JSON.parse(commonConfigSnippet || "{}");
      return {
        hideAttribution:
          config?.attribution?.commit === "" && config?.attribution?.pr === "",
        alwaysThinking: config?.alwaysThinkingEnabled === true,
        teammates:
          config?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1" ||
          config?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 1,
        skipAllPermissions:
          config?.permissions?.defaultMode === "bypassPermissions",
        fastMode: config?.fastMode === true,
      };
    } catch {
      return {
        hideAttribution: false,
        alwaysThinking: false,
        teammates: false,
        skipAllPermissions: false,
        fastMode: false,
      };
    }
  }, [commonConfigSnippet]);

  const handleSnippetToggle = useCallback(
    (toggleKey: ClaudeQuickToggleKey, checked: boolean) => {
      try {
        const config = JSON.parse(commonConfigSnippet || "{}");

        switch (toggleKey) {
          case "hideAttribution":
            if (checked) {
              config.attribution = { commit: "", pr: "" };
            } else {
              delete config.attribution;
            }
            break;
          case "alwaysThinking":
            if (checked) {
              config.alwaysThinkingEnabled = true;
            } else {
              delete config.alwaysThinkingEnabled;
            }
            break;
          case "teammates":
            if (!config.env) config.env = {};
            if (checked) {
              config.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
            } else {
              delete config.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
              if (Object.keys(config.env).length === 0) delete config.env;
            }
            break;
          case "skipAllPermissions":
            if (!config.permissions) config.permissions = {};
            if (checked) {
              config.permissions.defaultMode = "bypassPermissions";
              delete config.permissions.disableBypassPermissionsMode;
            } else {
              if (config.permissions.defaultMode === "bypassPermissions") {
                delete config.permissions.defaultMode;
              }
            }
            if (Object.keys(config.permissions).length === 0)
              delete config.permissions;
            break;
          case "fastMode":
            if (checked) {
              config.fastMode = true;
            } else {
              delete config.fastMode;
            }
            break;
        }

        onCommonConfigSnippetChange(JSON.stringify(config, null, 2));
      } catch {
        // invalid JSON
      }
    },
    [commonConfigSnippet, onCommonConfigSnippetChange],
  );

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="settingsConfig">{t("provider.configJson")}</Label>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                id="useCommonConfig"
                checked={useCommonConfig}
                onChange={(e) => onCommonConfigToggle(e.target.checked)}
                className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
              />
              <span>
                {t("claudeConfig.writeCommonConfig", {
                  defaultValue: "写入通用配置",
                })}
              </span>
            </label>
          </div>
        </div>
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onEditClick}
            className="text-xs text-blue-400 dark:text-blue-500 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
          >
            {t("claudeConfig.editCommonConfig", {
              defaultValue: "编辑通用配置",
            })}
          </button>
        </div>
        {commonConfigError && !isModalOpen && (
          <p className="text-xs text-red-500 dark:text-red-400 text-right">
            {commonConfigError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {CLAUDE_QUICK_TOGGLE_OPTIONS.map((option) => (
            <QuickConfigToggle
              key={option.key}
              checked={toggleStates[option.key]}
              onChange={(checked) => handleToggle(option.key, checked)}
              label={t(option.labelKey, { defaultValue: option.defaultLabel })}
              description={t(option.descriptionKey, {
                defaultValue: option.defaultDescription,
              })}
            />
          ))}
        </div>
        <JsonEditor
          value={localValue}
          onChange={handleLocalChange}
          placeholder={`{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-api-endpoint.com",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key-here"
  }
}`}
          darkMode={isDarkMode}
          rows={14}
          showValidation={true}
          language="json"
        />
      </div>

      <FullScreenPanel
        isOpen={isModalOpen}
        title={t("claudeConfig.editCommonConfigTitle", {
          defaultValue: "编辑通用配置片段",
        })}
        onClose={onModalClose}
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
                {t("claudeConfig.extractFromCurrent", {
                  defaultValue: "从编辑内容提取",
                })}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onModalClose}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={onModalClose} className="gap-2">
              <Save className="w-4 h-4" />
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("claudeConfig.commonConfigHint", {
              defaultValue: "通用配置片段将合并到所有启用它的供应商配置中",
            })}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {CLAUDE_QUICK_TOGGLE_OPTIONS.map((option) => (
              <QuickConfigToggle
                key={option.key}
                checked={snippetToggleStates[option.key]}
                onChange={(checked) => handleSnippetToggle(option.key, checked)}
                label={t(option.labelKey, {
                  defaultValue: option.defaultLabel,
                })}
                description={t(option.descriptionKey, {
                  defaultValue: option.defaultDescription,
                })}
              />
            ))}
          </div>
          <JsonEditor
            value={commonConfigSnippet}
            onChange={onCommonConfigSnippetChange}
            placeholder={`{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-api-endpoint.com"
  }
}`}
            darkMode={isDarkMode}
            rows={16}
            showValidation={true}
            language="json"
          />
          {commonConfigError && (
            <p className="text-sm text-red-500 dark:text-red-400">
              {commonConfigError}
            </p>
          )}
        </div>
      </FullScreenPanel>
    </>
  );
}
