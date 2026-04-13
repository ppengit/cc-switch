import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCleanupRequestLogsNow,
  useClearRequestLogsAll,
  useRequestLogCleanupConfig,
  useRequestLogs,
  useUpdateRequestLogCleanupConfig,
  usageKeys,
} from "@/lib/query/usage";
import { useSessionsQuery } from "@/lib/query";
import { useQueryClient } from "@tanstack/react-query";
import { useColumnResize } from "@/hooks/useColumnResize";
import type { LogFilters, RequestLog } from "@/types/usage";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { RequestDetailPanel } from "./RequestDetailPanel";
import { toast } from "sonner";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  fmtTokenCompact,
  fmtUsd,
  getLocaleFromLanguage,
  parseFiniteNumber,
} from "./format";
import { formatSessionTitle, getBaseName } from "@/components/sessions/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface RequestLogTableProps {
  appType?: string;
  refreshIntervalMs: number;
}

const ONE_DAY_SECONDS = 24 * 60 * 60;
const MAX_FIXED_RANGE_SECONDS = 30 * ONE_DAY_SECONDS;

type TimeMode = "rolling" | "fixed";
type RequestLogColumnKey =
  | "time"
  | "provider"
  | "sessionRouting"
  | "billingModel"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheCreationTokens"
  | "multiplier"
  | "totalCost"
  | "timingInfo"
  | "status";

const REQUEST_LOG_COLUMN_MIN_WIDTHS: Record<RequestLogColumnKey, number> = {
  time: 160,
  provider: 150,
  sessionRouting: 220,
  billingModel: 220,
  inputTokens: 110,
  outputTokens: 110,
  cacheReadTokens: 110,
  cacheCreationTokens: 120,
  multiplier: 95,
  totalCost: 110,
  timingInfo: 160,
  status: 90,
};

