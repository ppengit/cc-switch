import { z } from "zod";

const directorySchema = z
  .string()
  .trim()
  .min(1, "路径不能为空")
  .optional()
  .or(z.literal(""));

export const settingsSchema = z.object({
  // 设备级 UI 设置
  showInTray: z.boolean(),
  minimizeToTrayOnClose: z.boolean(),
  enableClaudePluginIntegration: z.boolean().optional(),
  skipClaudeOnboarding: z.boolean().optional(),
  launchOnStartup: z.boolean().optional(),
  silentStartup: z.boolean().optional(),
  enableLocalProxy: z.boolean().optional(),
  proxyConfirmed: z.boolean().optional(),
  usageConfirmed: z.boolean().optional(),
  language: z.enum(["en", "zh", "ja"]).optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  visibleApps: z
    .object({
      claude: z.boolean().optional(),
      codex: z.boolean().optional(),
      gemini: z.boolean().optional(),
      opencode: z.boolean().optional(),
      openclaw: z.boolean().optional(),
    })
    .partial()
    .optional(),

  // 设备级目录覆盖
  claudeConfigDir: directorySchema.nullable().optional(),
  codexConfigDir: directorySchema.nullable().optional(),
  geminiConfigDir: directorySchema.nullable().optional(),
  opencodeConfigDir: directorySchema.nullable().optional(),
  openclawConfigDir: directorySchema.nullable().optional(),

  // 当前供应商 ID（设备级）
  currentProviderClaude: z.string().optional(),
  currentProviderCodex: z.string().optional(),
  currentProviderGemini: z.string().optional(),
  currentProviderOpencode: z.string().optional(),
  currentProviderOpenclaw: z.string().optional(),

  // Skill 同步设置
  skillSyncMethod: z.enum(["auto", "symlink", "copy"]).optional(),

  // WebDAV v2 同步设置（通过专用命令保存，schema 仅用于读取）
  webdavSync: z
    .object({
      enabled: z.boolean().optional(),
      autoSync: z.boolean().optional(),
      baseUrl: z.string().trim().optional().or(z.literal("")),
      username: z.string().trim().optional().or(z.literal("")),
      password: z.string().optional(),
      remoteRoot: z.string().trim().optional().or(z.literal("")),
      profile: z.string().trim().optional().or(z.literal("")),
      status: z
        .object({
          lastSyncAt: z.number().nullable().optional(),
          lastError: z.string().nullable().optional(),
          lastErrorSource: z.string().nullable().optional(),
          lastRemoteEtag: z.string().nullable().optional(),
          lastLocalManifestHash: z.string().nullable().optional(),
          lastRemoteManifestHash: z.string().nullable().optional(),
        })
        .optional(),
    })
    .optional(),

  // 终端快捷方式设置
  terminalTargets: z.record(z.string(), z.any()).optional(),
  currentSessionByApp: z.record(z.string(), z.string()).optional(),

  // 备份策略设置
  backupIntervalHours: z.number().optional(),
  backupRetainCount: z.number().optional(),

  // 终端设置
  preferredTerminal: z.string().optional(),
});

export type SettingsFormData = z.infer<typeof settingsSchema>;
