import {
  act,
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import type { ReactElement } from "react";
import type { Provider } from "@/types";
import type { AppProxyConfig } from "@/types/proxy";
import { ProviderList } from "@/components/providers/ProviderList";
import {
  getProviders,
  setProviderDefaultTemplateState,
  setProviders,
} from "../msw/state";
import { server } from "../msw/server";
import {
  emitTauriEvent,
  getTauriEventListenerCount,
  resetTauriEventListeners,
} from "../msw/tauriMocks";

const useDragSortMock = vi.fn();
const useSortableMock = vi.fn();
const mockAddToFailoverQueueMutateAsync = vi.fn();
const mockRemoveFromFailoverQueueMutateAsync = vi.fn();
let mockAutoFailoverEnabled: boolean | undefined = false;
let mockAppProxyConfig: AppProxyConfig | undefined = undefined;
const mockUpdateAppProxyConfigMutate = vi.fn();
let mockFailoverQueue: Array<{ providerId: string; providerName: string }> = [];
let mockProviderHealth: unknown = undefined;
let mockCircuitBreakerStats: unknown = undefined;
const TAURI_ENDPOINT = "http://tauri.local";

vi.mock("@/hooks/useDragSort", () => ({
  useDragSort: (...args: unknown[]) => useDragSortMock(...args),
}));

vi.mock("@/components/UsageFooter", () => ({
  default: () => <div data-testid="usage-footer" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: any) => <div>{children}</div>,
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@dnd-kit/sortable", async () => {
  const actual = await vi.importActual<any>("@dnd-kit/sortable");

  return {
    ...actual,
    useSortable: (...args: unknown[]) => useSortableMock(...args),
  };
});

// Mock hooks that use QueryClient
vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({
    checkProvider: vi.fn(),
    isChecking: () => false,
  }),
}));

vi.mock("@/hooks/useProxyStatus", () => ({
  useProxyStatus: () => ({
    takeoverStatus: {
      claude: false,
      codex: false,
      gemini: false,
      opencode: false,
      openclaw: false,
      hermes: false,
    },
  }),
}));

vi.mock("@/lib/query/proxy", () => ({
  useAppProxyConfig: () => ({ data: mockAppProxyConfig }),
  useUpdateAppProxyConfig: () => ({
    mutate: mockUpdateAppProxyConfigMutate,
    isPending: false,
  }),
  useSessionRoutingSnapshot: () => ({
    data: {
      appType: "claude",
      enabled: false,
      proxyRunning: false,
      clientSessionOnly: true,
      idleTtlSeconds: 600,
      bindings: [],
      providers: [],
    },
    isFetching: false,
    refetch: vi.fn(),
  }),
  useRebindSessionRoute: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/api/sessions", () => ({
  sessionsApi: {
    listRecent: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/query/failover", () => ({
  useAutoFailoverEnabled: () => ({ data: mockAutoFailoverEnabled }),
  useFailoverQueue: () => ({ data: mockFailoverQueue }),
  useAddToFailoverQueue: () => ({
    mutate: vi.fn(),
    mutateAsync: mockAddToFailoverQueueMutateAsync,
  }),
  useRemoveFromFailoverQueue: () => ({
    mutate: vi.fn(),
    mutateAsync: mockRemoveFromFailoverQueueMutateAsync,
  }),
  useReorderFailoverQueue: () => ({ mutate: vi.fn() }),
  useProviderHealth: () => ({ data: mockProviderHealth }),
  useCircuitBreakerStats: () => ({ data: mockCircuitBreakerStats }),
}));

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: overrides.id ?? "provider-1",
    name: overrides.name ?? "Test Provider",
    settingsConfig: overrides.settingsConfig ?? {},
    category: overrides.category,
    createdAt: overrides.createdAt,
    sortIndex: overrides.sortIndex,
    meta: overrides.meta,
    websiteUrl: overrides.websiteUrl,
  };
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  resetTauriEventListeners();
  useDragSortMock.mockReset();
  useSortableMock.mockReset();
  mockAddToFailoverQueueMutateAsync.mockReset();
  mockAddToFailoverQueueMutateAsync.mockResolvedValue(undefined);
  mockRemoveFromFailoverQueueMutateAsync.mockReset();
  mockRemoveFromFailoverQueueMutateAsync.mockResolvedValue(undefined);
  mockUpdateAppProxyConfigMutate.mockReset();
  mockAutoFailoverEnabled = false;
  mockAppProxyConfig = undefined;
  mockFailoverQueue = [];
  mockProviderHealth = undefined;
  mockCircuitBreakerStats = undefined;

  useSortableMock.mockImplementation(({ id }: { id: string }) => ({
    setNodeRef: vi.fn(),
    attributes: { "data-dnd-id": id },
    listeners: { onPointerDown: vi.fn() },
    transform: null,
    transition: null,
    isDragging: false,
  }));

  useDragSortMock.mockReturnValue({
    sortedProviders: [],
    sensors: [],
    handleDragEnd: vi.fn(),
  });
});

