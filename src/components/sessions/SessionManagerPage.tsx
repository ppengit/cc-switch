import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useSessionSearch } from "@/hooks/useSessionSearch";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Download,
  RefreshCw,
  Search,
  Play,
  Trash2,
  MessageSquare,
  Clock,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FileText,
  X,
  CheckSquare,
  Pencil,
} from "lucide-react";
import {
  useDeleteSessionMutation,
  useSessionMessagesQuery,
  useSessionsQuery,
} from "@/lib/query";
import { sessionsApi } from "@/lib/api";
import type { SessionMeta } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { extractErrorMessage } from "@/utils/errorUtils";
import { ProviderIcon } from "@/components/ProviderIcon";
import { SessionItem } from "./SessionItem";
import { SessionMessageItem } from "./SessionMessageItem";
import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";
import {
  extractCodexPromptPreview,
  formatSessionMessagePreview,
  formatSessionTitle,
  formatTimestamp,
  getBaseName,
  getProviderIconName,
  getProviderLabel,
  getSessionKey,
  shouldHideCodexMessageFromToc,
} from "./utils";
import { cn } from "@/lib/utils";

type ProviderFilter =
  | "all"
  | "codex"
  | "claude"
  | "opencode"
  | "openclaw"
  | "gemini"
  | "hermes";

const ALL_PROJECTS_FILTER = "__all_projects__";
const UNCATEGORIZED_PROJECT_KEY = "__uncategorized__";
const detailActionButtonBase = "h-8 gap-1.5 border px-3";
const detailRenameButtonClass = `${detailActionButtonBase} border-violet-200 bg-violet-50/80 text-violet-700 hover:border-violet-300 hover:bg-violet-100 hover:text-violet-800 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-300 dark:hover:border-violet-800 dark:hover:bg-violet-950/50 dark:hover:text-violet-200`;
const detailResumeButtonClass = `${detailActionButtonBase} border-emerald-200 bg-emerald-50/80 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 hover:text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/50 dark:hover:text-emerald-200`;
const detailExportButtonClass = `${detailActionButtonBase} border-sky-200 bg-sky-50/80 text-sky-700 hover:border-sky-300 hover:bg-sky-100 hover:text-sky-800 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300 dark:hover:border-sky-800 dark:hover:bg-sky-950/50 dark:hover:text-sky-200`;
const detailDeleteButtonClass = `${detailActionButtonBase} border-rose-200 bg-rose-50/80 text-rose-700 hover:border-rose-300 hover:bg-rose-100 hover:text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:border-rose-800 dark:hover:bg-rose-950/50 dark:hover:text-rose-200`;

interface ProjectOption {
  key: string;
  label: string;
  path: string | null;
  count: number;
}

interface SessionProjectGroup extends ProjectOption {
  sessions: SessionMeta[];
}

const getParentDirectory = (value?: string | null) => {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  const backslashIndex = normalized.lastIndexOf("\\");
  const index = Math.max(slashIndex, backslashIndex);
  return index > 0 ? normalized.slice(0, index) : "";
};

const normalizeProjectPathDisplay = (value?: string | null) => {
  if (!value) return "";
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";

  const hasUncPrefix = /^[\\/]{2,}[^\\/]/.test(trimmed);
  const normalized = trimmed.replace(/[\\/]+/g, "/");

  return hasUncPrefix && !normalized.startsWith("//")
    ? `/${normalized}`
    : normalized;
};

const normalizeProjectPathKey = (value?: string | null) => {
  const normalized = normalizeProjectPathDisplay(value);
  if (!normalized) return "";
  return /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
};

const getSessionProjectPath = (session: SessionMeta) => {
  const projectDir = session.projectDir?.trim();
  if (projectDir) return normalizeProjectPathDisplay(projectDir);
  return normalizeProjectPathDisplay(getParentDirectory(session.sourcePath));
};

const getSessionProjectKey = (session: SessionMeta) =>
  normalizeProjectPathKey(getSessionProjectPath(session)) ||
  UNCATEGORIZED_PROJECT_KEY;

