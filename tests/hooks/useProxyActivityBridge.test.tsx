import type { ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { useProxyActivityBridge } from "@/hooks/useProxyActivityBridge";
import type { ProxyStatus } from "@/types/proxy";
import { emitTauriEvent } from "../msw/tauriMocks";

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

describe("useProxyActivityBridge", () => {
  it("creates proxyStatus cache when the first activity event arrives before polling", async () => {
    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useProxyActivityBridge(), { wrapper });

    await act(async () => {
      emitTauriEvent("proxy-activity-updated", {
        request_id: "req-1",
        event: "routed",
        app_type: "claude",
        provider_name: "Claude Custom",
        provider_id: "claude-2",
        request_model: "claude-sonnet-4-5",
        upstream_model: "gpt-5.4",
        status_code: null,
        error: null,
        active_request_count: 1,
        active_request_targets: [
          {
            app_type: "claude",
            provider_name: "Claude Custom",
            provider_id: "claude-2",
            inflight_requests: 1,
            request_model: "claude-sonnet-4-5",
            upstream_model: "gpt-5.4",
            last_request_model: "gpt-5.4",
            last_request_at: "2026-05-14T11:30:00Z",
          },
        ],
      });
    });

    await waitFor(() => {
      const status = queryClient.getQueryData<ProxyStatus>(["proxyStatus"]);
      expect(status?.running).toBe(true);
      expect(status?.active_request_count).toBe(1);
      expect(status?.active_request_targets?.[0]?.provider_id).toBe(
        "claude-2",
      );
    });
  });

  it("marks proxyStatus as running when activity arrives after a stopped snapshot", async () => {
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData<ProxyStatus>(["proxyStatus"], {
      running: false,
      address: "127.0.0.1",
      port: 15721,
      active_connections: 0,
      total_requests: 0,
      success_requests: 0,
      failed_requests: 0,
      success_rate: 0,
      uptime_seconds: 0,
      current_provider: null,
      current_provider_id: null,
      last_request_at: null,
      last_error: null,
      failover_count: 0,
      active_targets: [],
      active_request_count: 0,
      active_request_targets: [],
    });
    renderHook(() => useProxyActivityBridge(), { wrapper });

    await act(async () => {
      emitTauriEvent("proxy-activity-updated", {
        request_id: "req-2",
        event: "routed",
        app_type: "codex",
        provider_name: "Codex Secondary",
        provider_id: "codex-2",
        request_model: "gpt-5.4",
        upstream_model: null,
        status_code: null,
        error: null,
        active_request_count: 1,
        active_request_targets: [
          {
            app_type: "codex",
            provider_name: "Codex Secondary",
            provider_id: "codex-2",
            inflight_requests: 1,
            request_model: "gpt-5.4",
            upstream_model: null,
            last_request_model: "gpt-5.4",
            last_request_at: "2026-05-14T11:31:00Z",
          },
        ],
      });
    });

    await waitFor(() => {
      const status = queryClient.getQueryData<ProxyStatus>(["proxyStatus"]);
      expect(status?.running).toBe(true);
      expect(status?.active_request_targets?.[0]?.provider_id).toBe("codex-2");
    });
  });
});
