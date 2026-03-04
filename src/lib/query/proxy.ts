import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { proxyApi } from "@/lib/api/proxy";
import type {
  AppProxyConfig,
  GlobalProxyConfig,
  ProviderSessionOccupancy,
  SessionProviderBinding,
} from "@/types/proxy";

export function useProxyStatus() {
  return useQuery({
    queryKey: ["proxyStatus"],
    queryFn: () => proxyApi.getProxyStatus(),
    refetchInterval: 5000,
  });
}

export function useIsProxyRunning() {
  return useQuery({
    queryKey: ["proxyRunning"],
    queryFn: () => proxyApi.isProxyRunning(),
    refetchInterval: 2000,
  });
}

export function useIsLiveTakeoverActive() {
  return useQuery({
    queryKey: ["liveTakeoverActive"],
    queryFn: () => proxyApi.isLiveTakeoverActive(),
    refetchInterval: 2000,
  });
}

export function useProxyTakeoverStatus() {
  return useQuery({
    queryKey: ["proxyTakeoverStatus"],
    queryFn: () => proxyApi.getProxyTakeoverStatus(),
    refetchInterval: 2000,
  });
}

export function useStartProxyServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => proxyApi.startProxyServer(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
      queryClient.invalidateQueries({ queryKey: ["proxyRunning"] });
      queryClient.invalidateQueries({ queryKey: ["liveTakeoverActive"] });
      queryClient.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] });
    },
  });
}

export function useStopProxyServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => proxyApi.stopProxyWithRestore(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
      queryClient.invalidateQueries({ queryKey: ["proxyRunning"] });
      queryClient.invalidateQueries({ queryKey: ["liveTakeoverActive"] });
      queryClient.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] });
    },
  });
}

export function useSetProxyTakeoverForApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ appType, enabled }: { appType: string; enabled: boolean }) =>
      proxyApi.setProxyTakeoverForApp(appType, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] });
      queryClient.invalidateQueries({ queryKey: ["liveTakeoverActive"] });
    },
  });
}

export function useSwitchProxyProvider() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: ({
      appType,
      providerId,
    }: {
      appType: string;
      providerId: string;
    }) => proxyApi.switchProxyProvider(appType, providerId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
      queryClient.invalidateQueries({
        queryKey: ["providers", variables.appType],
      });
    },
    onError: (error: Error) => {
      toast.error(t("proxy.switchFailed", { error: error.message }));
    },
  });
}

export function useProxyConfig() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const { data: config, isLoading } = useQuery({
    queryKey: ["proxyConfig"],
    queryFn: () => proxyApi.getProxyConfig(),
  });

  const updateMutation = useMutation({
    mutationFn: proxyApi.updateProxyConfig,
    onSuccess: () => {
      toast.success(t("proxy.settings.toast.saved"), { closeButton: true });
      queryClient.invalidateQueries({ queryKey: ["proxyConfig"] });
      queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
    },
    onError: (error: Error) => {
      toast.error(
        t("proxy.settings.toast.saveFailed", { error: error.message }),
      );
    },
  });

  return {
    config,
    isLoading,
    updateConfig: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
  };
}

export function useGlobalProxyConfig() {
  return useQuery({
    queryKey: ["globalProxyConfig"],
    queryFn: () => proxyApi.getGlobalProxyConfig(),
  });
}

export function useUpdateGlobalProxyConfig() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (config: GlobalProxyConfig) =>
      proxyApi.updateGlobalProxyConfig(config),
    onSuccess: () => {
      toast.success(t("proxy.settings.toast.saved"), { closeButton: true });
      queryClient.invalidateQueries({ queryKey: ["globalProxyConfig"] });
      queryClient.invalidateQueries({ queryKey: ["proxyConfig"] });
      queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
    },
    onError: (error: Error) => {
      toast.error(
        t("proxy.settings.toast.saveFailed", { error: error.message }),
      );
    },
  });
}

export function useAppProxyConfig(appType: string) {
  return useQuery({
    queryKey: ["appProxyConfig", appType],
    queryFn: () => proxyApi.getProxyConfigForApp(appType),
    enabled: !!appType,
  });
}

