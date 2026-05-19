import type { AppId } from "@/lib/api/types";
import type { ManagedAuthProvider, ManagedAuthStatus } from "@/lib/api/auth";
import type { AppConfigTemplateFile } from "@/lib/api/config";
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
  McpServer,
  Provider,
  RemoteSnapshotInfo,
  SessionMessage,
  SessionMeta,
  Settings,
  WebDavSyncSettings,
} from "@/types";
import type {
  AppProxyConfig,
  FailoverQueueItem,
  GlobalProxyConfig,
  ProxyServerInfo,
  ProxyStatus,
} from "@/types/proxy";

type ProvidersByApp = Record<AppId, Record<string, Provider>>;
type CurrentProviderState = Record<AppId, string>;
type McpConfigState = Record<AppId, Record<string, McpServer>>;
type LiveProviderIdsByApp = Record<
  "opencode" | "openclaw" | "hermes",
  string[]
>;
type ProxyTakeoverStatusByApp = Record<
  "claude" | "codex" | "gemini" | "opencode" | "openclaw" | "hermes",
  boolean
>;
type SwitchModeAppId = "claude" | "codex" | "gemini";
type AppProxyConfigByApp = Record<AppId, AppProxyConfig>;
type FailoverQueueByApp = Record<AppId, FailoverQueueItem[]>;
type SwitchLiveSettingsByApp = Record<SwitchModeAppId, unknown>;
type ProviderDefaultTemplatesByApp = Record<AppId, string | null>;
type AppConfigTemplatesByApp = Record<AppId, AppConfigTemplateFile[]>;
type AutoFailoverEnabledByApp = Record<AppId, boolean>;
type McpServersState = Record<string, McpServer>;
type PromptState = Record<AppId, Record<string, Prompt>>;
type CurrentPromptFileContentByApp = Record<AppId, string | null>;
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
    readmeUrl: "https://github.com/mock-owner/mock-skills/tree/main/skill-alpha",
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
    readmeUrl: "https://github.com/remote-owner/remote-skills/tree/main/remote-skill",
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

const createDefaultCurrentPromptFileContent = (): CurrentPromptFileContentByApp => ({
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
  "claude-desktop": { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  codex: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  gemini: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  opencode: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  openclaw: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
  hermes: { getPrompts: 0, getCurrentFileContent: 0, importFromFile: 0 },
});

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
  remotePath: "/cc-switch-sync/v2/db-v6/default",
});

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
let globalProxyConfigState = createDefaultGlobalProxyConfig();
let failoverQueuesByApp = createDefaultFailoverQueues();
let switchLiveSettingsByApp = createDefaultSwitchLiveSettings();
let managedAuthStatusByProvider = createDefaultManagedAuthStatus();
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
let lastPromptUpsertRequest: PromptUpsertRequest | null = null;
let lastPromptEnableRequest: PromptEnableRequest | null = null;
let lastPromptDeleteRequest: PromptDeleteRequest | null = null;
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
let settingsState: Settings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  enableClaudePluginIntegration: false,
  claudeConfigDir: "/default/claude",
  codexConfigDir: "/default/codex",
  language: "zh",
};
let lastSettingsSaveRequest: Settings | null = null;
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
  JSON.parse(JSON.stringify(value)) as ProvidersByApp;

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
  globalProxyConfigState = createDefaultGlobalProxyConfig();
  failoverQueuesByApp = createDefaultFailoverQueues();
  switchLiveSettingsByApp = createDefaultSwitchLiveSettings();
  managedAuthStatusByProvider = createDefaultManagedAuthStatus();
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
  lastPromptUpsertRequest = null;
  lastPromptEnableRequest = null;
  lastPromptDeleteRequest = null;
  lastWebdavSaveRequest = null;
  webdavTestRequests = [];
  webdavRemoteInfoState = createDefaultWebdavRemoteInfo();
  webdavUploadCount = 0;
  webdavDownloadCount = 0;
  sessionsState = createDefaultSessions();
  sessionMessagesState = createDefaultSessionMessages();
  lastDeleteSessionsRequest = null;
  lastSessionTitleMappingRequest = null;
  lastSessionTerminalLaunchRequest = null;
  lastSessionExportRequest = null;
  settingsState = {
    showInTray: true,
    minimizeToTrayOnClose: true,
    enableClaudePluginIntegration: false,
    claudeConfigDir: "/default/claude",
    codexConfigDir: "/default/codex",
    language: "zh",
  };
  lastSettingsSaveRequest = null;
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

