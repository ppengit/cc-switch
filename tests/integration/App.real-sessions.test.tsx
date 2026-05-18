import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage, SessionMeta } from "@/types";
import {
  getLastDeleteSessionsRequest,
  getLastSessionExportRequest,
  getLastSessionTerminalLaunchRequest,
  getLastSessionTitleMappingRequest,
  listSessions,
  resetProviderState,
  setSessionFixtures,
} from "../msw/state";

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
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({ appId }: any) => (
    <section data-testid="provider-list" data-app-id={appId} />
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

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
  }: any) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <div>{message}</div>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onCancel}>{cancelText}</button>
      </div>
    ) : null,
}));

vi.mock("@/components/sessions/SessionToc", () => ({
  SessionTocSidebar: () => null,
  SessionTocDialog: () => null,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: forwardRef(({ appId }: any, _ref) => (
    <section data-testid="prompts-panel">{appId}</section>
  )),
}));

vi.mock("@/components/skills/UnifiedSkillsPanel", () => ({
  default: forwardRef(({ currentApp }: any, _ref) => (
    <section data-testid="skills-panel">{currentApp}</section>
  )),
}));

vi.mock("@/components/skills/SkillsPage", () => ({
  SkillsPage: forwardRef(({ initialApp }: any, _ref) => (
    <section data-testid="skills-discovery">{initialApp}</section>
  )),
}));

