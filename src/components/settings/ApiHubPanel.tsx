import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Eraser,
  ExternalLink,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiHubApi } from "@/lib/api";
import { buildApiHubSettingsConfigs } from "@/config/apiHubTemplates";
import type { AppId } from "@/lib/api/types";
import type {
  ApiHubAccountsBackup,
  ApiHubGroupInfo,
  ApiHubModelCandidateRow,
  ApiHubModelInfo,
  ApiHubModelSelection,
  ApiHubSiteDetail,
  ApiHubSiteRow,
} from "@/types/apiHub";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZES = [10, 20, 50] as const;
const SITE_TYPE_OPTIONS = [
  { value: "all", label: "全部协议" },
  { value: "new-api", label: "new-api" },
  { value: "one-hub", label: "one-hub" },
  { value: "done-hub", label: "done-hub" },
  { value: "sub2api", label: "sub2api" },
] as const;
const CHANGE_FILTER_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "changed", label: "有变更" },
  { value: "needs_review", label: "已导入且有变更" },
  { value: "unsynced", label: "未同步" },
  { value: "not_aligned", label: "未对齐" },
] as const;
const TARGET_APPS: Array<{ id: AppId; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "opencode", label: "OpenCode" },
  { id: "openclaw", label: "OpenClaw" },
  { id: "hermes", label: "Hermes" },
];
const APP_LABELS = new Map(TARGET_APPS.map((app) => [app.id, app.label]));
type SiteSortBy =
  | "site_type"
  | "site_name"
  | "group_count"
  | "model_count"
  | "token_count"
  | "last_synced_at"
  | "last_change_at"
  | "imported_apps";
type SortDirection = "asc" | "desc";
type AppModelSelections = Partial<Record<AppId, string[]>>;
type AppNoDefaultSelections = Partial<Record<AppId, boolean>>;
type AppCollapsedGroups = Partial<Record<AppId, string[]>>;
type ConfirmAction = "clear" | "delete" | "cleanup" | "cleanup_batch";
interface PendingConfirm {
  action: ConfirmAction;
  site?: ApiHubSiteRow;
  siteIds?: string[];
}
interface ApiHubPanelPersistedState {
  searchInput: string;
  search: string;
  modelFilterInput: string;
  modelFilter: string;
  siteTypeFilter: string;
  changeFilter: string;
  sortBy: SiteSortBy;
  sortDirection: SortDirection;
  page: number;
  pageSize: number;
  selectedSiteIds: string[];
}

const API_HUB_PANEL_STATE_KEY = "cc-switch-api-hub-panel-state";
const DEFAULT_PANEL_STATE: ApiHubPanelPersistedState = {
  searchInput: "",
  search: "",
  modelFilterInput: "",
  modelFilter: "",
  siteTypeFilter: "all",
  changeFilter: "all",
  sortBy: "site_type",
  sortDirection: "asc",
  page: 1,
  pageSize: 20,
  selectedSiteIds: [],
};

function loadPanelState(): ApiHubPanelPersistedState {
  if (typeof window === "undefined") return DEFAULT_PANEL_STATE;
  try {
    const raw = window.sessionStorage.getItem(API_HUB_PANEL_STATE_KEY);
    if (!raw) return DEFAULT_PANEL_STATE;
    const parsed = JSON.parse(raw) as Partial<ApiHubPanelPersistedState>;
    const sortBy = (
      [
        "site_type",
        "site_name",
        "group_count",
        "model_count",
        "token_count",
        "last_synced_at",
        "last_change_at",
        "imported_apps",
      ] as SiteSortBy[]
    ).includes(parsed.sortBy as SiteSortBy)
      ? (parsed.sortBy as SiteSortBy)
      : DEFAULT_PANEL_STATE.sortBy;
    const pageSize = PAGE_SIZES.includes(
      parsed.pageSize as (typeof PAGE_SIZES)[number],
    )
      ? Number(parsed.pageSize)
      : DEFAULT_PANEL_STATE.pageSize;
    return {
      searchInput:
        typeof parsed.searchInput === "string" ? parsed.searchInput : "",
      search: typeof parsed.search === "string" ? parsed.search : "",
      modelFilterInput:
        typeof parsed.modelFilterInput === "string"
          ? parsed.modelFilterInput
          : "",
      modelFilter:
        typeof parsed.modelFilter === "string" ? parsed.modelFilter : "",
      siteTypeFilter:
        typeof parsed.siteTypeFilter === "string"
          ? parsed.siteTypeFilter
          : DEFAULT_PANEL_STATE.siteTypeFilter,
      changeFilter:
        typeof parsed.changeFilter === "string"
          ? parsed.changeFilter
          : DEFAULT_PANEL_STATE.changeFilter,
      sortBy,
      sortDirection: parsed.sortDirection === "desc" ? "desc" : "asc",
      page:
        typeof parsed.page === "number" && parsed.page > 0
          ? parsed.page
          : DEFAULT_PANEL_STATE.page,
      pageSize,
      selectedSiteIds: Array.isArray(parsed.selectedSiteIds)
        ? parsed.selectedSiteIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
    };
  } catch {
    return DEFAULT_PANEL_STATE;
  }
}

function selectionKey(selection: ApiHubModelSelection): string {
  return `${selection.group}::${selection.model}`;
}

function parseSelectionKey(key: string): ApiHubModelSelection {
  const [group, ...modelParts] = key.split("::");
  return { group, model: modelParts.join("::") };
}

function candidateKey(candidate: ApiHubModelCandidateRow): string {
  return `${candidate.site_id}::${candidate.group}::${candidate.model}`;
}

function candidateToSiteRow(candidate: ApiHubModelCandidateRow): ApiHubSiteRow {
  return {
    id: candidate.site_id,
    site_name: candidate.site_name,
    site_url: candidate.site_url,
    site_type: candidate.site_type,
    exchange_rate: 1,
    imported_apps: candidate.imported_apps,
    sort_index: 0,
    group_count: 0,
    aligned_group_count: candidate.is_aligned ? 1 : 0,
    is_aligned: candidate.is_aligned,
    model_count: 0,
    token_count: candidate.has_api_key ? 1 : 0,
  };
}

function formatGroupRatio(ratio?: number | null): string {
  if (ratio === null || ratio === undefined) return "倍率 -";
  return `倍率 ${Number.isInteger(ratio) ? ratio : ratio.toFixed(2)}`;
}

