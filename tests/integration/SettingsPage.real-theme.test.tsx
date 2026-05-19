import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { ThemeProvider } from "@/components/theme-provider";
import {
  getLastWindowThemeRequest,
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

vi.mock("@/components/settings/LanguageSettings", () => ({
  LanguageSettings: () => <div>language-settings</div>,
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

vi.mock("@/components/settings/WindowSettings", () => ({
  WindowSettings: () => <div>window-settings</div>,
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

vi.mock("@/components/settings/ApiHubPanel", () => ({
  ApiHubPanel: () => <div>api-hub-panel</div>,
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
      <ThemeProvider>
        <Suspense fallback={<div data-testid="loading">loading</div>}>
          <SettingsPage open onOpenChange={() => {}} defaultTab="general" />
        </Suspense>
      </ThemeProvider>
    </QueryClientProvider>,
  );
};

describe("SettingsPage real theme settings", () => {
  beforeEach(() => {
    resetProviderState();
    setSettings({ language: "zh" });
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.documentElement.className = "";
  });

  it("syncs theme choice to localStorage, document classes, and native window theme through the real settings page", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "settings.tabGeneral" }),
      ).toHaveAttribute("data-state", "active"),
    );

    await waitFor(() =>
      expect(getLastWindowThemeRequest()).toBe("system"),
    );
    await waitFor(() =>
      expect(document.documentElement.classList.contains("light")).toBe(true),
    );

    await user.click(
      screen.getByRole("button", { name: "settings.themeDark" }),
    );

    await waitFor(() =>
      expect(window.localStorage.getItem("cc-switch-theme")).toBe("dark"),
    );
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
    await waitFor(() => expect(getLastWindowThemeRequest()).toBe("dark"));

    await user.click(
      screen.getByRole("button", { name: "settings.themeSystem" }),
    );

    await waitFor(() =>
      expect(window.localStorage.getItem("cc-switch-theme")).toBe("system"),
    );
    await waitFor(() =>
      expect(document.documentElement.classList.contains("light")).toBe(true),
    );
    await waitFor(() => expect(getLastWindowThemeRequest()).toBe("system"));
  });
});
