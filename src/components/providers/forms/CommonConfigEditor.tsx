import { useTranslation } from "react-i18next";
import { useEffect, useState, useCallback } from "react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Save, Download, Loader2 } from "lucide-react";
import JsonEditor from "@/components/JsonEditor";
import { getDefaultJsonCommonConfigTemplate } from "@/utils/providerConfigUtils";

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
  useCommonConfig: _useCommonConfig,
  onCommonConfigToggle: _onCommonConfigToggle,
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

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="settingsConfig">{t("provider.configJson")}</Label>
          <span className="text-xs text-muted-foreground">
            {t("provider.commonConfigApplyAll", {
              defaultValue: "应用配置模板",
            })}
          </span>
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
        <JsonEditor
          value={localValue}
          onChange={handleLocalChange}
          placeholder={getDefaultJsonCommonConfigTemplate("claude")}
          darkMode={isDarkMode}
          rows={14}
          showValidation={false}
          language="json"
        />
      </div>

      <FullScreenPanel
        isOpen={isModalOpen}
        title={t("claudeConfig.editCommonConfigTitle", {
          defaultValue: "编辑 Claude 应用配置模板",
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
              defaultValue:
                "这是 Claude 的应用配置模板。模板必须包含顶层 {{provider.config}}，可选 {{mcp.config}}；写入 live 配置时系统会注入当前供应商和 MCP 配置。",
            })}
          </p>
          <JsonEditor
            value={commonConfigSnippet}
            onChange={onCommonConfigSnippetChange}
            placeholder={getDefaultJsonCommonConfigTemplate("claude")}
            darkMode={isDarkMode}
            rows={16}
            showValidation={false}
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
