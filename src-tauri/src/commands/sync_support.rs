use serde_json::{json, Value};
use crate::error::AppError;
use crate::services::provider::ProviderService;
use crate::settings;
use crate::store::AppState;

pub(crate) fn run_post_import_sync(state: &AppState) -> Result<(), AppError> {
    ProviderService::sync_current_to_live(state)?;
    settings::reload_settings()?;
    Ok(())
}

fn post_sync_warning<E: std::fmt::Display>(err: E) -> String {
    AppError::localized(
        "sync.post_operation_sync_failed",
        format!("后置同步状态失败: {err}"),
        format!("Post-operation synchronization failed: {err}"),
    )
    .to_string()
}

pub(crate) fn post_sync_warning_from_result(
    result: Result<Result<(), AppError>, String>,
) -> Option<String> {
    match result {
        Ok(Ok(())) => None,
        Ok(Err(err)) => Some(post_sync_warning(err)),
        Err(err) => Some(post_sync_warning(err)),
    }
}

pub(crate) fn attach_warning(mut value: Value, warning: Option<String>) -> Value {
    if let Some(message) = warning {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("warning".to_string(), Value::String(message));
        }
    }
    value
}

pub(crate) fn success_payload_with_warning(backup_id: String, warning: Option<String>) -> Value {
    attach_warning(
        json!({
            "success": true,
            "message": "SQL imported successfully",
            "backupId": backup_id
        }),
        warning,
    )
}

#[cfg(test)]
mod tests {
    use super::{attach_warning, post_sync_warning_from_result};
    use crate::app_config::AppType;
    use crate::commands::sync_support::run_post_import_sync;
    use crate::config::{get_claude_settings_path, read_json_file};
    use crate::database::Database;
    use crate::provider::Provider;
    use crate::proxy::types::ProxyConfig;
    use crate::services::provider::ProviderService;
    use crate::store::AppState;
    use serde_json::{Value, json};
    use serial_test::serial;
    use std::env;
    use std::sync::Arc;
    use tempfile::TempDir;

    struct TempHome {
        #[allow(dead_code)]
        dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("failed to create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();
            let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();

            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());

            Self {
                dir,
                original_home,
                original_userprofile,
                original_test_home,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            if let Some(value) = &self.original_home {
                env::set_var("HOME", value);
            } else {
                env::remove_var("HOME");
            }

            if let Some(value) = &self.original_userprofile {
                env::set_var("USERPROFILE", value);
            } else {
                env::remove_var("USERPROFILE");
            }

            if let Some(value) = &self.original_test_home {
                env::set_var("CC_SWITCH_TEST_HOME", value);
            } else {
                env::remove_var("CC_SWITCH_TEST_HOME");
            }
        }
    }

    async fn reserve_free_tcp_port() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let port = listener
            .local_addr()
            .expect("read local addr for ephemeral port")
            .port();
        drop(listener);
        port
    }

    #[test]
    fn post_sync_warning_from_result_returns_none_on_success() {
        let warning = post_sync_warning_from_result(Ok(Ok(())));
        assert!(warning.is_none());
    }

    #[test]
    fn post_sync_warning_from_result_returns_some_on_sync_error() {
        let warning =
            post_sync_warning_from_result(Ok(Err(crate::error::AppError::Config("boom".into()))));
        assert!(warning.is_some());
    }

    #[tokio::test]
    async fn post_sync_warning_from_result_returns_some_on_join_error() {
        let handle = tokio::spawn(async move {
            panic!("forced join error");
        });
        let join_err = handle.await.expect_err("task should panic");
        let warning = post_sync_warning_from_result(Err(join_err.to_string()));
        assert!(warning.is_some());
    }

    #[test]
    fn attach_warning_adds_warning_without_dropping_existing_fields() {
        let payload = json!({ "status": "downloaded" });
        let updated = attach_warning(payload, Some("post sync warning".to_string()));
        assert_eq!(
            updated.get("status").and_then(|v| v.as_str()),
            Some("downloaded")
        );
        assert_eq!(
            updated.get("warning").and_then(|v| v.as_str()),
            Some("post sync warning")
        );
    }

    #[tokio::test]
    #[serial]
    async fn post_import_sync_uses_running_proxy_state_when_failover_takeover_is_active() {
        let _home = TempHome::new();
        crate::settings::reload_settings().expect("reload settings");

        let db = Arc::new(Database::memory().expect("init db"));
        let state = AppState::new(db.clone());

        let provider = Provider::with_id(
            "claude-a".into(),
            "Claude A".into(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token-a",
                    "ANTHROPIC_BASE_URL": "https://api.a.example",
                    "ANTHROPIC_MODEL": "model-a"
                }
            }),
            None,
        );
        db.save_provider("claude", &provider)
            .expect("save claude provider");
        db.add_to_failover_queue("claude", &provider.id)
            .expect("queue claude provider");

        let port = reserve_free_tcp_port().await;
        db.update_proxy_config(ProxyConfig {
            listen_port: port,
            ..Default::default()
        })
        .await
        .expect("set proxy config");

        let mut app_config = db
            .get_proxy_config_for_app("claude")
            .await
            .expect("get claude proxy config");
        app_config.enabled = true;
        app_config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(app_config)
            .await
            .expect("enable takeover and failover");

        db.clear_current_provider("claude")
            .expect("clear db current provider for failover mode");
        crate::settings::set_current_provider(&AppType::Claude, None)
            .expect("clear local current provider for failover mode");

        state
            .proxy_service
            .start()
            .await
            .expect("start proxy service");

        state
            .proxy_service
            .sync_live_from_provider_while_proxy_active(&AppType::Claude, &provider)
            .await
            .expect("seed takeover live");

        let shadow_state = AppState::new(db.clone());
        ProviderService::sync_current_to_live(&shadow_state)
            .expect("simulate legacy sync with a freshly constructed app state");

        run_post_import_sync(&state).expect("run post-import sync");

        let live: Value =
            read_json_file(&get_claude_settings_path()).expect("read claude live config");
        assert_eq!(
            live.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(serde_json::Value::as_str),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "post-import sync must keep Claude live on the local proxy endpoint while takeover+failover are active"
        );
        assert_eq!(
            live.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(serde_json::Value::as_str),
            Some("PROXY_MANAGED"),
            "post-import sync must preserve the takeover token placeholder instead of writing provider credentials back to live"
        );
    }
}
