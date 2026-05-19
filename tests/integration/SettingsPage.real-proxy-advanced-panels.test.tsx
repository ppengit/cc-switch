import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { resetProviderState, setSettings } from "../msw/state";
import { server } from "../msw/server";

const TAURI_ENDPOINT = "http://tauri.local";
const translationMocks = vi.hoisted(() => ({
  changeLanguage: vi.fn(),
  i18n: {
    language: "zh",
    changeLanguage: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    i18n: translationMocks.i18n,
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

const openProxySection = async (
  user: ReturnType<typeof userEvent.setup>,
  titlePattern: RegExp,
) => {
  renderSettingsPage();

  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "settings.tabProxy" })).toHaveAttribute(
      "data-state",
      "active",
    ),
  );

  await user.click(
    await screen.findByRole("button", {
      name: titlePattern,
    }),
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

describe("SettingsPage real proxy advanced panels", () => {
  beforeEach(() => {
    translationMocks.i18n.changeLanguage.mockReset();
    resetProviderState();
    setSettings({
      enableLocalProxy: false,
      proxyConfirmed: false,
      enableFailoverToggle: false,
      failoverConfirmed: false,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("loads and updates rectifier plus optimizer config through the real proxy tab entry", async () => {
    const user = userEvent.setup();
    let rectifierConfig = {
      enabled: true,
      requestThinkingSignature: true,
      requestThinkingBudget: true,
    };
    let optimizerConfig = {
      enabled: false,
      thinkingOptimizer: true,
      cacheInjection: true,
      cacheTtl: "1h",
    };
    const rectifierSaves: Array<Record<string, unknown>> = [];
    const optimizerSaves: Array<Record<string, unknown>> = [];

    server.use(
      http.post(`${TAURI_ENDPOINT}/get_rectifier_config`, () =>
        HttpResponse.json(rectifierConfig),
      ),
      http.post(`${TAURI_ENDPOINT}/set_rectifier_config`, async ({ request }) => {
        const payload = (await request.json()) as { config: typeof rectifierConfig };
        rectifierConfig = payload.config;
        rectifierSaves.push(payload.config);
        return HttpResponse.json(null);
      }),
      http.post(`${TAURI_ENDPOINT}/get_optimizer_config`, () =>
        HttpResponse.json(optimizerConfig),
      ),
      http.post(`${TAURI_ENDPOINT}/set_optimizer_config`, async ({ request }) => {
        const payload = (await request.json()) as { config: typeof optimizerConfig };
        optimizerConfig = payload.config;
        optimizerSaves.push(payload.config);
        return HttpResponse.json(null);
      }),
    );

    await openProxySection(user, /settings\.advanced\.rectifier\.title/);

    expect(
      await screen.findByText("settings.advanced.rectifier.enabled"),
    ).toBeInTheDocument();

    await clickSwitchNear(user, "settings.advanced.rectifier.enabled");
    await clickSwitchNear(user, "settings.advanced.optimizer.enabled");

    const ttlSelect = await screen.findByRole("combobox");
    fireEvent.change(ttlSelect, { target: { value: "5m" } });

    await waitFor(() =>
      expect(rectifierSaves).toContainEqual({
        enabled: false,
        requestThinkingSignature: true,
        requestThinkingBudget: true,
      }),
    );
    await waitFor(() =>
      expect(optimizerSaves).toContainEqual({
        enabled: true,
        thinkingOptimizer: true,
        cacheInjection: true,
        cacheTtl: "1h",
      }),
    );
    await waitFor(() =>
      expect(optimizerSaves).toContainEqual({
        enabled: true,
        thinkingOptimizer: true,
        cacheInjection: true,
        cacheTtl: "5m",
      }),
    );
  });

  it("loads, scans, tests, and saves global outbound proxy through the real proxy tab entry", async () => {
    const user = userEvent.setup();
    let savedUrl = "http://127.0.0.1:7890";
    const savedUrls: string[] = [];
    const testedUrls: string[] = [];
    let scanCallCount = 0;

    server.use(
      http.post(`${TAURI_ENDPOINT}/get_global_proxy_url`, () =>
        HttpResponse.json(savedUrl),
      ),
      http.post(`${TAURI_ENDPOINT}/set_global_proxy_url`, async ({ request }) => {
        const payload = (await request.json()) as { url: string };
        savedUrl = payload.url;
        savedUrls.push(payload.url);
        return HttpResponse.json(null);
      }),
      http.post(`${TAURI_ENDPOINT}/test_proxy_url`, async ({ request }) => {
        const payload = (await request.json()) as { url: string };
        testedUrls.push(payload.url);
        return HttpResponse.json({
          success: true,
          latencyMs: 18,
          error: null,
        });
      }),
      http.post(`${TAURI_ENDPOINT}/scan_local_proxies`, () => {
        scanCallCount += 1;
        return HttpResponse.json([
          {
            url: "http://127.0.0.1:9090",
            proxyType: "http",
            port: 9090,
          },
        ]);
      }),
    );

    await openProxySection(user, /settings\.advanced\.globalProxy\.title/);

    const urlInput = await screen.findByPlaceholderText(
      "http://127.0.0.1:7890 / socks5://127.0.0.1:1080",
    );

    await waitFor(() => expect(urlInput).toHaveValue("http://127.0.0.1:7890/"));

    await user.click(screen.getByTitle("settings.globalProxy.scan"));
    await user.click(await screen.findByRole("button", { name: "http://127.0.0.1:9090" }));

    fireEvent.change(screen.getByPlaceholderText("settings.globalProxy.username"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByPlaceholderText("settings.globalProxy.password"), {
      target: { value: "secret" },
    });

    await user.click(screen.getByTitle("settings.globalProxy.test"));
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(scanCallCount).toBe(1));
    await waitFor(() =>
      expect(testedUrls).toEqual(["http://alice:secret@127.0.0.1:9090/"]),
    );
    await waitFor(() =>
      expect(savedUrls).toEqual(["http://alice:secret@127.0.0.1:9090/"]),
    );
  });
});
