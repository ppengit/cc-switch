use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Duration, Utc};
use std::time::Instant;
use tauri::Emitter;
use tokio::sync::RwLock;

use super::types::{
    clamp_raw_proxy_log_retention_minutes, ActiveRequestTarget, ProxyActivityEvent,
    ProxyRawLogEntry, ProxyRawLogEvent, DEFAULT_RAW_PROXY_LOG_RETENTION_MINUTES,
};

const RAW_LOG_CAPACITY: usize = 500;

/// 活动请求自动剪枝阈值。
///
/// 兜底：极少数情况下 forwarder 出错后没成功调用 `finish_request`（hook 异常 / panic
/// 等），会导致 strip 上一直挂着某个供应商。`snapshot()` 时按这个阈值清理超时的
/// inflight，避免顶部 strip 永远残留旧请求。10 分钟比正常的最长请求都更长。
const STALE_REQUEST_PRUNE_SECS: u64 = 600;

#[derive(Debug, Clone)]
struct ActiveRequestMeta {
    app_type: String,
    provider_id: String,
    provider_name: String,
    started_at: Instant,
    request_model: Option<String>,
    upstream_model: Option<String>,
}

#[derive(Debug, Default)]
pub struct ProxyActivityState {
    requests: HashMap<String, ActiveRequestMeta>,
    targets: HashMap<(String, String), ActiveRequestTarget>,
    raw_logs: Vec<ProxyRawLogEntry>,
    next_log_id: u64,
    raw_log_retention_minutes: u64,
}

impl ProxyActivityState {
    pub fn with_raw_log_retention_minutes(minutes: u64) -> Self {
        Self {
            raw_log_retention_minutes: clamp_raw_proxy_log_retention_minutes(minutes),
            ..Default::default()
        }
    }

    fn new_raw_log_event(
        id: u64,
        timestamp: String,
        event: &ProxyActivityEvent,
    ) -> ProxyRawLogEvent {
        ProxyRawLogEvent {
            id,
            timestamp,
            event: event.event.clone(),
            app_type: event.app_type.clone(),
            provider_id: event.provider_id.clone(),
            provider_name: event.provider_name.clone(),
            request_model: event.request_model.clone(),
            upstream_model: event.upstream_model.clone(),
            status_code: event.status_code,
            error: event.error.clone(),
            active_request_count: event.active_request_count,
            active_target_count: event.active_request_targets.len(),
        }
    }

    fn derive_display_model(
        request_model: Option<&String>,
        upstream_model: Option<&String>,
    ) -> Option<String> {
        upstream_model.cloned().or_else(|| request_model.cloned())
    }

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

    /// 兜底剪枝：把超过阈值仍未 finish 的请求强制丢弃。
    ///
    /// 返回被剪掉的请求数量；调用方可据此决定是否再次广播事件。
    fn prune_stale_requests(&mut self) -> usize {
        let now = Instant::now();
        let stale_ids: Vec<String> = self
            .requests
            .iter()
            .filter_map(|(rid, meta)| {
                (now.duration_since(meta.started_at).as_secs() >= STALE_REQUEST_PRUNE_SECS)
                    .then_some(rid.clone())
            })
            .collect();
        if stale_ids.is_empty() {
            return 0;
        }
        let stale_count = stale_ids.len();
        for rid in stale_ids {
            if let Some(meta) = self.requests.remove(&rid) {
                self.decrement_target(&meta.app_type, &meta.provider_id);
                log::warn!(
                    "[activity] 剪枝过期 inflight 请求 request_id={rid} app={} provider={}",
                    meta.app_type,
                    meta.provider_id
                );
            }
        }
        stale_count
    }

    fn raw_log_retention_minutes(&self) -> u64 {
        let minutes = if self.raw_log_retention_minutes == 0 {
            DEFAULT_RAW_PROXY_LOG_RETENTION_MINUTES
        } else {
            self.raw_log_retention_minutes
        };
        clamp_raw_proxy_log_retention_minutes(minutes)
    }

    fn set_raw_log_retention_minutes(&mut self, minutes: u64) {
        self.raw_log_retention_minutes = clamp_raw_proxy_log_retention_minutes(minutes);
        self.prune_raw_logs();
    }

