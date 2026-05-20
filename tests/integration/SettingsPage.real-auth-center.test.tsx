import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getClipboardWrites,
  getLastManagedAuthStartLoginRequest,
  getManagedAuthStatus,
  getManagedAuthPollRequests,
  getOpenExternalRequests,
  resetProviderState,
  setManagedAuthStatusState,
} from "../msw/state";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/settings/LanguageSettings", () => ({
  LanguageSettings: () => <div>language-settings</div>,
}));

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <div>theme-settings</div>,
}));

vi.mock("@/components/settings/WindowSettings", () => ({
  WindowSettings: () => <div>window-settings</div>,
}));

vi.mock("@/components/settings/AppVisibilitySettings", () => ({
  AppVisibilitySettings: () => <div>app-visibility-settings</div>,
}));

vi.mock("@/components/settings/SkillStorageLocationSettings", () => ({
  SkillStorageLocationSettings: () => <div>skill-storage-location-settings</div>,
}));

vi.mock("@/components/settings/SkillSyncMethodSettings", () => ({
  SkillSyncMethodSettings: () => <div>skill-sync-method-settings</div>,
}));

vi.mock("@/components/settings/TerminalSettings", () => ({
  TerminalSettings: () => <div>terminal-settings</div>,
}));

vi.mock("@/components/settings/DirectorySettings", () => ({
  DirectorySettings: () => <div>directory-settings</div>,
}));

vi.mock("@/components/settings/ImportExportSection", () => ({
  ImportExportSection: () => <div>import-export-section</div>,
}));

vi.mock("@/components/settings/BackupListSection", () => ({
  BackupListSection: () => <div>backup-list-section</div>,
}));

vi.mock("@/components/settings/WebdavSyncSection", () => ({
  WebdavSyncSection: () => <div>webdav-sync-section</div>,
}));

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => <div>about-section</div>,
}));

vi.mock("@/components/settings/ApiHubPanel", () => ({
  ApiHubPanel: () => <div>api-hub-panel</div>,
}));

vi.mock("@/components/settings/ProxyTabContent", () => ({
  ProxyTabContent: () => <div>proxy-tab-content</div>,
}));

vi.mock("@/components/usage/ModelTestConfigPanel", () => ({
  ModelTestConfigPanel: () => <div>model-test-config-panel</div>,
}));

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: () => <div>usage-dashboard</div>,
}));

vi.mock("@/components/settings/LogConfigPanel", () => ({
  LogConfigPanel: () => <div>log-config-panel</div>,
}));

