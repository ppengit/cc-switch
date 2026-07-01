import { useMemo, useState } from "react";
import { Loader2, RefreshCw, Route, Shuffle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppId } from "@/lib/api";
import {
  useRebindSessionRoute,
  useSessionRoutingSnapshot,
} from "@/lib/query/proxy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface SessionRoutingManagerDialogProps {
  appId: AppId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const formatIdle = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const shortSessionId = (sessionId: string) => {
  if (sessionId.length <= 24) return sessionId;
  return `${sessionId.slice(0, 12)}...${sessionId.slice(-8)}`;
};

export function SessionRoutingManagerDialog({
  appId,
  open,
  onOpenChange,
}: SessionRoutingManagerDialogProps) {
  const { t } = useTranslation();
  const [targetBySession, setTargetBySession] = useState<
    Record<string, string>
  >({});
  const isSupported = appId === "claude" || appId === "codex";
  const { data, isFetching, refetch } = useSessionRoutingSnapshot(
    appId,
    open && isSupported,
  );
  const rebindMutation = useRebindSessionRoute();

  const providers = data?.providers ?? [];
  const bindings = data?.bindings ?? [];
  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.inFailoverQueue),
    [providers],
  );

  const handleRebind = (sessionId: string, currentProviderId: string) => {
    const providerId = targetBySession[sessionId] || currentProviderId;
    if (!providerId || providerId === currentProviderId) return;
    rebindMutation.mutate({ appType: appId, sessionId, providerId });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl" zIndex="top">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Route className="h-5 w-5 text-emerald-500" />
            {t("sessionRouting.manager.title", {
              defaultValue: "会话路由",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("sessionRouting.manager.description", {
              defaultValue:
                "查看 Claude/Codex 当前会话绑定、供应商占用，并把某个会话切换到其它故障转移供应商。",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2">
              <Badge variant={data?.enabled ? "default" : "secondary"}>
                {data?.enabled
                  ? t("common.enabled", { defaultValue: "已启用" })
                  : t("common.disabled", { defaultValue: "未启用" })}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {appId === "claude" ? "Claude" : "Codex"}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {t("common.refresh", { defaultValue: "刷新" })}
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {providers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                {t("sessionRouting.manager.noProviders", {
                  defaultValue: "故障转移队列中暂无供应商。",
                })}
              </div>
            ) : (
              providers.map((provider) => {
                const limit =
                  provider.maxConcurrentRequests &&
                  provider.maxConcurrentRequests > 0
                    ? provider.maxConcurrentRequests
                    : null;
                const pct = limit
                  ? Math.min(
                      100,
                      Math.round((provider.occupancy / limit) * 100),
                    )
                  : 0;
                return (
                  <div
                    key={provider.providerId}
                    className={cn(
                      "rounded-lg border border-border bg-background/70 p-3",
                      !provider.inFailoverQueue && "opacity-70",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div
                          className="truncate text-sm font-medium"
                          title={provider.providerName}
                        >
                          {provider.providerName}
                        </div>
                        <div className="mt-1 text-[11px] font-mono text-muted-foreground">
                          {provider.providerId}
                        </div>
                      </div>
                      <Badge variant={limit ? "outline" : "secondary"}>
                        {limit
                          ? `${provider.occupancy}/${limit}`
                          : t("sessionRouting.manager.unlimited", {
                              defaultValue: "无限",
                            })}
                      </Badge>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          pct >= 100
                            ? "bg-red-500"
                            : pct >= 80
                              ? "bg-amber-500"
                              : "bg-emerald-500",
                        )}
                        style={{ width: limit ? `${pct}%` : "100%" }}
                      />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                      <span>
                        {t("sessionRouting.manager.sessionSlots", {
                          count: provider.sessionOccupancy,
                          defaultValue: "会话占用 {{count}}",
                        })}
                      </span>
                      <span>
                        {t("sessionRouting.manager.anonymousSlots", {
                          count: provider.anonymousOccupancy,
                          defaultValue: "临时占用 {{count}}",
                        })}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div>
                <div className="text-sm font-medium">
                  {t("sessionRouting.manager.bindings", {
                    defaultValue: "会话绑定",
                  })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("sessionRouting.manager.bindingHint", {
                    defaultValue:
                      "只显示带会话 ID 且仍在 TTL 内的绑定；没有会话 ID 的请求只计入临时占用，不会进入绑定列表。",
                  })}
                </div>
              </div>
              <Badge variant="secondary">{bindings.length}</Badge>
            </div>
            <ScrollArea className="h-[22rem]">
              {isFetching && !data ? (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("common.loading", { defaultValue: "加载中..." })}
                </div>
              ) : bindings.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  {t("sessionRouting.manager.noBindings", {
                    defaultValue: "暂无会话绑定。",
                  })}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {bindings.map((binding) => {
                    const selected =
                      targetBySession[binding.sessionId] || binding.providerId;
                    const changed = selected !== binding.providerId;
                    return (
                      <div
                        key={`${binding.appType}:${binding.sessionId}`}
                        className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_8rem]"
                      >
                        <div className="min-w-0">
                          <div
                            className="truncate font-mono text-xs"
                            title={binding.sessionId}
                          >
                            {shortSessionId(binding.sessionId)}
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {t("sessionRouting.manager.idle", {
                              idle: formatIdle(binding.idleSeconds),
                              defaultValue: "空闲 {{idle}}",
                            })}
                          </div>
                        </div>
                        <Select
                          value={selected}
                          onValueChange={(providerId) =>
                            setTargetBySession((current) => ({
                              ...current,
                              [binding.sessionId]: providerId,
                            }))
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-72">
                            {enabledProviders.map((provider) => (
                              <SelectItem
                                key={provider.providerId}
                                value={provider.providerId}
                              >
                                {provider.providerName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          size="sm"
                          variant={changed ? "default" : "outline"}
                          className="h-8"
                          disabled={
                            !changed ||
                            rebindMutation.isPending ||
                            enabledProviders.length === 0
                          }
                          onClick={() =>
                            handleRebind(binding.sessionId, binding.providerId)
                          }
                        >
                          {rebindMutation.isPending ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Shuffle className="mr-2 h-3.5 w-3.5" />
                          )}
                          {t("sessionRouting.manager.rebind", {
                            defaultValue: "切换",
                          })}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close", { defaultValue: "关闭" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
