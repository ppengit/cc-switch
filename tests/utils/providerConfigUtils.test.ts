import { describe, expect, it } from "vitest";
import {
  normalizeCodexCommonConfigSnippetForEditing,
  hasTomlCommonConfigSnippet,
  updateTomlCommonConfigSnippet,
  validateCodexCommonConfigSnippet,
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
    expect(result.updatedConfig).not.toContain("# cc-switch common config start");
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

    expect(normalized).toContain("approval_policy = \"never\"");
    expect(normalized).toContain("{{provider.config}}");
    expect(normalized).toContain("{{mcp.config}}");
    expect(validateCodexCommonConfigSnippet(normalized)).toBe("");
  });
});
