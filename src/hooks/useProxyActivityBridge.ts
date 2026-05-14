import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import type { ProxyActivityEvent, ProxyStatus } from "@/types/proxy";
import {
  normalizeActiveRequestTargets,
  pruneProxyStatusProviderActivity,
} from "@/lib/proxyActivity";

function createStatusFromActivity(payload: ProxyActivityEvent): ProxyStatus {
  return {
    running: payload.active_request_count > 0,
    address: "",
    port: 0,
    active_connections: payload.active_request_count,
    total_requests: 0,
    success_requests: 0,
    failed_requests: 0,
    success_rate: 0,
    uptime_seconds: 0,
    current_provider: payload.provider_name || null,
    current_provider_id: payload.provider_id || null,
    last_request_at:
      payload.active_request_targets[0]?.last_request_at ?? null,
    last_error: payload.error ?? null,
    failover_count: 0,
    active_targets: payload.active_request_targets.map((target) => ({
      app_type: target.app_type,
      provider_id: target.provider_id,
      provider_name: target.provider_name,
    })),
    active_request_count: payload.active_request_count,
    active_request_targets: payload.active_request_targets,
  };
}

/**
 * 把后端实时代理活动事件同步到 React Query 的 proxyStatus 缓存。
 *
 * 目标是让 UI 不必等下一次轮询，就能立即看到“当前是否有请求、谁在处理”。
 */
export function useProxyActivityBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    (async () => {
      const off = await listen<ProxyActivityEvent>(
        "proxy-activity-updated",
        (event) => {
          const payload = event.payload;
          const normalizedTargets = normalizeActiveRequestTargets(
            payload.active_request_targets,
            payload.active_request_count,
          );
          queryClient.setQueryData<ProxyStatus | undefined>(
            ["proxyStatus"],
            (current) => {
              if (!current) {
                const created = createStatusFromActivity({
                  ...payload,
                  active_request_targets: normalizedTargets,
                });
                if (payload.event === "cleared") {
                  return (
                    pruneProxyStatusProviderActivity(
                      created,
                      payload.app_type,
                      payload.provider_id,
                    ) ?? created
                  );
                }
                return created;
              }
              const next: ProxyStatus = {
                ...current,
                running: current.running || payload.active_request_count > 0,
                active_request_count: payload.active_request_count,
                active_request_targets: normalizedTargets,
                last_request_at:
                  normalizedTargets[0]?.last_request_at ??
                  current.last_request_at,
              };
              if (payload.event === "cleared") {
                return (
                  pruneProxyStatusProviderActivity(
                    next,
                    payload.app_type,
                    payload.provider_id,
                  ) ?? next
                );
              }
              return next;
            },
          );
          queryClient.invalidateQueries({
            queryKey: ["usage", "raw-proxy-logs"],
          });
        },
      );

      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);
}
