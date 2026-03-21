import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RequestLog } from "@/types/usage";
import type { SessionMeta } from "@/types";
import { RequestLogTable } from "@/components/usage/RequestLogTable";
import { TooltipProvider } from "@/components/ui/tooltip";

const useRequestLogsMock = vi.fn();
const useRequestLogCleanupConfigMock = vi.fn();
const useUpdateRequestLogCleanupConfigMock = vi.fn();
const useCleanupRequestLogsNowMock = vi.fn();
const useClearRequestLogsAllMock = vi.fn();
const useSessionsQueryMock = vi.fn();

vi.mock("@/lib/query/usage", () => ({
  usageKeys: {
    logs: () => ["usage", "logs"],
  },
  useRequestLogs: (...args: unknown[]) => useRequestLogsMock(...args),
  useRequestLogCleanupConfig: (...args: unknown[]) =>
    useRequestLogCleanupConfigMock(...args),
  useUpdateRequestLogCleanupConfig: (...args: unknown[]) =>
    useUpdateRequestLogCleanupConfigMock(...args),
  useCleanupRequestLogsNow: (...args: unknown[]) =>
    useCleanupRequestLogsNowMock(...args),
  useClearRequestLogsAll: (...args: unknown[]) =>
    useClearRequestLogsAllMock(...args),
}));

vi.mock("@/lib/query", () => ({
  useSessionsQuery: (...args: unknown[]) => useSessionsQueryMock(...args),
}));

vi.mock("@/components/usage/RequestDetailPanel", () => ({
  RequestDetailPanel: () => null,
}));

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const baseRequestLog: RequestLog = {
  requestId: "req-1",
  providerId: "provider-1",
  providerName: "Provider One",
  appType: "claude",
  model: "claude-sonnet-4",
  requestModel: "claude-sonnet-4",
  costMultiplier: "1",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  inputCostUsd: "0.1",
  outputCostUsd: "0.2",
  cacheReadCostUsd: "0",
  cacheCreationCostUsd: "0",
  totalCostUsd: "0.3",
  isStreaming: true,
  latencyMs: 800,
  firstTokenMs: 300,
  durationMs: 1200,
  statusCode: 200,
  errorMessage: "",
  sessionId: "session-12345678",
  sessionRoutingActive: true,
  createdAt: 1_700_000_000,
};

beforeEach(() => {
  useRequestLogsMock.mockReset();
  useRequestLogCleanupConfigMock.mockReset();
  useUpdateRequestLogCleanupConfigMock.mockReset();
  useCleanupRequestLogsNowMock.mockReset();
  useClearRequestLogsAllMock.mockReset();
  useSessionsQueryMock.mockReset();

  useRequestLogsMock.mockReturnValue({
    data: {
      data: [baseRequestLog],
      total: 1,
      page: 0,
      pageSize: 20,
    },
    isLoading: false,
  });
  useRequestLogCleanupConfigMock.mockReturnValue({
    data: {
      enabled: true,
      retentionDays: 30,
      lastCleanupAt: null,
    },
  });
  useUpdateRequestLogCleanupConfigMock.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
  useCleanupRequestLogsNowMock.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
  useClearRequestLogsAllMock.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
  useSessionsQueryMock.mockReturnValue({ data: [] as SessionMeta[] });
});

describe("RequestLogTable", () => {
  it("shows the session title for session-routed logs when session metadata is available", () => {
    useSessionsQueryMock.mockReturnValue({
      data: [
        {
          providerId: "claude",
          sessionId: "session-12345678",
          title: "Feature Task",
          projectDir: "/workspace/demo-project",
        },
      ] satisfies SessionMeta[],
    });

    renderWithQueryClient(<RequestLogTable refreshIntervalMs={0} />);

    expect(screen.getByText("Feature Task")).toBeInTheDocument();
    expect(screen.getByText("session-12345678")).toBeInTheDocument();
    expect(screen.getByText("Provider One")).toBeInTheDocument();
  });
});
