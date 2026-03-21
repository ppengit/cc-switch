import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { useRequestDetail } from "@/lib/query/usage";
import { useSessionsQuery } from "@/lib/query";
import type { RequestLog } from "@/types/usage";
import { fmtTokenCompact } from "./format";
import { formatSessionTitle, getBaseName } from "@/components/sessions/utils";

interface RequestDetailPanelProps {
  requestId: string;
  onClose: () => void;
  initialRequest?: RequestLog | null;
}

const parseCost = (value: string) => {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

export function RequestDetailPanel({
  requestId,
  onClose,
  initialRequest = null,
}: RequestDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const {
    data: requestData,
    isLoading,
    isError,
    error,
  } = useRequestDetail(requestId);
  const { data: sessions = [] } = useSessionsQuery();

  const request = requestData ?? initialRequest ?? null;
  const sessionMeta =
    request?.sessionId != null
      ? sessions.find(
          (session) =>
            session.sessionId === request.sessionId &&
            session.providerId === request.appType,
        ) ??
        sessions.find((session) => session.sessionId === request.sessionId) ??
        null
      : null;
  const sessionTitle = sessionMeta ? formatSessionTitle(sessionMeta) : "";
  const sessionProjectName = sessionMeta
    ? getBaseName(sessionMeta.projectDir)
    : "";
  const dateLocale =
    i18n.language === "zh"
      ? "zh-CN"
      : i18n.language === "ja"
        ? "ja-JP"
        : "en-US";

  const title = t("usage.requestDetail", "请求详情");
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      onClose();
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const renderHeader = () => (
    <DialogHeader className="flex-row items-center justify-between space-y-0">
      <DialogTitle>{title}</DialogTitle>
      <DialogClose asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          aria-label={t("common.close", "关闭")}
        >
          <X className="h-4 w-4" />
        </Button>
      </DialogClose>
    </DialogHeader>
  );

  if (isLoading) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl p-0">
          <div className="p-6">{renderHeader()}</div>
          <div className="h-[400px] animate-pulse rounded bg-muted/60 mx-6 mb-6" />
        </DialogContent>
      </Dialog>
    );
  }

  if (isError && !request) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl p-0">
          <div className="p-6 space-y-4">
            {renderHeader()}
            <div className="text-center text-sm text-red-600 dark:text-red-400">
              {String(error ?? t("common.error", "错误"))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!request) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl p-0">
          <div className="p-6 space-y-4">
            {renderHeader()}
            <div className="text-center text-muted-foreground">
              {t("usage.requestNotFound", "请求未找到")}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto p-0">
        <div className="p-6">{renderHeader()}</div>

        <div className="space-y-4 px-6 pb-6">
          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.basicInfo", "基础信息")}
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.requestId", "请求 ID")}
                </dt>
                <dd className="font-mono break-all">{request.requestId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.time", "时间")}
                </dt>
                <dd>
                  {new Date(request.createdAt * 1000).toLocaleString(
                    dateLocale,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.provider", "提供商")}
                </dt>
                <dd className="text-sm">
                  <span className="font-medium">
                    {request.providerName || t("usage.unknownProvider", "未知")}
                  </span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {request.providerId}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.appType", "应用类型")}
                </dt>
                <dd>{request.appType}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.sessionRouting", "会话路由")}
                </dt>
                <dd>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                      request.sessionRoutingActive
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {request.sessionRoutingActive
                      ? t("usage.sessionRoutingActive", "已启用")
                      : t("usage.sessionRoutingInactive", "未启用")}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.status", "状态")}
                </dt>
                <dd>
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs ${
                      request.statusCode >= 200 && request.statusCode < 300
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                        : "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200"
                    }`}
                  >
                    {request.statusCode}
                  </span>
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">
                  {t("usage.sessionId", "会话 ID")}
                </dt>
                <dd className="font-mono break-all">
                  {request.sessionId || "-"}
                </dd>
              </div>
              {sessionTitle ? (
                <div className="col-span-2">
                  <dt className="text-muted-foreground">
                    {t("usage.sessionTitle", "会话名称")}
                  </dt>
                  <dd>
                    <div className="font-medium">{sessionTitle}</div>
                    {sessionProjectName ? (
                      <div className="text-xs text-muted-foreground">
                        {t("usage.sessionProject", "项目")}:{" "}
                        {sessionProjectName}
                      </div>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              <div className="col-span-2">
                <dt className="text-muted-foreground">
                  {t("usage.model", "模型")}
                </dt>
                <dd className="font-mono break-all">{request.model}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.tokenUsage", "Token 使用")}
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.inputTokens", "输入 Tokens")}
                </dt>
                <dd className="font-mono">
                  {fmtTokenCompact(request.inputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.outputTokens", "输出 Tokens")}
                </dt>
                <dd className="font-mono">
                  {fmtTokenCompact(request.outputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheReadTokens", "缓存读取")}
                </dt>
                <dd className="font-mono">
                  {fmtTokenCompact(request.cacheReadTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheCreationTokens", "缓存写入")}
                </dt>
                <dd className="font-mono">
                  {fmtTokenCompact(request.cacheCreationTokens)}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">
                  {t("usage.totalTokens", "总计")}
                </dt>
                <dd className="text-lg font-semibold">
                  {fmtTokenCompact(request.inputTokens + request.outputTokens)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.costBreakdown", "成本明细")}
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.inputCost", "输入成本")}
                </dt>
                <dd className="font-mono">
                  ${parseCost(request.inputCostUsd).toFixed(6)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.outputCost", "输出成本")}
                </dt>
                <dd className="font-mono">
                  ${parseCost(request.outputCostUsd).toFixed(6)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheReadCost", "缓存读取成本")}
                </dt>
                <dd className="font-mono">
                  ${parseCost(request.cacheReadCostUsd).toFixed(6)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheCreationCost", "缓存写入成本")}
                </dt>
                <dd className="font-mono">
                  ${parseCost(request.cacheCreationCostUsd).toFixed(6)}
                </dd>
              </div>
              <div className="col-span-2 border-t pt-3">
                <dt className="text-muted-foreground">
                  {t("usage.totalCost", "总成本")}
                </dt>
                <dd className="text-lg font-semibold text-primary">
                  ${parseCost(request.totalCostUsd).toFixed(6)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.performance", "性能信息")}
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.latency", "延迟")}
                </dt>
                <dd className="font-mono">{request.latencyMs}ms</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.duration", "总耗时")}
                </dt>
                <dd className="font-mono">
                  {typeof request.durationMs === "number"
                    ? `${request.durationMs}ms`
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.firstToken", "首 Token")}
                </dt>
                <dd className="font-mono">
                  {typeof request.firstTokenMs === "number"
                    ? `${request.firstTokenMs}ms`
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.streamType", "流式")}
                </dt>
                <dd>
                  {request.isStreaming
                    ? t("usage.stream", "流式")
                    : t("usage.nonStream", "非流式")}
                </dd>
              </div>
            </dl>
          </div>

          {request.errorMessage && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/30">
              <h3 className="mb-2 font-semibold text-red-800 dark:text-red-200">
                {t("usage.errorMessage", "错误信息")}
              </h3>
              <p className="text-sm text-red-700 dark:text-red-300 break-all">
                {request.errorMessage}
              </p>
            </div>
          )}

          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.allFields", "全部字段")}
            </h3>
            <pre className="max-h-[320px] overflow-auto rounded-md border bg-background/80 p-3 text-xs font-mono text-muted-foreground">
              {JSON.stringify(request, null, 2)}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
