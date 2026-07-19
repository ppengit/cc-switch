import type { ProviderUpstreamResponseReplay } from "@/types";

/**
 * Defaults are editor seed data, not matcher logic. The backend applies the
 * same values when an older provider record omits the new variables.
 */
export const DEFAULT_RESPONSE_REPLAY_MATCH_STATUSES = [400] as const;
export const DEFAULT_RESPONSE_REPLAY_MATCH_ENDPOINTS = ["/responses"] as const;
export const DEFAULT_RESPONSE_REPLAY_MATCH_KEYWORD_GROUPS = [
  ["bad_response_status_code"],
  ["new_api_error", "invalid character", "looking for beginning of value"],
] as const;

export const RESPONSE_REPLAY_MATCH_LIMITS = {
  statuses: 16,
  endpoints: 16,
  groups: 16,
  termsPerGroup: 8,
  textLength: 128,
} as const;

export const DEFAULT_RESPONSE_REPLAY_EDITOR_CONFIG = {
  enabled: false,
  retryHttp429: true,
  retryCodexConfiguredErrors: true,
  codexMatchStatuses: [...DEFAULT_RESPONSE_REPLAY_MATCH_STATUSES],
  codexMatchEndpoints: [...DEFAULT_RESPONSE_REPLAY_MATCH_ENDPOINTS],
  codexMatchKeywordGroups: DEFAULT_RESPONSE_REPLAY_MATCH_KEYWORD_GROUPS.map(
    (group) => [...group],
  ),
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 5_000,
  jitterMs: 100,
  honorRetryAfter: true,
} satisfies ProviderUpstreamResponseReplay;

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed.length === 0 ||
    trimmed.length > RESPONSE_REPLAY_MATCH_LIMITS.textLength
  ) {
    return undefined;
  }
  return trimmed;
}

export function parseResponseReplayStatuses(value: string): number[] {
  const values = value
    .split(/[\s,;]+/u)
    .map((part) => Number(part.trim()))
    .filter(
      (status) => Number.isInteger(status) && status >= 400 && status <= 599,
    );
  return unique(values).slice(0, RESPONSE_REPLAY_MATCH_LIMITS.statuses);
}

export function parseResponseReplayEndpoints(value: string): string[] {
  const values = value
    .split(/[\r\n,]+/u)
    .map((part) => normalizeText(part))
    .filter((part): part is string => part !== undefined);
  return unique(values).slice(0, RESPONSE_REPLAY_MATCH_LIMITS.endpoints);
}

export function parseResponseReplayKeywordGroups(value: string): string[][] {
  const groups: string[][] = [];
  for (const line of value.split(/\r?\n/u)) {
    const terms = unique(
      line
        .split("&&")
        .map((term) => normalizeText(term))
        .filter((term): term is string => term !== undefined),
    ).slice(0, RESPONSE_REPLAY_MATCH_LIMITS.termsPerGroup);
    if (terms.length === 0) continue;
    const key = terms.join("\u0000");
    if (groups.some((group) => group.join("\u0000") === key)) continue;
    groups.push(terms);
    if (groups.length >= RESPONSE_REPLAY_MATCH_LIMITS.groups) break;
  }
  return groups;
}

export function formatResponseReplayStatuses(
  value?: readonly number[],
): string {
  return (value ?? []).join(", ");
}

export function formatResponseReplayEndpoints(
  value?: readonly string[],
): string {
  return (value ?? []).join("\n");
}

export function formatResponseReplayKeywordGroups(
  value?: readonly (readonly string[])[],
): string {
  return (value ?? []).map((group) => group.join(" && ")).join("\n");
}

