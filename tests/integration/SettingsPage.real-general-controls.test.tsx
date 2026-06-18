import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getLastAutoLaunchRequest,
  getLastClaudeOnboardingSkipAction,
  getLastSettingsSaveRequest,
  getSettings,
  resetProviderState,
  setSettings,
} from "../msw/state";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
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

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <div>theme-settings</div>,
}));

vi.mock("@/components/settings/SkillStorageLocationSettings", () => ({
  SkillStorageLocationSettings: () => <div>skill-storage-location-settings</div>,
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

const waitForGeneralControlsReady = async () => {
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: "settings.languageOptionEnglish",
      }),
    ).toBeInTheDocument(),
  );
};

const openTerminalSelectAndChooseNext = async (
  user: ReturnType<typeof userEvent.setup>,
) => {
  const trigger = screen.getByRole("combobox");
  const currentText = trigger.textContent ?? "";
  await user.click(trigger);
  const options = await screen.findAllByRole("option");
  const nextOption = options.find((item) => item.textContent !== currentText);
  if (!nextOption) {
    throw new Error("No alternative terminal option found");
  }
  await user.click(nextOption);
};

describe("SettingsPage real general controls", () => {
  beforeEach(() => {
    resetProviderState();
    setSettings({
      language: "zh",
      launchOnStartup: false,
      silentStartup: false,
      skipClaudeOnboarding: false,
      minimizeToTrayOnClose: true,
      enableClaudePluginIntegration: false,
      preferredTerminal: undefined,
      skillSyncMethod: "auto",
      visibleApps: {
        claude: true,
        "claude-desktop": true,
        codex: true,
        gemini: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      },
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("persists language selection to settings and localStorage through the real general tab", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitForGeneralControlsReady();

    await user.click(
      screen.getByRole("button", {
        name: "settings.languageOptionEnglish",
      }),
    );

    await waitFor(() => expect(getSettings().language).toBe("en"));
    await waitFor(() =>
      expect(getLastSettingsSaveRequest()?.language).toBe("en"),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem("language")).toBe("en"),
    );
  });

  it("keeps launch-on-startup side effects and nested silent-startup state aligned through the real window settings", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "settings.launchOnStartup" }),
      ).toHaveAttribute("aria-checked", "false"),
    );
    expect(
      screen.queryByRole("switch", { name: "settings.silentStartup" }),
    ).toBeNull();

    await user.click(
      screen.getByRole("switch", { name: "settings.launchOnStartup" }),
    );

    await waitFor(() => expect(getSettings().launchOnStartup).toBe(true));
    await waitFor(() => expect(getLastAutoLaunchRequest()).toBe(true));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "settings.silentStartup" }),
      ).toHaveAttribute("aria-checked", "false"),
    );

    await user.click(
      screen.getByRole("switch", { name: "settings.silentStartup" }),
    );

    await waitFor(() => expect(getSettings().silentStartup).toBe(true));
    await waitFor(() =>
      expect(getLastSettingsSaveRequest()?.silentStartup).toBe(true),
    );

    await user.click(
      screen.getByRole("switch", {
        name: "settings.skipClaudeOnboarding",
      }),
    );

    await waitFor(() =>
      expect(getSettings().skipClaudeOnboarding).toBe(true),
    );
    await waitFor(() =>
      expect(getLastClaudeOnboardingSkipAction()).toBe("apply"),
    );
  });

  it("saves preferred terminal and skill sync method through the real general controls", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitForGeneralControlsReady();

    await openTerminalSelectAndChooseNext(user);

    await waitFor(() =>
      expect(getSettings().preferredTerminal).toBeTruthy(),
    );
    await waitFor(() =>
      expect(getLastSettingsSaveRequest()?.preferredTerminal).toBe(
        getSettings().preferredTerminal,
      ),
    );

    await user.click(
      screen.getByRole("button", { name: "settings.skillSync.copy" }),
    );

    await waitFor(() => expect(getSettings().skillSyncMethod).toBe("copy"));
    await waitFor(() =>
      expect(getLastSettingsSaveRequest()?.skillSyncMethod).toBe("copy"),
    );

    await user.click(
      screen.getByRole("button", { name: "settings.skillSync.symlink" }),
    );

    await waitFor(() => expect(getSettings().skillSyncMethod).toBe("symlink"));
    await waitFor(() =>
      expect(getLastSettingsSaveRequest()?.skillSyncMethod).toBe("symlink"),
    );
  });
});
