import {
  render,
  screen,
  fireEvent,
  within,
  act,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { http, HttpResponse } from "msw";
import type { Provider } from "@/types";
import { ProviderList } from "@/components/providers/ProviderList";
import { server } from "../msw/server";

const useDragSortMock = vi.fn();
const useSortableMock = vi.fn();
const providerActionsRenderSpy = vi.fn();
const checkProviderMock = vi.fn();
const isCheckingMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();
const toastInfoMock = vi.fn();
const useAutoFailoverEnabledMock = vi.fn();
const useFailoverQueueMock = vi.fn();
const addToQueueMutateMock = vi.fn();
const addToQueueMutateAsyncMock = vi.fn();
const removeFromQueueMutateMock = vi.fn();
const removeFromQueueMutateAsyncMock = vi.fn();
const useProviderHealthMock = vi.fn();
const useSettingsQueryMock = vi.fn();
const useSessionsQueryMock = vi.fn();
const useAppProxyConfigMock = vi.fn();
const useSessionProviderBindingsMock = vi.fn();
const useProviderSessionOccupancyMock = vi.fn();
const releaseProviderSessionBindingsMutateAsyncMock = vi.fn();
const updateAppProxyConfigMutateAsyncMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    info: (...args: unknown[]) => toastInfoMock(...args),
  },
}));

vi.mock("@/hooks/useDragSort", () => ({
  useDragSort: (...args: unknown[]) => useDragSortMock(...args),
}));

vi.mock("@/components/providers/ProviderActions", () => ({
  ProviderActions: (props: any) => {
    providerActionsRenderSpy(props);
    return (
      <div>
        <button aria-label="switch" onClick={props.onSwitch}>
          switch
        </button>
        <button aria-label="edit" onClick={props.onEdit}>
          edit
        </button>
        <button aria-label="duplicate" onClick={props.onDuplicate}>
          duplicate
        </button>
        <button aria-label="usage" onClick={props.onConfigureUsage}>
          usage
        </button>
        <button aria-label="delete" onClick={props.onDelete}>
          delete
        </button>
      </div>
    );
  },
}));

vi.mock("@/components/UsageFooter", () => ({
  default: () => <div data-testid="usage-footer" />,
}));

vi.mock("@dnd-kit/sortable", async () => {
  const actual = await vi.importActual<any>("@dnd-kit/sortable");

  return {
    ...actual,
    useSortable: (...args: unknown[]) => useSortableMock(...args),
  };
});

vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({
    checkProvider: (...args: unknown[]) => checkProviderMock(...args),
    isChecking: (...args: unknown[]) => isCheckingMock(...args),
  }),
}));

vi.mock("@/lib/query", () => ({
  useSettingsQuery: (...args: unknown[]) => useSettingsQueryMock(...args),
  useSessionsQuery: (...args: unknown[]) => useSessionsQueryMock(...args),
}));

vi.mock("@/lib/query/proxy", () => ({
  useAppProxyConfig: (...args: unknown[]) => useAppProxyConfigMock(...args),
  useProviderSessionOccupancy: (...args: unknown[]) =>
    useProviderSessionOccupancyMock(...args),
  useSessionProviderBindings: (...args: unknown[]) =>
    useSessionProviderBindingsMock(...args),
  useReleaseProviderSessionBindings: () => ({
    mutateAsync: (...args: unknown[]) =>
      releaseProviderSessionBindingsMutateAsyncMock(...args),
    isPending: false,
    variables: undefined,
  }),
  useUpdateAppProxyConfig: () => ({
    mutateAsync: (...args: unknown[]) =>
      updateAppProxyConfigMutateAsyncMock(...args),
    isPending: false,
  }),
}));

