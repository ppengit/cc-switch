import type { AppId } from "@/lib/api/types";
import type {
  ManagedAuthAccount,
  ManagedAuthDeviceCodeResponse,
  ManagedAuthProvider,
  ManagedAuthStatus,
} from "@/lib/api/auth";
import type { AppConfigTemplateFile } from "@/lib/api/config";
import type { LogConfig } from "@/lib/api/settings";
import type { Prompt } from "@/lib/api/prompts";
import type {
  DiscoverableSkill,
  ImportSkillSelection,
  InstalledSkill,
  SkillBackupEntry,
  SkillRepo,
  SkillUpdateInfo,
  SkillsShDiscoverableSkill,
  UnmanagedSkill,
} from "@/lib/api/skills";
import type {
  HermesMemoryKind,
  HermesMemoryLimits,
  McpServer,
  OpenClawEnvConfig,
  OpenClawAgentsDefaults,
  OpenClawToolsConfig,
  Provider,
  RemoteSnapshotInfo,
  SessionMessage,
  SessionMeta,
  Settings,
  WebDavSyncSettings,
} from "@/types";
import type {
  DailyStats,
  DataSourceSummary,
  ModelPricing,
  ModelStats,
  ProviderStats,
  RequestLog,
  UsageSummaryByApp,
} from "@/types/usage";
import type {
  AppProxyConfig,
  CircuitBreakerStats,
  FailoverQueueItem,
  GlobalProxyConfig,
  ProviderHealth,
  ProxyServerInfo,
  ProxyStatus,
} from "@/types/proxy";
import { deepClone } from "@/utils/deepClone";

type ProvidersByApp = Record<AppId, Record<string, Provider>>;
type CurrentProviderState = Record<AppId, string>;
type McpConfigState = Record<AppId, Record<string, McpServer>>;
type LiveProviderIdsByApp = Record<
  "opencode" | "openclaw" | "hermes",
  string[]
>;
type ProxyTakeoverStatusByApp = Record<AppId, boolean>;
type SwitchModeAppId = "claude" | "codex" | "gemini";
type AppProxyConfigByApp = Record<AppId, AppProxyConfig>;
type FailoverQueueByApp = Record<AppId, FailoverQueueItem[]>;
type SwitchLiveSettingsByApp = Record<SwitchModeAppId, unknown>;
type ProviderDefaultTemplatesByApp = Record<AppId, string | null>;
type AppConfigTemplatesByApp = Record<AppId, AppConfigTemplateFile[]>;
type AutoFailoverEnabledByApp = Record<AppId, boolean>;
type ProviderHealthState = Record<string, ProviderHealth>;
type CircuitBreakerStatsState = Record<string, CircuitBreakerStats | null>;
type McpServersState = Record<string, McpServer>;
type PromptState = Record<AppId, Record<string, Prompt>>;
type CurrentPromptFileContentByApp = Record<AppId, string | null>;
type ProxyProviderSwitchRequest = { appType: AppId; providerId: string };
type HermesMemoryState = Record<HermesMemoryKind, string>;
type WorkspaceFileState = Record<string, string | null>;
type PromptUpsertRequest = { app: AppId; id: string; prompt: Prompt };
type PromptEnableRequest = { app: AppId; id: string };
type PromptDeleteRequest = { app: AppId; id: string };
type PromptRequestCounts = Record<
  AppId,
  {
    getPrompts: number;
    getCurrentFileContent: number;
    importFromFile: number;
  }
>;
type ManagedAuthStatusByProvider = Record<
  ManagedAuthProvider,
  ManagedAuthStatus
>;
type ManagedAuthStartLoginRequest = {
  authProvider: ManagedAuthProvider;
  githubDomain: string | null;
};
type ManagedAuthPollRequest = {
  authProvider: ManagedAuthProvider;
  deviceCode: string;
  githubDomain: string | null;
};
type WebdavRemoteInfoState = RemoteSnapshotInfo | { empty: true };
type SessionDeleteRequestItem = {
  providerId: string;
  sessionId: string;
  sourcePath: string;
};
type SessionTitleMappingRequest =
  | {
      action: "set";
      appType: string;
      sessionId: string;
      sourcePath: string | null;
      customTitle: string;
    }
  | {
      action: "clear";
      appType: string;
      sessionId: string;
      sourcePath: string | null;
    };
type SessionTerminalLaunchRequest = {
  command: string;
  cwd?: string | null;
  customConfig?: string | null;
};
type DbBackupEntry = {
  filename: string;
  sizeBytes: number;
  createdAt: string;
};

const APP_IDS = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "opencode",
  "openclaw",
  "hermes",
] as const satisfies readonly AppId[];

const isAppId = (value: string): value is AppId =>
  (APP_IDS as readonly string[]).includes(value);

const requireAppId = (value: string): AppId => {
  if (!isAppId(value)) {
    throw new Error(`Unknown app type: ${value}`);
  }
  return value;
};

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
  "claude-desktop": {},
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
  hermes: {},
});

const createDefaultCurrent = (): CurrentProviderState => ({
  claude: "claude-1",
  "claude-desktop": "",
  codex: "codex-1",
  gemini: "gemini-1",
  opencode: "",
  openclaw: "",
  hermes: "",
});

const createDefaultProviderTemplates = (): ProviderDefaultTemplatesByApp => ({
  claude: null,
  "claude-desktop": null,
  codex: null,
  gemini: null,
  opencode: null,
  openclaw: null,
  hermes: null,
});

const createDefaultAppConfigTemplates = (): AppConfigTemplatesByApp => ({
  claude: [],
  "claude-desktop": [],
  codex: [],
  gemini: [],
  opencode: [],
  openclaw: [],
  hermes: [],
});

const createDefaultAutoFailoverEnabled = (): AutoFailoverEnabledByApp => ({
  claude: false,
  "claude-desktop": false,
  codex: false,
  gemini: false,
  opencode: false,
  openclaw: false,
  hermes: false,
});

const createDefaultProxyTakeoverStatus = (): ProxyTakeoverStatusByApp => ({
  claude: false,
  "claude-desktop": false,
  codex: false,
  gemini: false,
  opencode: false,
  openclaw: false,
  hermes: false,
});

const createDefaultAppProxyConfig = (appType: AppId): AppProxyConfig => ({
  appType,
  enabled: false,
  autoFailoverEnabled: false,
  loadBalancingEnabled: false,
  loadBalancingStickyMinutes: 10,
  responseRescueEnabled: true,
  responseRescueEmpty2xxEnabled: false,
  responseRescue429Enabled: true,
  responseRescueMaxRetries: 2,
  maxRetries: 3,
  streamingFirstByteTimeout: 30,
  streamingIdleTimeout: 60,
  nonStreamingTimeout: 120,
  circuitFailureThreshold: 3,
  circuitSuccessThreshold: 2,
  circuitTimeoutSeconds: 60,
  circuitErrorRateThreshold: 50,
  circuitMinRequests: 5,
});

const createDefaultAppProxyConfigs = (): AppProxyConfigByApp => ({
  claude: createDefaultAppProxyConfig("claude"),
  "claude-desktop": createDefaultAppProxyConfig("claude-desktop"),
  codex: createDefaultAppProxyConfig("codex"),
  gemini: createDefaultAppProxyConfig("gemini"),
  opencode: createDefaultAppProxyConfig("opencode"),
  openclaw: createDefaultAppProxyConfig("openclaw"),
  hermes: createDefaultAppProxyConfig("hermes"),
});

const createDefaultFailoverQueues = (): FailoverQueueByApp => ({
  claude: [],
  "claude-desktop": [],
  codex: [],
  gemini: [],
  opencode: [],
  openclaw: [],
  hermes: [],
});

const createDefaultGlobalProxyConfig = (): GlobalProxyConfig => ({
  proxyEnabled: false,
  listenAddress: "127.0.0.1",
  listenPort: 15721,
  enableLogging: true,
});

const createProxyLiveSettings = (appType: SwitchModeAppId, port = 0) => {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (appType === "codex") {
    return {
      auth: { OPENAI_API_KEY: "PROXY_MANAGED" },
      config: `model_provider = "cc-switch"\n[model_providers.cc-switch]\nbase_url = "${baseUrl}/codex"\n`,
    };
  }
  if (appType === "gemini") {
    return {
      env: {
        GEMINI_API_KEY: "PROXY_MANAGED",
        GOOGLE_GEMINI_BASE_URL: baseUrl,
      },
    };
  }
  return {
    env: {
      ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
      ANTHROPIC_BASE_URL: baseUrl,
    },
  };
};

const createDefaultSwitchLiveSettings = (): SwitchLiveSettingsByApp => ({
  claude: createProxyLiveSettings("claude"),
  codex: createProxyLiveSettings("codex"),
  gemini: createProxyLiveSettings("gemini"),
});

const createDefaultManagedAuthStatus = (): ManagedAuthStatusByProvider => ({
  github_copilot: {
    provider: "github_copilot",
    authenticated: false,
    default_account_id: null,
    migration_error: null,
    accounts: [],
  },
  codex_oauth: {
    provider: "codex_oauth",
    authenticated: false,
    default_account_id: null,
    migration_error: null,
    accounts: [],
  },
});

const createSkillApps = (
  overrides: Partial<InstalledSkill["apps"]> = {},
): InstalledSkill["apps"] => ({
  claude: false,
  codex: false,
  gemini: false,
  opencode: false,
  openclaw: false,
  hermes: false,
  ...overrides,
});

const createDefaultInstalledSkills = (): InstalledSkill[] => [
  {
    id: "skill-alpha",
    name: "Skill Alpha",
    description: "Managed skill fixture",
    directory: "skill-alpha",
    repoOwner: "mock-owner",
    repoName: "mock-skills",
    repoBranch: "main",
    readmeUrl:
      "https://github.com/mock-owner/mock-skills/tree/main/skill-alpha",
    apps: createSkillApps({ claude: true }),
    installedAt: 1_700_010_000,
    updatedAt: 1_700_010_100,
    contentHash: "hash-alpha",
  },
];

const createDefaultUnmanagedSkills = (): UnmanagedSkill[] => [
  {
    directory: "legacy-skill",
    name: "Legacy Skill",
    description: "Skill discovered in existing app folders",
    foundIn: ["claude", "codex"],
    path: "/mock/.claude/skills/legacy-skill",
  },
];

const createDefaultDiscoverableSkills = (): DiscoverableSkill[] => [
  {
    key: "repo-skill:mock-owner:mock-skills",
    name: "Repo Skill",
    description: "Installable skill from a configured repo",
    directory: "repo-skill",
    repoOwner: "mock-owner",
    repoName: "mock-skills",
    repoBranch: "main",
    readmeUrl: "https://github.com/mock-owner/mock-skills/tree/main/repo-skill",
  },
];

const createDefaultSkillRepos = (): SkillRepo[] => [
  {
    owner: "mock-owner",
    name: "mock-skills",
    branch: "main",
    enabled: true,
  },
];

