import type { AppId } from "@/lib/api/types";
import type { McpServer, Provider, Settings } from "@/types";
import type {
  AppProxyConfig,
  ProviderSessionOccupancy,
  SessionProviderBinding,
} from "@/types/proxy";

type ProvidersByApp = Record<AppId, Record<string, Provider>>;
type CurrentProviderState = Record<AppId, string>;
type McpConfigState = Record<AppId, Record<string, McpServer>>;
type AppProxyConfigState = Record<AppId, AppProxyConfig>;
type SessionBindingsState = Record<AppId, Record<string, SessionProviderBinding>>;

const createDefaultProviders = (): ProvidersByApp => ({
  claude: {
    "claude-1": {
      id: "claude-1",
      name: "Claude Default",
      settingsConfig: {},
      category: "official",
      sortIndex: 0,
      createdAt: Date.now(),
    },
    "claude-2": {
      id: "claude-2",
      name: "Claude Custom",
      settingsConfig: {},
      category: "custom",
      sortIndex: 1,
      createdAt: Date.now() + 1,
    },
  },
  codex: {
    "codex-1": {
      id: "codex-1",
      name: "Codex Default",
      settingsConfig: {},
      category: "official",
      sortIndex: 0,
      createdAt: Date.now(),
    },
    "codex-2": {
      id: "codex-2",
      name: "Codex Secondary",
      settingsConfig: {},
      category: "custom",
      sortIndex: 1,
      createdAt: Date.now() + 1,
    },
  },
  gemini: {
    "gemini-1": {
      id: "gemini-1",
      name: "Gemini Default",
      settingsConfig: {
        env: {
          GEMINI_API_KEY: "test-key",
          GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com",
        },
      },
      category: "official",
      sortIndex: 0,
      createdAt: Date.now(),
    },
  },
  opencode: {},
  openclaw: {},
});

const createDefaultCurrent = (): CurrentProviderState => ({
  claude: "claude-1",
  codex: "codex-1",
  gemini: "gemini-1",
  opencode: "",
  openclaw: "",
});

const createDefaultAppProxyConfig = (appType: AppId): AppProxyConfig => ({
  appType,
  enabled: false,
  autoFailoverEnabled: false,
  maxRetries: 3,
  streamingFirstByteTimeout: 30,
  streamingIdleTimeout: 30,
  nonStreamingTimeout: 60,
  circuitFailureThreshold: 3,
  circuitSuccessThreshold: 2,
  circuitTimeoutSeconds: 60,
  circuitErrorRateThreshold: 50,
  circuitMinRequests: 5,
  sessionRoutingEnabled: false,
  sessionRoutingStrategy: "priority",
  sessionMaxSessionsPerProvider: 1,
  sessionAllowSharedWhenExhausted: false,
  sessionIdleTtlMinutes: 30,
});

const createDefaultAppProxyConfigs = (): AppProxyConfigState => ({
  claude: createDefaultAppProxyConfig("claude"),
  codex: createDefaultAppProxyConfig("codex"),
  gemini: createDefaultAppProxyConfig("gemini"),
  opencode: createDefaultAppProxyConfig("opencode"),
  openclaw: createDefaultAppProxyConfig("openclaw"),
});

const createDefaultSessionBindings = (): SessionBindingsState => ({
  claude: {},
  codex: {},
  gemini: {},
  opencode: {},
  openclaw: {},
});

let providers = createDefaultProviders();
let current = createDefaultCurrent();
let appProxyConfigs = createDefaultAppProxyConfigs();
let sessionRoutingMasterEnabled = false;
let sessionBindings = createDefaultSessionBindings();
let settingsState: Settings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  enableClaudePluginIntegration: false,
  claudeConfigDir: "/default/claude",
  codexConfigDir: "/default/codex",
  language: "zh",
};
let appConfigDirOverride: string | null = null;
let mcpConfigs: McpConfigState = {
  claude: {
    sample: {
      id: "sample",
      name: "Sample Claude Server",
      enabled: true,
      apps: { claude: true, codex: false, gemini: false, opencode: false, openclaw: false },
      server: {
        type: "stdio",
        command: "claude-server",
      },
    },
  },
  codex: {
    httpServer: {
      id: "httpServer",
      name: "HTTP Codex Server",
      enabled: false,
      apps: { claude: false, codex: true, gemini: false, opencode: false, openclaw: false },
      server: {
        type: "http",
        url: "http://localhost:3000",
      },
    },
  },
  gemini: {},
  opencode: {},
  openclaw: {},
};