    fn prune_raw_logs(&mut self) {
        let retention = Duration::minutes(self.raw_log_retention_minutes() as i64);
        let cutoff = Utc::now() - retention;

        self.raw_logs.retain(|entry| {
            DateTime::parse_from_rfc3339(&entry.updated_at)
                .map(|updated_at| updated_at.with_timezone(&Utc) >= cutoff)
                .unwrap_or(true)
        });

        if self.raw_logs.len() > RAW_LOG_CAPACITY {
            self.raw_logs.sort_by_key(|entry| entry.id);
            let overflow = self.raw_logs.len() - RAW_LOG_CAPACITY;
            self.raw_logs.drain(0..overflow);
        }
    }

    fn append_raw_log(&mut self, event: &ProxyActivityEvent) {
        self.next_log_id = self.next_log_id.saturating_add(1);
        let event_id = self.next_log_id;
        let now = chrono::Utc::now().to_rfc3339();
        let raw_event = Self::new_raw_log_event(event_id, now.clone(), event);

        if let Some(entry) = self
            .raw_logs
            .iter_mut()
            .find(|entry| entry.request_id == event.request_id)
        {
            entry.id = event_id;
            entry.timestamp = now.clone();
            entry.updated_at = now;
            entry.event = event.event.clone();
            entry.app_type = event.app_type.clone();
            entry.provider_id = event.provider_id.clone();
            entry.provider_name = event.provider_name.clone();
            if event.request_model.is_some() {
                entry.request_model = event.request_model.clone();
            }
            if event.upstream_model.is_some() {
                entry.upstream_model = event.upstream_model.clone();
            }
            entry.status_code = event.status_code.or(entry.status_code);
            if event.error.is_some() {
                entry.error = event.error.clone();
            }
            entry.active_request_count = event.active_request_count;
            entry.active_target_count = event.active_request_targets.len();
            if let Some(previous) = entry.events.last_mut().filter(|previous| {
                previous.event == raw_event.event && previous.provider_id == raw_event.provider_id
            }) {
                *previous = raw_event;
            } else {
                entry.events.push(raw_event);
            }
        } else {
            self.raw_logs.push(ProxyRawLogEntry {
                id: event_id,
                timestamp: now.clone(),
                started_at: now.clone(),
                updated_at: now,
                request_id: event.request_id.clone(),
                event: event.event.clone(),
                app_type: event.app_type.clone(),
                provider_id: event.provider_id.clone(),
                provider_name: event.provider_name.clone(),
                request_model: event.request_model.clone(),
                upstream_model: event.upstream_model.clone(),
                status_code: event.status_code,
                error: event.error.clone(),
                active_request_count: event.active_request_count,
                active_target_count: event.active_request_targets.len(),
                events: vec![raw_event],
            });
        }

        self.prune_raw_logs();
    }

    fn route_request(
        &mut self,
        request_id: &str,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
        request_model: Option<String>,
        upstream_model: Option<String>,
    ) -> ProxyActivityEvent {
        if let Some(existing) = self.requests.get(request_id).cloned() {
            if existing.app_type == app_type && existing.provider_id == provider_id {
                if let Some(meta) = self.requests.get_mut(request_id) {
                    meta.provider_name = provider_name.to_string();
                    if request_model.is_some() {
                        meta.request_model = request_model.clone();
                    }
                    if upstream_model.is_some() {
                        meta.upstream_model = upstream_model.clone();
                    }
                }

                if let Some(target) = self
                    .targets
                    .get_mut(&(app_type.to_string(), provider_id.to_string()))
                {
                    if request_model.is_some() {
                        target.request_model = request_model.clone();
                    }
                    if upstream_model.is_some() {
                        target.upstream_model = upstream_model.clone();
                    }
                    target.last_request_model = Self::derive_display_model(
                        target.request_model.as_ref(),
                        target.upstream_model.as_ref(),
                    );
                    target.last_request_at = chrono::Utc::now().to_rfc3339();
                }
                let (active_request_count, active_request_targets) = self.snapshot();
                let event = ProxyActivityEvent {
                    request_id: request_id.to_string(),
                    event: "routed".to_string(),
                    app_type: app_type.to_string(),
                    provider_id: provider_id.to_string(),
                    provider_name: provider_name.to_string(),
                    request_model,
                    upstream_model,
                    status_code: None,
                    error: None,
                    active_request_count,
                    active_request_targets,
                };
                self.append_raw_log(&event);
                return event;
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
                request_model: None,
                upstream_model: None,
                last_request_model: None,
                last_request_at: now.clone(),
            });
        entry.provider_name = provider_name.to_string();
        entry.inflight_requests += 1;
        entry.request_model = request_model.clone();
        entry.upstream_model = upstream_model.clone();
        entry.last_request_model =
            Self::derive_display_model(entry.request_model.as_ref(), entry.upstream_model.as_ref());
        entry.last_request_at = now;

        self.requests.insert(
            request_id.to_string(),
            ActiveRequestMeta {
                app_type: app_type.to_string(),
                provider_id: provider_id.to_string(),
                provider_name: provider_name.to_string(),
                started_at: Instant::now(),
                request_model: request_model.clone(),
                upstream_model: upstream_model.clone(),
            },
        );

        let (active_request_count, active_request_targets) = self.snapshot();
        let event = ProxyActivityEvent {
            request_id: request_id.to_string(),
            event: "routed".to_string(),
            app_type: app_type.to_string(),
            provider_id: provider_id.to_string(),
            provider_name: provider_name.to_string(),
            request_model,
            upstream_model,
            status_code: None,
            error: None,
            active_request_count,
            active_request_targets,
        };
        self.append_raw_log(&event);
        event
    }

