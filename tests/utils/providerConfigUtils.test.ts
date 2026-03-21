import { describe, expect, it } from "vitest";
import {
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

  it("does not remove matching nested values when enabling common config", () => {
    const configText = `[mcp_servers.echo]
base_url = "https://example.com"
`;
    const snippet = `base_url = "https://example.com"`;

    const result = updateTomlCommonConfigSnippet(configText, snippet, true);

    expect(result.error).toBeUndefined();
    expect(
      result.updatedConfig.match(/base_url = "https:\/\/example\.com"/g),
    ).toHaveLength(2);
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
    const snippet = `[mcp_servers.echo]
type = "stdio"
command = "echo"
`;

    expect(validateCodexCommonConfigSnippet(snippet)).toContain("mcp_servers");
  });
});
