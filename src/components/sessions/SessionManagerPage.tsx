import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSessionSearch } from "@/hooks/useSessionSearch";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Copy,
  RefreshCw,
  Search,
  Play,
  MessageSquare,
  Clock,
  FolderOpen,
  Lock,
  Unlock,
  X,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import { useSessionMessagesQuery, useSessionsQuery } from "@/lib/query";
import {
  useAppProxyConfig,
  useRemoveSessionProviderBinding,
  useSessionProviderBinding,
  useSessionProviderBindings,
  useSetSessionProviderBindingPin,
  useSwitchSessionProviderBinding,
} from "@/lib/query/proxy";
import { sessionsApi } from "@/lib/api";
import { proxyApi } from "@/lib/api/proxy";
import { providersApi } from "@/lib/api/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import { SessionItem } from "./SessionItem";
import { SessionMessageItem } from "./SessionMessageItem";
import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";
import type { AppId } from "@/lib/api";
import {
  formatSessionTitle,
  formatTimestamp,
  getBaseName,
  getProviderIconName,
  getProviderLabel,
  getSessionKey,
} from "./utils";

type ProviderFilter =
  | "all"
  | "codex"
  | "claude"
  | "opencode"
  | "openclaw"
  | "gemini";

interface SessionBindingPreview {
  providerId: string;
  providerName: string;
  pinned: boolean;
}

function buildBindingLookupKeys(appType: string, sessionId: string): string[] {
  const normalizedAppType = (appType || "").toLowerCase();
  const keys = [`${normalizedAppType}:${sessionId}`];

  if (normalizedAppType === "codex") {
    if (sessionId.startsWith("codex_")) {
      const canonicalSessionId = sessionId.slice("codex_".length);
      if (canonicalSessionId) {
        keys.push(`${normalizedAppType}:${canonicalSessionId}`);
      }
    } else {
      keys.push(`${normalizedAppType}:codex_${sessionId}`);
    }
  }

  return keys;
}

