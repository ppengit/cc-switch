import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getFailoverQueueState,
  getLastSettingsSaveRequest,
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

vi.mock("@/components/settings/LanguageSettings", () => ({
  LanguageSettings: () => <div>language-settings</div>,
}));

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <div>theme-settings</div>,
}));

vi.mock("@/components/settings/WindowSettings", () => ({
  WindowSettings: () => <div>window-settings</div>,
}));

vi.mock("@/components/settings/AppVisibilitySettings", () => ({
  AppVisibilitySettings: () => <div>app-visibility-settings</div>,
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
        <SettingsPage open onOpenChange={() => {}} defaultTab="advanced" />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("SettingsPage directory sync with real DirectorySettings", () => {
  beforeEach(() => {
    resetProviderState();
    seedClaudeProviders();
    setSettings({
      enableLocalProxy: true,
      proxyConfirmed: true,
      enableFailoverToggle: true,
      failoverConfirmed: true,
    });
    startProxyServerState();
    setProxyTakeoverForAppState("claude", true);
    setAutoFailoverEnabledState("claude", true);
    removeFromFailoverQueueState("claude", "claude-alpha");
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("keeps Claude live config on the proxy endpoint after saving a directory override in takeover+failover mode", async () => {
    const user = userEvent.setup();

    expect(getFailoverQueueState("claude")).toEqual([]);

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
        screen.getByRole("tab", { name: "settings.tabAdvanced" }),
      ).toHaveAttribute("data-state", "active"),
    );

    await user.click(
      await screen.findByRole("button", {
        name: /settings\.advanced\.configDir\.title/,
      }),
    );

    const claudeDirInput = (await screen.findByPlaceholderText(
      "settings.browsePlaceholderClaude",
    )) as HTMLInputElement;
    fireEvent.change(claudeDirInput, {
      target: { value: "/custom/claude-takeover-sync" },
    });
    expect(claudeDirInput.value).toBe("/custom/claude-takeover-sync");

    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(getLastSettingsSaveRequest()).toMatchObject({
        claudeConfigDir: "/custom/claude-takeover-sync",
      }),
    );

    await waitFor(() => {
      const live = getSwitchLiveSettings("claude") as {
        env?: Record<string, string>;
      };
      expect(live.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:15721");
      expect(live.env?.ANTHROPIC_AUTH_TOKEN).toBe("PROXY_MANAGED");
      expect(live.env?.ANTHROPIC_BASE_URL).not.toBe(
        "https://claude-alpha.example.com",
      );
      expect(live.env?.ANTHROPIC_BASE_URL).not.toBe(
        "https://claude-beta.example.com",
      );
    });
  });
});
