import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FormLabel } from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import EndpointSpeedTest from "./EndpointSpeedTest";
import { ApiKeySection, EndpointField, ModelInputWithFetch } from "./shared";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import type { CodexApiFormat, ProviderCategory } from "@/types";

interface EndpointCandidate {
  url: string;
}

interface CodexFormFieldsProps {
  providerId?: string;
  // API Key
  codexApiKey: string;
  onApiKeyChange: (key: string) => void;
  category?: ProviderCategory;
  shouldShowApiKeyLink: boolean;
  websiteUrl: string;
  isPartner?: boolean;
  partnerPromotionKey?: string;

  // Base URL
  shouldShowSpeedTest: boolean;
  codexBaseUrl: string;
  onBaseUrlChange: (url: string) => void;
  isFullUrl: boolean;
  onFullUrlChange: (value: boolean) => void;
  isEndpointModalOpen: boolean;
  onEndpointModalToggle: (open: boolean) => void;
  onCustomEndpointsChange?: (endpoints: string[]) => void;
  autoSelect: boolean;
  onAutoSelectChange: (checked: boolean) => void;

  // API Format
  apiFormat: CodexApiFormat;
  onApiFormatChange: (format: CodexApiFormat) => void;

  // Model Name
  shouldShowModelField?: boolean;
  modelName?: string;
  onModelNameChange?: (model: string) => void;

  // Speed Test Endpoints
  speedTestEndpoints: EndpointCandidate[];

  // 屏蔽 [features] 段的快捷开关（写入 quirks.strip_paths）
  disableCodexFeatures?: boolean;
  onDisableCodexFeaturesChange?: (value: boolean) => void;
}

