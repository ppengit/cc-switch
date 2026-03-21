import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  invokeWhenBridgeReady,
  isBridgeNotReadyError,
  listenWhenBridgeReady,
} from "@/lib/tauriBridge";

describe("tauriBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listenMock.mockReset();
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries bridge listeners until Tauri internals are ready", async () => {
    const unlisten = vi.fn();
    listenMock
      .mockRejectedValueOnce(
        new TypeError(
          "Cannot read properties of undefined (reading 'transformCallback')",
        ),
      )
      .mockResolvedValueOnce(unlisten);

    const promise = listenWhenBridgeReady("deeplink-import", vi.fn(), {
      attempts: 2,
      delayMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when invoke never gets a ready bridge", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValue(
      new TypeError(
        "Cannot read properties of undefined (reading 'transformCallback')",
      ),
    );

    const promise = invokeWhenBridgeReady("get_init_error", undefined, {
      attempts: 2,
      delayMs: 10,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("detects the known bridge-not-ready error shape", () => {
    expect(
      isBridgeNotReadyError(
        new TypeError(
          "Cannot read properties of undefined (reading 'transformCallback')",
        ),
      ),
    ).toBe(true);
    expect(isBridgeNotReadyError(new Error("boom"))).toBe(false);
  });
});
