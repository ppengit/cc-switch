import { Loader2, Route } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppId } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { useAutoFailoverEnabled } from "@/lib/query/failover";
import { useAppProxyConfig, useUpdateAppProxyConfig } from "@/lib/query/proxy";
import { cn } from "@/lib/utils";

interface SessionRoutingToggleProps {
  className?: string;
  activeApp: AppId;
}

export function SessionRoutingToggle({
  className,
  activeApp,
}: SessionRoutingToggleProps) {
  const { t } = useTranslation();
  const isSupported = activeApp === "claude" || activeApp === "codex";
  const { data: appProxyConfig, isLoading } = useAppProxyConfig(activeApp);
  const { data: isAutoFailoverEnabled = false } =
    useAutoFailoverEnabled(activeApp);
  const appLabel = activeApp === "claude" ? "Claude" : "Codex";
  const updateConfig = useUpdateAppProxyConfig({
    successMessage: (config) =>
      config.sessionRoutingEnabled
        ? t("sessionRouting.toggle.enabledSaved", {
            app: appLabel,
            defaultValue: `${appLabel} 会话路由已开启`,
          })
        : t("sessionRouting.toggle.disabledSaved", {
            app: appLabel,
            defaultValue: `${appLabel} 会话路由已关闭`,
          }),
  });
  const { takeoverStatus, isRunning } = useProxyStatus();

  if (!isSupported) return null;

  const takeoverEnabled =
    Boolean(takeoverStatus?.[activeApp]) || Boolean(appProxyConfig?.enabled);
  const failoverEnabled =
    isAutoFailoverEnabled === true ||
    appProxyConfig?.autoFailoverEnabled === true;
  const enabled = appProxyConfig?.sessionRoutingEnabled === true;
  const canEnable = Boolean(
    appProxyConfig && takeoverEnabled && failoverEnabled && isRunning,
  );
  const isPending = updateConfig.isPending || isLoading;

  const handleToggle = (checked: boolean) => {
    if (!appProxyConfig) return;
    if (checked && !canEnable) return;
    updateConfig.mutate({
      ...appProxyConfig,
      sessionRoutingEnabled: checked,
    });
  };

  const tooltipText = enabled
    ? t("sessionRouting.toggle.enabled", {
        app: appLabel,
        defaultValue: `${appLabel} 会话路由已启用`,
      })
    : !takeoverEnabled
      ? t("sessionRouting.toggle.takeoverRequired", {
          app: appLabel,
          defaultValue: `请先接管 ${appLabel}，再启用会话路由`,
        })
      : !failoverEnabled
        ? t("sessionRouting.toggle.failoverRequired", {
            app: appLabel,
            defaultValue: `请先启用 ${appLabel} 故障转移，再启用会话路由`,
          })
        : !isRunning
          ? t("sessionRouting.toggle.proxyRequired", {
              defaultValue: "请先启动代理服务，再启用会话路由",
            })
          : t("sessionRouting.toggle.disabled", {
              app: appLabel,
              defaultValue: `启用 ${appLabel} 会话路由`,
            });

  return (
    <div
      className={cn(
        "flex h-8 items-center gap-1 rounded-lg bg-muted/50 px-1.5 transition-all",
        className,
      )}
      title={tooltipText}
    >
      {isPending ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Route
          className={cn(
            "h-4 w-4 transition-colors",
            enabled
              ? "text-emerald-500 animate-pulse"
              : "text-muted-foreground",
          )}
        />
      )}
      <Switch
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={isPending || !appProxyConfig || (!enabled && !canEnable)}
      />
    </div>
  );
}
