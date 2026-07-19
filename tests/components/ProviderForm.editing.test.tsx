import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
import type { AppId } from "@/lib/api";
import type { ProviderMeta } from "@/types";
import { setSettings } from "../msw/state";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
    language = "json",
  }: {
    value: string;
    onChange: (value: string) => void;
    language?: string;
  }) => (
    <textarea
      aria-label={`json-editor-${language}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const renderProviderForm = (
  name = "Old Provider",
  meta?: Partial<ProviderMeta>,
) => {
  const queryClient = createTestQueryClient();
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProviderForm
        appId="claude"
        providerId="claude-provider"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={onCancel}
        initialData={{
          name,
          websiteUrl: "https://old.example.com",
          notes: "old notes",
          category: "third_party",
          settingsConfig: {
            env: {
              ANTHROPIC_BASE_URL: "https://old.example.com/v1",
              ANTHROPIC_AUTH_TOKEN: "sk-old",
              ANTHROPIC_MODEL: "claude-old",
            },
          },
          meta,
        }}
      />
    </QueryClientProvider>,
  );

  return { ...view, onSubmit, onCancel };
};

const codexSettingsConfig = (options?: {
  providerName?: string;
  baseUrl?: string;
  modelProvider?: string;
}) => ({
  auth: { OPENAI_API_KEY: "sk-old" },
  config: [
    `model_provider = "${options?.modelProvider ?? "custom"}"`,
    'model = "gpt-5.4"',
    "",
    `[model_providers.${options?.modelProvider ?? "custom"}]`,
    `name = "${options?.providerName ?? "AIHubMix"}"`,
    `base_url = "${options?.baseUrl ?? "https://api.example.com/v1"}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n"),
});

const renderCodexProviderForm = (options?: {
  providerId?: string;
  name?: string;
  settingsConfig?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}) => {
  const queryClient = createTestQueryClient();
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProviderForm
        appId="codex"
        providerId={options?.providerId ?? "codex-provider"}
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={onCancel}
        initialData={{
          name: options?.name ?? "Codex Provider",
          websiteUrl: "https://old.example.com",
          category: "third_party",
          settingsConfig: options?.settingsConfig ?? codexSettingsConfig(),
          meta: options?.meta,
        }}
      />
    </QueryClientProvider>,
  );

  return { ...view, onSubmit, onCancel };
};

