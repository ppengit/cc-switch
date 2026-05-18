import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInstalledSkillsState,
  getLastZipInstallRequest,
  getMcpServersState,
  getSkillReposState,
  resetProviderState,
} from "../msw/state";

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: false,
    updateInfo: null,
    updateHandle: null,
    isChecking: false,
    error: null,
    isDismissed: false,
    dismissUpdate: vi.fn(),
    checkUpdate: vi.fn(),
    resetDismiss: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
    placeholder,
    darkMode: _darkMode,
    showValidation: _showValidation,
    language: _language,
    height: _height,
    rows: _rows,
    ...rest
  }: any) => (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange?.(event.target.value)}
      {...rest}
    />
  ),
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({ appId }: any) => (
    <section data-testid="provider-list" data-app-id={appId} />
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: () => null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: () => null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: () => null,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: forwardRef(({ appId }: any, _ref) => (
    <section data-testid="prompts-panel">{appId}</section>
  )),
}));

vi.mock("@/components/sessions/SessionManagerPage", () => ({
  SessionManagerPage: ({ appId }: any) => (
    <section data-testid="sessions-panel">{appId}</section>
  ),
}));

vi.mock("@/components/workspace/WorkspaceFilesPanel", () => ({
  default: () => <section data-testid="workspace-panel" />,
}));

vi.mock("@/components/openclaw/EnvPanel", () => ({
  default: () => <section data-testid="openclaw-env-panel" />,
}));

vi.mock("@/components/openclaw/ToolsPanel", () => ({
  default: () => <section data-testid="openclaw-tools-panel" />,
}));

vi.mock("@/components/openclaw/AgentsDefaultsPanel", () => ({
  default: () => <section data-testid="openclaw-agents-panel" />,
}));

vi.mock("@/components/openclaw/OpenClawHealthBanner", () => ({
  default: () => <section data-testid="openclaw-health-banner" />,
}));

vi.mock("@/components/hermes/HermesMemoryPanel", () => ({
  default: () => <section data-testid="hermes-memory-panel" />,
}));

vi.mock("@/components/DeepLinkImportDialog", () => ({
  DeepLinkImportDialog: () => null,
}));

vi.mock("@/components/FirstRunNoticeDialog", () => ({
  FirstRunNoticeDialog: () => null,
}));

vi.mock("@/components/usage/RequestDetailPanel", () => ({
  RequestDetailPanel: () => <section data-testid="request-detail-panel" />,
}));

vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: () => <section data-testid="settings-page" />,
}));

const renderApp = (AppComponent: ComponentType) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );
};

const waitForProviders = async () => {
  await waitFor(() =>
    expect(screen.getByTestId("provider-list")).toHaveAttribute(
      "data-app-id",
      "claude",
    ),
  );
};

const findGroupByText = (text: string): HTMLElement => {
  const element = screen.getByText(text);
  const group = element.closest(".group");
  if (!group) {
    throw new Error(`Group not found for ${text}`);
  }
  return group as HTMLElement;
};

describe("App with real Skills and MCP panels", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it("runs skills import, zip install, restore, and app toggles through the real App entry", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);
    await waitForProviders();

    await user.click(screen.getByTitle("skills.manage"));
    await waitFor(() =>
      expect(screen.getByText("Skill Alpha")).toBeInTheDocument(),
    );

    await user.click(within(findGroupByText("Skill Alpha")).getByRole("button", { name: "Codex" }));
    await waitFor(() =>
      expect(
        getInstalledSkillsState().find((skill) => skill.id === "skill-alpha")
          ?.apps.codex,
      ).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "skills.import" }));
    await waitFor(() =>
      expect(screen.getByText("Legacy Skill")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", { name: /skills\.importSelected/ }),
    );
    await waitFor(() =>
      expect(
        getInstalledSkillsState().find(
          (skill) => skill.id === "imported-legacy-skill",
        )?.apps.codex,
      ).toBe(true),
    );

    await user.click(
      screen.getByRole("button", { name: "skills.installFromZip.button" }),
    );
    await waitFor(() => {
      expect(getLastZipInstallRequest()).toEqual({
        filePath: "/mock/skills.zip",
        currentApp: "claude",
      });
      expect(
        getInstalledSkillsState().find((skill) => skill.id === "zip-skill")
          ?.apps.claude,
      ).toBe(true);
    });

    await user.click(
      screen.getByRole("button", { name: "skills.restoreFromBackup.button" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Restored Skill")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", {
        name: "skills.restoreFromBackup.restore",
      }),
    );
    await waitFor(() =>
      expect(
        getInstalledSkillsState().find((skill) => skill.id === "skill-restored")
          ?.apps.claude,
      ).toBe(true),
    );
  }, 15_000);

  it("installs a discoverable skill and manages repo sources through the real discovery page", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);
    await waitForProviders();

    await user.click(screen.getByTitle("skills.manage"));
    await waitFor(() =>
      expect(screen.getByText("Skill Alpha")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "skills.discover" }));
    await waitFor(() =>
      expect(screen.getByText("Repo Skill")).toBeInTheDocument(),
    );
    await user.click(within(findGroupByText("Repo Skill")).getByRole("button", { name: "skills.install" }));

    await waitFor(() =>
      expect(
        getInstalledSkillsState().find((skill) => skill.id === "repo-skill")
          ?.apps.claude,
      ).toBe(true),
    );

    await user.click(
      screen.getByRole("button", { name: "skills.repoManager" }),
    );
    await waitFor(() =>
      expect(screen.getByText("skills.repo.title")).toBeInTheDocument(),
    );
    await user.type(
      screen.getByPlaceholderText("skills.repo.urlPlaceholder"),
      "new-owner/new-skills",
    );
    await user.type(screen.getByPlaceholderText("skills.repo.branchPlaceholder"), "dev");
    await user.click(screen.getByRole("button", { name: "skills.repo.add" }));

    await waitFor(() =>
      expect(getSkillReposState()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner: "new-owner",
            name: "new-skills",
            branch: "dev",
          }),
        ]),
      ),
    );
  }, 15_000);

  it("runs MCP import, app toggles, add, and delete through the real App entry", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);
    await waitForProviders();

    await user.click(screen.getByTitle("mcp.title"));
    await waitFor(() =>
      expect(screen.getByText("Sample Claude Server")).toBeInTheDocument(),
    );

    await user.click(within(findGroupByText("Sample Claude Server")).getByRole("button", { name: "Codex" }));
    await waitFor(() =>
      expect(getMcpServersState().sample.apps.codex).toBe(true),
    );

    await user.click(
      screen.getByRole("button", { name: "mcp.importExisting" }),
    );
    await waitFor(() =>
      expect(getMcpServersState().importedMcp).toBeTruthy(),
    );
    expect(screen.getByText("Imported MCP")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "mcp.addMcp" }));
    await waitFor(() =>
      expect(screen.getByText("mcp.addServer")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "fetch" }));
    await user.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => {
      const servers = getMcpServersState();
      expect(servers.fetch).toBeTruthy();
      expect(servers.fetch.apps.claude).toBe(true);
      expect(servers.fetch.apps.codex).toBe(true);
      expect(servers.fetch.server.command).toBe("uvx");
    });

    await user.click(within(findGroupByText("Imported MCP")).getByTitle("common.delete"));
    const dialog = await screen.findByRole("dialog", {
      name: "mcp.unifiedPanel.deleteServer",
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "common.confirm" })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole("button", { name: "common.confirm" }));

    await waitFor(() =>
      expect(getMcpServersState().importedMcp).toBeUndefined(),
    );
  }, 15_000);
});
