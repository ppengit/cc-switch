use std::{collections::HashMap, sync::Arc};

use tauri::Emitter;
use tokio::sync::RwLock;

use super::types::{ActiveRequestTarget, ProxyActivityEvent};

#[derive(Debug, Clone)]
struct ActiveRequestMeta {
    app_type: String,
    provider_id: String,
}

#[derive(Debug, Default)]
pub struct ProxyActivityState {
    requests: HashMap<String, ActiveRequestMeta>,
    targets: HashMap<(String, String), ActiveRequestTarget>,
}

impl ProxyActivityState {
    fn snapshot(&self) -> (usize, Vec<ActiveRequestTarget>) {
        let mut targets: Vec<ActiveRequestTarget> = self.targets.values().cloned().collect();
        targets.sort_by(|a, b| {
            a.app_type
                .cmp(&b.app_type)
                .then_with(|| b.inflight_requests.cmp(&a.inflight_requests))
                .then_with(|| a.provider_name.cmp(&b.provider_name))
        });
        (self.requests.len(), targets)
    }

    fn route_request(
        &mut self,
        request_id: &str,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
        request_model: Option<String>,
    ) -> ProxyActivityEvent {
        if let Some(existing) = self.requests.get(request_id).cloned() {
            if existing.app_type == app_type && existing.provider_id == provider_id {
                let (active_request_count, active_request_targets) = self.snapshot();
                return ProxyActivityEvent {
                    request_id: request_id.to_string(),
                    event: "routed".to_string(),
                    app_type: app_type.to_string(),
                    provider_id: provider_id.to_string(),
                    provider_name: provider_name.to_string(),
                    request_model,
                    status_code: None,
                    error: None,
                    active_request_count,
                    active_request_targets,
                };
            }

            self.decrement_target(&existing.app_type, &existing.provider_id);
        }

        let key = (app_type.to_string(), provider_id.to_string());
        let now = chrono::Utc::now().to_rfc3339();
        let entry = self
            .targets
            .entry(key)
            .or_insert_with(|| ActiveRequestTarget {
                app_type: app_type.to_string(),
                provider_id: provider_id.to_string(),
                provider_name: provider_name.to_string(),
                inflight_requests: 0,
                last_request_model: None,
                last_request_at: now.clone(),
            });
        entry.provider_name = provider_name.to_string();
        entry.inflight_requests += 1;
        entry.last_request_model = request_model.clone();
        entry.last_request_at = now;

        self.requests.insert(
            request_id.to_string(),
            ActiveRequestMeta {
                app_type: app_type.to_string(),
                provider_id: provider_id.to_string(),
            },
        );

        let (active_request_count, active_request_targets) = self.snapshot();
        ProxyActivityEvent {
            request_id: request_id.to_string(),
            event: "routed".to_string(),
            app_type: app_type.to_string(),
            provider_id: provider_id.to_string(),
            provider_name: provider_name.to_string(),
            request_model,
            status_code: None,
            error: None,
            active_request_count,
            active_request_targets,
        }
    }

    fn finish_request(
        &mut self,
        request_id: &str,
        event: &str,
        status_code: Option<u16>,
        error: Option<String>,
    ) -> Option<ProxyActivityEvent> {
        let meta = self.requests.remove(request_id)?;
        let target_key = (meta.app_type.clone(), meta.provider_id.clone());
        let provider_name = self
            .targets
            .get(&target_key)
            .map(|target| target.provider_name.clone())
            .unwrap_or_else(|| meta.provider_id.clone());

        self.decrement_target(&meta.app_type, &meta.provider_id);

        let (active_request_count, active_request_targets) = self.snapshot();
        Some(ProxyActivityEvent {
            request_id: request_id.to_string(),
            event: event.to_string(),
            app_type: meta.app_type,
            provider_id: meta.provider_id,
            provider_name,
            request_model: None,
            status_code,
            error,
            active_request_count,
            active_request_targets,
        })
    }

    fn decrement_target(&mut self, app_type: &str, provider_id: &str) {
        let key = (app_type.to_string(), provider_id.to_string());
        if let Some(target) = self.targets.get_mut(&key) {
            target.inflight_requests = target.inflight_requests.saturating_sub(1);
            if target.inflight_requests == 0 {
                self.targets.remove(&key);
            }
        }
    }
}

fn emit_activity_event(app_handle: Option<&tauri::AppHandle>, event: &ProxyActivityEvent) {
    if let Some(handle) = app_handle {
        if let Err(err) = handle.emit("proxy-activity-updated", event) {
            log::debug!("emit proxy-activity-updated failed: {err}");
        }
    }
}

pub async fn route_request(
    activity: &Arc<RwLock<ProxyActivityState>>,
    app_handle: Option<&tauri::AppHandle>,
    request_id: &str,
    app_type: &str,
    provider_id: &str,
    provider_name: &str,
    request_model: Option<String>,
) {
    let event = {
        let mut state = activity.write().await;
        state.route_request(
            request_id,
            app_type,
            provider_id,
            provider_name,
            request_model,
        )
    };
    emit_activity_event(app_handle, &event);
}

pub async fn finish_request(
    activity: &Arc<RwLock<ProxyActivityState>>,
    app_handle: Option<&tauri::AppHandle>,
    request_id: &str,
    status_code: Option<u16>,
    error: Option<String>,
) {
    let event = {
        let mut state = activity.write().await;
        let event_name = if error.is_some() { "failed" } else { "finished" };
        state.finish_request(request_id, event_name, status_code, error)
    };

    if let Some(event) = event {
        emit_activity_event(app_handle, &event);
    }
}

pub async fn snapshot(
    activity: &Arc<RwLock<ProxyActivityState>>,
) -> (usize, Vec<ActiveRequestTarget>) {
    let state = activity.read().await;
    state.snapshot()
}
