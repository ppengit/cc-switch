import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { resetProviderState } from "../msw/state";

const TAURI_ENDPOINT = "http://tauri.local";

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

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({ appId }: any) => (
    <section data-testid="provider-list" data-app-id={appId} />
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: ({ open, appId }: any) =>
    open ? <div data-testid="add-provider-dialog">{appId}</div> : null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: ({ open }: any) =>
    open ? <div data-testid="edit-provider-dialog" /> : null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: ({ isOpen }: any) =>
    isOpen ? <div data-testid="usage-script-modal" /> : null,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: forwardRef(({ appId }: any, _ref) => (
    <section data-testid="prompts-panel">{appId}</section>
  )),
}));

vi.mock("@/components/skills/UnifiedSkillsPanel", () => ({
  default: forwardRef(({ currentApp }: any, _ref) => (
    <section data-testid="skills-panel">{currentApp}</section>
  )),
}));

vi.mock("@/components/skills/SkillsPage", () => ({
  SkillsPage: forwardRef(({ initialApp }: any, _ref) => (
    <section data-testid="skills-discovery">{initialApp}</section>
  )),
}));

vi.mock("@/components/mcp/UnifiedMcpPanel", () => ({
  default: forwardRef(() => <section data-testid="mcp-panel" />),
}));

vi.mock("@/components/sessions/SessionManagerPage", () => ({
  SessionManagerPage: ({ appId }: any) => (
    <section data-testid="sessions-panel">{appId}</section>
  ),
}));

vi.mock("@/components/workspace/WorkspaceFilesPanel", () => ({
  default: () => <section data-testid="workspace-panel" />,
}));

vi.mock("@/components/openclaw/EnvPanel", () => ({
  default: () => <section data-testid="openclaw-env-panel" />,
}));

vi.mock("@/components/openclaw/ToolsPanel", () => ({
  default: () => <section data-testid="openclaw-tools-panel" />,
}));

vi.mock("@/components/openclaw/AgentsDefaultsPanel", () => ({
  default: () => <section data-testid="openclaw-agents-panel" />,
}));

vi.mock("@/components/openclaw/OpenClawHealthBanner", () => ({
  default: () => <section data-testid="openclaw-health-banner" />,
}));

vi.mock("@/components/hermes/HermesMemoryPanel", () => ({
  default: () => <section data-testid="hermes-memory-panel" />,
}));

vi.mock("@/components/DeepLinkImportDialog", () => ({
  DeepLinkImportDialog: () => null,
}));

vi.mock("@/components/FirstRunNoticeDialog", () => ({
  FirstRunNoticeDialog: () => null,
}));

vi.mock("@/components/usage/RequestDetailPanel", () => ({
  RequestDetailPanel: () => <section data-testid="request-detail-panel" />,
}));

vi.mock("@/components/settings/LanguageSettings", () => ({
  LanguageSettings: () => <section>language-settings</section>,
}));

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <section>theme-settings</section>,
}));

vi.mock("@/components/settings/AppVisibilitySettings", () => ({
  AppVisibilitySettings: () => <section>app-visibility-settings</section>,
}));

vi.mock("@/components/settings/WindowSettings", () => ({
  WindowSettings: () => <section>window-settings</section>,
}));

vi.mock("@/components/settings/SkillStorageLocationSettings", () => ({
  SkillStorageLocationSettings: () => (
    <section>skill-storage-location-settings</section>
  ),
}));

vi.mock("@/components/settings/SkillSyncMethodSettings", () => ({
  SkillSyncMethodSettings: () => <section>skill-sync-method-settings</section>,
}));

vi.mock("@/components/settings/TerminalSettings", () => ({
  TerminalSettings: () => <section>terminal-settings</section>,
}));

vi.mock("@/components/settings/DirectorySettings", () => ({
  DirectorySettings: () => <section>directory-settings</section>,
}));

vi.mock("@/components/settings/ImportExportSection", () => ({
  ImportExportSection: () => <section>import-export-section</section>,
}));

vi.mock("@/components/settings/BackupListSection", () => ({
  BackupListSection: () => <section>backup-list-section</section>,
}));

vi.mock("@/components/settings/WebdavSyncSection", () => ({
  WebdavSyncSection: () => <section>webdav-sync-section</section>,
}));

vi.mock("@/components/settings/ProxyTabContent", () => ({
  ProxyTabContent: () => <section>proxy-tab-content</section>,
}));

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <section>auth-center-panel</section>,
}));

vi.mock("@/components/usage/ModelTestConfigPanel", () => ({
  ModelTestConfigPanel: () => <section>model-test-config-panel</section>,
}));

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: () => <section>usage-dashboard</section>,
}));

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => <section>about-section</section>,
}));

const renderApp = (AppComponent: ComponentType) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );
};

const expectTextNotVisible = (text: string) => {
  for (const element of screen.queryAllByText(text)) {
    expect(element).not.toBeVisible();
  }
};

describe("App settings entry with real Api-Hub tab", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    server.use(
      http.post(`${TAURI_ENDPOINT}/api_hub_list_sites`, () =>
        HttpResponse.json({
          items: [
            {
              id: "site-1",
              site_name: "Demo Hub",
              site_url: "https://hub.example.com",
              site_type: "sub2api",
              exchange_rate: 1,
              username: "demo",
              imported_apps: ["codex"],
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

  it(
    "opens Api-Hub from the real settings button without leaking content across settings tabs",
    async () => {
      const user = userEvent.setup();
      const { default: App } = await import("@/App");

      renderApp(App);

      await waitFor(() =>
        expect(screen.getByTestId("provider-list")).toHaveAttribute(
          "data-app-id",
          "claude",
        ),
      );

      await user.click(screen.getByTitle("common.settings"));
      await waitFor(() =>
        expect(screen.getByText("language-settings")).toBeInTheDocument(),
      );
      expect(
        screen.queryByRole("button", { name: "导入 JSON" }),
      ).not.toBeInTheDocument();
      expectTextNotVisible("Demo Hub");

      await user.click(screen.getByRole("tab", { name: "Api-Hub" }));

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "导入 JSON" }),
        ).toBeInTheDocument(),
      );
      await waitFor(() => expect(screen.getByText("Demo Hub")).toBeVisible());

      const searchInput = screen.getByPlaceholderText(
        "搜索站点名称或 URL",
      ) as HTMLInputElement;
      fireEvent.change(searchInput, { target: { value: "demo filter" } });
      fireEvent.change(screen.getByLabelText("站点类型"), {
        target: { value: "sub2api" },
      });

      await user.click(
        screen.getByRole("tab", { name: "settings.tabGeneral" }),
      );
      expect(screen.getByText("language-settings")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "导入 JSON" }),
      ).not.toBeInTheDocument();
      expectTextNotVisible("Demo Hub");

      await user.click(screen.getByRole("tab", { name: "usage.title" }));
      expect(screen.getByText("usage-dashboard")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "导入 JSON" }),
      ).not.toBeInTheDocument();
      expectTextNotVisible("Demo Hub");

      await user.click(screen.getByRole("tab", { name: "common.about" }));
      expect(screen.getByText("about-section")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "导入 JSON" }),
      ).not.toBeInTheDocument();
      expectTextNotVisible("Demo Hub");

      await user.click(screen.getByRole("tab", { name: "Api-Hub" }));

      expect(screen.getByPlaceholderText("搜索站点名称或 URL")).toHaveValue(
        "demo filter",
      );
      expect(screen.getByLabelText("站点类型")).toHaveValue("sub2api");
      await waitFor(() => expect(screen.getByText("Demo Hub")).toBeVisible());
    },
    15_000,
  );
});
