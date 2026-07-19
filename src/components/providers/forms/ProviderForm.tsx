import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { providerSchema, type ProviderFormData } from "@/lib/schemas/provider";
import {
  buildLocalProxyRequestOverrides,
  formatRequestOverrideObject,
} from "@/lib/requestOverrides";
import { providersApi, settingsApi, type AppId } from "@/lib/api";
import { useDarkMode } from "@/hooks/useDarkMode";
import { useSettingsQuery } from "@/lib/query";
import {
  normalizeResponseReplayConfigForSave,
  responseReplayEditorConfig,
} from "@/lib/responseReplay";
import type {
  ProviderCategory,
  ProviderMeta,
  ProviderTestConfig,
  ProviderUpstreamAdmissionRetry,
  ProviderUpstreamResponseReplay,
  ClaudeApiFormat,
  CodexApiFormat,
  CodexCatalogModel,
  CodexModelRoute,
  CodexChatReasoning,
  ClaudeApiKeyField,
} from "@/types";
import {
  providerPresets,
  type ProviderPreset,
} from "@/config/claudeProviderPresets";
import {
  codexProviderPresets,
  type CodexProviderPreset,
} from "@/config/codexProviderPresets";
import {
  geminiProviderPresets,
  type GeminiProviderPreset,
} from "@/config/geminiProviderPresets";
import {
  opencodeProviderPresets,
  type OpenCodeProviderPreset,
} from "@/config/opencodeProviderPresets";
import {
  openclawProviderPresets,
  rebaseOpenClawSuggestedDefaults,
  type OpenClawProviderPreset,
  type OpenClawSuggestedDefaults,
} from "@/config/openclawProviderPresets";
import {
  hermesProviderPresets,
  type HermesProviderPreset,
} from "@/config/hermesProviderPresets";
import { OpenCodeFormFields } from "./OpenCodeFormFields";
import { OpenClawFormFields } from "./OpenClawFormFields";
import { HermesFormFields } from "./HermesFormFields";
import type { UniversalProviderPreset } from "@/config/universalProviderPresets";
import {
  applyTemplateValues,
  extractCodexBaseUrl,
  hasApiKeyField,
  isKnownFullApiEndpoint,
  setCodexBaseUrl as setCodexBaseUrlInConfig,
} from "@/utils/providerConfigUtils";
import { mergeProviderMeta } from "@/utils/providerMetaUtils";
import {
  extractCodexWireApi,
  setCodexWireApi,
  setCodexModelName as setCodexModelNameInConfig,
} from "@/utils/providerConfigUtils";
import { isNonNegativeDecimalString } from "@/types/usage";
import { getCodexCustomTemplate } from "@/config/codexTemplates";
import CodexConfigEditor from "./CodexConfigEditor";
import GeminiConfigEditor from "./GeminiConfigEditor";
import JsonEditor from "@/components/JsonEditor";
import { Label } from "@/components/ui/label";
import { ProviderPresetSelector } from "./ProviderPresetSelector";
import { BasicFormFields } from "./BasicFormFields";
import { ClaudeFormFields } from "./ClaudeFormFields";
import { ClaudeDesktopProviderForm } from "./ClaudeDesktopProviderForm";
import {
  CodexFormFields,
  modelRouteRowsFromMap,
  type CodexModelRouteRow,
} from "./CodexFormFields";
import { GeminiFormFields } from "./GeminiFormFields";
import { OmoFormFields } from "./OmoFormFields";
import { parseOmoOtherFieldsObject } from "@/types/omo";
import {
  ProviderAdvancedConfig,
  ProviderRoutingRetryConfig,
  type PricingModelSourceOption,
} from "./ProviderAdvancedConfig";
import {
  useProviderCategory,
  useApiKeyState,
  useBaseUrlState,
  useModelState,
  useCodexConfigState,
  useApiKeyLink,
  useTemplateValues,
  useCodexCommonConfig,
  useSpeedTestEndpoints,
  useCodexTomlValidation,
  useGeminiConfigState,
  useGeminiCommonConfig,
  useOmoModelSource,
  useOpencodeFormState,
  useOmoDraftState,
  useOpenclawFormState,
  useHermesFormState,
  useCopilotAuth,
  useCodexOauth,
} from "./hooks";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  CLAUDE_DEFAULT_CONFIG,
  CODEX_DEFAULT_CONFIG,
  GEMINI_DEFAULT_CONFIG,
  OPENCODE_DEFAULT_CONFIG,
  OPENCLAW_DEFAULT_CONFIG,
  normalizePricingSource,
} from "./helpers/opencodeFormUtils";
import { HERMES_DEFAULT_CONFIG } from "./hooks/useHermesFormState";
import { resolveManagedAccountId } from "@/lib/authBinding";
import { useOpenClawLiveProviderIds } from "@/hooks/useOpenClaw";
import { useHermesLiveProviderIds } from "@/hooks/useHermes";

type PresetEntry = {
  id: string;
  preset:
    | ProviderPreset
    | CodexProviderPreset
    | GeminiProviderPreset
    | OpenCodeProviderPreset
    | OpenClawProviderPreset
    | HermesProviderPreset;
};

const codexApiFormatFromWireApi = (
  wireApi: string | undefined,
): CodexApiFormat | undefined => {
  switch (wireApi?.trim().toLowerCase()) {
    case "chat":
    case "chat_completions":
    case "chat-completions":
    case "openai_chat":
    case "openai-chat":
      return "openai_chat";
    case "responses":
    case "openai_responses":
    case "openai-responses":
      return "openai_responses";
    default:
      return undefined;
  }
};

const normalizeAdmissionRetryConfigForSave = (
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

const normalizeMaxConcurrentRequestsForSave = (
  value: number | undefined,
): number | undefined => {
  if (value === undefined || Number.isNaN(value)) return undefined;
  const normalized = Math.min(1_000_000, Math.max(0, Math.trunc(value)));
  return normalized > 0 ? normalized : undefined;
};

// 从已保存的 settingsConfig 推断 Codex 模型目录条目数（用于决定本地路由初始开关）。
const codexCatalogCountFromSettings = (settingsConfig: unknown): number => {
  if (settingsConfig && typeof settingsConfig === "object") {
    const models = (settingsConfig as { modelCatalog?: { models?: unknown } })
      .modelCatalog?.models;
    return Array.isArray(models) ? models.length : 0;
  }
  return 0;
};

const getInitialCodexLocalRoutingEnabled = (
  meta: ProviderMeta | undefined,
  settingsConfig: unknown,
): boolean => {
  if (meta?.codexLocalRoutingEnabled !== undefined) {
    return meta.codexLocalRoutingEnabled;
  }
  return codexCatalogCountFromSettings(settingsConfig) > 0;
};

const getInitialCodexModelRoutesEnabled = (
  meta: ProviderMeta | undefined,
): boolean => {
  return meta?.codexModelRoutesEnabled === true;
};

export const normalizeCodexCatalogModelsForSave = (
  models: CodexCatalogModel[],
): CodexCatalogModel[] => {
  const seen = new Set<string>();
  const normalized: CodexCatalogModel[] = [];

  for (const item of models) {
    const model = item.model.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);

    const displayName = item.displayName?.trim();
    const rawContextWindow = String(item.contextWindow ?? "").replace(
      /[^\d]/g,
      "",
    );
    const contextWindow = rawContextWindow
      ? Number.parseInt(rawContextWindow, 10)
      : undefined;

    const inputModalities = item.inputModalities?.filter(
      (m) => typeof m === "string" && m.trim(),
    );

    const baseInstructions = item.baseInstructions?.trim();

    normalized.push({
      model,
      ...(displayName ? { displayName } : {}),
      ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
      // Native Responses profile overrides (ignored by the chat/proxy profile).
      ...(typeof item.supportsParallelToolCalls === "boolean"
        ? { supportsParallelToolCalls: item.supportsParallelToolCalls }
        : {}),
      ...(inputModalities && inputModalities.length > 0
        ? { inputModalities }
        : {}),
      ...(baseInstructions ? { baseInstructions } : {}),
    });
  }

  return normalized;
};

