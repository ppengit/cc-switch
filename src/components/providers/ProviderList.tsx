import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpToLine,
  BarChart2,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  CircleArrowRight,
  Copy,
  DoorOpen,
  FileText,
  GripVertical,
  History,
  Loader2,
  Pencil,
  Route,
  Search,
  SlidersHorizontal,
  Terminal,
  TestTube2,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { Provider, SessionMeta } from "@/types";
import type { ProviderAdmissionRetryEvent } from "@/types/proxy";
import type { AppId } from "@/lib/api";
import { providersApi } from "@/lib/api/providers";
import { sessionsApi } from "@/lib/api/sessions";
import { configApi } from "@/lib/api";
import type { AppConfigTemplateFile } from "@/lib/api/config";
import { proxyApi } from "@/lib/api/proxy";
import { useDragSort } from "@/hooks/useDragSort";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useOpenClawLiveProviderIds,
  useOpenClawDefaultModel,
  openclawKeys,
} from "@/hooks/useOpenClaw";
import {
  useHermesLiveProviderIds,
  useHermesModelConfig,
  hermesKeys,
} from "@/hooks/useHermes";
import { useStreamCheck } from "@/hooks/useStreamCheck";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";
import {
  useAutoFailoverEnabled,
  useFailoverQueue,
  useAddToFailoverQueue,
  useRemoveFromFailoverQueue,
  useProviderHealth,
  useCircuitBreakerStats,
} from "@/lib/query/failover";
import {
  useCurrentOmoProviderId,
  useCurrentOmoSlimProviderId,
} from "@/lib/query/omo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PROVIDER_TYPES } from "@/config/constants";
import { isHermesReadOnlyProvider } from "@/config/hermesProviderPresets";
import {
  extractCodexBaseUrl,
  setCodexBaseUrl,
} from "@/utils/providerConfigUtils";
import { pruneProxyStatusProviderActivity } from "@/lib/proxyActivity";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { SessionRoutingManagerDialog } from "@/components/proxy/SessionRoutingManagerDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DEFAULT_CLAUDE_HAIKU_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_OPUS_MODEL,
  DEFAULT_CLAUDE_SONNET_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PROVIDER_MODEL,
  DEFAULT_PROVIDER_MODEL_LABEL,
} from "@/config/defaultModels";
import { isTextEditableTarget } from "@/utils/domUtils";

interface ProviderListProps {
  providers: Record<string, Provider>;
  currentProviderId: string;
  appId: AppId;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider, options?: { isEnabled: boolean }) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider) => void;
  onCreate?: () => void;
  isLoading?: boolean;
  isProxyRunning?: boolean;
  isProxyTakeover?: boolean;
  activeProviderId?: string;
  activeRequestProviders?: Record<
    string,
    {
      count: number;
      model?: string;
      requestModel?: string;
      upstreamModel?: string;
    }
  >;
  onSetAsDefault?: (provider: Provider) => void;
}

type StatusSortDirection = "asc" | "desc" | null;
type ModelSortDirection = "asc" | "desc";
type ProviderInteractionMode = "direct" | "takeover" | "failover" | "additive";

interface ProviderRowView {
  provider: Provider;
  modeState: "live_current" | "proxy_target" | "failover_enabled" | "inactive";
  isOmo: boolean;
  isOmoSlim: boolean;
  isAnyOmo: boolean;
  isCurrent: boolean;
  isInConfig: boolean;
  isReadOnly: boolean;
  isEnabled: boolean;
  isProxyModeResolving: boolean;
  isActiveProxyProvider: boolean;
  isProcessingProvider: boolean;
  activeRequestCount: number;
  activeRequestModel?: string;
  activeRequestRequestModel?: string;
  activeRequestUpstreamModel?: string;
  admissionRetryEnabled: boolean;
  admissionRetryCount: number;
  admissionRetryState?: ProviderAdmissionRetryEvent["event"];
  admissionRetryAdmittedCount: number;
  admissionRetryStatus?: number | null;
  admissionRetryLastError?: string | null;
  admissionRetryLastFailureAt?: string | null;
  admissionRetryDelayMs?: number | null;
  failoverPriority?: number;
  orderNumber: number;
  statusRank: number;
  modelDisplay: string;
  endpointDisplay: string;
  nameLink?: string;
  canDelete: boolean;
  canTest: boolean;
}

interface SearchMatchInfo {
  providerId: string;
  rowIndex: number;
}

type AdmissionRetryRequestEvents = Record<
  string,
  Record<string, ProviderAdmissionRetryEvent>
>;

interface AppConfigFileEntry {
  key: string;
  label: string;
  path: string;
}

const URL_WITHOUT_TRAILING_SLASH = /\/+$/;
const URL_V1_SUFFIX = /\/v1$/i;
const URL_V1_SEGMENT = /(\/v1)(?=\/|$|[?#])/i;

const stripTrailingSlash = (value?: string | null) =>
  (value || "").trim().replace(URL_WITHOUT_TRAILING_SLASH, "");

const stripV1Suffix = (value: string) => value.replace(URL_V1_SUFFIX, "");

const stripFromV1Segment = (value: string) => {
  const normalized = stripTrailingSlash(value);
  if (!normalized) return "";
  const match = normalized.match(URL_V1_SEGMENT);
  if (!match || typeof match.index !== "number") return normalized;
  return normalized.slice(0, match.index) || normalized;
};

const normalizeOptionalUrl = (value?: string | null) => {
  const normalized = stripTrailingSlash(value);
  return normalized || "";
};

const firstNonEmpty = (...values: Array<string | undefined | null>) => {
  for (const value of values) {
    const trimmed = (value || "").trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
};

const getCodexModelFromToml = (configText?: string) => {
  if (!configText) return "";
  const match = configText.match(/^\s*model\s*=\s*['"]([^'"]+)['"]/m);
  return match?.[1] || "";
};

const getProviderTemplateBindings = (provider: Provider, appId: AppId) => {
  const cfg =
    provider.settingsConfig && typeof provider.settingsConfig === "object"
      ? (provider.settingsConfig as Record<string, any>)
      : {};

  if (appId === "claude") {
    const env = (cfg.env || {}) as Record<string, any>;
    return {
      baseUrl: firstNonEmpty(env.ANTHROPIC_BASE_URL),
      apiKey: firstNonEmpty(
        env.ANTHROPIC_AUTH_TOKEN,
        env.ANTHROPIC_API_KEY,
        env.OPENAI_API_KEY,
      ),
      model: firstNonEmpty(
        env.ANTHROPIC_MODEL,
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      ),
    };
  }

  if (appId === "codex") {
    const auth = (cfg.auth || {}) as Record<string, any>;
    return {
      baseUrl: firstNonEmpty(
        extractCodexBaseUrl(typeof cfg.config === "string" ? cfg.config : ""),
      ),
      apiKey: firstNonEmpty(auth.OPENAI_API_KEY),
      model: firstNonEmpty(
        getCodexModelFromToml(typeof cfg.config === "string" ? cfg.config : ""),
      ),
    };
  }

  if (appId === "gemini") {
    const env = (cfg.env || {}) as Record<string, any>;
    return {
      baseUrl: firstNonEmpty(env.GOOGLE_GEMINI_BASE_URL),
      apiKey: firstNonEmpty(env.GEMINI_API_KEY),
      model: firstNonEmpty(env.GEMINI_MODEL),
    };
  }

  if (appId === "opencode") {
    const options = (cfg.options || {}) as Record<string, any>;
    const models = (cfg.models || {}) as Record<string, any>;
    return {
      baseUrl: firstNonEmpty(options.baseURL),
      apiKey: firstNonEmpty(options.apiKey),
      model: firstNonEmpty(Object.keys(models)[0]),
    };
  }

  if (appId === "openclaw") {
    const models = Array.isArray(cfg.models) ? cfg.models : [];
    return {
      baseUrl: firstNonEmpty(cfg.baseUrl),
      apiKey: firstNonEmpty(cfg.apiKey),
      model: firstNonEmpty(models[0]?.id),
    };
  }

  if (appId === "hermes") {
    const models = Array.isArray(cfg.models) ? cfg.models : [];
    return {
      baseUrl: firstNonEmpty(cfg.base_url),
      apiKey: firstNonEmpty(cfg.api_key),
      model: firstNonEmpty(models[0]?.id, cfg.model),
    };
  }

  return { baseUrl: "", apiKey: "", model: "" };
};

const replaceTemplatePlaceholders = (
  value: unknown,
  bindings: Record<string, string>,
  appId: AppId,
): unknown => {
  if (typeof value === "string") {
    const defaultModel =
      appId === "claude"
        ? DEFAULT_CLAUDE_MODEL
        : appId === "gemini"
          ? DEFAULT_GEMINI_MODEL
          : DEFAULT_PROVIDER_MODEL;
    return value
      .replace(/\{baseUrl\}/g, bindings.baseUrl || "")
      .replace(/\{apiKey\}/g, bindings.apiKey || "")
      .replace(/\{model\}/g, bindings.model || defaultModel);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceTemplatePlaceholders(item, bindings, appId),
    );
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        replaceTemplatePlaceholders(entry, bindings, appId),
      ]),
    );
  }

  return value;
};

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

const getNestedValue = (target: unknown, path: string[]) => {
  let cursor = target;
  for (const key of path) {
    cursor = asRecord(cursor)[key];
  }
  return cursor;
};

const setNestedValue = (
  target: Record<string, any>,
  path: string[],
  value: string,
) => {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const existing = cursor[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, any>;
  }
  cursor[path[path.length - 1]] = value;
};

const preserveNonEmptyString = (
  current: Record<string, any>,
  next: Record<string, any>,
  template: Record<string, unknown>,
  path: string[],
  placeholder: "apiKey" | "baseUrl",
) => {
  const currentCursor = getNestedValue(current, path);
  const nextCursor = getNestedValue(next, path);
  const templateCursor = getNestedValue(template, path);
  const currentValue =
    typeof currentCursor === "string" ? currentCursor.trim() : "";
  const nextValue = typeof nextCursor === "string" ? nextCursor.trim() : "";
  const templateUsesPlaceholder =
    typeof templateCursor === "string" &&
    templateCursor.includes(`{${placeholder}}`);

  if (currentValue && (!nextValue || !templateUsesPlaceholder)) {
    setNestedValue(next, path, currentValue);
  }
};

const protectProviderTemplateSecrets = (
  currentSettingsConfig: unknown,
  templateObject: Record<string, unknown>,
  renderedTemplate: Record<string, unknown>,
  appId: AppId,
): Record<string, unknown> => {
  const current = asRecord(currentSettingsConfig);
  const next = { ...renderedTemplate } as Record<string, any>;

  if (appId === "claude") {
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["env", "ANTHROPIC_BASE_URL"],
      "baseUrl",
    );
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["env", "ANTHROPIC_AUTH_TOKEN"],
      "apiKey",
    );
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["env", "ANTHROPIC_API_KEY"],
      "apiKey",
    );
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["env", "OPENAI_API_KEY"],
      "apiKey",
    );
    return next;
  }

  if (appId === "codex") {
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["auth", "OPENAI_API_KEY"],
      "apiKey",
    );
    const currentBaseUrl = firstNonEmpty(
      extractCodexBaseUrl(
        typeof current.config === "string" ? current.config : "",
      ),
    );
    const nextBaseUrl = firstNonEmpty(
      extractCodexBaseUrl(typeof next.config === "string" ? next.config : ""),
    );
    const templateConfig = templateObject.config;
    const templateUsesBaseUrlPlaceholder =
      typeof templateConfig === "string" &&
      templateConfig.includes("{baseUrl}");

    if (currentBaseUrl && (!nextBaseUrl || !templateUsesBaseUrlPlaceholder)) {
      if (typeof next.config === "string") {
        next.config = setCodexBaseUrl(next.config, currentBaseUrl);
      } else if (typeof current.config === "string") {
        next.config = current.config;
      }
    }
    return next;
  }

  if (appId === "gemini") {
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["env", "GOOGLE_GEMINI_BASE_URL"],
      "baseUrl",
    );
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["env", "GEMINI_API_KEY"],
      "apiKey",
    );
    return next;
  }

  if (appId === "opencode") {
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["options", "baseURL"],
      "baseUrl",
    );
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["options", "apiKey"],
      "apiKey",
    );
    return next;
  }

  if (appId === "openclaw") {
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["baseUrl"],
      "baseUrl",
    );
    preserveNonEmptyString(current, next, templateObject, ["apiKey"], "apiKey");
    return next;
  }

  if (appId === "hermes") {
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["base_url"],
      "baseUrl",
    );
    preserveNonEmptyString(
      current,
      next,
      templateObject,
      ["api_key"],
      "apiKey",
    );
  }

  return next;
};

const buildProviderSettingsFromTemplate = (
  provider: Provider,
  templateObject: Record<string, unknown>,
  appId: AppId,
) => {
  const bindings = getProviderTemplateBindings(provider, appId);
  const rendered = replaceTemplatePlaceholders(
    templateObject,
    bindings,
    appId,
  ) as Record<string, unknown>;
  return protectProviderTemplateSecrets(
    provider.settingsConfig,
    templateObject,
    rendered,
    appId,
  );
};

const DEFAULT_PROVIDER_TEMPLATE_BY_APP: Record<string, string> = {
  claude: JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: "{baseUrl}",
        ANTHROPIC_AUTH_TOKEN: "{apiKey}",
        ANTHROPIC_MODEL: DEFAULT_CLAUDE_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_CLAUDE_HAIKU_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: DEFAULT_CLAUDE_SONNET_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_CLAUDE_OPUS_MODEL,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    null,
    2,
  ),
  codex: JSON.stringify(
    {
      auth: {
        OPENAI_API_KEY: "{apiKey}",
      },
      config: `model_provider = "custom"
model = "${DEFAULT_PROVIDER_MODEL}"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[model_providers.custom]
name = "custom"
base_url = "{baseUrl}"
wire_api = "responses"
requires_openai_auth = true`,
    },
    null,
    2,
  ),
  gemini: JSON.stringify(
    {
      env: {
        GOOGLE_GEMINI_BASE_URL: "{baseUrl}",
        GEMINI_API_KEY: "{apiKey}",
        GEMINI_MODEL: DEFAULT_GEMINI_MODEL,
      },
      config: {
        model: {
          name: DEFAULT_GEMINI_MODEL,
        },
        security: {
          auth: {
            selectedType: "gemini-api-key",
          },
        },
      },
    },
    null,
    2,
  ),
  opencode: JSON.stringify(
    {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "{baseUrl}",
        apiKey: "{apiKey}",
        setCacheKey: true,
      },
      models: {
        [DEFAULT_PROVIDER_MODEL]: { name: DEFAULT_PROVIDER_MODEL_LABEL },
        "gpt-5.4-mini": { name: "GPT-5.4 Mini" },
      },
    },
    null,
    2,
  ),
  openclaw: JSON.stringify(
    {
      baseUrl: "{baseUrl}",
      apiKey: "{apiKey}",
      api: "openai-responses",
      models: [
        {
          id: DEFAULT_PROVIDER_MODEL,
          name: DEFAULT_PROVIDER_MODEL_LABEL,
          reasoning: true,
          input: ["text", "image"],
        },
        {
          id: "gpt-5.4-mini",
          name: "GPT-5.4 Mini",
          reasoning: true,
          input: ["text", "image"],
        },
      ],
    },
    null,
    2,
  ),
  hermes: JSON.stringify(
    {
      name: "my-provider",
      base_url: "{baseUrl}",
      api_key: "{apiKey}",
      api_mode: "codex_responses",
      models: [
        {
          id: "openai/gpt-5.5",
          name: "GPT-5.5",
          context_length: 400000,
        },
        {
          id: "openai/gpt-5.4-mini",
          name: "GPT-5.4 Mini",
          context_length: 400000,
        },
      ],
    },
    null,
    2,
  ),
};

