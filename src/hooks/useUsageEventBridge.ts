import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { usageKeys } from "@/lib/query/usage";

const USAGE_INVALIDATION_MIN_INTERVAL_MS = 1000;

/**
 * 监听后端 `usage-log-recorded` 事件，收到后立刻 invalidate 所有
 * UsageDashboard 相关查询，让用户无需等待 30s 轮询周期。
 *
 * 后端在 `proxy_request_logs` 写入新行时会 emit 该事件（200ms 防抖合并），
 * 来源覆盖代理日志、Claude/Codex/Gemini 会话同步、启动归档。
 *
 * 该 hook 只挂在 UsageDashboard 上，避免在主界面其他位置无意义触发。
 */
export function useUsageEventBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    let lastInvalidatedAt: number | null = null;
    let pendingInvalidation: ReturnType<typeof setTimeout> | undefined;

    const invalidateActiveUsageQueries = () => {
      if (disposed) return;
      lastInvalidatedAt = performance.now();
      pendingInvalidation = undefined;
      void queryClient.invalidateQueries({
        queryKey: usageKeys.all,
        refetchType: "active",
      });
    };

    const scheduleUsageInvalidation = () => {
      const now = performance.now();
      if (
        lastInvalidatedAt === null ||
        now - lastInvalidatedAt >= USAGE_INVALIDATION_MIN_INTERVAL_MS
      ) {
        if (pendingInvalidation !== undefined) {
          clearTimeout(pendingInvalidation);
          pendingInvalidation = undefined;
        }
        invalidateActiveUsageQueries();
        return;
      }

      if (pendingInvalidation !== undefined) return;
      pendingInvalidation = setTimeout(
        invalidateActiveUsageQueries,
        Math.ceil(
          USAGE_INVALIDATION_MIN_INTERVAL_MS - (now - lastInvalidatedAt),
        ),
      );
    };

    (async () => {
      const off = await listen("usage-log-recorded", () => {
        // 高频请求完成事件只触发一次即时刷新，并把同一秒内的后续事件合并为
        // 一次尾随刷新，避免统计聚合与图表渲染持续占满 WebView。
        scheduleUsageInvalidation();
      });

      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    })();

    return () => {
      disposed = true;
      if (pendingInvalidation !== undefined) {
        clearTimeout(pendingInvalidation);
      }
      unlisten?.();
    };
  }, [queryClient]);
}
