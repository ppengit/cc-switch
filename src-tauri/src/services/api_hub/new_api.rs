//! new-api compatible adapter.
//!
//! Covers new-api, One API forks, one-hub, done-hub, Veloera, and similar
//! deployments. Unknown ApiHub site types intentionally fall back to this
//! adapter because these forks share most user/group/token endpoints.

use std::time::Duration;

use serde_json::{json, Value};

use crate::error::AppError;

use super::adapter::ApiHubAdapter;
use super::types::{is_masked_api_key, CreateTokenReq, GroupInfo, ModelInfo, SiteCtx, TokenInfo};

pub struct NewApiAdapter;

impl NewApiAdapter {
    pub fn new() -> Self {
        Self
    }

    fn build_headers(&self, ctx: &SiteCtx) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        let raw_token = ctx.access_token.trim();
        let token_without_scheme = strip_bearer_scheme(raw_token);
        let bearer_token = format!("Bearer {token_without_scheme}");
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&bearer_token) {
            headers.insert(reqwest::header::AUTHORIZATION, v);
        }
        if let Ok(v) = reqwest::header::HeaderValue::from_str(token_without_scheme) {
            headers.insert(reqwest::header::HeaderName::from_static("api-key"), v);
        }
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        if let Some(uid) = ctx.user_id {
            let uid_str = uid.to_string();
            for name in &[
                "New-API-User",
                "Veloera-User",
                "voapi-user",
                "User-id",
                "Rix-Api-User",
                "neo-api-user",
                "done-api-user",
            ] {
                if let (Ok(hname), Ok(hval)) = (
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                    reqwest::header::HeaderValue::from_str(&uid_str),
                ) {
                    headers.insert(hname, hval);
                }
            }
        }
        headers
    }

    fn endpoint(&self, ctx: &SiteCtx, path: &str) -> String {
        let base = ctx.site_url.trim_end_matches('/');
        format!("{base}{path}")
    }

    async fn get_json(&self, ctx: &SiteCtx, path: &str) -> Result<Value, AppError> {
        let client = crate::proxy::http_client::get();
        let url = self.endpoint(ctx, path);
        let resp = client
            .get(&url)
            .headers(self.build_headers(ctx))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| AppError::Config(format!("GET {path} failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::HttpStatus {
                status: status.as_u16(),
                body: format!("GET {path}: {}", truncate(&body, 240)),
            });
        }

        resp.json::<Value>()
            .await
            .map_err(|e| AppError::Config(format!("GET {path} response is not JSON: {e}")))
    }

    async fn send_json(
        &self,
        ctx: &SiteCtx,
        method: reqwest::Method,
        path: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        let client = crate::proxy::http_client::get();
        let url = self.endpoint(ctx, path);
        let resp = client
            .request(method.clone(), &url)
            .headers(self.build_headers(ctx))
            .timeout(Duration::from_secs(15))
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Config(format!("{method} {path} failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let resp_body = resp.text().await.unwrap_or_default();
            return Err(AppError::HttpStatus {
                status: status.as_u16(),
                body: format!("{method} {path}: {}", truncate(&resp_body, 240)),
            });
        }

        resp.json::<Value>().await.or_else(|_| Ok(Value::Null))
    }

    async fn fetch_token_key(
        &self,
        ctx: &SiteCtx,
        token_id: i64,
    ) -> Result<Option<String>, AppError> {
        let key_path = format!("/api/token/{token_id}/key");
        let post_result = self
            .send_json(ctx, reqwest::Method::POST, &key_path, Value::Null)
            .await;
        match post_result {
            Ok(value) => {
                if let Some(message) = explicit_failure_message(&value) {
                    log::debug!(
                        "[ApiHub][new-api] token key endpoint returned failure: site={}, token_id={}, message={message}",
                        ctx.site_id,
                        token_id
                    );
                } else if let Some(key) = extract_key_from_value(&value) {
                    return Ok(Some(key));
                }
            }
            Err(err) => {
                log::debug!(
                    "[ApiHub][new-api] token key endpoint unavailable, trying token detail: site={}, token_id={}, err={err}",
                    ctx.site_id,
                    token_id
                );
            }
        }

        let detail_path = format!("/api/token/{token_id}");
        let value = self.get_json(ctx, &detail_path).await?;
        if let Some(message) = explicit_failure_message(&value) {
            log::debug!(
                "[ApiHub][new-api] token detail endpoint returned failure: site={}, token_id={}, message={message}",
                ctx.site_id,
                token_id
            );
            return Ok(None);
        }
        Ok(extract_key_from_value(&value))
    }
}

