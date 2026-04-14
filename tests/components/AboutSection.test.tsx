import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";

import { AboutSection } from "@/components/settings/AboutSection";

const getToolVersionsMock = vi.fn();
const getUpstreamReleaseInfoMock = vi.fn();
const openExternalMock = vi.fn();
const updateToolMock = vi.fn();
const getVersionMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    getToolVersions: (...args: unknown[]) => getToolVersionsMock(...args),
    getUpstreamReleaseInfo: (...args: unknown[]) =>
      getUpstreamReleaseInfoMock(...args),
    openExternal: (...args: unknown[]) => openExternalMock(...args),
    updateTool: (...args: unknown[]) => updateToolMock(...args),
  },
}));

vi.mock("@/lib/platform", () => ({
  isWindows: () => true,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => getVersionMock(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("AboutSection", () => {
  beforeEach(() => {
    getToolVersionsMock.mockReset();
    getUpstreamReleaseInfoMock.mockReset();
    openExternalMock.mockReset();
    updateToolMock.mockReset();
    getVersionMock.mockReset();
  });

  it("renders local tool versions even when latest version lookup is unavailable", async () => {
    getVersionMock.mockResolvedValue("3.13.0");
    getToolVersionsMock.mockResolvedValue([
      {
        name: "claude",
        version: "2.1.83",
        latest_version: null,
        error: null,
        install_source: "native",
        env_type: "windows",
        wsl_distro: null,
        installations: [{ source: "native", version: "2.1.83", error: null }],
      },
      {
        name: "codex",
        version: "0.120.0",
        latest_version: null,
        error: null,
        install_source: null,
        env_type: "windows",
        wsl_distro: null,
        installations: null,
      },
      {
        name: "gemini",
        version: "0.37.1",
        latest_version: null,
        error: null,
        install_source: null,
        env_type: "windows",
        wsl_distro: null,
        installations: null,
      },
      {
        name: "opencode",
        version: null,
        latest_version: null,
        error: "not installed or not executable",
        install_source: null,
        env_type: "windows",
        wsl_distro: null,
        installations: null,
      },
      {
        name: "openclaw",
        version: null,
        latest_version: null,
        error: "not installed or not executable",
        install_source: null,
        env_type: "windows",
        wsl_distro: null,
        installations: null,
      },
    ]);
    getUpstreamReleaseInfoMock.mockResolvedValue({
      repo: "farion1231/cc-switch",
      tagName: "v3.13.0",
      version: "3.13.0",
      name: "3.13.0",
      publishedAt: "2026-04-10T00:00:00Z",
      htmlUrl: "https://github.com/farion1231/cc-switch/releases/tag/v3.13.0",
      prerelease: false,
      draft: false,
      error: null,
    });

    render(<AboutSection isPortable={false} />);

    await waitFor(() => {
      expect(getToolVersionsMock).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText("2.1.83")).toBeInTheDocument();
    expect(screen.getByText("0.120.0")).toBeInTheDocument();
    expect(screen.getByText("0.37.1")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
  });
});
