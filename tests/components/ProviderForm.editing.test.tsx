import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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
});
