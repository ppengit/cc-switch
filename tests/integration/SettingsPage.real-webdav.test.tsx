import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getLastSettingsSaveRequest,
  getLastWebdavSaveRequest,
  getSettings,
  getWebdavSyncCounts,
  getWebdavTestRequests,
  resetProviderState,
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

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, title, confirmText, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onCancel}>common.cancel</button>
      </div>
    ) : null,
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

const openCloudSyncSection = async (user: ReturnType<typeof userEvent.setup>) => {
  renderSettingsPage();

  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: "settings.tabAdvanced" }),
    ).toHaveAttribute("data-state", "active"),
  );

  await user.click(screen.getByRole("button", {
    name: /settings\.advanced\.cloudSync\.title/,
  }));

  await waitFor(() =>
    expect(
      screen.getByText("settings.webdavSync.title"),
    ).toBeInTheDocument(),
  );
};

const fillWebdavForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.clear(
    screen.getByPlaceholderText("settings.webdavSync.baseUrlPlaceholder"),
  );
  await user.type(
    screen.getByPlaceholderText("settings.webdavSync.baseUrlPlaceholder"),
    "https://dav.example.com/dav/",
  );
  await user.type(
    screen.getByPlaceholderText("settings.webdavSync.usernamePlaceholder"),
    "alice",
  );
  await user.type(
    screen.getByPlaceholderText("settings.webdavSync.passwordPlaceholder"),
    "secret",
  );
  fireEvent.change(screen.getByPlaceholderText("cc-switch-sync"), {
    target: { value: "team-sync" },
  });
  fireEvent.change(screen.getByPlaceholderText("default"), {
    target: { value: "production" },
  });
  await user.click(
    screen.getByRole("switch", { name: "settings.webdavSync.autoSync" }),
  );
  await user.click(screen.getByRole("button", {
    name: "confirm.autoSync.confirm",
  }));
};

describe("SettingsPage with real WebdavSyncSection", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("saves and tests WebDAV settings without leaking the password into generic settings", async () => {
    const user = userEvent.setup();

    await openCloudSyncSection(user);
    await fillWebdavForm(user);

    await user.click(
      screen.getByRole("button", { name: "settings.webdavSync.save" }),
    );

    await waitFor(() =>
      expect(getLastWebdavSaveRequest()).toEqual(
        expect.objectContaining({
          passwordTouched: true,
          settings: expect.objectContaining({
            enabled: true,
            baseUrl: "https://dav.example.com/dav/",
            username: "alice",
            password: "secret",
            remoteRoot: "team-sync",
            profile: "production",
            autoSync: true,
          }),
        }),
      ),
    );

    const testRequests = getWebdavTestRequests();
    expect(testRequests.at(-1)).toEqual(
      expect.objectContaining({
        preserveEmptyPassword: true,
        settings: expect.objectContaining({
          baseUrl: "https://dav.example.com/dav/",
          username: "alice",
          password: "secret",
          remoteRoot: "team-sync",
          profile: "production",
          autoSync: true,
        }),
      }),
    );

    expect(getSettings().webdavSync).toEqual(
      expect.objectContaining({
        baseUrl: "https://dav.example.com/dav/",
        username: "alice",
        password: "",
        remoteRoot: "team-sync",
        profile: "production",
        autoSync: true,
      }),
    );

    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(getLastSettingsSaveRequest()).not.toBeNull());
    expect(getLastSettingsSaveRequest()).not.toHaveProperty("webdavSync");
    expect(getSettings().webdavSync).toEqual(
      expect.objectContaining({
        baseUrl: "https://dav.example.com/dav/",
        password: "",
        profile: "production",
      }),
    );
  });

  it("uploads and downloads from the real settings entry after WebDAV config is saved", async () => {
    const user = userEvent.setup();

    await openCloudSyncSection(user);
    await fillWebdavForm(user);
    await user.click(
      screen.getByRole("button", { name: "settings.webdavSync.save" }),
    );
    await waitFor(() => expect(getLastWebdavSaveRequest()).not.toBeNull());

    await user.click(
      screen.getByRole("button", { name: "settings.webdavSync.upload" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "settings.webdavSync.confirmUpload.confirm",
      }),
    );
    await waitFor(() =>
      expect(getWebdavSyncCounts()).toEqual(
        expect.objectContaining({ upload: 1 }),
      ),
    );

    await user.click(
      screen.getByRole("button", { name: "settings.webdavSync.download" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "settings.webdavSync.confirmDownload.confirm",
      }),
    );
    await waitFor(() =>
      expect(getWebdavSyncCounts()).toEqual(
        expect.objectContaining({ upload: 1, download: 1 }),
      ),
    );
  });
});
