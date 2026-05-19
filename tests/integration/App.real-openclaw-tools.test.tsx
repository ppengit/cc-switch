import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetProviderState,
  setOpenClawToolsConfigState,
} from "../msw/state";

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

vi.mock("@/components/openclaw/AgentsDefaultsPanel", () => ({
  default: () => <section data-testid="openclaw-agents-panel" />,
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

const openToolsPanel = async (user: ReturnType<typeof userEvent.setup>) => {
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

  await user.click(screen.getByTitle("openclaw.tools.title"));
  await waitFor(() =>
    expect(screen.getByText("openclaw.tools.allowList")).toBeInTheDocument(),
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

const openProfileSelect = async (user: ReturnType<typeof userEvent.setup>) => {
  const trigger = screen.getByRole("combobox");
  await user.click(trigger);
};

const fillInputByIndex = async (
  user: ReturnType<typeof userEvent.setup>,
  index: number,
  value: string,
) => {
  const inputs = screen.getAllByPlaceholderText("openclaw.tools.patternPlaceholder");
  await user.clear(inputs[index]);
  await user.type(inputs[index], value);
};

describe("App with real OpenClaw ToolsPanel interactions", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  it("loads tools config and saves edited profile, allow, and deny lists through the real App entry", async () => {
    setOpenClawToolsConfigState({
      profile: "minimal",
      allow: ["Read", "Write"],
      deny: ["Delete"],
    });

    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openToolsPanel(user);

    await waitFor(() =>
      expect(screen.getAllByDisplayValue("Read")[0]).toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue("Write")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Delete")).toBeInTheDocument();

    await openProfileSelect(user);
    await user.click(await screen.findByRole("option", { name: "Full" }));

    await user.click(screen.getByRole("button", { name: "openclaw.tools.addAllow" }));
    await fillInputByIndex(user, 2, "Shell");

    await user.click(screen.getByRole("button", { name: "openclaw.tools.addDeny" }));
    await fillInputByIndex(user, 4, "Network");

    const removeButtons = screen
      .getAllByRole("button")
      .filter((button) =>
        button.className.includes("hover:text-destructive"),
      );
    await user.click(removeButtons[1]);

    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_openclaw_tools")).toEqual({
        tools: {
          profile: "full",
          allow: ["Read", "Shell"],
          deny: ["Delete", "Network"],
        },
      }),
    );
  });

  it("preserves unsupported profile warning until the user explicitly chooses a supported profile", async () => {
    setOpenClawToolsConfigState({
      profile: "default",
      allow: ["Read", "Write"],
      deny: ["Delete"],
    });

    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openToolsPanel(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unsupported tools profile");
    expect(alert).toHaveTextContent("default");
    expect(alert).toHaveTextContent("supported OpenClaw list");

    await user.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_openclaw_tools")).toEqual({
        tools: {
          profile: "default",
          allow: ["Read", "Write"],
          deny: ["Delete"],
        },
      }),
    );

    await openProfileSelect(user);
    await user.click(await screen.findByRole("option", { name: "Coding" }));
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_openclaw_tools")).toEqual({
        tools: {
          profile: "coding",
          allow: ["Read", "Write"],
          deny: ["Delete"],
        },
      }),
    );
  });
});
