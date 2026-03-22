import { describe, expect, it } from "vitest";
import {
  extractCatalogModelIds,
  getCatalogProviderIds,
  supportsEndpointModelDiscovery,
  type ModelsDevCatalog,
} from "@/utils/modelDiscoveryUtils";

const mockCatalog: ModelsDevCatalog = {
  anthropic: {
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        modalities: { input: ["text"], output: ["text"] },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
  google: {
    models: {
      "gemini-3.1-pro-preview": {
        id: "gemini-3.1-pro-preview",
        modalities: { input: ["text"], output: ["text"] },
      },
      "gemini-embedding-001": {
        id: "gemini-embedding-001",
        modalities: { input: ["text"], output: ["embedding"] },
      },
    },
  },
  openai: {
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        modalities: { input: ["text"], output: ["text"] },
      },
      "o3-deep-research": {
        id: "o3-deep-research",
        modalities: { input: ["text"], output: ["text"] },
      },
      "text-embedding-3-large": {
        id: "text-embedding-3-large",
        modalities: { input: ["text"], output: ["embedding"] },
      },
    },
  },
};

describe("modelDiscoveryUtils", () => {
  it("returns catalog providers for supported apps", () => {
    expect(getCatalogProviderIds("claude")).toEqual(["anthropic"]);
    expect(getCatalogProviderIds("codex")).toEqual(["openai"]);
    expect(getCatalogProviderIds("gemini")).toEqual(["google"]);
    expect(getCatalogProviderIds("openclaw")).toEqual([]);
  });

  it("marks endpoint discovery support by app and Claude API format", () => {
    expect(
      supportsEndpointModelDiscovery("claude", { apiFormat: "anthropic" }),
    ).toBe(false);
    expect(
      supportsEndpointModelDiscovery("claude", { apiFormat: "openai_chat" }),
    ).toBe(true);
    expect(supportsEndpointModelDiscovery("codex")).toBe(true);
    expect(supportsEndpointModelDiscovery("gemini")).toBe(true);
    expect(supportsEndpointModelDiscovery("openclaw")).toBe(false);
  });

  it("filters catalog models by app-specific prefixes and text modalities", () => {
    expect(extractCatalogModelIds(mockCatalog, "claude")).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]);
    expect(extractCatalogModelIds(mockCatalog, "gemini")).toEqual([
      "gemini-3.1-pro-preview",
    ]);
    expect(extractCatalogModelIds(mockCatalog, "codex")).toEqual([
      "gpt-5.4",
      "o3-deep-research",
    ]);
  });
});
