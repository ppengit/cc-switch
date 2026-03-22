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
    expect(rendered).toContain('base_url = "https://sub.jlypx.de"');
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
