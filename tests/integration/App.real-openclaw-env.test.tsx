import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderState } from "../msw/state";

const INITIAL_ENV_JSON = `{
  "vars": {
    "OPENCLAW_API_KEY": "env-initial-key"
  },
  "shellEnv": {
    "OPENCLAW_BASE_URL": "https://openclaw.example.com"
  }
}`;

const UPDATED_ENV_JSON = `{
  "vars": {
    "OPENCLAW_API_KEY": "env-updated-key",
    "FEATURE_FLAG": "enabled"
  },
  "shellEnv": {
    "OPENCLAW_BASE_URL": "https://gateway.example.com"
  }
}`;

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

vi.mock("@/components/JsonEditor", () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      aria-label="openclaw-env-editor"
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

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const openEnvPanel = async (user: ReturnType<typeof userEvent.setup>) => {
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

  await user.click(screen.getByTitle("openclaw.env.title"));
  await waitFor(() =>
    expect(screen.getByLabelText("openclaw-env-editor")).toBeInTheDocument(),
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

describe("App with real OpenClaw EnvPanel interactions", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("loads env config and saves edited JSON through the real App entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openEnvPanel(user);

    await waitFor(() =>
      expect(screen.getByLabelText("openclaw-env-editor")).toHaveValue(
        INITIAL_ENV_JSON,
      ),
    );

    const editor = screen.getByLabelText("openclaw-env-editor");
    await user.clear(editor);
    await user.click(editor);
    await user.paste(UPDATED_ENV_JSON);
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_openclaw_env")).toEqual({
        env: {
          vars: {
            OPENCLAW_API_KEY: "env-updated-key",
            FEATURE_FLAG: "enabled",
          },
          shellEnv: {
            OPENCLAW_BASE_URL: "https://gateway.example.com",
          },
        },
      }),
    );

    await waitFor(() =>
      expect(
        getCommandBodies(fetchSpy, "get_openclaw_env").length,
      ).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("openclaw-env-editor")).toHaveValue(
        UPDATED_ENV_JSON,
      ),
    );
  });

  it("blocks invalid env JSON from being submitted through the real App entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openEnvPanel(user);

    const editor = screen.getByLabelText("openclaw-env-editor");
    await user.clear(editor);
    await user.click(editor);
    await user.paste(`["not","an","object"]`);
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(screen.getByLabelText("openclaw-env-editor")).toHaveValue(
        `["not","an","object"]`,
      ),
    );
    expect(getCommandBodies(fetchSpy, "set_openclaw_env")).toEqual([]);
  });
});
