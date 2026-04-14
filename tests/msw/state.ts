import type { AppId } from "@/lib/api/types";
import type {
  McpServer,
  Provider,
  SessionMessage,
  SessionMeta,
  Settings,
} from "@/types";
import type {
  AppProxyConfig,
  FailoverQueueItem,
  ProviderHealth,
  ReleaseProviderSessionBindingsResult,
  ProviderSessionOccupancy,
  SessionProviderBinding,
} from "@/types/proxy";

type ProvidersByApp = Record<AppId, Record<string, Provider>>;
type CurrentProviderState = Record<AppId, string>;
type McpConfigState = Record<AppId, Record<string, McpServer>>;
type AppProxyConfigState = Record<AppId, AppProxyConfig>;
type ProviderHealthState = Record<AppId, Record<string, ProviderHealth>>;
type SessionBindingsState = Record<AppId, Record<string, SessionProviderBinding>>;
type ProviderDefaultTemplateState = Partial<
  Record<"claude" | "codex" | "gemini", string | null>
>;

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
  forceModelEnabled: false,
  forceModel: "",
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
  zeroTokenAnomalyEnabled: false,
  zeroTokenAnomalyThreshold: 3,
  sessionRoutingEnabled: false,
  sessionRoutingStrategy: "priority",
  sessionDefaultProviderId: "",
  publicProviderPriorityEnabled: false,
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

const createDefaultProviderHealthState = (): ProviderHealthState => ({
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
let providerHealthState = createDefaultProviderHealthState();
let settingsState: Settings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  enableClaudePluginIntegration: false,
  claudeConfigDir: "/default/claude",
  codexConfigDir: "/default/codex",
  language: "zh",
  firstRunNoticeConfirmed: true,
  skillStorageLocation: "cc_switch",
};
let appConfigDirOverride: string | null = null;
let providerDefaultTemplates: ProviderDefaultTemplateState = {
  claude: null,
  codex: null,
  gemini: null,
};
let sessionsState: SessionMeta[] = [];
let sessionMessagesState: Record<string, SessionMessage[]> = {};
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
  providerHealthState = createDefaultProviderHealthState();
  settingsState = {
    showInTray: true,
    minimizeToTrayOnClose: true,
    enableClaudePluginIntegration: false,
    claudeConfigDir: "/default/claude",
    codexConfigDir: "/default/codex",
    language: "zh",
    firstRunNoticeConfirmed: true,
    skillStorageLocation: "cc_switch",
  };
  appConfigDirOverride = null;
  providerDefaultTemplates = {
    claude: null,
    codex: null,
    gemini: null,
  };
  sessionsState = [];
  sessionMessagesState = {};
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

export const setSessionFixtures = (
  sessions: SessionMeta[],
  messages: Record<string, SessionMessage[]>,
) => {
  sessionsState = JSON.parse(JSON.stringify(sessions)) as SessionMeta[];
  sessionMessagesState = JSON.parse(
    JSON.stringify(messages),
  ) as Record<string, SessionMessage[]>;
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

export const getAutoFailoverEnabledState = (appType: AppId) =>
  appProxyConfigs[appType]?.autoFailoverEnabled === true;

export const setAutoFailoverEnabledState = (appType: AppId, enabled: boolean) => {
  appProxyConfigs[appType] = {
    ...appProxyConfigs[appType],
    autoFailoverEnabled: enabled,
  };
};

export const getFailoverQueue = (appType: AppId): FailoverQueueItem[] =>
  Object.values(providers[appType] ?? {})
    .filter((provider) => provider.inFailoverQueue === true)
    .sort((left, right) => {
      const leftSort = left.sortIndex ?? Number.MAX_SAFE_INTEGER;
      const rightSort = right.sortIndex ?? Number.MAX_SAFE_INTEGER;
      if (leftSort !== rightSort) return leftSort - rightSort;
      const leftCreated = left.createdAt ?? Number.MAX_SAFE_INTEGER;
      const rightCreated = right.createdAt ?? Number.MAX_SAFE_INTEGER;
      if (leftCreated !== rightCreated) return leftCreated - rightCreated;
      return left.name.localeCompare(right.name);
    })
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      sortIndex: provider.sortIndex,
    }));

export const getAvailableProvidersForFailover = (appType: AppId): Provider[] =>
  Object.values(providers[appType] ?? {})
    .filter((provider) => provider.inFailoverQueue !== true)
    .map((provider) => JSON.parse(JSON.stringify(provider)) as Provider);

