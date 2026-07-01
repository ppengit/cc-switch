import { MonitorDot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SettingsFormState } from "@/hooks/useSettings";
interface MiniPanelSettingsProps {
  settings: SettingsFormState;
  onChange: (updates: Partial<SettingsFormState>) => void | Promise<unknown>;
}
export function MiniPanelSettings({
  settings,
  onChange,
}: MiniPanelSettingsProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      {" "}
      <div className="flex items-start justify-between gap-4">
        {" "}
        <div className="flex items-start gap-3">
          {" "}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
            {" "}
            <MonitorDot className="h-4 w-4 text-emerald-500" />{" "}
          </div>{" "}
          <div className="space-y-1">
            {" "}
            <p className="text-sm font-medium leading-none">
              {" "}
              {t("settings.miniPanel.title", {
                defaultValue: "Mini 面板设置",
              })}{" "}
            </p>{" "}
            <p className="text-xs text-muted-foreground">
              {" "}
              {t("settings.miniPanel.description", {
                defaultValue:
                  "控制实时请求 Mini 面板的显示与透明度。面板开启后常驻显示，可拖拽移动或拖右下角调整大小。",
              })}{" "}
            </p>{" "}
          </div>{" "}
        </div>{" "}
        <Switch
          checked={settings.showProxyActivityFloatingWindow ?? false}
          onCheckedChange={(checked) =>
            onChange({ showProxyActivityFloatingWindow: checked })
          }
          aria-label={t("settings.miniPanel.enabled", {
            defaultValue: "启用 Mini 面板",
          })}
        />{" "}
      </div>{" "}
      <div className="mt-4 grid gap-4">
        {" "}
        <div className="space-y-2">
          {" "}
          <Label htmlFor="mini-panel-opacity">
            {" "}
            {t("settings.miniPanel.opacity", {
              defaultValue: "面板透明度",
            })}{" "}
          </Label>{" "}
          <div className="grid grid-cols-[1fr_auto] items-center gap-3">
            {" "}
            <input
              id="mini-panel-opacity"
              type="range"
              min={35}
              max={100}
              step={1}
              value={Math.round(
                (settings.proxyActivityFloatingOpacity ?? 0.86) * 100,
              )}
              onChange={(event) =>
                onChange({
                  proxyActivityFloatingOpacity:
                    Number(event.target.value) / 100,
                })
              }
              className="w-full accent-emerald-500"
            />{" "}
            <span className="text-right text-xs font-mono text-muted-foreground">
              {" "}
              {Math.round(
                (settings.proxyActivityFloatingOpacity ?? 0.86) * 100,
              )}{" "}
              %{" "}
            </span>{" "}
          </div>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}
