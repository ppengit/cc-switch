import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  ArrowUpDown,
  FlaskConical,
  LayoutGrid,
  List,
  Loader2,
  Save,
  Search,
  SlidersHorizontal,
  Terminal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  Provider,
  ProviderSortBy,
  ProviderSortPreference,
  SortOrder,
  TerminalTargetMode,
  TerminalTargetPreference,
} from "@/types";
import type { AppId } from "@/lib/api";
import { configApi, settingsApi } from "@/lib/api";
import { providersApi } from "@/lib/api/providers";
import { useDragSort } from "@/hooks/useDragSort";
import { useSettingsQuery } from "@/lib/query";
import {
  useOpenClawLiveProviderIds,
  useOpenClawDefaultModel,
} from "@/hooks/useOpenClaw";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isWindows } from "@/lib/platform";
import { useStreamCheck } from "@/hooks/useStreamCheck";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";
import {
  useAutoFailoverEnabled,
  useFailoverQueue,
  useAddToFailoverQueue,
  useRemoveFromFailoverQueue,
} from "@/lib/query/failover";
import {
  useAppProxyConfig,
  useProviderSessionOccupancy,
  useUpdateAppProxyConfig,
} from "@/lib/query/proxy";
import {
  useCurrentOmoProviderId,
  useCurrentOmoSlimProviderId,
} from "@/lib/query/omo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import JsonEditor from "@/components/JsonEditor";
import { cn } from "@/lib/utils";
import {
  getStreamCheckConfig,
  saveStreamCheckConfig,
  type StreamCheckConfig,
  type StreamCheckResult,
} from "@/lib/api/model-test";
import {
  hasCommonConfigSnippet,
  hasTomlCommonConfigSnippet,
  updateCommonConfigSnippet,
  updateTomlCommonConfigSnippet,
  validateJsonConfig,
} from "@/utils/providerConfigUtils";
import {
  getTomlStringValue,
  removeTomlKeyIfMatch,
  upsertTomlStringValue,
} from "@/utils/tomlKeyUtils";
import type { SessionRoutingStrategy } from "@/types/proxy";

interface ProviderListProps {
  providers: Record<string, Provider>;
  currentProviderId: string;
  appId: AppId;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider, options?: { cwd?: string }) => void;
  onOpenAppTerminal?: (options?: { cwd?: string }) => void;
  onCreate?: () => void;
  isLoading?: boolean;
  isProxyRunning?: boolean;
  isProxyTakeover?: boolean;
  activeProviderId?: string;
  onSetAsDefault?: (provider: Provider) => void; // OpenClaw: set as default model
}

type ProviderViewMode = "list" | "card";
type ProviderDensity = "compact" | "comfortable";
type TestModelKey = "claudeModel" | "codexModel" | "geminiModel";

const VIEW_MODE_STORAGE_KEY = "cc-switch:provider-view-mode-v2";
const DENSITY_STORAGE_KEY = "cc-switch:provider-density-v2";
const SESSION_ROUTING_STRATEGY_OPTIONS: Array<{
  value: SessionRoutingStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "priority",
    label: "故障转移优先级",
    description: "按照故障转移队列优先级（P1→P2→...）进行分配。",
  },
  {
    value: "least_active",
    label: "最少占用优先",
    description: "优先选择当前绑定会话最少的提供商，适合均衡分配。",
  },
  {
    value: "round_robin",
    label: "轮询分配",
    description: "按顺序轮流分配提供商，分布更均匀。",
  },
  {
    value: "fixed",
    label: "固定首选",
    description: "优先使用首选提供商，只有不可用时才切换到其他提供商。",
  },
];

const GEMINI_COMMON_ENV_FORBIDDEN_KEYS = [
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_API_KEY",
] as const;
type GeminiForbiddenEnvKey = (typeof GEMINI_COMMON_ENV_FORBIDDEN_KEYS)[number];

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
};

