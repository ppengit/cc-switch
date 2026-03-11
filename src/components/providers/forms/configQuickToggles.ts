import {
  getTomlBoolValue,
  getTomlStringValue,
  removeTomlKey,
  removeTomlKeyIfMatch,
  upsertTomlBoolValue,
  upsertTomlStringValue,
} from "@/utils/tomlKeyUtils";

export interface QuickToggleOption<Key extends string> {
  key: Key;
  labelKey: string;
  defaultLabel: string;
  descriptionKey: string;
  defaultDescription: string;
}

export type ClaudeQuickToggleKey =
  | "hideAttribution"
  | "alwaysThinking"
  | "teammates"
  | "skipAllPermissions"
  | "fastMode";

export const CLAUDE_QUICK_TOGGLE_OPTIONS: Array<
  QuickToggleOption<ClaudeQuickToggleKey>
> = [
  {
    key: "hideAttribution",
    labelKey: "claudeConfig.hideAttribution",
    defaultLabel: "隐藏 AI 署名",
    descriptionKey: "claudeConfig.tooltips.hideAttribution",
    defaultDescription:
      "隐藏 Claude Code 自动附带的提交或 PR 署名，适合不希望在提交记录里暴露 AI 标记时使用。",
  },
  {
    key: "alwaysThinking",
    labelKey: "claudeConfig.alwaysThinking",
    defaultLabel: "扩展思考",
    descriptionKey: "claudeConfig.tooltips.alwaysThinking",
    defaultDescription:
      "让 Claude 更倾向于使用更深入的思考流程，通常更稳，但响应会更慢。",
  },
  {
    key: "teammates",
    labelKey: "claudeConfig.enableTeammates",
    defaultLabel: "Teammates 模式",
    descriptionKey: "claudeConfig.tooltips.enableTeammates",
    defaultDescription:
      "开启实验性的多代理协作能力，适合拆分复杂任务，但稳定性可能不如默认模式。",
  },
  {
    key: "skipAllPermissions",
    labelKey: "claudeConfig.skipAllPermissions",
    defaultLabel: "跳过所有权限",
    descriptionKey: "claudeConfig.tooltips.skipAllPermissions",
    defaultDescription:
      "默认直接放行本地操作，不再频繁弹权限确认。适合受控环境，但风险更高。",
  },
  {
    key: "fastMode",
    labelKey: "claudeConfig.fastMode",
    defaultLabel: "Fast 模式",
    descriptionKey: "claudeConfig.tooltips.fastMode",
    defaultDescription:
      "优先更低延迟，官方说明质量不变但成本更高，而且第三方上游可能不支持。",
  },
];

export type GeminiQuickToggleKey =
  | "inlineThinking"
  | "showModelInfo"
  | "enableAgents";

export const GEMINI_QUICK_TOGGLE_OPTIONS: Array<
  QuickToggleOption<GeminiQuickToggleKey>
> = [
  {
    key: "inlineThinking",
    labelKey: "geminiConfig.inlineThinking",
    defaultLabel: "扩展思考",
    descriptionKey: "geminiConfig.tooltips.inlineThinking",
    defaultDescription:
      "在对话里直接展示更完整的思考内容，便于排查和理解，但输出会更长。",
  },
  {
    key: "showModelInfo",
    labelKey: "geminiConfig.showModelInfo",
    defaultLabel: "显示模型信息",
    descriptionKey: "geminiConfig.tooltips.showModelInfo",
    defaultDescription:
      "在聊天界面显示当前实际使用的模型，适合核对路由和配置是否生效。",
  },
  {
    key: "enableAgents",
    labelKey: "geminiConfig.enableAgents",
    defaultLabel: "启用代理模式",
    descriptionKey: "geminiConfig.tooltips.enableAgents",
    defaultDescription:
      "打开 Gemini CLI 的实验性 Agents 能力，适合复杂流程，但可能有兼容性变化。",
  },
];

