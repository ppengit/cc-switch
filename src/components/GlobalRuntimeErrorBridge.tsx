import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

export const GLOBAL_RUNTIME_ERROR_EVENT = "cc-switch-runtime-error";

export interface GlobalRuntimeErrorDetail {
  message: string;
  source?: string;
}

const MAX_DESCRIPTION_LENGTH = 500;

const normalizeErrorDescription = (message: string): string => {
  const trimmed = message.trim();
  if (trimmed.length <= MAX_DESCRIPTION_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_DESCRIPTION_LENGTH)}...`;
};

const isIgnorableRuntimeError = (message: string): boolean => {
  return (
    message.includes("ResizeObserver loop limit exceeded") ||
    message.includes(
      "ResizeObserver loop completed with undelivered notifications",
    )
  );
};

export function emitGlobalRuntimeError(detail: GlobalRuntimeErrorDetail): void {
  window.dispatchEvent(
    new CustomEvent<GlobalRuntimeErrorDetail>(GLOBAL_RUNTIME_ERROR_EVENT, {
      detail,
    }),
  );
}

export function GlobalRuntimeErrorBridge() {
  const { t } = useTranslation();
  const lastErrorRef = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const handleRuntimeError = (event: Event) => {
      const customEvent = event as CustomEvent<GlobalRuntimeErrorDetail>;
      const message = String(customEvent.detail?.message ?? "").trim();
      const source = customEvent.detail?.source?.trim();

      if (!message || isIgnorableRuntimeError(message)) {
        return;
      }

      const errorKey = `${source ?? "runtime"}::${message}`;
      const now = Date.now();
      if (
        lastErrorRef.current &&
        lastErrorRef.current.key === errorKey &&
        now - lastErrorRef.current.at < 3000
      ) {
        return;
      }
      lastErrorRef.current = { key: errorKey, at: now };

      toast.error(
        t("errors.runtimeUnhandledTitle", {
          defaultValue: "运行时发生异常",
        }),
        {
          description: normalizeErrorDescription(message),
          closeButton: true,
          duration: 10000,
        },
      );
    };

    window.addEventListener(
      GLOBAL_RUNTIME_ERROR_EVENT,
      handleRuntimeError as EventListener,
    );
    return () => {
      window.removeEventListener(
        GLOBAL_RUNTIME_ERROR_EVENT,
        handleRuntimeError as EventListener,
      );
    };
  }, [t]);

  return null;
}
