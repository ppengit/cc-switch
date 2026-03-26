import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import type { Provider, SessionMessage, SessionMeta } from "@/types";
import {
  addToFailoverQueueState,
  setAppProxyConfig,
  setProviderHealthState,
  setProviders,
  setSessionFixtures,
  switchSessionProviderBinding,
} from "../msw/state";

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectContext = React.createContext<{
    onValueChange?: (value: string) => void;
  }>({});

  return {
    Select: ({
      value: _value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (value: string) => void;
      children: React.ReactNode;
    }) => (
      <SelectContext.Provider value={{ onValueChange }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: React.forwardRef(
      (
        { children, ...props }: any,
        ref: React.ForwardedRef<HTMLButtonElement>,
      ) => (
        <button ref={ref} type="button" role="combobox" {...props}>
          {children}
        </button>
      ),
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => {
      const { onValueChange } = React.useContext(SelectContext);
      return (
        <button type="button" onClick={() => onValueChange?.(value)}>
          {children}
        </button>
      );
    },
  };
});

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/sessions/SessionToc", () => ({
  SessionTocSidebar: () => null,
  SessionTocDialog: () => null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{message}</div>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onCancel}>{cancelText}</button>
      </div>
    ) : null,
}));

const renderPage = (
  props?: Partial<ComponentProps<typeof SessionManagerPage>>,
) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <SessionManagerPage appId="codex" {...props} />
    </QueryClientProvider>,
  );
};

const openSearch = () => {
  const searchButton = Array.from(screen.getAllByRole("button")).find(
    (button) => button.querySelector(".lucide-search"),
  );

  if (!searchButton) {
    throw new Error("Search button not found");
  }

  fireEvent.click(searchButton);
};

describe("SessionManagerPage", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();

    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-session-1",
        title: "Alpha Session",
        summary: "Alpha summary",
        projectDir: "/mock/codex",
        createdAt: 2,
        lastActiveAt: 20,
        sourcePath: "/mock/codex/session-1.jsonl",
        resumeCommand: "codex resume codex-session-1",
      },
      {
        providerId: "codex",
        sessionId: "codex-session-2",
        title: "Beta Session",
        summary: "Beta summary",
        projectDir: "/mock/codex",
        createdAt: 1,
        lastActiveAt: 10,
        sourcePath: "/mock/codex/session-2.jsonl",
        resumeCommand: "codex resume codex-session-2",
      },
    ];
    const messages: Record<string, SessionMessage[]> = {
      "codex:/mock/codex/session-1.jsonl": [
        { role: "user", content: "alpha", ts: 20 },
      ],
      "codex:/mock/codex/session-2.jsonl": [
        { role: "user", content: "beta", ts: 10 },
      ],
    };

    setSessionFixtures(sessions, messages);
  });

  it("deletes the selected session and selects the next visible session", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Alpha Session/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /删除会话/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Beta Session" }),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("removes a deleted session from filtered search results", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    openSearch();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(screen.getAllByText("Alpha Session")).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /删除会话/i }));

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(
      screen.getByText("sessionManager.selectSession"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("sessionManager.emptySession"),
    ).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("filters out disabled, degraded, unhealthy, and full providers from session binding switcher", async () => {
    const providers: Record<string, Provider> = {
      healthy: {
        id: "healthy",
        name: "Healthy Provider",
        settingsConfig: {},
        inFailoverQueue: true,
        isPublic: true,
      },
      degraded: {
        id: "degraded",
        name: "Degraded Provider",
        settingsConfig: {},
        inFailoverQueue: true,
      },
      disabled: {
        id: "disabled",
        name: "Disabled Provider",
        settingsConfig: {},
        inFailoverQueue: false,
      },
      unhealthy: {
        id: "unhealthy",
        name: "Open Circuit Provider",
        settingsConfig: {},
        inFailoverQueue: true,
      },
      full: {
        id: "full",
        name: "Full Provider",
        settingsConfig: {},
        inFailoverQueue: true,
      },
    };

    setProviders("codex", providers);
    setAppProxyConfig("codex", {
      appType: "codex",
      enabled: false,
      forceModelEnabled: false,
      forceModel: "",
      autoFailoverEnabled: true,
      maxRetries: 3,
      streamingFirstByteTimeout: 30,
      streamingIdleTimeout: 30,
      nonStreamingTimeout: 60,
      circuitFailureThreshold: 3,
      circuitSuccessThreshold: 2,
      circuitTimeoutSeconds: 60,
      circuitErrorRateThreshold: 50,
      circuitMinRequests: 5,
      zeroTokenAnomalyEnabled: false,
      zeroTokenAnomalyThreshold: 3,
      sessionRoutingEnabled: true,
      sessionRoutingStrategy: "priority",
      sessionDefaultProviderId: "",
      sessionMaxSessionsPerProvider: 1,
      sessionAllowSharedWhenExhausted: false,
      sessionIdleTtlMinutes: 30,
    });
    addToFailoverQueueState("codex", "healthy");
    addToFailoverQueueState("codex", "degraded");
    addToFailoverQueueState("codex", "unhealthy");
    addToFailoverQueueState("codex", "full");
    setProviderHealthState("codex", "healthy", { is_healthy: true });
    setProviderHealthState("codex", "degraded", {
      is_healthy: true,
      consecutive_failures: 1,
    });
    setProviderHealthState("codex", "unhealthy", {
      is_healthy: false,
      consecutive_failures: 3,
    });
    setProviderHealthState("codex", "full", { is_healthy: true });
    switchSessionProviderBinding("codex", "codex-session-1", "healthy", false);
    switchSessionProviderBinding("codex", "occupied-by-full", "full", false);

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("combobox", { name: /选择提供商/i }));

    await waitFor(() =>
      expect(screen.getByText("Healthy Provider")).toBeInTheDocument(),
    );
    expect(screen.getAllByText("public").length).toBeGreaterThan(0);
    expect(screen.queryByText("Disabled Provider")).not.toBeInTheDocument();
    expect(screen.queryByText("Degraded Provider")).not.toBeInTheDocument();
    expect(screen.queryByText("Open Circuit Provider")).not.toBeInTheDocument();
    expect(screen.queryByText("Full Provider")).not.toBeInTheDocument();
  });

  it("syncs the selected specific app back to the parent state", async () => {
    const handleAppChange = vi.fn();

    renderPage({ onAppChange: handleAppChange });

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.mouseDown(screen.getAllByRole("combobox")[0]);

    fireEvent.click(screen.getByText("Claude Code"));

    await waitFor(() => {
      expect(handleAppChange).toHaveBeenCalledWith("claude");
    });
  });
});
