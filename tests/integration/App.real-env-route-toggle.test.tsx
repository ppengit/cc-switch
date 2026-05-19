import { Suspense, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { EnvConflict } from "@/types/env";
import { server } from "../msw/server";
import {
  getProxyStatusState,
  getProxyTakeoverStatusState,
  resetProviderState,
  setProxyStatusState,
  setProxyTakeoverStatusState,
  setSettings,
} from "../msw/state";

const TAURI_ENDPOINT = "http://tauri.local";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: false,
    updateInfo: null,
    updateHandle: null,
    isChecking: false,
    error: null,
    isDismissed: false,
    dismissUpdate: vi.fn(),
    checkUpdate: vi.fn(),
    resetDismiss: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({ appId, providers }: any) => (
    <section data-testid="provider-list" data-app-id={appId}>
      {Object.keys(providers).join(",")}
    </section>
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: () => null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: () => null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: () => null,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: () => <section data-testid="prompts-panel" />,
}));

vi.mock("@/components/skills/UnifiedSkillsPanel", () => ({
  default: () => <section data-testid="skills-panel" />,
}));

vi.mock("@/components/skills/SkillsPage", () => ({
  SkillsPage: () => <section data-testid="skills-discovery" />,
}));

vi.mock("@/components/mcp/UnifiedMcpPanel", () => ({
  default: () => <section data-testid="mcp-panel" />,
}));

vi.mock("@/components/sessions/SessionManagerPage", () => ({
  SessionManagerPage: ({ appId }: any) => (
    <section data-testid="sessions-panel">{appId}</section>
  ),
}));

vi.mock("@/components/workspace/WorkspaceFilesPanel", () => ({
  default: () => <section data-testid="workspace-panel" />,
}));

vi.mock("@/components/openclaw/EnvPanel", () => ({
  default: () => <section data-testid="openclaw-env-panel" />,
}));

vi.mock("@/components/openclaw/ToolsPanel", () => ({
  default: () => <section data-testid="openclaw-tools-panel" />,
}));

vi.mock("@/components/openclaw/AgentsDefaultsPanel", () => ({
  default: () => <section data-testid="openclaw-agents-panel" />,
}));

vi.mock("@/components/openclaw/OpenClawHealthBanner", () => ({
  default: () => <section data-testid="openclaw-health-banner" />,
}));

vi.mock("@/components/hermes/HermesMemoryPanel", () => ({
  default: () => <section data-testid="hermes-memory-panel" />,
}));

vi.mock("@/components/DeepLinkImportDialog", () => ({
  DeepLinkImportDialog: () => null,
}));

vi.mock("@/components/FirstRunNoticeDialog", () => ({
  FirstRunNoticeDialog: () => null,
}));

vi.mock("@/components/usage/RequestDetailPanel", () => ({
  RequestDetailPanel: () => <section data-testid="request-detail-panel" />,
}));

vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: () => <section data-testid="settings-page" />,
}));

const renderApp = (AppComponent: ComponentType) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );
};

const claudeConflict = (
  varName: string,
  sourcePath: string,
  sourceType: EnvConflict["sourceType"] = "system",
): EnvConflict => ({
  varName,
  varValue: "https://env.example.com",
  sourceType,
  sourcePath,
});

