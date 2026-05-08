import { describe, expect, it } from "vitest";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  isKnownFullApiEndpoint,
  setCodexBaseUrl,
  setCodexModelName,
} from "@/utils/providerConfigUtils";

describe("Codex TOML utils", () => {
  it("removes base_url line when set to empty", () => {
    const input = [
      'model_provider = "openai"',
      'base_url = "https://api.example.com/v1"',
      'model = "gpt-5-codex"',
      "",
    ].join("\n");

    const output = setCodexBaseUrl(input, "");

    expect(output).not.toMatch(/^\s*base_url\s*=/m);
    expect(extractCodexBaseUrl(output)).toBeUndefined();
    expect(extractCodexModelName(output)).toBe("gpt-5-codex");
  });

  it("removes only the top-level model line when set to empty", () => {
    const input = [
      'model_provider = "openai"',
      'base_url = "https://api.example.com/v1"',
      'model = "gpt-5-codex"',
      "",
      "[profiles.default]",
      'model = "profile-model"',
      "",
    ].join("\n");

    const output = setCodexModelName(input, "");

    expect(output).not.toMatch(/^model\s*=\s*"gpt-5-codex"$/m);
    expect(output).toMatch(/^\[profiles\.default\]\nmodel = "profile-model"$/m);
    expect(extractCodexModelName(output)).toBeUndefined();
    expect(extractCodexBaseUrl(output)).toBe("https://api.example.com/v1");
  });

  it("updates existing values when non-empty", () => {
    const input = [
      'model_provider = "openai"',
      "base_url = 'https://old.example/v1'",
      'model = "old-model"',
      "",
    ].join("\n");

    const output1 = setCodexBaseUrl(input, " https://new.example/v1 \n");
    expect(extractCodexBaseUrl(output1)).toBe("https://new.example/v1");

    const output2 = setCodexModelName(output1, " new-model \n");
    expect(extractCodexModelName(output2)).toBe("new-model");
  });

  it("replaces an empty base_url placeholder instead of appending a duplicate line", () => {
    const input = [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      'model_reasoning_effort = "xhigh"',
      'disable_response_storage = true',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'base_url = ""',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      "",
    ].join("\n");

    const output = setCodexBaseUrl(input, "https://api.example.com/v1");

    expect(output).toContain('base_url = "https://api.example.com/v1"');
    expect(output).not.toContain('base_url = ""');
    expect(output.match(/base_url\s*=/g)).toHaveLength(1);
  });

  it("replaces an empty top-level model placeholder instead of appending a duplicate line", () => {
    const input = [
      'model_provider = "custom"',
      'model = ""',
      'model_reasoning_effort = "xhigh"',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'base_url = "https://api.example.com/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");

    const output = setCodexModelName(input, "gpt-5.5");

    expect(output).toContain('model = "gpt-5.5"');
    expect(output).not.toContain('model = ""');
    expect(output.match(/^model\s*=/gm)).toHaveLength(1);
  });

  it("preserves a full chat completions endpoint in base_url", () => {
    const input = [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'base_url = "https://old.example/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");

    const fullEndpoint =
      "https://api.xn--chy-js0fk50c.top/v1/chat/completions";
    const output = setCodexBaseUrl(input, fullEndpoint);

    expect(extractCodexBaseUrl(output)).toBe(fullEndpoint);
    expect(output).toContain(`base_url = "${fullEndpoint}"`);
  });

  it("recognizes known full API endpoints without treating /v1 bases as full URLs", () => {
    expect(
      isKnownFullApiEndpoint(
        "https://api.xn--chy-js0fk50c.top/v1/chat/completions",
      ),
    ).toBe(true);
    expect(
      isKnownFullApiEndpoint("https://relay.example/v1/responses"),
    ).toBe(true);
    expect(isKnownFullApiEndpoint("https://relay.example/v1")).toBe(false);
    expect(isKnownFullApiEndpoint("https://relay.example/api")).toBe(false);
  });

  it("reads and writes base_url in the active provider section", () => {
    const input = [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'wire_api = "responses"',
      "",
      "[profiles.default]",
      'approval_policy = "never"',
      "",
    ].join("\n");

    const output = setCodexBaseUrl(input, "https://api.example.com/v1");

    expect(output).toContain(
      '[model_providers.custom]\nname = "custom"\nwire_api = "responses"\nbase_url = "https://api.example.com/v1"',
    );
    expect(extractCodexBaseUrl(output)).toBe("https://api.example.com/v1");
  });

  it("recovers a single misplaced base_url from another section", () => {
    const input = [
      'model_provider = "custom"',
      'model = "gpt-5.4"',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'wire_api = "responses"',
      "",
      "[profiles.default]",
      'approval_policy = "never"',
      'base_url = "https://wrong.example/v1"',
      "",
    ].join("\n");

    expect(extractCodexBaseUrl(input)).toBe("https://wrong.example/v1");

    const output = setCodexBaseUrl(input, "https://fixed.example/v1");

    expect(output).toContain(
      '[model_providers.custom]\nname = "custom"\nwire_api = "responses"\nbase_url = "https://fixed.example/v1"',
    );
    expect(output).not.toContain("https://wrong.example/v1");
    expect(output.match(/base_url\s*=/g)).toHaveLength(1);
  });

  it("does not treat mcp_servers base_url as provider base_url", () => {
    const input = [
      'model_provider = "azure"',
      'model = "gpt-4"',
      "",
      "[model_providers.azure]",
      'name = "Azure OpenAI"',
      'wire_api = "responses"',
      "",
      "[mcp_servers.my_server]",
      'base_url = "http://localhost:8080"',
      "",
    ].join("\n");

    expect(extractCodexBaseUrl(input)).toBeUndefined();

    const output = setCodexBaseUrl(input, "https://new.azure/v1");

    expect(output).toContain(
      '[model_providers.azure]\nname = "Azure OpenAI"\nwire_api = "responses"\nbase_url = "https://new.azure/v1"',
    );
    expect(output).toContain(
      '[mcp_servers.my_server]\nbase_url = "http://localhost:8080"',
    );
  });

  it("reads model only from the top-level config", () => {
    const input = [
      'model_provider = "custom"',
      "",
      "[profiles.default]",
      'model = "profile-model"',
      "",
    ].join("\n");

    expect(extractCodexModelName(input)).toBeUndefined();
  });

  it("handles single-quoted values", () => {
    const input = "base_url = 'https://api.example.com/v1'\nmodel = 'gpt-5'\n";

    expect(extractCodexBaseUrl(input)).toBe("https://api.example.com/v1");
    expect(extractCodexModelName(input)).toBe("gpt-5");
  });
});
