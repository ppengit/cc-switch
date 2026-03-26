import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Info, Loader2, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppProxyConfig, useUpdateAppProxyConfig } from "@/lib/query/proxy";

interface ZeroTokenConfigPanelProps {
  appType: string;
  disabled?: boolean;
}

export function ZeroTokenConfigPanel({
  appType,
  disabled = false,
}: ZeroTokenConfigPanelProps) {
  const { t } = useTranslation();
  const { data: config, isLoading, error } = useAppProxyConfig(appType);
  const updateConfig = useUpdateAppProxyConfig();
  const [zeroTokenAnomalyEnabled, setZeroTokenAnomalyEnabled] = useState(false);
  const [zeroTokenAnomalyThreshold, setZeroTokenAnomalyThreshold] =
    useState("3");

  useEffect(() => {
    if (!config) {
      return;
    }

    setZeroTokenAnomalyEnabled(config.zeroTokenAnomalyEnabled === true);
    setZeroTokenAnomalyThreshold(String(config.zeroTokenAnomalyThreshold ?? 3));
  }, [config]);

  const isDisabled = disabled || isLoading || updateConfig.isPending;

  const handleSave = async () => {
    if (!config) {
      return;
    }

    const normalizedThreshold = zeroTokenAnomalyThreshold.trim();
    if (!/^\d+$/.test(normalizedThreshold)) {
      toast.error(
        t("proxy.autoFailover.validationFailed", {
          fields: t("proxy.autoFailover.zeroTokenThreshold", {
            defaultValue: "0/0 Token 连续阈值",
          }),
          defaultValue: `以下字段超出有效范围: ${t(
            "proxy.autoFailover.zeroTokenThreshold",
            {
              defaultValue: "0/0 Token 连续阈值",
            },
          )}`,
        }),
      );
      return;
    }

    const threshold = parseInt(normalizedThreshold, 10);
    if (Number.isNaN(threshold) || threshold < 1 || threshold > 20) {
      toast.error(
        t("proxy.autoFailover.validationFailed", {
          fields: `${t("proxy.autoFailover.zeroTokenThreshold", {
            defaultValue: "0/0 Token 连续阈值",
          })}: 1-20`,
          defaultValue: `以下字段超出有效范围: ${t(
            "proxy.autoFailover.zeroTokenThreshold",
            {
              defaultValue: "0/0 Token 连续阈值",
            },
          )}: 1-20`,
        }),
      );
      return;
    }

    try {
      await updateConfig.mutateAsync({
        config: {
          ...config,
          zeroTokenAnomalyEnabled,
          zeroTokenAnomalyThreshold: threshold,
        },
        successMessage: t("proxy.autoFailover.configSaved", {
          defaultValue: "自动故障转移配置已保存",
        }),
      });
    } catch (saveError) {
      console.error("Save zero token config failed:", saveError);
    }
  };

  const handleReset = () => {
    if (!config) {
      return;
    }

    setZeroTokenAnomalyEnabled(config.zeroTokenAnomalyEnabled === true);
    setZeroTokenAnomalyThreshold(String(config.zeroTokenAnomalyThreshold ?? 3));
  };

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{String(error)}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-muted/20 p-4">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          {t("proxy.autoFailover.zeroTokenEnabledHint", {
            defaultValue:
              "当上游成功返回但输入/输出 token 都为 0 时，按连续次数统计并在命中阈值后触发降级与会话迁移。",
          })}
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/50 px-3 py-3">
        <div className="pr-4">
          <Label htmlFor={`zeroTokenAnomalyEnabled-${appType}`}>
            {t("proxy.autoFailover.zeroTokenEnabled", {
              defaultValue: "启用 0/0 Token 异常自动降级",
            })}
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("proxy.autoFailover.zeroTokenEnabledHint", {
              defaultValue:
                "当上游成功返回但输入/输出 token 都为 0 时，按连续次数统计并在命中阈值后触发降级与会话迁移。",
            })}
          </p>
        </div>
        <Switch
          id={`zeroTokenAnomalyEnabled-${appType}`}
          checked={zeroTokenAnomalyEnabled}
          onCheckedChange={setZeroTokenAnomalyEnabled}
          disabled={isDisabled}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`zeroTokenAnomalyThreshold-${appType}`}>
          {t("proxy.autoFailover.zeroTokenThreshold", {
            defaultValue: "0/0 Token 连续阈值",
          })}
        </Label>
        <Input
          id={`zeroTokenAnomalyThreshold-${appType}`}
          type="number"
          min="1"
          max="20"
          value={zeroTokenAnomalyThreshold}
          onChange={(event) => setZeroTokenAnomalyThreshold(event.target.value)}
          disabled={isDisabled}
        />
        <p className="text-xs text-muted-foreground">
          {t("proxy.autoFailover.zeroTokenThresholdHint", {
            defaultValue:
              "启用后，连续命中多少次 0/0 token 异常才会将该供应商降级/熔断（建议: 2-5）。",
          })}
        </p>
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <Button variant="outline" onClick={handleReset} disabled={isDisabled}>
          {t("common.reset", { defaultValue: "Reset" })}
        </Button>
        <Button onClick={() => void handleSave()} disabled={isDisabled}>
          {updateConfig.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("common.saving", { defaultValue: "Saving..." })}
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {t("common.save", { defaultValue: "Save" })}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
