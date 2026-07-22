import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRequestLogs } from "@/lib/query/usage";
import {
  getFreshInputTokens,
  isUnpricedUsage,
  type LogFilters,
  type RequestLog,
  type UsageRangeSelection,
} from "@/types/usage";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { UsageDateRangePicker } from "./UsageDateRangePicker";
import { RequestDetailPanel } from "./RequestDetailPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useClearRequestLogs,
  useRequestLogRetentionConfig,
  useUpdateRequestLogRetention,
} from "@/lib/query/usage";
import { toast } from "sonner";
import {
  fmtInt,
  fmtUsd,
  getLocaleFromLanguage,
  parseFiniteNumber,
} from "./format";

interface RequestLogTableProps {
  range: UsageRangeSelection;
  rangeLabel: string;
  appType?: string;
  providerName?: string;
  model?: string;
  refreshIntervalMs: number;
  onRangeChange?: (range: UsageRangeSelection) => void;
  onOpenRequestDetail?: (request: RequestLog) => void;
}

export function RequestLogTable({
  range,
  rangeLabel,
  appType: dashboardAppType,
  providerName,
  model,
  refreshIntervalMs,
  onRangeChange,
  onOpenRequestDetail,
}: RequestLogTableProps) {
  const { t, i18n } = useTranslation();

  // 应用/Provider/模型筛选已上移到 Dashboard 顶栏（全局生效）；
  // 这里只保留日志特有的状态码筛选。
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [pageInput, setPageInput] = useState("");
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const [detailRequest, setDetailRequest] = useState<RequestLog | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [autoCleanupEnabled, setAutoCleanupEnabled] = useState(true);
  const [retainCountInput, setRetainCountInput] = useState("50");
  const pageSize = 20;

  const retentionQuery = useRequestLogRetentionConfig();
  const retentionMutation = useUpdateRequestLogRetention();
  const clearMutation = useClearRequestLogs();

  useEffect(() => {
    if (!retentionQuery.data) return;
    setAutoCleanupEnabled(retentionQuery.data.autoCleanupEnabled);
    setRetainCountInput(String(retentionQuery.data.retainCount));
  }, [retentionQuery.data]);

  const parseRetainCount = (raw: string) => {
    const trimmed = raw.trim();
    const value = /^\d+$/.test(trimmed)
      ? Number.parseInt(trimmed, 10)
      : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
      toast.error(
        t("usage.invalidRetainCount", {
          defaultValue: "保留条数必须是 1 到 1,000,000 之间的整数",
        }),
      );
      return null;
    }
    return value;
  };

  const parsedRetainCount = () => parseRetainCount(retainCountInput);

  const saveRetentionConfig = (enabled: boolean, count = retainCountInput) => {
    const value = parseRetainCount(count);
    if (value == null) return;
    const previousEnabled = autoCleanupEnabled;
    setAutoCleanupEnabled(enabled);
    setRetainCountInput(String(value));
    retentionMutation.mutate(
      { autoCleanupEnabled: enabled, retainCount: value },
      {
        onError: (error) => {
          toast.error(String(error));
          setAutoCleanupEnabled(previousEnabled);
        },
        onSuccess: () => {
          toast.success(
            t("usage.requestLogRetentionSaved", {
              defaultValue: "日志自动清理设置已保存",
            }),
          );
        },
      },
    );
  };

  const handleClearLogs = () => {
    setClearConfirmOpen(false);
    clearMutation.mutate(undefined, {
      onSuccess: (deleted) => {
        setPage(0);
        toast.success(
          t("usage.requestLogsCleared", {
            defaultValue: "已清空 {{count}} 条请求日志，统计数据已保留",
            count: deleted,
          }),
        );
      },
      onError: (error) => {
        toast.error(
          t("usage.requestLogsClearFailed", {
            defaultValue: "清空请求日志失败：{{error}}",
            error: String(error),
          }),
        );
      },
    });
  };

  const effectiveFilters: LogFilters = {
    appType:
      dashboardAppType && dashboardAppType !== "all"
        ? dashboardAppType
        : undefined,
    providerName,
    model,
    statusCode,
  };

  const {
    data: result,
    isLoading,
    isFetching,
    isPlaceholderData,
  } = useRequestLogs({
    filters: effectiveFilters,
    range,
    page,
    pageSize,
    options: {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  });

  const logs = result?.data ?? [];
  const total = result?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  useEffect(() => {
    if (!result) return;
    const lastValidPage = Math.max(0, totalPages - 1);
    setPage((current) => Math.min(current, lastValidPage));
  }, [result, totalPages]);

  useEffect(() => {
    setPage(0);
  }, [
    dashboardAppType,
    providerName,
    model,
    range.customEndDate,
    range.customStartDate,
    range.preset,
  ]);

  const handleGoToPage = () => {
    const trimmed = pageInput.trim();
    if (!/^\d+$/.test(trimmed)) return;
    const parsed = Number(trimmed);
    if (parsed < 1 || parsed > totalPages) return;
    setPage(parsed - 1);
    setPageInput("");
  };

  const language = i18n.resolvedLanguage || i18n.language || "en";
  const locale = getLocaleFromLanguage(language);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card/50 p-2 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Status code */}
          <Select
            value={statusCode?.toString() || "all"}
            onValueChange={(v) => {
              const parsed = Number.parseInt(v, 10);
              setStatusCode(
                v === "all" || !Number.isFinite(parsed) ? undefined : parsed,
              );
              setPage(0);
            }}
          >
            <SelectTrigger className="h-8 w-[100px] bg-background text-xs">
              <SelectValue placeholder={t("usage.statusCode")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              <SelectItem value="200">200 OK</SelectItem>
              <SelectItem value="400">400</SelectItem>
              <SelectItem value="401">401</SelectItem>
              <SelectItem value="429">429</SelectItem>
              <SelectItem value="500">500</SelectItem>
            </SelectContent>
          </Select>

          {onRangeChange && (
            <UsageDateRangePicker
              selection={range}
              triggerLabel={rangeLabel}
              onApply={onRangeChange}
            />
          )}
          <div className="ml-auto flex items-center gap-2">
            <span
              className={`inline-flex h-7 min-w-[72px] items-center justify-end gap-1 text-xs text-muted-foreground transition-opacity ${
                isFetching && result ? "opacity-100" : "invisible opacity-0"
              }`}
              aria-hidden={!(isFetching && result)}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  isFetching && result ? "animate-spin" : ""
                }`}
              />
              {t("common.loading", { defaultValue: "更新中" })}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                  disabled={clearMutation.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("usage.clearRequestLogs", {
                    defaultValue: "清空日志",
                  })}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuItem
                  className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                  onSelect={() => setClearConfirmOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("usage.clearAllRequestLogs", {
                    defaultValue: "清空全部请求日志",
                  })}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>
                  {t("usage.requestLogAutoCleanup", {
                    defaultValue: "自动清理",
                  })}
                </DropdownMenuLabel>
                <div className="flex items-center justify-between gap-3 px-2 py-1.5">
                  <span className="text-xs text-muted-foreground">
                    {t("usage.requestLogAutoCleanupDescription", {
                      defaultValue: "按保留条数定期归档旧日志",
                    })}
                  </span>
                  <Switch
                    checked={autoCleanupEnabled}
                    disabled={retentionMutation.isPending}
                    onCheckedChange={(checked) => saveRetentionConfig(checked)}
                    aria-label={t("usage.requestLogAutoCleanup", {
                      defaultValue: "自动清理",
                    })}
                  />
                </div>
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={1}
                    value={retainCountInput}
                    onChange={(event) =>
                      setRetainCountInput(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        const value = parsedRetainCount();
                        if (value != null) {
                          saveRetentionConfig(
                            autoCleanupEnabled,
                            String(value),
                          );
                        }
                      }
                    }}
                    aria-label={t("usage.requestLogRetainCount", {
                      defaultValue: "保留最近条数",
                    })}
                    className="h-8 min-w-0 flex-1 text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 shrink-0 text-xs"
                    disabled={retentionMutation.isPending}
                    onClick={() => {
                      const value = parsedRetainCount();
                      if (value != null) {
                        saveRetentionConfig(autoCleanupEnabled, String(value));
                      }
                    }}
                  >
                    {t("common.apply", { defaultValue: "应用" })}
                  </Button>
                </div>
                <p className="px-2 pb-1 text-[11px] text-muted-foreground">
                  {t("usage.requestLogRetainCount", {
                    defaultValue: "保留最近条数",
                  })}
                </p>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <>
        <div
          className="min-h-[400px] rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm overflow-x-auto"
          aria-busy={isFetching}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.time")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.provider")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.session", { defaultValue: "会话" })}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.billingModel")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.inputTokens")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.outputTokens")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.totalCost")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.timingInfo")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.status")}
                </TableHead>
                <TableHead className="text-center whitespace-nowrap">
                  {t("usage.source", { defaultValue: "Source" })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody
              className={
                isPlaceholderData
                  ? "pointer-events-none opacity-60 transition-opacity"
                  : "transition-opacity"
              }
            >
              {isLoading && !result ? (
                Array.from({ length: 8 }, (_, rowIndex) => (
                  <TableRow
                    key={`loading-${rowIndex}`}
                    data-testid="request-log-loading-row"
                  >
                    {Array.from({ length: 10 }, (_, cellIndex) => (
                      <TableCell key={cellIndex} className="h-11 px-2">
                        <div className="mx-auto h-3 w-16 animate-pulse rounded bg-muted" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center text-muted-foreground"
                  >
                    {t("usage.noData")}
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((log) => {
                  const unpriced = isUnpricedUsage(log);
                  const requestModel = log.requestModel?.trim() || "";
                  const actualModel = log.model;
                  const showRequestModel =
                    requestModel.length > 0 && requestModel !== actualModel;
                  const modelTitle = showRequestModel
                    ? `${actualModel} (req: ${requestModel})`
                    : actualModel;

                  return (
                    <TableRow
                      key={log.requestId}
                      className={
                        isPlaceholderData ? "cursor-wait" : "cursor-pointer"
                      }
                      aria-disabled={isPlaceholderData || undefined}
                      onDoubleClick={() => {
                        if (isPlaceholderData) return;
                        if (onOpenRequestDetail) {
                          onOpenRequestDetail(log);
                          return;
                        }
                        setDetailRequest(log);
                        setDetailRequestId(log.requestId);
                      }}
                    >
                      <TableCell className="text-center whitespace-nowrap text-xs px-1.5">
                        {new Date(log.createdAt * 1000).toLocaleString(locale, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </TableCell>
                      <TableCell className="text-center">
                        {log.providerName || t("usage.unknownProvider")}
                      </TableCell>
                      <TableCell className="text-center max-w-[220px]">
                        {log.sessionTitle || log.projectPath ? (
                          <div className="space-y-0.5">
                            <div
                              className="truncate text-xs font-medium"
                              title={log.sessionTitle || undefined}
                            >
                              {log.sessionTitle || "-"}
                            </div>
                            {log.projectPath && (
                              <div
                                className="truncate text-[11px] text-muted-foreground"
                                title={log.projectPath}
                              >
                                {log.projectPath}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            -
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs max-w-[200px]">
                        <div className="truncate" title={modelTitle}>
                          <div className="truncate">{actualModel}</div>
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
                      <TableCell className="text-center px-1.5">
                        {(() => {
                          const freshInput = getFreshInputTokens(log);
                          const isCacheInclusive =
                            log.inputTokens !== freshInput;
                          return (
                            <div
                              className="tabular-nums"
                              title={
                                isCacheInclusive
                                  ? `Raw: ${log.inputTokens.toLocaleString()}`
                                  : undefined
                              }
                            >
                              {fmtInt(freshInput, locale)}
                            </div>
                          );
                        })()}
                        {(log.cacheReadTokens > 0 ||
                          log.cacheCreationTokens > 0) && (
                          <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {[
                              log.cacheReadTokens > 0 &&
                                `R${fmtInt(log.cacheReadTokens, locale)}`,
                              log.cacheCreationTokens > 0 &&
                                `W${fmtInt(log.cacheCreationTokens, locale)}`,
                            ]
                              .filter(Boolean)
                              .join("·")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {fmtInt(log.outputTokens, locale)}
                      </TableCell>
                      <TableCell className="text-center px-1.5">
                        <div
                          className={`font-medium tabular-nums ${
                            unpriced ? "text-muted-foreground" : ""
                          }`}
                        >
                          {unpriced
                            ? t("usage.unpriced", "未定价")
                            : fmtUsd(log.totalCostUsd, 4)}
                        </div>
                        {parseFiniteNumber(log.costMultiplier) != null &&
                          parseFiniteNumber(log.costMultiplier) !== 1 && (
                            <div className="text-[11px] text-muted-foreground">
                              ×
                              {parseFiniteNumber(log.costMultiplier)?.toFixed(
                                2,
                              )}
                            </div>
                          )}
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap text-xs tabular-nums">
                        {(log.latencyMs / 1000).toFixed(1)}s
                        {log.firstTokenMs != null && (
                          <span className="text-muted-foreground">
                            /{(log.firstTokenMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <span
                          className={
                            log.statusCode >= 200 && log.statusCode < 300
                              ? "text-green-600"
                              : "text-red-600"
                          }
                        >
                          {log.statusCode}
                        </span>
                      </TableCell>
                      <TableCell className="text-center text-xs text-muted-foreground">
                        {log.dataSource || "proxy"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t("usage.totalRecords", { total })}</span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {(() => {
              const pages: (number | string)[] = [];
              if (totalPages <= 9) {
                for (let i = 0; i < totalPages; i++) pages.push(i);
              } else {
                const pageSet = new Set<number>();
                for (let i = 0; i < 3; i++) pageSet.add(i);
                for (let i = totalPages - 3; i < totalPages; i++)
                  pageSet.add(i);
                for (
                  let i = Math.max(0, page - 1);
                  i <= Math.min(totalPages - 1, page + 1);
                  i++
                )
                  pageSet.add(i);
                const sorted = Array.from(pageSet).sort((a, b) => a - b);
                for (let i = 0; i < sorted.length; i++) {
                  if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
                    pages.push(`ellipsis-${i}`);
                  }
                  pages.push(sorted[i]);
                }
              }
              return pages.map((p) =>
                typeof p === "string" ? (
                  <span key={p} className="px-2 text-muted-foreground">
                    ...
                  </span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? "default" : "outline"}
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => setPage(p)}
                  >
                    {p + 1}
                  </Button>
                ),
              );
            })()}
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1 ml-2">
              <Input
                type="text"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleGoToPage();
                }}
                placeholder={t("usage.pageInputPlaceholder")}
                className="h-8 w-16 text-center text-xs"
              />
              <Button variant="outline" size="sm" onClick={handleGoToPage}>
                {t("usage.goToPage")}
              </Button>
            </div>
          </div>
        </div>
      </>
      <ConfirmDialog
        isOpen={clearConfirmOpen}
        title={t("usage.clearRequestLogsTitle", {
          defaultValue: "清空请求日志",
        })}
        message={t("usage.clearRequestLogsConfirm", {
          defaultValue:
            "将删除所有请求日志明细，但保留已汇总的使用统计。此操作无法撤销。",
        })}
        confirmText={t("usage.clearRequestLogsConfirmAction", {
          defaultValue: "清空日志",
        })}
        onConfirm={handleClearLogs}
        onCancel={() => setClearConfirmOpen(false)}
      />
      {!onOpenRequestDetail && detailRequestId && (
        <RequestDetailPanel
          requestId={detailRequestId}
          initialRequest={detailRequest}
          onClose={() => {
            setDetailRequestId(null);
            setDetailRequest(null);
          }}
        />
      )}
    </div>
  );
}
