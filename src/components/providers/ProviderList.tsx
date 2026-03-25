import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Eye,
  FlaskConical,
  Loader2,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Terminal,
  Waypoints,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  Provider,
  TerminalTargetMode,
  TerminalTargetPreference,
} from "@/types";
import type { AppId } from "@/lib/api";
import { configApi, settingsApi } from "@/lib/api";
import type {
  AppConfigPreview,
  AppConfigPreviewFile,
  LiveConfigFileEntry,
} from "@/lib/api/config";
import { providersApi } from "@/lib/api/providers";
import { useDragSort } from "@/hooks/useDragSort";
import { useColumnResize } from "@/hooks/useColumnResize";
import { useSessionsQuery, useSettingsQuery } from "@/lib/query";
import {
  openclawKeys,
  useOpenClawLiveProviderIds,
  useOpenClawDefaultModel,
} from "@/hooks/useOpenClaw";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isWindows } from "@/lib/platform";
import { useStreamCheck } from "@/hooks/useStreamCheck";
import { ProviderActions } from "@/components/providers/ProviderActions";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";
import { ProviderHealthBadge } from "@/components/providers/ProviderHealthBadge";
import {
  useAutoFailoverEnabled,
  useFailoverQueue,
  useAddToFailoverQueue,
  useRemoveFromFailoverQueue,
  useProviderHealth,
} from "@/lib/query/failover";
import {
  useAppProxyConfig,
  useProviderSessionOccupancy,
  useReleaseProviderSessionBindings,
  useSessionProviderBindings,
  useUpdateAppProxyConfig,
} from "@/lib/query/proxy";
import {
  useCurrentOmoProviderId,
  useCurrentOmoSlimProviderId,
} from "@/lib/query/omo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
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
import TextCodeEditor from "@/components/TextCodeEditor";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getStreamCheckConfig,
  saveStreamCheckConfig,
  type StreamCheckConfig,
  type StreamCheckResult,
} from "@/lib/api/model-test";
import {
  extractCodexModelName,
  getDefaultJsonCommonConfigTemplate,
  normalizeJsonCommonConfigTemplateForEditing,
  normalizeCodexCommonConfigSnippetForEditing,
  parseJsonCommonConfigTemplate,
  setCodexModelName,
  validateCodexCommonConfigSnippet,
  validateJsonCommonConfigTemplate,
} from "@/utils/providerConfigUtils";
import {
  getFallbackProviderDefaultTemplate,
  getAllowedProviderTemplatePlaceholders,
  isSupportedProviderTemplateApp,
  validateProviderDefaultTemplate,
} from "@/utils/providerDefaultTemplateUtils";
import type { SessionRoutingStrategy } from "@/types/proxy";
import { formatSessionTitle, getBaseName } from "@/components/sessions/utils";
import {
  getDirtyPreviewFiles,
  getLiveConfigEditorMode,
  getLiveConfigTextSyntax,
  getPreviewDraftValue,
  isPreviewDraftDirty,
} from "./liveConfigPreviewUtils";

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

function buildLiveConfigSignature(files: LiveConfigFileEntry[]): string {
  return files
    .map((file) =>
      [
        file.label,
        file.path,
        file.exists ? "1" : "0",
        file.modifiedAt ?? "",
        file.sizeBytes ?? "",
      ].join(":"),
    )
    .join("|");
}

type TestModelKey = "claudeModel" | "codexModel" | "geminiModel";
type ProviderSortKey = "default" | "name" | "notes" | "model" | "status";
type SortDirection = "asc" | "desc";
type ProviderFilterField = "all" | "name" | "websiteUrl" | "notes" | "model";
type ProviderResizableColumnKey = "notes" | "model";
interface ProviderStatusMeta {
  sortValue: number;
  badges: Array<{
    label: string;
    className: string;
    description?: string;
  }>;
}

interface ProviderOccupancyDetail {
  sessionId: string;
  title: string;
  projectName: string;
}

interface BatchTestProgress {
  index: number;
  total: number;
  name: string;
}

interface BatchTestSessionState {
  isTesting: boolean;
  progress: BatchTestProgress | null;
  selections: Record<string, boolean>;
  results: Record<string, StreamCheckResult | null>;
}

interface SearchLocatorMatch {
  id: string;
  name: string;
  detail: string;
}

const PROVIDER_COLUMN_MIN_WIDTHS: Record<ProviderResizableColumnKey, number> = {
  notes: 150,
  model: 160,
};
const PROVIDER_STATUS_COLUMN_MIN_WIDTH = 180;
const getProviderActionsColumnWidth = (appId: AppId) =>
  appId === "openclaw" ? 360 : 328;
const batchTestSessionStore = new Map<AppId, BatchTestSessionState>();
const DEFAULT_STREAM_CHECK_PROMPTS = [
  "Who are you?",
  "What can you help me with?",
  "Explain what an API is in one sentence.",
  "Summarize the purpose of unit tests in one sentence.",
  "Reply with OK only.",
];
const DEFAULT_STREAM_CHECK_PROMPT = DEFAULT_STREAM_CHECK_PROMPTS.join("\n");

const normalizeTestPromptText = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

const getTestPromptOptions = (value: string): string[] => {
  const normalized = normalizeTestPromptText(value);
  if (normalized.length > 0) {
    return normalized.split("\n");
  }
  return DEFAULT_STREAM_CHECK_PROMPTS;
};

const getRandomTestPrompt = (value: string): string => {
  const prompts = getTestPromptOptions(value);
  const index = Math.floor(Math.random() * prompts.length);
  return prompts[index] ?? DEFAULT_STREAM_CHECK_PROMPT;
};

const getRandomPromptForProvider = (
  provider: Provider,
  globalPromptText: string,
): string => {
  const providerPrompt =
    provider.meta?.testConfig?.enabled === true
      ? provider.meta.testConfig.testPrompt?.trim()
      : "";

  return getRandomTestPrompt(
    providerPrompt && providerPrompt.length > 0
      ? (provider.meta?.testConfig?.testPrompt ?? globalPromptText)
      : globalPromptText,
  );
};

const createEmptyBatchTestSessionState = (): BatchTestSessionState => ({
  isTesting: false,
  progress: null,
  selections: {},
  results: {},
});

const syncBatchTestSessionWithProviders = (
  state: BatchTestSessionState,
  providers: Provider[],
): BatchTestSessionState => {
  const nextSelections: Record<string, boolean> = {};
  const nextResults: Record<string, StreamCheckResult | null> = {};
  const providerIdSet = new Set(providers.map((provider) => provider.id));

  for (const provider of providers) {
    nextSelections[provider.id] = state.selections[provider.id] ?? true;
  }

  for (const [providerId, result] of Object.entries(state.results)) {
    if (providerIdSet.has(providerId)) {
      nextResults[providerId] = result;
    }
  }

  return {
    ...state,
    selections: nextSelections,
    results: nextResults,
  };
};

const getBatchTestSessionState = (
  appId: AppId,
  providers: Provider[],
): BatchTestSessionState => {
  const current =
    batchTestSessionStore.get(appId) ?? createEmptyBatchTestSessionState();
  const synced = syncBatchTestSessionWithProviders(current, providers);
  batchTestSessionStore.set(appId, synced);
  return synced;
};