export function SessionManagerPage({ appId }: { appId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useSessionsQuery();
  const sessions = data ?? [];
  const detailRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [activeMessageIndex, setActiveMessageIndex] = useState<number | null>(
    null,
  );
  const [tocDialogOpen, setTocDialogOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<SessionMeta[] | null>(
    null,
  );
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [renameSession, setRenameSession] = useState<SessionMeta | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);
  const [isExportingSession, setIsExportingSession] = useState(false);
  const [contextMenuSession, setContextMenuSession] =
    useState<SessionMeta | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(
    appId as ProviderFilter,
  );
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS_FILTER);
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // 使用 FlexSearch 全文搜索
  const { search: searchSessions } = useSessionSearch({
    sessions,
    providerFilter,
  });

  const getProjectLabel = useCallback(
    (key: string, path: string | null) => {
      if (key === UNCATEGORIZED_PROJECT_KEY) {
        return t("sessionManager.uncategorizedProject", {
          defaultValue: "未归类",
        });
      }
      return getBaseName(path) || path || key;
    },
    [t],
  );

  const projectOptions = useMemo<ProjectOption[]>(() => {
    const optionMap = new Map<string, ProjectOption>();

    sessions
      .filter(
        (session) =>
          providerFilter === "all" || session.providerId === providerFilter,
      )
      .forEach((session) => {
        const key = getSessionProjectKey(session);
        const path = getSessionProjectPath(session) || null;
        const existing = optionMap.get(key);

        if (existing) {
          existing.count += 1;
          if (path && existing.path && path.length < existing.path.length) {
            existing.path = path;
            existing.label = getProjectLabel(key, path);
          }
        } else {
          optionMap.set(key, {
            key,
            label: getProjectLabel(key, path),
            path,
            count: 1,
          });
        }
      });

    return Array.from(optionMap.values()).sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [getProjectLabel, providerFilter, sessions]);

  useEffect(() => {
    if (
      projectFilter !== ALL_PROJECTS_FILTER &&
      !projectOptions.some((option) => option.key === projectFilter)
    ) {
      setProjectFilter(ALL_PROJECTS_FILTER);
    }
  }, [projectFilter, projectOptions]);

  const searchFilteredSessions = useMemo(() => {
    return searchSessions(search);
  }, [searchSessions, search]);

  const filteredSessions = useMemo(() => {
    if (projectFilter === ALL_PROJECTS_FILTER) {
      return searchFilteredSessions;
    }

    return searchFilteredSessions.filter(
      (session) => getSessionProjectKey(session) === projectFilter,
    );
  }, [projectFilter, searchFilteredSessions]);

  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedKey(null);
      return;
    }
    const exists = selectedKey
      ? filteredSessions.some(
          (session) => getSessionKey(session) === selectedKey,
        )
      : false;
    if (!exists) {
      setSelectedKey(getSessionKey(filteredSessions[0]));
    }
  }, [filteredSessions, selectedKey]);

  const selectedSession = useMemo(() => {
    if (!selectedKey) return null;
    return (
      filteredSessions.find(
        (session) => getSessionKey(session) === selectedKey,
      ) || null
    );
  }, [filteredSessions, selectedKey]);

  const { data: messages = [], isLoading: isLoadingMessages } =
    useSessionMessagesQuery(
      selectedSession?.providerId,
      selectedSession?.sourcePath,
    );
  const deleteSessionMutation = useDeleteSessionMutation();
  const isDeleting = deleteSessionMutation.isPending || isBatchDeleting;

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    overscan: 5,
    gap: 12,
  });

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [selectedKey]);

  useEffect(() => {
    const validKeys = new Set(
      sessions.map((session) => getSessionKey(session)),
    );
    setSelectedSessionKeys((current) => {
      let changed = false;
      const next = new Set<string>();
      current.forEach((key) => {
        if (validKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [sessions]);

  const isCodexSession = selectedSession?.providerId === "codex";

  // 提取用户消息用于目录
  const userMessagesToc = useMemo(() => {
    return messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => {
        if (msg.role.toLowerCase() !== "user") return false;
        return !(isCodexSession && shouldHideCodexMessageFromToc(msg.content));
      })
      .map(({ msg, index }) => {
        const previewContent = isCodexSession
          ? extractCodexPromptPreview(msg.content)
          : msg.content;

        return {
          index,
          preview: formatSessionMessagePreview(previewContent),
          ts: msg.ts,
        };
      });
  }, [isCodexSession, messages]);

  const scrollToMessage = (index: number) => {
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    setActiveMessageIndex(index);
    setTocDialogOpen(false);
    setTimeout(() => setActiveMessageIndex(null), 2000);
  };

  const handleCopy = useCallback(
    async (text: string, successMessage: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(successMessage);
      } catch (error) {
        toast.error(
          extractErrorMessage(error) ||
            t("common.error", { defaultValue: "Copy failed" }),
        );
      }
    },
    [t],
  );

  const handleMessageCopy = useCallback(
    (content: string) => {
      void handleCopy(
        content,
        t("sessionManager.messageCopied", { defaultValue: "已复制消息内容" }),
      );
    },
    [handleCopy, t],
  );

  const handleResume = async () => {
    if (!selectedSession?.resumeCommand) return;

    try {
      await sessionsApi.launchTerminal({
        command: selectedSession.resumeCommand,
        cwd: selectedSession.projectDir ?? undefined,
      });
      toast.success(t("sessionManager.terminalLaunched"));
    } catch (error) {
      const fallback = selectedSession.resumeCommand;
      let copied = false;
      try {
        await navigator.clipboard.writeText(fallback);
        copied = true;
        toast.info(t("sessionManager.resumeFallbackCopied"));
      } catch (copyError) {
        console.error("Failed to copy fallback resume command", copyError);
      }

      if (!copied) {
        toast.error(
          extractErrorMessage(error) || t("sessionManager.openFailed"),
        );
      }
    }
  };

  const handleExportSession = useCallback(async () => {
    if (!selectedSession?.sourcePath || isExportingSession) return;

    setIsExportingSession(true);
    try {
      const exportedPath = await sessionsApi.exportMarkdown(selectedSession);
      if (exportedPath) {
        toast.success(
          t("sessionManager.exportSuccess", {
            defaultValue: "会话已导出为 Markdown",
          }),
        );
      }
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.exportFailed", {
            defaultValue: "导出会话失败",
          }),
      );
    } finally {
      setIsExportingSession(false);
    }
  }, [isExportingSession, selectedSession, t]);

  const handleOpenRenameDialog = useCallback((session: SessionMeta) => {
    setRenameSession(session);
    setRenameValue(formatSessionTitle(session));
    setContextMenuSession(null);
    setContextMenuPosition(null);
  }, []);

  const handleSessionContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>, session: SessionMeta) => {
      event.preventDefault();
      event.stopPropagation();
      const menuWidth = 160;
      const menuHeight = 96;
      const x = Math.max(
        8,
        Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      );
      const y = Math.max(
        8,
        Math.min(event.clientY, window.innerHeight - menuHeight - 8),
      );
      setSelectedKey(getSessionKey(session));
      setContextMenuSession(session);
      setContextMenuPosition({ x, y });
    },
    [],
  );

  const closeSessionContextMenu = useCallback(() => {
    setContextMenuSession(null);
    setContextMenuPosition(null);
  }, []);

  useEffect(() => {
    if (!contextMenuPosition || !contextMenuSession) return;

    const handlePointerDown = () => closeSessionContextMenu();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSessionContextMenu();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeSessionContextMenu, contextMenuPosition, contextMenuSession]);

  const handleSaveRename = useCallback(async () => {
    if (!renameSession || isSavingRename) return;

    const appType = renameSession.providerId;
    const sessionId = renameSession.sessionId;
    const sourcePath = renameSession.sourcePath ?? null;
    const title = renameValue.trim();

    setIsSavingRename(true);
    try {
      if (title.length === 0) {
        await sessionsApi.clearSessionTitleMapping({
          appType,
          sessionId,
          sourcePath,
        });
      } else {
        await sessionsApi.setSessionTitleMapping({
          appType,
          sessionId,
          sourcePath,
          customTitle: title,
        });
      }

      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(
        t("sessionManager.renameSuccess", { defaultValue: "会话标题已更新" }),
      );
      setRenameSession(null);
      setRenameValue("");
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.renameFailed", {
            defaultValue: "更新会话标题失败",
          }),
      );
    } finally {
      setIsSavingRename(false);
    }
  }, [isSavingRename, queryClient, renameSession, renameValue, t]);

  const handleDeleteConfirm = async () => {
    if (!deleteTargets || deleteTargets.length === 0 || isDeleting) {
      return;
    }

    const targets = deleteTargets.filter((session) => session.sourcePath);
    setDeleteTargets(null);

    if (targets.length === 0) {
      return;
    }

    if (targets.length === 1) {
      const [target] = targets;
      await deleteSessionMutation.mutateAsync({
        providerId: target.providerId,
        sessionId: target.sessionId,
        sourcePath: target.sourcePath!,
      });
      setSelectedSessionKeys((current) => {
        const next = new Set(current);
        next.delete(getSessionKey(target));
        return next;
      });
      return;
    }

    setIsBatchDeleting(true);
    try {
      const results = await sessionsApi.deleteMany(
        targets.map((session) => ({
          providerId: session.providerId,
          sessionId: session.sessionId,
          sourcePath: session.sourcePath!,
        })),
      );

      const deletedKeys = results
        .filter((result) => result.success)
        .map(
          (result) =>
            `${result.providerId}:${result.sessionId}:${result.sourcePath ?? ""}`,
        );

      const failedErrors = results
        .filter((result) => !result.success)
        .map((result) => result.error || t("common.unknown"));

      if (deletedKeys.length > 0) {
        const deletedKeySet = new Set(deletedKeys);
        queryClient.setQueryData<SessionMeta[]>(["sessions"], (current) =>
          (current ?? []).filter(
            (session) => !deletedKeySet.has(getSessionKey(session)),
          ),
        );
      }

      results
        .filter((result) => result.success)
        .forEach((result) => {
          queryClient.removeQueries({
            queryKey: ["sessionMessages", result.providerId, result.sourcePath],
          });
        });

      setSelectedSessionKeys((current) => {
        const next = new Set(current);
        deletedKeys.forEach((key) => next.delete(key));
        return next;
      });

      await queryClient.invalidateQueries({ queryKey: ["sessions"] });

      if (deletedKeys.length > 0) {
        toast.success(
          t("sessionManager.batchDeleteSuccess", {
            defaultValue: "已删除 {{count}} 个会话",
            count: deletedKeys.length,
          }),
        );
      }

      if (failedErrors.length > 0) {
        toast.error(
          t("sessionManager.batchDeleteFailed", {
            defaultValue: "{{failed}} 个会话删除失败",
            failed: failedErrors.length,
          }),
          {
            description: failedErrors[0],
          },
        );
      }
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.batchDeleteRequestFailed", {
            defaultValue: "批量删除失败，请稍后重试",
          }),
      );
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const deletableFilteredSessions = useMemo(
    () => filteredSessions.filter((session) => Boolean(session.sourcePath)),
    [filteredSessions],
  );

  const selectedSessions = useMemo(
    () =>
      sessions.filter((session) =>
        selectedSessionKeys.has(getSessionKey(session)),
      ),
    [sessions, selectedSessionKeys],
  );

  const selectedDeletableSessions = useMemo(
    () => selectedSessions.filter((session) => Boolean(session.sourcePath)),
    [selectedSessions],
  );

  useEffect(() => {
    if (!selectionMode) return;

    const visibleKeys = new Set(
      deletableFilteredSessions.map((session) => getSessionKey(session)),
    );

    setSelectedSessionKeys((current) => {
      let changed = false;
      const next = new Set<string>();

      current.forEach((key) => {
        if (visibleKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [deletableFilteredSessions, selectionMode]);

  const allFilteredSelected =
    deletableFilteredSessions.length > 0 &&
    deletableFilteredSessions.every((session) =>
      selectedSessionKeys.has(getSessionKey(session)),
    );

  const toggleSessionChecked = (session: SessionMeta, checked: boolean) => {
    if (!session.sourcePath) return;
    const key = getSessionKey(session);
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const handleToggleSelectAll = () => {
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        deletableFilteredSessions.forEach((session) =>
          next.delete(getSessionKey(session)),
        );
      } else {
        deletableFilteredSessions.forEach((session) =>
          next.add(getSessionKey(session)),
        );
      }
      return next;
    });
  };

  const openBatchDeleteDialog = () => {
    if (selectedDeletableSessions.length === 0) return;
    setDeleteTargets(selectedDeletableSessions);
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedSessionKeys(new Set());
  };

  const sessionGroups = useMemo<SessionProjectGroup[]>(() => {
    const groupMap = new Map<string, SessionProjectGroup>();

    filteredSessions.forEach((session) => {
      const key = getSessionProjectKey(session);
      const path = getSessionProjectPath(session) || null;
      const existing = groupMap.get(key);

      if (existing) {
        existing.sessions.push(session);
        existing.count += 1;
        if (path && existing.path && path.length < existing.path.length) {
          existing.path = path;
          existing.label = getProjectLabel(key, path);
        }
      } else {
        groupMap.set(key, {
          key,
          label: getProjectLabel(key, path),
          path,
          count: 1,
          sessions: [session],
        });
      }
    });

    return Array.from(groupMap.values());
  }, [filteredSessions, getProjectLabel]);

  useEffect(() => {
    const validGroupKeys = new Set(sessionGroups.map((group) => group.key));
    setCollapsedProjectKeys((current) => {
      let changed = false;
      const next = new Set<string>();

      current.forEach((key) => {
        if (validGroupKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [sessionGroups]);

  const toggleProjectGroup = useCallback((key: string) => {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  return (
    <TooltipProvider>
      <div
        className="flex w-full flex-1 min-h-0 flex-col px-4 sm:px-6"
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          {/* 主内容区域 - 左右分栏 */}
          <div className="flex-1 min-h-0 overflow-hidden grid gap-4 md:grid-cols-[minmax(17.5rem,20rem)_minmax(0,1fr)]">
            {/* 左侧会话列表 */}
            <Card className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <CardHeader className="py-2 px-3 border-b">
                {isSearchOpen ? (
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                      <Input
                        ref={searchInputRef}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t("sessionManager.searchPlaceholder")}
                        className="h-8 pl-8 pr-8 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setIsSearchOpen(false);
                            setSearch("");
                          }
                        }}
                        onBlur={() => {
                          if (search.trim() === "") {
                            setIsSearchOpen(false);
                          }
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1/2 -translate-y-1/2 size-6"
                        onClick={() => {
                          setIsSearchOpen(false);
                          setSearch("");
                        }}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                    {selectionMode && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="secondary"
                            size="icon"
                            className="size-7 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/60"
                            aria-label={t(
                              "sessionManager.exitBatchModeTooltip",
                              {
                                defaultValue: "退出批量管理",
                              },
                            )}
                            onClick={exitSelectionMode}
                          >
                            <CheckSquare className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t("sessionManager.exitBatchModeTooltip", {
                            defaultValue: "退出批量管理",
                          })}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div
                      data-testid="session-list-title-row"
                      className="flex items-center justify-between gap-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <CardTitle className="text-sm font-medium whitespace-nowrap">
                          {t("sessionManager.sessionList")}
                        </CardTitle>
                        <Badge variant="secondary" className="text-xs">
                          {filteredSessions.length}
                        </Badge>
                      </div>
                    </div>
                    <div
                      data-testid="session-list-filter-row"
                      className="grid min-w-0 grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-center gap-1"
                    >
                      {(selectionMode ||
                        deletableFilteredSessions.length > 0) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant={selectionMode ? "secondary" : "ghost"}
                              size="icon"
                              className={
                                selectionMode
                                  ? "size-7 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/60"
                                  : "size-7"
                              }
                              aria-label={
                                selectionMode
                                  ? t("sessionManager.exitBatchModeTooltip", {
                                      defaultValue: "退出批量管理",
                                    })
                                  : t("sessionManager.manageBatchTooltip", {
                                      defaultValue: "批量管理",
                                    })
                              }
                              onClick={() => {
                                if (selectionMode) {
                                  exitSelectionMode();
                                } else {
                                  setSelectionMode(true);
                                }
                              }}
                            >
                              <CheckSquare className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {selectionMode
                              ? t("sessionManager.exitBatchModeTooltip", {
                                  defaultValue: "退出批量管理",
                                })
                              : t("sessionManager.manageBatchTooltip", {
                                  defaultValue: "批量管理",
                                })}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() => {
                              setIsSearchOpen(true);
                              setTimeout(
                                () => searchInputRef.current?.focus(),
                                0,
                              );
                            }}
                          >
                            <Search className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t("sessionManager.searchSessions")}
                        </TooltipContent>
                      </Tooltip>

                      <Select
                        value={providerFilter}
                        onValueChange={(value) =>
                          setProviderFilter(value as ProviderFilter)
                        }
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SelectTrigger className="size-7 p-0 justify-center border-0 bg-transparent hover:bg-muted">
                              <ProviderIcon
                                icon={
                                  providerFilter === "all"
                                    ? "apps"
                                    : getProviderIconName(providerFilter)
                                }
                                name={providerFilter}
                                size={14}
                              />
                            </SelectTrigger>
                          </TooltipTrigger>
                          <TooltipContent>
                            {providerFilter === "all"
                              ? t("sessionManager.providerFilterAll")
                              : providerFilter}
                          </TooltipContent>
                        </Tooltip>
                        <SelectContent>
                          <SelectItem value="all">
                            <div className="flex items-center gap-2">
                              <ProviderIcon icon="apps" name="all" size={14} />
                              <span>
                                {t("sessionManager.providerFilterAll")}
                              </span>
                            </div>
                          </SelectItem>
                          <SelectItem value="codex">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="openai"
                                name="codex"
                                size={14}
                              />
                              <span>Codex</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="claude">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="claude"
                                name="claude"
                                size={14}
                              />
                              <span>Claude Code</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="opencode">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="opencode"
                                name="opencode"
                                size={14}
                              />
                              <span>OpenCode</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="openclaw">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="openclaw"
                                name="openclaw"
                                size={14}
                              />
                              <span>OpenClaw</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="gemini">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="gemini"
                                name="gemini"
                                size={14}
                              />
                              <span>Gemini CLI</span>
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      {projectOptions.length > 0 ? (
                        <Select
                          value={projectFilter}
                          onValueChange={setProjectFilter}
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <SelectTrigger
                                aria-label={t("sessionManager.projectFilter", {
                                  defaultValue: "项目筛选",
                                })}
                                className="h-7 min-w-0 gap-1.5 border-0 bg-transparent px-2 hover:bg-muted"
                              >
                                <SelectValue
                                  placeholder={t(
                                    "sessionManager.projectFilterAll",
                                    {
                                      defaultValue: "全部项目",
                                    },
                                  )}
                                />
                              </SelectTrigger>
                            </TooltipTrigger>
                            <TooltipContent>
                              {projectFilter === ALL_PROJECTS_FILTER
                                ? t("sessionManager.projectFilterAll", {
                                    defaultValue: "全部项目",
                                  })
                                : projectOptions.find(
                                    (option) => option.key === projectFilter,
                                  )?.path || t("sessionManager.projectFilter")}
                            </TooltipContent>
                          </Tooltip>
                          <SelectContent className="max-w-[300px]">
                            <SelectItem value={ALL_PROJECTS_FILTER}>
                              <div className="flex min-w-0 items-center gap-2">
                                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                                <span>
                                  {t("sessionManager.projectFilterAll", {
                                    defaultValue: "全部项目",
                                  })}
                                </span>
                              </div>
                            </SelectItem>
                            {projectOptions.map((option) => (
                              <SelectItem
                                key={option.key}
                                value={option.key}
                                title={option.path ?? option.label}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                                  <span className="truncate">
                                    {option.label}
                                  </span>
                                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                    {option.count}
                                  </span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <div />
                      )}

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() => void refetch()}
                          >
                            <RefreshCw className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("common.refresh")}</TooltipContent>
                      </Tooltip>
                    </div>
                    {selectionMode && (
                      <div className="grid gap-3 rounded-md border bg-muted/40 px-3 py-2.5">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-xs">
                            {t("sessionManager.selectedCount", {
                              defaultValue: "已选 {{count}} 项",
                              count: selectedDeletableSessions.length,
                            })}
                          </Badge>
                          <span className="truncate">
                            {t("sessionManager.batchModeHint", {
                              defaultValue: "勾选要删除的会话",
                            })}
                          </span>
                        </div>
                        <div className="grid gap-3 min-[520px]:grid-cols-[minmax(0,1fr)_auto] min-[520px]:items-center">
                          <div className="flex flex-wrap items-center gap-2">
                            {deletableFilteredSessions.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2.5 text-xs whitespace-nowrap"
                                onClick={handleToggleSelectAll}
                              >
                                {allFilteredSelected
                                  ? t("sessionManager.clearFilteredSelection", {
                                      defaultValue: "取消全选",
                                    })
                                  : t("sessionManager.selectAllFiltered", {
                                      defaultValue: "全选当前",
                                    })}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2.5 text-xs whitespace-nowrap"
                              onClick={() => setSelectedSessionKeys(new Set())}
                            >
                              {t("sessionManager.clearSelection", {
                                defaultValue: "清空已选",
                              })}
                            </Button>
                          </div>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 gap-1.5 px-2.5 whitespace-nowrap justify-self-start min-[520px]:justify-self-end"
                            onClick={openBatchDeleteDialog}
                            disabled={
                              isDeleting ||
                              selectedDeletableSessions.length === 0
                            }
                          >
                            <Trash2 className="size-3.5" />
                            <span className="text-xs">
                              {isBatchDeleting
                                ? t("sessionManager.batchDeleting", {
                                    defaultValue: "删除中...",
                                  })
                                : t("sessionManager.deleteSelected", {
                                    defaultValue: "批量删除",
                                  })}
                            </span>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex-1 min-h-0 p-0">
                <ScrollArea className="h-full">
                  <div className="p-2">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : filteredSessions.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <MessageSquare className="size-8 text-muted-foreground/50 mb-2" />
                        <p className="text-sm text-muted-foreground">
                          {t("sessionManager.noSessions")}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {sessionGroups.map((group) => {
                          const isCollapsed = collapsedProjectKeys.has(
                            group.key,
                          );

                          return (
                            <div key={group.key} className="min-w-0">
                              <button
                                type="button"
                                aria-expanded={!isCollapsed}
                                onClick={() => toggleProjectGroup(group.key)}
                                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                              >
                                {isCollapsed ? (
                                  <ChevronRight className="size-3.5 shrink-0" />
                                ) : (
                                  <ChevronDown className="size-3.5 shrink-0" />
                                )}
                                <FolderOpen className="size-3.5 shrink-0 text-foreground/70" />
                                <span
                                  className="min-w-0 flex-1 truncate font-semibold text-foreground"
                                  title={group.path ?? group.label}
                                >
                                  {group.label}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="h-5 shrink-0 px-1.5 text-[10px]"
                                >
                                  {group.count}
                                </Badge>
                              </button>
                              {!isCollapsed && (
                                <div className="mt-1 space-y-1 border-l border-border-default/70 pl-2">
                                  {group.sessions.map((session) => {
                                    const isSelected =
                                      selectedKey !== null &&
                                      getSessionKey(session) === selectedKey;

                                    return (
                                      <SessionItem
                                        key={getSessionKey(session)}
                                        session={session}
                                        isSelected={isSelected}
                                        selectionMode={selectionMode}
                                        searchQuery={search}
                                        isChecked={selectedSessionKeys.has(
                                          getSessionKey(session),
                                        )}
                                        isCheckDisabled={!session.sourcePath}
                                        onSelect={setSelectedKey}
                                        onToggleChecked={(checked) =>
                                          toggleSessionChecked(session, checked)
                                        }
                                        onContextMenu={(event) =>
                                          handleSessionContextMenu(
                                            event,
                                            session,
                                          )
                                        }
                                      />
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* 右侧会话详情 */}
            <Card
              className="flex flex-col overflow-hidden min-h-0"
              ref={detailRef}
            >
              {!selectedSession ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
                  <MessageSquare className="size-12 mb-3 opacity-30" />
                  <p className="text-sm">{t("sessionManager.selectSession")}</p>
                </div>
              ) : (
                <>
                  {/* 详情头部 */}
                  <CardHeader className="py-3 px-4 border-b shrink-0">
                    <div className="flex items-start justify-between gap-4">
                      {/* 左侧：会话信息 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="shrink-0">
                                <ProviderIcon
                                  icon={getProviderIconName(
                                    selectedSession.providerId,
                                  )}
                                  name={selectedSession.providerId}
                                  size={20}
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {getProviderLabel(selectedSession.providerId, t)}
                            </TooltipContent>
                          </Tooltip>
                          <h2 className="text-base font-semibold truncate">
                            {formatSessionTitle(selectedSession)}
                          </h2>
                        </div>

                        {/* 元信息 */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="size-3" />
                            <span>
                              {formatTimestamp(
                                selectedSession.lastActiveAt ??
                                  selectedSession.createdAt,
                              )}
                            </span>
                          </div>
                          {selectedSession.projectDir && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleCopy(
                                      selectedSession.projectDir!,
                                      t("sessionManager.projectDirCopied"),
                                    )
                                  }
                                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                                >
                                  <FolderOpen className="size-3" />
                                  <span className="truncate max-w-[200px]">
                                    {getBaseName(selectedSession.projectDir)}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="max-w-xs"
                              >
                                <p className="font-mono text-xs break-all">
                                  {selectedSession.projectDir}
                                </p>
                                <p className="text-muted-foreground mt-1">
                                  {t("sessionManager.clickToCopyPath")}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {selectedSession.sourcePath && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleCopy(
                                      selectedSession.sourcePath!,
                                      t("sessionManager.sourcePathCopied"),
                                    )
                                  }
                                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                                >
                                  <FileText className="size-3 shrink-0" />
                                  <span className="font-mono truncate max-w-[200px]">
                                    {getBaseName(selectedSession.sourcePath)}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="max-w-xs"
                              >
                                <p className="font-mono text-xs break-all">
                                  {selectedSession.sourcePath}
                                </p>
                                <p className="text-muted-foreground mt-1">
                                  {t("sessionManager.clickToCopyPath")}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>

                      {/* 右侧：操作按钮组 */}
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className={detailRenameButtonClass}
                              onClick={() =>
                                handleOpenRenameDialog(selectedSession)
                              }
                            >
                              <Pencil className="size-3.5" />
                              <span className="hidden sm:inline">
                                {t("sessionManager.rename", {
                                  defaultValue: "修改名称",
                                })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.renameTooltip", {
                              defaultValue: "仅在本应用中映射，不回写原会话",
                            })}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className={detailResumeButtonClass}
                              onClick={() => void handleResume()}
                              disabled={!selectedSession.resumeCommand}
                            >
                              <Play className="size-3.5" />
                              <span className="hidden sm:inline">
                                {t("sessionManager.resume", {
                                  defaultValue: "恢复会话",
                                })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {selectedSession.resumeCommand
                              ? t("sessionManager.resumeTooltip", {
                                  defaultValue: "在终端中恢复此会话",
                                })
                              : t("sessionManager.noResumeCommand", {
                                  defaultValue: "此会话无法恢复",
                                })}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className={detailExportButtonClass}
                              onClick={() => void handleExportSession()}
                              disabled={
                                !selectedSession.sourcePath ||
                                isExportingSession
                              }
                            >
                              <Download className="size-3.5" />
                              <span className="hidden sm:inline">
                                {isExportingSession
                                  ? t("sessionManager.exporting", {
                                      defaultValue: "导出中...",
                                    })
                                  : t("sessionManager.export", {
                                      defaultValue: "导出会话",
                                    })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.exportTooltip", {
                              defaultValue: "导出当前会话内容为 Markdown",
                            })}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className={detailDeleteButtonClass}
                              onClick={() =>
                                setDeleteTargets([selectedSession])
                              }
                              disabled={
                                !selectedSession.sourcePath || isDeleting
                              }
                            >
                              <Trash2 className="size-3.5" />
                              <span className="hidden sm:inline">
                                {isDeleting
                                  ? t("sessionManager.deleting", {
                                      defaultValue: "删除中...",
                                    })
                                  : t("sessionManager.delete", {
                                      defaultValue: "删除会话",
                                    })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.deleteTooltip", {
                              defaultValue: "永久删除此本地会话记录",
                            })}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    {/* 恢复命令预览 */}
                    {selectedSession.resumeCommand && (
                      <div className="mt-3 flex items-center gap-2">
                        <div className="flex-1 rounded-md bg-muted/60 px-3 py-1.5 font-mono text-xs text-muted-foreground truncate">
                          {selectedSession.resumeCommand}
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              onClick={() =>
                                void handleCopy(
                                  selectedSession.resumeCommand!,
                                  t("sessionManager.resumeCommandCopied"),
                                )
                              }
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.copyCommand", {
                              defaultValue: "复制命令",
                            })}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    )}
                  </CardHeader>

                  {/* 消息列表区域 */}
                  <CardContent className="flex-1 min-h-0 p-0">
                    <div className="flex h-full min-w-0">
                      {/* 消息列表 */}
                      <div className="flex-1 min-w-0 flex flex-col">
                        <div className="px-4 pt-4 pb-2 min-w-0">
                          <div className="flex items-center gap-2">
                            <MessageSquare className="size-4 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              {t("sessionManager.conversationHistory", {
                                defaultValue: "对话记录",
                              })}
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              {messages.length}
                            </Badge>
                          </div>
                        </div>
                        <div
                          ref={scrollContainerRef}
                          className="flex-1 overflow-y-auto px-4 pb-4 min-w-0"
                        >
                          {isLoadingMessages ? (
                            <div className="flex items-center justify-center py-12">
                              <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                            </div>
                          ) : messages.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 text-center">
                              <MessageSquare className="size-8 text-muted-foreground/50 mb-2" />
                              <p className="text-sm text-muted-foreground">
                                {t("sessionManager.emptySession")}
                              </p>
                            </div>
                          ) : (
                            <div
                              style={{
                                height: virtualizer.getTotalSize(),
                                position: "relative",
                              }}
                            >
                              {virtualizer
                                .getVirtualItems()
                                .map((virtualRow) => (
                                  <div
                                    key={virtualRow.key}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                      position: "absolute",
                                      top: 0,
                                      left: 0,
                                      width: "100%",
                                      transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                  >
                                    <SessionMessageItem
                                      message={messages[virtualRow.index]}
                                      isActive={
                                        activeMessageIndex === virtualRow.index
                                      }
                                      searchQuery={search}
                                      onCopy={handleMessageCopy}
                                    />
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 右侧目录 - 类似少数派 (大屏幕) */}
                      <SessionTocSidebar
                        items={userMessagesToc}
                        onItemClick={scrollToMessage}
                      />
                    </div>

                    {/* 浮动目录按钮 (小屏幕) */}
                    <SessionTocDialog
                      items={userMessagesToc}
                      onItemClick={scrollToMessage}
                      open={tocDialogOpen}
                      onOpenChange={setTocDialogOpen}
                    />
                  </CardContent>
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
      {contextMenuPosition && contextMenuSession && (
        <div
          role="menu"
          aria-label={formatSessionTitle(contextMenuSession)}
          className="fixed z-50 w-40 overflow-hidden rounded-md border border-border-default bg-popover p-1 text-popover-foreground shadow-md"
          style={{
            left: contextMenuPosition.x,
            top: contextMenuPosition.y,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus:bg-accent"
            onClick={() => {
              handleOpenRenameDialog(contextMenuSession);
            }}
          >
            <Pencil className="size-3.5" />
            {t("sessionManager.rename", { defaultValue: "修改名称" })}
          </button>
          <div className="-mx-1 my-1 h-px bg-border-default" />
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenuSession.sourcePath}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus:bg-accent",
              contextMenuSession.sourcePath
                ? "text-destructive"
                : "cursor-not-allowed opacity-50",
            )}
            onClick={() => {
              if (contextMenuSession.sourcePath) {
                setDeleteTargets([contextMenuSession]);
                closeSessionContextMenu();
              }
            }}
          >
            <Trash2 className="size-3.5" />
            {t("sessionManager.delete", { defaultValue: "删除会话" })}
          </button>
        </div>
      )}
      <ConfirmDialog
        isOpen={Boolean(deleteTargets)}
        title={
          deleteTargets && deleteTargets.length > 1
            ? t("sessionManager.batchDeleteConfirmTitle", {
                defaultValue: "批量删除会话",
              })
            : t("sessionManager.deleteConfirmTitle", {
                defaultValue: "删除会话",
              })
        }
        message={
          deleteTargets && deleteTargets.length > 1
            ? t("sessionManager.batchDeleteConfirmMessage", {
                defaultValue:
                  "将永久删除已选中的 {{count}} 个本地会话记录。\n\n此操作不可恢复。",
                count: deleteTargets.length,
              })
            : deleteTargets?.[0]
              ? t("sessionManager.deleteConfirmMessage", {
                  defaultValue:
                    "将永久删除本地会话“{{title}}”\nSession ID: {{sessionId}}\n\n此操作不可恢复。",
                  title: formatSessionTitle(deleteTargets[0]),
                  sessionId: deleteTargets[0].sessionId,
                })
              : ""
        }
        confirmText={
          deleteTargets && deleteTargets.length > 1
            ? t("sessionManager.batchDeleteConfirmAction", {
                defaultValue: "删除所选会话",
              })
            : t("sessionManager.deleteConfirmAction", {
                defaultValue: "删除会话",
              })
        }
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        variant="destructive"
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => {
          if (!isDeleting) {
            setDeleteTargets(null);
          }
        }}
      />
      <Dialog
        open={Boolean(renameSession)}
        onOpenChange={(open) => {
          if (!open && !isSavingRename) {
            setRenameSession(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("sessionManager.renameDialogTitle", {
                defaultValue: "修改会话标题",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("sessionManager.renameDialogDescription", {
                defaultValue:
                  "输入新的会话标题，留空则恢复自动生成的默认标题。",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 pb-6 pt-4">
            <div className="space-y-2">
              <Label htmlFor="session-rename-input">
                {t("sessionManager.renameInputLabel", {
                  defaultValue: "会话名称/标题",
                })}
              </Label>
              <Input
                id="session-rename-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                maxLength={120}
                placeholder={t("sessionManager.renameInputPlaceholder", {
                  defaultValue: "输入标题，留空则恢复自动标题",
                })}
                disabled={isSavingRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSaveRename();
                  }
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setRenameSession(null);
                  setRenameValue("");
                }}
                disabled={isSavingRename}
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </Button>
              <Button
                onClick={() => void handleSaveRename()}
                disabled={isSavingRename}
              >
                {isSavingRename
                  ? t("common.saving", { defaultValue: "保存中..." })
                  : t("common.save", { defaultValue: "保存" })}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
