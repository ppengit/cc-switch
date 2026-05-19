import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import {
  getLastSettingsSaveRequest,
  getProviders,
  resetProviderState,
  setCurrentProviderId,
  setProviders,
  setSettings,
} from "../msw/state";

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

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
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: () => null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: () => null,
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

  const utils = render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );

  return { client, ...utils };
};

const claudeProvider = (id: string, name: string): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex: 0,
  createdAt: 1_700_000_000_000,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: `https://${id}.example.com/v1`,
      ANTHROPIC_AUTH_TOKEN: `${id}-token`,
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
    },
  },
});

const findProviderRow = (providerName: string): HTMLElement => {
  const row = screen
    .getAllByRole("row")
    .find((item) => within(item).queryByText(providerName));
  if (!row) {
    throw new Error(`Provider row not found: ${providerName}`);
  }
  return row;
};

describe("App with real UsageScriptModal", () => {
  beforeEach(() => {
    resetProviderState();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    setProviders("claude", {
      "claude-usage": claudeProvider("claude-usage", "Claude Usage"),
    });
    setCurrentProviderId("claude", "claude-usage");
    setSettings({
      usageConfirmed: false,
      webdavSync: {
        enabled: true,
        url: "https://webdav.example.com/remote.php/dav/files/demo",
        username: "demo",
        password: "",
      },
    } as any);
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("confirms usage settings, tests the script, and saves provider usage_script through the real App entry", async () => {
    const user = userEvent.setup();
    const { client } = renderApp((await import("@/App")).default);

    await waitFor(() =>
      expect(screen.getByText("Claude Usage")).toBeInTheDocument(),
    );

    await user.click(
      within(findProviderRow("Claude Usage")).getByRole("button", {
        name: "用量配置",
      }),
    );

    const enableSwitch = await screen.findByRole("switch", {
      name: "usageScript.enableUsageQuery",
    });
    expect(
      screen.getByRole("button", { name: "usageScript.testScript" }),
    ).toBeDisabled();

    await user.click(enableSwitch);
    await user.click(
      await screen.findByRole("button", { name: "confirm.usage.confirm" }),
    );

    await waitFor(() =>
      expect(getLastSettingsSaveRequest()).toMatchObject({
        usageConfirmed: true,
      }),
    );
    expect(getLastSettingsSaveRequest()).not.toHaveProperty("webdavSync");

    const apiKeyInput = document.getElementById(
      "usage-api-key",
    ) as HTMLInputElement | null;
    const baseUrlInput = document.getElementById(
      "usage-base-url",
    ) as HTMLInputElement | null;
    if (!apiKeyInput || !baseUrlInput) {
      throw new Error("Usage credential inputs not found");
    }

    await user.clear(apiKeyInput);
    await user.type(apiKeyInput, "usage-test-key");
    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, "https://usage.example.com/v1");

    const testButton = screen.getByRole("button", {
      name: "usageScript.testScript",
    });
    await waitFor(() => expect(testButton).toBeEnabled());
    await user.click(testButton);

    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringContaining("usageScript.testSuccess"),
        expect.objectContaining({
          closeButton: true,
        }),
      ),
    );

    expect(client.getQueryData(["usage", "claude-usage", "claude"])).toMatchObject({
      success: true,
      data: [
        {
          planName: "Primary",
          remaining: 42,
          unit: "USD",
        },
      ],
    });

    await user.click(
      screen.getByRole("button", { name: "usageScript.saveConfig" }),
    );

    await waitFor(() =>
      expect(getProviders("claude")["claude-usage"].meta?.usage_script).toMatchObject(
        {
          enabled: true,
          templateType: "general",
          apiKey: "usage-test-key",
          baseUrl: "https://usage.example.com/v1",
        },
      ),
    );

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(
      toastSuccessMock.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes("用量查询配置已保存"),
      ),
    ).toBe(true);
  }, 20_000);
});