describe("App real env banner and Claude Desktop route toggle", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    setSettings({
      enableLocalProxy: true,
      firstRunNoticeConfirmed: true,
    });
    setProxyStatusState({
      running: false,
      address: "127.0.0.1",
      port: 15721,
      active_targets: [],
      active_request_targets: [],
      active_request_count: 0,
    });
    setProxyTakeoverStatusState({
      claude: false,
      codex: false,
      gemini: false,
      opencode: false,
      openclaw: false,
      hermes: false,
    });
  });

  it("starts Claude Desktop local routing but blocks stop while other app takeover is active", async () => {
    const user = userEvent.setup();
    setProxyTakeoverStatusState({ claude: true });

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Claude Desktop" }));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude-desktop",
      ),
    );

    const routeSwitch = screen.getByRole("switch");
    expect(routeSwitch).toHaveAttribute("data-state", "unchecked");

    await user.click(routeSwitch);
    await waitFor(() =>
      expect(getProxyStatusState().running).toBe(true),
    );
    await waitFor(() =>
      expect(routeSwitch).toHaveAttribute("data-state", "checked"),
    );

    await user.click(routeSwitch);

    expect(getProxyStatusState().running).toBe(true);
    expect(getProxyTakeoverStatusState().claude).toBe(true);
    expect(toastMock.warning).toHaveBeenCalledWith(
      "其它应用正在使用代理接管。请先在设置中关闭对应应用接管，再停止本地路由。",
      { duration: 5000 },
    );
    expect(routeSwitch).toHaveAttribute("data-state", "checked");
  });

  it("shows env conflicts on startup, deletes selected entries, and keeps dismiss session-scoped", async () => {
    const user = userEvent.setup();
    const startupConflicts = [
      claudeConflict("ANTHROPIC_BASE_URL", "HKEY_CURRENT_USER\\Environment"),
      claudeConflict("OPENAI_API_KEY", "C:\\mock\\.env", "file"),
    ];

    let currentConflicts = [...startupConflicts];

    server.use(
      http.post(`${TAURI_ENDPOINT}/check_env_conflicts`, async ({ request }) => {
        const body = (await request.json()) as { app?: string };
        if (body.app === "claude") {
          return HttpResponse.json(currentConflicts);
        }
        return HttpResponse.json([]);
      }),
      http.post(`${TAURI_ENDPOINT}/delete_env_vars`, async ({ request }) => {
        const body = (await request.json()) as { conflicts: EnvConflict[] };
        const keys = new Set(
          body.conflicts.map((conflict) => `${conflict.varName}:${conflict.sourcePath}`),
        );
        currentConflicts = currentConflicts.filter(
          (conflict) => !keys.has(`${conflict.varName}:${conflict.sourcePath}`),
        );
        return HttpResponse.json({
          backupPath: "C:\\backup\\env-vars-20260519.json",
          timestamp: "2026-05-19T15:10:00+08:00",
          conflicts: body.conflicts,
        });
      }),
    );

    const { default: App } = await import("@/App");
    const { unmount } = renderApp(App);

    const expandButton = await screen.findByRole("button", {
      name: "env.actions.expand",
    });
    expect(screen.getByText("env.warning.title")).toBeInTheDocument();
    await user.click(expandButton);

    const selectAll = await screen.findByRole("checkbox", {
      name: "env.actions.selectAll",
    });
    await user.click(selectAll);
    await user.click(
      screen.getByRole("button", { name: "env.actions.deleteSelected" }),
    );

    const confirmDialog = await screen.findByRole("dialog");
    await user.click(
      within(confirmDialog).getByRole("button", { name: "env.confirm.confirm" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("env.warning.title")).not.toBeInTheDocument(),
    );
    expect(toastMock.success).toHaveBeenCalledWith("env.delete.success", {
      description: "env.backup.location",
      duration: 5000,
      closeButton: true,
    });

    currentConflicts = [claudeConflict("GEMINI_API_KEY", "C:\\mock\\.zshrc", "file")];
    unmount();

    renderApp(App);
    expect(await screen.findByText("env.warning.title")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "env.actions.expand" }),
    );
    await user.click(
      screen.getAllByRole("button").find((button) =>
        button.querySelector(".lucide-x"),
      )!,
    );
    expect(window.sessionStorage.getItem("env_banner_dismissed")).toBe("true");

    unmount();
    renderApp(App);
    await waitFor(() =>
      expect(screen.queryByText("env.warning.title")).not.toBeInTheDocument(),
    );
  });
});
