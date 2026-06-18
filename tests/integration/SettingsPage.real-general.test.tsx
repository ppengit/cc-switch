import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  addToFailoverQueueState,
  getLastSettingsSaveRequest,
  getSettings,
  getProviders,
  getSwitchLiveSettings,
  removeFromFailoverQueueState,
  resetProviderState,
  setAutoFailoverEnabledState,
  setCurrentProviderId,
  setProviders,
  setProxyTakeoverForAppState,
  setSettings,
  setSwitchLiveSettings,
  startProxyServerState,
} from "../msw/state";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <div>theme-settings</div>,
}));

vi.mock("@/components/settings/SkillStorageLocationSettings", () => ({
  SkillStorageLocationSettings: () => <div>skill-storage-location-settings</div>,
}));

vi.mock("@/components/settings/SkillSyncMethodSettings", () => ({
  SkillSyncMethodSettings: () => <div>skill-sync-method-settings</div>,
}));

vi.mock("@/components/settings/TerminalSettings", () => ({
  TerminalSettings: () => <div>terminal-settings</div>,
}));

vi.mock("@/components/settings/DirectorySettings", () => ({
  DirectorySettings: () => <div>directory-settings</div>,
}));

vi.mock("@/components/settings/ImportExportSection", () => ({
  ImportExportSection: () => <div>import-export-section</div>,
}));

vi.mock("@/components/settings/BackupListSection", () => ({
  BackupListSection: () => <div>backup-list-section</div>,
}));

vi.mock("@/components/settings/WebdavSyncSection", () => ({
  WebdavSyncSection: () => <div>webdav-sync-section</div>,
}));

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => <div>about-section</div>,
}));


vi.mock("@/components/settings/ProxyTabContent", () => ({
  ProxyTabContent: () => <div>proxy-tab-content</div>,
}));

vi.mock("@/components/usage/ModelTestConfigPanel", () => ({
  ModelTestConfigPanel: () => <div>model-test-config-panel</div>,
}));

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: () => <div>usage-dashboard</div>,
}));

vi.mock("@/components/settings/LogConfigPanel", () => ({
  LogConfigPanel: () => <div>log-config-panel</div>,
}));

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <div>auth-center-panel</div>,
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

const seedClaudeProviders = () => {
  setProviders("claude", {
    "claude-alpha": claudeProvider("claude-alpha", "Claude Alpha", 0),
    "claude-beta": claudeProvider("claude-beta", "Claude Beta", 1),
  });
  setCurrentProviderId("claude", "claude-alpha");
};

const renderSettingsPage = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <SettingsPage open onOpenChange={() => {}} defaultTab="general" />
      </Suspense>
    </QueryClientProvider>,
  );
};

const findButtonByTextContent = (text: string) => {
  const button = screen
    .getAllByRole("button")
    .find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Button not found for text: ${text}`);
  return button;
};

describe("SettingsPage general tab with real auto-save settings", () => {
  beforeEach(() => {
    resetProviderState();
    seedClaudeProviders();
    setSettings({
      enableClaudePluginIntegration: false,
      visibleApps: {
        claude: true,
        "claude-desktop": false,
        codex: true,
        gemini: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      },
      enableLocalProxy: true,
      proxyConfirmed: true,
      enableFailoverToggle: true,
      failoverConfirmed: true,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("keeps Claude live config on the proxy endpoint when plugin integration toggles in takeover+failover mode", async () => {
    const user = userEvent.setup();

    startProxyServerState();
    setProxyTakeoverForAppState("claude", true);
    setAutoFailoverEnabledState("claude", true);
    addToFailoverQueueState("claude", "claude-beta");
    removeFromFailoverQueueState("claude", "claude-alpha");
    setSwitchLiveSettings(
      "claude",
      getProviders("claude")["claude-beta"].settingsConfig,
    );

    expect(
      (getSwitchLiveSettings("claude") as { env?: Record<string, string> }).env
        ?.ANTHROPIC_BASE_URL,
    ).toBe("https://claude-beta.example.com");

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "settings.tabGeneral" }),
      ).toHaveAttribute("data-state", "active"),
    );

    const pluginSwitch = await screen.findByRole("switch", {
      name: "settings.enableClaudePluginIntegration",
    });
    expect(pluginSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(pluginSwitch);

    await waitFor(() =>
      expect(getSettings().enableClaudePluginIntegration).toBe(true),
    );
    await waitFor(() =>
      expect(
        getLastSettingsSaveRequest()?.enableClaudePluginIntegration,
      ).toBe(true),
    );
    await waitFor(() => {
      const live = getSwitchLiveSettings("claude") as {
        env?: Record<string, string>;
      };
      expect(live.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:15721");
      expect(live.env?.ANTHROPIC_AUTH_TOKEN).toBe("PROXY_MANAGED");
    });

    await user.click(pluginSwitch);

    await waitFor(() =>
      expect(getSettings().enableClaudePluginIntegration).toBe(false),
    );
    await waitFor(() =>
      expect(
        getLastSettingsSaveRequest()?.enableClaudePluginIntegration,
      ).toBe(false),
    );
    await waitFor(() => {
      const live = getSwitchLiveSettings("claude") as {
        env?: Record<string, string>;
      };
      expect(live.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:15721");
      expect(live.env?.ANTHROPIC_BASE_URL).not.toBe(
        "https://claude-beta.example.com",
      );
    });
  });

  it("auto-saves app visibility changes and prevents disabling the last visible app", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "settings.tabGeneral" }),
      ).toHaveAttribute("data-state", "active"),
    );

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button")
          .some((item) => item.textContent?.includes("apps.claudeCode")),
      ).toBe(true),
    );
    const claudeButton = findButtonByTextContent("apps.claudeCode");
    const codexButton = findButtonByTextContent("apps.codex");

    expect(claudeButton).not.toBeDisabled();
    expect(codexButton).not.toBeDisabled();

    await user.click(codexButton);

    await waitFor(() =>
      expect(getLastSettingsSaveRequest()?.visibleApps).toMatchObject({
        claude: true,
        codex: false,
      }),
    );
    await waitFor(() => expect(codexButton).not.toBeDisabled());
    await waitFor(() => expect(claudeButton).toBeDisabled());

    await user.click(claudeButton);

    await waitFor(() =>
      expect(getSettings().visibleApps).toMatchObject({
        claude: true,
        codex: false,
      }),
    );
  });
});
