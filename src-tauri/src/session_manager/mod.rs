pub mod providers;
pub mod terminal;

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use providers::{claude, codex, gemini, hermes, openclaw, opencode};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub provider_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionRequest {
    pub provider_id: String,
    pub session_id: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionOutcome {
    pub provider_id: String,
    pub session_id: String,
    pub source_path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    let (r1, r2, r3, r4, r5, r6) = std::thread::scope(|s| {
        let h1 = s.spawn(codex::scan_sessions);
        let h2 = s.spawn(claude::scan_sessions);
        let h3 = s.spawn(opencode::scan_sessions);
        let h4 = s.spawn(openclaw::scan_sessions);
        let h5 = s.spawn(gemini::scan_sessions);
        let h6 = s.spawn(hermes::scan_sessions);
        (
            h1.join().unwrap_or_default(),
            h2.join().unwrap_or_default(),
            h3.join().unwrap_or_default(),
            h4.join().unwrap_or_default(),
            h5.join().unwrap_or_default(),
            h6.join().unwrap_or_default(),
        )
    });

    let mut sessions = Vec::new();
    sessions.extend(r1);
    sessions.extend(r2);
    sessions.extend(r3);
    sessions.extend(r4);
    sessions.extend(r5);
    sessions.extend(r6);

    sort_sessions_by_recent(&mut sessions);
    sessions
}

pub fn scan_sessions_for_provider(provider_id: &str) -> Vec<SessionMeta> {
    let mut sessions = match provider_id {
        "codex" => codex::scan_sessions(),
        "claude" => claude::scan_sessions(),
        "opencode" => opencode::scan_sessions(),
        "openclaw" => openclaw::scan_sessions(),
        "gemini" => gemini::scan_sessions(),
        "hermes" => hermes::scan_sessions(),
        _ => Vec::new(),
    };

    sort_sessions_by_recent(&mut sessions);
    sessions
}

fn sort_sessions_by_recent(sessions: &mut [SessionMeta]) {
    sessions.sort_by(|a, b| {
        let a_ts = a.last_active_at.or(a.created_at).unwrap_or(0);
        let b_ts = b.last_active_at.or(b.created_at).unwrap_or(0);
        b_ts.cmp(&a_ts)
    });
}

pub fn sanitize_detected_title_candidate(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    if trimmed.starts_with("# AGENTS.md")
        || lower.starts_with("<environment_context>")
        || lower.starts_with("<cwd>")
        || lower.starts_with("<shell>")
        || lower.contains("<local-command-caveat>")
        || lower.starts_with("<command-name>")
    {
        return None;
    }

    Some(trimmed.to_string())
}

fn format_markdown_timestamp(ts: Option<i64>) -> Option<String> {
    let ts = ts?;
    if ts <= 0 {
        return None;
    }

    let dt = if ts > 10_000_000_000 {
        Local.timestamp_millis_opt(ts).single()
    } else {
        Local.timestamp_opt(ts, 0).single()
    }?;

    Some(dt.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn markdown_role_label(role: &str) -> &str {
    match role.trim().to_ascii_lowercase().as_str() {
        "assistant" => "Assistant",
        "user" => "User",
        "system" => "System",
        "tool" => "Tool",
        _ => role,
    }
}

pub fn export_session_markdown(session: &SessionMeta, messages: &[SessionMessage]) -> String {
    let title = session
        .title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&session.session_id);

    let mut output = String::new();
    output.push_str("# ");
    output.push_str(title);
    output.push_str("\n\n");
    output.push_str("- Provider: ");
    output.push_str(&session.provider_id);
    output.push('\n');
    output.push_str("- Session ID: ");
    output.push_str(&session.session_id);
    output.push('\n');

    if let Some(project_dir) = session
        .project_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        output.push_str("- Project: ");
        output.push_str(project_dir);
        output.push('\n');
    }

    if let Some(created_at) = format_markdown_timestamp(session.created_at) {
        output.push_str("- Created At: ");
        output.push_str(&created_at);
        output.push('\n');
    }

    if let Some(last_active_at) = format_markdown_timestamp(session.last_active_at) {
        output.push_str("- Last Active At: ");
        output.push_str(&last_active_at);
        output.push('\n');
    }

    output.push_str("\n---\n");

    for message in messages {
        output.push_str("\n## ");
        output.push_str(markdown_role_label(&message.role));
        output.push('\n');

        if let Some(ts) = format_markdown_timestamp(message.ts) {
            output.push_str("_Time: ");
            output.push_str(&ts);
            output.push_str("_\n\n");
        } else {
            output.push('\n');
        }

        output.push_str(message.content.trim_end());
        output.push('\n');
    }

    output
}

pub fn load_messages(provider_id: &str, source_path: &str) -> Result<Vec<SessionMessage>, String> {
    // SQLite sessions use a "sqlite:" prefixed source_path
    if provider_id == "opencode" && source_path.starts_with("sqlite:") {
        return opencode::load_messages_sqlite(source_path);
    }
    if provider_id == "hermes" && source_path.starts_with("sqlite:") {
        return hermes::load_messages_sqlite(source_path);
    }

    let path = Path::new(source_path);
    match provider_id {
        "codex" => codex::load_messages(path),
        "claude" => claude::load_messages(path),
        "opencode" => opencode::load_messages(path),
        "openclaw" => openclaw::load_messages(path),
        "gemini" => gemini::load_messages(path),
        "hermes" => hermes::load_messages(path),
        _ => Err(format!("Unsupported provider: {provider_id}")),
    }
}

pub fn delete_session(
    provider_id: &str,
    session_id: &str,
    source_path: &str,
) -> Result<bool, String> {
    // SQLite sessions bypass the file-based deletion path
    if provider_id == "opencode" && source_path.starts_with("sqlite:") {
        return opencode::delete_session_sqlite(session_id, source_path);
    }
    if provider_id == "hermes" && source_path.starts_with("sqlite:") {
        return hermes::delete_session_sqlite(session_id, source_path);
    }

    let root = provider_root(provider_id)?;
    delete_session_with_root(provider_id, session_id, Path::new(source_path), &root)
}

pub fn delete_sessions(requests: &[DeleteSessionRequest]) -> Vec<DeleteSessionOutcome> {
    collect_delete_session_outcomes(requests, |request| {
        delete_session(
            &request.provider_id,
            &request.session_id,
            &request.source_path,
        )
    })
}

fn delete_session_with_root(
    provider_id: &str,
    session_id: &str,
    source_path: &Path,
    root: &Path,
) -> Result<bool, String> {
    let validated_root = canonicalize_existing_path(root, "session root")?;
    let validated_source = canonicalize_existing_path(source_path, "session source")?;

    if !validated_source.starts_with(&validated_root) {
        return Err(format!(
            "Session source path is outside provider root: {}",
            source_path.display()
        ));
    }

    match provider_id {
        "codex" => codex::delete_session(&validated_root, &validated_source, session_id),
        "claude" => claude::delete_session(&validated_root, &validated_source, session_id),
        "opencode" => opencode::delete_session(&validated_root, &validated_source, session_id),
        "openclaw" => openclaw::delete_session(&validated_root, &validated_source, session_id),
        "gemini" => gemini::delete_session(&validated_root, &validated_source, session_id),
        "hermes" => hermes::delete_session(&validated_root, &validated_source, session_id),
        _ => Err(format!("Unsupported provider: {provider_id}")),
    }
}

fn provider_root(provider_id: &str) -> Result<PathBuf, String> {
    let root = match provider_id {
        "codex" => crate::codex_config::get_codex_config_dir().join("sessions"),
        "claude" => crate::config::get_claude_config_dir().join("projects"),
        "opencode" => opencode::get_opencode_data_dir(),
        "openclaw" => crate::openclaw_config::get_openclaw_dir().join("agents"),
        "gemini" => crate::gemini_config::get_gemini_dir().join("tmp"),
        "hermes" => crate::hermes_config::get_hermes_dir().join("sessions"),
        _ => return Err(format!("Unsupported provider: {provider_id}")),
    };

    Ok(root)
}

fn canonicalize_existing_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("{label} not found: {}", path.display()));
    }

    path.canonicalize()
        .map_err(|e| format!("Failed to resolve {label} {}: {e}", path.display()))
}

