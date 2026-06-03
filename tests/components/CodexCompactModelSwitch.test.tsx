import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexCompactModelSwitch } from "@/components/proxy/CodexCompactModelSwitch";
import type { AppProxyConfig } from "@/types/proxy";

const mockMutate = vi.fn();
let mockConfig: AppProxyConfig | undefined;
let mockIsLoading = false;
let mockIsPending = false;
let mockRequestedAppType = "";

vi.mock("@/lib/query/proxy", () => ({
  useAppProxyConfig: (appType: string) => {
    mockRequestedAppType = appType;
    return { data: mockConfig, isLoading: mockIsLoading };
  },
  useUpdateAppProxyConfig: () => ({
    mutate: mockMutate,
    isPending: mockIsPending,
  }),
}));

const createConfig = (
  overrides: Partial<AppProxyConfig> = {},
): AppProxyConfig => ({
  appType: "codex",
  enabled: true,
  autoFailoverEnabled: false,
  loadBalancingEnabled: false,
  forceResponsesCompactGpt54: false,
  maxRetries: 3,
  streamingFirstByteTimeout: 60,
  streamingIdleTimeout: 120,
  nonStreamingTimeout: 600,
  circuitFailureThreshold: 5,
  circuitSuccessThreshold: 2,
  circuitTimeoutSeconds: 60,
  circuitErrorRateThreshold: 0.5,
  circuitMinRequests: 10,
  ...overrides,
});

describe("CodexCompactModelSwitch", () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockConfig = createConfig();
    mockIsLoading = false;
    mockIsPending = false;
    mockRequestedAppType = "";
  });

  it("renders the Codex compact override switch from app proxy config", () => {
    render(<CodexCompactModelSwitch />);

    expect(mockRequestedAppType).toBe("codex");
    expect(
      screen.getByRole("switch", {
        name: "Codex compact 强制使用 gpt-5.4",
      }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("updates only the Codex compact override flag when toggled", () => {
    mockConfig = createConfig({
      autoFailoverEnabled: true,
      forceResponsesCompactGpt54: false,
      maxRetries: 7,
    });

    render(<CodexCompactModelSwitch />);

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Codex compact 强制使用 gpt-5.4",
      }),
    );

    expect(mockMutate).toHaveBeenCalledWith({
      ...mockConfig,
      forceResponsesCompactGpt54: true,
    });
  });
});