const createDefaultSkillBackups = (): SkillBackupEntry[] => [
  {
    backupId: "backup-alpha",
    backupPath: "/mock/backups/skill-alpha",
    createdAt: 1_700_020_000,
    skill: {
      id: "skill-restored",
      name: "Restored Skill",
      description: "Backup skill fixture",
      directory: "restored-skill",
      repoOwner: "mock-owner",
      repoName: "mock-skills",
      repoBranch: "main",
      apps: createSkillApps(),
      installedAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      contentHash: "hash-restored",
    },
  },
];

const createDefaultSkillUpdates = (): SkillUpdateInfo[] => [
  {
    id: "skill-alpha",
    name: "Skill Alpha",
    currentHash: "hash-alpha",
    remoteHash: "hash-alpha-new",
  },
];

const createDefaultSkillsShResults = (): SkillsShDiscoverableSkill[] => [
  {
    key: "skillssh-result:remote-owner:remote-skills",
    name: "Remote Skill",
    directory: "remote-skill",
    repoOwner: "remote-owner",
    repoName: "remote-skills",
    repoBranch: "main",
    installs: 42,
    readmeUrl:
      "https://github.com/remote-owner/remote-skills/tree/main/remote-skill",
  },
];

const createDefaultMcpServers = (): McpServersState => ({
  sample: {
    id: "sample",
    name: "Sample Claude Server",
    description: "Claude server fixture",
    apps: {
      claude: true,
      codex: false,
      gemini: false,
      opencode: false,
      openclaw: false,
      hermes: false,
    },
    server: {
      type: "stdio",
      command: "claude-server",
    },
  },
  httpServer: {
    id: "httpServer",
    name: "HTTP Codex Server",
    description: "Codex server fixture",
    apps: {
      claude: false,
      codex: true,
      gemini: false,
      opencode: false,
      openclaw: false,
      hermes: false,
    },
    server: {
      type: "http",
      url: "http://localhost:3000",
    },
  },
});

const createDefaultPrompts = (): PromptState => ({
  claude: {
    "claude-alpha": {
      id: "claude-alpha",
      name: "Claude Alpha Prompt",
      description: "Claude enabled prompt",
      content: "# Claude Alpha\n\nUse the alpha instructions.",
      enabled: true,
      createdAt: 1_700_030_000,
      updatedAt: 1_700_030_100,
    },
    "claude-beta": {
      id: "claude-beta",
      name: "Claude Beta Prompt",
      description: "Claude standby prompt",
      content: "# Claude Beta\n\nUse the beta instructions.",
      enabled: false,
      createdAt: 1_700_031_000,
      updatedAt: 1_700_031_100,
    },
  },
  "claude-desktop": {},
  codex: {
    "codex-alpha": {
      id: "codex-alpha",
      name: "Codex Alpha Prompt",
      description: "Codex enabled prompt",
      content: "# Codex Alpha\n\nUse codex instructions.",
      enabled: true,
      createdAt: 1_700_032_000,
      updatedAt: 1_700_032_100,
    },
  },
  gemini: {},
  opencode: {},
  openclaw: {},
  hermes: {},
});

const createDefaultCurrentPromptFileContent =
  (): CurrentPromptFileContentByApp => ({
    claude: "# CLAUDE.md\n\nCurrent Claude live prompt",
    "claude-desktop": null,
    codex: "# AGENTS.md\n\nCurrent Codex live prompt",
    gemini: null,
    opencode: null,
    openclaw: null,
    hermes: null,
  });

const createDefaultPromptRequestCounts = (): PromptRequestCounts => ({
  claude: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  "claude-desktop": {
    getPrompts: 0,
    getCurrentFileContent: 0,
    importFromFile: 0,
  },
  codex: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  gemini: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  opencode: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  openclaw: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  hermes: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
});

const createDefaultHermesMemory = (): HermesMemoryState => ({
  memory: "# MEMORY.md\n\nRemember the current Hermes operating context.",
  user: "# USER.md\n\nProfile: careful reviewer.",
});

const createDefaultHermesMemoryLimits = (): HermesMemoryLimits => ({
  memory: 2200,
  user: 1375,
  memoryEnabled: true,
  userEnabled: false,
});

const createDefaultWorkspaceFiles = (): WorkspaceFileState => ({
  "AGENTS.md": "# AGENTS.md\n\nInitial OpenClaw agent instructions.",
  "SOUL.md": null,
  "USER.md": "# USER.md\n\nWorkspace user notes.",
  "IDENTITY.md": "# IDENTITY.md\n\nWorkspace identity notes.",
  "TOOLS.md": "# TOOLS.md\n\nWorkspace tools notes.",
  "MEMORY.md": "# MEMORY.md\n\nWorkspace memory notes.",
  "HEARTBEAT.md": "# HEARTBEAT.md\n\nWorkspace heartbeat notes.",
  "BOOTSTRAP.md": "# BOOTSTRAP.md\n\nWorkspace bootstrap notes.",
  "BOOT.md": "# BOOT.md\n\nWorkspace boot notes.",
});

const createDefaultOpenClawEnvConfig = (): OpenClawEnvConfig => ({
  vars: {
    OPENCLAW_API_KEY: "env-initial-key",
  },
  shellEnv: {
    OPENCLAW_BASE_URL: "https://openclaw.example.com",
  },
});

const createDefaultOpenClawToolsConfig = (): OpenClawToolsConfig => ({
  profile: "minimal",
  allow: ["Read", "Write"],
  deny: ["Delete"],
});

const createDefaultOpenClawAgentsDefaults = (): OpenClawAgentsDefaults => ({
  model: {
    primary: "provider-a/model-alpha",
    fallbacks: ["provider-b/model-beta"],
  },
  workspace: "write",
  timeoutSeconds: 90,
  contextTokens: 32768,
  maxConcurrent: 4,
  customFlag: "preserve-me",
});

const createDefaultUsageSummaryByApp = (): UsageSummaryByApp[] => [
  {
    appType: "claude",
    summary: {
      totalRequests: 12,
      totalCost: "1.234500",
      totalInputTokens: 2000,
      totalOutputTokens: 800,
      totalCacheCreationTokens: 200,
      totalCacheReadTokens: 400,
      successRate: 91.7,
      realTotalTokens: 3400,
      cacheHitRate: 0.1538,
    },
  },
  {
    appType: "codex",
    summary: {
      totalRequests: 4,
      totalCost: "0.400000",
      totalInputTokens: 900,
      totalOutputTokens: 300,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 100,
      successRate: 100,
      realTotalTokens: 1300,
      cacheHitRate: 0.1,
    },
  },
];

const createDefaultUsageTrends = (): DailyStats[] => [
  {
    date: "2026-05-19T08:00:00Z",
    requestCount: 3,
    totalCost: "0.150000",
    totalTokens: 1200,
    totalInputTokens: 600,
    totalOutputTokens: 400,
    totalCacheCreationTokens: 50,
    totalCacheReadTokens: 150,
  },
  {
    date: "2026-05-19T09:00:00Z",
    requestCount: 5,
    totalCost: "0.280000",
    totalTokens: 1600,
    totalInputTokens: 700,
    totalOutputTokens: 500,
    totalCacheCreationTokens: 100,
    totalCacheReadTokens: 300,
  },
];

const createDefaultProviderStats = (): ProviderStats[] => [
  {
    providerId: "claude-alpha",
    providerName: "Claude Alpha",
    requestCount: 9,
    totalTokens: 2400,
    totalCost: "0.800000",
    successRate: 88.9,
    avgLatencyMs: 1250,
  },
];

const createDefaultModelStats = (): ModelStats[] => [
  {
    model: "claude-haiku-4-5-20251001",
    requestCount: 6,
    totalTokens: 1900,
    totalCost: "0.500000",
    avgCostPerRequest: "0.083333",
  },
];

const createDefaultRequestLogs = (): RequestLog[] => [
  {
    requestId: "req-1",
    providerId: "claude-alpha",
    providerName: "Claude Alpha",
    appType: "claude",
    model: "claude-haiku-4-5-20251001",
    requestModel: "claude-haiku-4-5-20251001",
    costMultiplier: "1",
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 200,
    cacheCreationTokens: 100,
    inputCostUsd: "0.120000",
    outputCostUsd: "0.090000",
    cacheReadCostUsd: "0.010000",
    cacheCreationCostUsd: "0.020000",
    totalCostUsd: "0.240000",
    isStreaming: true,
    latencyMs: 1850,
    firstTokenMs: 420,
    durationMs: 2200,
    statusCode: 200,
    sessionId: "session-1",
    sessionTitle: "Claude Session One",
    projectPath: "/workspace/claude-one",
    providerType: "custom",
    createdAt: 1_747_645_600,
    dataSource: "proxy",
  },
  {
    requestId: "req-2",
    providerId: "codex-alpha",
    providerName: "Codex Alpha",
    appType: "codex",
    model: "gpt-5.5",
    requestModel: "gpt-5.5@low",
    costMultiplier: "1",
    inputTokens: 800,
    outputTokens: 120,
    cacheReadTokens: 100,
    cacheCreationTokens: 0,
    inputCostUsd: "0.040000",
    outputCostUsd: "0.030000",
    cacheReadCostUsd: "0.005000",
    cacheCreationCostUsd: "0.000000",
    totalCostUsd: "0.075000",
    isStreaming: false,
    latencyMs: 980,
    statusCode: 200,
    sessionId: "session-2",
    sessionTitle: "Codex Session",
    projectPath: "/workspace/codex",
    providerType: "custom",
    createdAt: 1_747_649_200,
    dataSource: "proxy",
  },
];

const createDefaultRequestDetails = (): Record<string, RequestLog | null> => ({
  "req-1": {
    ...createDefaultRequestLogs()[0],
    requestModel: "claude-3.7-thinking",
    model: "claude-haiku-4-5-20251001",
    errorMessage: "",
  },
  "req-2": {
    ...createDefaultRequestLogs()[1],
    requestModel: "gpt-5.5@low",
    model: "gpt-5.5",
  },
});

const createDefaultModelPricing = (): ModelPricing[] => [
  {
    modelId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    inputCostPerMillion: "3",
    outputCostPerMillion: "15",
    cacheReadCostPerMillion: "0.3",
    cacheCreationCostPerMillion: "3.75",
  },
];

const createDefaultUsageDataSources = (): DataSourceSummary[] => [
  {
    dataSource: "proxy",
    requestCount: 16,
    totalCostUsd: "1.634500",
  },
];

const createDefaultWebdavRemoteInfo = (): WebdavRemoteInfoState => ({
  deviceName: "Mock Device",
  createdAt: "2026-05-19T00:00:00Z",
  snapshotId: "snapshot-1",
  version: 2,
  protocolVersion: 2,
  dbCompatVersion: 6,
  compatible: true,
  artifacts: ["db.sql", "skills.zip"],
  layout: "current",
  remotePath: "/cc-switch-sync/v2/db-v8/default",
});

const createDefaultDbBackups = (): DbBackupEntry[] => [
  {
    filename: "db_backup_20260518_010203.db",
    sizeBytes: 1_024,
    createdAt: "2026-05-18T01:02:03Z",
  },
];

