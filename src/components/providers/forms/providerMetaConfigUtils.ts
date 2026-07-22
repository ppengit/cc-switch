import type {
  CodexChatReasoning,
  ProviderUpstreamAdmissionRetry,
} from "@/types";

export const normalizeAdmissionRetryConfigForSave = (
  config: ProviderUpstreamAdmissionRetry,
): ProviderUpstreamAdmissionRetry | undefined => {
  const clamp = (
    value: number | undefined,
    min: number,
    max: number,
  ): number | undefined => {
    if (value === undefined || Number.isNaN(value)) return undefined;
    return Math.min(max, Math.max(min, Math.trunc(value)));
  };

  const normalized: ProviderUpstreamAdmissionRetry = {
    enabled: config.enabled === true,
    autoEnabled: config.autoEnabled === true,
    notifyOnSuccess: config.notifyOnSuccess === true,
  };
  const scheduleMode =
    config.scheduleMode === "fixedInterval" ? "fixedInterval" : undefined;
  const autoKeywords = Array.from(
    new Set(
      (config.autoKeywords ?? [])
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  );
  const maxRetries = clamp(config.maxRetries, 0, 1_000_000);
  const initialDelayMs = clamp(config.initialDelayMs, 0, 600_000);
  const maxDelayMs = clamp(config.maxDelayMs, 0, 600_000);
  const jitterMs = clamp(config.jitterMs, 0, 500);

  if (autoKeywords.length > 0) normalized.autoKeywords = autoKeywords;
  if (scheduleMode !== undefined) normalized.scheduleMode = scheduleMode;
  if (maxRetries !== undefined) normalized.maxRetries = maxRetries;
  if (initialDelayMs !== undefined) normalized.initialDelayMs = initialDelayMs;
  if (maxDelayMs !== undefined) normalized.maxDelayMs = maxDelayMs;
  if (jitterMs !== undefined) normalized.jitterMs = jitterMs;

  return normalized.enabled ||
    normalized.autoEnabled ||
    normalized.notifyOnSuccess ||
    scheduleMode !== undefined ||
    autoKeywords.length > 0 ||
    maxRetries !== undefined ||
    initialDelayMs !== undefined ||
    maxDelayMs !== undefined ||
    jitterMs !== undefined
    ? normalized
    : undefined;
};

export const normalizeMaxConcurrentRequestsForSave = (
  value: number | undefined,
): number | undefined => {
  if (value === undefined || Number.isNaN(value)) return undefined;
  const normalized = Math.min(1_000_000, Math.max(0, Math.trunc(value)));
  return normalized > 0 ? normalized : undefined;
};

export const normalizeCodexChatReasoningForSave = (
  value?: CodexChatReasoning,
): CodexChatReasoning | undefined => {
  const supportsEffort = value?.supportsEffort === true;
  const supportsThinking = value?.supportsThinking === true || supportsEffort;
  const hasExplicitConfig = value && Object.keys(value).length > 0;

  if (!supportsThinking && !supportsEffort) {
    return hasExplicitConfig
      ? {
          supportsThinking: false,
          supportsEffort: false,
          thinkingParam: "none",
          effortParam: "none",
          outputFormat: value?.outputFormat ?? "auto",
        }
      : undefined;
  }

  return {
    supportsThinking,
    supportsEffort,
    thinkingParam: supportsThinking
      ? (value?.thinkingParam ?? "thinking")
      : "none",
    effortParam: supportsEffort
      ? (value?.effortParam ?? "reasoning_effort")
      : "none",
    effortValueMode: supportsEffort
      ? (value?.effortValueMode ?? "passthrough")
      : undefined,
    outputFormat: value?.outputFormat ?? "auto",
  };
};