/** Fill editor-only defaults while preserving an explicitly empty array. */
export function responseReplayEditorConfig(
  config?: ProviderUpstreamResponseReplay,
): ProviderUpstreamResponseReplay {
  const { retryCodexBadResponse400: legacyToggle, ...currentConfig } =
    config ?? {};
  return {
    ...DEFAULT_RESPONSE_REPLAY_EDITOR_CONFIG,
    ...currentConfig,
    retryCodexConfiguredErrors:
      config?.retryCodexConfiguredErrors ?? legacyToggle ?? true,
    codexMatchStatuses:
      config?.codexMatchStatuses === undefined
        ? [...DEFAULT_RESPONSE_REPLAY_MATCH_STATUSES]
        : [...config.codexMatchStatuses],
    codexMatchEndpoints:
      config?.codexMatchEndpoints === undefined
        ? [...DEFAULT_RESPONSE_REPLAY_MATCH_ENDPOINTS]
        : [...config.codexMatchEndpoints],
    codexMatchKeywordGroups:
      config?.codexMatchKeywordGroups === undefined
        ? DEFAULT_RESPONSE_REPLAY_MATCH_KEYWORD_GROUPS.map((group) => [
            ...group,
          ])
        : config.codexMatchKeywordGroups.map((group) => [...group]),
  };
}

function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeStatuses(value?: number[]): number[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value.filter(
      (status): status is number =>
        Number.isInteger(status) && status >= 400 && status <= 599,
    ),
  ).slice(0, RESPONSE_REPLAY_MATCH_LIMITS.statuses);
}

function normalizeEndpoints(value?: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const normalized = normalizeText(item);
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= RESPONSE_REPLAY_MATCH_LIMITS.endpoints) break;
  }
  return result;
}

function normalizeKeywordGroups(value?: string[][]): string[][] {
  if (!Array.isArray(value)) return [];
  const result: string[][] = [];
  for (const group of value) {
    if (!Array.isArray(group)) continue;
    const terms = unique(
      group
        .map((term) => normalizeText(term))
        .filter((term): term is string => term !== undefined),
    ).slice(0, RESPONSE_REPLAY_MATCH_LIMITS.termsPerGroup);
    if (terms.length === 0) continue;
    const key = terms.join("\u0000");
    if (result.some((existing) => existing.join("\u0000") === key)) continue;
    result.push(terms);
    if (result.length >= RESPONSE_REPLAY_MATCH_LIMITS.groups) break;
  }
  return result;
}

export function normalizeResponseReplayConfigForSave(
  config: ProviderUpstreamResponseReplay,
): ProviderUpstreamResponseReplay | undefined {
  const hasExplicitConfig =
    config.enabled === true ||
    config.retryHttp429 !== undefined ||
    config.retryCodexConfiguredErrors !== undefined ||
    config.retryCodexBadResponse400 !== undefined ||
    config.codexMatchStatuses !== undefined ||
    config.codexMatchEndpoints !== undefined ||
    config.codexMatchKeywordGroups !== undefined ||
    config.maxRetries !== undefined ||
    config.initialDelayMs !== undefined ||
    config.maxDelayMs !== undefined ||
    config.jitterMs !== undefined ||
    config.honorRetryAfter !== undefined;
  if (!hasExplicitConfig) return undefined;

  const maxRetries = clampNumber(config.maxRetries, 0, 10) ?? 2;
  const maxDelayMs = clampNumber(config.maxDelayMs, 0, 60_000) ?? 5_000;
  const initialDelayMs = Math.min(
    clampNumber(config.initialDelayMs, 0, 60_000) ?? 250,
    maxDelayMs,
  );

  return {
    enabled: config.enabled === true,
    retryHttp429: config.retryHttp429 !== false,
    retryCodexConfiguredErrors:
      config.retryCodexConfiguredErrors ??
      config.retryCodexBadResponse400 ??
      true,
    codexMatchStatuses:
      config.codexMatchStatuses === undefined
        ? [...DEFAULT_RESPONSE_REPLAY_MATCH_STATUSES]
        : normalizeStatuses(config.codexMatchStatuses),
    codexMatchEndpoints:
      config.codexMatchEndpoints === undefined
        ? [...DEFAULT_RESPONSE_REPLAY_MATCH_ENDPOINTS]
        : normalizeEndpoints(config.codexMatchEndpoints),
    codexMatchKeywordGroups:
      config.codexMatchKeywordGroups === undefined
        ? DEFAULT_RESPONSE_REPLAY_MATCH_KEYWORD_GROUPS.map((group) => [
            ...group,
          ])
        : normalizeKeywordGroups(config.codexMatchKeywordGroups),
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    jitterMs: clampNumber(config.jitterMs, 0, 500) ?? 100,
    honorRetryAfter: config.honorRetryAfter !== false,
  };
}
