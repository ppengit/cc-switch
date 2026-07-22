import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";

const toastErrorMock = vi.fn();
const getProviderDefaultTemplateMock = vi.fn();
const upsertUniversalProviderMock = vi.fn();
const providerFormPropsMock = vi.fn();
let mockProvidersData: { providers: Record<string, any> };
let mockFormValues: ProviderFormValues;

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}));

vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    isOpen,
    children,
    footer,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    isOpen ? (
      <div>
        {children}
        {footer}
      </div>
    ) : null,
}));

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: (props: {
    onSubmit: (values: ProviderFormValues) => void;
    providerDefaultSettingsConfig?: Record<string, unknown>;
  }) => {
    providerFormPropsMock(props);
    return (
      <form
        id="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit(mockFormValues);
        }}
      />
    );
  },
}));

vi.mock("@/lib/query", () => ({
  useProvidersQuery: () => ({ data: mockProvidersData }),
}));

vi.mock("@/lib/api", () => ({
  configApi: {
    getProviderDefaultTemplate: (...args: unknown[]) =>
      getProviderDefaultTemplateMock(...args),
  },
  universalProvidersApi: {
    upsert: (...args: unknown[]) => upsertUniversalProviderMock(...args),
  },
}));

describe("AddProviderDialog", () => {
  const renderWithQueryClient = (ui: React.ReactElement) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    return render(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    );
  };

  const renderDialog = async (
    onSubmit = vi.fn().mockResolvedValue(undefined),
  ) => {
    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="claude"
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("加载供应商模板中...")).not.toBeInTheDocument(),
    );

    return { onSubmit };
  };

  beforeEach(() => {
    toastErrorMock.mockReset();
    getProviderDefaultTemplateMock.mockReset();
    upsertUniversalProviderMock.mockReset();
    providerFormPropsMock.mockReset();
    getProviderDefaultTemplateMock.mockResolvedValue(null);
    upsertUniversalProviderMock.mockResolvedValue(true);
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

    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("加载供应商模板中...")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

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

    await renderDialog(handleSubmit);

    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

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

    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("加载供应商模板中...")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

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
    };

    await renderDialog(handleSubmit);

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.provider.addToLive).toBe(false);
    expect(submitted.saveOptions).toEqual({ pinToTop: false, enabled: false });
  });

  it("加载 Claude 供应商模板时将模型占位符真实写入 Claude 默认模型", async () => {
    getProviderDefaultTemplateMock.mockResolvedValue(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "{baseUrl}",
          ANTHROPIC_AUTH_TOKEN: "{apiKey}",
          ANTHROPIC_MODEL: "{model}",
        },
      }),
    );

    await renderDialog();

    await waitFor(() =>
      expect(providerFormPropsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerDefaultSettingsConfig: {
            env: {
              ANTHROPIC_BASE_URL: "",
              ANTHROPIC_AUTH_TOKEN: "",
              ANTHROPIC_MODEL: "claude-sonnet-4-6",
            },
          },
        }),
      ),
    );
  });

  it("加载 Grok Build 供应商模板时使用 Grok 默认模型", async () => {
    getProviderDefaultTemplateMock.mockResolvedValue(
      JSON.stringify({
        config: `[models]\ndefault = "{model}"\n\n[model."{model}"]\nmodel = "{model}"\nbase_url = "{baseUrl}"\napi_key = "{apiKey}"\napi_backend = "responses"\ncontext_window = 500000\n`,
      }),
    );

    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="grokbuild"
        onSubmit={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(providerFormPropsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerDefaultSettingsConfig: expect.objectContaining({
            config: expect.stringContaining('default = "grok-4.5"'),
          }),
        }),
      ),
    );
  });

  it("阻止 Grok Build 下相同 API 地址和 API Key 的供应商重复添加", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    mockProvidersData = {
      providers: {
        existing: {
          id: "existing",
          name: "Existing Grok",
          settingsConfig: {
            config: `[models]\ndefault = "grok-4.5"\n\n[model."grok-4.5"]\nmodel = "grok-4.5"\nbase_url = "https://grok.example.com/v1"\napi_key = "same-key"\napi_backend = "responses"\ncontext_window = 500000\n`,
          },
        },
      },
    };
    mockFormValues = {
      name: "Duplicate Grok",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        config: `[models]\ndefault = "grok-4.5"\n\n[model."grok-4.5"]\nmodel = "grok-4.5"\nbase_url = "https://grok.example.com/v1/"\napi_key = "same-key"\napi_backend = "responses"\ncontext_window = 500000\n`,
      }),
    };

    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="grokbuild"
        onSubmit={handleSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("加载供应商模板中...")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it("阻止 Grok Build 下相同 API 地址和 env_key 的供应商重复添加", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    mockProvidersData = {
      providers: {
        existing: {
          id: "existing",
          name: "Existing Grok Env",
          settingsConfig: {
            config: `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://grok.example.com/v1"
name = "Existing Grok Env"
env_key = "SHARED_GROK_KEY"
api_backend = "responses"
context_window = 500000
`,
          },
        },
      },
    };
    mockFormValues = {
      name: "Duplicate Grok Env",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        config: `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://grok.example.com/v1/"
name = "Duplicate Grok Env"
env_key = "SHARED_GROK_KEY"
api_backend = "responses"
context_window = 500000
`,
      }),
    };

    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="grokbuild"
        onSubmit={handleSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("加载供应商模板中...")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it("不把 Grok env_key 名称与同文本的内嵌 API Key 误判为重复", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    mockProvidersData = {
      providers: {
        existing: {
          id: "existing",
          name: "Existing Grok Env",
          settingsConfig: {
            config: `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://grok.example.com/v1"
name = "Existing Grok Env"
env_key = "SHARED_GROK_KEY"
api_backend = "responses"
context_window = 500000
`,
          },
        },
      },
    };
    mockFormValues = {
      name: "Inline Grok",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        config: `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://grok.example.com/v1"
name = "Inline Grok"
api_key = "SHARED_GROK_KEY"
api_backend = "responses"
context_window = 500000
`,
      }),
    };

    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="grokbuild"
        onSubmit={handleSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("加载供应商模板中...")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("新建 Grok Build 自定义供应商时不补默认 Grok 图标", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "tes 1",
      websiteUrl: "",
      icon: "",
      iconColor: "",
      settingsConfig: JSON.stringify({
        config: `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://grok.example.com/v1"
name = "tes 1"
api_key = "secret"
api_backend = "responses"
context_window = 500000
`,
      }),
    };

    renderWithQueryClient(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="grokbuild"
        onSubmit={handleSubmit}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("加载供应商模板中...")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.provider.icon).toBeUndefined();
    expect(submitted.provider.iconColor).toBeUndefined();
  });
});
