import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import type { ProxyActivityEvent, ProxyStatus } from "@/types/proxy";

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
          queryClient.setQueryData<ProxyStatus | undefined>(
            ["proxyStatus"],
            (current) => {
              if (!current) return current;
              return {
                ...current,
                active_request_count: payload.active_request_count,
                active_request_targets: payload.active_request_targets,
                last_request_at:
                  payload.active_request_targets[0]?.last_request_at ??
                  current.last_request_at,
              };
            },
          );
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