let providers = createDefaultProviders();
let current = createDefaultCurrent();
let liveProviderIds: LiveProviderIdsByApp = {
  opencode: [],
  openclaw: [],
  hermes: [],
};
let providerDefaultTemplatesByApp = createDefaultProviderTemplates();
let appConfigTemplatesByApp = createDefaultAppConfigTemplates();
let autoFailoverEnabledByApp = createDefaultAutoFailoverEnabled();
let proxyTakeoverStatusByApp = createDefaultProxyTakeoverStatus();
let appProxyConfigsByApp = createDefaultAppProxyConfigs();
let providerHealthState: ProviderHealthState = {};
let circuitBreakerStatsState: CircuitBreakerStatsState = {};
let globalProxyConfigState = createDefaultGlobalProxyConfig();
let failoverQueuesByApp = createDefaultFailoverQueues();
let switchLiveSettingsByApp = createDefaultSwitchLiveSettings();
let managedAuthStatusByProvider = createDefaultManagedAuthStatus();
let lastManagedAuthStartLoginRequest: ManagedAuthStartLoginRequest | null =
  null;
let managedAuthPollRequests: ManagedAuthPollRequest[] = [];
let clipboardWrites: string[] = [];
let installedSkillsState = createDefaultInstalledSkills();
let unmanagedSkillsState = createDefaultUnmanagedSkills();
let discoverableSkillsState = createDefaultDiscoverableSkills();
let skillReposState = createDefaultSkillRepos();
let skillBackupsState = createDefaultSkillBackups();
let skillUpdatesState = createDefaultSkillUpdates();
let skillsShResultsState = createDefaultSkillsShResults();
let lastZipInstallRequest: { filePath: string; currentApp: AppId } | null =
  null;
let mcpServersState = createDefaultMcpServers();
let promptsState = createDefaultPrompts();
let currentPromptFileContentByApp = createDefaultCurrentPromptFileContent();
let promptRequestCounts = createDefaultPromptRequestCounts();
let hermesMemoryState = createDefaultHermesMemory();
let hermesMemoryLimitsState = createDefaultHermesMemoryLimits();
let lastOpenedHermesWebUiPath: string | null = null;
let workspaceFilesState = createDefaultWorkspaceFiles();
let lastOpenedWorkspaceDirectory: "workspace" | "memory" | null = null;
let openClawEnvConfigState = createDefaultOpenClawEnvConfig();
let openClawToolsConfigState = createDefaultOpenClawToolsConfig();
let openClawAgentsDefaultsState: OpenClawAgentsDefaults | null =
  createDefaultOpenClawAgentsDefaults();
let usageSummaryByAppState = createDefaultUsageSummaryByApp();
let usageTrendsState = createDefaultUsageTrends();
let providerStatsState = createDefaultProviderStats();
let modelStatsState = createDefaultModelStats();
let requestLogsState = createDefaultRequestLogs();
let requestDetailsState = createDefaultRequestDetails();
let modelPricingState = createDefaultModelPricing();
let usageDataSourcesState = createDefaultUsageDataSources();
let streamCheckConfigState = {
  timeoutSecs: 45,
  maxRetries: 2,
  degradedThresholdMs: 6000,
  claudeModel: "claude-haiku-4-5-20251001",
  codexModel: "gpt-5.5@low",
  geminiModel: "gemini-3-flash-preview",
  testPrompt: "Who are you?",
};
let lastPromptUpsertRequest: PromptUpsertRequest | null = null;
let lastPromptEnableRequest: PromptEnableRequest | null = null;
let lastPromptDeleteRequest: PromptDeleteRequest | null = null;
let lastProxyProviderSwitchRequest: ProxyProviderSwitchRequest | null = null;
let lastWebdavSaveRequest: {
  settings: WebDavSyncSettings;
  passwordTouched: boolean;
} | null = null;
let webdavTestRequests: Array<{
  settings: WebDavSyncSettings;
  preserveEmptyPassword: boolean;
}> = [];
let webdavRemoteInfoState = createDefaultWebdavRemoteInfo();
let webdavUploadCount = 0;
let webdavDownloadCount = 0;
let logConfigState: LogConfig = {
  enabled: true,
  level: "info",
  rawProxyLogRetentionMinutes: 30,
};
let logConfigSaveHistory: LogConfig[] = [];
let dbBackupsState = createDefaultDbBackups();
let lastRestoredBackupFilename: string | null = null;
let settingsState: Settings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  enableClaudePluginIntegration: false,
  claudeConfigDir: "/default/claude",
  codexConfigDir: "/default/codex",
  language: "zh",
};
let lastSettingsSaveRequest: Settings | null = null;
let lastAutoLaunchRequest: boolean | null = null;
let lastClaudeOnboardingSkipAction: "apply" | "clear" | null = null;
let externalOpenRequests: string[] = [];
let lastWindowThemeRequest: string | null = null;
let lastToolVersionsRequest: {
  tools?: string[];
  wslShellByTool?: Record<
    string,
    { wslShell?: string | null; wslShellFlag?: string | null }
  >;
} | null = null;
let appConfigDirOverride: string | null = null;
const createDefaultProxyStatus = (): ProxyStatus => ({
  running: false,
  address: "127.0.0.1",
  port: 0,
  active_connections: 0,
  total_requests: 0,
  success_requests: 0,
  failed_requests: 0,
  success_rate: 0,
  uptime_seconds: 0,
  current_provider: null,
  current_provider_id: null,
  last_request_at: null,
  last_error: null,
  failover_count: 0,
  active_targets: [],
  active_request_count: 0,
  active_request_targets: [],
});
let proxyStatusState: ProxyStatus = createDefaultProxyStatus();
const sessionMessageKey = (providerId: string, sourcePath: string) =>
  `${providerId}:${sourcePath}`;
const providerRuntimeKey = (appType: AppId, providerId: string) =>
  `${appType}:${providerId}`;

const createDefaultSessions = (): SessionMeta[] => {
  const now = Date.now();
  return [
    {
      providerId: "codex",
      sessionId: "codex-session-1",
      title: "Codex Session One",
      summary: "Codex summary",
      projectDir: "/mock/codex",
      createdAt: now - 2000,
      lastActiveAt: now - 1000,
      sourcePath: "/mock/codex/session-1.jsonl",
      resumeCommand: "codex resume codex-session-1",
    },
    {
      providerId: "claude",
      sessionId: "claude-session-1",
      title: "Claude Session One",
      summary: "Claude summary",
      projectDir: "/mock/claude",
      createdAt: now - 4000,
      lastActiveAt: now - 3000,
      sourcePath: "/mock/claude/session-1.jsonl",
      resumeCommand: "claude --resume claude-session-1",
    },
  ];
};

const createDefaultSessionMessages = (): Record<string, SessionMessage[]> => ({
  [sessionMessageKey("codex", "/mock/codex/session-1.jsonl")]: [
    {
      role: "user",
      content: "First codex message",
      ts: Date.now() - 1000,
    },
  ],
  [sessionMessageKey("claude", "/mock/claude/session-1.jsonl")]: [
    {
      role: "user",
      content: "First claude message",
      ts: Date.now() - 3000,
    },
  ],
});

let sessionsState = createDefaultSessions();
let sessionMessagesState = createDefaultSessionMessages();
let lastDeleteSessionsRequest: SessionDeleteRequestItem[] | null = null;
let lastSessionTitleMappingRequest: SessionTitleMappingRequest | null = null;
let lastSessionTerminalLaunchRequest: SessionTerminalLaunchRequest | null =
  null;
let lastSessionExportRequest: SessionMeta | null = null;
let lastProviderTerminalLaunchRequest: {
  providerId: string;
  app: AppId;
  cwd?: string | null;
} | null = null;
let mcpConfigs: McpConfigState = {
  claude: {
    sample: {
      id: "sample",
      name: "Sample Claude Server",
      enabled: true,
      apps: {
        claude: true,
        codex: false,
        gemini: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      },
      server: {
        type: "stdio",
        command: "claude-server",
      },
    },
  },
  "claude-desktop": {},
  codex: {
    httpServer: {
      id: "httpServer",
      name: "HTTP Codex Server",
      enabled: false,
      apps: {
        claude: false,
        codex: true,
        gemini: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      },
      server: {
        type: "http",
        url: "http://localhost:3000",
      },
    },
  },
  gemini: {},
  opencode: {},
  openclaw: {},
  hermes: {},
};

const cloneProviders = (value: ProvidersByApp) =>
  deepClone(value) as ProvidersByApp;

export const resetProviderState = () => {
  providers = createDefaultProviders();
  current = createDefaultCurrent();
  liveProviderIds = {
    opencode: [],
    openclaw: [],
    hermes: [],
  };
  providerDefaultTemplatesByApp = createDefaultProviderTemplates();
  appConfigTemplatesByApp = createDefaultAppConfigTemplates();
  autoFailoverEnabledByApp = createDefaultAutoFailoverEnabled();
  proxyTakeoverStatusByApp = createDefaultProxyTakeoverStatus();
  appProxyConfigsByApp = createDefaultAppProxyConfigs();
  providerHealthState = {};
  circuitBreakerStatsState = {};
  globalProxyConfigState = createDefaultGlobalProxyConfig();
  failoverQueuesByApp = createDefaultFailoverQueues();
  switchLiveSettingsByApp = createDefaultSwitchLiveSettings();
  managedAuthStatusByProvider = createDefaultManagedAuthStatus();
  lastManagedAuthStartLoginRequest = null;
  managedAuthPollRequests = [];
  clipboardWrites = [];
  installedSkillsState = createDefaultInstalledSkills();
  unmanagedSkillsState = createDefaultUnmanagedSkills();
  discoverableSkillsState = createDefaultDiscoverableSkills();
  skillReposState = createDefaultSkillRepos();
  skillBackupsState = createDefaultSkillBackups();
  skillUpdatesState = createDefaultSkillUpdates();
  skillsShResultsState = createDefaultSkillsShResults();
  lastZipInstallRequest = null;
  mcpServersState = createDefaultMcpServers();
  promptsState = createDefaultPrompts();
  currentPromptFileContentByApp = createDefaultCurrentPromptFileContent();
  promptRequestCounts = createDefaultPromptRequestCounts();
  hermesMemoryState = createDefaultHermesMemory();
  hermesMemoryLimitsState = createDefaultHermesMemoryLimits();
  lastOpenedHermesWebUiPath = null;
  workspaceFilesState = createDefaultWorkspaceFiles();
  lastOpenedWorkspaceDirectory = null;
  openClawEnvConfigState = createDefaultOpenClawEnvConfig();
  openClawToolsConfigState = createDefaultOpenClawToolsConfig();
  openClawAgentsDefaultsState = createDefaultOpenClawAgentsDefaults();
  usageSummaryByAppState = createDefaultUsageSummaryByApp();
  usageTrendsState = createDefaultUsageTrends();
  providerStatsState = createDefaultProviderStats();
  modelStatsState = createDefaultModelStats();
  requestLogsState = createDefaultRequestLogs();
  requestDetailsState = createDefaultRequestDetails();
  modelPricingState = createDefaultModelPricing();
  usageDataSourcesState = createDefaultUsageDataSources();
  streamCheckConfigState = {
    timeoutSecs: 45,
    maxRetries: 2,
    degradedThresholdMs: 6000,
    claudeModel: "claude-haiku-4-5-20251001",
    codexModel: "gpt-5.5@low",
    geminiModel: "gemini-3-flash-preview",
    testPrompt: "Who are you?",
  };
  lastPromptUpsertRequest = null;
  lastPromptEnableRequest = null;
  lastPromptDeleteRequest = null;
  lastProxyProviderSwitchRequest = null;
  lastWebdavSaveRequest = null;
  webdavTestRequests = [];
  webdavRemoteInfoState = createDefaultWebdavRemoteInfo();
  webdavUploadCount = 0;
  webdavDownloadCount = 0;
  logConfigState = {
    enabled: true,
    level: "info",
    rawProxyLogRetentionMinutes: 30,
  };
  logConfigSaveHistory = [];
  dbBackupsState = createDefaultDbBackups();
  lastRestoredBackupFilename = null;
  sessionsState = createDefaultSessions();
  sessionMessagesState = createDefaultSessionMessages();
  lastDeleteSessionsRequest = null;
  lastSessionTitleMappingRequest = null;
  lastSessionTerminalLaunchRequest = null;
  lastSessionExportRequest = null;
  lastProviderTerminalLaunchRequest = null;
  settingsState = {
    showInTray: true,
    minimizeToTrayOnClose: true,
    enableClaudePluginIntegration: false,
    claudeConfigDir: "/default/claude",
    codexConfigDir: "/default/codex",
    language: "zh",
  };
  lastSettingsSaveRequest = null;
  lastAutoLaunchRequest = null;
  lastClaudeOnboardingSkipAction = null;
  externalOpenRequests = [];
  clipboardWrites = [];
  lastWindowThemeRequest = null;
  lastToolVersionsRequest = null;
  appConfigDirOverride = null;
  proxyStatusState = createDefaultProxyStatus();
  mcpConfigs = {
    claude: {
      sample: {
        id: "sample",
        name: "Sample Claude Server",
        enabled: true,
        apps: {
          claude: true,
          codex: false,
          gemini: false,
          opencode: false,
          openclaw: false,
          hermes: false,
        },
        server: {
          type: "stdio",
          command: "claude-server",
        },
      },
    },
    "claude-desktop": {},
    codex: {
      httpServer: {
        id: "httpServer",
        name: "HTTP Codex Server",
        enabled: false,
        apps: {
          claude: false,
          codex: true,
          gemini: false,
          opencode: false,
          openclaw: false,
          hermes: false,
        },
        server: {
          type: "http",
          url: "http://localhost:3000",
        },
      },
    },
    gemini: {},
    opencode: {},
    openclaw: {},
    hermes: {},
  };
};

