import type { ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  useAddToFailoverQueue,
  useProviderRuntimeStatuses,
  useRemoveFromFailoverQueue,
} from "@/lib/query/failover";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

interface WrapperProps {
  children: ReactNode;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const wrapper = ({ children }: WrapperProps) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { wrapper, queryClient };
}

describe("failover queue mutations", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("loads all provider runtime statuses through one batched command", async () => {
    invokeMock.mockResolvedValue({ health: {}, circuitBreakers: {} });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useProviderRuntimeStatuses("codex", true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_provider_runtime_statuses", {
      appType: "codex",
    });
  });

  it("refreshes proxy status after adding a provider to the failover queue", async () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useAddToFailoverQueue(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        appType: "codex",
        providerId: "provider-a",
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["proxyStatus"],
    });
  });

  it("refreshes proxy status after removing a provider from the failover queue", async () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRemoveFromFailoverQueue(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        appType: "codex",
        providerId: "provider-a",
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["proxyStatus"],
    });
  });
});
