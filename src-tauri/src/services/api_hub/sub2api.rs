//! Sub2Api 协议 Adapter

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::AppError;

use super::adapter::ApiHubAdapter;
use super::types::{CreateTokenReq, GroupInfo, ModelInfo, SiteCtx, TokenInfo};

pub struct Sub2ApiAdapter;

impl Sub2ApiAdapter {
    pub fn new() -> Self {
        Self
    }

    fn endpoint(&self, ctx: &SiteCtx, path: &str) -> String {
        let base = ctx.site_url.trim_end_matches('/');
        format!("{base}{path}")
    }

    fn build_headers(&self, ctx: &SiteCtx) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        let auth = format!("Bearer {}", ctx.access_token);
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&auth) {
            headers.insert(reqwest::header::AUTHORIZATION, v);
        }
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        headers
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
            .map_err(|e| AppError::HttpStatus {
                status: 0,
                body: format!("GET {path} 失败: {e}"),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::HttpStatus {
                status: status.as_u16(),
                body: truncate(&body, 240),
            });
        }

        let value = resp
            .json::<Value>()
            .await
            .map_err(|e| AppError::Config(format!("GET {path} 响应非 JSON: {e}")))?;
        ensure_sub2api_success(&value)?;
        Ok(value)
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
            .map_err(|e| AppError::HttpStatus {
                status: 0,
                body: format!("{method} {path} 失败: {e}"),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::HttpStatus {
                status: status.as_u16(),
                body: truncate(&text, 240),
            });
        }

        let value = resp.json::<Value>().await.unwrap_or(Value::Null);
        ensure_sub2api_success(&value)?;
        Ok(value)
    }

    async fn resolve_group_id(&self, ctx: &SiteCtx, group_name: &str) -> Result<i64, AppError> {
        let value = self.get_json(ctx, "/api/v1/groups/available").await?;
        let groups = parse_group_name_id_map(&value);
        if let Some(group_id) = groups.get(group_name) {
            return Ok(*group_id);
        }

        let lowered = group_name.to_ascii_lowercase();
        groups
            .iter()
            .find_map(|(name, id)| {
                if name.to_ascii_lowercase() == lowered {
                    Some(*id)
                } else {
                    None
                }
            })
            .ok_or_else(|| AppError::Config(format!("Sub2api 分组不存在或未返回 id: {group_name}")))
    }
}

#[async_trait::async_trait]
impl ApiHubAdapter for Sub2ApiAdapter {
    async fn list_groups(&self, ctx: &SiteCtx) -> Result<Vec<GroupInfo>, AppError> {
        let value = self.get_json(ctx, "/api/v1/groups/available").await?;
        Ok(parse_available_groups(&value))
    }

    async fn list_models(&self, ctx: &SiteCtx) -> Result<Vec<ModelInfo>, AppError> {
        let value = self.get_json(ctx, "/api/v1/channels/available").await?;
        Ok(parse_available_channels(&value))
    }

    async fn list_tokens(&self, ctx: &SiteCtx) -> Result<Vec<TokenInfo>, AppError> {
        let groups = self
            .get_json(ctx, "/api/v1/groups/available")
            .await
            .map(|value| parse_group_id_name_map(&value))
            .unwrap_or_default();
        let value = self
            .get_json(ctx, "/api/v1/keys?page=1&page_size=200")
            .await?;
        Ok(parse_keys_response(&value, &groups))
    }

    async fn create_token(
        &self,
        ctx: &SiteCtx,
        req: CreateTokenReq,
    ) -> Result<TokenInfo, AppError> {
        let group_id = self.resolve_group_id(ctx, &req.group).await?;
        let body = build_create_key_body(&req, group_id);
        let value = self
            .send_json(ctx, reqwest::Method::POST, "/api/v1/keys", body)
            .await?;
        let groups = [(group_id, req.group.clone())].into_iter().collect();
        if let Some(token) = parse_keys_response(&value, &groups).into_iter().next() {
            return Ok(token);
        }
        self.list_tokens(ctx)
            .await?
            .into_iter()
            .find(|token| token.name == req.name && token.group_name.as_deref() == Some(&req.group))
            .ok_or_else(|| AppError::Config("创建 key 成功但回查未找到对应记录".to_string()))
    }