    fn observe_request(
        &mut self,
        request_id: &str,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
        request_model: Option<String>,
    ) -> ProxyActivityEvent {
        let (active_request_count, active_request_targets) = self.snapshot();
        let event = ProxyActivityEvent {
            request_id: request_id.to_string(),
            event: "received".to_string(),
            app_type: app_type.to_string(),
            provider_id: provider_id.to_string(),
            provider_name: provider_name.to_string(),
            request_model,
            upstream_model: None,
            status_code: None,
            error: None,
            active_request_count,
            active_request_targets,
        };
        self.append_raw_log(&event);
        event
    }

    fn finish_request(
        &mut self,
        request_id: &str,
        event: &str,
        status_code: Option<u16>,
        error: Option<String>,
    ) -> Option<ProxyActivityEvent> {
        let Some(meta) = self.requests.remove(request_id) else {
            return self.finish_observed_request(request_id, event, status_code, error);
        };
        let provider_name = meta.provider_name.clone();
        let request_model = meta.request_model.clone();
        let upstream_model = meta.upstream_model.clone();

        self.decrement_target(&meta.app_type, &meta.provider_id);

        let (active_request_count, active_request_targets) = self.snapshot();
        let event = ProxyActivityEvent {
            request_id: request_id.to_string(),
            event: event.to_string(),
            app_type: meta.app_type,
            provider_id: meta.provider_id,
            provider_name,
            request_model,
            upstream_model,
            status_code,
            error,
            active_request_count,
            active_request_targets,
        };
        self.append_raw_log(&event);
        Some(event)
    }