export function useUpdateAppProxyConfig() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: ({
      config,
    }: {
      config: AppProxyConfig;
      successMessage?: string;
      skipSuccessToast?: boolean;
      skipErrorToast?: boolean;
    }) => proxyApi.updateProxyConfigForApp(config),
    onSuccess: (_, variables) => {
      if (!variables.skipSuccessToast) {
        toast.success(
          variables.successMessage ?? t("proxy.settings.toast.saved"),
          {
            closeButton: true,
          },
        );
      }
      queryClient.invalidateQueries({
        queryKey: ["appProxyConfig", variables.config.appType],
      });
      queryClient.invalidateQueries({ queryKey: ["proxyConfig"] });
      queryClient.invalidateQueries({ queryKey: ["circuitBreakerConfig"] });
      queryClient.invalidateQueries({
        queryKey: ["sessionProviderBindings", variables.config.appType],
      });
      queryClient.invalidateQueries({
        queryKey: ["providerSessionOccupancy", variables.config.appType],
      });
    },
    onError: (error: Error, variables) => {
      if (variables?.skipErrorToast) {
        return;
      }
      toast.error(
        t("proxy.settings.toast.saveFailed", { error: error.message }),
      );
    },
  });
}

export function useSessionRoutingMasterEnabled() {
  return useQuery({
    queryKey: ["sessionRoutingMasterEnabled"],
    queryFn: () => proxyApi.getSessionRoutingMasterEnabled(),
  });
}

export function useSetSessionRoutingMasterEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enabled: boolean) =>
      proxyApi.setSessionRoutingMasterEnabled(enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["sessionRoutingMasterEnabled"],
      });
      queryClient.invalidateQueries({ queryKey: ["sessionProviderBindings"] });
      queryClient.invalidateQueries({ queryKey: ["providerSessionOccupancy"] });
    },
  });
}

export function useSessionProviderBindings(
  appType: string,
  idleTtlMinutes?: number,
) {
  return useQuery<SessionProviderBinding[]>({
    queryKey: ["sessionProviderBindings", appType, idleTtlMinutes ?? null],
    queryFn: () =>
      proxyApi.listSessionProviderBindings(appType, idleTtlMinutes),
    enabled: !!appType,
    refetchInterval: 5000,
  });
}

export function useSessionProviderBinding(
  appType?: string,
  sessionId?: string,
  idleTtlMinutes?: number,
) {
  return useQuery<SessionProviderBinding | null>({
    queryKey: [
      "sessionProviderBinding",
      appType ?? null,
      sessionId ?? null,
      idleTtlMinutes ?? null,
    ],
    queryFn: () =>
      proxyApi.getSessionProviderBinding(appType!, sessionId!, idleTtlMinutes),
    enabled: Boolean(appType && sessionId),
    refetchInterval: 5000,
  });
}

export function useSwitchSessionProviderBinding() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      appType,
      sessionId,
      providerId,
      pin,
    }: {
      appType: string;
      sessionId: string;
      providerId: string;
      pin?: boolean;
    }) =>
      proxyApi.switchSessionProviderBinding(
        appType,
        sessionId,
        providerId,
        pin,
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["sessionProviderBindings", variables.appType],
      });
      queryClient.invalidateQueries({
        queryKey: ["providerSessionOccupancy", variables.appType],
      });
      queryClient.invalidateQueries({
        queryKey: [
          "sessionProviderBinding",
          variables.appType,
          variables.sessionId,
        ],
      });
    },
  });
}

export function useSetSessionProviderBindingPin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      appType,
      sessionId,
      pinned,
    }: {
      appType: string;
      sessionId: string;
      pinned: boolean;
    }) => proxyApi.setSessionProviderBindingPin(appType, sessionId, pinned),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["sessionProviderBindings", variables.appType],
      });
      queryClient.invalidateQueries({
        queryKey: [
          "sessionProviderBinding",
          variables.appType,
          variables.sessionId,
        ],
      });
    },
  });
}

export function useRemoveSessionProviderBinding() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      appType,
      sessionId,
    }: {
      appType: string;
      sessionId: string;
    }) => proxyApi.removeSessionProviderBinding(appType, sessionId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["sessionProviderBindings", variables.appType],
      });
      queryClient.invalidateQueries({
        queryKey: ["providerSessionOccupancy", variables.appType],
      });
      queryClient.invalidateQueries({
        queryKey: [
          "sessionProviderBinding",
          variables.appType,
          variables.sessionId,
        ],
      });
    },
  });
}

export function useProviderSessionOccupancy(
  appType: string,
  idleTtlMinutes?: number,
) {
  return useQuery<ProviderSessionOccupancy[]>({
    queryKey: ["providerSessionOccupancy", appType, idleTtlMinutes ?? null],
    queryFn: () =>
      proxyApi.getProviderSessionOccupancy(appType, idleTtlMinutes),
    enabled: !!appType,
    refetchInterval: 5000,
  });
}