    async fn rename_token(
        &self,
        ctx: &SiteCtx,
        token_id: i64,
        new_name: &str,
        group: &str,
    ) -> Result<(), AppError> {
        let group_id = self.resolve_group_id(ctx, group).await?;
        let path = format!("/api/v1/keys/{token_id}");
        let body = build_update_key_body(new_name, group_id);
        self.send_json(ctx, reqwest::Method::PUT, &path, body)
            .await?;
        Ok(())
    }

    async fn delete_token(&self, ctx: &SiteCtx, token_id: i64) -> Result<(), AppError> {
        let path = format!("/api/v1/keys/{token_id}");
        self.send_json(ctx, reqwest::Method::DELETE, &path, Value::Null)
            .await?;
        Ok(())
    }
}

fn ensure_sub2api_success(value: &Value) -> Result<(), AppError> {
    if let Some(code) = value.get("code").and_then(value_to_i64) {
        if code != 0 {
            let message = value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("Sub2api 接口返回失败");
            return Err(AppError::Config(format!("Sub2api 接口失败: {message}")));
        }
    }
    if value.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let message = value
            .get("message")
            .or_else(|| value.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("Sub2api 接口返回失败");
        return Err(AppError::Config(format!("Sub2api 接口失败: {message}")));
    }
    Ok(())
}

fn parse_available_groups(value: &Value) -> Vec<GroupInfo> {
    parse_group_entries(value)
        .into_iter()
        .map(|(_, name, ratio, description)| GroupInfo {
            name,
            ratio,
            description,
        })
        .collect()
}

fn parse_group_name_id_map(value: &Value) -> HashMap<String, i64> {
    parse_group_entries(value)
        .into_iter()
        .filter_map(|(id, name, _, _)| id.map(|id| (name, id)))
        .collect()
}

fn parse_group_id_name_map(value: &Value) -> HashMap<i64, String> {
    parse_group_entries(value)
        .into_iter()
        .filter_map(|(id, name, _, _)| id.map(|id| (id, name)))
        .collect()
}

type ParsedGroupEntry = (Option<i64>, String, Option<f64>, Option<String>);

fn parse_group_entries(value: &Value) -> Vec<ParsedGroupEntry> {
    let data = value.get("data").unwrap_or(value);
    let Some(arr) = data.as_array() else {
        return Vec::new();
    };

    arr.iter()
        .filter_map(|item| {
            if let Some(name) = item.as_str() {
                return Some((None, name.to_string(), None, None));
            }
            let obj = item.as_object()?;
            let name = obj
                .get("name")
                .or_else(|| obj.get("group_name"))
                .or_else(|| obj.get("title"))
                .and_then(value_to_string)?;
            let ratio = obj
                .get("rate_multiplier")
                .or_else(|| obj.get("rate"))
                .or_else(|| obj.get("ratio"))
                .and_then(value_to_f64);
            let description = obj
                .get("description")
                .or_else(|| obj.get("desc"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let id = obj
                .get("id")
                .or_else(|| obj.get("group_id"))
                .and_then(value_to_i64);
            Some((id, name, ratio, description))
        })
        .collect()
}

fn parse_available_channels(value: &Value) -> Vec<ModelInfo> {
    let data = value.get("data").unwrap_or(value);
    let mut models: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    if let Some(arr) = data.as_array() {
        for item in arr {
            if let Some(name) = item.as_str() {
                models.entry(name.to_string()).or_default();
                continue;
            }

            let Some(obj) = item.as_object() else {
                continue;
            };

            if let Some(platforms) = obj.get("platforms").and_then(|v| v.as_array()) {
                for platform in platforms {
                    let groups = parse_groups_from_value(platform.get("groups"));
                    collect_models_from_object(platform, &groups, &mut models);
                }
                continue;
            }

            let groups = parse_groups_from_value(obj.get("groups"));
            collect_models_from_object(item, &groups, &mut models);
        }
    }

    models
        .into_iter()
        .map(|(name, groups)| ModelInfo {
            name,
            enable_groups: groups.into_iter().collect(),
        })
        .collect()
}

fn collect_models_from_object(
    value: &Value,
    groups: &[String],
    models: &mut BTreeMap<String, BTreeSet<String>>,
) {
    let Some(obj) = value.as_object() else {
        return;
    };

    let candidates = [
        obj.get("supported_models"),
        obj.get("models"),
        obj.get("model"),
    ];
    for candidate in candidates.into_iter().flatten() {
        for model in parse_model_names(candidate) {
            let entry = models.entry(model).or_default();
            entry.extend(groups.iter().cloned());
        }
    }
}

fn parse_model_names(value: &Value) -> Vec<String> {
    if let Some(name) = value.as_str() {
        return vec![name.to_string()];
    }

    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            item.as_str().map(String::from).or_else(|| {
                item.get("name")
                    .or_else(|| item.get("model"))
                    .or_else(|| item.get("model_name"))
                    .and_then(value_to_string)
            })
        })
        .collect()
}

