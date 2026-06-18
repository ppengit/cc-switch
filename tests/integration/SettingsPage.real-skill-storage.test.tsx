import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { useSettingsQuery } from "@/lib/query";
import {
  getSettings,
  resetProviderState,
  setInstalledSkillsState,
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

function SkillStorageLocationObserver() {
  const { data } = useSettingsQuery();
  return (
    <div data-testid="skill-storage-location-observer">
      {data?.skillStorageLocation ?? "cc_switch"}
    </div>
  );
}

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
        <>
          <SkillStorageLocationObserver />
          <SettingsPage open onOpenChange={() => {}} defaultTab="general" />
        </>
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("SettingsPage skill storage migration", () => {
  beforeEach(() => {
    resetProviderState();
    setSettings({
      skillStorageLocation: "cc_switch",
    });
    setInstalledSkillsState([
      {
        id: "skill-alpha",
        name: "Skill Alpha",
        description: "Managed skill fixture",
        directory: "skill-alpha",
        repoOwner: "mock-owner",
        repoName: "mock-skills",
        repoBranch: "main",
        readmeUrl:
          "https://github.com/mock-owner/mock-skills/tree/main/skill-alpha",
        apps: {
          claude: true,
          codex: false,
          gemini: false,
          opencode: false,
          openclaw: false,
          hermes: false,
        },
        installedAt: 1_700_010_000,
        updatedAt: 1_700_010_100,
        contentHash: "hash-alpha",
      },
    ]);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("confirms migration and synchronizes the new skill storage location to shared settings state", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "settings.tabGeneral" }),
      ).toHaveAttribute("data-state", "active"),
    );

    const unifiedButton = await screen.findByRole("button", {
      name: "settings.skillStorage.unified",
    });

    expect(screen.getByTestId("skill-storage-location-observer")).toHaveTextContent(
      "cc_switch",
    );

    await user.click(unifiedButton);

    expect(getSettings().skillStorageLocation).toBe("cc_switch");
    expect(screen.getByTestId("skill-storage-location-observer")).toHaveTextContent(
      "cc_switch",
    );

    await waitFor(() =>
      expect(
        screen.getByText("settings.skillStorage.confirmTitle"),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() =>
      expect(getSettings().skillStorageLocation).toBe("unified"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("skill-storage-location-observer"),
      ).toHaveTextContent("unified"),
    );
  });
});
