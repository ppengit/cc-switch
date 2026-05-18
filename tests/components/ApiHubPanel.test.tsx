import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { ApiHubPanel } from "@/components/settings/ApiHubPanel";
import { server } from "../msw/server";
import { emitTauriEvent } from "../msw/tauriMocks";

const TAURI_ENDPOINT = "http://tauri.local";
const toastSuccessMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: vi.fn(),
  },
}));

const renderPanel = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <ApiHubPanel />
    </QueryClientProvider>,
  );
};

describe("ApiHubPanel", () => {
  beforeEach(() => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    toastSuccessMock.mockReset();
  });

  it("shows row loading only for the site reported by batch progress events", async () => {
    const alignCalls: unknown[] = [];
    const syncCalls: unknown[] = [];
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
            {
              id: "site-2",
              site_name: "Second Hub",
              site_url: "https://second.example.com",
              site_type: "new-api",
              exchange_rate: 1,
              username: "second",
              imported_apps: [],
              last_synced_at: null,
              last_sync_error: null,
              sort_index: 1,
              group_count: 1,
              model_count: 3,
              token_count: 1,
            },
          ],
          total: 2,
          page: 1,
          page_size: 20,
        }),
      ),
      http.post(
        `${TAURI_ENDPOINT}/api_hub_align_sites`,
        async ({ request }) => {
          alignCalls.push(await request.json());
          return HttpResponse.json(null);
        },
      ),
      http.post(`${TAURI_ENDPOINT}/api_hub_sync_sites`, async ({ request }) => {
        syncCalls.push(await request.json());
        return HttpResponse.json(null);
      }),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    expect(await screen.findByText("Second Hub")).toBeInTheDocument();
    expect(screen.getByText("2 个分组 / 8 个模型")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("选择 Demo Hub"));
    fireEvent.click(screen.getByLabelText("选择 Second Hub"));
    fireEvent.click(screen.getByRole("button", { name: "同步选中" }));

    await waitFor(() => {
      expect(syncCalls).toEqual([{ siteIds: ["site-1", "site-2"] }]);
    });

    expect(
      screen.queryByRole("button", { name: "同步中" }),
    ).not.toBeInTheDocument();

    emitTauriEvent("api_hub_sync_progress", {
      site_id: "site-1",
      site_name: "Demo Hub",
      index: 1,
      total: 2,
      step: "sync",
      status: "running",
      error: null,
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "同步中" })).toHaveLength(1);
    });
    expect(screen.getByRole("row", { name: /Demo Hub/ })).toHaveTextContent(
      "同步中",
    );
    expect(screen.getByRole("row", { name: /Second Hub/ })).toHaveTextContent(
      "同步对齐",
    );

    emitTauriEvent("api_hub_sync_progress", {
      site_id: "site-1",
      site_name: "Demo Hub",
      index: 1,
      total: 2,
      step: "sync",
      status: "success",
      error: null,
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "同步中" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "对齐选中" }));

    await waitFor(() => {
      expect(alignCalls).toEqual([
        {
          siteIds: ["site-1", "site-2"],
          options: { rename_existing: true, delete_extra: true },
        },
      ]);
    });

    expect(
      screen.queryByRole("button", { name: "对齐中" }),
    ).not.toBeInTheDocument();

    emitTauriEvent("api_hub_align_progress", {
      site_id: "site-2",
      site_name: "Second Hub",
      index: 2,
      total: 2,
      step: "align",
      status: "running",
      error: null,
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "对齐中" })).toHaveLength(1);
    });
    expect(screen.getByRole("row", { name: /Demo Hub/ })).toHaveTextContent(
      "同步对齐",
    );
    expect(screen.getByRole("row", { name: /Second Hub/ })).toHaveTextContent(
      "对齐中",
    );
  });

  it("filters sites by type and deletes a site record", async () => {
    const listCalls: any[] = [];
    const deleteCalls: any[] = [];
    const cleanupCalls: any[] = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/api_hub_list_sites`, async ({ request }) => {
        listCalls.push(await request.json());
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
      http.post(
        `${TAURI_ENDPOINT}/api_hub_delete_site`,
        async ({ request }) => {
          deleteCalls.push(await request.json());
          return HttpResponse.json(null);
        },
      ),
      http.post(
        `${TAURI_ENDPOINT}/api_hub_cleanup_site_providers`,
        async ({ request }) => {
          cleanupCalls.push(await request.json());
          return HttpResponse.json({ deleted: 2 });
        },
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    expect(screen.getByText("已导入：Codex")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("站点类型"), {
      target: { value: "sub2api" },
    });

    await waitFor(() => {
      expect(
        listCalls.some((call) => call.filter.site_type === "sub2api"),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "清理站点" }));
    const cleanupButton = await screen.findByRole("button", { name: "清理" });
    await waitFor(() => expect(cleanupButton).toBeEnabled());
    fireEvent.click(cleanupButton);

    await waitFor(() => {
      expect(cleanupCalls).toEqual([{ siteId: "site-1" }]);
    });

    fireEvent.click(screen.getByRole("button", { name: "删除记录" }));
    const deleteButton = await screen.findByRole("button", { name: "删除" });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(deleteCalls).toEqual([{ siteId: "site-1" }]);
    });
  });

  it("does not delete a site before delete confirmation", async () => {
    const deleteCalls: any[] = [];
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
              username: null,
              imported_apps: [],
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
        }),
      ),
      http.post(
        `${TAURI_ENDPOINT}/api_hub_delete_site`,
        async ({ request }) => {
          deleteCalls.push(await request.json());
          return HttpResponse.json(null);
        },
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除记录" }));

    expect(
      await screen.findByText("确认删除 Api-Hub 站点记录：Demo Hub？"),
    ).toBeInTheDocument();
    expect(deleteCalls).toEqual([]);
  });

  it("does not clear sites before clear confirmation", async () => {
    const clearCalls: any[] = [];
    server.use(
      http.post(`${TAURI_ENDPOINT}/api_hub_list_sites`, () =>
        HttpResponse.json({ items: [], total: 0, page: 1, page_size: 20 }),
      ),
      http.post(`${TAURI_ENDPOINT}/api_hub_clear_all`, async ({ request }) => {
        clearCalls.push(await request.json().catch(() => null));
        return HttpResponse.json(null);
      }),
    );

    renderPanel();

    await screen.findByText("暂无 Api-Hub 站点，先导入 accounts-backup JSON。");
    fireEvent.click(screen.getByRole("button", { name: "common.clear" }));

    expect(
      await screen.findByText(
        "确认清空 Api-Hub 站点缓存？已导入到 providers 的供应商不会删除。",
      ),
    ).toBeInTheDocument();
    expect(clearCalls).toEqual([]);
  });

  it("does not clean site providers before cleanup confirmation", async () => {
    const cleanupCalls: any[] = [];
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
              username: null,
              imported_apps: ["claude"],
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
        }),
      ),
      http.post(
        `${TAURI_ENDPOINT}/api_hub_cleanup_site_providers`,
        async ({ request }) => {
          cleanupCalls.push(await request.json());
          return HttpResponse.json({ deleted: 2, failed: [] });
        },
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清理站点" }));

    await waitFor(() => {
      expect(
        screen.getByText("确认清理 Demo Hub 已导入到各应用的供应商记录？"),
      ).toBeInTheDocument();
    });
    expect(cleanupCalls).toEqual([]);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("renders millisecond sync timestamps as normal dates", async () => {
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
              username: null,
              imported_apps: [],
              last_synced_at: 1715750061000,
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
        }),
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    expect(screen.getByText(/2024/)).toBeInTheDocument();
    expect(screen.queryByText(/58338/)).not.toBeInTheDocument();
  });

  it("requests sorted site pages from sortable column headers", async () => {
    const listCalls: any[] = [];
    server.use(
      http.post(`${TAURI_ENDPOINT}/api_hub_list_sites`, async ({ request }) => {
        listCalls.push(await request.json());
        return HttpResponse.json({
          items: [
            {
              id: "site-1",
              site_name: "Demo Hub",
              site_url: "https://hub.example.com",
              site_type: "new-api",
              exchange_rate: 1,
              username: null,
              imported_apps: [],
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
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "站点排序" }));

    await waitFor(() => {
      expect(
        listCalls.some(
          (call) =>
            call.filter.sort_by === "site_name" &&
            call.filter.sort_direction === "asc",
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "站点排序" }));

    await waitFor(() => {
      expect(
        listCalls.some(
          (call) =>
            call.filter.sort_by === "site_name" &&
            call.filter.sort_direction === "desc",
        ),
      ).toBe(true);
    });
  });

  it("switches target app tabs without selecting apps", async () => {
    const importCalls: any[] = [];
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
              username: null,
              imported_apps: [],
              last_synced_at: 1715750061,
              last_sync_error: null,
              sort_index: 0,
              group_count: 1,
              model_count: 1,
              token_count: 1,
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
            username: null,
            imported_apps: [],
            last_synced_at: 1715750061,
            last_sync_error: null,
            sort_index: 0,
            group_count: 1,
            model_count: 1,
            token_count: 1,
          },
          groups: [{ name: "default", ratio: 1, description: null }],
          models: [{ name: "gpt-5", enable_groups: ["default"] }],
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
      http.post(
        `${TAURI_ENDPOINT}/api_hub_import_to_apps`,
        async ({ request }) => {
          importCalls.push(await request.json());
          return HttpResponse.json({
            created: 1,
            updated: 0,
            failed: [],
            auto_aligned_groups: [],
          });
        },
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入应用" }));
    expect(
      await screen.findByText("导入到应用 - Demo Hub"),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("default / gpt-5"));
    expect(screen.getByRole("button", { name: "确认导入" })).toBeEnabled();
    expect(screen.getByLabelText("导入到 Codex")).toBeChecked();
    fireEvent.click(screen.getByLabelText("default / gpt-5"));
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
    expect(screen.getByLabelText("导入到 Codex")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Codex 无默认模型供应商导入"));
    expect(screen.getByRole("button", { name: "确认导入" })).toBeEnabled();
    expect(screen.getByLabelText("导入到 Codex")).toBeChecked();
  });

  it("treats masked API keys as missing in the import dialog", async () => {
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
              username: null,
              imported_apps: [],
              last_synced_at: 1715750061,
              last_sync_error: null,
              sort_index: 0,
              group_count: 1,
              model_count: 1,
              token_count: 1,
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
            username: null,
            imported_apps: [],
            last_synced_at: 1715750061,
            last_sync_error: null,
            sort_index: 0,
            group_count: 1,
            model_count: 1,
            token_count: 1,
          },
          groups: [{ name: "default", ratio: 1, description: null }],
          models: [{ name: "gpt-5", enable_groups: ["default"] }],
          tokens: [
            {
              id: 10,
              name: "default",
              group_name: "default",
              key: "sk-abcd********wxyz",
              status: 1,
              remain_quota: null,
              expired_at: -1,
            },
          ],
        }),
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入应用" }));
    expect(
      await screen.findByText("导入到应用 - Demo Hub"),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByLabelText("default / gpt-5"));

    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
    expect(
      screen.getByText(/以下分组缺少同名 APIKey.*default/),
    ).toBeInTheDocument();
  });

  it("keeps model selections isolated by target app and supports no-default-model selection", async () => {
    const importCalls: any[] = [];
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
              username: null,
              imported_apps: [],
              last_synced_at: 1715750061,
              last_sync_error: null,
              sort_index: 0,
              group_count: 1,
              model_count: 1,
              token_count: 1,
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
            username: null,
            imported_apps: [],
            last_synced_at: 1715750061,
            last_sync_error: null,
            sort_index: 0,
            group_count: 1,
            model_count: 1,
            token_count: 1,
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
      http.post(
        `${TAURI_ENDPOINT}/api_hub_import_to_apps`,
        async ({ request }) => {
          importCalls.push(await request.json());
          return HttpResponse.json({
            created: 1,
            updated: 0,
            failed: [],
            auto_aligned_groups: [],
          });
        },
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入应用" }));

    expect(
      await screen.findByText("导入到应用 - Demo Hub"),
    ).toBeInTheDocument();
    expect(await screen.findByText("倍率 1")).toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText("导入到 Claude"));
    fireEvent.click(await screen.findByLabelText("default / gpt-5"));

    fireEvent.click(await screen.findByRole("tab", { name: "Codex" }));
    expect(screen.getByLabelText("default / gpt-5")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("导入到 Codex"));
    fireEvent.change(
      screen.getByPlaceholderText("筛选模型或分组，按 ESC 清空"),
      {
        target: { value: "claude" },
      },
    );
    expect(screen.getByLabelText("default / claude-4")).toBeInTheDocument();
    expect(screen.queryByLabelText("default / gpt-5")).not.toBeInTheDocument();
    fireEvent.keyDown(
      screen.getByPlaceholderText("筛选模型或分组，按 ESC 清空"),
      {
        key: "Escape",
      },
    );
    expect(await screen.findByLabelText("default / gpt-5")).toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText("default / claude-4"));
    fireEvent.click(screen.getByLabelText("Codex 无默认模型供应商导入"));

    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() => {
      expect(importCalls).toHaveLength(1);
    });

    expect(importCalls[0].req.target_apps).toEqual(["claude", "codex"]);
    expect(importCalls[0].req.selections).toEqual([
      { group: "default", model: "gpt-5", app: "claude" },
      { group: "default", model: "", app: "codex" },
      { group: "default", model: "claude-4", app: "codex" },
    ]);
    expect(importCalls[0].req.mark_as_imported).toBe(true);
    expect(
      importCalls[0].req.settings_configs["claude::default::gpt-5"].env
        .ANTHROPIC_AUTH_TOKEN,
    ).toBe("__API_HUB_API_KEY__");
    expect(
      importCalls[0].req.settings_configs["codex::default::claude-4"].auth
        .OPENAI_API_KEY,
    ).toBe("__API_HUB_API_KEY__");
    expect(
      importCalls[0].req.settings_configs["codex::default::"].auth
        .OPENAI_API_KEY,
    ).toBe("__API_HUB_API_KEY__");
  });

  it("imports selected apps without requiring a model selection", async () => {
    const importCalls: any[] = [];
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
              username: null,
              imported_apps: [],
              last_synced_at: 1715750061,
              last_sync_error: null,
              sort_index: 0,
              group_count: 1,
              model_count: 1,
              token_count: 1,
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
            username: null,
            imported_apps: [],
            last_synced_at: 1715750061,
            last_sync_error: null,
            sort_index: 0,
            group_count: 1,
            model_count: 1,
            token_count: 1,
          },
          groups: [{ name: "default", ratio: 1, description: null }],
          models: [{ name: "gpt-5", enable_groups: ["default"] }],
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
      http.post(
        `${TAURI_ENDPOINT}/api_hub_import_to_apps`,
        async ({ request }) => {
          importCalls.push(await request.json());
          return HttpResponse.json({
            created: 1,
            updated: 0,
            failed: [],
            auto_aligned_groups: [],
          });
        },
      ),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入应用" }));
    await screen.findByText("导入到应用 - Demo Hub");
    fireEvent.click(await screen.findByRole("tab", { name: "Codex" }));
    fireEvent.click(screen.getByLabelText("Codex 无默认模型供应商导入"));
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() => {
      expect(importCalls).toHaveLength(1);
    });

    expect(importCalls[0].req.target_apps).toEqual(["codex"]);
    expect(importCalls[0].req.selections).toEqual([
      { group: "default", model: "", app: "codex" },
    ]);
    expect(
      importCalls[0].req.settings_configs["codex::default::"].auth
        .OPENAI_API_KEY,
    ).toBe("__API_HUB_API_KEY__");
  });

  it("creates one no-default-model import per selected app, not per group", async () => {
    server.use(
      http.post(`${TAURI_ENDPOINT}/api_hub_list_sites`, () =>
        HttpResponse.json({
          items: [
            {
              id: "site-1",
              site_name: "Eu",
              site_url: "https://eu.example.com",
              site_type: "new-api",
              exchange_rate: 1,
              username: null,
              imported_apps: [],
              last_synced_at: 1715750061,
              last_sync_error: null,
              sort_index: 0,
              group_count: 2,
              model_count: 2,
              token_count: 2,
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
            site_name: "Eu",
            site_url: "https://eu.example.com",
            site_type: "new-api",
            exchange_rate: 1,
            username: null,
            imported_apps: [],
            last_synced_at: 1715750061,
            last_sync_error: null,
            sort_index: 0,
            group_count: 2,
            model_count: 2,
            token_count: 2,
          },
          groups: [
            { name: "claude", ratio: 1, description: null },
            { name: "gpt", ratio: 1, description: null },
          ],
          models: [
            { name: "claude-sonnet", enable_groups: ["claude"] },
            { name: "gpt-5", enable_groups: ["gpt"] },
          ],
          tokens: [
            {
              id: 10,
              name: "claude",
              group_name: "claude",
              key: "sk-claude",
              status: 1,
              remain_quota: null,
              expired_at: -1,
            },
            {
              id: 11,
              name: "gpt",
              group_name: "gpt",
              key: "sk-gpt",
              status: 1,
              remain_quota: null,
              expired_at: -1,
            },
          ],
        }),
      ),
    );

    renderPanel();

    expect(await screen.findByText("Eu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入应用" }));
    await screen.findByText("导入到应用 - Eu");

    fireEvent.click(
      await screen.findByLabelText("Claude 无默认模型供应商导入"),
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Codex" }));
    fireEvent.click(
      await screen.findByLabelText("Codex 无默认模型供应商导入"),
    );

    expect(screen.getByText("Eu · 不写默认模型 → claude")).toBeInTheDocument();
    expect(screen.getByText("Eu · 不写默认模型 → codex")).toBeInTheDocument();
    expect(
      screen.queryByText("Eu · claude · 不写默认模型 → claude"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Eu · gpt · 不写默认模型 → codex"),
    ).not.toBeInTheDocument();
  });
});
