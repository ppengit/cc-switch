import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("@/components/providers/forms/CopilotAuthSection", () => ({
  CopilotAuthSection: () => <div>copilot-auth-section</div>,
}));

vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: () => <div>codex-oauth-section</div>,
}));

describe("AuthCenterPanel", () => {
  it("renders copilot and codex oauth sections", () => {
    render(<AuthCenterPanel />);

    expect(screen.getByText("OAuth 认证中心")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT (Codex OAuth)")).toBeInTheDocument();
    expect(screen.getByText("copilot-auth-section")).toBeInTheDocument();
    expect(screen.getByText("codex-oauth-section")).toBeInTheDocument();
  });
});
