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
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
}));

const createLog = (
  overrides: Partial<ProxyRawLogEntry> = {},
): ProxyRawLogEntry => ({
  id: overrides.id ?? 1,
  timestamp: overrides.timestamp ?? "2026-05-03T10:00:00.000Z",
  startedAt: overrides.startedAt ?? "2026-05-03T10:00:00.000Z",
  updatedAt:
    overrides.updatedAt ??
    overrides.timestamp ??
    "2026-05-03T10:00:00.000Z",
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
  events:
    overrides.events ??
    [
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
});