function importedAppsText(site: ApiHubSiteRow): string {
  const apps = site.imported_apps ?? [];
  if (apps.length === 0) return "未导入";
  return `已导入：${apps
    .map((app) => APP_LABELS.get(app as AppId) ?? app)
    .join(" / ")}`;
}

function siteTypeClass(siteType: string, hasError: boolean): string {
  if (hasError) return "border-red-500/40 bg-red-500/10 text-red-700";
  switch (siteType.toLowerCase()) {
    case "new-api":
    case "newapi":
    case "one-api":
    case "oneapi":
    case "one-hub":
    case "onehub":
    case "done-hub":
    case "donehub":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700";
    case "sub2api":
    case "sub2-api":
      return "border-violet-500/40 bg-violet-500/10 text-violet-700";
    default:
      return "border-muted-foreground/30 bg-muted text-muted-foreground";
  }
}

function changeStatusClass(site: ApiHubSiteRow): string {
  if (site.last_change_summary) {
    return (site.imported_apps ?? []).length > 0
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
      : "border-sky-500/40 bg-sky-500/10 text-sky-700";
  }
  if (site.last_checked_at) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
  }
  return "border-muted-foreground/30 bg-muted text-muted-foreground";
}

function changeStatusText(site: ApiHubSiteRow): string {
  if (site.last_change_summary) return site.last_change_summary;
  if (site.last_checked_at) return "无变更";
  return "未检查";
}

