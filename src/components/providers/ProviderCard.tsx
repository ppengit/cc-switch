import { useMemo, useState, useEffect, useRef } from "react";
import { GripVertical, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import type { Provider, TerminalTargetMode } from "@/types";
import type { AppId } from "@/lib/api";
import { cn } from "@/lib/utils";
import { extractCodexModelName } from "@/utils/providerConfigUtils";
import { ProviderActions } from "@/components/providers/ProviderActions";
import { ProviderIcon } from "@/components/ProviderIcon";
import UsageFooter from "@/components/UsageFooter";
import SubscriptionQuotaFooter from "@/components/SubscriptionQuotaFooter";
import CopilotQuotaFooter from "@/components/CopilotQuotaFooter";
import CodexOauthQuotaFooter from "@/components/CodexOauthQuotaFooter";
import { ProviderHealthBadge } from "@/components/providers/ProviderHealthBadge";
import { FailoverPriorityBadge } from "@/components/providers/FailoverPriorityBadge";
import { useProviderHealth } from "@/lib/query/failover";
import { useUsageQuery } from "@/lib/query/queries";
import { PROVIDER_TYPES } from "@/config/constants";

interface DragHandleProps {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

interface ProviderCardProps {
  provider: Provider;
  isCurrent: boolean;
  appId: AppId;
  isInConfig?: boolean; // OpenCode: 是否已添加到 opencode.json
  isOmo?: boolean;
  isOmoSlim?: boolean;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onConfigureUsage: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onDuplicate: (provider: Provider) => void;
  onTest?: (provider: Provider) => void;
  onOpenTerminalWithMode?: (
    provider: Provider,
    mode: TerminalTargetMode,
    path?: string,
  ) => void;
  recentTerminalTargets?: string[];
  onClearRecentTerminals?: () => void;
  isTesting?: boolean;
  isProxyRunning: boolean;
  isProxyTakeover?: boolean; // 代理接管模式（Live配置已被接管，切换为热切换）
  density?: "compact" | "comfortable";
  viewMode?: "list" | "card";
  dragHandleProps?: DragHandleProps;
  isAutoFailoverEnabled?: boolean; // 是否开启自动故障转移
  failoverPriority?: number; // 故障转移优先级（1 = P1, 2 = P2, ...）
  isInFailoverQueue?: boolean; // 是否在故障转移队列中
  onToggleFailover?: (enabled: boolean) => void; // 切换故障转移队列
  activeProviderId?: string; // 代理当前实际使用的供应商 ID（用于故障转移模式下标注绿色边框）
  sessionOccupancyCount?: number;
  onReleaseSessionOccupancy?: () => void;
  isReleasingSessionOccupancy?: boolean;
  // OpenClaw: default model
  isDefaultModel?: boolean;
  onSetAsDefault?: () => void;
}

const extractApiUrl = (provider: Provider, fallbackText: string) => {
  if (provider.notes?.trim()) {
    return provider.notes.trim();
  }

  if (provider.websiteUrl) {
    return provider.websiteUrl;
  }

  const config = provider.settingsConfig;

  if (config && typeof config === "object") {
    const envBase =
      (config as Record<string, any>)?.env?.ANTHROPIC_BASE_URL ||
      (config as Record<string, any>)?.env?.GOOGLE_GEMINI_BASE_URL;
    if (typeof envBase === "string" && envBase.trim()) {
      return envBase;
    }

    const baseUrl = (config as Record<string, any>)?.config;

    if (typeof baseUrl === "string" && baseUrl.includes("base_url")) {
      const match = baseUrl.match(/base_url\s*=\s*['"]([^'"]+)['"]/);
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return fallbackText;
};

export function ProviderCard({
  provider,
  isCurrent,
  appId,
  isInConfig = true,
  isOmo = false,
  isOmoSlim = false,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onConfigureUsage,
  onOpenWebsite,
  onDuplicate,
  onTest,
  onOpenTerminalWithMode,
  recentTerminalTargets,
  onClearRecentTerminals,
  isTesting,
  isProxyRunning,
  isProxyTakeover = false,
  density = "comfortable",
  viewMode = "list",
  dragHandleProps,
  isAutoFailoverEnabled = false,
  failoverPriority,
  isInFailoverQueue = false,
  onToggleFailover,
  activeProviderId,
  sessionOccupancyCount = 0,
  onReleaseSessionOccupancy,
  isReleasingSessionOccupancy = false,
  // OpenClaw: default model
  isDefaultModel,
  onSetAsDefault,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const isCompact = density === "compact";
  const containerPadding = isCompact ? "p-3" : "p-4";
  const containerGap = isCompact ? "gap-3" : "gap-4";
  const iconBoxSize = isCompact ? "h-7 w-7" : "h-8 w-8";
  const iconSize = isCompact ? 18 : 20;
  const titleSize = isCompact ? "text-sm" : "text-base";
  const urlSize = isCompact ? "text-xs" : "text-sm";
  const headerMinHeight = isCompact ? "min-h-6" : "min-h-7";
  const actionGap = isCompact ? "gap-1" : "gap-1.5";
  const actionPadding = isCompact ? "pl-2" : "pl-3";
  const isCardView = viewMode === "card";
  const actionOverlayPadding = isCardView ? "px-2 py-1" : actionPadding;
  const actionOverlayBackground = isCardView
    ? "rounded-lg border border-border/60 bg-slate-50/95 shadow-sm backdrop-blur dark:bg-slate-900/70"
    : "";
  const actionOverlayPosition = isCardView
    ? "left-1/2 -translate-x-1/2"
    : "right-0";
  const actionOverlayMotion = isCardView
    ? "scale-95 group-hover:scale-100 group-focus-within:scale-100"
    : "translate-x-2 group-hover:translate-x-0 group-focus-within:translate-x-0";
  const dragIconSize = isCompact ? "h-3.5 w-3.5" : "h-4 w-4";
  const dragPadding = isCompact ? "p-1" : "p-1.5";

  // OMO and OMO Slim share the same card behavior
  const isAnyOmo = isOmo || isOmoSlim;
  const handleDisableAnyOmo = isOmoSlim ? onDisableOmoSlim : onDisableOmo;

  const { data: health } = useProviderHealth(provider.id, appId);

  const fallbackUrlText = t("provider.notConfigured", {
    defaultValue: "未配置接口地址",
  });

  const displayUrl = useMemo(() => {
    return extractApiUrl(provider, fallbackUrlText);
  }, [provider, fallbackUrlText]);

  const modelSummary = useMemo(() => {
    const config = provider.settingsConfig ?? {};
    if (appId === "claude") {
      const env = (config as Record<string, any>).env || {};
      const items: Array<{ label: string; value: string }> = [];
      const mainModel =
        typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL : "";
      const reasoningModel =
        typeof env.ANTHROPIC_REASONING_MODEL === "string"
          ? env.ANTHROPIC_REASONING_MODEL
          : "";
      const haikuModel =
        typeof env.ANTHROPIC_DEFAULT_HAIKU_MODEL === "string"
          ? env.ANTHROPIC_DEFAULT_HAIKU_MODEL
          : "";
      const sonnetModel =
        typeof env.ANTHROPIC_DEFAULT_SONNET_MODEL === "string"
          ? env.ANTHROPIC_DEFAULT_SONNET_MODEL
          : "";
      const opusModel =
        typeof env.ANTHROPIC_DEFAULT_OPUS_MODEL === "string"
          ? env.ANTHROPIC_DEFAULT_OPUS_MODEL
          : "";

      if (mainModel.trim()) items.push({ label: "主模型", value: mainModel });
      if (reasoningModel.trim())
        items.push({ label: "推理模型", value: reasoningModel });
      if (haikuModel.trim()) items.push({ label: "Haiku", value: haikuModel });
      if (sonnetModel.trim())
        items.push({ label: "Sonnet", value: sonnetModel });
      if (opusModel.trim()) items.push({ label: "Opus", value: opusModel });

      if (items.length === 0) return "";
      return items.map((item) => `${item.label}: ${item.value}`).join(" | ");
    }

    if (appId === "codex") {
      const configText =
        typeof (config as Record<string, any>).config === "string"
          ? ((config as Record<string, any>).config as string)
          : "";
      const modelName = extractCodexModelName(configText) || "";
      return modelName.trim() ? `模型: ${modelName}` : "";
    }

    if (appId === "gemini") {
      const env = (config as Record<string, any>).env || {};
      const model =
        typeof env.GEMINI_MODEL === "string" ? env.GEMINI_MODEL : "";
      return model.trim() ? `模型: ${model}` : "";
    }

    if (appId === "opencode") {
      const models = (config as Record<string, any>).models;
      if (models && typeof models === "object") {
        const count = Object.keys(models).length;
        if (count > 0) return `模型: ${count} 个`;
      }
      return "";
    }

    if (appId === "openclaw") {
      const models = (config as Record<string, any>).models;
      if (Array.isArray(models)) {
        const count = models.length;
        if (count > 0) return `模型: ${count} 个`;
      }
      return "";
    }

    return "";
  }, [appId, provider.settingsConfig]);

  const isClickableUrl = useMemo(() => {
    if (provider.notes?.trim()) {
      return false;
    }
    if (displayUrl === fallbackUrlText) {
      return false;
    }
    return true;
  }, [provider.notes, displayUrl, fallbackUrlText]);

  const usageEnabled = provider.meta?.usage_script?.enabled ?? false;
  const providerType = provider.meta?.providerType;
  const showOfficialQuotaFooter =
    provider.category === "official" &&
    (appId === "claude" || appId === "codex" || appId === "gemini");
  const showCopilotQuotaFooter = providerType === PROVIDER_TYPES.GITHUB_COPILOT;
  const showCodexOauthQuotaFooter = providerType === PROVIDER_TYPES.CODEX_OAUTH;
  const useSubscriptionFooter =
    showOfficialQuotaFooter ||
    showCopilotQuotaFooter ||
    showCodexOauthQuotaFooter;

  // 获取用量数据以判断是否有多套餐
  // 累加模式应用（OpenCode/OpenClaw）：使用 isInConfig 代替 isCurrent
  const shouldAutoQuery =
    appId === "opencode" || appId === "openclaw" ? isInConfig : isCurrent;
  const autoQueryInterval = shouldAutoQuery
    ? provider.meta?.usage_script?.autoQueryInterval || 0
    : 0;

  const { data: usage } = useUsageQuery(provider.id, appId, {
    enabled: usageEnabled,
    autoQueryInterval,
  });

  const hasMultiplePlans =
    !useSubscriptionFooter &&
    usage?.success &&
    usage.data &&
    usage.data.length > 1;

  const [isExpanded, setIsExpanded] = useState(false);

  const actionsRef = useRef<HTMLDivElement>(null);
  const [actionsWidth, setActionsWidth] = useState(0);

  useEffect(() => {
    if (hasMultiplePlans) {
      setIsExpanded(true);
    }
  }, [hasMultiplePlans]);

  useEffect(() => {
    if (actionsRef.current) {
      const updateWidth = () => {
        const width = actionsRef.current?.offsetWidth || 0;
        setActionsWidth(width);
      };
      updateWidth();
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
  }, [onTest, onOpenTerminalWithMode, recentTerminalTargets]);

  const handleOpenWebsite = () => {
    if (!isClickableUrl) {
      return;
    }
    onOpenWebsite(displayUrl);
  };

  // 判断是否是"当前使用中"的供应商
  // - OMO/OMO Slim 供应商：使用 isCurrent
  // - 累加模式应用（OpenCode 非 OMO / OpenClaw）：不存在"当前"概念，始终返回 false
  // - 故障转移模式：代理实际使用的供应商（activeProviderId）
  // - 普通模式：isCurrent
  const isFailoverRoutingMode = isAutoFailoverEnabled && isProxyTakeover;

  const isActiveProvider = isAnyOmo
    ? isCurrent
    : appId === "opencode" || appId === "openclaw"
      ? false
      : isFailoverRoutingMode
        ? activeProviderId === provider.id
        : isCurrent;

  const shouldUseGreen = !isAnyOmo && isProxyTakeover && isActiveProvider;
  const shouldUseBlue =
    (isAnyOmo && isActiveProvider) ||
    (!isAnyOmo && !isProxyTakeover && isActiveProvider);

  const renderFooter = (inline: boolean) => {
    if (showCopilotQuotaFooter) {
      return (
        <CopilotQuotaFooter
          meta={provider.meta}
          inline={inline}
          isCurrent={isCurrent}
        />
      );
    }

    if (showCodexOauthQuotaFooter) {
      return (
        <CodexOauthQuotaFooter
          meta={provider.meta}
          inline={inline}
          isCurrent={isCurrent}
        />
      );
    }

    if (showOfficialQuotaFooter) {
      return (
        <SubscriptionQuotaFooter
          appId={appId}
          inline={inline}
          isCurrent={isCurrent}
        />
      );
    }

    return (
      <UsageFooter
        provider={provider}
        providerId={provider.id}
        appId={appId}
        usageEnabled={usageEnabled}
        isCurrent={isCurrent}
        isInConfig={isInConfig}
        inline={inline}
      />
    );
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border transition-all duration-300",
        "bg-card text-card-foreground group",
        containerPadding,
        isAutoFailoverEnabled || isProxyTakeover
          ? "hover:border-emerald-500/50"
          : "hover:border-border-active",
        shouldUseGreen &&
          "border-emerald-500/60 shadow-sm shadow-emerald-500/10",
        shouldUseBlue && "border-blue-500/60 shadow-sm shadow-blue-500/10",
        !isActiveProvider && "hover:shadow-sm",
        dragHandleProps?.isDragging &&
          "cursor-grabbing border-primary shadow-lg scale-105 z-10",
      )}
    >
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-r to-transparent transition-opacity duration-500 pointer-events-none",
          shouldUseGreen && "from-emerald-500/10",
          shouldUseBlue && "from-blue-500/10",
          !isActiveProvider && "from-primary/10",
          isActiveProvider ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        className={cn(
          "relative flex flex-col sm:flex-row sm:items-center sm:justify-between",
          containerGap,
        )}
      >
        <div className="flex flex-1 items-center gap-2">
          {dragHandleProps && (
            <button
              type="button"
              className={cn(
                "-ml-1.5 flex-shrink-0 cursor-grab active:cursor-grabbing",
                dragPadding,
                "text-muted-foreground/50 hover:text-muted-foreground transition-colors",
                dragHandleProps.isDragging && "cursor-grabbing",
              )}
              aria-label={t("provider.dragHandle")}
              {...(dragHandleProps.attributes ?? {})}
              {...(dragHandleProps.listeners ?? {})}
            >
              <GripVertical className={dragIconSize} />
            </button>
          )}

          <div
            className={cn(
              "rounded-lg bg-muted flex items-center justify-center border border-border group-hover:scale-105 transition-transform duration-300",
              iconBoxSize,
            )}
          >
            <ProviderIcon
              icon={provider.icon}
              name={provider.name}
              color={provider.iconColor}
              size={iconSize}
            />
          </div>

          <div className="space-y-1">
            <div
              className={cn(
                "flex flex-wrap items-center gap-2",
                headerMinHeight,
              )}
            >
              <h3 className={cn("font-semibold leading-none", titleSize)}>
                {provider.name}
              </h3>

              {isOmo && (
                <span className="inline-flex items-center rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                  OMO
                </span>
              )}

              {isOmoSlim && (
                <span className="inline-flex items-center rounded-md bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                  Slim
                </span>
              )}

              {isProxyRunning && isInFailoverQueue && health && (
                <ProviderHealthBadge
                  consecutiveFailures={health.consecutive_failures}
                  lastError={health.last_error}
                />
              )}

              {isAutoFailoverEnabled &&
                isInFailoverQueue &&
                failoverPriority && (
                  <FailoverPriorityBadge priority={failoverPriority} />
                )}

              {provider.isPublic && (
                <span className="inline-flex items-center rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {t("provider.publicTag", { defaultValue: "public" })}
                </span>
              )}

              {sessionOccupancyCount > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                  title={t("proxy.sessionRouting.occupiedSessions", {
                    defaultValue: "当前会话占用: {{count}}",
                    count: sessionOccupancyCount,
                  })}
                >
                  S:{sessionOccupancyCount}
                  {onReleaseSessionOccupancy && (
                    <button
                      type="button"
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-emerald-700/80 transition-colors hover:bg-emerald-200 hover:text-emerald-900 dark:text-emerald-200/80 dark:hover:bg-emerald-800/60 dark:hover:text-emerald-50"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onReleaseSessionOccupancy();
                      }}
                      disabled={isReleasingSessionOccupancy}
                      aria-label={t("provider.releaseOccupancy", {
                        defaultValue: "释放占用",
                      })}
                      title={t("provider.releaseOccupancy", {
                        defaultValue: "释放占用",
                      })}
                    >
                      {isReleasingSessionOccupancy ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        <X className="h-2.5 w-2.5" />
                      )}
                    </button>
                  )}
                </span>
              )}

              {provider.category === "third_party" &&
                provider.meta?.isPartner && (
                  <span
                    className="text-yellow-500 dark:text-yellow-400"
                    title={t("provider.officialPartner", {
                      defaultValue: "官方合作伙伴",
                    })}
                  >
                    ⭐
                  </span>
                )}
            </div>

            {modelSummary && (
              <div
                className={cn(
                  "text-xs text-muted-foreground max-w-[360px] truncate",
                  isCompact ? "max-w-[260px]" : "max-w-[360px]",
                )}
                title={modelSummary}
              >
                {modelSummary}
              </div>
            )}

            {displayUrl && (
              <button
                type="button"
                onClick={handleOpenWebsite}
                className={cn(
                  "inline-flex items-center max-w-[280px]",
                  urlSize,
                  isClickableUrl
                    ? "text-blue-500 transition-colors hover:underline dark:text-blue-400 cursor-pointer"
                    : "text-muted-foreground cursor-default",
                )}
                title={displayUrl}
                disabled={!isClickableUrl}
              >
                <span className="truncate">{displayUrl}</span>
              </button>
            )}
          </div>
        </div>

        <div
          className={cn(
            "flex items-center ml-auto min-w-0 gap-3",
            !isCardView && "relative",
          )}
          style={
            {
              "--actions-width": `${actionsWidth || 320}px`,
            } as React.CSSProperties
          }
        >
          <div className="ml-auto">
            <div
              className={cn(
                "flex items-center gap-1 transition-transform duration-200",
                !isCardView &&
                  "group-hover:-translate-x-[var(--actions-width)] group-focus-within:-translate-x-[var(--actions-width)]",
              )}
            >
              {hasMultiplePlans ? (
                <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-medium">
                    {t("usage.multiplePlans", {
                      count: usage?.data?.length || 0,
                      defaultValue: `${usage?.data?.length || 0} 个套餐`,
                    })}
                  </span>
                </div>
              ) : (
                renderFooter(true)
              )}
              {hasMultiplePlans && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsExpanded(!isExpanded);
                  }}
                  className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-500 dark:text-gray-400 flex-shrink-0"
                  title={
                    isExpanded
                      ? t("usage.collapse", { defaultValue: "收起" })
                      : t("usage.expand", { defaultValue: "展开" })
                  }
                >
                  {isExpanded ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                </button>
              )}
            </div>
          </div>

          <div
            ref={actionsRef}
            className={cn(
              "absolute top-1/2 z-20 -translate-y-1/2 flex items-center opacity-0 pointer-events-none group-hover:opacity-100 group-focus-within:opacity-100 group-hover:pointer-events-auto group-focus-within:pointer-events-auto transition-all duration-200",
              actionOverlayPosition,
              actionOverlayMotion,
              actionGap,
              actionOverlayPadding,
              actionOverlayBackground,
            )}
          >
            <ProviderActions
              appId={appId}
              isCurrent={isCurrent}
              isInConfig={isInConfig}
              isTesting={isTesting}
              isProxyTakeover={isProxyTakeover}
              isOmo={isAnyOmo}
              onSwitch={() => onSwitch(provider)}
              onEdit={() => onEdit(provider)}
              onDuplicate={() => onDuplicate(provider)}
              onTest={onTest ? () => onTest(provider) : undefined}
              onConfigureUsage={() => onConfigureUsage(provider)}
              onDelete={() => onDelete(provider)}
              onRemoveFromConfig={
                onRemoveFromConfig
                  ? () => onRemoveFromConfig(provider)
                  : undefined
              }
              onDisableOmo={handleDisableAnyOmo}
              onOpenTerminalWithMode={
                onOpenTerminalWithMode
                  ? (mode, path) => onOpenTerminalWithMode(provider, mode, path)
                  : undefined
              }
              recentTerminalTargets={recentTerminalTargets}
              onClearRecentTerminals={onClearRecentTerminals}
              isAutoFailoverEnabled={isAutoFailoverEnabled}
              isInFailoverQueue={isInFailoverQueue}
              onToggleFailover={onToggleFailover}
              // OpenClaw: default model
              isDefaultModel={isDefaultModel}
              onSetAsDefault={onSetAsDefault}
            />
          </div>
        </div>
      </div>

      {isExpanded && hasMultiplePlans && (
        <div className="mt-4 pt-4 border-t border-border-default">
          {renderFooter(false)}
        </div>
      )}
    </div>
  );
}
