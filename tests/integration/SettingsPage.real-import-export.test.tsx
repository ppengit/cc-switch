import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Provider } from "@/types";
import { server } from "../msw/server";
import {
  getProviders,
  getSettings,
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
  syncCurrentProvidersLiveState,
} from "../msw/state";

const TAURI_ENDPOINT = "http://tauri.local";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
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

vi.mock("@/components/settings/DirectorySettings", () => ({
  DirectorySettings: () => <div>directory-settings</div>,
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

const renderSettingsPage = (onImportSuccess = vi.fn()) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <SettingsPage
          open
          onOpenChange={() => {}}
          defaultTab="advanced"
          onImportSuccess={onImportSuccess}
        />
      </Suspense>
    </QueryClientProvider>,
  );
};

const openDataSection = async (
  user: ReturnType<typeof userEvent.setup>,
  onImportSuccess = vi.fn(),
) => {
  renderSettingsPage(onImportSuccess);

  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: "settings.tabAdvanced" }),
    ).toHaveAttribute("data-state", "active"),
  );

  await user.click(
    screen.getByRole("button", {
      name: /settings\.advanced\.data\.title/,
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("settings.importExport")).toBeInTheDocument(),
  );
};

describe("SettingsPage with real ImportExportSection", () => {
  beforeEach(() => {
    resetProviderState();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("selects, imports, clears, and exports config through the real settings page", async () => {
    const user = userEvent.setup();
    const onImportSuccess = vi.fn();
    const importRequests: string[] = [];
    const exportRequests: string[] = [];
    const saveDialogDefaults: string[] = [];
    let syncCount = 0;

    server.use(
      http.post(`${TAURI_ENDPOINT}/open_file_dialog`, () =>
        HttpResponse.json("/mock/import-from-settings.sql"),
      ),
      http.post(`${TAURI_ENDPOINT}/import_config_from_file`, async ({ request }) => {
        const { filePath } = (await request.json()) as { filePath: string };
        importRequests.push(filePath);
        setSettings({ language: "en" });
        return HttpResponse.json({ success: true, backupId: "backup-real-001" });
      }),
      http.post(`${TAURI_ENDPOINT}/sync_current_providers_live`, () => {
        syncCount += 1;
        return HttpResponse.json({
          success: true,
          message: "Live configuration synchronized",
        });
      }),
      http.post(`${TAURI_ENDPOINT}/save_file_dialog`, async ({ request }) => {
        const { defaultName } = (await request.json()) as {
          defaultName: string;
        };
        saveDialogDefaults.push(defaultName);
        return HttpResponse.json("/mock/export-from-settings.sql");
      }),
      http.post(`${TAURI_ENDPOINT}/export_config_to_file`, async ({ request }) => {
        const { filePath } = (await request.json()) as { filePath: string };
        exportRequests.push(filePath);
        return HttpResponse.json({ success: true, filePath });
      }),
    );

    await openDataSection(user, onImportSuccess);

    await user.click(
      screen.getByRole("button", { name: /settings\.selectConfigFile/ }),
    );
    await waitFor(() =>
      expect(screen.getByText(/import-from-settings\.sql/)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /settings\.import/ }));

    await waitFor(() =>
      expect(screen.getByText("settings.importSuccess")).toBeInTheDocument(),
    );
    expect(screen.getByText(/backup-real-001/)).toBeInTheDocument();
    expect(importRequests).toEqual(["/mock/import-from-settings.sql"]);
    expect(onImportSuccess).toHaveBeenCalledTimes(1);
    expect(syncCount).toBe(1);
    expect(getSettings().language).toBe("en");

    await user.click(screen.getByRole("button", { name: "common.clear" }));
    await waitFor(() =>
      expect(screen.queryByText(/import-from-settings\.sql/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("settings.importSuccess")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "settings.exportConfig" }));
    await waitFor(() =>
      expect(exportRequests).toEqual(["/mock/export-from-settings.sql"]),
    );
    expect(saveDialogDefaults).toHaveLength(1);
    expect(saveDialogDefaults[0]).toMatch(
      /^cc-switch-export-\d{8}_\d{6}\.sql$/,
    );
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("/mock/export-from-settings.sql"),
      expect.objectContaining({ closeButton: true }),
    );
  });

  it("shows import errors and recovers after clearing the failed selection", async () => {
    const user = userEvent.setup();
    const importRequests: string[] = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/open_file_dialog`, () =>
        HttpResponse.json("/mock/broken-settings.sql"),
      ),
      http.post(`${TAURI_ENDPOINT}/import_config_from_file`, async ({ request }) => {
        const { filePath } = (await request.json()) as { filePath: string };
        importRequests.push(filePath);
        return HttpResponse.json({
          success: false,
          message: "Broken SQL backup",
        });
      }),
    );

    await openDataSection(user);

    await user.click(
      screen.getByRole("button", { name: /settings\.selectConfigFile/ }),
    );
    await waitFor(() =>
      expect(screen.getByText(/broken-settings\.sql/)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /settings\.import/ }));

    await waitFor(() =>
      expect(screen.getByText("Broken SQL backup")).toBeInTheDocument(),
    );
    expect(importRequests).toEqual(["/mock/broken-settings.sql"]);
    expect(toastErrorMock).toHaveBeenCalledWith("Broken SQL backup");

    await user.click(screen.getByRole("button", { name: "common.clear" }));
    await waitFor(() =>
      expect(screen.queryByText("Broken SQL backup")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/broken-settings\.sql/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /settings\.selectConfigFile/ }),
    ).toBeEnabled();
  });

  it("keeps Claude live config on the proxy endpoint after importing config in takeover+failover mode", async () => {
    const user = userEvent.setup();

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

    setSwitchLiveSettings(
      "claude",
      getProviders("claude")["claude-beta"].settingsConfig,
    );
    expect(
      (getSwitchLiveSettings("claude") as { env?: Record<string, string> }).env
        ?.ANTHROPIC_BASE_URL,
    ).toBe("https://claude-beta.example.com");

    server.use(
      http.post(`${TAURI_ENDPOINT}/open_file_dialog`, () =>
        HttpResponse.json("/mock/takeover-import.sql"),
      ),
      http.post(`${TAURI_ENDPOINT}/import_config_from_file`, () => {
        setSettings({ language: "en" });
        return HttpResponse.json({
          success: true,
          backupId: "backup-takeover-001",
        });
      }),
      http.post(`${TAURI_ENDPOINT}/sync_current_providers_live`, () =>
        HttpResponse.json(syncCurrentProvidersLiveState()),
      ),
    );

    await openDataSection(user);

    await user.click(
      screen.getByRole("button", { name: /settings\.selectConfigFile/ }),
    );
    await waitFor(() =>
      expect(screen.getByText(/takeover-import\.sql/)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /settings\.import/ }));

    await waitFor(() =>
      expect(screen.getByText("settings.importSuccess")).toBeInTheDocument(),
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
