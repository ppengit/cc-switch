import "@testing-library/jest-dom";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { server } from "./msw/server";
import { resetProviderState } from "./msw/state";
import "./msw/tauriMocks";

const consoleDebugSpy = vi
  .spyOn(console, "debug")
  .mockImplementation(() => {});

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: { translation: {} },
      en: { translation: {} },
    },
    interpolation: {
      escapeValue: false,
    },
  });
});

afterEach(() => {
  cleanup();
  resetProviderState();
  server.resetHandlers();
  vi.clearAllMocks();
});

afterAll(() => {
  consoleDebugSpy.mockRestore();
  server.close();
});