export type CodexQuickToggleKey =
  | "workspaceWrite"
  | "fullAccess"
  | "approvalOnRequest"
  | "approvalNever"
  | "fastTier"
  | "highReasoning"
  | "planHighReasoning"
  | "conciseReasoningSummary"
  | "detailedReasoningSummary"
  | "verboseOutput"
  | "rawAgentReasoning";

export const CODEX_QUICK_TOGGLE_OPTIONS: Array<
  QuickToggleOption<CodexQuickToggleKey>
> = [
  {
    key: "workspaceWrite",
    labelKey: "codexConfig.workspaceWrite",
    defaultLabel: "工作区写入",
    descriptionKey: "codexConfig.tooltips.workspaceWrite",
    defaultDescription:
      "把 sandbox_mode 设为 workspace-write，允许在工作区内修改文件，但比完全访问更克制。",
  },
  {
    key: "fullAccess",
    labelKey: "codexConfig.fullAccess",
    defaultLabel: "完全访问权限",
    descriptionKey: "codexConfig.tooltips.fullAccess",
    defaultDescription:
      "把沙箱改成 danger-full-access，让 Codex 可以直接读写工作区并执行命令，适合本机受控环境。",
  },
  {
    key: "approvalOnRequest",
    labelKey: "codexConfig.approvalOnRequest",
    defaultLabel: "按需审批",
    descriptionKey: "codexConfig.tooltips.approvalOnRequest",
    defaultDescription:
      "把 approval_policy 设为 on-request，需要时再人工批准执行高风险动作。",
  },
  {
    key: "approvalNever",
    labelKey: "codexConfig.approvalNever",
    defaultLabel: "永不审批",
    descriptionKey: "codexConfig.tooltips.approvalNever",
    defaultDescription:
      "把 approval_policy 设为 never，不再请求审批，适合你完全信任当前环境时使用。",
  },
  {
    key: "fastTier",
    labelKey: "codexConfig.fastTier",
    defaultLabel: "Fast 服务层",
    descriptionKey: "codexConfig.tooltips.fastTier",
    defaultDescription:
      "设置 service_tier = fast，优先更低延迟，适合高频交互式编辑。",
  },
  {
    key: "highReasoning",
    labelKey: "codexConfig.highReasoning",
    defaultLabel: "高强度推理",
    descriptionKey: "codexConfig.tooltips.highReasoning",
    defaultDescription:
      "设置更高的 reasoning effort，让 Codex 在复杂任务上花更多思考预算，通常更稳但更慢。",
  },
  {
    key: "planHighReasoning",
    labelKey: "codexConfig.planHighReasoning",
    defaultLabel: "计划模式高推理",
    descriptionKey: "codexConfig.tooltips.planHighReasoning",
    defaultDescription:
      "把 plan_mode_reasoning_effort 设为 high，让规划阶段也使用更高推理强度。",
  },
  {
    key: "conciseReasoningSummary",
    labelKey: "codexConfig.conciseReasoningSummary",
    defaultLabel: "简短推理摘要",
    descriptionKey: "codexConfig.tooltips.conciseReasoningSummary",
    defaultDescription:
      "为回答附带简短的 reasoning summary，便于快速看懂模型为什么这么做。",
  },
  {
    key: "detailedReasoningSummary",
    labelKey: "codexConfig.detailedReasoningSummary",
    defaultLabel: "详细推理摘要",
    descriptionKey: "codexConfig.tooltips.detailedReasoningSummary",
    defaultDescription:
      "把 model_reasoning_summary 设为 detailed，返回更完整的推理摘要，适合排查复杂行为。",
  },
  {
    key: "verboseOutput",
    labelKey: "codexConfig.verboseOutput",
    defaultLabel: "详细输出",
    descriptionKey: "codexConfig.tooltips.verboseOutput",
    defaultDescription:
      "提高 model_verbosity，让 Codex 输出更详细的说明，适合调试和审计。",
  },
  {
    key: "rawAgentReasoning",
    labelKey: "codexConfig.rawAgentReasoning",
    defaultLabel: "原始代理推理",
    descriptionKey: "codexConfig.tooltips.rawAgentReasoning",
    defaultDescription:
      "开启 show_raw_agent_reasoning，直接显示代理的原始推理内容，更适合诊断而不是日常使用。",
  },
];