describe("ProviderList Component", () => {
  it("should render skeleton placeholders when loading", () => {
    const { container } = renderWithQueryClient(
      <ProviderList
        providers={{}}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        isLoading
      />,
    );

    const placeholders = container.querySelectorAll(
      ".border-dashed.border-muted-foreground\\/40",
    );
    expect(placeholders).toHaveLength(3);
  });

  it("should show empty state and trigger create callback when no providers exist", () => {
    const handleCreate = vi.fn();
    useDragSortMock.mockReturnValueOnce({
      sortedProviders: [],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{}}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        onCreate={handleCreate}
      />,
    );

    const addButton = screen.getByRole("button", {
      name: "provider.addProvider",
    });
    fireEvent.click(addButton);

    expect(handleCreate).toHaveBeenCalledTimes(1);
  });

  it("should render in order returned by useDragSort and pass through action callbacks", () => {
    const providerA = createProvider({ id: "a", name: "A" });
    const providerB = createProvider({ id: "b", name: "B" });

    const handleSwitch = vi.fn();
    const handleEdit = vi.fn();
    const handleDelete = vi.fn();
    const handleDuplicate = vi.fn();
    const handleUsage = vi.fn();
    const handleOpenWebsite = vi.fn();

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerB, providerA],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA, b: providerB }}
        currentProviderId="a"
        appId="claude"
        onSwitch={handleSwitch}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
        onConfigureUsage={handleUsage}
        onOpenWebsite={handleOpenWebsite}
      />,
    );

    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows[0].textContent).toContain("B");
    expect(dataRows[1].textContent).toContain("A");

    const rowB = dataRows[0];
    const rowA = dataRows[1];

    expect(
      within(rowB).getByRole("button", { name: "拖拽排序" }),
    ).toHaveAttribute("data-dnd-id", "b");
    expect(
      within(rowA).getByRole("button", { name: "拖拽排序" }),
    ).toHaveAttribute("data-dnd-id", "a");

    fireEvent.click(within(rowB).getByRole("button", { name: "使用此供应商" }));
    fireEvent.click(within(rowB).getByRole("button", { name: "编辑" }));
    fireEvent.click(within(rowB).getByRole("button", { name: "复制" }));
    fireEvent.click(within(rowB).getByRole("button", { name: "用量配置" }));
    expect(within(rowA).getByRole("button", { name: "删除" })).toBeEnabled();
    fireEvent.click(within(rowB).getByRole("button", { name: "删除" }));

    expect(handleSwitch).toHaveBeenCalledWith(providerB);
    expect(handleEdit).toHaveBeenCalledWith(providerB, { isEnabled: false });
    expect(handleDuplicate).toHaveBeenCalledWith(providerB);
    expect(handleUsage).toHaveBeenCalledWith(providerB);
    expect(handleDelete).toHaveBeenCalledWith(providerB);

    // Verify useDragSort call parameters
    expect(useDragSortMock).toHaveBeenCalledWith(
      { a: providerA, b: providerB },
      "claude",
    );
  });

  it("enabling admission retry on one provider disables the other same-app provider", async () => {
    const providerA = createProvider({
      id: "retry-a",
      name: "Retry A",
      meta: {
        upstreamAdmissionRetry: {
          enabled: true,
          maxRetries: 7,
          initialDelayMs: 250,
        },
      },
    });
    const providerB = createProvider({
      id: "retry-b",
      name: "Retry B",
      meta: {
        upstreamAdmissionRetry: {
          enabled: false,
          maxRetries: 3,
        },
      },
    });

    setProviders("claude", {
      "retry-a": providerA,
      "retry-b": providerB,
    });
    useDragSortMock.mockReturnValue({
      sortedProviders: [providerA, providerB],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "retry-a": providerA, "retry-b": providerB }}
        currentProviderId="retry-a"
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    const retryBRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("Retry B"));
    expect(retryBRow).toBeTruthy();

    fireEvent.click(
      within(retryBRow!).getByRole("button", {
        name: "开启上游入场重试",
      }),
    );

    await waitFor(() => {
      const saved = getProviders("claude");
      expect(saved["retry-a"].meta?.upstreamAdmissionRetry?.enabled).toBe(
        false,
      );
      expect(saved["retry-b"].meta?.upstreamAdmissionRetry?.enabled).toBe(true);
    });
    expect(
      getProviders("claude")["retry-a"].meta?.upstreamAdmissionRetry
        ?.maxRetries,
    ).toBe(7);
  });

  it("clears local admission retry count and hides the tag after disabling admission retry", async () => {
    const provider = createProvider({
      id: "retry-live",
      name: "Retry Live",
      meta: {
        upstreamAdmissionRetry: {
          enabled: true,
        },
      },
    });

    setProviders("claude", { "retry-live": provider });
    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "retry-live": provider }}
        currentProviderId="retry-live"
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(getTauriEventListenerCount("provider-admission-retry")).toBe(1);
    });

    await waitFor(() => {
      expect(screen.getByText("Retry Live")).toBeInTheDocument();
    });

    await waitFor(() => {
      const row = screen
        .getAllByRole("row")
        .find((candidate) => candidate.textContent?.includes("Retry Live"));
      expect(row).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "关闭上游入场重试" }),
    );

    await waitFor(() => {
      expect(
        getProviders("claude")["retry-live"].meta?.upstreamAdmissionRetry
          ?.enabled,
      ).toBe(false);
    });

    await act(async () => {
      emitTauriEvent("provider-admission-retry", {
        requestId: "req-retry-live",
        event: "retrying",
        appType: "claude",
        providerId: "retry-live",
        providerName: "Retry Live",
        retryCount: 3,
        delayMs: 1000,
        status: 429,
        error: "Service Unavailable",
        updatedAt: "2026-07-04T08:00:00Z",
      });
    });

    await waitFor(() => {
      const row = screen
        .getAllByRole("row")
        .find((candidate) => candidate.textContent?.includes("Retry Live"));
      expect(row?.textContent).not.toContain("入场 3");
    });
  });

  it("hides stale admission retry tag state when the provider switch is already disabled", async () => {
    const provider = createProvider({
      id: "retry-hidden",
      name: "Retry Hidden",
      meta: {
        upstreamAdmissionRetry: {
          enabled: false,
        },
      },
    });

    setProviders("claude", { "retry-hidden": provider });
    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "retry-hidden": provider }}
        currentProviderId="retry-hidden"
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(getTauriEventListenerCount("provider-admission-retry")).toBe(1);
    });

    await act(async () => {
      emitTauriEvent("provider-admission-retry", {
        requestId: "req-retry-hidden",
        event: "admitted",
        appType: "claude",
        providerId: "retry-hidden",
        providerName: "Retry Hidden",
        retryCount: 4,
        delayMs: 0,
        status: 200,
        error: null,
        updatedAt: "2026-07-04T08:00:01Z",
      });
    });

    await waitFor(() => {
      const row = screen
        .getAllByRole("row")
        .find((candidate) => candidate.textContent?.includes("Retry Hidden"));
      expect(row).toBeTruthy();
      expect(row?.textContent).not.toContain("入场成功");
      expect(row?.textContent).not.toContain("入场 4");
    });
  });

  it("keeps continuous order numbers for mixed failover queue membership", async () => {
    // 禁用项在前、启用项在后时，旧逻辑会把启用项的队列优先级 1..k
    // 与禁用项的列表位置 1..m 混用，出现 1,2,3,1,2 这类重复序号。
    const disabledA = createProvider({
      id: "disabled-a",
      name: "Disabled A",
      sortIndex: 0,
    });
    const disabledB = createProvider({
      id: "disabled-b",
      name: "Disabled B",
      sortIndex: 1,
    });
    const disabledC = createProvider({
      id: "disabled-c",
      name: "Disabled C",
      sortIndex: 2,
    });
    const enabledD = createProvider({
      id: "enabled-d",
      name: "Enabled D",
      sortIndex: 3,
    });
    const enabledE = createProvider({
      id: "enabled-e",
      name: "Enabled E",
      sortIndex: 4,
    });
    const enabledF = createProvider({
      id: "enabled-f",
      name: "Enabled F",
      sortIndex: 5,
    });
    const enabledG = createProvider({
      id: "enabled-g",
      name: "Enabled G",
      sortIndex: 6,
    });
    const enabledH = createProvider({
      id: "enabled-h",
      name: "Enabled H",
      sortIndex: 7,
    });

    mockAutoFailoverEnabled = true;
    mockFailoverQueue = [
      { providerId: "enabled-d", providerName: "Enabled D" },
      { providerId: "enabled-e", providerName: "Enabled E" },
      { providerId: "enabled-f", providerName: "Enabled F" },
      { providerId: "enabled-g", providerName: "Enabled G" },
      { providerId: "enabled-h", providerName: "Enabled H" },
    ];

    const sortedProviders = [
      disabledA,
      disabledB,
      disabledC,
      enabledD,
      enabledE,
      enabledF,
      enabledG,
      enabledH,
    ];

    useDragSortMock.mockReturnValue({
      sortedProviders,
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={Object.fromEntries(
          sortedProviders.map((provider) => [provider.id, provider]),
        )}
        currentProviderId=""
        appId="claude"
        isProxyTakeover
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    const rows = screen
      .getAllByRole("row")
      .filter((row) =>
        sortedProviders.some((provider) =>
          row.textContent?.includes(provider.name),
        ),
      );

    expect(rows).toHaveLength(8);

    const orderNumbers = rows.map((row) => {
      const cells = within(row).getAllByRole("cell");
      // 列：选择 / 序号 / 名称 / ...
      return cells[1]?.textContent?.replace(/\s/g, "") ?? "";
    });

    expect(orderNumbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("persists model-name sorting with enabled providers first", async () => {
    const providerAlpha = createProvider({
      id: "alpha",
      name: "Alpha",
      settingsConfig: { env: { ANTHROPIC_MODEL: "gpt-5-b" } },
    });
    const providerBeta = createProvider({
      id: "beta",
      name: "Beta",
      settingsConfig: { env: { ANTHROPIC_MODEL: "zz-model" } },
    });
    const providerGamma = createProvider({
      id: "gamma",
      name: "Gamma",
      settingsConfig: { env: { ANTHROPIC_MODEL: "aa-model" } },
    });
    const sortCalls: Array<{
      updates: { id: string; sortIndex: number }[];
      app: string;
    }> = [];

    mockAutoFailoverEnabled = true;
    mockFailoverQueue = [{ providerId: "beta", providerName: "Beta" }];

    server.use(
      http.post(
        `${TAURI_ENDPOINT}/update_providers_sort_order`,
        async ({ request }) => {
          const body = (await request.json()) as {
            updates: { id: string; sortIndex: number }[];
            app: string;
          };
          sortCalls.push(body);
          return HttpResponse.json(true);
        },
      ),
    );

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha, providerBeta, providerGamma],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{
          alpha: providerAlpha,
          beta: providerBeta,
          gamma: providerGamma,
        }}
        currentProviderId=""
        appId="claude"
        isProxyTakeover
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "模型名称排序" }));

    await waitFor(() => expect(sortCalls).toHaveLength(1));
    expect(sortCalls[0].app).toBe("claude");
    expect(sortCalls[0].updates.map((item) => item.id)).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "模型名称排序" }));

    await waitFor(() => expect(sortCalls).toHaveLength(2));
    expect(sortCalls[1].updates.map((item) => item.id)).toEqual([
      "beta",
      "alpha",
      "gamma",
    ]);
  });

  it("filters rows by multiple model names before search and uses filtered rows for bulk enable", async () => {
    const providerAlpha = createProvider({
      id: "alpha",
      name: "Alpha",
      settingsConfig: { env: { ANTHROPIC_MODEL: "gpt-5" } },
    });
    const providerBeta = createProvider({
      id: "beta",
      name: "Beta",
      settingsConfig: { env: { ANTHROPIC_MODEL: "claude-sonnet" } },
    });
    const providerGamma = createProvider({
      id: "gamma",
      name: "Gamma",
      settingsConfig: { env: { ANTHROPIC_MODEL: "gpt-5" } },
    });

    mockAutoFailoverEnabled = true;
    mockFailoverQueue = [];

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha, providerBeta, providerGamma],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{
          alpha: providerAlpha,
          beta: providerBeta,
          gamma: providerGamma,
        }}
        currentProviderId=""
        appId="claude"
        isProxyTakeover
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    const modelFilter = screen.getByRole("button", { name: "模型名称筛选" });
    const searchInput = screen.getByRole("textbox", {
      name: "Search providers",
    });
    expect(
      modelFilter.compareDocumentPosition(searchInput) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(modelFilter);
    fireEvent.click(screen.getByRole("checkbox", { name: "gpt-5 (2)" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "claude-sonnet (1)" }),
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "加入队列" }));

    await waitFor(() => {
      expect(mockAddToFailoverQueueMutateAsync).toHaveBeenCalledTimes(3);
    });
    expect(
      mockAddToFailoverQueueMutateAsync.mock.calls.map(([arg]) => arg),
    ).toEqual([
      { appType: "claude", providerId: "alpha" },
      { appType: "claude", providerId: "beta" },
      { appType: "claude", providerId: "gamma" },
    ]);
  });

  it("locates providers with the search input without filtering rows", () => {
    const providerAlpha = createProvider({ id: "alpha", name: "Alpha Labs" });
    const providerBeta = createProvider({ id: "beta", name: "Beta Works" });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha, providerBeta],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ alpha: providerAlpha, beta: providerBeta }}
        currentProviderId=""
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    const searchInput =
      screen.getByPlaceholderText("按名称、备注、网址或模型定位...");
    expect(screen.getByText("Alpha Labs")).toBeInTheDocument();
    expect(screen.getAllByText("Beta Works").length).toBeGreaterThan(0);

    fireEvent.change(searchInput, { target: { value: "beta" } });
    expect(screen.getByText("Alpha Labs")).toBeInTheDocument();
    expect(screen.getAllByText("Beta Works").length).toBeGreaterThan(1);
    expect(screen.getByText("1/1")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "gamma" } });
    expect(screen.getByText("Alpha Labs")).toBeInTheDocument();
    expect(screen.getAllByText("Beta Works").length).toBeGreaterThan(0);
    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(screen.getAllByText("没有找到匹配结果").length).toBeGreaterThan(0);
  });

  it("keeps full API endpoints visible for search and display text", () => {
    const fullEndpoint = "https://api.xn--chy-js0fk50c.top/v1/chat/completions";
    const provider = createProvider({
      id: "codex-full",
      name: "Codex Full Endpoint",
      settingsConfig: {
        config: [
          'model_provider = "custom"',
          "",
          "[model_providers.custom]",
          'name = "custom"',
          `base_url = "${fullEndpoint}"`,
          'wire_api = "responses"',
          "",
        ].join("\n"),
      },
    });

    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "codex-full": provider }}
        currentProviderId=""
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    const searchInput =
      screen.getByPlaceholderText("按名称、备注、网址或模型定位...");
    fireEvent.change(searchInput, { target: { value: "chat/completions" } });

    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText(fullEndpoint)).toBeInTheDocument();
  });

  it("uses separate badges for lifecycle status and live requests, and exposes request/upstream models", () => {
    const provider = createProvider({
      id: "provider-active",
      name: "Active Provider",
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_MODEL: "gpt-5.4",
        },
      },
    });

    mockAutoFailoverEnabled = true;
    mockFailoverQueue = [
      { providerId: "provider-active", providerName: "Active Provider" },
    ];

    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "provider-active": provider }}
        currentProviderId=""
        appId="claude"
        isProxyTakeover
        activeRequestProviders={{
          "provider-active": {
            count: 1,
            model: "gpt-5.3-codex",
            requestModel: "gpt-5.4",
            upstreamModel: "gpt-5.3-codex",
          },
        }}
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    expect(screen.getByText("启用")).toBeInTheDocument();
    expect(screen.getByText("请求中")).toBeInTheDocument();
    expect(screen.queryByText("处理中")).not.toBeInTheDocument();

    const statusSummary = screen.getByTitle((value) => {
      const text = String(value);
      return (
        text.includes("实际上游模型：gpt-5.3-codex") &&
        text.includes("请求模型：gpt-5.4")
      );
    });

    expect(statusSummary).toBeInTheDocument();
  });

  it("preserves existing Codex API key and base URL when applying an incomplete provider template", async () => {
    const provider = createProvider({
      id: "codex-safe",
      name: "Codex Safe",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "real-key" },
        config: [
          'model_provider = "custom"',
          'model = "gpt-5.4"',
          "",
          "[model_providers.custom]",
          'name = "custom"',
          'base_url = "https://real.example/v1"',
          'wire_api = "responses"',
        ].join("\n"),
      },
    });

    setProviders("codex", { "codex-safe": provider });
    setProviderDefaultTemplateState(
      "codex",
      JSON.stringify(
        {
          auth: { OPENAI_API_KEY: "" },
          config: [
            'model_provider = "custom"',
            'model = "gpt-5.5"',
            "",
            "[model_providers.custom]",
            'name = "custom"',
            'base_url = ""',
            'wire_api = "responses"',
            "requires_openai_auth = true",
          ].join("\n"),
        },
        null,
        2,
      ),
    );

    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "codex-safe": provider }}
        currentProviderId=""
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "供应商配置模板" }),
    );

    const applyAllButton = await screen.findByRole("button", {
      name: "应用到当前应用全部 (1)",
    });
    await screen.findByDisplayValue(/base_url = ""/);
    fireEvent.click(applyAllButton);

    await waitFor(() => {
      const updated = getProviders("codex")["codex-safe"];
      expect(updated.settingsConfig).toMatchObject({
        auth: { OPENAI_API_KEY: "real-key" },
      });
    });

    const updatedConfig = getProviders("codex")["codex-safe"].settingsConfig
      ?.config as string;
    expect(updatedConfig).toContain('base_url = "https://real.example/v1"');
    expect(updatedConfig).toContain('model = "gpt-5.5"');
    expect(updatedConfig).toContain("requires_openai_auth = true");
  });

  it("does not replace existing Codex credentials with fixed provider template values", async () => {
    const provider = createProvider({
      id: "codex-fixed",
      name: "Codex Fixed",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "real-key" },
        config: [
          'model_provider = "custom"',
          'model = "gpt-5.4"',
          "",
          "[model_providers.custom]",
          'name = "custom"',
          'base_url = "https://real.example/v1"',
          'wire_api = "responses"',
        ].join("\n"),
      },
    });

    setProviders("codex", { "codex-fixed": provider });
    setProviderDefaultTemplateState(
      "codex",
      JSON.stringify(
        {
          auth: { OPENAI_API_KEY: "template-key" },
          config: [
            'model_provider = "custom"',
            'model = "gpt-5.5"',
            "",
            "[model_providers.custom]",
            'name = "custom"',
            'base_url = "https://template.example/v1"',
            'wire_api = "responses"',
            "requires_openai_auth = true",
          ].join("\n"),
        },
        null,
        2,
      ),
    );

    useDragSortMock.mockReturnValue({
      sortedProviders: [provider],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ "codex-fixed": provider }}
        currentProviderId=""
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "供应商配置模板" }),
    );

    const applyAllButton = await screen.findByRole("button", {
      name: "应用到当前应用全部 (1)",
    });
    await screen.findByDisplayValue(/https:\/\/template\.example\/v1/);
    fireEvent.click(applyAllButton);

    await waitFor(() => {
      const updated = getProviders("codex")["codex-fixed"];
      expect(updated.settingsConfig).toMatchObject({
        auth: { OPENAI_API_KEY: "real-key" },
      });
    });

    const updatedConfig = getProviders("codex")["codex-fixed"].settingsConfig
      ?.config as string;
    expect(updatedConfig).toContain('base_url = "https://real.example/v1"');
    expect(updatedConfig).not.toContain("https://template.example/v1");
    expect(updatedConfig).toContain('model = "gpt-5.5"');
  });

  it("does not allow normal provider switching while proxy failover state is unresolved", () => {
    const providerA = createProvider({ id: "a", name: "A" });
    const providerB = createProvider({ id: "b", name: "B" });
    const handleSwitch = vi.fn();
    mockAutoFailoverEnabled = undefined;

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerA, providerB],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA, b: providerB }}
        currentProviderId="a"
        appId="codex"
        isProxyTakeover
        onSwitch={handleSwitch}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    const rowB = screen.getAllByRole("row")[2];
    const switchButton = within(rowB).getByRole("button", {
      name: "切换到此供应商",
    });

    expect(switchButton).toBeDisabled();
    fireEvent.click(switchButton);
    expect(handleSwitch).not.toHaveBeenCalled();
  });
});
