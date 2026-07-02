import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  DoorOpen,
  FlaskConical,
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
import type {
  ProviderTestConfig,
  ProviderUpstreamAdmissionRetry,
} from "@/types";

export type PricingModelSourceOption = "inherit" | "request" | "response";

interface ProviderPricingConfig {
  enabled: boolean;
  costMultiplier?: string;
  pricingModelSource: PricingModelSourceOption;
}

interface ProviderRoutingRetryConfigProps {
  admissionRetryConfig: ProviderUpstreamAdmissionRetry;
  maxConcurrentRequests?: number;
  onAdmissionRetryConfigChange: (
    config: ProviderUpstreamAdmissionRetry,
  ) => void;
  onMaxConcurrentRequestsChange: (value?: number) => void;
}

interface ProviderAdvancedConfigProps {
  testConfig: ProviderTestConfig;
  pricingConfig: ProviderPricingConfig;
  onTestConfigChange: (config: ProviderTestConfig) => void;
  onPricingConfigChange: (config: ProviderPricingConfig) => void;
}

export function ProviderRoutingRetryConfig({
  admissionRetryConfig,
  maxConcurrentRequests,
  onAdmissionRetryConfigChange,
  onMaxConcurrentRequestsChange,
}: ProviderRoutingRetryConfigProps) {
  const { t } = useTranslation();
  const hasAdmissionRetryTiming =
    admissionRetryConfig.maxRetries !== undefined ||
    admissionRetryConfig.initialDelayMs !== undefined ||
    admissionRetryConfig.maxDelayMs !== undefined ||
    admissionRetryConfig.jitterMs !== undefined;
  const autoKeywordsText = (admissionRetryConfig.autoKeywords ?? []).join("\n");
  const hasAdmissionRetryAuto =
    admissionRetryConfig.autoEnabled === true || autoKeywordsText.trim() !== "";
  const [isAdmissionRetryOpen, setIsAdmissionRetryOpen] = useState(
    admissionRetryConfig.enabled === true ||
      hasAdmissionRetryTiming ||
      hasAdmissionRetryAuto,
  );
  const [isSessionRoutingConfigOpen, setIsSessionRoutingConfigOpen] = useState(
    maxConcurrentRequests !== undefined,
  );

  useEffect(() => {
    setIsAdmissionRetryOpen(
      admissionRetryConfig.enabled === true ||
        hasAdmissionRetryTiming ||
        hasAdmissionRetryAuto,
    );
  }, [
    admissionRetryConfig.enabled,
    hasAdmissionRetryTiming,
    hasAdmissionRetryAuto,
  ]);

  useEffect(() => {
    if (maxConcurrentRequests !== undefined) {
      setIsSessionRoutingConfigOpen(true);
    }
  }, [maxConcurrentRequests]);

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
                  "留空或填 0 表示无限并发；这是单个供应商可承载的会话路由占用上限。",
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
              ? "max-h-[900px] opacity-100"
              : "max-h-0 opacity-0",
          )}
        >
          <div className="border-t border-border/50 p-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("providerAdvanced.admissionRetryConfigDesc", {
                defaultValue:
                  "当上游返回 overloaded、capacity、rate limit 等拥挤错误时，持续重试同一供应商；启用/关闭请在供应商列表快速切换。不会重试认证、模型不存在、上下文超限等请求错误。",
              })}
            </p>
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                    defaultValue: "初始等待（毫秒）",
                  })}
                </Label>
                <Input
                  id="admission-initial-delay"
                  type="number"
                  min={0}
                  max={2000}
                  value={admissionRetryConfig.initialDelayMs ?? ""}
                  onChange={(e) =>
                    onAdmissionRetryConfigChange({
                      ...admissionRetryConfig,
                      initialDelayMs: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder="300"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admission-max-delay">
                  {t("providerAdvanced.admissionMaxDelay", {
                    defaultValue: "最大等待（毫秒）",
                  })}
                </Label>
                <Input
                  id="admission-max-delay"
                  type="number"
                  min={0}
                  max={3000}
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
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProviderAdvancedConfig({
  testConfig,
  pricingConfig,
  onTestConfigChange,
  onPricingConfigChange,
}: ProviderAdvancedConfigProps) {
  const { t } = useTranslation();
  const [isTestConfigOpen, setIsTestConfigOpen] = useState(testConfig.enabled);
  const [isPricingConfigOpen, setIsPricingConfigOpen] = useState(
    pricingConfig.enabled,
  );

  useEffect(() => {
    setIsTestConfigOpen(testConfig.enabled);
  }, [testConfig.enabled]);

  useEffect(() => {
    setIsPricingConfigOpen(pricingConfig.enabled);
  }, [pricingConfig.enabled]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/50 bg-muted/20">
        <div
          role="button"
          tabIndex={0}
          className="flex w-full cursor-pointer items-center justify-between p-4 transition-colors hover:bg-muted/30"
          onClick={() => setIsTestConfigOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setIsTestConfigOpen((current) => !current);
            }
          }}
        >
          <div className="flex items-center gap-3">
            <FlaskConical className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">
              {t("providerAdvanced.testConfig", {
                defaultValue: "连通检测配置",
              })}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <Label
                htmlFor="test-config-enabled"
                className="text-sm text-muted-foreground"
              >
                {t("providerAdvanced.useCustomConfig", {
                  defaultValue: "使用单独配置",
                })}
              </Label>
              <Switch
                id="test-config-enabled"
                checked={testConfig.enabled}
                onCheckedChange={(checked) => {
                  onTestConfigChange({ ...testConfig, enabled: checked });
                  if (checked) setIsTestConfigOpen(true);
                }}
              />
            </div>
            {isTestConfigOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>
        <div
          className={cn(
            "overflow-hidden transition-all duration-200",
            isTestConfigOpen
              ? "max-h-[500px] opacity-100"
              : "max-h-0 opacity-0",
          )}
        >
          <div className="border-t border-border/50 p-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("providerAdvanced.testConfigDesc", {
                defaultValue:
                  "为此供应商配置单独的连通检测参数（超时/阈值/重试），不启用时使用全局配置。",
              })}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="test-timeout">
                  {t("providerAdvanced.timeoutSecs", {
                    defaultValue: "超时时间（秒）",
                  })}
                </Label>
                <Input
                  id="test-timeout"
                  type="number"
                  min={1}
                  max={60}
                  value={testConfig.timeoutSecs || ""}
                  onChange={(e) =>
                    onTestConfigChange({
                      ...testConfig,
                      timeoutSecs: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder="8"
                  disabled={!testConfig.enabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="degraded-threshold">
                  {t("providerAdvanced.degradedThreshold", {
                    defaultValue: "降级阈值（毫秒）",
                  })}
                </Label>
                <Input
                  id="degraded-threshold"
                  type="number"
                  min={100}
                  max={60000}
                  value={testConfig.degradedThresholdMs || ""}
                  onChange={(e) =>
                    onTestConfigChange({
                      ...testConfig,
                      degradedThresholdMs: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder="6000"
                  disabled={!testConfig.enabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="max-retries">
                  {t("providerAdvanced.maxRetries", {
                    defaultValue: "最大重试次数",
                  })}
                </Label>
                <Input
                  id="max-retries"
                  type="number"
                  min={0}
                  max={5}
                  value={testConfig.maxRetries ?? ""}
                  onChange={(e) =>
                    onTestConfigChange({
                      ...testConfig,
                      maxRetries: e.target.value
                        ? parseInt(e.target.value, 10)
                        : undefined,
                    })
                  }
                  placeholder="1"
                  disabled={!testConfig.enabled}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

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
