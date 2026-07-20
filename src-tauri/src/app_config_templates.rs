use crate::app_config::AppType;

const DEFAULT_CODEX_MODEL: &str = "gpt-5.6";
const DEFAULT_CLAUDE_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_CLAUDE_HAIKU_MODEL: &str = "claude-haiku-4-5-20251001";
const DEFAULT_CLAUDE_SONNET_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_CLAUDE_OPUS_MODEL: &str = "claude-opus-4-7";
const DEFAULT_GEMINI_MODEL: &str = "gemini-3.1-pro-preview";
const DEFAULT_GROK_MODEL: &str = "grok-4.5";

/// One editable file inside an application's access/live configuration template.
///
/// This is the single backend source of truth used by both the config dialog
/// and proxy-takeover live rendering. Keep frontend examples aligned with this
/// module when changing defaults.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigTemplateFile {
    pub key: String,
    pub label: String,
    pub content: String,
}

fn normalize_codex_template_content(content: &str) -> String {
    content
        .replace(
            "base_url = {proxyCodexBaseUrl}",
            "base_url = \"{proxyCodexBaseUrl}\"",
        )
        .replace("base_url = {proxyBaseUrl}", "base_url = \"{proxyBaseUrl}\"")
}

fn normalize_template_file(
    app_type: &AppType,
    mut file: AppConfigTemplateFile,
) -> AppConfigTemplateFile {
    if matches!(app_type, AppType::Codex) && file.key == "config" {
        file.content = normalize_codex_template_content(&file.content);
    }
    file
}

pub fn normalize_template_files(
    app_type: &AppType,
    files: Vec<AppConfigTemplateFile>,
) -> Vec<AppConfigTemplateFile> {
    files
        .into_iter()
        .map(|file| normalize_template_file(app_type, file))
        .collect()
}

pub fn default_template_files_for(app_type: &AppType) -> Vec<AppConfigTemplateFile> {
    match app_type {
        AppType::Claude => vec![AppConfigTemplateFile {
            key: "settings".to_string(),
            label: "settings.json".to_string(),
            content: format!("{{\n  \"env\": {{\n    \"ANTHROPIC_BASE_URL\": \"{{proxyBaseUrl}}\",\n    \"ANTHROPIC_AUTH_TOKEN\": \"{{proxyToken}}\",\n    \"ANTHROPIC_MODEL\": \"{DEFAULT_CLAUDE_MODEL}\",\n    \"ANTHROPIC_DEFAULT_HAIKU_MODEL\": \"{DEFAULT_CLAUDE_HAIKU_MODEL}\",\n    \"ANTHROPIC_DEFAULT_SONNET_MODEL\": \"{DEFAULT_CLAUDE_SONNET_MODEL}\",\n    \"ANTHROPIC_DEFAULT_OPUS_MODEL\": \"{DEFAULT_CLAUDE_OPUS_MODEL}\",\n    \"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\": \"1\"\n  }}\n}}\n"),
        }],
        AppType::ClaudeDesktop => vec![],
        AppType::Codex => vec![
            AppConfigTemplateFile {
                key: "auth".to_string(),
                label: "auth.json".to_string(),
                content: "{\n  \"OPENAI_API_KEY\": \"{proxyToken}\"\n}\n".to_string(),
            },
            AppConfigTemplateFile {
                key: "config".to_string(),
                label: "config.toml".to_string(),
                content: format!("model_provider = \"cc-switch\"\nmodel = \"{DEFAULT_CODEX_MODEL}\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.cc-switch]\nname = \"cc-switch\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nbase_url = \"{{proxyCodexBaseUrl}}\"\n\n{{mcpConfig}}\n"),
            },
        ],
        AppType::Gemini => vec![
            AppConfigTemplateFile {
                key: "env".to_string(),
                label: ".env".to_string(),
                content: format!("GOOGLE_GEMINI_BASE_URL={{proxyBaseUrl}}\nGEMINI_API_KEY={{proxyToken}}\nGEMINI_MODEL={DEFAULT_GEMINI_MODEL}\n"),
            },
            AppConfigTemplateFile {
                key: "settings".to_string(),
                label: "settings.json".to_string(),
                content: format!("{{\n  \"mcpServers\": {{mcpConfig}},\n  \"model\": {{\n    \"name\": \"{DEFAULT_GEMINI_MODEL}\"\n  }},\n  \"security\": {{\n    \"auth\": {{\n      \"selectedType\": \"gemini-api-key\"\n    }}\n  }}\n}}\n"),
            },
        ],
        // Grok Build live settings are `{ "config": "<toml string>" }` written to ~/.grok/config.toml.
        // Takeover rewrites base_url/api_key from live content; this template still produces valid
        // settings when rendered via render_access_template with {proxyBaseUrl}/{proxyToken}.
        // Callers that need the Grok proxy path pass format!("{}/grokbuild/v1", proxy_url) as
        // the proxyBaseUrl binding (see build_proxy_takeover_settings).
        AppType::GrokBuild => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "config.toml".to_string(),
            content: format!(
                "[models]\ndefault = \"{DEFAULT_GROK_MODEL}\"\n\n[model.\"{DEFAULT_GROK_MODEL}\"]\nmodel = \"{DEFAULT_GROK_MODEL}\"\nbase_url = \"{{proxyBaseUrl}}\"\nname = \"Grok\"\napi_key = \"{{proxyToken}}\"\napi_backend = \"responses\"\ncontext_window = 500000\n"
            ),
        }],
        AppType::OpenCode => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "opencode.json".to_string(),
            content: "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"provider\": {\n    \"openai\": {\n      \"npm\": \"@ai-sdk/openai\",\n      \"name\": \"OpenAI Responses\",\n      \"options\": {\n        \"baseURL\": \"https://api.openai.com/v1\",\n        \"apiKey\": \"{env:OPENAI_API_KEY}\",\n        \"setCacheKey\": true\n      },\n      \"models\": {\n        \"gpt-5.5\": {\n          \"name\": \"GPT-5.5\"\n        }\n      }\n    }\n  },\n  \"model\": \"openai/gpt-5.5\",\n  \"small_model\": \"openai/gpt-5.5\",\n  \"mcp\": {}\n}\n".to_string(),
        }],
        AppType::OpenClaw => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "openclaw.json".to_string(),
            content: "{\n  models: {\n    mode: \"merge\",\n    providers: {\n      openai: {\n        baseUrl: \"https://api.openai.com/v1\",\n        apiKey: \"\",\n        api: \"openai-responses\",\n        models: [\n          {\n            id: \"gpt-5.5\",\n            name: \"GPT-5.5\",\n            contextWindow: 400000,\n            maxTokens: 128000\n          }\n        ]\n      }\n    }\n  },\n  agents: {\n    defaults: {\n      model: {\n        primary: \"openai/gpt-5.5\"\n      },\n      models: {\n        \"openai/gpt-5.5\": { alias: \"GPT-5.5\" }\n      }\n    }\n  }\n}\n".to_string(),
        }],
        AppType::Hermes => vec![AppConfigTemplateFile {
            key: "config".to_string(),
            label: "config.yaml".to_string(),
            content: "model:\n  default: \"gpt-5.5\"\n  provider: \"openai\"\n  base_url: \"https://api.openai.com/v1\"\n  context_length: 400000\n  max_tokens: 128000\nagent:\n  reasoning_effort: \"high\"\ncustom_providers:\n  - name: \"openai\"\n    base_url: \"https://api.openai.com/v1\"\n    api_key: \"\"\n    api_mode: \"codex_responses\"\n    model: \"gpt-5.5\"\n    models:\n      gpt-5.5:\n        context_length: 400000\nmcp_servers: {}\n".to_string(),
        }],
    }
}

