//! 官方供应商种子数据
//!
//! 启动时调用 `Database::init_default_official_providers` 把这些条目
//! 写入 `providers` 表，让所有用户都能看到一个"一键切回官方"的入口。
//!
//! 字段与前端预设保持一致，参见：
//! - `src/config/claudeProviderPresets.ts`（"Claude Official"）
//! - `src/config/codexProviderPresets.ts`（"OpenAI Official"）
//! - `src/config/geminiProviderPresets.ts`（"Google Official"）

use crate::app_config::AppType;

pub(crate) const LEGACY_CLAUDE_OFFICIAL_SETTINGS_CONFIG_JSON: &str = r#"{"env":{"ANTHROPIC_MODEL":"claude-sonnet-4-6","ANTHROPIC_DEFAULT_HAIKU_MODEL":"claude-haiku-4-5-20251001","ANTHROPIC_DEFAULT_SONNET_MODEL":"claude-sonnet-4-6","ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-opus-4-7","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"}}"#;

/// 单条官方供应商种子定义。
pub(crate) struct OfficialProviderSeed {
    pub id: &'static str,
    pub app_type: AppType,
    pub name: &'static str,
    pub website_url: &'static str,
    pub icon: &'static str,
    pub icon_color: &'static str,
    /// settings_config 的 JSON 字符串，每个 app 结构不同。
    pub settings_config_json: &'static str,
}

/// Claude / Codex / Gemini 三个应用的官方预设。
///
/// id 固定，便于幂等检查；name 直接用英文原名（与前端预设一致），不做 i18n。
pub(crate) const OFFICIAL_SEEDS: &[OfficialProviderSeed] = &[
    OfficialProviderSeed {
        id: "claude-official",
        app_type: AppType::Claude,
        name: "Claude Official",
        website_url: "https://www.anthropic.com/claude-code",
        icon: "anthropic",
        icon_color: "#D4915D",
        // 显式写入官方 API 地址和空 token，并启用 Claude Code 默认权限与中文输出偏好。
        settings_config_json: r#"{"env":{"ANTHROPIC_MODEL":"claude-sonnet-4-6","ANTHROPIC_DEFAULT_HAIKU_MODEL":"claude-haiku-4-5-20251001","ANTHROPIC_DEFAULT_SONNET_MODEL":"claude-sonnet-4-6","ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-opus-4-7[1m]","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_AUTH_TOKEN":""},"permissions":{"defaultMode":"bypassPermissions"},"skipDangerousModePermissionPrompt":true,"effortLevel":"xhigh","language":"chinese"}"#,
    },
    OfficialProviderSeed {
        id: "codex-official",
        app_type: AppType::Codex,
        name: "OpenAI Official",
        website_url: "https://chatgpt.com/codex",
        icon: "openai",
        icon_color: "#00A67E",
        // 不写 API Key，让用户走 Codex 自身认证；默认启用 GPT-5.5 Responses 配置。
        settings_config_json: r#"{"auth":{},"config":"model = \"gpt-5.5\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n"}"#,
    },
    OfficialProviderSeed {
        id: "gemini-official",
        app_type: AppType::Gemini,
        name: "Google Official",
        website_url: "https://ai.google.dev/",
        icon: "gemini",
        icon_color: "#4285F4",
        // 不写 API Key / base URL，保留 Google OAuth；默认模型贴合当前 Gemini CLI。
        settings_config_json: r#"{"env":{"GEMINI_MODEL":"gemini-3.1-pro-preview"},"config":{"model":{"name":"gemini-3.1-pro-preview"}}}"#,
    },
];

/// 判断给定的 provider id 是否属于内置官方种子。
///
/// 单一事实源：直接扫描 `OFFICIAL_SEEDS`，避免在多处重复维护 id 列表。
pub(crate) fn is_official_seed_id(id: &str) -> bool {
    OFFICIAL_SEEDS.iter().any(|seed| seed.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_official_seed_uses_requested_default_settings() {
        let seed = OFFICIAL_SEEDS
            .iter()
            .find(|seed| seed.id == "claude-official")
            .expect("Claude Official seed should exist");
        let settings: serde_json::Value =
            serde_json::from_str(seed.settings_config_json).expect("seed JSON should parse");

        assert_eq!(
            settings,
            json!({
                "env": {
                    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-7[1m]",
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                    "ANTHROPIC_AUTH_TOKEN": ""
                },
                "permissions": {
                    "defaultMode": "bypassPermissions"
                },
                "skipDangerousModePermissionPrompt": true,
                "effortLevel": "xhigh",
                "language": "chinese"
            })
        );
    }
}