    fn finish_observed_request(
        &mut self,
        request_id: &str,
        event: &str,
        status_code: Option<u16>,
        error: Option<String>,
    ) -> Option<ProxyActivityEvent> {
        let existing = self
            .raw_logs
            .iter()
            .find(|entry| entry.request_id == request_id)?;

        if matches!(existing.event.as_str(), "finished" | "failed" | "cleared") {
            return None;
        }

        let (active_request_count, active_request_targets) = self.snapshot();
        let event = ProxyActivityEvent {
            request_id: request_id.to_string(),
            event: event.to_string(),
            app_type: existing.app_type.clone(),
            provider_id: existing.provider_id.clone(),
            provider_name: existing.provider_name.clone(),
            request_model: existing.request_model.clone(),
            upstream_model: existing.upstream_model.clone(),
            status_code,
            error,
            active_request_count,
            active_request_targets,
        };
        self.append_raw_log(&event);
        Some(event)
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

    fn clear_provider(&mut self, app_type: &str, provider_id: &str) -> Option<ProxyActivityEvent> {
        let request_ids: Vec<String> = self
            .requests
            .iter()
            .filter_map(|(request_id, meta)| {
                (meta.app_type == app_type && meta.provider_id == provider_id)
                    .then_some(request_id.clone())
            })
            .collect();
        let target_key = (app_type.to_string(), provider_id.to_string());
        let provider_name = self
            .targets
            .get(&target_key)
            .map(|target| target.provider_name.clone())
            .unwrap_or_else(|| provider_id.to_string());
        let had_target = self.targets.remove(&target_key).is_some();

        if request_ids.is_empty() && !had_target {
            return None;
        }

        for request_id in request_ids {
            self.requests.remove(&request_id);
        }

        let (active_request_count, active_request_targets) = self.snapshot();
        let event = ProxyActivityEvent {
            request_id: format!("clear:{app_type}:{provider_id}"),
            event: "cleared".to_string(),
            app_type: app_type.to_string(),
            provider_id: provider_id.to_string(),
            provider_name,
            request_model: None,
            upstream_model: None,
            status_code: None,
            error: None,
            active_request_count,
            active_request_targets,
        };
        self.append_raw_log(&event);
        Some(event)
    }

    fn raw_logs(&mut self, limit: usize, app_type: Option<&str>) -> Vec<ProxyRawLogEntry> {
        self.prune_raw_logs();
        let safe_limit = limit.clamp(1, RAW_LOG_CAPACITY);
        let mut entries: Vec<ProxyRawLogEntry> = self
            .raw_logs
            .iter()
            .filter(|entry| {
                app_type
                    .map(|expected| entry.app_type.eq_ignore_ascii_case(expected))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        entries.sort_by(|a, b| b.id.cmp(&a.id));
        entries.truncate(safe_limit);
        entries.reverse();
        entries
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
    upstream_model: Option<String>,
) {
    let event = {
        let mut state = activity.write().await;
        state.route_request(
            request_id,
            app_type,
            provider_id,
            provider_name,
            request_model,
            upstream_model,
        )
    };
    emit_activity_event(app_handle, &event);
}

pub async fn observe_request(
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
        state.observe_request(
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
        let event_name = if error.is_some() {
            "failed"
        } else {
            "finished"
        };
        state.finish_request(request_id, event_name, status_code, error)
    };

    if let Some(event) = event {
        emit_activity_event(app_handle, &event);
    }
}

pub async fn snapshot(
    activity: &Arc<RwLock<ProxyActivityState>>,
) -> (usize, Vec<ActiveRequestTarget>) {
    let mut state = activity.write().await;
    let pruned = state.prune_stale_requests();
    if pruned > 0 {
        log::warn!("[activity] snapshot: 共剪枝 {pruned} 个过期请求");
    }
    state.snapshot()
}

pub async fn raw_logs(
    activity: &Arc<RwLock<ProxyActivityState>>,
    limit: usize,
    app_type: Option<&str>,
) -> Vec<ProxyRawLogEntry> {
    let mut state = activity.write().await;
    state.raw_logs(limit, app_type)
}

pub async fn set_raw_log_retention_minutes(
    activity: &Arc<RwLock<ProxyActivityState>>,
    minutes: u64,
) {
    let mut state = activity.write().await;
    state.set_raw_log_retention_minutes(minutes);
}

pub async fn clear_provider(
    activity: &Arc<RwLock<ProxyActivityState>>,
    app_handle: Option<&tauri::AppHandle>,
    app_type: &str,
    provider_id: &str,
) {
    let event = {
        let mut state = activity.write().await;
        state.clear_provider(app_type, provider_id)
    };

    if let Some(event) = event {
        emit_activity_event(app_handle, &event);
    }
}

#[cfg(test)]
mod tests {
    use super::ProxyActivityState;

    #[test]
    fn rerouting_same_request_updates_last_request_model_without_double_counting() {
        let mut state = ProxyActivityState::default();

        let first = state.route_request(
            "req-1",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
            None,
        );
        assert_eq!(first.active_request_count, 1);
        assert_eq!(first.active_request_targets.len(), 1);
        assert_eq!(
            first.active_request_targets[0].request_model.as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            first.active_request_targets[0]
                .last_request_model
                .as_deref(),
            Some("gpt-5.4")
        );

        let updated = state.route_request(
            "req-1",
            "codex",
            "provider-a",
            "Provider A",
            None,
            Some("gpt-5.3-codex".to_string()),
        );
        assert_eq!(updated.active_request_count, 1);
        assert_eq!(updated.active_request_targets.len(), 1);
        assert_eq!(
            updated.active_request_targets[0].request_model.as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            updated.active_request_targets[0].upstream_model.as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            updated.active_request_targets[0]
                .last_request_model
                .as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(updated.active_request_targets[0].inflight_requests, 1);
    }

    #[test]
    fn raw_logs_capture_received_routed_and_finished_sequence() {
        let mut state = ProxyActivityState::default();

        let received = state.observe_request(
            "req-seq",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
        );
        assert_eq!(received.event, "received");
        assert_eq!(received.active_request_count, 0);

        let routed = state.route_request(
            "req-seq",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
            None,
        );
        assert_eq!(routed.event, "routed");
        assert_eq!(routed.active_request_count, 1);

        let finished = state
            .finish_request("req-seq", "finished", Some(200), None)
            .expect("finish event");
        assert_eq!(finished.event, "finished");
        assert_eq!(finished.active_request_count, 0);

        let logs = state.raw_logs(10, Some("codex"));
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].event, "finished");
        assert_eq!(logs[0].status_code, Some(200));
        let events: Vec<String> = logs[0]
            .events
            .iter()
            .map(|entry| entry.event.clone())
            .collect();
        assert_eq!(events, vec!["received", "routed", "finished"]);
        assert_eq!(logs[0].request_model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn raw_logs_update_repeated_routed_state_without_duplicate_status_events() {
        let mut state = ProxyActivityState::default();

        state.observe_request(
            "req-routed",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
        );
        state.route_request(
            "req-routed",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
            None,
        );
        state.route_request(
            "req-routed",
            "codex",
            "provider-a",
            "Provider A",
            None,
            Some("gpt-5.3-codex".to_string()),
        );

        let logs = state.raw_logs(10, Some("codex"));
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].event, "routed");
        assert_eq!(logs[0].request_model.as_deref(), Some("gpt-5.4"));
        assert_eq!(logs[0].upstream_model.as_deref(), Some("gpt-5.3-codex"));
        let events: Vec<String> = logs[0]
            .events
            .iter()
            .map(|entry| entry.event.clone())
            .collect();
        assert_eq!(events, vec!["received", "routed"]);
    }

    #[test]
    fn raw_logs_keep_request_models_isolated_for_concurrent_requests_same_target() {
        let mut state = ProxyActivityState::default();

        state.route_request(
            "req-a",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.3-codex".to_string()),
            None,
        );
        state.route_request(
            "req-b",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.5".to_string()),
            None,
        );

        state
            .finish_request("req-a", "finished", Some(200), None)
            .expect("finish req-a");

        let logs = state.raw_logs(10, Some("codex"));
        let req_a = logs
            .iter()
            .find(|entry| entry.request_id == "req-a")
            .expect("req-a log");
        assert_eq!(req_a.event, "finished");
        assert_eq!(req_a.request_model.as_deref(), Some("gpt-5.3-codex"));
    }

    #[test]
    fn raw_logs_finish_observed_request_without_route() {
        let mut state = ProxyActivityState::default();

        state.observe_request(
            "req-parse-failed",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
        );

        let failed = state
            .finish_request(
                "req-parse-failed",
                "failed",
                None,
                Some("parse failed".to_string()),
            )
            .expect("observed request should be finished");

        assert_eq!(failed.event, "failed");
        assert_eq!(failed.active_request_count, 0);

        let logs = state.raw_logs(10, Some("codex"));
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].event, "failed");
        assert_eq!(logs[0].error.as_deref(), Some("parse failed"));
        let events: Vec<String> = logs[0]
            .events
            .iter()
            .map(|entry| entry.event.clone())
            .collect();
        assert_eq!(events, vec!["received", "failed"]);
    }

    #[test]
    fn clear_provider_removes_matching_requests_and_targets() {
        let mut state = ProxyActivityState::default();

        state.route_request(
            "req-a",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
            None,
        );
        state.route_request(
            "req-b",
            "codex",
            "provider-a",
            "Provider A",
            Some("gpt-5.4".to_string()),
            None,
        );
        state.route_request(
            "req-c",
            "codex",
            "provider-b",
            "Provider B",
            Some("gpt-5.3-codex".to_string()),
            None,
        );

        let cleared = state
            .clear_provider("codex", "provider-a")
            .expect("provider-a activity should exist");

        assert_eq!(cleared.event, "cleared");
        assert_eq!(cleared.active_request_count, 1);
        assert_eq!(cleared.active_request_targets.len(), 1);
        assert_eq!(cleared.active_request_targets[0].provider_id, "provider-b");
        assert!(!state.requests.contains_key("req-a"));
        assert!(!state.requests.contains_key("req-b"));
        assert!(state.requests.contains_key("req-c"));
    }
}
