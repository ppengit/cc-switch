use cc_switch_lib::{
    get_default_cost_multiplier_test_hook, get_pricing_model_source_test_hook,
    get_provider_session_occupancy_test_hook, list_session_provider_bindings_test_hook,
    set_default_cost_multiplier_test_hook, set_pricing_model_source_test_hook, AppError, Provider,
};
use serde_json::json;

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

// 测试使用 Mutex 进行串行化，跨 await 持锁是预期行为
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn default_cost_multiplier_commands_round_trip() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");

    let default = get_default_cost_multiplier_test_hook(&state, "claude")
        .await
        .expect("read default multiplier");
    assert_eq!(default, "1");

    set_default_cost_multiplier_test_hook(&state, "claude", "1.5")
        .await
        .expect("set multiplier");
    let updated = get_default_cost_multiplier_test_hook(&state, "claude")
        .await
        .expect("read updated multiplier");
    assert_eq!(updated, "1.5");

    let err = set_default_cost_multiplier_test_hook(&state, "claude", "not-a-number")
        .await
        .expect_err("invalid multiplier should error");
    // 错误已改为 Localized 类型（支持 i18n）
    match err {
        AppError::Localized { key, .. } => {
            assert_eq!(key, "error.invalidMultiplier");
        }
        other => panic!("expected localized error, got {other:?}"),
    }
}

// 测试使用 Mutex 进行串行化，跨 await 持锁是预期行为
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn pricing_model_source_commands_round_trip() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");

    let default = get_pricing_model_source_test_hook(&state, "claude")
        .await
        .expect("read default pricing model source");
    assert_eq!(default, "response");

    set_pricing_model_source_test_hook(&state, "claude", "request")
        .await
        .expect("set pricing model source");
    let updated = get_pricing_model_source_test_hook(&state, "claude")
        .await
        .expect("read updated pricing model source");
    assert_eq!(updated, "request");

    let err = set_pricing_model_source_test_hook(&state, "claude", "invalid")
        .await
        .expect_err("invalid pricing model source should error");
    // 错误已改为 Localized 类型（支持 i18n）
    match err {
        AppError::Localized { key, .. } => {
            assert_eq!(key, "error.invalidPricingMode");
        }
        other => panic!("expected localized error, got {other:?}"),
    }
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn session_routing_enabled_rebinds_unhealthy_provider_and_updates_occupancy() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None),
        )
        .expect("save provider a");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None),
        )
        .expect("save provider b");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.session_routing_enabled = true;
    config.session_routing_strategy = "priority".to_string();
    config.session_max_sessions_per_provider = 1;
    config.session_allow_shared_when_exhausted = false;
    config.session_idle_ttl_minutes = 30;
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .expect("update codex proxy config");

    let now_ms = chrono::Utc::now().timestamp_millis();
    state
        .db
        .upsert_session_provider_binding("codex", "session-enabled", "a", true, now_ms)
        .expect("seed binding");

    state
        .db
        .update_provider_health_with_threshold(
            "a",
            "codex",
            false,
            Some("circuit open".to_string()),
            1,
        )
        .await
        .expect("mark provider a unhealthy");

    let bindings = list_session_provider_bindings_test_hook(&state, "codex", Some(30))
        .await
        .expect("list bindings");
    let binding = bindings
        .iter()
        .find(|item| item.session_id == "session-enabled")
        .expect("binding should still exist");
    assert_eq!(binding.provider_id, "b");
    assert!(
        binding.pinned,
        "pinned mode should be preserved after rebind"
    );

    let occupancy = get_provider_session_occupancy_test_hook(&state, "codex", Some(30))
        .await
        .expect("occupancy");
    let count_a = occupancy
        .iter()
        .find(|item| item.provider_id == "a")
        .map(|item| item.session_count)
        .unwrap_or(0);
    let count_b = occupancy
        .iter()
        .find(|item| item.provider_id == "b")
        .map(|item| item.session_count)
        .unwrap_or(0);
    assert_eq!(count_a, 0);
    assert_eq!(count_b, 1);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn session_routing_disabled_keeps_existing_binding_even_if_provider_unhealthy() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None),
        )
        .expect("save provider a");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None),
        )
        .expect("save provider b");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.session_routing_enabled = false;
    config.session_idle_ttl_minutes = 30;
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .expect("update codex proxy config");

    let now_ms = chrono::Utc::now().timestamp_millis();
    state
        .db
        .upsert_session_provider_binding("codex", "session-disabled", "a", true, now_ms)
        .expect("seed binding");

    state
        .db
        .update_provider_health_with_threshold(
            "a",
            "codex",
            false,
            Some("circuit open".to_string()),
            1,
        )
        .await
        .expect("mark provider a unhealthy");

    let bindings = list_session_provider_bindings_test_hook(&state, "codex", Some(30))
        .await
        .expect("list bindings");
    let binding = bindings
        .iter()
        .find(|item| item.session_id == "session-disabled")
        .expect("binding should exist");
    assert_eq!(binding.provider_id, "a");

    let occupancy = get_provider_session_occupancy_test_hook(&state, "codex", Some(30))
        .await
        .expect("occupancy");
    let count_a = occupancy
        .iter()
        .find(|item| item.provider_id == "a")
        .map(|item| item.session_count)
        .unwrap_or(0);
    let count_b = occupancy
        .iter()
        .find(|item| item.provider_id == "b")
        .map(|item| item.session_count)
        .unwrap_or(0);
    assert_eq!(count_a, 1);
    assert_eq!(count_b, 0);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn session_routing_enabled_removes_binding_when_all_candidates_are_unhealthy() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None),
        )
        .expect("save provider a");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("b".to_string(), "Provider B".to_string(), json!({}), None),
        )
        .expect("save provider b");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.session_routing_enabled = true;
    config.session_routing_strategy = "priority".to_string();
    config.session_idle_ttl_minutes = 30;
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .expect("update codex proxy config");

    let now_ms = chrono::Utc::now().timestamp_millis();
    state
        .db
        .upsert_session_provider_binding("codex", "session-all-unhealthy", "a", false, now_ms)
        .expect("seed binding");

    for provider_id in ["a", "b"] {
        state
            .db
            .update_provider_health_with_threshold(
                provider_id,
                "codex",
                false,
                Some("circuit open".to_string()),
                1,
            )
            .await
            .expect("mark provider unhealthy");
    }

    let bindings = list_session_provider_bindings_test_hook(&state, "codex", Some(30))
        .await
        .expect("list bindings");
    assert!(
        !bindings
            .iter()
            .any(|item| item.session_id == "session-all-unhealthy"),
        "binding should be released when no healthy routing candidate remains"
    );

    let occupancy = get_provider_session_occupancy_test_hook(&state, "codex", Some(30))
        .await
        .expect("occupancy");
    let count_a = occupancy
        .iter()
        .find(|item| item.provider_id == "a")
        .map(|item| item.session_count)
        .unwrap_or(0);
    let count_b = occupancy
        .iter()
        .find(|item| item.provider_id == "b")
        .map(|item| item.session_count)
        .unwrap_or(0);
    assert_eq!(count_a, 0);
    assert_eq!(count_b, 0);
}
