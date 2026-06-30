import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RawProxyLogPanelProps {
  appType?: string;
  refreshIntervalMs: number;
}

const LOG_LIMIT = 500;
const PAGE_SIZE = 50;

const EVENT_COLOR_MAP: Record<string, string> = {
  processing:
    "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/35",
  success:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/35",
};

const EVENT_LABEL_DEFAULTS: Record<string, string> = {
  processing: "正在处理",
  success: "成功",
  failed: "失败",
};

const normalizeModel = (value?: string | null) => {
  const trimmed = (value || "").trim();
  return trimmed || undefined;
};

// 右上角关闭按钮：Radix Dialog 默认不带关闭按钮，补一个明确的关闭入口，
// 配合 closeOnInteractOutside 让弹窗既能点外部也能点按钮关闭。
function DialogCloseButton({ label }: { label: string }) {
  return (
    <DialogClose
      className="absolute right-4 top-4 z-10 rounded-md p-1.5 text-muted-foreground opacity-70 transition hover:bg-muted hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
      aria-label={label}
    >
      <X className="h-4 w-4" />
    </DialogClose>
  );
}

const normalizeRouteMode = (value?: string | null) => {
  const trimmed = (value || "").trim();
  return trimmed || undefined;
};

const getDisplayEvent = (log: ProxyRawLogEntry) => {
  if (log.event === "failed") return "failed";
  if (log.event === "finished") return "success";
  return "processing";
};

/**
 * 判断错误文本是否疑似 HTML 页面。
 *
 * 上游 nginx/CDN/网关在 4xx/5xx 时常返回 HTML 错误页（如 413、502、504、
 * Cloudflare 错误页等），这些内容会原样进入 error 字段。命中时提供
 * iframe 沙箱预览，让用户看到排版后的真实错误页。
 */
const isLikelyHtml = (value?: string | null): boolean => {
  if (!value) return false;
  const sample = value.slice(0, 2000).toLowerCase();
  return (
    sample.includes("<!doctype html") ||
    sample.includes("<html") ||
    (sample.includes("<body") && sample.includes("</body>")) ||
    (sample.includes("<head") && sample.includes("</head>"))
  );
};

