import type { AppId } from "@/lib/api/types";
import type { ApiHubModelSelection, ApiHubSiteRow } from "@/types/apiHub";
import { generateThirdPartyConfig } from "@/config/codexProviderPresets";

export const API_HUB_API_KEY_PLACEHOLDER = "__API_HUB_API_KEY__";

export function ensureOpenAiV1BaseUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "https://example.com/v1";
  return /\/v1(?:\/)?$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function providerKey(site: ApiHubSiteRow, group: string): string {
  const seed = `${site.site_name}-${group}`;
  return (
    seed
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "api_hub"
  );
}

function withNonEmptyEntry(
  value: Record<string, any>,
  key: string,
  entry: unknown,
): Record<string, any> {
  if (typeof entry === "string" && entry.trim()) {
    value[key] = entry.trim();
  }
  return value;
}

function createCodexConfig(
  site: ApiHubSiteRow,
  group: string,
  openAiBaseUrl: string,
  model: string,
): string {
  const providerName = providerKey(site, group);
  const trimmedModel = model.trim();
  if (trimmedModel) {
    return generateThirdPartyConfig(providerName, openAiBaseUrl, trimmedModel);
  }

  return `model_provider = "${providerName}"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.${providerName}]
name = "${providerName}"
base_url = "${openAiBaseUrl}"
wire_api = "responses"
requires_openai_auth = true`;
}

export function createApiHubSettingsConfig(
  app: AppId,
  site: ApiHubSiteRow,
  group: string,
  model: string,
): Record<string, any> {
  const baseUrl = site.site_url.trim().replace(/\/+$/, "");
  const openAiBaseUrl = ensureOpenAiV1BaseUrl(site.site_url);
  const key = API_HUB_API_KEY_PLACEHOLDER;
  const trimmedModel = model.trim();

  switch (app) {
    case "claude":
      return {
        env: withNonEmptyEntry(
          {
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_AUTH_TOKEN: key,
          },
          "ANTHROPIC_MODEL",
          trimmedModel,
        ),
        ...(trimmedModel ? { model: trimmedModel } : {}),
      };
    case "codex":
      return {
        auth: {
          OPENAI_API_KEY: key,
        },
        config: createCodexConfig(site, group, openAiBaseUrl, trimmedModel),
      };
    case "gemini":
      return {
        env: withNonEmptyEntry(
          {
            GOOGLE_GEMINI_BASE_URL: baseUrl,
            GEMINI_API_KEY: key,
          },
          "GEMINI_MODEL",
          trimmedModel,
        ),
        config: trimmedModel
          ? {
              model: {
                name: trimmedModel,
              },
              security: {
                auth: {
                  selectedType: "gemini-api-key",
                },
              },
            }
          : {
              security: {
                auth: {
                  selectedType: "gemini-api-key",
                },
              },
            },
      };
    case "opencode":
      return {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: openAiBaseUrl,
          apiKey: key,
          setCacheKey: true,
        },
        models: trimmedModel
          ? {
              [trimmedModel]: {
                name: trimmedModel,
              },
            }
          : {},
      };
    case "openclaw":
      return {
        baseUrl: openAiBaseUrl,
        apiKey: key,
        api: "openai-responses",
        models: trimmedModel
          ? [
              {
                id: trimmedModel,
                name: trimmedModel,
                reasoning: true,
                input: ["text"],
              },
            ]
          : [],
      };
    case "hermes":
      return {
        name: providerKey(site, group),
        base_url: openAiBaseUrl,
        api_key: key,
        api_mode: "codex_responses",
        models: trimmedModel
          ? [
              {
                id: trimmedModel,
                name: trimmedModel,
              },
            ]
          : [],
      };
    default:
      return {};
  }
}

export function buildApiHubSettingsConfigs(
  site: ApiHubSiteRow,
  apps: AppId[],
  selections: ApiHubModelSelection[],
): Record<string, Record<string, unknown>> {
  const configs: Record<string, Record<string, unknown>> = {};
  const targetApps = new Set(apps);
  for (const app of apps) {
    for (const selection of selections) {
      if (selection.app && selection.app !== app) continue;
      configs[`${app}::${selection.group}::${selection.model}`] =
        createApiHubSettingsConfig(app, site, selection.group, selection.model);
    }
  }
  for (const selection of selections) {
    if (!selection.app || targetApps.has(selection.app)) continue;
    configs[`${selection.app}::${selection.group}::${selection.model}`] =
      createApiHubSettingsConfig(
        selection.app,
        site,
        selection.group,
        selection.model,
      );
  }
  return configs;
}