export function RequestLogTable({
  appType: dashboardAppType,
  refreshIntervalMs,
}: RequestLogTableProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const getRollingRange = () => {
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - ONE_DAY_SECONDS;
    return { startDate: oneDayAgo, endDate: now };
  };

  const [appliedTimeMode, setAppliedTimeMode] = useState<TimeMode>("rolling");
  const [draftTimeMode, setDraftTimeMode] = useState<TimeMode>("rolling");

  const [appliedFilters, setAppliedFilters] = useState<LogFilters>({});
  const [draftFilters, setDraftFilters] = useState<LogFilters>({});
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const [validationError, setValidationError] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<RequestLog | null>(
    null,
  );
  const [showCleanupControls, setShowCleanupControls] = useState(false);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [cleanupEnabledDraft, setCleanupEnabledDraft] = useState(true);
  const [retentionDaysDraft, setRetentionDaysDraft] = useState("30");
  const [clearStatisticsDraft, setClearStatisticsDraft] = useState(false);
  const { widths: columnWidths, startResize: startColumnResize } =
    useColumnResize<RequestLogColumnKey>({
      initialWidths: {
        time: 170,
        provider: 160,
        sessionRouting: 240,
        billingModel: 260,
        inputTokens: 120,
        outputTokens: 120,
        cacheReadTokens: 120,
        cacheCreationTokens: 135,
        multiplier: 100,
        totalCost: 120,
        timingInfo: 170,
        status: 95,
      },
      minWidths: REQUEST_LOG_COLUMN_MIN_WIDTHS,
    });

  const { data: cleanupConfig } = useRequestLogCleanupConfig();
  const updateCleanupConfig = useUpdateRequestLogCleanupConfig();
  const cleanupLogsNow = useCleanupRequestLogsNow();
  const clearAllLogs = useClearRequestLogsAll();

  useEffect(() => {
    if (!cleanupConfig) return;
    setCleanupEnabledDraft(cleanupConfig.enabled);
    setRetentionDaysDraft(String(cleanupConfig.retentionDays));
    setClearStatisticsDraft(cleanupConfig.clearStatistics);
  }, [cleanupConfig]);

  // When dashboard-level app filter is active (not "all"), override the local appType filter
  const dashboardAppTypeActive = dashboardAppType && dashboardAppType !== "all";
  const effectiveFilters: LogFilters = dashboardAppTypeActive
    ? { ...appliedFilters, appType: dashboardAppType }
    : appliedFilters;

  const { data: result, isLoading } = useRequestLogs({
    filters: effectiveFilters,
    timeMode: appliedTimeMode,
    rollingWindowSeconds: ONE_DAY_SECONDS,
    page,
    pageSize,
    options: {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  });

  const logs = result?.data ?? [];
  const total = result?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const { data: sessions = [] } = useSessionsQuery();

  const sessionMetaByKey = useMemo(() => {
    const byScopedKey = new Map<string, (typeof sessions)[number]>();
    const bySessionId = new Map<string, (typeof sessions)[number]>();

    for (const session of sessions) {
      byScopedKey.set(`${session.providerId}:${session.sessionId}`, session);
      if (!bySessionId.has(session.sessionId)) {
        bySessionId.set(session.sessionId, session);
      }
    }

    return { byScopedKey, bySessionId };
  }, [sessions]);

  const getLogSessionMeta = useCallback(
    (log: RequestLog) => {
      if (!log.sessionId) return null;
      return (
        sessionMetaByKey.byScopedKey.get(`${log.appType}:${log.sessionId}`) ??
        sessionMetaByKey.bySessionId.get(log.sessionId) ??
        null
      );
    },
    [sessionMetaByKey],
  );

  useEffect(() => {
    if (page === 0) return;
    if (total === 0) {
      setPage(0);
      return;
    }
    if (page >= totalPages) {
      setPage(Math.max(totalPages - 1, 0));
    }
  }, [page, total, totalPages]);

  const handleSearch = () => {
    setValidationError(null);

    if (draftTimeMode === "fixed") {
      const start = draftFilters.startDate;
      const end = draftFilters.endDate;

      if (typeof start !== "number" || typeof end !== "number") {
        setValidationError(
          t("usage.invalidTimeRange", "请选择完整的开始/结束时间"),
        );
        return;
      }

      if (start > end) {
        setValidationError(
          t("usage.invalidTimeRangeOrder", "开始时间不能晚于结束时间"),
        );
        return;
      }

      if (end - start > MAX_FIXED_RANGE_SECONDS) {
        setValidationError(
          t("usage.timeRangeTooLarge", "时间范围过大，请缩小范围"),
        );
        return;
      }
    }

    setAppliedTimeMode(draftTimeMode);
    setAppliedFilters((prev) => {
      const next = { ...prev, ...draftFilters };
      if (draftTimeMode === "rolling") {
        delete next.startDate;
        delete next.endDate;
      }
      return next;
    });
    setPage(0);
  };

  const handleReset = () => {
    setValidationError(null);
    setAppliedTimeMode("rolling");
    setDraftTimeMode("rolling");
    setDraftFilters({});
    setAppliedFilters({});
    setPage(0);
  };

  const handleRefresh = () => {
    const key = {
      timeMode: appliedTimeMode,
      rollingWindowSeconds:
        appliedTimeMode === "rolling" ? ONE_DAY_SECONDS : undefined,
      appType: appliedFilters.appType,
      providerName: appliedFilters.providerName,
      model: appliedFilters.model,
      sessionQuery: appliedFilters.sessionQuery,
      statusCode: appliedFilters.statusCode,
      sessionRoutingActive: appliedFilters.sessionRoutingActive,
      startDate:
        appliedTimeMode === "fixed" ? appliedFilters.startDate : undefined,
      endDate: appliedTimeMode === "fixed" ? appliedFilters.endDate : undefined,
    };

    queryClient.invalidateQueries({
      queryKey: usageKeys.logs(key, page, pageSize),
    });
  };

  const handleSaveCleanupConfig = async () => {
    const parsedRetentionDays = Number.parseInt(retentionDaysDraft, 10);
    if (
      !Number.isFinite(parsedRetentionDays) ||
      parsedRetentionDays < 1 ||
      parsedRetentionDays > 3650
    ) {
      toast.error(
        t("usage.cleanupRetentionValidation", {
          defaultValue: "保留天数需在 1-3650 之间",
        }),
      );
      return;
    }

    try {
      const updated = await updateCleanupConfig.mutateAsync({
        enabled: cleanupEnabledDraft,
        retentionDays: parsedRetentionDays,
        clearStatistics: clearStatisticsDraft,
      });
      setCleanupEnabledDraft(updated.enabled);
      setRetentionDaysDraft(String(updated.retentionDays));
      setClearStatisticsDraft(updated.clearStatistics);
      toast.success(
        t("usage.cleanupConfigSaved", {
          defaultValue: "请求日志清理配置已保存",
        }),
      );
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("usage.cleanupConfigSaveFailed", {
            defaultValue: "保存请求日志清理配置失败",
          }),
      );
    }
  };

  const handleCleanupNow = async () => {
    const parsedRetentionDays = Number.parseInt(retentionDaysDraft, 10);
    if (
      !Number.isFinite(parsedRetentionDays) ||
      parsedRetentionDays < 1 ||
      parsedRetentionDays > 3650
    ) {
      toast.error(
        t("usage.cleanupRetentionValidation", {
          defaultValue: "保留天数需在 1-3650 之间",
        }),
      );
      return;
    }

    try {
      const result = await cleanupLogsNow.mutateAsync({
        retentionDays: parsedRetentionDays,
        clearStatistics: clearStatisticsDraft,
      });
      if (result.deletedRows === 0) {
        toast.info(
          t("usage.cleanupNowNoop", {
            defaultValue: "未删除日志：当前记录均在保留期内",
          }),
        );
      } else {
        toast.success(
          t("usage.cleanupNowSuccess", {
            defaultValue: "清理完成，已删除 {{count}} 条日志",
            count: result.deletedRows,
          }),
        );
      }
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("usage.cleanupNowFailed", {
            defaultValue: "立即清理请求日志失败",
          }),
      );
    }
  };

  const handleClearAllLogs = () => {
    setShowClearAllConfirm(true);
  };

  const handleConfirmClearAllLogs = async () => {
    if (clearAllLogs.isPending) return;
    setShowClearAllConfirm(false);

    try {
      const result = await clearAllLogs.mutateAsync({
        clearStatistics: clearStatisticsDraft,
      });
      setSelectedRequest(null);
      setPage(0);
      toast.success(
        t("usage.clearAllLogsSuccess", {
          defaultValue: "已清空全部请求日志，共删除 {{count}} 条记录",
          count: result.deletedRows,
        }),
      );
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("usage.clearAllLogsFailed", {
            defaultValue: "清空全部请求日志失败",
          }),
      );
    }
  };

  // Convert Unix timestamp to local datetime-local input value.
  const timestampToLocalDatetime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // Convert datetime-local input value to Unix timestamp.
  const localDatetimeToTimestamp = (datetime: string): number | undefined => {
    if (!datetime) return undefined;
    // Validate format completeness (YYYY-MM-DDTHH:mm)
    if (datetime.length < 16) return undefined;
    const timestamp = new Date(datetime).getTime();
    if (Number.isNaN(timestamp)) return undefined;
    return Math.floor(timestamp / 1000);
  };

  const language = i18n.resolvedLanguage || i18n.language || "en";
  const locale = getLocaleFromLanguage(language);

  const rollingRangeForDisplay =
    draftTimeMode === "rolling" ? getRollingRange() : null;

  const renderColumnResizeHandle = useCallback(
    (columnKey: RequestLogColumnKey) => (
      <span
        role="separator"
        aria-orientation="vertical"
        className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none touch-none"
        onMouseDown={(event) => startColumnResize(columnKey, event)}
        onClick={(event) => event.stopPropagation()}
      />
    ),
    [startColumnResize],
  );

  const renderSessionRoutingCell = useCallback(
    (log: RequestLog) => {
      const sessionMeta =
        log.sessionRoutingActive && log.sessionId
          ? getLogSessionMeta(log)
          : null;
      const sessionTitle = sessionMeta ? formatSessionTitle(sessionMeta) : null;
      const sessionProjectName = sessionMeta
        ? getBaseName(sessionMeta.projectDir)
        : "";

      return (
        <div className="flex items-start gap-2 overflow-hidden">
          <span
            className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
              log.sessionRoutingActive
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {log.sessionRoutingActive
              ? t("usage.sessionRoutingActive", "已启用")
              : t("usage.sessionRoutingInactive", "未启用")}
          </span>
          {sessionTitle ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="min-w-0 overflow-hidden">
                  <div
                    className="truncate text-xs font-medium"
                    title={sessionTitle}
                  >
                    {sessionTitle}
                  </div>
                  <div
                    className="truncate font-mono text-[10px] text-muted-foreground"
                    title={log.sessionId ?? "-"}
                  >
                    {log.sessionId}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-left leading-relaxed">
                <div className="space-y-1">
                  <div className="font-medium">{sessionTitle}</div>
                  {sessionProjectName ? (
                    <div>
                      {t("usage.sessionProject", { defaultValue: "项目" })}:{" "}
                      {sessionProjectName}
                    </div>
                  ) : null}
                  <div className="font-mono text-primary-foreground/80">
                    {t("usage.sessionId", { defaultValue: "会话 ID" })}:{" "}
                    {log.sessionId}
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          ) : (
            <div
              className="truncate font-mono text-[10px] text-muted-foreground whitespace-nowrap"
              title={log.sessionId ?? "-"}
            >
              {log.sessionId || "-"}
            </div>
          )}
        </div>
      );
    },
    [getLogSessionMeta, t],
  );

  const logColumnDefs = useMemo(
    () => [
      {
        key: "time",
        width: columnWidths.time,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.time,
      },
      {
        key: "provider",
        width: columnWidths.provider,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.provider,
      },
      {
        key: "sessionRouting",
        width: columnWidths.sessionRouting,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.sessionRouting,
      },
      {
        key: "billingModel",
        width: columnWidths.billingModel,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.billingModel,
      },
      {
        key: "inputTokens",
        width: columnWidths.inputTokens,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.inputTokens,
      },
      {
        key: "outputTokens",
        width: columnWidths.outputTokens,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.outputTokens,
      },
      {
        key: "cacheReadTokens",
        width: columnWidths.cacheReadTokens,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.cacheReadTokens,
      },
      {
        key: "cacheCreationTokens",
        width: columnWidths.cacheCreationTokens,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.cacheCreationTokens,
      },
      {
        key: "multiplier",
        width: columnWidths.multiplier,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.multiplier,
      },
      {
        key: "totalCost",
        width: columnWidths.totalCost,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.totalCost,
      },
      {
        key: "timingInfo",
        width: columnWidths.timingInfo,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.timingInfo,
      },
      {
        key: "status",
        width: columnWidths.status,
        minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.status,
      },
    ],
    [columnWidths],
  );

  return (
    <div className="space-y-4">
      {/* 筛选栏 */}
      <div className="flex flex-col gap-4 rounded-lg border bg-card/50 p-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={
              dashboardAppTypeActive
                ? dashboardAppType
                : draftFilters.appType || "all"
            }
            onValueChange={(v) =>
              setDraftFilters({
                ...draftFilters,
                appType: v === "all" ? undefined : v,
              })
            }
            disabled={!!dashboardAppTypeActive}
          >
            <SelectTrigger className="w-[130px] bg-background">
              <SelectValue placeholder={t("usage.appType")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("usage.allApps")}</SelectItem>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="gemini">Gemini</SelectItem>
              <SelectItem value="opencode">OpenCode</SelectItem>
              <SelectItem value="openclaw">OpenClaw</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={draftFilters.statusCode?.toString() || "all"}
            onValueChange={(v) =>
              setDraftFilters({
                ...draftFilters,
                statusCode:
                  v === "all"
                    ? undefined
                    : Number.isFinite(Number.parseInt(v, 10))
                      ? Number.parseInt(v, 10)
                      : undefined,
              })
            }
          >
            <SelectTrigger className="w-[130px] bg-background">
              <SelectValue placeholder={t("usage.statusCode")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              <SelectItem value="200">200 OK</SelectItem>
              <SelectItem value="400">400 Bad Request</SelectItem>
              <SelectItem value="401">401 Unauthorized</SelectItem>
              <SelectItem value="429">429 Rate Limit</SelectItem>
              <SelectItem value="500">500 Server Error</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={
              draftFilters.sessionRoutingActive == null
                ? "all"
                : draftFilters.sessionRoutingActive
                  ? "enabled"
                  : "disabled"
            }
            onValueChange={(v) =>
              setDraftFilters({
                ...draftFilters,
                sessionRoutingActive: v === "all" ? undefined : v === "enabled",
              })
            }
          >
            <SelectTrigger className="w-[150px] bg-background">
              <SelectValue
                placeholder={t("usage.sessionRouting", {
                  defaultValue: "会话路由",
                })}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              <SelectItem value="enabled">
                {t("usage.sessionRoutingActive", "已启用")}
              </SelectItem>
              <SelectItem value="disabled">
                {t("usage.sessionRoutingInactive", "未启用")}
              </SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 flex-1 min-w-[300px]">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("usage.searchProviderPlaceholder")}
                className="pl-9 bg-background"
                value={draftFilters.providerName || ""}
                onChange={(e) =>
                  setDraftFilters({
                    ...draftFilters,
                    providerName: e.target.value || undefined,
                  })
                }
              />
            </div>
            <Input
              placeholder={t("usage.searchModelPlaceholder")}
              className="w-[180px] bg-background"
              value={draftFilters.model || ""}
              onChange={(e) =>
                setDraftFilters({
                  ...draftFilters,
                  model: e.target.value || undefined,
                })
              }
            />
            <Input
              placeholder={t("usage.searchSessionPlaceholder", {
                defaultValue: "搜索会话路由 / 会话 ID",
              })}
              className="w-[220px] bg-background"
              value={draftFilters.sessionQuery || ""}
              onChange={(e) =>
                setDraftFilters({
                  ...draftFilters,
                  sessionQuery: e.target.value || undefined,
                })
              }
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="whitespace-nowrap">{t("usage.timeRange")}:</span>
            <Input
              type="datetime-local"
              className="h-8 w-[200px] bg-background"
              value={
                (rollingRangeForDisplay?.startDate ?? draftFilters.startDate)
                  ? timestampToLocalDatetime(
                      (rollingRangeForDisplay?.startDate ??
                        draftFilters.startDate) as number,
                    )
                  : ""
              }
              onChange={(e) => {
                const timestamp = localDatetimeToTimestamp(e.target.value);
                setDraftTimeMode("fixed");
                setDraftFilters({
                  ...draftFilters,
                  startDate: timestamp,
                });
              }}
            />
            <span>-</span>
            <Input
              type="datetime-local"
              className="h-8 w-[200px] bg-background"
              value={
                (rollingRangeForDisplay?.endDate ?? draftFilters.endDate)
                  ? timestampToLocalDatetime(
                      (rollingRangeForDisplay?.endDate ??
                        draftFilters.endDate) as number,
                    )
                  : ""
              }
              onChange={(e) => {
                const timestamp = localDatetimeToTimestamp(e.target.value);
                setDraftTimeMode("fixed");
                setDraftFilters({
                  ...draftFilters,
                  endDate: timestamp,
                });
              }}
            />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <Button
              size="sm"
              variant="default"
              onClick={handleSearch}
              className="h-8"
            >
              <Search className="mr-2 h-3.5 w-3.5" />
              {t("common.search")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              className="h-8"
            >
              <X className="mr-2 h-3.5 w-3.5" />
              {t("common.reset")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleRefresh}
              className="h-8 px-2"
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Popover
              open={showCleanupControls}
              onOpenChange={setShowCleanupControls}
            >
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant={showCleanupControls ? "default" : "outline"}
                  className="h-8 gap-1.5"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {t("usage.cleanupControls", { defaultValue: "日志清理" })}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[380px] p-4">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={cleanupEnabledDraft}
                        onCheckedChange={setCleanupEnabledDraft}
                        disabled={updateCleanupConfig.isPending}
                      />
                      <span className="text-sm">
                        {t("usage.cleanupAutoSwitch", {
                          defaultValue: "自动清理请求日志",
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch
                      checked={clearStatisticsDraft}
                      onCheckedChange={setClearStatisticsDraft}
                      disabled={updateCleanupConfig.isPending}
                    />
                    <span className="text-sm">
                      {t("usage.cleanupClearStatistics", {
                        defaultValue: "清理时同时删除统计信息",
                      })}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        {t("usage.cleanupRetentionDays", {
                          defaultValue: "保留天数",
                        })}
                      </span>
                      <Input
                        type="number"
                        min={1}
                        max={3650}
                        step={1}
                        value={retentionDaysDraft}
                        onChange={(event) =>
                          setRetentionDaysDraft(event.target.value)
                        }
                        className="h-8 w-24 bg-background"
                      />
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleSaveCleanupConfig()}
                      disabled={updateCleanupConfig.isPending}
                    >
                      {t("common.save", { defaultValue: "保存" })}
                    </Button>

                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleCleanupNow()}
                      disabled={cleanupLogsNow.isPending}
                    >
                      {t("usage.cleanupNow", { defaultValue: "立即清理" })}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/20"
                      onClick={handleClearAllLogs}
                      disabled={clearAllLogs.isPending}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      {t("usage.clearAllLogs", {
                        defaultValue: "清空全部日志",
                      })}
                    </Button>

                    {cleanupConfig?.lastCleanupAt ? (
                      <span className="text-xs text-muted-foreground">
                        {t("usage.cleanupLastRun", {
                          defaultValue: "上次清理：{{time}}",
                          time: new Date(
                            cleanupConfig.lastCleanupAt * 1000,
                          ).toLocaleString(locale),
                        })}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t("usage.cleanupNeverRun", {
                          defaultValue: "上次清理：从未",
                        })}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("usage.cleanupHint", {
                      defaultValue:
                        "自动清理开启后，系统会按保留天数后台清理日志（默认每小时最多触发一次）。",
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("usage.cleanupClearStatisticsHint", {
                      defaultValue:
                        "默认仅清理明细日志，并把历史数据汇总到统计表中；开启后会连同统计信息一起删除。",
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("usage.cleanupNowHint", {
                      defaultValue:
                        "“立即清理”只会删除超出保留期的日志；如需彻底清空，请使用“清空全部日志”。",
                    })}
                  </p>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {validationError && (
          <div className="text-sm text-red-600 dark:text-red-400">
            {validationError}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="h-[400px] animate-pulse rounded bg-muted/60" />
      ) : (
        <>
          <div className="rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm overflow-x-auto">
            <Table>
              <colgroup>
                {logColumnDefs.map((column) => (
                  <col
                    key={column.key}
                    style={{ width: column.width, minWidth: column.minWidth }}
                  />
                ))}
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className="relative whitespace-nowrap"
                    style={{
                      width: columnWidths.time,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.time,
                    }}
                  >
                    {t("usage.time")}
                    {renderColumnResizeHandle("time")}
                  </TableHead>
                  <TableHead
                    className="relative whitespace-nowrap"
                    style={{
                      width: columnWidths.provider,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.provider,
                    }}
                  >
                    {t("usage.provider")}
                    {renderColumnResizeHandle("provider")}
                  </TableHead>
                  <TableHead
                    className="relative whitespace-nowrap"
                    style={{
                      width: columnWidths.sessionRouting,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.sessionRouting,
                    }}
                  >
                    {t("usage.sessionRouting", "会话路由")}
                    {renderColumnResizeHandle("sessionRouting")}
                  </TableHead>
                  <TableHead
                    className="relative whitespace-nowrap"
                    style={{
                      width: columnWidths.billingModel,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.billingModel,
                    }}
                  >
                    {t("usage.billingModel")}
                    {renderColumnResizeHandle("billingModel")}
                  </TableHead>
                  <TableHead
                    className="relative text-right whitespace-nowrap"
                    style={{
                      width: columnWidths.inputTokens,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.inputTokens,
                    }}
                  >
                    {t("usage.inputTokens")}
                    {renderColumnResizeHandle("inputTokens")}
                  </TableHead>
                  <TableHead
                    className="relative text-right whitespace-nowrap"
                    style={{
                      width: columnWidths.outputTokens,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.outputTokens,
                    }}
                  >
                    {t("usage.outputTokens")}
                    {renderColumnResizeHandle("outputTokens")}
                  </TableHead>
                  <TableHead
                    className="relative text-right whitespace-nowrap"
                    style={{
                      width: columnWidths.cacheReadTokens,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.cacheReadTokens,
                    }}
                  >
                    {t("usage.cacheReadTokens")}
                    {renderColumnResizeHandle("cacheReadTokens")}
                  </TableHead>
                  <TableHead
                    className="relative text-right whitespace-nowrap"
                    style={{
                      width: columnWidths.cacheCreationTokens,
                      minWidth:
                        REQUEST_LOG_COLUMN_MIN_WIDTHS.cacheCreationTokens,
                    }}
                  >
                    {t("usage.cacheCreationTokens")}
                    {renderColumnResizeHandle("cacheCreationTokens")}
                  </TableHead>
                  <TableHead
                    className="relative text-right whitespace-nowrap"
                    style={{
                      width: columnWidths.multiplier,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.multiplier,
                    }}
                  >
                    {t("usage.multiplier")}
                    {renderColumnResizeHandle("multiplier")}
                  </TableHead>
                  <TableHead
                    className="relative text-right whitespace-nowrap"
                    style={{
                      width: columnWidths.totalCost,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.totalCost,
                    }}
                  >
                    {t("usage.totalCost")}
                    {renderColumnResizeHandle("totalCost")}
                  </TableHead>
                  <TableHead
                    className="relative text-center whitespace-nowrap"
                    style={{
                      width: columnWidths.timingInfo,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.timingInfo,
                    }}
                  >
                    {t("usage.timingInfo")}
                    {renderColumnResizeHandle("timingInfo")}
                  </TableHead>
                  <TableHead
                    className="relative whitespace-nowrap"
                    style={{
                      width: columnWidths.status,
                      minWidth: REQUEST_LOG_COLUMN_MIN_WIDTHS.status,
                    }}
                  >
                    {t("usage.status")}
                    {renderColumnResizeHandle("status")}
                  </TableHead>
                  <TableHead className="whitespace-nowrap">
                    {t("usage.source", { defaultValue: "Source" })}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={12}
                      className="text-center text-muted-foreground"
                    >
                      {t("usage.noData")}
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => (
                    <TableRow
                      key={log.requestId}
                      className="cursor-pointer"
                      onDoubleClick={() => setSelectedRequest(log)}
                    >
                      <TableCell>
                        {new Date(log.createdAt * 1000).toLocaleString(locale)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span>
                            {log.providerName || t("usage.unknownProvider")}
                          </span>
                          {log.providerIsPublic && (
                            <span className="rounded border border-border/70 px-1 py-0 text-[10px] leading-none text-muted-foreground">
                              {t("provider.publicTag", {
                                defaultValue: "public",
                              })}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{renderSessionRoutingCell(log)}</TableCell>
                      <TableCell className="font-mono text-xs max-w-[200px]">
                        <div
                          className="truncate"
                          title={
                            log.requestModel && log.requestModel !== log.model
                              ? `${t("usage.requestModel")}: ${log.requestModel}\n${t("usage.responseModel")}: ${log.model}`
                              : log.model
                          }
                        >
                          {log.model}
                        </div>
                        {log.requestModel && log.requestModel !== log.model && (
                          <div
                            className="truncate text-muted-foreground text-[10px]"
                            title={log.requestModel}
                          >
                            {"-> "}
                            {log.requestModel}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtTokenCompact(log.inputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtTokenCompact(log.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtTokenCompact(log.cacheReadTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtTokenCompact(log.cacheCreationTokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {(parseFiniteNumber(log.costMultiplier) ?? 1) !== 1 ? (
                          <span className="text-orange-600 dark:text-orange-400">
                            x{log.costMultiplier}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">x1</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtUsd(log.totalCostUsd, 6)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-center gap-1">
                          {(() => {
                            const durationMs =
                              typeof log.durationMs === "number"
                                ? log.durationMs
                                : log.latencyMs;
                            const durationSec = durationMs / 1000;
                            const durationColor = Number.isFinite(durationSec)
                              ? durationSec <= 5
                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                                : durationSec <= 120
                                  ? "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200"
                                  : "bg-red-200 text-red-900 dark:bg-red-500/20 dark:text-red-200"
                              : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200";
                            return (
                              <span
                                className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs ${durationColor}`}
                              >
                                {Number.isFinite(durationSec)
                                  ? `${Math.round(durationSec)}s`
                                  : "--"}
                              </span>
                            );
                          })()}
                          {log.isStreaming &&
                            log.firstTokenMs != null &&
                            (() => {
                              const firstSec = log.firstTokenMs / 1000;
                              const firstColor = Number.isFinite(firstSec)
                                ? firstSec <= 5
                                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                                  : firstSec <= 120
                                    ? "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200"
                                    : "bg-red-200 text-red-900 dark:bg-red-500/20 dark:text-red-200"
                                : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200";
                              return (
                                <span
                                  className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs ${firstColor}`}
                                >
                                  {Number.isFinite(firstSec)
                                    ? `${firstSec.toFixed(1)}s`
                                    : "--"}
                                </span>
                              );
                            })()}
                          <span
                            className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs ${
                              log.isStreaming
                                ? "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"
                                : "bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200"
                            }`}
                          >
                            {log.isStreaming
                              ? t("usage.stream")
                              : t("usage.nonStream")}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs ${
                            log.statusCode >= 200 && log.statusCode < 300
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                              : "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200"
                          }`}
                        >
                          {log.statusCode}
                        </span>
                      </TableCell>
                      <TableCell>
                        {log.dataSource && log.dataSource !== "proxy" ? (
                          <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] bg-indigo-100 text-indigo-800">
                            {t(`usage.dataSource.${log.dataSource}`, {
                              defaultValue: log.dataSource,
                            })}
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] bg-gray-100 text-gray-600">
                            {t("usage.dataSource.proxy", {
                              defaultValue: "Proxy",
                            })}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* 分页控件 */}
          {total > 0 && (
            <div className="flex items-center justify-between px-2">
              <span className="text-sm text-muted-foreground">
                {t("usage.totalRecords", { total })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {/* 页码按钮 */}
                {(() => {
                  const pages: (number | string)[] = [];
                  if (totalPages <= 7) {
                    for (let i = 0; i < totalPages; i++) pages.push(i);
                  } else {
                    pages.push(0);
                    if (page > 2) pages.push("...");
                    for (
                      let i = Math.max(1, page - 1);
                      i <= Math.min(totalPages - 2, page + 1);
                      i++
                    ) {
                      pages.push(i);
                    }
                    if (page < totalPages - 3) pages.push("...");
                    pages.push(totalPages - 1);
                  }
                  return pages.map((p, idx) =>
                    typeof p === "string" ? (
                      <span
                        key={`ellipsis-${idx}`}
                        className="px-2 text-muted-foreground"
                      >
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
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page + 1)}
                  disabled={page >= totalPages - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedRequest && (
        <RequestDetailPanel
          requestId={selectedRequest.requestId}
          initialRequest={selectedRequest}
          onClose={() => setSelectedRequest(null)}
        />
      )}

      <ConfirmDialog
        isOpen={showClearAllConfirm}
        title={t("usage.clearAllLogsTitle", {
          defaultValue: "清空全部日志",
        })}
        message={
          clearStatisticsDraft
            ? t("usage.clearAllLogsConfirmWithStats", {
                defaultValue:
                  "将清空全部请求日志和统计信息，该操作不可恢复。是否继续？",
              })
            : t("usage.clearAllLogsConfirmWithoutStats", {
                defaultValue:
                  "将清空全部请求日志，统计信息会保留。该操作不可恢复。是否继续？",
              })
        }
        confirmText={t("usage.clearAllLogsAction", { defaultValue: "清空" })}
        onConfirm={() => void handleConfirmClearAllLogs()}
        onCancel={() => setShowClearAllConfirm(false)}
      />
    </div>
  );
}