export const getCodexQuickToggleStates = (value: string) => ({
  workspaceWrite:
    getTomlStringValue(value, "sandbox_mode") === "workspace-write",
  fullAccess:
    getTomlStringValue(value, "sandbox_mode") === "danger-full-access",
  approvalOnRequest:
    getTomlStringValue(value, "approval_policy") === "on-request",
  approvalNever: getTomlStringValue(value, "approval_policy") === "never",
  fastTier: getTomlStringValue(value, "service_tier") === "fast",
  highReasoning: getTomlStringValue(value, "model_reasoning_effort") === "high",
  planHighReasoning:
    getTomlStringValue(value, "plan_mode_reasoning_effort") === "high",
  conciseReasoningSummary:
    getTomlStringValue(value, "model_reasoning_summary") === "concise",
  detailedReasoningSummary:
    getTomlStringValue(value, "model_reasoning_summary") === "detailed",
  verboseOutput: getTomlStringValue(value, "model_verbosity") === "high",
  rawAgentReasoning:
    getTomlBoolValue(value, "show_raw_agent_reasoning") === true,
});

export const toggleCodexQuickOption = (
  value: string,
  toggleKey: CodexQuickToggleKey,
  checked: boolean,
): string => {
  switch (toggleKey) {
    case "workspaceWrite":
      return checked
        ? upsertTomlStringValue(value, "sandbox_mode", "workspace-write")
        : removeTomlKeyIfMatch(value, "sandbox_mode", "workspace-write");
    case "fullAccess":
      return checked
        ? upsertTomlStringValue(value, "sandbox_mode", "danger-full-access")
        : removeTomlKeyIfMatch(value, "sandbox_mode", "danger-full-access");
    case "approvalOnRequest":
      return checked
        ? upsertTomlStringValue(value, "approval_policy", "on-request")
        : removeTomlKeyIfMatch(value, "approval_policy", "on-request");
    case "approvalNever":
      return checked
        ? upsertTomlStringValue(value, "approval_policy", "never")
        : removeTomlKeyIfMatch(value, "approval_policy", "never");
    case "fastTier":
      return checked
        ? upsertTomlStringValue(value, "service_tier", "fast")
        : removeTomlKeyIfMatch(value, "service_tier", "fast");
    case "highReasoning":
      return checked
        ? upsertTomlStringValue(value, "model_reasoning_effort", "high")
        : removeTomlKeyIfMatch(value, "model_reasoning_effort", "high");
    case "planHighReasoning":
      return checked
        ? upsertTomlStringValue(value, "plan_mode_reasoning_effort", "high")
        : removeTomlKeyIfMatch(value, "plan_mode_reasoning_effort", "high");
    case "conciseReasoningSummary":
      return checked
        ? upsertTomlStringValue(value, "model_reasoning_summary", "concise")
        : removeTomlKeyIfMatch(value, "model_reasoning_summary", "concise");
    case "detailedReasoningSummary":
      return checked
        ? upsertTomlStringValue(value, "model_reasoning_summary", "detailed")
        : removeTomlKeyIfMatch(value, "model_reasoning_summary", "detailed");
    case "verboseOutput":
      return checked
        ? upsertTomlStringValue(value, "model_verbosity", "high")
        : removeTomlKeyIfMatch(value, "model_verbosity", "high");
    case "rawAgentReasoning":
      return checked
        ? upsertTomlBoolValue(value, "show_raw_agent_reasoning", true)
        : getTomlBoolValue(value, "show_raw_agent_reasoning") === true
          ? removeTomlKey(value, "show_raw_agent_reasoning")
          : value;
    default:
      return value;
  }
};
