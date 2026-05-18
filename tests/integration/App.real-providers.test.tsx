import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import {
  getCurrentProviderId,
  getProviders,
  resetProviderState,
  setCurrentProviderId,
  setLiveProviderIds,
  setProviders,
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

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: ({ open, appId, onOpenChange }: any) =>
    open ? (
      <div data-testid="add-provider-dialog">
        add:{appId}
        <button onClick={() => onOpenChange(false)}>close-add</button>
      </div>
    ) : null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: ({ open, appId, provider, onOpenChange }: any) =>
    open ? (
      <div data-testid="edit-provider-dialog">
        edit:{appId}:{provider?.id}
        <button onClick={() => onOpenChange(false)}>close-edit</button>
      </div>
    ) : null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: ({ isOpen, appId, provider, onClose }: any) =>
    isOpen ? (
      <div data-testid="usage-script-modal">
        usage:{appId}:{provider?.id}
        <button onClick={onClose}>close-usage</button>
      </div>
    ) : null,
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

const claudeProvider = (
  id: string,
  name: string,
  sortIndex: number,
): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex,
  createdAt: 1_700_000_000_000 + sortIndex,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: `https://${id}.example.com`,
      ANTHROPIC_AUTH_TOKEN: `${id}-token`,
      ANTHROPIC_MODEL: `${id}-model`,
    },
  },
});

const codexProvider = (
  id: string,
  name: string,
  sortIndex: number,
): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex,
  createdAt: 1_700_000_100_000 + sortIndex,
  settingsConfig: {
    auth: {
      OPENAI_API_KEY: `${id}-key`,
    },
    config: `model = "${id}-model"\nmodel_provider = "${id}"\n[model_providers.${id}]\nbase_url = "https://${id}.example.com/v1"\n`,
  },
});

const opencodeProvider = (
  id: string,
  name: string,
  sortIndex: number,
): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex,
  createdAt: 1_700_000_200_000 + sortIndex,
  settingsConfig: {
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `https://${id}.example.com/v1`,
      apiKey: `${id}-key`,
    },
    models: {
      [`${id}-model`]: { name: `${name} Model` },
    },
  },
});

const openclawProvider = (
  id: string,
  name: string,
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
    models: [{ id: `${id}-model`, name: `${name} Model` }],
  },
});

const hermesProvider = (
  id: string,
  name: string,
  sortIndex: number,
): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex,
  createdAt: 1_700_000_400_000 + sortIndex,
  settingsConfig: {
    provider: id,
    base_url: `https://${id}.example.com/v1`,
    api_key: `${id}-key`,
    model: `${id}-model`,
    models: [{ id: `${id}-model`, name: `${name} Model` }],
  },
});

const seedProviderFixtures = () => {
  setProviders("claude", {
    "claude-alpha": claudeProvider("claude-alpha", "Claude Alpha", 0),
    "claude-beta": claudeProvider("claude-beta", "Claude Beta", 1),
  });
  setCurrentProviderId("claude", "claude-beta");

  setProviders("codex", {
    "codex-alpha": codexProvider("codex-alpha", "Codex Alpha", 0),
    "codex-beta": codexProvider("codex-beta", "Codex Beta", 1),
  });
  setCurrentProviderId("codex", "codex-alpha");

  setProviders("opencode", {
    "opencode-live": opencodeProvider("opencode-live", "OpenCode Live", 0),
    "opencode-idle": opencodeProvider("opencode-idle", "OpenCode Idle", 1),
  });
  setLiveProviderIds("opencode", ["opencode-live"]);

  setProviders("openclaw", {
    "openclaw-live": openclawProvider("openclaw-live", "OpenClaw Live", 0),
    "openclaw-idle": openclawProvider("openclaw-idle", "OpenClaw Idle", 1),
  });
  setLiveProviderIds("openclaw", ["openclaw-idle"]);

  setProviders("hermes", {
    "hermes-live": hermesProvider("hermes-live", "Hermes Live", 0),
    "hermes-idle": hermesProvider("hermes-idle", "Hermes Idle", 1),
  });
  setLiveProviderIds("hermes", ["hermes-live"]);
};

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const findProviderRow = (providerName: string): HTMLElement => {
  const row = screen
    .getAllByRole("row")
    .find((item) => within(item).queryByText(providerName));
  if (!row) {
    throw new Error(`Provider row not found: ${providerName}`);
  }
  return row;
};

const expectProviderVisible = async (providerName: string) => {
  await waitFor(() => expect(screen.getByText(providerName)).toBeInTheDocument());
};

const expectAdditiveState = (
  providerName: string,
  expected: "enabled" | "disabled",
) => {
  const row = findProviderRow(providerName);
  if (expected === "enabled") {
    expect(within(row).getByTitle("禁用")).toBeInTheDocument();
    expect(within(row).getByText("使用中")).toBeInTheDocument();
  } else {
    expect(within(row).getByTitle("启用")).toBeInTheDocument();
    expect(within(row).getByText("禁用")).toBeInTheDocument();
  }
};

