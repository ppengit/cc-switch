import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  FileText,
  GripVertical,
  History,
  Loader2,
  Pencil,
  Pin,
  Play,
  Search,
  Terminal,
  TestTube2,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Provider, SessionMeta } from "@/types";
import type { AppId } from "@/lib/api";
import { providersApi } from "@/lib/api/providers";
import {
  getStreamCheckConfig,
  saveStreamCheckConfig,
  streamCheckAllProviders,
} from "@/lib/api/model-test";
import { sessionsApi } from "@/lib/api/sessions";
import { configApi } from "@/lib/api";
import { useDragSort } from "@/hooks/useDragSort";
import {
  useOpenClawLiveProviderIds,
  useOpenClawDefaultModel,
  openclawKeys,
} from "@/hooks/useOpenClaw";
import {
  useHermesLiveProviderIds,
  useHermesModelConfig,
  hermesKeys,
} from "@/hooks/useHermes";
import { useStreamCheck } from "@/hooks/useStreamCheck";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";
import {
  useAutoFailoverEnabled,
  useFailoverQueue,
  useAddToFailoverQueue,
  useRemoveFromFailoverQueue,
} from "@/lib/query/failover";
import {
  useCurrentOmoProviderId,
  useCurrentOmoSlimProviderId,
} from "@/lib/query/omo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { settingsApi } from "@/lib/api/settings";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import { PROVIDER_TYPES } from "@/config/constants";
import { isHermesReadOnlyProvider } from "@/config/hermesProviderPresets";
import { extractCodexBaseUrl } from "@/utils/providerConfigUtils";
import { pickRandomTestPrompt } from "@/utils/batchTestPrompts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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
  onOpenTerminal?: (provider: Provider) => void;
  onCreate?: () => void;
  isLoading?: boolean;
  isProxyRunning?: boolean;
  isProxyTakeover?: boolean;
  activeProviderId?: string;
  onSetAsDefault?: (provider: Provider) => void;
}

type StatusSortDirection = "asc" | "desc" | null;

interface ProviderRowView {
  provider: Provider;
  isOmo: boolean;
  isOmoSlim: boolean;
  isAnyOmo: boolean;
  isCurrent: boolean;
  isInConfig: boolean;
  isReadOnly: boolean;
  isEnabled: boolean;
  isActiveProxyProvider: boolean;
  failoverPriority?: number;
  orderNumber: number;
  statusRank: number;
  modelDisplay: string;
  endpointDisplay: string;
  nameLink?: string;
  canDelete: boolean;
  canTest: boolean;
}

interface AppConfigFileEntry {
  key: string;
  label: string;
  path: string;
}

const URL_WITHOUT_TRAILING_SLASH = /\/+$/;
const URL_V1_SUFFIX = /\/v1$/i;

const stripTrailingSlash = (value?: string | null) =>
  (value || "").trim().replace(URL_WITHOUT_TRAILING_SLASH, "");

const stripV1Suffix = (value: string) => value.replace(URL_V1_SUFFIX, "");

const normalizeOptionalUrl = (value?: string | null) => {
  const normalized = stripTrailingSlash(value);
  return normalized || "";
};

