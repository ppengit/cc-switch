import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getOpenExternalRequests,
  getToolVersionsRequests,
  resetProviderState,
} from "../msw/state";

const checkUpdateMock = vi.fn();

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "3.15.2"),
}));

vi.mock("@/lib/platform", () => ({
  isWindows: () => false,
  isMac: () => false,
  isLinux: () => true,
  DRAG_REGION_ENABLED: true,
  DRAG_REGION_ATTR: { "data-tauri-drag-region": true },
  DRAG_REGION_STYLE: { WebkitAppRegion: "drag" },
}));

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
    checkUpdate: checkUpdateMock,
    resetDismiss: vi.fn(),
  }),
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
  SkillStorageLocationSettings: () => (
    <div>skill-storage-location-settings</div>
  ),
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
        <SettingsPage open onOpenChange={() => {}} defaultTab="about" />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("SettingsPage real about section", () => {
  beforeEach(() => {
    resetProviderState();
    checkUpdateMock.mockReset();
    checkUpdateMock.mockResolvedValue(false);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("loads version and tool info, opens external links, and checks updates through the real about tab", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "common.about" })).toHaveAttribute(
        "data-state",
        "active",
      ),
    );

    await waitFor(() =>
      expect(screen.getByText("CC Switch")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("v3.15.2")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("Claude Code")).toBeInTheDocument(),
    );

    await user.click(
      await screen.findByRole("button", { name: "common.refresh" }),
    );

    await waitFor(() =>
      expect(
        Array.from(
          new Set(
            getToolVersionsRequests().flatMap(
              (request) => request.tools ?? [],
            ),
          ),
        ).sort(),
      ).toEqual([
        "claude",
        "codex",
        "gemini",
        "hermes",
        "openclaw",
        "opencode",
      ]),
    );

    await user.click(
      screen.getByRole("button", { name: "settings.officialWebsite" }),
    );
    await user.click(screen.getByRole("button", { name: "settings.github" }));
    await user.click(
      screen.getByRole("button", { name: "settings.releaseNotes" }),
    );

    await waitFor(() =>
      expect(getOpenExternalRequests()).toEqual([
        "https://ccswitch.io",
        "https://github.com/farion1231/cc-switch",
        "https://github.com/ppengit/cc-switch/releases/tag/v3.15.2",
      ]),
    );

    await user.click(
      screen.getByRole("button", { name: "settings.checkForUpdates" }),
    );
    await waitFor(() => expect(checkUpdateMock).toHaveBeenCalledTimes(1));

    await user.click(
      screen.getByRole("button", { name: "settings.manualInstallCommands" }),
    );
    expect(screen.getByText(/@openai\/codex@latest/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "common.copy" }),
    ).toBeInTheDocument();
  });
});