export const getLastWebdavSaveRequest = () =>
  lastWebdavSaveRequest
    ? (JSON.parse(JSON.stringify(lastWebdavSaveRequest)) as {
        settings: WebDavSyncSettings;
        passwordTouched: boolean;
      })
    : null;

export const getWebdavTestRequests = () =>
  JSON.parse(JSON.stringify(webdavTestRequests)) as Array<{
    settings: WebDavSyncSettings;
    preserveEmptyPassword: boolean;
  }>;

export const getWebdavSyncCounts = () => ({
  upload: webdavUploadCount,
  download: webdavDownloadCount,
});

export const getLogConfigState = () =>
  JSON.parse(JSON.stringify(logConfigState)) as LogConfig;

export const setLogConfigState = (config: LogConfig) => {
  logConfigState = JSON.parse(JSON.stringify(config)) as LogConfig;
};

export const saveLogConfigState = (config: LogConfig) => {
  const normalized: LogConfig = {
    enabled: config.enabled,
    level: config.level,
    rawProxyLogRetentionMinutes: Math.min(
      1440,
      Math.max(1, Math.round(config.rawProxyLogRetentionMinutes)),
    ),
  };
  logConfigState = JSON.parse(JSON.stringify(normalized)) as LogConfig;
  logConfigSaveHistory.push(
    JSON.parse(JSON.stringify(normalized)) as LogConfig,
  );
  return true;
};

export const getLogConfigSaveHistory = () =>
  JSON.parse(JSON.stringify(logConfigSaveHistory)) as LogConfig[];

export const getDbBackupsState = () =>
  JSON.parse(JSON.stringify(dbBackupsState)) as DbBackupEntry[];

export const setDbBackupsState = (backups: DbBackupEntry[]) => {
  dbBackupsState = JSON.parse(JSON.stringify(backups)) as DbBackupEntry[];
};

export const createDbBackupState = () => {
  const existing = new Set(dbBackupsState.map((backup) => backup.filename));
  let index = dbBackupsState.length + 1;
  let filename = `db_backup_20260519_100000_${index}.db`;
  while (existing.has(filename)) {
    index += 1;
    filename = `db_backup_20260519_100000_${index}.db`;
  }
  dbBackupsState = [
    {
      filename,
      sizeBytes: 2_048,
      createdAt: "2026-05-19T10:00:00Z",
    },
    ...dbBackupsState,
  ];
  return filename;
};

export const restoreDbBackupState = (filename: string) => {
  if (!dbBackupsState.some((backup) => backup.filename === filename)) {
    throw new Error(`Backup not found: ${filename}`);
  }
  lastRestoredBackupFilename = filename;
  return "db_backup_20260519_100500";
};

export const getLastRestoredBackupFilename = () => lastRestoredBackupFilename;

export const renameDbBackupState = (oldFilename: string, newName: string) => {
  const index = dbBackupsState.findIndex(
    (backup) => backup.filename === oldFilename,
  );
  if (index < 0) {
    throw new Error(`Backup not found: ${oldFilename}`);
  }
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new Error("Backup name cannot be empty");
  }
  const filename = trimmed.endsWith(".db") ? trimmed : `${trimmed}.db`;
  dbBackupsState[index] = {
    ...dbBackupsState[index],
    filename,
  };
  return filename;
};

export const deleteDbBackupState = (filename: string) => {
  const next = dbBackupsState.filter((backup) => backup.filename !== filename);
  if (next.length === dbBackupsState.length) {
    throw new Error(`Backup not found: ${filename}`);
  }
  dbBackupsState = next;
};

export const setWebdavRemoteInfoState = (info: WebdavRemoteInfoState) => {
  webdavRemoteInfoState = JSON.parse(
    JSON.stringify(info),
  ) as WebdavRemoteInfoState;
};

export const recordWebdavSaveSettings = (
  settings: WebDavSyncSettings,
  passwordTouched: boolean,
) => {
  lastWebdavSaveRequest = {
    settings: JSON.parse(JSON.stringify(settings)) as WebDavSyncSettings,
    passwordTouched,
  };
  setSettings({
    webdavSync: {
      ...settings,
      password: "",
    },
  });
};

export const recordWebdavTestConnection = (
  settings: WebDavSyncSettings,
  preserveEmptyPassword: boolean,
) => {
  webdavTestRequests.push({
    settings: JSON.parse(JSON.stringify(settings)) as WebDavSyncSettings,
    preserveEmptyPassword,
  });
};

export const getWebdavRemoteInfoState = () =>
  JSON.parse(JSON.stringify(webdavRemoteInfoState)) as WebdavRemoteInfoState;

export const recordWebdavUpload = () => {
  webdavUploadCount += 1;
};

export const recordWebdavDownload = () => {
  webdavDownloadCount += 1;
};

export const getInstalledSkillsState = () =>
  JSON.parse(JSON.stringify(installedSkillsState)) as InstalledSkill[];

export const setInstalledSkillsState = (skills: InstalledSkill[]) => {
  installedSkillsState = JSON.parse(JSON.stringify(skills)) as InstalledSkill[];
};

export const getUnmanagedSkillsState = () =>
  JSON.parse(JSON.stringify(unmanagedSkillsState)) as UnmanagedSkill[];

export const setUnmanagedSkillsState = (skills: UnmanagedSkill[]) => {
  unmanagedSkillsState = JSON.parse(JSON.stringify(skills)) as UnmanagedSkill[];
};

export const getDiscoverableSkillsState = () =>
  JSON.parse(JSON.stringify(discoverableSkillsState)) as DiscoverableSkill[];

export const setDiscoverableSkillsState = (skills: DiscoverableSkill[]) => {
  discoverableSkillsState = JSON.parse(
    JSON.stringify(skills),
  ) as DiscoverableSkill[];
};

export const getSkillReposState = () =>
  JSON.parse(JSON.stringify(skillReposState)) as SkillRepo[];

export const setSkillReposState = (repos: SkillRepo[]) => {
  skillReposState = JSON.parse(JSON.stringify(repos)) as SkillRepo[];
};

export const getSkillBackupsState = () =>
  JSON.parse(JSON.stringify(skillBackupsState)) as SkillBackupEntry[];

export const setSkillBackupsState = (backups: SkillBackupEntry[]) => {
  skillBackupsState = JSON.parse(JSON.stringify(backups)) as SkillBackupEntry[];
};

export const getSkillUpdatesState = () =>
  JSON.parse(JSON.stringify(skillUpdatesState)) as SkillUpdateInfo[];

export const setSkillUpdatesState = (updates: SkillUpdateInfo[]) => {
  skillUpdatesState = JSON.parse(JSON.stringify(updates)) as SkillUpdateInfo[];
};

export const getSkillsShResultsState = () =>
  JSON.parse(
    JSON.stringify(skillsShResultsState),
  ) as SkillsShDiscoverableSkill[];

export const setSkillsShResultsState = (
  skills: SkillsShDiscoverableSkill[],
) => {
  skillsShResultsState = JSON.parse(
    JSON.stringify(skills),
  ) as SkillsShDiscoverableSkill[];
};

export const toggleSkillAppState = (
  id: string,
  app: AppId,
  enabled: boolean,
) => {
  installedSkillsState = installedSkillsState.map((skill) =>
    skill.id === id
      ? {
          ...skill,
          apps: {
            ...skill.apps,
            [app]: enabled,
          },
        }
      : skill,
  );
};

export const importSkillsFromAppsState = (imports: ImportSkillSelection[]) => {
  const imported = imports
    .map((selection) => {
      const unmanaged = unmanagedSkillsState.find(
        (skill) => skill.directory === selection.directory,
      );
      if (!unmanaged) return null;
      return {
        id: `imported-${unmanaged.directory}`,
        name: unmanaged.name,
        description: unmanaged.description,
        directory: unmanaged.directory,
        apps: {
          ...createSkillApps(),
          ...selection.apps,
        },
        installedAt: Date.now(),
        updatedAt: Date.now(),
      } satisfies InstalledSkill;
    })
    .filter(Boolean) as InstalledSkill[];

  const importedIds = new Set(imported.map((skill) => skill.id));
  installedSkillsState = [
    ...installedSkillsState.filter((skill) => !importedIds.has(skill.id)),
    ...imported,
  ];
  const importedDirectories = new Set(imports.map((item) => item.directory));
  unmanagedSkillsState = unmanagedSkillsState.filter(
    (skill) => !importedDirectories.has(skill.directory),
  );
  return JSON.parse(JSON.stringify(imported)) as InstalledSkill[];
};

