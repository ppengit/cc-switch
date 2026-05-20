import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
import type { AppId } from "@/lib/api";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const renderProviderForm = (name = "Old Provider") => {
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

  it("saves and reloads maxSessions in edit mode", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    const initialData = {
      name: "Scaled Provider",
      websiteUrl: "https://scaled.example.com",
      notes: "scaled notes",
      category: "third_party" as const,
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://scaled.example.com/v1",
          ANTHROPIC_AUTH_TOKEN: "sk-scaled",
          ANTHROPIC_MODEL: "claude-scaled",
        },
      },
      meta: {
        maxSessions: 3,
      },
    };

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="claude"
          providerId="claude-provider"
          submitLabel="Save"
          onSubmit={onSubmit}
          onCancel={onCancel}
          initialData={initialData}
        />
      </QueryClientProvider>,
    );

    const maxSessionsInput = screen.getByLabelText(
      "最大会话数",
    ) as HTMLInputElement;
    expect(maxSessionsInput.value).toBe("3");

    fireEvent.change(maxSessionsInput, { target: { value: "5" } });
    expect(maxSessionsInput.value).toBe("5");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.maxSessions).toBe(5);

    view.rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderForm
          appId="claude"
          providerId="claude-provider"
          submitLabel="Save"
          onSubmit={onSubmit}
          onCancel={onCancel}
          initialData={{
            ...initialData,
            meta: {
              maxSessions: 5,
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("最大会话数")).toHaveValue(5);
  });

  it("omits maxSessions when an existing value is cleared in edit mode", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="claude"
          providerId="claude-provider"
          submitLabel="Save"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Cleared Provider",
            websiteUrl: "https://cleared.example.com",
            category: "third_party",
            settingsConfig: {
              env: {
                ANTHROPIC_BASE_URL: "https://cleared.example.com/v1",
                ANTHROPIC_AUTH_TOKEN: "sk-cleared",
                ANTHROPIC_MODEL: "claude-cleared",
              },
            },
            meta: {
              maxSessions: 4,
            },
          }}
        />
      </QueryClientProvider>,
    );

    const maxSessionsInput = screen.getByLabelText("最大会话数");
    fireEvent.change(maxSessionsInput, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.maxSessions).toBeUndefined();
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

  it("keeps maxSessions empty by default and omits it from the submitted payload", async () => {
    const { onSubmit } = renderCreateProviderForm("claude");

    const maxSessionsInput = screen.getByLabelText("最大会话数");
    const maxSessionsLabel = screen.getByText("最大会话数");
    expect(maxSessionsInput).toHaveValue(null);
    expect(maxSessionsLabel).toHaveClass("whitespace-nowrap");
    expect(maxSessionsInput.parentElement).toHaveClass(
      "flex",
      "flex-nowrap",
      "items-center",
      "gap-3",
    );
    expect(maxSessionsInput).toHaveClass("w-40", "shrink-0");

    await submitCreateForm({ confirmSoftIssues: true });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.maxSessions).toBeUndefined();
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

  it("shows and submits maxSessions for OpenClaw create mode", async () => {
    const { onSubmit } = renderCreateProviderForm("openclaw");

    const maxSessionsInput = screen.getByLabelText("最大会话数");
    expect(maxSessionsInput).toBeInTheDocument();

    fireEvent.change(maxSessionsInput, { target: { value: "4" } });

    await submitCreateForm({
      providerKeyInputId: "openclaw-key",
      providerKey: "openclaw-new",
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.maxSessions).toBe(4);
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

    fireEvent.change(screen.getByDisplayValue("gpt-5.5"), {
      target: { value: "provider-model" },
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