vi.mock("@/lib/query/failover", () => ({
  useAutoFailoverEnabled: (...args: unknown[]) =>
    useAutoFailoverEnabledMock(...args),
  useFailoverQueue: (...args: unknown[]) => useFailoverQueueMock(...args),
  useAddToFailoverQueue: () => ({
    mutate: (...args: unknown[]) => addToQueueMutateMock(...args),
    mutateAsync: (...args: unknown[]) => addToQueueMutateAsyncMock(...args),
    isPending: false,
  }),
  useRemoveFromFailoverQueue: () => ({
    mutate: (...args: unknown[]) => removeFromQueueMutateMock(...args),
    mutateAsync: (...args: unknown[]) =>
      removeFromQueueMutateAsyncMock(...args),
    isPending: false,
  }),
  useProviderHealth: (...args: unknown[]) => useProviderHealthMock(...args),
  useReorderFailoverQueue: () => ({ mutate: vi.fn() }),
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
  useDragSortMock.mockReset();
  useSortableMock.mockReset();
  providerActionsRenderSpy.mockClear();
  checkProviderMock.mockReset();
  isCheckingMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  toastWarningMock.mockReset();
  toastInfoMock.mockReset();
  useAutoFailoverEnabledMock.mockReset();
  useFailoverQueueMock.mockReset();
  addToQueueMutateMock.mockReset();
  addToQueueMutateAsyncMock.mockReset();
  removeFromQueueMutateMock.mockReset();
  removeFromQueueMutateAsyncMock.mockReset();
  useProviderHealthMock.mockReset();
  useSettingsQueryMock.mockReset();
  useSessionsQueryMock.mockReset();
  useAppProxyConfigMock.mockReset();
  useSessionProviderBindingsMock.mockReset();
  useProviderSessionOccupancyMock.mockReset();
  releaseProviderSessionBindingsMutateAsyncMock.mockReset();
  updateAppProxyConfigMutateAsyncMock.mockReset();

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
  isCheckingMock.mockReturnValue(false);
  useAutoFailoverEnabledMock.mockReturnValue({ data: false });
  useFailoverQueueMock.mockReturnValue({ data: [] });
  useProviderHealthMock.mockReturnValue({ data: null });
  useSettingsQueryMock.mockReturnValue({ data: undefined });
  useSessionsQueryMock.mockReturnValue({ data: [] });
  useAppProxyConfigMock.mockReturnValue({ data: undefined });
  useSessionProviderBindingsMock.mockReturnValue({ data: [] });
  useProviderSessionOccupancyMock.mockReturnValue({ data: [] });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

    const { container } = renderWithQueryClient(
      <ProviderList
        providers={{ a: providerA, b: providerB }}
        currentProviderId="b"
        appId="claude"
        onSwitch={handleSwitch}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
        onConfigureUsage={handleUsage}
        onOpenWebsite={handleOpenWebsite}
      />,
    );

    const rows = Array.from(
      container.querySelectorAll("tbody tr"),
    ) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("B");
    expect(rows[1].textContent).toContain("A");

    const sortableIds = useSortableMock.mock.calls
      .map((call) => call[0].id)
      .filter((id, index, arr) => arr.indexOf(id) === index);
    expect(sortableIds.slice(0, 2)).toEqual(["b", "a"]);

    const actionsForB = within(rows[0]);
    const actionsForA = within(rows[1]);
    fireEvent.click(actionsForB.getByRole("button", { name: "switch" }));
    fireEvent.click(actionsForB.getByRole("button", { name: "edit" }));
    fireEvent.click(actionsForB.getByRole("button", { name: "duplicate" }));
    fireEvent.click(actionsForB.getByRole("button", { name: "usage" }));
    fireEvent.click(actionsForA.getByRole("button", { name: "delete" }));

    expect(handleSwitch).toHaveBeenCalledWith(providerB);
    expect(handleEdit).toHaveBeenCalledWith(providerB);
    expect(handleDuplicate).toHaveBeenCalledWith(providerB);
    expect(handleUsage).toHaveBeenCalledWith(providerB);
    expect(handleDelete).toHaveBeenCalledWith(providerA);

    expect(useDragSortMock).toHaveBeenCalledWith(
      { a: providerA, b: providerB },
      "claude",
    );
  });

  it("filters providers with the search input", () => {
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

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const searchInput = screen.getByTestId("provider-filter-keyword-input");
    expect(screen.getByText("Alpha Labs")).toBeInTheDocument();
    expect(screen.getByText("Beta Works")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "beta" } });
    expect(screen.getAllByText("Alpha Labs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta Works").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /定位到 1 个供应商|Locate 1 providers?|provider\.searchLocatorMatches/i,
      ),
    ).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "alpha" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });
    expect(screen.getAllByText("Alpha Labs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta Works").length).toBeGreaterThan(0);
  });

  it("shows explicit no-session default badge during session routing and keeps status/actions columns non-resizable", () => {
    const providerAlpha = createProvider({ id: "alpha", name: "Alpha Labs" });
    const providerBeta = createProvider({ id: "beta", name: "Beta Works" });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha, providerBeta],
      sensors: [],
      handleDragEnd: vi.fn(),
    });
    useAppProxyConfigMock.mockReturnValue({
      data: {
        sessionRoutingEnabled: true,
        sessionDefaultProviderId: "beta",
        sessionIdleTtlMinutes: 30,
      },
    });
    useAutoFailoverEnabledMock.mockReturnValue({ data: true });
    useFailoverQueueMock.mockReturnValue({
      data: [{ providerId: "alpha" }, { providerId: "beta" }],
    });

    const { container } = renderWithQueryClient(
      <ProviderList
        providers={{ alpha: providerAlpha, beta: providerBeta }}
        currentProviderId="alpha"
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        isProxyTakeover
        activeProviderId="alpha"
      />,
    );

    const rows = Array.from(
      container.querySelectorAll("tbody tr"),
    ) as HTMLTableRowElement[];
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0].cells[5]).queryByText("当前流量"),
    ).not.toBeInTheDocument();
    expect(
      within(rows[0].cells[5]).queryByText("当前"),
    ).not.toBeInTheDocument();
    expect(
      within(rows[1].cells[5]).getByText("无会话默认"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/队列 P/i)).not.toBeInTheDocument();

    const modelHeader = screen.getByText("模型").closest("th");
    const notesHeader = screen.getByText("备注").closest("th");
    const statusHeader = screen.getByText("状态").closest("th");
    const actionsHeader = screen.getByText("操作").closest("th");

    expect(notesHeader?.style.width).toBe("190px");
    expect(modelHeader?.style.width).toBe("180px");
    expect(statusHeader?.style.width).toBe("");
    expect(actionsHeader?.style.width).toBe("328px");
    expect(modelHeader?.querySelector('[role="separator"]')).not.toBeNull();
    expect(statusHeader?.querySelector('[role="separator"]')).toBeNull();
    expect(actionsHeader?.querySelector('[role="separator"]')).toBeNull();
  });

  it("shows current and active traffic badges when session routing is disabled", () => {
    const providerAlpha = createProvider({ id: "alpha", name: "Alpha Labs" });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha],
      sensors: [],
      handleDragEnd: vi.fn(),
    });
    useAppProxyConfigMock.mockReturnValue({
      data: {
        sessionRoutingEnabled: false,
        sessionDefaultProviderId: "",
        sessionIdleTtlMinutes: 30,
      },
    });

    const { container } = renderWithQueryClient(
      <ProviderList
        providers={{ alpha: providerAlpha }}
        currentProviderId="alpha"
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        isProxyTakeover
        activeProviderId="alpha"
      />,
    );

    const row = container.querySelector(
      "tbody tr",
    ) as HTMLTableRowElement | null;
    expect(row).not.toBeNull();
    expect(within(row!.cells[5]).getByText("当前流量")).toBeInTheDocument();
    expect(within(row!.cells[5]).getByText("当前")).toBeInTheDocument();
  });

  it("allows deleting the current switch-mode provider when another fallback provider exists", () => {
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
        currentProviderId="beta"
        appId="codex"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />,
    );

    const betaActionProps = providerActionsRenderSpy.mock.calls.find(
      ([props]) => props.isCurrent === true,
    )?.[0];

    expect(betaActionProps?.canDelete).toBe(true);
  });

  it("maps no-session default to current provider when session routing follows current", () => {
    const providerAlpha = createProvider({ id: "alpha", name: "Alpha Labs" });
    const providerBeta = createProvider({ id: "beta", name: "Beta Works" });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha, providerBeta],
      sensors: [],
      handleDragEnd: vi.fn(),
    });
    useAppProxyConfigMock.mockReturnValue({
      data: {
        sessionRoutingEnabled: true,
        sessionDefaultProviderId: "",
        sessionIdleTtlMinutes: 30,
      },
    });

    const { container } = renderWithQueryClient(
      <ProviderList
        providers={{ alpha: providerAlpha, beta: providerBeta }}
        currentProviderId="alpha"
        appId="claude"
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
        isProxyTakeover
        activeProviderId="alpha"
      />,
    );

    const rows = Array.from(
      container.querySelectorAll("tbody tr"),
    ) as HTMLTableRowElement[];
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0].cells[5]).getByText("无会话默认(跟随当前)"),
    ).toBeInTheDocument();
    expect(
      within(rows[0].cells[5]).queryByText("当前"),
    ).not.toBeInTheDocument();
    expect(
      within(rows[0].cells[5]).queryByText("当前流量"),
    ).not.toBeInTheDocument();
    expect(
      within(rows[1].cells[5]).queryByText("无会话默认"),
    ).not.toBeInTheDocument();
  });

  it("persists batch test results after closing and remounting the provider list", async () => {
    const providerAlpha = createProvider({ id: "alpha", name: "Alpha Labs" });
    const providerBeta = createProvider({ id: "beta", name: "Beta Works" });
    const alphaDeferred = createDeferred<any>();
    const betaDeferred = createDeferred<any>();

    checkProviderMock.mockImplementation((providerId: string) => {
      if (providerId === "alpha") {
        return alphaDeferred.promise;
      }
      return betaDeferred.promise;
    });

    useDragSortMock.mockReturnValue({
      sortedProviders: [providerAlpha, providerBeta],
      sensors: [],
      handleDragEnd: vi.fn(),
    });

    const props = {
      providers: { alpha: providerAlpha, beta: providerBeta },
      currentProviderId: "",
      appId: "claude" as const,
      onSwitch: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onOpenWebsite: vi.fn(),
    };

    const firstRender = renderWithQueryClient(<ProviderList {...props} />);

    fireEvent.click(screen.getByTitle(/批量测试|streamCheck\.testAll/i));
    const startButtons = screen.getAllByRole("button", {
      name: /开始测试|streamCheck\.testAll/i,
    });
    fireEvent.click(startButtons[startButtons.length - 1]);

    await waitFor(() => expect(checkProviderMock).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: /关闭|common\.close/i }),
    );
    firstRender.unmount();

    await act(async () => {
      alphaDeferred.resolve({
        status: "operational",
        success: true,
        message: "",
        responseTimeMs: 120,
        modelUsed: "claude-3-5-sonnet",
        testedAt: Date.now(),
        retryCount: 0,
      });
    });

    await waitFor(() => expect(checkProviderMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      betaDeferred.resolve({
        status: "failed",
        success: false,
        message: "network error",
        modelUsed: "claude-3-5-sonnet",
        testedAt: Date.now(),
        retryCount: 1,
      });
    });

    renderWithQueryClient(<ProviderList {...props} />);

    fireEvent.click(screen.getByTitle(/批量测试|streamCheck\.testAll/i));

    expect(screen.getAllByText("Alpha Labs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta Works").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/正常|streamCheck\.operationalShort/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/失败|streamCheck\.failedShort/i).length,
    ).toBeGreaterThan(0);
  });

  it("clears live config change warning after refreshing the current environment config", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      intervalCallbacks.push(callback as () => void);
      return 1 as unknown as number;
    }) as typeof window.setInterval);
    const clearIntervalSpy = vi
      .spyOn(window, "clearInterval")
      .mockImplementation(() => {});

    try {
      let modifiedAt = 1;
      let snapshotText =
        '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://example.com"\n  }\n}';

      server.use(
        http.post("http://tauri.local/get_live_config_files", async () =>
          HttpResponse.json([
            {
              label: "settings.json",
              path: "C:/mock/.claude/settings.json",
              exists: true,
              modifiedAt,
              sizeBytes: snapshotText.length,
            },
          ]),
        ),
        http.post(
          "http://tauri.local/get_current_live_config_snapshot",
          async () =>
            HttpResponse.json({
              app: "claude",
              currentProviderId: "provider-1",
              currentProviderName: "Test Provider",
              note: "直接显示当前 live 配置文件内容，可在此编辑并保存。",
              files: [
                {
                  label: "settings.json",
                  path: "C:/mock/.claude/settings.json",
                  expectedText: snapshotText,
                  actualText: snapshotText,
                  differs: false,
                },
              ],
            }),
        ),
      );

      const provider = createProvider();
      useDragSortMock.mockReturnValue({
        sortedProviders: [provider],
        sensors: [],
        handleDragEnd: vi.fn(),
      });

      renderWithQueryClient(
        <ProviderList
          providers={{ "provider-1": provider }}
          currentProviderId="provider-1"
          appId="claude"
          onSwitch={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onOpenWebsite={vi.fn()}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "当前环境配置" }),
      );

      await screen.findByText(
        "直接显示当前 live 配置文件内容，可在此编辑并保存。",
      );
      expect(
        screen.queryByText(
          "检测到实际配置文件发生变化。请先刷新当前环境配置，再决定是否保存。",
        ),
      ).not.toBeInTheDocument();

      modifiedAt = 2;
      snapshotText =
        '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://changed.example.com"\n  }\n}';

      await act(async () => {
        intervalCallbacks[0]?.();
      });

      await screen.findByText(
        "检测到实际配置文件发生变化。请先刷新当前环境配置，再决定是否保存。",
      );

      fireEvent.click(screen.getByRole("button", { name: "刷新" }));

      await waitFor(() => {
        expect(
          screen.queryByText(
            "检测到实际配置文件发生变化。请先刷新当前环境配置，再决定是否保存。",
          ),
        ).not.toBeInTheDocument();
      });
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
