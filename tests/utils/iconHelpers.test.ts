import { describe, expect, it } from "vitest";
import { getIcon, hasIcon } from "@/icons/extracted";
import { getIconMetadata, searchIcons } from "@/icons/extracted/metadata";

describe("icon helpers", () => {
  it("gracefully handles empty icon names", () => {
    expect(getIcon()).toBe("");
    expect(getIcon(null)).toBe("");
    expect(hasIcon()).toBe(false);
    expect(hasIcon(null)).toBe(false);
    expect(getIconMetadata()).toBeUndefined();
    expect(getIconMetadata(null)).toBeUndefined();
  });

  it("returns all icons when search query is empty", () => {
    const results = searchIcons();
    expect(results.length).toBeGreaterThan(0);
  });
});
