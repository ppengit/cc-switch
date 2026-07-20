import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  DoorOpen,
  RefreshCw,
  Route,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DEFAULT_RESPONSE_REPLAY_MATCH_ENDPOINTS,
  DEFAULT_RESPONSE_REPLAY_MATCH_KEYWORD_GROUPS,
  DEFAULT_RESPONSE_REPLAY_MATCH_STATUSES,
  formatResponseReplayEndpoints,
  formatResponseReplayKeywordGroups,
  formatResponseReplayStatuses,
  parseResponseReplayEndpoints,
  parseResponseReplayKeywordGroups,
  parseResponseReplayStatuses,
  responseReplayEditorConfig,
} from "@/lib/responseReplay";
import type {
  ProviderUpstreamAdmissionRetry,
  ProviderUpstreamResponseReplay,
} from "@/types";

export type PricingModelSourceOption = "inherit" | "request" | "response";

interface ProviderPricingConfig {
  enabled: boolean;
  costMultiplier?: string;
  pricingModelSource: PricingModelSourceOption;
}

interface ProviderRoutingRetryConfigProps {
  admissionRetryConfig: ProviderUpstreamAdmissionRetry;
  responseReplayConfig: ProviderUpstreamResponseReplay;
  showResponseReplay?: boolean;
  maxConcurrentRequests?: number;
  onAdmissionRetryConfigChange: (
    config: ProviderUpstreamAdmissionRetry,
  ) => void;
  onResponseReplayConfigChange: (
    config: ProviderUpstreamResponseReplay,
  ) => void;
  onMaxConcurrentRequestsChange: (value?: number) => void;
}

interface ProviderAdvancedConfigProps {
  pricingConfig: ProviderPricingConfig;
  onPricingConfigChange: (config: ProviderPricingConfig) => void;
}

