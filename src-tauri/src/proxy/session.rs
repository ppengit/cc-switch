use axum::http::HeaderMap;
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ClientFormat {
    Claude,
    Codex,
    OpenAI,
    Gemini,
    GeminiCli,
    Unknown,
}

#[allow(dead_code)]
impl ClientFormat {
    pub fn from_path(path: &str) -> Self {
        if path.contains("/v1/messages") {
            ClientFormat::Claude
        } else if path.contains("/v1/responses") {
            ClientFormat::Codex
        } else if path.contains("/v1/chat/completions") {
            ClientFormat::OpenAI
        } else if path.contains("/v1internal/") && path.contains("generateContent") {
            ClientFormat::GeminiCli
        } else if ((path.contains("/v1beta/") || path.contains("/v1/"))
            && path.contains("generateContent"))
            || path.contains("generateContent")
        {
            ClientFormat::Gemini
        } else {
            ClientFormat::Unknown
        }
    }

    pub fn from_body(body: &serde_json::Value) -> Self {
        if body.get("messages").is_some()
            && body.get("model").is_some()
            && body.get("response_format").is_none()
            && body.get("contents").is_none()
        {
            if body.get("max_tokens").is_some() {
                return ClientFormat::Claude;
            }
            return ClientFormat::OpenAI;
        }

        if body.get("input").is_some() {
            return ClientFormat::Codex;
        }

        if body.get("contents").is_some() {
            return ClientFormat::Gemini;
        }

        ClientFormat::Unknown
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ClientFormat::Claude => "claude",
            ClientFormat::Codex => "codex",
            ClientFormat::OpenAI => "openai",
            ClientFormat::Gemini => "gemini",
            ClientFormat::GeminiCli => "gemini_cli",
            ClientFormat::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for ClientFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ProxySession {
    pub session_id: String,
    pub start_time: Instant,
    pub method: String,
    pub request_url: String,
    pub user_agent: Option<String>,
    pub client_format: ClientFormat,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub is_streaming: bool,
}

#[allow(dead_code)]
impl ProxySession {
    pub fn from_request(
        method: &str,
        request_url: &str,
        user_agent: Option<&str>,
        body: Option<&serde_json::Value>,
    ) -> Self {
        let mut client_format = ClientFormat::from_path(request_url);
        if client_format == ClientFormat::Unknown {
            if let Some(body) = body {
                client_format = ClientFormat::from_body(body);
            }
        }

        let is_streaming = body
            .and_then(|b| b.get("stream"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let model = body
            .and_then(|b| b.get("model"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Self {
            session_id: Uuid::new_v4().to_string(),
            start_time: Instant::now(),
            method: method.to_string(),
            request_url: request_url.to_string(),
            user_agent: user_agent.map(|s| s.to_string()),
            client_format,
            provider_id: None,
            model,
            is_streaming,
        }
    }

    pub fn with_provider(mut self, provider_id: &str) -> Self {
        self.provider_id = Some(provider_id.to_string());
        self
    }

    pub fn latency_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionIdSource {
    MetadataUserId,
    MetadataSessionId,
    Header,
    PreviousResponseId,
    Generated,
}

#[derive(Debug, Clone)]
pub struct SessionIdResult {
    pub session_id: String,
    pub source: SessionIdSource,
    pub client_provided: bool,
}

pub fn extract_session_id(
    headers: &HeaderMap,
    body: &serde_json::Value,
    client_format: &str,
) -> SessionIdResult {
    if let Some(mut result) = extract_session_from_headers(headers) {
        if client_format == "codex" || client_format == "openai" {
            result.session_id = normalize_codex_session_id(&result.session_id);
        }
        return result;
    }

    if client_format == "codex" || client_format == "openai" {
        if let Some(result) = extract_codex_session(body) {
            return result;
        }
    }

    if let Some(result) = extract_from_metadata(body) {
        return result;
    }

    generate_new_session_id()
}

fn extract_session_from_headers(headers: &HeaderMap) -> Option<SessionIdResult> {
    for header_name in &[
        "ccswitch-session-id",
        "x-ccswitch-session-id",
        "ccswitch_session_id",
        "session_id",
        "x-session-id",
    ] {
        if let Some(value) = headers.get(*header_name) {
            if let Ok(session_id) = value.to_str() {
                let trimmed = session_id.trim();
                if !trimmed.is_empty() {
                    return Some(SessionIdResult {
                        session_id: trimmed.to_string(),
                        source: SessionIdSource::Header,
                        client_provided: true,
                    });
                }
            }
        }
    }
    None
}

fn extract_codex_session(body: &serde_json::Value) -> Option<SessionIdResult> {
    if let Some(metadata) = body.get("metadata") {
        // Prefer user_id-derived session for Codex when available.
        // This avoids collapsing different conversations that may share metadata.session_id.
        if let Some(user_id) = metadata.get("user_id").and_then(|v| v.as_str()) {
            if let Some(session_id) = parse_session_from_user_id(user_id) {
                let normalized = normalize_codex_session_id(&session_id);
                if !normalized.is_empty() {
                    return Some(SessionIdResult {
                        session_id: normalized,
                        source: SessionIdSource::MetadataUserId,
                        client_provided: true,
                    });
                }
            }
        }

        if let Some(session_id) = metadata.get("session_id").and_then(|v| v.as_str()) {
            let normalized = normalize_codex_session_id(session_id);
            if !normalized.is_empty() {
                return Some(SessionIdResult {
                    session_id: normalized,
                    source: SessionIdSource::MetadataSessionId,
                    client_provided: true,
                });
            }
        }
    }

    if let Some(prev_id) = body.get("previous_response_id").and_then(|v| v.as_str()) {
        let normalized = normalize_codex_session_id(prev_id);
        if !normalized.is_empty() {
            return Some(SessionIdResult {
                session_id: normalized,
                source: SessionIdSource::PreviousResponseId,
                client_provided: true,
            });
        }
    }

    None
}

fn normalize_codex_session_id(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(stripped) = trimmed.strip_prefix("codex_") {
        if !stripped.is_empty() {
            return stripped.to_string();
        }
    }
    trimmed.to_string()
}

fn extract_from_metadata(body: &serde_json::Value) -> Option<SessionIdResult> {
    let metadata = body.get("metadata")?;

    if let Some(user_id) = metadata.get("user_id").and_then(|v| v.as_str()) {
        if let Some(session_id) = parse_session_from_user_id(user_id) {
            return Some(SessionIdResult {
                session_id,
                source: SessionIdSource::MetadataUserId,
                client_provided: true,
            });
        }
    }

    if let Some(session_id) = metadata.get("session_id").and_then(|v| v.as_str()) {
        if !session_id.is_empty() {
            return Some(SessionIdResult {
                session_id: session_id.to_string(),
                source: SessionIdSource::MetadataSessionId,
                client_provided: true,
            });
        }
    }

    None
}

fn parse_session_from_user_id(user_id: &str) -> Option<String> {
    if let Some(pos) = user_id.find("_session_") {
        let session_id = &user_id[pos + 9..];
        if !session_id.is_empty() {
            return Some(session_id.to_string());
        }
    }
    None
}

fn generate_new_session_id() -> SessionIdResult {
    SessionIdResult {
        session_id: Uuid::new_v4().to_string(),
        source: SessionIdSource::Generated,
        client_provided: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    #[test]
    fn test_client_format_from_path_claude() {
        assert_eq!(ClientFormat::from_path("/v1/messages"), ClientFormat::Claude);
        assert_eq!(
            ClientFormat::from_path("/api/v1/messages"),
            ClientFormat::Claude
        );
    }

    #[test]
    fn test_client_format_from_path_codex() {
        assert_eq!(ClientFormat::from_path("/v1/responses"), ClientFormat::Codex);
    }

    #[test]
    fn test_client_format_from_path_openai() {
        assert_eq!(
            ClientFormat::from_path("/v1/chat/completions"),
            ClientFormat::OpenAI
        );
    }

    #[test]
    fn test_client_format_from_path_gemini() {
        assert_eq!(
            ClientFormat::from_path("/v1beta/models/gemini-pro:generateContent"),
            ClientFormat::Gemini
        );
    }

    #[test]
    fn test_client_format_from_path_gemini_cli() {
        assert_eq!(
            ClientFormat::from_path("/v1internal/models/gemini-pro:generateContent"),
            ClientFormat::GeminiCli
        );
    }

    #[test]
    fn test_client_format_from_body_claude() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 1024
        });
        assert_eq!(ClientFormat::from_body(&body), ClientFormat::Claude);
    }

    #[test]
    fn test_client_format_from_body_codex() {
        let body = json!({
            "input": "Write a function"
        });
        assert_eq!(ClientFormat::from_body(&body), ClientFormat::Codex);
    }

    #[test]
    fn test_client_format_from_body_gemini() {
        let body = json!({
            "contents": [{"parts": [{"text": "Hello"}]}]
        });
        assert_eq!(ClientFormat::from_body(&body), ClientFormat::Gemini);
    }

    #[test]
    fn test_session_id_uniqueness() {
        let session1 = ProxySession::from_request("POST", "/v1/messages", None, None);
        let session2 = ProxySession::from_request("POST", "/v1/messages", None, None);
        assert_ne!(session1.session_id, session2.session_id);
    }

    #[test]
    fn test_session_from_request() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 1024,
            "stream": true
        });

        let session =
            ProxySession::from_request("POST", "/v1/messages", Some("Mozilla/5.0"), Some(&body));

        assert_eq!(session.method, "POST");
        assert_eq!(session.request_url, "/v1/messages");
        assert_eq!(session.user_agent, Some("Mozilla/5.0".to_string()));
        assert_eq!(session.client_format, ClientFormat::Claude);
        assert_eq!(session.model, Some("claude-3-5-sonnet".to_string()));
        assert!(session.is_streaming);
    }

    #[test]
    fn test_session_with_provider() {
        let session =
            ProxySession::from_request("POST", "/v1/messages", None, None).with_provider("provider-123");

        assert_eq!(session.provider_id, Some("provider-123".to_string()));
    }

    #[test]
    fn test_client_format_as_str() {
        assert_eq!(ClientFormat::Claude.as_str(), "claude");
        assert_eq!(ClientFormat::Codex.as_str(), "codex");
        assert_eq!(ClientFormat::OpenAI.as_str(), "openai");
        assert_eq!(ClientFormat::Gemini.as_str(), "gemini");
        assert_eq!(ClientFormat::GeminiCli.as_str(), "gemini_cli");
        assert_eq!(ClientFormat::Unknown.as_str(), "unknown");
    }

    #[test]
    fn test_extract_session_from_claude_metadata_user_id() {
        let headers = HeaderMap::new();
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [{"role": "user", "content": "Hello"}],
            "metadata": {
                "user_id": "user_john_doe_session_abc123def456"
            }
        });

        let result = extract_session_id(&headers, &body, "claude");

        assert_eq!(result.session_id, "abc123def456");
        assert_eq!(result.source, SessionIdSource::MetadataUserId);
        assert!(result.client_provided);
    }