const tryParseProviderTemplate = (template: string) => {
  try {
    const parsed = JSON.parse(template || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const formatProviderTemplateForApp = (appId: AppId, template: string) => {
  const parsed = tryParseProviderTemplate(template);

  if (appId === "codex") {
    return JSON.stringify(
      {
        auth:
          parsed.auth &&
          typeof parsed.auth === "object" &&
          !Array.isArray(parsed.auth)
            ? parsed.auth
            : {},
        config: typeof parsed.config === "string" ? parsed.config : "",
      },
      null,
      2,
    );
  }

  if (appId === "gemini") {
    return JSON.stringify(
      {
        env:
          parsed.env &&
          typeof parsed.env === "object" &&
          !Array.isArray(parsed.env)
            ? parsed.env
            : {},
        config:
          parsed.config &&
          typeof parsed.config === "object" &&
          !Array.isArray(parsed.config)
            ? parsed.config
            : {},
      },
      null,
      2,
    );
  }

  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return template;
  }
};

const getProviderTemplateSections = (appId: AppId, template: string) => {
  const parsed = tryParseProviderTemplate(template);

  if (appId === "codex") {
    return [
      {
        key: "auth",
        label: "auth.json",
        language: "json" as const,
        rows: 6,
        value: JSON.stringify(
          parsed.auth &&
            typeof parsed.auth === "object" &&
            !Array.isArray(parsed.auth)
            ? parsed.auth
            : {},
          null,
          2,
        ),
      },
      {
        key: "config",
        label: "config.toml",
        language: "text" as const,
        rows: 14,
        value: typeof parsed.config === "string" ? parsed.config : "",
      },
    ];
  }

  if (appId === "gemini") {
    return [
      {
        key: "env",
        label: ".env",
        language: "text" as const,
        rows: 6,
        value:
          parsed.env &&
          typeof parsed.env === "object" &&
          !Array.isArray(parsed.env)
            ? Object.entries(parsed.env as Record<string, unknown>)
                .map(
                  ([key, value]) =>
                    `${key}=${typeof value === "string" ? value : ""}`,
                )
                .join("\n")
            : "",
      },
      {
        key: "config",
        label: "settings.json",
        language: "json" as const,
        rows: 14,
        value: JSON.stringify(
          parsed.config &&
            typeof parsed.config === "object" &&
            !Array.isArray(parsed.config)
            ? parsed.config
            : {},
          null,
          2,
        ),
      },
    ];
  }

  return [];
};

const getEndpointFromProvider = (provider: Provider, appId: AppId) => {
  const cfg =
    provider.settingsConfig && typeof provider.settingsConfig === "object"
      ? (provider.settingsConfig as Record<string, any>)
      : undefined;

  if (!cfg) return "";

  if (appId === "claude") {
    return firstNonEmpty(cfg.env?.ANTHROPIC_BASE_URL);
  }

  if (appId === "codex") {
    const extracted = extractCodexBaseUrl(
      typeof cfg.config === "string" ? cfg.config : "",
    );
    return extracted || "";
  }

  if (appId === "gemini") {
    return firstNonEmpty(cfg.env?.GOOGLE_GEMINI_BASE_URL);
  }

  if (appId === "opencode") {
    return firstNonEmpty(cfg.options?.baseURL);
  }

  if (appId === "openclaw") {
    return firstNonEmpty(cfg.baseUrl);
  }

  if (appId === "hermes") {
    return firstNonEmpty(cfg.base_url);
  }

  return "";
};

const getModelDisplayByApp = (provider: Provider, appId: AppId) => {
  const cfg =
    provider.settingsConfig && typeof provider.settingsConfig === "object"
      ? (provider.settingsConfig as Record<string, any>)
      : undefined;

  if (!cfg) return "-";

  if (appId === "claude") {
    const env = (cfg.env || {}) as Record<string, unknown>;
    const models = [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ]
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    const unique = Array.from(new Set(models));
    return unique.length > 0 ? unique.join(", ") : "-";
  }

  if (appId === "codex") {
    const model = getCodexModelFromToml(
      typeof cfg.config === "string" ? cfg.config : "",
    );
    return model || "-";
  }

  if (appId === "gemini") {
    const model = firstNonEmpty(cfg.env?.GEMINI_MODEL);
    return model || "-";
  }

  if (appId === "opencode") {
    const models = cfg.models;
    if (Array.isArray(models)) {
      const ids = models
        .map((item) =>
          item && typeof item === "object" && typeof item.id === "string"
            ? item.id.trim()
            : "",
        )
        .filter(Boolean);
      return ids.length > 0 ? ids.join(", ") : "-";
    }

    if (models && typeof models === "object") {
      const names = Object.keys(models);
      return names.length > 0 ? names.join(", ") : "-";
    }

    return "-";
  }

  if (appId === "openclaw" || appId === "hermes") {
    const models = cfg.models;
    if (!Array.isArray(models)) return "-";

    const ids = models
      .map((item) =>
        item && typeof item === "object" && typeof item.id === "string"
          ? item.id.trim()
          : "",
      )
      .filter(Boolean);

    return ids.length > 0 ? ids.join(", ") : "-";
  }

  return "-";
};

const EMPTY_MODEL_FILTER_VALUE = "__empty__";
const splitModelDisplay = (modelDisplay: string): string[] => {
  if (!modelDisplay || modelDisplay === "-") return [];
  return modelDisplay
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

function isOfficialProvider(provider: Provider, appId: AppId): boolean {
  const config = provider.settingsConfig as Record<string, any>;
  if (appId === "claude") {
    const baseUrl = config?.env?.ANTHROPIC_BASE_URL;
    return !baseUrl || (typeof baseUrl === "string" && baseUrl.trim() === "");
  }
  if (appId === "codex") {
    const apiKey = config?.auth?.OPENAI_API_KEY;
    return !apiKey || (typeof apiKey === "string" && apiKey.trim() === "");
  }
  if (appId === "gemini") {
    const apiKey = config?.env?.GEMINI_API_KEY;
    const baseUrl = config?.env?.GOOGLE_GEMINI_BASE_URL;
    return (
      (!apiKey || (typeof apiKey === "string" && apiKey.trim() === "")) &&
      (!baseUrl || (typeof baseUrl === "string" && baseUrl.trim() === ""))
    );
  }
  return false;
}

const buildTemplateByApp = (appId: AppId): AppConfigTemplateFile[] => {
  if (appId === "codex") {
    return [
      {
        key: "auth",
        label: "auth.json",
        content: '{\n  "OPENAI_API_KEY": "{proxyToken}"\n}\n',
      },
      {
        key: "config",
        label: "config.toml",
        content: `model_provider = "cc-switch"\nmodel = "${DEFAULT_PROVIDER_MODEL}"\nmodel_reasoning_effort = "high"\ndisable_response_storage = true\n\n[model_providers.cc-switch]\nname = "cc-switch"\nwire_api = "responses"\nrequires_openai_auth = true\nbase_url = "{proxyCodexBaseUrl}"\n\n{mcpConfig}\n`,
      },
    ];
  }

  if (appId === "gemini") {
    return [
      {
        key: "env",
        label: ".env",
        content: `GOOGLE_GEMINI_BASE_URL={proxyBaseUrl}\nGEMINI_API_KEY={proxyToken}\nGEMINI_MODEL=${DEFAULT_GEMINI_MODEL}\n`,
      },
      {
        key: "settings",
        label: "settings.json",
        content: `{\n  "mcpServers": {mcpConfig},\n  "model": {\n    "name": "${DEFAULT_GEMINI_MODEL}"\n  },\n  "security": {\n    "auth": {\n      "selectedType": "gemini-api-key"\n    }\n  }\n}\n`,
      },
    ];
  }

  if (appId === "opencode") {
    return [
      {
        key: "config",
        label: "opencode.json",
        content:
          '{\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {\n    "openai": {\n      "npm": "@ai-sdk/openai",\n      "name": "OpenAI Responses",\n      "options": {\n        "baseURL": "https://api.openai.com/v1",\n        "apiKey": "{env:OPENAI_API_KEY}",\n        "setCacheKey": true\n      },\n      "models": {\n        "gpt-5.5": {\n          "name": "GPT-5.5"\n        }\n      }\n    }\n  },\n  "model": "openai/gpt-5.5",\n  "small_model": "openai/gpt-5.5",\n  "mcp": {}\n}\n',
      },
    ];
  }

  if (appId === "openclaw") {
    return [
      {
        key: "config",
        label: "openclaw.json",
        content:
          '{\n  models: {\n    mode: "merge",\n    providers: {\n      openai: {\n        baseUrl: "https://api.openai.com/v1",\n        apiKey: "",\n        api: "openai-responses",\n        models: [\n          {\n            id: "gpt-5.5",\n            name: "GPT-5.5",\n            contextWindow: 400000,\n            maxTokens: 128000\n          }\n        ]\n      }\n    }\n  },\n  agents: {\n    defaults: {\n      model: {\n        primary: "openai/gpt-5.5"\n      },\n      models: {\n        "openai/gpt-5.5": { alias: "GPT-5.5" }\n      }\n    }\n  }\n}\n',
      },
    ];
  }

  if (appId === "hermes") {
    return [
      {
        key: "config",
        label: "config.yaml",
        content:
          'model:\n  default: "gpt-5.5"\n  provider: "openai"\n  base_url: "https://api.openai.com/v1"\n  context_length: 400000\n  max_tokens: 128000\nagent:\n  reasoning_effort: "high"\ncustom_providers:\n  - name: "openai"\n    base_url: "https://api.openai.com/v1"\n    api_key: ""\n    api_mode: "codex_responses"\n    model: "gpt-5.5"\n    models:\n      gpt-5.5:\n        context_length: 400000\nmcp_servers: {}\n',
      },
    ];
  }

  return [
    {
      key: "settings",
      label: "settings.json",
      content: `{\n  "env": {\n    "ANTHROPIC_BASE_URL": "{proxyBaseUrl}",\n    "ANTHROPIC_AUTH_TOKEN": "{proxyToken}",\n    "ANTHROPIC_MODEL": "${DEFAULT_CLAUDE_MODEL}",\n    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${DEFAULT_CLAUDE_HAIKU_MODEL}",\n    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${DEFAULT_CLAUDE_SONNET_MODEL}",\n    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${DEFAULT_CLAUDE_OPUS_MODEL}",\n    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"\n  }\n}\n`,
    },
  ];
};

const serializeTemplateFilesForClipboard = (files: AppConfigTemplateFile[]) =>
  files
    .map((file) => `# ${file.label}\n${file.content.trimEnd()}`)
    .join("\n\n");

export function ProviderList({
  providers,
  currentProviderId,
  appId,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onCreate,
  isLoading = false,
  isProxyTakeover = false,
  activeProviderId,
  activeRequestProviders,
  onSetAsDefault,
}: ProviderListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [admissionRetryRequests, setAdmissionRetryRequests] =
    useState<AdmissionRetryRequestEvents>({});
  const [admissionRetrySuppressedIds, setAdmissionRetrySuppressedIds] =
    useState<Set<string>>(new Set());
  const [admissionRetryUpdatingIds, setAdmissionRetryUpdatingIds] = useState<
    Set<string>
  >(new Set());
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const admissionRetrySuppressedIdsRef = useRef(admissionRetrySuppressedIds);
  admissionRetrySuppressedIdsRef.current = admissionRetrySuppressedIds;

  const { checkProvider, isChecking } = useStreamCheck(appId);
  const { sortedProviders, sensors, handleDragEnd } = useDragSort(
    providers,
    appId,
  );

  const { data: opencodeLiveIds } = useQuery({
    queryKey: ["opencodeLiveProviderIds"],
    queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
    enabled: appId === "opencode",
  });

  const { data: openclawLiveIds } = useOpenClawLiveProviderIds(
    appId === "openclaw",
  );

  const { data: hermesLiveIds } = useHermesLiveProviderIds(appId === "hermes");

  const { data: hermesModelConfig } = useHermesModelConfig(appId === "hermes");
  const hermesCurrentProviderId = hermesModelConfig?.provider;

  const isProviderInConfig = useCallback(
    (providerId: string): boolean => {
      if (appId === "opencode") {
        return opencodeLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "openclaw") {
        return openclawLiveIds?.includes(providerId) ?? false;
      }
      if (appId === "hermes") {
        return hermesLiveIds?.includes(providerId) ?? false;
      }
      return true;
    },
    [appId, opencodeLiveIds, openclawLiveIds, hermesLiveIds],
  );

  const { data: openclawDefaultModel } = useOpenClawDefaultModel(
    appId === "openclaw",
  );

  const isProviderDefaultModel = useCallback(
    (providerId: string): boolean => {
      if (appId !== "openclaw" || !openclawDefaultModel?.primary) return false;
      return openclawDefaultModel.primary.startsWith(providerId + "/");
    },
    [appId, openclawDefaultModel],
  );

  const isAdmissionRetryVisible = useCallback((providerId: string): boolean => {
    return (
      providersRef.current[providerId]?.meta?.upstreamAdmissionRetry
        ?.enabled === true &&
      !admissionRetrySuppressedIdsRef.current.has(providerId)
    );
  }, []);

  const clearAdmissionRetryRequests = useCallback(
    (providerIds: Iterable<string>) => {
      setAdmissionRetryRequests((current) => {
        let changed = false;
        const next = { ...current };
        for (const providerId of providerIds) {
          if (!(providerId in next)) continue;
          delete next[providerId];
          changed = true;
        }
        return changed ? next : current;
      });
    },
    [],
  );

  const suppressAdmissionRetryForProviders = useCallback(
    (providerIds: Iterable<string>) => {
      const ids = Array.from(providerIds);
      if (ids.length === 0) return;
      const nextSuppressedIds = new Set(admissionRetrySuppressedIdsRef.current);
      ids.forEach((id) => nextSuppressedIds.add(id));
      admissionRetrySuppressedIdsRef.current = nextSuppressedIds;
      setAdmissionRetrySuppressedIds(nextSuppressedIds);
      clearAdmissionRetryRequests(ids);
    },
    [clearAdmissionRetryRequests],
  );

  useEffect(() => {
    setAdmissionRetryRequests({});
    const nextSuppressedIds = new Set<string>();
    admissionRetrySuppressedIdsRef.current = nextSuppressedIds;
    setAdmissionRetrySuppressedIds(nextSuppressedIds);

    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    const applyRetryEvent = (payload: ProviderAdmissionRetryEvent) => {
      if (payload.appType !== appId) return;
      const shouldTrackEvent = isAdmissionRetryVisible(payload.providerId);

      if (
        shouldTrackEvent &&
        (payload.event === "admitted" ||
          (payload.event === "retrying" && payload.retryCount === 1))
      ) {
        void queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      }

      setAdmissionRetryRequests((current) => {
        if (!shouldTrackEvent) {
          if (!(payload.providerId in current)) return current;
          const next = { ...current };
          delete next[payload.providerId];
          return next;
        }

        const providerRequests = {
          ...(current[payload.providerId] ?? {}),
        };

        if (payload.event === "retrying" || payload.event === "admitted") {
          providerRequests[payload.requestId] = payload;
        } else {
          delete providerRequests[payload.requestId];
        }

        const next = { ...current };
        if (Object.keys(providerRequests).length > 0) {
          next[payload.providerId] = providerRequests;
        } else {
          delete next[payload.providerId];
        }
        return next;
      });
    };

    (async () => {
      const off = await listen<ProviderAdmissionRetryEvent>(
        "provider-admission-retry",
        (event) => {
          applyRetryEvent(event.payload);
        },
      );

      if (disposed) {
        off();
      } else {
        unlisten = off;
      }

      try {
        const snapshot =
          await proxyApi.getProviderAdmissionRetrySnapshot(appId);
        if (disposed) return;

        const next: AdmissionRetryRequestEvents = {};
        for (const payload of snapshot) {
          if (
            payload.appType !== appId ||
            (payload.event !== "retrying" && payload.event !== "admitted") ||
            !isAdmissionRetryVisible(payload.providerId)
          ) {
            continue;
          }
          next[payload.providerId] = {
            ...(next[payload.providerId] ?? {}),
            [payload.requestId]: payload,
          };
        }
        setAdmissionRetryRequests(next);
      } catch (error) {
        console.debug("Failed to load admission retry snapshot", error);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appId, isAdmissionRetryVisible, queryClient]);

  useEffect(() => {
    clearAdmissionRetryRequests(
      Object.keys(admissionRetryRequests).filter(
        (providerId) => !isAdmissionRetryVisible(providerId),
      ),
    );
  }, [
    admissionRetryRequests,
    admissionRetrySuppressedIds,
    clearAdmissionRetryRequests,
    isAdmissionRetryVisible,
    providers,
  ]);

  const { data: isAutoFailoverEnabled } = useAutoFailoverEnabled(appId);
  const { data: failoverQueue } = useFailoverQueue(appId);
  const addToQueue = useAddToFailoverQueue();
  const removeFromQueue = useRemoveFromFailoverQueue();

  const isFailoverModeActive =
    isProxyTakeover === true && isAutoFailoverEnabled === true;
  const isProxyModeResolving =
    isProxyTakeover === true && isAutoFailoverEnabled === undefined;
  const isTakeoverModeActive =
    isProxyTakeover === true && isAutoFailoverEnabled !== true;

  const isAdditiveMode =
    appId === "opencode" || appId === "openclaw" || appId === "hermes";
  const interactionMode: ProviderInteractionMode = isAdditiveMode
    ? "additive"
    : isFailoverModeActive
      ? "failover"
      : isTakeoverModeActive
        ? "takeover"
        : "direct";
  const showBulkMembershipActions =
    interactionMode === "failover" || interactionMode === "additive";

  const isOpenCode = appId === "opencode";
  const { data: currentOmoId } = useCurrentOmoProviderId(isOpenCode);
  const { data: currentOmoSlimId } = useCurrentOmoSlimProviderId(isOpenCode);

  const getFailoverPriority = useCallback(
    (providerId: string): number | undefined => {
      if (!isFailoverModeActive || !failoverQueue) return undefined;
      const index = failoverQueue.findIndex(
        (item) => item.providerId === providerId,
      );
      return index >= 0 ? index + 1 : undefined;
    },
    [isFailoverModeActive, failoverQueue],
  );

  const [searchTerm, setSearchTerm] = useState("");
  const deferredSearchTerm = useDeferredValue(searchTerm.trim().toLowerCase());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const providerTableRef = useRef<HTMLTableElement>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const { data: claudeDesktopStatus } = useQuery({
    queryKey: ["claudeDesktopStatus"],
    queryFn: () => providersApi.getClaudeDesktopStatus(),
    enabled: appId === "claude-desktop",
    refetchInterval: appId === "claude-desktop" ? 5000 : false,
  });

  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [statusSortDirection, setStatusSortDirection] =
    useState<StatusSortDirection>(null);
  const [modelSortDirection, setModelSortDirection] =
    useState<ModelSortDirection>("asc");
  const [modelFilters, setModelFilters] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBulkOperating, setIsBulkOperating] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateDrafts, setTemplateDrafts] = useState<AppConfigTemplateFile[]>(
    [],
  );
  const [providerTemplateDialogOpen, setProviderTemplateDialogOpen] =
    useState(false);
  const [sessionRoutingManagerOpen, setSessionRoutingManagerOpen] =
    useState(false);
  const [providerTemplateDraft, setProviderTemplateDraft] = useState("");
  // 多 section 编辑器（Codex auth+config / Gemini env+settings）的"原文 drafts"。
  //
  // 早期实现把每次 onChange 都通过 `formatProviderTemplateForApp` 重新解析+stringify
  // 外层 template，导致用户输入还没敲完合法 JSON 就被吞成 `{}`。这里改为 per-section
  // 维护原文字符串，section 编辑期间不再走 JSON 化回流；只在保存/应用时合成最终对象。
  const [providerTemplateSectionDrafts, setProviderTemplateSectionDrafts] =
    useState<Record<string, string>>({});
  const providerTemplateSections = useMemo(
    () => getProviderTemplateSections(appId, providerTemplateDraft),
    [appId, providerTemplateDraft],
  );
  const [isSavingProviderTemplate, setIsSavingProviderTemplate] =
    useState(false);
  const [syncTemplateToLive, setSyncTemplateToLive] = useState(true);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [currentConfigDialogOpen, setCurrentConfigDialogOpen] = useState(false);

  const [currentConfigDrafts, setCurrentConfigDrafts] = useState<
    Record<string, string>
  >({});
  const [currentConfigContents, setCurrentConfigContents] = useState<
    Record<string, { label: string; path: string }>
  >({});
  const [isCurrentConfigContentLoading, setIsCurrentConfigContentLoading] =
    useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isImportingCurrentConfigMcp, setIsImportingCurrentConfigMcp] =
    useState(false);

  const { takeoverStatus } = useProxyStatus();

  const { data: recentSessions = [], isFetching: isRecentSessionsLoading } =
    useQuery({
      queryKey: ["recentSessions", appId],
      queryFn: () => sessionsApi.listRecent({ appType: appId, limit: 10 }),
      staleTime: 30_000,
    });

  const {
    data: configFiles = [],
    isFetching: isConfigFilesFetching,
    refetch: refetchConfigFiles,
  } = useQuery({
    queryKey: ["appConfigFiles", appId],
    queryFn: () => configApi.listAppConfigFiles(appId),
    enabled: currentConfigDialogOpen,
  });

  const isCurrentConfigLoading =
    isConfigFilesFetching || isCurrentConfigContentLoading;
  const isSwitchModeApp = !isAdditiveMode;
  const isCurrentAppTakeoverActive =
    isSwitchModeApp &&
    Boolean(takeoverStatus?.[appId as keyof typeof takeoverStatus]);
  const canSyncTemplateToLive = isCurrentAppTakeoverActive;
  const canImportCurrentConfigMcp = appId !== "openclaw";

  const {
    data: persistedTemplate,
    isFetching: isTemplateFetching,
    refetch: refetchTemplate,
  } = useQuery({
    queryKey: ["appConfigTemplate", appId],
    queryFn: () => configApi.getAppConfigTemplate(appId),
    enabled: templateDialogOpen,
  });

  const {
    data: persistedProviderTemplate,
    isFetching: isProviderTemplateFetching,
  } = useQuery({
    queryKey: ["providerDefaultTemplate", appId],
    queryFn: () => configApi.getProviderDefaultTemplate(appId),
    enabled: providerTemplateDialogOpen,
  });

  // 连通性检查不发真实请求、无封号/计费风险，直接执行（无需确认弹窗）。
  const handleTest = useCallback(
    (provider: Provider) => {
      checkProvider(provider.id, provider.name);
    },
    [checkProvider],
  );

  // Import current live config as default provider
  const importMutation = useMutation({
    mutationFn: async (): Promise<boolean> => {
      if (appId === "opencode") {
        const count = await providersApi.importOpenCodeFromLive();
        return count > 0;
      }
      if (appId === "openclaw") {
        const count = await providersApi.importOpenClawFromLive();
        return count > 0;
      }
      if (appId === "hermes") {
        const count = await providersApi.importHermesFromLive();
        return count > 0;
      }
      if (appId === "claude-desktop") {
        const count = await providersApi.importClaudeDesktopFromClaude();
        return count > 0;
      }
      return providersApi.importDefault(appId);
    },
    onSuccess: (imported) => {
      if (imported) {
        queryClient.invalidateQueries({ queryKey: ["providers", appId] });
        if (appId === "claude-desktop") {
          queryClient.invalidateQueries({ queryKey: ["claudeDesktopStatus"] });
        }
        toast.success(t("provider.importCurrentDescription"));
      } else {
        toast.info(t("provider.noProviders"));
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        // 正在输入框/可编辑区域中时不抢占 Ctrl+F（例如添加供应商表单里
        // ProviderPresetSelector 的搜索框），避免与其同名快捷键冲突。
        if (isTextEditableTarget(document.activeElement)) return;
        event.preventDefault();
        const input = searchInputRef.current;
        input?.focus();
        input?.select();
        return;
      }

      if (key === "escape") {
        setSearchTerm("");
        setActiveSearchMatchIndex(0);
        searchInputRef.current?.blur();
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const allIds = new Set(sortedProviders.map((item) => item.id));
    setSelectedProviderIds((prev) => {
      const next = new Set<string>();
      prev.forEach((id) => {
        if (allIds.has(id)) {
          next.add(id);
        }
      });
      return next;
    });
  }, [sortedProviders]);

  useEffect(() => {
    if (!currentConfigDialogOpen) {
      setCurrentConfigDrafts({});
      setCurrentConfigContents({});
      return;
    }

    void refetchConfigFiles();
  }, [currentConfigDialogOpen, refetchConfigFiles]);

  useEffect(() => {
    if (!currentConfigDialogOpen || configFiles.length === 0) return;

    let cancelled = false;
    const loadConfigFiles = async () => {
      setIsCurrentConfigContentLoading(true);
      try {
        const contents = await Promise.all(
          configFiles.map((file) =>
            configApi.readAppConfigFile({ appId, fileKey: file.key }),
          ),
        );
        if (cancelled) return;

        const nextDrafts: Record<string, string> = {};
        const nextMeta: Record<string, { label: string; path: string }> = {};
        contents.forEach((file) => {
          nextDrafts[file.key] = file.content || "";
          nextMeta[file.key] = { label: file.label, path: file.path };
        });
        setCurrentConfigDrafts(nextDrafts);
        setCurrentConfigContents(nextMeta);
      } catch (error) {
        console.error("Failed to load current config files", error);
        toast.error(
          t("provider.currentConfigLoadFailed", {
            defaultValue: "加载当前配置失败",
          }),
        );
      } finally {
        if (!cancelled) {
          setIsCurrentConfigContentLoading(false);
        }
      }
    };

    void loadConfigFiles();
    return () => {
      cancelled = true;
    };
  }, [appId, configFiles, currentConfigDialogOpen, t]);

  useEffect(() => {
    if (!templateDialogOpen) {
      setTemplateDrafts([]);
      return;
    }

    void refetchTemplate();
  }, [templateDialogOpen, refetchTemplate]);

  useEffect(() => {
    if (!templateDialogOpen) return;

    const fallbackTemplate = buildTemplateByApp(appId);
    const resolvedTemplate =
      Array.isArray(persistedTemplate) && persistedTemplate.length > 0
        ? persistedTemplate
        : fallbackTemplate;
    setTemplateDrafts(resolvedTemplate);
  }, [appId, persistedTemplate, templateDialogOpen]);

  useEffect(() => {
    if (!providerTemplateDialogOpen) return;
    const fallback = DEFAULT_PROVIDER_TEMPLATE_BY_APP[appId] ?? "";
    const formatted = formatProviderTemplateForApp(
      appId,
      persistedProviderTemplate?.trim() || fallback,
    );
    setProviderTemplateDraft(formatted);
    // 同步初始化 section drafts（按当前 appId 的 section 划分）
    const sections = getProviderTemplateSections(appId, formatted);
    if (sections.length > 0) {
      const next: Record<string, string> = {};
      for (const s of sections) {
        next[s.key] = s.value;
      }
      setProviderTemplateSectionDrafts(next);
    } else {
      setProviderTemplateSectionDrafts({});
    }
  }, [appId, persistedProviderTemplate, providerTemplateDialogOpen]);

  // 把 per-section drafts 合成最终的外层 template JSON 字符串。
  // 不在 onChange 时调用，仅在保存/应用按钮里使用。
  const composeTemplateFromSectionDrafts = useCallback(
    (drafts: Record<string, string>): string => {
      if (appId === "codex") {
        let auth: unknown = {};
        const authRaw = (drafts.auth ?? "").trim();
        if (authRaw) {
          try {
            auth = JSON.parse(authRaw);
          } catch {
            // 解析失败：保留原文，让上层校验阶段报错
            auth = drafts.auth;
          }
        }
        return JSON.stringify({ auth, config: drafts.config ?? "" }, null, 2);
      }
      if (appId === "gemini") {
        let config: unknown = {};
        const configRaw = (drafts.config ?? "").trim();
        if (configRaw) {
          try {
            config = JSON.parse(configRaw);
          } catch {
            config = drafts.config;
          }
        }
        const env: Record<string, string> = {};
        for (const line of (drafts.env ?? "").split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const idx = trimmed.indexOf("=");
          if (idx <= 0) continue;
          env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
        }
        return JSON.stringify({ env, config }, null, 2);
      }
      return providerTemplateDraft;
    },
    [appId, providerTemplateDraft],
  );

  const getProviderCurrentState = useCallback(
    (provider: Provider) => {
      const isOmo = provider.category === "omo";
      const isOmoSlim = provider.category === "omo-slim";
      const isHermesCurrent =
        appId === "hermes" && hermesCurrentProviderId === provider.id;

      const isCurrent = isOmo
        ? provider.id === (currentOmoId || "")
        : isOmoSlim
          ? provider.id === (currentOmoSlimId || "")
          : appId === "hermes"
            ? isHermesCurrent
            : provider.id === currentProviderId;

      return {
        isOmo,
        isOmoSlim,
        isAnyOmo: isOmo || isOmoSlim,
        isCurrent,
        isHermesCurrent,
      };
    },
    [
      appId,
      currentOmoId,
      currentOmoSlimId,
      currentProviderId,
      hermesCurrentProviderId,
    ],
  );

  const providerRowViews = useMemo<ProviderRowView[]>(() => {
    const sortedIndexMap = new Map(
      sortedProviders.map((provider, index) => [provider.id, index]),
    );

    return sortedProviders.map((provider) => {
      const { isOmo, isOmoSlim, isAnyOmo, isCurrent } =
        getProviderCurrentState(provider);
      const isInConfig = isProviderInConfig(provider.id);
      const isReadOnly =
        appId === "hermes" && isHermesReadOnlyProvider(provider.settingsConfig);
      const failoverPriority = getFailoverPriority(provider.id);

      const isEnabled = isFailoverModeActive
        ? Boolean(failoverPriority)
        : isAdditiveMode
          ? isInConfig
          : isCurrent;
      const activeRequest = isEnabled
        ? activeRequestProviders?.[provider.id]
        : undefined;
      const activeRequestCount = activeRequest?.count ?? 0;
      const isProcessingProvider = activeRequestCount > 0;
      const retryEvents = Object.values(
        admissionRetryRequests[provider.id] ?? {},
      );
      const activeRetryEvents = retryEvents.filter(
        (event) => event.event === "retrying",
      );
      const admittedEvents = retryEvents.filter(
        (event) => event.event === "admitted",
      );
      const admissionRetryCount =
        activeRetryEvents.length > 0
          ? Math.max(...activeRetryEvents.map((event) => event.retryCount))
          : 0;
      const latestAdmissionRetry = retryEvents.reduce<
        ProviderAdmissionRetryEvent | undefined
      >((latest, event) => {
        if (!latest) return event;
        const latestTime = Date.parse(latest.updatedAt || "");
        const eventTime = Date.parse(event.updatedAt || "");
        if (Number.isFinite(eventTime) && eventTime > latestTime) {
          return event;
        }
        return event.retryCount >= latest.retryCount ? event : latest;
      }, undefined);
      const admissionRetryEnabled =
        provider.meta?.upstreamAdmissionRetry?.enabled === true &&
        !admissionRetrySuppressedIds.has(provider.id);
      const visibleAdmissionRetryCount = admissionRetryEnabled
        ? admissionRetryCount
        : 0;
      const visibleAdmissionRetryState = admissionRetryEnabled
        ? latestAdmissionRetry?.event
        : undefined;
      const visibleAdmissionRetryAdmittedCount = admissionRetryEnabled
        ? admittedEvents.length > 0
          ? Math.max(...admittedEvents.map((event) => event.retryCount))
          : 0
        : 0;

      const isActiveProxyProvider =
        isCurrentAppTakeoverActive &&
        activeProviderId === provider.id &&
        !isProcessingProvider;

      const modeState: ProviderRowView["modeState"] = isFailoverModeActive
        ? failoverPriority
          ? "failover_enabled"
          : "inactive"
        : isTakeoverModeActive
          ? isCurrent
            ? "proxy_target"
            : "inactive"
          : isAdditiveMode
            ? isInConfig
              ? "live_current"
              : "inactive"
            : isCurrent
              ? "live_current"
              : "inactive";

      const orderNumber =
        failoverPriority ?? (sortedIndexMap.get(provider.id) ?? 0) + 1;

      const endpoint = normalizeOptionalUrl(
        getEndpointFromProvider(provider, appId),
      );
      const endpointWithoutV1 = stripV1Suffix(endpoint);
      const endpointForNameLink =
        stripFromV1Segment(endpoint) || endpointWithoutV1;

      const website = normalizeOptionalUrl(provider.websiteUrl);
      const websiteForNameLink = stripFromV1Segment(website);
      const nameLink = websiteForNameLink || endpointForNameLink || undefined;

      const isOfficial = isOfficialProvider(provider, appId);
      const isCopilot =
        provider.meta?.providerType === PROVIDER_TYPES.GITHUB_COPILOT ||
        provider.meta?.usage_script?.templateType === "github_copilot";
      const isCodexOauth =
        provider.meta?.providerType === PROVIDER_TYPES.CODEX_OAUTH;

      const canDelete =
        !isReadOnly &&
        (isAnyOmo || isAdditiveMode
          ? true
          : isFailoverModeActive
            ? true
            : !isCurrent || Object.keys(providers).length > 1);

      const statusRank = !isEnabled
        ? 1
        : visibleAdmissionRetryCount > 0
          ? 5
          : activeRequestCount > 0
            ? 4
            : isActiveProxyProvider
              ? 3
              : 2;

      return {
        provider,
        modeState,
        isOmo,
        isOmoSlim,
        isAnyOmo,
        isCurrent,
        isInConfig,
        isReadOnly,
        isEnabled,
        isProxyModeResolving,
        isActiveProxyProvider,
        isProcessingProvider,
        activeRequestCount,
        activeRequestModel: activeRequest?.model,
        activeRequestRequestModel: activeRequest?.requestModel,
        activeRequestUpstreamModel: activeRequest?.upstreamModel,
        admissionRetryEnabled,
        admissionRetryCount: visibleAdmissionRetryCount,
        admissionRetryState: visibleAdmissionRetryState,
        admissionRetryAdmittedCount: visibleAdmissionRetryAdmittedCount,
        admissionRetryStatus: admissionRetryEnabled
          ? latestAdmissionRetry?.status
          : undefined,
        admissionRetryLastError: admissionRetryEnabled
          ? latestAdmissionRetry?.error
          : undefined,
        admissionRetryLastFailureAt: admissionRetryEnabled
          ? latestAdmissionRetry?.updatedAt
          : undefined,
        admissionRetryDelayMs: admissionRetryEnabled
          ? latestAdmissionRetry?.delayMs
          : undefined,
        failoverPriority,
        orderNumber,
        statusRank,
        modelDisplay: getModelDisplayByApp(provider, appId),
        endpointDisplay: endpointWithoutV1 || "-",
        nameLink,
        canDelete,
        canTest: !isOfficial && !isCopilot && !isCodexOauth,
      };
    });
  }, [
    activeProviderId,
    activeRequestProviders,
    admissionRetrySuppressedIds,
    admissionRetryRequests,
    appId,
    getFailoverPriority,
    getProviderCurrentState,
    isAdditiveMode,
    isCurrentAppTakeoverActive,
    isFailoverModeActive,
    isProxyModeResolving,
    isProviderInConfig,
    sortedProviders,
  ]);

  const modelFilterOptions = useMemo(() => {
    const values = new Map<string, number>();
    let emptyCount = 0;
    for (const row of providerRowViews) {
      const models = splitModelDisplay(row.modelDisplay);
      if (models.length === 0) {
        emptyCount += 1;
        continue;
      }
      for (const model of models) {
        values.set(model, (values.get(model) ?? 0) + 1);
      }
    }
    return Array.from(values.entries())
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) =>
        a.model.localeCompare(b.model, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .concat(
        emptyCount > 0
          ? [
              {
                model: EMPTY_MODEL_FILTER_VALUE,
                count: emptyCount,
              },
            ]
          : [],
      );
  }, [providerRowViews]);

  useEffect(() => {
    if (modelFilters.size === 0) return;
    const validModels = new Set(
      modelFilterOptions.map((option) => option.model),
    );
    setModelFilters((prev) => {
      const next = new Set<string>();
      prev.forEach((model) => {
        if (validModels.has(model)) next.add(model);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [modelFilterOptions, modelFilters.size]);

  const filteredRows = useMemo(() => {
    if (modelFilters.size === 0) {
      return providerRowViews;
    }
    return providerRowViews.filter((row) => {
      const models = splitModelDisplay(row.modelDisplay);
      if (modelFilters.has(EMPTY_MODEL_FILTER_VALUE) && models.length === 0) {
        return true;
      }
      return models.some((model) => modelFilters.has(model));
    });
  }, [modelFilters, providerRowViews]);

  useEffect(() => {
    const visibleIds = new Set(filteredRows.map((row) => row.provider.id));
    setSelectedProviderIds((prev) => {
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visibleIds.has(id)) {
          next.add(id);
        }
      });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredRows]);

  const displayRows = useMemo(() => {
    const rows = filteredRows;
    if (!statusSortDirection) {
      return rows;
    }

    const sortedIndexMap = new Map(
      providerRowViews.map((row, index) => [row.provider.id, index]),
    );

    return [...rows].sort((a, b) => {
      const diff =
        statusSortDirection === "desc"
          ? b.statusRank - a.statusRank
          : a.statusRank - b.statusRank;
      if (diff !== 0) return diff;
      return (
        (sortedIndexMap.get(a.provider.id) ?? 0) -
        (sortedIndexMap.get(b.provider.id) ?? 0)
      );
    });
  }, [filteredRows, providerRowViews, statusSortDirection]);

  const searchMatches = useMemo<SearchMatchInfo[]>(() => {
    if (!deferredSearchTerm) return [];

    return displayRows.flatMap((row, rowIndex) => {
      const fields = [
        row.provider.name,
        row.provider.notes,
        row.provider.websiteUrl,
        row.endpointDisplay,
        row.modelDisplay,
      ];
      const matches = fields.some((field) =>
        field?.toString().toLowerCase().includes(deferredSearchTerm),
      );
      return matches
        ? [
            {
              providerId: row.provider.id,
              rowIndex,
            },
          ]
        : [];
    });
  }, [deferredSearchTerm, displayRows]);

  const searchMatchIdSet = useMemo(
    () => new Set(searchMatches.map((match) => match.providerId)),
    [searchMatches],
  );

  const activeSearchMatch = searchMatches[activeSearchMatchIndex] ?? null;

  const recentSessionsForApp = useMemo(
    () => recentSessions.slice(0, 10),
    [recentSessions],
  );

  const registerRowRef = useCallback(
    (providerId: string, node: HTMLTableRowElement | null) => {
      rowRefs.current[providerId] = node;
    },
    [],
  );

  const getScrollableListContainer = useCallback(() => {
    return listScrollRef.current;
  }, []);

  const scrollToProviderRow = useCallback(
    (providerId: string, behavior: ScrollBehavior = "smooth") => {
      const node = rowRefs.current[providerId];
      const container = listScrollRef.current;
      if (!node) return;
      if (!container) {
        node.scrollIntoView({ behavior, block: "center" });
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const headerOffset = 48;
      const targetTop =
        container.scrollTop +
        (nodeRect.top - containerRect.top) -
        Math.max((container.clientHeight - nodeRect.height) / 2, headerOffset);
      const maxTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );

      const scrollTop = Math.max(0, Math.min(maxTop, targetTop));
      if (typeof container.scrollTo === "function") {
        container.scrollTo({
          top: scrollTop,
          behavior,
        });
        return;
      }

      container.scrollTop = scrollTop;
    },
    [],
  );

  const scrollByPage = useCallback(
    (direction: -1 | 1) => {
      const container = getScrollableListContainer();
      if (!container) return;
      const delta = direction * Math.max(container.clientHeight * 0.82, 280);
      const targetTop = Math.max(
        0,
        Math.min(
          container.scrollHeight - container.clientHeight,
          container.scrollTop + delta,
        ),
      );

      if (typeof container.scrollTo === "function") {
        container.scrollTo({
          top: targetTop,
          behavior: "smooth",
        });
        return;
      }

      container.scrollTop = targetTop;
    },
    [getScrollableListContainer],
  );

  const scrollToEdge = useCallback(
    (edge: "start" | "end") => {
      const container = getScrollableListContainer();
      if (!container) return;
      const targetTop = edge === "start" ? 0 : container.scrollHeight;
      if (typeof container.scrollTo === "function") {
        container.scrollTo({
          top: targetTop,
          behavior: "smooth",
        });
        return;
      }
      container.scrollTop = targetTop;
    },
    [getScrollableListContainer],
  );

  const jumpToSearchMatch = useCallback(
    (nextIndex: number) => {
      if (searchMatches.length === 0) return;
      const normalizedIndex =
        ((nextIndex % searchMatches.length) + searchMatches.length) %
        searchMatches.length;
      setActiveSearchMatchIndex(normalizedIndex);
      scrollToProviderRow(searchMatches[normalizedIndex].providerId);
    },
    [scrollToProviderRow, searchMatches],
  );

  const selectedRows = useMemo(() => {
    return providerRowViews.filter((row) =>
      selectedProviderIds.has(row.provider.id),
    );
  }, [providerRowViews, selectedProviderIds]);

  const selectedCount = selectedRows.length;
  const effectiveTargetRows = selectedCount > 0 ? selectedRows : filteredRows;

  const enabledCount = useMemo(
    () => providerRowViews.filter((row) => row.isEnabled).length,
    [providerRowViews],
  );

  const totalCount = providerRowViews.length;
  const filteredCount = filteredRows.length;

  const allDisplayedSelected =
    displayRows.length > 0 &&
    displayRows.every((row) => selectedProviderIds.has(row.provider.id));

  const hasDisplayedSelection = displayRows.some((row) =>
    selectedProviderIds.has(row.provider.id),
  );

  const canDragRows = statusSortDirection === null && modelFilters.size === 0;

  const toggleModelFilter = useCallback((model: string, checked: boolean) => {
    setModelFilters((prev) => {
      const next = new Set(prev);
      if (checked) next.add(model);
      else next.delete(model);
      return next;
    });
  }, []);

  const modelFilterSummary = useMemo(() => {
    if (modelFilters.size === 0) {
      return t("provider.allModels", { defaultValue: "全部模型" });
    }
    const labels = Array.from(modelFilters).map((model) =>
      model === EMPTY_MODEL_FILTER_VALUE
        ? t("provider.emptyModel", { defaultValue: "未填写模型" })
        : model,
    );
    return labels.length <= 2
      ? labels.join(" / ")
      : t("provider.modelFilterSelected", {
          defaultValue: `已选 ${labels.length} 个模型`,
          count: labels.length,
        });
  }, [modelFilters, t]);

  useEffect(() => {
    if (!deferredSearchTerm || searchMatches.length === 0) {
      setActiveSearchMatchIndex(0);
      return;
    }

    setActiveSearchMatchIndex((current) =>
      Math.min(current, searchMatches.length - 1),
    );
  }, [deferredSearchTerm, searchMatches.length]);

  useEffect(() => {
    if (!deferredSearchTerm || searchMatches.length === 0) return;
    const activeMatch =
      searchMatches[activeSearchMatchIndex] ?? searchMatches[0];
    if (!activeMatch) return;
    scrollToProviderRow(activeMatch.providerId, "smooth");
  }, [
    activeSearchMatchIndex,
    deferredSearchTerm,
    scrollToProviderRow,
    searchMatches,
  ]);

  const toggleSelectAllDisplayed = (checked: boolean) => {
    setSelectedProviderIds((current) => {
      const next = new Set(current);
      if (checked) {
        displayRows.forEach((row) => next.add(row.provider.id));
      } else {
        displayRows.forEach((row) => next.delete(row.provider.id));
      }
      return next;
    });
  };

  const toggleSelectRow = (providerId: string, checked: boolean) => {
    setSelectedProviderIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(providerId);
      } else {
        next.delete(providerId);
      }
      return next;
    });
  };

  const cycleStatusSort = () => {
    setStatusSortDirection((current) => {
      if (current === null) return "desc";
      if (current === "desc") return "asc";
      return null;
    });
  };

  const applyModelNameSort = async () => {
    if (providerRowViews.length === 0) return;

    const currentIndexMap = new Map(
      providerRowViews.map((row, index) => [row.provider.id, index]),
    );
    const direction = modelSortDirection;
    const nextRows = [...providerRowViews].sort((a, b) => {
      if (a.isEnabled !== b.isEnabled) {
        return a.isEnabled ? -1 : 1;
      }

      const aModels = splitModelDisplay(a.modelDisplay).join(", ");
      const bModels = splitModelDisplay(b.modelDisplay).join(", ");
      if (!aModels && bModels) return 1;
      if (aModels && !bModels) return -1;

      const modelDiff = aModels.localeCompare(bModels, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (modelDiff !== 0) {
        return direction === "asc" ? modelDiff : -modelDiff;
      }

      return (
        (currentIndexMap.get(a.provider.id) ?? 0) -
        (currentIndexMap.get(b.provider.id) ?? 0)
      );
    });

    const updates = nextRows.map((row, index) => ({
      id: row.provider.id,
      sortIndex: index,
    }));

    try {
      await providersApi.updateSortOrder(updates, appId);
      setStatusSortDirection(null);
      setModelSortDirection(direction === "asc" ? "desc" : "asc");
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      await queryClient.invalidateQueries({
        queryKey: ["failoverQueue", appId],
      });
      await providersApi.updateTrayMenu().catch(() => undefined);
      toast.success(
        t("provider.sortUpdated", {
          defaultValue: "排序已更新",
        }),
      );
    } catch (error) {
      toast.error(
        t("provider.sortUpdateFailed", {
          defaultValue: "排序更新失败",
        }),
      );
      console.error("Failed to sort providers by model name", error);
    }
  };

  const handlePinToTop = async (providerId: string) => {
    const currentIndex = sortedProviders.findIndex(
      (item) => item.id === providerId,
    );
    if (currentIndex < 0) return;

    const reordered = [
      sortedProviders[currentIndex],
      ...sortedProviders.filter((item) => item.id !== providerId),
    ];

    const updates = reordered.map((item, index) => ({
      id: item.id,
      sortIndex: index,
    }));

    try {
      await providersApi.updateSortOrder(updates, appId);
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      await queryClient.invalidateQueries({
        queryKey: ["failoverQueue", appId],
      });
      await providersApi.updateTrayMenu().catch(() => undefined);
      toast.success(
        t("provider.pinnedToTop", {
          defaultValue: "已置顶到故障转移顺序 #1",
        }),
      );
    } catch (error) {
      toast.error(
        t("provider.pinToTopFailed", {
          defaultValue: "置顶失败",
        }),
      );
      console.error("Failed to pin provider to top", error);
    }
  };

  const applyBulkEnableState = async (enabled: boolean) => {
    if (effectiveTargetRows.length === 0) return;

    if (!(isFailoverModeActive || isAdditiveMode)) {
      toast.info(
        t("provider.bulkToggleUnsupported", {
          defaultValue: "当前模式不支持批量启用/禁用",
        }),
      );
      return;
    }

    setIsBulkOperating(true);
    let success = 0;
    let failed = 0;

    for (const row of effectiveTargetRows) {
      try {
        if (isFailoverModeActive) {
          if (enabled && !row.failoverPriority) {
            await addToQueue.mutateAsync({
              appType: appId,
              providerId: row.provider.id,
            });
          }
          if (!enabled && row.failoverPriority) {
            await removeFromQueue.mutateAsync({
              appType: appId,
              providerId: row.provider.id,
            });
            suppressAdmissionRetryForProviders([row.provider.id]);
          }
        } else if (isAdditiveMode) {
          if (enabled && !row.isInConfig) {
            await providersApi.switch(row.provider.id, appId);
          }
          if (!enabled && row.isInConfig) {
            await providersApi.removeFromLiveConfig(row.provider.id, appId);
            suppressAdmissionRetryForProviders([row.provider.id]);
            queryClient.setQueryData(
              ["proxyStatus"],
              (current: unknown) =>
                pruneProxyStatusProviderActivity(
                  current as any,
                  appId,
                  row.provider.id,
                ) ?? current,
            );
          }
        }
        success += 1;
      } catch (error) {
        failed += 1;
        console.error("Bulk toggle provider failed", row.provider.id, error);
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
    await queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });

    if (appId === "opencode") {
      await queryClient.invalidateQueries({
        queryKey: ["opencodeLiveProviderIds"],
      });
    }
    if (appId === "openclaw") {
      await queryClient.invalidateQueries({
        queryKey: openclawKeys.liveProviderIds,
      });
      await queryClient.invalidateQueries({ queryKey: openclawKeys.health });
    }
    if (appId === "hermes") {
      await queryClient.invalidateQueries({
        queryKey: hermesKeys.liveProviderIds,
      });
    }

    await providersApi.updateTrayMenu().catch(() => undefined);

    setIsBulkOperating(false);

    if (success > 0) {
      toast.success(
        t("provider.bulkToggleSuccess", {
          defaultValue: "批量操作完成：成功 {{success}} 项",
          success,
        }),
      );
    }

    if (failed > 0) {
      toast.warning(
        t("provider.bulkToggleFailed", {
          defaultValue: "有 {{failed}} 项操作失败",
          failed,
        }),
      );
    }
  };

  const executeBulkDelete = async () => {
    if (selectedRows.length === 0) {
      setShowBulkDeleteConfirm(false);
      return;
    }

    setIsBulkOperating(true);
    let success = 0;
    let failed = 0;

    for (const row of selectedRows) {
      if (!row.canDelete) {
        failed += 1;
        continue;
      }

      try {
        await providersApi.delete(row.provider.id, appId);
        queryClient.setQueryData(
          ["proxyStatus"],
          (current: unknown) =>
            pruneProxyStatusProviderActivity(
              current as any,
              appId,
              row.provider.id,
            ) ?? current,
        );
        success += 1;
      } catch (error) {
        failed += 1;
        console.error("Bulk delete failed", row.provider.id, error);
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
    await queryClient.invalidateQueries({ queryKey: ["failoverQueue", appId] });

    if (appId === "opencode") {
      await queryClient.invalidateQueries({
        queryKey: ["opencodeLiveProviderIds"],
      });
    }
    if (appId === "openclaw") {
      await queryClient.invalidateQueries({
        queryKey: openclawKeys.liveProviderIds,
      });
      await queryClient.invalidateQueries({ queryKey: openclawKeys.health });
    }
    if (appId === "hermes") {
      await queryClient.invalidateQueries({
        queryKey: hermesKeys.liveProviderIds,
      });
    }

    await providersApi.updateTrayMenu().catch(() => undefined);

    setSelectedProviderIds(new Set());
    setIsBulkOperating(false);
    setShowBulkDeleteConfirm(false);

    if (success > 0) {
      toast.success(
        t("provider.bulkDeleteSuccess", {
          defaultValue: "已删除 {{count}} 个供应商",
          count: success,
        }),
      );
    }

    if (failed > 0) {
      toast.warning(
        t("provider.bulkDeleteFailed", {
          defaultValue: "{{count}} 个供应商删除失败或不可删",
          count: failed,
        }),
      );
    }
  };

  const handleResumeSession = async (session: SessionMeta) => {
    if (!session.resumeCommand) return;

    try {
      await sessionsApi.launchTerminal({
        command: session.resumeCommand,
        cwd: session.projectDir ?? undefined,
      });
      toast.success(
        t("sessionManager.terminalLaunched", {
          defaultValue: "终端已打开",
        }),
      );
    } catch (error) {
      let copied = false;
      try {
        await navigator.clipboard.writeText(session.resumeCommand);
        copied = true;
        toast.info(
          t("sessionManager.resumeFallbackCopied", {
            defaultValue: "启动失败，恢复命令已复制到剪贴板",
          }),
        );
      } catch {}

      console.error("Failed to launch session terminal", error);
      if (!copied) {
        toast.error(
          t("sessionManager.openFailed", {
            defaultValue: "打开终端失败",
          }),
        );
      }
    }
  };

  const refreshCurrentConfig = async () => {
    const result = await refetchConfigFiles();
    const files = result.data ?? configFiles;
    if (files.length === 0) return;

    setIsCurrentConfigContentLoading(true);
    try {
      const contents = await Promise.all(
        files.map((file) =>
          configApi.readAppConfigFile({ appId, fileKey: file.key }),
        ),
      );
      const nextDrafts: Record<string, string> = {};
      const nextMeta: Record<string, { label: string; path: string }> = {};
      contents.forEach((file) => {
        nextDrafts[file.key] = file.content || "";
        nextMeta[file.key] = { label: file.label, path: file.path };
      });
      setCurrentConfigDrafts(nextDrafts);
      setCurrentConfigContents(nextMeta);
    } finally {
      setIsCurrentConfigContentLoading(false);
    }
  };

  const saveCurrentConfig = async () => {
    if (configFiles.length === 0) return;
    setIsSavingConfig(true);

    try {
      await configApi.writeAppConfigFiles({
        appId,
        files: configFiles.map((file) => ({
          fileKey: file.key,
          content: currentConfigDrafts[file.key] ?? "",
        })),
      });
      await refreshCurrentConfig();
      toast.success(
        t("provider.currentConfigSaved", {
          defaultValue: "当前配置已保存",
        }),
      );
      setCurrentConfigDialogOpen(false);
    } catch (error) {
      console.error("Failed to save current config", error);
      toast.error(
        t("provider.currentConfigSaveFailed", {
          defaultValue: "保存当前配置失败：{{error}}",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setIsSavingConfig(false);
    }
  };

  const importCurrentConfigMcp = async () => {
    if (configFiles.length === 0) return;
    if (isCurrentAppTakeoverActive) {
      toast.error(
        t("provider.currentConfigMcpImportBlockedByTakeover", {
          defaultValue:
            "当前应用已开启代理接管，不能直接从当前配置回显 MCP；请先关闭接管后再试。",
        }),
      );
      return;
    }

    setIsImportingCurrentConfigMcp(true);
    try {
      await configApi.writeAppConfigFiles({
        appId,
        files: configFiles.map((file) => ({
          fileKey: file.key,
          content: currentConfigDrafts[file.key] ?? "",
        })),
      });
      const imported = await configApi.importMcpFromAppLive(appId);
      await queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
      await refreshCurrentConfig();
      toast.success(
        t("provider.currentConfigImportedToMcp", {
          defaultValue: "已从当前配置回显 MCP 管理：{{count}} 项",
          count: imported,
        }),
      );
    } catch (error) {
      console.error("Failed to import MCP from current config", error);
      toast.error(
        t("provider.currentConfigImportMcpFailed", {
          defaultValue: "回显 MCP 管理失败：{{error}}",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setIsImportingCurrentConfigMcp(false);
    }
  };

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(
        serializeTemplateFilesForClipboard(
          templateDrafts.length > 0
            ? templateDrafts
            : buildTemplateByApp(appId),
        ),
      );
      toast.success(
        t("provider.templateCopied", {
          defaultValue: "应用接入配置模板已复制",
        }),
      );
    } catch (error) {
      console.error("Failed to copy template", error);
      toast.error(
        t("provider.templateCopyFailed", {
          defaultValue: "复制模板失败",
        }),
      );
    }
  };

  const saveTemplate = async () => {
    setIsSavingTemplate(true);
    try {
      await configApi.setAppConfigTemplate({
        appId,
        files:
          templateDrafts.length > 0
            ? templateDrafts
            : buildTemplateByApp(appId),
        syncToLive: canSyncTemplateToLive && syncTemplateToLive,
      });
      await queryClient.invalidateQueries({
        queryKey: ["appConfigTemplate", appId],
      });
      if (canSyncTemplateToLive && syncTemplateToLive) {
        await queryClient.invalidateQueries({
          queryKey: ["appConfigFiles", appId],
        });
      }
      toast.success(
        t("provider.templateSaved", {
          defaultValue: "应用接入配置模板已保存",
        }),
      );
      setTemplateDialogOpen(false);
    } catch (error) {
      console.error("Failed to save template", error);
      toast.error(
        t("provider.templateSaveFailed", {
          defaultValue: "保存应用接入配置模板失败",
        }),
      );
    } finally {
      setIsSavingTemplate(false);
    }
  };

  // 把当前编辑器的"有效模板 JSON 字符串"解析出来：
  // - 多 section 模式：用 section drafts 合成
  // - 单 textarea 模式：直接用 providerTemplateDraft
  const resolveActiveProviderTemplate = useCallback((): string => {
    if (providerTemplateSections.length > 0) {
      return composeTemplateFromSectionDrafts(providerTemplateSectionDrafts);
    }
    return providerTemplateDraft;
  }, [
    composeTemplateFromSectionDrafts,
    providerTemplateDraft,
    providerTemplateSectionDrafts,
    providerTemplateSections.length,
  ]);

  const saveProviderTemplate = async () => {
    const composed = resolveActiveProviderTemplate();
    setIsSavingProviderTemplate(true);
    try {
      await configApi.setProviderDefaultTemplate({
        appId,
        template: composed.trim() || null,
      });
      await queryClient.invalidateQueries({
        queryKey: ["providerDefaultTemplate", appId],
      });
      toast.success(
        t("provider.providerTemplateSaved", {
          defaultValue: "供应商配置模板已保存",
        }),
      );
      setProviderTemplateDialogOpen(false);
    } catch (error) {
      console.error("Failed to save provider default template", error);
      toast.error(
        t("provider.providerTemplateSaveFailed", {
          defaultValue: "保存供应商配置模板失败",
        }),
      );
    } finally {
      setIsSavingProviderTemplate(false);
    }
  };

  const applyProviderTemplateToSelection = async () => {
    if (selectedRows.length === 0) return;

    const composed = resolveActiveProviderTemplate();
    let templateObject: Record<string, unknown>;
    try {
      templateObject = JSON.parse(composed) as Record<string, unknown>;
      if (Object.keys(templateObject).length === 0) {
        throw new Error("empty-template");
      }
    } catch (error) {
      toast.error(
        t("provider.providerTemplateInvalid", {
          defaultValue: "供应商配置模板不是有效 JSON",
        }),
      );
      return;
    }

    setIsSavingProviderTemplate(true);
    let success = 0;
    let failed = 0;

    try {
      for (const row of selectedRows) {
        try {
          const nextSettingsConfig = buildProviderSettingsFromTemplate(
            row.provider,
            templateObject,
            appId,
          );

          await providersApi.update(
            {
              ...row.provider,
              settingsConfig: nextSettingsConfig,
            },
            appId,
          );
          success += 1;
        } catch (error) {
          failed += 1;
          console.error(
            "Failed to apply provider template",
            row.provider.id,
            error,
          );
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });

      if (success > 0) {
        toast.success(
          t("provider.providerTemplateApplied", {
            defaultValue: "已应用到 {{count}} 个供应商",
            count: success,
          }),
        );
      }

      if (failed > 0) {
        toast.warning(
          t("provider.providerTemplateApplyFailed", {
            defaultValue: "{{count}} 个供应商应用失败",
            count: failed,
          }),
        );
      }
    } finally {
      setIsSavingProviderTemplate(false);
    }
  };

  const applyProviderTemplateToAll = async () => {
    if (displayRows.length === 0) return;

    const composed = resolveActiveProviderTemplate();
    let templateObject: Record<string, unknown>;
    try {
      templateObject = JSON.parse(composed) as Record<string, unknown>;
      if (Object.keys(templateObject).length === 0) {
        throw new Error("empty-template");
      }
    } catch (error) {
      toast.error(
        t("provider.providerTemplateInvalid", {
          defaultValue: "供应商配置模板不是有效 JSON",
        }),
      );
      return;
    }

    setIsSavingProviderTemplate(true);
    let success = 0;
    let failed = 0;

    try {
      for (const row of displayRows) {
        try {
          const nextSettingsConfig = buildProviderSettingsFromTemplate(
            row.provider,
            templateObject,
            appId,
          );

          await providersApi.update(
            {
              ...row.provider,
              settingsConfig: nextSettingsConfig,
            },
            appId,
          );
          success += 1;
        } catch (error) {
          failed += 1;
          console.error(
            "Failed to apply provider template to all",
            row.provider.id,
            error,
          );
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });

      if (success > 0) {
        toast.success(
          t("provider.providerTemplateApplied", {
            defaultValue: "已应用到 {{count}} 个供应商",
            count: success,
          }),
        );
      }

      if (failed > 0) {
        toast.warning(
          t("provider.providerTemplateApplyFailed", {
            defaultValue: "{{count}} 个供应商应用失败",
            count: failed,
          }),
        );
      }
    } finally {
      setIsSavingProviderTemplate(false);
    }
  };

  const loadLiveConfigIntoTemplate = async () => {
    setIsSavingTemplate(true);
    try {
      const files = await configApi.listAppConfigFiles(appId);
      const liveContents = await Promise.all(
        files.map((file) =>
          configApi.readAppConfigFile({ appId, fileKey: file.key }),
        ),
      );
      const byKey = new Map(liveContents.map((file) => [file.key, file]));
      const defaults = buildTemplateByApp(appId);
      setTemplateDrafts(
        defaults.map((file) => ({
          ...file,
          content: byKey.get(file.key)?.content ?? file.content,
        })),
      );
    } catch (error) {
      console.error("Failed to load live config into template", error);
      toast.error(
        t("provider.loadLiveTemplateFailed", {
          defaultValue: "加载环境配置失败",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setIsSavingTemplate(false);
    }
  };

  const handleAdmissionRetryToggle = async (row: ProviderRowView) => {
    const providerId = row.provider.id;
    const nextEnabled = !row.admissionRetryEnabled;
    const affectedProviderIds = new Set<string>([providerId]);
    if (nextEnabled) {
      Object.values(providers).forEach((candidate) => {
        if (
          candidate.id !== providerId &&
          candidate.meta?.upstreamAdmissionRetry?.enabled === true
        ) {
          affectedProviderIds.add(candidate.id);
        }
      });
    }

    setAdmissionRetryUpdatingIds((current) => {
      const next = new Set(current);
      affectedProviderIds.forEach((id) => next.add(id));
      return next;
    });

    try {
      const currentRetry = row.provider.meta?.upstreamAdmissionRetry ?? {};
      await providersApi.update(
        {
          ...row.provider,
          meta: {
            ...(row.provider.meta ?? {}),
            upstreamAdmissionRetry: {
              ...currentRetry,
              enabled: nextEnabled,
            },
          },
        },
        appId,
      );

      const nextSuppressedIds = new Set(admissionRetrySuppressedIdsRef.current);
      if (nextEnabled) {
        nextSuppressedIds.delete(providerId);
        affectedProviderIds.forEach((id) => {
          if (id !== providerId) {
            nextSuppressedIds.add(id);
          }
        });
      } else {
        nextSuppressedIds.add(providerId);
      }
      admissionRetrySuppressedIdsRef.current = nextSuppressedIds;
      setAdmissionRetrySuppressedIds(nextSuppressedIds);
      clearAdmissionRetryRequests(
        Array.from(affectedProviderIds).filter(
          (id) => !nextEnabled || id !== providerId,
        ),
      );

      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      toast.success(
        nextEnabled
          ? t("provider.admissionRetryEnabled", {
              defaultValue: "已开启上游入场重试",
            })
          : t("provider.admissionRetryDisabled", {
              defaultValue: "已关闭上游入场重试",
            }),
      );
    } catch (error) {
      console.error("Failed to toggle upstream admission retry", error);
      toast.error(
        t("provider.admissionRetryToggleFailed", {
          defaultValue: "切换上游入场重试失败",
        }),
      );
    } finally {
      setAdmissionRetryUpdatingIds((current) => {
        const next = new Set(current);
        affectedProviderIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const handleRowEnableToggle = async (row: ProviderRowView) => {
    if (isFailoverModeActive) {
      try {
        if (row.failoverPriority) {
          await removeFromQueue.mutateAsync({
            appType: appId,
            providerId: row.provider.id,
          });
          suppressAdmissionRetryForProviders([row.provider.id]);
        } else {
          await addToQueue.mutateAsync({
            appType: appId,
            providerId: row.provider.id,
          });
        }
      } catch (error) {
        console.error("Failed to toggle failover queue", error);
      }
      return;
    }

    if (isAdditiveMode) {
      try {
        if (row.isInConfig) {
          if (onRemoveFromConfig) {
            onRemoveFromConfig(row.provider);
            return;
          }
          await providersApi.removeFromLiveConfig(row.provider.id, appId);
          suppressAdmissionRetryForProviders([row.provider.id]);
          queryClient.setQueryData(
            ["proxyStatus"],
            (current: unknown) =>
              pruneProxyStatusProviderActivity(
                current as any,
                appId,
                row.provider.id,
              ) ?? current,
          );
          await queryClient.invalidateQueries({
            queryKey: ["providers", appId],
          });
          await queryClient.invalidateQueries({
            queryKey: ["failoverQueue", appId],
          });
        } else {
          await providersApi.switch(row.provider.id, appId);
          await queryClient.invalidateQueries({
            queryKey: ["providers", appId],
          });
          await queryClient.invalidateQueries({
            queryKey: ["failoverQueue", appId],
          });
        }
      } catch (error) {
        console.error("Failed to toggle config state", error);
      }
      return;
    }

    if (row.isCurrent && !isFailoverModeActive) {
      toast.info(
        t("provider.disableCurrentUnsupported", {
          defaultValue: "当前供应商无法直接禁用，请先切换到其他供应商",
        }),
      );
      return;
    }

    onSwitch(row.provider);
  };

  const safeHandleDragEnd = (event: any) => {
    if (!canDragRows) return;
    void handleDragEnd(event);
  };

  const claudeDesktopStatusMessages = useMemo(() => {
    if (appId !== "claude-desktop" || !claudeDesktopStatus) return [];

    const messages: string[] = [];
    if (!claudeDesktopStatus.supported) {
      messages.push(
        t("claudeDesktop.statusUnsupported", {
          defaultValue: "当前平台暂不支持 Claude Desktop 3P 配置写入。",
        }),
      );
      return messages;
    }

    if (claudeDesktopStatus.staleRawModels) {
      messages.push(
        t("claudeDesktop.statusStaleRawModels", {
          defaultValue:
            "Claude Desktop profile 中存在非 claude-* 模型名，新版 Claude Desktop 可能拒绝加载；重新切换当前供应商可修复。",
        }),
      );
    }
    if (claudeDesktopStatus.missingRouteMappings) {
      messages.push(
        t("claudeDesktop.statusMissingRouteMappings", {
          defaultValue:
            "当前供应商启用了模型映射，但没有有效路由；请编辑供应商并补全至少一个模型映射。",
        }),
      );
    }
    if (
      claudeDesktopStatus.mode === "proxy" &&
      !claudeDesktopStatus.gatewayTokenConfigured
    ) {
      messages.push(
        t("claudeDesktop.statusGatewayTokenMissing", {
          defaultValue:
            "当前本地路由 token 尚未生成；重新切换该供应商会写入新的本地 token。",
        }),
      );
    }

    const expected = claudeDesktopStatus.expectedBaseUrl?.replace(/\/+$/, "");
    const actual = claudeDesktopStatus.actualBaseUrl?.replace(/\/+$/, "");
    if (expected && actual && expected !== actual) {
      messages.push(
        t("claudeDesktop.statusBaseUrlMismatch", {
          expected,
          actual,
          defaultValue:
            "Claude Desktop profile 指向的地址与当前供应商不一致；当前为 {{actual}}，应为 {{expected}}。重新切换当前供应商可修复。",
        }),
      );
    }

    return messages;
  }, [appId, claudeDesktopStatus, t]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="w-full border border-dashed rounded-lg h-20 border-muted-foreground/40 bg-muted/40"
          />
        ))}
      </div>
    );
  }

  if (sortedProviders.length === 0) {
    return (
      <ProviderEmptyState
        appId={appId}
        onCreate={onCreate}
        onImport={() => importMutation.mutate()}
      />
    );
  }

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
      {claudeDesktopStatusMessages.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t("claudeDesktop.statusTitle", {
              defaultValue: "Claude Desktop 配置需要检查",
            })}
          </div>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed">
            {claudeDesktopStatusMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border-default bg-card/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80">
        {showBulkMembershipActions ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => void applyBulkEnableState(true)}
              disabled={isBulkOperating || effectiveTargetRows.length === 0}
            >
              {interactionMode === "failover"
                ? t("provider.bulkAddToQueue", {
                    defaultValue: "加入队列",
                  })
                : t("provider.bulkAddToConfig", {
                    defaultValue: "写入配置",
                  })}
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => void applyBulkEnableState(false)}
              disabled={isBulkOperating || effectiveTargetRows.length === 0}
            >
              {interactionMode === "failover"
                ? t("provider.bulkRemoveFromQueue", {
                    defaultValue: "移出队列",
                  })
                : t("provider.bulkRemoveFromConfig", {
                    defaultValue: "移出配置",
                  })}
            </Button>
          </>
        ) : null}

        <Badge
          variant="secondary"
          className="order-first h-7 px-2 text-sm font-mono"
        >
          {enabledCount}/{totalCount}
          {filteredCount !== totalCount ? ` · ${filteredCount}` : ""}
        </Badge>

        <Button
          size="sm"
          variant="outline"
          className={cn(
            "h-7 text-xs",
            selectedCount > 0 && "text-red-600 border-red-500/30",
          )}
          onClick={() => setShowBulkDeleteConfirm(true)}
          disabled={selectedCount === 0 || isBulkOperating}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          {t("common.delete", { defaultValue: "删除" })}
          {selectedCount > 0 ? ` (${selectedCount})` : ""}
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={
                recentSessionsForApp.length === 0 && !isRecentSessionsLoading
              }
            >
              <History className="h-3.5 w-3.5 mr-1" />
              {t("provider.recentSessions", { defaultValue: "最近会话" })}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[26rem] p-0" align="start">
            <div className="border-b px-3 py-2 text-sm font-medium">
              {t("provider.recentSessionsTitle", {
                defaultValue: "最近 10 条会话",
              })}
            </div>
            <ScrollArea className="max-h-72">
              {isRecentSessionsLoading ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("common.loading", { defaultValue: "加载中..." })}
                </div>
              ) : recentSessionsForApp.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  {t("provider.noRecentSessions", {
                    defaultValue: "暂无最近会话",
                  })}
                </div>
              ) : (
                <div className="divide-y divide-border-default">
                  {recentSessionsForApp.map((session) => {
                    const title =
                      session.title ||
                      session.projectDir
                        ?.split(/[\\/]/)
                        .filter(Boolean)
                        .pop() ||
                      session.sessionId.slice(0, 8);
                    return (
                      <button
                        key={`${session.providerId}:${session.sessionId}:${session.sourcePath || ""}`}
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void handleResumeSession(session)}
                        disabled={!session.resumeCommand}
                      >
                        <div className="truncate text-sm font-medium">
                          {title}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate font-mono">
                          {session.projectDir || session.resumeCommand || "-"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 text-xs">
              <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
              {t("provider.configMenu", { defaultValue: "配置" })}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={() => setCurrentConfigDialogOpen(true)}>
              <FileText className="h-3.5 w-3.5" />
              {t("provider.currentConfig", { defaultValue: "当前配置" })}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTemplateDialogOpen(true)}>
              <FileText className="h-3.5 w-3.5" />
              {t("provider.commonConfigTemplate", {
                defaultValue: "接管代理配置模板",
              })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setProviderTemplateDialogOpen(true)}
            >
              <FileText className="h-3.5 w-3.5" />
              {t("provider.providerDefaultTemplate", {
                defaultValue: "供应商配置模板",
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {(appId === "claude" || appId === "codex") && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setSessionRoutingManagerOpen(true)}
          >
            <Route className="mr-1 h-3.5 w-3.5" />
            {t("sessionRouting.manager.title", {
              defaultValue: "会话路由",
            })}
          </Button>
        )}

        <div className="ml-auto flex min-w-[22rem] flex-1 items-center justify-end gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t("provider.modelFilterAriaLabel", {
                  defaultValue: "模型名称筛选",
                })}
                className="h-8 max-w-[15rem] justify-between text-xs"
              >
                <span className="truncate">
                  {t("provider.modelFilter", { defaultValue: "模型" })}:{" "}
                  {modelFilterSummary}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-2">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("provider.modelFilter", { defaultValue: "模型" })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => setModelFilters(new Set())}
                  disabled={modelFilters.size === 0}
                >
                  {t("common.clear", { defaultValue: "清空" })}
                </Button>
              </div>
              <ScrollArea className="max-h-72">
                <div className="space-y-1">
                  {modelFilterOptions.map((option) => {
                    const label =
                      option.model === EMPTY_MODEL_FILTER_VALUE
                        ? t("provider.emptyModel", {
                            defaultValue: "未填写模型",
                          })
                        : option.model;
                    return (
                      <label
                        key={option.model}
                        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60"
                      >
                        <Checkbox
                          aria-label={`${label} (${option.count})`}
                          checked={modelFilters.has(option.model)}
                          onCheckedChange={(checked) =>
                            toggleModelFilter(option.model, checked === true)
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        <span className="shrink-0 font-mono text-muted-foreground">
                          {option.count}
                        </span>
                      </label>
                    );
                  })}
                  {modelFilterOptions.length === 0 ? (
                    <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                      {t("provider.noModels", { defaultValue: "暂无模型" })}
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>
          <Popover open={Boolean(searchTerm)}>
            <PopoverAnchor asChild>
              <div className="relative w-full max-w-[28rem]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={searchTerm}
                  onChange={(event) => {
                    setSearchTerm(event.target.value);
                    setActiveSearchMatchIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      jumpToSearchMatch(
                        event.shiftKey
                          ? activeSearchMatchIndex - 1
                          : activeSearchMatchIndex + 1,
                      );
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSearchTerm("");
                      setActiveSearchMatchIndex(0);
                    }
                  }}
                  placeholder={t("provider.searchPlaceholder", {
                    defaultValue: "按名称、备注、网址或模型定位...",
                  })}
                  aria-label={t("provider.searchAriaLabel", {
                    defaultValue: "Search providers",
                  })}
                  className="h-8 pr-28 pl-9 text-sm"
                />
                {searchTerm ? (
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    <span className="min-w-[3.25rem] text-center font-mono text-[11px] text-muted-foreground">
                      {searchMatches.length === 0
                        ? "0/0"
                        : `${activeSearchMatchIndex + 1}/${searchMatches.length}`}
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() =>
                        jumpToSearchMatch(activeSearchMatchIndex - 1)
                      }
                      disabled={searchMatches.length === 0}
                      title={t("provider.searchPrev", {
                        defaultValue: "上一个结果",
                      })}
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() =>
                        jumpToSearchMatch(activeSearchMatchIndex + 1)
                      }
                      disabled={searchMatches.length === 0}
                      title={t("provider.searchNext", {
                        defaultValue: "下一个结果",
                      })}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : null}
              </div>
            </PopoverAnchor>
            <PopoverContent
              align="end"
              sideOffset={8}
              onOpenAutoFocus={(event) => event.preventDefault()}
              className="z-[80] w-[28rem] overflow-hidden border-border-default bg-popover p-0 text-popover-foreground shadow-xl"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border-default bg-popover px-3 py-2">
                <div className="min-w-0 text-xs text-muted-foreground">
                  {searchMatches.length > 0
                    ? t("provider.searchResultSummary", {
                        defaultValue: "定位到 {{current}} / {{total}}",
                        current: activeSearchMatchIndex + 1,
                        total: searchMatches.length,
                      })
                    : t("provider.noSearchResults", {
                        defaultValue: "没有找到匹配结果",
                      })}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setSearchTerm("");
                    setActiveSearchMatchIndex(0);
                    searchInputRef.current?.focus();
                  }}
                >
                  {t("common.clear", { defaultValue: "清空" })}
                </Button>
              </div>
              {searchMatches.length > 0 ? (
                <ScrollArea className="max-h-[min(22rem,calc(100vh-14rem))]">
                  <div className="divide-y divide-border-default bg-popover">
                    {searchMatches.map((match, index) => {
                      const row = displayRows[match.rowIndex];
                      if (!row) return null;
                      return (
                        <button
                          key={`${match.providerId}:${index}`}
                          type="button"
                          className={cn(
                            "flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-muted/70",
                            index === activeSearchMatchIndex &&
                              "bg-amber-500/15",
                          )}
                          onClick={() => {
                            jumpToSearchMatch(index);
                            searchInputRef.current?.focus();
                          }}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate text-sm font-medium">
                              {row.provider.name}
                            </span>
                            <Badge
                              variant="outline"
                              className="h-5 shrink-0 px-1.5 text-[10px] font-mono"
                            >
                              #{row.orderNumber}
                            </Badge>
                            <Badge
                              variant={row.isEnabled ? "default" : "secondary"}
                              className="h-5 shrink-0 px-1.5 text-[10px]"
                            >
                              {row.isEnabled
                                ? t("provider.enabled", {
                                    defaultValue: "启用",
                                  })
                                : t("provider.disabled", {
                                    defaultValue: "禁用",
                                  })}
                            </Badge>
                            {row.isActiveProxyProvider ? (
                              <Badge className="h-5 shrink-0 bg-emerald-600 px-1.5 text-[10px] hover:bg-emerald-600">
                                {t("provider.currentProxy", {
                                  defaultValue: "当前代理",
                                })}
                              </Badge>
                            ) : null}
                            {row.activeRequestCount > 0 ? (
                              <Badge
                                variant="outline"
                                className="h-5 shrink-0 border-emerald-500/40 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-300"
                              >
                                {t("provider.liveRequests", {
                                  defaultValue: "请求中",
                                })}
                                {row.activeRequestCount > 1
                                  ? ` ${row.activeRequestCount}`
                                  : ""}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {row.provider.notes ||
                              (row.modelDisplay !== "-"
                                ? row.modelDisplay
                                : row.endpointDisplay)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              ) : (
                <div className="bg-popover px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("provider.noSearchResults", {
                    defaultValue: "没有找到匹配结果",
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-default bg-card/40">
        <div className="z-20 flex shrink-0 items-center justify-between gap-2 border-b border-border-default bg-card px-3 py-2 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <span>
              {t("provider.searchScopeHint", {
                defaultValue:
                  "搜索只负责定位，不会过滤列表或改变故障转移顺序。",
              })}
            </span>
            {searchTerm && searchMatches.length === 0 ? (
              <span className="text-amber-600 dark:text-amber-400">
                {t("provider.noSearchResults", {
                  defaultValue: "没有找到匹配结果",
                })}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => scrollToEdge("start")}
              title={t("provider.scrollToTop", {
                defaultValue: "滚动到顶部",
              })}
            >
              <ChevronsUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => scrollByPage(-1)}
              title={t("provider.scrollPrevPage", {
                defaultValue: "上一页",
              })}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => scrollByPage(1)}
              title={t("provider.scrollNextPage", {
                defaultValue: "下一页",
              })}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => scrollToEdge("end")}
              title={t("provider.scrollToBottom", {
                defaultValue: "滚动到底部",
              })}
            >
              <ChevronsDown className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={listScrollRef}
            className="h-full overflow-auto overscroll-contain"
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={safeHandleDragEnd}
            >
              <SortableContext
                items={displayRows.map((row) => row.provider.id)}
                strategy={verticalListSortingStrategy}
              >
                <Table
                  ref={providerTableRef}
                  className="min-w-[1350px] table-fixed text-[13px]"
                >
                  <colgroup>
                    <col className="w-[48px]" />
                    <col className="w-[84px]" />
                    <col />
                    <col className="w-[210px]" />
                    <col className="w-[300px]" />
                    <col className="w-[196px]" />
                    <col className="w-[224px]" />
                  </colgroup>
                  <TableHeader className="sticky top-0 z-20 bg-muted">
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="h-9 bg-muted px-2 shadow-[inset_0_-1px_0_hsl(var(--border))]">
                        <Checkbox
                          checked={
                            allDisplayedSelected
                              ? true
                              : hasDisplayedSelection
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(checked) =>
                            toggleSelectAllDisplayed(Boolean(checked))
                          }
                          aria-label={t("provider.selectAll", {
                            defaultValue: "全选",
                          })}
                        />
                      </TableHead>
                      <TableHead className="h-9 bg-muted px-2 text-center whitespace-nowrap shadow-[inset_0_-1px_0_hsl(var(--border))]">
                        {t("provider.priority", { defaultValue: "序号" })}
                      </TableHead>
                      <TableHead className="h-9 bg-muted px-2 whitespace-nowrap shadow-[inset_0_-1px_0_hsl(var(--border))]">
                        {t("provider.name", { defaultValue: "供应商名称" })}
                      </TableHead>
                      <TableHead className="h-9 bg-muted px-2 whitespace-nowrap shadow-[inset_0_-1px_0_hsl(var(--border))]">
                        {t("provider.notes", { defaultValue: "备注" })}
                      </TableHead>
                      <TableHead className="h-9 bg-muted px-2 whitespace-nowrap shadow-[inset_0_-1px_0_hsl(var(--border))]">
                        <button
                          type="button"
                          onClick={() => void applyModelNameSort()}
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                          aria-label={t("provider.modelNameSort", {
                            defaultValue: "模型名称排序",
                          })}
                          title={t("provider.modelNameSortHint", {
                            defaultValue:
                              "按模型名称重排供应商，启用项保持在前；会更新序号和故障转移队列顺序",
                          })}
                        >
                          {t("provider.modelName", {
                            defaultValue: "模型名称",
                          })}
                          {modelSortDirection === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5" />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="h-9 bg-muted px-2 text-center whitespace-nowrap shadow-[inset_0_-1px_0_hsl(var(--border))]">
                        <button
                          type="button"
                          onClick={cycleStatusSort}
                          className="inline-flex items-center justify-center gap-1 text-muted-foreground hover:text-foreground"
                        >
                          {t("provider.status", { defaultValue: "状态" })}
                          {statusSortDirection === null ? (
                            <ArrowUpDown className="h-3.5 w-3.5" />
                          ) : statusSortDirection === "desc" ? (
                            <ArrowDown className="h-3.5 w-3.5" />
                          ) : (
                            <ArrowUp className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="h-9 bg-muted px-2 text-center whitespace-nowrap shadow-[inset_0_-1px_0_hsl(var(--border))]">
                        {t("common.actions", { defaultValue: "操作" })}
                      </TableHead>
                    </TableRow>
                  </TableHeader>

                  <TableBody>
                    {displayRows.map((row) => (
                      <SortableProviderTableRow
                        key={row.provider.id}
                        row={row}
                        appId={appId}
                        interactionMode={interactionMode}
                        showFailoverHealth={
                          isFailoverModeActive && Boolean(row.failoverPriority)
                        }
                        canDragRows={canDragRows}
                        rowRef={(node) => registerRowRef(row.provider.id, node)}
                        isSearchMatch={searchMatchIdSet.has(row.provider.id)}
                        isActiveSearchMatch={
                          activeSearchMatch?.providerId === row.provider.id
                        }
                        isSelected={selectedProviderIds.has(row.provider.id)}
                        onSelectedChange={(checked) =>
                          toggleSelectRow(row.provider.id, checked)
                        }
                        onOpenWebsite={onOpenWebsite}
                        onActivateProvider={() => onSwitch(row.provider)}
                        onToggleEnabled={() => void handleRowEnableToggle(row)}
                        onToggleAdmissionRetry={() =>
                          void handleAdmissionRetryToggle(row)
                        }
                        isAdmissionRetryUpdating={admissionRetryUpdatingIds.has(
                          row.provider.id,
                        )}
                        onPinToTop={() => void handlePinToTop(row.provider.id)}
                        onOpenTerminal={
                          onOpenTerminal
                            ? () => onOpenTerminal(row.provider)
                            : undefined
                        }
                        onEdit={() =>
                          onEdit(row.provider, { isEnabled: row.isEnabled })
                        }
                        onDuplicate={() => onDuplicate(row.provider)}
                        onTest={
                          row.canTest
                            ? () => handleTest(row.provider)
                            : undefined
                        }
                        isTesting={isChecking(row.provider.id)}
                        onDelete={
                          row.canDelete
                            ? () => onDelete(row.provider)
                            : undefined
                        }
                        onConfigureUsage={
                          onConfigureUsage
                            ? () => onConfigureUsage(row.provider)
                            : undefined
                        }
                        canSetDefault={
                          (appId === "openclaw" || appId === "hermes") &&
                          row.isInConfig &&
                          Boolean(onSetAsDefault)
                        }
                        isDefaultModel={
                          appId === "hermes"
                            ? row.isCurrent
                            : isProviderDefaultModel(row.provider.id)
                        }
                        onSetAsDefault={
                          onSetAsDefault
                            ? () => onSetAsDefault(row.provider)
                            : undefined
                        }
                        t={t}
                      />
                    ))}
                  </TableBody>
                </Table>
              </SortableContext>
            </DndContext>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showBulkDeleteConfirm}
        variant="destructive"
        title={t("provider.bulkDeleteTitle", {
          defaultValue: "批量删除供应商",
        })}
        message={t("provider.bulkDeleteMessage", {
          defaultValue:
            "将删除已选中的 {{count}} 个供应商。\n\n此操作不可撤销。",
          count: selectedCount,
        })}
        confirmText={t("provider.bulkDeleteAction", {
          defaultValue: "确认删除",
        })}
        onConfirm={() => void executeBulkDelete()}
        onCancel={() => {
          if (!isBulkOperating) {
            setShowBulkDeleteConfirm(false);
          }
        }}
      />

      {(appId === "claude" || appId === "codex") && (
        <SessionRoutingManagerDialog
          appId={appId}
          open={sessionRoutingManagerOpen}
          onOpenChange={setSessionRoutingManagerOpen}
        />
      )}

      <FullScreenPanel
        isOpen={templateDialogOpen}
        title={t("provider.commonConfigTemplate", {
          defaultValue: "接管代理配置模板",
        })}
        onClose={() => setTemplateDialogOpen(false)}
        footer={
          <>
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-sm"
                onClick={() => setTemplateDrafts(buildTemplateByApp(appId))}
                disabled={isSavingTemplate}
              >
                {t("provider.resetTemplate", {
                  defaultValue: "恢复默认模板",
                })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-sm"
                onClick={() => void loadLiveConfigIntoTemplate()}
                disabled={isSavingTemplate}
              >
                {t("provider.loadLiveConfig", {
                  defaultValue: "加载环境配置",
                })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-sm"
                onClick={() => void copyTemplate()}
              >
                <Copy className="mr-1 h-3.5 w-3.5" />
                {t("common.copy", { defaultValue: "复制" })}
              </Button>
              <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={canSyncTemplateToLive && syncTemplateToLive}
                  onCheckedChange={(checked) =>
                    setSyncTemplateToLive(Boolean(checked))
                  }
                  disabled={!canSyncTemplateToLive}
                />
                {t("provider.syncTemplateToLive", {
                  defaultValue: "接管中同步 live",
                })}
              </label>
            </div>
            <Button
              size="sm"
              className="h-8 text-sm"
              onClick={() => void saveTemplate()}
              disabled={isTemplateFetching || isSavingTemplate}
            >
              {isSavingTemplate
                ? t("common.saving", { defaultValue: "保存中..." })
                : t("common.save", { defaultValue: "保存" })}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {appId === "opencode" || appId === "openclaw" || appId === "hermes"
              ? t("provider.configTemplateHintAdditive", {
                  defaultValue:
                    "该应用当前不支持代理接管；这里提供可直接编辑保存的 starter 配置，供应商仍由列表中的供应商配置累加写入 live 文件。",
                })
              : appId === "gemini"
                ? t("provider.configTemplateHintGemini", {
                    defaultValue:
                      "Gemini 模板按 .env 与 settings.json 分文件管理，支持 {proxyBaseUrl}、{proxyToken} 与 {mcpConfig}。",
                  })
                : t("provider.configTemplateHint", {
                    defaultValue:
                      "模板只用于代理接管模式下生成应用连接 cc-switch 的稳定接入配置，支持 {proxyBaseUrl}、{proxyCodexBaseUrl}、{proxyToken} 与 {mcpConfig}。",
                  })}
          </p>
          <div className="space-y-4">
            {(templateDrafts.length > 0
              ? templateDrafts
              : buildTemplateByApp(appId)
            ).map((file) => (
              <div key={file.key} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{file.label}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {file.key}
                  </div>
                </div>
                <Textarea
                  value={file.content}
                  onChange={(event) => {
                    const value = event.target.value;
                    setTemplateDrafts((current) =>
                      (current.length > 0
                        ? current
                        : buildTemplateByApp(appId)
                      ).map((item) =>
                        item.key === file.key
                          ? { ...item, content: value }
                          : item,
                      ),
                    );
                  }}
                  rows={file.key === "env" ? 8 : 14}
                  className="font-mono text-sm leading-6"
                  placeholder={file.content}
                  disabled={isTemplateFetching || isSavingTemplate}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {appId === "gemini"
              ? t("provider.templateEffectHintGemini", {
                  defaultValue:
                    "接管模式会同时渲染 Gemini .env 与 settings.json；启用 MCP 时写入 mcpServers，未启用时不写空 mcpServers。直连模式仍使用供应商自身配置。",
                })
              : t("provider.templateEffectHint", {
                  defaultValue:
                    "接管模式会用该模板重建应用 live 配置；直连模式不套用此模板，直接写当前供应商配置并合并 MCP。",
                })}
          </p>
        </div>
      </FullScreenPanel>

      <FullScreenPanel
        isOpen={currentConfigDialogOpen}
        title={t("provider.currentConfig", { defaultValue: "当前配置" })}
        onClose={() => setCurrentConfigDialogOpen(false)}
        footer={
          <>
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => void refreshCurrentConfig()}
                disabled={isCurrentConfigLoading}
              >
                {t("common.refresh", { defaultValue: "刷新" })}
              </Button>

              {canImportCurrentConfigMcp && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => void importCurrentConfigMcp()}
                  disabled={
                    configFiles.length === 0 ||
                    isCurrentConfigLoading ||
                    isSavingConfig ||
                    isImportingCurrentConfigMcp
                  }
                >
                  {isImportingCurrentConfigMcp
                    ? t("provider.currentConfigImportingMcp", {
                        defaultValue: "回显 MCP 中...",
                      })
                    : t("provider.currentConfigImportMcp", {
                        defaultValue: "回显到 MCP 管理",
                      })}
                </Button>
              )}
            </div>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => void saveCurrentConfig()}
              disabled={
                configFiles.length === 0 ||
                isCurrentConfigLoading ||
                isSavingConfig
              }
            >
              {isSavingConfig
                ? t("common.saving", { defaultValue: "保存中..." })
                : t("common.save", { defaultValue: "保存" })}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {isSwitchModeApp && (
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-xs",
                isCurrentAppTakeoverActive
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-border/60 bg-muted/40 text-muted-foreground",
              )}
            >
              {isCurrentAppTakeoverActive
                ? t("provider.currentConfigTakeoverHint", {
                    defaultValue:
                      "当前应用已开启代理接管。这里展示的是应用实际配置，可随时手动保存；重新开启或同步接管模板时可能会再次按模板重建。",
                  })
                : t("provider.currentConfigSsotHint", {
                    defaultValue:
                      "“保存”只会直接写应用实际配置文件，不会回写供应商事实源；供应商 API 地址、Key 和模型请在供应商编辑中维护。",
                  })}
            </div>
          )}

          <div className="space-y-4">
            {configFiles.map((file: AppConfigFileEntry) => {
              const meta = currentConfigContents[file.key];
              return (
                <div key={file.key} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">{file.label}</div>
                    <div className="text-[11px] text-muted-foreground font-mono break-all">
                      {meta?.path || file.path}
                    </div>
                  </div>
                  <Textarea
                    value={currentConfigDrafts[file.key] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCurrentConfigDrafts((current) => ({
                        ...current,
                        [file.key]: value,
                      }));
                    }}
                    rows={file.key === "env" ? 8 : 14}
                    className="font-mono text-sm leading-6"
                    placeholder={t("provider.currentConfigPlaceholder", {
                      defaultValue: "配置文件内容为空",
                    })}
                    disabled={isCurrentConfigLoading}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </FullScreenPanel>

      <FullScreenPanel
        isOpen={providerTemplateDialogOpen}
        title={t("provider.providerDefaultTemplate", {
          defaultValue: "供应商配置模板",
        })}
        onClose={() => setProviderTemplateDialogOpen(false)}
        footer={
          <>
            <div className="mr-auto text-xs text-muted-foreground">
              {t("provider.providerTemplateHint", {
                defaultValue:
                  "可使用占位符：{baseUrl}、{apiKey}、{model}。保存后将用于新增供应商默认配置，后续会支持批量套用到现有供应商。",
              })}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-sm"
              onClick={() => {
                const formatted = formatProviderTemplateForApp(
                  appId,
                  DEFAULT_PROVIDER_TEMPLATE_BY_APP[appId] ?? "",
                );
                setProviderTemplateDraft(formatted);
                const sections = getProviderTemplateSections(appId, formatted);
                if (sections.length > 0) {
                  const next: Record<string, string> = {};
                  for (const s of sections) next[s.key] = s.value;
                  setProviderTemplateSectionDrafts(next);
                } else {
                  setProviderTemplateSectionDrafts({});
                }
              }}
              disabled={isSavingProviderTemplate}
            >
              {t("provider.resetTemplate", {
                defaultValue: "恢复默认模板",
              })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-sm"
              onClick={() => void applyProviderTemplateToSelection()}
              disabled={selectedRows.length === 0 || isSavingProviderTemplate}
            >
              {t("provider.providerTemplateApplyToSelected", {
                defaultValue: "应用到选中项",
              })}
              {selectedRows.length > 0 ? ` (${selectedRows.length})` : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-sm"
              onClick={() => void applyProviderTemplateToAll()}
              disabled={displayRows.length === 0 || isSavingProviderTemplate}
            >
              {t("provider.providerTemplateApplyToAll", {
                defaultValue: "应用到当前应用全部",
              })}
              {displayRows.length > 0 ? ` (${displayRows.length})` : ""}
            </Button>
            <Button
              size="sm"
              className="h-8 text-sm"
              onClick={() => void saveProviderTemplate()}
              disabled={isProviderTemplateFetching || isSavingProviderTemplate}
            >
              {isSavingProviderTemplate
                ? t("common.saving", { defaultValue: "保存中..." })
                : t("common.save", { defaultValue: "保存" })}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {providerTemplateSections.length > 0 ? (
            providerTemplateSections.map((section) => (
              <div key={section.key} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium">{section.label}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {section.language === "json" ? "JSON" : "TEXT"}
                  </div>
                </div>
                <Textarea
                  value={
                    providerTemplateSectionDrafts[section.key] ?? section.value
                  }
                  onChange={(event) =>
                    setProviderTemplateSectionDrafts((current) => ({
                      ...current,
                      [section.key]: event.target.value,
                    }))
                  }
                  rows={section.rows}
                  className="font-mono text-sm leading-6"
                />
              </div>
            ))
          ) : (
            <Textarea
              value={providerTemplateDraft}
              onChange={(event) => setProviderTemplateDraft(event.target.value)}
              rows={18}
              className="font-mono text-sm leading-6"
              placeholder={formatProviderTemplateForApp(
                appId,
                DEFAULT_PROVIDER_TEMPLATE_BY_APP[appId] ?? "",
              )}
            />
          )}
        </div>
      </FullScreenPanel>
    </div>
  );
}

interface SortableProviderTableRowProps {
  row: ProviderRowView;
  appId: AppId;
  interactionMode: ProviderInteractionMode;
  showFailoverHealth: boolean;
  canDragRows: boolean;
  rowRef: (node: HTMLTableRowElement | null) => void;
  isSearchMatch: boolean;
  isActiveSearchMatch: boolean;
  isSelected: boolean;
  onSelectedChange: (checked: boolean) => void;
  onOpenWebsite: (url: string) => void;
  onActivateProvider: () => void;
  onToggleEnabled: () => void;
  onToggleAdmissionRetry: () => void;
  isAdmissionRetryUpdating: boolean;
  onPinToTop: () => void;
  onOpenTerminal?: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onTest?: () => void;
  isTesting: boolean;
  onDelete?: () => void;
  onConfigureUsage?: () => void;
  canSetDefault: boolean;
  isDefaultModel: boolean;
  onSetAsDefault?: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function SortableProviderTableRow({
  row,
  appId,
  interactionMode,
  showFailoverHealth,
  canDragRows,
  rowRef,
  isSearchMatch,
  isActiveSearchMatch,
  isSelected,
  onSelectedChange,
  onOpenWebsite,
  onActivateProvider,
  onToggleEnabled,
  onToggleAdmissionRetry,
  isAdmissionRetryUpdating,
  onPinToTop,
  onOpenTerminal,
  onEdit,
  onDuplicate,
  onTest,
  isTesting,
  onDelete,
  onConfigureUsage,
  canSetDefault,
  isDefaultModel,
  onSetAsDefault,
  t,
}: SortableProviderTableRowProps) {
  const { data: health } = useProviderHealth(row.provider.id, appId);
  const { data: circuitStats } = useCircuitBreakerStats(row.provider.id, appId);
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.provider.id,
    disabled: !canDragRows,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const canOpenNameLink = Boolean(
    row.nameLink && /^https?:\/\//i.test(row.nameLink),
  );

  const suppressFailoverHealth = !row.isEnabled || row.admissionRetryEnabled;
  const isCircuitOpen =
    !suppressFailoverHealth &&
    showFailoverHealth &&
    circuitStats?.state === "open";
  const isCircuitHalfOpen =
    !suppressFailoverHealth &&
    showFailoverHealth &&
    circuitStats?.state === "half_open";
  const failureCount = row.isEnabled ? (health?.consecutive_failures ?? 0) : 0;
  const isDegraded =
    !suppressFailoverHealth &&
    showFailoverHealth &&
    !isCircuitOpen &&
    !isCircuitHalfOpen &&
    health?.is_healthy !== false &&
    failureCount > 0;
  const isProcessing = row.activeRequestCount > 0;
  const isAdmissionRetrying = row.isEnabled && row.admissionRetryCount > 0;
  const isAdmissionAdmitted =
    row.isEnabled &&
    row.admissionRetryState === "admitted" &&
    row.admissionRetryAdmittedCount > 0;
  const activityModel = row.activeRequestModel;
  const requestModel = row.activeRequestRequestModel;
  const upstreamModel = row.activeRequestUpstreamModel;
  const admissionRetryLastFailureAt = row.admissionRetryLastFailureAt
    ? new Date(row.admissionRetryLastFailureAt).toLocaleString()
    : null;
  const lastFailureAt =
    row.isEnabled && health?.last_failure_at
      ? new Date(health.last_failure_at).toLocaleString()
      : null;
  const circuitFailureRate =
    !suppressFailoverHealth && circuitStats && circuitStats.totalRequests > 0
      ? `${circuitStats.failedRequests}/${circuitStats.totalRequests}`
      : null;
  const healthDetailLines = [
    isCircuitOpen
      ? t("provider.statusReasonCircuitOpen", {
          defaultValue: "熔断器已打开，当前新请求不会再路由到该供应商。",
        })
      : null,
    isCircuitHalfOpen
      ? t("provider.statusReasonCircuitHalfOpen", {
          defaultValue: "熔断器处于半开状态，正在尝试恢复探测请求。",
        })
      : null,
    isDegraded
      ? t("provider.statusReasonDegraded", {
          defaultValue: "近期请求存在失败，当前处于降级观察状态。",
        })
      : null,
    isAdmissionRetrying
      ? t("provider.statusReasonAdmissionRetrying", {
          defaultValue: "上游入场重试中：第 {{count}} 次",
          count: row.admissionRetryCount,
        })
      : null,
    isAdmissionAdmitted
      ? t("provider.statusReasonAdmissionRetryAdmitted", {
          defaultValue: "上游入场已成功，后续请求正在按正常流程继续处理。",
        })
      : null,
    isAdmissionAdmitted
      ? t("provider.statusReasonAdmissionRetryAdmittedCount", {
          defaultValue: "本次入场在第 {{count}} 次重试后成功",
          count: row.admissionRetryAdmittedCount,
        })
      : null,
    isAdmissionRetrying && row.admissionRetryStatus
      ? t("provider.statusReasonAdmissionRetryStatus", {
          defaultValue: "入场重试状态：HTTP {{status}}",
          status: row.admissionRetryStatus,
        })
      : null,
    isAdmissionRetrying && row.admissionRetryLastError
      ? t("provider.statusReasonAdmissionRetryLastError", {
          defaultValue: "入场重试最后错误：{{error}}",
          error: row.admissionRetryLastError,
        })
      : null,
    isAdmissionRetrying && admissionRetryLastFailureAt
      ? t("provider.statusReasonAdmissionRetryLastFailureAt", {
          defaultValue: "入场重试最后失败时间：{{time}}",
          time: admissionRetryLastFailureAt,
        })
      : null,
    isAdmissionRetrying && row.admissionRetryDelayMs != null
      ? t("provider.statusReasonAdmissionRetryDelay", {
          defaultValue: "下一轮重试延迟：{{delay}}ms",
          delay: row.admissionRetryDelayMs,
        })
      : null,
    row.isEnabled && row.admissionRetryEnabled && !isAdmissionRetrying
      ? t("provider.statusReasonAdmissionRetryEnabled", {
          defaultValue: "上游入场重试已开启，拥挤类失败不会触发降级或熔断。",
        })
      : null,
    failureCount > 0
      ? t("provider.statusReasonFailures", {
          defaultValue: "连续失败次数：{{count}}",
          count: failureCount,
        })
      : null,
    circuitFailureRate
      ? t("provider.statusReasonFailureRate", {
          defaultValue: "熔断统计：{{rate}}",
          rate: circuitFailureRate,
        })
      : null,
    row.isEnabled && health?.last_error
      ? t("provider.statusReasonLastError", {
          defaultValue: "最后错误：{{error}}",
          error: health.last_error,
        })
      : null,
    lastFailureAt
      ? t("provider.statusReasonLastFailureAt", {
          defaultValue: "最后失败时间：{{time}}",
          time: lastFailureAt,
        })
      : null,
    isProcessing && activityModel
      ? t(
          upstreamModel && requestModel && upstreamModel !== requestModel
            ? "provider.statusReasonUpstreamModel"
            : "provider.statusReasonActivityModel",
          {
            defaultValue:
              upstreamModel && requestModel && upstreamModel !== requestModel
                ? "实际上游模型：{{model}}"
                : "活动模型：{{model}}",
            model: activityModel,
          },
        )
      : null,
    isProcessing &&
    requestModel &&
    upstreamModel &&
    requestModel !== upstreamModel
      ? t("provider.statusReasonRequestModel", {
          defaultValue: "请求模型：{{model}}",
          model: requestModel,
        })
      : null,
  ].filter(Boolean) as string[];
  const hasStatusTooltip = healthDetailLines.length > 0;

  // 被动禁用（认证错误熔断等）的供应商会被移出故障转移队列，showFailoverHealth
  // 变为 false，熔断/降级 badge 不再显示。但后端保留了 provider_health.last_error，
  // 这里在没有其它健康 badge 时兜底显示一个"异常"标记，让用户在列表上直接看到问题，
  // 具体错误文本仍通过状态列 tooltip 展示。
  const hasPersistedError =
    !isProcessing &&
    !isCircuitOpen &&
    !isCircuitHalfOpen &&
    !isDegraded &&
    !row.admissionRetryEnabled &&
    row.isEnabled &&
    Boolean(health?.last_error);

  const statusLabel = row.isActiveProxyProvider
    ? t("provider.currentProxy", { defaultValue: "当前代理" })
    : row.modeState === "proxy_target"
      ? t("provider.currentProxy", { defaultValue: "当前代理" })
      : row.modeState === "failover_enabled"
        ? t("provider.enabled", { defaultValue: "启用" })
        : row.modeState === "live_current"
          ? t("provider.inUse", { defaultValue: "使用中" })
          : t("provider.disabled", { defaultValue: "禁用" });
  const showMembershipToggle =
    interactionMode === "failover" || interactionMode === "additive";
  const activationLabel =
    interactionMode === "takeover"
      ? row.isCurrent
        ? t("provider.currentProxy", { defaultValue: "当前代理" })
        : t("provider.switchToThisProvider", {
            defaultValue: "切换到此供应商",
          })
      : row.isCurrent
        ? t("provider.inUse", { defaultValue: "使用中" })
        : t("provider.useThisProvider", {
            defaultValue: "使用此供应商",
          });

  return (
    <TableRow
      ref={(node) => {
        setNodeRef(node);
        rowRef(node);
      }}
      style={style}
      className={cn(
        "h-12 scroll-mt-12",
        isDragging && "bg-muted/70",
        row.isActiveProxyProvider && "bg-emerald-500/5",
        isSearchMatch && "bg-sky-500/5",
        isActiveSearchMatch &&
          "ring-1 ring-amber-400/70 ring-inset bg-amber-500/10",
      )}
    >
      <TableCell className="px-2 py-1 whitespace-nowrap">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelectedChange(Boolean(checked))}
          aria-label={t("provider.select", { defaultValue: "选择" })}
        />
      </TableCell>

      <TableCell className="px-2 py-1 whitespace-nowrap">
        <div className="flex items-center justify-center gap-1 font-mono text-sm">
          <button
            type="button"
            className={cn(
              "rounded p-1 text-muted-foreground hover:text-foreground",
              !canDragRows && "opacity-40 cursor-not-allowed",
            )}
            aria-label={
              canDragRows
                ? t("provider.dragToSort", { defaultValue: "拖拽排序" })
                : t("provider.dragDisabledHint", {
                    defaultValue: "请关闭状态排序后再拖拽",
                  })
            }
            title={
              canDragRows
                ? t("provider.dragToSort", { defaultValue: "拖拽排序" })
                : t("provider.dragDisabledHint", {
                    defaultValue: "请关闭状态排序后再拖拽",
                  })
            }
            disabled={!canDragRows}
            {...(canDragRows ? attributes : {})}
            {...(canDragRows ? listeners : {})}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <span>{row.orderNumber}</span>
        </div>
      </TableCell>

      <TableCell className="px-2 py-1 whitespace-nowrap">
        <div className="flex w-full min-w-0 items-center gap-2">
          {showMembershipToggle ? (
            <Switch
              checked={row.isEnabled}
              onCheckedChange={onToggleEnabled}
              className="h-5 w-9 shrink-0"
              title={
                row.isEnabled
                  ? t("provider.disable", { defaultValue: "禁用" })
                  : t("provider.enable", { defaultValue: "启用" })
              }
            />
          ) : (
            <Button
              type="button"
              size="icon"
              variant={row.isCurrent ? "secondary" : "outline"}
              className={cn(
                "h-7 w-7 shrink-0",
                row.isCurrent && "opacity-70 cursor-default",
              )}
              onClick={
                row.isCurrent || row.isProxyModeResolving
                  ? undefined
                  : onActivateProvider
              }
              disabled={row.isCurrent || row.isProxyModeResolving}
              title={activationLabel}
            >
              {row.isCurrent ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <CircleArrowRight className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          <div className="min-w-0 flex-1">
            {canOpenNameLink && row.nameLink ? (
              <button
                type="button"
                onClick={() => onOpenWebsite(row.nameLink!)}
                className="block w-full truncate text-left text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                title={row.nameLink}
              >
                {row.provider.name}
              </button>
            ) : (
              <div
                className="w-full truncate text-sm font-medium"
                title={row.provider.name}
              >
                {row.provider.name}
              </div>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell className="px-2 py-1 whitespace-nowrap">
        <div
          className="w-full truncate text-sm"
          title={row.provider.notes || ""}
        >
          {row.provider.notes || "-"}
        </div>
      </TableCell>

      <TableCell className="px-2 py-1">
        <div
          className="w-full truncate font-mono text-[12px]"
          title={row.modelDisplay}
        >
          {row.modelDisplay}
        </div>
      </TableCell>

      <TableCell className="px-2 py-1 text-center whitespace-nowrap">
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="inline-flex max-w-full items-center justify-center gap-0.5 whitespace-nowrap"
                title={
                  hasStatusTooltip ? healthDetailLines.join("\n") : undefined
                }
              >
                <Badge
                  variant={row.isEnabled ? "default" : "secondary"}
                  className={cn(
                    "h-5 px-1.5 text-xs",
                    row.isActiveProxyProvider &&
                      "bg-emerald-600 hover:bg-emerald-600",
                    row.isEnabled &&
                      !row.isActiveProxyProvider &&
                      "bg-sky-600 hover:bg-sky-600",
                  )}
                >
                  {statusLabel}
                </Badge>
                {isProcessing ? (
                  <Badge
                    variant="outline"
                    className="h-5 border-emerald-500/40 px-1.5 text-xs text-emerald-700 dark:text-emerald-300"
                  >
                    {t("provider.liveRequests", {
                      defaultValue: "请求中",
                    })}
                    {row.activeRequestCount > 1
                      ? ` ${row.activeRequestCount}`
                      : ""}
                  </Badge>
                ) : null}
                {isAdmissionRetrying ? (
                  <Badge className="h-5 border border-amber-500/40 bg-amber-500/10 px-1.5 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-300">
                    <DoorOpen className="mr-0.5 h-3 w-3" />
                    {t("provider.admissionRetrying", {
                      defaultValue: "入场",
                    })}
                    {` ${row.admissionRetryCount}`}
                  </Badge>
                ) : isAdmissionAdmitted ? (
                  <Badge className="h-5 border border-emerald-500/40 bg-emerald-500/10 px-1.5 text-xs text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300">
                    <DoorOpen className="mr-0.5 h-3 w-3" />
                    {t("provider.admissionRetryAdmitted", {
                      defaultValue: "入场成功",
                    })}
                  </Badge>
                ) : null}
                {isCircuitOpen ? (
                  <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                    {t("provider.circuitOpen", { defaultValue: "熔断" })}
                  </Badge>
                ) : isCircuitHalfOpen ? (
                  <Badge className="h-5 border border-amber-500/40 bg-amber-500/10 px-1.5 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-300">
                    {t("provider.circuitHalfOpen", { defaultValue: "半开" })}
                  </Badge>
                ) : isDegraded ? (
                  <Badge className="h-5 border border-yellow-500/40 bg-yellow-500/10 px-1.5 text-xs text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-300">
                    {t("provider.degraded", { defaultValue: "降级" })}
                    {failureCount > 0 ? ` ${failureCount}` : ""}
                  </Badge>
                ) : hasPersistedError ? (
                  <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                    {t("provider.lastErrorBadge", { defaultValue: "异常" })}
                  </Badge>
                ) : null}
              </div>
            </TooltipTrigger>
            {hasStatusTooltip ? (
              <TooltipContent
                side="top"
                className="max-w-[26rem] whitespace-pre-line text-left leading-relaxed"
              >
                {healthDetailLines.join("\n")}
              </TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
      </TableCell>

      <TableCell className="px-2 py-1 whitespace-nowrap">
        <div className="flex w-full items-center justify-center gap-0.5">
          {canSetDefault && onSetAsDefault && (
            <Button
              size="icon"
              variant={isDefaultModel ? "secondary" : "outline"}
              className={cn(
                "h-7 w-7",
                isDefaultModel && "opacity-70 cursor-not-allowed",
              )}
              onClick={isDefaultModel ? undefined : onSetAsDefault}
              disabled={isDefaultModel}
              title={
                isDefaultModel
                  ? t("provider.isDefault", { defaultValue: "当前默认" })
                  : t("provider.setAsDefault", { defaultValue: "设为默认" })
              }
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
          )}

          <Button
            size="icon"
            variant={row.admissionRetryEnabled ? "secondary" : "ghost"}
            className="h-7 w-7"
            onClick={onToggleAdmissionRetry}
            aria-label={
              row.admissionRetryEnabled
                ? t("provider.disableAdmissionRetry", {
                    defaultValue: "关闭上游入场重试",
                  })
                : t("provider.enableAdmissionRetry", {
                    defaultValue: "开启上游入场重试",
                  })
            }
            title={
              row.admissionRetryEnabled
                ? t("provider.disableAdmissionRetryHint", {
                    defaultValue:
                      "关闭后恢复原来的失败处理、故障转移和熔断逻辑",
                  })
                : t("provider.enableAdmissionRetryHint", {
                    defaultValue:
                      "开启后拥挤类上游错误会持续重试同一供应商，不触发降级和熔断",
                  })
            }
            disabled={row.isReadOnly || isAdmissionRetryUpdating}
          >
            {isAdmissionRetryUpdating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <DoorOpen
                className={cn(
                  "h-3.5 w-3.5",
                  row.admissionRetryEnabled &&
                    "text-amber-600 dark:text-amber-300",
                )}
              />
            )}
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onEdit}
            aria-label={t("common.edit", { defaultValue: "编辑" })}
            title={t("common.edit", { defaultValue: "编辑" })}
            disabled={row.isReadOnly}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onPinToTop}
            aria-label={t("provider.pinToTop", {
              defaultValue: "置顶（顺序 1）",
            })}
            title={t("provider.pinToTop", { defaultValue: "置顶（顺序 1）" })}
          >
            <ArrowUpToLine className="h-3.5 w-3.5" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onDuplicate}
            aria-label={t("provider.duplicate", { defaultValue: "复制" })}
            title={t("provider.duplicate", { defaultValue: "复制" })}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onTest}
            aria-label={t("modelTest.testProvider", { defaultValue: "测试" })}
            title={t("modelTest.testProvider", { defaultValue: "测试" })}
            disabled={!onTest || isTesting}
          >
            {isTesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TestTube2 className="h-3.5 w-3.5" />
            )}
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onDelete}
            aria-label={t("common.delete", { defaultValue: "删除" })}
            title={t("common.delete", { defaultValue: "删除" })}
            disabled={!onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>

          {onConfigureUsage && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onConfigureUsage}
              aria-label={t("provider.configureUsage", {
                defaultValue: "用量配置",
              })}
              title={t("provider.configureUsage", {
                defaultValue: "用量配置",
              })}
            >
              <BarChart2 className="h-3.5 w-3.5" />
            </Button>
          )}

          {onOpenTerminal && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onOpenTerminal}
              aria-label={t("provider.openTerminal", {
                defaultValue: "打开终端",
              })}
              title={t("provider.openTerminal", { defaultValue: "打开终端" })}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
