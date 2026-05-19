import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderState } from "../msw/state";

const INITIAL_AGENTS_CONTENT =
  "# AGENTS.md\n\nInitial OpenClaw agent instructions.";
const UPDATED_AGENTS_CONTENT =
  "# AGENTS.md\n\nUpdated from App workspace real test.";
const CREATED_SOUL_CONTENT =
  "# SOUL.md\n\nA newly created OpenClaw personality profile.";

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
  default: ({ value, onChange, placeholder }: any) => (
    <textarea
      aria-label="workspace-editor"
      value={value}
      placeholder={placeholder}
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

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const openWorkspacePanel = async (user: ReturnType<typeof userEvent.setup>) => {
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

  await user.click(screen.getByTitle("workspace.manage"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /AGENTS\.md/ })).toBeInTheDocument(),
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

const closeWorkspaceEditor = async (user: ReturnType<typeof userEvent.setup>) => {
  const heading = screen.getByText("workspace.editing");
  await user.click(within(heading.parentElement as HTMLElement).getByRole("button"));
};

describe("App with real OpenClaw workspace interactions", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("loads workspace probes, opens directory, and saves AGENTS.md through the real App entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openWorkspacePanel(user);

    await waitFor(() =>
      expect(
        new Set(
          getCommandBodies(fetchSpy, "read_workspace_file").map(
            (body) => body.filename,
          ),
        ),
      ).toEqual(
        new Set([
          "AGENTS.md",
          "SOUL.md",
          "USER.md",
          "IDENTITY.md",
          "TOOLS.md",
          "MEMORY.md",
          "HEARTBEAT.md",
          "BOOTSTRAP.md",
          "BOOT.md",
        ]),
      ),
    );

    await user.click(screen.getByTitle("workspace.openDirectory"));
    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "open_workspace_directory")).toEqual({
        subdir: "workspace",
      }),
    );

    await user.click(screen.getByRole("button", { name: /AGENTS\.md/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("workspace-editor")).toHaveValue(
        INITIAL_AGENTS_CONTENT,
      ),
    );

    const editor = screen.getByLabelText("workspace-editor");
    await user.clear(editor);
    await user.type(editor, UPDATED_AGENTS_CONTENT);
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "write_workspace_file")).toEqual({
        filename: "AGENTS.md",
        content: UPDATED_AGENTS_CONTENT,
      }),
    );

    await closeWorkspaceEditor(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /AGENTS\.md/ })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /AGENTS\.md/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("workspace-editor")).toHaveValue(
        UPDATED_AGENTS_CONTENT,
      ),
    );
  });

  it("creates a previously missing SOUL.md file and keeps it isolated through the real App entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openWorkspacePanel(user);

    await user.click(screen.getByRole("button", { name: /SOUL\.md/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("workspace-editor")).toHaveValue(""),
    );

    const editor = screen.getByLabelText("workspace-editor");
    await user.type(editor, CREATED_SOUL_CONTENT);
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "write_workspace_file")).toEqual({
        filename: "SOUL.md",
        content: CREATED_SOUL_CONTENT,
      }),
    );

    await closeWorkspaceEditor(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /SOUL\.md/ })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /SOUL\.md/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("workspace-editor")).toHaveValue(
        CREATED_SOUL_CONTENT,
      ),
    );

    expect(
      getCommandBodies(fetchSpy, "write_workspace_file").some(
        (body) =>
          body.filename === "SOUL.md" &&
          body.content === CREATED_SOUL_CONTENT,
      ),
    ).toBe(true);
  });
});
