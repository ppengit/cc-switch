import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useProxyRawLogs } from "@/lib/query/usage";
import type { ProxyRawLogEntry } from "@/types/proxy";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RawProxyLogPanelProps {
  appType?: string;
  refreshIntervalMs: number;
}

const LOG_LIMIT = 300;

const EVENT_COLOR_MAP: Record<string, string> = {
  received:
    "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/35",
  routed: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/35",
  finished:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/35",
};

const normalizeModel = (value?: string | null) => {
  const trimmed = (value || "").trim();
  return trimmed || undefined;
};

export function RawProxyLogPanel({
  appType,
  refreshIntervalMs,
}: RawProxyLogPanelProps) {
  const { t, i18n } = useTranslation();
  const [selectedLog, setSelectedLog] = useState<ProxyRawLogEntry | null>(null);
  const { data, isLoading, error, refetch, isFetching } = useProxyRawLogs(
    appType,
    LOG_LIMIT,
    {
      refetchInterval: refreshIntervalMs > 0 ? Math.min(refreshIntervalMs, 2000) : false,
    },
  );

  const locale =
    i18n.resolvedLanguage === "zh"
      ? "zh-CN"
      : i18n.resolvedLanguage === "ja"
        ? "ja-JP"
        : "en-US";

  const logs = useMemo(
    () =>
      [...(data ?? [])]
        .filter((log) => log.event !== "cleared")
        .reverse(),
    [data],
  );
  const getEventLabel = (event: string) =>
    t(`usage.proxyEvent.${event}`, {
      defaultValue: event,
    });

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {t("usage.rawProxyLogsHint", {
              defaultValue:
                "显示代理实时链路事件（收到请求、路由、完成/失败）。仅内存保留，重启代理后清空。",
            })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            {t("common.refresh", { defaultValue: "刷新" })}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-[360px] animate-pulse rounded bg-gray-100" />
      ) : error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {t("usage.rawProxyLogsLoadFailed", {
            defaultValue: "加载代理原始日志失败：{{error}}",
            error: error instanceof Error ? error.message : String(error),
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.time", { defaultValue: "时间" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.event", { defaultValue: "事件" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.appType", { defaultValue: "应用" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.provider", { defaultValue: "供应商" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.model", { defaultValue: "模型" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.status", { defaultValue: "状态" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.liveRequests", { defaultValue: "活动请求" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.error", { defaultValue: "错误" })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    {t("usage.rawProxyLogsEmpty", {
                      defaultValue: "当前没有代理原始日志。请先开启接管代理并发起请求。",
                    })}
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((log) => {
                  const requestModel = normalizeModel(log.requestModel);
                  const upstreamModel = normalizeModel(log.upstreamModel);
                  const displayModel = upstreamModel ?? requestModel;
                  const statusText =
                    log.statusCode != null
                      ? String(log.statusCode)
                      : log.event === "failed"
                        ? t("usage.failed", { defaultValue: "失败" })
                        : log.event === "finished"
                          ? t("usage.success", { defaultValue: "成功" })
                          : "-";
                  return (
                    <TableRow
                      key={log.id}
                      className="cursor-pointer"
                      onDoubleClick={() => setSelectedLog(log)}
                    >
                      <TableCell className="text-center whitespace-nowrap text-xs">
                        {new Date(log.timestamp).toLocaleString(locale, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap">
                        <Badge
                          variant="outline"
                          className={EVENT_COLOR_MAP[log.event] ?? ""}
                        >
                          {getEventLabel(log.event)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs uppercase">
                        {log.appType}
                      </TableCell>
                      <TableCell className="text-center max-w-[220px]">
                        <div className="truncate" title={log.providerName}>
                          {log.providerName}
                        </div>
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs max-w-[220px]">
                        <div
                          className="truncate"
                          title={
                            upstreamModel && requestModel && upstreamModel !== requestModel
                              ? `${upstreamModel} (req: ${requestModel})`
                              : displayModel || "-"
                          }
                        >
                          {displayModel || "-"}
                        </div>
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap text-xs">
                        {statusText}
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {log.activeRequestCount}
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        <div
                          className="truncate text-xs text-red-600 dark:text-red-400"
                          title={log.error || ""}
                        >
                          {log.error || "-"}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {selectedLog && (
        <Dialog open onOpenChange={() => setSelectedLog(null)}>
          <DialogContent
            zIndex="top"
            className="max-w-3xl max-h-[86vh] overflow-y-auto"
          >
            <DialogHeader>
              <DialogTitle>
                {t("usage.rawProxyLogDetail", {
                  defaultValue: "代理原始日志详情",
                })}
              </DialogTitle>
            </DialogHeader>
            <pre className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed overflow-auto">
              {JSON.stringify(selectedLog, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
