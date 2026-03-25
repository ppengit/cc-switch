import { describe, expect, it } from "vitest";
import {
  getDefaultJsonCommonConfigTemplate,
  normalizeCodexCommonConfigSnippetForEditing,
  normalizeJsonCommonConfigTemplateForEditing,
  hasTomlCommonConfigSnippet,
  parseJsonCommonConfigTemplate,
  updateTomlCommonConfigSnippet,
  validateCodexCommonConfigSnippet,
  validateJsonCommonConfigTemplate,
} from "@/utils/providerConfigUtils";

describe("providerConfigUtils codex common config", () => {
  it("does not treat nested matching values as a common config block", () => {
    const configText = `[mcp_servers.echo]
base_url = "https://example.com"
`;
    const snippet = `base_url = "https://example.com"`;

    expect(hasTomlCommonConfigSnippet(configText, snippet)).toBe(false);
  });

  it("accepts codex templates with provider placeholder and keeps nested MCP values", () => {
    const configText = `[mcp_servers.echo]
base_url = "https://example.com"
`;
    const snippet = `{{provider.config}}

[tool]
base_url = "https://example.com"`;

    const result = updateTomlCommonConfigSnippet(configText, snippet, true);

    expect(result.error).toBeUndefined();
    expect(result.updatedConfig).toContain("{{provider.config}}");
    expect(result.updatedConfig).toContain("[tool]");
    expect(result.updatedConfig).toContain("[mcp_servers.echo]");
  });

  it("removes the managed common config block even if the current snippet is empty", () => {
    const configText = `# cc-switch common config start
sandbox_mode = "workspace-write"
# cc-switch common config end

model = "gpt-4.1"
`;

    const result = updateTomlCommonConfigSnippet(configText, "", false);

    expect(result.error).toBeUndefined();
    expect(result.updatedConfig).not.toContain(
      "# cc-switch common config start",
    );
    expect(result.updatedConfig).toContain(`model = "gpt-4.1"`);
  });

  it("rejects MCP sections inside codex common config snippets", () => {
    const snippet = `{{provider.config}}

[mcp_servers.echo]
type = "stdio"
command = "echo"
`;

    expect(validateCodexCommonConfigSnippet(snippet)).toContain("mcp_servers");
  });

  it("migrates legacy codex snippets to include provider and mcp placeholders for editing", () => {
    const snippet = `approval_policy = "never"
sandbox_mode = "danger-full-access"`;

    const normalized = normalizeCodexCommonConfigSnippetForEditing(snippet);

    expect(normalized).toContain('approval_policy = "never"');
    expect(normalized).toContain("{{provider.config}}");
    expect(normalized).toContain("{{mcp.config}}");
    expect(validateCodexCommonConfigSnippet(normalized)).toBe("");
  });
});

describe("providerConfigUtils json common config templates", () => {
  it("provides a Claude default template with provider and mcp placeholders", () => {
    const template = getDefaultJsonCommonConfigTemplate("claude");

    expect(template).toContain('"{{provider.config}}"');
    expect(template).toContain('"mcpServers": "{{mcp.config}}"');
    expect(validateJsonCommonConfigTemplate("claude", template)).toBe("");
  });

  it("migrates legacy Claude snippets to a template with provider placeholder", () => {
    const normalized = normalizeJsonCommonConfigTemplateForEditing(
      "claude",
      `{
  "includeCoAuthoredBy": false
}`,
    );

    expect(normalized).toContain('"{{provider.config}}"');
    expect(normalized).toContain('"includeCoAuthoredBy": false');
    expect(normalized).toContain('"mcpServers": "{{mcp.config}}"');
    expect(validateJsonCommonConfigTemplate("claude", normalized)).toBe("");
  });

  it("parses Gemini templates and strips placeholders from common content", () => {
    const parsed = parseJsonCommonConfigTemplate(
      "gemini",
      `{
  "{{provider.config}}": {},
  "env": {
    "GEMINI_MODEL": "gemini-3.1-pro-preview"
  },
  "mcpServers": "{{mcp.config}}"
}`,
    );

    expect("error" in parsed).toBe(false);
    if ("error" in parsed) {
      return;
    }

    expect(parsed.result.hasMcpPlaceholder).toBe(true);
    expect(parsed.result.commonConfig).toEqual({
      env: {
        GEMINI_MODEL: "gemini-3.1-pro-preview",
      },
    });
  });

  it("rejects Gemini templates without provider placeholder", () => {
    expect(
      validateJsonCommonConfigTemplate(
        "gemini",
        `{
  "env": {
    "GEMINI_MODEL": "gemini-3.1-pro-preview"
  }
}`,
      ),
    ).toContain("{{provider.config}}");
  });
});
