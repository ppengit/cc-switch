import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
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

  it("does not let website/API endpoint sync trim a full Codex endpoint while editing", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();
    const fullEndpoint =
      "https://api.xn--chy-js0fk50c.top/v1/chat/completions";

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
                'requires_openai_auth = true',
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
