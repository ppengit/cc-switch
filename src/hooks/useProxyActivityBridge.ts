import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { providersApi } from "@/lib/api/providers";
import type { AppId } from "@/lib/api/types";
import type { Provider } from "@/types";
import type {
  ProviderAdmissionRetryEvent,
  ProxyActivityEvent,
  ProxyStatus,
} from "@/types/proxy";
import {
  normalizeActiveRequestTargets,
  pruneProxyStatusProviderActivity,
} from "@/lib/proxyActivity";

const APP_LABELS: Record<AppId, string> = {
  claude: "Claude",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

interface ProvidersCacheEntry {
  providers: Record<string, Provider>;
  currentProviderId: string;
}

let admissionRetryAudioContext: AudioContext | null = null;

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
    last_request_at: payload.active_request_targets[0]?.last_request_at ?? null,
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

function isAppId(value: string): value is AppId {
  return Object.prototype.hasOwnProperty.call(APP_LABELS, value);
}

async function getAdmissionRetryProvider(
  queryClient: QueryClient,
  appId: AppId,
  providerId: string,
): Promise<Provider | undefined> {
  const cached = queryClient.getQueryData<ProvidersCacheEntry>([
    "providers",
    appId,
  ]);
  const cachedProvider = cached?.providers?.[providerId];
  if (cachedProvider) return cachedProvider;

  try {
    const providers = await providersApi.getAll(appId);
    return providers[providerId];
  } catch {
    return undefined;
  }
}

function playAdmissionRetrySuccessTone() {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
    return;
  }

  try {
    admissionRetryAudioContext ??= new window.AudioContext();
    const ctx = admissionRetryAudioContext;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }

    const startedAt = ctx.currentTime + 0.01;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, startedAt);
    oscillator.frequency.exponentialRampToValueAtTime(1320, startedAt + 0.12);

    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(0.08, startedAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.24);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startedAt);
    oscillator.stop(startedAt + 0.25);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  } catch {
    // 桌面环境不支持音频上下文时静默降级，只保留弹窗提示。
  }
}

async function maybeNotifyAdmissionRetrySuccess(
  queryClient: QueryClient,
  payload: ProviderAdmissionRetryEvent,
) {
  if (payload.event !== "admitted" || !isAppId(payload.appType)) {
    return;
  }

  const provider = await getAdmissionRetryProvider(
    queryClient,
    payload.appType,
    payload.providerId,
  );
  if (provider?.meta?.upstreamAdmissionRetry?.notifyOnSuccess !== true) {
    return;
  }

  playAdmissionRetrySuccessTone();
  const retrySuffix =
    payload.retryCount > 0 ? `，累计重试 ${payload.retryCount} 次` : "";
  toast.success(`${APP_LABELS[payload.appType]} 入场成功`, {
    id: `admission-retry-admitted-${payload.requestId}`,
    position: "bottom-right",
    duration: 6000,
    description: `${payload.providerName} 已成功进入上游${retrySuffix}。现在可以回到对应 CLI 继续会话。`,
  });
}

/**
 * 把后端实时代理活动事件同步到 React Query 的 proxyStatus 缓存。
 *
 * 目标是让 UI 不必等下一次轮询，就能立即看到“当前是否有请求、谁在处理”。
 */
export function useProxyActivityBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let disposed = false;

    (async () => {
      const [activityOff, admissionRetryOff] = await Promise.all([
        listen<ProxyActivityEvent>("proxy-activity-updated", (event) => {
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
        }),
        listen<ProviderAdmissionRetryEvent>("provider-admission-retry", (event) => {
          const payload = event.payload;
          void maybeNotifyAdmissionRetrySuccess(queryClient, payload);
          queryClient.invalidateQueries({
            queryKey: ["usage", "raw-proxy-logs"],
          });
        }),
      ]);

      if (disposed) {
        activityOff();
        admissionRetryOff();
      } else {
        unlisteners = [activityOff, admissionRetryOff];
      }
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((off) => off());
    };
  }, [queryClient]);
}
