import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import { sessionsApi } from "@/lib/api/sessions";
import type { SessionMessage, SessionMeta } from "@/types";
import { setSessionFixtures } from "../msw/state";

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

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SessionManagerPage appId="codex" />
      </QueryClientProvider>,
    ),
  };
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

const closeSearch = () => {
  const closeButton = Array.from(screen.getAllByRole("button")).find((button) =>
    button.querySelector(".lucide-x"),
  );

  if (!closeButton) {
    throw new Error("Search close button not found");
  }

  fireEvent.click(closeButton);
};

const seedProjectSessions = () => {
  const sessions: SessionMeta[] = [
    {
      providerId: "codex",
      sessionId: "alpha-1",
      title: "Alpha One",
      projectDir: "/workspace/alpha",
      createdAt: 3,
      lastActiveAt: 30,
      sourcePath: "/workspace/alpha/session-1.jsonl",
      resumeCommand: "codex resume alpha-1",
    },
    {
      providerId: "codex",
      sessionId: "alpha-2",
      title: "Alpha Two",
      projectDir: "/workspace/alpha",
      createdAt: 2,
      lastActiveAt: 20,
      sourcePath: "/workspace/alpha/session-2.jsonl",
      resumeCommand: "codex resume alpha-2",
    },
    {
      providerId: "codex",
      sessionId: "beta-1",
      title: "Beta One",
      projectDir: "/workspace/beta",
      createdAt: 1,
      lastActiveAt: 10,
      sourcePath: "/workspace/beta/session-1.jsonl",
      resumeCommand: "codex resume beta-1",
    },
  ];
  const messages: Record<string, SessionMessage[]> = {
    "codex:/workspace/alpha/session-1.jsonl": [
      { role: "user", content: "alpha one", ts: 30 },
    ],
    "codex:/workspace/alpha/session-2.jsonl": [
      { role: "user", content: "alpha two", ts: 20 },
    ],
    "codex:/workspace/beta/session-1.jsonl": [
      { role: "user", content: "beta one", ts: 10 },
    ],
  };

  setSessionFixtures(sessions, messages);
};

const seedWindowsProjectSessions = () => {
  const sessions: SessionMeta[] = [
    {
      providerId: "codex",
      sessionId: "win-1",
      title: "Windows One",
      projectDir: "C:\\Repo\\App\\",
      createdAt: 3,
      lastActiveAt: 30,
      sourcePath: "C:\\Repo\\App\\session-1.jsonl",
      resumeCommand: "codex resume win-1",
    },
    {
      providerId: "codex",
      sessionId: "win-2",
      title: "Windows Two",
      projectDir: "c:/repo/app",
      createdAt: 2,
      lastActiveAt: 20,
      sourcePath: "c:/repo/app/session-2.jsonl",
      resumeCommand: "codex resume win-2",
    },
    {
      providerId: "codex",
      sessionId: "win-3",
      title: "Windows Three",
      projectDir: "C:/Repo/App//",
      createdAt: 1,
      lastActiveAt: 10,
      sourcePath: "C:/Repo/App/session-3.jsonl",
      resumeCommand: "codex resume win-3",
    },
  ];
  const messages: Record<string, SessionMessage[]> = {
    "codex:C:\\Repo\\App\\session-1.jsonl": [
      { role: "user", content: "one", ts: 30 },
    ],
    "codex:c:/repo/app/session-2.jsonl": [
      { role: "user", content: "two", ts: 20 },
    ],
    "codex:C:/Repo/App/session-3.jsonl": [
      { role: "user", content: "three", ts: 10 },
    ],
  };

  setSessionFixtures(sessions, messages);
};

const seedWindowsUncProjectSessions = () => {
  const sessions: SessionMeta[] = [
    {
      providerId: "codex",
      sessionId: "unc-1",
      title: "UNC One",
      projectDir: "\\\\Server\\Share\\Repo\\",
      createdAt: 2,
      lastActiveAt: 20,
      sourcePath: "\\\\Server\\Share\\Repo\\session-1.jsonl",
      resumeCommand: "codex resume unc-1",
    },
    {
      providerId: "codex",
      sessionId: "unc-2",
      title: "UNC Two",
      projectDir: "//server/share/repo",
      createdAt: 1,
      lastActiveAt: 10,
      sourcePath: "//server/share/repo/session-2.jsonl",
      resumeCommand: "codex resume unc-2",
    },
  ];
  const messages: Record<string, SessionMessage[]> = {
    "codex:\\\\Server\\Share\\Repo\\session-1.jsonl": [
      { role: "user", content: "one", ts: 20 },
    ],
    "codex://server/share/repo/session-2.jsonl": [
      { role: "user", content: "two", ts: 10 },
    ],
  };

  setSessionFixtures(sessions, messages);
};

