import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Info,
  Loader2,
  RefreshCw,
  Terminal,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { settingsApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import appIcon from "@/assets/icons/app-icon.png";
import { isWindows } from "@/lib/platform";

interface AboutSectionProps {
  isPortable: boolean;
}

interface ToolVersion {
  name: string;
  version: string | null;
  latest_version: string | null;
  error: string | null;
  install_source: "native" | "npm" | null;
  env_type: "windows" | "wsl" | "macos" | "linux" | "unknown";
  wsl_distro: string | null;
}

interface UpstreamReleaseInfo {
  repo: string;
  tagName: string | null;
  version: string | null;
  name: string | null;
  publishedAt: string | null;
  htmlUrl: string | null;
  prerelease: boolean;
  draft: boolean;
  error: string | null;
}

const TOOL_NAMES = ["claude", "codex", "gemini", "opencode", "openclaw"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

type WslShellPreference = {
  wslShell?: string | null;
  wslShellFlag?: string | null;
};

const WSL_SHELL_OPTIONS = ["sh", "bash", "zsh", "fish", "dash"] as const;
// UI-friendly order: login shell first.
const WSL_SHELL_FLAG_OPTIONS = ["-lic", "-lc", "-c"] as const;

const ENV_BADGE_CONFIG: Record<
  string,
  { labelKey: string; className: string }
> = {
  wsl: {
    labelKey: "settings.envBadge.wsl",
    className:
      "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
  },
  windows: {
    labelKey: "settings.envBadge.windows",
    className:
      "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  },
  macos: {
    labelKey: "settings.envBadge.macos",
    className:
      "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20",
  },
  linux: {
    labelKey: "settings.envBadge.linux",
    className:
      "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
  },
};

const INSTALL_SOURCE_BADGE_CONFIG: Record<
  string,
  { labelKey: string; className: string }
> = {
  native: {
    labelKey: "settings.toolInstallSourceNative",
    className:
      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
  npm: {
    labelKey: "settings.toolInstallSourceNpm",
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
  },
};

const ONE_CLICK_INSTALL_COMMANDS = `# Claude Code (Native install - recommended)
curl -fsSL https://claude.ai/install.sh | bash
# Codex
npm i -g @openai/codex@latest
# Gemini CLI
npm i -g @google/gemini-cli@latest
# OpenCode
npm i -g opencode-ai@latest
# OpenClaw
npm i -g openclaw@latest`;

const formatAppVersionForDisplay = (version?: string | null): string => {
  if (!version) return "";
  const [core, build] = version.split("+");
  if (build && /^\d+$/.test(build)) {
    return `${core}.${build}`;
  }
  return version;
};

const parseLooseVersion = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.trim().replace(/^v/i, "");
  if (!normalized) return null;

  const [corePart, buildPart] = normalized.split("+", 2);
  const core = corePart.split(".").map((part) => {
    const num = Number.parseInt(part, 10);
    return Number.isFinite(num) ? num : 0;
  });
  const build = buildPart && /^\d+$/.test(buildPart) ? Number(buildPart) : null;

  return { core, build };
};

const compareLooseVersion = (left?: string | null, right?: string | null) => {
  const l = parseLooseVersion(left);
  const r = parseLooseVersion(right);
  if (!l || !r) return 0;

  const length = Math.max(l.core.length, r.core.length);
  for (let i = 0; i < length; i += 1) {
    const lPart = l.core[i] ?? 0;
    const rPart = r.core[i] ?? 0;
    if (lPart !== rPart) return lPart > rPart ? 1 : -1;
  }

  if (l.build !== null && r.build !== null && l.build !== r.build) {
    return l.build > r.build ? 1 : -1;
  }

  return 0;
};

export function AboutSection({ isPortable }: AboutSectionProps) {
  // ... (use hooks as before) ...
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [isLoadingVersion, setIsLoadingVersion] = useState(true);
  const [toolVersions, setToolVersions] = useState<ToolVersion[]>([]);
  const [isLoadingTools, setIsLoadingTools] = useState(true);
  const [upstreamRelease, setUpstreamRelease] =
    useState<UpstreamReleaseInfo | null>(null);
  const [upstreamReleaseError, setUpstreamReleaseError] = useState<
    string | null
  >(null);
  const [isLoadingUpstreamRelease, setIsLoadingUpstreamRelease] =
    useState(true);
  const [isCheckingUpstreamRelease, setIsCheckingUpstreamRelease] =
    useState(false);
  const [updatingTools, setUpdatingTools] = useState<Record<string, boolean>>(
    {},
  );

  const [wslShellByTool, setWslShellByTool] = useState<
    Record<string, WslShellPreference>
  >({});
  const [loadingTools, setLoadingTools] = useState<Record<string, boolean>>({});

  const refreshToolVersions = useCallback(
    async (
      toolNames: ToolName[],
      wslOverrides?: Record<string, WslShellPreference>,
    ) => {
      if (toolNames.length === 0) return;

      // 单工具刷新使用统一后端入口（get_tool_versions）并带工具过滤。
      setLoadingTools((prev) => {
        const next = { ...prev };
        for (const name of toolNames) next[name] = true;
        return next;
      });

      try {
        const updated = await settingsApi.getToolVersions(
          toolNames,
          wslOverrides,
        );

        setToolVersions((prev) => {
          if (prev.length === 0) return updated;
          const byName = new Map(updated.map((t) => [t.name, t]));
          const merged = prev.map((t) => byName.get(t.name) ?? t);
          const existing = new Set(prev.map((t) => t.name));
          for (const u of updated) {
            if (!existing.has(u.name)) merged.push(u);
          }
          return merged;
        });
      } catch (error) {
        console.error("[AboutSection] Failed to refresh tools", error);
      } finally {
        setLoadingTools((prev) => {
          const next = { ...prev };
          for (const name of toolNames) next[name] = false;
          return next;
        });
      }
    },
    [],
  );

  const loadAllToolVersions = useCallback(async () => {
    setIsLoadingTools(true);
    try {
      // Respect current UI overrides (shell / flag) when doing a full refresh.
      const versions = await settingsApi.getToolVersions(
        [...TOOL_NAMES],
        wslShellByTool,
      );
      setToolVersions(versions);
    } catch (error) {
      console.error("[AboutSection] Failed to load tool versions", error);
    } finally {
      setIsLoadingTools(false);
    }
  }, [wslShellByTool]);

  const checkUpstreamRelease = useCallback(
    async (notifyOnError = false) => {
      setIsCheckingUpstreamRelease(true);
      try {
        const info = await settingsApi.getUpstreamReleaseInfo();
        setUpstreamRelease(info);
        setUpstreamReleaseError(info.error || null);
        if (notifyOnError && info.error) {
          toast.error(
            t("settings.upstreamReleaseCheckFailed", {
              defaultValue: "上游 Release 检测失败",
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[AboutSection] Failed to check upstream release", error);
        setUpstreamRelease(null);
        setUpstreamReleaseError(message);
        if (notifyOnError) {
          toast.error(
            t("settings.upstreamReleaseCheckFailed", {
              defaultValue: "上游 Release 检测失败",
            }),
          );
        }
      } finally {
        setIsCheckingUpstreamRelease(false);
        setIsLoadingUpstreamRelease(false);
      }
    },
    [t],
  );

  const handleUpdateTool = useCallback(
    async (tool: ToolVersion) => {
      const toolName = tool.name;
      setUpdatingTools((prev) => ({ ...prev, [toolName]: true }));
      try {
        await settingsApi.updateTool(toolName, {
          envType: tool.env_type,
          wslDistro: tool.wsl_distro ?? undefined,
          installSource: tool.install_source,
        });
        toast.success(
          t("settings.toolUpdateStarted", {
            defaultValue: "已开始更新，请查看终端输出",
          }),
          { closeButton: true },
        );
        await refreshToolVersions([toolName as ToolName], wslShellByTool);
      } catch (error) {
        console.error("[AboutSection] Failed to update tool", error);
        toast.error(
          t("settings.toolUpdateFailed", {
            defaultValue: "更新失败，请查看日志",
          }),
        );
      } finally {
        setUpdatingTools((prev) => ({ ...prev, [toolName]: false }));
      }
    },
    [refreshToolVersions, t, wslShellByTool],
  );

  const handleToolShellChange = async (toolName: ToolName, value: string) => {
    const wslShell = value === "auto" ? null : value;
    const nextPref: WslShellPreference = {
      ...(wslShellByTool[toolName] ?? {}),
      wslShell,
    };
    setWslShellByTool((prev) => ({ ...prev, [toolName]: nextPref }));
    await refreshToolVersions([toolName], { [toolName]: nextPref });
  };

  const handleToolShellFlagChange = async (
    toolName: ToolName,
    value: string,
  ) => {
    const wslShellFlag = value === "auto" ? null : value;
    const nextPref: WslShellPreference = {
      ...(wslShellByTool[toolName] ?? {}),
      wslShellFlag,
    };
    setWslShellByTool((prev) => ({ ...prev, [toolName]: nextPref }));
    await refreshToolVersions([toolName], { [toolName]: nextPref });
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [appVersion] = await Promise.all([
          getVersion(),
          loadAllToolVersions(),
          checkUpstreamRelease(),
        ]);

        if (active) {
          setVersion(appVersion);
        }
      } catch (error) {
        console.error("[AboutSection] Failed to load info", error);
        if (active) {
          setVersion(null);
        }
      } finally {
        if (active) {
          setIsLoadingVersion(false);
        }
      }
    };

    void load();
    return () => {
      active = false;
    };
    // Mount-only: loadAllToolVersions is intentionally excluded to avoid
    // re-fetching all tools whenever wslShellByTool changes. Single-tool
    // refreshes are handled by refreshToolVersions in the shell/flag handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopyInstallCommands = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ONE_CLICK_INSTALL_COMMANDS);
      toast.success(t("settings.installCommandsCopied"), { closeButton: true });
    } catch (error) {
      console.error("[AboutSection] Failed to copy install commands", error);
      toast.error(t("settings.installCommandsCopyFailed"));
    }
  }, [t]);

  const displayVersion =
    formatAppVersionForDisplay(version) || t("common.unknown");
  const upstreamDisplayVersion =
    formatAppVersionForDisplay(upstreamRelease?.version) || t("common.unknown");
  const upstreamVersionCompare = compareLooseVersion(
    version,
    upstreamRelease?.version,
  );
  const upstreamPublishedAt = upstreamRelease?.publishedAt
    ? new Date(upstreamRelease.publishedAt)
    : null;
  const hasValidUpstreamPublishedAt =
    upstreamPublishedAt !== null &&
    Number.isFinite(upstreamPublishedAt.getTime());
  const upstreamStatusText = isCheckingUpstreamRelease
    ? t("common.checking", { defaultValue: "检测中" })
    : upstreamReleaseError
      ? t("settings.upstreamReleaseCheckFailed", {
          defaultValue: "上游检测失败",
        })
      : !upstreamRelease?.version || !version
        ? t("common.unknown")
        : upstreamVersionCompare < 0
          ? t("settings.upstreamReleaseNewer", {
              defaultValue: "有上游新版本",
            })
          : upstreamVersionCompare > 0
            ? t("settings.upstreamReleaseAhead", {
                defaultValue: "当前高于上游",
              })
            : t("settings.upstreamReleaseAligned", {
                defaultValue: "已对齐上游",
              });
  const upstreamStatusClassName = isCheckingUpstreamRelease
    ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
    : upstreamReleaseError
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
      : upstreamVersionCompare < 0
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      <header className="space-y-1">
        <h3 className="text-sm font-medium">{t("common.about")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.aboutHint")}
        </p>
      </header>

      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="rounded-xl border border-border bg-gradient-to-br from-card/80 to-card/40 p-6 space-y-5 shadow-sm"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <img src={appIcon} alt="CC Switch" className="h-5 w-5" />
              <h4 className="text-lg font-semibold text-foreground">
                CC Switch
              </h4>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1.5 bg-background/80">
                <span className="text-muted-foreground">
                  {t("common.version")}
                </span>
                {isLoadingVersion ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <span className="font-medium">{`v${displayVersion}`}</span>
                )}
              </Badge>
              {isPortable && (
                <Badge variant="secondary" className="gap-1.5">
                  <Info className="h-3 w-3" />
                  {t("settings.portableMode")}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1.5 bg-background/80">
                <span className="text-muted-foreground">
                  {t("settings.upstreamRelease", {
                    defaultValue: "上游 Release",
                  })}
                </span>
                {isLoadingUpstreamRelease ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <span className="font-medium">{`v${upstreamDisplayVersion}`}</span>
                )}
              </Badge>
              <Badge
                variant="outline"
                className={`gap-1.5 border ${upstreamStatusClassName}`}
              >
                {upstreamStatusText}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void checkUpstreamRelease(true)}
                disabled={isCheckingUpstreamRelease}
              >
                <RefreshCw
                  className={
                    isCheckingUpstreamRelease
                      ? "h-3.5 w-3.5 animate-spin"
                      : "h-3.5 w-3.5"
                  }
                />
                {isCheckingUpstreamRelease
                  ? t("common.checking", { defaultValue: "检测中" })
                  : t("common.check", { defaultValue: "检测" })}
              </Button>
            </div>
            {upstreamRelease?.htmlUrl && (
              <div className="text-xs text-muted-foreground">
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() =>
                    void settingsApi.openExternal(upstreamRelease.htmlUrl!)
                  }
                >
                  {upstreamRelease.repo}
                </button>
                {hasValidUpstreamPublishedAt && (
                  <span className="ml-2">
                    {t("settings.upstreamReleasePublishedAt", {
                      defaultValue: "发布时间",
                    })}
                    : {upstreamPublishedAt.toLocaleString()}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2" />
        </div>
      </motion.div>

      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-sm font-medium">{t("settings.localEnvCheck")}</h3>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={() => loadAllToolVersions()}
            disabled={isLoadingTools}
          >
            <RefreshCw
              className={
                isLoadingTools ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"
              }
            />
            {isLoadingTools ? t("common.refreshing") : t("common.refresh")}
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 px-1">
          {TOOL_NAMES.map((toolName, index) => {
            const tool = toolVersions.find((item) => item.name === toolName);
            // Special casing keeps product names aligned with branding.
            const displayName =
              toolName === "opencode"
                ? "OpenCode"
                : toolName === "openclaw"
                  ? "OpenClaw"
                : toolName.charAt(0).toUpperCase() + toolName.slice(1);
            const title =
              tool?.version ||
              tool?.latest_version ||
              tool?.error ||
              t("common.unknown");
            const localVersion = tool?.version || t("common.unknown");
            const latestVersion = tool?.latest_version || t("common.unknown");
            const isUpdating = updatingTools[toolName] ?? false;
            const hasNewerVersion = Boolean(
              tool?.version &&
                tool?.latest_version &&
                compareLooseVersion(tool.version, tool.latest_version) < 0,
            );
            const canUpdate =
              hasNewerVersion &&
              !isUpdating &&
              !isLoadingTools &&
              !loadingTools[toolName];

            return (
              <motion.div
                key={toolName}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: 0.15 + index * 0.05 }}
                whileHover={{ scale: 1.02 }}
                className="flex flex-col gap-2 rounded-xl border border-border bg-gradient-to-br from-card/80 to-card/40 p-4 shadow-sm transition-colors hover:border-primary/30"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{displayName}</span>
                    {/* Environment Badge */}
                    {tool?.env_type && ENV_BADGE_CONFIG[tool.env_type] && (
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded-full border ${ENV_BADGE_CONFIG[tool.env_type].className}`}
                      >
                        {t(ENV_BADGE_CONFIG[tool.env_type].labelKey)}
                      </span>
                    )}
                    {tool?.install_source &&
                      INSTALL_SOURCE_BADGE_CONFIG[tool.install_source] && (
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded-full border ${INSTALL_SOURCE_BADGE_CONFIG[tool.install_source].className}`}
                        >
                          {t(
                            INSTALL_SOURCE_BADGE_CONFIG[tool.install_source]
                              .labelKey,
                          )}
                        </span>
                      )}
                    {/* WSL Shell Selector */}
                    {tool?.env_type === "wsl" && (
                      <Select
                        value={wslShellByTool[toolName]?.wslShell || "auto"}
                        onValueChange={(v) =>
                          handleToolShellChange(toolName, v)
                        }
                        disabled={isLoadingTools || loadingTools[toolName]}
                      >
                        <SelectTrigger className="h-6 w-[70px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            {t("common.auto")}
                          </SelectItem>
                          {WSL_SHELL_OPTIONS.map((shell) => (
                            <SelectItem key={shell} value={shell}>
                              {shell}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {/* WSL Shell Flag Selector */}
                    {tool?.env_type === "wsl" && (
                      <Select
                        value={wslShellByTool[toolName]?.wslShellFlag || "auto"}
                        onValueChange={(v) =>
                          handleToolShellFlagChange(toolName, v)
                        }
                        disabled={isLoadingTools || loadingTools[toolName]}
                      >
                        <SelectTrigger className="h-6 w-[70px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            {t("common.auto")}
                          </SelectItem>
                          {WSL_SHELL_FLAG_OPTIONS.map((flag) => (
                            <SelectItem key={flag} value={flag}>
                              {flag}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isLoadingTools || loadingTools[toolName] ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : tool?.version ? (
                      tool.latest_version &&
                      tool.version !== tool.latest_version ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/20">
                          {tool.latest_version}
                        </span>
                      ) : (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      )
                    ) : (
                      <AlertCircle className="h-4 w-4 text-yellow-500" />
                    )}
                    {(hasNewerVersion || isUpdating) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => tool && handleUpdateTool(tool)}
                        disabled={!tool || !canUpdate}
                      >
                        {isUpdating
                          ? t("settings.updatingTool", {
                              defaultValue: "更新中",
                            })
                          : t("settings.updateTool", {
                              defaultValue: "更新",
                            })}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div className="truncate" title={title}>
                    {t("settings.toolLocalVersion", {
                      defaultValue: "本地",
                    })}
                    : <span className="font-mono">{localVersion}</span>
                  </div>
                  <div className="truncate" title={title}>
                    {t("settings.toolLatestVersion", {
                      defaultValue: "官方",
                    })}
                    : <span className="font-mono">{latestVersion}</span>
                  </div>
                </div>
                {tool?.error && !tool?.version && (
                  <div
                    className="text-xs text-amber-600 truncate"
                    title={tool.error}
                  >
                    {tool.error}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      {!isWindows() && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.3 }}
          className="space-y-3"
        >
          <h3 className="text-sm font-medium px-1">
            {t("settings.oneClickInstall")}
          </h3>
          <div className="rounded-xl border border-border bg-gradient-to-br from-card/80 to-card/40 p-4 space-y-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {t("settings.oneClickInstallHint")}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopyInstallCommands}
                className="h-7 gap-1.5 text-xs"
              >
                <Copy className="h-3.5 w-3.5" />
                {t("common.copy")}
              </Button>
            </div>
            <pre className="text-xs font-mono bg-background/80 px-3 py-2.5 rounded-lg border border-border/60 overflow-x-auto">
              {ONE_CLICK_INSTALL_COMMANDS}
            </pre>
          </div>
        </motion.div>
      )}
    </motion.section>
  );
}
