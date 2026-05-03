import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import type { Provider } from "@/types";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import type { AppId } from "@/lib/api";

interface EditProviderDialogProps {
  open: boolean;
  provider: Provider | null;
  currentProviderId: string;
  initialEnabledState?: boolean;
  allowEnableToggle?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: {
    provider: Provider;
    originalId?: string;
    saveOptions?: {
      pinToTop: boolean;
      enabled?: boolean;
    };
  }) => Promise<void> | void;
  appId: AppId;
  isProxyTakeover?: boolean;
}

export function EditProviderDialog({
  open,
  provider,
  initialEnabledState = true,
  allowEnableToggle = true,
  onOpenChange,
  onSubmit,
  appId,
}: EditProviderDialogProps) {
  const { t } = useTranslation();
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  const [pinToTopOnSave, setPinToTopOnSave] = useState(false);
  const [enableOnSave, setEnableOnSave] = useState(true);

  // Freeze the form seed while the dialog is open. Provider rows can refresh
  // frequently because of proxy activity/status updates; those refreshes must
  // not reset fields while the user is typing.
  const initialData = useMemo(() => {
    if (!provider) return null;
    return {
      name: provider.name,
      notes: provider.notes,
      websiteUrl: provider.websiteUrl,
      settingsConfig: (provider.settingsConfig ?? {}) as Record<string, unknown>,
      category: provider.category,
      meta: provider.meta,
      icon: provider.icon,
      iconColor: provider.iconColor,
    };
  }, [
    appId,
    open, // Re-read latest provider data each time the dialog is opened.
    provider?.id, // Keep typing stable across provider object refreshes.
  ]);

  useEffect(() => {
    if (!provider) return;
    setPinToTopOnSave(false);
    setEnableOnSave(initialEnabledState);
  }, [initialEnabledState, provider]);

  const handleSubmit = useCallback(
    async (values: ProviderFormValues) => {
      if (!provider) return;

      // 注意：values.settingsConfig 已经是最终的配置字符串
      // ProviderForm 已经为不同的 app 类型（Claude/Codex/Gemini）正确组装了配置
      const parsedConfig = JSON.parse(values.settingsConfig) as Record<
        string,
        unknown
      >;
      const nextProviderId =
        (appId === "opencode" ||
          appId === "openclaw" ||
          appId === "hermes") &&
        values.providerKey?.trim()
          ? values.providerKey.trim()
          : provider.id;

      const updatedProvider: Provider = {
        ...provider,
        id: nextProviderId,
        name: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        websiteUrl: values.websiteUrl?.trim() || undefined,
        settingsConfig: parsedConfig,
        icon: values.icon?.trim() || undefined,
        iconColor: values.iconColor?.trim() || undefined,
        ...(values.presetCategory ? { category: values.presetCategory } : {}),
        // 保留或更新 meta 字段
        ...(values.meta ? { meta: values.meta } : {}),
      };

      await onSubmit({
        provider: updatedProvider,
        originalId: provider.id,
        saveOptions: {
          pinToTop: pinToTopOnSave,
          enabled: allowEnableToggle ? enableOnSave : undefined,
        },
      });
      onOpenChange(false);
    },
    [appId, enableOnSave, onOpenChange, onSubmit, pinToTopOnSave, provider],
  );

  if (!provider || !initialData) {
    return null;
  }

  return (
    <FullScreenPanel
      isOpen={open}
      title={t("provider.editProvider")}
      onClose={() => onOpenChange(false)}
      footer={
        <>
          <div className="mr-auto flex flex-wrap items-center gap-4">
            <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm">
              <Checkbox
                checked={pinToTopOnSave}
                onCheckedChange={(checked) => setPinToTopOnSave(Boolean(checked))}
              />
              <span>
                {t("providerForm.pinToTopOnSave", {
                  defaultValue: "置顶（保存后顺序为 1）",
                })}
              </span>
            </label>
            {allowEnableToggle ? (
              <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm">
                <Checkbox
                  checked={enableOnSave}
                  onCheckedChange={(checked) => setEnableOnSave(Boolean(checked))}
                />
                <span>
                  {t("providerForm.enableOnSave", {
                    defaultValue: "启用（保存后立即生效）",
                  })}
                </span>
              </label>
            ) : null}
          </div>
          <Button
            type="submit"
            form="provider-form"
            disabled={isFormSubmitting}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Save className="h-4 w-4 mr-2" />
            {t("common.save")}
          </Button>
        </>
      }
    >
      <ProviderForm
        appId={appId}
        providerId={provider.id}
        submitLabel={t("common.save")}
        onSubmit={handleSubmit}
        onCancel={() => onOpenChange(false)}
        onSubmittingChange={setIsFormSubmitting}
        initialData={initialData}
        showButtons={false}
      />
    </FullScreenPanel>
  );
}