fn strip_bearer_scheme(value: &str) -> &str {
    value
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
        .map(|_| value[7..].trim())
        .unwrap_or(value)
}

#[async_trait::async_trait]
impl ApiHubAdapter for NewApiAdapter {
    async fn list_groups(&self, ctx: &SiteCtx) -> Result<Vec<GroupInfo>, AppError> {
        let value = match self.get_json(ctx, "/api/user/self/groups").await {
            Ok(v) if explicit_failure_message(&v).is_none() => v,
            Ok(v) => {
                log::debug!(
                    "[ApiHub][new-api] /api/user/self/groups failed logically: {:?}",
                    explicit_failure_message(&v)
                );
                self.get_json(ctx, "/api/user/groups").await?
            }
            Err(e) => {
                log::debug!("[ApiHub][new-api] self/groups failed, falling back: {e}");
                self.get_json(ctx, "/api/user/groups").await?
            }
        };
        if let Some(message) = explicit_failure_message(&value) {
            return Err(AppError::Config(format!("list groups failed: {message}")));
        }
        Ok(parse_groups_response(&value))
    }

    async fn list_models(&self, ctx: &SiteCtx) -> Result<Vec<ModelInfo>, AppError> {
        match self.get_json(ctx, "/api/pricing").await {
            Ok(value) => {
                if explicit_failure_message(&value).is_none() {
                    let models = parse_pricing_models(&value);
                    if !models.is_empty() {
                        return Ok(models);
                    }
                } else {
                    log::debug!(
                        "[ApiHub][new-api] /api/pricing returned failure: {:?}",
                        explicit_failure_message(&value)
                    );
                }
            }
            Err(err) => {
                log::debug!("[ApiHub][new-api] /api/pricing failed, falling back: {err}");
            }
        }

        let value = self.get_json(ctx, "/api/user/models").await?;
        if let Some(message) = explicit_failure_message(&value) {
            return Err(AppError::Config(format!("list models failed: {message}")));
        }
        Ok(parse_user_models(&value))
    }

    async fn list_tokens(&self, ctx: &SiteCtx) -> Result<Vec<TokenInfo>, AppError> {
        let value = self.get_json(ctx, "/api/token/?page=1&size=200").await?;
        if let Some(message) = explicit_failure_message(&value) {
            return Err(AppError::Config(format!("list tokens failed: {message}")));
        }

        let mut tokens = Vec::new();
        for item in response_items(&value) {
            let id = item.get("id").and_then(value_to_i64).unwrap_or_default();
            if id == 0 {
                continue;
            }

            let listed_key = extract_key_from_value(&item);
            let fetched_key = match self.fetch_token_key(ctx, id).await {
                Ok(key) => key,
                Err(err) => {
                    log::debug!(
                        "[ApiHub][new-api] could not fetch plain token key; keeping listed key: site={}, token_id={}, err={err}",
                        ctx.site_id,
                        id
                    );
                    None
                }
            };
            let key = prefer_key(fetched_key, listed_key);

            tokens.push(TokenInfo {
                id,
                name: item
                    .get("name")
                    .and_then(value_to_string)
                    .unwrap_or_default(),
                group_name: parse_token_group_name(&item),
                key,
                status: item.get("status").and_then(parse_status),
                remain_quota: item.get("remain_quota").and_then(value_to_i64),
                expired_at: item
                    .get("expired_time")
                    .or_else(|| item.get("expired_at"))
                    .or_else(|| item.get("expires_at"))
                    .and_then(parse_timestamp),
            });
        }
        Ok(tokens)
    }

