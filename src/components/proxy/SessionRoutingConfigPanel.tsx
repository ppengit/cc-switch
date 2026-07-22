import { useEffect, useState } from "react";
import { Info, Loader2, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppProxyConfig, useUpdateAppProxyConfig } from "@/lib/query/proxy";

interface SessionRoutingConfigPanelProps {
  appType: "claude" | "codex" | "grokbuild";
  disabled?: boolean;
}

export function SessionRoutingConfigPanel({
  appType,
  disabled = false,
}: SessionRoutingConfigPanelProps) {
  const { t } = useTranslation();
  const { data: config, isLoading, error } = useAppProxyConfig(appType);
  const updateConfig = useUpdateAppProxyConfig();
  const [formData, setFormData] = useState({
    sessionRoutingEnabled: false,
    sessionRoutingIdleTtlSeconds: "600",
    sessionRoutingClientSessionOnly: true,
    sessionRoutingOverflowFallbackEnabled: true,
  });

  useEffect(() => {
    if (!config) return;
    setFormData({
      sessionRoutingEnabled: config.sessionRoutingEnabled,
      sessionRoutingIdleTtlSeconds: String(config.sessionRoutingIdleTtlSeconds),
      sessionRoutingClientSessionOnly: config.sessionRoutingClientSessionOnly,
      sessionRoutingOverflowFallbackEnabled:
        config.sessionRoutingOverflowFallbackEnabled,
    });
  }, [config]);

  const isDisabled = disabled || updateConfig.isPending;
  const canEnable =
    Boolean(config?.enabled) && Boolean(config?.autoFailoverEnabled);

  const handleSave = async () => {
    if (!config) return;
    const ttl = Number.parseInt(formData.sessionRoutingIdleTtlSeconds, 10);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 86400) {
      toast.error(
        t("sessionRouting.validation.ttl", {
          defaultValue: "会话释放 TTL 必须在 1-86400 秒之间",
        }),
      );
      return;
    }

    await updateConfig.mutateAsync({
      ...config,
      sessionRoutingEnabled:
        formData.sessionRoutingEnabled &&
        config.enabled &&
        config.autoFailoverEnabled,
      sessionRoutingIdleTtlSeconds: ttl,
      sessionRoutingClientSessionOnly: formData.sessionRoutingClientSessionOnly,
      sessionRoutingOverflowFallbackEnabled:
        formData.sessionRoutingOverflowFallbackEnabled,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{String(error)}</AlertDescription>
        </Alert>
      ) : null}

      <Alert className="border-blue-500/40 bg-blue-500/10">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-sm">
          {t("sessionRouting.settings.info", {
            defaultValue:
              "会话路由仅在本地路由接管和自动故障转移都启用时生效。同一客户端会话优先保持在同一供应商；供应商达到并发上限时会按故障转移队列选择其它可用供应商。开启满载兜底后，所有供应商满载时可能临时超过上限。Claude、Codex 与 Grok Build 均支持此功能。",
          })}
        </AlertDescription>
      </Alert>

      {!canEnable ? (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-300">
          {t("sessionRouting.settings.requiresFailover", {
            defaultValue: "需要先为该应用开启本地路由接管和自动故障转移。",
          })}
        </div>
      ) : null}

      <div className="space-y-4 rounded-lg border border-white/10 bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor={`session-routing-enabled-${appType}`}>
              {t("sessionRouting.settings.enabled", {
                defaultValue: "启用会话路由",
              })}
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("sessionRouting.settings.enabledHint", {
                defaultValue:
                  "关闭后完全使用当前故障转移逻辑，不做会话粘性和并发分流。",
              })}
            </p>
          </div>
          <Switch
            id={`session-routing-enabled-${appType}`}
            checked={formData.sessionRoutingEnabled}
            onCheckedChange={(checked) =>
              setFormData((current) => ({
                ...current,
                sessionRoutingEnabled: checked,
              }))
            }
            disabled={isDisabled || !canEnable}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`session-routing-ttl-${appType}`}>
              {t("sessionRouting.settings.idleTtl", {
                defaultValue: "会话空闲释放 TTL（秒）",
              })}
            </Label>
            <Input
              id={`session-routing-ttl-${appType}`}
              type="number"
              min={1}
              max={86400}
              value={formData.sessionRoutingIdleTtlSeconds}
              onChange={(event) =>
                setFormData((current) => ({
                  ...current,
                  sessionRoutingIdleTtlSeconds: event.target.value,
                }))
              }
              disabled={isDisabled}
            />
            <p className="text-xs text-muted-foreground">
              {t("sessionRouting.settings.idleTtlHint", {
                defaultValue:
                  "超过这个时间没有新请求的会话会释放供应商占用，默认 600 秒。",
              })}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="flex items-start justify-between gap-4 rounded-md border border-border/50 bg-background/40 p-3">
            <span>
              <span className="block text-sm font-medium">
                {t("sessionRouting.settings.clientOnly", {
                  defaultValue: "仅绑定客户端显式会话",
                })}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("sessionRouting.settings.clientOnlyHint", {
                  defaultValue:
                    "自动生成的请求 ID 不作为会话粘性依据，避免把无会话请求错误绑定到某个供应商。",
                })}
              </span>
            </span>
            <Switch
              checked={formData.sessionRoutingClientSessionOnly}
              onCheckedChange={(checked) =>
                setFormData((current) => ({
                  ...current,
                  sessionRoutingClientSessionOnly: checked,
                }))
              }
              disabled={isDisabled}
            />
          </label>

          <label className="flex items-start justify-between gap-4 rounded-md border border-border/50 bg-background/40 p-3">
            <span>
              <span className="block text-sm font-medium">
                {t("sessionRouting.settings.overflowFallback", {
                  defaultValue: "满载时使用队列首个正常供应商兜底",
                })}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("sessionRouting.settings.overflowFallbackHint", {
                  defaultValue:
                    "当所有供应商都达到最大并发上限时，仍把请求交给故障转移队列中第一个可用供应商，避免无人处理；这会让最大并发上限成为软限制。",
                })}
              </span>
            </span>
            <Switch
              checked={formData.sessionRoutingOverflowFallbackEnabled}
              onCheckedChange={(checked) =>
                setFormData((current) => ({
                  ...current,
                  sessionRoutingOverflowFallbackEnabled: checked,
                }))
              }
              disabled={isDisabled}
            />
          </label>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={isDisabled || !config}>
          {updateConfig.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("common.saving", { defaultValue: "保存中..." })}
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {t("common.save", { defaultValue: "保存" })}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
