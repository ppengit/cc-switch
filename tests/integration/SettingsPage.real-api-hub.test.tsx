import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Provider } from "@/types";
import { server } from "../msw/server";
import { emitTauriEvent } from "../msw/tauriMocks";
import {
  getProviders,
  getSwitchLiveSettings,
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

type ApiHubListRequest = {
  filter?: {
    site_type?: string;
    search?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ApiHubImportRequest = {
  req: {
    site_id: string;
    target_apps: string[];
    auto_align_if_missing: boolean;
    mark_as_imported: boolean;
    selections: Array<{
      group: string;
      model: string;
      app: string;
    }>;
    settings_configs?: Record<string, Record<string, unknown>>;
  };
  [key: string]: unknown;
};

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

const seedClaudeTakeoverFailover = () => {
  setProviders("claude", {
    "claude-alpha": claudeProvider("claude-alpha", "Claude Alpha", 0),
    "claude-beta": claudeProvider("claude-beta", "Claude Beta", 1),
  });
  setCurrentProviderId("claude", "claude-alpha");
  setSettings({
    enableLocalProxy: true,
    proxyConfirmed: true,
    enableFailoverToggle: true,
    failoverConfirmed: true,
  });
  startProxyServerState();
  setProxyTakeoverForAppState("claude", true);
  setAutoFailoverEnabledState("claude", true);
};

const expectClaudeLiveOnProxy = () => {
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
  expect(live.env?.ANTHROPIC_BASE_URL).not.toBe("https://hub.example.com");
};

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
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

describe("SettingsPage with real Api-Hub panel", () => {
  beforeEach(() => {
    resetProviderState();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("filters, cleans up, and deletes Api-Hub sites through the real settings tab entry", async () => {
    const user = userEvent.setup();
    const listCalls: ApiHubListRequest[] = [];
    const cleanupCalls: Array<Record<string, unknown>> = [];
    const deleteCalls: Array<Record<string, unknown>> = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/api_hub_list_sites`, async ({ request }) => {
        const body = (await request.json()) as ApiHubListRequest;
        listCalls.push(body);
        return HttpResponse.json({
          items: [
            {
              id: "site-1",
              site_name: "Demo Hub",
              site_url: "https://hub.example.com",
              site_type: "sub2api",
              exchange_rate: 1,
              username: null,
              imported_apps: ["codex"],
              last_synced_at: null,
              last_sync_error: null,
              sort_index: 0,
              group_count: 1,
              model_count: 2,
              token_count: 1,
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        });
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_cleanup_site_providers`, async ({ request }) => {
        cleanupCalls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ deleted: 2, failed: [] });
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_delete_site`, async ({ request }) => {
        deleteCalls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(null);
      }),
    );

    renderSettingsPage({ defaultTab: "apiHub" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument(),
    );
    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    expect(screen.getByText("已导入：Codex")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("站点类型"), {
      target: { value: "sub2api" },
    });
    await waitFor(() =>
      expect(
        listCalls.some((call) => call.filter?.site_type === "sub2api"),
      ).toBe(true),
    );

    fireEvent.change(screen.getByPlaceholderText("搜索站点名称或 URL"), {
      target: { value: "Demo" },
    });
    await waitFor(() =>
      expect(
        listCalls.some((call) => call.filter?.search === "Demo"),
      ).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "清理站点" }));
    await waitFor(() =>
      expect(
        screen.getByText("确认清理 Demo Hub 已导入到各应用的供应商记录？"),
      ).toBeInTheDocument(),
    );
    expect(cleanupCalls).toEqual([]);

    const cleanupConfirmButton = screen.getByRole("button", { name: "清理" });
    await waitFor(() => expect(cleanupConfirmButton).toBeEnabled());
    await user.click(cleanupConfirmButton);
    await waitFor(() =>
      expect(cleanupCalls).toEqual([{ siteId: "site-1" }]),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("已清理 2 个供应商");

    await user.click(screen.getByRole("button", { name: "删除记录" }));
    await waitFor(() =>
      expect(
        screen.getByText("确认删除 Api-Hub 站点记录：Demo Hub？"),
      ).toBeInTheDocument(),
    );
    expect(deleteCalls).toEqual([]);

    const deleteConfirmButton = screen.getByRole("button", { name: "删除" });
    await waitFor(() => expect(deleteConfirmButton).toBeEnabled());
    await user.click(deleteConfirmButton);
    await waitFor(() =>
      expect(deleteCalls).toEqual([{ siteId: "site-1" }]),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("站点记录已删除");
  });

  it("imports selected models into Codex and runs batch sync and align through the real settings tab entry", async () => {
    const user = userEvent.setup();
    const syncCalls: Array<Record<string, unknown>> = [];
    const alignCalls: Array<Record<string, unknown>> = [];
    const importCalls: ApiHubImportRequest[] = [];

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
              last_synced_at: 1715750061,
              last_sync_error: null,
              sort_index: 0,
              group_count: 1,
              model_count: 2,
              token_count: 1,
              aligned_group_count: 1,
              is_aligned: true,
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        }),
      ),
      http.post(`${TAURI_ENDPOINT}/api_hub_get_site_detail`, () =>
        HttpResponse.json({
          site: {
            id: "site-1",
            site_name: "Demo Hub",
            site_url: "https://hub.example.com",
            site_type: "new-api",
            exchange_rate: 1,
            username: "demo",
            imported_apps: [],
            last_synced_at: 1715750061,
            last_sync_error: null,
            sort_index: 0,
            group_count: 1,
            model_count: 2,
            token_count: 1,
            aligned_group_count: 1,
            is_aligned: true,
          },
          groups: [{ name: "default", ratio: 1, description: null }],
          models: [
            { name: "gpt-5", enable_groups: ["default"] },
            { name: "claude-4", enable_groups: ["default"] },
          ],
          tokens: [
            {
              id: 10,
              name: "default",
              group_name: "default",
              key: "sk-hidden",
              status: 1,
              remain_quota: null,
              expired_at: -1,
            },
          ],
        }),
      ),
      http.post(`${TAURI_ENDPOINT}/api_hub_import_to_apps`, async ({ request }) => {
        importCalls.push((await request.json()) as ApiHubImportRequest);
        return HttpResponse.json({
          created: 1,
          updated: 0,
          failed: [],
          auto_aligned_groups: [],
        });
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_sync_sites`, async ({ request }) => {
        syncCalls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(null);
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_align_sites`, async ({ request }) => {
        alignCalls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(null);
      }),
    );

    renderSettingsPage({ defaultTab: "apiHub" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument(),
    );
    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();

    await user.click(screen.getByLabelText("选择 Demo Hub"));
    await user.click(screen.getByRole("button", { name: "同步选中" }));
    await waitFor(() =>
      expect(syncCalls).toEqual([{ siteIds: ["site-1"] }]),
    );

    act(() => {
      emitTauriEvent("api_hub_sync_progress", {
        site_id: "site-1",
        site_name: "Demo Hub",
        index: 1,
        total: 1,
        step: "sync",
        status: "running",
        error: null,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "同步中" })).toBeInTheDocument(),
    );
    act(() => {
      emitTauriEvent("api_hub_sync_progress", {
        site_id: "site-1",
        site_name: "Demo Hub",
        index: 1,
        total: 1,
        step: "sync",
        status: "success",
        error: null,
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "同步中" })).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "对齐选中" }));
    await waitFor(() =>
      expect(alignCalls).toEqual([
        {
          siteIds: ["site-1"],
          options: { rename_existing: true, delete_extra: true },
        },
      ]),
    );

    act(() => {
      emitTauriEvent("api_hub_align_progress", {
        site_id: "site-1",
        site_name: "Demo Hub",
        index: 1,
        total: 1,
        step: "align",
        status: "running",
        error: null,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "对齐中" })).toBeInTheDocument(),
    );
    act(() => {
      emitTauriEvent("api_hub_align_progress", {
        site_id: "site-1",
        site_name: "Demo Hub",
        index: 1,
        total: 1,
        step: "align",
        status: "success",
        error: null,
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "对齐中" })).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "导入应用" }));
    await waitFor(() =>
      expect(screen.getByText("导入到应用 - Demo Hub")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("tab", { name: "Codex" }));
    await user.click(screen.getByLabelText("default / claude-4"));
    await user.click(screen.getByLabelText("Codex 无默认模型供应商导入"));
    await user.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() => expect(importCalls).toHaveLength(1));
    expect(importCalls[0].req).toMatchObject({
      site_id: "site-1",
      target_apps: ["codex"],
      auto_align_if_missing: true,
      mark_as_imported: true,
    });
    expect(importCalls[0].req.selections).toEqual([
      { group: "default", model: "", app: "codex" },
      { group: "default", model: "claude-4", app: "codex" },
    ]);
  });

  it("keeps Claude takeover live config on the proxy endpoint while syncing, aligning, and importing Api-Hub providers", async () => {
    const user = userEvent.setup();
    const syncCalls: Array<Record<string, unknown>> = [];
    const alignCalls: Array<Record<string, unknown>> = [];
    const importCalls: ApiHubImportRequest[] = [];

    seedClaudeTakeoverFailover();
    setSwitchLiveSettings(
      "claude",
      getProviders("claude")["claude-beta"].settingsConfig,
    );
    expect(
      (getSwitchLiveSettings("claude") as { env?: Record<string, string> }).env
        ?.ANTHROPIC_BASE_URL,
    ).toBe("https://claude-beta.example.com");

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
              last_synced_at: 1715750061,
              last_sync_error: null,
              sort_index: 0,
              group_count: 1,
              model_count: 1,
              token_count: 1,
              aligned_group_count: 1,
              is_aligned: true,
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        }),
      ),
      http.post(`${TAURI_ENDPOINT}/api_hub_get_site_detail`, () =>
        HttpResponse.json({
          site: {
            id: "site-1",
            site_name: "Demo Hub",
            site_url: "https://hub.example.com",
            site_type: "new-api",
            exchange_rate: 1,
            username: "demo",
            imported_apps: [],
            last_synced_at: 1715750061,
            last_sync_error: null,
            sort_index: 0,
            group_count: 1,
            model_count: 1,
            token_count: 1,
            aligned_group_count: 1,
            is_aligned: true,
          },
          groups: [{ name: "default", ratio: 1, description: null }],
          models: [{ name: "claude-4", enable_groups: ["default"] }],
          tokens: [
            {
              id: 10,
              name: "default",
              group_name: "default",
              key: "sk-hidden",
              status: 1,
              remain_quota: null,
              expired_at: -1,
            },
          ],
        }),
      ),
      http.post(`${TAURI_ENDPOINT}/api_hub_sync_sites`, async ({ request }) => {
        syncCalls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(syncCurrentProvidersLiveState());
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_align_sites`, async ({ request }) => {
        alignCalls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(syncCurrentProvidersLiveState());
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_import_to_apps`, async ({ request }) => {
        importCalls.push((await request.json()) as ApiHubImportRequest);
        syncCurrentProvidersLiveState();
        return HttpResponse.json({
          created: 1,
          updated: 0,
          failed: [],
          auto_aligned_groups: [],
        });
      }),
    );

    renderSettingsPage({ defaultTab: "apiHub" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导入 JSON" })).toBeInTheDocument(),
    );
    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();

    await user.click(screen.getByLabelText("选择 Demo Hub"));
    await user.click(screen.getByRole("button", { name: "同步选中" }));
    await waitFor(() =>
      expect(syncCalls).toEqual([{ siteIds: ["site-1"] }]),
    );
    expectClaudeLiveOnProxy();

    await user.click(screen.getByRole("button", { name: "对齐选中" }));
    await waitFor(() =>
      expect(alignCalls).toEqual([
        {
          siteIds: ["site-1"],
          options: { rename_existing: true, delete_extra: true },
        },
      ]),
    );
    expectClaudeLiveOnProxy();

    await user.click(screen.getByRole("button", { name: "导入应用" }));
    await waitFor(() =>
      expect(screen.getByText("导入到应用 - Demo Hub")).toBeInTheDocument(),
    );

    await user.click(screen.getByLabelText("导入到 Claude"));
    await user.click(screen.getByLabelText("default / claude-4"));
    await user.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() => expect(importCalls).toHaveLength(1));
    expect(importCalls[0].req).toMatchObject({
      site_id: "site-1",
      target_apps: ["claude"],
      auto_align_if_missing: true,
      mark_as_imported: true,
    });
    expect(importCalls[0].req.selections).toEqual([
      { group: "default", model: "claude-4", app: "claude" },
    ]);
    expect(importCalls[0].req.settings_configs).toMatchObject({
      "claude::default::claude-4": {
        env: {
          ANTHROPIC_BASE_URL: "https://hub.example.com",
          ANTHROPIC_AUTH_TOKEN: "__API_HUB_API_KEY__",
          ANTHROPIC_MODEL: "claude-4",
        },
      },
    });
    expectClaudeLiveOnProxy();
  }, 20_000);
});