export const installSkillFromDiscoveryState = (
  skill: DiscoverableSkill,
  currentApp: AppId,
) => {
  const installed: InstalledSkill = {
    id: skill.directory,
    name: skill.name,
    description: skill.description,
    directory: skill.directory,
    repoOwner: skill.repoOwner,
    repoName: skill.repoName,
    repoBranch: skill.repoBranch,
    readmeUrl: skill.readmeUrl,
    apps: createSkillApps({ [currentApp]: true }),
    installedAt: Date.now(),
    updatedAt: Date.now(),
    contentHash: `hash-${skill.directory}`,
  };
  installedSkillsState = [
    ...installedSkillsState.filter((item) => item.id !== installed.id),
    installed,
  ];
  return JSON.parse(JSON.stringify(installed)) as InstalledSkill;
};

export const uninstallSkillState = (id: string) => {
  const existing = installedSkillsState.find((skill) => skill.id === id);
  installedSkillsState = installedSkillsState.filter(
    (skill) => skill.id !== id,
  );
  if (existing) {
    skillBackupsState = [
      {
        backupId: `backup-${id}`,
        backupPath: `/mock/backups/${id}`,
        createdAt: Math.floor(Date.now() / 1000),
        skill: existing,
      },
      ...skillBackupsState,
    ];
  }
  return { backupPath: existing ? `/mock/backups/${id}` : undefined };
};

export const restoreSkillBackupState = (
  backupId: string,
  currentApp: AppId,
) => {
  const backup = skillBackupsState.find((entry) => entry.backupId === backupId);
  if (!backup) return null;
  const restored: InstalledSkill = {
    ...backup.skill,
    apps: createSkillApps({ [currentApp]: true }),
    installedAt: Date.now(),
    updatedAt: Date.now(),
  };
  installedSkillsState = [
    ...installedSkillsState.filter((skill) => skill.id !== restored.id),
    restored,
  ];
  skillBackupsState = skillBackupsState.filter(
    (entry) => entry.backupId !== backupId,
  );
  return JSON.parse(JSON.stringify(restored)) as InstalledSkill;
};

export const deleteSkillBackupState = (backupId: string) => {
  skillBackupsState = skillBackupsState.filter(
    (entry) => entry.backupId !== backupId,
  );
  return true;
};

export const installSkillsFromZipState = (
  filePath: string,
  currentApp: AppId,
) => {
  lastZipInstallRequest = { filePath, currentApp };
  const installed: InstalledSkill = {
    id: "zip-skill",
    name: "Zip Skill",
    description: `Installed from ${filePath}`,
    directory: "zip-skill",
    apps: createSkillApps({ [currentApp]: true }),
    installedAt: Date.now(),
    updatedAt: Date.now(),
    contentHash: "hash-zip",
  };
  installedSkillsState = [
    ...installedSkillsState.filter((skill) => skill.id !== installed.id),
    installed,
  ];
  return [JSON.parse(JSON.stringify(installed)) as InstalledSkill];
};

export const getLastZipInstallRequest = () =>
  lastZipInstallRequest
    ? ({ ...lastZipInstallRequest } as { filePath: string; currentApp: AppId })
    : null;

export const getPromptsState = (app: AppId) => {
  promptRequestCounts[app].getPrompts += 1;
  return JSON.parse(JSON.stringify(promptsState[app] ?? {})) as Record<
    string,
    Prompt
  >;
};

export const setPromptsState = (
  app: AppId,
  prompts: Record<string, Prompt>,
) => {
  promptsState[app] = JSON.parse(JSON.stringify(prompts)) as Record<
    string,
    Prompt
  >;
};

export const getPromptsSnapshotState = (app: AppId) =>
  JSON.parse(JSON.stringify(promptsState[app] ?? {})) as Record<string, Prompt>;

export const getPromptState = (app: AppId, id: string) =>
  promptsState[app]?.[id]
    ? (JSON.parse(JSON.stringify(promptsState[app][id])) as Prompt)
    : null;

export const getCurrentPromptFileContentState = (app: AppId) => {
  promptRequestCounts[app].getCurrentFileContent += 1;
  return currentPromptFileContentByApp[app] ?? null;
};

export const getCurrentPromptFileContentSnapshotState = (app: AppId) =>
  currentPromptFileContentByApp[app] ?? null;

export const getHermesMemoryState = (kind: HermesMemoryKind) =>
  hermesMemoryState[kind];

export const setHermesMemoryState = (
  kind: HermesMemoryKind,
  content: string,
) => {
  hermesMemoryState[kind] = content;
};

export const getHermesMemoryLimitsState = () =>
  JSON.parse(JSON.stringify(hermesMemoryLimitsState)) as HermesMemoryLimits;

export const setHermesMemoryEnabledState = (
  kind: HermesMemoryKind,
  enabled: boolean,
) => {
  if (kind === "memory") {
    hermesMemoryLimitsState = {
      ...hermesMemoryLimitsState,
      memoryEnabled: enabled,
    };
    return;
  }

  hermesMemoryLimitsState = {
    ...hermesMemoryLimitsState,
    userEnabled: enabled,
  };
};

export const recordOpenHermesWebUiState = (path: string | null) => {
  lastOpenedHermesWebUiPath = path;
};

export const getLastOpenedHermesWebUiPath = () => lastOpenedHermesWebUiPath;

export const getWorkspaceFileState = (filename: string) =>
  filename in workspaceFilesState ? workspaceFilesState[filename] : null;

export const setWorkspaceFileState = (
  filename: string,
  content: string | null,
) => {
  workspaceFilesState[filename] = content;
};

export const recordOpenWorkspaceDirectoryState = (
  subdir: "workspace" | "memory",
) => {
  lastOpenedWorkspaceDirectory = subdir;
};

export const getLastOpenedWorkspaceDirectory = () =>
  lastOpenedWorkspaceDirectory;

export const getOpenClawEnvConfigState = () =>
  JSON.parse(JSON.stringify(openClawEnvConfigState)) as OpenClawEnvConfig;

export const setOpenClawEnvConfigState = (env: OpenClawEnvConfig) => {
  openClawEnvConfigState = JSON.parse(JSON.stringify(env)) as OpenClawEnvConfig;
};

export const getOpenClawToolsConfigState = () =>
  JSON.parse(JSON.stringify(openClawToolsConfigState)) as OpenClawToolsConfig;

export const setOpenClawToolsConfigState = (tools: OpenClawToolsConfig) => {
  openClawToolsConfigState = JSON.parse(
    JSON.stringify(tools),
  ) as OpenClawToolsConfig;
};

export const getOpenClawAgentsDefaultsState = () =>
  JSON.parse(
    JSON.stringify(openClawAgentsDefaultsState),
  ) as OpenClawAgentsDefaults;

export const setOpenClawAgentsDefaultsState = (
  defaults: OpenClawAgentsDefaults | null,
) => {
  openClawAgentsDefaultsState =
    defaults === null
      ? null
      : (JSON.parse(JSON.stringify(defaults)) as OpenClawAgentsDefaults);
};

export const getUsageSummaryByAppState = () =>
  JSON.parse(JSON.stringify(usageSummaryByAppState)) as UsageSummaryByApp[];

export const setUsageSummaryByAppState = (value: UsageSummaryByApp[]) => {
  usageSummaryByAppState = JSON.parse(
    JSON.stringify(value),
  ) as UsageSummaryByApp[];
};

export const getUsageTrendsState = () =>
  JSON.parse(JSON.stringify(usageTrendsState)) as DailyStats[];

export const setUsageTrendsState = (value: DailyStats[]) => {
  usageTrendsState = JSON.parse(JSON.stringify(value)) as DailyStats[];
};

export const getProviderStatsState = () =>
  JSON.parse(JSON.stringify(providerStatsState)) as ProviderStats[];

export const setProviderStatsState = (value: ProviderStats[]) => {
  providerStatsState = JSON.parse(JSON.stringify(value)) as ProviderStats[];
};

export const getModelStatsState = () =>
  JSON.parse(JSON.stringify(modelStatsState)) as ModelStats[];

export const setModelStatsState = (value: ModelStats[]) => {
  modelStatsState = JSON.parse(JSON.stringify(value)) as ModelStats[];
};

export const getRequestLogsState = () =>
  JSON.parse(JSON.stringify(requestLogsState)) as RequestLog[];

export const setRequestLogsState = (value: RequestLog[]) => {
  requestLogsState = JSON.parse(JSON.stringify(value)) as RequestLog[];
};

export const getRequestDetailState = (requestId: string) =>
  requestDetailsState[requestId] === null
    ? null
    : requestDetailsState[requestId]
      ? (JSON.parse(
          JSON.stringify(requestDetailsState[requestId]),
        ) as RequestLog)
      : null;

export const setRequestDetailState = (
  requestId: string,
  value: RequestLog | null,
) => {
  requestDetailsState[requestId] =
    value === null ? null : (JSON.parse(JSON.stringify(value)) as RequestLog);
};

export const getModelPricingState = () =>
  JSON.parse(JSON.stringify(modelPricingState)) as ModelPricing[];

export const setModelPricingState = (value: ModelPricing[]) => {
  modelPricingState = JSON.parse(JSON.stringify(value)) as ModelPricing[];
};

export const getUsageDataSourcesState = () =>
  JSON.parse(JSON.stringify(usageDataSourcesState)) as DataSourceSummary[];

export const setUsageDataSourcesState = (value: DataSourceSummary[]) => {
  usageDataSourcesState = JSON.parse(
    JSON.stringify(value),
  ) as DataSourceSummary[];
};

export const getStreamCheckConfigState = () =>
  JSON.parse(JSON.stringify(streamCheckConfigState)) as {
    timeoutSecs: number;
    maxRetries: number;
    degradedThresholdMs: number;
    claudeModel: string;
    codexModel: string;
    geminiModel: string;
    testPrompt: string;
  };

export const setStreamCheckConfigState = (
  value: typeof streamCheckConfigState,
) => {
  streamCheckConfigState = JSON.parse(
    JSON.stringify(value),
  ) as typeof streamCheckConfigState;
};

export const setCurrentPromptFileContentState = (
  app: AppId,
  content: string | null,
) => {
  currentPromptFileContentByApp[app] = content;
};

export const upsertPromptState = (app: AppId, id: string, prompt: Prompt) => {
  lastPromptUpsertRequest = {
    app,
    id,
    prompt: JSON.parse(JSON.stringify(prompt)) as Prompt,
  };
  promptsState[app] = promptsState[app] ?? {};
  promptsState[app][id] = JSON.parse(JSON.stringify(prompt)) as Prompt;
  if (prompt.enabled) {
    currentPromptFileContentByApp[app] = prompt.content;
  } else if (!Object.values(promptsState[app]).some((item) => item.enabled)) {
    currentPromptFileContentByApp[app] = "";
  }
};

export const enablePromptState = (app: AppId, id: string) => {
  lastPromptEnableRequest = { app, id };
  const prompt = promptsState[app]?.[id];
  if (!prompt) return false;

  promptsState[app] = Object.fromEntries(
    Object.entries(promptsState[app]).map(([promptId, value]) => [
      promptId,
      { ...value, enabled: promptId === id },
    ]),
  ) as Record<string, Prompt>;
  currentPromptFileContentByApp[app] = prompt.content;
  return true;
};