const setBatchTestSessionState = (
  appId: AppId,
  updater: (current: BatchTestSessionState) => BatchTestSessionState,
): BatchTestSessionState => {
  const current =
    batchTestSessionStore.get(appId) ?? createEmptyBatchTestSessionState();
  const next = updater(current);
  batchTestSessionStore.set(appId, next);
  return next;
};
const SESSION_ROUTING_STRATEGY_OPTIONS: Array<{
  value: SessionRoutingStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "priority",
    label: "列表顺序优先",
    description:
      "按照当前启用提供商列表顺序分配；自动故障转移开启时仅使用故障转移队列中的供应商。",
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
  isProxyTakeover = false,
  activeProviderId,
  onSetAsDefault,
}: ProviderListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settingsData } = useSettingsQuery();
  const { sortedProviders, sensors, handleDragEnd } = useDragSort(
    providers,
    appId,
  );

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
  const [providerDefaultTemplate, setProviderDefaultTemplate] = useState("");
  const [providerDefaultTemplateError, setProviderDefaultTemplateError] =
    useState("");
  const [isCommonConfigOpen, setIsCommonConfigOpen] = useState(false);
  const [configPreview, setConfigPreview] = useState<AppConfigPreview | null>(
    null,
  );
  const [isConfigPreviewOpen, setIsConfigPreviewOpen] = useState(false);
  const [, setLiveConfigFiles] = useState<LiveConfigFileEntry[]>([]);
  const [previewDrafts, setPreviewDrafts] = useState<Record<string, string>>(
    {},
  );
  const [isBatchTestOpen, setIsBatchTestOpen] = useState(false);
  const [isCommonConfigSaving, setIsCommonConfigSaving] = useState(false);
  const [isCommonConfigLoading, setIsCommonConfigLoading] = useState(false);
  const [isConfigPreviewLoading, setIsConfigPreviewLoading] = useState(false);
  const [, setIsLiveConfigFilesLoading] = useState(false);
  const [openingLiveConfigPath, setOpeningLiveConfigPath] = useState<
    string | null
  >(null);
  const [savingPreviewFilePath, setSavingPreviewFilePath] = useState<
    string | null
  >(null);
  const [isSavingAllPreviewFiles, setIsSavingAllPreviewFiles] = useState(false);
  const [hasLiveConfigChanged, setHasLiveConfigChanged] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const liveConfigSignatureRef = useRef<string | null>(null);
  const lastLiveConfigAppRef = useRef<AppId | null>(null);

  const getTerminalTargetKey = useCallback(
    (providerId?: string) =>
      providerId ? `${appId}:provider:${providerId}` : `${appId}:global`,
    [appId],
  );
  const { data: sessions = [] } = useSessionsQuery();

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

  const recentSessionProjectDirs = useMemo(
    () =>
      normalizeRecentPaths(
        [...sessions]
          .filter((session) => session.providerId === appId)
          .sort(
            (left, right) =>
              (right.lastActiveAt ?? right.createdAt ?? 0) -
              (left.lastActiveAt ?? left.createdAt ?? 0),
          )
          .map((session) => session.projectDir),
      ),
    [appId, normalizeRecentPaths, sessions],
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

  const buildRecentTerminalTargets = useCallback(
    (target?: TerminalTargetPreference) =>
      normalizeRecentPaths([
        ...recentSessionProjectDirs,
        target?.lastCwd ?? null,
        ...(target?.recentCwds ?? []),
      ]),
    [normalizeRecentPaths, recentSessionProjectDirs],
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

  const appTerminalTarget = useMemo(
    () => getTerminalTarget(),
    [getTerminalTarget],
  );
  const hasStoredRecentTerminalTargets = useCallback(
    (providerId?: string) => {
      const target = getTerminalTarget(providerId);
      return Boolean(
        target.lastCwd?.trim() || (target.recentCwds?.length ?? 0) > 0,
      );
    },
    [getTerminalTarget],
  );
  const appRecentTerminalTargets = useMemo(
    () => buildRecentTerminalTargets(appTerminalTarget),
    [appTerminalTarget, buildRecentTerminalTargets],
  );
  const hasAppRecentTargets = appRecentTerminalTargets.length > 0;
  const hasAppStoredRecentTargets = hasStoredRecentTerminalTargets();

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
    (providerId?: string) =>
      buildRecentTerminalTargets(getTerminalTarget(providerId)),
    [buildRecentTerminalTargets, getTerminalTarget],
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
          selectedPath ??
          getRecentTerminalTargets(provider.id)[0] ??
          target.lastCwd ??
          undefined;
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

  const canOpenProviderTerminal = Boolean(onOpenTerminal) && appId === "claude";
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
          selectedPath ??
          buildRecentTerminalTargets(target)[0] ??
          target.lastCwd ??
          undefined;
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
      await saveTerminalTarget(key, { recentCwds: [], lastCwd: undefined });
    },
    [getTerminalTargetKey, saveTerminalTarget],
  );

  const [streamConfig, setStreamConfig] = useState<StreamCheckConfig | null>(
    null,
  );
  const [testModel, setTestModel] = useState("");
  const [testPromptText, setTestPromptText] = useState(
    DEFAULT_STREAM_CHECK_PROMPT,
  );
  const [isSavingStreamConfig, setIsSavingStreamConfig] = useState(false);
  const [isBatchTesting, setIsBatchTesting] = useState(
    () => getBatchTestSessionState(appId, sortedProviders).isTesting,
  );
  const [batchProgress, setBatchProgress] = useState<BatchTestProgress | null>(
    () => getBatchTestSessionState(appId, sortedProviders).progress,
  );
  const [batchSelections, setBatchSelections] = useState<
    Record<string, boolean>
  >(() => getBatchTestSessionState(appId, sortedProviders).selections);
  const [batchResults, setBatchResults] = useState<
    Record<string, StreamCheckResult | null>
  >(() => getBatchTestSessionState(appId, sortedProviders).results);
  const [activeSearchMatchId, setActiveSearchMatchId] = useState<string | null>(
    null,
  );
  const isProviderListMountedRef = useRef(true);
  const providerRowRefs = useRef<Record<string, HTMLTableRowElement | null>>(
    {},
  );

  const modelKey = useMemo<TestModelKey | null>(() => {
    if (!enableStreamCheck) return null;
    if (appId === "claude") return "claudeModel";
    if (appId === "codex") return "codexModel";
    if (appId === "gemini") return "geminiModel";
    return null;
  }, [appId, enableStreamCheck]);

  useEffect(() => {
    return () => {
      isProviderListMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const next = getBatchTestSessionState(appId, sortedProviders);
    setIsBatchTesting(next.isTesting);
    setBatchProgress(next.progress);
    setBatchSelections(next.selections);
    setBatchResults(next.results);
  }, [appId, sortedProviders]);

  const syncBatchTestSession = useCallback(
    (updater: (current: BatchTestSessionState) => BatchTestSessionState) => {
      const next = setBatchTestSessionState(appId, updater);
      if (isProviderListMountedRef.current) {
        setIsBatchTesting(next.isTesting);
        setBatchProgress(next.progress);
        setBatchSelections(next.selections);
        setBatchResults(next.results);
      }
      return next;
    },
    [appId],
  );

  const setProviderRowRef = useCallback(
    (providerId: string, node: HTMLTableRowElement | null) => {
      if (node) {
        providerRowRefs.current[providerId] = node;
        return;
      }
      delete providerRowRefs.current[providerId];
    },
    [],
  );

  const scrollToProviderMatch = useCallback(
    (providerId: string, behavior: ScrollBehavior = "smooth") => {
      setActiveSearchMatchId(providerId);
      const row = providerRowRefs.current[providerId];
      if (!row) return;
      if (typeof row.scrollIntoView !== "function") return;
      row.scrollIntoView({
        block: "center",
        behavior,
      });
    },
    [],
  );

  useEffect(() => {
    if (!enableStreamCheck || !modelKey) return;
    let active = true;

    const loadStreamConfig = async () => {
      try {
        const config = await getStreamCheckConfig();
        if (!active) return;
        setStreamConfig(config);
        setTestModel(config[modelKey] || "");
        setTestPromptText(config.testPrompt || DEFAULT_STREAM_CHECK_PROMPT);
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

    const loadCommonConfigData = async () => {
      try {
        setIsCommonConfigLoading(true);
        setCommonConfigError("");
        setProviderDefaultTemplateError("");
        const snippet = await configApi.getCommonConfigSnippet(
          appId as "claude" | "codex" | "gemini",
        );
        if (!active) return;
        setCommonConfigSnippet(
          appId === "codex"
            ? normalizeCodexCommonConfigSnippetForEditing(snippet)
            : appId === "claude" || appId === "gemini"
              ? normalizeJsonCommonConfigTemplateForEditing(appId, snippet)
              : (snippet ?? ""),
        );

        if (isSupportedProviderTemplateApp(appId)) {
          const template = await configApi.getProviderDefaultTemplate(appId);
          if (!active) return;
          setProviderDefaultTemplate(
            template?.trim() || getFallbackProviderDefaultTemplate(appId),
          );
        }
      } catch (error) {
        console.error(
          "[ProviderList] Failed to load common config data",
          error,
        );
      } finally {
        if (active) {
          setIsCommonConfigLoading(false);
        }
      }
    };

    void loadCommonConfigData();
    return () => {
      active = false;
    };
  }, [appId, supportsCommonConfig]);

  const loadLiveConfigFiles = useCallback(
    async (options?: { resetSignature?: boolean }) => {
      try {
        setIsLiveConfigFilesLoading(true);
        const files = await configApi.getLiveConfigFiles(appId);
        setLiveConfigFiles(files);

        const nextSignature = buildLiveConfigSignature(files);
        const appChanged = lastLiveConfigAppRef.current !== appId;
        if (
          options?.resetSignature ||
          appChanged ||
          !liveConfigSignatureRef.current
        ) {
          liveConfigSignatureRef.current = nextSignature;
          lastLiveConfigAppRef.current = appId;
          setHasLiveConfigChanged(false);
        } else if (liveConfigSignatureRef.current !== nextSignature) {
          setHasLiveConfigChanged(true);
        }
      } catch (error) {
        console.error("[ProviderList] Failed to load live config files", error);
        setLiveConfigFiles([]);
      } finally {
        setIsLiveConfigFilesLoading(false);
      }
    },
    [appId],
  );

  const loadConfigPreview = useCallback(
    async (options?: { resetLiveSignature?: boolean }) => {
      try {
        setIsConfigPreviewLoading(true);
        const preview = await configApi.getCurrentLiveConfigSnapshot(appId);
        setConfigPreview(preview);
        setPreviewDrafts(
          Object.fromEntries(
            preview.files.map((file) => [file.path, file.actualText]),
          ),
        );
        if (options?.resetLiveSignature) {
          await loadLiveConfigFiles({ resetSignature: true });
        }
      } catch (error) {
        console.error("[ProviderList] Failed to load config preview", error);
        toast.error(
          t("provider.configPreviewLoadFailed", {
            defaultValue: "加载当前环境配置失败: {{error}}",
            error: String(error),
          }),
        );
      } finally {
        setIsConfigPreviewLoading(false);
      }
    },
    [appId, loadLiveConfigFiles, t],
  );

  useEffect(() => {
    if (!isConfigPreviewOpen) return;
    void loadConfigPreview({ resetLiveSignature: true });
  }, [isConfigPreviewOpen, loadConfigPreview]);

  useEffect(() => {
    void loadLiveConfigFiles({ resetSignature: true });

    const timer = window.setInterval(() => {
      void loadLiveConfigFiles();
    }, 10000);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadLiveConfigFiles]);

  const { checkProvider, isChecking } = useStreamCheck(appId);
  const handleTestProvider = useCallback(
    (provider: Provider) => {
      void checkProvider(provider.id, provider.name, {
        promptOverride: getRandomPromptForProvider(provider, testPromptText),
      });
    },
    [checkProvider, testPromptText],
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
  const failoverPriorityMap = useMemo(
    () =>
      new Map(
        (failoverQueue ?? []).map((item, index) => [
          item.providerId,
          index + 1,
        ]),
      ),
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
  const { data: sessionProviderBindings = [] } = useSessionProviderBindings(
    appId,
    appProxyConfig?.sessionIdleTtlMinutes,
  );
  const { data: providerSessionOccupancy = [] } = useProviderSessionOccupancy(
    appId,
    appProxyConfig?.sessionIdleTtlMinutes,
  );
  const releaseProviderSessionBindings = useReleaseProviderSessionBindings();
  const providerSessionCountMap = useMemo(() => {
    return new Map(
      providerSessionOccupancy.map((item) => [
        item.providerId,
        item.sessionCount,
      ]),
    );
  }, [providerSessionOccupancy]);
  const sessionMetaMap = useMemo(() => {
    return new Map(
      sessions
        .filter((session) => session.providerId === appId)
        .map((session) => [session.sessionId, session]),
    );
  }, [appId, sessions]);
  const providerSessionDetailsMap = useMemo(() => {
    const detailsMap = new Map<string, ProviderOccupancyDetail[]>();

    for (const binding of sessionProviderBindings) {
      if (!binding.isActive) continue;
      const session = sessionMetaMap.get(binding.sessionId);
      const detail: ProviderOccupancyDetail = {
        sessionId: binding.sessionId,
        title: session
          ? formatSessionTitle(session)
          : binding.sessionId.slice(0, 8),
        projectName: session ? getBaseName(session.projectDir) : "",
      };
      const current = detailsMap.get(binding.providerId) ?? [];
      current.push(detail);
      detailsMap.set(binding.providerId, current);
    }

    for (const details of detailsMap.values()) {
      details.sort((left, right) => left.title.localeCompare(right.title));
    }

    return detailsMap;
  }, [sessionMetaMap, sessionProviderBindings]);
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
    defaultProviderId: "",
    publicPriorityEnabled: false,
    maxSessionsPerProvider: "1",
    allowSharedWhenExhausted: false,
    idleTtlMinutes: "30",
  });

  const handleReleaseProviderOccupancy = useCallback(
    async (provider: Provider) => {
      try {
        const result = await releaseProviderSessionBindings.mutateAsync({
          appType: appId,
          providerId: provider.id,
          idleTtlMinutes: appProxyConfig?.sessionIdleTtlMinutes,
        });

        if (result.totalAffected === 0) {
          toast.info(
            t("provider.releaseOccupancyNoop", {
              defaultValue: "当前没有可释放的活跃会话占用",
            }),
          );
          return;
        }

        if (result.unboundCount > 0) {
          if (result.suggestIncreaseMaxSessions) {
            toast.warning(
              t("provider.releaseOccupancyPartialSuggestLimit", {
                defaultValue:
                  "已处理 {{total}} 个会话：{{rebound}} 个已重绑，{{unbound}} 个因无可用空闲供应商已解绑。当前每个供应商最大会话数为 {{limit}}，可考虑提高该值。",
                total: result.totalAffected,
                rebound: result.reboundCount,
                unbound: result.unboundCount,
                limit: appProxyConfig?.sessionMaxSessionsPerProvider ?? 1,
              }),
              {
                action: {
                  label: t("provider.openSessionRoutingSettings", {
                    defaultValue: "打开会话路由设置",
                  }),
                  onClick: () => setIsSessionRoutingDialogOpen(true),
                },
              },
            );
          } else {
            toast.warning(
              t("provider.releaseOccupancyPartial", {
                defaultValue:
                  "已处理 {{total}} 个会话：{{rebound}} 个已重绑，{{unbound}} 个因无可用供应商已解绑",
                total: result.totalAffected,
                rebound: result.reboundCount,
                unbound: result.unboundCount,
              }),
            );
          }
          return;
        }

        toast.success(
          t("provider.releaseOccupancySuccess", {
            defaultValue: "已释放占用并重绑 {{count}} 个会话",
            count: result.reboundCount,
          }),
        );
      } catch (error) {
        toast.error(
          t("provider.releaseOccupancyFailed", {
            defaultValue: "释放供应商占用失败",
          }) +
            ": " +
            String(error),
        );
      }
    },
    [
      appId,
      appProxyConfig?.sessionIdleTtlMinutes,
      appProxyConfig?.sessionMaxSessionsPerProvider,
      releaseProviderSessionBindings,
      t,
    ],
  );

  const sessionRoutingProviderOptions = useMemo(
    () =>
      Object.values(providers)
        .filter(
          (provider) =>
            isProviderInConfig(provider.id) &&
            (!isAutoFailoverActive || failoverQueueSet.has(provider.id)),
        )
        .sort((left, right) => {
          const leftSort = left.sortIndex ?? Number.MAX_SAFE_INTEGER;
          const rightSort = right.sortIndex ?? Number.MAX_SAFE_INTEGER;
          if (leftSort !== rightSort) {
            return leftSort - rightSort;
          }

          const leftCreatedAt = left.createdAt ?? Number.MAX_SAFE_INTEGER;
          const rightCreatedAt = right.createdAt ?? Number.MAX_SAFE_INTEGER;
          if (leftCreatedAt !== rightCreatedAt) {
            return leftCreatedAt - rightCreatedAt;
          }

          return left.name.localeCompare(right.name);
        }),
    [failoverQueueSet, isAutoFailoverActive, isProviderInConfig, providers],
  );
  const effectiveSessionDefaultProviderId = useMemo(() => {
    const explicitProviderId = appProxyConfig?.sessionDefaultProviderId?.trim();
    if (explicitProviderId) {
      if (!isAutoFailoverActive || failoverQueueSet.has(explicitProviderId)) {
        return explicitProviderId;
      }
      return failoverQueue?.[0]?.providerId ?? "";
    }
    if (!isAutoFailoverActive) {
      return currentProviderId;
    }
    if (currentProviderId && failoverQueueSet.has(currentProviderId)) {
      return currentProviderId;
    }
    return failoverQueue?.[0]?.providerId ?? "";
  }, [
    appProxyConfig?.sessionDefaultProviderId,
    currentProviderId,
    failoverQueue,
    failoverQueueSet,
    isAutoFailoverActive,
  ]);
  const currentProviderName = useMemo(() => {
    if (!currentProviderId) {
      return "";
    }
    return providers[currentProviderId]?.name ?? currentProviderId;
  }, [currentProviderId, providers]);

  useEffect(() => {
    if (!appProxyConfig) return;
    setSessionRoutingForm({
      enabled: appProxyConfig.sessionRoutingEnabled,
      strategy: appProxyConfig.sessionRoutingStrategy,
      defaultProviderId: appProxyConfig.sessionDefaultProviderId || "",
      publicPriorityEnabled:
        appProxyConfig.publicProviderPriorityEnabled === true,
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
      sessionRoutingForm.defaultProviderId !==
        (appProxyConfig.sessionDefaultProviderId || "") ||
      sessionRoutingForm.publicPriorityEnabled !==
        (appProxyConfig.publicProviderPriorityEnabled === true) ||
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
  const isSessionRoutingControlsDisabled =
    updateAppProxyConfig.isPending || !sessionRoutingForm.enabled;

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
        sessionDefaultProviderId: sessionRoutingForm.defaultProviderId,
        publicProviderPriorityEnabled: sessionRoutingForm.publicPriorityEnabled,
        sessionMaxSessionsPerProvider: maxSessions,
        sessionAllowSharedWhenExhausted:
          sessionRoutingForm.allowSharedWhenExhausted,
        sessionIdleTtlMinutes: idleTtl,
      },
      successMessage: t("proxy.sessionRouting.configSaved", {
        defaultValue: "会话路由配置已保存",
      }),
    });
    setIsSessionRoutingDialogOpen(false);
  }, [appProxyConfig, sessionRoutingForm, t, updateAppProxyConfig]);

  const handleTogglePublicPriority = useCallback(
    async (checked: boolean) => {
      if (!appProxyConfig) return;
      if (!appProxyConfig.sessionRoutingEnabled) return;

      await updateAppProxyConfig.mutateAsync({
        config: {
          ...appProxyConfig,
          publicProviderPriorityEnabled: checked,
        },
        successMessage: t("proxy.sessionRouting.publicPrioritySaved", {
          defaultValue: checked ? "公共优先已启用" : "公共优先已关闭",
        }),
      });
    },
    [appProxyConfig, t, updateAppProxyConfig],
  );

  const [filterField, setFilterField] = useState<ProviderFilterField>("all");
  const [filterKeyword, setFilterKeyword] = useState("");
  const [selectedModelFilters, setSelectedModelFilters] = useState<string[]>(
    [],
  );
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [sortState, setSortState] = useState<{
    key: ProviderSortKey;
    direction: SortDirection;
  }>({
    key: "default",
    direction: "asc",
  });
  const {
    widths: providerColumnWidths,
    startResize: startProviderColumnResize,
  } = useColumnResize<ProviderResizableColumnKey>({
    initialWidths: {
      notes: 190,
      model: 180,
    },
    minWidths: PROVIDER_COLUMN_MIN_WIDTHS,
  });
  const providerActionsColumnWidth = useMemo(
    () => getProviderActionsColumnWidth(appId),
    [appId],
  );
  const [selectedProviderIds, setSelectedProviderIds] = useState<
    Record<string, boolean>
  >({});
  const [isBatchModelDialogOpen, setIsBatchModelDialogOpen] = useState(false);
  const [isBatchDeleteDialogOpen, setIsBatchDeleteDialogOpen] = useState(false);
  const [batchCodexModel, setBatchCodexModel] = useState("");
  const [batchGeminiModel, setBatchGeminiModel] = useState("");
  const [batchClaudePrimaryModel, setBatchClaudePrimaryModel] = useState("");
  const [batchClaudeReasoningModel, setBatchClaudeReasoningModel] =
    useState("");
  const [isBatchUpdating, setIsBatchUpdating] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);

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

      const templateParsed = parseJsonCommonConfigTemplate("gemini", trimmed);
      if ("error" in templateParsed) {
        return {
          env: {},
          config: {},
          error: templateParsed.error,
        };
      }

      const parsedObj = templateParsed.result.commonConfig as Record<
        string,
        unknown
      >;
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

  const saveStreamCheckSettingsIfNeeded = useCallback(
    async (options?: { includeModel?: boolean; includePrompt?: boolean }) => {
      if (!streamConfig) return;

      const includeModel = options?.includeModel === true;
      const includePrompt = options?.includePrompt === true;
      const nextPrompt = normalizeTestPromptText(testPromptText);
      const promptToSave =
        nextPrompt.length > 0 ? nextPrompt : DEFAULT_STREAM_CHECK_PROMPT;
      let nextConfig = streamConfig;
      let shouldSave = false;

      if (includeModel && modelKey) {
        const nextModel = testModel.trim();
        if (streamConfig[modelKey] !== nextModel) {
          nextConfig = {
            ...nextConfig,
            [modelKey]: nextModel,
          };
          shouldSave = true;
        }
      }

      if (includePrompt && streamConfig.testPrompt !== promptToSave) {
        nextConfig = {
          ...nextConfig,
          testPrompt: promptToSave,
        };
        shouldSave = true;
      }

      if (!shouldSave) {
        if (includePrompt && testPromptText !== promptToSave) {
          setTestPromptText(promptToSave);
        }
        return;
      }

      try {
        setIsSavingStreamConfig(true);
        await saveStreamCheckConfig(nextConfig);
        setStreamConfig(nextConfig);
        if (includePrompt) {
          setTestPromptText(promptToSave);
        }
      } catch (error) {
        console.error(
          "[ProviderList] Failed to save stream check settings",
          error,
        );
        toast.error(
          t("streamCheck.configSaveFailed", {
            defaultValue: "测试配置保存失败",
          }),
        );
      } finally {
        setIsSavingStreamConfig(false);
      }
    },
    [streamConfig, modelKey, testModel, testPromptText, t],
  );

  const handleCloseBatchTest = useCallback(() => {
    void saveStreamCheckSettingsIfNeeded({
      includeModel: true,
      includePrompt: true,
    });
    setIsBatchTestOpen(false);
  }, [saveStreamCheckSettingsIfNeeded]);

  const handleBatchTest = useCallback(async () => {
    if (!enableStreamCheck || isBatchTesting) return;
    if (selectedBatchProviders.length === 0) return;

    await saveStreamCheckSettingsIfNeeded({
      includeModel: true,
      includePrompt: true,
    });

    const total = selectedBatchProviders.length;
    let operationalCount = 0;
    let degradedCount = 0;
    let failedCount = 0;

    syncBatchTestSession((current) => {
      const nextResults = { ...current.results };
      for (const provider of selectedBatchProviders) {
        delete nextResults[provider.id];
      }
      return {
        ...current,
        isTesting: true,
        progress: null,
        results: nextResults,
      };
    });
    try {
      for (let index = 0; index < selectedBatchProviders.length; index += 1) {
        const provider = selectedBatchProviders[index];
        syncBatchTestSession((current) => ({
          ...current,
          progress: {
            index: index + 1,
            total,
            name: provider.name,
          },
        }));
        const promptOverride = getRandomPromptForProvider(
          provider,
          testPromptText,
        );
        const result = await checkProvider(provider.id, provider.name, {
          silent: true,
          promptOverride,
        });
        if (!result || result.status === "failed") {
          failedCount += 1;
        } else if (result.status === "degraded") {
          degradedCount += 1;
        } else {
          operationalCount += 1;
        }
        syncBatchTestSession((current) => ({
          ...current,
          results: {
            ...current.results,
            [provider.id]: result,
          },
        }));
      }

      toast.success(
        t("streamCheck.batchCompleted", {
          count: total,
          defaultValue: "已完成批量测试（{{count}} 个供应商）",
        }),
        {
          closeButton: true,
          description: t("streamCheck.batchCompletedSummary", {
            operational: operationalCount,
            degraded: degradedCount,
            failed: failedCount,
            defaultValue:
              "正常 {{operational}} 个，降级 {{degraded}} 个，失败 {{failed}} 个",
          }),
        },
      );
    } finally {
      syncBatchTestSession((current) => ({
        ...current,
        isTesting: false,
        progress: null,
      }));
    }
  }, [
    checkProvider,
    enableStreamCheck,
    isBatchTesting,
    selectedBatchProviders,
    saveStreamCheckSettingsIfNeeded,
    syncBatchTestSession,
    testPromptText,
    t,
  ]);

  const handleToggleBatchSelection = useCallback(
    (providerId: string, checked: boolean) => {
      syncBatchTestSession((current) => ({
        ...current,
        selections: {
          ...current.selections,
          [providerId]: checked,
        },
      }));
    },
    [syncBatchTestSession],
  );

  const handleToggleAllBatchSelections = useCallback(
    (checked: boolean) => {
      const next: Record<string, boolean> = {};
      for (const provider of sortedProviders) {
        next[provider.id] = checked;
      }
      syncBatchTestSession((current) => ({
        ...current,
        selections: next,
      }));
    },
    [sortedProviders, syncBatchTestSession],
  );

  const handleSaveCommonConfig = useCallback(async () => {
    if (!supportsCommonConfig) return;

    let validationError = "";
    if (appId === "claude") {
      validationError = validateJsonCommonConfigTemplate(
        "claude",
        commonConfigSnippet,
        t("claudeConfig.commonConfigSnippet", {
          defaultValue: "应用配置模板",
        }),
      );
    } else if (appId === "codex") {
      validationError = validateCodexCommonConfigSnippet(commonConfigSnippet);
    } else if (appId === "gemini") {
      if (parsedGeminiSnippet.error) {
        validationError = parsedGeminiSnippet.error;
      }
    }

    if (validationError) {
      setCommonConfigError(validationError);
      return;
    }

    let templateValidationError = "";
    if (isSupportedProviderTemplateApp(appId)) {
      templateValidationError = validateProviderDefaultTemplate(
        appId,
        providerDefaultTemplate,
      );
    }
    if (templateValidationError) {
      setProviderDefaultTemplateError(templateValidationError);
      return;
    }

    try {
      setIsCommonConfigSaving(true);
      setCommonConfigError("");
      setProviderDefaultTemplateError("");
      await configApi.setCommonConfigSnippet(
        appId as "claude" | "codex" | "gemini",
        commonConfigSnippet.trim(),
      );
      if (isSupportedProviderTemplateApp(appId)) {
        await configApi.setProviderDefaultTemplate(
          appId,
          providerDefaultTemplate.trim(),
        );
      }
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
    providerDefaultTemplate,
    parsedGeminiSnippet,
    t,
  ]);

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
        setIsFilterPanelOpen(true);
        requestAnimationFrame(() => {
          filterInputRef.current?.focus();
          filterInputRef.current?.select();
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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

  const isAdditiveMode = appId === "opencode" || appId === "openclaw";

  const isCurrentProvider = useCallback(
    (provider: Provider): boolean => {
      if (provider.category === "omo") {
        return provider.id === (currentOmoId || "");
      }
      if (provider.category === "omo-slim") {
        return provider.id === (currentOmoSlimId || "");
      }
      return provider.id === currentProviderId;
    },
    [currentOmoId, currentOmoSlimId, currentProviderId],
  );

  const resolveProviderModelNames = useCallback(
    (provider: Provider): string[] => {
      const config = isPlainObject(provider.settingsConfig)
        ? (provider.settingsConfig as Record<string, unknown>)
        : {};

      if (appId === "codex") {
        const configText =
          typeof config.config === "string" ? config.config : "";
        const modelName = extractCodexModelName(configText);
        return modelName?.trim() ? [modelName.trim()] : [];
      }

      if (appId === "claude") {
        const env = isPlainObject(config.env)
          ? (config.env as Record<string, unknown>)
          : {};
        const primaryModel =
          typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL : "";
        if (primaryModel.trim()) {
          return [primaryModel.trim()];
        }
        const fallbackModelCandidates = [
          env.ANTHROPIC_REASONING_MODEL,
          env.ANTHROPIC_DEFAULT_SONNET_MODEL,
          env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        ];
        for (const candidate of fallbackModelCandidates) {
          if (typeof candidate === "string" && candidate.trim().length > 0) {
            return [candidate.trim()];
          }
        }
        return [];
      }

      if (appId === "gemini") {
        const env = isPlainObject(config.env)
          ? (config.env as Record<string, unknown>)
          : {};
        const model =
          typeof env.GEMINI_MODEL === "string" ? env.GEMINI_MODEL : "";
        return model.trim() ? [model.trim()] : [];
      }

      if (appId === "opencode") {
        const models = isPlainObject(config.models)
          ? (config.models as Record<string, unknown>)
          : null;
        return models
          ? Object.keys(models)
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          : [];
      }

      if (appId === "openclaw") {
        const models = Array.isArray(config.models)
          ? (config.models as Array<Record<string, unknown>>)
          : [];
        return Array.from(
          new Set(
            models
              .map((item) => {
                if (isPlainObject(item) && typeof item.id === "string") {
                  return item.id;
                }
                if (isPlainObject(item) && typeof item.name === "string") {
                  return item.name;
                }
                return "";
              })
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        );
      }

      return [];
    },
    [appId],
  );

  const resolveProviderModelSummary = useCallback(
    (provider: Provider): string => {
      const modelNames = resolveProviderModelNames(provider);
      if (modelNames.length === 0) {
        return "—";
      }
      return modelNames.join(", ");
    },
    [resolveProviderModelNames],
  );

  const resolveProviderStatus = useCallback(
    (provider: Provider): ProviderStatusMeta => {
      if (provider.category === "omo" || provider.category === "omo-slim") {
        const current = isCurrentProvider(provider);
        return current
          ? {
              sortValue: 3,
              badges: [
                {
                  label: t("provider.current", { defaultValue: "当前" }),
                  className:
                    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
                  description: t("provider.statusHint.current", {
                    defaultValue: "当前应用使用此供应商作为默认目标",
                  }),
                },
              ],
            }
          : {
              sortValue: 1,
              badges: [
                {
                  label: t("provider.disabled", { defaultValue: "未启用" }),
                  className: "bg-muted text-muted-foreground",
                  description: t("provider.statusHint.disabled", {
                    defaultValue: "该供应商未启用",
                  }),
                },
              ],
            };
      }

      if (appId === "openclaw") {
        if (isProviderDefaultModel(provider.id)) {
          return {
            sortValue: 4,
            badges: [
              {
                label: t("provider.isDefault", { defaultValue: "默认模型" }),
                className:
                  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
                description: t("provider.statusHint.defaultModel", {
                  defaultValue: "OpenClaw 默认主模型",
                }),
              },
            ],
          };
        }
        const inConfig = isProviderInConfig(provider.id);
        return inConfig
          ? {
              sortValue: 3,
              badges: [
                {
                  label: t("provider.inConfig", { defaultValue: "已加入配置" }),
                  className:
                    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
                  description: t("provider.statusHint.inConfig", {
                    defaultValue: "已写入应用配置，可被选择使用",
                  }),
                },
              ],
            }
          : {
              sortValue: 1,
              badges: [
                {
                  label: t("provider.notInConfig", {
                    defaultValue: "未加入配置",
                  }),
                  className: "bg-muted text-muted-foreground",
                  description: t("provider.statusHint.notInConfig", {
                    defaultValue: "未写入应用配置，当前不会被使用",
                  }),
                },
              ],
            };
      }

      if (appId === "opencode") {
        const inConfig = isProviderInConfig(provider.id);
        return inConfig
          ? {
              sortValue: 3,
              badges: [
                {
                  label: t("provider.inConfig", { defaultValue: "已加入配置" }),
                  className:
                    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
                  description: t("provider.statusHint.inConfig", {
                    defaultValue: "已写入应用配置，可被选择使用",
                  }),
                },
              ],
            }
          : {
              sortValue: 1,
              badges: [
                {
                  label: t("provider.notInConfig", {
                    defaultValue: "未加入配置",
                  }),
                  className: "bg-muted text-muted-foreground",
                  description: t("provider.statusHint.notInConfig", {
                    defaultValue: "未写入应用配置，当前不会被使用",
                  }),
                },
              ],
            };
      }

      const badges: ProviderStatusMeta["badges"] = [];
      let sortValue = 0;
      const sessionRoutingEnabled =
        appProxyConfig?.sessionRoutingEnabled === true;
      const followsCurrentSessionDefault =
        sessionRoutingEnabled &&
        !(appProxyConfig?.sessionDefaultProviderId?.trim().length ?? 0);

      if (
        !sessionRoutingEnabled &&
        isProxyTakeover &&
        activeProviderId === provider.id
      ) {
        badges.push({
          label: t("provider.activeTraffic", { defaultValue: "当前流量" }),
          className:
            "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
          description: t("provider.statusHint.activeTraffic", {
            defaultValue: "代理正在把当前流量转发到此供应商",
          }),
        });
        sortValue += 400;
      }

      if (!sessionRoutingEnabled && isCurrentProvider(provider)) {
        badges.push({
          label: t("provider.current", { defaultValue: "当前" }),
          className:
            "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
          description: t("provider.statusHint.current", {
            defaultValue: "当前应用使用此供应商作为默认目标",
          }),
        });
        sortValue += 200;
      }

      if (
        sessionRoutingEnabled &&
        effectiveSessionDefaultProviderId === provider.id
      ) {
        badges.push({
          label: followsCurrentSessionDefault
            ? t("provider.sessionDefaultFollowCurrentShort", {
                defaultValue: "无会话默认(跟随当前)",
              })
            : t("provider.sessionDefault", {
                defaultValue: "无会话默认",
              }),
          className:
            "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
          description: appProxyConfig.sessionDefaultProviderId
            ? t("provider.statusHint.sessionDefault", {
                defaultValue: "未携带会话 ID 的请求默认先使用此供应商",
              })
            : t("provider.statusHint.sessionDefaultFollowCurrent", {
                defaultValue:
                  "未携带会话 ID 的请求跟随当前供应商；当前指向此供应商",
              }),
        });
        sortValue += 120;
      }

      if (isAutoFailoverActive) {
        if (failoverPriorityMap.has(provider.id)) {
          sortValue += 80;
        }
      }

      return {
        sortValue,
        badges,
      };
    },
    [
      activeProviderId,
      appId,
      appProxyConfig?.sessionDefaultProviderId,
      appProxyConfig?.sessionRoutingEnabled,
      effectiveSessionDefaultProviderId,
      failoverPriorityMap,
      isAutoFailoverActive,
      isCurrentProvider,
      isProviderDefaultModel,
      isProviderInConfig,
      isProxyTakeover,
      t,
    ],
  );

  const availableModelFilters = useMemo(() => {
    const modelSet = new Set<string>();
    for (const provider of sortedProviders) {
      for (const modelName of resolveProviderModelNames(provider)) {
        modelSet.add(modelName);
      }
    }
    return Array.from(modelSet).sort((left, right) =>
      left.localeCompare(right),
    );
  }, [resolveProviderModelNames, sortedProviders]);

  useEffect(() => {
    setSelectedModelFilters((current) =>
      current.filter((value) => availableModelFilters.includes(value)),
    );
  }, [availableModelFilters]);

  const selectedModelFilterSet = useMemo(
    () => new Set(selectedModelFilters),
    [selectedModelFilters],
  );
  const selectedModelFilterPreview = useMemo(
    () => selectedModelFilters.slice(0, 3),
    [selectedModelFilters],
  );

  const buildProviderSearchFieldMap = useCallback(
    (
      provider: Provider,
    ): Record<Exclude<ProviderFilterField, "all">, string> => {
      const modelSummary = resolveProviderModelSummary(provider).toLowerCase();
      return {
        name: provider.name.toLowerCase(),
        websiteUrl: (provider.websiteUrl ?? "").toLowerCase(),
        notes: (provider.notes ?? "").toLowerCase(),
        model: modelSummary === "—" ? "" : modelSummary,
      };
    },
    [resolveProviderModelSummary],
  );

  const visibleProviders = useMemo(() => {
    return sortedProviders.filter((provider) => {
      if (selectedModelFilterSet.size === 0) {
        return true;
      }

      const modelNames = resolveProviderModelNames(provider);
      return modelNames.some((name) => selectedModelFilterSet.has(name));
    });
  }, [resolveProviderModelNames, selectedModelFilterSet, sortedProviders]);

  const sortedDisplayProviders = useMemo(() => {
    const directionFactor = sortState.direction === "asc" ? 1 : -1;
    const indexedProviders = visibleProviders.map((provider, index) => ({
      provider,
      index,
    }));

    const compareText = (left: string, right: string) =>
      left.localeCompare(right) * directionFactor;

    indexedProviders.sort((leftItem, rightItem) => {
      const left = leftItem.provider;
      const right = rightItem.provider;
      let comparison = 0;

      if (sortState.key === "default") {
        comparison = (leftItem.index - rightItem.index) * directionFactor;
      } else if (sortState.key === "name") {
        comparison = compareText(left.name, right.name);
      } else if (sortState.key === "notes") {
        comparison = compareText(left.notes ?? "", right.notes ?? "");
      } else if (sortState.key === "model") {
        comparison = compareText(
          resolveProviderModelSummary(left),
          resolveProviderModelSummary(right),
        );
      } else if (sortState.key === "status") {
        comparison =
          (resolveProviderStatus(left).sortValue -
            resolveProviderStatus(right).sortValue) *
          directionFactor;
      }

      if (comparison !== 0) {
        return comparison;
      }

      return leftItem.index - rightItem.index;
    });

    return indexedProviders.map((item) => item.provider);
  }, [
    visibleProviders,
    resolveProviderModelSummary,
    resolveProviderStatus,
    sortState.direction,
    sortState.key,
  ]);

  const searchMatches = useMemo<SearchLocatorMatch[]>(() => {
    const keyword = (filterKeyword ?? "").trim().toLowerCase();
    if (!keyword) {
      return [];
    }

    return sortedDisplayProviders
      .filter((provider) => {
        const fieldMap = buildProviderSearchFieldMap(provider);
        return filterField === "all"
          ? Object.values(fieldMap).some((value) => value.includes(keyword))
          : fieldMap[filterField].includes(keyword);
      })
      .map((provider) => {
        const detailMap: Record<Exclude<ProviderFilterField, "all">, string> = {
          name: provider.name,
          websiteUrl: provider.websiteUrl ?? "",
          notes: provider.notes ?? "",
          model:
            resolveProviderModelSummary(provider) === "—"
              ? ""
              : resolveProviderModelSummary(provider),
        };
        const detail =
          filterField === "all"
            ? [
                detailMap.name,
                detailMap.websiteUrl,
                detailMap.notes,
                detailMap.model,
              ]
                .filter(Boolean)
                .join(" / ")
            : detailMap[filterField];

        return {
          id: provider.id,
          name: provider.name,
          detail,
        };
      });
  }, [
    buildProviderSearchFieldMap,
    filterField,
    filterKeyword,
    resolveProviderModelSummary,
    sortedDisplayProviders,
  ]);

  const searchMatchIdSet = useMemo(
    () => new Set(searchMatches.map((match) => match.id)),
    [searchMatches],
  );

  useEffect(() => {
    const keyword = filterKeyword.trim();
    if (!keyword || searchMatches.length === 0) {
      setActiveSearchMatchId(null);
      return;
    }

    setActiveSearchMatchId((current) => {
      if (current && searchMatches.some((match) => match.id === current)) {
        return current;
      }
      return searchMatches[0]?.id ?? null;
    });
  }, [filterKeyword, searchMatches]);

  const isDragEnabled =
    sortState.key === "default" && sortState.direction === "asc";

  const displayedProviderIds = useMemo(
    () => sortedDisplayProviders.map((provider) => provider.id),
    [sortedDisplayProviders],
  );

  useEffect(() => {
    const validIds = new Set(sortedProviders.map((provider) => provider.id));
    setSelectedProviderIds((current) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const id of Object.keys(current)) {
        if (current[id] && validIds.has(id)) {
          next[id] = true;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sortedProviders]);

  const selectedProviders = useMemo(
    () =>
      sortedProviders.filter((provider) => selectedProviderIds[provider.id]),
    [selectedProviderIds, sortedProviders],
  );

  const selectedCount = selectedProviders.length;

  const allVisibleSelected =
    displayedProviderIds.length > 0 &&
    displayedProviderIds.every((id) => selectedProviderIds[id]);
  const someVisibleSelected =
    displayedProviderIds.some((id) => selectedProviderIds[id]) &&
    !allVisibleSelected;

  const toggleProviderSelection = useCallback(
    (providerId: string, checked: boolean) => {
      setSelectedProviderIds((current) => {
        const next = { ...current };
        if (checked) {
          next[providerId] = true;
        } else {
          delete next[providerId];
        }
        return next;
      });
    },
    [],
  );

  const toggleSelectAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedProviderIds((current) => {
        const next = { ...current };
        for (const providerId of displayedProviderIds) {
          if (checked) {
            next[providerId] = true;
          } else {
            delete next[providerId];
          }
        }
        return next;
      });
    },
    [displayedProviderIds],
  );

  const clearSelection = useCallback(() => {
    setSelectedProviderIds({});
  }, []);

  const handleMoveProviderToTop = useCallback(
    async (providerId: string) => {
      const currentIndex = sortedProviders.findIndex(
        (provider) => provider.id === providerId,
      );
      if (currentIndex <= 0) return;

      const reordered = [
        sortedProviders[currentIndex],
        ...sortedProviders.filter((provider) => provider.id !== providerId),
      ];
      const updates = reordered.map((provider, index) => ({
        id: provider.id,
        sortIndex: index,
      }));

      try {
        await providersApi.updateSortOrder(updates, appId);
        await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
        await queryClient.invalidateQueries({
          queryKey: ["failoverQueue", appId],
        });
        try {
          await providersApi.updateTrayMenu();
        } catch (error) {
          console.error("[ProviderList] Failed to update tray menu", error);
        }
        toast.success(
          t("provider.moveToTopSuccess", {
            defaultValue: "供应商已置顶",
          }),
        );
      } catch (error) {
        console.error("[ProviderList] Failed to move provider to top", error);
        toast.error(
          t("provider.moveToTopFailed", {
            defaultValue: "置顶失败",
          }),
        );
      }
    },
    [appId, queryClient, sortedProviders, t],
  );

  const canDeleteProvider = useCallback(
    (provider: Provider): boolean => {
      const isOmoCategory =
        provider.category === "omo" || provider.category === "omo-slim";
      if (isAdditiveMode || isOmoCategory) return true;
      if (!isCurrentProvider(provider)) return true;
      return sortedProviders.some((candidate) => candidate.id !== provider.id);
    },
    [isAdditiveMode, isCurrentProvider, sortedProviders],
  );

  const deletableSelectedProviders = useMemo(
    () => selectedProviders.filter((provider) => canDeleteProvider(provider)),
    [canDeleteProvider, selectedProviders],
  );

  const supportsBatchModelEdit =
    appId === "claude" || appId === "codex" || appId === "gemini";

  const modelFieldLabel = useMemo(() => {
    if (appId === "claude") {
      return t("provider.primaryModel", { defaultValue: "主模型" });
    }
    if (appId === "codex" || appId === "gemini") {
      return t("provider.model", { defaultValue: "模型名称" });
    }
    return t("provider.model", { defaultValue: "模型" });
  }, [appId, t]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (selectedModelFilters.length > 0) count += 1;
    return count;
  }, [selectedModelFilters]);

  const modelFilterLabel =
    selectedModelFilters.length > 0
      ? t("provider.modelFilterLabelSelected", {
          defaultValue: "{{field}} ({{count}})",
          field: modelFieldLabel,
          count: selectedModelFilters.length,
        })
      : t("provider.modelFilterLabelIdle", {
          field: modelFieldLabel,
          defaultValue: "按{{field}}筛选",
        });

  const filterToggleLabel = isFilterPanelOpen
    ? t("provider.hideFilters", { defaultValue: "收起筛选" })
    : t("provider.showFilters", { defaultValue: "展开筛选" });

  const handleSortChange = useCallback((key: ProviderSortKey) => {
    setSortState((current) => {
      if (current.key === key) {
        return {
          key,
          direction: current.direction === "asc" ? "desc" : "asc",
        };
      }
      return { key, direction: "asc" };
    });
  }, []);

  const getSortIcon = useCallback(
    (key: ProviderSortKey) => {
      if (sortState.key !== key) {
        return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/70" />;
      }
      return sortState.direction === "asc" ? (
        <ArrowUp className="h-3.5 w-3.5 text-foreground" />
      ) : (
        <ArrowDown className="h-3.5 w-3.5 text-foreground" />
      );
    },
    [sortState.direction, sortState.key],
  );

  const renderProviderColumnResizeHandle = useCallback(
    (columnKey: ProviderResizableColumnKey) => (
      <span
        role="separator"
        aria-orientation="vertical"
        className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none touch-none"
        onMouseDown={(event) => startProviderColumnResize(columnKey, event)}
        onClick={(event) => event.stopPropagation()}
      />
    ),
    [startProviderColumnResize],
  );

  const handleApplyBatchModelUpdate = useCallback(async () => {
    if (!supportsBatchModelEdit || selectedProviders.length === 0) return;

    const codexModel = batchCodexModel.trim();
    const geminiModel = batchGeminiModel.trim();
    const claudePrimaryModel = batchClaudePrimaryModel.trim();
    const claudeReasoningModel = batchClaudeReasoningModel.trim();

    if (appId === "codex" && !codexModel) {
      toast.error(
        t("provider.batchModelRequired", {
          defaultValue: "请填写模型名称",
        }),
      );
      return;
    }

    if (appId === "gemini" && !geminiModel) {
      toast.error(
        t("provider.batchModelRequired", {
          defaultValue: "请填写模型名称",
        }),
      );
      return;
    }

    if (appId === "claude" && !claudePrimaryModel && !claudeReasoningModel) {
      toast.error(
        t("provider.batchClaudeModelRequired", {
          defaultValue: "请至少填写主模型或推理模型",
        }),
      );
      return;
    }

    setIsBatchUpdating(true);
    const failed: Array<{ name: string; reason: string }> = [];
    let updatedCount = 0;

    try {
      for (const provider of selectedProviders) {
        try {
          const config = isPlainObject(provider.settingsConfig)
            ? ({ ...provider.settingsConfig } as Record<string, unknown>)
            : {};
          let nextSettingsConfig = config;

          if (appId === "codex") {
            const configText =
              typeof config.config === "string" ? config.config : "";
            nextSettingsConfig = {
              ...config,
              config: setCodexModelName(configText, codexModel),
            };
          } else if (appId === "gemini") {
            const env = isPlainObject(config.env)
              ? ({ ...config.env } as Record<string, unknown>)
              : {};
            nextSettingsConfig = {
              ...config,
              env: {
                ...env,
                GEMINI_MODEL: geminiModel,
              },
            };
          } else if (appId === "claude") {
            const env = isPlainObject(config.env)
              ? ({ ...config.env } as Record<string, unknown>)
              : {};
            const nextEnv: Record<string, unknown> = { ...env };
            if (claudePrimaryModel) {
              nextEnv.ANTHROPIC_MODEL = claudePrimaryModel;
            }
            if (claudeReasoningModel) {
              nextEnv.ANTHROPIC_REASONING_MODEL = claudeReasoningModel;
            }
            nextSettingsConfig = {
              ...config,
              env: nextEnv,
            };
          }

          const updatedProvider: Provider = {
            ...provider,
            settingsConfig: nextSettingsConfig as Record<string, any>,
          };
          await providersApi.update(updatedProvider, appId);
          updatedCount += 1;
        } catch (error) {
          failed.push({
            name: provider.name,
            reason:
              error instanceof Error
                ? error.message
                : t("common.unknownError", { defaultValue: "未知错误" }),
          });
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      try {
        await providersApi.updateTrayMenu();
      } catch (trayError) {
        console.error(
          "[ProviderList] Failed to update tray menu after batch model update",
          trayError,
        );
      }

      if (updatedCount > 0) {
        toast.success(
          t("provider.batchModelUpdateSuccess", {
            defaultValue: "已批量更新 {{count}} 个提供商",
            count: updatedCount,
          }),
        );
        setIsBatchModelDialogOpen(false);
      }

      if (failed.length > 0) {
        toast.error(
          t("provider.batchModelUpdatePartialFailed", {
            defaultValue: "部分提供商更新失败（{{count}} 个）",
            count: failed.length,
          }),
          {
            description: `${failed[0]?.name ?? ""}: ${failed[0]?.reason ?? ""}`,
          },
        );
      }
    } finally {
      setIsBatchUpdating(false);
    }
  }, [
    appId,
    batchClaudePrimaryModel,
    batchClaudeReasoningModel,
    batchCodexModel,
    batchGeminiModel,
    queryClient,
    selectedProviders,
    supportsBatchModelEdit,
    t,
  ]);

  const handleOpenLiveConfigFile = useCallback(
    async (file: LiveConfigFileEntry) => {
      try {
        setOpeningLiveConfigPath(file.path);
        await configApi.openLiveConfigFile(file.path);
      } catch (error) {
        console.error("[ProviderList] Failed to open live config file", error);
        toast.error(
          t("provider.openLiveConfigFailed", {
            defaultValue: "打开实际配置文件失败: {{error}}",
            error: String(error),
          }),
        );
      } finally {
        setOpeningLiveConfigPath((current) =>
          current === file.path ? null : current,
        );
      }
    },
    [t],
  );

  const handlePreviewDraftChange = useCallback(
    (path: string, value: string) => {
      setPreviewDrafts((current) => ({
        ...current,
        [path]: value,
      }));
    },
    [],
  );

  const handleResetPreviewDraft = useCallback((file: AppConfigPreviewFile) => {
    setPreviewDrafts((current) => ({
      ...current,
      [file.path]: file.actualText,
    }));
  }, []);

  const handleSavePreviewFile = useCallback(
    async (file: AppConfigPreviewFile) => {
      try {
        setSavingPreviewFilePath(file.path);
        const nextContent = getPreviewDraftValue(file, previewDrafts);
        await configApi.saveLiveConfigFile(appId, file.label, nextContent);
        await loadConfigPreview({ resetLiveSignature: true });
        await queryClient.invalidateQueries({ queryKey: ["providers"] });
        toast.success(
          t("provider.saveLiveConfigSuccess", {
            defaultValue: "live 配置文件已保存",
          }),
        );
      } catch (error) {
        console.error("[ProviderList] Failed to save live config file", error);
        toast.error(
          t("provider.saveLiveConfigFailed", {
            defaultValue: "保存 live 配置文件失败: {{error}}",
            error: String(error),
          }),
        );
      } finally {
        setSavingPreviewFilePath((current) =>
          current === file.path ? null : current,
        );
      }
    },
    [
      appId,
      loadConfigPreview,
      loadLiveConfigFiles,
      previewDrafts,
      queryClient,
      t,
    ],
  );

  const dirtyPreviewFiles = useMemo(
    () => getDirtyPreviewFiles(configPreview?.files ?? [], previewDrafts),
    [configPreview?.files, previewDrafts],
  );

  const handleSaveAllPreviewFiles = useCallback(async () => {
    if (!configPreview) return;

    const filesToSave = getDirtyPreviewFiles(
      configPreview.files,
      previewDrafts,
    );
    if (filesToSave.length === 0) {
      return;
    }

    try {
      setIsSavingAllPreviewFiles(true);
      for (const file of filesToSave) {
        await configApi.saveLiveConfigFile(
          appId,
          file.label,
          getPreviewDraftValue(file, previewDrafts),
        );
      }
      await loadConfigPreview({ resetLiveSignature: true });
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast.success(
        t("provider.saveAllLiveConfigSuccess", {
          defaultValue: "已保存 {{count}} 个 live 配置文件",
          count: filesToSave.length,
        }),
      );
    } catch (error) {
      console.error(
        "[ProviderList] Failed to save all live config files",
        error,
      );
      toast.error(
        t("provider.saveAllLiveConfigFailed", {
          defaultValue: "批量保存 live 配置文件失败: {{error}}",
          error: String(error),
        }),
      );
    } finally {
      setIsSavingAllPreviewFiles(false);
    }
  }, [
    appId,
    configPreview,
    loadConfigPreview,
    loadLiveConfigFiles,
    previewDrafts,
    queryClient,
    t,
  ]);

  const handleBatchDelete = useCallback(async () => {
    if (deletableSelectedProviders.length === 0) {
      toast.error(
        t("provider.batchDeleteNone", {
          defaultValue: "当前选中项不可删除",
        }),
      );
      return;
    }

    setIsBatchDeleting(true);
    const failed: Array<{ name: string; reason: string }> = [];
    let deletedCount = 0;

    try {
      for (const provider of deletableSelectedProviders) {
        try {
          await providersApi.delete(provider.id, appId);
          deletedCount += 1;
        } catch (error) {
          failed.push({
            name: provider.name,
            reason:
              error instanceof Error
                ? error.message
                : t("common.unknownError", { defaultValue: "未知错误" }),
          });
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      await queryClient.invalidateQueries({
        queryKey: ["failoverQueue", appId],
      });
      if (appId === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["opencodeLiveProviderIds"],
        });
      }
      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.liveProviderIds,
        });
      }

      if (deletedCount > 0) {
        toast.success(
          t("provider.batchDeleteSuccess", {
            defaultValue: "已删除 {{count}} 个提供商",
            count: deletedCount,
          }),
        );
      }

      if (failed.length > 0) {
        toast.error(
          t("provider.batchDeletePartialFailed", {
            defaultValue: "部分提供商删除失败（{{count}} 个）",
            count: failed.length,
          }),
          {
            description: `${failed[0]?.name ?? ""}: ${failed[0]?.reason ?? ""}`,
          },
        );
      }

      setSelectedProviderIds((current) => {
        const next = { ...current };
        for (const provider of deletableSelectedProviders) {
          delete next[provider.id];
        }
        return next;
      });
      setIsBatchDeleteDialogOpen(false);
    } finally {
      setIsBatchDeleting(false);
    }
  }, [appId, deletableSelectedProviders, queryClient, t]);

  const renderProviderTable = () => (
    <DndContext
      sensors={isDragEnabled ? sensors : undefined}
      collisionDetection={closestCenter}
      onDragEnd={(event) => {
        if (!isDragEnabled) return;
        void handleDragEnd(event);
      }}
    >
      <SortableContext
        items={sortedDisplayProviders.map((provider) => provider.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="rounded-xl border border-border/70 overflow-hidden">
          <div className="overflow-auto">
            <table
              className="w-full text-sm"
              style={{
                minWidth:
                  48 +
                  40 +
                  300 +
                  providerColumnWidths.notes +
                  providerColumnWidths.model +
                  PROVIDER_STATUS_COLUMN_MIN_WIDTH +
                  providerActionsColumnWidth,
              }}
            >
              <colgroup>
                <col style={{ width: 48, minWidth: 48 }} />
                <col style={{ width: 40, minWidth: 40 }} />
                <col style={{ width: 300, minWidth: 240 }} />
                <col
                  style={{
                    width: providerColumnWidths.notes,
                    minWidth: PROVIDER_COLUMN_MIN_WIDTHS.notes,
                  }}
                />
                <col
                  style={{
                    width: providerColumnWidths.model,
                    minWidth: PROVIDER_COLUMN_MIN_WIDTHS.model,
                  }}
                />
                <col
                  style={{
                    minWidth: PROVIDER_STATUS_COLUMN_MIN_WIDTH,
                  }}
                />
                <col
                  style={{
                    width: providerActionsColumnWidth,
                    minWidth: providerActionsColumnWidth,
                    maxWidth: providerActionsColumnWidth,
                  }}
                />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border/70">
                  <th className="sticky left-0 z-30 w-12 bg-background px-3 py-2 text-left align-middle">
                    <div className="flex items-center justify-center">
                      <Checkbox
                        checked={
                          allVisibleSelected
                            ? true
                            : someVisibleSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(checked) =>
                          toggleSelectAllVisible(checked === true)
                        }
                        aria-label={t("common.selectAll", {
                          defaultValue: "全选当前筛选结果",
                        })}
                      />
                    </div>
                  </th>
                  <th className="sticky left-[48px] z-30 w-10 bg-background px-2 py-2 text-left align-middle" />
                  <th className="sticky left-[88px] z-30 bg-background px-3 py-2 text-left align-middle">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 text-sm font-medium"
                      onClick={() => handleSortChange("name")}
                    >
                      {t("provider.providerName", { defaultValue: "提供商" })}
                      {getSortIcon("name")}
                    </button>
                  </th>
                  <th
                    className="relative px-3 py-2 text-left"
                    style={{
                      width: providerColumnWidths.notes,
                      minWidth: PROVIDER_COLUMN_MIN_WIDTHS.notes,
                    }}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 text-sm font-medium"
                      onClick={() => handleSortChange("notes")}
                    >
                      {t("provider.notes", { defaultValue: "备注" })}
                      {getSortIcon("notes")}
                    </button>
                    {renderProviderColumnResizeHandle("notes")}
                  </th>
                  <th
                    className="relative px-3 py-2 text-left"
                    style={{
                      width: providerColumnWidths.model,
                      minWidth: PROVIDER_COLUMN_MIN_WIDTHS.model,
                    }}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 text-sm font-medium"
                      onClick={() => handleSortChange("model")}
                    >
                      {t("provider.model", { defaultValue: "模型" })}
                      {getSortIcon("model")}
                    </button>
                    {renderProviderColumnResizeHandle("model")}
                  </th>
                  <th
                    className="relative px-3 py-2 text-left"
                    style={{
                      minWidth: PROVIDER_STATUS_COLUMN_MIN_WIDTH,
                    }}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 text-sm font-medium"
                      onClick={() => handleSortChange("status")}
                    >
                      {t("provider.status", { defaultValue: "状态" })}
                      {getSortIcon("status")}
                    </button>
                  </th>
                  <th
                    className="relative sticky right-0 z-30 bg-background px-3 py-2 text-left"
                    style={{
                      width: providerActionsColumnWidth,
                      minWidth: providerActionsColumnWidth,
                      maxWidth: providerActionsColumnWidth,
                    }}
                  >
                    {t("common.actions", { defaultValue: "操作" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedDisplayProviders.map((provider, index) => (
                  <SortableProviderTableRow
                    key={provider.id}
                    provider={provider}
                    rowIndex={index}
                    showOrderNumber={sortState.key === "default"}
                    columnWidths={providerColumnWidths}
                    actionsColumnWidth={providerActionsColumnWidth}
                    dragEnabled={isDragEnabled}
                    isSelected={Boolean(selectedProviderIds[provider.id])}
                    onToggleSelected={toggleProviderSelection}
                    modelSummary={resolveProviderModelSummary(provider)}
                    statusMeta={resolveProviderStatus(provider)}
                    sessionCount={providerSessionCountMap.get(provider.id) ?? 0}
                    occupancyDetails={
                      providerSessionDetailsMap.get(provider.id) ?? []
                    }
                    showSessionOccupancy={Boolean(
                      appProxyConfig?.sessionRoutingEnabled,
                    )}
                    onReleaseSessionOccupancy={
                      appProxyConfig?.sessionRoutingEnabled
                        ? () => void handleReleaseProviderOccupancy(provider)
                        : undefined
                    }
                    isReleasingSessionOccupancy={
                      releaseProviderSessionBindings.isPending &&
                      releaseProviderSessionBindings.variables?.providerId ===
                        provider.id
                    }
                    isCurrent={isCurrentProvider(provider)}
                    canDelete={canDeleteProvider(provider)}
                    isInConfig={isProviderInConfig(provider.id)}
                    isOmo={provider.category === "omo"}
                    isOmoSlim={provider.category === "omo-slim"}
                    appId={appId}
                    onSwitch={onSwitch}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onRemoveFromConfig={onRemoveFromConfig}
                    onDisableOmo={onDisableOmo}
                    onDisableOmoSlim={onDisableOmoSlim}
                    onDuplicate={onDuplicate}
                    onMoveToTop={() => handleMoveProviderToTop(provider.id)}
                    onConfigureUsage={onConfigureUsage}
                    onOpenWebsite={onOpenWebsite}
                    onOpenTerminalWithMode={providerTerminalHandler}
                    recentTerminalTargets={getRecentTerminalTargets(
                      provider.id,
                    )}
                    onClearRecentTerminals={
                      hasStoredRecentTerminalTargets(provider.id)
                        ? () => void handleClearRecentTerminals(provider.id)
                        : undefined
                    }
                    onTest={enableStreamCheck ? handleTestProvider : undefined}
                    isTesting={
                      enableStreamCheck ? isChecking(provider.id) : false
                    }
                    rowRef={(node) => setProviderRowRef(provider.id, node)}
                    isSearchMatched={searchMatchIdSet.has(provider.id)}
                    isActiveSearchMatch={activeSearchMatchId === provider.id}
                    isProxyTakeover={isProxyTakeover}
                    isAutoFailoverEnabled={isAutoFailoverActive}
                    isInFailoverQueue={isInFailoverQueue(provider.id)}
                    onToggleFailover={(enabled) =>
                      handleToggleFailover(provider.id, enabled)
                    }
                    isDefaultModel={isProviderDefaultModel(provider.id)}
                    onSetAsDefault={
                      onSetAsDefault
                        ? () => onSetAsDefault(provider)
                        : undefined
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </SortableContext>
    </DndContext>
  );

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

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      <div className="-mx-1 border-b border-border/60 bg-background/95 px-1 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {supportsCommonConfig && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setIsCommonConfigOpen(true)}
                disabled={isCommonConfigLoading}
                className="gap-2"
              >
                {isCommonConfigLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SlidersHorizontal className="h-4 w-4" />
                )}
                {t("provider.commonConfigApplyAll", {
                  defaultValue: "应用配置模板",
                })}
              </Button>
            )}

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setIsConfigPreviewOpen(true)}
              disabled={isConfigPreviewLoading}
              className={cn(
                "gap-2",
                hasLiveConfigChanged &&
                  "border-amber-500/50 text-amber-600 dark:text-amber-400",
              )}
            >
              {isConfigPreviewLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              {t("provider.configPreview", {
                defaultValue: "当前环境配置",
              })}
            </Button>

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
              <div className="flex items-center gap-2 rounded-lg border border-border px-2 py-1">
                <Switch
                  checked={
                    appProxyConfig.publicProviderPriorityEnabled === true
                  }
                  onCheckedChange={(checked) =>
                    void handleTogglePublicPriority(checked)
                  }
                  disabled={
                    updateAppProxyConfig.isPending ||
                    !appProxyConfig.sessionRoutingEnabled
                  }
                  aria-label={t("proxy.sessionRouting.publicPriority", {
                    defaultValue: "公共优先",
                  })}
                />
                <div className="flex items-center gap-1 text-xs">
                  <span className="font-medium">
                    {t("proxy.sessionRouting.publicPriority", {
                      defaultValue: "公共优先",
                    })}
                  </span>
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
                <Waypoints className="h-3.5 w-3.5" />
                {t("proxy.sessionRouting.title", {
                  defaultValue: "会话路由",
                })}
                {appProxyConfig.sessionRoutingEnabled && (
                  <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    {t("proxy.sessionRouting.enabledBadge", {
                      defaultValue: "已启用",
                    })}
                  </span>
                )}
              </Button>
            )}

            {enableStreamCheck && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setIsBatchTestOpen(true)}
                disabled={sortedProviders.length === 0}
                className="gap-2"
                title={t("streamCheck.testAll", { defaultValue: "批量测试" })}
              >
                <FlaskConical className="h-4 w-4" />
                {t("streamCheck.testAll", { defaultValue: "批量测试" })}
              </Button>
            )}

            {onOpenAppTerminal && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                  >
                    <Terminal className="h-4 w-4" />
                    {t("provider.openTerminalGlobal", {
                      defaultValue: "打开终端",
                    })}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[220px]">
                  <DropdownMenuItem
                    onSelect={() =>
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
                            onSelect={() =>
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
                      {hasAppStoredRecentTargets && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => void handleClearRecentTerminals()}
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
            {selectedCount > 0 && (
              <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                {t("common.selectedCount", {
                  defaultValue: "已选 {{count}} 项",
                  count: selectedCount,
                })}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setIsBatchModelDialogOpen(true)}
              disabled={!supportsBatchModelEdit || selectedCount === 0}
            >
              {t("provider.batchUpdateModel", { defaultValue: "批量修改模型" })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800/80 dark:text-rose-300 dark:hover:bg-rose-900/20"
              onClick={() => setIsBatchDeleteDialogOpen(true)}
              disabled={selectedCount === 0}
            >
              {t("provider.batchDelete", { defaultValue: "批量删除" })}
            </Button>
            {selectedCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={clearSelection}
              >
                {t("common.clearSelection", { defaultValue: "清空选择" })}
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              variant={isFilterPanelOpen ? "default" : "outline"}
              className="h-8 w-8"
              onClick={() => setIsFilterPanelOpen((current) => !current)}
              aria-label={filterToggleLabel}
              title={filterToggleLabel}
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
            {activeFilterCount > 0 && (
              <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                {t("provider.activeFilters", {
                  defaultValue: "筛选 {{count}}",
                  count: activeFilterCount,
                })}
              </span>
            )}
          </div>
        </div>

        {isFilterPanelOpen && (
          <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
            <div className="w-[190px] space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("provider.filterField", { defaultValue: "筛选字段" })}
              </Label>
              <select
                value={filterField}
                onChange={(event) =>
                  setFilterField(event.target.value as ProviderFilterField)
                }
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="all">
                  {t("provider.filterAll", { defaultValue: "全部字段" })}
                </option>
                <option value="name">
                  {t("provider.filterByName", { defaultValue: "供应商名称" })}
                </option>
                <option value="websiteUrl">
                  {t("provider.filterByWebsite", { defaultValue: "官网链接" })}
                </option>
                <option value="notes">
                  {t("provider.filterByNotes", { defaultValue: "备注" })}
                </option>
                <option value="model">{modelFieldLabel}</option>
              </select>
            </div>

            <div className="relative min-w-[220px] flex-1 space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("provider.fuzzyFilter", { defaultValue: "模糊筛选" })}
              </Label>
              <Search className="pointer-events-none absolute left-2.5 top-[30px] h-3.5 w-3.5 text-muted-foreground" />
              <Input
                ref={filterInputRef}
                data-testid="provider-filter-keyword-input"
                value={filterKeyword}
                onChange={(event) => setFilterKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const targetId = activeSearchMatchId ?? searchMatches[0]?.id;
                  if (!targetId) return;
                  event.preventDefault();
                  scrollToProviderMatch(targetId);
                }}
                placeholder={t("provider.filterKeywordPlaceholder", {
                  field: modelFieldLabel,
                  defaultValue: "输入关键字筛选名称/网址/备注/{{field}}",
                })}
                className="h-8 pl-8 pr-8 text-sm"
              />
              {filterKeyword.trim().length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-[24px] h-6 w-6"
                  onClick={() => setFilterKeyword("")}
                  aria-label={t("common.clear", { defaultValue: "清空" })}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              {filterKeyword.trim().length > 0 && (
                <div className="mt-2 rounded-lg border border-border/70 bg-background/95 p-2 shadow-sm">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      {searchMatches.length > 0
                        ? t("provider.searchLocatorMatches", {
                            count: searchMatches.length,
                            defaultValue:
                              "定位到 {{count}} 个供应商，可点击快速跳转",
                          })
                        : t("provider.searchLocatorNoMatch", {
                            defaultValue: "没有匹配的供应商",
                          })}
                    </span>
                    {searchMatches.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() =>
                          scrollToProviderMatch(
                            activeSearchMatchId ?? searchMatches[0].id,
                          )
                        }
                      >
                        {t("provider.searchLocatorFocus", {
                          defaultValue: "定位当前",
                        })}
                      </Button>
                    )}
                  </div>
                  {searchMatches.length > 0 && (
                    <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                      {searchMatches.map((match, index) => (
                        <button
                          key={match.id}
                          type="button"
                          className={cn(
                            "flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                            activeSearchMatchId === match.id
                              ? "border-sky-300/80 bg-sky-50/90 shadow-sm dark:border-sky-500/30 dark:bg-sky-400/[0.08]"
                              : "border-border/50 bg-muted/20 hover:border-border/80 hover:bg-muted/35 dark:bg-muted/15 dark:hover:bg-muted/25",
                          )}
                          onClick={() => scrollToProviderMatch(match.id)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-background px-1.5 text-[11px] font-semibold text-muted-foreground">
                                {index + 1}
                              </span>
                              <span className="truncate text-sm font-medium text-foreground">
                                {match.name}
                              </span>
                            </span>
                            {match.detail && (
                              <span className="mt-1 block truncate text-xs text-muted-foreground">
                                {match.detail}
                              </span>
                            )}
                          </span>
                          {activeSearchMatchId === match.id && (
                            <span className="shrink-0 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                              {t("provider.searchLocatorFocus", {
                                defaultValue: "定位中",
                              })}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("provider.modelFilterMultiSelect", {
                  field: modelFieldLabel,
                  defaultValue: "按{{field}}多选",
                })}
              </Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 min-w-[180px] justify-between gap-3"
                  >
                    {modelFilterLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="max-h-72 w-64 overflow-y-auto"
                >
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      setSelectedModelFilters([]);
                    }}
                    disabled={selectedModelFilters.length === 0}
                  >
                    {t("common.clear", { defaultValue: "清空" })}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {availableModelFilters.length === 0 ? (
                    <DropdownMenuItem disabled>
                      {t("provider.noModelOptions", {
                        defaultValue: "暂无模型可选",
                      })}
                    </DropdownMenuItem>
                  ) : (
                    availableModelFilters.map((modelName) => (
                      <DropdownMenuCheckboxItem
                        key={modelName}
                        checked={selectedModelFilterSet.has(modelName)}
                        className="rounded-md border border-transparent data-[state=checked]:border-sky-300/50 data-[state=checked]:bg-sky-500/10 data-[state=checked]:text-sky-700 dark:data-[state=checked]:border-sky-500/30 dark:data-[state=checked]:bg-sky-400/[0.08] dark:data-[state=checked]:text-sky-300"
                        onCheckedChange={(checked) => {
                          setSelectedModelFilters((current) => {
                            if (checked === true) {
                              if (current.includes(modelName)) return current;
                              return [...current, modelName];
                            }
                            return current.filter((item) => item !== modelName);
                          });
                        }}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <div className="flex w-full items-center justify-between gap-3">
                          <span
                            className="max-w-[180px] truncate"
                            title={modelName}
                          >
                            {modelName}
                          </span>
                          {selectedModelFilterSet.has(modelName) && (
                            <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                              {t("common.selected", {
                                defaultValue: "已选",
                              })}
                            </span>
                          )}
                        </div>
                      </DropdownMenuCheckboxItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {selectedModelFilterPreview.length > 0 && (
                <div className="flex max-w-[280px] flex-wrap gap-1 pt-1">
                  {selectedModelFilterPreview.map((modelName) => (
                    <span
                      key={modelName}
                      className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700 dark:text-sky-300"
                      title={modelName}
                    >
                      {modelName}
                    </span>
                  ))}
                  {selectedModelFilters.length >
                    selectedModelFilterPreview.length && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      +
                      {selectedModelFilters.length -
                        selectedModelFilterPreview.length}
                    </span>
                  )}
                </div>
              )}
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => setSortState({ key: "default", direction: "asc" })}
              disabled={
                sortState.key === "default" && sortState.direction === "asc"
              }
            >
              {t("provider.defaultOrder", { defaultValue: "默认顺序" })}
            </Button>

            {!isDragEnabled && (
              <span className="rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                {t("provider.dragDisabledForSort", {
                  defaultValue: "当前为临时排序，拖拽已禁用",
                })}
              </span>
            )}
          </div>
        )}
      </div>

      <div
        ref={listScrollRef}
        className="flex-1 overflow-y-auto overflow-x-auto scroll-visible px-1 pb-2"
      >
        <div className="space-y-4 pb-4">
          {sortedDisplayProviders.length === 0 ? (
            <div className="px-6 py-8 text-sm text-center border border-dashed rounded-lg border-border text-muted-foreground">
              {t("provider.noSearchResults", {
                defaultValue: "没有符合筛选条件的提供商",
              })}
            </div>
          ) : (
            renderProviderTable()
          )}
        </div>
      </div>

      <Dialog
        open={isBatchModelDialogOpen}
        onOpenChange={setIsBatchModelDialogOpen}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              {t("provider.batchUpdateModel", { defaultValue: "批量修改模型" })}
            </DialogTitle>
            <DialogDescription>
              {t("provider.batchUpdateModelHint", {
                defaultValue:
                  "仅更新当前选中提供商，改动只影响配置展示与后续调用参数。",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t("common.selectedCount", {
                defaultValue: "已选 {{count}} 项",
                count: selectedCount,
              })}
            </p>

            {appId === "codex" && (
              <div className="space-y-1">
                <Label htmlFor="batch-codex-model">
                  {t("provider.model", { defaultValue: "模型名称" })}
                </Label>
                <Input
                  id="batch-codex-model"
                  value={batchCodexModel}
                  onChange={(event) => setBatchCodexModel(event.target.value)}
                  placeholder={t("provider.modelPlaceholder", {
                    defaultValue: "例如 gpt-5-codex",
                  })}
                />
              </div>
            )}

            {appId === "gemini" && (
              <div className="space-y-1">
                <Label htmlFor="batch-gemini-model">
                  {t("provider.model", { defaultValue: "模型名称" })}
                </Label>
                <Input
                  id="batch-gemini-model"
                  value={batchGeminiModel}
                  onChange={(event) => setBatchGeminiModel(event.target.value)}
                  placeholder={t("provider.modelPlaceholder", {
                    defaultValue: "例如 gemini-3.1-pro-preview",
                  })}
                />
              </div>
            )}

            {appId === "claude" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="batch-claude-primary-model">
                    {t("provider.primaryModel", { defaultValue: "主模型" })}
                  </Label>
                  <Input
                    id="batch-claude-primary-model"
                    value={batchClaudePrimaryModel}
                    onChange={(event) =>
                      setBatchClaudePrimaryModel(event.target.value)
                    }
                    placeholder={t("provider.primaryModelPlaceholder", {
                      defaultValue: "例如 claude-sonnet-4",
                    })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="batch-claude-reasoning-model">
                    {t("provider.reasoningModel", { defaultValue: "推理模型" })}
                  </Label>
                  <Input
                    id="batch-claude-reasoning-model"
                    value={batchClaudeReasoningModel}
                    onChange={(event) =>
                      setBatchClaudeReasoningModel(event.target.value)
                    }
                    placeholder={t("provider.reasoningModelPlaceholder", {
                      defaultValue: "例如 claude-opus-4",
                    })}
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsBatchModelDialogOpen(false)}
              disabled={isBatchUpdating}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button
              type="button"
              onClick={() => void handleApplyBatchModelUpdate()}
              disabled={
                !supportsBatchModelEdit ||
                selectedCount === 0 ||
                isBatchUpdating
              }
            >
              {isBatchUpdating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("common.save", { defaultValue: "保存" })
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isBatchDeleteDialogOpen}
        onOpenChange={setIsBatchDeleteDialogOpen}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {t("provider.batchDelete", { defaultValue: "批量删除" })}
            </DialogTitle>
            <DialogDescription>
              {t("provider.batchDeleteHint", {
                defaultValue:
                  "将删除当前选中提供商。该操作仅影响提供商记录，不改变会话路由策略设定。",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-sm">
            <p>
              {t("provider.batchDeleteSummary", {
                defaultValue: "已选 {{selected}} 项，可删除 {{deletable}} 项。",
                selected: selectedCount,
                deletable: deletableSelectedProviders.length,
              })}
            </p>
            {selectedCount > deletableSelectedProviders.length && (
              <p className="text-amber-600 dark:text-amber-300">
                {t("provider.batchDeleteBlocked", {
                  defaultValue:
                    "{{count}} 项为当前使用中或受限项，将自动跳过。",
                  count: selectedCount - deletableSelectedProviders.length,
                })}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsBatchDeleteDialogOpen(false)}
              disabled={isBatchDeleting}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleBatchDelete()}
              disabled={
                deletableSelectedProviders.length === 0 || isBatchDeleting
              }
            >
              {isBatchDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("common.delete", { defaultValue: "删除" })
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

              <div className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {t("proxy.sessionRouting.publicPriority", {
                        defaultValue: "公共优先",
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("proxy.sessionRouting.publicPriorityHint", {
                        defaultValue:
                          "开启后，会话路由和故障转移会优先选择正常的公共供应商；当公共供应商全部未启用、降级或熔断时，再按原队列顺序分配。",
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={sessionRoutingForm.publicPriorityEnabled}
                    onCheckedChange={(checked) =>
                      setSessionRoutingForm((current) => ({
                        ...current,
                        publicPriorityEnabled: checked,
                      }))
                    }
                    disabled={isSessionRoutingControlsDisabled}
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
                  disabled={isSessionRoutingControlsDisabled}
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

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t("proxy.sessionRouting.defaultProvider", {
                    defaultValue: "无会话默认提供商",
                  })}
                </Label>
                <select
                  value={sessionRoutingForm.defaultProviderId}
                  onChange={(event) =>
                    setSessionRoutingForm((current) => ({
                      ...current,
                      defaultProviderId: event.target.value,
                    }))
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  disabled={isSessionRoutingControlsDisabled}
                >
                  <option value="">
                    {t("proxy.sessionRouting.defaultProviderFollowCurrent", {
                      defaultValue: currentProviderName
                        ? `跟随当前供应商（${currentProviderName}）`
                        : "跟随当前供应商（应用默认）",
                    })}
                  </option>
                  {sessionRoutingProviderOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.isPublic
                        ? `${provider.name} (public)`
                        : provider.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {sessionRoutingForm.defaultProviderId
                    ? isAutoFailoverActive
                      ? t(
                          "proxy.sessionRouting.defaultProviderHintWithFailover",
                          {
                            defaultValue:
                              "未携带会话 ID 的请求会先使用该提供商；失败后再按故障转移队列继续回落。",
                          },
                        )
                      : t("proxy.sessionRouting.defaultProviderHint", {
                          defaultValue:
                            "未携带会话 ID 的请求会固定先使用该提供商，不参与会话绑定。",
                        })
                    : isAutoFailoverActive
                      ? t(
                          "proxy.sessionRouting.defaultProviderFollowCurrentHintWithFailover",
                          {
                            defaultValue:
                              "留空时跟随当前供应商；若当前失败，再按故障转移队列回落。",
                          },
                        )
                      : t(
                          "proxy.sessionRouting.defaultProviderFollowCurrentHint",
                          {
                            defaultValue:
                              "留空时跟随当前供应商；这就是会话路由模式下的“应用默认”回退行为。",
                          },
                        )}
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
                    disabled={isSessionRoutingControlsDisabled}
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
                    disabled={isSessionRoutingControlsDisabled}
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
                    disabled={isSessionRoutingControlsDisabled}
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
          onClose={handleCloseBatchTest}
          footer={
            <div className="flex w-full items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {batchSelectionStatus.selected}/{batchSelectionStatus.total}{" "}
                {t("common.selected", { defaultValue: "已选" })}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={handleCloseBatchTest}
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
                  onBlur={() =>
                    void saveStreamCheckSettingsIfNeeded({
                      includeModel: true,
                      includePrompt: true,
                    })
                  }
                  placeholder={t("streamCheck.testModelPlaceholder", {
                    defaultValue: "输入用于测试的模型名称",
                  })}
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={() => void handleBatchTest()}
                  disabled={
                    isBatchTesting ||
                    isSavingStreamConfig ||
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

            <div className="space-y-2">
              <Label htmlFor="batch-test-prompts">
                {t("streamCheck.testPromptList", {
                  defaultValue: "测试问题（每行一个）",
                })}
              </Label>
              <Textarea
                id="batch-test-prompts"
                value={testPromptText}
                onChange={(event) => setTestPromptText(event.target.value)}
                onBlur={() =>
                  void saveStreamCheckSettingsIfNeeded({
                    includeModel: true,
                    includePrompt: true,
                  })
                }
                placeholder={t("streamCheck.testPromptListPlaceholder", {
                  defaultValue: DEFAULT_STREAM_CHECK_PROMPT,
                })}
                rows={5}
                className="min-h-[120px]"
              />
              <p className="text-xs text-muted-foreground">
                {t("streamCheck.testPromptListHint", {
                  defaultValue:
                    "每行一个问题。每次测试都会随机选择其中一行，并作为全局检查提示词使用。",
                })}
              </p>
            </div>

            <div className="rounded-xl border border-border overflow-hidden">
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-background">
                    <tr className="border-b border-border/60">
                      <th className="w-10 px-3 py-2 text-center align-middle">
                        <div className="flex items-center justify-center">
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
                        </div>
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
                      <th className="px-3 py-2 text-left">
                        {t("streamCheck.failureReason", {
                          defaultValue: "失败原因",
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
                      let failureReason = "—";
                      if (hasResult) {
                        if (!result) {
                          statusLabel = t("streamCheck.failedShort", {
                            defaultValue: "失败",
                          });
                          statusClass = "text-rose-500";
                          failureReason = t("streamCheck.failedNoReason", {
                            defaultValue: "请求异常，请查看错误提示",
                          });
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
                          failureReason =
                            result.message?.trim() ||
                            t("streamCheck.failedNoReason", {
                              defaultValue: "无详细错误信息",
                            });
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
                          <td className="px-3 py-2 align-middle">
                            <div className="flex items-center justify-center">
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
                            </div>
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
                          <td className="px-3 py-2">
                            {failureReason === "—" ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span
                                className="block max-w-[360px] truncate text-rose-500"
                                title={failureReason}
                              >
                                {failureReason}
                              </span>
                            )}
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
                  defaultValue: "编辑 Codex 应用配置模板",
                })
              : appId === "gemini"
                ? t("geminiConfig.editCommonConfigTitle", {
                    defaultValue: "编辑 Gemini 应用配置模板",
                  })
                : t("claudeConfig.editCommonConfigTitle", {
                    defaultValue: "编辑 Claude 应用配置模板",
                  })
          }
          onClose={() => setIsCommonConfigOpen(false)}
          footer={
            <div className="flex w-full items-center justify-between">
              <div className="text-xs text-muted-foreground">
                {t("provider.commonConfigApplyAll", {
                  defaultValue: "应用配置模板",
                })}
              </div>
              <div className="flex items-center gap-2 flex-nowrap">
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
                ? t("codexConfig.commonConfigHint", {
                    defaultValue:
                      "该模板会在写入 live config.toml 时渲染；请使用 {{provider.config}}，可选 {{mcp.config}}",
                  })
                : appId === "gemini"
                  ? t("geminiConfig.commonConfigHint", {
                      defaultValue:
                        "该模板会在写入 Gemini live 配置时渲染；必须包含顶层 {{provider.config}}，可选 {{mcp.config}}。",
                    })
                  : t("claudeConfig.commonConfigHint", {
                      defaultValue:
                        "该模板会在写入 Claude live 配置时渲染；必须包含顶层 {{provider.config}}，可选 {{mcp.config}}。",
                    })}
            </p>

            <JsonEditor
              value={commonConfigSnippet}
              onChange={(value) => {
                setCommonConfigSnippet(value);
                setCommonConfigError("");
              }}
              placeholder={
                appId === "codex"
                  ? `developer_instructions = "请使用中文回答,务必使用清晰详细准确的风格。"

{{provider.config}}

{{mcp.config}}`
                  : appId === "gemini"
                    ? getDefaultJsonCommonConfigTemplate("gemini")
                    : getDefaultJsonCommonConfigTemplate("claude")
              }
              darkMode={
                typeof document !== "undefined" &&
                document.documentElement.classList.contains("dark")
              }
              rows={16}
              showValidation={false}
              language={appId === "codex" ? "javascript" : "json"}
            />

            {commonConfigError && (
              <p className="text-sm text-red-500 dark:text-red-400">
                {commonConfigError}
              </p>
            )}

            {isSupportedProviderTemplateApp(appId) && (
              <div className="space-y-3 border-t border-border/60 pt-4">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t("provider.defaultTemplate", {
                      defaultValue: "默认供应商模板",
                    })}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("provider.defaultTemplateHint", {
                      defaultValue:
                        appId === "codex"
                          ? "用于新建 Codex 自定义供应商的默认 config.toml 模板片段，不包含 auth.json，可使用变量占位符。"
                          : "用于新建自定义供应商的初始配置，可使用占位符如 {{api_key}}、{{base_url}}、{{model}}",
                    })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("provider.defaultTemplatePlaceholders", {
                      defaultValue: "可用占位符: {{placeholders}}",
                      placeholders: getAllowedProviderTemplatePlaceholders(
                        appId,
                      )
                        .map((item) => `{{${item}}}`)
                        .join(", "),
                    })}
                  </p>
                </div>

                <JsonEditor
                  value={providerDefaultTemplate}
                  onChange={(value) => {
                    setProviderDefaultTemplate(value);
                    setProviderDefaultTemplateError("");
                  }}
                  placeholder={getFallbackProviderDefaultTemplate(appId)}
                  darkMode={
                    typeof document !== "undefined" &&
                    document.documentElement.classList.contains("dark")
                  }
                  rows={16}
                  showValidation={appId !== "codex"}
                  language={appId === "codex" ? "javascript" : "json"}
                />

                {providerDefaultTemplateError && (
                  <p className="text-sm text-red-500 dark:text-red-400">
                    {providerDefaultTemplateError}
                  </p>
                )}
              </div>
            )}
          </div>
        </FullScreenPanel>
      )}

      <FullScreenPanel
        isOpen={isConfigPreviewOpen}
        title={t("provider.configPreviewTitle", {
          defaultValue: "当前环境配置",
        })}
        onClose={() => setIsConfigPreviewOpen(false)}
        footer={
          <>
            <Button
              type="button"
              onClick={() => void handleSaveAllPreviewFiles()}
              disabled={
                dirtyPreviewFiles.length === 0 ||
                isSavingAllPreviewFiles ||
                savingPreviewFilePath !== null ||
                hasLiveConfigChanged
              }
              className="gap-2"
            >
              {isSavingAllPreviewFiles ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t("provider.saveAllLiveConfig", {
                defaultValue: dirtyPreviewFiles.length
                  ? "保存全部已修改文件 ({{count}})"
                  : "保存全部已修改文件",
                count: dirtyPreviewFiles.length,
              })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void loadConfigPreview({ resetLiveSignature: true })
              }
              disabled={isConfigPreviewLoading}
              className="gap-2"
            >
              {isConfigPreviewLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("common.refresh", {
                defaultValue: "刷新",
              })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsConfigPreviewOpen(false)}
            >
              {t("common.close", {
                defaultValue: "关闭",
              })}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {hasLiveConfigChanged && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                {t("provider.liveConfigChanged", {
                  defaultValue:
                    "检测到实际配置文件发生变化。请先刷新当前环境配置，再决定是否保存。",
                })}
              </span>
            </div>
          )}

          {configPreview?.note && (
            <div className="rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              {configPreview.note}
            </div>
          )}

          <div className="rounded-lg border border-border/60 px-4 py-3 text-sm">
            <div className="font-medium text-foreground">
              {t("provider.currentProvider", {
                defaultValue: "当前供应商",
              })}
            </div>
            <div className="mt-1 text-muted-foreground">
              {configPreview?.currentProviderName ||
                configPreview?.currentProviderId ||
                t("provider.noCurrentProvider", {
                  defaultValue: "未设置",
                })}
            </div>
          </div>

          {configPreview?.files?.length ? (
            configPreview.files.map((file) => {
              const draftValue = getPreviewDraftValue(file, previewDrafts);
              const isOpening = openingLiveConfigPath === file.path;
              const isSaving = savingPreviewFilePath === file.path;
              const isDirty = isPreviewDraftDirty(file, previewDrafts);
              const saveDisabled =
                !isDirty || isSavingAllPreviewFiles || hasLiveConfigChanged;
              const editorMode = getLiveConfigEditorMode(file);
              const textSyntax = getLiveConfigTextSyntax(file);
              const previewPaneHeight = "min(56vh, 520px)";
              const showsFormatButton = editorMode === "json";
              return (
                <div
                  key={`${file.path}:${file.label}`}
                  className="space-y-3 rounded-lg border border-border/60 px-4 py-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium text-foreground">
                          {file.label}
                        </div>
                        {isDirty && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          >
                            {t("provider.liveConfigDraftDirty", {
                              defaultValue: "未保存",
                            })}
                          </Badge>
                        )}
                        {file.differs && (
                          <Badge
                            variant="outline"
                            className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                          >
                            {t("provider.liveConfigDiffersFromExpected", {
                              defaultValue: "与预期配置不同",
                            })}
                          </Badge>
                        )}
                      </div>
                      <code className="block text-xs text-muted-foreground break-all">
                        {file.path}
                      </code>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          !isDirty || isSaving || isSavingAllPreviewFiles
                        }
                        onClick={() => handleResetPreviewDraft(file)}
                        className="gap-2"
                      >
                        <RefreshCw className="h-4 w-4" />
                        {t("common.reset", {
                          defaultValue: "重置",
                        })}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleSavePreviewFile(file)}
                        disabled={saveDisabled || isSaving}
                        className="gap-2"
                      >
                        {isSaving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        {t("common.save", {
                          defaultValue: "保存",
                        })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          !file.exists || isOpening || isSavingAllPreviewFiles
                        }
                        onClick={() =>
                          void handleOpenLiveConfigFile({
                            label: file.label,
                            path: file.path,
                            exists: file.exists,
                          } as LiveConfigFileEntry)
                        }
                        className="gap-2"
                      >
                        {isOpening ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                        {t("provider.openLiveConfigFile", {
                          defaultValue: "打开文件",
                        })}
                      </Button>
                    </div>
                  </div>

                  {file.differs && (
                    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
                      {t("provider.liveConfigExpectedHint", {
                        defaultValue:
                          "当前 live 文件内容与系统预期配置不同。编辑和保存前，请确认这是你希望保留的实际运行配置。",
                      })}
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-muted-foreground">
                        {t("provider.actualConfig", {
                          defaultValue: "当前 live 文件",
                        })}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("provider.liveConfigStatusHint", {
                          defaultValue: isDirty
                            ? "有未保存改动"
                            : "已与磁盘内容同步",
                        })}
                      </div>
                    </div>
                    {editorMode === "text" && (
                      <TextCodeEditor
                        value={draftValue}
                        onChange={(value) =>
                          handlePreviewDraftChange(file.path, value)
                        }
                        height={previewPaneHeight}
                        language={textSyntax}
                      />
                    )}
                    {editorMode === "json" && (
                      <JsonEditor
                        value={draftValue}
                        onChange={(value) =>
                          handlePreviewDraftChange(file.path, value)
                        }
                        height={previewPaneHeight}
                        showValidation={true}
                        language="json"
                      />
                    )}
                    {showsFormatButton && (
                      <p className="text-xs text-muted-foreground">
                        {t("provider.liveConfigEditHint", {
                          defaultValue:
                            "上方直接编辑的是当前环境实际使用的 live 配置文件内容。",
                        })}
                      </p>
                    )}
                    {editorMode === "text" && (
                      <p className="text-xs text-muted-foreground">
                        {t("provider.liveConfigTextEditHint", {
                          defaultValue:
                            "当前文件不是 JSON，已按纯文本模式编辑，不执行 JSON 校验和格式化。",
                        })}
                      </p>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              {t("provider.configPreviewEmpty", {
                defaultValue: "当前应用暂无可展示的 live 配置文件。",
              })}
            </div>
          )}
        </div>
      </FullScreenPanel>

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

interface SortableProviderTableRowProps {
  provider: Provider;
  rowIndex: number;
  showOrderNumber: boolean;
  columnWidths: Record<ProviderResizableColumnKey, number>;
  actionsColumnWidth: number;
  dragEnabled: boolean;
  isSelected: boolean;
  onToggleSelected: (providerId: string, checked: boolean) => void;
  modelSummary: string;
  statusMeta: ProviderStatusMeta;
  sessionCount?: number;
  occupancyDetails?: ProviderOccupancyDetail[];
  showSessionOccupancy?: boolean;
  onReleaseSessionOccupancy?: () => void;
  isReleasingSessionOccupancy?: boolean;
  isCurrent: boolean;
  canDelete: boolean;
  isInConfig: boolean;
  isOmo: boolean;
  isOmoSlim: boolean;
  appId: AppId;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onMoveToTop: (provider: Provider) => void;
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
  isProxyTakeover: boolean;
  isAutoFailoverEnabled: boolean;
  isInFailoverQueue: boolean;
  onToggleFailover: (enabled: boolean) => void;
  isDefaultModel?: boolean;
  onSetAsDefault?: () => void;
  rowRef?: (node: HTMLTableRowElement | null) => void;
  isSearchMatched?: boolean;
  isActiveSearchMatch?: boolean;
}

function SortableProviderTableRow({
  provider,
  rowIndex,
  showOrderNumber,
  columnWidths,
  actionsColumnWidth,
  dragEnabled,
  isSelected,
  onToggleSelected,
  modelSummary,
  statusMeta,
  sessionCount = 0,
  occupancyDetails = [],
  showSessionOccupancy = false,
  onReleaseSessionOccupancy,
  isReleasingSessionOccupancy = false,
  isCurrent,
  canDelete,
  isInConfig,
  isOmo,
  isOmoSlim,
  appId,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onMoveToTop,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminalWithMode,
  recentTerminalTargets,
  onClearRecentTerminals,
  onTest,
  isTesting,
  isProxyTakeover,
  isAutoFailoverEnabled,
  isInFailoverQueue,
  onToggleFailover,
  isDefaultModel,
  onSetAsDefault,
  rowRef,
  isSearchMatched = false,
  isActiveSearchMatch = false,
}: SortableProviderTableRowProps) {
  const { t } = useTranslation();
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.id, disabled: !dragEnabled });
  const { data: health } = useProviderHealth(provider.id, appId);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const rowClass =
    rowIndex % 2 === 0
      ? "bg-background/90 dark:bg-background/40"
      : "bg-muted/35 dark:bg-muted/20";
  const baseStickyCellBgClass =
    rowIndex % 2 === 0
      ? "bg-background dark:bg-background/60"
      : "bg-muted/45 dark:bg-muted/30";
  const stickyCellBgClass = baseStickyCellBgClass;
  const searchBadgeLabel = isActiveSearchMatch
    ? t("provider.searchLocatorFocus", { defaultValue: "定位中" })
    : t("provider.searchMatchedBadge", { defaultValue: "匹配" });
  const nameCellHighlightClass = isActiveSearchMatch
    ? "ring-1 ring-inset ring-sky-300/80 bg-sky-50/80 dark:ring-sky-500/35 dark:bg-sky-400/[0.08]"
    : isSearchMatched
      ? "ring-1 ring-inset ring-border/70 bg-muted/25 dark:bg-muted/15"
      : "";

  const website = provider.websiteUrl?.trim() ?? "";
  const notes = provider.notes?.trim() ?? "";
  const disableOmoHandler = isOmoSlim ? onDisableOmoSlim : onDisableOmo;
  const showHealthBadge =
    isInFailoverQueue && health != null && !isOmo && !isOmoSlim;
  const showOccupancyBadge = showSessionOccupancy && sessionCount > 0;
  const visibleOccupancyDetails = occupancyDetails.slice(0, 4);
  const remainingOccupancyCount = Math.max(
    occupancyDetails.length - visibleOccupancyDetails.length,
    0,
  );
  const handleRowRef = useCallback(
    (node: HTMLTableRowElement | null) => {
      setNodeRef(node);
      rowRef?.(node);
    },
    [rowRef, setNodeRef],
  );

  return (
    <tr
      ref={handleRowRef}
      style={style}
      data-state={isSelected ? "selected" : undefined}
      data-provider-id={provider.id}
      className={cn(
        "border-b border-border/60 transition-colors",
        "hover:bg-muted/45 dark:hover:bg-muted/35",
        rowClass,
        isDragging && "z-10 bg-accent/40",
      )}
    >
      <td
        className={cn(
          "sticky left-0 z-20 px-3 py-2 align-middle",
          stickyCellBgClass,
        )}
      >
        <div className="flex items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) =>
              onToggleSelected(provider.id, checked === true)
            }
            aria-label={t("common.select", { defaultValue: "选择" })}
          />
        </div>
      </td>

      <td
        className={cn(
          "sticky left-[48px] z-20 px-2 py-2 align-middle",
          stickyCellBgClass,
        )}
      >
        <button
          type="button"
          className={cn(
            "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-muted-foreground transition-colors tabular-nums",
            dragEnabled
              ? "cursor-grab hover:bg-muted active:cursor-grabbing"
              : "cursor-not-allowed opacity-40",
          )}
          aria-label={t("provider.dragHandle", { defaultValue: "拖拽排序" })}
          disabled={!dragEnabled}
          {...(dragEnabled ? attributes : {})}
          {...(dragEnabled ? listeners : {})}
        >
          {showOrderNumber ? (
            <span className="text-xs font-semibold">{rowIndex + 1}</span>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="5" cy="4" r="1" />
              <circle cx="11" cy="4" r="1" />
              <circle cx="5" cy="8" r="1" />
              <circle cx="11" cy="8" r="1" />
              <circle cx="5" cy="12" r="1" />
              <circle cx="11" cy="12" r="1" />
            </svg>
          )}
        </button>
      </td>

      <td
        className={cn(
          "sticky left-[88px] z-20 min-w-[240px] px-3 py-2 align-middle",
          stickyCellBgClass,
        )}
      >
        <div
          className={cn("min-w-0 rounded-lg px-2 py-1", nameCellHighlightClass)}
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate font-medium" title={provider.name}>
              {website ? (
                <button
                  type="button"
                  className="block max-w-full truncate text-left text-blue-600 hover:underline dark:text-blue-400"
                  title={website}
                  onClick={() => onOpenWebsite(website)}
                >
                  {provider.name}
                </button>
              ) : (
                provider.name
              )}
            </div>
            {isSearchMatched && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  isActiveSearchMatch
                    ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {searchBadgeLabel}
              </span>
            )}
            {provider.isPublic && (
              <span className="shrink-0 rounded border border-border/70 px-1 py-0 text-[10px] leading-none text-muted-foreground">
                {t("provider.publicTag", { defaultValue: "public" })}
              </span>
            )}
          </div>
        </div>
      </td>

      <td
        className="px-3 py-2 align-middle"
        style={{
          width: columnWidths.notes,
          minWidth: PROVIDER_COLUMN_MIN_WIDTHS.notes,
        }}
      >
        {notes ? (
          <span className="block truncate text-muted-foreground" title={notes}>
            {notes}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      <td
        className="px-3 py-2 align-middle"
        style={{
          width: columnWidths.model,
          minWidth: PROVIDER_COLUMN_MIN_WIDTHS.model,
        }}
      >
        <span
          className="block truncate text-muted-foreground"
          title={modelSummary}
        >
          {modelSummary}
        </span>
      </td>

      <td
        className="px-3 py-2 align-middle"
        style={{
          minWidth: PROVIDER_STATUS_COLUMN_MIN_WIDTH,
        }}
      >
        <div className="flex items-center gap-2 flex-wrap">
          {showHealthBadge && (
            <ProviderHealthBadge
              consecutiveFailures={health.consecutive_failures}
              lastError={health.last_error}
            />
          )}
          {showOccupancyBadge && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-200">
                  {t("provider.sessionOccupancy", {
                    defaultValue: "占用 {{count}}",
                    count: sessionCount,
                  })}
                  {onReleaseSessionOccupancy && (
                    <button
                      type="button"
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-amber-700/80 transition-colors hover:bg-amber-200 hover:text-amber-900 dark:text-amber-200/80 dark:hover:bg-amber-800/60 dark:hover:text-amber-50"
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
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-left leading-relaxed">
                <div className="space-y-2">
                  <p className="font-medium">
                    {t("provider.sessionOccupancyDetailsTitle", {
                      defaultValue: "活跃会话占用数：{{count}}",
                      count: sessionCount,
                    })}
                  </p>
                  {visibleOccupancyDetails.length > 0 ? (
                    <div className="space-y-1">
                      {visibleOccupancyDetails.map((detail) => (
                        <div key={detail.sessionId} className="space-y-0.5">
                          <div className="font-medium">{detail.title}</div>
                          {detail.projectName ? (
                            <div className="text-primary-foreground/80">
                              {t("provider.sessionProjectLabel", {
                                defaultValue: "项目",
                              })}
                              : {detail.projectName}
                            </div>
                          ) : null}
                          <div className="text-primary-foreground/80">
                            {t("provider.sessionIdLabel", {
                              defaultValue: "会话",
                            })}
                            : {detail.sessionId.slice(0, 8)}
                          </div>
                        </div>
                      ))}
                      {remainingOccupancyCount > 0 && (
                        <div className="text-primary-foreground/80">
                          {t("provider.sessionOccupancyMore", {
                            defaultValue: "还有 {{count}} 个会话",
                            count: remainingOccupancyCount,
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-primary-foreground/80">
                      {t("provider.sessionOccupancyHint", {
                        defaultValue: "活跃会话占用数：{{count}}",
                        count: sessionCount,
                      })}
                    </p>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
          {statusMeta.badges.map((badge, index) => (
            <span
              key={`${badge.label}-${index}`}
              className={cn(
                "inline-flex rounded-md px-2 py-0.5 text-xs",
                badge.className,
              )}
              title={badge.description ?? undefined}
            >
              {badge.label}
            </span>
          ))}
        </div>
      </td>

      <td
        className={cn(
          "sticky right-0 z-20 px-3 py-2 align-middle",
          stickyCellBgClass,
        )}
        style={{
          width: actionsColumnWidth,
          minWidth: actionsColumnWidth,
          maxWidth: actionsColumnWidth,
        }}
      >
        <div className="w-full">
          <ProviderActions
            appId={appId}
            isCurrent={isCurrent}
            canDelete={canDelete}
            isInConfig={isInConfig}
            isTesting={isTesting}
            isProxyTakeover={isProxyTakeover}
            isOmo={isOmo || isOmoSlim}
            onSwitch={() => onSwitch(provider)}
            onEdit={() => onEdit(provider)}
            onDuplicate={() => onDuplicate(provider)}
            onMoveToTop={() => onMoveToTop(provider)}
            onTest={onTest ? () => onTest(provider) : undefined}
            onConfigureUsage={
              onConfigureUsage
                ? () => onConfigureUsage(provider)
                : () => undefined
            }
            onDelete={() => onDelete(provider)}
            onRemoveFromConfig={
              onRemoveFromConfig
                ? () => onRemoveFromConfig(provider)
                : undefined
            }
            onDisableOmo={disableOmoHandler}
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
            isDefaultModel={isDefaultModel}
            onSetAsDefault={onSetAsDefault}
          />
        </div>
      </td>
    </tr>
  );
}
