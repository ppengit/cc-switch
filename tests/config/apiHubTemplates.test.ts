import { describe, expect, it } from "vitest";
import {
  API_HUB_API_KEY_PLACEHOLDER,
  buildApiHubSettingsConfigs,
  createApiHubSettingsConfig,
  ensureOpenAiV1BaseUrl,
} from "@/config/apiHubTemplates";
import type { ApiHubSiteRow, ApiHubModelSelection } from "@/types/apiHub";

const site: ApiHubSiteRow = {
  id: "site-001",
  site_name: "Demo Hub",
  site_url: "https://hub.example.com/api",
  site_type: "new-api",
  exchange_rate: 1,
  username: "demo",
  last_synced_at: null,
  last_sync_error: null,
  sort_index: 0,
  group_count: 2,
  model_count: 3,
  token_count: 2,
  imported_apps: [],
};

describe("apiHubTemplates", () => {
  it("normalizes OpenAI compatible base URLs without duplicating /v1", () => {
    expect(ensureOpenAiV1BaseUrl("https://hub.example.com")).toBe(
      "https://hub.example.com/v1",
    );
    expect(ensureOpenAiV1BaseUrl("https://hub.example.com/api/")).toBe(
      "https://hub.example.com/api/v1",
    );
    expect(ensureOpenAiV1BaseUrl("https://hub.example.com/v1")).toBe(
      "https://hub.example.com/v1",
    );
  });

  it("builds app settings with the backend API key placeholder", () => {
    const codex = createApiHubSettingsConfig("codex", site, "default", "gpt-5");
    const opencode = createApiHubSettingsConfig(
      "opencode",
      site,
      "default",
      "gpt-5",
    );
    const claude = createApiHubSettingsConfig(
      "claude",
      site,
      "default",
      "claude-sonnet-4-5",
    );

    expect(codex.auth.OPENAI_API_KEY).toBe(API_HUB_API_KEY_PLACEHOLDER);
    expect(codex.config).toContain('base_url = "https://hub.example.com/api/v1"');
    expect(opencode.options.apiKey).toBe(API_HUB_API_KEY_PLACEHOLDER);
    expect(opencode.options.baseURL).toBe("https://hub.example.com/api/v1");
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe(
      API_HUB_API_KEY_PLACEHOLDER,
    );
  });

  it("keys generated settings by app, group, and model for backend import", () => {
    const selections: ApiHubModelSelection[] = [
      { group: "default", model: "gpt-5" },
      { group: "vip", model: "claude-sonnet-4-5" },
    ];

    const configs = buildApiHubSettingsConfigs(site, ["claude", "codex"], selections);

    expect(Object.keys(configs).sort()).toEqual([
      "claude::default::gpt-5",
      "claude::vip::claude-sonnet-4-5",
      "codex::default::gpt-5",
      "codex::vip::claude-sonnet-4-5",
    ]);
  });

  it("supports importing a group without a default model", () => {
    const selections: ApiHubModelSelection[] = [{ group: "default", model: "" }];

    const configs = buildApiHubSettingsConfigs(site, ["claude", "codex"], selections);

    expect(Object.keys(configs).sort()).toEqual([
      "claude::default::",
      "codex::default::",
    ]);
    expect(configs["claude::default::"].env).toEqual({
      ANTHROPIC_BASE_URL: "https://hub.example.com/api",
      ANTHROPIC_AUTH_TOKEN: API_HUB_API_KEY_PLACEHOLDER,
    });
    expect(configs["codex::default::"].config).not.toContain('model = ""');
  });
});