export function ProviderRoutingRetryConfig({
  admissionRetryConfig,
  responseReplayConfig,
  showResponseReplay = false,
  maxConcurrentRequests,
  onAdmissionRetryConfigChange,
  onResponseReplayConfigChange,
  onMaxConcurrentRequestsChange,
}: ProviderRoutingRetryConfigProps) {
  const { t } = useTranslation();
  const hasAdmissionRetryTiming =
    admissionRetryConfig.maxRetries !== undefined ||
    admissionRetryConfig.scheduleMode !== undefined ||
    admissionRetryConfig.initialDelayMs !== undefined ||
    admissionRetryConfig.maxDelayMs !== undefined ||
    admissionRetryConfig.jitterMs !== undefined;
  const autoKeywordsText = (admissionRetryConfig.autoKeywords ?? []).join("\n");
  const hasAdmissionRetryAuto =
    admissionRetryConfig.autoEnabled === true || autoKeywordsText.trim() !== "";
  const hasAdmissionRetryNotify = admissionRetryConfig.notifyOnSuccess === true;
  const [isAdmissionRetryOpen, setIsAdmissionRetryOpen] = useState(
    admissionRetryConfig.enabled === true ||
      hasAdmissionRetryTiming ||
      hasAdmissionRetryAuto ||
      hasAdmissionRetryNotify,
  );
  const [isSessionRoutingConfigOpen, setIsSessionRoutingConfigOpen] = useState(
    maxConcurrentRequests !== undefined,
  );
  const hasResponseReplayConfig =
    responseReplayConfig.enabled === true ||
    responseReplayConfig.retryHttp429 === false ||
    responseReplayConfig.retryCodexConfiguredErrors === false ||
    responseReplayConfig.retryCodexBadResponse400 === false ||
    responseReplayConfig.codexMatchStatuses !== undefined ||
    responseReplayConfig.codexMatchEndpoints !== undefined ||
    responseReplayConfig.codexMatchKeywordGroups !== undefined ||
    responseReplayConfig.maxRetries !== undefined ||
    responseReplayConfig.initialDelayMs !== undefined ||
    responseReplayConfig.maxDelayMs !== undefined ||
    responseReplayConfig.jitterMs !== undefined ||
    responseReplayConfig.honorRetryAfter === false;
  const [isResponseReplayOpen, setIsResponseReplayOpen] = useState(
    hasResponseReplayConfig,
  );

  useEffect(() => {
    setIsAdmissionRetryOpen(
      admissionRetryConfig.enabled === true ||
        hasAdmissionRetryTiming ||
        hasAdmissionRetryAuto ||
        hasAdmissionRetryNotify,
    );
  }, [
    admissionRetryConfig.enabled,
    hasAdmissionRetryTiming,
    hasAdmissionRetryAuto,
    hasAdmissionRetryNotify,
  ]);

  useEffect(() => {
    if (maxConcurrentRequests !== undefined) {
      setIsSessionRoutingConfigOpen(true);
    }
  }, [maxConcurrentRequests]);

  useEffect(() => {
    if (hasResponseReplayConfig) setIsResponseReplayOpen(true);
  }, [hasResponseReplayConfig]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/50 bg-muted/20">
        <div
          role="button"
          tabIndex={0}
          className="flex w-full cursor-pointer items-center justify-between p-4 transition-colors hover:bg-muted/30"
          onClick={() => setIsSessionRoutingConfigOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setIsSessionRoutingConfigOpen((current) => !current);
            }
          }}
        >
          <div className="flex items-center gap-3">
            <Route className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">
              {t("providerAdvanced.sessionRoutingConfig", {
                defaultValue: "会话路由并发上限",
              })}
            </span>
          </div>
          {isSessionRoutingConfigOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div
          className={cn(
            "overflow-hidden transition-all duration-200",
            isSessionRoutingConfigOpen
              ? "max-h-[260px] opacity-100"
              : "max-h-0 opacity-0",
          )}
        >
          <div className="border-t border-border/50 p-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("providerAdvanced.sessionRoutingConfigDesc", {
                defaultValue:
                  "留空或填 0 表示无限制；会话绑定和正在请求会共用这个槽位上限，同一会话的并发请求也会计入。若会话路由开启满载兜底，所有供应商满载时仍可能临时超过上限。",
              })}
            </p>
            <div className="space-y-2 max-w-sm">
              <Label htmlFor="max-concurrent-requests">
                {t("providerAdvanced.maxConcurrentRequests", {
                  defaultValue: "最大并发请求数",
                })}
              </Label>
              <Input
                id="max-concurrent-requests"
                type="number"
                min={0}
                max={1000000}
                value={maxConcurrentRequests ?? ""}
                onChange={(e) =>
                  onMaxConcurrentRequestsChange(
                    e.target.value ? parseInt(e.target.value, 10) : undefined,
                  )
                }
                placeholder="0"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/50 bg-muted/20">
        <div
          role="button"
          tabIndex={0}
          className="flex w-full cursor-pointer items-center justify-between p-4 transition-colors hover:bg-muted/30"
          onClick={() => setIsAdmissionRetryOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setIsAdmissionRetryOpen((current) => !current);
            }
          }}
        >
          <div className="flex items-center gap-3">
            <DoorOpen className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">
              {t("providerAdvanced.admissionRetryConfig", {
                defaultValue: "上游入场重试",
              })}
            </span>
          </div>
          {isAdmissionRetryOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div
          className={cn(
            "overflow-hidden transition-all duration-200",
            isAdmissionRetryOpen
              ? "max-h-[1250px] opacity-100"
              : "max-h-0 opacity-0",
          )}
        >
          <div className="border-t border-border/50 p-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("providerAdvanced.admissionRetryConfigDesc", {
                defaultValue:
                  "当上游返回 overloaded、capacity、rate limit 等拥挤错误时，会按所选调度持续重试同一供应商；也可在供应商列表快速切换。不会重试认证、模型不存在、上下文超限等请求错误。",
              })}
            </p>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border/50 bg-background/40 p-3">
              <div className="space-y-1">
                <Label htmlFor="admission-enabled">
                  {t("providerAdvanced.admissionEnabled", {
                    defaultValue: "启用入场重试",
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.admissionEnabledHint", {
                    defaultValue:
                      "开启后，当前供应商遇到临时拥挤或限流错误时会重发同一请求，不触发故障转移或熔断。",
                  })}
                </p>
              </div>
              <Switch
                id="admission-enabled"
                checked={admissionRetryConfig.enabled === true}
                onCheckedChange={(checked) =>
                  onAdmissionRetryConfigChange({
                    ...admissionRetryConfig,
                    enabled: checked,
                  })
                }
              />
            </div>
            <div className="space-y-3 rounded-md border border-border/50 bg-background/40 p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="admission-auto-enabled">
                    {t("providerAdvanced.admissionAutoEnable", {
                      defaultValue: "自动开启",
                    })}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("providerAdvanced.admissionAutoEnableHint", {
                      defaultValue:
                        "打开后，当前请求命中下方关键词时会自动开启该供应商入场重试；入场成功后仍会自动关闭。",
                    })}
                  </p>
                </div>
                <Switch
                  id="admission-auto-enabled"
                  checked={admissionRetryConfig.autoEnabled === true}
                  onCheckedChange={(checked) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      autoEnabled: checked,
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admission-auto-keywords">
                  {t("providerAdvanced.admissionAutoKeywords", {
                    defaultValue: "自动开启关键词",
                  })}
                </Label>
                <Textarea
                  id="admission-auto-keywords"
                  value={autoKeywordsText}
                  onChange={(event) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      autoKeywords: event.target.value
                        .split(/\r?\n/)
                        .map((keyword) => keyword.trim())
                        .filter(Boolean),
                    })
                  }
                  rows={3}
                  placeholder={t(
                    "providerAdvanced.admissionAutoKeywordsPlaceholder",
                    {
                      defaultValue: "例如：负载已经达到上限",
                    },
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.admissionAutoKeywordsHint", {
                    defaultValue:
                      "每行一个关键词；匹配上游错误响应体或错误摘要，大小写不敏感。",
                  })}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border/50 bg-background/40 p-3">
              <div className="space-y-1">
                <Label htmlFor="admission-notify-on-success">
                  {t("providerAdvanced.admissionNotifyOnSuccess", {
                    defaultValue: "成功通知（弹窗+声音）",
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.admissionNotifyOnSuccessHint", {
                    defaultValue:
                      "入场成功并自动停止重试后，在右下角弹出提示并播放一声提醒，便于回到对应 CLI 继续会话。",
                  })}
                </p>
              </div>
              <Switch
                id="admission-notify-on-success"
                checked={admissionRetryConfig.notifyOnSuccess === true}
                onCheckedChange={(checked) =>
                  onAdmissionRetryConfigChange({
                    ...admissionRetryConfig,
                    notifyOnSuccess: checked,
                  })
                }
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="admission-schedule-mode">
                  {t("providerAdvanced.admissionScheduleMode", {
                    defaultValue: "重试调度",
                  })}
                </Label>
                <Select
                  value={admissionRetryConfig.scheduleMode ?? "afterResponse"}
                  onValueChange={(value) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      scheduleMode:
                        value === "fixedInterval"
                          ? "fixedInterval"
                          : "afterResponse",
                    })
                  }
                >
                  <SelectTrigger id="admission-schedule-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="afterResponse">
                      {t("providerAdvanced.admissionScheduleAfterResponse", {
                        defaultValue: "请求结束后等待",
                      })}
                    </SelectItem>
                    <SelectItem value="fixedInterval">
                      {t("providerAdvanced.admissionScheduleFixedInterval", {
                        defaultValue: "固定频率",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.admissionScheduleModeHint", {
                    defaultValue:
                      "请求结束后等待会在失败或超时后再等配置间隔；固定频率按请求发起时间计算间隔，单次失败耗时超过间隔时下一轮会立即开始。",
                  })}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="admission-max-retries">
                  {t("providerAdvanced.admissionMaxRetries", {
                    defaultValue: "最大入场重试次数",
                  })}
                </Label>
                <Input
                  id="admission-max-retries"
                  type="number"
                  min={0}
                  max={1000000}
                  value={admissionRetryConfig.maxRetries ?? ""}
                  onChange={(e) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      maxRetries: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder={t(
                    "providerAdvanced.admissionMaxRetriesPlaceholder",
                    {
                      defaultValue: "留空或 0 表示无限",
                    },
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.admissionMaxRetriesHint", {
                    defaultValue:
                      "达到阈值后会把最后一次上游错误返回给当前请求，但仍不会触发故障转移、降级或熔断。",
                  })}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="admission-initial-delay">
                  {t("providerAdvanced.admissionInitialDelay", {
                    defaultValue: "首次等待（毫秒）",
                  })}
                </Label>
                <Input
                  id="admission-initial-delay"
                  type="number"
                  min={0}
                  max={600000}
                  value={admissionRetryConfig.initialDelayMs ?? ""}
                  onChange={(e) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      initialDelayMs: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder="1000"
                />
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.admissionInitialDelayHint", {
                    defaultValue:
                      "控制首次重试的目标起始间隔；若上游这次失败本身已经耗时更久，则不会再额外补等。",
                  })}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="admission-max-delay">
                  {t("providerAdvanced.admissionMaxDelay", {
                    defaultValue: "重试间隔（毫秒）",
                  })}
                </Label>
                <Input
                  id="admission-max-delay"
                  type="number"
                  min={0}
                  max={600000}
                  value={admissionRetryConfig.maxDelayMs ?? ""}
                  onChange={(e) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      maxDelayMs: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder="1000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admission-jitter">
                  {t("providerAdvanced.admissionJitter", {
                    defaultValue: "随机抖动（毫秒）",
                  })}
                </Label>
                <Input
                  id="admission-jitter"
                  type="number"
                  min={0}
                  max={500}
                  value={admissionRetryConfig.jitterMs ?? ""}
                  onChange={(e) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      jitterMs: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder="100"
                />
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.admissionJitterHint", {
                    defaultValue:
                      "用于打散同一时刻的并发重试；设为 0 可获得更稳定的固定节奏。",
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showResponseReplay && (
        <div className="rounded-lg border border-border/50 bg-muted/20">
          <div
            role="button"
            tabIndex={0}
            className="flex w-full cursor-pointer items-center justify-between p-4 transition-colors hover:bg-muted/30"
            onClick={() => setIsResponseReplayOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setIsResponseReplayOpen((current) => !current);
              }
            }}
          >
            <div className="flex items-center gap-3">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">
                {t("providerAdvanced.responseReplayConfig", {
                  defaultValue: "错误响应重放",
                })}
              </span>
            </div>
            {isResponseReplayOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <div
            className={cn(
              "overflow-hidden transition-all duration-200",
              isResponseReplayOpen
                ? "max-h-[1600px] opacity-100"
                : "max-h-0 opacity-0",
            )}
          >
            <div className="space-y-4 border-t border-border/50 p-4">
              <p className="text-sm text-muted-foreground">
                {t("providerAdvanced.responseReplayConfigDesc", {
                  defaultValue:
                    "仅在上游已经返回选定的瞬时错误、且尚未向 Codex CLI 返回响应时，重放同一请求。正常成功请求不增加等待或响应体检查。",
                })}
              </p>

              <div className="flex items-center justify-between gap-4 rounded-md border border-border/50 bg-background/40 p-3">
                <div className="space-y-1">
                  <Label htmlFor="response-replay-enabled">
                    {t("providerAdvanced.responseReplayEnabled", {
                      defaultValue: "启用错误响应重放",
                    })}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("providerAdvanced.responseReplayEnabledHint", {
                      defaultValue:
                        "开关关闭时完全保持原有返回流程；开启后，重放耗尽才把最后错误交回故障转移或客户端。",
                    })}
                  </p>
                </div>
                <Switch
                  id="response-replay-enabled"
                  checked={responseReplayConfig.enabled === true}
                  onCheckedChange={(checked) =>
                    onResponseReplayConfigChange({
                      ...(checked
                        ? responseReplayEditorConfig(responseReplayConfig)
                        : responseReplayConfig),
                      enabled: checked,
                    })
                  }
                />
              </div>

              <div className="space-y-3 rounded-md border border-border/50 bg-background/40 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="response-replay-http-429">
                      {t("providerAdvanced.responseReplayHttp429", {
                        defaultValue: "重放 HTTP 429",
                      })}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("providerAdvanced.responseReplayHttp429Hint", {
                        defaultValue:
                          "Too Many Requests 会重放；明确的余额、永久配额或鉴权错误仍直接返回。",
                      })}
                    </p>
                  </div>
                  <Switch
                    id="response-replay-http-429"
                    checked={responseReplayConfig.retryHttp429 !== false}
                    onCheckedChange={(checked) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        retryHttp429: checked,
                      })
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-4 border-t border-border/40 pt-3">
                  <div className="space-y-1">
                    <Label htmlFor="response-replay-codex-matcher">
                      {t("providerAdvanced.responseReplayCodexMatcher", {
                        defaultValue: "启用自定义 Codex 错误匹配",
                      })}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("providerAdvanced.responseReplayCodexMatcherHint", {
                        defaultValue:
                          "状态码、端点和关键词组全部满足时才重放；每组关键词为 AND，多组之间为 OR。永久配额、鉴权和计费错误仍不会重放。",
                      })}
                    </p>
                  </div>
                  <Switch
                    id="response-replay-codex-matcher"
                    checked={
                      responseReplayConfig.retryCodexConfiguredErrors ??
                      responseReplayConfig.retryCodexBadResponse400 ??
                      true
                    }
                    onCheckedChange={(checked) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        retryCodexConfiguredErrors: checked,
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="response-replay-match-statuses">
                    {t("providerAdvanced.responseReplayMatchStatuses", {
                      defaultValue: "匹配状态码",
                    })}
                  </Label>
                  <Input
                    id="response-replay-match-statuses"
                    value={formatResponseReplayStatuses(
                      responseReplayConfig.codexMatchStatuses ??
                        DEFAULT_RESPONSE_REPLAY_MATCH_STATUSES,
                    )}
                    onChange={(event) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        codexMatchStatuses: parseResponseReplayStatuses(
                          event.target.value,
                        ),
                      })
                    }
                    placeholder="400, 409"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("providerAdvanced.responseReplayMatchStatusesHint", {
                      defaultValue:
                        "用逗号、空格或分号分隔，支持 400-599；清空后不匹配状态码。",
                    })}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="response-replay-match-endpoints">
                    {t("providerAdvanced.responseReplayMatchEndpoints", {
                      defaultValue: "匹配端点",
                    })}
                  </Label>
                  <Textarea
                    id="response-replay-match-endpoints"
                    rows={3}
                    value={formatResponseReplayEndpoints(
                      responseReplayConfig.codexMatchEndpoints ??
                        DEFAULT_RESPONSE_REPLAY_MATCH_ENDPOINTS,
                    )}
                    onChange={(event) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        codexMatchEndpoints: parseResponseReplayEndpoints(
                          event.target.value,
                        ),
                      })
                    }
                    placeholder="/responses"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("providerAdvanced.responseReplayMatchEndpointsHint", {
                      defaultValue:
                        "每行一个路径；会自动忽略查询串并兼容 /v1 前缀。填写 * 可匹配任意端点。",
                    })}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="response-replay-match-keywords">
                  {t("providerAdvanced.responseReplayMatchKeywords", {
                    defaultValue: "匹配关键词组",
                  })}
                </Label>
                <Textarea
                  id="response-replay-match-keywords"
                  rows={5}
                  value={formatResponseReplayKeywordGroups(
                    responseReplayConfig.codexMatchKeywordGroups ??
                      DEFAULT_RESPONSE_REPLAY_MATCH_KEYWORD_GROUPS,
                  )}
                  onChange={(event) =>
                    onResponseReplayConfigChange({
                      ...responseReplayConfig,
                      codexMatchKeywordGroups: parseResponseReplayKeywordGroups(
                        event.target.value,
                      ),
                    })
                  }
                  placeholder={
                    "bad_response_status_code\nnew_api_error && invalid character"
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.responseReplayMatchKeywordsHint", {
                    defaultValue:
                      "每行是一组 OR 条件，组内用 && 表示 AND；关键词不区分大小写，* 表示任意正文。清空可关闭这类匹配。",
                  })}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="response-replay-max-retries">
                    {t("providerAdvanced.responseReplayMaxRetries", {
                      defaultValue: "最大重放次数",
                    })}
                  </Label>
                  <Input
                    id="response-replay-max-retries"
                    type="number"
                    min={0}
                    max={10}
                    value={responseReplayConfig.maxRetries ?? ""}
                    onChange={(event) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        maxRetries: event.target.value
                          ? parseInt(event.target.value, 10)
                          : undefined,
                      })
                    }
                    placeholder="2"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("providerAdvanced.responseReplayMaxRetriesHint", {
                      defaultValue: "额外重发次数，范围 0-10；0 表示不重放。",
                    })}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="response-replay-initial-delay">
                    {t("providerAdvanced.responseReplayInitialDelay", {
                      defaultValue: "重放等待（毫秒）",
                    })}
                  </Label>
                  <Input
                    id="response-replay-initial-delay"
                    type="number"
                    min={0}
                    max={60000}
                    value={responseReplayConfig.initialDelayMs ?? ""}
                    onChange={(event) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        initialDelayMs: event.target.value
                          ? parseInt(event.target.value, 10)
                          : undefined,
                      })
                    }
                    placeholder="250"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="response-replay-max-delay">
                    {t("providerAdvanced.responseReplayMaxDelay", {
                      defaultValue: "最大等待（毫秒）",
                    })}
                  </Label>
                  <Input
                    id="response-replay-max-delay"
                    type="number"
                    min={0}
                    max={60000}
                    value={responseReplayConfig.maxDelayMs ?? ""}
                    onChange={(event) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        maxDelayMs: event.target.value
                          ? parseInt(event.target.value, 10)
                          : undefined,
                      })
                    }
                    placeholder="5000"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="response-replay-jitter">
                    {t("providerAdvanced.responseReplayJitter", {
                      defaultValue: "随机抖动（毫秒）",
                    })}
                  </Label>
                  <Input
                    id="response-replay-jitter"
                    type="number"
                    min={0}
                    max={500}
                    value={responseReplayConfig.jitterMs ?? ""}
                    onChange={(event) =>
                      onResponseReplayConfigChange({
                        ...responseReplayConfig,
                        jitterMs: event.target.value
                          ? parseInt(event.target.value, 10)
                          : undefined,
                      })
                    }
                    placeholder="100"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-md border border-border/50 bg-background/40 p-3">
                <div className="space-y-1">
                  <Label htmlFor="response-replay-retry-after">
                    {t("providerAdvanced.responseReplayHonorRetryAfter", {
                      defaultValue: "遵循 Retry-After",
                    })}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("providerAdvanced.responseReplayHonorRetryAfterHint", {
                      defaultValue:
                        "上游提供 Retry-After 时优先使用，但不会超过最大等待。",
                    })}
                  </p>
                </div>
                <Switch
                  id="response-replay-retry-after"
                  checked={responseReplayConfig.honorRetryAfter !== false}
                  onCheckedChange={(checked) =>
                    onResponseReplayConfigChange({
                      ...responseReplayConfig,
                      honorRetryAfter: checked,
                    })
                  }
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProviderAdvancedConfig({
  pricingConfig,
  onPricingConfigChange,
}: ProviderAdvancedConfigProps) {
  const { t } = useTranslation();
  const [isPricingConfigOpen, setIsPricingConfigOpen] = useState(
    pricingConfig.enabled,
  );

  useEffect(() => {
    setIsPricingConfigOpen(pricingConfig.enabled);
  }, [pricingConfig.enabled]);

  return (
    <div className="space-y-4">
      {/* 计费配置 */}
      <div className="rounded-lg border border-border/50 bg-muted/20">
        <div
          role="button"
          tabIndex={0}
          className="flex w-full cursor-pointer items-center justify-between p-4 transition-colors hover:bg-muted/30"
          onClick={() => setIsPricingConfigOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setIsPricingConfigOpen((current) => !current);
            }
          }}
        >
          <div className="flex items-center gap-3">
            <Coins className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">
              {t("providerAdvanced.pricingConfig", {
                defaultValue: "计费配置",
              })}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <Label
                htmlFor="pricing-config-enabled"
                className="text-sm text-muted-foreground"
              >
                {t("providerAdvanced.useCustomPricing", {
                  defaultValue: "使用单独配置",
                })}
              </Label>
              <Switch
                id="pricing-config-enabled"
                checked={pricingConfig.enabled}
                onCheckedChange={(checked) => {
                  onPricingConfigChange({ ...pricingConfig, enabled: checked });
                  if (checked) setIsPricingConfigOpen(true);
                }}
              />
            </div>
            {isPricingConfigOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>
        <div
          className={cn(
            "overflow-hidden transition-all duration-200",
            isPricingConfigOpen
              ? "max-h-[500px] opacity-100"
              : "max-h-0 opacity-0",
          )}
        >
          <div className="border-t border-border/50 p-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("providerAdvanced.pricingConfigDesc", {
                defaultValue:
                  "为此供应商配置单独的计费参数，不启用时使用全局默认配置。",
              })}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="cost-multiplier">
                  {t("providerAdvanced.costMultiplier", {
                    defaultValue: "成本倍率",
                  })}
                </Label>
                <Input
                  id="cost-multiplier"
                  type="number"
                  min={0}
                  step={0.01}
                  value={pricingConfig.costMultiplier || ""}
                  onChange={(e) =>
                    onPricingConfigChange({
                      ...pricingConfig,
                      costMultiplier: e.target.value || undefined,
                    })
                  }
                  placeholder={t("providerAdvanced.costMultiplierPlaceholder", {
                    defaultValue: "留空使用全局默认（1）",
                  })}
                  disabled={!pricingConfig.enabled}
                />
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.costMultiplierHint", {
                    defaultValue: "实际成本 = 基础成本 x 倍率，支持小数如 1.5",
                  })}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pricing-model-source">
                  {t("providerAdvanced.pricingModelSourceLabel", {
                    defaultValue: "计费模式",
                  })}
                </Label>
                <Select
                  value={pricingConfig.pricingModelSource}
                  onValueChange={(value) =>
                    onPricingConfigChange({
                      ...pricingConfig,
                      pricingModelSource: value as PricingModelSourceOption,
                    })
                  }
                  disabled={!pricingConfig.enabled}
                >
                  <SelectTrigger id="pricing-model-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">
                      {t("providerAdvanced.pricingModelSourceInherit", {
                        defaultValue: "继承全局默认",
                      })}
                    </SelectItem>
                    <SelectItem value="request">
                      {t("providerAdvanced.pricingModelSourceRequest", {
                        defaultValue: "请求模型",
                      })}
                    </SelectItem>
                    <SelectItem value="response">
                      {t("providerAdvanced.pricingModelSourceResponse", {
                        defaultValue: "返回模型",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("providerAdvanced.pricingModelSourceHint", {
                    defaultValue: "选择按请求模型还是返回模型进行定价匹配。",
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