const cloneProviders = (value: ProvidersByApp) =>
  JSON.parse(JSON.stringify(value)) as ProvidersByApp;

export const resetProviderState = () => {
  providers = createDefaultProviders();
  current = createDefaultCurrent();
  appProxyConfigs = createDefaultAppProxyConfigs();
  sessionRoutingMasterEnabled = false;
  sessionBindings = createDefaultSessionBindings();
  settingsState = {
    showInTray: true,
    minimizeToTrayOnClose: true,
    enableClaudePluginIntegration: false,
    claudeConfigDir: "/default/claude",
    codexConfigDir: "/default/codex",
    language: "zh",
  };
  appConfigDirOverride = null;
  mcpConfigs = {
    claude: {
      sample: {
        id: "sample",
        name: "Sample Claude Server",
        enabled: true,
        apps: { claude: true, codex: false, gemini: false, opencode: false, openclaw: false },
        server: {
          type: "stdio",
          command: "claude-server",
        },
      },
    },
    codex: {
      httpServer: {
        id: "httpServer",
        name: "HTTP Codex Server",
        enabled: false,
        apps: { claude: false, codex: true, gemini: false, opencode: false, openclaw: false },
        server: {
          type: "http",
          url: "http://localhost:3000",
        },
      },
    },
    gemini: {},
    opencode: {},
    openclaw: {},
  };
};

export const getProviders = (appType: AppId) =>
  cloneProviders(providers)[appType] ?? {};

export const getCurrentProviderId = (appType: AppId) => current[appType] ?? "";

export const setCurrentProviderId = (appType: AppId, providerId: string) => {
  current[appType] = providerId;
};

export const updateProviders = (
  appType: AppId,
  data: Record<string, Provider>,
) => {
  providers[appType] = cloneProviders({ [appType]: data } as ProvidersByApp)[
    appType
  ];
};

export const setProviders = (
  appType: AppId,
  data: Record<string, Provider>,
) => {
  providers[appType] = JSON.parse(JSON.stringify(data)) as Record<
    string,
    Provider
  >;
};

export const addProvider = (appType: AppId, provider: Provider) => {
  providers[appType] = providers[appType] ?? {};
  providers[appType][provider.id] = provider;
};

export const updateProvider = (appType: AppId, provider: Provider) => {
  if (!providers[appType]) return;
  providers[appType][provider.id] = {
    ...providers[appType][provider.id],
    ...provider,
  };
};

export const deleteProvider = (appType: AppId, providerId: string) => {
  if (!providers[appType]) return;
  delete providers[appType][providerId];
  if (current[appType] === providerId) {
    const fallback = Object.keys(providers[appType])[0] ?? "";
    current[appType] = fallback;
  }
};

export const updateSortOrder = (
  appType: AppId,
  updates: { id: string; sortIndex: number }[],
) => {
  if (!providers[appType]) return;
  updates.forEach(({ id, sortIndex }) => {
    const provider = providers[appType][id];
    if (provider) {
      providers[appType][id] = { ...provider, sortIndex };
    }
  });
};

export const listProviders = (appType: AppId) =>
  JSON.parse(JSON.stringify(providers[appType] ?? {})) as Record<
    string,
    Provider
  >;

export const getSessionRoutingMasterEnabledState = () =>
  sessionRoutingMasterEnabled;

export const setSessionRoutingMasterEnabledState = (value: boolean) => {
  sessionRoutingMasterEnabled = value;
};

export const getAppProxyConfig = (appType: AppId) =>
  JSON.parse(JSON.stringify(appProxyConfigs[appType])) as AppProxyConfig;

export const setAppProxyConfig = (appType: AppId, value: AppProxyConfig) => {
  appProxyConfigs[appType] = JSON.parse(JSON.stringify(value)) as AppProxyConfig;
};

