import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderState } from "../msw/state";

const INITIAL_MEMORY_CONTENT =
  "# MEMORY.md\n\nRemember the current Hermes operating context.";
const UPDATED_MEMORY_CONTENT =
  "# MEMORY.md\n\nUpdated memory from App real test.";
const INITIAL_USER_CONTENT = "# USER.md\n\nProfile: careful reviewer.";
const UPDATED_USER_CONTENT =
  "# USER.md\n\nProfile: production rollout owner.";
type FetchSpyLike = {
  mock: {
    calls: Array<[RequestInfo | URL, RequestInit?]>;
  };
};

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

vi.mock("@/components/MarkdownEditor", () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      aria-label="hermes-memory-editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
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

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: forwardRef(() => <section data-testid="prompts-panel" />),
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

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const openHermesMemoryPanel = async (user: ReturnType<typeof userEvent.setup>) => {
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

  await user.click(screen.getByTitle("hermes.memory.title"));
  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: "hermes.memory.agentTab" }),
    ).toBeInTheDocument(),
  );
};

const getCommandBodies = (
  fetchSpy: FetchSpyLike,
  command: string,
) =>
  fetchSpy.mock.calls
    .filter(([input]) => String(input).endsWith(`/${command}`))
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")));

const getLastCommandBody = (
  fetchSpy: FetchSpyLike,
  command: string,
) => {
  const bodies = getCommandBodies(fetchSpy, command);
  return bodies.at(-1);
};

const getActiveEditor = () => {
  const panel = screen.getByRole("tabpanel");
  return within(panel).getByLabelText("hermes-memory-editor");
};

describe("App with real HermesMemoryPanel interactions", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("loads memory, toggles disable, saves edits, and opens config through the real App entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openHermesMemoryPanel(user);

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "hermes.memory.agentTab" }),
      ).toHaveAttribute("aria-selected", "true"),
    );
    await waitFor(() => expect(getActiveEditor()).toHaveValue(INITIAL_MEMORY_CONTENT));

    const memorySwitch = screen.getByRole("switch");
    expect(memorySwitch).toHaveAttribute("aria-checked", "true");

    await user.click(memorySwitch);

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_hermes_memory_enabled")).toEqual({
        kind: "memory",
        enabled: false,
      }),
    );
    expect(screen.getByText("hermes.memory.disabledHint")).toBeInTheDocument();

    await user.clear(getActiveEditor());
    await user.type(getActiveEditor(), UPDATED_MEMORY_CONTENT);
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_hermes_memory")).toEqual({
        kind: "memory",
        content: UPDATED_MEMORY_CONTENT,
      }),
    );
    await waitFor(() =>
      expect(
        getCommandBodies(fetchSpy, "get_hermes_memory").filter(
          (body) => body.kind === "memory",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(getActiveEditor()).toHaveValue(UPDATED_MEMORY_CONTENT),
    );

    await user.click(
      screen.getByRole("button", { name: "hermes.memory.openConfig" }),
    );

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "open_hermes_web_ui")).toEqual({
        path: "/config",
      }),
    );
  });

  it("keeps memory and user tab content isolated through the real App entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openHermesMemoryPanel(user);

    await user.click(screen.getByRole("tab", { name: "hermes.memory.userTab" }));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "hermes.memory.userTab" }),
      ).toHaveAttribute("aria-selected", "true"),
    );
    await waitFor(() => expect(getActiveEditor()).toHaveValue(INITIAL_USER_CONTENT));

    const userSwitch = screen.getByRole("switch");
    expect(userSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(userSwitch);

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_hermes_memory_enabled")).toEqual({
        kind: "user",
        enabled: true,
      }),
    );

    await user.clear(getActiveEditor());
    await user.type(getActiveEditor(), UPDATED_USER_CONTENT);
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_hermes_memory")).toEqual({
        kind: "user",
        content: UPDATED_USER_CONTENT,
      }),
    );
    await waitFor(() =>
      expect(getActiveEditor()).toHaveValue(UPDATED_USER_CONTENT),
    );

    await user.click(screen.getByRole("tab", { name: "hermes.memory.agentTab" }));
    await waitFor(() =>
      expect(getActiveEditor()).toHaveValue(INITIAL_MEMORY_CONTENT),
    );

    await user.click(screen.getByRole("tab", { name: "hermes.memory.userTab" }));
    await waitFor(() =>
      expect(getActiveEditor()).toHaveValue(UPDATED_USER_CONTENT),
    );

    expect(
      getCommandBodies(fetchSpy, "get_hermes_memory").some(
        (body) => body.kind === "memory",
      ),
    ).toBe(true);
    expect(
      getCommandBodies(fetchSpy, "get_hermes_memory").some(
        (body) => body.kind === "user",
      ),
    ).toBe(true);
  });
});
