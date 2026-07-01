import { MonitorDot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SettingsFormState } from "@/hooks/useSettings";

interface MiniPanelSettingsProps {
  settings: SettingsFormState;
  onChange: (updates: Partial<SettingsFormState>) => void | Promise<unknown>;
}

const clampIdleSeconds = (value: number) => {
  if (!Number.isFinite(value)) return 180;
  return Math.max(10, Math.min(3600, Math.round(value)));
};

export function MiniPanelSettings({
  settings,
  onChange,
}: MiniPanelSettingsProps) {
  const { t } = useTranslation();
  const idleSeconds = settings.proxyActivityFloatingIdleHideSeconds ?? 180;

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
            <MonitorDot className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium leading-none">
              {t("settings.miniPanel.title", {
                defaultValue: "Mini 面板设置",
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.miniPanel.description", {
                defaultValue:
                  "控制实时请求 Mini 面板的显示、透明度和空闲隐藏时间。",
              })}
            </p>
          </div>
        </div>
        <Switch
          checked={settings.showProxyActivityFloatingWindow ?? false}
          onCheckedChange={(checked) =>
            onChange({ showProxyActivityFloatingWindow: checked })
          }
          aria-label={t("settings.miniPanel.enabled", {
            defaultValue: "启用 Mini 面板",
          })}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="mini-panel-idle-hide">
            {t("settings.miniPanel.idleHideSeconds", {
              defaultValue: "空闲隐藏时间",
            })}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="mini-panel-idle-hide"
              type="number"
              min={10}
              max={3600}
              step={10}
              value={idleSeconds}
              onChange={(event) =>
                onChange({
                  proxyActivityFloatingIdleHideSeconds: clampIdleSeconds(
                    Number(event.target.value),
                  ),
                })
              }
            />
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("common.seconds", { defaultValue: "秒" })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.miniPanel.idleHideHint", {
              defaultValue:
                "没有实时请求后延迟隐藏；范围 10 到 3600 秒，默认 180 秒。",
            })}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="mini-panel-opacity">
            {t("settings.miniPanel.opacity", {
              defaultValue: "面板透明度",
            })}
          </Label>
          <div className="grid grid-cols-[1fr_auto] items-center gap-3">
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
            />
            <span className="text-right text-xs font-mono text-muted-foreground">
              {Math.round(
                (settings.proxyActivityFloatingOpacity ?? 0.86) * 100,
              )}
              %
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