    #[test]
    fn test_extract_session_from_claude_metadata_session_id() {
        let headers = HeaderMap::new();
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [{"role": "user", "content": "Hello"}],
            "metadata": {
                "session_id": "my-session-123"
            }
        });

        let result = extract_session_id(&headers, &body, "claude");

        assert_eq!(result.session_id, "my-session-123");
        assert_eq!(result.source, SessionIdSource::MetadataSessionId);
        assert!(result.client_provided);
    }

    #[test]
    fn test_extract_session_from_codex_previous_response_id() {
        let headers = HeaderMap::new();
        let body = json!({
            "input": "Write a function",
            "previous_response_id": "resp_abc123def456789"
        });

        let result = extract_session_id(&headers, &body, "codex");

        assert_eq!(result.session_id, "resp_abc123def456789");
        assert_eq!(result.source, SessionIdSource::PreviousResponseId);
        assert!(result.client_provided);
    }

    #[test]
    fn test_extract_session_from_codex_prefers_metadata_user_id_over_metadata_session_id() {
        let headers = HeaderMap::new();
        let body = json!({
            "input": "Write a function",
            "metadata": {
                "session_id": "project-level-id",
                "user_id": "u_demo_session_chat-001"
            }
        });

        let result = extract_session_id(&headers, &body, "codex");

        assert_eq!(result.session_id, "chat-001");
        assert_eq!(result.source, SessionIdSource::MetadataUserId);
        assert!(result.client_provided);
    }

    #[test]
    fn test_extract_session_from_common_header_for_all_apps() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-ccswitch-session-id",
            HeaderValue::from_static("terminal-session-001"),
        );
        let body = json!({
            "contents": [{"parts": [{"text": "Hello"}]}]
        });

        let result = extract_session_id(&headers, &body, "gemini");

        assert_eq!(result.session_id, "terminal-session-001");
        assert_eq!(result.source, SessionIdSource::Header);
        assert!(result.client_provided);
    }

    #[test]
    fn test_extract_session_from_header_normalizes_legacy_codex_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("codex_legacy-001"));
        let body = json!({
            "input": "hello"
        });

        let result = extract_session_id(&headers, &body, "codex");

        assert_eq!(result.session_id, "legacy-001");
        assert_eq!(result.source, SessionIdSource::Header);
        assert!(result.client_provided);
    }

    #[test]
    fn test_extract_session_generates_new_when_not_found() {
        let headers = HeaderMap::new();
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [{"role": "user", "content": "Hello"}]
        });

        let result = extract_session_id(&headers, &body, "claude");

        assert!(!result.session_id.is_empty());
        assert_eq!(result.source, SessionIdSource::Generated);
        assert!(!result.client_provided);
    }

    #[test]
    fn test_parse_session_from_user_id() {
        assert_eq!(
            parse_session_from_user_id("user_john_session_abc123"),
            Some("abc123".to_string())
        );
        assert_eq!(
            parse_session_from_user_id("my_app_session_xyz789"),
            Some("xyz789".to_string())
        );
        assert_eq!(
            parse_session_from_user_id("no_session_marker"),
            Some("marker".to_string())
        );
        assert_eq!(parse_session_from_user_id("user_john_abc123"), None);
        assert_eq!(parse_session_from_user_id("_session_"), None);
    }
}
