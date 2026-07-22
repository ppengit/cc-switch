import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestLogTable } from "@/components/usage/RequestLogTable";
import type { RequestLog, UsageRangeSelection } from "@/types/usage";

const useRequestLogsMock = vi.hoisted(() => vi.fn());
const retentionQueryMock = vi.hoisted(() => vi.fn());
const retentionMutationMock = vi.hoisted(() => vi.fn());
const clearMutationMock = vi.hoisted(() => vi.fn());

const createRequestLog = (overrides: Partial<RequestLog> = {}): RequestLog => ({
  requestId: overrides.requestId ?? "req-1",
  providerId: overrides.providerId ?? "provider-1",
  providerName: overrides.providerName ?? "Provider One",
  appType: overrides.appType ?? "codex",
  model: overrides.model ?? "gpt-5.4",
  requestModel: overrides.requestModel ?? "gpt-5.4",
  costMultiplier: overrides.costMultiplier ?? "1.0",
  inputTokens: overrides.inputTokens ?? 10,
  outputTokens: overrides.outputTokens ?? 20,
  cacheReadTokens: overrides.cacheReadTokens ?? 0,
  cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
  inputCostUsd: overrides.inputCostUsd ?? "0",
  outputCostUsd: overrides.outputCostUsd ?? "0",
  cacheReadCostUsd: overrides.cacheReadCostUsd ?? "0",
  cacheCreationCostUsd: overrides.cacheCreationCostUsd ?? "0",
  totalCostUsd: overrides.totalCostUsd ?? "0",
  isStreaming: overrides.isStreaming ?? true,
  latencyMs: overrides.latencyMs ?? 1000,
  statusCode: overrides.statusCode ?? 200,
  createdAt: overrides.createdAt ?? 1_710_000_000,
  dataSource: overrides.dataSource,
  sessionTitle: overrides.sessionTitle,
  projectPath: overrides.projectPath,
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string;
      },
    ) => options?.defaultValue ?? key,
    i18n: {
      resolvedLanguage: "en",
      language: "en",
    },
  }),
}));

vi.mock("@/lib/query/usage", () => ({
  useRequestLogs: (args: unknown) => useRequestLogsMock(args),
  useRequestLogRetentionConfig: () => retentionQueryMock(),
  useUpdateRequestLogRetention: () => ({
    mutate: retentionMutationMock,
    isPending: false,
  }),
  useClearRequestLogs: () => ({
    mutate: clearMutationMock,
    isPending: false,
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder ?? null}</span>,
  SelectContent: () => null,
  SelectItem: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, ...props }: any) => (
    <button type="button" onClick={() => onSelect?.()} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: any) => <table>{children}</table>,
  TableBody: ({ children, ...props }: any) => (
    <tbody {...props}>{children}</tbody>
  ),
  TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
  TableHead: ({ children, ...props }: any) => <th {...props}>{children}</th>,
  TableHeader: ({ children }: any) => <thead>{children}</thead>,
  TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
}));

