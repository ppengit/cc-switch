import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";

const toastErrorMock = vi.fn();
let mockProvidersData: { providers: Record<string, any> };

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

let mockFormValues: ProviderFormValues;

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    onSubmit,
  }: {
    onSubmit: (values: ProviderFormValues) => void;
  }) => (
    <form
      id="provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(mockFormValues);
      }}
    />
  ),
}));

vi.mock("@/lib/query", () => ({
  useProvidersQuery: () => ({ data: mockProvidersData }),
}));

describe("AddProviderDialog", () => {
  beforeEach(() => {
    toastErrorMock.mockReset();
    mockProvidersData = { providers: {} };
    mockFormValues = {
      name: "Test Provider",
      websiteUrl: "https://provider.example.com",
      settingsConfig: JSON.stringify({ env: {}, config: {} }),
      meta: {
        custom_endpoints: {
          "https://api.new-endpoint.com": {
            url: "https://api.new-endpoint.com",
            addedAt: 1,
          },
        },
      },
    };
  });

  it("使用 ProviderForm 返回的自定义端点", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const handleOpenChange = vi.fn();

    render(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.provider.meta?.custom_endpoints).toEqual(
      mockFormValues.meta?.custom_endpoints,
    );
    expect(submitted.saveOptions).toEqual({ pinToTop: true, enabled: true });
    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  it("在缺少自定义端点时回退到配置中的 baseUrl", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "Base URL Provider",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://claude.base" },
        config: {},
      }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.provider.meta?.custom_endpoints).toEqual({
      "https://claude.base": {
        url: "https://claude.base",
        addedAt: expect.any(Number),
        lastUsed: undefined,
      },
    });
  });

  it("阻止同一应用下请求地址和 API Key 重复的供应商", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const handleOpenChange = vi.fn();

    mockProvidersData = {
      providers: {
        existing: {
          id: "existing",
          name: "Existing Provider",
          settingsConfig: {
            env: {
              ANTHROPIC_BASE_URL: "https://api.example.com/v1/",
              ANTHROPIC_AUTH_TOKEN: "sk-same",
            },
          },
        },
      },
    };
    mockFormValues = {
      name: "Duplicate Provider",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-same",
        },
        config: {},
      }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(handleSubmit).not.toHaveBeenCalled();
    expect(handleOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("在未勾选启用时向上层传递 addToLive=false", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "Disabled Provider",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://disabled.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-disabled",
        },
        config: {},
      }),
      enableOnSave: false,
      pinToTopOnSave: false,
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.provider.addToLive).toBe(false);
    expect(submitted.saveOptions).toEqual({ pinToTop: false, enabled: false });
  });
});
