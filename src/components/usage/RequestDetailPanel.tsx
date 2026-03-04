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
import type { RequestLog } from "@/types/usage";

interface RequestDetailPanelProps {
  requestId: string;
  onClose: () => void;
  initialRequest?: RequestLog | null;
}

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
  const request = requestData ?? initialRequest ?? null;
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
        <DialogContent className="max-w-2xl">
          {renderHeader()}
          <div className="h-[400px] animate-pulse rounded bg-muted/60" />
        </DialogContent>
      </Dialog>
    );
  }

  if (isError && !request) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          {renderHeader()}
          <div className="text-center text-sm text-red-600 dark:text-red-400">
            {String(error ?? t("common.error", "错误"))}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!request) {
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          {renderHeader()}
          <div className="text-center text-muted-foreground">
            {t("usage.requestNotFound", "请求未找到")}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        {renderHeader()}

        <div className="space-y-4">
          {/* 基本信息 */}
          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.basicInfo", "基本信息")}
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.requestId", "请求ID")}
                </dt>
                <dd className="font-mono">{request.requestId}</dd>
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
                  {t("usage.provider", "供应商")}
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
                  {t("usage.model", "模型")}
                </dt>
                <dd className="font-mono">{request.model}</dd>
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
            </dl>
          </div>

          {/* Token 使用量 */}
          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.tokenUsage", "Token 使用量")}
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.inputTokens", "输入 Tokens")}
                </dt>
                <dd className="font-mono">
                  {request.inputTokens.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.outputTokens", "输出 Tokens")}
                </dt>
                <dd className="font-mono">
                  {request.outputTokens.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheReadTokens", "缓存读取")}
                </dt>
                <dd className="font-mono">
                  {request.cacheReadTokens.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheCreationTokens", "缓存写入")}
                </dt>
                <dd className="font-mono">
                  {request.cacheCreationTokens.toLocaleString()}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">
                  {t("usage.totalTokens", "总计")}
                </dt>
                <dd className="text-lg font-semibold">
                  {(
                    request.inputTokens + request.outputTokens
                  ).toLocaleString()}
                </dd>
              </div>
            </dl>
          </div>

          {/* 成本明细 */}
          <div className="rounded-lg border p-4">
            <h3 className="mb-3 font-semibold">
              {t("usage.costBreakdown", "成本明细")}
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.inputCost", "输入成本")}
                  <span className="ml-1 text-xs">
                    ({t("usage.baseCost", "基础")})
                  </span>
                </dt>
                <dd className="font-mono">
                  ${parseFloat(request.inputCostUsd).toFixed(6)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.outputCost", "输出成本")}
                  <span className="ml-1 text-xs">
                    ({t("usage.baseCost", "基础")})
                  </span>
                </dt>
                <dd className="font-mono">
                  ${parseFloat(request.outputCostUsd).toFixed(6)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheReadCost", "缓存读取成本")}
                  <span className="ml-1 text-xs">
                    ({t("usage.baseCost", "基础")})
                  </span>
                </dt>
                <dd className="font-mono">
                  ${parseFloat(request.cacheReadCostUsd).toFixed(6)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheCreationCost", "缓存写入成本")}
                  <span className="ml-1 text-xs">
                    ({t("usage.baseCost", "基础")})
                  </span>
                </dt>
                <dd className="font-mono">
                  ${parseFloat(request.cacheCreationCostUsd).toFixed(6)}
                </dd>
              </div>
              {/* 显示成本倍率（如果不等于1） */}
              {request.costMultiplier &&
                parseFloat(request.costMultiplier) !== 1 && (
                  <div className="col-span-2 border-t pt-3">
                    <dt className="text-muted-foreground">
                      {t("usage.costMultiplier", "成本倍率")}
                    </dt>
                    <dd className="font-mono">x{request.costMultiplier}</dd>
                  </div>
                )}
              <div
                className={`col-span-2 ${request.costMultiplier && parseFloat(request.costMultiplier) !== 1 ? "" : "border-t"} pt-3`}
              >
                <dt className="text-muted-foreground">
                  {t("usage.totalCost", "总成本")}
                  {request.costMultiplier &&
                    parseFloat(request.costMultiplier) !== 1 && (
                      <span className="ml-1 text-xs">
                        ({t("usage.withMultiplier", "含倍率")})
                      </span>
                    )}
                </dt>
                <dd className="text-lg font-semibold text-primary">
                  ${parseFloat(request.totalCostUsd).toFixed(6)}
                </dd>
              </div>
            </dl>
          </div>

          {/* 性能信息 */}
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
            </dl>
          </div>

          {/* 错误信息 */}
          {request.errorMessage && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/30">
              <h3 className="mb-2 font-semibold text-red-800 dark:text-red-200">
                {t("usage.errorMessage", "错误信息")}
              </h3>
              <p className="text-sm text-red-700 dark:text-red-300">
                {request.errorMessage}
              </p>
            </div>
          )}

          {/* 全部字段 */}
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