describe("SessionManagerPage", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();

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

  it("groups the session list by project directory and collapses a project group", async () => {
    seedProjectSessions();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Alpha One")).toBeInTheDocument(),
    );

    const alphaGroup = screen.getByRole("button", {
      name: /^alpha 2$/i,
      expanded: true,
    });
    const betaGroup = screen.getByRole("button", {
      name: /^beta 1$/i,
      expanded: true,
    });

    expect(alphaGroup).toBeInTheDocument();
    expect(betaGroup).toBeInTheDocument();

    fireEvent.click(alphaGroup);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Alpha Two/i }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Beta One/i })).toBeVisible();

    fireEvent.click(alphaGroup);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Alpha Two/i })).toBeVisible(),
    );
  });

  it("keeps the session list title row separate from filter controls", async () => {
    seedProjectSessions();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Alpha One")).toBeInTheDocument(),
    );

    const titleRow = screen.getByTestId("session-list-title-row");
    const filterRow = screen.getByTestId("session-list-filter-row");
    const projectFilter = screen.getByRole("combobox", {
      name: /项目筛选|sessionManager\.projectFilter/,
    });

    expect(
      within(titleRow).getByText("sessionManager.sessionList"),
    ).toBeVisible();
    expect(filterRow).toContainElement(projectFilter);
    expect(titleRow).not.toContainElement(projectFilter);
  });

  it("shows a single project icon in the project filter trigger", async () => {
    seedProjectSessions();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Alpha One")).toBeInTheDocument(),
    );

    const projectFilter = screen.getByRole("combobox", {
      name: /项目筛选|sessionManager\.projectFilter/,
    });

    expect(projectFilter.querySelectorAll(".lucide-folder-open")).toHaveLength(
      1,
    );
  });

  it("emphasizes project names in the session tree", async () => {
    seedProjectSessions();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Alpha One")).toBeInTheDocument(),
    );

    const alphaGroup = screen.getByRole("button", {
      name: /^alpha 2$/i,
      expanded: true,
    });
    const alphaLabel = within(alphaGroup).getByTitle("/workspace/alpha");

    expect(alphaLabel).toHaveClass("font-semibold");
    expect(alphaLabel).toHaveClass("text-foreground");
  });

  it("uses consistent sizing with distinct colors for session detail actions", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    const renameButton = screen.getByRole("button", { name: /修改名称/i });
    const resumeButton = screen.getByRole("button", { name: /恢复会话/i });
    const exportButton = screen.getByRole("button", { name: /导出会话/i });
    const deleteButton = screen.getByRole("button", { name: /删除会话/i });
    const buttons = [renameButton, resumeButton, exportButton, deleteButton];

    buttons.forEach((button) => {
      expect(button).toHaveClass("h-8");
      expect(button).toHaveClass("gap-1.5");
      expect(button).toHaveClass("border");
    });
    expect(renameButton.className).toContain("violet");
    expect(resumeButton.className).toContain("emerald");
    expect(exportButton.className).toContain("sky");
    expect(deleteButton.className).toContain("rose");
  });

  it("filters sessions by a deduplicated project directory dropdown", async () => {
    seedProjectSessions();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Alpha One")).toBeInTheDocument(),
    );

    const projectFilter = screen.getByRole("combobox", {
      name: /项目筛选|sessionManager\.projectFilter/,
    });
    fireEvent.pointerDown(projectFilter, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.keyDown(projectFilter, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /beta/i }));

    await waitFor(() =>
      expect(screen.queryByText("Alpha One")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Alpha Two")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Beta One/i })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^beta 1$/i, expanded: true }),
    ).toBeVisible();
  });

  it("deduplicates equivalent Windows project paths in groups and filter options", async () => {
    seedWindowsProjectSessions();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Windows One")).toBeInTheDocument(),
    );

    expect(
      screen.getByRole("button", { name: /^App 3$/i, expanded: true }),
    ).toBeVisible();

    const projectFilter = screen.getByRole("combobox", {
      name: /项目筛选|sessionManager\.projectFilter/,
    });
    fireEvent.pointerDown(projectFilter, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.keyDown(projectFilter, { key: "ArrowDown" });

    await waitFor(() =>
      expect(screen.getAllByRole("option", { name: /App/i })).toHaveLength(1),
    );
    expect(screen.getByRole("option", { name: /App.*3/i })).toBeVisible();
  });

  it("deduplicates equivalent Windows UNC project paths", async () => {
    seedWindowsUncProjectSessions();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("UNC One")).toBeInTheDocument(),
    );

    expect(
      screen.getByRole("button", { name: /^Repo 2$/i, expanded: true }),
    ).toBeVisible();

    const projectFilter = screen.getByRole("combobox", {
      name: /项目筛选|sessionManager\.projectFilter/,
    });
    fireEvent.pointerDown(projectFilter, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.keyDown(projectFilter, { key: "ArrowDown" });

    await waitFor(() =>
      expect(screen.getAllByRole("option", { name: /Repo/i })).toHaveLength(1),
    );
    expect(screen.getByRole("option", { name: /Repo.*2/i })).toBeVisible();
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
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
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

  it("restores batch delete controls when deleteMany rejects", async () => {
    const deleteManySpy = vi
      .spyOn(sessionsApi, "deleteMany")
      .mockRejectedValueOnce(new Error("network error"));

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("network error"),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /批量删除/i }),
      ).not.toBeDisabled(),
    );

    deleteManySpy.mockRestore();
  });

  it("keeps the exit batch mode button visible when search hides all sessions", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "NoSuchSession" },
    });

    await waitFor(() => expect(screen.queryByText("Alpha Session")).toBeNull());

    expect(screen.getByRole("button", { name: /退出批量管理/i })).toBeVisible();
  });

  it("drops hidden selections when search narrows the result set", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));

    expect(screen.getByText("已选 2 项")).toBeInTheDocument();

    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument(),
    );

    closeSearch();

    await waitFor(() =>
      expect(screen.getByText("已选 1 项")).toBeInTheDocument(),
    );
  });

  it("removes successfully deleted sessions from the UI before refetch completes", async () => {
    const view = renderPage();
    let resolveInvalidate!: () => void;
    const invalidateSpy = vi
      .spyOn(view.client, "invalidateQueries")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInvalidate = () => resolve(undefined);
          }),
      );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveInvalidate();
    });
    invalidateSpy.mockRestore();
  });
});