vi.mock("@/components/mcp/UnifiedMcpPanel", () => ({
  default: forwardRef(() => <section data-testid="mcp-panel" />),
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

const session = (
  providerId: string,
  sessionId: string,
  title: string,
  projectDir: string,
  order: number,
): SessionMeta => ({
  providerId,
  sessionId,
  title,
  summary: `${title} summary`,
  projectDir,
  createdAt: 1_700_001_000_000 + order,
  lastActiveAt: 1_700_001_100_000 + order,
  sourcePath: `${projectDir}/${sessionId}.jsonl`,
  resumeCommand: `${providerId} resume ${sessionId}`,
});

const seedSessions = () => {
  const sessions = [
    session("claude", "claude-alpha", "Claude Alpha Session", "/mock/claude", 3),
    session("claude", "claude-beta", "Claude Beta Session", "/mock/claude", 2),
    session("codex", "codex-alpha", "Codex Alpha Session", "/mock/codex", 1),
    session("codex", "codex-beta", "Codex Beta Session", "/mock/codex", 0),
  ];
  const messages: Record<string, SessionMessage[]> = Object.fromEntries(
    sessions.map((item) => [
      `${item.providerId}:${item.sourcePath}`,
      [{ role: "user", content: `${item.title} message`, ts: item.lastActiveAt }],
    ]),
  );
  setSessionFixtures(sessions, messages);
};

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const backToProviders = async (user: ReturnType<typeof userEvent.setup>) => {
  const backButton = Array.from(
    within(screen.getByRole("banner")).getAllByRole("button"),
  ).find((button) => button.querySelector(".lucide-arrow-left"));
  if (!backButton) {
    throw new Error("Back button not found");
  }
  await user.click(backButton);
  await waitFor(() =>
    expect(screen.getByTestId("provider-list")).toBeInTheDocument(),
  );
};

const openSessions = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTitle("sessionManager.title"));
  await waitFor(() =>
    expect(
      screen.getByText("sessionManager.sessionList"),
    ).toBeInTheDocument(),
  );
};

const openSearch = async (user: ReturnType<typeof userEvent.setup>) => {
  const searchButton = Array.from(screen.getAllByRole("button")).find((button) =>
    button.querySelector(".lucide-search"),
  );
  if (!searchButton) {
    throw new Error("Session search button not found");
  }
  await user.click(searchButton);
};

describe("App with real SessionManagerPage", () => {
  beforeEach(() => {
    resetProviderState();
    seedSessions();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it("opens sessions from the real toolbar and remounts per selected app", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await openSessions(user);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Alpha Session" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Claude Beta Session")).toBeInTheDocument();
    expect(screen.queryByText("Codex Alpha Session")).not.toBeInTheDocument();

    await backToProviders(user);
    await clickAppSwitcherButton(user, "Codex");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "codex",
      ),
    );
    await openSessions(user);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Codex Alpha Session" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Codex Beta Session")).toBeInTheDocument();
    expect(screen.queryByText("Claude Alpha Session")).not.toBeInTheDocument();

    await backToProviders(user);
    await clickAppSwitcherButton(user, "Claude Code");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );
    await openSessions(user);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Alpha Session" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Codex Alpha Session")).not.toBeInTheDocument();
  }, 15_000);

  it("keeps session search scoped to the current app and resets it after app switches", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await openSessions(user);
    await waitFor(() =>
      expect(screen.getByText("Claude Beta Session")).toBeInTheDocument(),
    );

    await openSearch(user);
    await user.type(
      screen.getByPlaceholderText("sessionManager.searchPlaceholder"),
      "Beta",
    );

    await waitFor(() =>
      expect(screen.getByText("Claude Beta Session")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Claude Alpha Session")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex Beta Session")).not.toBeInTheDocument();

    await backToProviders(user);
    await clickAppSwitcherButton(user, "Codex");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "codex",
      ),
    );
    await openSessions(user);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Codex Alpha Session" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Codex Beta Session")).toBeInTheDocument();
    expect(screen.queryByText("Claude Beta Session")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("sessionManager.searchPlaceholder"),
    ).not.toBeInTheDocument();
  });

  it("deletes a session through the real App entry without affecting another app", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await clickAppSwitcherButton(user, "Codex");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "codex",
      ),
    );
    await openSessions(user);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Codex Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /删除会话/i }));
    const dialog = screen.getByRole("dialog", { name: "删除会话" });
    expect(within(dialog).getByText(/Codex Alpha Session/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "删除会话" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Codex Beta Session" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Codex Alpha Session")).not.toBeInTheDocument();

    await backToProviders(user);
    await clickAppSwitcherButton(user, "Claude Code");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );
    await openSessions(user);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Alpha Session" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Claude Beta Session")).toBeInTheDocument();
    expect(screen.queryByText("Codex Alpha Session")).not.toBeInTheDocument();
  });

  it("renames, resumes, and exports the selected session through the real App entry", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await openSessions(user);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /修改名称/i }));
    const renameDialog = screen.getByRole("dialog", { name: "修改会话标题" });
    const titleInput = within(renameDialog).getByLabelText("会话名称/标题");
    await user.clear(titleInput);
    await user.type(titleInput, "Renamed Claude Alpha");
    await user.click(within(renameDialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Renamed Claude Alpha" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Claude Alpha Session")).not.toBeInTheDocument();
    expect(getLastSessionTitleMappingRequest()).toEqual({
      action: "set",
      appType: "claude",
      sessionId: "claude-alpha",
      sourcePath: "/mock/claude/claude-alpha.jsonl",
      customTitle: "Renamed Claude Alpha",
    });

    await user.click(screen.getByRole("button", { name: /恢复会话/i }));
    await waitFor(() =>
      expect(getLastSessionTerminalLaunchRequest()).toEqual({
        command: "claude resume claude-alpha",
        cwd: "/mock/claude",
        customConfig: undefined,
      }),
    );

    await user.click(screen.getByRole("button", { name: /导出会话/i }));
    await waitFor(() =>
      expect(getLastSessionExportRequest()).toMatchObject({
        providerId: "claude",
        sessionId: "claude-alpha",
        title: "Renamed Claude Alpha",
        sourcePath: "/mock/claude/claude-alpha.jsonl",
      }),
    );
  }, 15_000);

  it("batch deletes only the current app sessions from the real App entry", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await openSessions(user);
    await waitFor(() =>
      expect(screen.getByText("Claude Beta Session")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "批量管理" }));
    await user.click(screen.getByRole("button", { name: "全选当前" }));
    await user.click(screen.getByRole("button", { name: "批量删除" }));

    const dialog = screen.getByRole("dialog", { name: "批量删除会话" });
    expect(within(dialog).getByText(/2/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "删除所选会话" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Claude Alpha Session")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Claude Beta Session")).not.toBeInTheDocument();
    expect(screen.getByText("sessionManager.noSessions")).toBeInTheDocument();

    expect(getLastDeleteSessionsRequest()).toEqual([
      {
        providerId: "claude",
        sessionId: "claude-alpha",
        sourcePath: "/mock/claude/claude-alpha.jsonl",
      },
      {
        providerId: "claude",
        sessionId: "claude-beta",
        sourcePath: "/mock/claude/claude-beta.jsonl",
      },
    ]);
    expect(listSessions().map((item) => item.sessionId).sort()).toEqual([
      "codex-alpha",
      "codex-beta",
    ]);

    await backToProviders(user);
    await clickAppSwitcherButton(user, "Codex");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "codex",
      ),
    );
    await openSessions(user);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Codex Alpha Session" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Codex Beta Session")).toBeInTheDocument();
    expect(screen.queryByText("Claude Alpha Session")).not.toBeInTheDocument();
  }, 15_000);
});
