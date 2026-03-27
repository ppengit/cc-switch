use cc_switch_lib::{
    get_default_cost_multiplier_test_hook, get_pricing_model_source_test_hook,
    get_provider_session_occupancy_test_hook, list_session_provider_bindings_test_hook,
    reconcile_session_bindings_for_routing, release_provider_session_bindings_test_hook,
    remove_from_failover_queue_test_hook, set_default_cost_multiplier_test_hook,
    set_pricing_model_source_test_hook, switch_session_provider_binding_test_hook, update_settings,
    AppError, AppSettings, AppState, AppType, Database, Provider, ProviderService, ProxyService,
};
use serde_json::json;
use std::sync::Arc;

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

fn create_memory_test_state() -> AppState {
    let db = Arc::new(Database::memory().expect("create memory db"));
    let proxy_service = ProxyService::new(db.clone());
    AppState { db, proxy_service }
}

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

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn removing_enabled_provider_from_queue_reassigns_active_session_binding() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
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

    state
        .db
        .add_to_failover_queue("codex", "a")
        .expect("queue provider a");
    state
        .db
        .add_to_failover_queue("codex", "b")
        .expect("queue provider b");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.auto_failover_enabled = true;
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
        .upsert_session_provider_binding("codex", "session-disable", "a", true, now_ms)
        .expect("seed binding");

    state
        .db
        .remove_from_failover_queue("codex", "a")
        .expect("remove from queue");
    reconcile_session_bindings_for_routing(&state, "codex", 30)
        .await
        .expect("reconcile bindings");

    let binding = state
        .db
        .get_session_provider_binding("codex", "session-disable", 30)
        .expect("query binding")
        .expect("binding exists");
    assert_eq!(binding.provider_id, "b");
    assert!(binding.pinned);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn removing_current_provider_from_queue_switches_current_provider_immediately() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
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

    state
        .db
        .add_to_failover_queue("codex", "a")
        .expect("queue provider a");
    state
        .db
        .add_to_failover_queue("codex", "b")
        .expect("queue provider b");

    state
        .proxy_service
        .switch_proxy_target("codex", "a")
        .await
        .expect("switch to provider a");

    remove_from_failover_queue_test_hook(&state, "codex", "a")
        .await
        .expect("remove current provider from queue");

    let current = state
        .db
        .get_current_provider("codex")
        .expect("read current provider");
    assert_eq!(current.as_deref(), Some("b"));

    let effective_current =
        ProviderService::current(&state, AppType::Codex).expect("read effective current");
    assert_eq!(effective_current.as_str(), "b");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn removing_last_queued_current_provider_falls_back_to_another_provider() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
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

    state
        .db
        .add_to_failover_queue("codex", "a")
        .expect("queue provider a");

    state
        .proxy_service
        .switch_proxy_target("codex", "a")
        .await
        .expect("switch to provider a");

    remove_from_failover_queue_test_hook(&state, "codex", "a")
        .await
        .expect("remove only queued provider");

    let current = state
        .db
        .get_current_provider("codex")
        .expect("read current provider");
    assert_eq!(current.as_deref(), Some("b"));

    let effective_current =
        ProviderService::current(&state, AppType::Codex).expect("read effective current");
    assert_eq!(effective_current.as_str(), "b");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn release_provider_session_bindings_reassigns_active_sessions() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
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

    state
        .db
        .add_to_failover_queue("codex", "a")
        .expect("queue provider a");
    state
        .db
        .add_to_failover_queue("codex", "b")
        .expect("queue provider b");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.auto_failover_enabled = true;
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
        .upsert_session_provider_binding("codex", "session-release", "a", true, now_ms)
        .expect("seed binding");

    let affected = release_provider_session_bindings_test_hook(&state, "codex", "a", Some(30))
        .await
        .expect("release provider occupancy");
    assert_eq!(affected.total_affected, 1);
    assert_eq!(affected.rebound_count, 1);
    assert_eq!(affected.unbound_count, 0);
    assert!(!affected.suggest_increase_max_sessions);

    let binding = state
        .db
        .get_session_provider_binding("codex", "session-release", 30)
        .expect("query binding")
        .expect("binding exists");
    assert_eq!(binding.provider_id, "b");
    assert!(binding.pinned);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn release_provider_session_bindings_unbinds_when_no_rebind_target_exists() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("a".to_string(), "Provider A".to_string(), json!({}), None),
        )
        .expect("save provider a");

    state
        .db
        .add_to_failover_queue("codex", "a")
        .expect("queue provider a");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.auto_failover_enabled = true;
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
        .upsert_session_provider_binding("codex", "session-unbind", "a", true, now_ms)
        .expect("seed binding");

    let affected = release_provider_session_bindings_test_hook(&state, "codex", "a", Some(30))
        .await
        .expect("release provider occupancy");
    assert_eq!(affected.total_affected, 1);
    assert_eq!(affected.rebound_count, 0);
    assert_eq!(affected.unbound_count, 1);
    assert!(!affected.suggest_increase_max_sessions);

    let binding = state
        .db
        .get_session_provider_binding("codex", "session-unbind", 30)
        .expect("query binding");
    assert!(binding.is_none());
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn release_provider_session_bindings_suggests_raising_capacity_when_others_are_full() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
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

    state
        .db
        .add_to_failover_queue("codex", "a")
        .expect("queue provider a");
    state
        .db
        .add_to_failover_queue("codex", "b")
        .expect("queue provider b");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.auto_failover_enabled = true;
    config.session_routing_enabled = true;
    config.session_routing_strategy = "priority".to_string();
    config.session_idle_ttl_minutes = 30;
    config.session_max_sessions_per_provider = 1;
    config.session_allow_shared_when_exhausted = false;
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .expect("update codex proxy config");

    let now_ms = chrono::Utc::now().timestamp_millis();
    state
        .db
        .upsert_session_provider_binding("codex", "session-a", "a", true, now_ms)
        .expect("seed binding a");
    state
        .db
        .upsert_session_provider_binding("codex", "session-b", "b", true, now_ms)
        .expect("seed binding b");

    let affected = release_provider_session_bindings_test_hook(&state, "codex", "a", Some(30))
        .await
        .expect("release provider occupancy");
    assert_eq!(affected.total_affected, 1);
    assert_eq!(affected.rebound_count, 0);
    assert_eq!(affected.unbound_count, 1);
    assert!(affected.suggest_increase_max_sessions);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn switch_session_provider_binding_rejects_provider_outside_routing_candidates() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("queued".to_string(), "Queued".to_string(), json!({}), None),
        )
        .expect("save queued provider");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id(
                "disabled".to_string(),
                "Disabled".to_string(),
                json!({}),
                None,
            ),
        )
        .expect("save disabled provider");

    state
        .db
        .add_to_failover_queue("codex", "queued")
        .expect("queue provider");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.auto_failover_enabled = true;
    config.session_routing_enabled = true;
    config.session_idle_ttl_minutes = 30;
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .expect("update codex proxy config");

    let error = switch_session_provider_binding_test_hook(
        &state,
        "codex",
        "session-disabled-target",
        "disabled",
        Some(true),
    )
    .await
    .expect_err("disabled provider should be rejected");

    assert!(
        error.contains("不在会话路由候选集中"),
        "unexpected error: {error}"
    );
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn switch_session_provider_binding_rejects_provider_that_reached_capacity() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
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

    state
        .db
        .add_to_failover_queue("codex", "a")
        .expect("queue provider a");
    state
        .db
        .add_to_failover_queue("codex", "b")
        .expect("queue provider b");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.auto_failover_enabled = true;
    config.session_routing_enabled = true;
    config.session_idle_ttl_minutes = 30;
    config.session_max_sessions_per_provider = 1;
    config.session_allow_shared_when_exhausted = false;
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .expect("update codex proxy config");

    let now_ms = chrono::Utc::now().timestamp_millis();
    state
        .db
        .upsert_session_provider_binding("codex", "session-capacity-existing", "b", false, now_ms)
        .expect("seed capacity binding");

    let error = switch_session_provider_binding_test_hook(
        &state,
        "codex",
        "session-capacity-new",
        "b",
        None,
    )
    .await
    .expect_err("full provider should be rejected");

    assert!(
        error.contains("最大会话数限制"),
        "unexpected error: {error}"
    );
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn switch_session_provider_binding_rejects_degraded_provider_when_stable_candidate_exists() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_memory_test_state();
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id("stable".to_string(), "Stable".to_string(), json!({}), None),
        )
        .expect("save stable provider");
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id(
                "degraded".to_string(),
                "Degraded".to_string(),
                json!({}),
                None,
            ),
        )
        .expect("save degraded provider");

    state
        .db
        .add_to_failover_queue("codex", "stable")
        .expect("queue stable provider");
    state
        .db
        .add_to_failover_queue("codex", "degraded")
        .expect("queue degraded provider");

    let mut config = state
        .db
        .get_proxy_config_for_app("codex")
        .await
        .expect("read codex proxy config");
    config.auto_failover_enabled = true;
    config.session_routing_enabled = true;
    config.session_idle_ttl_minutes = 30;
    state
        .db
        .update_proxy_config_for_app(config)
        .await
        .expect("update codex proxy config");

    state
        .db
        .update_provider_health_with_threshold(
            "degraded",
            "codex",
            false,
            Some("soft fail".to_string()),
            3,
        )
        .await
        .expect("mark provider degraded");

    let error = switch_session_provider_binding_test_hook(
        &state,
        "codex",
        "session-degraded-target",
        "degraded",
        None,
    )
    .await
    .expect_err("degraded provider should be rejected while stable provider exists");

    assert!(
        error.contains("不在会话路由候选集中"),
        "unexpected error: {error}"
    );
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn list_provider_ids_for_session_routing_filters_out_opencode_providers_not_in_live_config() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let opencode_dir = home.join(".config").join("opencode");
    std::fs::create_dir_all(&opencode_dir).expect("create opencode dir");
    let mut settings = AppSettings::default();
    settings.opencode_config_dir = Some(opencode_dir.display().to_string());
    update_settings(settings).expect("set opencode config override");
    std::fs::write(
        opencode_dir.join("opencode.json"),
        r#"{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "enabled-live": {
      "name": "Enabled Live"
    }
  }
}"#,
    )
    .expect("write opencode config");

    let state = create_memory_test_state();
    state
        .db
        .save_provider(
            "opencode",
            &Provider::with_id(
                "enabled-live".to_string(),
                "Enabled Live".to_string(),
                json!({}),
                None,
            ),
        )
        .expect("save enabled live provider");
    state
        .db
        .save_provider(
            "opencode",
            &Provider::with_id(
                "disabled-live".to_string(),
                "Disabled Live".to_string(),
                json!({}),
                None,
            ),
        )
        .expect("save disabled live provider");

    let provider_ids = state
        .db
        .list_provider_ids_for_session_routing("opencode")
        .expect("list routing providers");

    assert_eq!(provider_ids, vec!["enabled-live".to_string()]);
}
