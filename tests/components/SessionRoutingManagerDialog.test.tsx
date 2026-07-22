import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRoutingManagerDialog } from "@/components/proxy/SessionRoutingManagerDialog";

const mockSnapshot = vi.fn();
const mockRebind = vi.fn();

vi.mock("@/lib/query/proxy", () => ({
  useSessionRoutingSnapshot: (...args: unknown[]) => mockSnapshot(...args),
  useRebindSessionRoute: () => ({
    mutate: mockRebind,
    isPending: false,
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children, asChild }: any) =>
    asChild ? children : <button>{children}</button>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <button>{children}</button>,
  SelectValue: () => <span>value</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}));

const renderDialog = (
  onOpenChange = vi.fn(),
  appId: "codex" | "grokbuild" = "codex",
) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <SessionRoutingManagerDialog
        appId={appId}
        open={true}
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
};

describe("SessionRoutingManagerDialog", () => {
  beforeEach(() => {
    mockSnapshot.mockReset();
    mockRebind.mockReset();
  });

  it("explains why bindings are empty when proxy is stopped", () => {
    mockSnapshot.mockReturnValue({
      data: {
        appType: "codex",
        enabled: true,
        proxyRunning: false,
        clientSessionOnly: true,
        idleTtlSeconds: 600,
        bindings: [],
        providers: [],
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderDialog();

    expect(
      screen.getByText(/代理服务未运行。会话绑定只保存在运行中的代理内存里/i),
    ).toBeInTheDocument();
  });

  it("explains anonymous occupancy when client-session-only is enabled", () => {
    mockSnapshot.mockReturnValue({
      data: {
        appType: "codex",
        enabled: true,
        proxyRunning: true,
        clientSessionOnly: true,
        idleTtlSeconds: 600,
        bindings: [],
        providers: [
          {
            providerId: "p1",
            providerName: "Provider 1",
            sessionOccupancy: 0,
            anonymousOccupancy: 2,
            occupancy: 2,
            maxConcurrentRequests: null,
            inFailoverQueue: true,
          },
        ],
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderDialog();

    expect(
      screen.getByText(/当前有 2 个临时占用，但这些请求没有客户端显式会话 ID/i),
    ).toBeInTheDocument();
  });

  it("closes when clicking the close button", () => {
    const onOpenChange = vi.fn();
    mockSnapshot.mockReturnValue({
      data: {
        appType: "codex",
        enabled: true,
        proxyRunning: true,
        clientSessionOnly: false,
        idleTtlSeconds: 600,
        bindings: [],
        providers: [],
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderDialog(onOpenChange);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("loads and labels Grok Build session bindings", () => {
    mockSnapshot.mockReturnValue({
      data: {
        appType: "grokbuild",
        enabled: true,
        proxyRunning: true,
        clientSessionOnly: false,
        idleTtlSeconds: 600,
        bindings: [],
        providers: [],
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderDialog(vi.fn(), "grokbuild");

    expect(mockSnapshot).toHaveBeenCalledWith("grokbuild", true);
    expect(screen.getByText("Grok Build")).toBeInTheDocument();
  });
});
