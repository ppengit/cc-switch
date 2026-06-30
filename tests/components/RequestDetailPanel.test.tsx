import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestDetailPanel } from "@/components/usage/RequestDetailPanel";
import type { RequestLog } from "@/types/usage";

const useRequestDetailMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { defaultValue?: string },
    ) => {
      if (typeof options === "string") {
        return options;
      }
      return options?.defaultValue ?? key;
    },
    i18n: {
      language: "zh",
    },
  }),
}));

vi.mock("@/lib/query/usage", () => ({
  useRequestDetail: (requestId: string) => useRequestDetailMock(requestId),
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
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogClose: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

const createRequest = (overrides: Partial<RequestLog> = {}): RequestLog => ({
  requestId: overrides.requestId ?? "req-1",
  providerId: overrides.providerId ?? "provider-1",
  providerName: overrides.providerName ?? "Provider One",
  appType: overrides.appType ?? "codex",
  model: overrides.model ?? "gpt-5.3-codex",
  requestModel: overrides.requestModel ?? "gpt-5.4",
  costMultiplier: overrides.costMultiplier ?? "1.0",
  inputTokens: overrides.inputTokens ?? 100,
  outputTokens: overrides.outputTokens ?? 50,
  cacheReadTokens: overrides.cacheReadTokens ?? 0,
  cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
  inputCostUsd: overrides.inputCostUsd ?? "0.001",
  outputCostUsd: overrides.outputCostUsd ?? "0.002",
  cacheReadCostUsd: overrides.cacheReadCostUsd ?? "0",
  cacheCreationCostUsd: overrides.cacheCreationCostUsd ?? "0",
  totalCostUsd: overrides.totalCostUsd ?? "0.003",
  isStreaming: overrides.isStreaming ?? true,
  latencyMs: overrides.latencyMs ?? 1200,
  firstTokenMs: overrides.firstTokenMs ?? 400,
  durationMs: overrides.durationMs ?? 1200,
  statusCode: overrides.statusCode ?? 200,
  createdAt: overrides.createdAt ?? 1_710_000_000,
  sessionId: overrides.sessionId ?? "session-1",
  sessionTitle: overrides.sessionTitle ?? "Session One",
  projectPath: overrides.projectPath ?? "/mock/project",
  dataSource: overrides.dataSource ?? "proxy",
});

describe("RequestDetailPanel", () => {
  beforeEach(() => {
    useRequestDetailMock.mockReset();
  });

  it("uses the initial request summary while loading the fuller detail", () => {
    useRequestDetailMock.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
    });

    render(
      <RequestDetailPanel
        requestId="req-1"
        initialRequest={createRequest()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("正在加载更完整的请求详情，当前先展示列表摘要。")).toBeInTheDocument();
    expect(screen.getByText("Provider One")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.3-codex")).toBeInTheDocument();
  });

  it("shows the fallback notice when loading detail fails but a summary exists", () => {
    useRequestDetailMock.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error("detail failed"),
    });

    render(
      <RequestDetailPanel
        requestId="req-1"
        initialRequest={createRequest()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("详细记录读取失败，当前展示的是列表中的摘要信息。")).toBeInTheDocument();
    expect(screen.getByText("req-1")).toBeInTheDocument();
    expect(screen.getByText("Session One")).toBeInTheDocument();
  });

  it("shows actual model and request model as separate fields", () => {
    useRequestDetailMock.mockReturnValue({
      data: createRequest({
        requestId: "req-2",
        model: "gpt-5.3-codex",
        requestModel: "gpt-5.4",
      }),
      isLoading: false,
      error: null,
    });

    render(
      <RequestDetailPanel requestId="req-2" onClose={vi.fn()} />,
    );

    expect(screen.getByText("实际模型")).toBeInTheDocument();
    expect(screen.getByText("请求模型")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.3-codex")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.4")).toBeInTheDocument();
  });
});