const renderSettingsPage = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <SettingsPage open onOpenChange={() => {}} defaultTab="auth" />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("SettingsPage auth center with real auth sections", () => {
  beforeEach(() => {
    resetProviderState();
    setManagedAuthStatusState("github_copilot", {
      provider: "github_copilot",
      authenticated: true,
      default_account_id: "gh-primary",
      migration_error: null,
      accounts: [
        {
          id: "gh-primary",
          provider: "github_copilot",
          login: "octocat",
          avatar_url: null,
          authenticated_at: 1_700_000_000,
          is_default: true,
          github_domain: "github.com",
        },
        {
          id: "gh-alt",
          provider: "github_copilot",
          login: "hub-alt",
          avatar_url: null,
          authenticated_at: 1_700_000_100,
          is_default: false,
          github_domain: "github.enterprise.local",
        },
      ],
    });
    setManagedAuthStatusState("codex_oauth", {
      provider: "codex_oauth",
      authenticated: true,
      default_account_id: "codex-main",
      migration_error: null,
      accounts: [
        {
          id: "codex-main",
          provider: "codex_oauth",
          login: "chatgpt-main",
          avatar_url: null,
          authenticated_at: 1_700_000_200,
          is_default: true,
          github_domain: "github.com",
        },
        {
          id: "codex-alt",
          provider: "codex_oauth",
          login: "chatgpt-alt",
          avatar_url: null,
          authenticated_at: 1_700_000_300,
          is_default: false,
          github_domain: "github.com",
        },
      ],
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("loads account status, switches defaults, removes accounts, and logs out through the real auth center", async () => {
    const user = userEvent.setup();

    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "认证" })).toHaveAttribute(
        "data-state",
        "active",
      ),
    );

    await waitFor(() =>
      expect(screen.getByText("GitHub Copilot")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("ChatGPT (Codex OAuth)")).toBeInTheDocument(),
    );

    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("hub-alt")).toBeInTheDocument();
    expect(screen.getByText("chatgpt-main")).toBeInTheDocument();
    expect(screen.getByText("chatgpt-alt")).toBeInTheDocument();

    const copilotRow = screen
      .getByText("hub-alt")
      .closest("div.rounded-md.border");
    if (!(copilotRow instanceof HTMLElement)) {
      throw new Error("GitHub secondary account row not found");
    }
    await user.click(
      within(copilotRow).getByRole("button", { name: "设为默认" }),
    );

    await waitFor(() =>
      expect(getManagedAuthStatus("github_copilot").default_account_id).toBe(
        "gh-alt",
      ),
    );

    const codexRow = screen
      .getByText("chatgpt-alt")
      .closest("div.rounded-md.border");
    if (!(codexRow instanceof HTMLElement)) {
      throw new Error("Codex secondary account row not found");
    }
    await user.click(
      within(codexRow).getByRole("button", { name: "设为默认" }),
    );

    await waitFor(() =>
      expect(getManagedAuthStatus("codex_oauth").default_account_id).toBe(
        "codex-alt",
      ),
    );

    const octocatRow = screen
      .getByText("octocat")
      .closest("div.rounded-md.border");
    if (!(octocatRow instanceof HTMLElement)) {
      throw new Error("GitHub primary account row not found");
    }
    await user.click(
      within(octocatRow).getByRole("button", { name: "移除账号" }),
    );

    await waitFor(() =>
      expect(
        getManagedAuthStatus("github_copilot").accounts.map(
          (account) => account.login,
        ),
      ).toEqual(["hub-alt"]),
    );

    const logoutButtons = screen.getAllByRole("button", {
      name: "注销所有账号",
    });
    expect(logoutButtons).toHaveLength(1);

    await user.click(logoutButtons[0]);
    await waitFor(() =>
      expect(getManagedAuthStatus("codex_oauth").accounts).toHaveLength(0),
    );

    await waitFor(() =>
      expect(screen.getAllByText("未认证").length).toBeGreaterThanOrEqual(1),
    );
  });

  it("starts GitHub Enterprise login, opens verification URL, polls account, and keeps Codex isolated", async () => {
    const user = userEvent.setup();

    setManagedAuthStatusState("github_copilot", {
      provider: "github_copilot",
      authenticated: false,
      default_account_id: null,
      migration_error: null,
      accounts: [],
    });
    setManagedAuthStatusState("codex_oauth", {
      provider: "codex_oauth",
      authenticated: false,
      default_account_id: null,
      migration_error: null,
      accounts: [],
    });

    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "认证" })).toHaveAttribute(
        "data-state",
        "active",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("GitHub Copilot")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", {
        name: "GitHub Enterprise Server",
      }),
    );
    await user.type(
      screen.getByPlaceholderText("例如：company.ghe.com"),
      "https://ghe.example.com/",
    );
    await user.click(screen.getByRole("button", { name: "使用 GitHub 登录" }));

    expect(await screen.findByText("GH-USER-1234")).toBeInTheDocument();
    expect(
      screen.getByText("https://github.com/login/device"),
    ).toBeInTheDocument();
    expect(getLastManagedAuthStartLoginRequest()).toEqual({
      authProvider: "github_copilot",
      githubDomain: "ghe.example.com",
    });
    expect(getClipboardWrites()).toContain("GH-USER-1234");

    await waitFor(() =>
      expect(getOpenExternalRequests()).toEqual([
        "https://github.com/login/device",
      ]),
    );
    await waitFor(() =>
      expect(getManagedAuthPollRequests()).toEqual([
        {
          authProvider: "github_copilot",
          deviceCode: "github-device-code",
          githubDomain: "ghe.example.com",
        },
      ]),
    );
    await waitFor(() =>
      expect(
        getManagedAuthStatus("github_copilot").accounts.map((account) => ({
          login: account.login,
          github_domain: account.github_domain,
        })),
      ).toEqual([
        {
          login: "ghe-octocat",
          github_domain: "ghe.example.com",
        },
      ]),
    );

    expect(getManagedAuthStatus("codex_oauth").accounts).toHaveLength(0);
    expect(await screen.findByText("ghe-octocat")).toBeInTheDocument();
    expect(screen.getByText("ghe.example.com")).toBeInTheDocument();
  });

  it("starts Codex OAuth login without GitHub domain and keeps Copilot isolated", async () => {
    const user = userEvent.setup();

    setManagedAuthStatusState("github_copilot", {
      provider: "github_copilot",
      authenticated: false,
      default_account_id: null,
      migration_error: null,
      accounts: [],
    });
    setManagedAuthStatusState("codex_oauth", {
      provider: "codex_oauth",
      authenticated: false,
      default_account_id: null,
      migration_error: null,
      accounts: [],
    });

    renderSettingsPage();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "认证" })).toHaveAttribute(
        "data-state",
        "active",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("ChatGPT (Codex OAuth)")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));

    expect(await screen.findByText("CDX-USER-1234")).toBeInTheDocument();
    expect(screen.getByText("https://chatgpt.com/activate")).toBeInTheDocument();
    expect(getLastManagedAuthStartLoginRequest()).toEqual({
      authProvider: "codex_oauth",
      githubDomain: null,
    });
    expect(getClipboardWrites()).toContain("CDX-USER-1234");

    await waitFor(() =>
      expect(getOpenExternalRequests()).toEqual([
        "https://chatgpt.com/activate",
      ]),
    );
    await waitFor(() =>
      expect(getManagedAuthPollRequests()).toEqual([
        {
          authProvider: "codex_oauth",
          deviceCode: "codex-device-code",
          githubDomain: null,
        },
      ]),
    );
    await waitFor(() =>
      expect(
        getManagedAuthStatus("codex_oauth").accounts.map((account) => ({
          login: account.login,
          github_domain: account.github_domain,
        })),
      ).toEqual([
        {
          login: "chatgpt-login",
          github_domain: "github.com",
        },
      ]),
    );

    expect(getManagedAuthStatus("github_copilot").accounts).toHaveLength(0);
    expect(await screen.findByText("chatgpt-login")).toBeInTheDocument();
  });
});
