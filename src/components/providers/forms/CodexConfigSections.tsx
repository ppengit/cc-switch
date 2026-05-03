import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import JsonEditor from "@/components/JsonEditor";

interface CodexAuthSectionProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
}

/**
 * CodexAuthSection - Auth JSON editor section
 */
export const CodexAuthSection: React.FC<CodexAuthSectionProps> = ({
  value,
  onChange,
  onBlur,
  error,
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
      <label
        htmlFor="codexAuth"
        className="block text-sm font-medium text-foreground"
      >
        {t("codexConfig.authJson")}
      </label>

      <JsonEditor
        value={value}
        onChange={handleChange}
        placeholder={t("codexConfig.authJsonPlaceholder")}
        darkMode={isDarkMode}
        rows={4}
        showValidation={true}
        language="json"
      />

      {error && (
        <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
      )}

      {!error && (
        <p className="text-xs text-muted-foreground">
          {t("codexConfig.authJsonHint")}
        </p>
      )}
    </div>
  );
};

interface CodexConfigSectionProps {
  value: string;
  onChange: (value: string) => void;
  useCommonConfig: boolean;
  onCommonConfigToggle: (checked: boolean) => void;
  onEditCommonConfig: () => void;
  commonConfigError?: string;
  configError?: string;
  showCommonConfig?: boolean;
}

/**
 * CodexConfigSection - Config TOML editor section
 */
export const CodexConfigSection: React.FC<CodexConfigSectionProps> = ({
  value,
  onChange,
  useCommonConfig,
  onCommonConfigToggle,
  onEditCommonConfig,
  commonConfigError,
  configError,
  showCommonConfig = true,
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

  // Mirror value prop to local state (same pattern as CommonConfigEditor)
  const [localValue, setLocalValue] = useState(value);
  const localValueRef = useRef(value);
  useEffect(() => {
    setLocalValue(value);
    localValueRef.current = value;
  }, [value]);

  const handleLocalChange = useCallback(
    (newValue: string) => {
      if (newValue === localValueRef.current) return;
      localValueRef.current = newValue;
      setLocalValue(newValue);
      onChange(newValue);
    },
    [onChange],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label
          htmlFor="codexConfig"
          className="block text-sm font-medium text-foreground"
        >
          {t("codexConfig.configToml")}
        </label>

        {showCommonConfig && (
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={useCommonConfig}
              onChange={(e) => onCommonConfigToggle(e.target.checked)}
              className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default  rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
            />
            {t("codexConfig.writeCommonConfig")}
          </label>
        )}
      </div>

      {showCommonConfig && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onEditCommonConfig}
            className="text-xs text-blue-500 dark:text-blue-400 hover:underline"
          >
            {t("codexConfig.editCommonConfig")}
          </button>
        </div>
      )}

      {showCommonConfig && commonConfigError && (
        <p className="text-xs text-red-500 dark:text-red-400 text-right">
          {commonConfigError}
        </p>
      )}

      <JsonEditor
        value={localValue}
        onChange={handleLocalChange}
        placeholder=""
        darkMode={isDarkMode}
        rows={8}
        showValidation={false}
        language="javascript"
      />

      {configError && (
        <p className="text-xs text-red-500 dark:text-red-400">{configError}</p>
      )}

      {!configError && (
        <p className="text-xs text-muted-foreground">
          {t("codexConfig.configTomlHint")}
        </p>
      )}
    </div>
  );
};
