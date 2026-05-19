import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { Provider } from "@/types";
import { server } from "../msw/server";
import {
  getProviders,
  resetProviderState,
  setLiveProviderIds,
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

const clickAppSwitcherButton = async (
  user: ReturnType<typeof userEvent.setup>,
  appName: string,
) => {
  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: appName }));
};

const findImportCurrentButton = () =>
  screen.findByRole("button", {
    name: /导入当前配置|Import Current Config|provider\.importCurrent/i,
  });

const opencodeProvider = (id: string, name: string): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex: 0,
  createdAt: 1_700_000_200_000,
  settingsConfig: {
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `https://${id}.example.com/v1`,
      apiKey: `${id}-key`,
    },
    models: {
      [`${id}-model`]: { name: `${name} Model` },
    },
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
    models: [{ id: `${id}-model`, name: `${name} Model` }],
  },
});

const hermesProvider = (id: string, name: string): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex: 0,
  createdAt: 1_700_000_400_000,
  settingsConfig: {
    provider: id,
    base_url: `https://${id}.example.com/v1`,
    api_key: `${id}-key`,
    model: `${id}-model`,
    models: [{ id: `${id}-model`, name: `${name} Model` }],
  },
});

describe("App with real provider empty-state import flows", () => {
  beforeEach(() => {
    resetProviderState();
    setProviders("opencode", {});
    setProviders("openclaw", {});
    setProviders("hermes", {});
    setLiveProviderIds("opencode", ["opencode-live-imported"]);
    setLiveProviderIds("openclaw", ["openclaw-live-imported"]);
    setLiveProviderIds("hermes", ["hermes-live-imported"]);
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("imports existing OpenCode, OpenClaw, and Hermes live configs through the real empty-state entry without cross-app leakage", async () => {
    const importCalls: string[] = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/import_opencode_providers_from_live`, () => {
        importCalls.push("opencode");
        setProviders("opencode", {
          "opencode-live-imported": opencodeProvider(
            "opencode-live-imported",
            "OpenCode Imported",
          ),
        });
        return HttpResponse.json(1);
      }),
      http.post(`${TAURI_ENDPOINT}/import_openclaw_providers_from_live`, () => {
        importCalls.push("openclaw");
        setProviders("openclaw", {
          "openclaw-live-imported": openclawProvider(
            "openclaw-live-imported",
            "OpenClaw Imported",
          ),
        });
        return HttpResponse.json(1);
      }),
      http.post(`${TAURI_ENDPOINT}/import_hermes_providers_from_live`, () => {
        importCalls.push("hermes");
        setProviders("hermes", {
          "hermes-live-imported": hermesProvider(
            "hermes-live-imported",
            "Hermes Imported",
          ),
        });
        return HttpResponse.json(1);
      }),
    );

    const user = userEvent.setup();
    const { default: App } = await import("@/App");
    renderApp(App);

    await clickAppSwitcherButton(user, "OpenCode");
    await user.click(await findImportCurrentButton());
    await waitFor(() =>
      expect(screen.getByText("OpenCode Imported")).toBeInTheDocument(),
    );
    expect(getProviders("opencode")["opencode-live-imported"]).toBeDefined();
    expect(getProviders("openclaw")["openclaw-live-imported"]).toBeUndefined();
    expect(getProviders("hermes")["hermes-live-imported"]).toBeUndefined();

    await clickAppSwitcherButton(user, "OpenClaw");
    await user.click(await findImportCurrentButton());
    await waitFor(() =>
      expect(screen.getByText("OpenClaw Imported")).toBeInTheDocument(),
    );
    expect(getProviders("opencode")["opencode-live-imported"]).toBeDefined();
    expect(getProviders("openclaw")["openclaw-live-imported"]).toBeDefined();
    expect(getProviders("hermes")["hermes-live-imported"]).toBeUndefined();

    await clickAppSwitcherButton(user, "Hermes");
    await user.click(await findImportCurrentButton());
    await waitFor(() =>
      expect(screen.getByText("Hermes Imported")).toBeInTheDocument(),
    );
    expect(getProviders("opencode")["opencode-live-imported"]).toBeDefined();
    expect(getProviders("openclaw")["openclaw-live-imported"]).toBeDefined();
    expect(getProviders("hermes")["hermes-live-imported"]).toBeDefined();

    expect(importCalls).toEqual(["opencode", "openclaw", "hermes"]);
  }, 20_000);
});
