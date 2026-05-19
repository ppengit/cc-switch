import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import {
  getOpenClawAgentsDefaultsState,
  resetProviderState,
  setOpenClawAgentsDefaultsState,
  setProviders,
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

vi.mock("@/components/openclaw/ToolsPanel", () => ({
  default: () => <section data-testid="openclaw-tools-panel" />,
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

const openAgentsPanel = async (user: ReturnType<typeof userEvent.setup>) => {
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

  await user.click(screen.getByTitle("openclaw.agents.title"));
  await waitFor(() =>
    expect(
      screen.getByText("openclaw.agents.description"),
    ).toBeInTheDocument(),
  );
};

const getCommandBodies = (fetchSpy: FetchSpyLike, command: string) =>
  fetchSpy.mock.calls
    .filter(([input]) => String(input).endsWith(`/${command}`))
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")));

const getLastCommandBody = (fetchSpy: FetchSpyLike, command: string) => {
  const bodies = getCommandBodies(fetchSpy, command);
  return bodies.at(-1);
};

const openclawProvider = (
  id: string,
  name: string,
  modelId: string,
  modelName: string,
  sortIndex: number,
): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex,
  createdAt: 1_700_000_300_000 + sortIndex,
  settingsConfig: {
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `${id}-key`,
    api: "openai-completions",
    models: [{ id: modelId, name: modelName }],
  },
});

const seedOpenClawProviders = () => {
  setProviders("openclaw", {
    "provider-a": openclawProvider(
      "provider-a",
      "Provider A",
      "model-alpha",
      "Model Alpha",
      0,
    ),
    "provider-b": openclawProvider(
      "provider-b",
      "Provider B",
      "model-beta",
      "Model Beta",
      1,
    ),
    "provider-c": openclawProvider(
      "provider-c",
      "Provider C",
      "model-gamma",
      "Model Gamma",
      2,
    ),
  });
};

describe("App with real OpenClaw AgentsDefaultsPanel interactions", () => {
  beforeEach(() => {
    resetProviderState();
    seedOpenClawProviders();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  it("loads agents defaults and saves edited model and runtime fields through the real App entry", async () => {
    setOpenClawAgentsDefaultsState({
      model: {
        primary: "provider-a/model-alpha",
      },
      workspace: "write",
      timeoutSeconds: 90,
      contextTokens: 32768,
      maxConcurrent: 4,
      customFlag: "preserve-me",
    });

    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openAgentsPanel(user);

    await waitFor(() =>
      expect(screen.getAllByRole("combobox")[0]).toHaveTextContent(
        "Provider A / Model Alpha",
      ),
    );
    expect(screen.getByDisplayValue("write")).toBeInTheDocument();
    expect(screen.getByDisplayValue("90")).toBeInTheDocument();
    expect(screen.getByDisplayValue("32768")).toBeInTheDocument();
    expect(screen.getByDisplayValue("4")).toBeInTheDocument();

    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(
      await screen.findByRole("option", {
        name: "Provider B / Model Beta",
      }),
    );

    await user.click(
      screen.getByRole("button", { name: /add fallback model/i }),
    );
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(
      await screen.findByRole("option", {
        name: "Provider C / Model Gamma",
      }),
    );

    const workspaceInput = screen.getByDisplayValue("write");
    await user.clear(workspaceInput);
    await user.type(workspaceInput, "~/projects");

    const timeoutInput = screen.getByDisplayValue("90");
    await user.clear(timeoutInput);
    await user.type(timeoutInput, "300");

    const contextTokensInput = screen.getByDisplayValue("32768");
    await user.clear(contextTokensInput);
    await user.type(contextTokensInput, "64000");

    const maxConcurrentInput = screen.getByDisplayValue("4");
    await user.clear(maxConcurrentInput);
    await user.type(maxConcurrentInput, "8");

    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_openclaw_agents_defaults")).toEqual(
        {
          defaults: {
            model: {
              primary: "provider-b/model-beta",
              fallbacks: ["provider-c/model-gamma"],
            },
            workspace: "~/projects",
            timeoutSeconds: 300,
            contextTokens: 64000,
            maxConcurrent: 8,
            customFlag: "preserve-me",
          },
        },
      ),
    );

    await waitFor(() =>
      expect(getOpenClawAgentsDefaultsState()).toEqual({
        model: {
          primary: "provider-b/model-beta",
          fallbacks: ["provider-c/model-gamma"],
        },
        workspace: "~/projects",
        timeoutSeconds: 300,
        contextTokens: 64000,
        maxConcurrent: 8,
        customFlag: "preserve-me",
      }),
    );
    await waitFor(() =>
      expect(
        getCommandBodies(fetchSpy, "get_openclaw_agents_defaults").length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("preserves unsupported model values and migrates legacy timeout on save", async () => {
    setOpenClawAgentsDefaultsState({
      model: {
        primary: "legacy/missing-model",
        fallbacks: ["provider-b/model-beta"],
      },
      workspace: "legacy-space",
      timeout: 120,
      contextTokens: 8192,
      maxConcurrent: 2,
      customFlag: "preserve-me",
    });

    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { default: App } = await import("@/App");
    renderApp(App);

    await openAgentsPanel(user);

    const legacyAlert = await screen.findByRole("alert");
    expect(legacyAlert).toHaveTextContent(/timeout/i);
    expect(screen.getByDisplayValue("120")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "set_openclaw_agents_defaults")).toEqual(
        {
          defaults: {
            model: {
              primary: "legacy/missing-model",
              fallbacks: ["provider-b/model-beta"],
            },
            workspace: "legacy-space",
            timeoutSeconds: 120,
            contextTokens: 8192,
            maxConcurrent: 2,
            customFlag: "preserve-me",
          },
        },
      ),
    );

    await waitFor(() =>
      expect(getOpenClawAgentsDefaultsState()).toEqual({
        model: {
          primary: "legacy/missing-model",
          fallbacks: ["provider-b/model-beta"],
        },
        workspace: "legacy-space",
        timeoutSeconds: 120,
        contextTokens: 8192,
        maxConcurrent: 2,
        customFlag: "preserve-me",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });
});
