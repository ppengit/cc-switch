import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";
import type { Provider } from "@/types";
import { server } from "../msw/server";
import {
  addProvider,
  addToFailoverQueueState,
  getCurrentProviderId,
  getFailoverQueueState,
  getProviders,
  getProxyStatusState,
  getSwitchLiveSettings,
  resetProviderState,
  setAutoFailoverEnabledState,
  setCurrentProviderId,
  setProviders,
  setProxyStatusState,
  setProxyTakeoverForAppState,
  startProxyServerState,
} from "../msw/state";
import {
  emitTauriEvent,
  getTauriEventListenerCount,
} from "../msw/tauriMocks";

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

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const codexProvider = (
  id: string,
  name: string,
  sortIndex: number,
): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex,
  createdAt: 1_700_000_100_000 + sortIndex,
  settingsConfig: {
    auth: {
      OPENAI_API_KEY: `${id}-key`,
    },
    config: [
      `model_provider = "${id}"`,
      'model = "gpt-5.5"',
      `[model_providers.${id}]`,
      `base_url = "https://${id}.example.com/v1"`,
      "",
    ].join("\n"),
  },
});

const codexProviderFromDeeplink = (
  id: string,
  request: DeepLinkImportRequest,
): Provider => ({
  id,
  name: request.name ?? id,
  notes: request.notes,
  category: "custom",
  sortIndex: 9,
  createdAt: 1_700_000_200_000,
  settingsConfig: {
    auth: {
      OPENAI_API_KEY: request.apiKey ?? "",
    },
    config: [
      `model_provider = "${id}"`,
      `model = "${request.model ?? "gpt-5.5"}"`,
      `[model_providers.${id}]`,
      `base_url = "${request.endpoint ?? ""}"`,
      "",
    ].join("\n"),
  },
});

describe("App with real DeepLink provider import", () => {
  beforeEach(() => {
    resetProviderState();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.warning.mockReset();
    toastMock.info.mockReset();

    setProviders("codex", {
      "codex-alpha": codexProvider("codex-alpha", "Codex Alpha", 0),
      "codex-beta": codexProvider("codex-beta", "Codex Beta", 1),
    });
    setCurrentProviderId("codex", "codex-alpha");
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("imports an enabled Codex provider from the real deeplink dialog without drifting takeover live config", async () => {
    const importRequests: DeepLinkImportRequest[] = [];
    const importedProviderId = "codex-deeplink-imported";

    startProxyServerState();
    setProxyTakeoverForAppState("codex", true);
    setAutoFailoverEnabledState("codex", true);
    addToFailoverQueueState("codex", "codex-beta");

    expect(getCurrentProviderId("codex")).toBe("");
    expect(getFailoverQueueState("codex").map((item) => item.providerId)).toEqual([
      "codex-alpha",
      "codex-beta",
    ]);
    expect((getSwitchLiveSettings("codex") as { config?: string }).config).toContain(
      'base_url = "http://127.0.0.1:15721/codex"',
    );

    server.use(
      http.post(`${TAURI_ENDPOINT}/merge_deeplink_config`, async ({ request }) => {
        const body = (await request.json()) as {
          request: DeepLinkImportRequest;
        };
        return HttpResponse.json({
          ...body.request,
          endpoint: "https://deeplink-codex.example.com/v1",
          apiKey: "deeplink-codex-key",
          model: "gpt-5.6",
          notes: "merged deeplink config",
        });
      }),
      http.post(
        `${TAURI_ENDPOINT}/import_from_deeplink_unified`,
        async ({ request }) => {
          const body = (await request.json()) as {
            request: DeepLinkImportRequest;
          };
          importRequests.push(body.request);
          addProvider(
            "codex",
            codexProviderFromDeeplink(importedProviderId, body.request),
          );

          const status = getProxyStatusState();
          setProxyStatusState({
            active_targets: [
              ...(status.active_targets ?? []).filter(
                (target) => target.app_type !== "codex",
              ),
              {
                app_type: "codex",
                provider_id: importedProviderId,
                provider_name: body.request.name ?? "Deep Link Codex",
              },
            ],
            current_provider: body.request.name ?? "Deep Link Codex",
            current_provider_id: importedProviderId,
          });

          return HttpResponse.json({
            type: "provider",
            id: importedProviderId,
          });
        },
      ),
    );

    const user = userEvent.setup();
    const { default: App } = await import("@/App");
    renderApp(App);

    await clickAppSwitcherButton(user, "Codex");
    await waitFor(() =>
      expect(screen.getByText("Codex Alpha")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(getTauriEventListenerCount("deeplink-import")).toBeGreaterThan(0),
    );

    await act(async () => {
      emitTauriEvent("deeplink-import", {
        version: "1",
        resource: "provider",
        app: "codex",
        enabled: true,
        name: "Deep Link Codex",
        homepage: "https://deeplink.example.com",
        endpoint: "https://placeholder.example.com/v1",
        apiKey: "placeholder-key",
        model: "gpt-5.5",
        configUrl: "https://deeplink.example.com/ccswitch.json",
        icon: "openai",
      });
    });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("deeplink.confirmImport")).toBeInTheDocument();
    expect(
      within(dialog).getByText((_, element) =>
        element?.classList.contains("font-medium") === true &&
        element.textContent?.includes("https://deeplink-codex.example.com/v1") ===
          true,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("gpt-5.6")).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "deeplink.import" }),
    );

    await waitFor(() =>
      expect(screen.getByText("Deep Link Codex")).toBeInTheDocument(),
    );
    expect(importRequests).toHaveLength(1);
    expect(importRequests[0]).toMatchObject({
      app: "codex",
      enabled: true,
      name: "Deep Link Codex",
      endpoint: "https://deeplink-codex.example.com/v1",
      apiKey: "deeplink-codex-key",
      model: "gpt-5.6",
      configUrl: "https://deeplink.example.com/ccswitch.json",
    });
    expect(getProviders("codex")[importedProviderId]).toMatchObject({
      name: "Deep Link Codex",
    });

    const proxyStatus = getProxyStatusState();
    expect(proxyStatus.active_targets).toContainEqual({
      app_type: "codex",
      provider_id: importedProviderId,
      provider_name: "Deep Link Codex",
    });
    expect(proxyStatus.current_provider_id).toBe(importedProviderId);
    expect(getCurrentProviderId("codex")).toBe("");

    const live = getSwitchLiveSettings("codex") as {
      auth?: Record<string, string>;
      config?: string;
    };
    expect(live.auth?.OPENAI_API_KEY).toBe("PROXY_MANAGED");
    expect(live.config).toContain('base_url = "http://127.0.0.1:15721/codex"');
    expect(live.config).not.toContain("https://deeplink-codex.example.com/v1");
    expect(live.config).not.toContain("https://codex-alpha.example.com/v1");
    expect(live.config).not.toContain("https://codex-beta.example.com/v1");
    expect(toastMock.success).toHaveBeenCalledWith(
      "deeplink.importSuccess",
      expect.objectContaining({ closeButton: true }),
    );
  }, 20_000);
});