export function ProviderList({
  providers,
  currentProviderId,
  appId,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onOpenAppTerminal,
  onCreate,
  isLoading = false,
  isProxyRunning = false,
  isProxyTakeover = false,
  activeProviderId,
  onSetAsDefault,
}: ProviderListProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settingsData } = useSettingsQuery();
  const {
    sortedProviders: manualSortedProviders,
    sensors,
    handleDragEnd,
  } = useDragSort(providers, appId);
  const locale = i18n.language === "zh" ? "zh-CN" : "en-US";
  const providerSortPreference = useMemo(() => {
    const stored = settingsData?.providerSort?.[appId];
    return {
      by: stored?.by ?? "manual",
      order: stored?.order ?? "asc",
    };
  }, [settingsData?.providerSort, appId]);
  const isManualSort = providerSortPreference.by === "manual";
  const activeSensors = isManualSort ? sensors : [];
  const activeHandleDragEnd = isManualSort ? handleDragEnd : undefined;
  const sortByLabel = useMemo(() => {
    switch (providerSortPreference.by) {
      case "name":
        return t("provider.sortByName", { defaultValue: "名称" });
      case "createdAt":
        return t("provider.sortByCreatedAt", { defaultValue: "加入时间" });
      default:
        return t("provider.sortByManual", { defaultValue: "故障转移优先级" });
    }
  }, [providerSortPreference.by, t]);
  const sortOrderLabel = useMemo(
    () =>
      providerSortPreference.order === "desc"
        ? t("provider.sortOrderDesc", { defaultValue: "倒序" })
        : t("provider.sortOrderAsc", { defaultValue: "正序" }),
    [providerSortPreference.order, t],
  );
  const sortedProviders = useMemo(() => {
    if (providerSortPreference.by === "manual") {
      return manualSortedProviders;
    }

    const list = Object.values(providers);
    const direction = providerSortPreference.order === "desc" ? -1 : 1;

    list.sort((a, b) => {
      if (providerSortPreference.by === "name") {
        const nameCompare = a.name.localeCompare(b.name, locale);
        if (nameCompare !== 0) return nameCompare * direction;
        return a.id.localeCompare(b.id, locale) * direction;
      }

      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      const hasTimeA = timeA > 0;
      const hasTimeB = timeB > 0;
      if (hasTimeA && hasTimeB && timeA !== timeB) {
        return (timeA - timeB) * direction;
      }
      if (hasTimeA !== hasTimeB) {
        return hasTimeA ? -1 : 1;
      }
      return a.id.localeCompare(b.id, locale) * direction;
    });

    return list;
  }, [
    manualSortedProviders,
    providers,
    providerSortPreference.by,
    providerSortPreference.order,
    locale,
  ]);

  const [viewMode, setViewMode] = useState<ProviderViewMode>(() => {
    if (typeof window === "undefined") return "card";
    const saved = window.localStorage.getItem(
      VIEW_MODE_STORAGE_KEY,
    ) as ProviderViewMode | null;
    return saved === "card" || saved === "list" ? saved : "card";
  });
  const [density, setDensity] = useState<ProviderDensity>(() => {
    if (typeof window === "undefined") return "compact";
    const saved = window.localStorage.getItem(
      DENSITY_STORAGE_KEY,
    ) as ProviderDensity | null;
    return saved === "compact" || saved === "comfortable" ? saved : "compact";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  }, [density]);

  const { data: opencodeLiveIds } = useQuery({
    queryKey: ["opencodeLiveProviderIds"],
    queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
    enabled: appId === "opencode",
  });

  // OpenClaw: query provider IDs in live config for isInConfig.
  const { data: openclawLiveIds } = useOpenClawLiveProviderIds(
    appId === "openclaw",
  );

  // Determine whether provider is included in config for additive apps.
  const isProviderInConfig = useCallback(
    (providerId: string): boolean => {
      if (appId === "opencode") {
        return opencodeLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "openclaw") {
        return openclawLiveIds?.includes(providerId) ?? false;
      }
      return true; // other apps always return true
    },
    [appId, opencodeLiveIds, openclawLiveIds],
  );

  // OpenClaw: query default model to determine which provider is default
  const { data: openclawDefaultModel } = useOpenClawDefaultModel(
    appId === "openclaw",
  );

  const supportsCommonConfig =
    appId === "claude" || appId === "codex" || appId === "gemini";
  const enableStreamCheck = appId !== "opencode" && appId !== "openclaw";

  const [commonConfigSnippet, setCommonConfigSnippet] = useState("");
  const [commonConfigError, setCommonConfigError] = useState("");
  const [isCommonConfigOpen, setIsCommonConfigOpen] = useState(false);
  const [isBatchTestOpen, setIsBatchTestOpen] = useState(false);
  const [isCommonConfigSaving, setIsCommonConfigSaving] = useState(false);
  const [isCommonConfigLoading, setIsCommonConfigLoading] = useState(false);
  const [isApplyingCommonConfig, setIsApplyingCommonConfig] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const listScrollRef = useRef<HTMLDivElement>(null);

  const getTerminalTargetKey = useCallback(
    (providerId?: string) =>
      providerId ? `${appId}:provider:${providerId}` : `${appId}:global`,
    [appId],
  );

  const normalizeRecentPaths = useCallback(
    (paths?: Array<string | null | undefined>) => {
      const seen = new Set<string>();
      const normalized: string[] = [];
      for (const raw of paths ?? []) {
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value) continue;
        const key = isWindows() ? value.toLowerCase() : value;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(value);
        if (normalized.length >= 10) break;
      }
      return normalized;
    },
    [],
  );

  const normalizeTerminalTarget = useCallback(
    (target?: TerminalTargetPreference): TerminalTargetPreference => {
      if (!target) {
        return { mode: "recent", recentCwds: [] };
      }

      const mode = (target.mode ?? "recent") as string;
      const recentCwds = normalizeRecentPaths(target.recentCwds ?? []);

      if (mode === "manual" || mode === "recent") {
        return { ...target, mode: mode as TerminalTargetMode, recentCwds };
      }

      if (mode === "custom") {
        const legacyCustomPath = (target as Record<string, unknown>)
          .customPath as string | undefined;
        const lastCwd = legacyCustomPath ?? target.lastCwd;
        return {
          mode: "manual",
          lastCwd,
          recentCwds: normalizeRecentPaths([lastCwd, ...recentCwds]),
        };
      }

      return { ...target, mode: "recent", recentCwds };
    },
    [normalizeRecentPaths],
  );

  const getTerminalTarget = useCallback(
    (providerId?: string): TerminalTargetPreference => {
      const key = getTerminalTargetKey(providerId);
      return {
        ...normalizeTerminalTarget(settingsData?.terminalTargets?.[key]),
      };
    },
    [
      getTerminalTargetKey,
      normalizeTerminalTarget,
      settingsData?.terminalTargets,
    ],
  );

  const saveTerminalTarget = useCallback(
    async (key: string, patch: TerminalTargetPreference) => {
      const base = settingsData ?? (await settingsApi.get());
      const prevTargets = base.terminalTargets ?? {};
      const nextTarget = {
        ...normalizeTerminalTarget(prevTargets[key]),
        ...patch,
      };
      const nextSettings = {
        ...base,
        terminalTargets: { ...prevTargets, [key]: nextTarget },
      };
      await settingsApi.save(nextSettings);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      return nextTarget;
    },
    [queryClient, settingsData],
  );

  const saveProviderSort = useCallback(
    async (nextPreference: Partial<ProviderSortPreference>) => {
      const base = settingsData ?? (await settingsApi.get());
      const prevSort = base.providerSort ?? {};
      const existing = prevSort[appId] ?? { by: "manual", order: "asc" };
      const next: ProviderSortPreference = {
        by: nextPreference.by ?? existing.by,
        order: nextPreference.order ?? existing.order,
      };
      const nextSettings = {
        ...base,
        providerSort: { ...prevSort, [appId]: next },
      };
      await settingsApi.save(nextSettings);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    [appId, queryClient, settingsData],
  );

  const appTerminalTarget = useMemo(
    () => getTerminalTarget(),
    [getTerminalTarget],
  );
  const appRecentTerminalTargets = appTerminalTarget.recentCwds ?? [];
  const hasAppRecentTargets = appRecentTerminalTargets.length > 0;

  const addRecentCwd = useCallback(
    (target: TerminalTargetPreference, cwd: string) => {
      const merged = normalizeRecentPaths([
        cwd,
        ...(target.recentCwds ?? []),
        target.lastCwd ?? null,
      ]);
      return {
        ...target,
        lastCwd: cwd,
        recentCwds: merged,
      };
    },
    [normalizeRecentPaths],
  );

  const getRecentTerminalTargets = useCallback(
    (providerId?: string) => getTerminalTarget(providerId).recentCwds ?? [],
    [getTerminalTarget],
  );

  const handleOpenTerminalWithMode = useCallback(
    async (
      provider: Provider | null,
      mode: TerminalTargetMode,
      selectedPath?: string,
    ) => {
      if (!provider || !onOpenTerminal) return;
      const key = getTerminalTargetKey(provider.id);
      const target = getTerminalTarget(provider.id);
      let cwd: string | undefined;

      if (mode === "manual") {
        const picked = await settingsApi.selectConfigDirectory(
          target.lastCwd ?? undefined,
        );
        if (!picked) return;
        cwd = picked;
      } else {
        cwd =
          selectedPath ?? target.recentCwds?.[0] ?? target.lastCwd ?? undefined;
        if (!cwd) return;
      }

      await onOpenTerminal(provider, { cwd });

      const nextTarget = addRecentCwd({ ...target, mode }, cwd);
      await saveTerminalTarget(key, {
        mode,
        lastCwd: nextTarget.lastCwd,
        recentCwds: nextTarget.recentCwds,
      });
    },
    [
      addRecentCwd,
      getTerminalTarget,
      getTerminalTargetKey,
      onOpenTerminal,
      saveTerminalTarget,
    ],
  );

  const canOpenProviderTerminal = Boolean(onOpenTerminal);
  const providerTerminalHandler = canOpenProviderTerminal
    ? handleOpenTerminalWithMode
    : undefined;

  const handleOpenAppTerminalWithMode = useCallback(
    async (mode: TerminalTargetMode, selectedPath?: string) => {
      if (!onOpenAppTerminal) return;
      const key = getTerminalTargetKey();
      const target = getTerminalTarget();
      let cwd: string | undefined;

      if (mode === "manual") {
        const picked = await settingsApi.selectConfigDirectory(
          target.lastCwd ?? undefined,
        );
        if (!picked) return;
        cwd = picked;
      } else {
        cwd =
          selectedPath ?? target.recentCwds?.[0] ?? target.lastCwd ?? undefined;
        if (!cwd) return;
      }

      await onOpenAppTerminal({ cwd });

      const nextTarget = addRecentCwd({ ...target, mode }, cwd);
      await saveTerminalTarget(key, {
        mode,
        lastCwd: nextTarget.lastCwd,
        recentCwds: nextTarget.recentCwds,
      });
    },
    [
      addRecentCwd,
      getTerminalTarget,
      getTerminalTargetKey,
      onOpenAppTerminal,
      saveTerminalTarget,
    ],
  );

  const handleClearRecentTerminals = useCallback(
    async (providerId?: string) => {
      const key = getTerminalTargetKey(providerId);
      await saveTerminalTarget(key, { recentCwds: [] });
    },
    [getTerminalTargetKey, saveTerminalTarget],
  );

  const [streamConfig, setStreamConfig] = useState<StreamCheckConfig | null>(
    null,
  );
  const [testModel, setTestModel] = useState("");
  const [isSavingTestModel, setIsSavingTestModel] = useState(false);
  const [isBatchTesting, setIsBatchTesting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    index: number;
    total: number;
    name: string;
  } | null>(null);
  const [batchSelections, setBatchSelections] = useState<
    Record<string, boolean>
  >({});
  const [batchResults, setBatchResults] = useState<
    Record<string, StreamCheckResult | null>
  >({});

  const modelKey = useMemo<TestModelKey | null>(() => {
    if (!enableStreamCheck) return null;
    if (appId === "claude") return "claudeModel";
    if (appId === "codex") return "codexModel";
    if (appId === "gemini") return "geminiModel";
    return null;
  }, [appId, enableStreamCheck]);

  useEffect(() => {
    if (!enableStreamCheck || !modelKey) return;
    let active = true;

    const loadStreamConfig = async () => {
      try {
        const config = await getStreamCheckConfig();
        if (!active) return;
        setStreamConfig(config);
        setTestModel(config[modelKey] || "");
      } catch (error) {
        console.error(
          "[ProviderList] Failed to load stream check config",
          error,
        );
      }
    };

    loadStreamConfig();
    return () => {
      active = false;
    };
  }, [enableStreamCheck, modelKey]);

  useEffect(() => {
    if (!supportsCommonConfig) return;
    let active = true;

    const loadCommonConfigSnippet = async () => {
      try {
        setIsCommonConfigLoading(true);
        setCommonConfigError("");
        const snippet = await configApi.getCommonConfigSnippet(
          appId as "claude" | "codex" | "gemini",
        );
        if (!active) return;
        setCommonConfigSnippet(snippet || "");
      } catch (error) {
        console.error(
          "[ProviderList] Failed to load common config snippet",
          error,
        );
      } finally {
        if (active) {
          setIsCommonConfigLoading(false);
        }
      }
    };

    loadCommonConfigSnippet();
    return () => {
      active = false;
    };
  }, [appId, supportsCommonConfig]);

  useEffect(() => {
    if (!isBatchTestOpen) return;
    const initialSelections: Record<string, boolean> = {};
    for (const provider of sortedProviders) {
      initialSelections[provider.id] = true;
    }
    setBatchSelections(initialSelections);
    setBatchResults({});
  }, [isBatchTestOpen, sortedProviders]);

  useEffect(() => {
    if (isBatchTestOpen) return;
    setBatchProgress(null);
    setIsBatchTesting(false);
  }, [isBatchTestOpen]);

  const { checkProvider, isChecking } = useStreamCheck(appId);
  const handleTestProvider = useCallback(
    (provider: Provider) => {
      void checkProvider(provider.id, provider.name);
    },
    [checkProvider],
  );

  const isProviderDefaultModel = useCallback(
    (providerId: string): boolean => {
      if (appId !== "openclaw" || !openclawDefaultModel?.primary) return false;
      return openclawDefaultModel.primary.startsWith(providerId + "/");
    },
    [appId, openclawDefaultModel],
  );

  // Failover related state.
  const { data: isAutoFailoverEnabled } = useAutoFailoverEnabled(appId);
  const { data: failoverQueue } = useFailoverQueue(appId);
  const addToQueue = useAddToFailoverQueue();
  const removeFromQueue = useRemoveFromFailoverQueue();

  const isAutoFailoverActive = isAutoFailoverEnabled === true;

  const isOpenCode = appId === "opencode";
  const { data: currentOmoId } = useCurrentOmoProviderId(isOpenCode);
  const { data: currentOmoSlimId } = useCurrentOmoSlimProviderId(isOpenCode);

  const getFailoverPriority = useCallback(
    (providerId: string): number | undefined => {
      if (!isAutoFailoverActive || !failoverQueue) return undefined;
      const index = failoverQueue.findIndex(
        (item) => item.providerId === providerId,
      );
      return index >= 0 ? index + 1 : undefined;
    },
    [isAutoFailoverActive, failoverQueue],
  );

  const isInFailoverQueue = useCallback(
    (providerId: string): boolean => {
      if (!isAutoFailoverActive || !failoverQueue) return false;
      return failoverQueue.some((item) => item.providerId === providerId);
    },
    [isAutoFailoverActive, failoverQueue],
  );

  const handleToggleFailover = useCallback(
    (providerId: string, enabled: boolean) => {
      if (enabled) {
        addToQueue.mutate({ appType: appId, providerId });
      } else {
        removeFromQueue.mutate({ appType: appId, providerId });
      }
    },
    [appId, addToQueue, removeFromQueue],
  );

  const [isBulkFailoverToggling, setIsBulkFailoverToggling] = useState(false);

  const failoverCandidateProviderIds = useMemo(() => {
    if (!isAutoFailoverActive) return [];
    return sortedProviders
      .filter((provider) => {
        const isOmoCategory =
          provider.category === "omo" || provider.category === "omo-slim";
        const isAdditiveMode =
          (appId === "opencode" && !isOmoCategory) || appId === "openclaw";
        return !isAdditiveMode && !isOmoCategory;
      })
      .map((provider) => provider.id);
  }, [appId, isAutoFailoverActive, sortedProviders]);

  const failoverQueueSet = useMemo(
    () => new Set((failoverQueue ?? []).map((item) => item.providerId)),
    [failoverQueue],
  );

  const enabledFailoverCount = useMemo(
    () =>
      failoverCandidateProviderIds.filter((id) => failoverQueueSet.has(id))
        .length,
    [failoverCandidateProviderIds, failoverQueueSet],
  );

  const allFailoverEnabled =
    failoverCandidateProviderIds.length > 0 &&
    enabledFailoverCount === failoverCandidateProviderIds.length;

  const failoverBulkSwitchDisabled =
    isBulkFailoverToggling ||
    addToQueue.isPending ||
    removeFromQueue.isPending ||
    failoverCandidateProviderIds.length === 0;

  const handleToggleAllFailover = useCallback(
    async (enabled: boolean) => {
      if (failoverCandidateProviderIds.length === 0) return;

      const targetProviderIds = enabled
        ? failoverCandidateProviderIds.filter((id) => !failoverQueueSet.has(id))
        : failoverCandidateProviderIds.filter((id) => failoverQueueSet.has(id));

      if (targetProviderIds.length === 0) return;

      const mutate = enabled
        ? addToQueue.mutateAsync
        : removeFromQueue.mutateAsync;
      setIsBulkFailoverToggling(true);
      try {
        const results = await Promise.allSettled(
          targetProviderIds.map((providerId) =>
            mutate({ appType: appId, providerId }),
          ),
        );
        const failedCount = results.filter(
          (result) => result.status === "rejected",
        ).length;

        if (failedCount > 0) {
          toast.error(
            t("failover.bulkTogglePartialFailed", {
              failedCount,
              totalCount: targetProviderIds.length,
              defaultValue:
                "部分操作失败：{{failedCount}} / {{totalCount}} 个供应商未更新",
            }),
          );
          return;
        }

        toast.success(
          enabled
            ? t("failover.bulkEnableSuccess", {
                count: targetProviderIds.length,
                defaultValue: "已将 {{count}} 个供应商加入故障转移队列",
              })
            : t("failover.bulkDisableSuccess", {
                count: targetProviderIds.length,
                defaultValue: "已将 {{count}} 个供应商移出故障转移队列",
              }),
          { closeButton: true },
        );
      } finally {
        setIsBulkFailoverToggling(false);
      }
    },
    [
      addToQueue.mutateAsync,
      addToQueue,
      appId,
      failoverCandidateProviderIds,
      failoverQueueSet,
      removeFromQueue.mutateAsync,
      removeFromQueue,
      t,
    ],
  );

  const { data: appProxyConfig } = useAppProxyConfig(appId);
  const updateAppProxyConfig = useUpdateAppProxyConfig();
  const { data: providerSessionOccupancy = [] } = useProviderSessionOccupancy(
    appId,
    appProxyConfig?.sessionIdleTtlMinutes,
  );
  const sessionOccupancyMap = useMemo(() => {
    return new Map(
      providerSessionOccupancy.map((item) => [
        item.providerId,
        item.sessionCount,
      ]),
    );
  }, [providerSessionOccupancy]);
  const activeSessionCount = useMemo(
    () =>
      providerSessionOccupancy.reduce(
        (total, item) => total + item.sessionCount,
        0,
      ),
    [providerSessionOccupancy],
  );
  const occupiedProviderCount = useMemo(
    () =>
      providerSessionOccupancy.filter((item) => item.sessionCount > 0).length,
    [providerSessionOccupancy],
  );

  const [isSessionRoutingDialogOpen, setIsSessionRoutingDialogOpen] =
    useState(false);
  const [sessionRoutingForm, setSessionRoutingForm] = useState({
    enabled: false,
    strategy: "priority" as SessionRoutingStrategy,
    maxSessionsPerProvider: "1",
    allowSharedWhenExhausted: false,
    idleTtlMinutes: "30",
  });

  useEffect(() => {
    if (!appProxyConfig) return;
    setSessionRoutingForm({
      enabled: appProxyConfig.sessionRoutingEnabled,
      strategy: appProxyConfig.sessionRoutingStrategy,
      maxSessionsPerProvider: String(
        appProxyConfig.sessionMaxSessionsPerProvider,
      ),
      allowSharedWhenExhausted: appProxyConfig.sessionAllowSharedWhenExhausted,
      idleTtlMinutes: String(appProxyConfig.sessionIdleTtlMinutes),
    });
  }, [appProxyConfig]);

  const sessionRoutingDirty = useMemo(() => {
    if (!appProxyConfig) return false;
    return (
      sessionRoutingForm.enabled !== appProxyConfig.sessionRoutingEnabled ||
      sessionRoutingForm.strategy !== appProxyConfig.sessionRoutingStrategy ||
      Number(sessionRoutingForm.maxSessionsPerProvider || 0) !==
        appProxyConfig.sessionMaxSessionsPerProvider ||
      sessionRoutingForm.allowSharedWhenExhausted !==
        appProxyConfig.sessionAllowSharedWhenExhausted ||
      Number(sessionRoutingForm.idleTtlMinutes || 0) !==
        appProxyConfig.sessionIdleTtlMinutes
    );
  }, [appProxyConfig, sessionRoutingForm]);

  const selectedSessionRoutingStrategy = useMemo(
    () =>
      SESSION_ROUTING_STRATEGY_OPTIONS.find(
        (option) => option.value === sessionRoutingForm.strategy,
      ) ?? SESSION_ROUTING_STRATEGY_OPTIONS[0],
    [sessionRoutingForm.strategy],
  );

  const handleSaveSessionRoutingConfig = useCallback(async () => {
    if (!appProxyConfig) return;

    const maxSessions = Number.parseInt(
      sessionRoutingForm.maxSessionsPerProvider,
      10,
    );
    const idleTtl = Number.parseInt(sessionRoutingForm.idleTtlMinutes, 10);

    if (!Number.isFinite(maxSessions) || maxSessions < 1 || maxSessions > 99) {
      toast.error(
        t("proxy.sessionRouting.validation.maxSessions", {
          defaultValue: "每个提供商最大会话数需为 1-99 的整数",
        }),
      );
      return;
    }

    if (!Number.isFinite(idleTtl) || idleTtl < 1 || idleTtl > 1440) {
      toast.error(
        t("proxy.sessionRouting.validation.idleTtl", {
          defaultValue: "会话空闲释放时间需为 1-1440 分钟",
        }),
      );
      return;
    }

    await updateAppProxyConfig.mutateAsync({
      config: {
        ...appProxyConfig,
        sessionRoutingEnabled: sessionRoutingForm.enabled,
        sessionRoutingStrategy: sessionRoutingForm.strategy,
        sessionMaxSessionsPerProvider: maxSessions,
        sessionAllowSharedWhenExhausted:
          sessionRoutingForm.allowSharedWhenExhausted,
        sessionIdleTtlMinutes: idleTtl,
      },
      successMessage: t("proxy.sessionRouting.configSaved", {
        defaultValue: "会话路由配置已保存",
      }),
    });
  }, [appProxyConfig, sessionRoutingForm, t, updateAppProxyConfig]);

  const [searchTerm, setSearchTerm] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Import current live config as default provider
  const parseGeminiSnippet = useCallback(
    (
      snippetString: string,
    ): {
      env: Record<string, string>;
      config: Record<string, unknown>;
      error?: string;
    } => {
      const trimmed = snippetString.trim();
      if (!trimmed) {
        return { env: {}, config: {} };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return {
          env: {},
          config: {},
          error: t("geminiConfig.invalidJsonFormat", {
            defaultValue: "JSON 格式错误，请检查语法",
          }),
        };
      }

      if (!isPlainObject(parsed)) {
        return {
          env: {},
          config: {},
          error: t("geminiConfig.invalidJsonFormat", {
            defaultValue: "JSON 格式错误，请检查语法",
          }),
        };
      }

      const parsedObj = parsed as Record<string, unknown>;
      const hasStructured =
        Object.prototype.hasOwnProperty.call(parsedObj, "env") ||
        Object.prototype.hasOwnProperty.call(parsedObj, "config");

      const envSource = hasStructured ? parsedObj.env : parsedObj;
      const configSource = hasStructured ? parsedObj.config : undefined;

      if (
        envSource !== undefined &&
        envSource !== null &&
        !isPlainObject(envSource)
      ) {
        return {
          env: {},
          config: {},
          error: t("geminiConfig.invalidJsonFormat", {
            defaultValue: "JSON 格式错误，请检查语法",
          }),
        };
      }

      const env: Record<string, string> = {};
      if (envSource && isPlainObject(envSource)) {
        const keys = Object.keys(envSource);
        const forbiddenKeys = keys.filter((key) =>
          GEMINI_COMMON_ENV_FORBIDDEN_KEYS.includes(
            key as GeminiForbiddenEnvKey,
          ),
        );
        if (forbiddenKeys.length > 0) {
          return {
            env: {},
            config: {},
            error: t("geminiConfig.commonConfigInvalidKeys", {
              keys: forbiddenKeys.join(", "),
              defaultValue: `通用配置包含禁用字段: ${forbiddenKeys.join(", ")}`,
            }),
          };
        }

        for (const [key, value] of Object.entries(envSource)) {
          if (typeof value !== "string") {
            return {
              env: {},
              config: {},
              error: t("geminiConfig.commonConfigInvalidValues", {
                defaultValue: "通用配置的值必须是字符串",
              }),
            };
          }
          const normalized = value.trim();
          if (!normalized) continue;
          env[key] = normalized;
        }
      }

      const config: Record<string, unknown> = {};
      if (configSource !== undefined && configSource !== null) {
        if (!isPlainObject(configSource)) {
          return {
            env: {},
            config: {},
            error: t("geminiConfig.invalidJsonFormat", {
              defaultValue: "JSON 格式错误，请检查语法",
            }),
          };
        }
        Object.assign(config, configSource as Record<string, unknown>);
      }

      return { env, config };
    },
    [t],
  );

  const parsedGeminiSnippet = useMemo(() => {
    if (appId !== "gemini") {
      return { env: {}, config: {}, error: undefined as string | undefined };
    }
    return parseGeminiSnippet(commonConfigSnippet);
  }, [appId, commonConfigSnippet, parseGeminiSnippet]);

  const claudeSnippetToggleStates = useMemo(() => {
    if (appId !== "claude") {
      return {
        hideAttribution: false,
        alwaysThinking: false,
        teammates: false,
        skipAllPermissions: false,
        fastMode: false,
      };
    }
    try {
      const config = JSON.parse(commonConfigSnippet || "{}");
      return {
        hideAttribution:
          config?.attribution?.commit === "" && config?.attribution?.pr === "",
        alwaysThinking: config?.alwaysThinkingEnabled === true,
        teammates:
          config?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1" ||
          config?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 1,
        skipAllPermissions:
          config?.permissions?.defaultMode === "bypassPermissions",
        fastMode: config?.fastMode === true,
      };
    } catch {
      return {
        hideAttribution: false,
        alwaysThinking: false,
        teammates: false,
        skipAllPermissions: false,
        fastMode: false,
      };
    }
  }, [appId, commonConfigSnippet]);

  const geminiSnippetToggleStates = useMemo(() => {
    if (appId !== "gemini") {
      return {
        inlineThinking: false,
        showModelInfo: false,
        enableAgents: false,
      };
    }
    const config = parsedGeminiSnippet.config as Record<string, any>;
    return {
      inlineThinking: config?.ui?.inlineThinkingMode === "full",
      showModelInfo: config?.ui?.showModelInfoInChat === true,
      enableAgents: config?.experimental?.enableAgents === true,
    };
  }, [appId, parsedGeminiSnippet.config]);

  const codexSnippetFullAccess = useMemo(() => {
    if (appId !== "codex") return false;
    return (
      getTomlStringValue(commonConfigSnippet, "sandbox_mode") ===
      "danger-full-access"
    );
  }, [appId, commonConfigSnippet]);

  const handleClaudeSnippetToggle = useCallback(
    (toggleKey: string, checked: boolean) => {
      if (appId !== "claude") return;
      try {
        const config = JSON.parse(commonConfigSnippet || "{}");
        switch (toggleKey) {
          case "hideAttribution":
            if (checked) {
              config.attribution = { commit: "", pr: "" };
            } else {
              delete config.attribution;
            }
            break;
          case "alwaysThinking":
            if (checked) {
              config.alwaysThinkingEnabled = true;
            } else {
              delete config.alwaysThinkingEnabled;
            }
            break;
          case "teammates":
            if (!config.env) config.env = {};
            if (checked) {
              config.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
            } else {
              delete config.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
              if (Object.keys(config.env).length === 0) delete config.env;
            }
            break;
          case "skipAllPermissions":
            if (!config.permissions) config.permissions = {};
            if (checked) {
              config.permissions.defaultMode = "bypassPermissions";
              delete config.permissions.disableBypassPermissionsMode;
            } else if (config.permissions.defaultMode === "bypassPermissions") {
              delete config.permissions.defaultMode;
            }
            if (Object.keys(config.permissions).length === 0) {
              delete config.permissions;
            }
            break;
          case "fastMode":
            if (checked) {
              config.fastMode = true;
            } else {
              delete config.fastMode;
            }
            break;
        }

        setCommonConfigSnippet(JSON.stringify(config, null, 2));
        setCommonConfigError("");
      } catch {
        // ignore invalid JSON
      }
    },
    [appId, commonConfigSnippet],
  );

  const handleGeminiSnippetToggle = useCallback(
    (
      toggleKey: "inlineThinking" | "showModelInfo" | "enableAgents",
      checked: boolean,
    ) => {
      if (appId !== "gemini") return;
      if (parsedGeminiSnippet.error) return;

      const env = parsedGeminiSnippet.env ?? {};
      const config = { ...(parsedGeminiSnippet.config as Record<string, any>) };

      if (toggleKey === "inlineThinking") {
        config.ui = config.ui || {};
        if (checked) {
          config.ui.inlineThinkingMode = "full";
        } else {
          delete config.ui.inlineThinkingMode;
        }
        if (Object.keys(config.ui).length === 0) delete config.ui;
      }

      if (toggleKey === "showModelInfo") {
        config.ui = config.ui || {};
        if (checked) {
          config.ui.showModelInfoInChat = true;
        } else {
          delete config.ui.showModelInfoInChat;
        }
        if (Object.keys(config.ui).length === 0) delete config.ui;
      }

      if (toggleKey === "enableAgents") {
        config.experimental = config.experimental || {};
        if (checked) {
          config.experimental.enableAgents = true;
        } else {
          delete config.experimental.enableAgents;
        }
        if (Object.keys(config.experimental).length === 0) {
          delete config.experimental;
        }
      }

      setCommonConfigSnippet(JSON.stringify({ env, config }, null, 2));
      setCommonConfigError("");
    },
    [appId, parsedGeminiSnippet],
  );

  const handleCodexSnippetToggle = useCallback(
    (checked: boolean) => {
      if (appId !== "codex") return;
      const nextSnippet = checked
        ? upsertTomlStringValue(
            commonConfigSnippet,
            "sandbox_mode",
            "danger-full-access",
          )
        : removeTomlKeyIfMatch(
            commonConfigSnippet,
            "sandbox_mode",
            "danger-full-access",
          );
      setCommonConfigSnippet(nextSnippet);
      setCommonConfigError("");
    },
    [appId, commonConfigSnippet],
  );

  const hasGeminiConfigSnippet = useCallback(
    (
      configObj: Record<string, unknown>,
      snippetConfig: Record<string, unknown>,
    ): boolean => {
      for (const [key, value] of Object.entries(snippetConfig)) {
        if (!(key in configObj)) return false;
        const targetValue = configObj[key];
        if (isPlainObject(value) && isPlainObject(targetValue)) {
          if (
            !hasGeminiConfigSnippet(
              targetValue as Record<string, unknown>,
              value as Record<string, unknown>,
            )
          ) {
            return false;
          }
        } else if (targetValue !== value) {
          return false;
        }
      }
      return true;
    },
    [],
  );

  const mergeGeminiConfigSnippet = useCallback(
    (
      configObj: Record<string, unknown>,
      snippetConfig: Record<string, unknown>,
    ) => {
      const next = { ...configObj };
      for (const [key, value] of Object.entries(snippetConfig)) {
        if (isPlainObject(value) && isPlainObject(next[key])) {
          next[key] = mergeGeminiConfigSnippet(
            next[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          );
        } else {
          next[key] = value;
        }
      }
      return next;
    },
    [],
  );

  const removeGeminiConfigSnippet = useCallback(
    (
      configObj: Record<string, unknown>,
      snippetConfig: Record<string, unknown>,
    ) => {
      const next = { ...configObj };
      for (const [key, value] of Object.entries(snippetConfig)) {
        if (!(key in next)) continue;
        if (isPlainObject(value) && isPlainObject(next[key])) {
          const nested = removeGeminiConfigSnippet(
            next[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          );
          if (Object.keys(nested).length === 0) {
            delete next[key];
          } else {
            next[key] = nested;
          }
        } else if (next[key] === value) {
          delete next[key];
        }
      }
      return next;
    },
    [],
  );

  const hasCommonConfigForProvider = useCallback(
    (provider: Provider): boolean => {
      if (!commonConfigSnippet.trim()) return false;

      if (appId === "claude") {
        const jsonString = JSON.stringify(provider.settingsConfig ?? {});
        return hasCommonConfigSnippet(jsonString, commonConfigSnippet);
      }

      if (appId === "codex") {
        const configText =
          typeof provider.settingsConfig?.config === "string"
            ? provider.settingsConfig.config
            : "";
        return hasTomlCommonConfigSnippet(configText, commonConfigSnippet);
      }

      if (appId === "gemini") {
        if (parsedGeminiSnippet.error) return false;
        const envEntries = Object.entries(parsedGeminiSnippet.env);
        const configEntries = Object.entries(parsedGeminiSnippet.config);
        if (envEntries.length === 0 && configEntries.length === 0) return false;

        const rawEnv = isPlainObject(provider.settingsConfig?.env)
          ? (provider.settingsConfig?.env as Record<string, unknown>)
          : {};
        const envObj: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawEnv)) {
          if (typeof value === "string") {
            envObj[key] = value;
          }
        }

        const envMatches =
          envEntries.length === 0 ||
          envEntries.every(([key, value]) => envObj[key] === value);

        const rawConfig = isPlainObject(provider.settingsConfig?.config)
          ? (provider.settingsConfig?.config as Record<string, unknown>)
          : {};
        const configMatches =
          configEntries.length === 0 ||
          hasGeminiConfigSnippet(rawConfig, parsedGeminiSnippet.config);

        return envMatches && configMatches;
      }

      return false;
    },
    [appId, commonConfigSnippet, parsedGeminiSnippet, hasGeminiConfigSnippet],
  );

  const commonConfigStatus = useMemo(() => {
    const total = sortedProviders.length;
    if (!supportsCommonConfig || total === 0) {
      return {
        total,
        appliedCount: 0,
        allApplied: false,
        partial: false,
      };
    }
    if (!commonConfigSnippet.trim()) {
      return {
        total,
        appliedCount: 0,
        allApplied: false,
        partial: false,
      };
    }

    let appliedCount = 0;
    for (const provider of sortedProviders) {
      if (hasCommonConfigForProvider(provider)) {
        appliedCount += 1;
      }
    }

    return {
      total,
      appliedCount,
      allApplied: appliedCount === total && total > 0,
      partial: appliedCount > 0 && appliedCount < total,
    };
  }, [
    supportsCommonConfig,
    sortedProviders,
    commonConfigSnippet,
    hasCommonConfigForProvider,
  ]);

  const batchSelectionStatus = useMemo(() => {
    const total = sortedProviders.length;
    if (total === 0) {
      return { total, selected: 0, allSelected: false, partial: false };
    }
    let selected = 0;
    for (const provider of sortedProviders) {
      if (batchSelections[provider.id] ?? true) {
        selected += 1;
      }
    }
    return {
      total,
      selected,
      allSelected: selected === total,
      partial: selected > 0 && selected < total,
    };
  }, [sortedProviders, batchSelections]);

  const orderedBatchProviders = useMemo(() => {
    if (!enableStreamCheck) return sortedProviders;
    const selected: Provider[] = [];
    const unselected: Provider[] = [];
    for (const provider of sortedProviders) {
      const isSelected = batchSelections[provider.id] ?? true;
      if (isSelected) {
        selected.push(provider);
      } else {
        unselected.push(provider);
      }
    }
    return [...selected, ...unselected];
  }, [enableStreamCheck, sortedProviders, batchSelections]);

  const selectedBatchProviders = useMemo(() => {
    if (!enableStreamCheck) return [];
    return orderedBatchProviders.filter(
      (provider) => batchSelections[provider.id] ?? true,
    );
  }, [enableStreamCheck, orderedBatchProviders, batchSelections]);

  const saveTestModelIfNeeded = useCallback(async () => {
    if (!streamConfig || !modelKey) return;
    const nextModel = testModel.trim();
    if (streamConfig[modelKey] === nextModel) return;

    const nextConfig: StreamCheckConfig = {
      ...streamConfig,
      [modelKey]: nextModel,
    };

    try {
      setIsSavingTestModel(true);
      await saveStreamCheckConfig(nextConfig);
      setStreamConfig(nextConfig);
    } catch (error) {
      console.error("[ProviderList] Failed to save test model", error);
      toast.error(
        t("streamCheck.configSaveFailed", {
          defaultValue: "测试模型保存失败",
        }),
      );
    } finally {
      setIsSavingTestModel(false);
    }
  }, [streamConfig, modelKey, testModel, t]);

  const handleBatchTest = useCallback(async () => {
    if (!enableStreamCheck || isBatchTesting) return;
    if (selectedBatchProviders.length === 0) return;

    await saveTestModelIfNeeded();

    const total = selectedBatchProviders.length;
    setIsBatchTesting(true);
    setBatchResults((prev) => {
      const next = { ...prev };
      for (const provider of selectedBatchProviders) {
        delete next[provider.id];
      }
      return next;
    });
    try {
      for (let index = 0; index < selectedBatchProviders.length; index += 1) {
        const provider = selectedBatchProviders[index];
        setBatchProgress({
          index: index + 1,
          total,
          name: provider.name,
        });
        const result = await checkProvider(provider.id, provider.name);
        setBatchResults((prev) => ({
          ...prev,
          [provider.id]: result,
        }));
      }
    } finally {
      setBatchProgress(null);
      setIsBatchTesting(false);
    }
  }, [
    enableStreamCheck,
    isBatchTesting,
    selectedBatchProviders,
    checkProvider,
    saveTestModelIfNeeded,
  ]);

  const handleToggleBatchSelection = useCallback(
    (providerId: string, checked: boolean) => {
      setBatchSelections((prev) => ({
        ...prev,
        [providerId]: checked,
      }));
    },
    [],
  );

  const handleToggleAllBatchSelections = useCallback(
    (checked: boolean) => {
      const next: Record<string, boolean> = {};
      for (const provider of sortedProviders) {
        next[provider.id] = checked;
      }
      setBatchSelections(next);
    },
    [sortedProviders],
  );

  const handleSaveCommonConfig = useCallback(async () => {
    if (!supportsCommonConfig) return;

    let validationError = "";
    if (appId === "claude") {
      validationError = validateJsonConfig(
        commonConfigSnippet,
        t("claudeConfig.commonConfigSnippet", {
          defaultValue: "通用配置片段",
        }),
      );
    } else if (appId === "gemini") {
      if (parsedGeminiSnippet.error) {
        validationError = parsedGeminiSnippet.error;
      }
    }

    if (validationError) {
      setCommonConfigError(validationError);
      return;
    }

    try {
      setIsCommonConfigSaving(true);
      setCommonConfigError("");
      await configApi.setCommonConfigSnippet(
        appId as "claude" | "codex" | "gemini",
        commonConfigSnippet.trim(),
      );
      setIsCommonConfigOpen(false);
      toast.success(
        t("common.saved", {
          defaultValue: "已保存",
        }),
      );
    } catch (error) {
      console.error(
        "[ProviderList] Failed to save common config snippet",
        error,
      );
      const message = String(error);
      setCommonConfigError(message);
      toast.error(message);
    } finally {
      setIsCommonConfigSaving(false);
    }
  }, [
    supportsCommonConfig,
    appId,
    commonConfigSnippet,
    parsedGeminiSnippet,
    t,
  ]);

  const handleApplyCommonConfigToAll = useCallback(
    async (enabled: boolean) => {
      if (!supportsCommonConfig) return;
      if (sortedProviders.length === 0) return;

      const snippet = commonConfigSnippet.trim();
      if (!snippet) {
        toast.error(
          t("provider.commonConfigEmpty", {
            defaultValue: "通用配置片段为空",
          }),
        );
        return;
      }

      if (appId === "gemini" && parsedGeminiSnippet.error) {
        setCommonConfigError(parsedGeminiSnippet.error);
        toast.error(parsedGeminiSnippet.error);
        return;
      }

      setIsApplyingCommonConfig(true);
      setCommonConfigError("");
      try {
        const failed: { name: string; reason: string }[] = [];

        for (const provider of sortedProviders) {
          try {
            if (appId === "claude") {
              const originalConfig = JSON.stringify(
                provider.settingsConfig ?? {},
              );
              const { updatedConfig, error } = updateCommonConfigSnippet(
                originalConfig,
                snippet,
                enabled,
              );
              if (error) {
                throw new Error(error);
              }
              if (updatedConfig === originalConfig) {
                continue;
              }
              const updatedSettingsConfig = JSON.parse(updatedConfig);
              await providersApi.update(
                { ...provider, settingsConfig: updatedSettingsConfig },
                appId,
              );
              continue;
            }

            if (appId === "codex") {
              const originalConfig =
                typeof provider.settingsConfig?.config === "string"
                  ? provider.settingsConfig.config
                  : "";
              const { updatedConfig, error } = updateTomlCommonConfigSnippet(
                originalConfig,
                snippet,
                enabled,
              );
              if (error) {
                throw new Error(error);
              }
              if (updatedConfig === originalConfig) {
                continue;
              }
              const updatedSettingsConfig = {
                ...(provider.settingsConfig ?? {}),
                config: updatedConfig,
              };
              await providersApi.update(
                { ...provider, settingsConfig: updatedSettingsConfig },
                appId,
              );
              continue;
            }

            if (appId === "gemini") {
              const rawEnv = isPlainObject(provider.settingsConfig?.env)
                ? (provider.settingsConfig?.env as Record<string, unknown>)
                : {};
              const envObj: Record<string, string> = {};
              for (const [key, value] of Object.entries(rawEnv)) {
                if (typeof value === "string") {
                  envObj[key] = value;
                }
              }

              const snippetEnv = parsedGeminiSnippet.env;
              const updatedEnv = { ...envObj };
              for (const [key, value] of Object.entries(snippetEnv)) {
                if (enabled) {
                  updatedEnv[key] = value;
                } else if (updatedEnv[key] === value) {
                  delete updatedEnv[key];
                }
              }

              const rawConfig = isPlainObject(provider.settingsConfig?.config)
                ? (provider.settingsConfig?.config as Record<string, unknown>)
                : {};
              const snippetConfig = parsedGeminiSnippet.config;
              const updatedConfig =
                Object.keys(snippetConfig).length === 0
                  ? rawConfig
                  : enabled
                    ? mergeGeminiConfigSnippet(rawConfig, snippetConfig)
                    : removeGeminiConfigSnippet(rawConfig, snippetConfig);

              const updatedSettingsConfig = {
                ...(provider.settingsConfig ?? {}),
                env: updatedEnv,
                config: updatedConfig,
              };

              if (
                JSON.stringify(updatedSettingsConfig) ===
                JSON.stringify(provider.settingsConfig ?? {})
              ) {
                continue;
              }

              await providersApi.update(
                { ...provider, settingsConfig: updatedSettingsConfig },
                appId,
              );
            }
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            failed.push({ name: provider.name, reason });
            console.error(
              `[ProviderList] Failed to apply common config for ${provider.name}`,
              error,
            );
          }
        }

        await queryClient.invalidateQueries({
          queryKey: ["providers", appId],
        });

        if (failed.length > 0) {
          const first = failed[0];
          toast.error(
            t("provider.commonConfigApplyFailed", {
              defaultValue: "通用配置批量更新失败",
            }),
            {
              description: first ? `${first.name}: ${first.reason}` : undefined,
            },
          );
        } else {
          toast.success(
            t("provider.commonConfigApplied", {
              defaultValue: enabled ? "已批量应用通用配置" : "已移除通用配置",
            }),
          );
        }
      } finally {
        setIsApplyingCommonConfig(false);
      }
    },
    [
      supportsCommonConfig,
      sortedProviders,
      commonConfigSnippet,
      appId,
      parsedGeminiSnippet,
      mergeGeminiConfigSnippet,
      removeGeminiConfigSnippet,
      queryClient,
      t,
    ],
  );

  const importMutation = useMutation({
    mutationFn: async (): Promise<boolean> => {
      if (appId === "opencode") {
        const count = await providersApi.importOpenCodeFromLive();
        return count > 0;
      }
      if (appId === "openclaw") {
        const count = await providersApi.importOpenClawFromLive();
        return count > 0;
      }
      return providersApi.importDefault(appId);
    },
    onSuccess: (imported) => {
      if (imported) {
        queryClient.invalidateQueries({ queryKey: ["providers", appId] });
        toast.success(t("provider.importCurrentDescription"));
      } else {
        toast.info(t("provider.noProviders"));
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = (event.key ?? "").toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        event.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      if (key === "escape") {
        setIsSearchOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (isSearchOpen) {
      const frame = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [isSearchOpen]);

  useEffect(() => {
    const container = listScrollRef.current;
    if (!container) return;

    const handleScroll = () => {
      setShowScrollTop(container.scrollTop > 200);
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const handleScrollTop = useCallback(() => {
    const container = listScrollRef.current;
    if (!container) return;
    container.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const filteredProviders = useMemo(() => {
    const keyword = (searchTerm ?? "").trim().toLowerCase();
    if (!keyword) return sortedProviders;
    return sortedProviders.filter((provider) => {
      const fields = [provider.name, provider.notes, provider.websiteUrl];
      return fields.some((field) => {
        const text = field?.toString();
        return text ? text.toLowerCase().includes(keyword) : false;
      });
    });
  }, [searchTerm, sortedProviders]);

  const listGapClass = density === "compact" ? "space-y-2" : "space-y-3";
  const gridGapClass = density === "compact" ? "gap-3" : "gap-4";
  const listLayoutClass =
    viewMode === "card"
      ? `grid ${gridGapClass} sm:grid-cols-2 xl:grid-cols-3`
      : listGapClass;
  const sortingStrategy =
    viewMode === "card" ? rectSortingStrategy : verticalListSortingStrategy;

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="w-full border border-dashed rounded-lg h-28 border-muted-foreground/40 bg-muted/40"
          />
        ))}
      </div>
    );
  }

  if (sortedProviders.length === 0) {
    return (
      <ProviderEmptyState
        onCreate={onCreate}
        onImport={() => importMutation.mutate()}
      />
    );
  }

  const renderProviderList = () => (
    <DndContext
      sensors={activeSensors}
      collisionDetection={closestCenter}
      onDragEnd={activeHandleDragEnd}
    >
      <SortableContext
        items={filteredProviders.map((provider) => provider.id)}
        strategy={sortingStrategy}
      >
        <div className={listLayoutClass}>
          {filteredProviders.map((provider) => {
            const isOmo = provider.category === "omo";
            const isOmoSlim = provider.category === "omo-slim";
            const isOmoCurrent = isOmo && provider.id === (currentOmoId || "");
            const isOmoSlimCurrent =
              isOmoSlim && provider.id === (currentOmoSlimId || "");
            return (
              <SortableProviderCard
                key={provider.id}
                provider={provider}
                isCurrent={
                  isOmo
                    ? isOmoCurrent
                    : isOmoSlim
                      ? isOmoSlimCurrent
                      : provider.id === currentProviderId
                }
                appId={appId}
                isInConfig={isProviderInConfig(provider.id)}
                isOmo={isOmo}
                isOmoSlim={isOmoSlim}
                onSwitch={onSwitch}
                onEdit={onEdit}
                onDelete={onDelete}
                onRemoveFromConfig={onRemoveFromConfig}
                onDisableOmo={onDisableOmo}
                onDisableOmoSlim={onDisableOmoSlim}
                onDuplicate={onDuplicate}
                onConfigureUsage={onConfigureUsage}
                onOpenWebsite={onOpenWebsite}
                onOpenTerminalWithMode={providerTerminalHandler}
                recentTerminalTargets={getRecentTerminalTargets(provider.id)}
                onClearRecentTerminals={() =>
                  void handleClearRecentTerminals(provider.id)
                }
                onTest={enableStreamCheck ? handleTestProvider : undefined}
                isTesting={enableStreamCheck ? isChecking(provider.id) : false}
                isProxyRunning={isProxyRunning}
                isProxyTakeover={isProxyTakeover}
                viewMode={viewMode}
                dragDisabled={!isManualSort}
                isAutoFailoverEnabled={isAutoFailoverActive}
                failoverPriority={getFailoverPriority(provider.id)}
                isInFailoverQueue={isInFailoverQueue(provider.id)}
                onToggleFailover={(enabled) =>
                  handleToggleFailover(provider.id, enabled)
                }
                activeProviderId={activeProviderId}
                density={density}
                sessionOccupancyCount={
                  sessionOccupancyMap.get(provider.id) ?? 0
                }
                // OpenClaw: default model
                isDefaultModel={isProviderDefaultModel(provider.id)}
                onSetAsDefault={
                  onSetAsDefault ? () => onSetAsDefault(provider) : undefined
                }
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      <AnimatePresence>
        {isSearchOpen && (
          <motion.div
            key="provider-search"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="fixed left-1/2 top-[6.5rem] z-40 w-[min(90vw,26rem)] -translate-x-1/2 sm:right-6 sm:left-auto sm:translate-x-0"
          >
            <div className="p-4 space-y-3 border shadow-md rounded-2xl border-white/10 bg-background/95 shadow-black/20 backdrop-blur-md">
              <div className="relative flex items-center gap-2">
                <Search className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none left-3 top-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t("provider.searchPlaceholder", {
                    defaultValue: "Search name, notes, or URL...",
                  })}
                  aria-label={t("provider.searchAriaLabel", {
                    defaultValue: "Search providers",
                  })}
                  className="pr-16 pl-9"
                />
                {searchTerm && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute text-xs -translate-y-1/2 right-11 top-1/2"
                    onClick={() => setSearchTerm("")}
                  >
                    {t("common.clear", { defaultValue: "Clear" })}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  onClick={() => setIsSearchOpen(false)}
                  aria-label={t("provider.searchCloseAriaLabel", {
                    defaultValue: "Close provider search",
                  })}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {t("provider.searchScopeHint", {
                    defaultValue: "Matches provider name, notes, and URL.",
                  })}
                </span>
                <span>
                  {t("provider.searchCloseHint", {
                    defaultValue: "Press Esc to close",
                  })}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur-md border-b border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {supportsCommonConfig && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => setIsCommonConfigOpen(true)}
                  disabled={isCommonConfigLoading}
                  title={t("provider.commonConfigEdit", {
                    defaultValue: "编辑通用配置",
                  })}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
                <div className="flex items-center gap-2 rounded-lg border border-border px-2 py-1">
                  <Switch
                    checked={commonConfigStatus.allApplied}
                    onCheckedChange={handleApplyCommonConfigToAll}
                    disabled={
                      isApplyingCommonConfig ||
                      isCommonConfigLoading ||
                      !commonConfigSnippet.trim()
                    }
                  />
                  <div className="text-xs">
                    <span className="font-medium">
                      {t("provider.commonConfigApplyAll", {
                        defaultValue: "通用配置",
                      })}
                    </span>
                    <span className="ml-1 text-muted-foreground">
                      {commonConfigStatus.appliedCount}/
                      {commonConfigStatus.total}
                    </span>
                    {commonConfigStatus.partial && (
                      <span className="ml-2 text-amber-500">
                        {t("provider.commonConfigPartial", {
                          defaultValue: "部分已应用",
                        })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {isAutoFailoverActive && (
              <div className="flex items-center gap-2 rounded-lg border border-border px-2 py-1">
                <Switch
                  checked={allFailoverEnabled}
                  onCheckedChange={(checked) =>
                    void handleToggleAllFailover(checked)
                  }
                  disabled={failoverBulkSwitchDisabled}
                  aria-label={t("failover.bulkToggleAll", {
                    defaultValue: "启用/禁用故障转移",
                  })}
                />
                <div className="flex items-center gap-1 text-xs">
                  <span className="font-medium">
                    {t("failover.bulkToggleAllLabel", {
                      defaultValue: "启用",
                    })}
                  </span>
                  <span className="text-muted-foreground">
                    {enabledFailoverCount}/{failoverCandidateProviderIds.length}
                  </span>
                  {isBulkFailoverToggling && (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  )}
                </div>
              </div>
            )}

            {appProxyConfig && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-2 border-border/70 bg-background/80 hover:bg-muted/70 hover:text-foreground dark:hover:bg-muted/50 dark:hover:text-foreground"
                onClick={() => setIsSessionRoutingDialogOpen(true)}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t("proxy.sessionRouting.title", {
                  defaultValue: "会话路由",
                })}
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {t("proxy.sessionRouting.activeSessions", {
                    defaultValue: "活跃会话",
                  })}
                  : {activeSessionCount}
                </span>
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-[11px]",
                    appProxyConfig.sessionRoutingEnabled
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {t("proxy.sessionRouting.app", { defaultValue: "当前应用" })}:{" "}
                  {appProxyConfig.sessionRoutingEnabled
                    ? t("common.enabled", { defaultValue: "开" })
                    : t("common.disabled", { defaultValue: "关" })}
                </span>
              </Button>
            )}

            {enableStreamCheck && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => setIsBatchTestOpen(true)}
                disabled={sortedProviders.length === 0}
                title={t("streamCheck.testAll", { defaultValue: "批量测试" })}
              >
                <FlaskConical className="h-4 w-4" />
              </Button>
            )}

            {onOpenAppTerminal && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title={t("provider.openTerminalGlobal", {
                      defaultValue: "打开终端",
                    })}
                    className="hover:text-emerald-600 dark:hover:text-emerald-400"
                  >
                    <Terminal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[220px]">
                  <DropdownMenuItem
                    onClick={() => void handleOpenAppTerminalWithMode("manual")}
                  >
                    {t("provider.terminalTargetManual", {
                      defaultValue: "手动选择",
                    })}
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      {t("provider.terminalTargetRecentOpened", {
                        defaultValue: "最近打开",
                      })}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-[260px]">
                      {hasAppRecentTargets ? (
                        appRecentTerminalTargets.map((path) => (
                          <DropdownMenuItem
                            key={path}
                            title={path}
                            onClick={() =>
                              void handleOpenAppTerminalWithMode("recent", path)
                            }
                          >
                            <span className="truncate">{path}</span>
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>
                          {t("provider.terminalTargetRecentEmpty", {
                            defaultValue: "空",
                          })}
                        </DropdownMenuItem>
                      )}
                      {hasAppRecentTargets && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => void handleClearRecentTerminals()}
                          >
                            {t("provider.terminalTargetRecentClear", {
                              defaultValue: "清除最近打开",
                            })}
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title={t("provider.sortTitle", { defaultValue: "排序" })}
                  className="h-7 px-2 text-xs bg-muted/60 text-foreground hover:bg-muted hover:text-foreground dark:hover:text-foreground"
                >
                  <ArrowUpDown className="h-3.5 w-3.5 mr-1" />
                  {sortByLabel}
                  <span className="mx-1 text-muted-foreground/80">·</span>
                  {sortOrderLabel}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuRadioGroup
                  value={providerSortPreference.by}
                  onValueChange={(value) =>
                    void saveProviderSort({ by: value as ProviderSortBy })
                  }
                >
                  <DropdownMenuRadioItem value="manual">
                    {t("provider.sortByManual", {
                      defaultValue: "故障转移优先级",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">
                    {t("provider.sortByName", { defaultValue: "名称" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="createdAt">
                    {t("provider.sortByCreatedAt", {
                      defaultValue: "加入时间",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={providerSortPreference.order}
                  onValueChange={(value) =>
                    void saveProviderSort({ order: value as SortOrder })
                  }
                >
                  <DropdownMenuRadioItem value="asc">
                    {t("provider.sortOrderAsc", { defaultValue: "正序" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="desc">
                    {t("provider.sortOrderDesc", { defaultValue: "倒序" })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs",
                  viewMode === "list"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setViewMode("list")}
                title={t("provider.viewModeList", { defaultValue: "列表" })}
              >
                <List className="h-3.5 w-3.5 mr-1" />
                {t("provider.viewModeList", { defaultValue: "列表" })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs",
                  viewMode === "card"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setViewMode("card")}
                title={t("provider.viewModeCard", { defaultValue: "卡片" })}
              >
                <LayoutGrid className="h-3.5 w-3.5 mr-1" />
                {t("provider.viewModeCard", { defaultValue: "卡片" })}
              </Button>
            </div>

            <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs",
                  density === "compact"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setDensity("compact")}
                title={t("provider.viewDensityCompact", {
                  defaultValue: "紧凑",
                })}
              >
                {t("provider.viewDensityCompact", { defaultValue: "紧凑" })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs",
                  density === "comfortable"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setDensity("comfortable")}
                title={t("provider.viewDensityComfortable", {
                  defaultValue: "宽松",
                })}
              >
                {t("provider.viewDensityComfortable", { defaultValue: "宽松" })}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={listScrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden scroll-visible px-1 pb-2"
      >
        <div className="space-y-4 pb-4">
          {filteredProviders.length === 0 ? (
            <div className="px-6 py-8 text-sm text-center border border-dashed rounded-lg border-border text-muted-foreground">
              {t("provider.noSearchResults", {
                defaultValue: "No providers match your search.",
              })}
            </div>
          ) : (
            renderProviderList()
          )}
        </div>
      </div>

      {appProxyConfig && (
        <Dialog
          open={isSessionRoutingDialogOpen}
          onOpenChange={setIsSessionRoutingDialogOpen}
        >
          <DialogContent className="sm:max-w-[640px]">
            <DialogHeader>
              <DialogTitle>
                {t("proxy.sessionRouting.title", { defaultValue: "会话路由" })}
              </DialogTitle>
              <DialogDescription>
                {t("proxy.sessionRouting.dialogHint", {
                  defaultValue:
                    "按会话维度固定提供商，提升并发下的缓存命中与稳定性。仅在当前应用生效。",
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-1">
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">
                    {t("proxy.sessionRouting.activeSessions", {
                      defaultValue: "活跃会话",
                    })}
                    : {activeSessionCount}
                  </span>
                  <span className="text-muted-foreground">
                    {t("proxy.sessionRouting.occupiedProviders", {
                      defaultValue: "占用提供商",
                    })}
                    : {occupiedProviderCount}
                  </span>
                  <span className="text-muted-foreground">
                    {t("proxy.sessionRouting.capacityHint", {
                      defaultValue:
                        "建议会话上限与提供商数量匹配，避免频繁共享切换。",
                    })}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {t("proxy.sessionRouting.app", {
                        defaultValue: "当前应用开关",
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("proxy.sessionRouting.appHint", {
                        defaultValue:
                          "仅控制当前应用（如 Codex/Claude/Gemini）是否启用会话路由。",
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={sessionRoutingForm.enabled}
                    onCheckedChange={(checked) =>
                      setSessionRoutingForm((current) => ({
                        ...current,
                        enabled: checked,
                      }))
                    }
                    disabled={updateAppProxyConfig.isPending}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t("proxy.sessionRouting.strategy", {
                    defaultValue: "分配策略",
                  })}
                </Label>
                <select
                  value={sessionRoutingForm.strategy}
                  onChange={(event) =>
                    setSessionRoutingForm((current) => ({
                      ...current,
                      strategy: event.target.value as SessionRoutingStrategy,
                    }))
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  disabled={updateAppProxyConfig.isPending}
                >
                  {SESSION_ROUTING_STRATEGY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {selectedSessionRoutingStrategy.description}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("proxy.sessionRouting.maxSessions", {
                      defaultValue: "每个提供商最大会话数",
                    })}
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    step={1}
                    inputMode="numeric"
                    value={sessionRoutingForm.maxSessionsPerProvider}
                    onChange={(event) =>
                      setSessionRoutingForm((current) => ({
                        ...current,
                        maxSessionsPerProvider: event.target.value,
                      }))
                    }
                    className="h-9 text-sm"
                    disabled={updateAppProxyConfig.isPending}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("proxy.sessionRouting.idleTtl", {
                      defaultValue: "会话空闲释放时间（分钟）",
                    })}
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    inputMode="numeric"
                    value={sessionRoutingForm.idleTtlMinutes}
                    onChange={(event) =>
                      setSessionRoutingForm((current) => ({
                        ...current,
                        idleTtlMinutes: event.target.value,
                      }))
                    }
                    className="h-9 text-sm"
                    disabled={updateAppProxyConfig.isPending}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {t("proxy.sessionRouting.share", {
                        defaultValue: "资源耗尽时允许共享",
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("proxy.sessionRouting.shareHint", {
                        defaultValue:
                          "当所有提供商都达到会话上限时，允许新会话临时复用已占用提供商。",
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={sessionRoutingForm.allowSharedWhenExhausted}
                    onCheckedChange={(checked) =>
                      setSessionRoutingForm((current) => ({
                        ...current,
                        allowSharedWhenExhausted: checked,
                      }))
                    }
                    disabled={updateAppProxyConfig.isPending}
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {t("proxy.sessionRouting.activeSessions", {
                  defaultValue: "当前活跃会话",
                })}
                : {activeSessionCount}
              </p>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsSessionRoutingDialogOpen(false)}
              >
                {t("common.close", { defaultValue: "关闭" })}
              </Button>
              <Button
                type="button"
                onClick={() => void handleSaveSessionRoutingConfig()}
                disabled={
                  !sessionRoutingDirty || updateAppProxyConfig.isPending
                }
              >
                {updateAppProxyConfig.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("common.save", { defaultValue: "保存" })
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {enableStreamCheck && (
        <FullScreenPanel
          isOpen={isBatchTestOpen}
          title={t("streamCheck.testAll", { defaultValue: "批量测试" })}
          onClose={() => setIsBatchTestOpen(false)}
          footer={
            <div className="flex w-full items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {batchSelectionStatus.selected}/{batchSelectionStatus.total}{" "}
                {t("common.selected", { defaultValue: "已选" })}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsBatchTestOpen(false)}
              >
                {t("common.close", { defaultValue: "关闭" })}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[220px] space-y-1">
                <Label htmlFor="batch-test-model">
                  {t("streamCheck.testModel", { defaultValue: "测试模型" })}
                </Label>
                <Input
                  id="batch-test-model"
                  value={testModel}
                  onChange={(event) => setTestModel(event.target.value)}
                  onBlur={() => void saveTestModelIfNeeded()}
                  placeholder={t("streamCheck.testModelPlaceholder", {
                    defaultValue: "输入用于测试的模型名称",
                  })}
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {onOpenAppTerminal && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" className="gap-2">
                        <Terminal className="h-4 w-4" />
                        {t("provider.openTerminalGlobal", {
                          defaultValue: "打开终端",
                        })}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      className="min-w-[220px]"
                    >
                      <DropdownMenuItem
                        onClick={() =>
                          void handleOpenAppTerminalWithMode("manual")
                        }
                      >
                        {t("provider.terminalTargetManual", {
                          defaultValue: "手动选择",
                        })}
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          {t("provider.terminalTargetRecentOpened", {
                            defaultValue: "最近打开",
                          })}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="min-w-[260px]">
                          {hasAppRecentTargets ? (
                            appRecentTerminalTargets.map((path) => (
                              <DropdownMenuItem
                                key={path}
                                title={path}
                                onClick={() =>
                                  void handleOpenAppTerminalWithMode(
                                    "recent",
                                    path,
                                  )
                                }
                              >
                                <span className="truncate">{path}</span>
                              </DropdownMenuItem>
                            ))
                          ) : (
                            <DropdownMenuItem disabled>
                              {t("provider.terminalTargetRecentEmpty", {
                                defaultValue: "空",
                              })}
                            </DropdownMenuItem>
                          )}
                          {hasAppRecentTargets && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() =>
                                  void handleClearRecentTerminals()
                                }
                              >
                                {t("provider.terminalTargetRecentClear", {
                                  defaultValue: "清除最近打开",
                                })}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button
                  type="button"
                  onClick={() => void handleBatchTest()}
                  disabled={
                    isBatchTesting ||
                    isSavingTestModel ||
                    selectedBatchProviders.length === 0
                  }
                >
                  {isBatchTesting ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {t("streamCheck.testing", { defaultValue: "测试中" })}
                    </>
                  ) : (
                    t("streamCheck.testAll", { defaultValue: "开始测试" })
                  )}
                </Button>
                {batchProgress && (
                  <span className="text-xs text-muted-foreground">
                    {t("streamCheck.testingProgress", {
                      defaultValue: `正在测试 ${batchProgress.index}/${batchProgress.total}: ${batchProgress.name}`,
                      index: batchProgress.index,
                      total: batchProgress.total,
                      name: batchProgress.name,
                    })}
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border overflow-hidden">
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-background">
                    <tr className="border-b border-border/60">
                      <th className="w-10 px-3 py-2 text-left">
                        <Checkbox
                          checked={
                            batchSelectionStatus.allSelected
                              ? true
                              : batchSelectionStatus.partial
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(checked) =>
                            handleToggleAllBatchSelections(checked === true)
                          }
                          aria-label={t("common.selectAll", {
                            defaultValue: "全选",
                          })}
                        />
                      </th>
                      <th className="px-3 py-2 text-left">
                        {t("provider.name", { defaultValue: "供应商" })}
                      </th>
                      <th className="px-3 py-2 text-left">
                        {t("streamCheck.status", { defaultValue: "状态" })}
                      </th>
                      <th className="px-3 py-2 text-left">
                        {t("streamCheck.responseTime", {
                          defaultValue: "耗时",
                        })}
                      </th>
                      <th className="px-3 py-2 text-left">
                        {t("streamCheck.modelUsed", {
                          defaultValue: "模型",
                        })}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderedBatchProviders.map((provider) => {
                      const isSelected = batchSelections[provider.id] ?? true;
                      const hasResult = Object.prototype.hasOwnProperty.call(
                        batchResults,
                        provider.id,
                      );
                      const result = batchResults[provider.id];
                      let statusLabel = t("streamCheck.notTested", {
                        defaultValue: "未测试",
                      });
                      let statusClass = "text-muted-foreground";
                      let statusDetail = "";
                      if (hasResult) {
                        if (!result) {
                          statusLabel = t("streamCheck.failedShort", {
                            defaultValue: "失败",
                          });
                          statusClass = "text-rose-500";
                        } else if (result.status === "operational") {
                          statusLabel = t("streamCheck.operationalShort", {
                            defaultValue: "正常",
                          });
                          statusClass = "text-emerald-500";
                        } else if (result.status === "degraded") {
                          statusLabel = t("streamCheck.degradedShort", {
                            defaultValue: "降级",
                          });
                          statusClass = "text-amber-500";
                        } else {
                          statusLabel = t("streamCheck.failedShort", {
                            defaultValue: "失败",
                          });
                          statusClass = "text-rose-500";
                        }
                        statusDetail = result?.message || "";
                      }

                      return (
                        <tr
                          key={provider.id}
                          className={cn(
                            "border-b border-border/40",
                            isSelected ? "bg-background" : "opacity-70",
                          )}
                        >
                          <td className="px-3 py-2">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(checked) =>
                                handleToggleBatchSelection(
                                  provider.id,
                                  checked === true,
                                )
                              }
                              aria-label={t("common.select", {
                                defaultValue: "选择",
                              })}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium">{provider.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {provider.id}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {isChecking(provider.id) ? (
                              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                {t("streamCheck.testing", {
                                  defaultValue: "测试中",
                                })}
                              </span>
                            ) : (
                              <span
                                className={cn(
                                  "text-sm font-medium",
                                  statusClass,
                                )}
                                title={statusDetail || undefined}
                              >
                                {statusLabel}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {result?.responseTimeMs
                              ? `${result.responseTimeMs} ms`
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {result?.modelUsed || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </FullScreenPanel>
      )}

      {supportsCommonConfig && (
        <FullScreenPanel
          isOpen={isCommonConfigOpen}
          title={
            appId === "codex"
              ? t("codexConfig.editCommonConfigTitle", {
                  defaultValue: "编辑 Codex 通用配置片段",
                })
              : appId === "gemini"
                ? t("geminiConfig.editCommonConfigTitle", {
                    defaultValue: "编辑 Gemini 通用配置片段",
                  })
                : t("claudeConfig.editCommonConfigTitle", {
                    defaultValue: "编辑通用配置片段",
                  })
          }
          onClose={() => setIsCommonConfigOpen(false)}
          footer={
            <div className="flex w-full items-center justify-between">
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">
                  {t("provider.commonConfigApplyAll", {
                    defaultValue: "通用配置",
                  })}
                </span>
                <span className="ml-1">
                  {commonConfigStatus.appliedCount}/{commonConfigStatus.total}
                </span>
                {commonConfigStatus.partial && (
                  <span className="ml-2 text-amber-500">
                    {t("provider.commonConfigPartial", {
                      defaultValue: "部分已应用",
                    })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsCommonConfigOpen(false)}
                  disabled={isCommonConfigSaving}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleSaveCommonConfig()}
                  disabled={isCommonConfigSaving}
                  className="gap-2"
                >
                  {isCommonConfigSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {t("common.save")}
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {appId === "codex"
                ? t("codexConfig.commonConfigHint")
                : appId === "gemini"
                  ? t("geminiConfig.commonConfigHint", {
                      defaultValue:
                        "该片段支持 env / config 两部分（env 不允许包含 GOOGLE_GEMINI_BASE_URL、GEMINI_API_KEY）",
                    })
                  : t("claudeConfig.commonConfigHint", {
                      defaultValue:
                        "通用配置片段将合并到所有启用它的供应商配置中",
                    })}
            </p>

            {appId === "codex" ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={codexSnippetFullAccess}
                    onChange={(e) => handleCodexSnippetToggle(e.target.checked)}
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>
                    {t("codexConfig.fullAccess", {
                      defaultValue: "完全访问权限",
                    })}
                  </span>
                </label>
              </div>
            ) : appId === "gemini" ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={geminiSnippetToggleStates.inlineThinking}
                    onChange={(e) =>
                      handleGeminiSnippetToggle(
                        "inlineThinking",
                        e.target.checked,
                      )
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>
                    {t("geminiConfig.inlineThinking", {
                      defaultValue: "扩展思考",
                    })}
                  </span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={geminiSnippetToggleStates.showModelInfo}
                    onChange={(e) =>
                      handleGeminiSnippetToggle(
                        "showModelInfo",
                        e.target.checked,
                      )
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>
                    {t("geminiConfig.showModelInfo", {
                      defaultValue: "显示模型信息",
                    })}
                  </span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={geminiSnippetToggleStates.enableAgents}
                    onChange={(e) =>
                      handleGeminiSnippetToggle(
                        "enableAgents",
                        e.target.checked,
                      )
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>
                    {t("geminiConfig.enableAgents", {
                      defaultValue: "启用代理模式",
                    })}
                  </span>
                </label>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={claudeSnippetToggleStates.hideAttribution}
                    onChange={(e) =>
                      handleClaudeSnippetToggle(
                        "hideAttribution",
                        e.target.checked,
                      )
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>{t("claudeConfig.hideAttribution")}</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={claudeSnippetToggleStates.alwaysThinking}
                    onChange={(e) =>
                      handleClaudeSnippetToggle(
                        "alwaysThinking",
                        e.target.checked,
                      )
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>{t("claudeConfig.alwaysThinking")}</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={claudeSnippetToggleStates.teammates}
                    onChange={(e) =>
                      handleClaudeSnippetToggle("teammates", e.target.checked)
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>{t("claudeConfig.enableTeammates")}</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={claudeSnippetToggleStates.skipAllPermissions}
                    onChange={(e) =>
                      handleClaudeSnippetToggle(
                        "skipAllPermissions",
                        e.target.checked,
                      )
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>
                    {t("claudeConfig.skipAllPermissions", {
                      defaultValue: "跳过所有权限",
                    })}
                  </span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={claudeSnippetToggleStates.fastMode}
                    onChange={(e) =>
                      handleClaudeSnippetToggle("fastMode", e.target.checked)
                    }
                    className="w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2"
                  />
                  <span>
                    {t("claudeConfig.fastMode", {
                      defaultValue: "Fast 模式",
                    })}
                  </span>
                </label>
              </div>
            )}

            <JsonEditor
              value={commonConfigSnippet}
              onChange={(value) => {
                setCommonConfigSnippet(value);
                setCommonConfigError("");
              }}
              placeholder={
                appId === "codex"
                  ? `# Common Codex config\n\n# Add your common TOML configuration here`
                  : appId === "gemini"
                    ? `{\n  \"env\": {\n    \"GEMINI_MODEL\": \"gemini-3-pro-preview\"\n  },\n  \"config\": {\n    \"ui\": {\n      \"inlineThinkingMode\": \"full\"\n    }\n  }\n}`
                    : `{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://your-api-endpoint.com\"\n  }\n}`
              }
              darkMode={
                typeof document !== "undefined" &&
                document.documentElement.classList.contains("dark")
              }
              rows={16}
              showValidation={appId !== "codex"}
              language={appId === "codex" ? "javascript" : "json"}
            />

            {commonConfigError && (
              <p className="text-sm text-red-500 dark:text-red-400">
                {commonConfigError}
              </p>
            )}
          </div>
        </FullScreenPanel>
      )}

      <AnimatePresence>
        {showScrollTop && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="fixed bottom-6 right-6 z-50"
          >
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={handleScrollTop}
              title={t("common.backToTop", { defaultValue: "回到顶部" })}
              aria-label={t("common.backToTop", { defaultValue: "回到顶部" })}
              className="h-10 w-10 rounded-full shadow-lg"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface SortableProviderCardProps {
  provider: Provider;
  isCurrent: boolean;
  appId: AppId;
  density: ProviderDensity;
  sessionOccupancyCount: number;
  isInConfig: boolean;
  isOmo: boolean;
  isOmoSlim: boolean;
  dragDisabled?: boolean;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminalWithMode?: (
    provider: Provider,
    mode: TerminalTargetMode,
    path?: string,
  ) => void;
  recentTerminalTargets?: string[];
  onClearRecentTerminals?: () => void;
  onTest?: (provider: Provider) => void;
  isTesting: boolean;
  isProxyRunning: boolean;
  isProxyTakeover: boolean;
  viewMode?: ProviderViewMode;
  isAutoFailoverEnabled: boolean;
  failoverPriority?: number;
  isInFailoverQueue: boolean;
  onToggleFailover: (enabled: boolean) => void;
  activeProviderId?: string;
  // OpenClaw: default model
  isDefaultModel?: boolean;
  onSetAsDefault?: () => void;
}

function SortableProviderCard({
  provider,
  isCurrent,
  appId,
  density,
  sessionOccupancyCount,
  isInConfig,
  isOmo,
  isOmoSlim,
  dragDisabled = false,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminalWithMode,
  recentTerminalTargets,
  onClearRecentTerminals,
  onTest,
  isTesting,
  isProxyRunning,
  isProxyTakeover,
  viewMode,
  isAutoFailoverEnabled,
  failoverPriority,
  isInFailoverQueue,
  onToggleFailover,
  activeProviderId,
  isDefaultModel,
  onSetAsDefault,
}: SortableProviderCardProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.id, disabled: dragDisabled });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ProviderCard
        provider={provider}
        isCurrent={isCurrent}
        appId={appId}
        density={density}
        isInConfig={isInConfig}
        isOmo={isOmo}
        isOmoSlim={isOmoSlim}
        onSwitch={onSwitch}
        onEdit={onEdit}
        onDelete={onDelete}
        onRemoveFromConfig={onRemoveFromConfig}
        onDisableOmo={onDisableOmo}
        onDisableOmoSlim={onDisableOmoSlim}
        onDuplicate={onDuplicate}
        onConfigureUsage={
          onConfigureUsage ? (item) => onConfigureUsage(item) : () => undefined
        }
        onOpenWebsite={onOpenWebsite}
        onOpenTerminalWithMode={onOpenTerminalWithMode}
        recentTerminalTargets={recentTerminalTargets}
        onClearRecentTerminals={onClearRecentTerminals}
        onTest={onTest}
        isTesting={isTesting}
        isProxyRunning={isProxyRunning}
        isProxyTakeover={isProxyTakeover}
        viewMode={viewMode}
        dragHandleProps={
          dragDisabled
            ? undefined
            : {
                attributes,
                listeners,
                isDragging,
              }
        }
        isAutoFailoverEnabled={isAutoFailoverEnabled}
        failoverPriority={failoverPriority}
        isInFailoverQueue={isInFailoverQueue}
        onToggleFailover={onToggleFailover}
        activeProviderId={activeProviderId}
        sessionOccupancyCount={sessionOccupancyCount}
        // OpenClaw: default model
        isDefaultModel={isDefaultModel}
        onSetAsDefault={onSetAsDefault}
      />
    </div>
  );
}