export const setWebdavRemoteInfoState = (info: WebdavRemoteInfoState) => {
  webdavRemoteInfoState = JSON.parse(JSON.stringify(info)) as WebdavRemoteInfoState;
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
  skillBackupsState = JSON.parse(
    JSON.stringify(backups),
  ) as SkillBackupEntry[];
};

export const getSkillUpdatesState = () =>
  JSON.parse(JSON.stringify(skillUpdatesState)) as SkillUpdateInfo[];

export const setSkillUpdatesState = (updates: SkillUpdateInfo[]) => {
  skillUpdatesState = JSON.parse(JSON.stringify(updates)) as SkillUpdateInfo[];
};

export const getSkillsShResultsState = () =>
  JSON.parse(JSON.stringify(skillsShResultsState)) as SkillsShDiscoverableSkill[];

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

export const importSkillsFromAppsState = (
  imports: ImportSkillSelection[],
) => {
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
  installedSkillsState = installedSkillsState.filter((skill) => skill.id !== id);
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
  JSON.parse(JSON.stringify(promptsState[app] ?? {})) as Record<
    string,
    Prompt
  >;

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

export const setCurrentPromptFileContentState = (
  app: AppId,
  content: string | null,
) => {
  currentPromptFileContentByApp[app] = content;
};

export const upsertPromptState = (
  app: AppId,
  id: string,
  prompt: Prompt,
) => {
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
    current_provider_id: first?.providerId ?? proxyStatusState.current_provider_id,
  };
};

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

export const addToFailoverQueueState = (
  appType: AppId,
  providerId: string,
) => {
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
  };

  if (enabled) {
    current[appType] = "";
  }
  refreshActiveTargetForApp(appType);
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

export const getProxyTakeoverStatusState = () =>
  JSON.parse(JSON.stringify(proxyTakeoverStatusByApp)) as ProxyTakeoverStatusByApp;

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
};

export const listProviders = (appType: AppId) =>
  JSON.parse(JSON.stringify(providers[appType] ?? {})) as Record<
    string,
    Provider
  >;

export const getSettings = () =>
  JSON.parse(JSON.stringify(settingsState)) as Settings;

export const getLastSettingsSaveRequest = () =>
  lastSettingsSaveRequest
    ? (JSON.parse(JSON.stringify(lastSettingsSaveRequest)) as Settings)
    : null;

export const setSettings = (data: Partial<Settings>) => {
  settingsState = { ...settingsState, ...data };
};

export const recordSettingsSave = (settings: Settings) => {
  lastSettingsSaveRequest = JSON.parse(JSON.stringify(settings)) as Settings;
  setSettings(settings);
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

export const listSessions = () =>
  JSON.parse(JSON.stringify(sessionsState)) as SessionMeta[];

export const getSessionMessages = (providerId: string, sourcePath: string) =>
  JSON.parse(
    JSON.stringify(
      sessionMessagesState[sessionMessageKey(providerId, sourcePath)] ?? [],
    ),
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

export const setSessionFixtures = (
  sessions: SessionMeta[],
  messages: Record<string, SessionMessage[]>,
) => {
  sessionsState = JSON.parse(JSON.stringify(sessions)) as SessionMeta[];
  sessionMessagesState = JSON.parse(JSON.stringify(messages)) as Record<
    string,
    SessionMessage[]
  >;
};
