import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useClearRequestLogs } from "@/lib/query/usage";
import type { PaginatedLogs } from "@/types/usage";

const clearRequestLogsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    clearRequestLogs: clearRequestLogsMock,
  },
}));

describe("useClearRequestLogs", () => {
  beforeEach(() => {
    clearRequestLogsMock.mockReset();
    clearRequestLogsMock.mockResolvedValue(2);
  });

  it("clears every cached request-log page before background invalidation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const firstPageKey = ["usage", "logs", "today", 0] as const;
    const secondPageKey = ["usage", "logs", "today", 1] as const;
    const summaryKey = ["usage", "summary", "today"] as const;
    const page = (pageNumber: number): PaginatedLogs => ({
      data: [
        { requestId: `request-${pageNumber}` } as PaginatedLogs["data"][number],
      ],
      total: 2,
      page: pageNumber,
      pageSize: 20,
    });
    queryClient.setQueryData(firstPageKey, page(0));
    queryClient.setQueryData(secondPageKey, page(1));
    queryClient.setQueryData(summaryKey, { totalRequests: 2 });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useClearRequestLogs(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    for (const key of [firstPageKey, secondPageKey]) {
      expect(queryClient.getQueryData<PaginatedLogs>(key)).toEqual({
        data: [],
        total: 0,
        page: 0,
        pageSize: 20,
      });
    }
    expect(queryClient.getQueryData(summaryKey)).toEqual({ totalRequests: 2 });
  });
});