    async fn create_token(
        &self,
        ctx: &SiteCtx,
        req: CreateTokenReq,
    ) -> Result<TokenInfo, AppError> {
        let body = json!({
            "name": req.name,
            "group": req.group,
            "unlimited_quota": req.unlimited_quota,
            "expired_time": req.expired_time,
            "remain_quota": 0,
            "model_limits_enabled": false,
            "model_limits": "",
            "allow_ips": "",
            "remark": req.remark.clone().unwrap_or_default(),
        });
        let value = self
            .send_json(ctx, reqwest::Method::POST, "/api/token/", body)
            .await?;

        if let Some(message) = explicit_failure_message(&value) {
            return Err(AppError::Config(format!("create token failed: {message}")));
        }

        let tokens = self.list_tokens(ctx).await?;
        tokens
            .into_iter()
            .find(|t| token_matches_group(t, &req.name, &req.group))
            .ok_or_else(|| {
                AppError::Config(
                    "token was created but the matching record could not be found".to_string(),
                )
            })
    }

    async fn rename_token(
        &self,
        ctx: &SiteCtx,
        token_id: i64,
        new_name: &str,
        group: &str,
    ) -> Result<(), AppError> {
        let body = json!({
            "id": token_id,
            "name": new_name,
            "group": group,
        });
        let value = self
            .send_json(ctx, reqwest::Method::PUT, "/api/token/", body)
            .await?;
        if let Some(message) = explicit_failure_message(&value) {
            return Err(AppError::Config(format!("rename token failed: {message}")));
        }
        Ok(())
    }

    async fn delete_token(&self, ctx: &SiteCtx, token_id: i64) -> Result<(), AppError> {
        let client = crate::proxy::http_client::get();
        let url = self.endpoint(ctx, &format!("/api/token/{token_id}"));
        let resp = client
            .delete(&url)
            .headers(self.build_headers(ctx))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| AppError::Config(format!("DELETE token failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::HttpStatus {
                status: status.as_u16(),
                body: format!("DELETE token: {}", truncate(&body, 240)),
            });
        }
        Ok(())
    }
}

