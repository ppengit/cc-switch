import { ChevronRight, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { SessionMeta } from "@/types";
import {
  formatRelativeTime,
  formatSessionTitle,
  getBaseName,
  getProviderIconName,
  getProviderLabel,
  getSessionKey,
} from "./utils";

interface SessionItemProps {
  session: SessionMeta;
  isSelected: boolean;
  onSelect: (key: string) => void;
  bindingProviderName?: string | null;
  bindingProviderId?: string | null;
  bindingPinned?: boolean | null;
}

export function SessionItem({
  session,
  isSelected,
  onSelect,
  bindingProviderName,
  bindingProviderId,
  bindingPinned,
}: SessionItemProps) {
  const { t } = useTranslation();
  const title = formatSessionTitle(session);
  const projectName = getBaseName(session.projectDir);
  const showProjectName = projectName && projectName !== title;
  const lastActive = session.lastActiveAt || session.createdAt || undefined;
  const sessionKey = getSessionKey(session);
  const associatedProvider = bindingProviderName || bindingProviderId || "";
  const modeLabel =
    bindingPinned === true
      ? t("sessionManager.bindingPinnedShort", { defaultValue: "锁定" })
      : t("sessionManager.bindingAutoShort", { defaultValue: "自动" });

  return (
    <button
      type="button"
      onClick={() => onSelect(sessionKey)}
      className={cn(
        "w-full text-left rounded-lg px-3 py-2.5 transition-all group",
        isSelected
          ? "bg-primary/10 border border-primary/30"
          : "hover:bg-muted/60 border border-transparent",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <ProviderIcon
                icon={getProviderIconName(session.providerId)}
                name={session.providerId}
                size={18}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {getProviderLabel(session.providerId, t)}
          </TooltipContent>
        </Tooltip>
        <span className="text-sm font-medium truncate flex-1">{title}</span>
        <ChevronRight
          className={cn(
            "size-4 text-muted-foreground/50 shrink-0 transition-transform",
            isSelected && "text-primary rotate-90",
          )}
        />
      </div>

      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Clock className="size-3" />
        <span>
          {lastActive ? formatRelativeTime(lastActive, t) : t("common.unknown")}
        </span>
      </div>

      {showProjectName && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>
            {t("sessionManager.projectName", { defaultValue: "项目" })}:
          </span>
          <span className="truncate" title={projectName}>
            {projectName}
          </span>
        </div>
      )}

      {associatedProvider && (
        <div className="mt-1 flex items-center gap-1 text-[11px] min-w-0">
          <span className="text-muted-foreground">
            {t("sessionManager.associatedProviderShort", {
              defaultValue: "关联",
            })}
          </span>
          <span
            className="truncate text-foreground/80"
            title={associatedProvider}
          >
            {associatedProvider}
          </span>
          <Badge
            variant={bindingPinned ? "default" : "secondary"}
            className="h-4 px-1.5 text-[10px] leading-none"
            title={
              bindingPinned
                ? t("sessionManager.bindingPinnedHint", {
                    defaultValue:
                      "锁定（已绑定）：优先使用当前提供商；若该提供商降级/熔断或不可用，系统仍会自动迁移并释放占用。",
                  })
                : t("sessionManager.bindingAutoHint", {
                    defaultValue:
                      "自动：系统根据会话路由策略自动分配提供商，并在降级/熔断或容量变化时自动重绑定。",
                  })
            }
          >
            {modeLabel}
          </Badge>
        </div>
      )}
    </button>
  );
}
