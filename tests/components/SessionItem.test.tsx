import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionItem } from "@/components/sessions/SessionItem";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("SessionItem", () => {
  it("shows associated provider and mode badge when binding exists", () => {
    render(
      <TooltipProvider>
        <SessionItem
          session={{
            providerId: "codex",
            sessionId: "session-1",
            title: "Session One",
            lastActiveAt: Date.now(),
          }}
          isSelected={false}
          onSelect={vi.fn()}
          bindingProviderName="Alpha Provider"
          bindingPinned
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("Alpha Provider")).toBeInTheDocument();
    expect(screen.getByText("锁定")).toBeInTheDocument();
  });
});
