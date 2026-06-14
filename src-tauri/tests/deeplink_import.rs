use std::sync::Arc;

use cc_switch_lib::{import_provider_from_deeplink, parse_deeplink_url, AppState, Database};

#[path = "support.rs"]
mod support;
use support::{ensure_test_home, reset_test_fs, test_mutex};

#[test]
fn deeplink_import_claude_provider_persists_to_db() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let url = "ccswitch://v1/import?resource=provider&app=claude&name=DeepLink%20Claude&homepage=https%3A%2F%2Fexample.com&endpoint=https%3A%2F%2Fapi.example.com%2Fv1&apiKey=sk-test-claude-key&model=claude-sonnet-4&icon=claude";
    let request = parse_deeplink_url(url).expect("parse deeplink url");

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());

    let provider_id = import_provider_from_deeplink(&state, request.clone())
        .expect("import provider from deeplink");

    // Verify DB state
    let providers = db.get_all_providers("claude").expect("get providers");
    let provider = providers
        .get(&provider_id)
        .expect("provider created via deeplink");

    assert_eq!(provider.name, request.name.clone().unwrap());
    assert_eq!(provider.website_url.as_deref(), request.homepage.as_deref());
    assert_eq!(provider.icon.as_deref(), Some("claude"));
    let auth_token = provider
        .settings_config
        .pointer("/env/ANTHROPIC_AUTH_TOKEN")
        .and_then(|v| v.as_str());
    let base_url = provider
        .settings_config
        .pointer("/env/ANTHROPIC_BASE_URL")
        .and_then(|v| v.as_str());
    assert_eq!(auth_token, request.api_key.as_deref());
    assert_eq!(base_url, request.endpoint.as_deref());
}

#[test]
fn deeplink_import_claude_provider_applies_provider_default_template() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let url = "ccswitch://v1/import?resource=provider&app=claude&name=Templated%20Claude&homepage=https%3A%2F%2Fexample.com&endpoint=https%3A%2F%2Fapi.template.example%2Fv1&apiKey=sk-template-claude-key&model=claude-template-model";
    let request = parse_deeplink_url(url).expect("parse deeplink url");

    let db = Arc::new(Database::memory().expect("create memory db"));
    db.set_provider_default_template(
        "claude",
        Some(
            r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "{baseUrl}",
    "ANTHROPIC_AUTH_TOKEN": "{apiKey}",
    "ANTHROPIC_MODEL": "{model}",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "EXTRA_TEMPLATE_FLAG": "enabled"
  }
}"#
            .to_string(),
        ),
    )
    .expect("set provider default template");
    let state = AppState::new(db.clone());

    let provider_id = import_provider_from_deeplink(&state, request.clone())
        .expect("import provider from deeplink");
    let providers = db.get_all_providers("claude").expect("get providers");
    let provider = providers
        .get(&provider_id)
        .expect("provider created via deeplink");

    assert_eq!(
        provider
            .settings_config
            .pointer("/env/ANTHROPIC_BASE_URL")
            .and_then(|v| v.as_str()),
        request.endpoint.as_deref()
    );
    assert_eq!(
        provider
            .settings_config
            .pointer("/env/ANTHROPIC_AUTH_TOKEN")
            .and_then(|v| v.as_str()),
        request.api_key.as_deref()
    );
    assert_eq!(
        provider
            .settings_config
            .pointer("/env/ANTHROPIC_MODEL")
            .and_then(|v| v.as_str()),
        request.model.as_deref()
    );
    assert_eq!(
        provider
            .settings_config
            .pointer("/env/EXTRA_TEMPLATE_FLAG")
            .and_then(|v| v.as_str()),
        Some("enabled")
    );
}

#[test]
fn deeplink_import_codex_provider_builds_auth_and_config() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let url = "ccswitch://v1/import?resource=provider&app=codex&name=DeepLink%20Codex&homepage=https%3A%2F%2Fopenai.example&endpoint=https%3A%2F%2Fapi.openai.example%2Fv1&apiKey=sk-test-codex-key&model=gpt-4o&icon=openai";
    let request = parse_deeplink_url(url).expect("parse deeplink url");

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());

    let provider_id = import_provider_from_deeplink(&state, request.clone())
        .expect("import provider from deeplink");

    let providers = db.get_all_providers("codex").expect("get providers");
    let provider = providers
        .get(&provider_id)
        .expect("provider created via deeplink");

    assert_eq!(provider.name, request.name.clone().unwrap());
    assert_eq!(provider.website_url.as_deref(), request.homepage.as_deref());
    assert_eq!(provider.icon.as_deref(), Some("openai"));
    let auth_value = provider
        .settings_config
        .pointer("/auth/OPENAI_API_KEY")
        .and_then(|v| v.as_str());
    let config_text = provider
        .settings_config
        .get("config")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert_eq!(auth_value, request.api_key.as_deref());
    assert!(
        config_text.contains(request.endpoint.as_deref().unwrap()),
        "config.toml content should contain endpoint"
    );
    assert!(
        config_text.contains("model = \"gpt-4o\""),
        "config.toml content should contain model setting"
    );
}

#[test]
fn deeplink_import_codex_provider_applies_provider_default_template() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let url = "ccswitch://v1/import?resource=provider&app=codex&name=Templated%20Codex&homepage=https%3A%2F%2Fcodex.example&endpoint=https%3A%2F%2Fapi.codex-template.example%2Fv1&apiKey=sk-template-codex-key&model=gpt-template&icon=openai";
    let request = parse_deeplink_url(url).expect("parse deeplink url");

    let db = Arc::new(Database::memory().expect("create memory db"));
    db.set_provider_default_template(
        "codex",
        Some(
            r#"{
  "auth": {
    "OPENAI_API_KEY": "{apiKey}"
  },
  "config": "model_provider = \"vendor\"\nmodel = {model}\nmodel_reasoning_effort = \"high\"\n\n[model_providers.vendor]\nname = \"Templated Vendor\"\nbase_url = {baseUrl}\nwire_api = \"responses\"\nrequires_openai_auth = true\n"
}"#
            .to_string(),
        ),
    )
    .expect("set provider default template");
    let state = AppState::new(db.clone());

    let provider_id = import_provider_from_deeplink(&state, request.clone())
        .expect("import provider from deeplink");
    let providers = db.get_all_providers("codex").expect("get providers");
    let provider = providers
        .get(&provider_id)
        .expect("provider created via deeplink");

    assert_eq!(
        provider
            .settings_config
            .pointer("/auth/OPENAI_API_KEY")
            .and_then(|v| v.as_str()),
        request.api_key.as_deref()
    );

    let config_text = provider
        .settings_config
        .get("config")
        .and_then(|v| v.as_str())
        .expect("config text");
    let parsed: toml::Value = toml::from_str(config_text).expect("valid rendered TOML");
    assert_eq!(
        parsed.get("model_provider").and_then(|v| v.as_str()),
        Some("vendor")
    );
    assert_eq!(
        parsed.get("model").and_then(|v| v.as_str()),
        request.model.as_deref()
    );
    assert_eq!(
        parsed
            .get("model_providers")
            .and_then(|v| v.get("vendor"))
            .and_then(|v| v.get("base_url"))
            .and_then(|v| v.as_str()),
        request.endpoint.as_deref()
    );
    assert_eq!(
        parsed
            .get("model_providers")
            .and_then(|v| v.get("vendor"))
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str()),
        Some("Templated Vendor")
    );
}
