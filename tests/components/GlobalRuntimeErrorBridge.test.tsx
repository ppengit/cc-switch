import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppProviders } from "@/AppProviders";
import {
  emitGlobalRuntimeError,
  GLOBAL_RUNTIME_ERROR_EVENT,
} from "@/components/GlobalRuntimeErrorBridge";

const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
  },
  Toaster: () => <div data-testid="toaster" />,
}));

describe("GlobalRuntimeErrorBridge", () => {
  beforeEach(() => {
    toastError.mockReset();
  });

  it("keeps the app mounted and shows a toast for runtime errors", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <AppProviders client={client}>
        <div>runtime-ready</div>
      </AppProviders>,
    );

    expect(screen.getByText("runtime-ready")).toBeInTheDocument();

    act(() => {
      emitGlobalRuntimeError({
        message: "测试运行时错误",
        source: GLOBAL_RUNTIME_ERROR_EVENT,
      });
    });

    expect(screen.getByText("runtime-ready")).toBeInTheDocument();
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toContain("运行时发生异常");
  });
});
