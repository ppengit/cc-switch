import { useMemo } from "react";
import { Loader2, RefreshCw, Route } from "lucide-react";
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
import { getBaseName } from "@/components/sessions/utils";

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

function bindingPrimaryLabel(binding: {
  sessionTitle?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  sessionId: string;
}) {
  const title = binding.sessionTitle?.trim();
  if (title) return title;
  const projectName = binding.projectName?.trim();
  if (projectName) return projectName;
  const fromPath = getBaseName(binding.projectPath);
  if (fromPath) return fromPath;
  return shortSessionId(binding.sessionId);
}

function bindingProjectName(binding: {
  projectName?: string | null;
  projectPath?: string | null;
}) {
  const name = binding.projectName?.trim();
  if (name) return name;
  return getBaseName(binding.projectPath) || null;
}

export function SessionRoutingManagerDialog({
  appId,
  open,
  onOpenChange,
}: SessionRoutingManagerDialogProps) {
  const { t } = useTranslation();
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

  const handleProviderChange = (
    sessionId: string,
    currentProviderId: string,
    providerId: string,
  ) => {
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

          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-3 py-2">
              <div className="text-sm font-medium">
                {t("sessionRouting.manager.providers", {
                  defaultValue: "供应商占用",
                })}
              </div>
            </div>
            {providers.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("sessionRouting.manager.noProviders", {
                  defaultValue: "故障转移队列中暂无供应商。",
                })}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {providers.map((provider) => {
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
                  const occupancyLabel = limit
                    ? `${provider.occupancy}/${limit}`
                    : t("sessionRouting.manager.unlimited", {
                        defaultValue: "无限",
                      });
                  return (
                    <div
                      key={provider.providerId}
                      className={cn(
                        "flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap",
                        !provider.inFailoverQueue && "opacity-70",
                      )}
                    >
                      <div className="min-w-0 flex-1 basis-[12rem]">
                        <div
                          className="truncate text-sm font-medium"
                          title={provider.providerName}
                        >
                          {provider.providerName}
                        </div>
                        <div
                          className="truncate text-[11px] font-mono text-muted-foreground"
                          title={provider.providerId}
                        >
                          {provider.providerId}
                        </div>
                      </div>
                      <Badge
                        variant={limit ? "outline" : "secondary"}
                        className="shrink-0 whitespace-nowrap"
                      >
                        {occupancyLabel}
                      </Badge>
                      <div className="h-1.5 w-full min-w-[8rem] flex-1 overflow-hidden rounded-full bg-muted sm:max-w-[10rem]">
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
                      <div className="flex shrink-0 gap-3 text-[11px] text-muted-foreground">
                        <span className="whitespace-nowrap">
                          {t("sessionRouting.manager.sessionSlots", {
                            count: provider.sessionOccupancy,
                            defaultValue: "会话 {{count}}",
                          })}
                        </span>
                        <span className="whitespace-nowrap">
                          {t("sessionRouting.manager.anonymousSlots", {
                            count: provider.anonymousOccupancy,
                            defaultValue: "临时 {{count}}",
                          })}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
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
                    const primary = bindingPrimaryLabel(binding);
                    const projectName = bindingProjectName(binding);
                    const projectPath = binding.projectPath?.trim() || null;
                    const showProjectName =
                      projectName &&
                      projectName !== primary &&
                      binding.sessionTitle?.trim();
                    return (
                      <div
                        key={`${binding.appType}:${binding.sessionId}`}
                        className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div
                            className="truncate text-sm font-medium"
                            title={primary}
                          >
                            {primary}
                          </div>
                          {showProjectName ? (
                            <div
                              className="truncate text-xs text-muted-foreground"
                              title={projectName}
                            >
                              {t("sessionRouting.manager.projectName", {
                                name: projectName,
                                defaultValue: "项目：{{name}}",
                              })}
                            </div>
                          ) : null}
                          {projectPath ? (
                            <div
                              className="truncate font-mono text-[11px] text-muted-foreground"
                              title={projectPath}
                            >
                              {projectPath}
                            </div>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span
                              className="font-mono"
                              title={binding.sessionId}
                            >
                              {shortSessionId(binding.sessionId)}
                            </span>
                            <span aria-hidden>·</span>
                            <span>
                              {t("sessionRouting.manager.idle", {
                                idle: formatIdle(binding.idleSeconds),
                                defaultValue: "空闲 {{idle}}",
                              })}
                            </span>
                          </div>
                        </div>
                        <Select
                          value={binding.providerId}
                          onValueChange={(providerId) =>
                            handleProviderChange(
                              binding.sessionId,
                              binding.providerId,
                              providerId,
                            )
                          }
                          disabled={
                            rebindMutation.isPending ||
                            enabledProviders.length === 0
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="z-[230] max-h-72">
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
