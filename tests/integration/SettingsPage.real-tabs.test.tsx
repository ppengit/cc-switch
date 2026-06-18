import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { resetProviderState } from "../msw/state";

const translationMocks = vi.hoisted(() => ({
  changeLanguage: vi.fn(),
  i18n: {
    language: "zh",
    changeLanguage: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    i18n: translationMocks.i18n,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
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

vi.mock("@/components/settings/LogConfigPanel", () => ({
  LogConfigPanel: () => <div>log-config-panel</div>,
}));

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <div>auth-center-panel</div>,
}));

const renderSettingsPage = (
  props?: Partial<React.ComponentProps<typeof SettingsPage>>,
) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <SettingsPage open onOpenChange={() => {}} {...props} />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("SettingsPage real tab structure", () => {
  beforeEach(() => {
    translationMocks.i18n.changeLanguage.mockReset();
    resetProviderState();
    window.sessionStorage.clear();
  });

  it("does not expose removed aggregation-import tabs or actions", async () => {
    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByText("language-settings")).toBeInTheDocument(),
    );

    const tabLabels = screen
      .getAllByRole("tab")
      .map((element) => element.textContent?.trim() ?? "");
    expect(tabLabels).toEqual([
      "settings.tabGeneral",
      "settings.tabProxy",
      "认证",
      "settings.tabAdvanced",
      "usage.title",
      "common.about",
    ]);
    expect(screen.queryByRole("button", { name: "导入 JSON" })).not.toBeInTheDocument();
  });

  it("honors defaultTab with the real tabs implementation and keeps usage before about", async () => {
    renderSettingsPage({ defaultTab: "usage" });

    await waitFor(() =>
      expect(screen.getByText("usage-dashboard")).toBeInTheDocument(),
    );

    const tabLabels = screen
      .getAllByRole("tab")
      .map((element) => element.textContent?.trim() ?? "");

    expect(tabLabels.indexOf("usage.title")).toBeLessThan(
      tabLabels.indexOf("common.about"),
    );

    expect(screen.queryByText("language-settings")).not.toBeInTheDocument();
    expect(screen.getByText("usage-dashboard")).toBeInTheDocument();
  });

  it("keeps the settings tab bar in a single scrollable row for narrow windows", async () => {
    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByText("language-settings")).toBeInTheDocument(),
    );

    const tabList = screen.getByRole("tablist");
    expect(tabList).toHaveClass("overflow-x-auto");
    expect(tabList).toHaveClass("justify-start");
    expect(tabList).not.toHaveClass("grid-cols-7");

    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveClass("shrink-0");
    }
  });

  it("renders exactly the current settings tabs", async () => {
    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByText("language-settings")).toBeInTheDocument(),
    );

    expect(
      screen.getAllByRole("tab").map((element) => element.textContent?.trim() ?? ""),
    ).toEqual([
      "settings.tabGeneral",
      "settings.tabProxy",
      "认证",
      "settings.tabAdvanced",
      "usage.title",
      "common.about",
    ]);
  });
});
