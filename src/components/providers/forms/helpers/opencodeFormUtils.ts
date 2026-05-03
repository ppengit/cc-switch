import type { OpenCodeModel, OpenCodeProviderConfig } from "@/types";
import type { PricingModelSourceOption } from "../ProviderAdvancedConfig";

// ── Default configs ──────────────────────────────────────────────────

export const CLAUDE_DEFAULT_CONFIG = JSON.stringify(
  {
    env: {
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  },
  null,
  2,
);
export const CODEX_DEFAULT_CONFIG = JSON.stringify(
  {
    auth: { OPENAI_API_KEY: "" },
    config: `model_provider = "custom"
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[model_providers.custom]
name = "custom"
base_url = ""
wire_api = "responses"
requires_openai_auth = true`,
  },
  null,
  2,
);
export const GEMINI_DEFAULT_CONFIG = JSON.stringify(
  {
    env: {
      GOOGLE_GEMINI_BASE_URL: "",
      GEMINI_API_KEY: "",
      GEMINI_MODEL: "gemini-3.1-pro-preview",
    },
    config: {
      model: {
        name: "gemini-3.1-pro-preview",
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
);

export const OPENCODE_DEFAULT_NPM = "@ai-sdk/openai-compatible";
export const OPENCODE_DEFAULT_CONFIG = JSON.stringify(
  {
    npm: OPENCODE_DEFAULT_NPM,
    options: {
      baseURL: "",
      apiKey: "",
      setCacheKey: true,
    },
    models: {
      "gpt-5.5": { name: "GPT-5.5" },
      "gpt-5.4-mini": { name: "GPT-5.4 Mini" },
    },
  },
  null,
  2,
);
export const OPENCODE_KNOWN_OPTION_KEYS = [
  "baseURL",
  "apiKey",
  "headers",
] as const;

export const OPENCLAW_DEFAULT_CONFIG = JSON.stringify(
  {
    baseUrl: "",
    apiKey: "",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
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
);

// ── Pure functions ───────────────────────────────────────────────────

export function isKnownOpencodeOptionKey(key: string): boolean {
  return OPENCODE_KNOWN_OPTION_KEYS.includes(
    key as (typeof OPENCODE_KNOWN_OPTION_KEYS)[number],
  );
}

export function parseOpencodeConfig(
  settingsConfig?: Record<string, unknown>,
): OpenCodeProviderConfig {
  const normalize = (
    parsed: Partial<OpenCodeProviderConfig>,
  ): OpenCodeProviderConfig => ({
    npm: parsed.npm || OPENCODE_DEFAULT_NPM,
    options:
      parsed.options && typeof parsed.options === "object"
        ? (parsed.options as OpenCodeProviderConfig["options"])
        : {},
    models:
      parsed.models && typeof parsed.models === "object"
        ? (parsed.models as Record<string, OpenCodeModel>)
        : {},
  });

  try {
    const parsed = JSON.parse(
      settingsConfig ? JSON.stringify(settingsConfig) : OPENCODE_DEFAULT_CONFIG,
    ) as Partial<OpenCodeProviderConfig>;
    return normalize(parsed);
  } catch {
    return {
      npm: OPENCODE_DEFAULT_NPM,
      options: {},
      models: {},
    };
  }
}

export function parseOpencodeConfigStrict(
  settingsConfig?: Record<string, unknown>,
): OpenCodeProviderConfig {
  const parsed = JSON.parse(
    settingsConfig ? JSON.stringify(settingsConfig) : OPENCODE_DEFAULT_CONFIG,
  ) as Partial<OpenCodeProviderConfig>;
  return {
    npm: parsed.npm || OPENCODE_DEFAULT_NPM,
    options:
      parsed.options && typeof parsed.options === "object"
        ? (parsed.options as OpenCodeProviderConfig["options"])
        : {},
    models:
      parsed.models && typeof parsed.models === "object"
        ? (parsed.models as Record<string, OpenCodeModel>)
        : {},
  };
}

export const OPENCODE_KNOWN_MODEL_KEYS = ["name", "limit", "options"] as const;

export function isKnownModelKey(key: string): boolean {
  return OPENCODE_KNOWN_MODEL_KEYS.includes(
    key as (typeof OPENCODE_KNOWN_MODEL_KEYS)[number],
  );
}

export function getModelExtraFields(
  model: OpenCodeModel,
): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(model)) {
    if (!isKnownModelKey(k)) {
      extra[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return extra;
}

export function toOpencodeExtraOptions(
  options: OpenCodeProviderConfig["options"],
): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(options || {})) {
    if (!isKnownOpencodeOptionKey(k)) {
      extra[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return extra;
}

export { buildOmoProfilePreview } from "@/types/omo";

export const normalizePricingSource = (
  value?: string,
): PricingModelSourceOption =>
  value === "request" || value === "response" ? value : "inherit";
