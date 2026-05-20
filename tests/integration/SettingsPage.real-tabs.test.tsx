import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { server } from "../msw/server";
import { resetProviderState } from "../msw/state";

const TAURI_ENDPOINT = "http://tauri.local";
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

const getPanelForTab = (container: HTMLElement, tabName: string) => {
  const tab = screen.getByRole("tab", { name: tabName });
  const panel = Array.from(
    container.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
  ).find((element) => element.getAttribute("aria-labelledby") === tab.id);
  expect(panel).toBeDefined();
  return panel as HTMLElement;
};

describe("SettingsPage real tab structure", () => {
  beforeEach(() => {
    translationMocks.i18n.changeLanguage.mockReset();
    resetProviderState();
    window.sessionStorage.clear();
    server.use(
      http.post(`${TAURI_ENDPOINT}/api_hub_list_sites`, () =>
        HttpResponse.json({
          items: [
            {
              id: "site-1",
              site_name: "Demo Hub",
              site_url: "https://hub.example.com",
              site_type: "new-api",
              exchange_rate: 1,
              username: "demo",
              imported_apps: [],
              last_synced_at: null,
              last_sync_error: null,
              sort_index: 0,
              group_count: 2,
              model_count: 8,
              token_count: 1,
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        }),
      ),
    );
  });

  it("keeps Api-Hub content inaccessible on other tabs while preserving panel state", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByText("language-settings")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "导入 JSON" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Api-Hub" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("Demo Hub")).toBeInTheDocument(),
    );

    const searchInput = screen.getByPlaceholderText(
      "搜索站点名称或 URL",
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "demo filter" } });
    fireEvent.change(screen.getByLabelText("站点类型"), {
      target: { value: "sub2api" },
    });

    await user.click(screen.getByRole("tab", { name: "settings.tabGeneral" }));

    expect(screen.getByText("language-settings")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "导入 JSON" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Api-Hub" }));

    expect(screen.getByPlaceholderText("搜索站点名称或 URL")).toHaveValue(
      "demo filter",
    );
    expect(screen.getByLabelText("站点类型")).toHaveValue("sub2api");
  });

  it("honors defaultTab with the real tabs implementation and keeps Api-Hub between usage and about", async () => {
    renderSettingsPage({ defaultTab: "apiHub" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument(),
    );

    const tabLabels = screen
      .getAllByRole("tab")
      .map((element) => element.textContent?.trim() ?? "");

    expect(tabLabels.indexOf("usage.title")).toBeLessThan(
      tabLabels.indexOf("Api-Hub"),
    );
    expect(tabLabels.indexOf("Api-Hub")).toBeLessThan(
      tabLabels.indexOf("common.about"),
    );

    expect(screen.queryByText("language-settings")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Demo Hub")).toBeInTheDocument(),
    );
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

  it("keeps the force-mounted Api-Hub panel visually hidden outside the Api-Hub tab", async () => {
    const user = userEvent.setup();
    const { container } = renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByText("language-settings")).toBeInTheDocument(),
    );

    const apiHubPanel = getPanelForTab(container, "Api-Hub");
    expect(apiHubPanel).toHaveAttribute("data-state", "inactive");
    expect(apiHubPanel).toHaveAttribute("hidden");
    expect(apiHubPanel).toHaveAttribute("aria-hidden", "true");
    expect(apiHubPanel).toHaveClass("data-[state=inactive]:hidden");
    expect(
      screen.queryByRole("button", { name: "导入 JSON" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Api-Hub" }));

    await waitFor(() =>
      expect(apiHubPanel).toHaveAttribute("data-state", "active"),
    );
    expect(apiHubPanel).not.toHaveAttribute("hidden");
    expect(apiHubPanel).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "settings.tabAdvanced" }));

    await waitFor(() =>
      expect(apiHubPanel).toHaveAttribute("data-state", "inactive"),
    );
    expect(apiHubPanel).toHaveAttribute("hidden");
    expect(apiHubPanel).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.queryByRole("button", { name: "导入 JSON" }),
    ).not.toBeInTheDocument();
  });
});
