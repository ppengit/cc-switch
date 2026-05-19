import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { Provider, UniversalProvider } from "@/types";
import { server } from "../msw/server";
import {
  getCurrentProviderId,
  getProviders,
  resetProviderState,
  setCurrentProviderId,
  setProviders,
} from "../msw/state";

const TAURI_ENDPOINT = "http://tauri.local";

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

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({ appId }: any) => (
    <section data-testid="provider-list" data-app-id={appId} />
  ),
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: () => null,
}));

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: () => <section data-testid="provider-form" />,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: () => null,
}));

vi.mock("@/components/universal/UniversalProviderFormModal", () => ({
  UniversalProviderFormModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <section data-testid="universal-provider-form-modal" /> : null,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: forwardRef(() => <section data-testid="prompts-panel" />),
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

const claudeProvider = (id: string, name: string): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex: 0,
  createdAt: 1_700_000_000_000,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: `https://${id}.example.com`,
      ANTHROPIC_AUTH_TOKEN: `${id}-token`,
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
    },
  },
});

const codexProvider = (id: string, name: string): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex: 0,
  createdAt: 1_700_000_100_000,
  settingsConfig: {
    auth: {
      OPENAI_API_KEY: `${id}-key`,
    },
    config: `model_provider = "${id}"\nmodel = "gpt-5.5"\n[model_providers.${id}]\nbase_url = "https://${id}.example.com/v1"\n`,
  },
});

const openclawProvider = (id: string, name: string): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex: 0,
  createdAt: 1_700_000_300_000,
  settingsConfig: {
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `${id}-key`,
    api: "openai-completions",
    models: [{ id: "openclaw-model", name: "OpenClaw Model" }],
  },
});

const createUniversalProvider = (): UniversalProvider => ({
  id: "universal-alpha",
  name: "Universal Alpha",
  providerType: "newapi",
  apps: {
    claude: true,
    codex: true,
    gemini: false,
  },
  baseUrl: "https://universal.example.com",
  apiKey: "universal-key",
  models: {
    claude: {
      model: "claude-sonnet-4-5",
    },
    codex: {
      model: "gpt-5.5",
      reasoningEffort: "high",
    },
  },
  notes: "Shared upstream",
  createdAt: 1_700_100_000_000,
  sortIndex: 0,
});

const cloneUniversalProviders = (
  value: Record<string, UniversalProvider>,
): Record<string, UniversalProvider> =>
  JSON.parse(JSON.stringify(value)) as Record<string, UniversalProvider>;

const syncUniversalProviderIntoApps = (provider: UniversalProvider) => {
  if (provider.apps.claude) {
    setProviders("claude", {
      ...getProviders("claude"),
      [`universal-${provider.id}-claude`]: {
        id: `universal-${provider.id}-claude`,
        name: provider.name,
        category: "custom",
        sortIndex: 99,
        createdAt: provider.createdAt ?? Date.now(),
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: provider.baseUrl,
            ANTHROPIC_AUTH_TOKEN: provider.apiKey,
            ANTHROPIC_MODEL: provider.models.claude?.model ?? "claude-sonnet-4-5",
          },
        },
      },
    });
  }

  if (provider.apps.codex) {
    setProviders("codex", {
      ...getProviders("codex"),
      [`universal-${provider.id}-codex`]: {
        id: `universal-${provider.id}-codex`,
        name: provider.name,
        category: "custom",
        sortIndex: 99,
        createdAt: provider.createdAt ?? Date.now(),
        settingsConfig: {
          auth: {
            OPENAI_API_KEY: provider.apiKey,
          },
          config: `model_provider = "universal"\nmodel = "${provider.models.codex?.model ?? "gpt-5.5"}"\n[model_providers.universal]\nbase_url = "${provider.baseUrl.replace(/\/+$/, "")}/v1"\n`,
        },
      },
    });
  }
};

