import type { AppId } from "@/lib/api";

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
  codex: ["api_key", "base_url", "model", "reasoning_effort"],
  gemini: ["api_key", "base_url", "model"],
};

const FALLBACK_PROVIDER_DEFAULT_TEMPLATES: Record<SupportedTemplateApp, string> =
  {
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
    codex: `{
  "auth": {
    "OPENAI_API_KEY": "{{api_key}}"
  },
  "config": "model_provider = \\"custom\\"\\nmodel = \\"{{model}}\\"\\nmodel_reasoning_effort = \\"{{reasoning_effort}}\\"\\ndisable_response_storage = true\\n\\n[model_providers.custom]\\nname = \\"custom\\"\\nwire_api = \\"responses\\"\\nrequires_openai_auth = true\\nbase_url = \\"{{base_url}}\\"\\n"
}`,
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
    model: "claude-sonnet-4-20250514",
    reasoning_model: "claude-sonnet-4-20250514",
    haiku_model: "claude-haiku-4-20250514",
    sonnet_model: "claude-sonnet-4-20250514",
    opus_model: "claude-sonnet-4-20250514",
  },
  codex: {
    api_key: "",
    base_url: "",
    model: "gpt-5.4",
    reasoning_effort: "xhigh",
  },
  gemini: {
    api_key: "",
    base_url: "",
    model: "gemini-3-pro-preview",
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

  try {
    JSON.parse(trimmed);
  } catch {
    return "默认 Provider 模板必须是合法 JSON";
  }

  const allowed = new Set(ALLOWED_PROVIDER_TEMPLATE_PLACEHOLDERS[appId]);
  const matches = trimmed.matchAll(/\{\{([^{}]+)\}\}/g);
  for (const match of matches) {
    const placeholder = (match[1] || "").trim();
    if (!allowed.has(placeholder)) {
      return `默认 Provider 模板包含不支持的占位符: {{${placeholder}}}`;
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

  try {
    const parsed = JSON.parse(rendered);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return rendered;
  }
}