fn collect_delete_session_outcomes<F>(
    requests: &[DeleteSessionRequest],
    mut deleter: F,
) -> Vec<DeleteSessionOutcome>
where
    F: FnMut(&DeleteSessionRequest) -> Result<bool, String>,
{
    requests
        .iter()
        .map(|request| match deleter(request) {
            Ok(true) => DeleteSessionOutcome {
                provider_id: request.provider_id.clone(),
                session_id: request.session_id.clone(),
                source_path: request.source_path.clone(),
                success: true,
                error: None,
            },
            Ok(false) => DeleteSessionOutcome {
                provider_id: request.provider_id.clone(),
                session_id: request.session_id.clone(),
                source_path: request.source_path.clone(),
                success: false,
                error: Some("Session was not deleted".to_string()),
            },
            Err(error) => DeleteSessionOutcome {
                provider_id: request.provider_id.clone(),
                session_id: request.session_id.clone(),
                source_path: request.source_path.clone(),
                success: false,
                error: Some(error),
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_source_path_outside_provider_root() {
        let root = tempdir().expect("tempdir");
        let outside = tempdir().expect("tempdir");
        let source = outside.path().join("session.jsonl");
        std::fs::write(&source, "{}").expect("write source");

        let err = delete_session_with_root("codex", "session-1", &source, root.path())
            .expect_err("expected outside-root path to be rejected");

        assert!(err.contains("outside provider root"));
    }

    #[test]
    fn rejects_missing_source_path() {
        let root = tempdir().expect("tempdir");
        let missing = root.path().join("missing.jsonl");

        let err = delete_session_with_root("codex", "session-1", &missing, root.path())
            .expect_err("expected missing source path to fail");

        assert!(err.contains("session source not found"));
    }

    #[test]
    fn batch_delete_collects_successes_and_failures_in_order() {
        let requests = vec![
            DeleteSessionRequest {
                provider_id: "codex".to_string(),
                session_id: "s1".to_string(),
                source_path: "/tmp/s1".to_string(),
            },
            DeleteSessionRequest {
                provider_id: "claude".to_string(),
                session_id: "s2".to_string(),
                source_path: "/tmp/s2".to_string(),
            },
            DeleteSessionRequest {
                provider_id: "gemini".to_string(),
                session_id: "s3".to_string(),
                source_path: "/tmp/s3".to_string(),
            },
        ];

        let outcomes = collect_delete_session_outcomes(&requests, |request| {
            match request.session_id.as_str() {
                "s1" => Ok(true),
                "s2" => Err("boom".to_string()),
                _ => Ok(false),
            }
        });

        assert_eq!(outcomes.len(), 3);
        assert!(outcomes[0].success);
        assert_eq!(outcomes[0].error, None);
        assert!(!outcomes[1].success);
        assert_eq!(outcomes[1].error.as_deref(), Some("boom"));
        assert!(!outcomes[2].success);
        assert_eq!(
            outcomes[2].error.as_deref(),
            Some("Session was not deleted")
        );
    }

    #[test]
    fn sanitize_detected_title_candidate_skips_injected_environment_blocks() {
        assert_eq!(
            sanitize_detected_title_candidate(
                "<environment_context>\n<cwd>D:\\Solution\\cc-switch</cwd>\n</environment_context>"
            ),
            None
        );
        assert_eq!(sanitize_detected_title_candidate("# AGENTS.md instructions"), None);
        assert_eq!(
            sanitize_detected_title_candidate("How do I deploy this project?"),
            Some("How do I deploy this project?".to_string())
        );
    }

    #[test]
    fn export_markdown_contains_session_metadata_and_messages() {
        let session = SessionMeta {
            provider_id: "codex".to_string(),
            session_id: "session-123".to_string(),
            title: Some("Test Session".to_string()),
            summary: None,
            project_dir: Some("D:\\Solution\\cc-switch".to_string()),
            created_at: Some(1_777_000_000),
            last_active_at: Some(1_777_000_600),
            source_path: Some("dummy".to_string()),
            resume_command: Some("codex resume session-123".to_string()),
        };
        let messages = vec![
            SessionMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
                ts: Some(1_777_000_001),
            },
            SessionMessage {
                role: "assistant".to_string(),
                content: "World".to_string(),
                ts: Some(1_777_000_002),
            },
        ];

        let markdown = export_session_markdown(&session, &messages);
        assert!(markdown.contains("# Test Session"));
        assert!(markdown.contains("- Provider: codex"));
        assert!(markdown.contains("- Session ID: session-123"));
        assert!(markdown.contains("- Project: D:\\Solution\\cc-switch"));
        assert!(markdown.contains("## User"));
        assert!(markdown.contains("Hello"));
        assert!(markdown.contains("## Assistant"));
        assert!(markdown.contains("World"));
    }
}
