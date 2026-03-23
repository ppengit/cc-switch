import { invoke } from "@tauri-apps/api/core";
import type {
  AppProxyConfig,
  GlobalProxyConfig,
  ProviderSessionOccupancy,
  ProxyConfig,
  ReleaseProviderSessionBindingsResult,
  ProxyServerInfo,
  ProxyStatus,
  ProxyTakeoverStatus,
  SessionProviderBinding,
} from "@/types/proxy";

export const proxyApi = {
  async startProxyServer(): Promise<ProxyServerInfo> {
    return invoke("start_proxy_server");
  },

  async stopProxyWithRestore(): Promise<void> {
    return invoke("stop_proxy_with_restore");
  },

  async getProxyStatus(): Promise<ProxyStatus> {
    return invoke("get_proxy_status");
  },

  async isProxyRunning(): Promise<boolean> {
    return invoke("is_proxy_running");
  },

  async isLiveTakeoverActive(): Promise<boolean> {
    return invoke("is_live_takeover_active");
  },

  async switchProxyProvider(
    appType: string,
    providerId: string,
  ): Promise<void> {
    return invoke("switch_proxy_provider", { appType, providerId });
  },

  async getProxyTakeoverStatus(): Promise<ProxyTakeoverStatus> {
    return invoke("get_proxy_takeover_status");
  },

  async setProxyTakeoverForApp(
    appType: string,
    enabled: boolean,
  ): Promise<void> {
    return invoke("set_proxy_takeover_for_app", { appType, enabled });
  },

  async getProxyConfig(): Promise<ProxyConfig> {
    return invoke("get_proxy_config");
  },

  async updateProxyConfig(config: ProxyConfig): Promise<void> {
    return invoke("update_proxy_config", { config });
  },

  async getGlobalProxyConfig(): Promise<GlobalProxyConfig> {
    return invoke("get_global_proxy_config");
  },

  async updateGlobalProxyConfig(config: GlobalProxyConfig): Promise<void> {
    return invoke("update_global_proxy_config", { config });
  },

  async getProxyConfigForApp(appType: string): Promise<AppProxyConfig> {
    return invoke("get_proxy_config_for_app", { appType });
  },

  async updateProxyConfigForApp(config: AppProxyConfig): Promise<void> {
    return invoke("update_proxy_config_for_app", { config });
  },

  async listSessionProviderBindings(
    appType: string,
    idleTtlMinutes?: number,
  ): Promise<SessionProviderBinding[]> {
    return invoke("list_session_provider_bindings", {
      appType,
      idleTtlMinutes,
    });
  },

  async getSessionProviderBinding(
    appType: string,
    sessionId: string,
    idleTtlMinutes?: number,
  ): Promise<SessionProviderBinding | null> {
    return invoke("get_session_provider_binding", {
      appType,
      sessionId,
      idleTtlMinutes,
    });
  },

  async switchSessionProviderBinding(
    appType: string,
    sessionId: string,
    providerId: string,
    pin?: boolean,
  ): Promise<SessionProviderBinding> {
    return invoke("switch_session_provider_binding", {
      appType,
      sessionId,
      providerId,
      pin,
    });
  },

  async setSessionProviderBindingPin(
    appType: string,
    sessionId: string,
    pinned: boolean,
  ): Promise<void> {
    return invoke("set_session_provider_binding_pin", {
      appType,
      sessionId,
      pinned,
    });
  },

  async removeSessionProviderBinding(
    appType: string,
    sessionId: string,
  ): Promise<void> {
    return invoke("remove_session_provider_binding", {
      appType,
      sessionId,
    });
  },

  async releaseProviderSessionBindings(
    appType: string,
    providerId: string,
    idleTtlMinutes?: number,
  ): Promise<ReleaseProviderSessionBindingsResult> {
    return invoke("release_provider_session_bindings", {
      appType,
      providerId,
      idleTtlMinutes,
    });
  },

  async getProviderSessionOccupancy(
    appType: string,
    idleTtlMinutes?: number,
  ): Promise<ProviderSessionOccupancy[]> {
    return invoke("get_provider_session_occupancy", {
      appType,
      idleTtlMinutes,
    });
  },

  async getDefaultCostMultiplier(appType: string): Promise<string> {
    return invoke("get_default_cost_multiplier", { appType });
  },

  async setDefaultCostMultiplier(
    appType: string,
    value: string,
  ): Promise<void> {
    return invoke("set_default_cost_multiplier", { appType, value });
  },

  async getPricingModelSource(appType: string): Promise<string> {
    return invoke("get_pricing_model_source", { appType });
  },

  async setPricingModelSource(appType: string, value: string): Promise<void> {
    return invoke("set_pricing_model_source", { appType, value });
  },
};
