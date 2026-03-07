import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface QuickConfigToggleProps {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function QuickConfigToggle({
  checked,
  label,
  description,
  onChange,
  disabled = false,
}: QuickConfigToggleProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            disabled={disabled}
            className="h-4 w-4 rounded border-border-default bg-white text-blue-500 focus:ring-2 focus:ring-blue-500 dark:bg-gray-800 dark:focus:ring-blue-400"
          />
          <span>{label}</span>
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground/70 transition-colors hover:text-foreground"
              aria-label={label}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-left leading-relaxed">
            {description}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