describe("App with real AddProviderDialog universal tab interactions", () => {
  beforeEach(() => {
    resetProviderState();
    setProviders("claude", {
      "claude-base": claudeProvider("claude-base", "Claude Base"),
    });
    setCurrentProviderId("claude", "claude-base");
    setProviders("codex", {
      "codex-base": codexProvider("codex-base", "Codex Base"),
    });
    setCurrentProviderId("codex", "codex-base");
    setProviders("openclaw", {
      "openclaw-base": openclawProvider("openclaw-base", "OpenClaw Base"),
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  it("loads, syncs, duplicates, and deletes universal providers through the real add-provider dialog entry", async () => {
    let universalProviders = cloneUniversalProviders({
      "universal-alpha": createUniversalProvider(),
    });
    const syncCalls: string[] = [];
    const upsertCalls: UniversalProvider[] = [];
    const deleteCalls: string[] = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/get_universal_providers`, () =>
        HttpResponse.json(cloneUniversalProviders(universalProviders)),
      ),
      http.post(`${TAURI_ENDPOINT}/upsert_universal_provider`, async ({ request }) => {
        const body = (await request.json()) as { provider: UniversalProvider };
        upsertCalls.push(body.provider);
        universalProviders = {
          ...universalProviders,
          [body.provider.id]: JSON.parse(
            JSON.stringify(body.provider),
          ) as UniversalProvider,
        };
        return HttpResponse.json(true);
      }),
      http.post(`${TAURI_ENDPOINT}/delete_universal_provider`, async ({ request }) => {
        const body = (await request.json()) as { id: string };
        deleteCalls.push(body.id);
        const next = { ...universalProviders };
        delete next[body.id];
        universalProviders = next;
        return HttpResponse.json(true);
      }),
      http.post(`${TAURI_ENDPOINT}/sync_universal_provider`, async ({ request }) => {
        const body = (await request.json()) as { id: string };
        syncCalls.push(body.id);
        const provider = universalProviders[body.id];
        if (provider) {
          syncUniversalProviderIntoApps(provider);
        }
        return HttpResponse.json(true);
      }),
    );

    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    const user = userEvent.setup();

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveAttribute(
        "data-app-id",
        "claude",
      ),
    );

    const header = screen.getByRole("banner");
    const addButtons = within(header).getAllByRole("button");
    await user.click(addButtons[addButtons.length - 1]);

    await waitFor(() =>
      expect(screen.getByTestId("provider-form")).toBeInTheDocument(),
    );

    const tabs = screen.getAllByRole("tab");
    await user.click(tabs[1]);

    expect(await screen.findByText("Universal Alpha")).toBeInTheDocument();
    expect(screen.getByText("Shared upstream")).toBeInTheDocument();

    await user.click(screen.getByTitle("同步到应用"));
    const syncDialog = await screen.findByRole("dialog", {
      name: "同步统一供应商",
    });
    await waitFor(() =>
      expect(
        within(syncDialog).getByRole("button", { name: "同步" }),
      ).toBeEnabled(),
    );
    await user.click(within(syncDialog).getByRole("button", { name: "同步" }));

    await waitFor(() => expect(syncCalls).toEqual(["universal-alpha"]));
    await waitFor(() =>
      expect(
        Object.values(getProviders("claude")).some(
          (provider) => provider.name === "Universal Alpha",
        ),
      ).toBe(true),
    );
    expect(getCurrentProviderId("claude")).toBe("claude-base");
    expect(getCurrentProviderId("codex")).toBe("codex-base");
    expect(Object.keys(getProviders("openclaw"))).toEqual(["openclaw-base"]);

    await user.click(screen.getByTitle("复制"));

    await waitFor(() =>
      expect(screen.getByText("Universal Alpha copy")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(syncCalls).toEqual([
        "universal-alpha",
        "00000000-0000-4000-8000-000000000001",
      ]),
    );
    expect(upsertCalls.at(-1)?.id).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(getCurrentProviderId("claude")).toBe("claude-base");
    expect(getCurrentProviderId("codex")).toBe("codex-base");

    const deleteButtons = screen.getAllByTitle("删除");
    await user.click(deleteButtons[1]);
    const deleteDialog = await screen.findByRole("dialog", {
      name: "删除统一供应商",
    });
    await waitFor(() =>
      expect(
        within(deleteDialog).getByRole("button", { name: "删除" }),
      ).toBeEnabled(),
    );
    await user.click(
      within(deleteDialog).getByRole("button", { name: "删除" }),
    );

    await waitFor(() =>
      expect(deleteCalls).toEqual([
        "00000000-0000-4000-8000-000000000001",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByText("Universal Alpha copy")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Universal Alpha")).toBeInTheDocument();

    randomUuidSpy.mockRestore();
  }, 20_000);
});
