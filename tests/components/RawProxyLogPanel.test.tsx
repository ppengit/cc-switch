import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RawProxyLogPanel } from "@/components/usage/RawProxyLogPanel";
import type { ProxyRawLogEntry, ProxyRawLogEvent } from "@/types/proxy";

const useProxyRawLogsMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string;
        error?: string;
      },
    ) => options?.defaultValue ?? key,
    i18n: {
      resolvedLanguage: "zh",
    },
  }),
}));

vi.mock("@/lib/query/usage", () => ({
  useProxyRawLogs: (...args: unknown[]) => useProxyRawLogsMock(...args),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: any) => <table>{children}</table>,
  TableBody: ({ children }: any) => <tbody>{children}</tbody>,
  TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
  TableHead: ({ children, ...props }: any) => <th {...props}>{children}</th>,
  TableHeader: ({ children }: any) => <thead>{children}</thead>,
  TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: any) =>
    open ? (
      <div>
        <button
          data-testid="dialog-outside"
          type="button"
          onClick={() => onOpenChange?.(false)}
        />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogClose: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

const createLog = (
  overrides: Partial<ProxyRawLogEntry> = {},
): ProxyRawLogEntry => ({
  id: overrides.id ?? 1,
  timestamp: overrides.timestamp ?? "2026-05-03T10:00:00.000Z",
  startedAt: overrides.startedAt ?? "2026-05-03T10:00:00.000Z",
  updatedAt:
    overrides.updatedAt ?? overrides.timestamp ?? "2026-05-03T10:00:00.000Z",
  requestId: overrides.requestId ?? "req-1",
  event: overrides.event ?? "routed",
  appType: overrides.appType ?? "codex",
  providerName: overrides.providerName ?? "Provider One",
  providerId: overrides.providerId ?? "provider-1",
  requestModel: overrides.requestModel ?? "gpt-5.4",
  upstreamModel: overrides.upstreamModel,
  statusCode: overrides.statusCode,
  error: overrides.error,
  activeRequestCount: overrides.activeRequestCount ?? 1,
  activeTargetCount: overrides.activeTargetCount ?? 1,
  events: overrides.events ?? [
    {
      id: overrides.id ?? 1,
      timestamp: overrides.timestamp ?? "2026-05-03T10:00:00.000Z",
      event: overrides.event ?? "routed",
      appType: overrides.appType ?? "codex",
      providerName: overrides.providerName ?? "Provider One",
      providerId: overrides.providerId ?? "provider-1",
      requestModel: overrides.requestModel ?? "gpt-5.4",
      upstreamModel: overrides.upstreamModel,
      statusCode: overrides.statusCode,
      error: overrides.error,
      activeRequestCount: overrides.activeRequestCount ?? 1,
      activeTargetCount: overrides.activeTargetCount ?? 1,
    } satisfies ProxyRawLogEvent,
  ],
});

describe("RawProxyLogPanel", () => {
  beforeEach(() => {
    useProxyRawLogsMock.mockReset();
    useProxyRawLogsMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
      isPlaceholderData: false,
    });
  });

  it("keeps the themed table shell visible during the initial load", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
      isFetching: true,
      isPlaceholderData: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    expect(screen.getByText("时间")).toBeInTheDocument();
    expect(screen.getAllByTestId("raw-proxy-log-loading-row")).toHaveLength(8);
  });

  it("keeps placeholder rows visible but disables stale-row interaction", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [createLog({ providerName: "Previous Raw Provider" })],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: true,
      isPlaceholderData: true,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    const row = screen.getByText("Previous Raw Provider").closest("tr");
    expect(row).toHaveAttribute("aria-disabled", "true");
    fireEvent.doubleClick(row!);
    expect(screen.queryByText("代理原始日志详情")).not.toBeInTheDocument();
  });

  it("uses the dashboard refresh interval instead of polling raw logs per event", () => {
    render(<RawProxyLogPanel appType="codex" refreshIntervalMs={30_000} />);

    expect(useProxyRawLogsMock).toHaveBeenCalledWith("codex", 50, {
      refetchInterval: 30_000,
    });
  });

  it("filters internal cleared events and shows upstream model with request model when they differ", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [
        createLog({
          id: 1,
          event: "cleared",
          providerName: "Hidden Provider",
        }),
        createLog({
          id: 2,
          event: "finished",
          providerName: "Visible Provider",
          requestModel: "gpt-5.4",
          upstreamModel: "gpt-5.3-codex",
        }),
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    expect(screen.queryByText("Hidden Provider")).not.toBeInTheDocument();
    expect(screen.getByText("Visible Provider")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.3-codex")).toBeInTheDocument();
    expect(screen.getByText("请求模型: gpt-5.4")).toBeInTheDocument();
  });

  it("falls back to request model when upstream model is absent", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [
        createLog({
          id: 3,
          providerName: "Request Model Provider",
          requestModel: "gpt-5.4-mini",
          upstreamModel: null,
        }),
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    expect(screen.getByText("gpt-5.4-mini")).toBeInTheDocument();
  });

  it("renders multiple admission retry rows even when request ids are duplicated", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [
        createLog({
          id: 10,
          requestId: "req-shared",
          event: "admission_retry",
          providerName: "Retry Attempt 1",
          retryCount: 1,
          delayMs: 300,
        }),
        createLog({
          id: 11,
          requestId: "req-shared",
          event: "admission_retry",
          providerName: "Retry Attempt 2",
          retryCount: 2,
          delayMs: 300,
        }),
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    expect(screen.getByText("Retry Attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Retry Attempt 2")).toBeInTheDocument();
  });

  it("shows only the current raw log state instead of the full lifecycle", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [
        createLog({
          id: 6,
          requestId: "req-processing",
          event: "routed",
          providerName: "Processing Provider",
          events: [
            {
              id: 61,
              timestamp: "2026-05-03T10:00:00.000Z",
              event: "received",
              appType: "codex",
              providerName: "Processing Provider",
              providerId: "provider-1",
              activeRequestCount: 0,
              activeTargetCount: 0,
            },
            {
              id: 62,
              timestamp: "2026-05-03T10:00:01.000Z",
              event: "routed",
              appType: "codex",
              providerName: "Processing Provider",
              providerId: "provider-1",
              activeRequestCount: 1,
              activeTargetCount: 1,
            },
          ],
        }),
        createLog({
          id: 7,
          requestId: "req-success",
          event: "finished",
          providerName: "Success Provider",
          statusCode: 200,
        }),
        createLog({
          id: 8,
          requestId: "req-failed",
          event: "failed",
          providerName: "Failed Provider",
          statusCode: 503,
        }),
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    expect(screen.getByText("正在处理")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.queryByText("收到请求")).not.toBeInTheDocument();
    expect(screen.queryByText("开始路由")).not.toBeInTheDocument();
  });

  it("renders HTML errors in the shared static sandbox preview", async () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [
        createLog({
          id: 9,
          event: "failed",
          error:
            '<!doctype html><html><body><h1>Gateway error</h1><script>bad()</script><img src="https://bad.example/pixel"></body></html>',
        }),
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);
    fireEvent.click(screen.getByRole("button", { name: "查看错误页" }));

    const previewFrame = await screen.findByTitle("错误页预览");
    const previewDocument = previewFrame.getAttribute("srcdoc") ?? "";
    expect(previewFrame).toHaveAttribute("sandbox", "");
    expect(previewDocument).toContain("Gateway error");
    expect(previewDocument).not.toContain("https://bad.example");
    expect(previewDocument).not.toMatch(/<script\b/i);
  });

  it("opens the detail dialog on row double click", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [
        createLog({
          id: 4,
          requestId: "req-open-detail",
          providerName: "Detail Provider",
        }),
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    const row = screen.getByText("Detail Provider").closest("tr");
    expect(row).not.toBeNull();

    fireEvent.doubleClick(row!);

    expect(screen.getByText("代理原始日志详情")).toBeInTheDocument();
    expect(screen.getByText(/req-open-detail/)).toBeInTheDocument();
  });

  it("closes the detail dialog when clicking outside", () => {
    useProxyRawLogsMock.mockReturnValue({
      data: [
        createLog({
          id: 5,
          requestId: "req-close-detail",
          providerName: "Closable Provider",
        }),
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });

    render(<RawProxyLogPanel refreshIntervalMs={0} />);

    const row = screen.getByText("Closable Provider").closest("tr");
    expect(row).not.toBeNull();

    fireEvent.doubleClick(row!);
    expect(screen.getByText("代理原始日志详情")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("dialog-outside"));

    expect(screen.queryByText("代理原始日志详情")).not.toBeInTheDocument();
    expect(screen.queryByText(/req-close-detail/)).not.toBeInTheDocument();
  });
});
