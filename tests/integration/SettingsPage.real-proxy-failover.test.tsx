import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { settingsApi } from "@/lib/api";
import type { Provider } from "@/types";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getAppProxyConfigState,
  getAutoFailoverEnabled,
  getFailoverQueueState,
  getLastSettingsSaveRequest,
  getProxyTakeoverStatusState,
  getProviders,
  getSwitchLiveSettings,
  resetProviderState,
  setAppProxyConfigState,
  setCurrentProviderId,
  setProviders,
  setSettings,
  setSwitchLiveSettings,
  startProxyServerState,
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

vi.mock("@/components/usage/ModelTestConfigPanel", () => ({
  ModelTestConfigPanel: () => <div>model-test-config-panel</div>,
}));

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: () => <div>usage-dashboard</div>,
}));

vi.mock("@/components/settings/LogConfigPanel", () => ({
  LogConfigPanel: () => <div>log-config-panel</div>,
}));

vi.mock("@/components/settings/AuthCenterPanel", () => ({
  AuthCenterPanel: () => <div>auth-center-panel</div>,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, title, confirmText, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onCancel}>common.cancel</button>
      </div>
    ) : null,
}));

const claudeProvider = (
  id: string,
  name: string,
  sortIndex: number,
): Provider => ({
  id,
  name,
  notes: `${name} notes`,
  category: "custom",
  sortIndex,
  createdAt: 1_700_000_000_000 + sortIndex,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: `https://${id}.example.com`,
      ANTHROPIC_AUTH_TOKEN: `${id}-token`,
      ANTHROPIC_MODEL: `${id}-model`,
    },
  },
});

const seedClaudeProviders = () => {
  setProviders("claude", {
    "claude-alpha": claudeProvider("claude-alpha", "Claude Alpha", 0),
    "claude-beta": claudeProvider("claude-beta", "Claude Beta", 1),
  });
  setCurrentProviderId("claude", "claude-alpha");
};

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
        <SettingsPage open onOpenChange={() => {}} defaultTab="proxy" />
      </Suspense>
    </QueryClientProvider>,
  );
};

const openProxySection = async (user: ReturnType<typeof userEvent.setup>) => {
  renderSettingsPage();

  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "settings.tabProxy" })).toHaveAttribute(
      "data-state",
      "active",
    ),
  );

  await user.click(
    await screen.findByRole("button", {
      name: /settings\.advanced\.proxy\.title/,
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("代理服务")).toBeInTheDocument(),
  );
};

const openFailoverSection = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    screen.getByRole("button", {
      name: /settings\.advanced\.failover\.title/,
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("proxy.failoverQueue.title").length).toBeGreaterThan(
      0,
    ),
  );
};

const clickSwitchNear = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  index = 0,
) => {
  const container = screen.getAllByText(label)[index].closest("div");
  if (!container) throw new Error(`Switch container not found: ${label}`);
  let current: HTMLElement | null = container;
  let switchButton: HTMLElement | null = null;
  while (current && !switchButton) {
    switchButton = within(current).queryByRole("switch");
    current = current.parentElement;
  }
  if (!switchButton) throw new Error(`Switch not found near: ${label}`);
  await user.click(switchButton);
};

const expectClaudeLiveOnProxy = () => {
  expect(getSwitchLiveSettings("claude")).toMatchObject({
    env: {
      ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
    },
  });
};

