import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  getStreamCheckConfigState,
  resetProviderState,
  setStreamCheckConfigState,
} from "../msw/state";

type FetchSpyLike = {
  mock: {
    calls: Array<[RequestInfo | URL, RequestInit?]>;
  };
};

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
        <SettingsPage open onOpenChange={() => {}} defaultTab="advanced" />
      </Suspense>
    </QueryClientProvider>,
  );
};

const getCommandBodies = (fetchSpy: FetchSpyLike, command: string) =>
  fetchSpy.mock.calls
    .filter(([input]) => String(input).endsWith(`/${command}`))
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")));

const getLastCommandBody = (fetchSpy: FetchSpyLike, command: string) => {
  const bodies = getCommandBodies(fetchSpy, command);
  return bodies.at(-1);
};

const openModelTestAccordion = async (
  user: ReturnType<typeof userEvent.setup>,
) => {
  const modelTestTrigger = screen
    .getByText("settings.advanced.modelTest.title")
    .closest("button");
  if (!modelTestTrigger) {
    throw new Error("Model test accordion trigger not found");
  }
  await user.click(modelTestTrigger);
  await waitFor(() =>
    expect(
      screen.getByLabelText("streamCheck.claudeModel"),
    ).toBeInTheDocument(),
  );
};

const getModelTestPanelRoot = () => {
  const heading = screen.getByText("streamCheck.checkParams");
  const root = heading.parentElement?.parentElement;
  if (!root) {
    throw new Error("Model test panel root not found");
  }
  return root as HTMLElement;
};

describe("SettingsPage with real ModelTestConfigPanel", () => {
  beforeEach(() => {
    resetProviderState();
    setStreamCheckConfigState({
      timeoutSecs: 45,
      maxRetries: 2,
      degradedThresholdMs: 6000,
      claudeModel: "claude-haiku-4-5-20251001",
      codexModel: "gpt-5.5@low",
      geminiModel: "gemini-3-flash-preview",
      testPrompt: "Who are you?",
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("loads, edits, and saves model test config through the real advanced settings entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "settings.tabAdvanced" }),
      ).toHaveAttribute("data-state", "active"),
    );

    await openModelTestAccordion(user);

    const claudeModelInput = screen.getByLabelText("streamCheck.claudeModel");
    const codexModelInput = screen.getByLabelText("streamCheck.codexModel");
    const geminiModelInput = screen.getByLabelText("streamCheck.geminiModel");
    const timeoutInput = screen.getByLabelText("streamCheck.timeout");
    const maxRetriesInput = screen.getByLabelText("streamCheck.maxRetries");
    const degradedThresholdInput = screen.getByLabelText(
      "streamCheck.degradedThreshold",
    );
    const promptInput = screen.getByLabelText("streamCheck.testPrompt");

    expect(claudeModelInput).toHaveValue("claude-haiku-4-5-20251001");
    expect(codexModelInput).toHaveValue("gpt-5.5@low");
    expect(geminiModelInput).toHaveValue("gemini-3-flash-preview");
    expect(timeoutInput).toHaveValue(45);
    expect(maxRetriesInput).toHaveValue(2);
    expect(degradedThresholdInput).toHaveValue(6000);
    expect(promptInput).toHaveValue("Who are you?");

    await user.clear(claudeModelInput);
    await user.type(claudeModelInput, "claude-opus-4-20260101");
    await user.clear(codexModelInput);
    await user.type(codexModelInput, "gpt-5.5@high");
    await user.clear(geminiModelInput);
    await user.type(geminiModelInput, "gemini-3-pro");
    await user.clear(timeoutInput);
    await user.type(timeoutInput, "60");
    await user.clear(maxRetriesInput);
    await user.type(maxRetriesInput, "4");
    await user.clear(degradedThresholdInput);
    await user.type(degradedThresholdInput, "9000");
    await user.clear(promptInput);
    await user.type(promptInput, "Return health check.");

    await user.click(
      within(getModelTestPanelRoot()).getByRole("button", {
        name: "common.save",
      }),
    );

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "save_stream_check_config")).toEqual(
        {
          config: {
            timeoutSecs: 60,
            maxRetries: 4,
            degradedThresholdMs: 9000,
            claudeModel: "claude-opus-4-20260101",
            codexModel: "gpt-5.5@high",
            geminiModel: "gemini-3-pro",
            testPrompt: "Return health check.",
          },
        },
      ),
    );

    await waitFor(() =>
      expect(getStreamCheckConfigState()).toEqual({
        timeoutSecs: 60,
        maxRetries: 4,
        degradedThresholdMs: 9000,
        claudeModel: "claude-opus-4-20260101",
        codexModel: "gpt-5.5@high",
        geminiModel: "gemini-3-pro",
        testPrompt: "Return health check.",
      }),
    );
  });

  it("falls back to default numeric values and prompt when inputs are cleared", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderSettingsPage();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "settings.tabAdvanced" }),
      ).toHaveAttribute("data-state", "active"),
    );

    await openModelTestAccordion(user);

    const timeoutInput = screen.getByLabelText("streamCheck.timeout");
    const maxRetriesInput = screen.getByLabelText("streamCheck.maxRetries");
    const degradedThresholdInput = screen.getByLabelText(
      "streamCheck.degradedThreshold",
    );
    const promptInput = screen.getByLabelText("streamCheck.testPrompt");

    await user.clear(timeoutInput);
    await user.clear(maxRetriesInput);
    await user.clear(degradedThresholdInput);
    await user.clear(promptInput);

    await user.click(
      within(getModelTestPanelRoot()).getByRole("button", {
        name: "common.save",
      }),
    );

    await waitFor(() =>
      expect(getLastCommandBody(fetchSpy, "save_stream_check_config")).toEqual(
        {
          config: {
            timeoutSecs: 45,
            maxRetries: 2,
            degradedThresholdMs: 6000,
            claudeModel: "claude-haiku-4-5-20251001",
            codexModel: "gpt-5.5@low",
            geminiModel: "gemini-3-flash-preview",
            testPrompt: "Who are you?",
          },
        },
      ),
    );

    await waitFor(() =>
      expect(getStreamCheckConfigState()).toEqual({
        timeoutSecs: 45,
        maxRetries: 2,
        degradedThresholdMs: 6000,
        claudeModel: "claude-haiku-4-5-20251001",
        codexModel: "gpt-5.5@low",
        geminiModel: "gemini-3-flash-preview",
        testPrompt: "Who are you?",
      }),
    );
  });
});
