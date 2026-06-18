import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { RequestLog, UsageSummaryByApp } from "@/types/usage";
import {
  resetProviderState,
  setModelStatsState,
  setProviderStatsState,
  setProxyStatusState,
  setProxyTakeoverStatusState,
  setRequestLogsState,
  setUsageSummaryByAppState,
  setUsageTrendsState,
} from "../msw/state";
import { server } from "../msw/server";

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

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, title, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>confirm</button>
        <button onClick={onCancel}>cancel</button>
      </div>
    ) : null,
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

vi.mock("@/components/settings/ProxyTabContent", () => ({
  ProxyTabContent: () => <section>proxy-tab-content</section>,
}));

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <section>auth-center-panel</section>,
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

const createRequest = (overrides: Partial<RequestLog> = {}): RequestLog => ({
  requestId: overrides.requestId ?? "req-detail-1",
  providerId: overrides.providerId ?? "claude-alpha",
  providerName: overrides.providerName ?? "Claude Summary Provider",
  appType: overrides.appType ?? "claude",
  model: overrides.model ?? "summary-model",
  requestModel: overrides.requestModel ?? "summary-request-model",
  costMultiplier: overrides.costMultiplier ?? "1",
  inputTokens: overrides.inputTokens ?? 120,
  outputTokens: overrides.outputTokens ?? 30,
  cacheReadTokens: overrides.cacheReadTokens ?? 0,
  cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
  inputCostUsd: overrides.inputCostUsd ?? "0.001000",
  outputCostUsd: overrides.outputCostUsd ?? "0.002000",
  cacheReadCostUsd: overrides.cacheReadCostUsd ?? "0",
  cacheCreationCostUsd: overrides.cacheCreationCostUsd ?? "0",
  totalCostUsd: overrides.totalCostUsd ?? "0.003000",
  isStreaming: overrides.isStreaming ?? true,
  latencyMs: overrides.latencyMs ?? 900,
  firstTokenMs: overrides.firstTokenMs ?? 220,
  durationMs: overrides.durationMs ?? 1200,
  statusCode: overrides.statusCode ?? 200,
  sessionId: overrides.sessionId ?? "summary-session",
  sessionTitle: overrides.sessionTitle ?? "Summary Session",
  projectPath: overrides.projectPath ?? "/workspace/summary",
  providerType: overrides.providerType ?? "custom",
  createdAt: overrides.createdAt ?? 1_747_645_600,
  dataSource: overrides.dataSource ?? "proxy",
  errorMessage: overrides.errorMessage,
});

const usageSummary: UsageSummaryByApp[] = [
  {
    appType: "claude",
    summary: {
      totalRequests: 1,
      totalCost: "0.003000",
      totalInputTokens: 120,
      totalOutputTokens: 30,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      successRate: 100,
      realTotalTokens: 150,
      cacheHitRate: 0,
    },
  },
];

const openUsageDetailFromApp = async (user: ReturnType<typeof userEvent.setup>) => {
  const { default: App } = await import("@/App");
  renderApp(App);

  await waitFor(() =>
    expect(screen.getByTestId("provider-list")).toHaveAttribute(
      "data-app-id",
      "claude",
    ),
  );

  await user.click(await screen.findByTitle("使用统计"));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "usage.title" })).toHaveAttribute(
      "data-state",
      "active",
    ),
  );

  const rowText = await screen.findByText("Summary Session");
  await user.dblClick(rowText);
};

const findRequestDetailDialog = async () =>
  screen.findByRole("dialog", {
    name: /^(usage\.requestDetail|请求详情)$/,
  });

describe("App real request detail panel", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    setProxyStatusState({ running: true, port: 15721 });
    setProxyTakeoverStatusState({ claude: true });
    setUsageSummaryByAppState(usageSummary);
    setUsageTrendsState([
      {
        date: "2026-05-19T08:00:00Z",
        requestCount: 1,
        totalCost: "0.003000",
        totalTokens: 150,
        totalInputTokens: 120,
        totalOutputTokens: 30,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
      },
    ]);
    setProviderStatsState([
      {
        providerId: "claude-alpha",
        providerName: "Claude Summary Provider",
        requestCount: 1,
        totalTokens: 150,
        totalCost: "0.003000",
        successRate: 100,
        avgLatencyMs: 900,
      },
    ]);
    setModelStatsState([
      {
        model: "summary-model",
        requestCount: 1,
        totalTokens: 150,
        totalCost: "0.003000",
        avgCostPerRequest: "0.003000",
      },
    ]);
    setRequestLogsState([createRequest()]);
  });

  it("opens the real detail panel from App usage and replaces the summary with loaded detail", async () => {
    const user = userEvent.setup();
    const detail = createRequest({
      providerName: "Claude Detail Provider",
      model: "detail-actual-model",
      requestModel: "detail-request-model",
      sessionTitle: "Detail Session",
      projectPath: "/workspace/detail",
      inputTokens: 500,
      outputTokens: 125,
      totalCostUsd: "0.012500",
      latencyMs: 1234,
      firstTokenMs: 345,
    });

    server.use(
      http.post(`${TAURI_ENDPOINT}/get_request_detail`, async ({ request }) => {
        const body = (await request.json()) as { requestId: string };
        await new Promise((resolve) => setTimeout(resolve, 120));
        return HttpResponse.json(
          body.requestId === detail.requestId ? detail : null,
        );
      }),
    );

    await openUsageDetailFromApp(user);
    const dialog = await findRequestDetailDialog();

    expect(
      await within(dialog).findByText(
        "正在加载更完整的请求详情，当前先展示列表摘要。",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Claude Summary Provider")).toBeInTheDocument();
    expect(within(dialog).getByText("summary-model")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        within(dialog).queryByText("Claude Summary Provider"),
      ).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByText("Claude Detail Provider")).toBeInTheDocument();
    expect(within(dialog).getByText("detail-actual-model")).toBeInTheDocument();
    expect(within(dialog).getByText("detail-request-model")).toBeInTheDocument();
    expect(within(dialog).getByText("Detail Session")).toBeInTheDocument();
    expect(within(dialog).getByText("/workspace/detail")).toBeInTheDocument();
    expect(
      within(dialog).getByText((content) =>
        content.includes('"requestId": "req-detail-1"'),
      ),
    ).toBeInTheDocument();
  }, 20_000);

  it("keeps the summary visible and shows fallback notice when detail loading fails", async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${TAURI_ENDPOINT}/get_request_detail`, () =>
        HttpResponse.json("detail unavailable", { status: 500 }),
      ),
    );

    await openUsageDetailFromApp(user);
    const dialog = await findRequestDetailDialog();

    expect(
      await within(dialog).findByText(
        "详细记录读取失败，当前展示的是列表中的摘要信息。",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Claude Summary Provider")).toBeInTheDocument();
    expect(within(dialog).getByText("summary-model")).toBeInTheDocument();
    expect(within(dialog).getByText("Summary Session")).toBeInTheDocument();
    expect(within(dialog).getByText("/workspace/summary")).toBeInTheDocument();
    expect(
      within(dialog).getByText((content) =>
        content.includes('"requestId": "req-detail-1"'),
      ),
    ).toBeInTheDocument();
  }, 20_000);
});
