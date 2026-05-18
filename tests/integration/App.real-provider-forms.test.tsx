import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import {
  getLiveProviderIds,
  getProviders,
  resetProviderState,
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

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const clickHeaderAddButton = async (user: ReturnType<typeof userEvent.setup>) => {
  const header = screen.getByRole("banner");
  const addButton = within(header).getByRole("button", { name: "" });
  await user.click(addButton);
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

const getInputById = async (id: string): Promise<HTMLInputElement> => {
  await waitFor(() => {
    expect(document.getElementById(id)).toBeInstanceOf(HTMLInputElement);
  });
  return document.getElementById(id) as HTMLInputElement;
};

const getProviderNameInput = () =>
  screen.queryByLabelText("provider.name") ??
  screen.queryByLabelText("供应商名称") ??
  screen.getByLabelText("Provider Name");

const getApiKeyInput = () =>
  screen.queryByLabelText("API Key") ??
  screen.queryByLabelText("apiKeyInput.label") ??
  screen.getByLabelText("密钥");

describe("App with real provider add/edit forms", () => {
  beforeEach(() => {
    resetProviderState();
    setProviders("opencode", {
      "opencode-live": opencodeProvider("opencode-live", "OpenCode Live", 0),
      "opencode-draft": opencodeProvider("opencode-draft", "OpenCode Draft", 1),
    });
    setLiveProviderIds("opencode", ["opencode-live"]);
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("adds an OpenCode provider from the real App dialog and keeps live membership in the active app", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await clickAppSwitcherButton(user, "OpenCode");
    await waitFor(() =>
      expect(screen.getByText("OpenCode Live")).toBeInTheDocument(),
    );

    await clickHeaderAddButton(user);
    await user.type(await getInputById("opencode-key"), "opencode-new");
    await user.type(getProviderNameInput(), "OpenCode New");
    await user.clear(getApiKeyInput());
    await user.type(getApiKeyInput(), "sk-opencode-new");
    await user.clear(await getInputById("opencode-baseurl"));
    await user.type(
      await getInputById("opencode-baseurl"),
      "https://opencode-new.example.com/v1",
    );

    await user.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => {
      const providers = getProviders("opencode");
      expect(providers["opencode-new"]).toBeDefined();
      expect(providers["opencode-new"].name).toBe("OpenCode New");
      expect(providers["opencode-new"].settingsConfig.options).toMatchObject({
        baseURL: "https://opencode-new.example.com/v1",
        apiKey: "sk-opencode-new",
      });
      expect(getLiveProviderIds("opencode")).toEqual([
        "opencode-live",
        "opencode-new",
      ]);
    });

    expect(getProviders("claude")["opencode-new"]).toBeUndefined();
  }, 20_000);

  it("edits an OpenCode provider through the real App dialog using originalId semantics", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await clickAppSwitcherButton(user, "OpenCode");
    await waitFor(() =>
      expect(screen.getByText("OpenCode Live")).toBeInTheDocument(),
    );

    await user.click(
      within(findProviderRow("OpenCode Draft")).getByRole("button", {
        name: "编辑",
      }),
    );
    const keyInput = await getInputById("opencode-key");
    expect(keyInput).toHaveValue("opencode-draft");

    await user.clear(keyInput);
    await user.type(keyInput, "opencode-renamed");
    await user.clear(getProviderNameInput());
    await user.type(getProviderNameInput(), "OpenCode Renamed");
    await user.clear(await getInputById("opencode-baseurl"));
    await user.type(
      await getInputById("opencode-baseurl"),
      "https://opencode-renamed.example.com/v1",
    );

    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      const providers = getProviders("opencode");
      expect(providers["opencode-draft"]).toBeUndefined();
      expect(providers["opencode-renamed"]).toBeDefined();
      expect(providers["opencode-renamed"].name).toBe("OpenCode Renamed");
      expect(providers["opencode-renamed"].settingsConfig.options.baseURL).toBe(
        "https://opencode-renamed.example.com/v1",
      );
      expect(getLiveProviderIds("opencode")).toEqual(["opencode-live"]);
    });
  }, 20_000);
});