fn explicit_failure_message(value: &Value) -> Option<String> {
    if value.get("success").and_then(|v| v.as_bool()) == Some(false) {
        return Some(
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("request failed")
                .to_string(),
        );
    }
    if let Some(code) = value.get("code").and_then(value_to_i64) {
        if code != 0 {
            return Some(
                value
                    .get("message")
                    .or_else(|| value.get("error"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("request failed")
                    .to_string(),
            );
        }
    }
    None
}

fn parse_groups_response(value: &Value) -> Vec<GroupInfo> {
    let data = value.get("data").unwrap_or(value);
    let mut groups = Vec::new();
    if let Some(obj) = data.as_object() {
        for (fallback_name, info) in obj {
            let name = info
                .get("symbol")
                .or_else(|| info.get("name"))
                .or_else(|| info.get("group"))
                .and_then(value_to_string)
                .unwrap_or_else(|| fallback_name.clone());
            if name.trim().is_empty() {
                continue;
            }
            groups.push(GroupInfo {
                name,
                ratio: info
                    .get("ratio")
                    .or_else(|| info.get("rate"))
                    .or_else(|| info.get("rate_multiplier"))
                    .and_then(value_to_f64),
                description: info
                    .get("desc")
                    .or_else(|| info.get("description"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
            });
        }
    } else if let Some(arr) = data.as_array() {
        for item in arr {
            if let Some(name) = item.as_str() {
                groups.push(GroupInfo {
                    name: name.to_string(),
                    ratio: None,
                    description: None,
                });
            } else if let Some(obj) = item.as_object() {
                let name = obj
                    .get("name")
                    .or_else(|| obj.get("symbol"))
                    .or_else(|| obj.get("group"))
                    .and_then(value_to_string)
                    .unwrap_or_default();
                if !name.is_empty() {
                    groups.push(GroupInfo {
                        name,
                        ratio: obj
                            .get("ratio")
                            .or_else(|| obj.get("rate"))
                            .or_else(|| obj.get("rate_multiplier"))
                            .and_then(value_to_f64),
                        description: obj
                            .get("desc")
                            .or_else(|| obj.get("description"))
                            .and_then(|v| v.as_str())
                            .map(String::from),
                    });
                }
            }
        }
    }
    groups
}

fn parse_pricing_models(value: &Value) -> Vec<ModelInfo> {
    let data = value.get("data").unwrap_or(value);
    let mut out = Vec::new();
    if let Some(list) = data.as_array() {
        for item in list {
            let Some(name) = item
                .get("model_name")
                .or_else(|| item.get("model"))
                .or_else(|| item.get("name"))
                .or_else(|| item.get("id"))
                .and_then(value_to_string)
            else {
                continue;
            };
            out.push(ModelInfo {
                name,
                enable_groups: parse_string_list(
                    item.get("enable_groups")
                        .or_else(|| item.get("groups"))
                        .or_else(|| item.get("group")),
                ),
            });
        }
    } else if let Some(obj) = data.as_object() {
        let model_map = data
            .get("models")
            .and_then(|v| v.as_object())
            .unwrap_or(obj);
        for (name, item) in model_map {
            if name == "success" || name == "message" || name == "data" {
                continue;
            }
            let model_name = item
                .get("model_name")
                .or_else(|| item.get("model"))
                .or_else(|| item.get("name"))
                .and_then(value_to_string)
                .unwrap_or_else(|| name.clone());
            if model_name.trim().is_empty() {
                continue;
            }
            out.push(ModelInfo {
                name: model_name,
                enable_groups: parse_string_list(
                    item.get("enable_groups")
                        .or_else(|| item.get("groups"))
                        .or_else(|| item.get("group")),
                ),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name && a.enable_groups == b.enable_groups);
    out
}

fn parse_user_models(value: &Value) -> Vec<ModelInfo> {
    response_items(value)
        .into_iter()
        .filter_map(|item| {
            let name = item.as_str().map(String::from).or_else(|| {
                item.get("id")
                    .or_else(|| item.get("model"))
                    .or_else(|| item.get("name"))
                    .or_else(|| item.get("model_name"))
                    .and_then(value_to_string)
            })?;
            Some(ModelInfo {
                name,
                enable_groups: Vec::new(),
            })
        })
        .collect()
}

fn response_items(value: &Value) -> Vec<Value> {
    find_items_array(value).cloned().unwrap_or_else(|| {
        let data = value.get("data").unwrap_or(value);
        if data.get("id").is_some() {
            vec![data.clone()]
        } else {
            Vec::new()
        }
    })
}

fn find_items_array(value: &Value) -> Option<&Vec<Value>> {
    if let Some(arr) = value.as_array() {
        return Some(arr);
    }
    let obj = value.as_object()?;
    for key in ["data", "items", "list", "rows", "records", "tokens"] {
        let Some(next) = obj.get(key) else {
            continue;
        };
        if let Some(arr) = next.as_array() {
            return Some(arr);
        }
        if let Some(arr) = find_items_array(next) {
            return Some(arr);
        }
    }
    None
}

fn extract_key_from_value(value: &Value) -> Option<String> {
    for key in ["key", "api_key", "token", "custom_key"] {
        if let Some(value) = value.get(key).and_then(|v| v.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    for key in ["data", "item", "token"] {
        if let Some(nested) = value.get(key) {
            if let Some(found) = extract_key_from_value(nested) {
                return Some(found);
            }
        }
    }
    None
}

fn prefer_key(fetched: Option<String>, listed: Option<String>) -> Option<String> {
    match (fetched, listed) {
        (Some(fetched), Some(listed)) => {
            if !is_masked_api_key(&fetched) || is_masked_api_key(&listed) {
                Some(fetched)
            } else {
                Some(listed)
            }
        }
        (Some(fetched), None) => Some(fetched),
        (None, listed) => listed,
    }
}

fn parse_token_group_name(item: &Value) -> Option<String> {
    item.get("group")
        .and_then(|group| {
            group.as_str().map(String::from).or_else(|| {
                group
                    .get("symbol")
                    .or_else(|| group.get("name"))
                    .or_else(|| group.get("group_name"))
                    .and_then(value_to_string)
            })
        })
        .or_else(|| item.get("group_name").and_then(value_to_string))
        .filter(|value| !value.trim().is_empty())
}

fn token_matches_group(token: &TokenInfo, name: &str, group: &str) -> bool {
    token.name.trim() == name.trim()
        && token.group_name.as_deref().map(str::trim) == Some(group.trim())
}

fn parse_string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(value_to_string)
            .filter(|value| !value.trim().is_empty())
            .collect(),
        Some(Value::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(String::from)
            .collect(),
        Some(value) => value_to_string(value).into_iter().collect(),
        None => Vec::new(),
    }
}

fn parse_status(value: &Value) -> Option<i32> {
    value.as_i64().map(|v| v as i32).or_else(|| {
        let status = value.as_str()?.to_ascii_lowercase();
        match status.as_str() {
            "active" | "enabled" => Some(1),
            "inactive" | "disabled" => Some(0),
            "quota_exhausted" | "exhausted" => Some(2),
            "expired" => Some(3),
            _ => None,
        }
    })
}

fn parse_timestamp(value: &Value) -> Option<i64> {
    if let Some(raw) = value_to_i64(value) {
        return Some(raw);
    }
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|dt| dt.timestamp())
        .ok()
}

fn value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(String::from)
        .or_else(|| value_to_i64(value).map(|v| v.to_string()))
        .filter(|value| !value.trim().is_empty())
}

fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|v| i64::try_from(v).ok()))
        .or_else(|| value.as_str()?.parse::<i64>().ok())
}

fn value_to_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
}

fn truncate(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (index, ch) in s.chars().enumerate() {
        if index >= max {
            out.push_str("...");
            return out;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_one_hub_paginated_token_list() {
        let value = json!({
            "success": true,
            "message": "",
            "data": {
                "data": [{
                    "id": 42,
                    "key": "sk-one-hub",
                    "name": "vip",
                    "group": "vip",
                    "status": 1,
                    "expired_time": -1,
                    "remain_quota": 0
                }],
                "page": 1,
                "size": 10,
                "total_count": 1
            }
        });

        let items = response_items(&value);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("id").and_then(value_to_i64), Some(42));
        assert_eq!(
            extract_key_from_value(&items[0]).as_deref(),
            Some("sk-one-hub")
        );
    }

    #[test]
    fn parses_token_detail_key_fallback_shape() {
        let value = json!({
            "success": true,
            "data": {
                "id": 7,
                "key": "sk-detail"
            }
        });

        assert_eq!(extract_key_from_value(&value).as_deref(), Some("sk-detail"));
    }

    #[test]
    fn keeps_listed_plain_key_when_detail_key_is_masked() {
        let key = prefer_key(Some("sk-****".to_string()), Some("sk-plain".to_string()));

        assert_eq!(key.as_deref(), Some("sk-plain"));
    }

    #[test]
    fn parses_pricing_model_field_used_by_one_hub() {
        let value = json!({
            "success": true,
            "data": [{
                "model": "gpt-5",
                "enable_groups": ["default"]
            }]
        });

        let models = parse_pricing_models(&value);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "gpt-5");
        assert_eq!(models[0].enable_groups, vec!["default"]);
    }
}
