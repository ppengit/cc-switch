import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderHealthBadge } from "@/components/providers/ProviderHealthBadge";

function getTitle(container: HTMLElement): string {
  return container.firstElementChild?.getAttribute("title") ?? "";
}

describe("ProviderHealthBadge", () => {
  it("includes normalized circuit reason when breaker is open", () => {
    const { container } = render(
      <ProviderHealthBadge
        consecutiveFailures={5}
        lastError={"  upstream timeout\n after 30s  "}
      />,
    );

    const title = getTitle(container);

    expect(title).toContain("5");
    expect(title).toContain("upstream timeout after 30s");
    expect(title).toContain("\n");
  });

  it("shows fallback circuit reason when no error text is available", () => {
    const { container } = render(
      <ProviderHealthBadge consecutiveFailures={6} lastError={"   \n  "} />,
    );

    const title = getTitle(container);

    expect(title).toContain("6");
    expect(title).toContain("\n");
  });

  it("keeps non-circuit title free from circuit reason text", () => {
    const { container } = render(
      <ProviderHealthBadge
        consecutiveFailures={2}
        lastError={"this reason should not be shown"}
      />,
    );

    const title = getTitle(container);

    expect(title).toContain("2");
    expect(title).not.toContain("this reason should not be shown");
    expect(title).not.toContain("\n");
  });

  it("truncates overlong circuit reason for readability", () => {
    const longReason = "x".repeat(180);
    const { container } = render(
      <ProviderHealthBadge consecutiveFailures={7} lastError={longReason} />,
    );

    const title = getTitle(container);

    expect(title).toContain("x".repeat(140));
    expect(title).toContain("...");
  });
});
