import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import type { Provider, CustomEndpoint, UniversalProvider } from "@/types";
import type { AppId } from "@/lib/api";
import { universalProvidersApi } from "@/lib/api";
import { configApi } from "@/lib/api";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { UniversalProviderFormModal } from "@/components/universal/UniversalProviderFormModal";
import { UniversalProviderPanel } from "@/components/universal";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { extractCodexBaseUrl } from "@/utils/providerConfigUtils";
import type { OpenClawSuggestedDefaults } from "@/config/openclawProviderPresets";
import type { UniversalProviderPreset } from "@/config/universalProviderPresets";
import { useProvidersQuery } from "@/lib/query";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PROVIDER_MODEL,
} from "@/config/defaultModels";

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
  allowEnableToggle?: boolean;
  onSubmit: (payload: {
    provider: Omit<Provider, "id"> & {
      providerKey?: string;
      suggestedDefaults?: OpenClawSuggestedDefaults;
      addToLive?: boolean;
      ensureClaudeDesktopOfficialSeed?: boolean;
    };
    saveOptions?: {
      pinToTop: boolean;
      enabled?: boolean;
    };
  }) => Promise<void> | void;
}

const normalizeEndpointForDuplicateCheck = (value?: unknown) =>
  typeof value === "string"
    ? value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "")
    : "";

const defaultProviderTemplateModelForApp = (appId: AppId) => {
  if (appId === "claude") return DEFAULT_CLAUDE_MODEL;
  if (appId === "gemini") return DEFAULT_GEMINI_MODEL;
  return DEFAULT_PROVIDER_MODEL;
};

const materializeProviderTemplatePlaceholders = (
  value: unknown,
  appId: AppId,
): unknown => {
  if (typeof value === "string") {
    return value
      .replace(/\{baseUrl\}/g, "")
      .replace(/\{apiKey\}/g, "")
      .replace(/\{model\}/g, defaultProviderTemplateModelForApp(appId));
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      materializeProviderTemplatePlaceholders(item, appId),
    );
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        materializeProviderTemplatePlaceholders(entry, appId),
      ]),
    );
  }

  return value;
};

const getProviderEndpointAndKey = (
  appId: AppId,
  config: Record<string, unknown>,
) => {
  if (appId === "claude") {
    const env = config.env as Record<string, unknown> | undefined;
    return {
      endpoint: normalizeEndpointForDuplicateCheck(env?.ANTHROPIC_BASE_URL),
      apiKey:
        typeof env?.ANTHROPIC_AUTH_TOKEN === "string"
          ? env.ANTHROPIC_AUTH_TOKEN.trim()
          : typeof env?.ANTHROPIC_API_KEY === "string"
            ? env.ANTHROPIC_API_KEY.trim()
            : "",
    };
  }

  if (appId === "codex") {
    const auth = config.auth as Record<string, unknown> | undefined;
    return {
      endpoint: normalizeEndpointForDuplicateCheck(
        extractCodexBaseUrl(
          typeof config.config === "string" ? config.config : "",
        ),
      ),
      apiKey:
        typeof auth?.OPENAI_API_KEY === "string"
          ? auth.OPENAI_API_KEY.trim()
          : "",
    };
  }

  if (appId === "gemini") {
    const env = config.env as Record<string, unknown> | undefined;
    return {
      endpoint: normalizeEndpointForDuplicateCheck(env?.GOOGLE_GEMINI_BASE_URL),
      apiKey:
        typeof env?.GEMINI_API_KEY === "string"
          ? env.GEMINI_API_KEY.trim()
          : "",
    };
  }

  if (appId === "opencode") {
    const options = config.options as Record<string, unknown> | undefined;
    return {
      endpoint: normalizeEndpointForDuplicateCheck(options?.baseURL),
      apiKey: typeof options?.apiKey === "string" ? options.apiKey.trim() : "",
    };
  }

  if (appId === "openclaw") {
    return {
      endpoint: normalizeEndpointForDuplicateCheck(config.baseUrl),
      apiKey: typeof config.apiKey === "string" ? config.apiKey.trim() : "",
    };
  }

  if (appId === "hermes") {
    return {
      endpoint: normalizeEndpointForDuplicateCheck(config.base_url),
      apiKey: typeof config.api_key === "string" ? config.api_key.trim() : "",
    };
  }

  return { endpoint: "", apiKey: "" };
};

