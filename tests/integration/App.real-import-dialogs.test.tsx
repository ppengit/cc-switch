import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { Prompt } from "@/lib/api/prompts";
import type { Provider } from "@/types";
import { server } from "../msw/server";
import {
  addProvider,
  getLastSettingsSaveRequest,
  getPromptsSnapshotState,
  getProviders,
  getSettings,
  resetProviderState,
  setPromptsState,
  setSettings,
} from "../msw/state";
import { emitTauriEvent } from "../msw/tauriMocks";

const TAURI_ENDPOINT = "http://tauri.local";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

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
  toast: toastMock,
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({ appId, providers }: any) => (
    <section data-testid="provider-list" data-app-id={appId}>
      {Object.values(providers).map((provider: any) => (
        <div key={provider.id}>{provider.name}</div>
      ))}
    </section>
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

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, title, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>common.confirm</button>
        <button onClick={onCancel}>common.cancel</button>
      </div>
    ) : null,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: forwardRef(({ appId }: any, _ref) => (
    <section data-testid="prompts-panel">{appId}</section>
  )),
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

const claudeProvider = (
  id: string,
  name: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Provider => ({
  id,
  name,
  category: "custom",
  createdAt: 1_700_000_000_000,
  sortIndex: 9,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: model,
    },
  },
});

describe("App with real import dialogs", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    setSettings({ firstRunNoticeConfirmed: true });
  });

  it("acknowledges the real first-run notice without dropping existing webdav settings", async () => {
    const user = userEvent.setup();

    setSettings({
      firstRunNoticeConfirmed: undefined,
      webdavSync: {
        enabled: true,
        autoSync: true,
        baseUrl: "https://dav.example.com/remote.php/webdav",
        username: "alice",
        password: "secret-password",
        remoteRoot: "/cc-switch",
        profile: "main",
      },
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    const confirmButton = await screen.findByRole("button", {
      name: "firstRunNotice.confirm",
    });
    await user.click(confirmButton);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "firstRunNotice.confirm",
        }),
      ).not.toBeInTheDocument(),
    );

    await waitFor(() =>
      expect(getSettings().firstRunNoticeConfirmed).toBe(true),
    );
    await waitFor(() => expect(getLastSettingsSaveRequest()).not.toBeNull());
    expect(getLastSettingsSaveRequest()).toMatchObject({
      firstRunNoticeConfirmed: true,
    });
    expect(getLastSettingsSaveRequest()).not.toHaveProperty("webdavSync");
    expect(getSettings().webdavSync).toMatchObject({
      baseUrl: "https://dav.example.com/remote.php/webdav",
      username: "alice",
      remoteRoot: "/cc-switch",
      profile: "main",
    });
  });

  it("imports a provider from the real deeplink dialog after merge and refreshes the provider list", async () => {
    const user = userEvent.setup();
    const importedRequests: Array<Record<string, unknown>> = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/merge_deeplink_config`, async ({ request }) => {
        const body = (await request.json()) as {
          request: Record<string, unknown>;
        };
        return HttpResponse.json({
          ...body.request,
          endpoint: "https://merged.provider.example.com/v1",
          apiKey: "merged-provider-key",
          model: "claude-merged",
          notes: "merged deeplink config",
        });
      }),
      http.post(
        `${TAURI_ENDPOINT}/import_from_deeplink_unified`,
        async ({ request }) => {
          const body = (await request.json()) as {
            request: Record<string, unknown>;
          };
          importedRequests.push(body.request);
          addProvider(
            "claude",
            claudeProvider(
              "claude-deeplink-imported",
              String(body.request.name),
              String(body.request.endpoint),
              String(body.request.apiKey),
              String(body.request.model),
            ),
          );
          return HttpResponse.json({
            type: "provider",
            id: "claude-deeplink-imported",
          });
        },
      ),
    );

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    await act(async () => {
      emitTauriEvent("deeplink-import", {
        version: "1",
        resource: "provider",
        app: "claude",
        name: "Deep Link Claude",
        homepage: "https://provider.example.com",
        endpoint: "https://placeholder.example.com/v1",
        apiKey: "placeholder-key",
        configUrl: "https://provider.example.com/ccswitch.json",
        icon: "anthropic",
      });
    });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("deeplink.confirmImport")).toBeInTheDocument();
    expect(
      within(dialog).getByText((_, element) =>
        element?.classList.contains("font-medium") === true &&
        element.textContent === "🔹 https://merged.provider.example.com/v1",
      ),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "deeplink.import" }),
    );

    await waitFor(() =>
      expect(screen.getByText("Deep Link Claude")).toBeInTheDocument(),
    );
    expect(getProviders("claude")["claude-deeplink-imported"]).toBeDefined();
    expect(importedRequests).toHaveLength(1);
    expect(importedRequests[0]).toMatchObject({
      name: "Deep Link Claude",
      endpoint: "https://merged.provider.example.com/v1",
      apiKey: "merged-provider-key",
      model: "claude-merged",
      configUrl: "https://provider.example.com/ccswitch.json",
    });
  });

  it("imports a prompt from the real deeplink dialog and dispatches the refresh event", async () => {
    const user = userEvent.setup();
    const promptEvents: Array<{ app: string | undefined }> = [];
    const onPromptImported = (event: Event) => {
      const detail = (event as CustomEvent<{ app?: string }>).detail;
      promptEvents.push({ app: detail?.app });
    };
    window.addEventListener("prompt-imported", onPromptImported);

    server.use(
      http.post(
        `${TAURI_ENDPOINT}/import_from_deeplink_unified`,
        async ({ request }) => {
          const body = (await request.json()) as {
            request: {
              app: "claude";
              name: string;
              content: string;
              description?: string;
            };
          };
          const nextPrompts = {
            ...getPromptsSnapshotState("claude"),
            "prompt-deeplink-imported": {
              id: "prompt-deeplink-imported",
              name: body.request.name,
              content: body.request.content,
              description: body.request.description,
              enabled: true,
            } satisfies Prompt,
          };
          setPromptsState("claude", nextPrompts);
          return HttpResponse.json({
            type: "prompt",
            id: "prompt-deeplink-imported",
          });
        },
      ),
    );

    try {
      const { default: App } = await import("@/App");
      renderApp(App);

      await act(async () => {
        emitTauriEvent("deeplink-import", {
          version: "1",
          resource: "prompt",
          app: "claude",
          name: "Imported Prompt",
          description: "Prompt from deeplink",
          enabled: true,
          content: btoa("You are a reliable coding assistant."),
        });
      });

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("deeplink.importPrompt")).toBeInTheDocument();
      expect(
        within(dialog).getByText("You are a reliable coding assistant."),
      ).toBeInTheDocument();

      await user.click(
        within(dialog).getByRole("button", { name: "deeplink.import" }),
      );

      await waitFor(() =>
        expect(
          getPromptsSnapshotState("claude")["prompt-deeplink-imported"],
        ).toMatchObject({
          name: "Imported Prompt",
          enabled: true,
        }),
      );
      await waitFor(() =>
        expect(promptEvents).toEqual([{ app: "claude" }]),
      );
    } finally {
      window.removeEventListener("prompt-imported", onPromptImported);
    }
  });

  it("surfaces deeplink parse errors through the real event listener", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await act(async () => {
      emitTauriEvent("deeplink-error", {
        url: "ccswitch://bad",
        error: "Malformed deeplink payload",
      });
    });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("deeplink.parseError", {
        description: "Malformed deeplink payload",
      }),
    );
  });
});