describe("ProviderForm edit mode", () => {
  it("keeps user edits when parent rerenders with the same provider id", () => {
    const view = renderProviderForm();

    const nameInput = screen.getByLabelText("provider.name");
    fireEvent.change(nameInput, { target: { value: "Typing Provider" } });
    expect(nameInput).toHaveValue("Typing Provider");

    view.rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderForm
          appId="claude"
          providerId="claude-provider"
          submitLabel="Save"
          onSubmit={view.onSubmit}
          onCancel={view.onCancel}
          initialData={{
            name: "Old Provider",
            websiteUrl: "https://old.example.com",
            notes: "old notes",
            category: "third_party",
            settingsConfig: {
              env: {
                ANTHROPIC_BASE_URL: "https://old.example.com/v1",
                ANTHROPIC_AUTH_TOKEN: "sk-old",
                ANTHROPIC_MODEL: "claude-old",
              },
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("provider.name")).toHaveValue(
      "Typing Provider",
    );
  });

  it("does not let website/API endpoint sync trim a full Codex endpoint while editing", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();
    const fullEndpoint = "https://api.xn--chy-js0fk50c.top/v1/chat/completions";

    render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="codex"
          providerId="codex-provider"
          submitLabel="Save"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Codex Provider",
            websiteUrl: "https://old.example.com",
            category: "third_party",
            settingsConfig: {
              auth: { OPENAI_API_KEY: "sk-old" },
              config: [
                'model_provider = "custom"',
                'model = "gpt-5.4"',
                "",
                "[model_providers.custom]",
                'name = "custom"',
                `base_url = "${fullEndpoint}"`,
                'wire_api = "responses"',
                "requires_openai_auth = true",
                "",
              ].join("\n"),
            },
          }}
        />
      </QueryClientProvider>,
    );

    const endpointInput = await screen.findByDisplayValue(fullEndpoint);
    expect(endpointInput).toHaveValue(fullEndpoint);
    expect(screen.getByLabelText("provider.websiteUrl")).toHaveValue(
      "https://old.example.com",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.config).toContain(`base_url = "${fullEndpoint}"`);
    expect(submitted.websiteUrl).toBe("https://old.example.com");
    expect(submitted.meta?.isFullUrl).toBe(true);
  });

  it("keeps Codex config edits when parent rerenders with the same provider id", async () => {
    const view = renderCodexProviderForm();

    const configEditor = (await screen.findByLabelText(
      "json-editor-javascript",
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(configEditor.value).toContain('model = "gpt-5.4"'),
    );

    fireEvent.change(configEditor, {
      target: {
        value: configEditor.value.replace(
          'model = "gpt-5.4"',
          'model = "edited-model"',
        ),
      },
    });
    expect(configEditor.value).toContain('model = "edited-model"');

    view.rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderForm
          appId="codex"
          providerId="codex-provider"
          submitLabel="Save"
          onSubmit={view.onSubmit}
          onCancel={view.onCancel}
          initialData={{
            name: "Codex Provider",
            websiteUrl: "https://old.example.com",
            category: "third_party",
            settingsConfig: codexSettingsConfig(),
          }}
        />
      </QueryClientProvider>,
    );

    expect(
      (screen.getByLabelText("json-editor-javascript") as HTMLTextAreaElement)
        .value,
    ).toContain('model = "edited-model"');
  });

  it("drops the removed Codex features strip-path when saving legacy metadata", async () => {
    const { onSubmit } = renderCodexProviderForm({
      meta: {
        quirks: {
          strip_paths: ["config.toml:features", "body:debug"],
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.quirks?.strip_paths).toEqual([
      "body:debug",
    ]);
  });

  it("preserves Codex request model routes while their enable switch is off", async () => {
    const { onSubmit } = renderCodexProviderForm({
      meta: {
        codexModelRoutesEnabled: false,
        codexModelRoutes: {
          "gpt-5.5": { model: "deepseek-v4-pro" },
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta).toMatchObject({
      codexModelRoutesEnabled: false,
      codexModelRoutes: {
        "gpt-5.5": { model: "deepseek-v4-pro" },
      },
    });
  });

  it("keeps legacy Codex request model routes disabled when the enable flag is missing", async () => {
    const { onSubmit } = renderCodexProviderForm({
      meta: {
        codexModelRoutes: {
          "gpt-5.5": { model: "deepseek-v4-pro" },
        },
      },
    });

    expect(
      screen.getByRole("switch", { name: "请求模型映射" }),
    ).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta).toMatchObject({
      codexModelRoutesEnabled: false,
      codexModelRoutes: {
        "gpt-5.5": { model: "deepseek-v4-pro" },
      },
    });
  });

  it("keeps a draft Codex request model route when it temporarily matches an existing route", async () => {
    setSettings({ commonConfigConfirmed: true });

    const { onSubmit } = renderCodexProviderForm({
      meta: {
        codexModelRoutesEnabled: true,
        codexModelRoutes: {
          "gpt-5.5": { model: "deepseek-v4-pro" },
        },
      },
    });

    await screen.findByDisplayValue("gpt-5.5");

    fireEvent.click(screen.getByRole("button", { name: "添加映射" }));

    let requestInputs = screen.getAllByLabelText(
      "请求模型",
    ) as HTMLInputElement[];
    expect(requestInputs).toHaveLength(2);

    fireEvent.change(requestInputs[1], { target: { value: "gpt-5.5" } });
    requestInputs = screen.getAllByLabelText("请求模型") as HTMLInputElement[];
    expect(requestInputs).toHaveLength(2);
    expect(requestInputs[1]).toHaveValue("gpt-5.5");

    fireEvent.change(requestInputs[1], {
      target: { value: "gpt-5.5-mini" },
    });
    const upstreamInputs = screen.getAllByLabelText(
      "上游模型",
    ) as HTMLInputElement[];
    fireEvent.change(upstreamInputs[1], {
      target: { value: "deepseek-v4-mini" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.codexModelRoutes).toEqual({
      "gpt-5.5": { model: "deepseek-v4-pro" },
      "gpt-5.5-mini": { model: "deepseek-v4-mini" },
    });
  });

  it("saves Claude admission retry enable state and retry interval from the form", async () => {
    const { onSubmit } = renderProviderForm();

    fireEvent.click(screen.getByText("上游入场重试"));
    fireEvent.click(screen.getByRole("switch", { name: "启用入场重试" }));
    fireEvent.change(screen.getByLabelText("重试间隔（毫秒）"), {
      target: { value: "45000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      onSubmit.mock.calls[0][0].meta?.upstreamAdmissionRetry,
    ).toMatchObject({
      enabled: true,
      maxDelayMs: 45000,
    });
  });

  it("preserves Claude admission retry fixed interval scheduling from the form", async () => {
    const { onSubmit } = renderProviderForm("Old Provider", {
      upstreamAdmissionRetry: {
        enabled: true,
        scheduleMode: "fixedInterval",
        initialDelayMs: 1000,
        maxDelayMs: 1000,
        jitterMs: 100,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      onSubmit.mock.calls[0][0].meta?.upstreamAdmissionRetry,
    ).toMatchObject({
      enabled: true,
      scheduleMode: "fixedInterval",
      initialDelayMs: 1000,
      maxDelayMs: 1000,
      jitterMs: 100,
    });
  });

  it("saves Claude admission retry success notification toggle from the form", async () => {
    const { onSubmit } = renderProviderForm();

    fireEvent.click(screen.getByText("上游入场重试"));
    fireEvent.click(
      screen.getByRole("switch", { name: "成功通知（弹窗+声音）" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      onSubmit.mock.calls[0][0].meta?.upstreamAdmissionRetry,
    ).toMatchObject({
      notifyOnSuccess: true,
    });
  });

  it("saves Codex admission retry enable state and retry interval from the form", async () => {
    const { onSubmit } = renderCodexProviderForm();

    fireEvent.click(screen.getByText("上游入场重试"));
    fireEvent.click(screen.getByRole("switch", { name: "启用入场重试" }));
    fireEvent.change(screen.getByLabelText("重试间隔（毫秒）"), {
      target: { value: "45000" },
    });
    expect(
      screen.queryByText(
        "包含上游格式、模型目录、请求模型映射、思考能力与自定义 User-Agent。",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      onSubmit.mock.calls[0][0].meta?.upstreamAdmissionRetry,
    ).toMatchObject({
      enabled: true,
      maxDelayMs: 45000,
    });
  });

  it("saves Codex transient response replay rules and timing", async () => {
    const { onSubmit } = renderCodexProviderForm();

    fireEvent.click(screen.getByText("错误响应重放"));
    fireEvent.click(screen.getByRole("switch", { name: "启用错误响应重放" }));
    fireEvent.change(screen.getByLabelText("最大重放次数"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("重放等待（毫秒）"), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByLabelText("匹配状态码"), {
      target: { value: "400, 409" },
    });
    fireEvent.change(screen.getByLabelText("匹配端点"), {
      target: { value: "/responses\n/responses/compact" },
    });
    fireEvent.change(screen.getByLabelText("匹配关键词组"), {
      target: {
        value: "provider_busy && please retry\ninvalid character",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.upstreamResponseReplay).toEqual({
      enabled: true,
      retryHttp429: true,
      retryCodexConfiguredErrors: true,
      codexMatchStatuses: [400, 409],
      codexMatchEndpoints: ["/responses", "/responses/compact"],
      codexMatchKeywordGroups: [
        ["provider_busy", "please retry"],
        ["invalid character"],
      ],
      maxRetries: 3,
      initialDelayMs: 150,
      maxDelayMs: 5000,
      jitterMs: 100,
      honorRetryAfter: true,
    });
  });

  it("preserves an explicitly empty Codex matcher variable", async () => {
    const { onSubmit } = renderCodexProviderForm();

    fireEvent.click(screen.getByText("错误响应重放"));
    fireEvent.click(screen.getByRole("switch", { name: "启用错误响应重放" }));
    fireEvent.change(screen.getByLabelText("匹配状态码"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      onSubmit.mock.calls[0][0].meta?.upstreamResponseReplay,
    ).toMatchObject({
      enabled: true,
      codexMatchStatuses: [],
    });
  });
});

describe("ProviderForm create mode", () => {
  const renderCreateProviderForm = (appId: AppId) => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId={appId}
          submitLabel="Save"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    return { onSubmit };
  };

  const submitCreateForm = async (options?: {
    providerKeyInputId?: string;
    providerKey?: string;
    confirmSoftIssues?: boolean;
  }) => {
    if (options?.providerKeyInputId) {
      fireEvent.change(document.getElementById(options.providerKeyInputId)!, {
        target: { value: options.providerKey ?? "new-provider" },
      });
    }
    fireEvent.change(screen.getByLabelText("provider.name"), {
      target: { value: "New Provider" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    if (options?.confirmSoftIssues) {
      const confirmButton = await screen.findByRole("button", {
        name: "仍要保存",
      });
      await waitFor(() => expect(confirmButton).toBeEnabled());
      fireEvent.click(confirmButton);
    }
  };

  it("submits the Codex default model as a real value instead of an empty placeholder", async () => {
    const { onSubmit } = renderCreateProviderForm("codex");

    await submitCreateForm({ confirmSoftIssues: true });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.config).toContain('model = "gpt-5.5"');
    expect(settingsConfig.config).not.toContain('model = ""');
    expect(settingsConfig.config).not.toContain("{model}");
  });

  it("submits the Claude default model as a real value instead of an empty placeholder", async () => {
    const { onSubmit } = renderCreateProviderForm("claude");

    await submitCreateForm({ confirmSoftIssues: true });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(settingsConfig.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "claude-sonnet-4-6",
    );
    expect(settingsConfig.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(settingsConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      "claude-opus-4-7",
    );
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("submits the Gemini default model as a real value instead of an empty placeholder", async () => {
    const { onSubmit } = renderCreateProviderForm("gemini");

    await submitCreateForm({ confirmSoftIssues: true });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.env.GEMINI_MODEL).toBe("gemini-3.1-pro-preview");
    expect(settingsConfig.config.model.name).toBe("gemini-3.1-pro-preview");
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("submits the OpenCode default model as a real value instead of an empty placeholder", async () => {
    const { onSubmit } = renderCreateProviderForm("opencode");

    await submitCreateForm({
      providerKeyInputId: "opencode-key",
      providerKey: "opencode-new",
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.models["gpt-5.5"]).toEqual({ name: "GPT-5.5" });
    expect(
      Object.prototype.hasOwnProperty.call(settingsConfig.models, ""),
    ).toBe(false);
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("submits the OpenClaw default model as a real value instead of an empty placeholder", async () => {
    const { onSubmit } = renderCreateProviderForm("openclaw");

    await submitCreateForm({
      providerKeyInputId: "openclaw-key",
      providerKey: "openclaw-new",
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.models[0].id).toBe("gpt-5.5");
    expect(
      settingsConfig.models.map((model: { id?: string }) => model.id),
    ).not.toContain("");
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("submits the Hermes default model as a real value instead of an empty placeholder", async () => {
    const { onSubmit } = renderCreateProviderForm("hermes");

    await submitCreateForm({
      providerKeyInputId: "hermes-key",
      providerKey: "hermes-new",
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.models[0].id).toBe("openai/gpt-5.5");
    expect(
      settingsConfig.models.map((model: { id?: string }) => model.id),
    ).not.toContain("");
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("updates the Codex default model in place without keeping an empty model", async () => {
    const { onSubmit } = renderCreateProviderForm("codex");

    const configEditor = screen.getByLabelText(
      "json-editor-javascript",
    ) as HTMLTextAreaElement;
    fireEvent.change(configEditor, {
      target: {
        value: configEditor.value.replace(
          'model = "gpt-5.5"',
          'model = "provider-model"',
        ),
      },
    });
    await submitCreateForm({ confirmSoftIssues: true });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.config).toContain('model = "provider-model"');
    expect(settingsConfig.config).not.toContain('model = ""');
    expect(settingsConfig.config).not.toContain("{model}");
  });

  it("updates the Gemini default model in env and settings without keeping an empty model", async () => {
    const { onSubmit } = renderCreateProviderForm("gemini");

    fireEvent.change(screen.getByDisplayValue("gemini-3.1-pro-preview"), {
      target: { value: "provider-model" },
    });
    await submitCreateForm({ confirmSoftIssues: true });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.env.GEMINI_MODEL).toBe("provider-model");
    expect(settingsConfig.config.model.name).toBe("provider-model");
    expect(settingsConfig.env.GEMINI_MODEL).not.toBe("");
    expect(settingsConfig.config.model.name).not.toBe("");
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("renames the OpenCode default model instead of keeping an empty model key", async () => {
    const { onSubmit } = renderCreateProviderForm("opencode");
    const modelInput = screen.getByDisplayValue("gpt-5.5");

    fireEvent.change(modelInput, { target: { value: "provider-model" } });
    fireEvent.blur(modelInput);
    await submitCreateForm({
      providerKeyInputId: "opencode-key",
      providerKey: "opencode-new",
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.models["provider-model"]).toEqual({
      name: "GPT-5.5",
    });
    expect(Object.keys(settingsConfig.models)).not.toContain("");
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("updates the OpenClaw default model row without keeping an empty model id", async () => {
    const { onSubmit } = renderCreateProviderForm("openclaw");

    fireEvent.change(screen.getByDisplayValue("gpt-5.5"), {
      target: { value: "provider-model" },
    });
    await submitCreateForm({
      providerKeyInputId: "openclaw-key",
      providerKey: "openclaw-new",
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.models[0].id).toBe("provider-model");
    expect(
      settingsConfig.models.map((model: { id?: string }) => model.id),
    ).not.toContain("");
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });

  it("updates the Hermes default model row without keeping an empty model id", async () => {
    const { onSubmit } = renderCreateProviderForm("hermes");

    fireEvent.change(screen.getByDisplayValue("openai/gpt-5.5"), {
      target: { value: "openai/provider-model" },
    });
    await submitCreateForm({
      providerKeyInputId: "hermes-key",
      providerKey: "hermes-new",
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    const settingsConfig = JSON.parse(submitted.settingsConfig);
    expect(settingsConfig.models[0].id).toBe("openai/provider-model");
    expect(
      settingsConfig.models.map((model: { id?: string }) => model.id),
    ).not.toContain("");
    expect(JSON.stringify(settingsConfig)).not.toContain("{model}");
  });
});
