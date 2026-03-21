import { describe, expect, it } from "vitest";
import {
  getTomlBoolValue,
  getTomlStringValue,
  removeTomlKey,
  upsertTomlBoolValue,
  upsertTomlStringValue,
} from "@/utils/tomlKeyUtils";

describe("tomlKeyUtils", () => {
  it("reads only top-level string values", () => {
    const toml = `sandbox_mode = "workspace-write"

[profiles.safe]
sandbox_mode = "danger-full-access"
`;

    expect(getTomlStringValue(toml, "sandbox_mode")).toBe("workspace-write");
  });

  it("updates top-level string values without touching nested tables", () => {
    const toml = `sandbox_mode = "workspace-write"

[profiles.safe]
sandbox_mode = "danger-full-access"
`;

    const updated = upsertTomlStringValue(
      toml,
      "sandbox_mode",
      "danger-full-access",
    );

    expect(updated).toContain(`sandbox_mode = "danger-full-access"`);
    expect(updated).toContain(`[profiles.safe]
sandbox_mode = "danger-full-access"`);
    expect(updated.match(/sandbox_mode = "danger-full-access"/g)).toHaveLength(
      2,
    );
  });

  it("removes only top-level keys", () => {
    const toml = `show_raw_agent_reasoning = true

[profiles.debug]
show_raw_agent_reasoning = true
`;

    const updated = removeTomlKey(toml, "show_raw_agent_reasoning");

    expect(getTomlBoolValue(updated, "show_raw_agent_reasoning")).toBeNull();
    expect(updated).toContain(`[profiles.debug]
show_raw_agent_reasoning = true`);
  });

  it("upserts top-level bool values before tables", () => {
    const toml = `[profiles.debug]
show_raw_agent_reasoning = false
`;

    const updated = upsertTomlBoolValue(toml, "show_raw_agent_reasoning", true);

    expect(updated.startsWith("show_raw_agent_reasoning = true")).toBe(true);
    expect(updated).toContain(`[profiles.debug]
show_raw_agent_reasoning = false`);
  });
});
