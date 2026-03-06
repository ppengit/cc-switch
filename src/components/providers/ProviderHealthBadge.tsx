import { cn } from "@/lib/utils";
import { ProviderHealthStatus } from "@/types/proxy";
import { useTranslation } from "react-i18next";

interface ProviderHealthBadgeProps {
  consecutiveFailures: number;
  lastError?: string | null;
  className?: string;
}

const CIRCUIT_OPEN_THRESHOLD = 5;
const MAX_CIRCUIT_REASON_LENGTH = 140;

function formatCircuitReason(lastError?: string | null): string | null {
  if (!lastError) {
    return null;
  }

  const normalized = lastError.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= MAX_CIRCUIT_REASON_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_CIRCUIT_REASON_LENGTH)}...`;
}

export function ProviderHealthBadge({
  consecutiveFailures,
  lastError,
  className,
}: ProviderHealthBadgeProps) {
  const { t } = useTranslation();

  const getStatus = () => {
    if (consecutiveFailures === 0) {
      return {
        labelKey: "health.operational",
        labelFallback: "正常",
        status: ProviderHealthStatus.Healthy,
        color: "bg-green-500",
        bgColor: "bg-green-500/10",
        textColor: "text-green-600 dark:text-green-400",
      };
    }

    if (consecutiveFailures < CIRCUIT_OPEN_THRESHOLD) {
      return {
        labelKey: "health.degraded",
        labelFallback: "降级",
        status: ProviderHealthStatus.Degraded,
        color: "bg-yellow-500",
        bgColor: "bg-yellow-500/10",
        textColor: "text-yellow-600 dark:text-yellow-400",
      };
    }

    return {
      labelKey: "health.circuitOpen",
      labelFallback: "熔断",
      status: ProviderHealthStatus.Failed,
      color: "bg-red-500",
      bgColor: "bg-red-500/10",
      textColor: "text-red-600 dark:text-red-400",
    };
  };

  const statusConfig = getStatus();
  const label = t(statusConfig.labelKey, {
    defaultValue: statusConfig.labelFallback,
  });

  const baseTitle = t("health.consecutiveFailures", {
    count: consecutiveFailures,
    defaultValue: `连续失败 ${consecutiveFailures} 次`,
  });

  const formattedReason = formatCircuitReason(lastError);
  const reasonText =
    formattedReason ??
    t("health.circuitReasonUnavailable", {
      defaultValue: "暂无详细原因，请查看日志",
    });

  const title =
    consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD
      ? `${baseTitle}\n${t("health.circuitReason", {
          reason: reasonText,
          defaultValue: `熔断原因：${reasonText}`,
        })}`
      : baseTitle;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium",
        statusConfig.bgColor,
        statusConfig.textColor,
        className,
      )}
      title={title}
    >
      <div className={cn("w-2 h-2 rounded-full", statusConfig.color)} />
      <span>{label}</span>
    </div>
  );
}
