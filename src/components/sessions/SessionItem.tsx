import { ChevronRight, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  highlightText,
} from "./utils";

interface SessionItemProps {
  session: SessionMeta;
  isSelected: boolean;
  selectionMode: boolean;
  isChecked: boolean;
  isCheckDisabled?: boolean;
  searchQuery?: string;
  onSelect: (key: string) => void;
  onToggleChecked: (checked: boolean) => void;
}

export function SessionItem({
  session,
  isSelected,
  selectionMode,
  isChecked,
  isCheckDisabled = false,
  searchQuery,
  onSelect,
  onToggleChecked,
}: SessionItemProps) {
  const { t } = useTranslation();
  const title = formatSessionTitle(session);
  const lastActive = session.lastActiveAt || session.createdAt || undefined;
  const sessionKey = getSessionKey(session);
  const projectName = getBaseName(session.projectDir);

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2.5 transition-all group",
        isSelected
          ? "bg-primary/10 border border-primary/30"
          : "hover:bg-muted/60 border border-transparent",
      )}
    >
      {selectionMode && (
        <div className="shrink-0 pt-0.5">
          <Checkbox
            checked={isChecked}
            disabled={isCheckDisabled}
            aria-label={t("sessionManager.selectForBatch", {
              defaultValue: "选择会话",
            })}
            onCheckedChange={(checked) => onToggleChecked(Boolean(checked))}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => onSelect(sessionKey)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="mb-1.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mt-0.5 shrink-0">
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
          <span className="min-w-0 break-words text-sm font-medium leading-5 line-clamp-2">
            {searchQuery ? highlightText(title, searchQuery) : title}
          </span>
          <ChevronRight
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground/50 transition-transform",
              isSelected && "text-primary rotate-90",
            )}
          />
        </div>

        {session.projectDir ? (
          <div
            className="mb-1 truncate text-xs text-muted-foreground"
            title={session.projectDir}
          >
            {searchQuery
              ? highlightText(projectName || session.projectDir, searchQuery)
              : projectName || session.projectDir}
          </div>
        ) : null}

        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="size-3" />
          <span className="truncate">
            {lastActive
              ? formatRelativeTime(lastActive, t)
              : t("common.unknown")}
          </span>
        </div>
      </button>
    </div>
  );
}
