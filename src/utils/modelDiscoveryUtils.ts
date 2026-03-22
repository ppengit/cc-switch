import type { AppId } from "@/lib/api";
import type { ClaudeApiFormat } from "@/types";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";

type CatalogProviderId = "anthropic" | "google" | "openai";

interface ModelsDevModelModalities {
  input?: string[];
  output?: string[];
}

interface ModelsDevModelEntry {
  id?: string;
  family?: string;
  modalities?: ModelsDevModelModalities;
}

interface ModelsDevProviderEntry {
  models?: Record<string, ModelsDevModelEntry>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProviderEntry>;

interface CatalogOptions {
  apiFormat?: ClaudeApiFormat;
}

function hasTextRoundtripModalities(entry?: ModelsDevModelEntry): boolean {
  if (!entry?.modalities) {
    return true;
  }

  const input = entry.modalities.input ?? [];
  const output = entry.modalities.output ?? [];

  return input.includes("text") && output.includes("text");
}

function isRelevantCatalogModel(appId: AppId, modelId: string): boolean {
  switch (appId) {
    case "claude":
      return /^claude-/i.test(modelId);
    case "codex":
      return /^(gpt|o\d|codex|chatgpt)/i.test(modelId);
    case "gemini":
      return /^gemini/i.test(modelId);
    default:
      return false;
  }
}

export function getCatalogProviderIds(
  appId: AppId,
  _options: CatalogOptions = {},
): CatalogProviderId[] {
  switch (appId) {
    case "claude":
      return ["anthropic"];
    case "codex":
      return ["openai"];
    case "gemini":
      return ["google"];
    default:
      return [];
  }
}

export function supportsEndpointModelDiscovery(
  appId: AppId,
  options: CatalogOptions = {},
): boolean {
  switch (appId) {
    case "claude":
      return (
        options.apiFormat === "openai_chat" ||
        options.apiFormat === "openai_responses"
      );
    case "codex":
    case "gemini":
    case "opencode":
      return true;
    default:
      return false;
  }
}

export function extractCatalogModelIds(
  catalog: ModelsDevCatalog,
  appId: AppId,
  options: CatalogOptions = {},
): string[] {
  const providerIds = getCatalogProviderIds(appId, options);
  if (providerIds.length === 0) {
    return [];
  }

  const modelIds = new Set<string>();

  for (const providerId of providerIds) {
    const provider = catalog[providerId];
    if (!provider?.models) {
      continue;
    }

    for (const [fallbackId, entry] of Object.entries(provider.models)) {
      const modelId = (entry?.id || fallbackId).trim();
      if (!modelId) {
        continue;
      }

      if (!hasTextRoundtripModalities(entry)) {
        continue;
      }

      if (!isRelevantCatalogModel(appId, modelId)) {
        continue;
      }

      modelIds.add(modelId);
    }
  }

  return Array.from(modelIds).sort((a, b) => a.localeCompare(b, "en-US"));
}

export async function fetchCatalogModelIds(
  appId: AppId,
  options: CatalogOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const providerIds = getCatalogProviderIds(appId, options);
  if (providerIds.length === 0) {
    throw new Error("当前应用暂不支持从模型目录自动加载模型");
  }

  const response = await fetchImpl(MODELS_DEV_API_URL, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`模型目录请求失败（HTTP ${response.status}）`);
  }

  const catalog = (await response.json()) as ModelsDevCatalog;
  const modelIds = extractCatalogModelIds(catalog, appId, options);
  if (modelIds.length === 0) {
    throw new Error("模型目录中没有找到可用模型");
  }

  return modelIds;
}