export const normalizeCodexModelRoutesForSave = (
  routes: Record<string, CodexModelRoute> | undefined,
): Record<string, CodexModelRoute> | undefined => {
  if (!routes) return undefined;

  const normalized: Record<string, CodexModelRoute> = {};
  const seen = new Set<string>();
  for (const [requestModelRaw, route] of Object.entries(routes)) {
    const requestModel = requestModelRaw.trim();
    const upstreamModel = route?.model?.trim();
    if (!requestModel || !upstreamModel) continue;
    const lookup = requestModel.toLocaleLowerCase("en-US");
    if (seen.has(lookup)) continue;
    seen.add(lookup);
    normalized[requestModel] = { model: upstreamModel };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeCodexChatReasoningForSave = (
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

const getInitialClaudeApiKeyField = (
  appId: AppId,
  meta: ProviderMeta | undefined,
  settingsConfig: Record<string, unknown> | undefined,
): ClaudeApiKeyField => {
  if (appId !== "claude") return "ANTHROPIC_AUTH_TOKEN";
  if (meta?.apiKeyField) return meta.apiKeyField;

  const env = settingsConfig?.env as Record<string, unknown> | undefined;
  if (env?.ANTHROPIC_API_KEY !== undefined) return "ANTHROPIC_API_KEY";
  return "ANTHROPIC_AUTH_TOKEN";
};

const getInitialClaudeApiFormat = (
  appId: AppId,
  meta: ProviderMeta | undefined,
): ClaudeApiFormat => {
  if (appId !== "claude") return "anthropic";
  return meta?.apiFormat ?? "anthropic";
};

const getInitialCodexApiFormat = (
  meta: ProviderMeta | undefined,
  settingsConfig: Record<string, unknown> | undefined,
): CodexApiFormat => {
  if (meta?.apiFormat === "openai_chat") return "openai_chat";
  if (meta?.apiFormat === "openai_responses") return "openai_responses";

  return (
    codexApiFormatFromWireApi(
      extractCodexWireApi(
        typeof settingsConfig?.config === "string" ? settingsConfig.config : "",
      ),
    ) ?? "openai_responses"
  );
};

type LocalProxyRequestOverridesBuildResult = ReturnType<
  typeof buildLocalProxyRequestOverrides
>;

export interface ProviderFormProps {
  appId: AppId;
  providerId?: string;
  submitLabel: string;
  onSubmit: (values: ProviderFormValues) => Promise<void> | void;
  onCancel: () => void;
  onUniversalPresetSelect?: (preset: UniversalProviderPreset) => void;
  onManageUniversalProviders?: () => void;
  onSubmittingChange?: (isSubmitting: boolean) => void;
  initialData?: {
    name?: string;
    websiteUrl?: string;
    notes?: string;
    settingsConfig?: Record<string, unknown>;
    category?: ProviderCategory;
    meta?: ProviderMeta;
    icon?: string;
    iconColor?: string;
  };
  providerDefaultSettingsConfig?: Record<string, unknown>;
  showButtons?: boolean;
  isProxyTakeover?: boolean;
}

const getSeededCodexTemplate = (
  seededSettingsConfig?: Record<string, unknown>,
) => {
  const auth =
    seededSettingsConfig &&
    typeof seededSettingsConfig === "object" &&
    typeof (seededSettingsConfig as Record<string, unknown>).auth ===
      "object" &&
    (seededSettingsConfig as Record<string, unknown>).auth !== null
      ? ((seededSettingsConfig as Record<string, unknown>).auth as Record<
          string,
          unknown
        >)
      : {};
  const config =
    seededSettingsConfig &&
    typeof (seededSettingsConfig as Record<string, unknown>).config === "string"
      ? ((seededSettingsConfig as Record<string, unknown>).config as string)
      : "";
  return { auth, config };
};

const getSeededGeminiTemplate = (
  seededSettingsConfig?: Record<string, unknown>,
) => {
  const env =
    seededSettingsConfig &&
    typeof seededSettingsConfig === "object" &&
    typeof (seededSettingsConfig as Record<string, unknown>).env === "object" &&
    (seededSettingsConfig as Record<string, unknown>).env !== null
      ? ((seededSettingsConfig as Record<string, unknown>).env as Record<
          string,
          unknown
        >)
      : {};
  const config =
    seededSettingsConfig &&
    typeof (seededSettingsConfig as Record<string, unknown>).config ===
      "object" &&
    (seededSettingsConfig as Record<string, unknown>).config !== null
      ? ((seededSettingsConfig as Record<string, unknown>).config as Record<
          string,
          unknown
        >)
      : {};
  return { env, config };
};

export const normalizeUrlForSave = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\/$/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`.replace(/\/+$/, "");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
};

const normalizeWebsiteFromEndpoint = (endpoint: string): string => {
  const normalized = normalizeUrlForSave(endpoint);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (isKnownFullApiEndpoint(normalized)) {
      return url.origin;
    }
    if (/\/v1$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/v1$/i, "") || "/";
      url.search = "";
      url.hash = "";
      return normalizeUrlForSave(url.toString());
    }
  } catch {
    // Fallback for partially typed URLs.
  }

  return normalized.replace(/\/v1$/i, "");
};

const isUsableHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !!url.host
    );
  } catch {
    return false;
  }
};

const tryParseSettingsConfig = (
  value: string,
): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const getEndpointFromSettingsConfig = (
  settingsConfig: Record<string, unknown> | undefined,
  appId: AppId,
): string => {
  const cfg =
    settingsConfig && typeof settingsConfig === "object" ? settingsConfig : {};

  if (appId === "claude") {
    const env = cfg.env as Record<string, unknown> | undefined;
    return typeof env?.ANTHROPIC_BASE_URL === "string"
      ? env.ANTHROPIC_BASE_URL
      : "";
  }

  if (appId === "codex") {
    return (
      extractCodexBaseUrl(typeof cfg.config === "string" ? cfg.config : "") ||
      ""
    );
  }

  if (appId === "gemini") {
    const env = cfg.env as Record<string, unknown> | undefined;
    return typeof env?.GOOGLE_GEMINI_BASE_URL === "string"
      ? env.GOOGLE_GEMINI_BASE_URL
      : "";
  }

  if (appId === "opencode") {
    const options = cfg.options as Record<string, unknown> | undefined;
    return typeof options?.baseURL === "string" ? options.baseURL : "";
  }

  if (appId === "openclaw") {
    return typeof cfg.baseUrl === "string" ? cfg.baseUrl : "";
  }

  if (appId === "hermes") {
    return typeof cfg.base_url === "string" ? cfg.base_url : "";
  }

  return "";
};

export function ProviderForm(props: ProviderFormProps) {
  if (props.appId === "claude-desktop") {
    return <ClaudeDesktopProviderForm {...props} />;
  }

  return <ProviderFormFull {...props} />;
}

function ProviderFormFull({
  appId,
  providerId,
  submitLabel,
  onSubmit,
  onCancel,
  onUniversalPresetSelect,
  onManageUniversalProviders,
  onSubmittingChange,
  initialData,
  providerDefaultSettingsConfig,
  showButtons = true,
  isProxyTakeover = false,
}: ProviderFormProps) {
  if (appId === "claude-desktop") {
    throw new Error("ProviderFormFull should not receive claude-desktop");
  }

  const { t } = useTranslation();
  const isEditMode = Boolean(initialData);
  const formSeedKey = `${appId}:${providerId ?? "new"}:${isEditMode ? "edit" : "new"}`;
  const seededSettingsConfig =
    initialData?.settingsConfig ?? providerDefaultSettingsConfig;
  const queryClient = useQueryClient();
  const { data: settingsData } = useSettingsQuery();
  const showCommonConfigNotice =
    settingsData != null && settingsData.commonConfigConfirmed !== true;
  const isDarkMode = useDarkMode();

  const handleCommonConfigConfirm = async () => {
    try {
      if (settingsData) {
        const { webdavSync: _, ...rest } = settingsData;
        await settingsApi.save({ ...rest, commonConfigConfirmed: true });
        await queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
    } catch (error) {
      console.error("Failed to save commonConfigConfirmed:", error);
    }
  };

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    initialData ? null : "custom",
  );
  const [activePreset, setActivePreset] = useState<{
    id: string;
    category?: ProviderCategory;
    isPartner?: boolean;
    partnerPromotionKey?: string;
    suggestedDefaults?: OpenClawSuggestedDefaults;
  } | null>(null);
  const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
  const [isCodexEndpointModalOpen, setIsCodexEndpointModalOpen] =
    useState(false);

  const [draftCustomEndpoints, setDraftCustomEndpoints] = useState<string[]>(
    () => {
      if (initialData) return [];
      return [];
    },
  );
  const [endpointAutoSelect, setEndpointAutoSelect] = useState<boolean>(
    () => initialData?.meta?.endpointAutoSelect ?? true,
  );
  const supportsFullUrl = appId === "claude" || appId === "codex";
  const [localIsFullUrl, setLocalIsFullUrl] = useState<boolean>(() => {
    if (!supportsFullUrl) return false;
    return initialData?.meta?.isFullUrl ?? false;
  });

  const [testConfig, setTestConfig] = useState<ProviderTestConfig>(
    () => initialData?.meta?.testConfig ?? { enabled: false },
  );
  const [pricingConfig, setPricingConfig] = useState<{
    enabled: boolean;
    costMultiplier?: string;
    pricingModelSource: PricingModelSourceOption;
  }>(() => ({
    enabled:
      initialData?.meta?.costMultiplier !== undefined ||
      initialData?.meta?.pricingModelSource !== undefined,
    costMultiplier: initialData?.meta?.costMultiplier,
    pricingModelSource: normalizePricingSource(
      initialData?.meta?.pricingModelSource,
    ),
  }));
  const [admissionRetryConfig, setAdmissionRetryConfig] =
    useState<ProviderUpstreamAdmissionRetry>(() => ({
      ...(initialData?.meta?.upstreamAdmissionRetry ?? {}),
      enabled: initialData?.meta?.upstreamAdmissionRetry?.enabled ?? false,
    }));
  const [responseReplayConfig, setResponseReplayConfig] =
    useState<ProviderUpstreamResponseReplay>(() => {
      const existing = initialData?.meta?.upstreamResponseReplay;
      return existing ? responseReplayEditorConfig(existing) : {};
    });
  const [maxConcurrentRequests, setMaxConcurrentRequests] = useState<
    number | undefined
  >(() => initialData?.meta?.maxConcurrentRequests);
  const [codexChatReasoning, setCodexChatReasoning] =
    useState<CodexChatReasoning>(
      () => initialData?.meta?.codexChatReasoning ?? {},
    );
  const [codexModelRoutes, setCodexModelRoutes] = useState<
    CodexModelRouteRow[]
  >(() => modelRouteRowsFromMap(initialData?.meta?.codexModelRoutes ?? {}));
  const [codexModelRoutesEnabled, setCodexModelRoutesEnabled] =
    useState<boolean>(() =>
      getInitialCodexModelRoutesEnabled(initialData?.meta),
    );
  const [customUserAgent, setCustomUserAgent] = useState<string>(
    () => initialData?.meta?.customUserAgent ?? "",
  );
  const [localProxyHeadersOverride, setLocalProxyHeadersOverride] =
    useState<string>(() =>
      formatRequestOverrideObject(
        initialData?.meta?.localProxyRequestOverrides?.headers,
      ),
    );
  const [localProxyBodyOverride, setLocalProxyBodyOverride] = useState<string>(
    () =>
      formatRequestOverrideObject(
        initialData?.meta?.localProxyRequestOverrides?.body,
      ),
  );

  const { category } = useProviderCategory({
    appId,
    selectedPresetId,
    isEditMode,
    initialCategory: initialData?.category,
  });
  const isOmoCategory = appId === "opencode" && category === "omo";
  const isOmoSlimCategory = appId === "opencode" && category === "omo-slim";
  const isAnyOmoCategory = isOmoCategory || isOmoSlimCategory;

  // 只在 formSeedKey 变化时（即真正切换到不同的供应商表单）重新初始化派生状态。
  //
  // 注意：依赖里**故意不带 `initialData`**。父组件可能每次 rerender 都会传入新的对象
  // 引用（例如 React Query 重新拉取），如果把 initialData 放进依赖，用户每次输入都会
  // 触发 setEndpointAutoSelect / setTestConfig 等被回填覆盖，编辑框/开关瞬间被 reset。
  // 我们只在切到另一个供应商时（formSeedKey 变化）做一次性同步即可，期间用 ref 取值。
  const initialDataRef = useRef(initialData);
  initialDataRef.current = initialData;
  const seededSettingsConfigRef = useRef(seededSettingsConfig);
  seededSettingsConfigRef.current = seededSettingsConfig;

  useEffect(() => {
    const seed = initialDataRef.current;
    setSelectedPresetId(seed ? null : "custom");
    setActivePreset(null);

    if (!seed) {
      setDraftCustomEndpoints([]);
    }
    setEndpointAutoSelect(seed?.meta?.endpointAutoSelect ?? true);
    setLocalIsFullUrl(
      supportsFullUrl ? (seed?.meta?.isFullUrl ?? false) : false,
    );
    setTestConfig(seed?.meta?.testConfig ?? { enabled: false });
    setPricingConfig({
      enabled:
        seed?.meta?.costMultiplier !== undefined ||
        seed?.meta?.pricingModelSource !== undefined,
      costMultiplier: seed?.meta?.costMultiplier,
      pricingModelSource: normalizePricingSource(
        seed?.meta?.pricingModelSource,
      ),
    });
    setAdmissionRetryConfig({
      ...(seed?.meta?.upstreamAdmissionRetry ?? {}),
      enabled: seed?.meta?.upstreamAdmissionRetry?.enabled ?? false,
    });
    const existingResponseReplay = seed?.meta?.upstreamResponseReplay;
    setResponseReplayConfig(
      existingResponseReplay
        ? responseReplayEditorConfig(existingResponseReplay)
        : {},
    );
    setMaxConcurrentRequests(seed?.meta?.maxConcurrentRequests);
    setCodexChatReasoning(seed?.meta?.codexChatReasoning ?? {});
    setCodexModelRoutes(
      modelRouteRowsFromMap(seed?.meta?.codexModelRoutes ?? {}),
    );
    setCodexModelRoutesEnabled(getInitialCodexModelRoutesEnabled(seed?.meta));
    setCustomUserAgent(seed?.meta?.customUserAgent ?? "");
    setLocalProxyHeadersOverride(
      formatRequestOverrideObject(
        seed?.meta?.localProxyRequestOverrides?.headers,
      ),
    );
    setLocalProxyBodyOverride(
      formatRequestOverrideObject(seed?.meta?.localProxyRequestOverrides?.body),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, formSeedKey, supportsFullUrl]);

  const defaultValues: ProviderFormData = useMemo(
    () => ({
      name: initialData?.name ?? "",
      websiteUrl: initialData?.websiteUrl ?? "",
      notes: initialData?.notes ?? "",
      settingsConfig: seededSettingsConfig
        ? JSON.stringify(seededSettingsConfig, null, 2)
        : appId === "codex"
          ? CODEX_DEFAULT_CONFIG
          : appId === "gemini"
            ? GEMINI_DEFAULT_CONFIG
            : appId === "opencode"
              ? OPENCODE_DEFAULT_CONFIG
              : appId === "openclaw"
                ? OPENCLAW_DEFAULT_CONFIG
                : appId === "hermes"
                  ? HERMES_DEFAULT_CONFIG
                  : CLAUDE_DEFAULT_CONFIG,
      icon: initialData?.icon ?? "",
      iconColor: initialData?.iconColor ?? "",
    }),
    [appId, formSeedKey, initialData, seededSettingsConfig],
  );

  const form = useForm<ProviderFormData>({
    resolver: zodResolver(providerSchema),
    defaultValues,
    mode: "onSubmit",
  });
  const { isSubmitting } = form.formState;
  const formResetRef = useRef(form.reset);
  const defaultValuesRef = useRef(defaultValues);
  const websiteUrlFieldValue = form.watch("websiteUrl") || "";
  const syncingUrlFieldsRef = useRef(false);
  const urlAutoSyncConsumedRef = useRef(false);

  formResetRef.current = form.reset;
  defaultValuesRef.current = defaultValues;

  const initialUrlPairIsEmpty = useMemo(() => {
    const parsedSettingsConfig = tryParseSettingsConfig(
      defaultValues.settingsConfig,
    );
    return (
      !normalizeUrlForSave(defaultValues.websiteUrl ?? "") &&
      !normalizeUrlForSave(
        getEndpointFromSettingsConfig(parsedSettingsConfig, appId),
      )
    );
  }, [appId, defaultValues.settingsConfig, defaultValues.websiteUrl]);

  const canAutoSyncUrlFields =
    !isEditMode && selectedPresetId === "custom" && initialUrlPairIsEmpty;

  useEffect(() => {
    urlAutoSyncConsumedRef.current = false;
  }, [appId, formSeedKey, selectedPresetId]);

  const handleSettingsConfigChange = useCallback(
    (config: string) => {
      form.setValue("settingsConfig", config);
    },
    [form],
  );

  const [localApiKeyField, setLocalApiKeyField] = useState<ClaudeApiKeyField>(
    () =>
      getInitialClaudeApiKeyField(
        appId,
        initialData?.meta,
        seededSettingsConfig,
      ),
  );

  // 软校验：收集"业务约束"类问题（空值/缺项），由用户决定是否仍要保存
  const [softIssues, setSoftIssues] = useState<string[] | null>(null);
  const [pendingFormValues, setPendingFormValues] =
    useState<ProviderFormData | null>(null);
  const [
    pendingLocalProxyRequestOverridesResult,
    setPendingLocalProxyRequestOverridesResult,
  ] = useState<LocalProxyRequestOverridesBuildResult | null>(null);
  // 确认框走的提交路径绕过了 react-hook-form 的 isSubmitting，单独追踪
  const [isConfirmSubmitting, setIsConfirmSubmitting] = useState(false);

  useEffect(() => {
    onSubmittingChange?.(isSubmitting || isConfirmSubmitting);
  }, [isSubmitting, isConfirmSubmitting, onSubmittingChange]);

  const {
    apiKey,
    handleApiKeyChange,
    showApiKey: shouldShowApiKey,
  } = useApiKeyState({
    initialConfig: form.getValues("settingsConfig"),
    onConfigChange: handleSettingsConfigChange,
    selectedPresetId,
    category,
    appType: appId,
    apiKeyField: appId === "claude" ? localApiKeyField : undefined,
  });

  const {
    baseUrl,
    handleClaudeBaseUrlChange: originalHandleClaudeBaseUrlChange,
  } = useBaseUrlState({
    appType: appId,
    category,
    settingsConfig: form.getValues("settingsConfig"),
    codexConfig: "",
    onSettingsConfigChange: handleSettingsConfigChange,
    onCodexConfigChange: () => {},
  });

  const {
    claudeModel,
    defaultHaikuModel,
    defaultHaikuModelName,
    defaultSonnetModel,
    defaultSonnetModelName,
    defaultOpusModel,
    defaultOpusModelName,
    defaultFableModel,
    defaultFableModelName,
    subagentModel,
    handleModelChange,
  } = useModelState({
    settingsConfig: form.getValues("settingsConfig"),
    onConfigChange: handleSettingsConfigChange,
  });

  const [localApiFormat, setLocalApiFormat] = useState<ClaudeApiFormat>(() => {
    return getInitialClaudeApiFormat(appId, initialData?.meta);
  });

  const handleApiFormatChange = useCallback((format: ClaudeApiFormat) => {
    setLocalApiFormat(format);
  }, []);

  const handleApiKeyFieldChange = useCallback(
    (field: ClaudeApiKeyField) => {
      const prev = localApiKeyField;
      setLocalApiKeyField(field);

      // Swap the env key name in settingsConfig
      try {
        const raw = form.getValues("settingsConfig");
        const config = JSON.parse(raw || "{}");
        if (config?.env && prev in config.env) {
          const value = config.env[prev];
          delete config.env[prev];
          config.env[field] = value;
          const updated = JSON.stringify(config, null, 2);
          form.setValue("settingsConfig", updated);
          handleSettingsConfigChange(updated);
        }
      } catch {
        // ignore parse errors during editing
      }
    },
    [localApiKeyField, form, handleSettingsConfigChange],
  );

  // Copilot OAuth 认证状态（仅 Claude 应用需要）
  const { isAuthenticated: isCopilotAuthenticated } = useCopilotAuth();

  // Codex OAuth 认证状态（ChatGPT Plus/Pro 反代）
  const { isAuthenticated: isCodexOauthAuthenticated } = useCodexOauth();

  // 选中的 GitHub 账号 ID（多账号支持）
  const [selectedGitHubAccountId, setSelectedGitHubAccountId] = useState<
    string | null
  >(() => resolveManagedAccountId(initialData?.meta, "github_copilot"));

  // 选中的 ChatGPT 账号 ID（Codex OAuth 多账号支持）
  const [selectedCodexAccountId, setSelectedCodexAccountId] = useState<
    string | null
  >(() => resolveManagedAccountId(initialData?.meta, "codex_oauth"));
  const [codexFastMode, setCodexFastMode] = useState<boolean>(
    () => initialData?.meta?.codexFastMode ?? false,
  );

  const codexInitialData = useMemo(() => {
    if (appId !== "codex") return undefined;
    return {
      settingsConfig:
        seededSettingsConfig ?? tryParseSettingsConfig(CODEX_DEFAULT_CONFIG),
    };
  }, [appId, seededSettingsConfig]);

  const geminiInitialData = useMemo(() => {
    if (appId !== "gemini") return undefined;
    return {
      settingsConfig:
        seededSettingsConfig ?? tryParseSettingsConfig(GEMINI_DEFAULT_CONFIG),
    };
  }, [appId, seededSettingsConfig]);

  const {
    codexAuth,
    codexConfig,
    codexApiKey,
    codexBaseUrl,
    codexCatalogModels,
    codexAuthError,
    setCodexAuth,
    setCodexConfig,
    setCodexCatalogModels,
    handleCodexApiKeyChange,
    handleCodexBaseUrlChange: originalHandleCodexBaseUrlChange,
    handleCodexConfigChange: originalHandleCodexConfigChange,
    resetCodexConfig,
  } = useCodexConfigState({
    initialData: codexInitialData,
    initializationKey: formSeedKey,
  });

  const handleEndpointFullUrlDetection = useCallback(
    (nextUrl: string) => {
      if (
        supportsFullUrl &&
        category !== "official" &&
        isKnownFullApiEndpoint(nextUrl)
      ) {
        setLocalIsFullUrl(true);
      }
    },
    [category, supportsFullUrl],
  );

  const handleClaudeBaseUrlChange = useCallback(
    (nextUrl: string) => {
      handleEndpointFullUrlDetection(nextUrl);
      originalHandleClaudeBaseUrlChange(nextUrl);
    },
    [handleEndpointFullUrlDetection, originalHandleClaudeBaseUrlChange],
  );

  const handleCodexBaseUrlChange = useCallback(
    (nextUrl: string) => {
      handleEndpointFullUrlDetection(nextUrl);
      originalHandleCodexBaseUrlChange(nextUrl);
    },
    [handleEndpointFullUrlDetection, originalHandleCodexBaseUrlChange],
  );

  const [localCodexApiFormat, setLocalCodexApiFormat] =
    useState<CodexApiFormat>(() => {
      return getInitialCodexApiFormat(initialData?.meta, seededSettingsConfig);
    });

  // 本地路由（接管）开关 —— 仅控制 Codex model_catalog_json / 菜单可见模型。
  // 没有独立持久化字段，初值按「是否已配置模型目录」推断（有 catalog 即视为
  // 接管已开）。只在 useState 初始化与预设重置点设置，跟 localCodexApiFormat
  // 对称，避免漂移。
  const [codexTakeoverEnabled, setCodexTakeoverEnabled] = useState<boolean>(
    () =>
      getInitialCodexLocalRoutingEnabled(
        initialData?.meta,
        initialData?.settingsConfig,
      ),
  );

  useEffect(() => {
    const seed = initialDataRef.current;
    const seedMeta = seed?.meta;
    const seedSettingsConfig = seededSettingsConfigRef.current;

    setLocalApiKeyField(
      getInitialClaudeApiKeyField(appId, seedMeta, seedSettingsConfig),
    );
    setLocalApiFormat(getInitialClaudeApiFormat(appId, seedMeta));
    setSelectedGitHubAccountId(
      resolveManagedAccountId(seedMeta, "github_copilot"),
    );
    setSelectedCodexAccountId(resolveManagedAccountId(seedMeta, "codex_oauth"));
    setCodexFastMode(seedMeta?.codexFastMode ?? false);
    setLocalCodexApiFormat(
      getInitialCodexApiFormat(seedMeta, seedSettingsConfig),
    );
    setCodexTakeoverEnabled(
      getInitialCodexLocalRoutingEnabled(seedMeta, seedSettingsConfig),
    );
    setCodexModelRoutesEnabled(getInitialCodexModelRoutesEnabled(seedMeta));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, formSeedKey]);

  const { configError: codexConfigError, debouncedValidate } =
    useCodexTomlValidation();

  const handleCodexConfigChange = useCallback(
    (value: string) => {
      originalHandleCodexConfigChange(value);
      debouncedValidate(value);
    },
    [originalHandleCodexConfigChange, debouncedValidate],
  );

  const handleCodexApiFormatChange = useCallback(
    (format: CodexApiFormat) => {
      setLocalCodexApiFormat(format);
      // wire_api is always "responses" for Codex; format controls proxy-layer conversion
      setCodexConfig((prev) => {
        const updated = setCodexWireApi(prev, "responses");
        debouncedValidate(updated);
        return updated;
      });
    },
    [setCodexConfig, debouncedValidate],
  );

  useEffect(() => {
    formResetRef.current(defaultValuesRef.current);
  }, [formSeedKey]);

  useEffect(() => {
    if (
      appId === "codex" &&
      !initialDataRef.current &&
      selectedPresetId === "custom"
    ) {
      const template = getCodexCustomTemplate();
      resetCodexConfig(template.auth, template.config);
      setCodexChatReasoning({});
      setCodexModelRoutes([]);
      setCodexModelRoutesEnabled(false);
      setCodexTakeoverEnabled(false);
    }
  }, [appId, formSeedKey, selectedPresetId, resetCodexConfig]);

  const presetCategoryLabels: Record<string, string> = useMemo(
    () => ({
      official: t("providerForm.categoryOfficial", {
        defaultValue: "官方",
      }),
      cn_official: t("providerForm.categoryCnOfficial", {
        defaultValue: "国内官方",
      }),
      aggregator: t("providerForm.categoryAggregation", {
        defaultValue: "聚合服务",
      }),
      third_party: t("providerForm.categoryThirdParty", {
        defaultValue: "第三方",
      }),
      omo: "OMO",
    }),
    [t],
  );

  const presetEntries = useMemo(() => {
    if (appId === "codex") {
      return codexProviderPresets.map<PresetEntry>((preset, index) => ({
        id: `codex-${index}`,
        preset,
      }));
    } else if (appId === "gemini") {
      return geminiProviderPresets.map<PresetEntry>((preset, index) => ({
        id: `gemini-${index}`,
        preset,
      }));
    } else if (appId === "opencode") {
      return opencodeProviderPresets.map<PresetEntry>((preset, index) => ({
        id: `opencode-${index}`,
        preset,
      }));
    } else if (appId === "openclaw") {
      return openclawProviderPresets.map<PresetEntry>((preset, index) => ({
        id: `openclaw-${index}`,
        preset,
      }));
    } else if (appId === "hermes") {
      return hermesProviderPresets.map<PresetEntry>((preset, index) => ({
        id: `hermes-${index}`,
        preset,
      }));
    }
    return providerPresets
      .filter((p) => !p.hidden)
      .map<PresetEntry>((preset, index) => ({
        id: `claude-${index}`,
        preset,
      }));
  }, [appId]);

  const {
    templateValues,
    templateValueEntries,
    selectedPreset: templatePreset,
    handleTemplateValueChange,
    validateTemplateValues,
  } = useTemplateValues({
    selectedPresetId: appId === "claude" ? selectedPresetId : null,
    presetEntries: appId === "claude" ? presetEntries : [],
    settingsConfig: form.getValues("settingsConfig"),
    onConfigChange: handleSettingsConfigChange,
  });

  const {
    useCommonConfig: useCodexCommonConfigFlag,
    commonConfigSnippet: codexCommonConfigSnippet,
    commonConfigError: codexCommonConfigError,
    handleCommonConfigToggle: handleCodexCommonConfigToggle,
    handleCommonConfigSnippetChange: handleCodexCommonConfigSnippetChange,
    isExtracting: isCodexExtracting,
    handleExtract: handleCodexExtract,
    clearCommonConfigError: clearCodexCommonConfigError,
  } = useCodexCommonConfig({
    codexConfig,
    onConfigChange: handleCodexConfigChange,
    initialData: appId === "codex" ? initialData : undefined,
    initialEnabled: undefined,
    selectedPresetId: selectedPresetId ?? undefined,
    enabled: false,
  });

  const {
    geminiEnv,
    geminiConfig,
    geminiApiKey,
    geminiBaseUrl,
    geminiModel,
    envError,
    configError: geminiConfigError,
    handleGeminiApiKeyChange: originalHandleGeminiApiKeyChange,
    handleGeminiBaseUrlChange: originalHandleGeminiBaseUrlChange,
    handleGeminiModelChange: originalHandleGeminiModelChange,
    handleGeminiEnvChange: originalHandleGeminiEnvChange,
    handleGeminiConfigChange: originalHandleGeminiConfigChange,
    resetGeminiConfig,
    envStringToObj,
    envObjToString,
  } = useGeminiConfigState({
    initialData: geminiInitialData,
    initializationKey: formSeedKey,
  });

  const updateGeminiEnvField = useCallback(
    (
      key: "GEMINI_API_KEY" | "GOOGLE_GEMINI_BASE_URL" | "GEMINI_MODEL",
      value: string,
    ) => {
      try {
        const config = JSON.parse(form.getValues("settingsConfig") || "{}") as {
          env?: Record<string, unknown>;
        };
        if (!config.env || typeof config.env !== "object") {
          config.env = {};
        }
        // 空值不应以 "" 持久化到 .env / settings.json，否则用户在面板上看到一行
        // `KEY=`、CLI 实际取到 "" 这种空字符串，比"该字段不存在"更难调试。
        const trimmed = value.trim();
        if (trimmed) {
          config.env[key] = trimmed;
        } else {
          delete config.env[key];
        }
        form.setValue("settingsConfig", JSON.stringify(config, null, 2));
      } catch {}
    },
    [form],
  );

  const updateGeminiModelField = useCallback(
    (model: string) => {
      try {
        const config = JSON.parse(form.getValues("settingsConfig") || "{}") as {
          env?: Record<string, unknown>;
          config?: Record<string, unknown>;
        };
        if (!config.env || typeof config.env !== "object") {
          config.env = {};
        }
        if (!config.config || typeof config.config !== "object") {
          config.config = {};
        }

        const trimmed = model.trim();
        if (trimmed) {
          config.env.GEMINI_MODEL = trimmed;
          const nestedConfig = config.config as Record<string, unknown>;
          const modelConfig =
            nestedConfig.model &&
            typeof nestedConfig.model === "object" &&
            !Array.isArray(nestedConfig.model)
              ? { ...(nestedConfig.model as Record<string, unknown>) }
              : {};
          modelConfig.name = trimmed;
          nestedConfig.model = modelConfig;
        } else {
          delete config.env.GEMINI_MODEL;
          const nestedConfig = config.config as Record<string, unknown>;
          if (
            nestedConfig.model &&
            typeof nestedConfig.model === "object" &&
            !Array.isArray(nestedConfig.model)
          ) {
            const modelConfig = {
              ...(nestedConfig.model as Record<string, unknown>),
            };
            delete modelConfig.name;
            if (Object.keys(modelConfig).length > 0) {
              nestedConfig.model = modelConfig;
            } else {
              delete nestedConfig.model;
            }
          }
        }

        form.setValue("settingsConfig", JSON.stringify(config, null, 2));
      } catch {
        // Keep the editor state as source of truth if the hidden JSON is invalid.
      }
    },
    [form],
  );

  const updateGeminiSettingsField = useCallback(
    (patch: {
      env?: Record<string, string>;
      config?: Record<string, unknown>;
    }) => {
      try {
        const current = JSON.parse(
          form.getValues("settingsConfig") || "{}",
        ) as {
          env?: Record<string, unknown>;
          config?: Record<string, unknown>;
        };
        const next = {
          ...current,
          env:
            patch.env !== undefined
              ? patch.env
              : typeof current.env === "object" && current.env !== null
                ? current.env
                : {},
          config:
            patch.config !== undefined
              ? patch.config
              : typeof current.config === "object" && current.config !== null
                ? current.config
                : {},
        };
        form.setValue("settingsConfig", JSON.stringify(next, null, 2));
      } catch {
        // Keep the editor state as source of truth if the hidden JSON is invalid.
      }
    },
    [form],
  );

  const handleGeminiApiKeyChange = useCallback(
    (key: string) => {
      originalHandleGeminiApiKeyChange(key);
      updateGeminiEnvField("GEMINI_API_KEY", key.trim());
    },
    [originalHandleGeminiApiKeyChange, updateGeminiEnvField],
  );

  const handleGeminiBaseUrlChange = useCallback(
    (url: string) => {
      originalHandleGeminiBaseUrlChange(url);
      updateGeminiEnvField(
        "GOOGLE_GEMINI_BASE_URL",
        url.trim().replace(/\/+$/, ""),
      );
    },
    [originalHandleGeminiBaseUrlChange, updateGeminiEnvField],
  );

  const handleGeminiModelChange = useCallback(
    (model: string) => {
      originalHandleGeminiModelChange(model);
      updateGeminiModelField(model);
    },
    [originalHandleGeminiModelChange, updateGeminiModelField],
  );

  const handleGeminiEnvChange = useCallback(
    (value: string) => {
      originalHandleGeminiEnvChange(value);
      updateGeminiSettingsField({ env: envStringToObj(value) });
    },
    [envStringToObj, originalHandleGeminiEnvChange, updateGeminiSettingsField],
  );

  const handleGeminiConfigChange = useCallback(
    (value: string) => {
      originalHandleGeminiConfigChange(value);
      try {
        updateGeminiSettingsField({
          config: value.trim() ? JSON.parse(value) : {},
        });
      } catch {
        // Validation error is already shown by the Gemini config editor.
      }
    },
    [originalHandleGeminiConfigChange, updateGeminiSettingsField],
  );

  const {
    useCommonConfig: useGeminiCommonConfigFlag,
    commonConfigSnippet: geminiCommonConfigSnippet,
    commonConfigError: geminiCommonConfigError,
    handleCommonConfigToggle: handleGeminiCommonConfigToggle,
    handleCommonConfigSnippetChange: handleGeminiCommonConfigSnippetChange,
    isExtracting: isGeminiExtracting,
    handleExtract: handleGeminiExtract,
    clearCommonConfigError: clearGeminiCommonConfigError,
  } = useGeminiCommonConfig({
    envValue: geminiEnv,
    onEnvChange: handleGeminiEnvChange,
    envStringToObj,
    envObjToString,
    initialData: appId === "gemini" ? initialData : undefined,
    initialEnabled: undefined,
    selectedPresetId: selectedPresetId ?? undefined,
    enabled: false,
  });

  // ── Extracted hooks: OpenCode / OMO / OpenClaw ─────────────────────

  const {
    omoModelOptions,
    omoModelVariantsMap,
    omoPresetMetaMap,
    existingOpencodeKeys,
  } = useOmoModelSource({ isOmoCategory: isAnyOmoCategory, providerId });

  const {
    data: opencodeLiveProviderIds = [],
    isLoading: isOpencodeLiveProviderIdsLoading,
  } = useQuery({
    queryKey: ["opencodeLiveProviderIds"],
    queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
    enabled: appId === "opencode" && !isAnyOmoCategory,
  });

  const opencodeForm = useOpencodeFormState({
    initialData,
    appId,
    providerId,
    onSettingsConfigChange: (config) => form.setValue("settingsConfig", config),
    getSettingsConfig: () => form.getValues("settingsConfig"),
  });

  const initialOmoSettings =
    appId === "opencode" &&
    (initialData?.category === "omo" || initialData?.category === "omo-slim")
      ? (initialData.settingsConfig as Record<string, unknown> | undefined)
      : undefined;

  const omoDraft = useOmoDraftState({
    initialOmoSettings,
    isEditMode,
    appId,
    category,
  });

  const openclawForm = useOpenclawFormState({
    initialData,
    appId,
    providerId,
    onSettingsConfigChange: (config) => form.setValue("settingsConfig", config),
    getSettingsConfig: () => form.getValues("settingsConfig"),
  });
  const {
    data: openclawLiveProviderIds = [],
    isLoading: isOpenclawLiveProviderIdsLoading,
  } = useOpenClawLiveProviderIds(appId === "openclaw");

  const hermesForm = useHermesFormState({
    initialData,
    appId,
    providerId,
    onSettingsConfigChange: (config) => form.setValue("settingsConfig", config),
    getSettingsConfig: () => form.getValues("settingsConfig"),
  });
  const {
    data: hermesLiveProviderIds = [],
    isLoading: isHermesLiveProviderIdsLoading,
  } = useHermesLiveProviderIds(appId === "hermes");

  useEffect(() => {
    if (isEditMode || selectedPresetId !== "custom" || !seededSettingsConfig) {
      return;
    }

    if (appId === "codex") {
      const seeded = getSeededCodexTemplate(seededSettingsConfig);
      resetCodexConfig(seeded.auth, seeded.config);
      return;
    }

    if (appId === "gemini") {
      const seeded = getSeededGeminiTemplate(seededSettingsConfig);
      resetGeminiConfig(seeded.env, seeded.config);
      return;
    }

    if (appId === "opencode") {
      opencodeForm.resetOpencodeState(
        (seededSettingsConfig as any) || undefined,
      );
      return;
    }

    if (appId === "openclaw") {
      openclawForm.resetOpenclawState(
        (seededSettingsConfig as any) || undefined,
      );
      return;
    }

    if (appId === "hermes") {
      hermesForm.resetHermesState((seededSettingsConfig as any) || undefined);
      return;
    }

    if (appId === "claude") {
      const env = (seededSettingsConfig as Record<string, unknown>).env as
        | Record<string, unknown>
        | undefined;
      if (env?.ANTHROPIC_API_KEY !== undefined) {
        setLocalApiKeyField("ANTHROPIC_API_KEY");
      } else {
        setLocalApiKeyField("ANTHROPIC_AUTH_TOKEN");
      }
    }
  }, [
    appId,
    isEditMode,
    hermesForm.resetHermesState,
    openclawForm.resetOpenclawState,
    opencodeForm.resetOpencodeState,
    resetCodexConfig,
    resetGeminiConfig,
    seededSettingsConfig,
    selectedPresetId,
  ]);

  const additiveExistingProviderKeys = useMemo(() => {
    if (appId === "opencode" && !isAnyOmoCategory) {
      return Array.from(
        new Set(
          [...existingOpencodeKeys, ...opencodeLiveProviderIds].filter(
            (key) => key !== providerId,
          ),
        ),
      );
    }

    if (appId === "openclaw") {
      return Array.from(
        new Set(
          [
            ...openclawForm.existingOpenclawKeys,
            ...openclawLiveProviderIds,
          ].filter((key) => key !== providerId),
        ),
      );
    }

    if (appId === "hermes") {
      return Array.from(
        new Set(
          [...hermesForm.existingHermesKeys, ...hermesLiveProviderIds].filter(
            (key) => key !== providerId,
          ),
        ),
      );
    }

    return [];
  }, [
    appId,
    existingOpencodeKeys,
    hermesForm.existingHermesKeys,
    hermesLiveProviderIds,
    isAnyOmoCategory,
    openclawForm.existingOpenclawKeys,
    openclawLiveProviderIds,
    opencodeLiveProviderIds,
    providerId,
  ]);

  const isProviderKeyLockStateLoading = useMemo(() => {
    if (!isEditMode) return false;
    if (appId === "opencode" && !isAnyOmoCategory) {
      return isOpencodeLiveProviderIdsLoading;
    }
    if (appId === "openclaw") {
      return isOpenclawLiveProviderIdsLoading;
    }
    if (appId === "hermes") {
      return isHermesLiveProviderIdsLoading;
    }
    return false;
  }, [
    appId,
    isAnyOmoCategory,
    isEditMode,
    isHermesLiveProviderIdsLoading,
    isOpenclawLiveProviderIdsLoading,
    isOpencodeLiveProviderIdsLoading,
  ]);

  const isProviderKeyLocked = useMemo(() => {
    if (!isEditMode || !providerId) return false;
    if (appId === "opencode" && !isAnyOmoCategory) {
      return opencodeLiveProviderIds.includes(providerId);
    }
    if (appId === "openclaw") {
      return openclawLiveProviderIds.includes(providerId);
    }
    if (appId === "hermes") {
      return hermesLiveProviderIds.includes(providerId);
    }
    return false;
  }, [
    appId,
    hermesLiveProviderIds,
    isAnyOmoCategory,
    isEditMode,
    openclawLiveProviderIds,
    opencodeLiveProviderIds,
    providerId,
  ]);

  const shouldApplyLocalProxyRequestOverrides =
    (appId === "claude" || appId === "codex") && category !== "official";

  const handleSubmit = async (values: ProviderFormData) => {
    const overridesResult = shouldApplyLocalProxyRequestOverrides
      ? buildLocalProxyRequestOverrides(
          localProxyHeadersOverride,
          localProxyBodyOverride,
        )
      : {};
    if (overridesResult.error) {
      toast.error(
        t("providerForm.localProxyRequestOverridesInvalid", {
          defaultValue: `本地代理请求覆盖格式错误：${overridesResult.error}`,
          error: overridesResult.error,
        }),
      );
      return;
    }

    // 软性问题（业务约束，用户可选择仍要保存）
    const issues: string[] = [];

    // 模板变量未填：A 类（空值）
    if (appId === "claude" && templateValueEntries.length > 0) {
      const validation = validateTemplateValues();
      if (!validation.isValid && validation.missingField) {
        issues.push(
          t("providerForm.fillParameter", {
            label: validation.missingField.label,
            defaultValue: `请填写 ${validation.missingField.label}`,
          }),
        );
      }
    }

    // 供应商名空：A 类
    if (!values.name.trim()) {
      issues.push(
        t("providerForm.fillSupplierName", {
          defaultValue: "请填写供应商名称",
        }),
      );
    }

    const costMultiplier = pricingConfig.costMultiplier?.trim();
    if (
      pricingConfig.enabled &&
      costMultiplier &&
      !isNonNegativeDecimalString(costMultiplier)
    ) {
      toast.error(
        t("settings.globalProxy.defaultCostMultiplierInvalid", {
          defaultValue: "成本倍率必须为非负数",
        }),
      );
      return;
    }

    // opencode / openclaw / hermes: providerKey 相关
    // A 类（空）归到 issues；B 类（正则不合法 / 重复 / 状态加载中）仍硬拒绝
    const keyPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

    if (appId === "opencode" && !isAnyOmoCategory) {
      // providerKey 是 opencode / openclaw / hermes 的主键 ID，空或格式不合法
      // 都属于完整性约束，保留硬拒绝（mutations 层也会 throw，软化只会让错误更晦涩）
      if (!opencodeForm.opencodeProviderKey.trim()) {
        toast.error(t("opencode.providerKeyRequired"));
        return;
      }
      if (!keyPattern.test(opencodeForm.opencodeProviderKey)) {
        toast.error(t("opencode.providerKeyInvalid"));
        return;
      }
      if (isProviderKeyLockStateLoading) {
        toast.error(
          t("providerForm.providerKeyStatusLoading", {
            defaultValue: "正在加载供应商标识状态，请稍后再试",
          }),
        );
        return;
      }
      if (
        !isProviderKeyLocked &&
        additiveExistingProviderKeys.includes(opencodeForm.opencodeProviderKey)
      ) {
        toast.error(t("opencode.providerKeyDuplicate"));
        return;
      }
      if (Object.keys(opencodeForm.opencodeModels).length === 0) {
        issues.push(t("opencode.modelsRequired"));
      }
    }

    if (appId === "openclaw") {
      if (!openclawForm.openclawProviderKey.trim()) {
        toast.error(t("openclaw.providerKeyRequired"));
        return;
      }
      if (!keyPattern.test(openclawForm.openclawProviderKey)) {
        toast.error(t("openclaw.providerKeyInvalid"));
        return;
      }
      if (isProviderKeyLockStateLoading) {
        toast.error(
          t("providerForm.providerKeyStatusLoading", {
            defaultValue: "正在加载供应商标识状态，请稍后再试",
          }),
        );
        return;
      }
      if (
        !isProviderKeyLocked &&
        additiveExistingProviderKeys.includes(openclawForm.openclawProviderKey)
      ) {
        toast.error(t("openclaw.providerKeyDuplicate"));
        return;
      }
    }

    if (appId === "hermes") {
      if (!hermesForm.hermesProviderKey.trim()) {
        toast.error(t("hermes.form.providerKeyRequired"));
        return;
      }
      if (!keyPattern.test(hermesForm.hermesProviderKey)) {
        toast.error(t("hermes.form.providerKeyInvalid"));
        return;
      }
      if (isProviderKeyLockStateLoading) {
        toast.error(
          t("providerForm.providerKeyStatusLoading", {
            defaultValue: "正在加载供应商标识状态，请稍后再试",
          }),
        );
        return;
      }
      if (
        !isProviderKeyLocked &&
        additiveExistingProviderKeys.includes(hermesForm.hermesProviderKey)
      ) {
        toast.error(t("hermes.form.providerKeyDuplicate"));
        return;
      }
    }

    // OAuth 未登录：B 类（token 根本不存在，保存了也没法建立）
    const isCopilotProvider =
      templatePreset?.providerType === "github_copilot" ||
      initialData?.meta?.providerType === "github_copilot" ||
      baseUrl.includes("githubcopilot.com");
    const isCodexOauthProvider =
      templatePreset?.providerType === "codex_oauth" ||
      initialData?.meta?.providerType === "codex_oauth";
    if (isCopilotProvider && !isCopilotAuthenticated) {
      toast.error(
        t("copilot.loginRequired", {
          defaultValue: "请先登录 GitHub Copilot",
        }),
      );
      return;
    }
    if (isCodexOauthProvider && !isCodexOauthAuthenticated) {
      toast.error(
        t("codexOauth.loginRequired", {
          defaultValue: "请先登录 ChatGPT 账号",
        }),
      );
      return;
    }

    // OMO Other Fields JSON：B 类（格式错了保存下去数据就坏了）
    if (
      appId === "opencode" &&
      isAnyOmoCategory &&
      omoDraft.omoOtherFieldsStr.trim()
    ) {
      try {
        const otherFields = parseOmoOtherFieldsObject(
          omoDraft.omoOtherFieldsStr,
        );
        if (!otherFields) {
          toast.error(
            t("omo.jsonMustBeObject", {
              field: t("omo.otherFields", {
                defaultValue: "Other Config",
              }),
              defaultValue: "{{field}} must be a JSON object",
            }),
          );
          return;
        }
      } catch {
        toast.error(
          t("omo.invalidJson", {
            defaultValue: "Other Fields contains invalid JSON",
          }),
        );
        return;
      }
    }

    // 非官方供应商端点 / API Key 空：A 类
    // cloud_provider（如 Bedrock）通过模板变量处理认证，跳过通用校验
    if (category !== "official" && category !== "cloud_provider") {
      if (appId === "claude") {
        if (!isCodexOauthProvider && !baseUrl.trim()) {
          issues.push(
            t("providerForm.endpointRequired", {
              defaultValue: "非官方供应商请填写 API 端点",
            }),
          );
        }
        if (!isCopilotProvider && !isCodexOauthProvider && !apiKey.trim()) {
          issues.push(
            t("providerForm.apiKeyRequired", {
              defaultValue: "非官方供应商请填写 API Key",
            }),
          );
        }
      } else if (appId === "codex") {
        if (!codexBaseUrl.trim()) {
          issues.push(
            t("providerForm.endpointRequired", {
              defaultValue: "非官方供应商请填写 API 端点",
            }),
          );
        }
        if (!codexApiKey.trim()) {
          issues.push(
            t("providerForm.apiKeyRequired", {
              defaultValue: "非官方供应商请填写 API Key",
            }),
          );
        }
      } else if (appId === "gemini") {
        if (!geminiBaseUrl.trim()) {
          issues.push(
            t("providerForm.endpointRequired", {
              defaultValue: "非官方供应商请填写 API 端点",
            }),
          );
        }
        if (!geminiApiKey.trim()) {
          issues.push(
            t("providerForm.apiKeyRequired", {
              defaultValue: "非官方供应商请填写 API Key",
            }),
          );
        }
      }
    }

    if (issues.length > 0) {
      // 弹确认框让用户决定是否仍要保存
      setSoftIssues(issues);
      setPendingFormValues(values);
      setPendingLocalProxyRequestOverridesResult(overridesResult);
      return;
    }

    await performSubmit(values, overridesResult);
  };

  const performSubmit = async (
    values: ProviderFormData,
    overridesResult: LocalProxyRequestOverridesBuildResult,
  ) => {
    if (overridesResult.error) {
      toast.error(
        t("providerForm.localProxyRequestOverridesInvalid", {
          defaultValue: `本地代理请求覆盖格式错误：${overridesResult.error}`,
          error: overridesResult.error,
        }),
      );
      return;
    }

    // OAuth / 其它身份识别（与 handleSubmit 保持一致）
    const isCopilotProvider =
      templatePreset?.providerType === "github_copilot" ||
      initialData?.meta?.providerType === "github_copilot" ||
      baseUrl.includes("githubcopilot.com");
    const isCodexOauthProvider =
      templatePreset?.providerType === "codex_oauth" ||
      initialData?.meta?.providerType === "codex_oauth";

    const currentEndpointByApp =
      appId === "claude"
        ? baseUrl
        : appId === "codex"
          ? codexBaseUrl
          : appId === "gemini"
            ? geminiBaseUrl
            : appId === "opencode"
              ? opencodeForm.opencodeBaseUrl
              : appId === "openclaw"
                ? openclawForm.openclawBaseUrl
                : appId === "hermes"
                  ? hermesForm.hermesBaseUrl
                  : "";

    const normalizedWebsiteInput = normalizeUrlForSave(values.websiteUrl ?? "");
    const normalizedEndpointInput = normalizeUrlForSave(currentEndpointByApp);
    const effectiveWebsiteUrl =
      normalizedWebsiteInput ||
      (normalizedEndpointInput
        ? normalizeWebsiteFromEndpoint(normalizedEndpointInput)
        : "");
    const effectiveEndpointUrl =
      normalizedEndpointInput ||
      (effectiveWebsiteUrl ? normalizeUrlForSave(effectiveWebsiteUrl) : "");
    const nextIsFullUrl =
      supportsFullUrl &&
      category !== "official" &&
      (localIsFullUrl || isKnownFullApiEndpoint(effectiveEndpointUrl));
    let settingsConfig: string;

    if (appId === "codex") {
      try {
        const authJson = JSON.parse(codexAuth);
        const finalCodexConfig = setCodexBaseUrlInConfig(
          codexConfig ?? "",
          effectiveEndpointUrl,
        );
        let normalizedCodexConfig =
          category !== "official" && finalCodexConfig.trim()
            ? setCodexWireApi(finalCodexConfig, "responses")
            : finalCodexConfig;
        const normalizedCatalogModels =
          category !== "official" && codexTakeoverEnabled
            ? normalizeCodexCatalogModelsForSave(codexCatalogModels)
            : [];
        // Sync first catalog row's model into config.toml so Codex uses it as default
        if (normalizedCatalogModels.length > 0) {
          normalizedCodexConfig = setCodexModelNameInConfig(
            normalizedCodexConfig,
            normalizedCatalogModels[0].model,
          );
        }
        const configObj = {
          auth: authJson,
          config: normalizedCodexConfig,
        } as {
          auth: unknown;
          config: string;
          modelCatalog?: { models: CodexCatalogModel[] };
        };
        if (normalizedCatalogModels.length > 0) {
          configObj.modelCatalog = { models: normalizedCatalogModels };
        }
        settingsConfig = JSON.stringify(configObj);
      } catch (err) {
        settingsConfig = values.settingsConfig.trim();
      }
    } else if (appId === "gemini") {
      try {
        const currentConfig = JSON.parse(
          form.getValues("settingsConfig") || "{}",
        ) as {
          env?: Record<string, string>;
          config?: Record<string, unknown>;
        };
        const envObj =
          currentConfig.env && typeof currentConfig.env === "object"
            ? { ...currentConfig.env }
            : envStringToObj(geminiEnv);
        envObj.GOOGLE_GEMINI_BASE_URL = effectiveEndpointUrl;
        const normalizedGeminiApiKey = geminiApiKey.trim();
        const normalizedGeminiModel = geminiModel.trim();
        if (normalizedGeminiApiKey) {
          envObj.GEMINI_API_KEY = normalizedGeminiApiKey;
        } else {
          delete envObj.GEMINI_API_KEY;
        }
        if (normalizedGeminiModel) {
          envObj.GEMINI_MODEL = normalizedGeminiModel;
        } else {
          delete envObj.GEMINI_MODEL;
        }
        const configObj =
          currentConfig.config && typeof currentConfig.config === "object"
            ? currentConfig.config
            : geminiConfig.trim()
              ? JSON.parse(geminiConfig)
              : {};
        const combined = {
          env: envObj,
          config: configObj,
        };
        settingsConfig = JSON.stringify(combined);
      } catch (err) {
        settingsConfig = values.settingsConfig.trim();
      }
    } else if (
      appId === "opencode" &&
      (category === "omo" || category === "omo-slim")
    ) {
      const omoConfig: Record<string, unknown> = {};
      if (Object.keys(omoDraft.omoAgents).length > 0) {
        omoConfig.agents = omoDraft.omoAgents;
      }
      if (
        category === "omo" &&
        Object.keys(omoDraft.omoCategories).length > 0
      ) {
        omoConfig.categories = omoDraft.omoCategories;
      }
      if (omoDraft.omoOtherFieldsStr.trim()) {
        // 格式已在 handleSubmit 前置校验中验证过，此处可以安全解析
        const otherFields = parseOmoOtherFieldsObject(
          omoDraft.omoOtherFieldsStr,
        );
        if (otherFields) {
          omoConfig.otherFields = otherFields;
        }
      }
      settingsConfig = JSON.stringify(omoConfig);
    } else {
      settingsConfig = values.settingsConfig.trim();
      if (effectiveEndpointUrl) {
        try {
          const parsedConfig = JSON.parse(settingsConfig) as Record<
            string,
            any
          >;
          if (appId === "claude") {
            parsedConfig.env = parsedConfig.env ?? {};
            parsedConfig.env.ANTHROPIC_BASE_URL = effectiveEndpointUrl;
          } else if (appId === "opencode") {
            parsedConfig.options = parsedConfig.options ?? {};
            parsedConfig.options.baseURL = effectiveEndpointUrl;
          } else if (appId === "openclaw") {
            parsedConfig.baseUrl = effectiveEndpointUrl;
          } else if (appId === "hermes") {
            parsedConfig.base_url = effectiveEndpointUrl;
          }
          settingsConfig = JSON.stringify(parsedConfig);
        } catch {
          // ignore JSON parse failure and keep original payload
        }
      }
    }

    const payload: ProviderFormValues = {
      ...values,
      name: values.name.trim(),
      websiteUrl: effectiveWebsiteUrl,
      settingsConfig,
    };

    if (appId === "opencode") {
      if (isAnyOmoCategory) {
        if (!isEditMode) {
          const prefix = category === "omo" ? "omo" : "omo-slim";
          payload.providerKey = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
        }
      } else {
        payload.providerKey = opencodeForm.opencodeProviderKey;
      }
    } else if (appId === "openclaw") {
      payload.providerKey = openclawForm.openclawProviderKey;
    } else if (appId === "hermes") {
      payload.providerKey = hermesForm.hermesProviderKey;
    }

    if (isAnyOmoCategory && !payload.presetCategory) {
      payload.presetCategory = category;
    }

    if (activePreset) {
      payload.presetId = activePreset.id;
      if (activePreset.category) {
        payload.presetCategory = activePreset.category;
      }
      if (activePreset.isPartner) {
        payload.isPartner = activePreset.isPartner;
      }
      // OpenClaw: align preset model refs with the actual submitted provider key.
      if (activePreset.suggestedDefaults) {
        payload.suggestedDefaults =
          appId === "openclaw" && payload.providerKey
            ? rebaseOpenClawSuggestedDefaults(
                activePreset.suggestedDefaults,
                payload.providerKey,
              )
            : activePreset.suggestedDefaults;
      }
    }

    if (!isEditMode && draftCustomEndpoints.length > 0) {
      const customEndpointsToSave: Record<
        string,
        import("@/types").CustomEndpoint
      > = draftCustomEndpoints.reduce(
        (acc, url) => {
          const now = Date.now();
          acc[url] = { url, addedAt: now, lastUsed: undefined };
          return acc;
        },
        {} as Record<string, import("@/types").CustomEndpoint>,
      );

      const hadEndpoints =
        initialData?.meta?.custom_endpoints &&
        Object.keys(initialData.meta.custom_endpoints).length > 0;
      const needsClearEndpoints =
        hadEndpoints && draftCustomEndpoints.length === 0;

      let mergedMeta = needsClearEndpoints
        ? mergeProviderMeta(initialData?.meta, {})
        : mergeProviderMeta(initialData?.meta, customEndpointsToSave);

      if (activePreset?.isPartner) {
        mergedMeta = {
          ...(mergedMeta ?? {}),
          isPartner: true,
        };
      }

      if (activePreset?.partnerPromotionKey) {
        mergedMeta = {
          ...(mergedMeta ?? {}),
          partnerPromotionKey: activePreset.partnerPromotionKey,
        };
      }

      if (mergedMeta !== undefined) {
        payload.meta = mergedMeta;
      }
    }

    const baseMeta: ProviderMeta | undefined =
      payload.meta ?? (initialData?.meta ? { ...initialData.meta } : undefined);
    if (baseMeta && "commonConfigEnabled" in baseMeta) {
      delete (baseMeta as Record<string, unknown>).commonConfigEnabled;
    }

    // 确定 providerType（新建时从预设获取，编辑时从现有数据获取）
    const providerType =
      templatePreset?.providerType || initialData?.meta?.providerType;
    const normalizedCodexModelRoutes =
      appId === "codex" && category !== "official"
        ? normalizeCodexModelRoutesForSave(
            codexModelRoutes.reduce<Record<string, CodexModelRoute>>(
              (result, row) => {
                const requestModel = row.requestModel.trim();
                const upstreamModel = row.upstreamModel.trim();
                if (!requestModel || !upstreamModel) return result;
                result[requestModel] = { model: upstreamModel };
                return result;
              },
              {},
            ),
          )
        : undefined;

    const nextMeta: ProviderMeta = {
      ...(baseMeta ?? {}),
      endpointAutoSelect,
      claudeDesktopMode: undefined,
      // 保存 providerType（用于识别 Copilot / Codex OAuth 等特殊供应商）
      providerType,
      authBinding: isCopilotProvider
        ? {
            source: "managed_account",
            authProvider: "github_copilot",
            accountId: selectedGitHubAccountId ?? undefined,
          }
        : isCodexOauthProvider
          ? {
              source: "managed_account",
              authProvider: "codex_oauth",
              accountId: selectedCodexAccountId ?? undefined,
            }
          : undefined,
      // GitHub Copilot 多账号：保存关联的账号 ID
      githubAccountId:
        isCopilotProvider && selectedGitHubAccountId
          ? selectedGitHubAccountId
          : undefined,
      codexFastMode: isCodexOauthProvider ? codexFastMode : undefined,
      codexChatReasoning:
        appId === "codex" &&
        category !== "official" &&
        localCodexApiFormat === "openai_chat"
          ? normalizeCodexChatReasoningForSave(codexChatReasoning)
          : undefined,
      codexLocalRoutingEnabled:
        appId === "codex" && category !== "official"
          ? codexTakeoverEnabled
          : undefined,
      codexModelRoutes: normalizedCodexModelRoutes,
      codexModelRoutesEnabled:
        appId === "codex" && category !== "official"
          ? codexModelRoutesEnabled
          : undefined,
      customUserAgent:
        (appId === "claude" || appId === "codex") && category !== "official"
          ? customUserAgent.trim() || undefined
          : undefined,
      localProxyRequestOverrides: shouldApplyLocalProxyRequestOverrides
        ? overridesResult.overrides
        : undefined,
      upstreamAdmissionRetry:
        normalizeAdmissionRetryConfigForSave(admissionRetryConfig),
      upstreamResponseReplay:
        appId === "codex"
          ? normalizeResponseReplayConfigForSave(responseReplayConfig)
          : undefined,
      maxConcurrentRequests: normalizeMaxConcurrentRequestsForSave(
        maxConcurrentRequests,
      ),
      testConfig: testConfig.enabled ? testConfig : undefined,
      costMultiplier: pricingConfig.enabled
        ? pricingConfig.costMultiplier
        : undefined,
      pricingModelSource:
        pricingConfig.enabled && pricingConfig.pricingModelSource !== "inherit"
          ? pricingConfig.pricingModelSource
          : undefined,
      apiFormat:
        appId === "claude" && category !== "official"
          ? localApiFormat
          : appId === "codex" && category !== "official"
            ? localCodexApiFormat
            : undefined,
      apiKeyField:
        appId === "claude" &&
        category !== "official" &&
        localApiKeyField !== "ANTHROPIC_AUTH_TOKEN"
          ? localApiKeyField
          : undefined,
      isFullUrl: nextIsFullUrl ? true : undefined,
    };

    if (!isCodexOauthProvider && "codexFastMode" in nextMeta) {
      delete nextMeta.codexFastMode;
    }

    if (appId === "codex") {
      const FEATURES_TOKEN = "config.toml:features";
      const existingQuirks = (nextMeta.quirks ?? {}) as Record<string, unknown>;
      const existingStripPaths = Array.isArray(existingQuirks.strip_paths)
        ? (existingQuirks.strip_paths as string[]).filter(
            (item) => item !== FEATURES_TOKEN,
          )
        : [];

      const nextQuirks: Record<string, unknown> = { ...existingQuirks };
      if (existingStripPaths.length > 0) {
        nextQuirks.strip_paths = existingStripPaths;
      } else {
        delete nextQuirks.strip_paths;
      }

      if (Object.keys(nextQuirks).length === 0) {
        delete (nextMeta as Record<string, unknown>).quirks;
      } else {
        nextMeta.quirks = nextQuirks as ProviderMeta["quirks"];
      }
    }

    payload.meta = nextMeta;

    await onSubmit(payload);
  };

  const shouldShowSpeedTest =
    category !== "official" && category !== "cloud_provider";

  const endpointUrlFieldValue = useMemo(() => {
    if (appId === "claude") return baseUrl;
    if (appId === "codex") return codexBaseUrl;
    if (appId === "gemini") return geminiBaseUrl;
    if (appId === "opencode") return opencodeForm.opencodeBaseUrl;
    if (appId === "openclaw") return openclawForm.openclawBaseUrl;
    if (appId === "hermes") return hermesForm.hermesBaseUrl;
    return "";
  }, [
    appId,
    baseUrl,
    codexBaseUrl,
    geminiBaseUrl,
    opencodeForm.opencodeBaseUrl,
    openclawForm.openclawBaseUrl,
    hermesForm.hermesBaseUrl,
  ]);

  const applyEndpointUrlFieldValue = useCallback(
    (nextUrl: string) => {
      if (appId === "claude") {
        handleClaudeBaseUrlChange(nextUrl);
      } else if (appId === "codex") {
        handleCodexBaseUrlChange(nextUrl);
      } else if (appId === "gemini") {
        handleGeminiBaseUrlChange(nextUrl);
      } else if (appId === "opencode") {
        opencodeForm.handleOpencodeBaseUrlChange(nextUrl);
      } else if (appId === "openclaw") {
        openclawForm.handleOpenclawBaseUrlChange(nextUrl);
      } else if (appId === "hermes") {
        hermesForm.handleHermesBaseUrlChange(nextUrl);
      }
    },
    [
      appId,
      handleClaudeBaseUrlChange,
      handleCodexBaseUrlChange,
      handleGeminiBaseUrlChange,
      opencodeForm.handleOpencodeBaseUrlChange,
      openclawForm.handleOpenclawBaseUrlChange,
      hermesForm.handleHermesBaseUrlChange,
    ],
  );

  useEffect(() => {
    if (syncingUrlFieldsRef.current) return;
    if (!canAutoSyncUrlFields || urlAutoSyncConsumedRef.current) return;

    const normalizedWebsite = normalizeUrlForSave(websiteUrlFieldValue);
    const normalizedEndpoint = normalizeUrlForSave(endpointUrlFieldValue);

    if (!normalizedWebsite && normalizedEndpoint) {
      const nextWebsite = normalizeWebsiteFromEndpoint(normalizedEndpoint);
      if (nextWebsite && nextWebsite !== normalizedEndpoint) {
        urlAutoSyncConsumedRef.current = true;
        syncingUrlFieldsRef.current = true;
        form.setValue("websiteUrl", nextWebsite, { shouldDirty: true });
        setTimeout(() => {
          syncingUrlFieldsRef.current = false;
        }, 0);
      }
      return;
    }

    if (!normalizedEndpoint && normalizedWebsite) {
      if (!isUsableHttpUrl(normalizedWebsite)) return;
      urlAutoSyncConsumedRef.current = true;
      syncingUrlFieldsRef.current = true;
      applyEndpointUrlFieldValue(normalizedWebsite);
      setTimeout(() => {
        syncingUrlFieldsRef.current = false;
      }, 0);
    }
  }, [
    applyEndpointUrlFieldValue,
    canAutoSyncUrlFields,
    endpointUrlFieldValue,
    form,
    websiteUrlFieldValue,
  ]);

  const {
    shouldShowApiKeyLink: shouldShowClaudeApiKeyLink,
    websiteUrl: claudeWebsiteUrl,
    isPartner: isClaudePartner,
    partnerPromotionKey: claudePartnerPromotionKey,
  } = useApiKeyLink({
    appId: "claude",
    category,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: websiteUrlFieldValue,
  });

  const {
    shouldShowApiKeyLink: shouldShowCodexApiKeyLink,
    websiteUrl: codexWebsiteUrl,
    isPartner: isCodexPartner,
    partnerPromotionKey: codexPartnerPromotionKey,
  } = useApiKeyLink({
    appId: "codex",
    category,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: websiteUrlFieldValue,
  });

  const {
    shouldShowApiKeyLink: shouldShowGeminiApiKeyLink,
    websiteUrl: geminiWebsiteUrl,
    isPartner: isGeminiPartner,
    partnerPromotionKey: geminiPartnerPromotionKey,
  } = useApiKeyLink({
    appId: "gemini",
    category,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: websiteUrlFieldValue,
  });

  const {
    shouldShowApiKeyLink: shouldShowOpencodeApiKeyLink,
    websiteUrl: opencodeWebsiteUrl,
    isPartner: isOpencodePartner,
    partnerPromotionKey: opencodePartnerPromotionKey,
  } = useApiKeyLink({
    appId: "opencode",
    category,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: websiteUrlFieldValue,
  });

  // 使用 API Key 链接 hook (OpenClaw)
  const {
    shouldShowApiKeyLink: shouldShowOpenclawApiKeyLink,
    websiteUrl: openclawWebsiteUrl,
    isPartner: isOpenclawPartner,
    partnerPromotionKey: openclawPartnerPromotionKey,
  } = useApiKeyLink({
    appId: "openclaw",
    category,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: websiteUrlFieldValue,
  });

  // 使用 API Key 链接 hook (Hermes)
  const {
    shouldShowApiKeyLink: shouldShowHermesApiKeyLink,
    websiteUrl: hermesWebsiteUrl,
    isPartner: isHermesPartner,
    partnerPromotionKey: hermesPartnerPromotionKey,
  } = useApiKeyLink({
    appId: "hermes",
    category,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: websiteUrlFieldValue,
  });

  // 使用端点测速候选 hook
  const speedTestEndpoints = useSpeedTestEndpoints({
    appId,
    selectedPresetId,
    presetEntries,
    baseUrl,
    codexBaseUrl,
    initialData,
  });

  const handlePresetChange = (value: string) => {
    setSelectedPresetId(value);
    if (value === "custom") {
      setActivePreset(null);
      form.reset(defaultValues);

      if (appId === "codex") {
        const seeded = getSeededCodexTemplate(seededSettingsConfig);
        if (seeded.config || Object.keys(seeded.auth).length > 0) {
          const seededModelCatalog = ((seededSettingsConfig as any)
            ?.modelCatalog?.models ?? []) as CodexCatalogModel[];
          resetCodexConfig(seeded.auth, seeded.config, seededModelCatalog);
          setCodexChatReasoning(
            (seededSettingsConfig as any)?.meta?.codexChatReasoning ?? {},
          );
          setCodexModelRoutes(
            modelRouteRowsFromMap(initialData?.meta?.codexModelRoutes ?? {}),
          );
          setCodexModelRoutesEnabled(
            getInitialCodexModelRoutesEnabled(initialData?.meta),
          );
          setLocalCodexApiFormat(
            codexApiFormatFromWireApi(extractCodexWireApi(seeded.config)) ??
              "openai_responses",
          );
          setCodexTakeoverEnabled(
            getInitialCodexLocalRoutingEnabled(
              initialData?.meta,
              seededSettingsConfig,
            ),
          );
        } else {
          const template = getCodexCustomTemplate();
          resetCodexConfig(template.auth, template.config);
          setCodexChatReasoning({});
          setCodexModelRoutes([]);
          setCodexModelRoutesEnabled(false);
          setLocalCodexApiFormat(
            codexApiFormatFromWireApi(extractCodexWireApi(template.config)) ??
              "openai_responses",
          );
          setCodexTakeoverEnabled(false);
        }
      }
      if (appId === "gemini") {
        const seeded = getSeededGeminiTemplate(seededSettingsConfig);
        resetGeminiConfig(seeded.env, seeded.config);
      }
      if (appId === "opencode") {
        opencodeForm.resetOpencodeState(
          (seededSettingsConfig as any) || undefined,
        );
        omoDraft.resetOmoDraftState();
      }
      if (appId === "openclaw") {
        openclawForm.resetOpenclawState(
          (seededSettingsConfig as any) || undefined,
        );
      }
      if (appId === "hermes") {
        hermesForm.resetHermesState((seededSettingsConfig as any) || undefined);
      }
      return;
    }

    const entry = presetEntries.find((item) => item.id === value);
    if (!entry) {
      return;
    }

    setActivePreset({
      id: value,
      category: entry.preset.category,
      isPartner: entry.preset.isPartner,
      partnerPromotionKey: entry.preset.partnerPromotionKey,
    });

    if (appId === "codex") {
      const preset = entry.preset as CodexProviderPreset;
      const auth = preset.auth ?? {};
      const config = preset.config ?? "";

      resetCodexConfig(auth, config, preset.modelCatalog ?? []);
      setCodexChatReasoning(preset.codexChatReasoning ?? {});
      setCodexModelRoutes([]);
      setCodexModelRoutesEnabled(false);
      setCodexTakeoverEnabled((preset.modelCatalog?.length ?? 0) > 0);
      setLocalCodexApiFormat(
        preset.apiFormat ??
          codexApiFormatFromWireApi(extractCodexWireApi(config)) ??
          "openai_responses",
      );

      form.reset({
        name: preset.nameKey ? t(preset.nameKey) : preset.name,
        websiteUrl: preset.websiteUrl ?? "",
        settingsConfig: JSON.stringify({ auth, config }, null, 2),
        icon: preset.icon ?? "",
        iconColor: preset.iconColor ?? "",
      });
      return;
    }

    if (appId === "gemini") {
      const preset = entry.preset as GeminiProviderPreset;
      const env = (preset.settingsConfig as any)?.env ?? {};
      const config = (preset.settingsConfig as any)?.config ?? {};

      resetGeminiConfig(env, config);

      form.reset({
        name: preset.nameKey ? t(preset.nameKey) : preset.name,
        websiteUrl: preset.websiteUrl ?? "",
        settingsConfig: JSON.stringify(preset.settingsConfig, null, 2),
        icon: preset.icon ?? "",
        iconColor: preset.iconColor ?? "",
      });
      return;
    }

    if (appId === "opencode") {
      const preset = entry.preset as OpenCodeProviderPreset;
      const config = preset.settingsConfig;

      if (preset.category === "omo" || preset.category === "omo-slim") {
        omoDraft.resetOmoDraftState();
        form.reset({
          name: preset.category === "omo" ? "OMO" : "OMO Slim",
          websiteUrl: preset.websiteUrl ?? "",
          settingsConfig: JSON.stringify({}, null, 2),
          icon: preset.icon ?? "",
          iconColor: preset.iconColor ?? "",
        });
        return;
      }

      opencodeForm.resetOpencodeState(config);

      form.reset({
        name: preset.nameKey ? t(preset.nameKey) : preset.name,
        websiteUrl: preset.websiteUrl ?? "",
        settingsConfig: JSON.stringify(config, null, 2),
        icon: preset.icon ?? "",
        iconColor: preset.iconColor ?? "",
      });
      return;
    }

    // OpenClaw preset handling
    if (appId === "openclaw") {
      const preset = entry.preset as OpenClawProviderPreset;
      const config = preset.settingsConfig;

      // Update activePreset with suggestedDefaults for OpenClaw
      setActivePreset({
        id: value,
        category: preset.category,
        isPartner: preset.isPartner,
        partnerPromotionKey: preset.partnerPromotionKey,
        suggestedDefaults: preset.suggestedDefaults,
      });

      openclawForm.resetOpenclawState(config);

      // Update form fields
      form.reset({
        name: preset.nameKey ? t(preset.nameKey) : preset.name,
        websiteUrl: preset.websiteUrl ?? "",
        settingsConfig: JSON.stringify(config, null, 2),
        icon: preset.icon ?? "",
        iconColor: preset.iconColor ?? "",
      });
      return;
    }

    // Hermes preset handling
    if (appId === "hermes") {
      const preset = entry.preset as HermesProviderPreset;
      const config = preset.settingsConfig;

      hermesForm.resetHermesState(config);

      form.reset({
        name: preset.nameKey ? t(preset.nameKey) : preset.name,
        websiteUrl: preset.websiteUrl ?? "",
        settingsConfig: JSON.stringify(config, null, 2),
        icon: preset.icon ?? "",
        iconColor: preset.iconColor ?? "",
      });
      return;
    }

    const preset = entry.preset as ProviderPreset;
    const config = applyTemplateValues(
      preset.settingsConfig,
      preset.templateValues,
    );

    if (preset.apiFormat) {
      setLocalApiFormat(preset.apiFormat);
    } else {
      setLocalApiFormat("anthropic");
    }

    setLocalApiKeyField(preset.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN");
    setLocalIsFullUrl(false);

    form.reset({
      name: preset.nameKey ? t(preset.nameKey) : preset.name,
      websiteUrl: preset.websiteUrl ?? "",
      settingsConfig: JSON.stringify(config, null, 2),
      icon: preset.icon ?? "",
      iconColor: preset.iconColor ?? "",
    });
  };

  const settingsConfigErrorField = (
    <FormField
      control={form.control}
      name="settingsConfig"
      render={() => (
        <FormItem className="space-y-0">
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <>
      <Form {...form}>
        <form
          id="provider-form"
          onSubmit={form.handleSubmit(handleSubmit)}
          className="space-y-6 glass rounded-xl p-6 border border-white/10"
        >
          {!initialData && (
            <ProviderPresetSelector
              selectedPresetId={selectedPresetId}
              presetEntries={presetEntries}
              presetCategoryLabels={presetCategoryLabels}
              onPresetChange={handlePresetChange}
              onUniversalPresetSelect={onUniversalPresetSelect}
              onManageUniversalProviders={onManageUniversalProviders}
              category={category}
            />
          )}

          <BasicFormFields
            form={form}
            beforeNameSlot={
              appId === "opencode" && !isAnyOmoCategory ? (
                <div className="space-y-2">
                  <Label htmlFor="opencode-key">
                    {t("opencode.providerKey")}
                    <span className="text-destructive ml-1">*</span>
                  </Label>
                  <Input
                    id="opencode-key"
                    value={opencodeForm.opencodeProviderKey}
                    onChange={(e) =>
                      opencodeForm.setOpencodeProviderKey(
                        e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                      )
                    }
                    placeholder={t("opencode.providerKeyPlaceholder")}
                    disabled={
                      isProviderKeyLocked || isProviderKeyLockStateLoading
                    }
                    className={
                      (additiveExistingProviderKeys.includes(
                        opencodeForm.opencodeProviderKey,
                      ) &&
                        !isProviderKeyLocked) ||
                      (opencodeForm.opencodeProviderKey.trim() !== "" &&
                        !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                          opencodeForm.opencodeProviderKey,
                        ))
                        ? "border-destructive"
                        : ""
                    }
                  />
                  {additiveExistingProviderKeys.includes(
                    opencodeForm.opencodeProviderKey,
                  ) &&
                    !isProviderKeyLocked && (
                      <p className="text-xs text-destructive">
                        {t("opencode.providerKeyDuplicate")}
                      </p>
                    )}
                  {opencodeForm.opencodeProviderKey.trim() !== "" &&
                    !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                      opencodeForm.opencodeProviderKey,
                    ) && (
                      <p className="text-xs text-destructive">
                        {t("opencode.providerKeyInvalid")}
                      </p>
                    )}
                  {!(
                    additiveExistingProviderKeys.includes(
                      opencodeForm.opencodeProviderKey,
                    ) && !isProviderKeyLocked
                  ) &&
                    (opencodeForm.opencodeProviderKey.trim() === "" ||
                      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                        opencodeForm.opencodeProviderKey,
                      )) && (
                      <p className="text-xs text-muted-foreground">
                        {isProviderKeyLocked
                          ? t("opencode.providerKeyLockedHint", {
                              defaultValue:
                                "该供应商已添加到应用配置中，供应商标识不可修改",
                            })
                          : t("opencode.providerKeyHint")}
                      </p>
                    )}
                </div>
              ) : appId === "openclaw" ? (
                <div className="space-y-2">
                  <Label htmlFor="openclaw-key">
                    {t("openclaw.providerKey")}
                    <span className="text-destructive ml-1">*</span>
                  </Label>
                  <Input
                    id="openclaw-key"
                    value={openclawForm.openclawProviderKey}
                    onChange={(e) =>
                      openclawForm.setOpenclawProviderKey(
                        e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                      )
                    }
                    placeholder={t("openclaw.providerKeyPlaceholder")}
                    disabled={
                      isProviderKeyLocked || isProviderKeyLockStateLoading
                    }
                    className={
                      (additiveExistingProviderKeys.includes(
                        openclawForm.openclawProviderKey,
                      ) &&
                        !isProviderKeyLocked) ||
                      (openclawForm.openclawProviderKey.trim() !== "" &&
                        !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                          openclawForm.openclawProviderKey,
                        ))
                        ? "border-destructive"
                        : ""
                    }
                  />
                  {additiveExistingProviderKeys.includes(
                    openclawForm.openclawProviderKey,
                  ) &&
                    !isProviderKeyLocked && (
                      <p className="text-xs text-destructive">
                        {t("openclaw.providerKeyDuplicate")}
                      </p>
                    )}
                  {openclawForm.openclawProviderKey.trim() !== "" &&
                    !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                      openclawForm.openclawProviderKey,
                    ) && (
                      <p className="text-xs text-destructive">
                        {t("openclaw.providerKeyInvalid")}
                      </p>
                    )}
                  {!(
                    additiveExistingProviderKeys.includes(
                      openclawForm.openclawProviderKey,
                    ) && !isProviderKeyLocked
                  ) &&
                    (openclawForm.openclawProviderKey.trim() === "" ||
                      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                        openclawForm.openclawProviderKey,
                      )) && (
                      <p className="text-xs text-muted-foreground">
                        {isProviderKeyLocked
                          ? t("openclaw.providerKeyLockedHint", {
                              defaultValue:
                                "该供应商已添加到应用配置中，供应商标识不可修改",
                            })
                          : t("openclaw.providerKeyHint")}
                      </p>
                    )}
                </div>
              ) : appId === "hermes" ? (
                <div className="space-y-2">
                  <Label htmlFor="hermes-key">
                    {t("hermes.form.providerKey", {
                      defaultValue: "Provider Key",
                    })}
                    <span className="text-destructive ml-1">*</span>
                  </Label>
                  <Input
                    id="hermes-key"
                    value={hermesForm.hermesProviderKey}
                    onChange={(e) =>
                      hermesForm.setHermesProviderKey(
                        e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                      )
                    }
                    placeholder={t("hermes.form.providerKeyPlaceholder", {
                      defaultValue: "my-provider",
                    })}
                    disabled={
                      isProviderKeyLocked || isProviderKeyLockStateLoading
                    }
                    className={
                      (additiveExistingProviderKeys.includes(
                        hermesForm.hermesProviderKey,
                      ) &&
                        !isProviderKeyLocked) ||
                      (hermesForm.hermesProviderKey.trim() !== "" &&
                        !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                          hermesForm.hermesProviderKey,
                        ))
                        ? "border-destructive"
                        : ""
                    }
                  />
                  {additiveExistingProviderKeys.includes(
                    hermesForm.hermesProviderKey,
                  ) &&
                    !isProviderKeyLocked && (
                      <p className="text-xs text-destructive">
                        {t("hermes.form.providerKeyDuplicate")}
                      </p>
                    )}
                  {hermesForm.hermesProviderKey.trim() !== "" &&
                    !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                      hermesForm.hermesProviderKey,
                    ) && (
                      <p className="text-xs text-destructive">
                        {t("hermes.form.providerKeyInvalid")}
                      </p>
                    )}
                  {!(
                    additiveExistingProviderKeys.includes(
                      hermesForm.hermesProviderKey,
                    ) && !isProviderKeyLocked
                  ) &&
                    (hermesForm.hermesProviderKey.trim() === "" ||
                      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(
                        hermesForm.hermesProviderKey,
                      )) && (
                      <p className="text-xs text-muted-foreground">
                        {isProviderKeyLocked
                          ? t("hermes.form.providerKeyLockedHint", {
                              defaultValue:
                                "This provider is in Hermes config; key is locked.",
                            })
                          : t("hermes.form.providerKeyHint", {
                              defaultValue:
                                "Lowercase letters, numbers, and hyphens only. Used as the provider name in config.yaml.",
                            })}
                      </p>
                    )}
                </div>
              ) : undefined
            }
          />

          {appId === "claude" && (
            <ClaudeFormFields
              providerId={providerId}
              shouldShowApiKey={
                (category !== "cloud_provider" ||
                  hasApiKeyField(form.getValues("settingsConfig"), "claude")) &&
                shouldShowApiKey(form.getValues("settingsConfig"), isEditMode)
              }
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              category={category}
              shouldShowApiKeyLink={shouldShowClaudeApiKeyLink}
              websiteUrl={claudeWebsiteUrl}
              isPartner={isClaudePartner}
              partnerPromotionKey={claudePartnerPromotionKey}
              isCopilotPreset={
                templatePreset?.providerType === "github_copilot" ||
                initialData?.meta?.providerType === "github_copilot" ||
                baseUrl.includes("githubcopilot.com")
              }
              isCodexOauthPreset={
                templatePreset?.providerType === "codex_oauth" ||
                initialData?.meta?.providerType === "codex_oauth"
              }
              usesOAuth={
                templatePreset?.requiresOAuth === true ||
                templatePreset?.providerType === "github_copilot" ||
                initialData?.meta?.providerType === "github_copilot" ||
                baseUrl.includes("githubcopilot.com") ||
                templatePreset?.providerType === "codex_oauth" ||
                initialData?.meta?.providerType === "codex_oauth"
              }
              isCopilotAuthenticated={isCopilotAuthenticated}
              selectedGitHubAccountId={selectedGitHubAccountId}
              onGitHubAccountSelect={setSelectedGitHubAccountId}
              isCodexOauthAuthenticated={isCodexOauthAuthenticated}
              selectedCodexAccountId={selectedCodexAccountId}
              onCodexAccountSelect={setSelectedCodexAccountId}
              codexFastMode={codexFastMode}
              onCodexFastModeChange={setCodexFastMode}
              templateValueEntries={templateValueEntries}
              templateValues={templateValues}
              templatePresetName={templatePreset?.name || ""}
              onTemplateValueChange={handleTemplateValueChange}
              shouldShowSpeedTest={shouldShowSpeedTest}
              baseUrl={baseUrl}
              onBaseUrlChange={handleClaudeBaseUrlChange}
              isEndpointModalOpen={isEndpointModalOpen}
              onEndpointModalToggle={setIsEndpointModalOpen}
              onCustomEndpointsChange={
                isEditMode ? undefined : setDraftCustomEndpoints
              }
              autoSelect={endpointAutoSelect}
              onAutoSelectChange={setEndpointAutoSelect}
              showEndpointTools
              shouldShowModelSelector={category !== "official"}
              claudeModel={claudeModel}
              defaultHaikuModel={defaultHaikuModel}
              defaultHaikuModelName={defaultHaikuModelName}
              defaultSonnetModel={defaultSonnetModel}
              defaultSonnetModelName={defaultSonnetModelName}
              defaultOpusModel={defaultOpusModel}
              defaultOpusModelName={defaultOpusModelName}
              defaultFableModel={defaultFableModel}
              defaultFableModelName={defaultFableModelName}
              subagentModel={subagentModel}
              onModelChange={handleModelChange}
              speedTestEndpoints={speedTestEndpoints}
              apiFormat={localApiFormat}
              onApiFormatChange={handleApiFormatChange}
              apiKeyField={localApiKeyField}
              onApiKeyFieldChange={handleApiKeyFieldChange}
              isFullUrl={localIsFullUrl}
              onFullUrlChange={setLocalIsFullUrl}
              customUserAgent={customUserAgent}
              onCustomUserAgentChange={setCustomUserAgent}
              localProxyHeadersOverride={localProxyHeadersOverride}
              onLocalProxyHeadersOverrideChange={setLocalProxyHeadersOverride}
              localProxyBodyOverride={localProxyBodyOverride}
              onLocalProxyBodyOverrideChange={setLocalProxyBodyOverride}
            />
          )}

          {appId === "codex" && (
            <CodexFormFields
              providerId={providerId}
              codexApiKey={codexApiKey}
              onApiKeyChange={handleCodexApiKeyChange}
              category={category}
              shouldShowApiKeyLink={shouldShowCodexApiKeyLink}
              websiteUrl={codexWebsiteUrl}
              isPartner={isCodexPartner}
              partnerPromotionKey={codexPartnerPromotionKey}
              shouldShowSpeedTest={shouldShowSpeedTest}
              codexBaseUrl={codexBaseUrl}
              onBaseUrlChange={handleCodexBaseUrlChange}
              isFullUrl={localIsFullUrl}
              onFullUrlChange={setLocalIsFullUrl}
              isEndpointModalOpen={isCodexEndpointModalOpen}
              onEndpointModalToggle={setIsCodexEndpointModalOpen}
              onCustomEndpointsChange={
                isEditMode ? undefined : setDraftCustomEndpoints
              }
              autoSelect={endpointAutoSelect}
              onAutoSelectChange={setEndpointAutoSelect}
              takeoverEnabled={codexTakeoverEnabled}
              onTakeoverEnabledChange={setCodexTakeoverEnabled}
              apiFormat={localCodexApiFormat}
              onApiFormatChange={handleCodexApiFormatChange}
              codexChatReasoning={codexChatReasoning}
              onCodexChatReasoningChange={setCodexChatReasoning}
              catalogModels={codexCatalogModels}
              onCatalogModelsChange={setCodexCatalogModels}
              modelRoutesEnabled={codexModelRoutesEnabled}
              onModelRoutesEnabledChange={setCodexModelRoutesEnabled}
              modelRoutes={codexModelRoutes}
              onModelRoutesChange={setCodexModelRoutes}
              speedTestEndpoints={speedTestEndpoints}
              customUserAgent={customUserAgent}
              onCustomUserAgentChange={setCustomUserAgent}
              localProxyHeadersOverride={localProxyHeadersOverride}
              onLocalProxyHeadersOverrideChange={setLocalProxyHeadersOverride}
              localProxyBodyOverride={localProxyBodyOverride}
              onLocalProxyBodyOverrideChange={setLocalProxyBodyOverride}
            />
          )}

          {appId === "gemini" && (
            <GeminiFormFields
              providerId={providerId}
              shouldShowApiKey={shouldShowApiKey(
                form.getValues("settingsConfig"),
                isEditMode,
              )}
              apiKey={geminiApiKey}
              onApiKeyChange={handleGeminiApiKeyChange}
              category={category}
              shouldShowApiKeyLink={shouldShowGeminiApiKeyLink}
              websiteUrl={geminiWebsiteUrl}
              isPartner={isGeminiPartner}
              partnerPromotionKey={geminiPartnerPromotionKey}
              shouldShowSpeedTest={shouldShowSpeedTest}
              baseUrl={geminiBaseUrl}
              onBaseUrlChange={handleGeminiBaseUrlChange}
              isEndpointModalOpen={isEndpointModalOpen}
              onEndpointModalToggle={setIsEndpointModalOpen}
              onCustomEndpointsChange={setDraftCustomEndpoints}
              autoSelect={endpointAutoSelect}
              onAutoSelectChange={setEndpointAutoSelect}
              shouldShowModelField={true}
              model={geminiModel}
              onModelChange={handleGeminiModelChange}
              speedTestEndpoints={speedTestEndpoints}
            />
          )}

          {appId === "opencode" && !isAnyOmoCategory && (
            <OpenCodeFormFields
              npm={opencodeForm.opencodeNpm}
              onNpmChange={opencodeForm.handleOpencodeNpmChange}
              apiKey={opencodeForm.opencodeApiKey}
              onApiKeyChange={opencodeForm.handleOpencodeApiKeyChange}
              category={category}
              shouldShowApiKeyLink={shouldShowOpencodeApiKeyLink}
              websiteUrl={opencodeWebsiteUrl}
              isPartner={isOpencodePartner}
              partnerPromotionKey={opencodePartnerPromotionKey}
              baseUrl={opencodeForm.opencodeBaseUrl}
              onBaseUrlChange={opencodeForm.handleOpencodeBaseUrlChange}
              models={opencodeForm.opencodeModels}
              onModelsChange={opencodeForm.handleOpencodeModelsChange}
              extraOptions={opencodeForm.opencodeExtraOptions}
              onExtraOptionsChange={
                opencodeForm.handleOpencodeExtraOptionsChange
              }
            />
          )}

          {appId === "opencode" &&
            (category === "omo" || category === "omo-slim") && (
              <OmoFormFields
                modelOptions={omoModelOptions}
                modelVariantsMap={omoModelVariantsMap}
                presetMetaMap={omoPresetMetaMap}
                agents={omoDraft.omoAgents}
                onAgentsChange={omoDraft.setOmoAgents}
                categories={
                  category === "omo" ? omoDraft.omoCategories : undefined
                }
                onCategoriesChange={
                  category === "omo" ? omoDraft.setOmoCategories : undefined
                }
                otherFieldsStr={omoDraft.omoOtherFieldsStr}
                onOtherFieldsStrChange={omoDraft.setOmoOtherFieldsStr}
                isSlim={category === "omo-slim"}
              />
            )}

          {/* OpenClaw 专属字段 */}
          {appId === "openclaw" && (
            <OpenClawFormFields
              baseUrl={openclawForm.openclawBaseUrl}
              onBaseUrlChange={openclawForm.handleOpenclawBaseUrlChange}
              apiKey={openclawForm.openclawApiKey}
              onApiKeyChange={openclawForm.handleOpenclawApiKeyChange}
              category={category}
              shouldShowApiKeyLink={shouldShowOpenclawApiKeyLink}
              websiteUrl={openclawWebsiteUrl}
              isPartner={isOpenclawPartner}
              partnerPromotionKey={openclawPartnerPromotionKey}
              api={openclawForm.openclawApi}
              onApiChange={openclawForm.handleOpenclawApiChange}
              models={openclawForm.openclawModels}
              onModelsChange={openclawForm.handleOpenclawModelsChange}
              userAgent={openclawForm.openclawUserAgent}
              onUserAgentChange={openclawForm.handleOpenclawUserAgentChange}
            />
          )}

          {/* Hermes 专属字段 */}
          {appId === "hermes" && (
            <HermesFormFields
              baseUrl={hermesForm.hermesBaseUrl}
              onBaseUrlChange={hermesForm.handleHermesBaseUrlChange}
              apiKey={hermesForm.hermesApiKey}
              onApiKeyChange={hermesForm.handleHermesApiKeyChange}
              category={category}
              shouldShowApiKeyLink={shouldShowHermesApiKeyLink}
              websiteUrl={hermesWebsiteUrl}
              isPartner={isHermesPartner}
              partnerPromotionKey={hermesPartnerPromotionKey}
              apiMode={hermesForm.hermesApiMode}
              onApiModeChange={hermesForm.handleHermesApiModeChange}
              models={hermesForm.hermesModels}
              onModelsChange={hermesForm.handleHermesModelsChange}
              rateLimitDelay={hermesForm.hermesRateLimitDelay}
              onRateLimitDelayChange={
                hermesForm.handleHermesRateLimitDelayChange
              }
            />
          )}

          {!isAnyOmoCategory &&
            appId !== "opencode" &&
            appId !== "openclaw" &&
            appId !== "hermes" && (
              <ProviderRoutingRetryConfig
                admissionRetryConfig={admissionRetryConfig}
                responseReplayConfig={responseReplayConfig}
                showResponseReplay={appId === "codex"}
                maxConcurrentRequests={maxConcurrentRequests}
                onAdmissionRetryConfigChange={setAdmissionRetryConfig}
                onResponseReplayConfigChange={setResponseReplayConfig}
                onMaxConcurrentRequestsChange={setMaxConcurrentRequests}
              />
            )}

          {/* 配置编辑器：Codex、Claude、Gemini 分别使用不同的编辑器 */}
          {appId === "codex" ? (
            <>
              <CodexConfigEditor
                authValue={codexAuth}
                configValue={codexConfig}
                isProxyTakeover={isProxyTakeover}
                onAuthChange={setCodexAuth}
                onConfigChange={handleCodexConfigChange}
                useCommonConfig={useCodexCommonConfigFlag}
                onCommonConfigToggle={handleCodexCommonConfigToggle}
                commonConfigSnippet={codexCommonConfigSnippet}
                onCommonConfigSnippetChange={
                  handleCodexCommonConfigSnippetChange
                }
                onCommonConfigErrorClear={clearCodexCommonConfigError}
                commonConfigError={codexCommonConfigError}
                authError={codexAuthError}
                configError={codexConfigError}
                onExtract={handleCodexExtract}
                isExtracting={isCodexExtracting}
                showCommonConfig={false}
              />
              {settingsConfigErrorField}
            </>
          ) : appId === "gemini" ? (
            <>
              <GeminiConfigEditor
                envValue={geminiEnv}
                configValue={geminiConfig}
                onEnvChange={handleGeminiEnvChange}
                onConfigChange={handleGeminiConfigChange}
                useCommonConfig={useGeminiCommonConfigFlag}
                onCommonConfigToggle={handleGeminiCommonConfigToggle}
                commonConfigSnippet={geminiCommonConfigSnippet}
                onCommonConfigSnippetChange={
                  handleGeminiCommonConfigSnippetChange
                }
                onCommonConfigErrorClear={clearGeminiCommonConfigError}
                commonConfigError={geminiCommonConfigError}
                envError={envError}
                configError={geminiConfigError}
                onExtract={handleGeminiExtract}
                isExtracting={isGeminiExtracting}
                showCommonConfig={false}
              />
              {settingsConfigErrorField}
            </>
          ) : appId === "opencode" &&
            (category === "omo" || category === "omo-slim") ? (
            <div className="space-y-2">
              <Label>{t("provider.configJson")}</Label>
              <JsonEditor
                value={omoDraft.mergedOmoJsonPreview}
                onChange={() => {}}
                rows={14}
                showValidation={false}
                language="json"
                darkMode={isDarkMode}
              />
            </div>
          ) : appId === "opencode" &&
            category !== "omo" &&
            category !== "omo-slim" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="settingsConfig">
                  {t("provider.configJson")}
                </Label>
                <JsonEditor
                  value={form.getValues("settingsConfig")}
                  onChange={(config) => form.setValue("settingsConfig", config)}
                  placeholder={`{
  "npm": "@ai-sdk/openai-compatible",
  "options": {
    "baseURL": "https://your-api-endpoint.com",
    "apiKey": "your-api-key-here"
  },
  "models": {}
}`}
                  rows={14}
                  showValidation={true}
                  language="json"
                  darkMode={isDarkMode}
                />
              </div>
              {settingsConfigErrorField}
            </>
          ) : appId === "openclaw" || appId === "hermes" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="settingsConfig">
                  {t("provider.configJson")}
                </Label>
                <JsonEditor
                  value={form.getValues("settingsConfig")}
                  onChange={(config) => form.setValue("settingsConfig", config)}
                  placeholder={
                    appId === "hermes"
                      ? `{
  "name": "my-provider",
  "base_url": "https://api.example.com/v1",
  "api_key": ""
}`
                      : `{
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "your-api-key-here",
  "api": "openai-completions",
  "models": []
}`
                  }
                  rows={14}
                  showValidation={true}
                  language="json"
                  darkMode={isDarkMode}
                />
              </div>
              <FormField
                control={form.control}
                name="settingsConfig"
                render={() => (
                  <FormItem className="space-y-0">
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="settingsConfig">
                  {t("provider.configJson")}
                </Label>
                <JsonEditor
                  value={form.getValues("settingsConfig")}
                  onChange={(value) => form.setValue("settingsConfig", value)}
                  rows={14}
                  showValidation={true}
                  language="json"
                />
              </div>
              <FormField
                control={form.control}
                name="settingsConfig"
                render={() => (
                  <FormItem className="space-y-0">
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}

          {!isAnyOmoCategory &&
            appId !== "opencode" &&
            appId !== "openclaw" &&
            appId !== "hermes" && (
              <ProviderAdvancedConfig
                testConfig={testConfig}
                pricingConfig={pricingConfig}
                onTestConfigChange={setTestConfig}
                onPricingConfigChange={setPricingConfig}
              />
            )}

          {showButtons && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" type="button" onClick={onCancel}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting || isConfirmSubmitting}
              >
                {submitLabel}
              </Button>
            </div>
          )}
        </form>
      </Form>

      <ConfirmDialog
        isOpen={showCommonConfigNotice}
        variant="info"
        title={t("confirm.commonConfig.title")}
        message={t("confirm.commonConfig.message")}
        confirmText={t("confirm.commonConfig.confirm")}
        onConfirm={() => void handleCommonConfigConfirm()}
        onCancel={() => void handleCommonConfigConfirm()}
      />

      <ConfirmDialog
        isOpen={softIssues !== null && softIssues.length > 0}
        variant="info"
        title={t("providerForm.softValidation.title", {
          defaultValue: "配置存在以下问题",
        })}
        message={
          (softIssues ?? []).map((issue) => `• ${issue}`).join("\n") +
          "\n\n" +
          t("providerForm.softValidation.hint", {
            defaultValue:
              "仍要保存吗？保存后切换此供应商时可能失败，可以之后再补全。",
          })
        }
        confirmText={t("providerForm.softValidation.saveAnyway", {
          defaultValue: "仍要保存",
        })}
        cancelText={t("common.cancel")}
        onConfirm={async () => {
          if (isConfirmSubmitting) return;
          const values = pendingFormValues;
          const overridesResult = pendingLocalProxyRequestOverridesResult;
          if (!values || !overridesResult) {
            setSoftIssues(null);
            setPendingFormValues(null);
            setPendingLocalProxyRequestOverridesResult(null);
            return;
          }
          setIsConfirmSubmitting(true);
          try {
            await performSubmit(values, overridesResult);
            setSoftIssues(null);
            setPendingFormValues(null);
            setPendingLocalProxyRequestOverridesResult(null);
          } catch (error) {
            console.error("[ProviderForm] soft-confirm submit failed:", error);
            // 保留确认框和 pending values，让用户可以重试或取消
          } finally {
            setIsConfirmSubmitting(false);
          }
        }}
        onCancel={() => {
          if (isConfirmSubmitting) return;
          setSoftIssues(null);
          setPendingFormValues(null);
          setPendingLocalProxyRequestOverridesResult(null);
        }}
      />
    </>
  );
}

export type ProviderFormValues = ProviderFormData & {
  presetId?: string;
  presetCategory?: ProviderCategory;
  isPartner?: boolean;
  meta?: ProviderMeta;
  providerKey?: string; // OpenCode/OpenClaw: user-defined provider key
  suggestedDefaults?: OpenClawSuggestedDefaults; // OpenClaw: suggested default model configuration
};
