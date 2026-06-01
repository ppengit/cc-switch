import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditProviderDialog } from "@/components/providers/EditProviderDialog";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";
import type { Provider } from "@/types";

let mockFormValues: ProviderFormValues | null;

const apiMocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  getLiveProviderSettings: vi.fn(),
  getOpenClawLiveProvider: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  providersApi: {
    getCurrent: apiMocks.getCurrent,
  },
  vscodeApi: {
    getLiveProviderSettings: apiMocks.getLiveProviderSettings,
  },
  openclawApi: {
    getLiveProvider: apiMocks.getOpenClawLiveProvider,
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
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
}));

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    initialData,
    onSubmit,
    isProxyTakeover,
  }: {
    initialData: {
      name?: string;
      websiteUrl?: string;
      notes?: string;
      settingsConfig?: Record<string, unknown>;
      meta?: Record<string, unknown>;
      icon?: string;
      iconColor?: string;
    };
    onSubmit: (values: ProviderFormValues) => void;
    isProxyTakeover?: boolean;
  }) => (
    <form
      id="provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(
          mockFormValues ?? {
            name: initialData.name ?? "",
            websiteUrl: initialData.websiteUrl ?? "",
            notes: initialData.notes,
            settingsConfig: JSON.stringify(initialData.settingsConfig ?? {}),
            meta: initialData.meta,
            icon: initialData.icon,
            iconColor: initialData.iconColor,
          },
        );
      }}
    >
      <output data-testid="settings-config">
        {JSON.stringify(initialData.settingsConfig ?? {})}
      </output>
      <output data-testid="is-proxy-takeover">
        {isProxyTakeover ? "true" : "false"}
      </output>
    </form>
  ),
}));

describe("EditProviderDialog", () => {
  beforeEach(() => {
    mockFormValues = null;
    apiMocks.getCurrent.mockReset();
    apiMocks.getLiveProviderSettings.mockReset();
    apiMocks.getOpenClawLiveProvider.mockReset();
  });

  it("编辑 Hermes 时允许用 providerKey 更新供应商 ID", async () => {
    mockFormValues = {
      name: "Updated Hermes Provider",
      websiteUrl: "https://hermes.example.com",
      settingsConfig: JSON.stringify({
        base_url: "https://hermes.example.com",
        api_key: "sk-hermes",
      }),
      providerKey: "hermes-provider-renamed",
    };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const handleOpenChange = vi.fn();

    render(
      <EditProviderDialog
        open
        provider={{
          id: "hermes-provider",
          name: "Hermes Provider",
          settingsConfig: {
            base_url: "https://old.example.com",
            api_key: "sk-old",
          },
        }}
        currentProviderId="hermes-provider"
        initialEnabledState={true}
        onOpenChange={handleOpenChange}
        onSubmit={handleSubmit}
        appId="hermes"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit).toHaveBeenCalledWith({
      provider: expect.objectContaining({
        id: "hermes-provider-renamed",
        name: "Updated Hermes Provider",
      }),
      originalId: "hermes-provider",
      saveOptions: {
        pinToTop: false,
        enabled: true,
      },
    });
    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  it("保留 Codex 数据库中的 modelCatalog，避免 live 配置缺字段时清空模型映射", async () => {
    const dbModelCatalog = {
      models: [
        {
          model: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          contextWindow: 1000000,
        },
      ],
    };
    const provider: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "aggregator",
      settingsConfig: {
        auth: {
          OPENAI_API_KEY: "db-key",
        },
        config: 'model_provider = "custom"\nmodel = "deepseek-v4-flash"\n',
        modelCatalog: dbModelCatalog,
      },
    };
    const liveSettings = {
      auth: {
        OPENAI_API_KEY: "live-key",
      },
      config: 'model_provider = "custom"\nmodel = "deepseek-v4-pro"\n',
    };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockResolvedValue(liveSettings);

    render(
      <EditProviderDialog
        open
        provider={provider}
        currentProviderId={provider.id}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="codex"
      />,
    );

    await waitFor(() => {
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual({
        ...liveSettings,
        modelCatalog: dbModelCatalog,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].provider.settingsConfig).toEqual({
      ...liveSettings,
      modelCatalog: dbModelCatalog,
    });
  });

  it("代理接管中编辑 Codex 供应商时展示数据库配置而不是读取 live 代理配置", async () => {
    const provider: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        auth: {
          OPENAI_API_KEY: "db-key",
        },
        config:
          'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.deepseek.com/v1"\n',
      },
    };

    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockResolvedValue({
      auth: {
        OPENAI_API_KEY: "PROXY_MANAGED",
      },
      config:
        'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\nexperimental_bearer_token = "PROXY_MANAGED"\n',
    });

    render(
      <EditProviderDialog
        open
        provider={provider}
        currentProviderId={provider.id}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        appId="codex"
        isProxyTakeover
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("is-proxy-takeover").textContent).toBe("true");
    });

    expect(apiMocks.getLiveProviderSettings).not.toHaveBeenCalled();
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
    ).toEqual(provider.settingsConfig);
  });
});
