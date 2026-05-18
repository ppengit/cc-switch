import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRequestDetail } from "@/lib/query/usage";
import {
  getFreshInputTokens,
  isUnpricedUsage,
  type RequestLog,
} from "@/types/usage";

interface RequestDetailPanelProps {
  requestId: string;
  initialRequest?: RequestLog | null;
  onClose: () => void;
}

export function RequestDetailPanel({
  requestId,
  initialRequest = null,
  onClose,
}: RequestDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const { data: request, isLoading, error } = useRequestDetail(requestId);
  const resolvedRequest = request ?? initialRequest;
  const dateLocale =
    i18n.language === "zh"
      ? "zh-CN"
      : i18n.language === "ja"
        ? "ja-JP"
        : "en-US";

  if (isLoading && !resolvedRequest) {
    return (
      <Dialog open onOpenChange={onClose}>
        <DialogContent zIndex="top" className="max-w-4xl">
          <div className="h-[400px] animate-pulse rounded bg-gray-100" />
        </DialogContent>
      </Dialog>
    );
  }

  if (!resolvedRequest) {
    return (
      <Dialog open onOpenChange={onClose}>
        <DialogContent zIndex="top" className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("usage.requestDetail", "请求详情")}</DialogTitle>
          </DialogHeader>
          <div className="text-center text-muted-foreground">
            {error
              ? t("usage.requestDetailLoadFailed", {
                  defaultValue: "加载请求详情失败",
                })
              : t("usage.requestNotFound", "请求未找到")}
          </div>
          {error ? (
            <div className="break-all rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
              {error instanceof Error ? error.message : String(error)}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    );
  }

  const metadataPayload = {
    requestId: resolvedRequest.requestId,
    appType: resolvedRequest.appType,
    providerId: resolvedRequest.providerId,
    providerType: resolvedRequest.providerType ?? null,
    sessionId: resolvedRequest.sessionId ?? null,
    sessionTitle: resolvedRequest.sessionTitle ?? null,
    projectPath: resolvedRequest.projectPath ?? null,
    requestModel: resolvedRequest.requestModel ?? null,
    model: resolvedRequest.model,
    dataSource: resolvedRequest.dataSource ?? "proxy",
    isStreaming: resolvedRequest.isStreaming,
    statusCode: resolvedRequest.statusCode,
    latencyMs: resolvedRequest.latencyMs,
    firstTokenMs: resolvedRequest.firstTokenMs ?? null,
    durationMs: resolvedRequest.durationMs ?? null,
    createdAt: resolvedRequest.createdAt,
  };
  const freshInput = getFreshInputTokens(resolvedRequest);
  const isCacheInclusive = resolvedRequest.inputTokens !== freshInput;
  const unpriced = isUnpricedUsage(resolvedRequest);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        zIndex="top"
        className="max-w-4xl max-h-[88vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{t("usage.requestDetail", "请求详情")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {isLoading && initialRequest ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              {t("usage.requestDetailLoadingLatest", {
                defaultValue: "正在加载更完整的请求详情，当前先展示列表摘要。",
              })}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {t("usage.requestDetailFallbackNotice", {
                defaultValue:
                  "详细记录读取失败，当前展示的是列表中的摘要信息。",
              })}
            </div>
          ) : null}
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
                <dd className="font-mono">{resolvedRequest.requestId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.time", "时间")}
                </dt>
                <dd>
                  {new Date(resolvedRequest.createdAt * 1000).toLocaleString(
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
                    {resolvedRequest.providerName ||
                      t("usage.unknownProvider", "未知")}
                  </span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {resolvedRequest.providerId}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.appType", "应用类型")}
                </dt>
                <dd>{resolvedRequest.appType}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.actualModel", "实际模型")}
                </dt>
                <dd className="font-mono">{resolvedRequest.model}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.requestModel", "请求模型")}
                </dt>
                <dd className="font-mono text-xs">
                  {resolvedRequest.requestModel || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.sessionId", "会话 ID")}
                </dt>
                <dd className="font-mono text-xs">
                  {resolvedRequest.sessionId || "-"}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">
                  {t("usage.sessionTitle", "会话标题")}
                </dt>
                <dd>{resolvedRequest.sessionTitle || "-"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">
                  {t("usage.projectPath", "项目路径")}
                </dt>
                <dd className="font-mono text-xs break-all">
                  {resolvedRequest.projectPath || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.status", "状态")}
                </dt>
                <dd>
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs ${
                      resolvedRequest.statusCode >= 200 &&
                      resolvedRequest.statusCode < 300
                        ? "bg-green-100 text-green-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {resolvedRequest.statusCode}
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
                  {freshInput.toLocaleString()}
                  {isCacheInclusive && (
                    <span className="ml-2 text-xs text-muted-foreground/70 font-normal">
                      ({t("usage.rawInputLabel", "原始")}:{" "}
                      {resolvedRequest.inputTokens.toLocaleString()})
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.outputTokens", "输出 Tokens")}
                </dt>
                <dd className="font-mono">
                  {resolvedRequest.outputTokens.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheReadTokens", "缓存读取")}
                </dt>
                <dd className="font-mono">
                  {resolvedRequest.cacheReadTokens.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.cacheCreationTokens", "缓存写入")}
                </dt>
                <dd className="font-mono">
                  {resolvedRequest.cacheCreationTokens.toLocaleString()}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">
                  {t("usage.totalTokens", "总计")}
                </dt>
                <dd className="text-lg font-semibold">
                  {(freshInput + resolvedRequest.outputTokens).toLocaleString()}
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
                  ${parseFloat(resolvedRequest.inputCostUsd).toFixed(6)}
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
                  ${parseFloat(resolvedRequest.outputCostUsd).toFixed(6)}
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
                  ${parseFloat(resolvedRequest.cacheReadCostUsd).toFixed(6)}
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
                  ${parseFloat(resolvedRequest.cacheCreationCostUsd).toFixed(6)}
                </dd>
              </div>
              {/* 显示成本倍率（如果不等于1） */}
              {resolvedRequest.costMultiplier &&
                parseFloat(resolvedRequest.costMultiplier) !== 1 && (
                  <div className="col-span-2 border-t pt-3">
                    <dt className="text-muted-foreground">
                      {t("usage.costMultiplier", "成本倍率")}
                    </dt>
                    <dd className="font-mono">
                      ×{resolvedRequest.costMultiplier}
                    </dd>
                  </div>
                )}
              <div
                className={`col-span-2 ${resolvedRequest.costMultiplier && parseFloat(resolvedRequest.costMultiplier) !== 1 ? "" : "border-t"} pt-3`}
              >
                <dt className="text-muted-foreground">
                  {t("usage.totalCost", "总成本")}
                  {resolvedRequest.costMultiplier &&
                    parseFloat(resolvedRequest.costMultiplier) !== 1 && (
                      <span className="ml-1 text-xs">
                        ({t("usage.withMultiplier", "含倍率")})
                      </span>
                    )}
                </dt>
                <dd
                  className={`text-lg font-semibold ${
                    unpriced ? "text-muted-foreground" : "text-primary"
                  }`}
                >
                  {unpriced
                    ? t("usage.unpriced", "未定价")
                    : `$${parseFloat(resolvedRequest.totalCostUsd).toFixed(6)}`}
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
                <dd className="font-mono">{resolvedRequest.latencyMs}ms</dd>
              </div>
            </dl>
          </div>

          {/* 错误信息 */}
          {resolvedRequest.errorMessage && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <h3 className="mb-2 font-semibold text-red-800">
                {t("usage.errorMessage", "错误信息")}
              </h3>
              <p className="text-sm text-red-700">
                {resolvedRequest.errorMessage}
              </p>
            </div>
          )}

          <div className="rounded-lg border p-4">
            <h3 className="mb-2 font-semibold">
              {t("usage.requestMetadata", "请求元数据")}
            </h3>
            <pre className="max-h-56 overflow-auto rounded bg-muted p-3 text-xs leading-relaxed">
              {JSON.stringify(metadataPayload, null, 2)}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
