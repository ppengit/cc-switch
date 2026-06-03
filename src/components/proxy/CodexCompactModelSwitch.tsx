import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ToggleRow } from "@/components/ui/toggle-row";
import { useAppProxyConfig, useUpdateAppProxyConfig } from "@/lib/query/proxy";

export function CodexCompactModelSwitch() {
  const { t } = useTranslation();
  const { data: config, isLoading } = useAppProxyConfig("codex");
  const updateConfig = useUpdateAppProxyConfig();

  const handleChange = (checked: boolean) => {
    if (!config) return;
    updateConfig.mutate({
      ...config,
      forceResponsesCompactGpt54: checked,
    });
  };

  return (
    <ToggleRow
      icon={<Sparkles className="h-4 w-4 text-sky-500" />}
      title={t("proxy.settings.codexCompactGpt54", {
        defaultValue: "Codex compact 强制使用 gpt-5.4",
      })}
      description={t("proxy.settings.codexCompactGpt54Description", {
        defaultValue:
          "开启后仅在 Codex /responses/compact 请求发往上游前临时把 model 改写为 gpt-5.4，不影响普通 responses 或 chat/completions 请求。",
      })}
      checked={config?.forceResponsesCompactGpt54 ?? false}
      onCheckedChange={handleChange}
      disabled={isLoading || updateConfig.isPending || !config}
    />
  );
}
