import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "@/App";
import { AppProviders } from "@/AppProviders";
import {
  getAppProxyConfig,
  resetProviderState,
  setAppProxyConfig,
  switchSessionProviderBinding,
} from "../msw/state";

const renderApp = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <AppProviders client={client}>
      <App />
    </AppProviders>,
  );
};

describe("App full render", () => {
  beforeEach(() => {
    resetProviderState();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("renders the real provider list without crashing", async () => {
    renderApp();

    await waitFor(() => {
      expect(screen.getByText("Claude Default")).toBeInTheDocument();
    });

    expect(screen.getByText("Claude Custom")).toBeInTheDocument();
  });

  it("renders provider occupancy badges without crashing the tooltip tree", async () => {
    const appProxyConfig = getAppProxyConfig("claude");
    setAppProxyConfig("claude", {
      ...appProxyConfig,
      sessionRoutingEnabled: true,
    });
    switchSessionProviderBinding("claude", "session-1", "claude-1");
    renderApp();

    await waitFor(() => {
      expect(screen.getByText("占用 1")).toBeInTheDocument();
    });

    expect(screen.getByText("Claude Default")).toBeInTheDocument();
  });
});
