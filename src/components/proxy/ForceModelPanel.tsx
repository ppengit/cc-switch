import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Info, Loader2, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppProxyConfig, useUpdateAppProxyConfig } from "@/lib/query/proxy";

export interface ForceModelPanelProps {
  appType: string;
  disabled?: boolean;
}

const MODEL_PLACEHOLDERS: Record<string, string> = {
  claude: "claude-sonnet-4-5-20250929",
  codex: "gpt-5.4",
  gemini: "gemini-2.5-pro",
};

export function ForceModelPanel({
  appType,
  disabled = false,
}: ForceModelPanelProps) {
  const { t } = useTranslation();
  const { data: config, isLoading, error } = useAppProxyConfig(appType);
  const updateConfig = useUpdateAppProxyConfig();
  const [forceModelEnabled, setForceModelEnabled] = useState(false);
  const [forceModel, setForceModel] = useState("");

  useEffect(() => {
    if (!config) {
      return;
    }

    setForceModelEnabled(config.forceModelEnabled);
    setForceModel(config.forceModel ?? "");
  }, [config]);

  const placeholder = useMemo(
    () => MODEL_PLACEHOLDERS[appType] ?? "model-id",
    [appType],
  );
  const isDisabled = disabled || isLoading || updateConfig.isPending;

  const handleSave = async () => {
    if (!config) {
      return;
    }

    const normalizedModel = forceModel.trim();
    if (forceModelEnabled && !normalizedModel) {
      toast.error(
        t("proxy.forceModel.validationRequired", {
          defaultValue: "Model name is required when force model is enabled.",
        }),
      );
      return;
    }

    try {
      await updateConfig.mutateAsync({
        config: {
          ...config,
          forceModelEnabled,
          forceModel: normalizedModel,
        },
        successMessage: t("proxy.forceModel.saved", {
          defaultValue: "Force model settings saved.",
        }),
      });
    } catch (saveError) {
      console.error("Save force model config failed:", saveError);
    }
  };

  const handleReset = () => {
    if (!config) {
      return;
    }

    setForceModelEnabled(config.forceModelEnabled);
    setForceModel(config.forceModel ?? "");
  };

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("proxy.forceModel.loadFailed", {
            defaultValue: "Failed to load force model settings.",
          })}
          : {String(error)}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold">
            {t("proxy.forceModel.title", { defaultValue: "Force Model" })}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("proxy.forceModel.description", {
              defaultValue:
                "When enabled, all requests from this app that pass through the local proxy are rewritten to the specified model.",
            })}
          </p>
        </div>
        <Switch
          checked={forceModelEnabled}
          onCheckedChange={setForceModelEnabled}
          disabled={isDisabled}
          aria-label={t("proxy.forceModel.title", {
            defaultValue: "Force Model",
          })}
        />
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          {t("proxy.forceModel.notice", {
            defaultValue:
              "This setting only affects requests forwarded through the local proxy. It does not overwrite the provider live config, and turning it off restores the normal flow immediately.",
          })}
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label htmlFor={`force-model-${appType}`}>
          {t("proxy.forceModel.inputLabel", { defaultValue: "Model Name" })}
        </Label>
        <Input
          id={`force-model-${appType}`}
          value={forceModel}
          onChange={(event) => setForceModel(event.target.value)}
          placeholder={placeholder}
          disabled={isDisabled || !forceModelEnabled}
        />
        <p className="text-xs text-muted-foreground">
          {t("proxy.forceModel.inputHint", {
            defaultValue:
              "Enter a model ID that the upstream provider actually supports. Unsupported models will fail the request directly.",
          })}
        </p>
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <Button variant="outline" onClick={handleReset} disabled={isDisabled}>
          {t("common.reset", { defaultValue: "Reset" })}
        </Button>
        <Button onClick={() => void handleSave()} disabled={isDisabled}>
          {updateConfig.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("common.saving", { defaultValue: "Saving..." })}
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {t("common.save", { defaultValue: "Save" })}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
