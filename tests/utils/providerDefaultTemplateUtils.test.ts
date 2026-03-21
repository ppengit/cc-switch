import { describe, expect, it } from "vitest";
import {
  renderProviderDefaultTemplate,
  validateProviderDefaultTemplate,
} from "@/utils/providerDefaultTemplateUtils";

describe("providerDefaultTemplateUtils", () => {
  it("renders codex template placeholders", () => {
    const rendered = renderProviderDefaultTemplate("codex");
    const parsed = JSON.parse(rendered);

    expect(parsed.auth.OPENAI_API_KEY).toBe("");
    expect(parsed.config).toContain('model = "gpt-5.4"');
    expect(parsed.config).toContain('model_reasoning_effort = "xhigh"');
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
