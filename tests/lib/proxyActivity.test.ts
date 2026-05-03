import { describe, expect, it } from "vitest";
import {
  getActivityDisplayModel,
  getActivityRequestModel,
  getActivityUpstreamModel,
  normalizeActiveRequestTargets,
  pruneProxyStatusProviderActivity,
} from "@/lib/proxyActivity";
import type { ActiveRequestTarget, ProxyStatus } from "@/types/proxy";

function target(
  overrides: Partial<ActiveRequestTarget> = {},
): ActiveRequestTarget {
  return {
    app_type: overrides.app_type ?? "codex",
    provider_id: overrides.provider_id ?? "provider-a",
    provider_name: overrides.provider_name ?? "Provider A",
    inflight_requests: overrides.inflight_requests ?? 1,
    request_model: overrides.request_model,
    upstream_model: overrides.upstream_model,
    last_request_model: overrides.last_request_model ?? "gpt-5.4",
    last_request_at:
      overrides.last_request_at ?? "2026-05-02T10:00:00.000000+00:00",
  };
}

describe("normalizeActiveRequestTargets", () => {
  it("exposes request/upstream/display model helpers with the new semantics", () => {
    const activityTarget = target({
      request_model: "gpt-5.4",
      upstream_model: "gpt-5.3-codex",
      last_request_model: "gpt-5.3-codex",
    });

    expect(getActivityRequestModel(activityTarget)).toBe("gpt-5.4");
    expect(getActivityUpstreamModel(activityTarget)).toBe("gpt-5.3-codex");
    expect(getActivityDisplayModel(activityTarget)).toBe("gpt-5.3-codex");
  });

  it("deduplicates the same app/provider and keeps the latest model", () => {
    const normalized = normalizeActiveRequestTargets(
      [
        target({
          request_model: "gpt-5.4",
          last_request_model: "gpt-5.4",
          last_request_at: "2026-05-02T10:00:00.000000+00:00",
          inflight_requests: 1,
        }),
        target({
          request_model: "gpt-5.4",
          upstream_model: "gpt-5.3-codex",
          last_request_model: "gpt-5.3-codex",
          last_request_at: "2026-05-02T10:00:01.000000+00:00",
          inflight_requests: 1,
        }),
      ],
      1,
    );

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.last_request_model).toBe("gpt-5.3-codex");
    expect(normalized[0]?.request_model).toBe("gpt-5.4");
    expect(normalized[0]?.upstream_model).toBe("gpt-5.3-codex");
    expect(normalized[0]?.inflight_requests).toBe(1);
  });

  it("collapses impossible multi-tag states when only one request is active", () => {
    const normalized = normalizeActiveRequestTargets(
      [
        target({
          provider_id: "provider-a",
          provider_name: "Provider A",
          last_request_at: "2026-05-02T10:00:00.000000+00:00",
        }),
        target({
          provider_id: "provider-b",
          provider_name: "Provider B",
          last_request_model: "gpt-5.3-codex",
          last_request_at: "2026-05-02T10:00:02.000000+00:00",
        }),
      ],
      1,
    );

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.provider_id).toBe("provider-b");
  });

  it("preserves multiple providers when multiple requests are active", () => {
    const normalized = normalizeActiveRequestTargets(
      [
        target({
          provider_id: "provider-a",
          provider_name: "Provider A",
        }),
        target({
          provider_id: "provider-b",
          provider_name: "Provider B",
          last_request_at: "2026-05-02T10:00:01.000000+00:00",
        }),
      ],
      2,
    );

    expect(normalized).toHaveLength(2);
    expect(normalized.map((item) => item.provider_id)).toEqual([
      "provider-b",
      "provider-a",
    ]);
  });
});

describe("pruneProxyStatusProviderActivity", () => {
  it("removes a disabled provider from active targets and request targets", () => {
    const status: ProxyStatus = {
      running: true,
      address: "127.0.0.1",
      port: 15721,
      active_connections: 1,
      total_requests: 10,
      success_requests: 9,
      failed_requests: 1,
      success_rate: 90,
      uptime_seconds: 120,
      current_provider: "Provider A",
      current_provider_id: "provider-a",
      last_request_at: "2026-05-02T10:00:03.000000+00:00",
      last_error: null,
      failover_count: 1,
      active_targets: [
        {
          app_type: "codex",
          provider_id: "provider-a",
          provider_name: "Provider A",
        },
        {
          app_type: "claude",
          provider_id: "provider-c",
          provider_name: "Provider C",
        },
      ],
      active_request_count: 2,
      active_request_targets: [
        target({
          provider_id: "provider-a",
          provider_name: "Provider A",
          last_request_model: "gpt-5.4",
        }),
        target({
          provider_id: "provider-b",
          provider_name: "Provider B",
          last_request_model: "gpt-5.3-codex",
          last_request_at: "2026-05-02T10:00:03.000000+00:00",
        }),
      ],
    };

    const next = pruneProxyStatusProviderActivity(
      status,
      "codex",
      "provider-a",
    );

    expect(next?.active_request_count).toBe(1);
    expect(next?.active_targets).toEqual([
      {
        app_type: "claude",
        provider_id: "provider-c",
        provider_name: "Provider C",
      },
    ]);
    expect(next?.active_request_targets).toEqual([
      target({
        provider_id: "provider-b",
        provider_name: "Provider B",
        last_request_model: "gpt-5.3-codex",
        last_request_at: "2026-05-02T10:00:03.000000+00:00",
      }),
    ]);
  });
});