const typeNumberInput = async (
  user: ReturnType<typeof userEvent.setup>,
  id: string,
  value: string,
) => {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Number input not found: ${id}`);
  await user.clear(input);
  await user.type(input, value);
};

const clickAutoFailoverSave = async (
  user: ReturnType<typeof userEvent.setup>,
) => {
  await user.click(
    screen.getByRole("button", { name: /^(common\.save|保存)$/ }),
  );
};

describe("SettingsPage with real Proxy and Failover panels", () => {
  beforeEach(() => {
    resetProviderState();
    seedClaudeProviders();
    setSettings({
      enableLocalProxy: false,
      proxyConfirmed: false,
      enableFailoverToggle: false,
      failoverConfirmed: false,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("keeps proxy takeover live config stable while enabling failover and editing the queue", async () => {
    const user = userEvent.setup();

    await openProxySection(user);

    await user.click(
      screen.getByRole("switch", {
        name: "settings.advanced.proxy.enableFeature",
      }),
    );
    await waitFor(() =>
      expect(getLastSettingsSaveRequest()).toMatchObject({
        enableLocalProxy: true,
      }),
    );

    await clickSwitchNear(user, "代理服务");
    await user.click(
      screen.getByRole("button", { name: "confirm.proxy.confirm" }),
    );

    await waitFor(() =>
      expect(screen.getByText("http://127.0.0.1:15721")).toBeInTheDocument(),
    );

    await clickSwitchNear(user, "claude");
    await waitFor(() =>
      expect(getProxyTakeoverStatusState().claude).toBe(true),
    );

    expect(getSwitchLiveSettings("claude")).toMatchObject({
      env: {
        ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      },
    });

    await openFailoverSection(user);
    await user.click(
      screen.getByRole("switch", {
        name: "settings.advanced.proxy.enableFailoverToggle",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "confirm.failover.confirm" }),
    );

    await waitFor(() =>
      expect(getLastSettingsSaveRequest()).toMatchObject({
        enableFailoverToggle: true,
        failoverConfirmed: true,
      }),
    );

    await user.click(screen.getByRole("tab", { name: "Claude" }));

    await user.click(
      screen.getByRole("switch", {
        name: "自动故障转移",
      }),
    );
    await waitFor(() => expect(getAutoFailoverEnabled("claude")).toBe(true));
    expect(getFailoverQueueState("claude").map((item) => item.providerId)).toEqual([
      "claude-alpha",
    ]);

    await user.click(
      screen.getByRole("combobox", {
        name: "选择供应商添加到队列",
      }),
    );
    await user.click(await screen.findByRole("option", { name: /Claude Beta/ }));
    await user.click(
      screen.getByRole("button", {
        name: "添加供应商到故障转移队列",
      }),
    );

    await waitFor(() =>
      expect(getFailoverQueueState("claude").map((item) => item.providerId)).toEqual([
        "claude-alpha",
        "claude-beta",
      ]),
    );

    const deleteButtonName = /^(common\.delete|删除)$/;
    const betaRow =
      screen
        .getAllByText("Claude Beta")
        .map((element) => {
          let current = element.parentElement;
          while (current && current !== document.body) {
            const deleteButtons = within(current).queryAllByRole("button", {
              name: deleteButtonName,
            });
            if (deleteButtons.length === 1) {
              return current;
            }
            current = current.parentElement;
          }
          return null;
        })
        .find((container): container is HTMLElement => container !== null) ??
      null;
    if (!betaRow) throw new Error("Claude Beta queue row not found");
    await user.click(
      within(betaRow).getAllByRole("button", {
        name: deleteButtonName,
      })[0],
    );

    await waitFor(() =>
      expect(getFailoverQueueState("claude").map((item) => item.providerId)).toEqual([
        "claude-alpha",
      ]),
    );

    expect(getSwitchLiveSettings("claude")).toMatchObject({
      env: {
        ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      },
    });
  }, 20_000);

  it("keeps Claude live config on the proxy endpoint after the failover queue becomes empty", async () => {
    const user = userEvent.setup();

    setProviders("claude", {
      "claude-alpha": claudeProvider("claude-alpha", "Claude Alpha", 0),
      "claude-beta": claudeProvider("claude-beta", "Claude Beta", 1),
      "claude-gamma": claudeProvider("claude-gamma", "Claude Gamma", 2),
    });
    setCurrentProviderId("claude", "claude-beta");
    setSettings({
      enableLocalProxy: true,
      proxyConfirmed: true,
      enableFailoverToggle: true,
      failoverConfirmed: true,
    });

    await openProxySection(user);

    await clickSwitchNear(user, "代理服务");
    await waitFor(() =>
      expect(screen.getByText("http://127.0.0.1:15721")).toBeInTheDocument(),
    );

    await clickSwitchNear(user, "claude");
    await waitFor(() =>
      expect(getProxyTakeoverStatusState().claude).toBe(true),
    );

    await openFailoverSection(user);
    await user.click(
      screen.getByRole("switch", {
        name: "settings.advanced.proxy.enableFailoverToggle",
      }),
    );

    await user.click(screen.getByRole("tab", { name: "Claude" }));
    await user.click(
      screen.getByRole("switch", {
        name: "自动故障转移",
      }),
    );

    await waitFor(() =>
      expect(getFailoverQueueState("claude").map((item) => item.providerId)).toEqual([
        "claude-beta",
      ]),
    );

    for (const providerName of ["Claude Alpha", "Claude Gamma"]) {
      await user.click(
        screen.getByRole("combobox", {
          name: "选择供应商添加到队列",
        }),
      );
      await user.click(await screen.findByRole("option", { name: new RegExp(providerName) }));
      await user.click(
        screen.getByRole("button", {
          name: "添加供应商到故障转移队列",
        }),
      );
    }

    await waitFor(() =>
      expect(getFailoverQueueState("claude").map((item) => item.providerId)).toEqual([
        "claude-alpha",
        "claude-beta",
        "claude-gamma",
      ]),
    );

    const deleteButtonName = /^(common\.delete|删除)$/;

    for (const providerName of ["Claude Alpha", "Claude Beta", "Claude Gamma"]) {
      const row =
        screen
          .getAllByText(providerName)
          .map((element) => {
            let current = element.parentElement;
            while (current && current !== document.body) {
              const deleteButtons = within(current).queryAllByRole("button", {
                name: deleteButtonName,
              });
              if (deleteButtons.length === 1) {
                return current;
              }
              current = current.parentElement;
            }
            return null;
          })
          .find((container): container is HTMLElement => container !== null) ?? null;
      if (!row) throw new Error(`${providerName} queue row not found`);
      await user.click(
        within(row).getAllByRole("button", {
          name: deleteButtonName,
        })[0],
      );
      await waitFor(() =>
        expect(
          getFailoverQueueState("claude").some(
            (item) => item.providerName === providerName,
          ),
        ).toBe(false),
      );
    }

    await waitFor(() => {
      expect(getFailoverQueueState("claude")).toEqual([]);
    });

    setSwitchLiveSettings(
      "claude",
      getProviders("claude")["claude-alpha"].settingsConfig,
    );
    expect(
      (getSwitchLiveSettings("claude") as { env?: Record<string, string> }).env
        ?.ANTHROPIC_BASE_URL,
    ).toBe("https://claude-alpha.example.com");

    await settingsApi.syncCurrentProvidersLive();

    await waitFor(() =>
      expect(getSwitchLiveSettings("claude")).toMatchObject({
        env: {
          ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
        },
      }),
    );
  }, 20_000);

  it("saves Claude auto failover timing and circuit breaker settings without drifting live config", async () => {
    const user = userEvent.setup();

    setSettings({
      enableLocalProxy: true,
      proxyConfirmed: true,
      enableFailoverToggle: true,
      failoverConfirmed: true,
    });
    setAppProxyConfigState({
      ...getAppProxyConfigState("claude"),
      enabled: true,
      autoFailoverEnabled: true,
    });
    startProxyServerState();

    await openProxySection(user);
    await waitFor(() =>
      expect(screen.getByText("http://127.0.0.1:15721")).toBeInTheDocument(),
    );

    await openFailoverSection(user);
    await user.click(screen.getByRole("tab", { name: "Claude" }));

    await typeNumberInput(user, "maxRetries-claude", "4");
    await typeNumberInput(user, "streamingFirstByte-claude", "45");
    await typeNumberInput(user, "streamingIdle-claude", "90");
    await typeNumberInput(user, "nonStreaming-claude", "180");
    await typeNumberInput(user, "failureThreshold-claude", "7");
    await typeNumberInput(user, "successThreshold-claude", "3");
    await typeNumberInput(user, "timeoutSeconds-claude", "75");
    await typeNumberInput(user, "errorRateThreshold-claude", "35");
    await typeNumberInput(user, "minRequests-claude", "12");

    await clickAutoFailoverSave(user);

    await waitFor(() =>
      expect(getAppProxyConfigState("claude")).toMatchObject({
        appType: "claude",
        enabled: true,
        autoFailoverEnabled: true,
        maxRetries: 4,
        streamingFirstByteTimeout: 45,
        streamingIdleTimeout: 90,
        nonStreamingTimeout: 180,
        circuitFailureThreshold: 7,
        circuitSuccessThreshold: 3,
        circuitTimeoutSeconds: 75,
        circuitErrorRateThreshold: 0.35,
        circuitMinRequests: 12,
      }),
    );
    expectClaudeLiveOnProxy();
  }, 20_000);

  it("blocks invalid Claude auto failover config saves and preserves live config", async () => {
    const user = userEvent.setup();

    setSettings({
      enableLocalProxy: true,
      proxyConfirmed: true,
      enableFailoverToggle: true,
      failoverConfirmed: true,
    });
    setAppProxyConfigState({
      ...getAppProxyConfigState("claude"),
      enabled: true,
      autoFailoverEnabled: true,
      maxRetries: 3,
      streamingFirstByteTimeout: 30,
      streamingIdleTimeout: 60,
      nonStreamingTimeout: 120,
      circuitFailureThreshold: 3,
      circuitSuccessThreshold: 2,
      circuitTimeoutSeconds: 60,
      circuitErrorRateThreshold: 0.5,
      circuitMinRequests: 5,
    });
    startProxyServerState();
    const previousConfig = getAppProxyConfigState("claude");

    await openProxySection(user);
    await waitFor(() =>
      expect(screen.getByText("http://127.0.0.1:15721")).toBeInTheDocument(),
    );

    await openFailoverSection(user);
    await user.click(screen.getByRole("tab", { name: "Claude" }));

    await typeNumberInput(user, "maxRetries-claude", "11");
    await clickAutoFailoverSave(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(getAppProxyConfigState("claude")).toEqual(previousConfig);
    expectClaudeLiveOnProxy();
  }, 20_000);
});
