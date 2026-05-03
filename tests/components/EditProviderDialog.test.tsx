import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditProviderDialog } from "@/components/providers/EditProviderDialog";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";

let mockFormValues: ProviderFormValues;

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

describe("EditProviderDialog", () => {
  beforeEach(() => {
    mockFormValues = {
      name: "Updated Hermes Provider",
      websiteUrl: "https://hermes.example.com",
      settingsConfig: JSON.stringify({
        base_url: "https://hermes.example.com",
        api_key: "sk-hermes",
      }),
      providerKey: "hermes-provider-renamed",
    };
  });

  it("编辑 Hermes 时允许用 providerKey 更新供应商 ID", async () => {
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

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.save",
      }),
    );

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
});
