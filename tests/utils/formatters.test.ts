import { describe, expect, it } from "vitest";
import { formatTextConfig } from "@/utils/formatters";

describe("formatTextConfig", () => {
  it("normalizes line endings, trims trailing spaces, and adds a final newline", () => {
    expect(formatTextConfig("A=1  \r\nB=2\t\r\n\r\n")).toBe("A=1\nB=2\n");
  });

  it("preserves intentional inner blank lines", () => {
    expect(formatTextConfig("A=1  \n\n# note  \r\nB=2")).toBe(
      "A=1\n\n# note\nB=2\n",
    );
  });

  it("returns empty string for whitespace-only content", () => {
    expect(formatTextConfig(" \r\n\t\r\n")).toBe("");
  });
});