export const deletePromptState = (app: AppId, id: string) => {
  lastPromptDeleteRequest = { app, id };
  const prompt = promptsState[app]?.[id];
  if (!prompt || prompt.enabled) return false;
  delete promptsState[app][id];
  return true;
};

export const importPromptFromFileState = (app: AppId) => {
  promptRequestCounts[app].importFromFile += 1;
  const id = `imported-${app}`;
  const timestamp = Math.floor(Date.now() / 1000);
  promptsState[app] = promptsState[app] ?? {};
  promptsState[app][id] = {
    id,
    name: `Imported ${app} Prompt`,
    description: "Imported from current file",
    content: currentPromptFileContentByApp[app] ?? "",
    enabled: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return id;
};

export const getLastPromptUpsertRequest = () =>
  lastPromptUpsertRequest
    ? (JSON.parse(
        JSON.stringify(lastPromptUpsertRequest),
      ) as PromptUpsertRequest)
    : null;

export const getLastPromptEnableRequest = () =>
  lastPromptEnableRequest
    ? ({ ...lastPromptEnableRequest } as PromptEnableRequest)
    : null;

export const getLastPromptDeleteRequest = () =>
  lastPromptDeleteRequest
    ? ({ ...lastPromptDeleteRequest } as PromptDeleteRequest)
    : null;

export const getPromptRequestCounts = () =>
  JSON.parse(JSON.stringify(promptRequestCounts)) as PromptRequestCounts;

export const addSkillRepoState = (repo: SkillRepo) => {
  skillReposState = [
    ...skillReposState.filter(
      (item) => !(item.owner === repo.owner && item.name === repo.name),
    ),
    JSON.parse(JSON.stringify(repo)) as SkillRepo,
  ];
};

export const removeSkillRepoState = (owner: string, name: string) => {
  skillReposState = skillReposState.filter(
    (repo) => !(repo.owner === owner && repo.name === name),
  );
};

export const updateSkillState = (id: string) => {
  const update = skillUpdatesState.find((item) => item.id === id);
  installedSkillsState = installedSkillsState.map((skill) =>
    skill.id === id
      ? {
          ...skill,
          contentHash: update?.remoteHash ?? skill.contentHash,
          updatedAt: Date.now(),
        }
      : skill,
  );
  skillUpdatesState = skillUpdatesState.filter((item) => item.id !== id);
  return (
    installedSkillsState.find((skill) => skill.id === id) ??
    createDefaultInstalledSkills()[0]
  );
};

export const migrateSkillStorageState = (target: "cc_switch" | "unified") => {
  const current = settingsState.skillStorageLocation ?? "cc_switch";
  if (current === target) {
    return {
      migratedCount: 0,
      skippedCount: 0,
      errors: [],
    };
  }

  settingsState = {
    ...settingsState,
    skillStorageLocation: target,
  };

  return {
    migratedCount: installedSkillsState.length,
    skippedCount: 0,
    errors: [],
  };
};

export const getMcpServersState = () =>
  JSON.parse(JSON.stringify(mcpServersState)) as McpServersState;

export const setMcpServersState = (servers: McpServersState) => {
  mcpServersState = JSON.parse(JSON.stringify(servers)) as McpServersState;
};

export const toggleMcpAppState = (
  serverId: string,
  app: AppId,
  enabled: boolean,
) => {
  const server = mcpServersState[serverId];
  if (!server) return;
  mcpServersState[serverId] = {
    ...server,
    apps: {
      ...server.apps,
      [app]: enabled,
    },
  };
};

export const upsertMcpServerState = (server: McpServer) => {
  mcpServersState[server.id] = JSON.parse(JSON.stringify(server)) as McpServer;
};

export const deleteMcpServerState = (id: string) => {
  delete mcpServersState[id];
};

export const importMcpFromAppsState = () => {
  if (!mcpServersState.importedMcp) {
    mcpServersState.importedMcp = {
      id: "importedMcp",
      name: "Imported MCP",
      description: "Imported from app config",
      apps: {
        claude: true,
        codex: true,
        gemini: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      },
      server: {
        type: "stdio",
        command: "imported-mcp",
      },
    };
    return 1;
  }
  return 0;
};

export const getProxyStatusState = () =>
  JSON.parse(JSON.stringify(proxyStatusState)) as ProxyStatus;

export const setProxyStatusState = (status: Partial<ProxyStatus>) => {
  proxyStatusState = {
    ...proxyStatusState,
    ...JSON.parse(JSON.stringify(status)),
  };
};

const isSwitchModeApp = (appType: AppId): appType is SwitchModeAppId =>
  appType === "claude" || appType === "codex" || appType === "gemini";

const syncProxyLiveTemplate = (appType: SwitchModeAppId) => {
  switchLiveSettingsByApp[appType] = createProxyLiveSettings(
    appType,
    proxyStatusState.port || 15721,
  );
};

const failoverQueueItemFromProvider = (
  provider: Provider,
): FailoverQueueItem => ({
  providerId: provider.id,
  providerName: provider.name,
  providerNotes: provider.notes,
  sortIndex: provider.sortIndex,
});

const refreshActiveTargetForApp = (appType: AppId) => {
  const queue = failoverQueuesByApp[appType] ?? [];
  const first = queue[0];
  const activeTargets = (proxyStatusState.active_targets ?? []).filter(
    (target) => target.app_type !== appType,
  );

  proxyStatusState = {
    ...proxyStatusState,
    active_targets: first
      ? [
          ...activeTargets,
          {
            app_type: appType,
            provider_id: first.providerId,
            provider_name: first.providerName,
          },
        ]
      : activeTargets,
    current_provider: first?.providerName ?? proxyStatusState.current_provider,
    current_provider_id:
      first?.providerId ?? proxyStatusState.current_provider_id,
  };
};

const clearActiveTargetForApp = (appType: AppId) => {
  const activeTargets = (proxyStatusState.active_targets ?? []).filter(
    (target) => target.app_type !== appType,
  );
  const clearedCurrent =
    proxyStatusState.current_provider_id &&
    (proxyStatusState.active_targets ?? []).some(
      (target) =>
        target.app_type === appType &&
        target.provider_id === proxyStatusState.current_provider_id,
    );

  proxyStatusState = {
    ...proxyStatusState,
    active_targets: activeTargets,
    current_provider: clearedCurrent ? null : proxyStatusState.current_provider,
    current_provider_id: clearedCurrent
      ? null
      : proxyStatusState.current_provider_id,
  };
};

const setActiveTargetFromProvider = (appType: AppId, providerId: string) => {
  const provider = providers[appType]?.[providerId];
  if (!provider) {
    clearActiveTargetForApp(appType);
    return;
  }

  const activeTargets = (proxyStatusState.active_targets ?? []).filter(
    (target) => target.app_type !== appType,
  );
  proxyStatusState = {
    ...proxyStatusState,
    active_targets: [
      ...activeTargets,
      {
        app_type: appType,
        provider_id: provider.id,
        provider_name: provider.name,
      },
    ],
    current_provider: provider.name,
    current_provider_id: provider.id,
  };
};

export const switchProxyProviderState = (
  appType: AppId,
  providerId: string,
) => {
  lastProxyProviderSwitchRequest = { appType, providerId };
  const provider = providers[appType]?.[providerId];
  if (!provider) return false;

  if (
    appProxyConfigsByApp[appType]?.enabled &&
    appProxyConfigsByApp[appType]?.autoFailoverEnabled
  ) {
    setActiveTargetFromProvider(appType, providerId);
    return true;
  }

  current[appType] = providerId;
  setActiveTargetFromProvider(appType, providerId);
  return true;
};

const syncDirectLiveFromProvider = (appType: AppId, providerId: string) => {
  if (!isSwitchModeApp(appType)) return;
  const provider = providers[appType]?.[providerId];
  if (!provider) return;
  switchLiveSettingsByApp[appType] = JSON.parse(
    JSON.stringify(provider.settingsConfig ?? {}),
  );
};

const restoreCurrentFromFailoverQueueHead = (appType: AppId) => {
  const first = (failoverQueuesByApp[appType] ?? [])[0];
  if (!first) return false;
  current[appType] = first.providerId;
  return true;
};

const isAnyProxyTakeoverEnabled = () =>
  Object.values(proxyTakeoverStatusByApp).some(Boolean);

export const startProxyServerState = (): ProxyServerInfo => {
  proxyStatusState = {
    ...proxyStatusState,
    running: true,
    address: proxyStatusState.address || "127.0.0.1",
    port: proxyStatusState.port || 15721,
  };
  return {
    address: proxyStatusState.address,
    port: proxyStatusState.port,
    started_at: new Date().toISOString(),
  };
};

export const stopProxyServerState = (restore = false) => {
  proxyStatusState = {
    ...proxyStatusState,
    running: false,
    active_targets: [],
    active_request_count: 0,
    active_request_targets: [],
  };
  if (restore) {
    proxyTakeoverStatusByApp = createDefaultProxyTakeoverStatus();
    appProxyConfigsByApp = Object.fromEntries(
      Object.entries(appProxyConfigsByApp).map(([appType, config]) => [
        appType,
        { ...config, enabled: false, autoFailoverEnabled: false },
      ]),
    ) as AppProxyConfigByApp;
    autoFailoverEnabledByApp = createDefaultAutoFailoverEnabled();
  }
};

export const isProxyRunningState = () => proxyStatusState.running;

export const getGlobalProxyConfigState = () =>
  JSON.parse(JSON.stringify(globalProxyConfigState)) as GlobalProxyConfig;

export const setGlobalProxyConfigState = (config: GlobalProxyConfig) => {
  globalProxyConfigState = JSON.parse(
    JSON.stringify(config),
  ) as GlobalProxyConfig;
  proxyStatusState = {
    ...proxyStatusState,
    address: config.listenAddress,
    port: config.listenPort,
  };
};

export const getAppProxyConfigState = (appType: AppId) =>
  JSON.parse(
    JSON.stringify(
      appProxyConfigsByApp[appType] ?? createDefaultAppProxyConfig(appType),
    ),
  ) as AppProxyConfig;

export const setAppProxyConfigState = (config: AppProxyConfig) => {
  const appType = requireAppId(config.appType);
  appProxyConfigsByApp[appType] = JSON.parse(
    JSON.stringify(config),
  ) as AppProxyConfig;
  proxyTakeoverStatusByApp = {
    ...proxyTakeoverStatusByApp,
    [appType]: config.enabled,
  };
  autoFailoverEnabledByApp[appType] =
    config.enabled && config.autoFailoverEnabled;
  if (isSwitchModeApp(appType) && config.enabled) {
    syncProxyLiveTemplate(appType);
  }
};

export const setProxyTakeoverForAppState = (
  appType: AppId,
  enabled: boolean,
) => {
  const wasFailoverEnabled =
    Boolean(appProxyConfigsByApp[appType]?.autoFailoverEnabled) ||
    Boolean(autoFailoverEnabledByApp[appType]);

  proxyTakeoverStatusByApp = {
    ...proxyTakeoverStatusByApp,
    [appType]: enabled,
  };
  appProxyConfigsByApp[appType] = {
    ...(appProxyConfigsByApp[appType] ?? createDefaultAppProxyConfig(appType)),
    enabled,
    autoFailoverEnabled: enabled
      ? (appProxyConfigsByApp[appType]?.autoFailoverEnabled ?? false)
      : false,
  };
  autoFailoverEnabledByApp[appType] =
    enabled && (autoFailoverEnabledByApp[appType] ?? false);
  if (isSwitchModeApp(appType) && enabled) {
    syncProxyLiveTemplate(appType);
  }
  if (!enabled) {
    autoFailoverEnabledByApp[appType] = false;
    if (wasFailoverEnabled) {
      restoreCurrentFromFailoverQueueHead(appType);
    }
    const currentId = current[appType];
    if (currentId) {
      syncDirectLiveFromProvider(appType, currentId);
    }
    clearActiveTargetForApp(appType);
    if (!isAnyProxyTakeoverEnabled()) {
      proxyStatusState = {
        ...proxyStatusState,
        running: false,
        active_targets: [],
        active_request_count: 0,
        active_request_targets: [],
      };
    }
  }
};

export const isLiveTakeoverActiveState = () =>
  Object.values(proxyTakeoverStatusByApp).some(Boolean);

export const getSwitchLiveSettings = (appType: SwitchModeAppId) =>
  JSON.parse(JSON.stringify(switchLiveSettingsByApp[appType]));

export const setSwitchLiveSettings = (
  appType: SwitchModeAppId,
  settings: unknown,
) => {
  switchLiveSettingsByApp[appType] = JSON.parse(JSON.stringify(settings));
};

export const getFailoverQueueState = (appType: AppId) =>
  JSON.parse(
    JSON.stringify(failoverQueuesByApp[appType] ?? []),
  ) as FailoverQueueItem[];

export const getAvailableProvidersForFailoverState = (appType: AppId) => {
  const queued = new Set(
    (failoverQueuesByApp[appType] ?? []).map((item) => item.providerId),
  );
  return Object.values(getProviders(appType)).filter(
    (provider) => !queued.has(provider.id),
  );
};

export const addToFailoverQueueState = (appType: AppId, providerId: string) => {
  const provider = providers[appType]?.[providerId];
  if (!provider) return false;
  const queue = failoverQueuesByApp[appType] ?? [];
  if (!queue.some((item) => item.providerId === providerId)) {
    failoverQueuesByApp[appType] = [
      ...queue,
      failoverQueueItemFromProvider(provider),
    ].sort(
      (a, b) =>
        (a.sortIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.sortIndex ?? Number.MAX_SAFE_INTEGER) ||
        a.providerId.localeCompare(b.providerId),
    );
  }
  providers[appType][providerId] = {
    ...provider,
    inFailoverQueue: true,
  };
  refreshActiveTargetForApp(appType);
  return true;
};

export const removeFromFailoverQueueState = (
  appType: AppId,
  providerId: string,
) => {
  failoverQueuesByApp[appType] = (failoverQueuesByApp[appType] ?? []).filter(
    (item) => item.providerId !== providerId,
  );
  const provider = providers[appType]?.[providerId];
  if (provider) {
    providers[appType][providerId] = {
      ...provider,
      inFailoverQueue: false,
    };
  }
  refreshActiveTargetForApp(appType);
};

export const setAutoFailoverEnabledState = (
  appType: AppId,
  enabled: boolean,
) => {
  if (enabled && (failoverQueuesByApp[appType] ?? []).length === 0) {
    const currentProviderId = current[appType];
    if (currentProviderId) {
      addToFailoverQueueState(appType, currentProviderId);
    }
  }

  autoFailoverEnabledByApp[appType] = enabled;
  appProxyConfigsByApp[appType] = {
    ...(appProxyConfigsByApp[appType] ?? createDefaultAppProxyConfig(appType)),
    autoFailoverEnabled: enabled,
    loadBalancingEnabled: false,
  };

  if (enabled) {
    current[appType] = "";
    refreshActiveTargetForApp(appType);
    return;
  }

  const restored = restoreCurrentFromFailoverQueueHead(appType);
  if (
    restored &&
    proxyTakeoverStatusByApp[appType] &&
    proxyStatusState.running
  ) {
    setActiveTargetFromProvider(appType, current[appType]);
  } else {
    clearActiveTargetForApp(appType);
  }
};

export const syncCurrentProvidersLiveState = () => {
  (["claude", "codex", "gemini"] as const).forEach((appType) => {
    if (appProxyConfigsByApp[appType]?.enabled) {
      syncProxyLiveTemplate(appType);
      return;
    }

    const currentId = current[appType];
    const provider = currentId ? providers[appType]?.[currentId] : undefined;
    if (provider) {
      switchLiveSettingsByApp[appType] = JSON.parse(
        JSON.stringify(provider.settingsConfig ?? {}),
      );
    }
  });

  return {
    success: true,
    message: "Live configuration synchronized",
  };
};

export const getProviders = (appType: AppId) =>
  cloneProviders(providers)[appType] ?? {};

export const getCurrentProviderId = (appType: AppId) => current[appType] ?? "";

export const getLiveProviderIds = (
  appType: "opencode" | "openclaw" | "hermes",
) => [...liveProviderIds[appType]];

export const setLiveProviderIds = (
  appType: "opencode" | "openclaw" | "hermes",
  ids: string[],
) => {
  liveProviderIds[appType] = [...ids];
};

export const getProviderDefaultTemplate = (appType: AppId) =>
  providerDefaultTemplatesByApp[appType] ?? null;

export const setProviderDefaultTemplateState = (
  appType: AppId,
  template: string | null,
) => {
  providerDefaultTemplatesByApp[appType] = template;
};

export const getAppConfigTemplate = (appType: AppId) =>
  JSON.parse(
    JSON.stringify(appConfigTemplatesByApp[appType] ?? []),
  ) as AppConfigTemplateFile[];

export const setAppConfigTemplateState = (
  appType: AppId,
  files: AppConfigTemplateFile[],
) => {
  appConfigTemplatesByApp[appType] = JSON.parse(
    JSON.stringify(files),
  ) as AppConfigTemplateFile[];
};

export const getAutoFailoverEnabled = (appType: AppId) =>
  autoFailoverEnabledByApp[appType] ?? false;

export const getProviderHealthState = (
  appType: AppId,
  providerId: string,
): ProviderHealth => {
  const key = providerRuntimeKey(appType, providerId);
  return (
    providerHealthState[key] ?? {
      provider_id: providerId,
      app_type: appType,
      is_healthy: true,
      consecutive_failures: 0,
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
  health: Partial<ProviderHealth>,
) => {
  providerHealthState[providerRuntimeKey(appType, providerId)] = {
    ...getProviderHealthState(appType, providerId),
    ...health,
    provider_id: providerId,
    app_type: appType,
  };
};

export const getCircuitBreakerStatsState = (
  appType: AppId,
  providerId: string,
) => circuitBreakerStatsState[providerRuntimeKey(appType, providerId)] ?? null;

export const setCircuitBreakerStatsState = (
  appType: AppId,
  providerId: string,
  stats: CircuitBreakerStats | null,
) => {
  circuitBreakerStatsState[providerRuntimeKey(appType, providerId)] = stats
    ? JSON.parse(JSON.stringify(stats))
    : null;
};

export const getProxyTakeoverStatusState = () =>
  JSON.parse(
    JSON.stringify(proxyTakeoverStatusByApp),
  ) as ProxyTakeoverStatusByApp;

export const setProxyTakeoverStatusState = (
  status: Partial<ProxyTakeoverStatusByApp>,
) => {
  proxyTakeoverStatusByApp = {
    ...proxyTakeoverStatusByApp,
    ...JSON.parse(JSON.stringify(status)),
  };
};

export const getManagedAuthStatus = (provider: ManagedAuthProvider) =>
  JSON.parse(
    JSON.stringify(managedAuthStatusByProvider[provider]),
  ) as ManagedAuthStatus;

export const setManagedAuthStatusState = (
  provider: ManagedAuthProvider,
  status: ManagedAuthStatus,
) => {
  managedAuthStatusByProvider[provider] = JSON.parse(
    JSON.stringify(status),
  ) as ManagedAuthStatus;
};

export const startManagedAuthLoginState = (
  authProvider: ManagedAuthProvider,
  githubDomain?: string | null,
): ManagedAuthDeviceCodeResponse => {
  lastManagedAuthStartLoginRequest = {
    authProvider,
    githubDomain: githubDomain ?? null,
  };

  const isCodex = authProvider === "codex_oauth";
  return {
    provider: authProvider,
    device_code: isCodex ? "codex-device-code" : "github-device-code",
    user_code: isCodex ? "CDX-USER-1234" : "GH-USER-1234",
    verification_uri: isCodex
      ? "https://chatgpt.com/activate"
      : "https://github.com/login/device",
    expires_in: 900,
    interval: 1,
  };
};

export const pollManagedAuthAccountState = (
  authProvider: ManagedAuthProvider,
  deviceCode: string,
  githubDomain?: string | null,
): ManagedAuthAccount | null => {
  managedAuthPollRequests = [
    ...managedAuthPollRequests,
    {
      authProvider,
      deviceCode,
      githubDomain: githubDomain ?? null,
    },
  ];

  const expectedDeviceCode =
    authProvider === "codex_oauth" ? "codex-device-code" : "github-device-code";
  if (deviceCode !== expectedDeviceCode) {
    return null;
  }

  const normalizedDomain = githubDomain ?? "github.com";
  const account: ManagedAuthAccount =
    authProvider === "codex_oauth"
      ? {
          id: "codex-login",
          provider: authProvider,
          login: "chatgpt-login",
          avatar_url: null,
          authenticated_at: 1_700_000_500,
          is_default: true,
          github_domain: "github.com",
        }
      : {
          id: normalizedDomain === "github.com" ? "github-login" : "ghe-login",
          provider: authProvider,
          login:
            normalizedDomain === "github.com"
              ? "github-octocat"
              : "ghe-octocat",
          avatar_url: null,
          authenticated_at: 1_700_000_400,
          is_default: true,
          github_domain: normalizedDomain,
        };

  const existing = managedAuthStatusByProvider[authProvider];
  const accounts = [
    account,
    ...existing.accounts
      .filter((existingAccount) => existingAccount.id !== account.id)
      .map((existingAccount) => ({ ...existingAccount, is_default: false })),
  ];

  managedAuthStatusByProvider[authProvider] = {
    ...existing,
    authenticated: true,
    default_account_id: account.id,
    accounts,
  };

  return JSON.parse(JSON.stringify(account)) as ManagedAuthAccount;
};

export const getLastManagedAuthStartLoginRequest = () =>
  lastManagedAuthStartLoginRequest
    ? ({ ...lastManagedAuthStartLoginRequest } as ManagedAuthStartLoginRequest)
    : null;

export const getManagedAuthPollRequests = () =>
  JSON.parse(
    JSON.stringify(managedAuthPollRequests),
  ) as ManagedAuthPollRequest[];

export const recordClipboardWrite = (text: string) => {
  clipboardWrites = [...clipboardWrites, text];
  return true;
};

export const getClipboardWrites = () => [...clipboardWrites];

export const setManagedAuthDefaultAccountState = (
  provider: ManagedAuthProvider,
  accountId: string,
) => {
  const status = managedAuthStatusByProvider[provider];
  const accounts = status.accounts.map((account) => ({
    ...account,
    is_default: account.id === accountId,
  }));
  managedAuthStatusByProvider[provider] = {
    ...status,
    authenticated: accounts.length > 0,
    default_account_id: accounts.some((account) => account.id === accountId)
      ? accountId
      : (accounts[0]?.id ?? null),
    accounts,
  };
};

export const removeManagedAuthAccountState = (
  provider: ManagedAuthProvider,
  accountId: string,
) => {
  const status = managedAuthStatusByProvider[provider];
  const accounts = status.accounts.filter(
    (account) => account.id !== accountId,
  );
  const defaultAccountId = accounts.some(
    (account) => account.id === status.default_account_id,
  )
    ? status.default_account_id
    : (accounts[0]?.id ?? null);

  managedAuthStatusByProvider[provider] = {
    ...status,
    authenticated: accounts.length > 0,
    default_account_id: defaultAccountId,
    accounts: accounts.map((account) => ({
      ...account,
      is_default: account.id === defaultAccountId,
    })),
  };
};

export const logoutManagedAuthState = (provider: ManagedAuthProvider) => {
  const status = managedAuthStatusByProvider[provider];
  managedAuthStatusByProvider[provider] = {
    ...status,
    authenticated: false,
    default_account_id: null,
    accounts: [],
  };
};

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
  providers[appType] = deepClone(data) as Record<string, Provider>;
};

export const addProvider = (appType: AppId, provider: Provider) => {
  providers[appType] = providers[appType] ?? {};
  providers[appType][provider.id] = provider;
};

const isLiveProviderApp = (
  appType: AppId,
): appType is "opencode" | "openclaw" | "hermes" =>
  appType === "opencode" || appType === "openclaw" || appType === "hermes";

export const addProviderToLiveConfig = (appType: AppId, providerId: string) => {
  if (!isLiveProviderApp(appType)) return;
  if (!liveProviderIds[appType].includes(providerId)) {
    liveProviderIds[appType] = [...liveProviderIds[appType], providerId];
  }
};

export const removeProviderFromLiveConfigState = (
  appType: AppId,
  providerId: string,
) => {
  if (!isLiveProviderApp(appType)) return;
  liveProviderIds[appType] = liveProviderIds[appType].filter(
    (id) => id !== providerId,
  );
};

export const updateProvider = (
  appType: AppId,
  provider: Provider,
  originalId?: string,
) => {
  if (!providers[appType]) return;
  const previousId = originalId || provider.id;
  if (previousId !== provider.id) {
    delete providers[appType][previousId];
  }
  providers[appType][provider.id] = {
    ...providers[appType][provider.id],
    ...provider,
  };
};

export const deleteProvider = (appType: AppId, providerId: string) => {
  if (!providers[appType]) return;
  delete providers[appType][providerId];
  removeProviderFromLiveConfigState(appType, providerId);
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

  const queuedProviderIds = new Set(
    (failoverQueuesByApp[appType] ?? []).map((item) => item.providerId),
  );
  if (queuedProviderIds.size > 0) {
    failoverQueuesByApp[appType] = Object.values(providers[appType])
      .filter((provider) => queuedProviderIds.has(provider.id))
      .map((provider) => failoverQueueItemFromProvider(provider))
      .sort(
        (a, b) =>
          (a.sortIndex ?? Number.MAX_SAFE_INTEGER) -
            (b.sortIndex ?? Number.MAX_SAFE_INTEGER) ||
          a.providerId.localeCompare(b.providerId),
      );
    refreshActiveTargetForApp(appType);
  }
};

export const listProviders = (appType: AppId) =>
  deepClone(providers[appType] ?? {}) as Record<string, Provider>;

export const getSettings = () => deepClone(settingsState) as Settings;

export const getLastSettingsSaveRequest = () =>
  lastSettingsSaveRequest
    ? (JSON.parse(JSON.stringify(lastSettingsSaveRequest)) as Settings)
    : null;

export const getLastProxyProviderSwitchRequest = () =>
  lastProxyProviderSwitchRequest
    ? (JSON.parse(
        JSON.stringify(lastProxyProviderSwitchRequest),
      ) as ProxyProviderSwitchRequest)
    : null;

export const setSettings = (data: Partial<Settings>) => {
  settingsState = { ...settingsState, ...data };
};

export const recordSettingsSave = (settings: Settings) => {
  lastSettingsSaveRequest = JSON.parse(JSON.stringify(settings)) as Settings;
  setSettings(settings);
};

export const recordAutoLaunchRequest = (enabled: boolean) => {
  lastAutoLaunchRequest = enabled;
  return true;
};

export const getLastAutoLaunchRequest = () => lastAutoLaunchRequest;

export const recordClaudeOnboardingSkipAction = (action: "apply" | "clear") => {
  lastClaudeOnboardingSkipAction = action;
  return true;
};

export const getLastClaudeOnboardingSkipAction = () =>
  lastClaudeOnboardingSkipAction;

export const recordOpenExternalRequest = (url: string) => {
  externalOpenRequests = [...externalOpenRequests, url];
  return true;
};

export const getOpenExternalRequests = () => [...externalOpenRequests];

export const recordWindowThemeRequest = (theme: string) => {
  lastWindowThemeRequest = theme;
  return true;
};

export const getLastWindowThemeRequest = () => lastWindowThemeRequest;

export const recordToolVersionsRequest = (request: {
  tools?: string[];
  wslShellByTool?: Record<
    string,
    { wslShell?: string | null; wslShellFlag?: string | null }
  >;
}) => {
  lastToolVersionsRequest = JSON.parse(JSON.stringify(request)) as {
    tools?: string[];
    wslShellByTool?: Record<
      string,
      { wslShell?: string | null; wslShellFlag?: string | null }
    >;
  };
};

export const getLastToolVersionsRequest = () =>
  lastToolVersionsRequest
    ? (JSON.parse(JSON.stringify(lastToolVersionsRequest)) as {
        tools?: string[];
        wslShellByTool?: Record<
          string,
          { wslShell?: string | null; wslShellFlag?: string | null }
        >;
      })
    : null;

export const getAppConfigDirOverride = () => appConfigDirOverride;

export const setAppConfigDirOverrideState = (value: string | null) => {
  appConfigDirOverride = value;
};

export const getMcpConfig = (appType: AppId) => {
  const servers = deepClone(mcpConfigs[appType] ?? {}) as Record<
    string,
    McpServer
  >;
  return {
    configPath: `/mock/${appType}.mcp.json`,
    servers,
  };
};

export const setMcpConfig = (
  appType: AppId,
  value: Record<string, McpServer>,
) => {
  mcpConfigs[appType] = deepClone(value) as Record<string, McpServer>;
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
  mcpConfigs[appType][id] = deepClone(server) as McpServer;
};

export const deleteMcpServer = (appType: AppId, id: string) => {
  if (!mcpConfigs[appType]) return;
  delete mcpConfigs[appType][id];
};

export const listSessions = () => deepClone(sessionsState) as SessionMeta[];

export const getSessionMessages = (providerId: string, sourcePath: string) =>
  deepClone(
    sessionMessagesState[sessionMessageKey(providerId, sourcePath)] ?? [],
  ) as SessionMessage[];

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
  delete sessionMessagesState[sessionMessageKey(providerId, sourcePath)];
  return true;
};

export const recordDeleteSessionsRequest = (
  items: SessionDeleteRequestItem[],
) => {
  lastDeleteSessionsRequest = JSON.parse(
    JSON.stringify(items),
  ) as SessionDeleteRequestItem[];
};

export const getLastDeleteSessionsRequest = () =>
  lastDeleteSessionsRequest
    ? (JSON.parse(
        JSON.stringify(lastDeleteSessionsRequest),
      ) as SessionDeleteRequestItem[])
    : null;

export const setSessionTitleMappingState = (options: {
  appType: string;
  sessionId: string;
  sourcePath?: string | null;
  customTitle: string;
}) => {
  const request: SessionTitleMappingRequest = {
    action: "set",
    appType: options.appType,
    sessionId: options.sessionId,
    sourcePath: options.sourcePath ?? null,
    customTitle: options.customTitle,
  };
  lastSessionTitleMappingRequest = request;
  sessionsState = sessionsState.map((session) =>
    session.providerId === options.appType &&
    session.sessionId === options.sessionId &&
    (!options.sourcePath || session.sourcePath === options.sourcePath)
      ? { ...session, title: options.customTitle }
      : session,
  );
  return true;
};

export const clearSessionTitleMappingState = (options: {
  appType: string;
  sessionId: string;
  sourcePath?: string | null;
}) => {
  const request: SessionTitleMappingRequest = {
    action: "clear",
    appType: options.appType,
    sessionId: options.sessionId,
    sourcePath: options.sourcePath ?? null,
  };
  lastSessionTitleMappingRequest = request;
  sessionsState = sessionsState.map((session) =>
    session.providerId === options.appType &&
    session.sessionId === options.sessionId &&
    (!options.sourcePath || session.sourcePath === options.sourcePath)
      ? { ...session, title: undefined }
      : session,
  );
  return true;
};

export const getLastSessionTitleMappingRequest = () =>
  lastSessionTitleMappingRequest
    ? (JSON.parse(
        JSON.stringify(lastSessionTitleMappingRequest),
      ) as SessionTitleMappingRequest)
    : null;

export const recordSessionTerminalLaunch = (
  request: SessionTerminalLaunchRequest,
) => {
  lastSessionTerminalLaunchRequest = {
    command: request.command,
    cwd: request.cwd,
    customConfig: request.customConfig,
  };
  return true;
};

export const getLastSessionTerminalLaunchRequest = () =>
  lastSessionTerminalLaunchRequest
    ? ({ ...lastSessionTerminalLaunchRequest } as SessionTerminalLaunchRequest)
    : null;

export const recordSessionMarkdownExport = (session: SessionMeta) => {
  lastSessionExportRequest = JSON.parse(JSON.stringify(session)) as SessionMeta;
  return `/mock/exports/${session.providerId}-${session.sessionId}.md`;
};

export const getLastSessionExportRequest = () =>
  lastSessionExportRequest
    ? (JSON.parse(JSON.stringify(lastSessionExportRequest)) as SessionMeta)
    : null;

export const recordProviderTerminalLaunch = (request: {
  providerId: string;
  app: AppId;
  cwd?: string | null;
}) => {
  lastProviderTerminalLaunchRequest = {
    providerId: request.providerId,
    app: request.app,
    cwd: request.cwd ?? null,
  };
  return true;
};

export const getLastProviderTerminalLaunchRequest = () =>
  lastProviderTerminalLaunchRequest
    ? ({
        ...lastProviderTerminalLaunchRequest,
      } as {
        providerId: string;
        app: AppId;
        cwd?: string | null;
      })
    : null;

export const setSessionFixtures = (
  sessions: SessionMeta[],
  messages: Record<string, SessionMessage[]>,
) => {
  sessionsState = deepClone(sessions) as SessionMeta[];
  sessionMessagesState = deepClone(messages) as Record<
    string,
    SessionMessage[]
  >;
};
