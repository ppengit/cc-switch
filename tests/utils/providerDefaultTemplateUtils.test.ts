import { describe, expect, it } from "vitest";
import {
  renderProviderDefaultTemplate,
  validateProviderDefaultTemplate,
} from "@/utils/providerDefaultTemplateUtils";

describe("providerDefaultTemplateUtils", () => {
  it("renders codex template placeholders", () => {
    const rendered = renderProviderDefaultTemplate("codex");

    expect(rendered).toContain('model_provider = "custom"');
    expect(rendered).toContain('model = "gpt-5.4"');
    expect(rendered).toContain('model_reasoning_effort = "xhigh"');
    expect(rendered).toContain('base_url = ""');
  });

  it("keeps codex template placeholders in fallback template source", () => {
    const rendered = validateProviderDefaultTemplate(
      "codex",
      `model_provider = "custom"
model = "{{model}}"
model_reasoning_effort = "{{reasoning_effort}}"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "{{base_url}}"`,
    );

    expect(rendered).toBe("");
  });

  it("rejects unsupported placeholders", () => {
    const template = `{
  "env": {
    "ANTHROPIC_BASE_URL": "{{base_url}}",
    "EXTRA": "{{unsupported}}"
  }
}`;

    expect(validateProviderDefaultTemplate("claude", template)).toContain(
      "{{unsupported}}",
    );
  });
});
