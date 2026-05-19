import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import {
  getAutoFailoverEnabled,
  getCurrentProviderId,
  getFailoverQueueState,
  getProxyStatusState,
  getProxyTakeoverStatusState,
  getSwitchLiveSettings,
  resetProviderState,
  setCurrentProviderId,
  setProviders,
  setSettings,
  startProxyServerState,
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

const getHeaderSwitches = () =>
  within(screen.getByRole("banner")).getAllByRole("switch");

const waitForHeaderSwitches = async () => {
  await waitFor(() => expect(getHeaderSwitches()).toHaveLength(2));
  return getHeaderSwitches();
};

describe("App header proxy and failover toggles", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    setProviders("claude", {
      "claude-alpha": claudeProvider("claude-alpha", "Claude Alpha", 0),
      "claude-beta": claudeProvider("claude-beta", "Claude Beta", 1),
    });
    setCurrentProviderId("claude", "claude-beta");
    setSettings({
      enableLocalProxy: true,
      enableFailoverToggle: true,
      proxyConfirmed: true,
      failoverConfirmed: true,
    });
    startProxyServerState();
  });

  it("drives takeover and failover state from the real header controls without corrupting live config", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    let [proxySwitch, failoverSwitch] = await waitForHeaderSwitches();
    expect(proxySwitch).toHaveAttribute("aria-checked", "false");
    expect(failoverSwitch).toBeDisabled();

    await user.click(proxySwitch);
    await waitFor(() =>
      expect(getProxyTakeoverStatusState().claude).toBe(true),
    );
    await waitFor(() => {
      [proxySwitch, failoverSwitch] = getHeaderSwitches();
      expect(proxySwitch).toHaveAttribute("aria-checked", "true");
      expect(failoverSwitch).not.toBeDisabled();
    });

    expect(getSwitchLiveSettings("claude")).toMatchObject({
      env: {
        ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      },
    });

    await user.click(failoverSwitch);
    await waitFor(() => expect(getAutoFailoverEnabled("claude")).toBe(true));
    expect(getCurrentProviderId("claude")).toBe("");
    expect(getFailoverQueueState("claude").map((item) => item.providerId)).toEqual([
      "claude-beta",
    ]);
    expect(getProxyStatusState().active_targets).toEqual([
      {
        app_type: "claude",
        provider_id: "claude-beta",
        provider_name: "Claude Beta",
      },
    ]);
    expect(getSwitchLiveSettings("claude")).toMatchObject({
      env: {
        ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      },
    });

    [, failoverSwitch] = getHeaderSwitches();
    await user.click(failoverSwitch);
    await waitFor(() => expect(getAutoFailoverEnabled("claude")).toBe(false));
    expect(getFailoverQueueState("claude").map((item) => item.providerId)).toEqual([
      "claude-beta",
    ]);
    expect(getCurrentProviderId("claude")).toBe("claude-beta");
    expect(getProxyStatusState().active_targets).toEqual([
      {
        app_type: "claude",
        provider_id: "claude-beta",
        provider_name: "Claude Beta",
      },
    ]);
    expect(getSwitchLiveSettings("claude")).toMatchObject({
      env: {
        ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      },
    });

    [proxySwitch] = getHeaderSwitches();
    await user.click(proxySwitch);
    await waitFor(() =>
      expect(getProxyTakeoverStatusState().claude).toBe(false),
    );
    expect(getAutoFailoverEnabled("claude")).toBe(false);
    expect(getCurrentProviderId("claude")).toBe("claude-beta");
    expect(getProxyStatusState().running).toBe(false);
    expect(getProxyStatusState().active_targets).toEqual([]);
    expect(getSwitchLiveSettings("claude")).toMatchObject({
      env: {
        ANTHROPIC_AUTH_TOKEN: "claude-beta-token",
        ANTHROPIC_BASE_URL: "https://claude-beta.example.com",
      },
    });
  }, 20_000);
});
