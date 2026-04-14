import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";

import { WindowSettings } from "@/components/settings/WindowSettings";

const enterLightweightModeMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    enterLightweightMode: () => enterLightweightModeMock(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

describe("WindowSettings", () => {
  const baseSettings = {
    launchOnStartup: false,
    silentStartup: false,
    enableClaudePluginIntegration: false,
    skipClaudeOnboarding: false,
    minimizeToTrayOnClose: true,
  };

  beforeEach(() => {
    enterLightweightModeMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("calls enter lightweight mode when action button is clicked", async () => {
    enterLightweightModeMock.mockResolvedValue(undefined);

    render(<WindowSettings settings={baseSettings} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    await waitFor(() => {
      expect(enterLightweightModeMock).toHaveBeenCalledTimes(1);
    });
  });

  it("shows a toast error when entering lightweight mode fails", async () => {
    enterLightweightModeMock.mockRejectedValue(new Error("boom"));

    render(<WindowSettings settings={baseSettings} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    });
  });
});