export function CodexFormFields({
  providerId,
  codexApiKey,
  onApiKeyChange,
  category,
  shouldShowApiKeyLink,
  websiteUrl,
  isPartner,
  partnerPromotionKey,
  shouldShowSpeedTest,
  codexBaseUrl,
  onBaseUrlChange,
  isFullUrl,
  onFullUrlChange,
  isEndpointModalOpen,
  onEndpointModalToggle,
  onCustomEndpointsChange,
  autoSelect,
  onAutoSelectChange,
  apiFormat,
  onApiFormatChange,
  shouldShowModelField = true,
  modelName = "",
  onModelNameChange,
  speedTestEndpoints,
  disableCodexFeatures = false,
  onDisableCodexFeaturesChange,
}: CodexFormFieldsProps) {
  const { t } = useTranslation();

  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);

  const handleFetchModels = useCallback(() => {
    if (!codexBaseUrl || !codexApiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!codexApiKey,
        hasBaseUrl: !!codexBaseUrl,
      });
      return;
    }
    setIsFetchingModels(true);
    fetchModelsForConfig(codexBaseUrl, codexApiKey, isFullUrl)
      .then((models) => {
        setFetchedModels(models);
        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        } else {
          toast.success(
            t("providerForm.fetchModelsSuccess", { count: models.length }),
          );
        }
      })
      .catch((err) => {
        console.warn("[ModelFetch] Failed:", err);
        showFetchModelsError(err, t);
      })
      .finally(() => setIsFetchingModels(false));
  }, [codexBaseUrl, codexApiKey, isFullUrl, t]);

  return (
    <>
      {/* Codex API Key 输入框 */}
      <ApiKeySection
        id="codexApiKey"
        label="API Key"
        value={codexApiKey}
        onChange={onApiKeyChange}
        category={category}
        shouldShowLink={shouldShowApiKeyLink}
        websiteUrl={websiteUrl}
        isPartner={isPartner}
        partnerPromotionKey={partnerPromotionKey}
        placeholder={{
          official: t("providerForm.codexOfficialNoApiKey", {
            defaultValue: "官方供应商无需 API Key",
          }),
          thirdParty: t("providerForm.codexApiKeyAutoFill", {
            defaultValue: "输入 API Key，将自动填充到配置",
          }),
        }}
      />

      {/* Codex Base URL 输入框 */}
      {shouldShowSpeedTest && (
        <EndpointField
          id="codexBaseUrl"
          label={t("codexConfig.apiUrlLabel")}
          value={codexBaseUrl}
          onChange={onBaseUrlChange}
          placeholder={t("providerForm.codexApiEndpointPlaceholder")}
          hint={t("providerForm.codexApiHint")}
          showFullUrlToggle
          isFullUrl={isFullUrl}
          onFullUrlChange={onFullUrlChange}
          onManageClick={() => onEndpointModalToggle(true)}
        />
      )}

      {/* Codex API 格式选择 */}
      {shouldShowSpeedTest && (
        <div className="space-y-2">
          <FormLabel htmlFor="codexApiFormat">
            {t("providerForm.apiFormat", { defaultValue: "API 格式" })}
          </FormLabel>
          <Select
            value={apiFormat}
            onValueChange={(value) =>
              onApiFormatChange(value as CodexApiFormat)
            }
          >
            <SelectTrigger id="codexApiFormat" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai_responses">
                {t("providerForm.codexApiFormatResponses", {
                  defaultValue: "OpenAI Responses API (原生)",
                })}
              </SelectItem>
              <SelectItem value="openai_chat">
                {t("providerForm.codexApiFormatOpenAIChat", {
                  defaultValue: "OpenAI Chat Completions (需开启路由)",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("providerForm.codexApiFormatHint", {
              defaultValue:
                "选择供应商真实支持的 Codex API 格式；Chat Completions 会通过本地路由自动转换为 Responses。",
            })}
          </p>
        </div>
      )}

      {/* Codex Model Name 输入框 */}
      {shouldShowModelField && onModelNameChange && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="codexModelName"
              className="block text-sm font-medium text-foreground"
            >
              {t("codexConfig.modelName", { defaultValue: "模型名称" })}
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFetchModels}
              disabled={isFetchingModels}
              className="h-7 gap-1"
            >
              {isFetchingModels ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t("providerForm.fetchModels")}
            </Button>
          </div>
          <ModelInputWithFetch
            id="codexModelName"
            value={modelName}
            onChange={(v) => onModelNameChange!(v)}
            placeholder={t("codexConfig.modelNamePlaceholder", {
              defaultValue: "例如: gpt-5.5",
            })}
            fetchedModels={fetchedModels}
            isLoading={isFetchingModels}
          />
          <p className="text-xs text-muted-foreground">
            {modelName.trim()
              ? t("codexConfig.modelNameHint", {
                  defaultValue: "指定使用的模型，将自动更新到 config.toml 中",
                })
              : t("providerForm.modelHint", {
                  defaultValue: "💡 留空将使用供应商的默认模型",
                })}
          </p>
        </div>
      )}

      {/* 屏蔽 [features] 段：部分供应商对 Codex `[features]` 不兼容，
          勾选后写盘时会从 config.toml 中删除整段 [features]。 */}
      {onDisableCodexFeaturesChange && (
        <div className="flex items-start gap-3 rounded-md border border-dashed border-muted-foreground/30 p-3">
          <input
            id="disableCodexFeatures"
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-muted-foreground/40"
            checked={disableCodexFeatures}
            onChange={(e) => onDisableCodexFeaturesChange(e.target.checked)}
          />
          <div className="space-y-1">
            <label
              htmlFor="disableCodexFeatures"
              className="block text-sm font-medium text-foreground cursor-pointer"
            >
              {t("providerForm.codexDisableFeaturesLabel", {
                defaultValue: "屏蔽 [features] 段",
              })}
            </label>
            <p className="text-xs text-muted-foreground">
              {t("providerForm.codexDisableFeaturesHint", {
                defaultValue:
                  "若该供应商不兼容 Codex 的 [features] 配置，勾选后写入 config.toml 时会自动剥离整段 [features]。",
              })}
            </p>
          </div>
        </div>
      )}

      {/* 端点测速弹窗 - Codex */}
      {shouldShowSpeedTest && isEndpointModalOpen && (
        <EndpointSpeedTest
          appId="codex"
          providerId={providerId}
          value={codexBaseUrl}
          onChange={onBaseUrlChange}
          initialEndpoints={speedTestEndpoints}
          visible={isEndpointModalOpen}
          onClose={() => onEndpointModalToggle(false)}
          autoSelect={autoSelect}
          onAutoSelectChange={onAutoSelectChange}
          onCustomEndpointsChange={onCustomEndpointsChange}
        />
      )}
    </>
  );
}
