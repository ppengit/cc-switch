import { describe, expect, it } from "vitest";
import { universalProviderPresets } from "@/config/universalProviderPresets";

describe("universal provider presets", () => {
  it("use app-specific default models", () => {
    const newapi = universalProviderPresets.find(
      (preset) => preset.providerType === "newapi",
    );

    expect(newapi?.defaultModels.claude?.model).toBe("claude-sonnet-4-6");
    expect(newapi?.defaultModels.claude?.haikuModel).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(newapi?.defaultModels.claude?.sonnetModel).toBe("claude-sonnet-4-6");
    expect(newapi?.defaultModels.claude?.opusModel).toBe("claude-opus-4-7");
    expect(newapi?.defaultModels.codex?.model).toBe("gpt-5.5");
    expect(newapi?.defaultModels.gemini?.model).toBe("gemini-3.1-pro-preview");
  });
});