describe("App with real ProviderList", () => {
  beforeEach(() => {
    resetProviderState();
    seedProviderFixtures();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("keeps provider rows and current provider state isolated across app switches", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await expectProviderVisible("Claude Alpha");
    expect(screen.getByText("Claude Beta")).toBeInTheDocument();
    expect(screen.queryByText("Codex Alpha")).not.toBeInTheDocument();
    expect(within(findProviderRow("Claude Beta")).getByTitle("使用中")).toBeDisabled();
    expect(
      within(findProviderRow("Claude Alpha")).getByTitle("使用此供应商"),
    ).toBeEnabled();

    await clickAppSwitcherButton(user, "Codex");
    await expectProviderVisible("Codex Alpha");
    expect(screen.getByText("Codex Beta")).toBeInTheDocument();
    expect(screen.queryByText("Claude Alpha")).not.toBeInTheDocument();
    expect(within(findProviderRow("Codex Alpha")).getByTitle("使用中")).toBeDisabled();
    expect(
      within(findProviderRow("Codex Beta")).getByTitle("使用此供应商"),
    ).toBeEnabled();

    await user.click(within(findProviderRow("Codex Beta")).getByTitle("使用此供应商"));

    await waitFor(() => {
      expect(getCurrentProviderId("codex")).toBe("codex-beta");
      expect(within(findProviderRow("Codex Beta")).getByTitle("使用中")).toBeDisabled();
    });

    await clickAppSwitcherButton(user, "Claude Code");
    await expectProviderVisible("Claude Beta");
    expect(getCurrentProviderId("claude")).toBe("claude-beta");
    expect(getCurrentProviderId("codex")).toBe("codex-beta");
    expect(within(findProviderRow("Claude Beta")).getByTitle("使用中")).toBeDisabled();
    expect(screen.queryByText("Codex Beta")).not.toBeInTheDocument();
  }, 15_000);

  it("uses search as location only and resets it when the app changes", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await expectProviderVisible("Claude Alpha");
    const claudeSearch = screen.getByRole("textbox", {
      name: "Search providers",
    });

    await user.type(claudeSearch, "Claude Beta");
    expect(screen.getByText("Claude Alpha")).toBeInTheDocument();
    expect(findProviderRow("Claude Beta")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();

    await clickAppSwitcherButton(user, "Codex");
    await expectProviderVisible("Codex Alpha");
    expect(screen.getByText("Codex Beta")).toBeInTheDocument();
    expect(screen.queryByText("Claude Alpha")).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Search providers" }),
    ).toHaveValue("");

    await user.type(
      screen.getByRole("textbox", { name: "Search providers" }),
      "Codex Beta",
    );
    expect(screen.getByText("Codex Alpha")).toBeInTheDocument();
    expect(findProviderRow("Codex Beta")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();

    await clickAppSwitcherButton(user, "Claude Code");
    await expectProviderVisible("Claude Alpha");
    expect(screen.getByText("Claude Beta")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Search providers" }),
    ).toHaveValue("");
    expect(screen.queryByText("Codex Alpha")).not.toBeInTheDocument();
  });

  it("keeps edit, usage, and duplicate actions scoped to the active app provider", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await expectProviderVisible("Claude Alpha");
    await clickAppSwitcherButton(user, "Codex");
    await expectProviderVisible("Codex Alpha");

    await user.click(within(findProviderRow("Codex Alpha")).getByRole("button", { name: "用量配置" }));
    await waitFor(() =>
      expect(screen.getByTestId("usage-script-modal")).toHaveTextContent(
        "usage:codex:codex-alpha",
      ),
    );
    await user.click(screen.getByText("close-usage"));

    await user.click(within(findProviderRow("Codex Alpha")).getByRole("button", { name: "编辑" }));
    await waitFor(() =>
      expect(screen.getByTestId("edit-provider-dialog")).toHaveTextContent(
        "edit:codex:codex-alpha",
      ),
    );
    await user.click(screen.getByText("close-edit"));

    await user.click(within(findProviderRow("Codex Alpha")).getByRole("button", { name: "复制" }));

    await waitFor(() => {
      expect(screen.getByText("Codex Alpha copy")).toBeInTheDocument();
      expect(Object.values(getProviders("codex")).map((item) => item.name)).toContain(
        "Codex Alpha copy",
      );
      expect(Object.values(getProviders("claude")).map((item) => item.name)).not.toContain(
        "Codex Alpha copy",
      );
    });

    await clickAppSwitcherButton(user, "Claude Code");
    await expectProviderVisible("Claude Alpha");
    expect(screen.queryByText("Codex Alpha copy")).not.toBeInTheDocument();

    await clickAppSwitcherButton(user, "Codex");
    await expectProviderVisible("Codex Alpha copy");
  });

  it("keeps additive live-config membership isolated for OpenCode, OpenClaw, and Hermes", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await expectProviderVisible("Claude Alpha");

    await clickAppSwitcherButton(user, "OpenCode");
    await expectProviderVisible("OpenCode Live");
    expect(screen.getByText("OpenCode Idle")).toBeInTheDocument();
    expect(screen.queryByText("OpenClaw Live")).not.toBeInTheDocument();
    expect(screen.queryByText("Hermes Live")).not.toBeInTheDocument();
    expectAdditiveState("OpenCode Live", "enabled");
    expectAdditiveState("OpenCode Idle", "disabled");

    await clickAppSwitcherButton(user, "OpenClaw");
    await expectProviderVisible("OpenClaw Live");
    expect(screen.getByText("OpenClaw Idle")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode Live")).not.toBeInTheDocument();
    expect(screen.queryByText("Hermes Live")).not.toBeInTheDocument();
    expectAdditiveState("OpenClaw Live", "disabled");
    expectAdditiveState("OpenClaw Idle", "enabled");

    await clickAppSwitcherButton(user, "Hermes");
    await expectProviderVisible("Hermes Live");
    expect(screen.getByText("Hermes Idle")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode Live")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw Live")).not.toBeInTheDocument();
    expectAdditiveState("Hermes Live", "enabled");
    expectAdditiveState("Hermes Idle", "disabled");

    await clickAppSwitcherButton(user, "OpenCode");
    await expectProviderVisible("OpenCode Live");
    expectAdditiveState("OpenCode Live", "enabled");
    expectAdditiveState("OpenCode Idle", "disabled");
  });
});