const firstNonEmpty = (...values: Array<string | undefined | null>) => {
  for (const value of values) {
    const trimmed = (value || "").trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
};

const getCodexModelFromToml = (configText?: string) => {
  if (!configText) return "";
  const match = configText.match(/^\s*model\s*=\s*['"]([^'"]+)['"]/m);
  return match?.[1] || "";
};

const getEndpointFromProvider = (provider: Provider, appId: AppId) => {
  const cfg =
    provider.settingsConfig && typeof provider.settingsConfig === "object"
      ? (provider.settingsConfig as Record<string, any>)
      : undefined;

  if (!cfg) return "";

  if (appId === "claude") {
    return firstNonEmpty(cfg.env?.ANTHROPIC_BASE_URL);
  }

  if (appId === "codex") {
    const extracted = extractCodexBaseUrl(
      typeof cfg.config === "string" ? cfg.config : "",
    );
    return extracted || "";
  }

  if (appId === "gemini") {
    return firstNonEmpty(cfg.env?.GOOGLE_GEMINI_BASE_URL);
  }

  if (appId === "opencode") {
    return firstNonEmpty(cfg.options?.baseURL);
  }

  if (appId === "openclaw") {
    return firstNonEmpty(cfg.baseUrl);
  }

  if (appId === "hermes") {
    return firstNonEmpty(cfg.base_url);
  }

  return "";
};

const getModelDisplayByApp = (provider: Provider, appId: AppId) => {
  const cfg =
    provider.settingsConfig && typeof provider.settingsConfig === "object"
      ? (provider.settingsConfig as Record<string, any>)
      : undefined;

  if (!cfg) return "-";

  if (appId === "claude") {
    const env = (cfg.env || {}) as Record<string, unknown>;
    const models = [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ]
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    const unique = Array.from(new Set(models));
    return unique.length > 0 ? unique.join(", ") : "-";
  }

  if (appId === "codex") {
    const model = getCodexModelFromToml(
      typeof cfg.config === "string" ? cfg.config : "",
    );
    return model || "-";
  }

  if (appId === "gemini") {
    const model = firstNonEmpty(cfg.env?.GEMINI_MODEL);
    return model || "-";
  }

  if (appId === "opencode") {
    const models = cfg.models;
    if (Array.isArray(models)) {
      const ids = models
        .map((item) =>
          item && typeof item === "object" && typeof item.id === "string"
            ? item.id.trim()
            : "",
        )
        .filter(Boolean);
      return ids.length > 0 ? ids.join(", ") : "-";
    }

    if (models && typeof models === "object") {
      const names = Object.keys(models);
      return names.length > 0 ? names.join(", ") : "-";
    }

    return "-";
  }

  if (appId === "openclaw" || appId === "hermes") {
    const models = cfg.models;
    if (!Array.isArray(models)) return "-";

    const ids = models
      .map((item) =>
        item && typeof item === "object" && typeof item.id === "string"
          ? item.id.trim()
          : "",
      )
      .filter(Boolean);

    return ids.length > 0 ? ids.join(", ") : "-";
  }

  return "-";
};

function isOfficialProvider(provider: Provider, appId: AppId): boolean {
  const config = provider.settingsConfig as Record<string, any>;
  if (appId === "claude") {
    const baseUrl = config?.env?.ANTHROPIC_BASE_URL;
    return !baseUrl || (typeof baseUrl === "string" && baseUrl.trim() === "");
  }
  if (appId === "codex") {
    const apiKey = config?.auth?.OPENAI_API_KEY;
    return !apiKey || (typeof apiKey === "string" && apiKey.trim() === "");
  }
  if (appId === "gemini") {
    const apiKey = config?.env?.GEMINI_API_KEY;
    const baseUrl = config?.env?.GOOGLE_GEMINI_BASE_URL;
    return (
      (!apiKey || (typeof apiKey === "string" && apiKey.trim() === "")) &&
      (!baseUrl || (typeof baseUrl === "string" && baseUrl.trim() === ""))
    );
  }
  return false;
}

const buildTemplateByApp = (appId: AppId) => {
  if (appId === "codex") {
    return `# Codex config template
# provider
{providerConfig}

# MCP
[mcp_servers]
{mcpConfig}
`;
  }

  if (appId === "gemini") {
    return `# .env
{providerConfig}

# settings.json
{
  {settingsConfig}
  "mcpServers": {mcpConfig}
}
`;
  }

  if (appId === "opencode") {
    return `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {providerConfig},
  "mcp": {mcpConfig}
}`;
  }

  if (appId === "openclaw") {
    return `{
  "models": {
    "mode": "merge",
    "providers": {providerConfig}
  },
  "mcp": {mcpConfig}
}`;
  }

  if (appId === "hermes") {
    return `model:
  providerConfig: {providerConfig}

mcp_servers:
  {mcpConfig}
`;
  }

  return `{
  "provider": {providerConfig},
  "mcpServers": {mcpConfig}
}`;
};

export function ProviderList({
  providers,
  currentProviderId,
  appId,
  onSwitch,
  onEdit,
  onDelete,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onCreate,
  isLoading = false,
  isProxyTakeover = false,
  activeProviderId,
  onSetAsDefault,
}: ProviderListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { checkProvider, isChecking } = useStreamCheck(appId);
  const { sortedProviders, sensors, handleDragEnd } = useDragSort(
    providers,
    appId,
  );

  const { data: opencodeLiveIds } = useQuery({
    queryKey: ["opencodeLiveProviderIds"],
    queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
    enabled: appId === "opencode",
  });

  const { data: openclawLiveIds } = useOpenClawLiveProviderIds(
    appId === "openclaw",
  );

  const { data: hermesLiveIds } = useHermesLiveProviderIds(appId === "hermes");

  const { data: hermesModelConfig } = useHermesModelConfig(appId === "hermes");
  const hermesCurrentProviderId = hermesModelConfig?.provider;

  const isProviderInConfig = useCallback(
    (providerId: string): boolean => {
      if (appId === "opencode") {
        return opencodeLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "openclaw") {
        return openclawLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "hermes") {
        return hermesLiveIds?.includes(providerId) ?? false;
      }
      return true;
    },
    [appId, opencodeLiveIds, openclawLiveIds, hermesLiveIds],
  );

  const { data: openclawDefaultModel } = useOpenClawDefaultModel(
    appId === "openclaw",
  );

  const isProviderDefaultModel = useCallback(
    (providerId: string): boolean => {
      if (appId !== "openclaw" || !openclawDefaultModel?.primary) return false;
      return openclawDefaultModel.primary.startsWith(providerId + "/");
    },
    [appId, openclawDefaultModel],
  );

  const { data: isAutoFailoverEnabled } = useAutoFailoverEnabled(appId);
  const { data: failoverQueue } = useFailoverQueue(appId);
  const addToQueue = useAddToFailoverQueue();
  const removeFromQueue = useRemoveFromFailoverQueue();

  const isFailoverModeActive =
    isProxyTakeover === true && isAutoFailoverEnabled === true;

  const isAdditiveMode =
    appId === "opencode" || appId === "openclaw" || appId === "hermes";

  const isOpenCode = appId === "opencode";
  const { data: currentOmoId } = useCurrentOmoProviderId(isOpenCode);
  const { data: currentOmoSlimId } = useCurrentOmoSlimProviderId(isOpenCode);

  const getFailoverPriority = useCallback(
    (providerId: string): number | undefined => {
      if (!isFailoverModeActive || !failoverQueue) return undefined;
      const index = failoverQueue.findIndex(
        (item) => item.providerId === providerId,
      );
      return index >= 0 ? index + 1 : undefined;
    },
    [isFailoverModeActive, failoverQueue],
  );

  const [searchTerm, setSearchTerm] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchTesting, setIsBatchTesting] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showStreamCheckConfirm, setShowStreamCheckConfirm] = useState(false);
  const [pendingTestProvider, setPendingTestProvider] =
    useState<Provider | null>(null);

  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [statusSortDirection, setStatusSortDirection] =
    useState<StatusSortDirection>(null);
  const [isBulkOperating, setIsBulkOperating] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState("");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [currentConfigDialogOpen, setCurrentConfigDialogOpen] = useState(false);

  const [selectedConfigFileKey, setSelectedConfigFileKey] =
    useState<string>("");
  const [currentConfigDraft, setCurrentConfigDraft] = useState("");
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  });

  const { data: recentSessions = [], isFetching: isRecentSessionsLoading } =
    useQuery({
      queryKey: ["recentSessions", appId],
      queryFn: () => sessionsApi.listRecent({ appType: appId, limit: 10 }),
      staleTime: 30_000,
    });

  const {
    data: configFiles = [],
    isFetching: isConfigFilesFetching,
    refetch: refetchConfigFiles,
  } = useQuery({
    queryKey: ["appConfigFiles", appId],
    queryFn: () => configApi.listAppConfigFiles(appId),
    enabled: currentConfigDialogOpen,
  });

  const {
    data: currentConfigContent,
    isFetching: isCurrentConfigLoading,
    refetch: refetchCurrentConfig,
  } = useQuery({
    queryKey: ["appConfigFileContent", appId, selectedConfigFileKey],
    queryFn: () =>
      configApi.readAppConfigFile({ appId, fileKey: selectedConfigFileKey }),
    enabled: currentConfigDialogOpen && Boolean(selectedConfigFileKey),
  });

  const {
    data: persistedTemplate,
    isFetching: isTemplateFetching,
    refetch: refetchTemplate,
  } = useQuery({
    queryKey: ["appConfigTemplate", appId],
    queryFn: () => configApi.getAppConfigTemplate(appId),
    enabled: templateDialogOpen,
  });

  const handleTest = useCallback(
    (provider: Provider) => {
      if (!settings?.streamCheckConfirmed) {
        setPendingTestProvider(provider);
        setShowStreamCheckConfirm(true);
      } else {
        checkProvider(provider.id, provider.name);
      }
    },
    [checkProvider, settings?.streamCheckConfirmed],
  );

  const handleBatchTest = useCallback(async () => {
    if (isBatchTesting) return;
    setIsBatchTesting(true);
    try {
      try {
        const cfg = await getStreamCheckConfig();
        await saveStreamCheckConfig({
          ...cfg,
          testPrompt: pickRandomTestPrompt(),
        });
      } catch (error) {
        console.warn("[batchTest] failed to rotate test prompt", error);
      }

      const results = await streamCheckAllProviders(appId, false);
      const operational = results.filter(
        ([, result]) => result.status === "operational",
      ).length;
      const degraded = results.filter(
        ([, result]) => result.status === "degraded",
      ).length;
      const failed = results.filter(
        ([, result]) => result.status === "failed",
      ).length;

      toast.success(
        t("streamCheck.batchCompleted", {
          count: results.length,
          operational,
          degraded,
          failed,
          defaultValue: `批量测试完成：共 ${results.length} 个（正常 ${operational}，降级 ${degraded}，失败 ${failed}）`,
        }),
        { closeButton: true, duration: 6000 },
      );

      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
    } catch (error) {
      console.error("[batchTest] failed", error);
      toast.error(
        t("streamCheck.batchFailed", {
          defaultValue: "批量测试失败",
        }) + ` (${String(error)})`,
      );
    } finally {
      setIsBatchTesting(false);
    }
  }, [appId, isBatchTesting, queryClient, t]);

  const handleStreamCheckConfirm = async () => {
    setShowStreamCheckConfirm(false);
    try {
      if (settings) {
        const { webdavSync: _, ...rest } = settings;
        await settingsApi.save({ ...rest, streamCheckConfirmed: true });
        await queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
    } catch (error) {
      console.error("Failed to save stream check confirmed:", error);
    }

    if (pendingTestProvider) {
      checkProvider(pendingTestProvider.id, pendingTestProvider.name);
      setPendingTestProvider(null);
    }
  };

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
      if (appId === "hermes") {
        const count = await providersApi.importHermesFromLive();
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
      const key = event.key.toLowerCase();
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
    const allIds = new Set(sortedProviders.map((item) => item.id));
    setSelectedProviderIds((prev) => {
      const next = new Set<string>();
      prev.forEach((id) => {
        if (allIds.has(id)) {
          next.add(id);
        }
      });
      return next;
    });
  }, [sortedProviders]);

  useEffect(() => {
    if (!currentConfigDialogOpen) {
      setSelectedConfigFileKey("");
      setCurrentConfigDraft("");
      return;
    }

    void refetchConfigFiles();
  }, [currentConfigDialogOpen, refetchConfigFiles]);

  useEffect(() => {
    if (!currentConfigDialogOpen || configFiles.length === 0) return;
    if (selectedConfigFileKey) {
      const exists = configFiles.some(
        (file) => file.key === selectedConfigFileKey,
      );
      if (exists) return;
    }

    setSelectedConfigFileKey(configFiles[0].key);
  }, [configFiles, currentConfigDialogOpen, selectedConfigFileKey]);

  useEffect(() => {
    if (!currentConfigContent) return;
    setCurrentConfigDraft(currentConfigContent.content || "");
  }, [currentConfigContent]);

  useEffect(() => {
    if (!templateDialogOpen) {
      setTemplateDraft("");
      return;
    }

    void refetchTemplate();
  }, [templateDialogOpen, refetchTemplate]);

  useEffect(() => {
    if (!templateDialogOpen) return;

    const fallbackTemplate = buildTemplateByApp(appId);
    const resolvedTemplate =
      persistedTemplate && persistedTemplate.trim()
        ? persistedTemplate
        : fallbackTemplate;
    setTemplateDraft(resolvedTemplate);
  }, [appId, persistedTemplate, templateDialogOpen]);

  const filteredProviders = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return sortedProviders;
    return sortedProviders.filter((provider) => {
      const fields = [provider.name, provider.notes, provider.websiteUrl];
      return fields.some((field) =>
        field?.toString().toLowerCase().includes(keyword),
      );
    });
  }, [searchTerm, sortedProviders]);

  const getProviderCurrentState = useCallback(
    (provider: Provider) => {
      const isOmo = provider.category === "omo";
      const isOmoSlim = provider.category === "omo-slim";
      const isHermesCurrent =
        appId === "hermes" && hermesCurrentProviderId === provider.id;

      const isCurrent = isOmo
        ? provider.id === (currentOmoId || "")
        : isOmoSlim
          ? provider.id === (currentOmoSlimId || "")
          : appId === "hermes"
            ? isHermesCurrent
            : provider.id === currentProviderId;

      return {
        isOmo,
        isOmoSlim,
        isAnyOmo: isOmo || isOmoSlim,
        isCurrent,
        isHermesCurrent,
      };
    },
    [
      appId,
      currentOmoId,
      currentOmoSlimId,
      currentProviderId,
      hermesCurrentProviderId,
    ],
  );

  const providerRowViews = useMemo<ProviderRowView[]>(() => {
    const sortedIndexMap = new Map(
      sortedProviders.map((provider, index) => [provider.id, index]),
    );

    return filteredProviders.map((provider) => {
      const { isOmo, isOmoSlim, isAnyOmo, isCurrent } =
        getProviderCurrentState(provider);
      const isInConfig = isProviderInConfig(provider.id);
      const isReadOnly =
        appId === "hermes" && isHermesReadOnlyProvider(provider.settingsConfig);
      const failoverPriority = getFailoverPriority(provider.id);

      const isEnabled = isFailoverModeActive
        ? Boolean(failoverPriority)
        : isAdditiveMode
          ? isInConfig
          : isCurrent;

      const isActiveProxyProvider =
        isFailoverModeActive && activeProviderId === provider.id;

      const orderNumber =
        failoverPriority ?? (sortedIndexMap.get(provider.id) ?? 0) + 1;

      const endpoint = normalizeOptionalUrl(
        getEndpointFromProvider(provider, appId),
      );
      const endpointWithoutV1 = stripV1Suffix(endpoint);

      const website = normalizeOptionalUrl(provider.websiteUrl);
      const nameLink = website || endpointWithoutV1 || undefined;

      const isOfficial = isOfficialProvider(provider, appId);
      const isCopilot =
        provider.meta?.providerType === PROVIDER_TYPES.GITHUB_COPILOT ||
        provider.meta?.usage_script?.templateType === "github_copilot";
      const isCodexOauth =
        provider.meta?.providerType === PROVIDER_TYPES.CODEX_OAUTH;

      const canDelete =
        !isReadOnly && (isAnyOmo || isAdditiveMode ? true : !isCurrent);

      const statusRank = isActiveProxyProvider ? 3 : isEnabled ? 2 : 1;

      return {
        provider,
        isOmo,
        isOmoSlim,
        isAnyOmo,
        isCurrent,
        isInConfig,
        isReadOnly,
        isEnabled,
        isActiveProxyProvider,
        failoverPriority,
        orderNumber,
        statusRank,
        modelDisplay: getModelDisplayByApp(provider, appId),
        endpointDisplay: endpointWithoutV1 || "-",
        nameLink,
        canDelete,
        canTest: !isOfficial && !isCopilot && !isCodexOauth,
      };
    });
  }, [
    activeProviderId,
    appId,
    filteredProviders,
    getFailoverPriority,
    getProviderCurrentState,
    isAdditiveMode,
    isFailoverModeActive,
    isProviderInConfig,
    sortedProviders,
  ]);

  const displayRows = useMemo(() => {
    if (!statusSortDirection) {
      return providerRowViews;
    }

    const sortedIndexMap = new Map(
      providerRowViews.map((row, index) => [row.provider.id, index]),
    );

    return [...providerRowViews].sort((a, b) => {
      const diff =
        statusSortDirection === "desc"
          ? b.statusRank - a.statusRank
          : a.statusRank - b.statusRank;
      if (diff !== 0) return diff;
      return (
        (sortedIndexMap.get(a.provider.id) ?? 0) -
        (sortedIndexMap.get(b.provider.id) ?? 0)
      );
    });
  }, [providerRowViews, statusSortDirection]);

  const recentSessionsForApp = useMemo(
    () => recentSessions.slice(0, 10),
    [recentSessions],
  );

  const selectedRows = useMemo(() => {
    return providerRowViews.filter((row) =>
      selectedProviderIds.has(row.provider.id),
    );
  }, [providerRowViews, selectedProviderIds]);

  const selectedCount = selectedRows.length;
  const effectiveTargetRows =
    selectedCount > 0 ? selectedRows : providerRowViews;

  const enabledCount = useMemo(
    () => providerRowViews.filter((row) => row.isEnabled).length,
    [providerRowViews],
  );

  const totalCount = providerRowViews.length;

  const allDisplayedSelected =
    displayRows.length > 0 &&
    displayRows.every((row) => selectedProviderIds.has(row.provider.id));

  const hasDisplayedSelection = displayRows.some((row) =>
    selectedProviderIds.has(row.provider.id),
  );

  const canDragRows = statusSortDirection === null && !searchTerm.trim();

  const toggleSelectAllDisplayed = (checked: boolean) => {
    setSelectedProviderIds((current) => {
      const next = new Set(current);
      if (checked) {
        displayRows.forEach((row) => next.add(row.provider.id));
      } else {
        displayRows.forEach((row) => next.delete(row.provider.id));
      }
      return next;
    });
  };

  const toggleSelectRow = (providerId: string, checked: boolean) => {
    setSelectedProviderIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(providerId);
      } else {
        next.delete(providerId);
      }
      return next;
    });
  };

  const cycleStatusSort = () => {
    setStatusSortDirection((current) => {
      if (current === null) return "desc";
      if (current === "desc") return "asc";
      return null;
    });
  };

  const handlePinToTop = async (providerId: string) => {
    const currentIndex = sortedProviders.findIndex(
      (item) => item.id === providerId,
    );
    if (currentIndex < 0) return;

    const reordered = [
      sortedProviders[currentIndex],
      ...sortedProviders.filter((item) => item.id !== providerId),
    ];

    const updates = reordered.map((item, index) => ({
      id: item.id,
      sortIndex: index,
    }));

    try {
      await providersApi.updateSortOrder(updates, appId);
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      await queryClient.invalidateQueries({
        queryKey: ["failoverQueue", appId],
      });
      await providersApi.updateTrayMenu().catch(() => undefined);
      toast.success(
        t("provider.pinnedToTop", {
          defaultValue: "已置顶到故障转移顺序 #1",
        }),
      );
    } catch (error) {
      toast.error(
        t("provider.pinToTopFailed", {
          defaultValue: "置顶失败",
        }),
      );
      console.error("Failed to pin provider to top", error);
    }
  };

  const applyBulkEnableState = async (enabled: boolean) => {
    if (effectiveTargetRows.length === 0) return;

    if (!(isFailoverModeActive || isAdditiveMode)) {
      toast.info(
        t("provider.bulkToggleUnsupported", {
          defaultValue: "当前模式不支持批量启用/禁用",
        }),
      );
      return;
    }

    setIsBulkOperating(true);
    let success = 0;
    let failed = 0;

    for (const row of effectiveTargetRows) {
      try {
        if (isFailoverModeActive) {
          if (enabled && !row.failoverPriority) {
            await addToQueue.mutateAsync({
              appType: appId,
              providerId: row.provider.id,
            });
          }
          if (!enabled && row.failoverPriority) {
            await removeFromQueue.mutateAsync({
              appType: appId,
              providerId: row.provider.id,
            });
          }
        } else if (isAdditiveMode) {
          if (enabled && !row.isInConfig) {
            await providersApi.switch(row.provider.id, appId);
          }
          if (!enabled && row.isInConfig) {
            await providersApi.removeFromLiveConfig(row.provider.id, appId);
          }
        }
        success += 1;
      } catch (error) {
        failed += 1;
        console.error("Bulk toggle provider failed", row.provider.id, error);
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
    await queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });

    if (appId === "opencode") {
      await queryClient.invalidateQueries({
        queryKey: ["opencodeLiveProviderIds"],
      });
    }
    if (appId === "openclaw") {
      await queryClient.invalidateQueries({
        queryKey: openclawKeys.liveProviderIds,
      });
      await queryClient.invalidateQueries({ queryKey: openclawKeys.health });
    }
    if (appId === "hermes") {
      await queryClient.invalidateQueries({
        queryKey: hermesKeys.liveProviderIds,
      });
    }

    await providersApi.updateTrayMenu().catch(() => undefined);

    setIsBulkOperating(false);

    if (success > 0) {
      toast.success(
        t("provider.bulkToggleSuccess", {
          defaultValue: "批量操作完成：成功 {{success}} 项",
          success,
        }),
      );
    }

    if (failed > 0) {
      toast.warning(
        t("provider.bulkToggleFailed", {
          defaultValue: "有 {{failed}} 项操作失败",
          failed,
        }),
      );
    }
  };

  const executeBulkDelete = async () => {
    if (selectedRows.length === 0) {
      setShowBulkDeleteConfirm(false);
      return;
    }

    setIsBulkOperating(true);
    let success = 0;
    let failed = 0;

    for (const row of selectedRows) {
      if (!row.canDelete) {
        failed += 1;
        continue;
      }

      try {
        await providersApi.delete(row.provider.id, appId);
        success += 1;
      } catch (error) {
        failed += 1;
        console.error("Bulk delete failed", row.provider.id, error);
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
    await queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });

    if (appId === "opencode") {
      await queryClient.invalidateQueries({
        queryKey: ["opencodeLiveProviderIds"],
      });
    }
    if (appId === "openclaw") {
      await queryClient.invalidateQueries({
        queryKey: openclawKeys.liveProviderIds,
      });
      await queryClient.invalidateQueries({ queryKey: openclawKeys.health });
    }
    if (appId === "hermes") {
      await queryClient.invalidateQueries({
        queryKey: hermesKeys.liveProviderIds,
      });
    }

    await providersApi.updateTrayMenu().catch(() => undefined);

    setSelectedProviderIds(new Set());
    setIsBulkOperating(false);
    setShowBulkDeleteConfirm(false);

    if (success > 0) {
      toast.success(
        t("provider.bulkDeleteSuccess", {
          defaultValue: "已删除 {{count}} 个供应商",
          count: success,
        }),
      );
    }

    if (failed > 0) {
      toast.warning(
        t("provider.bulkDeleteFailed", {
          defaultValue: "{{count}} 个供应商删除失败或不可删",
          count: failed,
        }),
      );
    }
  };

  const handleResumeSession = async (session: SessionMeta) => {
    if (!session.resumeCommand) return;

    try {
      await sessionsApi.launchTerminal({
        command: session.resumeCommand,
        cwd: session.projectDir ?? undefined,
      });
      toast.success(
        t("sessionManager.terminalLaunched", {
          defaultValue: "终端已打开",
        }),
      );
    } catch (error) {
      let copied = false;
      try {
        await navigator.clipboard.writeText(session.resumeCommand);
        copied = true;
        toast.info(
          t("sessionManager.resumeFallbackCopied", {
            defaultValue: "启动失败，恢复命令已复制到剪贴板",
          }),
        );
      } catch {}

      console.error("Failed to launch session terminal", error);
      if (!copied) {
        toast.error(
          t("sessionManager.openFailed", {
            defaultValue: "打开终端失败",
          }),
        );
      }
    }
  };

  const saveCurrentConfig = async () => {
    if (!selectedConfigFileKey) return;
    setIsSavingConfig(true);

    try {
      await configApi.writeAppConfigFile({
        appId,
        fileKey: selectedConfigFileKey,
        content: currentConfigDraft,
      });
      await refetchCurrentConfig();
      toast.success(
        t("provider.currentConfigSaved", {
          defaultValue: "当前配置已保存",
        }),
      );
    } catch (error) {
      console.error("Failed to save current config", error);
      toast.error(
        t("provider.currentConfigSaveFailed", {
          defaultValue: "保存当前配置失败",
        }),
      );
    } finally {
      setIsSavingConfig(false);
    }
  };

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(
        templateDraft || buildTemplateByApp(appId),
      );
      toast.success(
        t("provider.templateCopied", {
          defaultValue: "配置模板已复制",
        }),
      );
    } catch (error) {
      console.error("Failed to copy template", error);
      toast.error(
        t("provider.templateCopyFailed", {
          defaultValue: "复制模板失败",
        }),
      );
    }
  };

  const saveTemplate = async () => {
    setIsSavingTemplate(true);
    try {
      await configApi.setAppConfigTemplate({
        appId,
        template: templateDraft,
      });
      await queryClient.invalidateQueries({
        queryKey: ["appConfigTemplate", appId],
      });
      toast.success(
        t("provider.templateSaved", {
          defaultValue: "配置模板已保存",
        }),
      );
    } catch (error) {
      console.error("Failed to save template", error);
      toast.error(
        t("provider.templateSaveFailed", {
          defaultValue: "保存配置模板失败",
        }),
      );
    } finally {
      setIsSavingTemplate(false);
    }
  };

  const handleRowEnableToggle = async (row: ProviderRowView) => {
    if (isFailoverModeActive) {
      try {
        if (row.failoverPriority) {
          await removeFromQueue.mutateAsync({
            appType: appId,
            providerId: row.provider.id,
          });
        } else {
          await addToQueue.mutateAsync({
            appType: appId,
            providerId: row.provider.id,
          });
        }
      } catch (error) {
        console.error("Failed to toggle failover queue", error);
      }
      return;
    }

    if (isAdditiveMode) {
      try {
        if (row.isInConfig) {
          await providersApi.removeFromLiveConfig(row.provider.id, appId);
          await queryClient.invalidateQueries({
            queryKey: ["providers", appId],
          });
          await queryClient.invalidateQueries({
            queryKey: ["failoverQueue", appId],
          });
        } else {
          await providersApi.switch(row.provider.id, appId);
          await queryClient.invalidateQueries({
            queryKey: ["providers", appId],
          });
          await queryClient.invalidateQueries({
            queryKey: ["failoverQueue", appId],
          });
        }
      } catch (error) {
        console.error("Failed to toggle config state", error);
      }
      return;
    }

    if (row.isCurrent) {
      toast.info(
        t("provider.disableCurrentUnsupported", {
          defaultValue: "当前供应商无法直接禁用，请先切换到其他供应商",
        }),
      );
      return;
    }

    onSwitch(row.provider);
  };

  const safeHandleDragEnd = (event: any) => {
    if (!canDragRows) return;
    void handleDragEnd(event);
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="w-full border border-dashed rounded-lg h-20 border-muted-foreground/40 bg-muted/40"
          />
        ))}
      </div>
    );
  }

  if (sortedProviders.length === 0) {
    return (
      <ProviderEmptyState
        appId={appId}
        onCreate={onCreate}
        onImport={() => importMutation.mutate()}
      />
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {sortedProviders.length > 1 && (
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={handleBatchTest}
            disabled={isBatchTesting}
            className="gap-2"
            title={t("streamCheck.testAll", { defaultValue: "批量测试" })}
          >
            <TestTube2 className="h-4 w-4" />
            {isBatchTesting
              ? t("streamCheck.batchRunning", { defaultValue: "测试中…" })
              : t("streamCheck.testAll", { defaultValue: "批量测试" })}
          </Button>
        </div>
      )}

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

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border-default bg-card/60 px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => void applyBulkEnableState(true)}
          disabled={
            isBulkOperating ||
            !(isFailoverModeActive || isAdditiveMode) ||
            effectiveTargetRows.length === 0
          }
        >
          {t("provider.bulkEnable", { defaultValue: "全部启用" })}
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => void applyBulkEnableState(false)}
          disabled={
            isBulkOperating ||
            !(isFailoverModeActive || isAdditiveMode) ||
            effectiveTargetRows.length === 0
          }
        >
          {t("provider.bulkDisable", { defaultValue: "全部禁用" })}
        </Button>

        <Badge variant="secondary" className="h-7 px-2 text-xs font-mono">
          {enabledCount}/{totalCount}
        </Badge>

        <Button
          size="sm"
          variant="outline"
          className={cn(
            "h-7 text-xs",
            selectedCount > 0 && "text-red-600 border-red-500/30",
          )}
          onClick={() => setShowBulkDeleteConfirm(true)}
          disabled={selectedCount === 0 || isBulkOperating}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          {t("common.delete", { defaultValue: "删除" })}
          {selectedCount > 0 ? ` (${selectedCount})` : ""}
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={
                recentSessionsForApp.length === 0 && !isRecentSessionsLoading
              }
            >
              <History className="h-3.5 w-3.5 mr-1" />
              {t("provider.recentSessions", { defaultValue: "最近会话" })}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[26rem] p-0" align="start">
            <div className="border-b px-3 py-2 text-sm font-medium">
              {t("provider.recentSessionsTitle", {
                defaultValue: "最近 10 条会话",
              })}
            </div>
            <ScrollArea className="max-h-72">
              {isRecentSessionsLoading ? (
                <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("common.loading", { defaultValue: "加载中..." })}
                </div>
              ) : recentSessionsForApp.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">
                  {t("provider.noRecentSessions", {
                    defaultValue: "暂无最近会话",
                  })}
                </div>
              ) : (
                <div className="divide-y divide-border-default">
                  {recentSessionsForApp.map((session) => {
                    const title =
                      session.title ||
                      session.projectDir
                        ?.split(/[\\/]/)
                        .filter(Boolean)
                        .pop() ||
                      session.sessionId.slice(0, 8);
                    return (
                      <button
                        key={`${session.providerId}:${session.sessionId}:${session.sourcePath || ""}`}
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void handleResumeSession(session)}
                        disabled={!session.resumeCommand}
                      >
                        <div className="text-xs font-medium truncate">
                          {title}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate font-mono">
                          {session.projectDir || session.resumeCommand || "-"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </PopoverContent>
        </Popover>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setTemplateDialogOpen(true)}
        >
          <FileText className="h-3.5 w-3.5 mr-1" />
          {t("provider.configTemplate", { defaultValue: "配置模板" })}
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setCurrentConfigDialogOpen(true)}
        >
          <FileText className="h-3.5 w-3.5 mr-1" />
          {t("provider.currentConfig", { defaultValue: "当前配置" })}
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs ml-auto"
          onClick={() => setIsSearchOpen((value) => !value)}
        >
          <Search className="h-3.5 w-3.5 mr-1" />
          {t("provider.search", { defaultValue: "搜索" })}
        </Button>
      </div>

      {displayRows.length === 0 ? (
        <div className="px-6 py-8 text-sm text-center border border-dashed rounded-lg border-border text-muted-foreground">
          {t("provider.noSearchResults", {
            defaultValue: "No providers match your search.",
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-border-default overflow-hidden">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={safeHandleDragEnd}
          >
            <SortableContext
              items={displayRows.map((row) => row.provider.id)}
              strategy={verticalListSortingStrategy}
            >
              <Table className="text-xs">
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="h-9 w-[34px] px-2">
                      <Checkbox
                        checked={
                          allDisplayedSelected
                            ? true
                            : hasDisplayedSelection
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(checked) =>
                          toggleSelectAllDisplayed(Boolean(checked))
                        }
                        aria-label={t("provider.selectAll", {
                          defaultValue: "全选",
                        })}
                      />
                    </TableHead>
                    <TableHead className="h-9 w-[86px] px-2 text-center">
                      {t("provider.priority", { defaultValue: "序号" })}
                    </TableHead>
                    <TableHead className="h-9 min-w-[180px] px-2">
                      {t("provider.name", { defaultValue: "供应商名称" })}
                    </TableHead>
                    <TableHead className="h-9 min-w-[120px] px-2">
                      {t("provider.notes", { defaultValue: "备注" })}
                    </TableHead>
                    <TableHead className="h-9 min-w-[150px] px-2">
                      {t("provider.modelName", { defaultValue: "模型名称" })}
                    </TableHead>
                    <TableHead className="h-9 w-[130px] px-2 text-center">
                      <button
                        type="button"
                        onClick={cycleStatusSort}
                        className="inline-flex items-center justify-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        {t("provider.status", { defaultValue: "状态" })}
                        {statusSortDirection === null ? (
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        ) : statusSortDirection === "desc" ? (
                          <ArrowDown className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowUp className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </TableHead>
                    <TableHead className="h-9 min-w-[280px] px-2 text-center">
                      {t("common.actions", { defaultValue: "操作" })}
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {displayRows.map((row) => (
                    <SortableProviderTableRow
                      key={row.provider.id}
                      row={row}
                      canDragRows={canDragRows}
                      isSelected={selectedProviderIds.has(row.provider.id)}
                      onSelectedChange={(checked) =>
                        toggleSelectRow(row.provider.id, checked)
                      }
                      onOpenWebsite={onOpenWebsite}
                      onToggleEnabled={() => void handleRowEnableToggle(row)}
                      onPinToTop={() => void handlePinToTop(row.provider.id)}
                      onOpenTerminal={
                        onOpenTerminal
                          ? () => onOpenTerminal(row.provider)
                          : undefined
                      }
                      onEdit={() => onEdit(row.provider)}
                      onDuplicate={() => onDuplicate(row.provider)}
                      onTest={
                        row.canTest ? () => handleTest(row.provider) : undefined
                      }
                      isTesting={isChecking(row.provider.id)}
                      onDelete={
                        row.canDelete ? () => onDelete(row.provider) : undefined
                      }
                      onConfigureUsage={
                        onConfigureUsage
                          ? () => onConfigureUsage(row.provider)
                          : undefined
                      }
                      canSetDefault={
                        (appId === "openclaw" || appId === "hermes") &&
                        row.isInConfig &&
                        Boolean(onSetAsDefault)
                      }
                      isDefaultModel={
                        appId === "hermes"
                          ? row.isCurrent
                          : isProviderDefaultModel(row.provider.id)
                      }
                      onSetAsDefault={
                        onSetAsDefault
                          ? () => onSetAsDefault(row.provider)
                          : undefined
                      }
                      t={t}
                    />
                  ))}
                </TableBody>
              </Table>
            </SortableContext>
          </DndContext>
        </div>
      )}

      <ConfirmDialog
        isOpen={showStreamCheckConfirm}
        variant="info"
        title={t("confirm.streamCheck.title")}
        message={t("confirm.streamCheck.message")}
        confirmText={t("confirm.streamCheck.confirm")}
        onConfirm={() => void handleStreamCheckConfirm()}
        onCancel={() => {
          setShowStreamCheckConfirm(false);
          setPendingTestProvider(null);
        }}
      />

      <ConfirmDialog
        isOpen={showBulkDeleteConfirm}
        variant="destructive"
        title={t("provider.bulkDeleteTitle", {
          defaultValue: "批量删除供应商",
        })}
        message={t("provider.bulkDeleteMessage", {
          defaultValue:
            "将删除已选中的 {{count}} 个供应商。\n\n此操作不可撤销。",
          count: selectedCount,
        })}
        confirmText={t("provider.bulkDeleteAction", {
          defaultValue: "确认删除",
        })}
        onConfirm={() => void executeBulkDelete()}
        onCancel={() => {
          if (!isBulkOperating) {
            setShowBulkDeleteConfirm(false);
          }
        }}
      />

      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {t("provider.configTemplate", { defaultValue: "配置模板" })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {appId === "gemini"
                ? t("provider.configTemplateHintGemini", {
                    defaultValue:
                      "Gemini 模板支持 {providerConfig}（.env）、{settingsConfig}（settings.json 其他字段）与 {mcpConfig}（mcpServers）。",
                  })
                : t("provider.configTemplateHint", {
                    defaultValue:
                      "模板中保留 {providerConfig} 与 {mcpConfig} 占位符，便于按应用注入实际配置。",
                  })}
            </p>
            <Textarea
              value={templateDraft}
              onChange={(event) => setTemplateDraft(event.target.value)}
              rows={16}
              className="font-mono text-xs"
              placeholder={buildTemplateByApp(appId)}
              disabled={isTemplateFetching || isSavingTemplate}
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTemplateDraft(buildTemplateByApp(appId))}
                disabled={isSavingTemplate}
              >
                {t("provider.resetTemplate", {
                  defaultValue: "恢复默认模板",
                })}
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copyTemplate()}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  {t("common.copy", { defaultValue: "复制" })}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void saveTemplate()}
                  disabled={isTemplateFetching || isSavingTemplate}
                >
                  {isSavingTemplate
                    ? t("common.saving", { defaultValue: "保存中..." })
                    : t("common.save", { defaultValue: "保存" })}
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {appId === "gemini"
                ? t("provider.templateEffectHintGemini", {
                    defaultValue:
                      "当前版本会在 Gemini 实际写入时同时渲染 .env 与 settings.json，并自动覆盖 mcpServers。",
                  })
                : t("provider.templateEffectHint", {
                    defaultValue:
                      "当前版本会在 Codex 实际写入时应用该模板；其他应用先按现有稳定逻辑写入。",
                  })}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={currentConfigDialogOpen}
        onOpenChange={setCurrentConfigDialogOpen}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {t("provider.currentConfig", { defaultValue: "当前配置" })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={selectedConfigFileKey}
                onValueChange={setSelectedConfigFileKey}
                disabled={isConfigFilesFetching || configFiles.length === 0}
              >
                <SelectTrigger className="w-[320px] h-8 text-xs">
                  <SelectValue
                    placeholder={t("provider.selectConfigFile", {
                      defaultValue: "选择配置文件",
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {configFiles.map((file: AppConfigFileEntry) => (
                    <SelectItem
                      key={file.key}
                      value={file.key}
                      className="text-xs"
                    >
                      {file.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => void refetchCurrentConfig()}
                disabled={!selectedConfigFileKey || isCurrentConfigLoading}
              >
                {t("common.refresh", { defaultValue: "刷新" })}
              </Button>

              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={() => void saveCurrentConfig()}
                disabled={
                  !selectedConfigFileKey ||
                  isCurrentConfigLoading ||
                  isSavingConfig
                }
              >
                {isSavingConfig
                  ? t("common.saving", { defaultValue: "保存中..." })
                  : t("common.save", { defaultValue: "保存" })}
              </Button>
            </div>

            {selectedConfigFileKey && currentConfigContent?.path && (
              <p className="text-[11px] text-muted-foreground font-mono break-all">
                {currentConfigContent.path}
              </p>
            )}

            <Textarea
              value={currentConfigDraft}
              onChange={(event) => setCurrentConfigDraft(event.target.value)}
              rows={20}
              className="font-mono text-xs"
              placeholder={t("provider.currentConfigPlaceholder", {
                defaultValue: "配置文件内容为空",
              })}
              disabled={!selectedConfigFileKey || isCurrentConfigLoading}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface SortableProviderTableRowProps {
  row: ProviderRowView;
  canDragRows: boolean;
  isSelected: boolean;
  onSelectedChange: (checked: boolean) => void;
  onOpenWebsite: (url: string) => void;
  onToggleEnabled: () => void;
  onPinToTop: () => void;
  onOpenTerminal?: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onTest?: () => void;
  isTesting: boolean;
  onDelete?: () => void;
  onConfigureUsage?: () => void;
  canSetDefault: boolean;
  isDefaultModel: boolean;
  onSetAsDefault?: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function SortableProviderTableRow({
  row,
  canDragRows,
  isSelected,
  onSelectedChange,
  onOpenWebsite,
  onToggleEnabled,
  onPinToTop,
  onOpenTerminal,
  onEdit,
  onDuplicate,
  onTest,
  isTesting,
  onDelete,
  onConfigureUsage,
  canSetDefault,
  isDefaultModel,
  onSetAsDefault,
  t,
}: SortableProviderTableRowProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.provider.id,
    disabled: !canDragRows,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const canOpenNameLink = Boolean(
    row.nameLink && /^https?:\/\//i.test(row.nameLink),
  );

  const statusLabel = row.isActiveProxyProvider
    ? t("provider.currentProxy", { defaultValue: "当前代理" })
    : row.isEnabled
      ? t("provider.enabled", { defaultValue: "启用" })
      : t("provider.disabled", { defaultValue: "禁用" });

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      className={cn(
        "h-12",
        isDragging && "bg-muted/70",
        row.isActiveProxyProvider && "bg-emerald-500/5",
      )}
    >
      <TableCell className="px-2 py-1">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelectedChange(Boolean(checked))}
          aria-label={t("provider.select", { defaultValue: "选择" })}
        />
      </TableCell>

      <TableCell className="px-2 py-1">
        <div className="flex items-center justify-center gap-1 font-mono text-[11px]">
          <button
            type="button"
            className={cn(
              "rounded p-1 text-muted-foreground hover:text-foreground",
              !canDragRows && "opacity-40 cursor-not-allowed",
            )}
            aria-label={
              canDragRows
                ? t("provider.dragToSort", { defaultValue: "拖拽排序" })
                : t("provider.dragDisabledHint", {
                    defaultValue: "请清空搜索并关闭状态排序后再拖拽",
                  })
            }
            title={
              canDragRows
                ? t("provider.dragToSort", { defaultValue: "拖拽排序" })
                : t("provider.dragDisabledHint", {
                    defaultValue: "请清空搜索并关闭状态排序后再拖拽",
                  })
            }
            disabled={!canDragRows}
            {...(canDragRows ? attributes : {})}
            {...(canDragRows ? listeners : {})}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <span>{row.orderNumber}</span>
        </div>
      </TableCell>

      <TableCell className="px-2 py-1">
        <div className="flex items-center gap-2 min-w-0">
          <ProviderIcon
            icon={row.provider.icon}
            name={row.provider.name}
            color={row.provider.iconColor}
            size={16}
          />
          <div className="min-w-0">
            {canOpenNameLink && row.nameLink ? (
              <button
                type="button"
                onClick={() => onOpenWebsite(row.nameLink!)}
                className="text-left font-medium text-blue-600 hover:underline dark:text-blue-400 truncate max-w-[280px]"
                title={row.nameLink}
              >
                {row.provider.name}
              </button>
            ) : (
              <div
                className="font-medium truncate max-w-[280px]"
                title={row.provider.name}
              >
                {row.provider.name}
              </div>
            )}
            {!row.provider.websiteUrl && row.endpointDisplay !== "-" && (
              <div
                className="text-[11px] text-muted-foreground truncate max-w-[280px]"
                title={row.endpointDisplay}
              >
                {row.endpointDisplay}
              </div>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell className="px-2 py-1">
        <div
          className="truncate max-w-[220px]"
          title={row.provider.notes || ""}
        >
          {row.provider.notes || "-"}
        </div>
      </TableCell>

      <TableCell className="px-2 py-1">
        <div
          className="truncate max-w-[260px] font-mono text-[11px]"
          title={row.modelDisplay}
        >
          {row.modelDisplay}
        </div>
      </TableCell>

      <TableCell className="px-2 py-1 text-center">
        <div className="inline-flex items-center gap-1 flex-wrap justify-center">
          <Badge
            variant={row.isEnabled ? "default" : "secondary"}
            className={cn(
              "text-[10px] px-1.5 h-5",
              row.isActiveProxyProvider &&
                "bg-emerald-600 hover:bg-emerald-600",
            )}
          >
            {statusLabel}
          </Badge>
          {row.failoverPriority ? (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 h-5 font-mono"
            >
              P{row.failoverPriority}
            </Badge>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="px-2 py-1">
        <div className="flex items-center justify-center gap-1.5">
          {canSetDefault && onSetAsDefault && (
            <Button
              size="sm"
              variant={isDefaultModel ? "secondary" : "outline"}
              className={cn(
                "h-7 px-2 text-xs",
                isDefaultModel && "opacity-70 cursor-not-allowed",
              )}
              onClick={isDefaultModel ? undefined : onSetAsDefault}
              disabled={isDefaultModel}
              title={
                isDefaultModel
                  ? t("provider.isDefault", { defaultValue: "当前默认" })
                  : t("provider.setAsDefault", { defaultValue: "设为默认" })
              }
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
          )}

          <Button
            size="sm"
            variant={row.isEnabled ? "secondary" : "default"}
            className="h-7 px-2 text-xs"
            onClick={onToggleEnabled}
            title={
              row.isEnabled
                ? t("provider.disable", { defaultValue: "禁用" })
                : t("provider.enable", { defaultValue: "启用" })
            }
          >
            <Play className="h-3.5 w-3.5" />
            {row.isEnabled
              ? t("provider.disable", { defaultValue: "禁用" })
              : t("provider.enable", { defaultValue: "启用" })}
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onPinToTop}
            aria-label={t("provider.pinToTop", {
              defaultValue: "置顶（顺序 1）",
            })}
            title={t("provider.pinToTop", { defaultValue: "置顶（顺序 1）" })}
          >
            <Pin className="h-3.5 w-3.5" />
          </Button>

          {onOpenTerminal && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onOpenTerminal}
              aria-label={t("provider.openTerminal", {
                defaultValue: "打开终端",
              })}
              title={t("provider.openTerminal", { defaultValue: "打开终端" })}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
          )}

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onEdit}
            aria-label={t("common.edit", { defaultValue: "编辑" })}
            title={t("common.edit", { defaultValue: "编辑" })}
            disabled={row.isReadOnly}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onDuplicate}
            aria-label={t("provider.duplicate", { defaultValue: "复制" })}
            title={t("provider.duplicate", { defaultValue: "复制" })}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onTest}
            aria-label={t("modelTest.testProvider", { defaultValue: "测试" })}
            title={t("modelTest.testProvider", { defaultValue: "测试" })}
            disabled={!onTest || isTesting}
          >
            {isTesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TestTube2 className="h-3.5 w-3.5" />
            )}
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onDelete}
            aria-label={t("common.delete", { defaultValue: "删除" })}
            title={t("common.delete", { defaultValue: "删除" })}
            disabled={!onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>

          {onConfigureUsage && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={onConfigureUsage}
              title={t("provider.configureUsage", {
                defaultValue: "用量配置",
              })}
            >
              {t("provider.configureUsage", {
                defaultValue: "用量",
              })}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
