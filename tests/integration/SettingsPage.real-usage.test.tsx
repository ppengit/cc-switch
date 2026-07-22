import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { ProxyRawLogEntry } from "@/types/proxy";
import {
  resetProviderState,
  setRequestDetailState,
  setRequestLogsState,
  setUsageSummaryByAppState,
  setUsageTrendsState,
  setProviderStatsState,
  setModelStatsState,
} from "../msw/state";
import { server } from "../msw/server";

const TAURI_ENDPOINT = "http://tauri.local";

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

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => <div>about-section</div>,
}));

vi.mock("@/components/settings/ProxyTabContent", () => ({
  ProxyTabContent: () => <div>proxy-tab-content</div>,
}));

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <div>auth-center-panel</div>,
}));

const renderSettingsPage = (options?: {
  onOpenRequestDetail?: (request: import("@/types/usage").RequestLog) => void;
}) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <SettingsPage
          open
          onOpenChange={() => {}}
          defaultTab="usage"
          onOpenRequestDetail={options?.onOpenRequestDetail}
        />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("SettingsPage usage tab with real UsageDashboard", () => {
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    consoleWarnSpy.mockClear();
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    setUsageSummaryByAppState([
      {
        appType: "claude",
        summary: {
          totalRequests: 12,
          totalCost: "1.234500",
          totalInputTokens: 2000,
          totalOutputTokens: 800,
          totalCacheCreationTokens: 200,
          totalCacheReadTokens: 400,
          successRate: 91.7,
          realTotalTokens: 3400,
          cacheHitRate: 0.1538,
        },
      },
      {
        appType: "codex",
        summary: {
          totalRequests: 4,
          totalCost: "0.400000",
          totalInputTokens: 900,
          totalOutputTokens: 300,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 100,
          successRate: 100,
          realTotalTokens: 1300,
          cacheHitRate: 0.1,
        },
      },
    ]);
    setUsageTrendsState([
      {
        date: "2026-05-19T08:00:00Z",
        requestCount: 3,
        totalCost: "0.150000",
        totalTokens: 1200,
        totalInputTokens: 600,
        totalOutputTokens: 400,
        totalCacheCreationTokens: 50,
        totalCacheReadTokens: 150,
      },
    ]);
    setProviderStatsState([
      {
        providerId: "claude-alpha",
        providerName: "Claude Alpha",
        requestCount: 9,
        totalTokens: 2400,
        totalCost: "0.800000",
        successRate: 88.9,
        avgLatencyMs: 1250,
      },
    ]);
    setModelStatsState([
      {
        model: "claude-haiku-4-5-20251001",
        requestCount: 6,
        totalTokens: 1900,
        totalCost: "0.500000",
        avgCostPerRequest: "0.083333",
      },
    ]);
    setRequestLogsState([
      {
        requestId: "req-1",
        providerId: "claude-alpha",
        providerName: "Claude Alpha",
        appType: "claude",
        model: "claude-haiku-4-5-20251001",
        requestModel: "claude-3.7-thinking",
        costMultiplier: "1",
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
        inputCostUsd: "0.120000",
        outputCostUsd: "0.090000",
        cacheReadCostUsd: "0.010000",
        cacheCreationCostUsd: "0.020000",
        totalCostUsd: "0.240000",
        isStreaming: true,
        latencyMs: 1850,
        firstTokenMs: 420,
        durationMs: 2200,
        statusCode: 200,
        sessionId: "session-1",
        sessionTitle: "Claude Session One",
        projectPath: "/workspace/claude-one",
        providerType: "custom",
        createdAt: 1_747_645_600,
        dataSource: "proxy",
      },
    ]);
    setRequestDetailState("req-1", {
      requestId: "req-1",
      providerId: "claude-alpha",
      providerName: "Claude Alpha",
      appType: "claude",
      model: "claude-haiku-4-5-20251001",
      requestModel: "claude-3.7-thinking",
      costMultiplier: "1",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      inputCostUsd: "0.120000",
      outputCostUsd: "0.090000",
      cacheReadCostUsd: "0.010000",
      cacheCreationCostUsd: "0.020000",
      totalCostUsd: "0.240000",
      isStreaming: true,
      latencyMs: 1850,
      firstTokenMs: 420,
      durationMs: 2200,
      statusCode: 200,
      sessionId: "session-1",
      sessionTitle: "Claude Session One",
      projectPath: "/workspace/claude-one",
      providerType: "custom",
      createdAt: 1_747_645_600,
      dataSource: "proxy",
    });
  });

  afterAll(() => {
    consoleWarnSpy.mockRestore();
  });

  const createRawProxyLogEntry = (id: number): ProxyRawLogEntry => ({
    id,
    timestamp: `2026-05-19T08:${String(id % 60).padStart(2, "0")}:00Z`,
    startedAt: `2026-05-19T08:${String(id % 60).padStart(2, "0")}:00Z`,
    updatedAt: `2026-05-19T08:${String(id % 60).padStart(2, "0")}:10Z`,
    requestId: `req-${id}`,
    event: "finished",
    appType: "codex",
    providerName: `Proxy Provider ${id}`,
    providerId: `proxy-provider-${id}`,
    requestModel: `request-model-${id}`,
    upstreamModel: `upstream-model-${id}`,
    routeMode: id % 2 === 0 ? "failover" : "direct",
    upstreamUrl: `https://proxy-${id}.example.com/v1/chat/completions`,
    statusCode: 200,
    error: null,
    activeRequestCount: 1,
    activeTargetCount: 1,
    events: [
      {
        id: id * 10 + 1,
        timestamp: `2026-05-19T08:${String(id % 60).padStart(2, "0")}:00Z`,
        event: "received",
        appType: "codex",
        providerName: `Proxy Provider ${id}`,
        providerId: `proxy-provider-${id}`,
        requestModel: `request-model-${id}`,
        upstreamModel: null,
        routeMode: null,
        upstreamUrl: null,
        statusCode: null,
        error: null,
        activeRequestCount: 1,
        activeTargetCount: 1,
      },
      {
        id: id * 10 + 2,
        timestamp: `2026-05-19T08:${String(id % 60).padStart(2, "0")}:05Z`,
        event: "routed",
        appType: "codex",
        providerName: `Proxy Provider ${id}`,
        providerId: `proxy-provider-${id}`,
        requestModel: `request-model-${id}`,
        upstreamModel: `upstream-model-${id}`,
        routeMode: id % 2 === 0 ? "failover" : "direct",
        upstreamUrl: `https://proxy-${id}.example.com/v1/chat/completions`,
        statusCode: null,
        error: null,
        activeRequestCount: 1,
        activeTargetCount: 1,
      },
      {
        id: id * 10 + 3,
        timestamp: `2026-05-19T08:${String(id % 60).padStart(2, "0")}:10Z`,
        event: "finished",
        appType: "codex",
        providerName: `Proxy Provider ${id}`,
        providerId: `proxy-provider-${id}`,
        requestModel: `request-model-${id}`,
        upstreamModel: `upstream-model-${id}`,
        routeMode: id % 2 === 0 ? "failover" : "direct",
        upstreamUrl: `https://proxy-${id}.example.com/v1/chat/completions`,
        statusCode: 200,
        error: null,
        activeRequestCount: 0,
        activeTargetCount: 0,
      },
    ],
  });

  it("loads usage aggregates, switches tabs, and opens request detail through the real settings usage entry", async () => {
    const user = userEvent.setup();
    const onOpenRequestDetail = vi.fn();

    renderSettingsPage({ onOpenRequestDetail });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "usage.title" })).toHaveAttribute(
        "data-state",
        "active",
      ),
    );

    expect(
      await screen.findByRole("heading", { name: "usage.title" }),
    ).toBeInTheDocument();
    expect(screen.getByText("4,700")).toBeInTheDocument();
    expect(screen.getByText("16")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "usage.appFilter.codex" }),
    );
    await waitFor(() => expect(screen.getByText("1,300")).toBeInTheDocument());

    await user.click(screen.getByRole("tab", { name: "usage.providerStats" }));
    expect(await screen.findByText("Claude Alpha")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "usage.modelStats" }));
    expect(
      await screen.findByText("claude-haiku-4-5-20251001"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "usage.requestLogs" }));
    const logRow = await screen.findByText("Claude Session One");
    await user.dblClick(logRow);

    await waitFor(() => expect(onOpenRequestDetail).toHaveBeenCalledTimes(1));
    expect(onOpenRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        providerId: "claude-alpha",
        providerName: "Claude Alpha",
        model: "claude-haiku-4-5-20251001",
        requestModel: "claude-3.7-thinking",
        projectPath: "/workspace/claude-one",
        sessionTitle: "Claude Session One",
      }),
    );
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("The width("),
    );
  });

  it("loads raw proxy logs with the active app filter, paginates them, and opens the detail dialog through the real usage entry", async () => {
    const user = userEvent.setup();
    const rawLogs = Array.from({ length: 55 }, (_, index) =>
      createRawProxyLogEntry(index + 1),
    );
    const rawLogRequests: Array<Record<string, unknown>> = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/get_proxy_raw_logs`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        rawLogRequests.push(body);
        const appType =
          typeof body.appType === "string" ? body.appType : undefined;
        const limit = typeof body.limit === "number" ? body.limit : 50;
        const filtered = rawLogs.filter(
          (item) => !appType || item.appType === appType,
        );
        return HttpResponse.json(
          filtered.slice(Math.max(0, filtered.length - limit)),
        );
      }),
    );

    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "usage.title" })).toHaveAttribute(
        "data-state",
        "active",
      ),
    );

    await user.click(
      screen.getByRole("button", { name: "usage.appFilter.codex" }),
    );
    await user.click(
      screen.getByRole("tab", { name: /^(usage\.rawProxyLogs|代理原始日志)$/ }),
    );

    await waitFor(() =>
      expect(
        rawLogRequests.some(
          (request) => request.appType === "codex" && request.limit === 50,
        ),
      ).toBe(true),
    );

    expect(await screen.findByText("Proxy Provider 55")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /^(common\.next|下一页)$/ }),
    );

    expect(await screen.findByText("Proxy Provider 35")).toBeInTheDocument();
    expect(screen.queryByText("Proxy Provider 55")).not.toBeInTheDocument();

    await user.dblClick(screen.getByText("Proxy Provider 35"));

    await waitFor(() =>
      expect(
        screen.getByText((content) =>
          content.includes('"requestId": "req-35"'),
        ),
      ).toBeInTheDocument(),
    );
  });

  it("saves pricing defaults and deletes a pricing row through the real usage pricing entry", async () => {
    const user = userEvent.setup();
    let pricing = [
      {
        modelId: "claude-haiku-4-5-20251001",
        displayName: "Claude Haiku 4.5",
        inputCostPerMillion: "3",
        outputCostPerMillion: "15",
        cacheReadCostPerMillion: "0.3",
        cacheCreationCostPerMillion: "3.75",
      },
      {
        modelId: "gpt-5.5",
        displayName: "GPT-5.5",
        inputCostPerMillion: "2",
        outputCostPerMillion: "8",
        cacheReadCostPerMillion: "0.2",
        cacheCreationCostPerMillion: "2.5",
      },
    ];
    const multipliers: Record<string, string> = {
      claude: "1",
      codex: "1.1",
      gemini: "0.95",
    };
    const modelSources: Record<string, string> = {
      claude: "response",
      codex: "response",
      gemini: "request",
    };
    const setMultiplierCalls: Array<Record<string, unknown>> = [];
    const setSourceCalls: Array<Record<string, unknown>> = [];
    const deleteCalls: string[] = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/get_model_pricing`, () =>
        HttpResponse.json(pricing),
      ),
      http.post(
        `${TAURI_ENDPOINT}/delete_model_pricing`,
        async ({ request }) => {
          const body = (await request.json()) as { modelId: string };
          deleteCalls.push(body.modelId);
          pricing = pricing.filter((item) => item.modelId !== body.modelId);
          return HttpResponse.json(null);
        },
      ),
      http.post(
        `${TAURI_ENDPOINT}/get_default_cost_multiplier`,
        async ({ request }) => {
          const body = (await request.json()) as { appType: string };
          return HttpResponse.json(multipliers[body.appType] ?? "1");
        },
      ),
      http.post(
        `${TAURI_ENDPOINT}/set_default_cost_multiplier`,
        async ({ request }) => {
          const body = (await request.json()) as {
            appType: string;
            value: string;
          };
          multipliers[body.appType] = body.value;
          setMultiplierCalls.push(body);
          return HttpResponse.json(null);
        },
      ),
      http.post(
        `${TAURI_ENDPOINT}/get_pricing_model_source`,
        async ({ request }) => {
          const body = (await request.json()) as { appType: string };
          return HttpResponse.json(modelSources[body.appType] ?? "response");
        },
      ),
      http.post(
        `${TAURI_ENDPOINT}/set_pricing_model_source`,
        async ({ request }) => {
          const body = (await request.json()) as {
            appType: string;
            value: string;
          };
          modelSources[body.appType] = body.value;
          setSourceCalls.push(body);
          return HttpResponse.json(null);
        },
      ),
    );

    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "usage.title" })).toHaveAttribute(
        "data-state",
        "active",
      ),
    );

    const pricingTrigger = screen
      .getByText("settings.advanced.pricing.title")
      .closest("button");
    if (!pricingTrigger) throw new Error("Pricing accordion trigger not found");
    await user.click(pricingTrigger);

    expect(
      await screen.findByText("settings.globalProxy.pricingDefaultsTitle"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("row")
          .some((row) =>
            row.textContent?.includes("claude-haiku-4-5-20251001"),
          ),
      ).toBe(true),
    );

    const claudeRow = screen.getByText("apps.claude").closest("tr");
    if (!claudeRow) throw new Error("Claude pricing defaults row not found");
    const claudeMultiplierInput = within(claudeRow).getByRole("spinbutton");
    const claudeSourceTrigger = within(claudeRow).getByRole("combobox");

    await user.clear(claudeMultiplierInput);
    await user.type(claudeMultiplierInput, "1.25");
    await user.click(claudeSourceTrigger);
    await user.click(
      await screen.findByRole("option", {
        name: "settings.globalProxy.pricingModelSourceRequest",
      }),
    );

    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(setMultiplierCalls).toContainEqual({
        appType: "claude",
        value: "1.25",
      }),
    );
    await waitFor(() =>
      expect(setSourceCalls).toContainEqual({
        appType: "claude",
        value: "request",
      }),
    );

    const pricingRow =
      screen
        .getAllByRole("row")
        .find(
          (row) =>
            row.textContent?.includes("claude-haiku-4-5-20251001") &&
            row.textContent?.includes("Claude Haiku 4.5"),
        ) ?? null;
    if (!pricingRow) throw new Error("Pricing row to delete not found");
    await user.click(within(pricingRow).getByTitle("common.delete"));
    await user.click(
      await screen.findByRole("button", { name: /^(common\.delete|删除)$/ }),
    );

    await waitFor(() =>
      expect(deleteCalls).toEqual(["claude-haiku-4-5-20251001"]),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("row")
          .some(
            (row) =>
              row.textContent?.includes("claude-haiku-4-5-20251001") &&
              row.textContent?.includes("Claude Haiku 4.5"),
          ),
      ).toBe(false),
    );
  });
});