fn parse_keys_response(value: &Value, group_id_name: &HashMap<i64, String>) -> Vec<TokenInfo> {
    let data = value.get("data").unwrap_or(value);
    let arr = data
        .as_array()
        .cloned()
        .or_else(|| data.get("items").and_then(|v| v.as_array()).cloned())
        .or_else(|| data.get("list").and_then(|v| v.as_array()).cloned())
        .or_else(|| {
            if data.get("id").is_some() {
                Some(vec![data.clone()])
            } else {
                None
            }
        })
        .unwrap_or_default();

    arr.into_iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(value_to_i64)?;
            Some(TokenInfo {
                id,
                name: item
                    .get("name")
                    .and_then(value_to_string)
                    .unwrap_or_default(),
                group_name: parse_token_group_name(&item, group_id_name),
                key: item
                    .get("key")
                    .or_else(|| item.get("api_key"))
                    .or_else(|| item.get("custom_key"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                status: item.get("status").and_then(parse_status),
                remain_quota: parse_remain_quota(&item),
                expired_at: item
                    .get("expired_at")
                    .or_else(|| item.get("expires_at"))
                    .and_then(parse_timestamp),
            })
        })
        .collect()
}

fn parse_token_group_name(item: &Value, group_id_name: &HashMap<i64, String>) -> Option<String> {
    item.get("group")
        .and_then(|group| {
            group.as_str().map(String::from).or_else(|| {
                group
                    .get("name")
                    .or_else(|| group.get("group_name"))
                    .and_then(value_to_string)
            })
        })
        .or_else(|| item.get("group_name").and_then(value_to_string))
        .or_else(|| {
            item.get("group_id")
                .and_then(value_to_i64)
                .and_then(|id| group_id_name.get(&id).cloned())
        })
}

fn parse_status(value: &Value) -> Option<i32> {
    value.as_i64().map(|v| v as i32).or_else(|| {
        let status = value.as_str()?.to_ascii_lowercase();
        match status.as_str() {
            "active" | "enabled" => Some(1),
            "inactive" | "disabled" => Some(0),
            "quota_exhausted" => Some(2),
            "expired" => Some(3),
            _ => None,
        }
    })
}

fn parse_remain_quota(item: &Value) -> Option<i64> {
    if let Some(value) = item.get("remain_quota").and_then(value_to_i64) {
        return Some(value);
    }
    let quota = item.get("quota").and_then(value_to_f64)?;
    if quota <= 0.0 {
        return Some(-1);
    }
    let used = item
        .get("quota_used")
        .or_else(|| item.get("used_quota"))
        .and_then(value_to_f64)
        .unwrap_or(0.0);
    Some((quota - used).max(0.0).round() as i64)
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

fn build_create_key_body(req: &CreateTokenReq, group_id: i64) -> Value {
    json!({
        "name": req.name,
        "group_id": group_id,
        "quota": 0,
        "expires_in_days": expires_in_days(req.expired_time),
    })
}

#[allow(dead_code)]
fn build_update_key_body(new_name: &str, group_id: i64) -> Value {
    json!({
        "name": new_name,
        "group_id": group_id,
    })
}

fn expires_in_days(expired_time: i64) -> Value {
    if expired_time < 0 {
        return Value::Null;
    }
    let now = chrono::Utc::now().timestamp();
    let seconds = expired_time.saturating_sub(now);
    let days = ((seconds + 86_399) / 86_400).max(1);
    json!(days)
}

fn parse_groups_from_value(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| {
                item.as_str().map(String::from).or_else(|| {
                    item.get("name")
                        .or_else(|| item.get("group_name"))
                        .and_then(value_to_string)
                })
            })
            .collect(),
        Some(Value::Object(obj)) => {
            if obj.contains_key("name") || obj.contains_key("group_name") {
                obj.get("name")
                    .or_else(|| obj.get("group_name"))
                    .and_then(value_to_string)
                    .into_iter()
                    .collect()
            } else {
                obj.keys().cloned().collect()
            }
        }
        Some(value) => value_to_string(value).into_iter().collect(),
        None => Vec::new(),
    }
}