pub fn parse_stored_template_files(
    app_type: &AppType,
    persisted: Option<String>,
) -> Vec<AppConfigTemplateFile> {
    let Some(persisted) = persisted else {
        return normalize_template_files(app_type, default_template_files_for(app_type));
    };

    let trimmed = persisted.trim();
    if trimmed.is_empty() {
        return normalize_template_files(app_type, default_template_files_for(app_type));
    }

    if let Ok(files) = serde_json::from_str::<Vec<AppConfigTemplateFile>>(trimmed) {
        if files.iter().any(|file| {
            file.content.contains("{providerConfig}") || file.content.contains("{settingsConfig}")
        }) {
            return normalize_template_files(app_type, default_template_files_for(app_type));
        }

        let mut merged = default_template_files_for(app_type);
        for stored in files {
            if let Some(target) = merged.iter_mut().find(|file| file.key == stored.key) {
                *target = stored;
            }
        }
        return normalize_template_files(app_type, merged);
    }

    normalize_template_files(app_type, default_template_files_for(app_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content_for(app_type: AppType, key: &str) -> String {
        default_template_files_for(&app_type)
            .into_iter()
            .find(|file| file.key == key)
            .expect("template file should exist")
            .content
    }

    #[test]
    fn claude_default_template_uses_claude_models() {
        let content = content_for(AppType::Claude, "settings");

        assert!(content.contains("\"ANTHROPIC_MODEL\": \"claude-sonnet-4-6\""));
        assert!(
            content.contains("\"ANTHROPIC_DEFAULT_HAIKU_MODEL\": \"claude-haiku-4-5-20251001\"")
        );
        assert!(content.contains("\"ANTHROPIC_DEFAULT_SONNET_MODEL\": \"claude-sonnet-4-6\""));
        assert!(content.contains("\"ANTHROPIC_DEFAULT_OPUS_MODEL\": \"claude-opus-4-7\""));
        assert!(!content.contains("\"ANTHROPIC_MODEL\": \"gpt-5.5\""));
    }

    #[test]
    fn gemini_default_template_uses_gemini_model() {
        let env = content_for(AppType::Gemini, "env");
        let settings = content_for(AppType::Gemini, "settings");

        assert!(env.contains("GEMINI_MODEL=gemini-3.1-pro-preview"));
        assert!(settings.contains("\"name\": \"gemini-3.1-pro-preview\""));
    }

    #[test]
    fn grokbuild_default_template_uses_grok_model_and_proxy_placeholders() {
        let content = content_for(AppType::GrokBuild, "config");

        assert!(content.contains("default = \"grok-4.5\""));
        assert!(content.contains("[model.\"grok-4.5\"]"));
        assert!(content.contains("base_url = \"{proxyBaseUrl}\""));
        assert!(content.contains("api_key = \"{proxyToken}\""));
        assert!(content.contains("api_backend = \"responses\""));
    }
}