describe("RequestLogTable", () => {
  beforeEach(() => {
    useRequestLogsMock.mockReset();
    retentionQueryMock.mockReset();
    retentionMutationMock.mockReset();
    clearMutationMock.mockReset();
    retentionQueryMock.mockReturnValue({
      data: { autoCleanupEnabled: true, retainCount: 50 },
    });
    useRequestLogsMock.mockImplementation(
      ({ page = 0, pageSize = 20 }: { page?: number; pageSize?: number }) => ({
        data: {
          data: [],
          total: 120,
          page,
          pageSize,
        },
        isLoading: false,
      }),
    );
  });

  it("keeps the table shell visible during the initial load", () => {
    useRequestLogsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    expect(screen.getByText("usage.time")).toBeInTheDocument();
    expect(screen.getAllByTestId("request-log-loading-row")).toHaveLength(8);
    expect(screen.queryByText("usage.noData")).not.toBeInTheDocument();
  });

  it("shows the safe 50-row automatic-cleanup defaults before config loads", () => {
    retentionQueryMock.mockReturnValue({ data: undefined });

    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    expect(screen.getByRole("switch", { name: "自动清理" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("spinbutton", { name: "保留最近条数" }),
    ).toHaveValue(50);
  });

  it("clamps the current page when retention shrinks the result set", async () => {
    let total = 120;
    useRequestLogsMock.mockImplementation(
      ({ page = 0, pageSize = 20 }: { page?: number; pageSize?: number }) => ({
        data: { data: [], total, page, pageSize },
        isLoading: false,
        isFetching: false,
        isPlaceholderData: false,
      }),
    );
    const props = {
      range: { preset: "today" } as UsageRangeSelection,
      rangeLabel: "Today",
      appType: "all",
      refreshIntervalMs: 0,
    };
    const { rerender } = render(<RequestLogTable {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "6" }));
    await waitFor(() =>
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 5 }),
      ),
    );

    total = 30;
    rerender(<RequestLogTable {...props} />);

    await waitFor(() =>
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1 }),
      ),
    );
  });

  it("keeps placeholder rows visible but disables stale-row interaction", () => {
    const onOpenRequestDetail = vi.fn();
    useRequestLogsMock.mockReturnValue({
      data: {
        data: [createRequestLog({ providerName: "Previous Provider" })],
        total: 1,
        page: 0,
        pageSize: 20,
      },
      isLoading: false,
      isFetching: true,
      isPlaceholderData: true,
    });

    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
        onOpenRequestDetail={onOpenRequestDetail}
      />,
    );

    expect(screen.getByText("更新中")).toBeInTheDocument();
    const row = screen.getByText("Previous Provider").closest("tr");
    expect(row).toHaveAttribute("aria-disabled", "true");
    fireEvent.doubleClick(row!);
    expect(onOpenRequestDetail).not.toHaveBeenCalled();
  });

  it("resets pagination when the dashboard range changes", async () => {
    const initialRange: UsageRangeSelection = { preset: "today" };
    const nextRange: UsageRangeSelection = {
      preset: "custom",
      customStartDate: 1_710_000_000,
      customEndDate: 1_710_086_400,
    };

    const { rerender } = render(
      <RequestLogTable
        range={initialRange}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          range: initialRange,
        }),
      );
    });

    rerender(
      <RequestLogTable
        range={nextRange}
        rangeLabel="Custom"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 0,
          range: nextRange,
        }),
      );
    });
  });

  it("resets pagination when the dashboard app filter changes", async () => {
    const range: UsageRangeSelection = { preset: "today" };
    const { rerender } = render(
      <RequestLogTable
        range={range}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          range,
        }),
      );
    });

    rerender(
      <RequestLogTable
        range={range}
        rangeLabel="Today"
        appType="claude"
        refreshIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 0,
          range,
        }),
      );
    });
  });

  it("keeps the session suffix in provider names for session-imported logs", () => {
    useRequestLogsMock.mockReturnValue({
      data: {
        data: [
          {
            requestId: "req-1",
            providerId: "_codex_session",
            providerName: "Codex (Session)",
            appType: "codex",
            model: "gpt-5",
            requestModel: "gpt-5",
            costMultiplier: "1.0",
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            inputCostUsd: "0",
            outputCostUsd: "0",
            cacheReadCostUsd: "0",
            cacheCreationCostUsd: "0",
            totalCostUsd: "0",
            isStreaming: true,
            latencyMs: 0,
            statusCode: 200,
            createdAt: 1_710_000_000,
            dataSource: "codex_session",
          },
        ],
        total: 1,
        page: 0,
        pageSize: 20,
      },
      isLoading: false,
    });

    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    expect(screen.getByText("Codex (Session)")).toBeInTheDocument();
    expect(screen.getByText("codex_session")).toBeInTheDocument();
  });

  it("shows actual model first and request model as secondary text when they differ", () => {
    useRequestLogsMock.mockReturnValue({
      data: {
        data: [
          {
            requestId: "req-model-diff",
            providerId: "provider-1",
            providerName: "Provider One",
            appType: "codex",
            model: "gpt-5.3-codex",
            requestModel: "gpt-5.4",
            costMultiplier: "1.0",
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            inputCostUsd: "0",
            outputCostUsd: "0",
            cacheReadCostUsd: "0",
            cacheCreationCostUsd: "0",
            totalCostUsd: "0",
            isStreaming: true,
            latencyMs: 1000,
            statusCode: 200,
            createdAt: 1_710_000_100,
          },
        ],
        total: 1,
        page: 0,
        pageSize: 20,
      },
      isLoading: false,
    });

    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    expect(screen.getByText("gpt-5.3-codex")).toBeInTheDocument();
    expect(screen.getByText("请求模型: gpt-5.4")).toBeInTheDocument();
    expect(
      screen.queryByText(/gpt-5\.3-codex\s*→\s*gpt-5\.4/),
    ).not.toBeInTheDocument();
  });
});