fn value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(String::from)
        .or_else(|| value_to_i64(value).map(|v| v.to_string()))
        .filter(|v| !v.is_empty())
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
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_groups_available_contract_response() {
        let value = json!({
            "code": 0,
            "message": "success",
            "data": [{
                "id": 10,
                "name": "Claude Group",
                "description": "paid tier",
                "rate_multiplier": 1.5,
                "status": "active"
            }]
        });

        let groups = parse_available_groups(&value);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Claude Group");
        assert_eq!(groups[0].ratio, Some(1.5));
        assert_eq!(groups[0].description.as_deref(), Some("paid tier"));
    }

    #[test]
    fn parse_channels_available_contract_maps_models_to_visible_groups() {
        let value = json!({
            "code": 0,
            "message": "success",
            "data": [{
                "name": "primary",
                "platforms": [{
                    "platform": "anthropic",
                    "groups": [{
                        "id": 10,
                        "name": "Claude Group"
                    }],
                    "supported_models": [{
                        "name": "claude-4",
                        "platform": "anthropic"
                    }]
                }, {
                    "platform": "gemini",
                    "groups": [{
                        "id": 11,
                        "name": "Gemini Group"
                    }],
                    "supported_models": [{
                        "name": "gemini-2.5-pro",
                        "platform": "gemini"
                    }]
                }]
            }]
        });

        let models = parse_available_channels(&value);

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "claude-4");
        assert_eq!(models[0].enable_groups, vec!["Claude Group"]);
        assert_eq!(models[1].name, "gemini-2.5-pro");
        assert_eq!(models[1].enable_groups, vec!["Gemini Group"]);
    }

    #[test]
    fn parse_keys_contract_maps_group_id_and_status() {
        let value = json!({
            "code": 0,
            "message": "success",
            "data": {
                "items": [{
                    "id": 100,
                    "key": "sk_custom_1234567890",
                    "name": "Claude Group",
                    "group_id": 10,
                    "status": "active",
                    "quota": 0,
                    "expires_at": null
                }]
            }
        });
        let groups = [(10_i64, "Claude Group".to_string())].into_iter().collect();

        let tokens = parse_keys_response(&value, &groups);

        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].id, 100);
        assert_eq!(tokens[0].group_name.as_deref(), Some("Claude Group"));
        assert_eq!(tokens[0].status, Some(1));
        assert_eq!(tokens[0].remain_quota, Some(-1));
    }

    #[test]
    fn create_key_body_uses_sub2api_contract_fields() {
        let req = CreateTokenReq {
            name: "Claude Group".to_string(),
            group: "Claude Group".to_string(),
            unlimited_quota: true,
            expired_time: -1,
            remark: Some("ignored".to_string()),
        };

        let body = build_create_key_body(&req, 10);

        assert_eq!(
            body,
            json!({
                "name": "Claude Group",
                "group_id": 10,
                "quota": 0,
                "expires_in_days": null
            })
        );
    }

    #[test]
    fn update_key_body_uses_numeric_group_id() {
        let body = build_update_key_body("Claude Group", 10);

        assert_eq!(
            body,
            json!({
                "name": "Claude Group",
                "group_id": 10
            })
        );
    }
}
