import React from "react";
import { Check } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppId } from "@/lib/api/types";
import { APP_IDS, APP_ICON_MAP } from "@/config/appConfig";

interface AppToggleGroupProps {
  apps: Record<AppId, boolean>;
  configuredApps?: Record<AppId, boolean>;
  onToggle: (app: AppId, enabled: boolean) => void;
  appIds?: AppId[];
}

export const AppToggleGroup: React.FC<AppToggleGroupProps> = ({
  apps,
  configuredApps,
  onToggle,
  appIds = APP_IDS,
}) => {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {appIds.map((app) => {
        const { label, icon, activeClass } = APP_ICON_MAP[app];
        const enabled = apps[app];
        const isConfigured = configuredApps?.[app] ?? false;
        return (
          <Tooltip key={app}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onToggle(app, !enabled)}
                className={`relative w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                  enabled ? activeClass : "opacity-35 hover:opacity-70"
                }`}
              >
                {icon}
                {isConfigured && (
                  <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow">
                    <Check className="h-2 w-2" />
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{label}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};
