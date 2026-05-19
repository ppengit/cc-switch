import { Suspense, forwardRef, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { AppId } from "@/lib/api";
import type { Provider } from "@/types";
import { server } from "../msw/server";
import {
  resetProviderState,
  setCurrentProviderId,
  setProviders,
  setProxyTakeoverForAppState,
} from "../msw/state";

const TAURI_ENDPOINT = "http://tauri.local";

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
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
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
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

const geminiProvider = (id: string, name: string): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex: 0,
  createdAt: 1_700_000_200_000,
  settingsConfig: {
    env: {
      GOOGLE_GEMINI_BASE_URL: `https://${id}.example.com`,
      GEMINI_API_KEY: `${id}-key`,
      GEMINI_MODEL: "gemini-2.5-flash",
    },
    config: {
      model: {
        name: "gemini-2.5-flash",
      },
    },
  },
});

describe("App with real ProviderList current-config interactions", () => {
  beforeEach(() => {
    resetProviderState();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    setProviders("claude", {
      "claude-base": claudeProvider("claude-base", "Claude Base"),
    });
    setCurrentProviderId("claude", "claude-base");
    setProviders("codex", {
      "codex-base": codexProvider("codex-base", "Codex Base"),
    });
    setCurrentProviderId("codex", "codex-base");
    setProviders("gemini", {
      "gemini-base": geminiProvider("gemini-base", "Gemini Base"),
    });
    setCurrentProviderId("gemini", "gemini-base");
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("loads, imports, refreshes, and saves multi-file Gemini live config through the real current-config entry", async () => {
    const configContents: Record<string, string> = {
      "gemini:env": [
        "GOOGLE_GEMINI_BASE_URL=https://gemini.live/v1",
        "GEMINI_API_KEY=sk-old",
      ].join("\n"),
      "gemini:settings": '{"model":{"name":"gemini-1.5-pro"}}',
    };
    const listCalls: AppId[] = [];
    const readCalls: Array<{ app: AppId; fileKey: string }> = [];
    const writeBodies: Array<{
      app: AppId;
      files: Array<{ fileKey: string; content: string }>;
    }> = [];
    const importBodies: Array<{ app: AppId }> = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/list_app_config_files`, async ({ request }) => {
        const { app } = (await request.json()) as { app: AppId };
        listCalls.push(app);
        if (app !== "gemini") {
          return HttpResponse.json([]);
        }
        return HttpResponse.json([
          {
            key: "env",
            label: ".env",
            path: "/mock/gemini/.env",
          },
          {
            key: "settings",
            label: "settings.json",
            path: "/mock/gemini/settings.json",
          },
        ]);
      }),
      http.post(`${TAURI_ENDPOINT}/read_app_config_file`, async ({ request }) => {
        const { app, fileKey } = (await request.json()) as {
          app: AppId;
          fileKey: string;
        };
        readCalls.push({ app, fileKey });
        return HttpResponse.json({
          key: fileKey,
          label: fileKey === "env" ? ".env" : "settings.json",
          path:
            fileKey === "env"
              ? `/mock/${app}/.env`
              : `/mock/${app}/settings.json`,
          content: configContents[`${app}:${fileKey}`] ?? "",
        });
      }),
      http.post(`${TAURI_ENDPOINT}/write_app_config_files`, async ({ request }) => {
        const body = (await request.json()) as {
          app: AppId;
          files: Array<{ fileKey: string; content: string }>;
        };
        writeBodies.push(body);
        for (const file of body.files) {
          configContents[`${body.app}:${file.fileKey}`] = file.content;
        }
        return HttpResponse.json(true);
      }),
      http.post(`${TAURI_ENDPOINT}/import_mcp_from_app_live`, async ({ request }) => {
        const body = (await request.json()) as { app: AppId };
        importBodies.push(body);
        return HttpResponse.json(3);
      }),
    );

    const user = userEvent.setup();
    const { default: App } = await import("@/App");
    renderApp(App);

    await clickAppSwitcherButton(user, "Gemini");
    await waitFor(() =>
      expect(screen.getByText("Gemini Base")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "当前配置" }));

    const envTextarea = (await screen.findByDisplayValue(
      /GOOGLE_GEMINI_BASE_URL=https:\/\/gemini\.live\/v1/,
    )) as HTMLTextAreaElement;
    const settingsTextarea = (await screen.findByDisplayValue(
      /gemini-1\.5-pro/,
    )) as HTMLTextAreaElement;

    fireEvent.change(envTextarea, {
      target: {
        value: [
          "GOOGLE_GEMINI_BASE_URL=https://gemini.changed/v1",
          "GEMINI_API_KEY=sk-new",
        ].join("\n"),
      },
    });
    fireEvent.change(settingsTextarea, {
      target: {
        value: '{"model":{"name":"gemini-2.0-flash"}}',
      },
    });

    await user.click(screen.getByRole("button", { name: "回显到 MCP 管理" }));

    await waitFor(() =>
      expect(importBodies).toEqual([{ app: "gemini" }]),
    );
    await waitFor(() =>
      expect(writeBodies[0]).toEqual({
        app: "gemini",
        files: [
          {
            fileKey: "env",
            content: [
              "GOOGLE_GEMINI_BASE_URL=https://gemini.changed/v1",
              "GEMINI_API_KEY=sk-new",
            ].join("\n"),
          },
          {
            fileKey: "settings",
            content: '{"model":{"name":"gemini-2.0-flash"}}',
          },
        ],
      }),
    );
    expect(listCalls.length).toBeGreaterThanOrEqual(1);
    expect(listCalls.every((app) => app === "gemini")).toBe(true);
    expect(readCalls.filter((item) => item.app === "gemini").length).toBeGreaterThanOrEqual(4);
    expect(writeBodies.every((body) => body.app === "gemini")).toBe(true);
    expect(toastSuccessMock).toHaveBeenCalledWith("已从当前配置回显 MCP 管理：3 项");

    await waitFor(() =>
      expect(screen.getByDisplayValue(/gemini-2\.0-flash/)).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByDisplayValue(/gemini-2\.0-flash/), {
      target: {
        value: '{"model":{"name":"gemini-2.5-pro"}}',
      },
    });

    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(writeBodies[1]).toEqual({
        app: "gemini",
        files: [
          {
            fileKey: "env",
            content: [
              "GOOGLE_GEMINI_BASE_URL=https://gemini.changed/v1",
              "GEMINI_API_KEY=sk-new",
            ].join("\n"),
          },
          {
            fileKey: "settings",
            content: '{"model":{"name":"gemini-2.5-pro"}}',
          },
        ],
      }),
    );
    expect(configContents["gemini:settings"]).toBe(
      '{"model":{"name":"gemini-2.5-pro"}}',
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("当前配置已保存");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "回显到 MCP 管理" }),
      ).not.toBeInTheDocument(),
    );
  }, 20_000);

  it("blocks MCP backfill from current config when Claude is under takeover mode", async () => {
    const writeBodies: Array<{
      app: AppId;
      files: Array<{ fileKey: string; content: string }>;
    }> = [];
    const importBodies: Array<{ app: AppId }> = [];

    setProxyTakeoverForAppState("claude", true);

    server.use(
      http.post(`${TAURI_ENDPOINT}/list_app_config_files`, async ({ request }) => {
        const { app } = (await request.json()) as { app: AppId };
        if (app !== "claude") {
          return HttpResponse.json([]);
        }
        return HttpResponse.json([
          {
            key: "settings",
            label: "claude.json",
            path: "/mock/claude/settings.json",
          },
        ]);
      }),
      http.post(`${TAURI_ENDPOINT}/read_app_config_file`, async ({ request }) => {
        const { app, fileKey } = (await request.json()) as {
          app: AppId;
          fileKey: string;
        };
        return HttpResponse.json({
          key: fileKey,
          label: "claude.json",
          path: `/mock/${app}/settings.json`,
          content: '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:15721"}}',
        });
      }),
      http.post(`${TAURI_ENDPOINT}/write_app_config_files`, async ({ request }) => {
        writeBodies.push(
          (await request.json()) as {
            app: AppId;
            files: Array<{ fileKey: string; content: string }>;
          },
        );
        return HttpResponse.json(true);
      }),
      http.post(`${TAURI_ENDPOINT}/import_mcp_from_app_live`, async ({ request }) => {
        importBodies.push((await request.json()) as { app: AppId });
        return HttpResponse.json(1);
      }),
    );

    const user = userEvent.setup();
    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByText("Claude Base")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "当前配置" }));

    expect(
      await screen.findByText(
        /当前应用已开启代理接管。这里展示的是应用实际配置/,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "回显到 MCP 管理" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "当前应用已开启代理接管，不能直接从当前配置回显 MCP；请先关闭接管后再试。",
      ),
    );
    expect(writeBodies).toEqual([]);
    expect(importBodies).toEqual([]);
  }, 20_000);
});
