import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { GrokBuildProviderForm } from "@/components/providers/forms/GrokBuildProviderForm";

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="raw-config"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

describe("GrokBuildProviderForm", () => {
  it("offers Codex-compatible provider presets and applies one", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /PatewayAI/ }));

    const baseUrlInput =
      container.querySelector<HTMLInputElement>("#codexBaseUrl");
    const nameInput =
      container.querySelector<HTMLInputElement>('input[name="name"]');
    expect(baseUrlInput?.value).toBe("https://api.pateway.ai/v1");
    expect(nameInput?.value).toBe("PatewayAI");
  });

  it("submits a complete config.toml payload with Grok defaults", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    const nameInput =
      container.querySelector<HTMLInputElement>('input[name="name"]');
    const baseUrlInput =
      container.querySelector<HTMLInputElement>("#codexBaseUrl");
    expect(nameInput).not.toBeNull();
    expect(baseUrlInput).not.toBeNull();

    fireEvent.change(nameInput!, { target: { value: "Example Relay" } });
    fireEvent.change(baseUrlInput!, {
      target: { value: "https://relay.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "secret-key" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.icon).toBe("");
    const settings = JSON.parse(submitted.settingsConfig);
    const config = parseToml(settings.config) as any;

    expect(config.models.default).toBe("grok-4.5");
    expect(config.model["grok-4.5"]).toEqual({
      model: "grok-4.5",
      base_url: "https://relay.example.com/v1",
      name: "Example Relay",
      api_key: "secret-key",
      api_backend: "responses",
      context_window: 500000,
    });
  });

  it("uses the provider default settings template when creating a Grok provider", () => {
    const config = `[models]
default = "grok-template"

[model."grok-template"]
model = "grok-template"
base_url = "https://template.example.com/v1"
name = "Template Relay"
api_key = "template-key"
api_backend = "responses"
context_window = 128000
`;

    const { container } = render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
        providerDefaultSettingsConfig={{ config }}
      />,
    );

    expect(
      container.querySelector<HTMLInputElement>("#grokbuild-profile"),
    ).toHaveValue("grok-template");
    expect(
      container.querySelector<HTMLInputElement>("#codexBaseUrl"),
    ).toHaveValue("https://template.example.com/v1");
  });

  it("uses config.toml api_backend when legacy metadata disagrees", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const config = `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://relay.example.com/v1"
name = "Relay"
api_key = "secret-key"
api_backend = "responses"
context_window = 500000
`;

    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
        initialData={{
          name: "Relay",
          settingsConfig: { config },
          meta: { apiFormat: "openai_chat" },
        }}
      />,
    );

    expect(
      screen.getByDisplayValue("responses"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].meta.apiFormat).toBe(
      "openai_responses",
    );
  });

  it("saves shared routing, replay, concurrency, and pricing metadata", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const config = `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://relay.example.com/v1"
name = "Relay"
api_key = "secret-key"
api_backend = "responses"
context_window = 500000
`;

    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
        initialData={{
          name: "Relay",
          settingsConfig: { config },
          meta: {
            upstreamAdmissionRetry: {
              enabled: true,
              maxRetries: 7,
              initialDelayMs: 1000,
              maxDelayMs: 2000,
              jitterMs: 50,
            },
            upstreamResponseReplay: {
              enabled: true,
              maxRetries: 3,
              initialDelayMs: 100,
              maxDelayMs: 1000,
              jitterMs: 20,
            },
            maxConcurrentRequests: 4,
            costMultiplier: "1.25",
            pricingModelSource: "response",
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const meta = onSubmit.mock.calls[0][0].meta;
    expect(meta.upstreamAdmissionRetry).toMatchObject({
      enabled: true,
      maxRetries: 7,
      jitterMs: 50,
    });
    expect(meta.upstreamResponseReplay).toMatchObject({
      enabled: true,
      maxRetries: 3,
      jitterMs: 20,
    });
    expect(meta.maxConcurrentRequests).toBe(4);
    expect(meta.costMultiplier).toBe("1.25");
    expect(meta.pricingModelSource).toBe("response");
  });

  it("keeps api_backend and apiFormat synchronized and hides the Codex-only model catalog switch", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(
      container.querySelector<HTMLInputElement>("#grokbuild-api-backend")!,
      {
        target: { value: "chat_completions" },
      },
    );
    fireEvent.change(
      container.querySelector<HTMLInputElement>('input[name="name"]')!,
      {
        target: { value: "Chat Relay" },
      },
    );
    fireEvent.change(
      container.querySelector<HTMLInputElement>("#codexBaseUrl")!,
      {
        target: { value: "https://chat.example.com/v1" },
      },
    );
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "chat-key" },
    });

    const advancedToggle = screen.getByRole("button", { name: "高级选项" });
    if (advancedToggle.getAttribute("data-state") !== "open") {
      await user.click(advancedToggle);
    }
    expect(screen.queryByText("需要本地路由映射")).not.toBeInTheDocument();
    expect(screen.getByText("思考能力")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].meta.apiFormat).toBe("openai_chat");
    const settings = JSON.parse(onSubmit.mock.calls[0][0].settingsConfig);
    const parsed = parseToml(settings.config) as any;
    expect(parsed.model[parsed.models.default].api_backend).toBe(
      "chat_completions",
    );
  });

  it("maps Chat Completions presets into Grok api_backend", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /BytePlus/ }));
    await user.type(screen.getByLabelText("API Key"), "secret-key");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0];
    const settings = JSON.parse(submitted.settingsConfig);
    const config = parseToml(settings.config) as any;
    expect(submitted.meta.apiFormat).toBe("openai_chat");
    expect(config.model[config.models.default].api_backend).toBe(
      "chat_completions",
    );
  });

  it("removes protocol-specific metadata when switching back to Responses", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const config = `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://relay.example.com/v1"
name = "Relay"
api_key = "secret-key"
api_backend = "messages"
context_window = 500000
`;

    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
        initialData={{
          name: "Relay",
          settingsConfig: { config },
          meta: {
            apiFormat: "anthropic",
            apiKeyField: "ANTHROPIC_API_KEY",
            impersonateClaudeCode: true,
            maxOutputTokens: 4096,
            promptCacheRouting: "enabled",
            codexChatReasoning: {
              supportsThinking: true,
              supportsEffort: true,
              thinkingParam: "thinking",
              effortParam: "reasoning_effort",
            },
          },
        }}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("messages"), {
      target: { value: "responses" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const meta = onSubmit.mock.calls[0][0].meta;
    expect(meta.apiFormat).toBe("openai_responses");
    expect(meta.apiKeyField).toBeUndefined();
    expect(meta.impersonateClaudeCode).toBeUndefined();
    expect(meta.maxOutputTokens).toBeUndefined();
    expect(meta.promptCacheRouting).toBeUndefined();
    expect(meta.codexChatReasoning).toBeUndefined();
  });

  it("renders localized validation feedback for malformed TOML", async () => {
    const onSubmit = vi.fn();
    render(
      <GrokBuildProviderForm
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("raw-config"), {
      target: { value: "[models" },
    });

    expect(screen.getByText(/Invalid config\.toml:/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("loads edit-mode values and does not resubmit stale custom endpoints", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const config = `[models]
default = "existing-profile"

[model."existing-profile"]
model = "grok-upstream"
base_url = "https://existing.example.com/v1"
name = "Existing Relay"
api_key = "existing-key"
api_backend = "responses"
context_window = 250000
`;
    const { container } = render(
      <GrokBuildProviderForm
        providerId="existing-provider"
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
        initialData={{
          name: "Existing Relay",
          settingsConfig: { config },
          meta: {
            custom_endpoints: {
              "https://deleted.example.com/v1": {
                url: "https://deleted.example.com/v1",
                addedAt: 1,
              },
            },
          },
        }}
      />,
    );

    expect(
      container.querySelector<HTMLInputElement>("#grokbuild-profile")?.value,
    ).toBe("existing-profile");
    expect(
      container.querySelector<HTMLInputElement>("#codexBaseUrl")?.value,
    ).toBe("https://existing.example.com/v1");

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].meta.custom_endpoints).toBeUndefined();
  });
});
