import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getLogConfigState,
  getLogConfigSaveHistory,
  resetProviderState,
  setLogConfigState,
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

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <div>auth-center-panel</div>,
}));

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

describe("SettingsPage with real LogConfigPanel", () => {
  beforeEach(() => {
    resetProviderState();
    setLogConfigState({
      enabled: true,
      level: "info",
      rawProxyLogRetentionMinutes: 30,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("loads, disables, clamps, and saves log config through the real advanced settings entry", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "settings.tabAdvanced" }),
      ).toHaveAttribute("data-state", "active"),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "common.save" }),
      ).toBeInTheDocument(),
    );

    const logConfigTrigger = screen
      .getByText("settings.advanced.logConfig.title")
      .closest("button");
    if (!logConfigTrigger) throw new Error("Log config accordion trigger not found");
    await user.click(logConfigTrigger);

    const enabledSwitch = await screen.findByRole("switch");
    const levelTrigger = screen.getByRole("combobox");
    const retentionInput = screen.getByRole("spinbutton");

    expect(enabledSwitch).toHaveAttribute("aria-checked", "true");
    expect(levelTrigger).toHaveTextContent("settings.advanced.logConfig.levels.info");
    expect(retentionInput).toHaveValue(30);

    await user.click(enabledSwitch);
    await waitFor(() =>
      expect(enabledSwitch).toHaveAttribute("aria-checked", "false"),
    );
    await waitFor(() => expect(levelTrigger).toBeDisabled());

    expect(getLogConfigSaveHistory()).toContainEqual({
      enabled: false,
      level: "info",
      rawProxyLogRetentionMinutes: 30,
    });

    await user.click(enabledSwitch);
    await waitFor(() =>
      expect(enabledSwitch).toHaveAttribute("aria-checked", "true"),
    );
    await waitFor(() => expect(levelTrigger).not.toBeDisabled());

    await user.click(levelTrigger);
    await user.click(
      await screen.findByRole("option", {
        name: "settings.advanced.logConfig.levels.trace",
      }),
    );

    await waitFor(() =>
      expect(getLogConfigState().level).toBe("trace"),
    );

    await user.clear(retentionInput);
    await user.type(retentionInput, "9999");
    await user.tab();

    await waitFor(() =>
      expect(retentionInput).toHaveValue(1440),
    );

    expect(getLogConfigState()).toEqual({
      enabled: true,
      level: "trace",
      rawProxyLogRetentionMinutes: 1440,
    });
    expect(getLogConfigSaveHistory()).toContainEqual({
      enabled: true,
      level: "trace",
      rawProxyLogRetentionMinutes: 1440,
    });
  });
});