export const addToFailoverQueueState = (appType: AppId, providerId: string) => {
  const provider = providers[appType]?.[providerId];
  if (!provider) return;
  providers[appType][providerId] = {
    ...provider,
    inFailoverQueue: true,
  };
};

export const removeFromFailoverQueueState = (
  appType: AppId,
  providerId: string,
) => {
  const provider = providers[appType]?.[providerId];
  if (!provider) return;
  providers[appType][providerId] = {
    ...provider,
    inFailoverQueue: false,
  };
};

export const getProviderHealthState = (
  appType: AppId,
  providerId: string,
): ProviderHealth => {
  return (
    providerHealthState[appType]?.[providerId] ?? {
      provider_id: providerId,
      app_type: appType,
      is_healthy: true,
      consecutive_failures: 0,
      zero_token_anomaly_streak: 0,
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    }
  );
};

export const setProviderHealthState = (
  appType: AppId,
  providerId: string,
  value: Partial<ProviderHealth>,
) => {
  providerHealthState[appType][providerId] = {
    ...getProviderHealthState(appType, providerId),
    ...value,
    provider_id: providerId,
    app_type: appType,
  };
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
  const providerIsPublic = providers[appType]?.[providerId]?.isPublic === true;
  const next: SessionProviderBinding = {
    appType,
    sessionId,
    providerId,
    providerName,
    providerIsPublic,
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

export const releaseProviderSessionBindings = (
  appType: AppId,
  providerId: string,
): ReleaseProviderSessionBindingsResult => {
  const bindings = Object.values(sessionBindings[appType] ?? {}).filter(
    (binding) => binding.isActive && binding.providerId === providerId,
  );
  if (bindings.length === 0) {
    return {
      totalAffected: 0,
      reboundCount: 0,
      unboundCount: 0,
      suggestIncreaseMaxSessions: false,
    };
  }

  const config = appProxyConfigs[appType];
  const candidates = Object.keys(providers[appType] ?? {}).filter(
    (id) => id !== providerId,
  );
  let reboundCount = 0;
  let unboundCount = 0;

  for (const binding of bindings) {
    const occupancy = getProviderSessionOccupancy(appType);
    const availableCandidate = candidates.find((candidateId) => {
      const count =
        occupancy.find((item) => item.providerId === candidateId)?.sessionCount ?? 0;
      if (!config.sessionAllowSharedWhenExhausted) {
        return count < config.sessionMaxSessionsPerProvider;
      }
      return true;
    });

    if (availableCandidate) {
      switchSessionProviderBinding(
        appType,
        binding.sessionId,
        availableCandidate,
        binding.pinned,
      );
      reboundCount += 1;
    } else {
      removeSessionProviderBinding(appType, binding.sessionId);
      unboundCount += 1;
    }
  }

  const suggestIncreaseMaxSessions =
    unboundCount > 0 &&
    !config.sessionAllowSharedWhenExhausted &&
    config.sessionMaxSessionsPerProvider > 0 &&
    candidates.length > 0;

  return {
    totalAffected: bindings.length,
    reboundCount,
    unboundCount,
    suggestIncreaseMaxSessions,
  };
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

export const getProviderDefaultTemplateState = (
  appType: "claude" | "codex" | "gemini",
) => providerDefaultTemplates[appType] ?? null;

export const setProviderDefaultTemplateState = (
  appType: "claude" | "codex" | "gemini",
  value: string | null,
) => {
  providerDefaultTemplates[appType] = value;
};

export const listSessions = (): SessionMeta[] =>
  JSON.parse(JSON.stringify(sessionsState)) as SessionMeta[];

export const getSessionMessages = (
  providerId: string,
  sourcePath: string,
): SessionMessage[] => {
  const key = `${providerId}:${sourcePath}`;
  return JSON.parse(JSON.stringify(sessionMessagesState[key] ?? [])) as SessionMessage[];
};

export const deleteSession = (
  providerId: string,
  sessionId: string,
  sourcePath: string,
) => {
  sessionsState = sessionsState.filter(
    (session) =>
      !(
        session.providerId === providerId &&
        session.sessionId === sessionId &&
        session.sourcePath === sourcePath
      ),
  );
  delete sessionMessagesState[`${providerId}:${sourcePath}`];
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
