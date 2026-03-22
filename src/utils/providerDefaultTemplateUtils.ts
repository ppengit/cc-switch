import type { AppId } from "@/lib/api";
import { validateToml } from "@/utils/tomlUtils";

type SupportedTemplateApp = Extract<AppId, "claude" | "codex" | "gemini">;

const ALLOWED_PROVIDER_TEMPLATE_PLACEHOLDERS: Record<
  SupportedTemplateApp,
  string[]
> = {
  claude: [
    "api_key",
    "base_url",
    "model",
    "reasoning_model",
    "haiku_model",
    "sonnet_model",
    "opus_model",
  ],
  codex: ["base_url", "model", "reasoning_effort"],
  gemini: ["api_key", "base_url", "model"],
};

const FALLBACK_PROVIDER_DEFAULT_TEMPLATES: Record<
  SupportedTemplateApp,
  string
> = {
  claude: `{
  "env": {
    "ANTHROPIC_BASE_URL": "{{base_url}}",
    "ANTHROPIC_AUTH_TOKEN": "{{api_key}}",
    "ANTHROPIC_MODEL": "{{model}}",
    "ANTHROPIC_REASONING_MODEL": "{{reasoning_model}}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "{{haiku_model}}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "{{sonnet_model}}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "{{opus_model}}"
  }
}`,
  codex: `model_provider = "custom"
model = "{{model}}"
model_reasoning_effort = "{{reasoning_effort}}"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "{{base_url}}"
`,
  gemini: `{
  "env": {
    "GOOGLE_GEMINI_BASE_URL": "{{base_url}}",
    "GEMINI_API_KEY": "{{api_key}}",
    "GEMINI_MODEL": "{{model}}"
  },
  "config": {}
}`,
};

const FALLBACK_PROVIDER_DEFAULT_VALUES: Record<
  SupportedTemplateApp,
  Record<string, string>
> = {
  claude: {
    api_key: "",
    base_url: "",
    model: "claude-sonnet-4-6",
    reasoning_model: "claude-sonnet-4-6",
    haiku_model: "claude-haiku-4-5-20251001",
    sonnet_model: "claude-sonnet-4-6",
    opus_model: "claude-opus-4-6",
  },
  codex: {
    base_url: "",
    model: "gpt-5.4",
    reasoning_effort: "xhigh",
  },
  gemini: {
    api_key: "",
    base_url: "",
    model: "gemini-3.1-pro-preview",
  },
};

export function isSupportedProviderTemplateApp(
  appId: AppId,
): appId is SupportedTemplateApp {
  return appId === "claude" || appId === "codex" || appId === "gemini";
}

export function getFallbackProviderDefaultTemplate(
  appId: SupportedTemplateApp,
): string {
  return FALLBACK_PROVIDER_DEFAULT_TEMPLATES[appId];
}

export function getAllowedProviderTemplatePlaceholders(
  appId: SupportedTemplateApp,
): string[] {
  return [...ALLOWED_PROVIDER_TEMPLATE_PLACEHOLDERS[appId]];
}

export function validateProviderDefaultTemplate(
  appId: SupportedTemplateApp,
  template: string,
): string {
  const trimmed = template.trim();
  if (!trimmed) {
    return "";
  }

  const allowed = new Set(ALLOWED_PROVIDER_TEMPLATE_PLACEHOLDERS[appId]);
  const matches = trimmed.matchAll(/\{\{([^{}]+)\}\}/g);
  for (const match of matches) {
    const placeholder = (match[1] || "").trim();
    if (!allowed.has(placeholder)) {
      return `默认供应商模板包含不支持的占位符: {{${placeholder}}}`;
    }
  }

  const renderedForValidation = Object.entries(
    FALLBACK_PROVIDER_DEFAULT_VALUES[appId],
  ).reduce((acc, [key, value]) => {
    return acc.split(`{{${key}}}`).join(value ?? "");
  }, trimmed);

  if (appId === "codex") {
    const tomlError = validateToml(renderedForValidation);
    if (tomlError) {
      return `默认供应商模板必须是合法的 TOML: ${tomlError}`;
    }
  } else {
    try {
      JSON.parse(renderedForValidation);
    } catch {
      return "默认供应商模板必须是合法 JSON";
    }
  }

  return "";
}

export function renderProviderDefaultTemplate(
  appId: SupportedTemplateApp,
  template?: string | null,
  overrides?: Record<string, string>,
): string {
  const templateSource =
    template && template.trim()
      ? template
      : FALLBACK_PROVIDER_DEFAULT_TEMPLATES[appId];
  const values = {
    ...FALLBACK_PROVIDER_DEFAULT_VALUES[appId],
    ...(overrides ?? {}),
  };

  const rendered = Object.entries(values).reduce((acc, [key, value]) => {
    return acc.split(`{{${key}}}`).join(value ?? "");
  }, templateSource);

  if (appId === "codex") {
    return rendered;
  }

  try {
    const parsed = JSON.parse(rendered);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return rendered;
  }
}
