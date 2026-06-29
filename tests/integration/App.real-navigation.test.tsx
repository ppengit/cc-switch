import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetProviderState,
  setProxyStatusState,
  setProxyTakeoverStatusState,
} from "../msw/state";

const updateContextMock = vi.hoisted(() => ({
  hasUpdate: true,
  updateInfo: {
    availableVersion: "9.9.9",
    currentVersion: "1.0.0",
    body: "test update",
  },
  updateHandle: null,
  isChecking: false,
  error: null,
  isDismissed: false,
  dismissUpdate: vi.fn(),
  checkUpdate: vi.fn(),
  resetDismiss: vi.fn(),
}));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => updateContextMock,
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
  ProviderList: ({ appId, providers }: any) => (
    <section data-testid="provider-list" data-app-id={appId}>
      {Object.keys(providers).join(",")}
    </section>
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: ({ open, appId }: any) =>
    open ? <div data-testid="add-provider-dialog">{appId}</div> : null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: ({ open }: any) =>
    open ? <div data-testid="edit-provider-dialog" /> : null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: ({ isOpen }: any) =>
    isOpen ? <div data-testid="usage-script-modal" /> : null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, title, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>confirm</button>
        <button onClick={onCancel}>cancel</button>
      </div>
    ) : null,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: forwardRef(({ appId }: any, _ref) => (
    <section data-testid="prompts-panel">{appId}</section>
  )),
}));

vi.mock("@/components/skills/UnifiedSkillsPanel", () => ({
  default: forwardRef(({ currentApp, onOpenDiscovery }: any, _ref) => (
    <section data-testid="skills-panel">
      <span>{currentApp}</span>
      <button onClick={onOpenDiscovery}>open-discovery</button>
    </section>
  )),
}));

vi.mock("@/components/skills/SkillsPage", () => ({
  getSkillsPageHeaderActions: () => [],
  SkillsPage: forwardRef(({ initialApp }: any, _ref) => (
    <section data-testid="skills-discovery">{initialApp}</section>
  )),
}));

vi.mock("@/components/mcp/UnifiedMcpPanel", () => ({
  default: forwardRef(() => <section data-testid="mcp-panel" />),
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

vi.mock("@/components/settings/LanguageSettings", () => ({
  LanguageSettings: () => <section>language-settings</section>,
}));

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <section>theme-settings</section>,
}));

vi.mock("@/components/settings/AppVisibilitySettings", () => ({
  AppVisibilitySettings: () => <section>app-visibility-settings</section>,
}));

vi.mock("@/components/settings/WindowSettings", () => ({
  WindowSettings: () => <section>window-settings</section>,
}));

vi.mock("@/components/settings/SkillStorageLocationSettings", () => ({
  SkillStorageLocationSettings: () => (
    <section>skill-storage-location-settings</section>
  ),
}));

vi.mock("@/components/settings/SkillSyncMethodSettings", () => ({
  SkillSyncMethodSettings: () => <section>skill-sync-method-settings</section>,
}));

vi.mock("@/components/settings/TerminalSettings", () => ({
  TerminalSettings: () => <section>terminal-settings</section>,
}));

vi.mock("@/components/settings/ProxyTabContent", () => ({
  ProxyTabContent: () => <section>proxy-tab-content</section>,
}));

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <section>auth-center-panel</section>,
}));

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: () => <section>usage-dashboard</section>,
}));

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => <section>about-section</section>,
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

const backToProviders = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "" }));
  await waitFor(() =>
    expect(screen.getByTestId("provider-list")).toBeInTheDocument(),
  );
};

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

