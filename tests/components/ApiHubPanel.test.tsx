import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { ApiHubPanel } from "@/components/settings/ApiHubPanel";
import { server } from "../msw/server";
import { emitTauriEvent } from "../msw/tauriMocks";

const TAURI_ENDPOINT = "http://tauri.local";

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
  });

  it("lists Api-Hub sites and supports selection driven batch actions", async () => {
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
          ],
          total: 1,
          page: 1,
          page_size: 20,
        }),
      ),
      http.post(`${TAURI_ENDPOINT}/api_hub_align_sites`, async ({ request }) => {
        alignCalls.push(await request.json());
        return HttpResponse.json(null);
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_sync_sites`, async ({ request }) => {
        syncCalls.push(await request.json());
        return HttpResponse.json(null);
      }),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    expect(screen.getByText("2 个分组 / 8 个模型")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("选择 Demo Hub"));
    fireEvent.click(screen.getByRole("button", { name: "同步选中" }));

    await waitFor(() => {
      expect(syncCalls).toEqual([{ siteIds: ["site-1"] }]);
    });

    emitTauriEvent("api_hub_sync_progress", {
      site_id: "site-1",
      site_name: "Demo Hub",
      index: 1,
      total: 1,
      step: "sync",
      status: "running",
      error: null,
    });

    expect(await screen.findByRole("button", { name: "同步中" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "对齐选中" }));

    await waitFor(() => {
      expect(alignCalls).toEqual([
        {
          siteIds: ["site-1"],
          options: { rename_existing: true, delete_extra: true },
        },
      ]);
    });

    emitTauriEvent("api_hub_align_progress", {
      site_id: "site-1",
      site_name: "Demo Hub",
      index: 1,
      total: 1,
      step: "align",
      status: "running",
      error: null,
    });

    expect(await screen.findByRole("button", { name: "对齐中" })).toBeDisabled();
  });

  it("filters sites by type and deletes a site record", async () => {
    const listCalls: any[] = [];
    const deleteCalls: any[] = [];
    const cleanupCalls: any[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);

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
      http.post(`${TAURI_ENDPOINT}/api_hub_delete_site`, async ({ request }) => {
        deleteCalls.push(await request.json());
        return HttpResponse.json(null);
      }),
      http.post(`${TAURI_ENDPOINT}/api_hub_cleanup_site_providers`, async ({ request }) => {
        cleanupCalls.push(await request.json());
        return HttpResponse.json({ deleted: 2 });
      }),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    expect(screen.getByText("已导入：Codex")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("站点类型"), {
      target: { value: "sub2api" },
    });

    await waitFor(() => {
      expect(listCalls.some((call) => call.filter.site_type === "sub2api")).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "清理站点" }));

    await waitFor(() => {
      expect(cleanupCalls).toEqual([{ siteId: "site-1" }]);
    });

    fireEvent.click(screen.getByRole("button", { name: "删除记录" }));

    await waitFor(() => {
      expect(deleteCalls).toEqual([{ siteId: "site-1" }]);
    });
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

  it("imports selected apps and models with generated settings configs", async () => {
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
              last_synced_at: null,
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
            last_synced_at: null,
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
      http.post(`${TAURI_ENDPOINT}/api_hub_import_to_apps`, async ({ request }) => {
        importCalls.push(await request.json());
        return HttpResponse.json({
          created: 1,
          updated: 0,
          failed: [],
          auto_aligned_groups: [],
        });
      }),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入应用" }));

    expect(await screen.findByText("导入到应用 - Demo Hub")).toBeInTheDocument();
    expect(await screen.findByText("倍率 1")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("tab", { name: "Codex" }));
    fireEvent.change(screen.getByPlaceholderText("筛选模型或分组，按 ESC 清空"), {
      target: { value: "gpt" },
    });
    expect(screen.getByLabelText("default / gpt-5")).toBeInTheDocument();
    expect(screen.queryByLabelText("default / claude-4")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("筛选模型或分组，按 ESC 清空"), {
      key: "Escape",
    });
    expect(await screen.findByLabelText("default / claude-4")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("筛选模型或分组，按 ESC 清空"), {
      target: { value: "gpt" },
    });
    fireEvent.click(await screen.findByLabelText("default / gpt-5"));
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() => {
      expect(importCalls).toHaveLength(1);
    });

    expect(importCalls[0].req.target_apps).toEqual(["codex"]);
    expect(importCalls[0].req.selections).toEqual([
      { group: "default", model: "gpt-5" },
    ]);
    expect(importCalls[0].req.mark_as_imported).toBe(true);
    expect(
      importCalls[0].req.settings_configs["codex::default::gpt-5"].auth
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
              last_synced_at: null,
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
            last_synced_at: null,
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
      http.post(`${TAURI_ENDPOINT}/api_hub_import_to_apps`, async ({ request }) => {
        importCalls.push(await request.json());
        return HttpResponse.json({
          created: 1,
          updated: 0,
          failed: [],
          auto_aligned_groups: [],
        });
      }),
    );

    renderPanel();

    expect(await screen.findByText("Demo Hub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入应用" }));
    await screen.findByText("导入到应用 - Demo Hub");
    fireEvent.click(await screen.findByRole("tab", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() => {
      expect(importCalls).toHaveLength(1);
    });

    expect(importCalls[0].req.target_apps).toEqual(["codex"]);
    expect(importCalls[0].req.selections).toEqual([
      { group: "default", model: "" },
    ]);
    expect(
      importCalls[0].req.settings_configs["codex::default::"].auth
        .OPENAI_API_KEY,
    ).toBe("__API_HUB_API_KEY__");
  });
});