function formatSyncTime(value?: number | null): string {
  if (!value) return "未同步";
  let timestamp = value;
  if (timestamp > 10_000_000_000_000_000) {
    timestamp = Math.floor(timestamp / 1_000_000);
  } else if (timestamp > 10_000_000_000_000) {
    timestamp = Math.floor(timestamp / 1_000);
  } else if (timestamp < 10_000_000_000) {
    timestamp *= 1000;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "未同步";
  return date.toLocaleString();
}

function selectNoDefaultGroup(
  groupedModels: Array<{ group: ApiHubGroupInfo; models: ApiHubModelInfo[] }>,
): string {
  return (
    groupedModels.find(({ group }) => group.name === "default")?.group.name ??
    groupedModels[0]?.group.name ??
    "default"
  );
}

function isPlainApiKey(value?: string | null): boolean {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && !trimmed.includes("*");
}

function modelsByGroup(detail?: ApiHubSiteDetail): Array<{
  group: ApiHubGroupInfo;
  models: ApiHubModelInfo[];
}> {
  if (!detail) return [];
  return detail.groups
    .map((group) => ({
      group,
      models: detail.models.filter((model) => {
        if (!model.enable_groups || model.enable_groups.length === 0)
          return true;
        return model.enable_groups.includes(group.name);
      }),
    }))
    .filter(({ models }) => models.length > 0);
}

export function ApiHubPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const initialPanelStateRef = useRef<ApiHubPanelPersistedState | null>(null);
  if (!initialPanelStateRef.current) {
    initialPanelStateRef.current = loadPanelState();
  }
  const initialPanelState = initialPanelStateRef.current;
  const [searchInput, setSearchInput] = useState(initialPanelState.searchInput);
  const [search, setSearch] = useState(initialPanelState.search);
  const [modelFilterInput, setModelFilterInput] = useState(
    initialPanelState.modelFilterInput,
  );
  const [modelFilter, setModelFilter] = useState(initialPanelState.modelFilter);
  const [siteTypeFilter, setSiteTypeFilter] = useState(
    initialPanelState.siteTypeFilter,
  );
  const [changeFilter, setChangeFilter] = useState(
    initialPanelState.changeFilter,
  );
  const [sortBy, setSortBy] = useState<SiteSortBy>(initialPanelState.sortBy);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    initialPanelState.sortDirection,
  );
  const [page, setPage] = useState(initialPanelState.page);
  const [pageSize, setPageSize] = useState<number>(initialPanelState.pageSize);
  const [selectedSiteIds, setSelectedSiteIds] = useState<Set<string>>(
    () => new Set(initialPanelState.selectedSiteIds),
  );
  const [selectedCandidateKeys, setSelectedCandidateKeys] = useState<
    Set<string>
  >(() => new Set());
  const [importSite, setImportSite] = useState<ApiHubSiteRow | null>(null);
  const [targetApps, setTargetApps] = useState<Set<AppId>>(() => new Set());
  const [activeTargetApp, setActiveTargetApp] = useState<AppId>("claude");
  const [selectedModelsByApp, setSelectedModelsByApp] =
    useState<AppModelSelections>(() => ({}));
  const [noDefaultByApp, setNoDefaultByApp] = useState<AppNoDefaultSelections>(
    () => ({}),
  );
  const [collapsedGroupsByApp, setCollapsedGroupsByApp] =
    useState<AppCollapsedGroups>(() => ({}));
  const [modelSearch, setModelSearch] = useState("");
  const [markAsImported, setMarkAsImported] = useState(true);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );
  const [syncingSiteIds, setSyncingSiteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [aligningSiteIds, setAligningSiteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [checkingSiteIds, setCheckingSiteIds] = useState<Set<string>>(
    () => new Set(),
  );

  const invalidateSites = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["apiHub", "sites"] }),
    [queryClient],
  );

  useEffect(() => {
    const state: ApiHubPanelPersistedState = {
      searchInput,
      search,
      modelFilterInput,
      modelFilter,
      siteTypeFilter,
      changeFilter,
      sortBy,
      sortDirection,
      page,
      pageSize,
      selectedSiteIds: Array.from(selectedSiteIds),
    };
    window.sessionStorage.setItem(
      API_HUB_PANEL_STATE_KEY,
      JSON.stringify(state),
    );
  }, [
    changeFilter,
    modelFilter,
    modelFilterInput,
    page,
    pageSize,
    search,
    searchInput,
    selectedSiteIds,
    siteTypeFilter,
    sortBy,
    sortDirection,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
    setModelFilter(modelFilterInput.trim());
  }, [modelFilterInput]);

  useEffect(() => {
    setPage(1);
  }, [siteTypeFilter, changeFilter, sortBy, sortDirection]);

  useEffect(() => {
    let unlistenSync: (() => void) | undefined;
    let unlistenAlign: (() => void) | undefined;
    let unlistenCheck: (() => void) | undefined;
    void apiHubApi
      .onSyncProgress((payload) => {
        setSyncingSiteIds((prev) => {
          const next = new Set(prev);
          if (payload.status === "running" || payload.status === "pending") {
            next.add(payload.site_id);
          } else {
            next.delete(payload.site_id);
          }
          return next;
        });
        if (payload.status !== "running" && payload.status !== "pending") {
          void invalidateSites();
        }
      })
      .then((unlisten) => {
        unlistenSync = unlisten;
      });
    void apiHubApi
      .onAlignProgress((payload) => {
        setAligningSiteIds((prev) => {
          const next = new Set(prev);
          if (payload.status === "running" || payload.status === "pending") {
            next.add(payload.site_id);
          } else {
            next.delete(payload.site_id);
          }
          return next;
        });
        if (payload.status !== "running" && payload.status !== "pending") {
          void invalidateSites();
        }
      })
      .then((unlisten) => {
        unlistenAlign = unlisten;
      });
    void apiHubApi
      .onCheckProgress((payload) => {
        setCheckingSiteIds((prev) => {
          const next = new Set(prev);
          if (payload.status === "running" || payload.status === "pending") {
            next.add(payload.site_id);
          } else {
            next.delete(payload.site_id);
          }
          return next;
        });
        if (payload.status !== "running" && payload.status !== "pending") {
          void invalidateSites();
        }
      })
      .then((unlisten) => {
        unlistenCheck = unlisten;
      });

    return () => {
      unlistenSync?.();
      unlistenAlign?.();
      unlistenCheck?.();
    };
  }, [invalidateSites]);

  const sitesQuery = useQuery({
    queryKey: [
      "apiHub",
      "sites",
      search,
      modelFilter,
      siteTypeFilter,
      changeFilter,
      sortBy,
      sortDirection,
      page,
      pageSize,
    ],
    queryFn: () =>
      apiHubApi.listSites({
        search: search || null,
        site_type: siteTypeFilter === "all" ? null : siteTypeFilter,
        model_search: modelFilter || null,
        change_filter: changeFilter === "all" ? null : changeFilter,
        sort_by: sortBy,
        sort_direction: sortDirection,
        page,
        page_size: pageSize,
      }),
  });

  const candidateSiteIds = useMemo(
    () => Array.from(selectedSiteIds).sort(),
    [selectedSiteIds],
  );
  const modelCandidatesQuery = useQuery({
    queryKey: [
      "apiHub",
      "modelCandidates",
      modelFilter,
      siteTypeFilter,
      candidateSiteIds,
    ],
    enabled: modelFilter.length > 0,
    queryFn: () =>
      apiHubApi.listModelCandidates({
        site_ids: candidateSiteIds,
        model_search: modelFilter,
        site_type: siteTypeFilter === "all" ? null : siteTypeFilter,
      }),
  });

  const detailQuery = useQuery({
    queryKey: ["apiHub", "siteDetail", importSite?.id],
    enabled: Boolean(importSite),
    queryFn: () => apiHubApi.getSiteDetail(importSite!.id),
  });

  const importJsonMutation = useMutation({
    mutationFn: apiHubApi.importJson,
    onSuccess: (report) => {
      toast.success(
        t("apiHub.toast.imported", {
          defaultValue: `导入完成：新增 ${report.new_count}，更新 ${report.update_count}`,
          new: report.new_count,
          updated: report.update_count,
        }),
      );
      void invalidateSites();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "导入失败");
    },
  });

  const clearMutation = useMutation({
    mutationFn: apiHubApi.clearAll,
    onSuccess: () => {
      setSelectedSiteIds(new Set());
      toast.success(
        t("apiHub.toast.cleared", { defaultValue: "已清空 Api-Hub 缓存" }),
      );
      void invalidateSites();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "清空失败");
    },
  });

  const alignMutation = useMutation({
    mutationFn: (siteIds: string[]) =>
      apiHubApi.alignSites(siteIds, {
        rename_existing: true,
        delete_extra: true,
      }),
    onSuccess: () => {
      toast.success(
        t("apiHub.toast.aligned", { defaultValue: "同步对齐任务已完成" }),
      );
      void invalidateSites();
      if (importSite) {
        void queryClient.invalidateQueries({
          queryKey: ["apiHub", "siteDetail", importSite.id],
        });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "对齐失败");
    },
    onSettled: (_data, error, siteIds) => {
      if (!siteIds || !error) return;
      setAligningSiteIds((prev) => {
        const next = new Set(prev);
        for (const siteId of siteIds) next.delete(siteId);
        return next;
      });
    },
  });

  const checkSitesMutation = useMutation({
    mutationFn: apiHubApi.checkSites,
    onSuccess: () => {
      toast.success("检查任务已完成");
      void invalidateSites();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "检查失败");
    },
    onSettled: (_data, _error, siteIds) => {
      if (!siteIds) return;
      setCheckingSiteIds((prev) => {
        const next = new Set(prev);
        for (const siteId of siteIds) next.delete(siteId);
        return next;
      });
    },
  });

  const deleteSiteMutation = useMutation({
    mutationFn: apiHubApi.deleteSite,
    onSuccess: () => {
      toast.success("站点记录已删除");
      void invalidateSites();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "删除记录失败");
    },
  });

  const cleanupSiteMutation = useMutation({
    mutationFn: apiHubApi.cleanupSiteProviders,
    onSuccess: (report) => {
      const failedText =
        (report.failed?.length ?? 0) > 0
          ? `，失败 ${report.failed.length}`
          : "";
      toast.success(`已清理 ${report.deleted} 个供应商${failedText}`);
      void invalidateSites();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "清理站点失败");
    },
  });

  const cleanupSitesMutation = useMutation({
    mutationFn: apiHubApi.cleanupSitesProviders,
    onSuccess: (report) => {
      const failedText =
        (report.failed?.length ?? 0) > 0
          ? `，失败 ${report.failed.length}`
          : "";
      toast.success(`已清理 ${report.deleted} 个供应商${failedText}`);
      void invalidateSites();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "批量清理失败");
    },
  });

  const strategyImportMutation = useMutation({
    mutationFn: async ({
      apps,
      candidates,
    }: {
      apps: AppId[];
      candidates: ApiHubModelCandidateRow[];
    }) => {
      const bySite = new Map<
        string,
        { site: ApiHubSiteRow; selections: ApiHubModelSelection[] }
      >();
      for (const candidate of candidates) {
        const entry = bySite.get(candidate.site_id) ?? {
          site: candidateToSiteRow(candidate),
          selections: [],
        };
        for (const app of apps) {
          entry.selections.push({
            group: candidate.group,
            model: candidate.model,
            app,
          });
        }
        bySite.set(candidate.site_id, entry);
      }

      let created = 0;
      let updated = 0;
      let failed = 0;
      for (const { site, selections } of bySite.values()) {
        const report = await apiHubApi.importToApps({
          site_id: site.id,
          target_apps: apps,
          selections,
          auto_align_if_missing: true,
          mark_as_imported: true,
          settings_configs: buildApiHubSettingsConfigs(site, apps, selections),
        });
        created += report.created;
        updated += report.updated;
        failed += report.failed.length;
      }
      return { created, updated, failed };
    },
    onSuccess: (report) => {
      const failedText = report.failed > 0 ? `，失败 ${report.failed}` : "";
      toast.success(
        `策略导入完成：新增 ${report.created}，更新 ${report.updated}${failedText}`,
      );
      setSelectedCandidateKeys(new Set());
      void invalidateSites();
      void queryClient.invalidateQueries({
        queryKey: ["apiHub", "modelCandidates"],
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "策略导入失败");
    },
  });

  const importAppsMutation = useMutation({
    mutationFn: apiHubApi.importToApps,
    onSuccess: (report) => {
      const failedText =
        report.failed.length > 0 ? `，失败 ${report.failed.length}` : "";
      toast.success(
        `导入完成：新增 ${report.created}，更新 ${report.updated}${failedText}`,
      );
      setImportSite(null);
      setTargetApps(new Set());
      setSelectedModelsByApp({});
      setNoDefaultByApp({});
      setModelSearch("");
      void invalidateSites();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "导入应用失败");
    },
  });

  const sites = sitesQuery.data?.items ?? [];
  const modelCandidates = modelCandidatesQuery.data ?? [];
  const total = sitesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectedSiteList = Array.from(selectedSiteIds);
  const checkTargetSiteIds =
    selectedSiteList.length > 0
      ? selectedSiteList
      : sites.map((site) => site.id);
  const allVisibleSelected =
    sites.length > 0 && sites.every((site) => selectedSiteIds.has(site.id));
  const selectedCandidates = modelCandidates.filter((candidate) =>
    selectedCandidateKeys.has(candidateKey(candidate)),
  );
  const allCandidatesSelected =
    modelCandidates.length > 0 &&
    modelCandidates.every((candidate) =>
      selectedCandidateKeys.has(candidateKey(candidate)),
    );

  useEffect(() => {
    const visibleKeys = new Set(modelCandidates.map(candidateKey));
    setSelectedCandidateKeys((prev) => {
      const next = new Set(
        Array.from(prev).filter((key) => visibleKeys.has(key)),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [modelCandidates]);

  const detail = detailQuery.data;
  const groupedModels = useMemo(() => modelsByGroup(detail), [detail]);
  const activeSelectedModels = useMemo(
    () => new Set(selectedModelsByApp[activeTargetApp] ?? []),
    [activeTargetApp, selectedModelsByApp],
  );
  const activeNoDefaultSelected = Boolean(noDefaultByApp[activeTargetApp]);
  const activeCollapsedGroups = useMemo(
    () => new Set(collapsedGroupsByApp[activeTargetApp] ?? []),
    [activeTargetApp, collapsedGroupsByApp],
  );
  const filteredGroupedModels = useMemo(() => {
    const keyword = modelSearch.trim().toLowerCase();
    if (!keyword) return groupedModels;
    return groupedModels
      .map(({ group, models }) => ({
        group,
        models: models.filter(
          (model) =>
            group.name.toLowerCase().includes(keyword) ||
            model.name.toLowerCase().includes(keyword),
        ),
      }))
      .filter(({ models }) => models.length > 0);
  }, [groupedModels, modelSearch]);
  const selectionsByApp = useMemo(() => {
    const selections: Partial<Record<AppId, ApiHubModelSelection[]>> = {};
    const noDefaultGroup = selectNoDefaultGroup(groupedModels);
    for (const app of targetApps) {
      const appSelected = selectedModelsByApp[app] ?? [];
      const appSelections = appSelected.map((key) => ({
        ...parseSelectionKey(key),
        app,
      }));
      if (noDefaultByApp[app]) {
        const modelGroup =
          appSelected.length > 0
            ? parseSelectionKey(appSelected[0]).group
            : noDefaultGroup;
        appSelections.unshift({
          group: modelGroup,
          model: "",
          app,
        });
      }
      selections[app] = appSelections;
    }
    return selections;
  }, [groupedModels, noDefaultByApp, selectedModelsByApp, targetApps]);
  const importSelectionList = useMemo(
    () => Array.from(targetApps).flatMap((app) => selectionsByApp[app] ?? []),
    [selectionsByApp, targetApps],
  );
  const missingTokenGroups = useMemo(() => {
    if (!detail) return [];
    const tokenGroups = new Set(
      detail.tokens
        .filter(
          (token) =>
            token.group_name &&
            token.name === token.group_name &&
            isPlainApiKey(token.key),
        )
        .map((token) => token.group_name as string),
    );
    return Array.from(new Set(importSelectionList.map((item) => item.group)))
      .filter((group) => !tokenGroups.has(group))
      .sort();
  }, [detail, importSelectionList]);

  const toggleSite = (siteId: string, checked: boolean) => {
    setSelectedSiteIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(siteId);
      else next.delete(siteId);
      return next;
    });
  };

  const toggleVisibleSites = (checked: boolean) => {
    setSelectedSiteIds((prev) => {
      const next = new Set(prev);
      for (const site of sites) {
        if (checked) next.add(site.id);
        else next.delete(site.id);
      }
      return next;
    });
  };

  const toggleApp = (app: AppId, checked: boolean) => {
    if (checked) {
      const hasSelection =
        (selectedModelsByApp[app]?.length ?? 0) > 0 ||
        Boolean(noDefaultByApp[app]);
      if (!hasSelection) return;
      setTargetApps((prev) => {
        const next = new Set(prev);
        next.add(app);
        return next;
      });
      return;
    }
    setTargetApps((prev) => {
      const next = new Set(prev);
      next.delete(app);
      return next;
    });
    setSelectedModelsByApp((prev) => ({
      ...prev,
      [app]: [],
    }));
    setNoDefaultByApp((prev) => ({
      ...prev,
      [app]: false,
    }));
  };

  const toggleNoDefault = (app: AppId, checked: boolean) => {
    setNoDefaultByApp((prev) => ({
      ...prev,
      [app]: checked,
    }));
    setTargetApps((prev) => {
      const next = new Set(prev);
      const selectedModelCount = selectedModelsByApp[app]?.length ?? 0;
      if (checked || selectedModelCount > 0) next.add(app);
      else next.delete(app);
      return next;
    });
  };

  const toggleModel = (selection: ApiHubModelSelection, checked: boolean) => {
    const app = activeTargetApp;
    const key = selectionKey(selection);
    const next = new Set(selectedModelsByApp[app] ?? []);
    if (checked) next.add(key);
    else next.delete(key);
    const nextList = Array.from(next);
    setSelectedModelsByApp((prev) => {
      return {
        ...prev,
        [app]: nextList,
      };
    });
    setTargetApps((prevApps) => {
      const nextApps = new Set(prevApps);
      const hasNoDefault = Boolean(noDefaultByApp[app]);
      if (nextList.length > 0 || hasNoDefault) nextApps.add(app);
      else nextApps.delete(app);
      return nextApps;
    });
  };

  const applySort = (field: SiteSortBy) => {
    setSortBy((prevField) => {
      if (prevField === field) {
        setSortDirection((prevDirection) =>
          prevDirection === "asc" ? "desc" : "asc",
        );
        return prevField;
      }
      setSortDirection("asc");
      return field;
    });
  };

  const sortIcon = (field: SiteSortBy) => {
    if (sortBy !== field) return <ArrowUpDown className="h-3.5 w-3.5" />;
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  };

  const openImportDialog = (site: ApiHubSiteRow) => {
    setImportSite(site);
    setActiveTargetApp("claude");
    setTargetApps(new Set());
    setSelectedModelsByApp({});
    setNoDefaultByApp({});
    setCollapsedGroupsByApp({});
    setModelSearch("");
    setMarkAsImported(true);
  };

  const toggleGroupCollapsed = (app: AppId, groupName: string) => {
    setCollapsedGroupsByApp((prev) => {
      const current = new Set(prev[app] ?? []);
      if (current.has(groupName)) current.delete(groupName);
      else current.add(groupName);
      return {
        ...prev,
        [app]: Array.from(current),
      };
    });
  };

  const readImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as ApiHubAccountsBackup;
      await importJsonMutation.mutateAsync(payload);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("apiHub.error.importFailed", { defaultValue: "导入失败" }),
      );
    }
  };

  const queueConfirmAction = useCallback((next: PendingConfirm) => {
    window.setTimeout(() => {
      setPendingConfirm(next);
    }, 0);
  }, []);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void readImportFile(file);
  };

  const handleClear = () => {
    queueConfirmAction({ action: "clear" });
  };

  const handleCheckSites = () => {
    if (checkTargetSiteIds.length === 0) return;
    checkSitesMutation.mutate(checkTargetSiteIds);
  };

  const handleCleanupSelectedSites = () => {
    if (selectedSiteList.length === 0) return;
    queueConfirmAction({
      action: "cleanup_batch",
      siteIds: selectedSiteList,
    });
  };

  const toggleCandidate = (key: string, checked: boolean) => {
    setSelectedCandidateKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleAllCandidates = (checked: boolean) => {
    setSelectedCandidateKeys((prev) => {
      const next = new Set(prev);
      for (const candidate of modelCandidates) {
        const key = candidateKey(candidate);
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const handleStrategyImport = (apps: AppId[]) => {
    if (selectedCandidates.length === 0) return;
    strategyImportMutation.mutate({
      apps,
      candidates: selectedCandidates,
    });
  };

  const handleImportApps = () => {
    if (!importSite) return;
    const apps = Array.from(targetApps);
    if (apps.length === 0 || importSelectionList.length === 0) return;
    importAppsMutation.mutate({
      site_id: importSite.id,
      target_apps: apps,
      selections: importSelectionList,
      auto_align_if_missing: true,
      mark_as_imported: markAsImported,
      settings_configs: buildApiHubSettingsConfigs(
        importSite,
        apps,
        importSelectionList,
      ),
    });
  };

  const handleDeleteSite = (site: ApiHubSiteRow) => {
    queueConfirmAction({ action: "delete", site });
  };

  const handleCleanupSite = (site: ApiHubSiteRow) => {
    queueConfirmAction({ action: "cleanup", site });
  };

  const confirmTitle = pendingConfirm
    ? pendingConfirm.action === "clear"
      ? "清空 Api-Hub 缓存"
      : pendingConfirm.action === "delete"
        ? "删除站点记录"
        : pendingConfirm.action === "cleanup_batch"
          ? "一键清理"
          : "清理站点"
    : "";
  const confirmMessage = pendingConfirm
    ? pendingConfirm.action === "clear"
      ? t("apiHub.clearConfirm", {
          defaultValue:
            "确认清空 Api-Hub 站点缓存？已导入到 providers 的供应商不会删除。",
        })
      : pendingConfirm.action === "delete" && pendingConfirm.site
        ? `确认删除 Api-Hub 站点记录：${pendingConfirm.site.site_name}？`
        : pendingConfirm.action === "cleanup_batch"
          ? `确认清理选中的 ${pendingConfirm.siteIds?.length ?? 0} 个站点已导入到各应用的供应商记录？`
          : pendingConfirm.site
            ? `确认清理 ${pendingConfirm.site.site_name} 已导入到各应用的供应商记录？`
            : ""
    : "";
  const confirmText =
    pendingConfirm?.action === "clear"
      ? t("common.clear")
      : pendingConfirm?.action === "delete"
        ? "删除"
        : "清理";
  const handleConfirmAction = () => {
    if (!pendingConfirm) return;
    const current = pendingConfirm;
    setPendingConfirm(null);
    if (current.action === "clear") {
      clearMutation.mutate();
      return;
    }
    if (current.action === "cleanup_batch") {
      cleanupSitesMutation.mutate(current.siteIds ?? []);
      return;
    }
    if (!current.site) return;
    if (current.action === "delete") {
      deleteSiteMutation.mutate(current.site.id);
      return;
    }
    cleanupSiteMutation.mutate(current.site.id);
  };

  const isImportingJson = importJsonMutation.isPending;
  const isBatchBusy =
    alignMutation.isPending ||
    checkSitesMutation.isPending ||
    cleanupSitesMutation.isPending ||
    strategyImportMutation.isPending ||
    clearMutation.isPending;
  const canImportApps =
    targetApps.size > 0 &&
    importSelectionList.length > 0 &&
    missingTokenGroups.length === 0 &&
    !importAppsMutation.isPending;
  const sortableHeader = (
    field: SiteSortBy,
    label: string,
    ariaLabel = `${label}排序`,
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={ariaLabel}
      onClick={() => applySort(field)}
      className="-ml-2 h-8 px-2 text-muted-foreground hover:text-foreground"
    >
      {label}
      {sortIcon(field)}
    </Button>
  );

  return (
    <div className="space-y-4 pb-4">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="rounded-xl border border-border-default bg-background/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-emerald-600" />
              <h2 className="text-lg font-semibold">
                {t("apiHub.title", { defaultValue: "Api-Hub" })}
              </h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("apiHub.description", {
                defaultValue:
                  "导入 api-hub 备份，按站点同步分组、模型和 APIKey，再批量写入各应用供应商。",
              })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isImportingJson}
            >
              {isImportingJson ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {t("apiHub.importJson", { defaultValue: "导入 JSON" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleCheckSites}
              disabled={checkTargetSiteIds.length === 0 || isBatchBusy}
              title={
                selectedSiteList.length > 0
                  ? `检查选中的 ${selectedSiteList.length} 个站点`
                  : `检查当前页 ${checkTargetSiteIds.length} 个站点`
              }
            >
              {checkSitesMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-2 h-4 w-4" />
              )}
              一键检查
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => alignMutation.mutate(selectedSiteList)}
              disabled={selectedSiteList.length === 0 || isBatchBusy}
            >
              {alignMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              同步并对齐
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleCleanupSelectedSites}
              disabled={selectedSiteList.length === 0 || isBatchBusy}
            >
              {cleanupSitesMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eraser className="mr-2 h-4 w-4" />
              )}
              一键清理
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleClear}
              disabled={isBatchBusy}
              className="text-red-600 hover:text-red-700"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common.clear")}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid flex-1 gap-2 md:grid-cols-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder={t("apiHub.searchPlaceholder", {
                  defaultValue: "搜索站点名称或 URL",
                })}
                className="pl-9"
              />
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="模型筛选"
                value={modelFilterInput}
                onChange={(event) => setModelFilterInput(event.target.value)}
                placeholder="筛选模型，例如 claude-4 / gpt-5"
                className="pl-9"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Label htmlFor="api-hub-site-type" className="text-sm font-normal">
              站点类型
            </Label>
            <select
              id="api-hub-site-type"
              aria-label="站点类型"
              value={siteTypeFilter}
              onChange={(event) => setSiteTypeFilter(event.target.value)}
              className="h-9 rounded-md border border-border-default bg-background px-2 text-foreground"
            >
              {SITE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Label
              htmlFor="api-hub-change-filter"
              className="text-sm font-normal"
            >
              变更
            </Label>
            <select
              id="api-hub-change-filter"
              aria-label="变更筛选"
              value={changeFilter}
              onChange={(event) => setChangeFilter(event.target.value)}
              className="h-9 rounded-md border border-border-default bg-background px-2 text-foreground"
            >
              {CHANGE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="ml-2">每页</span>
            <select
              value={pageSize}
              onChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value));
              }}
              className="h-9 rounded-md border border-border-default bg-background px-2 text-foreground"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span>条</span>
          </div>
        </div>

        {modelFilter ? (
          <div className="mt-4 rounded-lg border border-border-default bg-muted/20 p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">
                  模型聚合导入
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  当前关键词“{modelFilter}”，
                  {selectedSiteList.length > 0
                    ? `仅聚合选中的 ${selectedSiteList.length} 个站点`
                    : "聚合当前协议范围内全部站点"}
                  。只会导入已勾选的站点/分组/模型组合。
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => toggleAllCandidates(!allCandidatesSelected)}
                  disabled={
                    modelCandidates.length === 0 ||
                    modelCandidatesQuery.isLoading ||
                    strategyImportMutation.isPending
                  }
                >
                  {allCandidatesSelected ? "取消全选" : "全选候选"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleStrategyImport(["claude"])}
                  disabled={
                    selectedCandidates.length === 0 ||
                    strategyImportMutation.isPending
                  }
                >
                  {strategyImportMutation.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : null}
                  导入 Claude
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleStrategyImport(["codex"])}
                  disabled={
                    selectedCandidates.length === 0 ||
                    strategyImportMutation.isPending
                  }
                >
                  导入 Codex
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleStrategyImport(["claude", "codex"])}
                  disabled={
                    selectedCandidates.length === 0 ||
                    strategyImportMutation.isPending
                  }
                >
                  导入 Claude + Codex
                </Button>
              </div>
            </div>

            <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-border-default bg-background/70">
              {modelCandidatesQuery.isLoading ? (
                <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在聚合模型
                </div>
              ) : modelCandidates.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  没有匹配的模型候选。
                </div>
              ) : (
                <div className="divide-y divide-border-default">
                  {modelCandidates.map((candidate) => {
                    const key = candidateKey(candidate);
                    return (
                      <Label
                        key={key}
                        className="grid grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto] items-center gap-3 px-3 py-2 text-sm hover:bg-muted/30"
                      >
                        <Checkbox
                          aria-label={`选择候选 ${candidate.site_name} ${candidate.group} ${candidate.model}`}
                          checked={selectedCandidateKeys.has(key)}
                          onCheckedChange={(checked) =>
                            toggleCandidate(key, checked === true)
                          }
                        />
                        <span className="truncate font-medium text-foreground">
                          {candidate.site_name}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {candidate.group}
                        </span>
                        <span className="truncate">{candidate.model}</span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "whitespace-nowrap",
                            candidate.has_api_key
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                          )}
                        >
                          {candidate.has_api_key ? "Key 已对齐" : "需补 Key"}
                        </Badge>
                      </Label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-border-default bg-background/70">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="选择当前页"
                  checked={allVisibleSelected}
                  onCheckedChange={(checked) =>
                    toggleVisibleSites(checked === true)
                  }
                />
              </TableHead>
              <TableHead>{sortableHeader("site_name", "站点")}</TableHead>
              <TableHead>
                {sortableHeader("site_type", "协议", "协议排序")}
              </TableHead>
              <TableHead>
                {sortableHeader("group_count", "分组 / 模型", "分组模型排序")}
              </TableHead>
              <TableHead>
                {sortableHeader("token_count", "APIKey", "APIKey排序")}
              </TableHead>
              <TableHead>
                {sortableHeader("imported_apps", "导入状态", "导入状态排序")}
              </TableHead>
              <TableHead>
                {sortableHeader("last_change_at", "变更状态", "变更状态排序")}
              </TableHead>
              <TableHead>
                {sortableHeader("last_synced_at", "最近同步", "最近同步排序")}
              </TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sitesQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="h-40 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : sites.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="h-40 text-center text-sm text-muted-foreground"
                >
                  暂无 Api-Hub 站点，先导入 accounts-backup JSON。
                </TableCell>
              </TableRow>
            ) : (
              sites.map((site) => (
                <TableRow key={site.id}>
                  <TableCell>
                    <Checkbox
                      aria-label={`选择 ${site.site_name}`}
                      checked={selectedSiteIds.has(site.id)}
                      onCheckedChange={(checked) =>
                        toggleSite(site.id, checked === true)
                      }
                    />
                  </TableCell>
                  <TableCell className="min-w-64">
                    <div className="flex min-w-0 flex-col gap-1">
                      <a
                        href={site.site_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 font-semibold text-foreground hover:text-primary"
                      >
                        <span className="truncate">{site.site_name}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </a>
                      <span className="truncate text-xs text-muted-foreground">
                        {site.site_url}
                      </span>
                      {site.last_sync_error ? (
                        <span className="inline-flex items-center gap-1 text-xs text-red-600">
                          <AlertCircle className="h-3.5 w-3.5" />
                          {site.last_sync_error}
                        </span>
                      ) : null}
                      {(site.model_matches ?? []).length > 0 ? (
                        <div className="space-y-0.5 pt-1 text-xs text-muted-foreground">
                          {site.model_matches?.map((match) => (
                            <div key={match.model_name}>
                              {match.model_name}：
                              {(match.groups ?? []).length > 0
                                ? match.groups.join(" / ")
                                : "无分组"}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "whitespace-nowrap",
                        siteTypeClass(
                          site.site_type,
                          Boolean(site.last_sync_error),
                        ),
                      )}
                    >
                      {site.site_type || "unknown"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {site.group_count} 个分组 / {site.model_count} 个模型
                  </TableCell>
                  <TableCell>{site.token_count}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "whitespace-nowrap",
                        (site.imported_apps ?? []).length > 0
                          ? "border-blue-500/30 bg-blue-500/10 text-blue-700"
                          : "border-muted-foreground/30 bg-muted text-muted-foreground",
                      )}
                    >
                      {importedAppsText(site)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "whitespace-nowrap",
                        changeStatusClass(site),
                      )}
                    >
                      {changeStatusText(site)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatSyncTime(site.last_synced_at)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {(() => {
                        const isSyncing = syncingSiteIds.has(site.id);
                        const isAligning = aligningSiteIds.has(site.id);
                        const isChecking = checkingSiteIds.has(site.id);
                        const isCleaning =
                          (cleanupSiteMutation.isPending &&
                            cleanupSiteMutation.variables === site.id) ||
                          (cleanupSitesMutation.isPending &&
                            (cleanupSitesMutation.variables ?? []).includes(
                              site.id,
                            ));
                        const isDeleting =
                          deleteSiteMutation.isPending &&
                          deleteSiteMutation.variables === site.id;
                        const isSyncAlignBusy = isSyncing || isAligning;
                        const hasGroups = site.group_count > 0;
                        const hasModels = site.model_count > 0;
                        const isSynced =
                          Boolean(site.last_synced_at) &&
                          !Boolean(site.last_sync_error);
                        const alignedGroups =
                          site.aligned_group_count ?? site.token_count;
                        const isAligned =
                          site.is_aligned ??
                          (site.group_count > 0 &&
                            alignedGroups >= site.group_count);
                        const canImportSite =
                          hasGroups && hasModels && isSynced && isAligned;
                        const importDisabledReason = !hasGroups
                          ? "0 分组，无法导入"
                          : !hasModels
                            ? "0 模型，无法导入"
                            : !isSynced
                              ? "未同步，无法导入"
                              : !isAligned
                                ? "未对齐，无法导入"
                                : "";
                        return (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => alignMutation.mutate([site.id])}
                              disabled={isSyncAlignBusy || isChecking}
                            >
                              {isSyncAlignBusy || isChecking ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-1.5 h-4 w-4" />
                              )}
                              {isChecking
                                ? "检查中"
                                : isSyncAlignBusy
                                  ? "对齐中"
                                  : "同步对齐"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleCleanupSite(site)}
                              disabled={isCleaning}
                            >
                              {isCleaning ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              ) : (
                                <Eraser className="mr-1.5 h-4 w-4" />
                              )}
                              清理站点
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => openImportDialog(site)}
                              disabled={!canImportSite}
                              title={
                                canImportSite
                                  ? "导入应用"
                                  : importDisabledReason
                              }
                            >
                              <PackagePlus className="mr-1.5 h-4 w-4" />
                              导入应用
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleDeleteSite(site)}
                              disabled={isDeleting}
                              className="text-red-600 hover:text-red-700"
                            >
                              {isDeleting ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="mr-1.5 h-4 w-4" />
                              )}
                              删除记录
                            </Button>
                          </>
                        );
                      })()}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between border-t border-border-default px-4 py-3 text-sm text-muted-foreground">
          <span>
            共 {total} 个站点，已选 {selectedSiteList.length} 个
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>
              {page} / {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setPage((value) => Math.min(totalPages, value + 1))
              }
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={Boolean(importSite)}
        onOpenChange={(open) => {
          if (!open) {
            setImportSite(null);
            setTargetApps(new Set());
            setSelectedModelsByApp({});
            setNoDefaultByApp({});
            setCollapsedGroupsByApp({});
            setModelSearch("");
            setMarkAsImported(true);
          }
        }}
      >
        <DialogContent
          zIndex="nested"
          className="max-w-4xl"
          onEscapeKeyDown={(event) => {
            if (modelSearch.trim()) {
              event.preventDefault();
              setModelSearch("");
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              导入到应用{importSite ? ` - ${importSite.site_name}` : ""}
            </DialogTitle>
            <DialogDescription>
              选择目标应用和模型，确认后会按模板生成供应商配置。
            </DialogDescription>
          </DialogHeader>

          {detailQuery.isLoading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : detail ? (
            <div className="space-y-5 px-6">
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">目标应用</h3>
                <Tabs
                  value={activeTargetApp}
                  onValueChange={(value) => {
                    setActiveTargetApp(value as AppId);
                  }}
                >
                  <TabsList className="flex w-full flex-wrap justify-start">
                    {TARGET_APPS.map((app) => (
                      <TabsTrigger
                        key={app.id}
                        value={app.id}
                        onClick={() => setActiveTargetApp(app.id)}
                        className={cn(
                          "min-w-0 flex-1 gap-2 px-2",
                          targetApps.has(app.id) ? "opacity-100" : "",
                        )}
                      >
                        {app.label}
                        {targetApps.has(app.id) ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        ) : null}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <div className="grid grid-cols-2 gap-2">
                  <Label className="flex items-center justify-between rounded-md border border-border-default px-3 py-2">
                    <span className="text-sm">
                      导入到 {APP_LABELS.get(activeTargetApp)}
                    </span>
                    <Checkbox
                      aria-label={`导入到 ${APP_LABELS.get(activeTargetApp)}`}
                      checked={targetApps.has(activeTargetApp)}
                      onCheckedChange={(checked) =>
                        toggleApp(activeTargetApp, checked === true)
                      }
                    />
                  </Label>
                  <Label className="flex items-center justify-between rounded-md border border-border-default px-3 py-2">
                    <span className="text-sm">无默认模型供应商导入</span>
                    <Checkbox
                      aria-label={`${APP_LABELS.get(activeTargetApp)} 无默认模型供应商导入`}
                      checked={activeNoDefaultSelected}
                      onCheckedChange={(checked) =>
                        toggleNoDefault(activeTargetApp, checked === true)
                      }
                    />
                  </Label>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">可选模型</h3>
                  <span className="text-xs text-muted-foreground">
                    当前应用已选{" "}
                    {activeSelectedModels.size +
                      (noDefaultByApp[activeTargetApp] ? 1 : 0)}{" "}
                    项
                  </span>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setModelSearch("");
                      }
                    }}
                    placeholder="筛选模型或分组，按 ESC 清空"
                    className="pl-9"
                  />
                </div>
                <div className="max-h-72 overflow-y-auto rounded-md border border-border-default">
                  {filteredGroupedModels.length === 0 ? (
                    <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                      没有匹配的模型。
                    </div>
                  ) : (
                    filteredGroupedModels.map(({ group, models }) => (
                      <div
                        key={group.name}
                        className="border-b border-border-default last:border-0"
                      >
                        <button
                          type="button"
                          className="flex w-full items-center justify-between bg-muted/40 px-3 py-2 text-left hover:bg-muted/60"
                          onClick={() =>
                            toggleGroupCollapsed(activeTargetApp, group.name)
                          }
                          aria-label={`${group.name} 分组折叠`}
                        >
                          <div className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
                            {activeCollapsedGroups.has(group.name) ? (
                              <ChevronRight className="h-4 w-4 shrink-0" />
                            ) : (
                              <ChevronDown className="h-4 w-4 shrink-0" />
                            )}
                            <span className="truncate">{group.name}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span>{formatGroupRatio(group.ratio)}</span>
                            <span>{models.length} 个模型</span>
                          </div>
                        </button>
                        {!activeCollapsedGroups.has(group.name) ? (
                          <div className="divide-y divide-border-default">
                            {models
                              .map((model) => ({
                                selection: {
                                  group: group.name,
                                  model: model.name,
                                },
                                label: model.name,
                              }))
                              .map(({ selection, label }) => {
                                const key = selectionKey(selection);
                                return (
                                  <Label
                                    key={key}
                                    className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm hover:bg-muted/30"
                                  >
                                    <Checkbox
                                      aria-label={`${group.name} / ${label}`}
                                      checked={activeSelectedModels.has(key)}
                                      onCheckedChange={(checked) =>
                                        toggleModel(selection, checked === true)
                                      }
                                    />
                                    <span className="min-w-28 shrink-0 text-muted-foreground">
                                      {group.name}
                                    </span>
                                    <span className="truncate font-medium text-foreground">
                                      {label}
                                    </span>
                                  </Label>
                                );
                              })}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">命名预览</h3>
                <div className="max-h-28 overflow-y-auto rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                  {targetApps.size === 0 ? (
                    <span>选择目标应用后显示预览。</span>
                  ) : (
                    importSelectionList.slice(0, 20).map((selection) => (
                      <div
                        key={`${selection.app}-${selection.group}-${selection.model}`}
                      >
                        {selection.model
                          ? `${detail.site.site_name} · ${selection.group} · ${selection.model}`
                          : `${detail.site.site_name} · 不写默认模型`}{" "}
                        → {selection.app}
                      </div>
                    ))
                  )}
                </div>
              </section>

              {missingTokenGroups.length > 0 ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
                  以下分组缺少同名 APIKey，确认导入前将自动对齐：{" "}
                  {missingTokenGroups.join(", ")}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="px-6 text-sm text-muted-foreground">
              站点详情加载失败。
            </div>
          )}

          <DialogFooter className="justify-between sm:justify-between">
            <Label className="flex items-center gap-2 text-sm">
              <Switch
                checked={markAsImported}
                onCheckedChange={setMarkAsImported}
                aria-label="标记为已导入"
              />
              标记为已导入
            </Label>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setImportSite(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleImportApps}
                disabled={!canImportApps}
              >
                {importAppsMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                确认导入
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={pendingConfirm !== null}
        title={confirmTitle}
        message={confirmMessage}
        confirmText={confirmText}
        cancelText={t("common.cancel")}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={handleConfirmAction}
      />
    </div>
  );
}