describe("App real navigation", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("opens general settings from the real header settings button", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await user.click(screen.getByTitle("common.settings"));
    await waitFor(() =>
      expect(screen.getByText("language-settings")).toBeInTheDocument(),
    );
    expect(screen.queryByText("usage-dashboard")).not.toBeInTheDocument();
  });

  it("opens the about settings tab from the real update badge", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await user.click(
      screen.getByRole("button", { name: /settings.updateAvailable/ }),
    );
    await waitFor(() =>
      expect(screen.getByText("about-section")).toBeInTheDocument(),
    );
    expect(screen.queryByText("language-settings")).not.toBeInTheDocument();
  });

  it("opens the usage settings tab from the real takeover usage button", async () => {
    const user = userEvent.setup();
    setProxyStatusState({ running: true, port: 18888 });
    setProxyTakeoverStatusState({ claude: true });

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await user.click(await screen.findByTitle("使用统计"));
    await waitFor(() =>
      expect(screen.getByText("usage-dashboard")).toBeInTheDocument(),
    );
    expect(screen.queryByText("about-section")).not.toBeInTheDocument();
  });

  it("keeps default app toolbar entries wired to the expected views", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await user.click(screen.getByTitle("skills.manage"));
    await waitFor(() =>
      expect(screen.getByTestId("skills-panel")).toHaveTextContent("claude"),
    );
    await user.click(screen.getByText("open-discovery"));
    await waitFor(() =>
      expect(screen.getByTestId("skills-discovery")).toHaveTextContent(
        "claude",
      ),
    );
    await user.click(screen.getByRole("button", { name: "" }));
    await waitFor(() =>
      expect(screen.getByTestId("skills-panel")).toHaveTextContent("claude"),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("prompts.manage"));
    await waitFor(() =>
      expect(screen.getByTestId("prompts-panel")).toHaveTextContent("claude"),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("sessionManager.title"));
    await waitFor(() =>
      expect(screen.getByTestId("sessions-panel")).toHaveTextContent("claude"),
    );
    await backToProviders(user);
  });

  it("keeps OpenClaw toolbar entries isolated from default app actions", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await clickAppSwitcherButton(user, "OpenClaw");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "openclaw",
      ),
    );
    expect(screen.queryByTitle("prompts.manage")).not.toBeInTheDocument();

    await user.click(screen.getByTitle("workspace.manage"));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-panel")).toBeInTheDocument(),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("openclaw.env.title"));
    await waitFor(() =>
      expect(screen.getByTestId("openclaw-env-panel")).toBeInTheDocument(),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("openclaw.tools.title"));
    await waitFor(() =>
      expect(screen.getByTestId("openclaw-tools-panel")).toBeInTheDocument(),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("openclaw.agents.title"));
    await waitFor(() =>
      expect(screen.getByTestId("openclaw-agents-panel")).toBeInTheDocument(),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("sessionManager.title"));
    await waitFor(() =>
      expect(screen.getByTestId("sessions-panel")).toHaveTextContent(
        "openclaw",
      ),
    );
    await backToProviders(user);
  });

  it("keeps Hermes toolbar entries isolated from default and OpenClaw actions", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await clickAppSwitcherButton(user, "Hermes");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "hermes",
      ),
    );
    expect(screen.queryByTitle("prompts.manage")).not.toBeInTheDocument();
    expect(screen.queryByTitle("workspace.manage")).not.toBeInTheDocument();

    await user.click(screen.getByTitle("skills.manage"));
    await waitFor(() =>
      expect(screen.getByTestId("skills-panel")).toHaveTextContent("hermes"),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("hermes.memory.title"));
    await waitFor(() =>
      expect(screen.getByTestId("hermes-memory-panel")).toBeInTheDocument(),
    );
    await backToProviders(user);

    await user.click(screen.getByTitle("mcp.title"));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-panel")).toBeInTheDocument(),
    );
  });

  it("opens the add provider dialog for the app selected through the real app switcher", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await clickAppSwitcherButton(user, "Codex");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "codex",
      ),
    );

    const header = screen.getByRole("banner");
    const addButtons = within(header).getAllByRole("button");
    await user.click(addButtons[addButtons.length - 1]);

    await waitFor(() =>
      expect(screen.getByTestId("add-provider-dialog")).toHaveTextContent(
        "codex",
      ),
    );
  });

  it("falls back to providers when localStorage still contains the legacy agents view", async () => {
    window.localStorage.setItem("cc-switch-last-view", "agents");

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );
    expect(screen.queryByText("Coming Soon")).not.toBeInTheDocument();
  });
});