export function SessionManagerPage({ appId }: { appId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, refetch } = useSessionsQuery();
  const sessions = data ?? [];
  const detailRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const activeMessageTimerRef = useRef<number | null>(null);
  const [activeMessageIndex, setActiveMessageIndex] = useState<number | null>(
    null,
  );
  const [tocDialogOpen, setTocDialogOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [bindingProviderPickerOpen, setBindingProviderPickerOpen] =
    useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(
    appId as ProviderFilter,
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // 娴ｈ法鏁?FlexSearch 閸忋劍鏋冮幖婊呭偍
  const { search: searchSessions } = useSessionSearch({
    sessions,
    providerFilter,
  });

  const filteredSessions = useMemo(() => {
    return searchSessions(search);
  }, [searchSessions, search]);

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

  const selectedSessionAppType = selectedSession?.providerId;
  const { data: selectedAppProxyConfig } = useAppProxyConfig(
    selectedSessionAppType ?? appId,
  );
  const isSessionRoutingEnabledForSelection =
    selectedSession != null &&
    selectedAppProxyConfig?.sessionRoutingEnabled === true;

  const { data: sessionBinding, isLoading: isLoadingSessionBinding } =
    useSessionProviderBinding(
      selectedSessionAppType,
      selectedSession?.sessionId,
      selectedAppProxyConfig?.sessionIdleTtlMinutes,
    );
  const switchSessionProviderBinding = useSwitchSessionProviderBinding();
  const removeSessionProviderBinding = useRemoveSessionProviderBinding();
  const setSessionProviderBindingPin = useSetSessionProviderBindingPin();
  const { data: providersMap = {} } = useQuery({
    queryKey: ["providers", selectedSessionAppType, "session-manager"],
    queryFn: () => providersApi.getAll(selectedSessionAppType as AppId),
    enabled: Boolean(selectedSessionAppType),
    staleTime: 30 * 1000,
  });
  const providerOptions = useMemo(() => {
    return Object.values(providersMap).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [providersMap]);
  const { data: selectedCurrentProviderId = "" } = useQuery({
    queryKey: ["sessionManagerCurrentProvider", selectedSessionAppType],
    queryFn: () => providersApi.getCurrent(selectedSessionAppType as AppId),
    enabled: Boolean(selectedSessionAppType),
    staleTime: 30 * 1000,
  });
  const { data: sessionOccupancy = [] } = useQuery({
    queryKey: [
      "sessionManagerProviderOccupancy",
      selectedSessionAppType,
      selectedAppProxyConfig?.sessionIdleTtlMinutes,
    ],
    queryFn: () =>
      proxyApi.getProviderSessionOccupancy(
        selectedSessionAppType as string,
        selectedAppProxyConfig?.sessionIdleTtlMinutes,
      ),
    enabled: Boolean(selectedSessionAppType && isSessionRoutingEnabledForSelection),
    refetchInterval: 5000,
  });
  const { data: codexBindings = [] } = useSessionProviderBindings("codex");
  const { data: claudeBindings = [] } = useSessionProviderBindings("claude");
  const { data: opencodeBindings = [] } =
    useSessionProviderBindings("opencode");
  const { data: openclawBindings = [] } =
    useSessionProviderBindings("openclaw");
  const { data: geminiBindings = [] } = useSessionProviderBindings("gemini");

  const sessionBindingPreviewMap = useMemo(() => {
    const map = new Map<string, SessionBindingPreview>();
    const allBindings = [
      ...codexBindings,
      ...claudeBindings,
      ...opencodeBindings,
      ...openclawBindings,
      ...geminiBindings,
    ];

    for (const binding of allBindings) {
      if (!binding.isActive) {
        continue;
      }
      const providerName = binding.providerName?.trim() || binding.providerId;
      const preview: SessionBindingPreview = {
        providerId: binding.providerId,
        providerName,
        pinned: binding.pinned,
      };
      for (const key of buildBindingLookupKeys(
        binding.appType,
        binding.sessionId,
      )) {
        map.set(key, preview);
      }
    }

    return map;
  }, [
    claudeBindings,
    codexBindings,
    geminiBindings,
    opencodeBindings,
    openclawBindings,
  ]);

  const handleSwitchSessionProvider = async (providerId: string) => {
    if (!selectedSessionAppType || !selectedSession?.sessionId) return;
    try {
      await switchSessionProviderBinding.mutateAsync({
        appType: selectedSessionAppType,
        sessionId: selectedSession.sessionId,
        providerId,
        pin: sessionBinding?.pinned ?? false,
      });
      toast.success(
        t("sessionManager.bindingSwitchSuccess", {
          defaultValue: "会话绑定已切换",
        }),
      );
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.bindingSwitchFailed", {
            defaultValue: "切换会话绑定失败",
          }),
      );
    }
  };

  useEffect(() => {
    setBindingProviderPickerOpen(false);
  }, [selectedKey]);

  const handleToggleSessionPin = async () => {
    if (
      !selectedSessionAppType ||
      !selectedSession?.sessionId ||
      !sessionBinding
    )
      return;
    try {
      await setSessionProviderBindingPin.mutateAsync({
        appType: selectedSessionAppType,
        sessionId: selectedSession.sessionId,
        pinned: !sessionBinding.pinned,
      });
      toast.success(
        !sessionBinding.pinned
          ? t("sessionManager.bindingPinned", {
              defaultValue: "会话绑定已锁定",
            })
          : t("sessionManager.bindingAuto", {
              defaultValue: "会话绑定已切回自动",
            }),
      );
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.bindingPinFailed", {
            defaultValue: "更新会话绑定状态失败",
          }),
      );
    }
  };

  const handleRemoveSessionBinding = async () => {
    if (!selectedSessionAppType || !selectedSession?.sessionId) return;
    try {
      await removeSessionProviderBinding.mutateAsync({
        appType: selectedSessionAppType,
        sessionId: selectedSession.sessionId,
      });
      toast.success(
        t("sessionManager.bindingRemoved", {
          defaultValue: "会话绑定已解绑",
        }),
      );
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.bindingRemoveFailed", {
            defaultValue: "解绑会话绑定失败",
          }),
      );
    }
  };

  const occupancyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of sessionOccupancy) {
      map.set(item.providerId, item.sessionCount);
    }
    return map;
  }, [sessionOccupancy]);

  const routingStrategyLabel = useMemo(() => {
    const strategy = selectedAppProxyConfig?.sessionRoutingStrategy;
    if (!strategy) return "-";
    return t(`proxy.routingStrategy.${strategy}`, {
      defaultValue: strategy,
    });
  }, [selectedAppProxyConfig?.sessionRoutingStrategy, t]);

  const sessionRoutingExplainRows = useMemo(() => {
    return providerOptions.map((provider) => {
      const sessionCount = occupancyMap.get(provider.id) ?? 0;
      const isBound = sessionBinding?.providerId === provider.id;
      const isPinned = isBound && sessionBinding?.pinned;
      const isCurrentProvider = selectedCurrentProviderId === provider.id;
      const isDefaultProvider =
        !!selectedAppProxyConfig?.sessionDefaultProviderId &&
        selectedAppProxyConfig.sessionDefaultProviderId === provider.id;
      const maxSessions =
        selectedAppProxyConfig?.sessionMaxSessionsPerProvider ?? 0;
      const isAtCapacity = maxSessions > 0 && sessionCount >= maxSessions;

      const reasons = [
        isBound
          ? isPinned
            ? t("sessionManager.routingReasonPinned", {
                defaultValue: "当前会话已锁定到此 provider",
              })
            : t("sessionManager.routingReasonBound", {
                defaultValue: "当前会话当前绑定到此 provider",
              })
          : null,
        isDefaultProvider
          ? t("sessionManager.routingReasonDefault", {
              defaultValue: "这是会话路由默认 provider",
            })
          : null,
        !selectedAppProxyConfig?.sessionDefaultProviderId && isCurrentProvider
          ? t("sessionManager.routingReasonFollowCurrent", {
              defaultValue: "默认策略为空时，会跟随当前 provider",
            })
          : null,
        isAtCapacity
          ? t("sessionManager.routingReasonAtCapacity", {
              defaultValue: "已达到会话上限",
            })
          : t("sessionManager.routingReasonCapacityOk", {
              defaultValue: "仍可承载更多会话",
            }),
      ].filter(Boolean) as string[];

      return {
        providerId: provider.id,
        providerName: provider.name,
        sessionCount,
        isBound,
        isPinned,
        isCurrentProvider,
        isDefaultProvider,
        isAtCapacity,
        reasons,
      };
    });
  }, [
    occupancyMap,
    providerOptions,
    selectedAppProxyConfig?.sessionDefaultProviderId,
    selectedAppProxyConfig?.sessionMaxSessionsPerProvider,
    selectedCurrentProviderId,
    sessionBinding?.pinned,
    sessionBinding?.providerId,
    t,
  ]);

  const { data: messages = [], isLoading: isLoadingMessages } =
    useSessionMessagesQuery(
      selectedSession?.providerId,
      selectedSession?.sourcePath,
    );

  // 閹绘劕褰囬悽銊﹀煕濞戝牊浼呴悽銊ょ艾閻╊喖缍?
  const userMessagesToc = useMemo(() => {
    return messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => (msg.role ?? "").toLowerCase() === "user")
      .map(({ msg, index }) => ({
        index,
        preview:
          msg.content.slice(0, 50) + (msg.content.length > 50 ? "..." : ""),
        ts: msg.ts,
      }));
  }, [messages]);

  const scrollToMessage = (index: number) => {
    const el = messageRefs.current.get(index);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setActiveMessageIndex(index);
      setTocDialogOpen(false);

      if (activeMessageTimerRef.current !== null) {
        window.clearTimeout(activeMessageTimerRef.current);
      }
      activeMessageTimerRef.current = window.setTimeout(() => {
        setActiveMessageIndex(null);
        activeMessageTimerRef.current = null;
      }, 2000);
    }
  };

  useEffect(() => {
    return () => {
      if (activeMessageTimerRef.current !== null) {
        window.clearTimeout(activeMessageTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("common.error", { defaultValue: "Copy failed" }),
      );
    }
  };

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
      await handleCopy(fallback, t("sessionManager.resumeFallbackCopied"));
      toast.error(extractErrorMessage(error) || t("sessionManager.openFailed"));
    }
  };

  const handleDeleteSession = async () => {
    if (
      !selectedSession?.providerId ||
      !selectedSession.sessionId ||
      !selectedSession.sourcePath
    ) {
      return;
    }

    try {
      await sessionsApi.delete({
        providerId: selectedSession.providerId,
        sessionId: selectedSession.sessionId,
        sourcePath: selectedSession.sourcePath,
      });
      setDeleteDialogOpen(false);
      toast.success(
        t("sessionManager.deleteSuccess", {
          defaultValue: "会话已删除",
        }),
      );
      await refetch();
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.deleteFailed", {
            defaultValue: "删除会话失败",
          }),
      );
    }
  };
  const deleteSessionTitle = selectedSession
    ? formatSessionTitle(selectedSession)
    : "";

  return (
    <TooltipProvider>
      <div className="mx-auto w-full px-4 sm:px-6 pb-6 flex flex-col h-full min-h-0">
        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          {/* 娑撹鍞寸€圭懓灏崺?- 瀹革箑褰搁崚鍡樼埉 */}
          <div className="flex-1 overflow-hidden grid gap-4 md:grid-cols-[320px_1fr]">
            {/* 瀹革缚鏅舵导姘崇樈閸掓銆?*/}
            <Card className="flex flex-col overflow-hidden">
              <CardHeader className="py-2 px-3 border-b">
                {isSearchOpen ? (
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
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-sm font-medium">
                        {t("sessionManager.sessionList")}
                      </CardTitle>
                      <Badge variant="secondary" className="text-xs">
                        {filteredSessions.length}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1">
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
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden p-0">
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
                      <div className="space-y-1">
                        {filteredSessions.map((session) => {
                          const isSelected =
                            selectedKey !== null &&
                            getSessionKey(session) === selectedKey;
                          const bindingPreview = buildBindingLookupKeys(
                            session.providerId,
                            session.sessionId,
                          )
                            .map((key) => sessionBindingPreviewMap.get(key))
                            .find((item) => item != null);

                          return (
                            <SessionItem
                              key={getSessionKey(session)}
                              session={session}
                              isSelected={isSelected}
                              onSelect={setSelectedKey}
                              bindingProviderName={bindingPreview?.providerName}
                              bindingProviderId={bindingPreview?.providerId}
                              bindingPinned={bindingPreview?.pinned}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* 閸欏厖鏅舵导姘崇樈鐠囷附鍎?*/}
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
                  {/* 鐠囷附鍎忔径鎾劥 */}
                  <CardHeader className="py-3 px-4 border-b shrink-0">
                    <div className="flex items-start justify-between gap-4">
                      {/* 瀹革缚鏅堕敍姘窗鐠囨繀淇婇幁?*/}
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

                        {/* 閸忓啩淇婇幁?*/}
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
                        </div>

                        <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium">
                              {t("sessionManager.bindingSectionTitle", {
                                defaultValue: "会话路由绑定",
                              })}
                            </span>
                            <Badge
                              variant={
                                selectedAppProxyConfig?.sessionRoutingEnabled ===
                                true
                                  ? "default"
                                  : "secondary"
                              }
                              className="text-[11px]"
                            >
                              {t("sessionManager.bindingAppStatus", {
                                defaultValue: "应用：{{status}}",
                                status:
                                  selectedAppProxyConfig?.sessionRoutingEnabled ===
                                  true
                                    ? t("common.enabled", {
                                        defaultValue: "启用",
                                      })
                                    : t("common.disabled", {
                                        defaultValue: "停用",
                                      }),
                              })}
                            </Badge>
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge
                              variant={
                                sessionBinding?.isActive
                                  ? "default"
                                  : "secondary"
                              }
                              className="text-[11px]"
                            >
                              {isLoadingSessionBinding
                                ? t("sessionManager.bindingLoading", {
                                    defaultValue: "绑定读取中...",
                                  })
                                : t("sessionManager.bindingProvider", {
                                    defaultValue: "绑定：{{provider}}",
                                    provider:
                                      sessionBinding?.providerName ??
                                      sessionBinding?.providerId ??
                                      t("sessionManager.bindingNone", {
                                        defaultValue: "未分配",
                                      }),
                                  })}
                            </Badge>

                            <Badge variant="outline" className="text-[11px]">
                              {sessionBinding
                                ? sessionBinding.pinned
                                  ? t("sessionManager.bindingModePinned", {
                                      defaultValue: "模式：已绑定（锁定）",
                                    })
                                  : t("sessionManager.bindingModeAuto", {
                                      defaultValue: "模式：自动",
                                    })
                                : t("sessionManager.bindingModeNone", {
                                    defaultValue: "模式：未绑定",
                                  })}
                            </Badge>

                            {isSessionRoutingEnabledForSelection ? (
                              <>
                                <Popover
                                  open={bindingProviderPickerOpen}
                                  onOpenChange={(open) => {
                                    if (
                                      switchSessionProviderBinding.isPending ||
                                      providerOptions.length === 0
                                    ) {
                                      return;
                                    }
                                    setBindingProviderPickerOpen(open);
                                  }}
                                >
                                  <PopoverTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      role="combobox"
                                      aria-expanded={bindingProviderPickerOpen}
                                      className="h-7 w-[220px] justify-between px-2 text-xs font-normal"
                                      disabled={
                                        switchSessionProviderBinding.isPending ||
                                        providerOptions.length === 0
                                      }
                                    >
                                      <span className="truncate text-left">
                                        {sessionBinding?.providerName ??
                                          providerOptions.find(
                                            (provider) =>
                                              provider.id ===
                                              sessionBinding?.providerId,
                                          )?.name ??
                                          t(
                                            "sessionManager.bindingSwitchPlaceholder",
                                            {
                                              defaultValue: "选择提供商",
                                            },
                                          )}
                                      </span>
                                      <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    className="w-[320px] p-0"
                                    align="start"
                                  >
                                    <Command>
                                      <CommandInput
                                        placeholder={t(
                                          "sessionManager.bindingSwitchPlaceholder",
                                          {
                                            defaultValue: "搜索提供商",
                                          },
                                        )}
                                        className="h-8 text-xs"
                                      />
                                      <CommandList className="max-h-64 overflow-y-auto">
                                        <CommandEmpty>
                                          {t("sessionManager.bindingNone", {
                                            defaultValue: "无可用提供商",
                                          })}
                                        </CommandEmpty>
                                        {providerOptions.map((provider) => (
                                          <CommandItem
                                            key={provider.id}
                                            value={`${provider.name} ${provider.id}`}
                                            onSelect={() => {
                                              setBindingProviderPickerOpen(
                                                false,
                                              );
                                              if (
                                                provider.id !==
                                                sessionBinding?.providerId
                                              ) {
                                                void handleSwitchSessionProvider(
                                                  provider.id,
                                                );
                                              }
                                            }}
                                          >
                                            <Check
                                              className={`size-3.5 ${provider.id === sessionBinding?.providerId ? "opacity-100" : "opacity-0"}`}
                                            />
                                            <span className="truncate">
                                              {provider.name}
                                            </span>
                                          </CommandItem>
                                        ))}
                                      </CommandList>
                                    </Command>
                                  </PopoverContent>
                                </Popover>

                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs gap-1"
                                  onClick={() => void handleToggleSessionPin()}
                                  title={
                                    sessionBinding?.pinned
                                      ? t("sessionManager.bindingPinnedHint", {
                                          defaultValue:
                                            "锁定（已绑定）：优先使用当前提供商；若该提供商降级/熔断或不可用，系统仍会自动迁移并释放占用。",
                                        })
                                      : t("sessionManager.bindingAutoHint", {
                                          defaultValue:
                                            "自动：系统根据会话路由策略自动分配提供商，并在降级/熔断或容量变化时自动重绑定。",
                                        })
                                  }
                                  disabled={
                                    !sessionBinding ||
                                    setSessionProviderBindingPin.isPending
                                  }
                                >
                                  {sessionBinding?.pinned ? (
                                    <Lock className="size-3.5" />
                                  ) : (
                                    <Unlock className="size-3.5" />
                                  )}
                                  {sessionBinding?.pinned
                                    ? t("sessionManager.bindingPinnedShort", {
                                        defaultValue: "已锁定",
                                      })
                                    : t("sessionManager.bindingAutoShort", {
                                        defaultValue: "自动",
                                      })}
                                </Button>

                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs gap-1"
                                  onClick={() =>
                                    void handleRemoveSessionBinding()
                                  }
                                  disabled={
                                    !sessionBinding ||
                                    removeSessionProviderBinding.isPending
                                  }
                                >
                                  <X className="size-3.5" />
                                  {t("sessionManager.bindingRemove", {
                                    defaultValue: "解绑",
                                  })}
                                </Button>

                                <p className="w-full text-[11px] text-muted-foreground">
                                  {t("sessionManager.bindingModeHint", {
                                    defaultValue:
                                      "自动：按策略分配并可自动迁移。已绑定（锁定）：优先使用当前提供商，但当提供商降级/熔断或不可用时仍会自动释放并迁移。",
                                  })}
                                </p>
                              </>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                {t("sessionManager.bindingDisabled", {
                                  defaultValue: "当前应用未启用会话路由",
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {selectedSession && (
                        <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-[11px]">
                              {t("sessionManager.routingStrategy", {
                                defaultValue: "策略：{{strategy}}",
                                strategy: routingStrategyLabel,
                              })}
                            </Badge>
                            <Badge variant="outline" className="text-[11px]">
                              {selectedAppProxyConfig?.sessionDefaultProviderId
                                ? t("sessionManager.routingDefaultProvider", {
                                    defaultValue: "默认：{{provider}}",
                                    provider:
                                      providersMap[
                                        selectedAppProxyConfig
                                          .sessionDefaultProviderId
                                      ]?.name ??
                                      selectedAppProxyConfig
                                        .sessionDefaultProviderId,
                                  })
                                : t("sessionManager.routingDefaultFollowCurrent", {
                                    defaultValue: "默认：跟随当前 provider",
                                  })}
                            </Badge>
                            <Badge variant="outline" className="text-[11px]">
                              {t("sessionManager.routingCapacityRule", {
                                defaultValue:
                                  "容量：{{max}} / 共享{{shared}}",
                                max:
                                  selectedAppProxyConfig?.sessionMaxSessionsPerProvider ??
                                  0,
                                shared:
                                  selectedAppProxyConfig?.sessionAllowSharedWhenExhausted
                                    ? "ON"
                                    : "OFF",
                              })}
                            </Badge>
                          </div>

                          {isSessionRoutingEnabledForSelection ? (
                            <div className="mt-3 grid gap-2 md:grid-cols-2">
                              {sessionRoutingExplainRows.map((row) => (
                                <div
                                  key={row.providerId}
                                  className={cn(
                                    "rounded-lg border px-3 py-2",
                                    row.isBound
                                      ? "border-primary/40 bg-primary/5"
                                      : "border-border/60 bg-background/70",
                                  )}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-medium">
                                        {row.providerName}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground">
                                        {row.providerId}
                                      </div>
                                    </div>
                                    <Badge
                                      variant="secondary"
                                      className="shrink-0 text-[11px]"
                                    >
                                      {t("sessionManager.routingOccupancy", {
                                        defaultValue: "占用 {{count}}",
                                        count: row.sessionCount,
                                      })}
                                    </Badge>
                                  </div>

                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {row.isBound && (
                                      <Badge className="text-[10px]">
                                        {row.isPinned
                                          ? t(
                                              "sessionManager.routingBadgePinned",
                                              {
                                                defaultValue: "已锁定",
                                              },
                                            )
                                          : t(
                                              "sessionManager.routingBadgeBound",
                                              {
                                                defaultValue: "当前绑定",
                                              },
                                            )}
                                      </Badge>
                                    )}
                                    {row.isDefaultProvider && (
                                      <Badge
                                        variant="outline"
                                        className="text-[10px]"
                                      >
                                        {t(
                                          "sessionManager.routingBadgeDefault",
                                          {
                                            defaultValue: "默认 provider",
                                          },
                                        )}
                                      </Badge>
                                    )}
                                    {row.isCurrentProvider && (
                                      <Badge
                                        variant="outline"
                                        className="text-[10px]"
                                      >
                                        {t(
                                          "sessionManager.routingBadgeCurrent",
                                          {
                                            defaultValue: "当前 provider",
                                          },
                                        )}
                                      </Badge>
                                    )}
                                    {row.isAtCapacity && (
                                      <Badge
                                        variant="outline"
                                        className="text-[10px]"
                                      >
                                        {t(
                                          "sessionManager.routingBadgeAtCapacity",
                                          {
                                            defaultValue: "达到上限",
                                          },
                                        )}
                                      </Badge>
                                    )}
                                  </div>

                                  <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                                    {row.reasons.map((reason) => (
                                      <li key={`${row.providerId}:${reason}`}>
                                        {reason}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-3 text-[11px] text-muted-foreground">
                              {t("sessionManager.bindingDisabled", {
                                defaultValue: "当前应用未启用会话路由",
                              })}
                            </p>
                          )}
                        </div>
                      )}

                      {/* 閸欏厖鏅堕敍姘惙娴ｆ粍瀵滈柦顔剧矋 */}
                      <div className="flex items-center gap-2 shrink-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              className="gap-1.5"
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
                                  defaultValue: "此会话暂无恢复命令",
                                })}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1.5 text-rose-500 hover:text-rose-600"
                              onClick={() => setDeleteDialogOpen(true)}
                              disabled={!selectedSession.sourcePath}
                              aria-label={t("sessionManager.delete", {
                                defaultValue: "删除会话",
                              })}
                            >
                              <X className="size-3.5" />
                              <span className="hidden sm:inline">
                                {t("sessionManager.delete", {
                                  defaultValue: "删除会话",
                                })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.deleteTooltip", {
                              defaultValue: "从本地列表中删除此会话记录",
                            })}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    {/* 閹垹顦查崨鎴掓姢妫板嫯顫?*/}
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

                  {/* 濞戝牊浼呴崚妤勩€冮崠鍝勭厵 */}
                  <CardContent className="flex-1 overflow-hidden p-0">
                    <div className="flex h-full">
                      {/* 濞戝牊浼呴崚妤勩€?*/}
                      <ScrollArea className="flex-1">
                        <div className="p-4">
                          <div className="flex items-center gap-2 mb-3">
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
                            <div className="space-y-3">
                              {messages.map((message, index) => (
                                <SessionMessageItem
                                  key={`${message.role}-${index}`}
                                  message={message}
                                  index={index}
                                  isActive={activeMessageIndex === index}
                                  setRef={(el) => {
                                    if (el) messageRefs.current.set(index, el);
                                  }}
                                  onCopy={(content) =>
                                    handleCopy(
                                      content,
                                      t("sessionManager.messageCopied", {
                                        defaultValue: "消息内容已复制",
                                      }),
                                    )
                                  }
                                />
                              ))}
                              <div ref={messagesEndRef} />
                            </div>
                          )}
                        </div>
                      </ScrollArea>

                      {/* 閸欏厖鏅堕惄顔肩秿 - 缁鎶€鐏忔垶鏆熷ú?(婢堆冪潌楠? */}
                      <SessionTocSidebar
                        items={userMessagesToc}
                        onItemClick={scrollToMessage}
                      />
                    </div>

                    {/* 濞搭喖濮╅惄顔肩秿閹稿鎸?(鐏忓繐鐫嗛獮? */}
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
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title={t("sessionManager.deleteConfirmTitle", {
          defaultValue: "删除会话",
        })}
        message={t("sessionManager.deleteConfirmMessage", {
          defaultValue: `确认删除会话 “${deleteSessionTitle}” 吗？`,
        })}
        confirmText={t("sessionManager.delete", {
          defaultValue: "删除会话",
        })}
        cancelText={t("common.cancel", {
          defaultValue: "取消",
        })}
        onConfirm={() => void handleDeleteSession()}
        onCancel={() => setDeleteDialogOpen(false)}
      />
    </TooltipProvider>
  );
}
