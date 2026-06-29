import { describe, expect, it } from "vitest";
import {
  normalizeCodexCatalogModelsForSave,
  normalizeCodexModelRoutesForSave,
} from "@/components/providers/forms/ProviderForm";

describe("ProviderForm Codex catalog helpers", () => {
  it("normalizes catalog rows and removes empty or duplicate models", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        { model: " deepseek-v4-flash ", displayName: " DeepSeek " },
        { model: "deepseek-v4-flash", displayName: "Duplicate" },
        { model: "", displayName: "Empty" },
        { model: "kimi-k2", contextWindow: "128000 tokens" },
      ]),
    ).toEqual([
      { model: "deepseek-v4-flash", displayName: "DeepSeek" },
      { model: "kimi-k2", contextWindow: 128000 },
    ]);
  });

  it("normalizes Codex request model routes and removes incomplete rows", () => {
    expect(
      normalizeCodexModelRoutesForSave({
        " gpt-5.4-mini ": { model: " gpt-5.5 " },
        "": { model: "ignored" },
        "empty-upstream": { model: "" },
      }),
    ).toEqual({
      "gpt-5.4-mini": { model: "gpt-5.5" },
    });
  });
});
