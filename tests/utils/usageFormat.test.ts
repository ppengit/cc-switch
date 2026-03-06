import { describe, expect, it } from "vitest";
import { fmtTokenCompact } from "@/components/usage/format";

describe("fmtTokenCompact", () => {
  it("formats plain integers without compact unit", () => {
    expect(fmtTokenCompact(987)).toBe("987");
  });

  it("formats thousands with K", () => {
    expect(fmtTokenCompact(12_345)).toBe("12.3K");
  });

  it("formats millions with M", () => {
    expect(fmtTokenCompact(2_450_000)).toBe("2.45M");
  });

  it("formats billions with B", () => {
    expect(fmtTokenCompact(9_900_000_000)).toBe("9.9B");
  });

  it("returns fallback for invalid values", () => {
    expect(fmtTokenCompact(undefined)).toBe("--");
    expect(fmtTokenCompact("")).toBe("--");
  });
});
