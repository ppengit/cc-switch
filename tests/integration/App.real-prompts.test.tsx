import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prompt } from "@/lib/api/prompts";
import {
  getCurrentPromptFileContentSnapshotState,
  getLastPromptDeleteRequest,
  getLastPromptEnableRequest,
  getLastPromptUpsertRequest,
  getPromptRequestCounts,
  getPromptState,
  getPromptsSnapshotState,
  resetProviderState,
  setPromptsState,
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

vi.mock("@/components/MarkdownEditor", () => ({
  default: ({ value, onChange, placeholder }: any) => (
    <textarea
      aria-label="prompt-content-editor"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange?.(event.target.value)}
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

vi.mock("@/components/skills/UnifiedSkillsPanel", () => ({
  default: forwardRef(({ currentApp }: any, _ref) => (
    <section data-testid="skills-panel">{currentApp}</section>
  )),
}));

vi.mock("@/components/skills/SkillsPage", () => ({
  SkillsPage: forwardRef(({ initialApp }: any, _ref) => (
    <section data-testid="skills-discovery">{initialApp}</section>
  )),
}));

vi.mock("@/components/mcp/UnifiedMcpPanel", () => ({
  default: forwardRef(() => <section data-testid="mcp-panel" />),
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

const openPromptsPanel = async (user: ReturnType<typeof userEvent.setup>) => {
  await waitFor(() =>
    expect(screen.getByTestId("provider-list")).toHaveAttribute(
      "data-app-id",
      "claude",
    ),
  );

  await user.click(screen.getByTitle("prompts.manage"));
};

const backToProviders = async (user: ReturnType<typeof userEvent.setup>) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getAllByRole("button")[0]);
  await waitFor(() =>
    expect(screen.getByTestId("provider-list")).toBeInTheDocument(),
  );
};

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const findPromptCard = (name: string): HTMLElement => {
  const card = screen.getByText(name).closest(".group");
  if (!card) {
    throw new Error(`Prompt card not found: ${name}`);
  }
  return card as HTMLElement;
};

const savePromptForm = async (
  user: ReturnType<typeof userEvent.setup>,
  values: {
    name: string;
    description: string;
    content: string;
  },
) => {
  const nameInput = screen.getByLabelText("prompts.name");
  const descriptionInput = screen.getByLabelText("prompts.description");
  const contentInput = screen.getByLabelText("prompt-content-editor");

  await user.clear(nameInput);
  await user.type(nameInput, values.name);
  await user.clear(descriptionInput);
  await user.type(descriptionInput, values.description);
  await user.clear(contentInput);
  await user.type(contentInput, values.content);

  await user.click(screen.getByRole("button", { name: "common.save" }));
};

const promptWith = (overrides: Partial<Prompt> & Pick<Prompt, "id">): Prompt => ({
  name: overrides.id,
  content: "",
  enabled: false,
  ...overrides,
});

describe("App with real PromptPanel interactions", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("runs Claude prompt enable, edit, add, and delete through the real App entry", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await openPromptsPanel(user);

    await waitFor(() =>
      expect(screen.getByText("Claude Alpha Prompt")).toBeInTheDocument(),
    );
    expect(screen.getByText("Claude Beta Prompt")).toBeInTheDocument();
    expect(screen.getByText(/prompts\.count/)).toBeInTheDocument();

    await user.click(within(findPromptCard("Claude Beta Prompt")).getByRole("switch"));

    await waitFor(() =>
      expect(getLastPromptEnableRequest()).toEqual({
        app: "claude",
        id: "claude-beta",
      }),
    );
    expect(getPromptState("claude", "claude-alpha")?.enabled).toBe(false);
    expect(getPromptState("claude", "claude-beta")?.enabled).toBe(true);
    expect(getCurrentPromptFileContentSnapshotState("claude")).toContain(
      "Claude Beta",
    );

    await user.click(
      within(findPromptCard("Claude Alpha Prompt")).getByTitle("common.edit"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("prompts.name")).toHaveValue(
        "Claude Alpha Prompt",
      ),
    );

    await savePromptForm(user, {
      name: "Claude Alpha Edited",
      description: "Edited from real prompt form",
      content: "# Claude Alpha Edited\n\nUpdated instructions.",
    });

    await waitFor(() =>
      expect(getLastPromptUpsertRequest()).toMatchObject({
        app: "claude",
        id: "claude-alpha",
        prompt: {
          id: "claude-alpha",
          name: "Claude Alpha Edited",
          description: "Edited from real prompt form",
          content: "# Claude Alpha Edited\n\nUpdated instructions.",
          enabled: false,
        },
      }),
    );
    expect(screen.getByText("Claude Alpha Edited")).toBeInTheDocument();
    expect(getPromptState("claude", "claude-beta")?.enabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "prompts.add" }));
    await waitFor(() =>
      expect(screen.getByLabelText("prompts.name")).toHaveValue(""),
    );

    await savePromptForm(user, {
      name: "Claude Added Prompt",
      description: "Added from App toolbar",
      content: "# Claude Added\n\nNew instructions.",
    });

    await waitFor(() =>
      expect(getLastPromptUpsertRequest()).toMatchObject({
        app: "claude",
        prompt: {
          name: "Claude Added Prompt",
          description: "Added from App toolbar",
          content: "# Claude Added\n\nNew instructions.",
          enabled: false,
        },
      }),
    );
    const addedId = getLastPromptUpsertRequest()?.id;
    expect(addedId).toMatch(/^prompt-\d+$/);
    expect(screen.getByText("Claude Added Prompt")).toBeInTheDocument();

    await user.click(
      within(findPromptCard("Claude Added Prompt")).getByTitle("common.delete"),
    );
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "common.cancel" }));
    expect(getPromptState("claude", addedId!)).not.toBeNull();

    await user.click(
      within(findPromptCard("Claude Added Prompt")).getByTitle("common.delete"),
    );
    dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "common.confirm" }),
      ).toBeEnabled(),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "common.confirm" }),
    );

    await waitFor(() =>
      expect(getLastPromptDeleteRequest()).toEqual({
        app: "claude",
        id: addedId,
      }),
    );
    expect(getPromptState("claude", addedId!)).toBeNull();
    expect(screen.queryByText("Claude Added Prompt")).not.toBeInTheDocument();
  }, 20_000);

  it("keeps prompt state isolated by app and reloads only matching prompt-imported events", async () => {
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await openPromptsPanel(user);
    await waitFor(() =>
      expect(screen.getByText("Claude Alpha Prompt")).toBeInTheDocument(),
    );

    await backToProviders(user);
    await clickAppSwitcherButton(user, "Codex");
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "codex",
      ),
    );
    await user.click(screen.getByTitle("prompts.manage"));

    await waitFor(() =>
      expect(screen.getByText("Codex Alpha Prompt")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Claude Alpha Prompt")).not.toBeInTheDocument();

    const beforeIgnoredEvent = getPromptRequestCounts().codex.getPrompts;
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("prompt-imported", {
          detail: { app: "claude" },
        }),
      );
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(getPromptRequestCounts().codex.getPrompts).toBe(beforeIgnoredEvent);

    setPromptsState("codex", {
      ...getPromptsSnapshotState("codex"),
      "codex-imported": promptWith({
        id: "codex-imported",
        name: "Codex Imported Prompt",
        description: "Imported by deep link",
        content: "# Imported Codex",
      }),
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("prompt-imported", {
          detail: { app: "codex" },
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByText("Codex Imported Prompt")).toBeInTheDocument(),
    );
    expect(getPromptRequestCounts().codex.getPrompts).toBeGreaterThan(
      beforeIgnoredEvent,
    );
    expect(getPromptsSnapshotState("claude")["codex-imported"]).toBeUndefined();
  }, 15_000);
});
