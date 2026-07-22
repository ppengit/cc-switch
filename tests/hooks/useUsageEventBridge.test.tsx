import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUsageEventBridge } from "@/hooks/useUsageEventBridge";
import { emitTauriEvent, resetTauriEventListeners } from "../msw/tauriMocks";

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useUsageEventBridge", () => {
  beforeEach(() => {
    resetTauriEventListeners();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T00:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("coalesces bursts into one immediate and one trailing refresh", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useUsageEventBridge(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitTauriEvent("usage-log-recorded", {});
      emitTauriEvent("usage-log-recorded", {});
      emitTauriEvent("usage-log-recorded", {});
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenLastCalledWith({
      queryKey: ["usage"],
      refetchType: "active",
    });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending trailing refresh when the dashboard unmounts", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { unmount } = renderHook(() => useUsageEventBridge(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emitTauriEvent("usage-log-recorded", {});
      emitTauriEvent("usage-log-recorded", {});
    });
    expect(invalidate).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("cancels an older trailing refresh when a new event reaches the interval boundary", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useUsageEventBridge(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await Promise.resolve();
    });

    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    act(() => {
      emitTauriEvent("usage-log-recorded", {});
      now = 500;
      emitTauriEvent("usage-log-recorded", {});
      now = 1000;
      emitTauriEvent("usage-log-recorded", {});
    });

    expect(invalidate).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
