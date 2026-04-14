import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";

const DEFAULT_RETRY_DELAY_MS = 125;
const DEFAULT_RETRY_ATTEMPTS = 40;

interface BridgeRetryOptions {
  attempts?: number;
  delayMs?: number;
  label?: string;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export const isBridgeNotReadyError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("transformcallback") ||
    message.includes("__tauri_internals__") ||
    message.includes("cannot read properties of undefined")
  );
};

export const runWhenBridgeReady = async <T>(
  task: () => Promise<T>,
  options: BridgeRetryOptions = {},
): Promise<T | undefined> => {
  const {
    attempts = DEFAULT_RETRY_ATTEMPTS,
    delayMs = DEFAULT_RETRY_DELAY_MS,
    label = "tauri bridge task",
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isBridgeNotReadyError(error)) {
        throw error;
      }
      await delay(delayMs);
    }
  }

  console.warn(
    `[tauri-bridge] Skipping ${label}; bridge never became ready.`,
    lastError,
  );
  return undefined;
};

export const listenWhenBridgeReady = async <T>(
  event: string,
  handler: EventCallback<T>,
  options: BridgeRetryOptions = {},
): Promise<UnlistenFn | null> => {
  const result = await runWhenBridgeReady(() => listen<T>(event, handler), {
    ...options,
    label: options.label ?? `event listener ${event}`,
  });

  return result ?? null;
};

export const invokeWhenBridgeReady = async <T>(
  command: string,
  args?: Record<string, unknown>,
  options: BridgeRetryOptions = {},
): Promise<T | undefined> => {
  return runWhenBridgeReady(() => invoke<T>(command, args), {
    ...options,
    label: options.label ?? `command ${command}`,
  });
};