export function RawProxyLogPanel({
  appType,
  refreshIntervalMs,
}: RawProxyLogPanelProps) {
  const { t, i18n } = useTranslation();
  const [selectedLog, setSelectedLog] = useState<ProxyRawLogEntry | null>(null);
  const [htmlErrorPreview, setHtmlErrorPreview] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch, isFetching } = useProxyRawLogs(
    appType,
    LOG_LIMIT,
    {
      refetchInterval:
        refreshIntervalMs > 0 ? Math.min(refreshIntervalMs, 2000) : false,
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
        .sort((a, b) => b.id - a.id),
    [data],
  );
  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const pagedLogs = useMemo(
    () => logs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [logs, page],
  );
  const pageStart = logs.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, logs.length);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setPage(1);
  }, [appType]);

  const getEventLabel = (event: string) =>
    t(`usage.proxyEvent.${event}`, {
      defaultValue: EVENT_LABEL_DEFAULTS[event] ?? event,
    });
  const getRouteModeLabel = (routeMode?: string) =>
    routeMode
      ? t(`usage.routeModeValue.${routeMode}`, {
          defaultValue: routeMode,
        })
      : "-";

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {t("usage.rawProxyLogsHint", {
              defaultValue:
                "每行显示一个代理请求，事件列仅显示当前状态（正在处理/成功/失败）。完整生命周期保留在详情中，重启代理后清空。",
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
            <RefreshCw
              className={`mr-1 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
            />
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
                  {t("usage.routeMode", { defaultValue: "路由" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.model", { defaultValue: "模型" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.upstreamUrl", { defaultValue: "上游地址" })}
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
                    colSpan={10}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    {t("usage.rawProxyLogsEmpty", {
                      defaultValue:
                        "当前没有代理原始日志。请先开启接管代理并发起请求。",
                    })}
                  </TableCell>
                </TableRow>
              ) : (
                pagedLogs.map((log) => {
                  const requestModel = normalizeModel(log.requestModel);
                  const upstreamModel = normalizeModel(log.upstreamModel);
                  const displayModel = upstreamModel ?? requestModel;
                  const routeMode = normalizeRouteMode(log.routeMode);
                  const showRequestModel =
                    !!requestModel &&
                    !!displayModel &&
                    requestModel !== displayModel;
                  const displayEvent = getDisplayEvent(log);
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
                      key={log.requestId}
                      className="cursor-pointer"
                      onDoubleClick={() => setSelectedLog(log)}
                    >
                      <TableCell className="text-center whitespace-nowrap text-xs">
                        {new Date(log.startedAt).toLocaleString(locale, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </TableCell>
                      <TableCell className="min-w-[220px]">
                        <div className="flex flex-wrap justify-center gap-1">
                          <Badge
                            variant="outline"
                            className={EVENT_COLOR_MAP[displayEvent] ?? ""}
                          >
                            {getEventLabel(displayEvent)}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs uppercase">
                        {log.appType}
                      </TableCell>
                      <TableCell className="text-center max-w-[220px]">
                        <div className="truncate" title={log.providerName}>
                          {log.providerName}
                        </div>
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap text-xs">
                        <Badge variant="outline">
                          {getRouteModeLabel(routeMode)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs max-w-[220px]">
                        <div
                          className="truncate"
                          title={
                            showRequestModel
                              ? `${displayModel} (req: ${requestModel})`
                              : displayModel || "-"
                          }
                        >
                          <div className="truncate">{displayModel || "-"}</div>
                          {showRequestModel ? (
                            <div className="truncate text-[10px] text-muted-foreground">
                              {t("usage.requestModel", {
                                defaultValue: "请求模型",
                              })}
                              : {requestModel}
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[260px] text-center font-mono text-xs">
                        <div className="truncate" title={log.upstreamUrl || ""}>
                          {log.upstreamUrl || "-"}
                        </div>
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap text-xs">
                        {statusText}
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {log.activeRequestCount}
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        {log.error && isLikelyHtml(log.error) ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs text-red-600 dark:text-red-400"
                            onClick={(event) => {
                              event.stopPropagation();
                              setHtmlErrorPreview(log.error || "");
                            }}
                          >
                            {t("usage.viewErrorPage", {
                              defaultValue: "查看错误页",
                            })}
                          </Button>
                        ) : (
                          <div
                            className="truncate text-xs text-red-600 dark:text-red-400"
                            title={log.error || ""}
                          >
                            {log.error || "-"}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {logs.length > PAGE_SIZE && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
              <span>
                {t("usage.rawProxyLogsPageInfo", {
                  defaultValue: "第 {{start}}-{{end}} 条，共 {{total}} 条",
                  start: pageStart,
                  end: pageEnd,
                  total: logs.length,
                })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                  {t("common.previous", { defaultValue: "上一页" })}
                </Button>
                <span className="font-mono">
                  {page} / {totalPages}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setPage((current) => Math.min(totalPages, current + 1))
                  }
                  disabled={page >= totalPages}
                >
                  {t("common.next", { defaultValue: "下一页" })}
                  <ChevronRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={selectedLog !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedLog(null);
        }}
      >
        {selectedLog && (
          <DialogContent
            zIndex="top"
            closeOnInteractOutside
            className="w-[calc(100vw-2rem)] max-w-[min(1200px,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-hidden p-0"
          >
            <DialogCloseButton
              label={t("common.close", { defaultValue: "关闭" })}
            />
            <DialogHeader>
              <DialogTitle>
                {t("usage.rawProxyLogDetail", {
                  defaultValue: "代理原始日志详情",
                })}
              </DialogTitle>
              <DialogDescription>
                {t("usage.rawProxyLogDetailDescription", {
                  defaultValue: "查看单条代理原始日志的完整 JSON 详情。",
                })}
              </DialogDescription>
            </DialogHeader>
            <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-none border-0 bg-muted/40 p-4 font-mono text-xs leading-relaxed">
              {JSON.stringify(selectedLog, null, 2)}
            </pre>
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={htmlErrorPreview !== null}
        onOpenChange={(open) => {
          if (!open) setHtmlErrorPreview(null);
        }}
      >
        {htmlErrorPreview !== null && (
          <DialogContent
            zIndex="top"
            closeOnInteractOutside
            className="w-[calc(100vw-2rem)] max-w-[min(1280px,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-hidden p-0"
          >
            <DialogCloseButton
              label={t("common.close", { defaultValue: "关闭" })}
            />
            <DialogHeader>
              <DialogTitle>
                {t("usage.errorPagePreview", {
                  defaultValue: "错误页预览",
                })}
              </DialogTitle>
              <DialogDescription>
                {t("usage.errorPagePreviewDescription", {
                  defaultValue:
                    "上游返回的 HTML 错误页，在隔离沙箱中渲染（禁用脚本与外部请求）。",
                })}
              </DialogDescription>
            </DialogHeader>
            <iframe
              srcDoc={htmlErrorPreview}
              sandbox=""
              className="min-h-0 flex-1 w-full border-0 bg-white"
              title={t("usage.errorPagePreview", {
                defaultValue: "错误页预览",
              })}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
