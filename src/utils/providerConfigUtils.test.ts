import { describe, expect, it } from "vitest";
import {
  isCodexRemoteCompactionEnabled,
  setCodexRemoteCompaction,
} from "./providerConfigUtils";

describe("Codex remote compaction config helpers", () => {
  it("enables remote compaction by naming the active custom provider OpenAI", () => {
    const input = `model_provider = "custom"
model = "gpt-5.4"

[model_providers.custom]
name = "AIHubMix"
base_url = "https://aihubmix.example/v1"
wire_api = "responses"

[model_providers.backup]
name = "Backup"
base_url = "https://backup.example/v1"
`;

    const result = setCodexRemoteCompaction(input, true, "AIHubMix");

    expect(isCodexRemoteCompactionEnabled(result)).toBe(true);
    expect(result).toContain(`[model_providers.custom]\nname = "OpenAI"`);
    expect(result).toContain(`[model_providers.backup]\nname = "Backup"`);
  });

  it("disables remote compaction by restoring the provider display name", () => {
    const input = `model_provider = "custom"

[model_providers.custom]
name = "OpenAI"
base_url = "https://aihubmix.example/v1"
wire_api = "responses"
`;

    const result = setCodexRemoteCompaction(input, false, "AIHubMix");

    expect(isCodexRemoteCompactionEnabled(result)).toBe(false);
    expect(result).toContain(`name = "AIHubMix"`);
  });

  it("can disable remote compaction when the provider display name is OpenAI", () => {
    const input = `model_provider = "custom"

[model_providers.custom]
name = "OpenAI"
base_url = "https://relay.example/v1"
wire_api = "responses"
`;

    const result = setCodexRemoteCompaction(input, false, "OpenAI");

    expect(isCodexRemoteCompactionEnabled(result)).toBe(false);
    expect(result).toContain(`name = "OpenAI Compatible"`);
  });

  it("does not rewrite reserved built-in providers", () => {
    const input = `model_provider = "openai"
model = "gpt-5"
`;

    expect(setCodexRemoteCompaction(input, true, "OpenAI")).toBe(input);
    expect(isCodexRemoteCompactionEnabled(input)).toBe(false);
  });

  it("does not confuse custom OpenAI provider id with built-in openai", () => {
    const input = `model_provider = "OpenAI"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://relay.example/v1"
wire_api = "responses"
`;

    expect(isCodexRemoteCompactionEnabled(input)).toBe(true);

    const result = setCodexRemoteCompaction(input, false, "OpenAI Relay");

    expect(isCodexRemoteCompactionEnabled(result)).toBe(false);
    expect(result).toContain(`[model_providers.OpenAI]\nname = "OpenAI Relay"`);
  });

  it("repairs model_provider when toggling a renamed only provider section", () => {
    const input = `model_provider = "custom"

[model_providers.OpenAI]
name = "OpenAI Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
`;

    const result = setCodexRemoteCompaction(input, true, "OpenAI Relay");

    expect(isCodexRemoteCompactionEnabled(result)).toBe(true);
    expect(result).toContain(`model_provider = "OpenAI"`);
    expect(result).toContain(`[model_providers.OpenAI]\nname = "OpenAI"`);
    expect(result).not.toContain("[model_providers.custom]");
  });

  it("reads enabled state from a renamed only provider section", () => {
    const input = `model_provider = "custom"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://relay.example/v1"
wire_api = "responses"
`;

    expect(isCodexRemoteCompactionEnabled(input)).toBe(true);
  });
});
