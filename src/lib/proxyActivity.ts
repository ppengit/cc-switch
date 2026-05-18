import type { ActiveRequestTarget, ProxyStatus } from "@/types/proxy";

function normalizeModelValue(value?: string | null): string | undefined {
  const trimmed = (value || "").trim();
  return trimmed || undefined;
}

export function getActivityRequestModel(
  target: Pick<ActiveRequestTarget, "request_model">,
): string | undefined {
  return normalizeModelValue(target.request_model);
}

export function getActivityUpstreamModel(
  target: Pick<
    ActiveRequestTarget,
    "request_model" | "upstream_model" | "last_request_model"
  >,
): string | undefined {
  const explicitUpstream = normalizeModelValue(target.upstream_model);
  if (explicitUpstream) {
    return explicitUpstream;
  }

  const fallbackDisplay = normalizeModelValue(target.last_request_model);
  const requestModel = normalizeModelValue(target.request_model);
  if (fallbackDisplay && fallbackDisplay !== requestModel) {
    return fallbackDisplay;
  }

  return undefined;
}

export function getActivityDisplayModel(target: ActiveRequestTarget): string | undefined {
  return (
    getActivityUpstreamModel(target) ??
    normalizeModelValue(target.last_request_model) ??
    getActivityRequestModel(target)
  );
}

function compareLastRequestAt(
  left?: string | null,
  right?: string | null,
): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right);
}

function sumInflightRequests(targets: ActiveRequestTarget[]): number {
  return targets.reduce(
    (total, target) => total + Math.max(0, target.inflight_requests),
    0,
  );
}

export function normalizeActiveRequestTargets(
  targets: ActiveRequestTarget[] | undefined,
  activeRequestCount?: number,
): ActiveRequestTarget[] {
  if (!targets?.length) {
    return [];
  }

  const grouped = new Map<string, ActiveRequestTarget>();

  for (const target of targets) {
    if (!target || target.inflight_requests <= 0) {
      continue;
    }

    const key = `${target.app_type}:${target.provider_id}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, { ...target });
      continue;
    }

    const incomingIsNewer =
      compareLastRequestAt(target.last_request_at, existing.last_request_at) >=
      0;

    grouped.set(key, {
      ...existing,
      ...(incomingIsNewer
        ? {
            provider_name: target.provider_name,
            request_model: target.request_model ?? existing.request_model,
            upstream_model: target.upstream_model ?? existing.upstream_model,
            route_mode: target.route_mode ?? existing.route_mode,
            upstream_url: target.upstream_url ?? existing.upstream_url,
            last_request_model:
              target.last_request_model ?? existing.last_request_model,
            last_request_at: target.last_request_at,
          }
        : {}),
      inflight_requests: Math.max(
        existing.inflight_requests,
        target.inflight_requests,
      ),
    });
  }

  let normalized = [...grouped.values()].sort((a, b) => {
    const byTime = compareLastRequestAt(b.last_request_at, a.last_request_at);
    if (byTime !== 0) return byTime;
    const byApp = a.app_type.localeCompare(b.app_type);
    if (byApp !== 0) return byApp;
    return a.provider_name.localeCompare(b.provider_name);
  });

  if ((activeRequestCount ?? 0) <= 1 && normalized.length > 1) {
    normalized = normalized.slice(0, 1);
  }

  return normalized;
}

export function pruneProxyStatusProviderActivity(
  status: ProxyStatus | undefined,
  appType: string,
  providerId: string,
): ProxyStatus | undefined {
  if (!status) {
    return status;
  }

  const normalizedTargets = normalizeActiveRequestTargets(
    status.active_request_targets,
    status.active_request_count,
  );
  const remainingTargets = normalizedTargets.filter(
    (target) =>
      !(target.app_type === appType && target.provider_id === providerId),
  );
  const removedCount =
    sumInflightRequests(normalizedTargets) -
    sumInflightRequests(remainingTargets);
  const filteredActiveTargets = status.active_targets?.filter(
    (target) =>
      !(target.app_type === appType && target.provider_id === providerId),
  );
  const activeTargetsChanged =
    (filteredActiveTargets?.length ?? 0) !==
    (status.active_targets?.length ?? 0);

  if (removedCount === 0 && !activeTargetsChanged) {
    return status;
  }

  const remainingCount = sumInflightRequests(remainingTargets);
  const currentCount = Math.max(
    status.active_request_count ?? 0,
    sumInflightRequests(normalizedTargets),
  );

  return {
    ...status,
    active_targets: filteredActiveTargets,
    active_request_targets: remainingTargets,
    active_request_count: Math.max(
      0,
      currentCount - removedCount,
      remainingCount,
    ),
    last_request_at:
      remainingTargets[0]?.last_request_at ??
      (remainingCount > 0 ? status.last_request_at : null),
  };
}