export const listSessionProviderBindings = (
  appType: AppId,
): SessionProviderBinding[] =>
  Object.values(sessionBindings[appType] ?? {}).map(
    (item) => JSON.parse(JSON.stringify(item)) as SessionProviderBinding,
  );

export const getSessionProviderBinding = (
  appType: AppId,
  sessionId: string,
): SessionProviderBinding | null => {
  const item = sessionBindings[appType]?.[sessionId];
  if (!item) return null;
  return JSON.parse(JSON.stringify(item)) as SessionProviderBinding;
};

export const switchSessionProviderBinding = (
  appType: AppId,
  sessionId: string,
  providerId: string,
  pin?: boolean,
): SessionProviderBinding => {
  const now = Date.now();
  const currentBinding = sessionBindings[appType]?.[sessionId];
  const providerName = providers[appType]?.[providerId]?.name ?? providerId;
  const next: SessionProviderBinding = {
    appType,
    sessionId,
    providerId,
    providerName,
    pinned: pin ?? currentBinding?.pinned ?? false,
    createdAt: currentBinding?.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: now,
    isActive: true,
  };

  if (!sessionBindings[appType]) {
    sessionBindings[appType] = {};
  }
  sessionBindings[appType][sessionId] = next;
  return JSON.parse(JSON.stringify(next)) as SessionProviderBinding;
};

export const setSessionProviderBindingPin = (
  appType: AppId,
  sessionId: string,
  pinned: boolean,
) => {
  const currentBinding = sessionBindings[appType]?.[sessionId];
  if (!currentBinding) return;
  sessionBindings[appType][sessionId] = {
    ...currentBinding,
    pinned,
    updatedAt: Date.now(),
  };
};

export const removeSessionProviderBinding = (appType: AppId, sessionId: string) => {
  if (!sessionBindings[appType]) return;
  delete sessionBindings[appType][sessionId];
};

export const getProviderSessionOccupancy = (
  appType: AppId,
): ProviderSessionOccupancy[] => {
  const counts = new Map<string, number>();
  const providerNames = new Map<string, string>();

  for (const binding of Object.values(sessionBindings[appType] ?? {})) {
    if (!binding.isActive) continue;
    counts.set(binding.providerId, (counts.get(binding.providerId) ?? 0) + 1);
    providerNames.set(binding.providerId, binding.providerName ?? binding.providerId);
  }

  return Array.from(counts.entries())
    .map(([providerId, sessionCount]) => ({
      providerId,
      providerName: providerNames.get(providerId) ?? providerId,
      sessionCount,
    }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName));
};

export const getSettings = () =>
  JSON.parse(JSON.stringify(settingsState)) as Settings;

export const setSettings = (data: Partial<Settings>) => {
  settingsState = { ...settingsState, ...data };
};

export const getAppConfigDirOverride = () => appConfigDirOverride;

export const setAppConfigDirOverrideState = (value: string | null) => {
  appConfigDirOverride = value;
};

export const getMcpConfig = (appType: AppId) => {
  const servers = JSON.parse(
    JSON.stringify(mcpConfigs[appType] ?? {}),
  ) as Record<string, McpServer>;
  return {
    configPath: `/mock/${appType}.mcp.json`,
    servers,
  };
};

export const setMcpConfig = (
  appType: AppId,
  value: Record<string, McpServer>,
) => {
  mcpConfigs[appType] = JSON.parse(JSON.stringify(value)) as Record<
    string,
    McpServer
  >;
};

export const setMcpServerEnabled = (
  appType: AppId,
  id: string,
  enabled: boolean,
) => {
  if (!mcpConfigs[appType]?.[id]) return;
  mcpConfigs[appType][id] = {
    ...mcpConfigs[appType][id],
    enabled,
  };
};

export const upsertMcpServer = (
  appType: AppId,
  id: string,
  server: McpServer,
) => {
  if (!mcpConfigs[appType]) {
    mcpConfigs[appType] = {};
  }
  mcpConfigs[appType][id] = JSON.parse(JSON.stringify(server)) as McpServer;
};

export const deleteMcpServer = (appType: AppId, id: string) => {
  if (!mcpConfigs[appType]) return;
  delete mcpConfigs[appType][id];
};