export function AddProviderDialog({
  open,
  onOpenChange,
  appId,
  allowEnableToggle = true,
  onSubmit,
}: AddProviderDialogProps) {
  const { t } = useTranslation();
  // OpenCode and OpenClaw don't support universal providers
  const showUniversalTab =
    appId !== "opencode" &&
    appId !== "openclaw" &&
    appId !== "hermes" &&
    appId !== "claude-desktop";
  const [activeTab, setActiveTab] = useState<"app-specific" | "universal">(
    "app-specific",
  );
  const [universalFormOpen, setUniversalFormOpen] = useState(false);
  const [selectedUniversalPreset, setSelectedUniversalPreset] =
    useState<UniversalProviderPreset | null>(null);
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  const [pinToTopOnSave, setPinToTopOnSave] = useState(true);
  const [enableOnSave, setEnableOnSave] = useState(true);
  const [isProviderTemplateLoading, setIsProviderTemplateLoading] =
    useState(false);
  const [providerTemplateDefault, setProviderTemplateDefault] = useState<
    Record<string, unknown> | undefined
  >(undefined);
  const { data: providersData } = useProvidersQuery(appId);

  useEffect(() => {
    if (!open) return;
    setActiveTab("app-specific");
    setPinToTopOnSave(true);
    setEnableOnSave(true);
  }, [appId, open]);

  useEffect(() => {
    if (!open) return;
    setProviderTemplateDefault(undefined);
    setIsProviderTemplateLoading(true);
    let cancelled = false;

    void configApi
      .getProviderDefaultTemplate(appId)
      .then((template) => {
        if (cancelled) return;
        if (!template?.trim()) {
          setProviderTemplateDefault(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(template) as Record<string, unknown>;
          setProviderTemplateDefault(
            materializeProviderTemplatePlaceholders(parsed, appId) as Record<
              string,
              unknown
            >,
          );
        } catch {
          setProviderTemplateDefault(undefined);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProviderTemplateDefault(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsProviderTemplateLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appId, open]);

  const handleUniversalProviderSave = useCallback(
    async (provider: UniversalProvider) => {
      try {
        await universalProvidersApi.upsert(provider);
        toast.success(
          t("universalProvider.addSuccess", {
            defaultValue: "统一供应商添加成功",
          }),
        );
        setUniversalFormOpen(false);
        setSelectedUniversalPreset(null);
        onOpenChange(false);
      } catch (error) {
        console.error(
          "[AddProviderDialog] Failed to save universal provider",
          error,
        );
        toast.error(
          t("universalProvider.addFailed", {
            defaultValue: "统一供应商添加失败",
          }),
        );
      }
    },
    [t, onOpenChange],
  );

  const handleUniversalFormClose = useCallback(() => {
    setUniversalFormOpen(false);
    setSelectedUniversalPreset(null);
  }, []);

  const handleSubmit = useCallback(
    async (values: ProviderFormValues) => {
      const parsedConfig = JSON.parse(values.settingsConfig) as Record<
        string,
        unknown
      >;
      const nextCredential = getProviderEndpointAndKey(appId, parsedConfig);
      if (nextCredential.endpoint && nextCredential.apiKey) {
        const duplicated = Object.values(providersData?.providers ?? {}).find(
          (provider) => {
            const existing = getProviderEndpointAndKey(
              appId,
              provider.settingsConfig,
            );
            return (
              existing.endpoint === nextCredential.endpoint &&
              existing.apiKey === nextCredential.apiKey
            );
          },
        );
        if (duplicated) {
          toast.error(
            t("providerForm.duplicateProvider", {
              defaultValue:
                "该应用下已存在相同 API 请求地址和 API Key 的供应商：{{name}}",
              name: duplicated.name,
            }),
          );
          return;
        }
      }

      // 构造基础提交数据
      const providerData: Omit<Provider, "id"> & {
        providerKey?: string;
        suggestedDefaults?: OpenClawSuggestedDefaults;
        addToLive?: boolean;
        ensureClaudeDesktopOfficialSeed?: boolean;
      } = {
        name: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        websiteUrl: values.websiteUrl?.trim() || undefined,
        settingsConfig: parsedConfig,
        icon: values.icon?.trim() || undefined,
        iconColor: values.iconColor?.trim() || undefined,
        ...(values.presetCategory ? { category: values.presetCategory } : {}),
        ...(values.meta ? { meta: values.meta } : {}),
      };

      if (appId === "claude-desktop" && values.presetId) {
        const presetIndex = parseInt(
          values.presetId.replace("claude-desktop-", ""),
        );
        const preset = claudeDesktopProviderPresets[presetIndex];
        providerData.ensureClaudeDesktopOfficialSeed =
          values.presetCategory === "official" &&
          preset?.category === "official";
      }

      // OpenCode/OpenClaw: pass providerKey for ID generation
      if (
        (appId === "opencode" || appId === "openclaw" || appId === "hermes") &&
        values.providerKey
      ) {
        providerData.providerKey = values.providerKey;
      }

      const hasCustomEndpoints =
        providerData.meta?.custom_endpoints &&
        Object.keys(providerData.meta.custom_endpoints).length > 0;

      if (!hasCustomEndpoints && values.presetCategory !== "omo") {
        const urlSet = new Set<string>();

        const addUrl = (rawUrl?: string) => {
          const url = (rawUrl || "").trim().replace(/\/+$/, "");
          if (url && url.startsWith("http")) {
            urlSet.add(url);
          }
        };

        if (values.presetId) {
          if (appId === "claude") {
            const presets = providerPresets;
            const presetIndex = parseInt(
              values.presetId.replace("claude-", ""),
            );
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (preset?.endpointCandidates) {
                preset.endpointCandidates.forEach(addUrl);
              }
            }
          } else if (appId === "codex") {
            const presets = codexProviderPresets;
            const presetIndex = parseInt(values.presetId.replace("codex-", ""));
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (Array.isArray(preset.endpointCandidates)) {
                preset.endpointCandidates.forEach(addUrl);
              }
            }
          } else if (appId === "gemini") {
            const presets = geminiProviderPresets;
            const presetIndex = parseInt(
              values.presetId.replace("gemini-", ""),
            );
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (Array.isArray(preset.endpointCandidates)) {
                preset.endpointCandidates.forEach(addUrl);
              }
            }
          } else if (appId === "claude-desktop") {
            const presets = claudeDesktopProviderPresets;
            const presetIndex = parseInt(
              values.presetId.replace("claude-desktop-", ""),
            );
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (Array.isArray(preset.endpointCandidates)) {
                preset.endpointCandidates.forEach(addUrl);
              }
              addUrl(preset.baseUrl);
            }
          }
        }

        if (appId === "claude") {
          const env = parsedConfig.env as Record<string, any> | undefined;
          if (env?.ANTHROPIC_BASE_URL) {
            addUrl(env.ANTHROPIC_BASE_URL);
          }
        } else if (appId === "claude-desktop") {
          const env = parsedConfig.env as Record<string, any> | undefined;
          if (env?.ANTHROPIC_BASE_URL) {
            addUrl(env.ANTHROPIC_BASE_URL);
          }
        } else if (appId === "codex") {
          const config = parsedConfig.config as string | undefined;
          if (config) {
            const extractedBaseUrl = extractCodexBaseUrl(config);
            if (extractedBaseUrl) {
              addUrl(extractedBaseUrl);
            }
          }
        } else if (appId === "gemini") {
          const env = parsedConfig.env as Record<string, any> | undefined;
          if (env?.GOOGLE_GEMINI_BASE_URL) {
            addUrl(env.GOOGLE_GEMINI_BASE_URL);
          }
        } else if (appId === "opencode") {
          const options = parsedConfig.options as
            | Record<string, any>
            | undefined;
          if (options?.baseURL) {
            addUrl(options.baseURL);
          }
        } else if (appId === "openclaw") {
          // OpenClaw uses baseUrl directly
          if (parsedConfig.baseUrl) {
            addUrl(parsedConfig.baseUrl as string);
          }
        } else if (appId === "hermes") {
          if (parsedConfig.base_url) {
            addUrl(parsedConfig.base_url as string);
          }
        }

        const urls = Array.from(urlSet);
        if (urls.length > 0) {
          const now = Date.now();
          const customEndpoints: Record<string, CustomEndpoint> = {};
          urls.forEach((url) => {
            customEndpoints[url] = {
              url,
              addedAt: now,
              lastUsed: undefined,
            };
          });

          providerData.meta = {
            ...(providerData.meta ?? {}),
            custom_endpoints: customEndpoints,
          };
        }
      }

      // OpenClaw: pass suggestedDefaults for model registration
      if (appId === "openclaw" && values.suggestedDefaults) {
        providerData.suggestedDefaults = values.suggestedDefaults;
      }

      if (enableOnSave === false) {
        providerData.addToLive = false;
      }

      await onSubmit({
        provider: providerData,
        saveOptions: {
          pinToTop: pinToTopOnSave,
          enabled: allowEnableToggle ? enableOnSave : undefined,
        },
      });
      onOpenChange(false);
    },
    [
      appId,
      enableOnSave,
      onSubmit,
      onOpenChange,
      pinToTopOnSave,
      providersData?.providers,
      t,
    ],
  );

  const footer =
    !showUniversalTab || activeTab === "app-specific" ? (
      <>
        <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <span className="min-w-40 text-xs text-muted-foreground">
            {t("provider.addFooterHint")}
          </span>
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
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border/20 hover:bg-accent hover:text-accent-foreground"
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="provider-form"
            disabled={isFormSubmitting || isProviderTemplateLoading}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4 mr-2" />
            {t("common.add")}
          </Button>
        </div>
      </>
    ) : (
      <>
        <Button
          variant="outline"
          onClick={() => onOpenChange(false)}
          className="border-border/20 hover:bg-accent hover:text-accent-foreground"
        >
          {t("common.cancel")}
        </Button>
        <Button
          onClick={() => setUniversalFormOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4 mr-2" />
          {t("universalProvider.add")}
        </Button>
      </>
    );

  return (
    <FullScreenPanel
      isOpen={open}
      title={t("provider.addNewProvider")}
      onClose={() => onOpenChange(false)}
      footer={footer}
      contentClassName="pt-3"
    >
      {showUniversalTab ? (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "app-specific" | "universal")}
        >
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="app-specific">
              {t(`apps.${appId}`)} {t("provider.tabProvider")}
            </TabsTrigger>
            <TabsTrigger value="universal">
              {t("provider.tabUniversal")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="app-specific" className="mt-0">
            {isProviderTemplateLoading ? (
              <div className="py-8 text-sm text-muted-foreground">
                {t("provider.loadingTemplate", {
                  defaultValue: "加载供应商模板中...",
                })}
              </div>
            ) : (
              <ProviderForm
                appId={appId}
                submitLabel={t("common.add")}
                onSubmit={handleSubmit}
                onCancel={() => onOpenChange(false)}
                onSubmittingChange={setIsFormSubmitting}
                providerDefaultSettingsConfig={providerTemplateDefault}
                showButtons={false}
              />
            )}
          </TabsContent>

          <TabsContent value="universal" className="mt-0">
            <UniversalProviderPanel />
          </TabsContent>
        </Tabs>
      ) : (
        // OpenCode/OpenClaw: directly show form without tabs
        <>
          {isProviderTemplateLoading ? (
            <div className="py-8 text-sm text-muted-foreground">
              {t("provider.loadingTemplate", {
                defaultValue: "加载供应商模板中...",
              })}
            </div>
          ) : (
            <ProviderForm
              appId={appId}
              submitLabel={t("common.add")}
              onSubmit={handleSubmit}
              onCancel={() => onOpenChange(false)}
              onSubmittingChange={setIsFormSubmitting}
              providerDefaultSettingsConfig={providerTemplateDefault}
              showButtons={false}
            />
          )}
        </>
      )}

      {showUniversalTab && (
        <UniversalProviderFormModal
          isOpen={universalFormOpen}
          onClose={handleUniversalFormClose}
          onSave={handleUniversalProviderSave}
          initialPreset={selectedUniversalPreset}
        />
      )}
    </FullScreenPanel>
  );
}
