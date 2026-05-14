//! Sub2Api 协议 Adapter

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

        resp.json::<Value>()
            .await
            .map_err(|e| AppError::Config(format!("GET {path} 响应非 JSON: {e}")))
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

        resp.json::<Value>().await.or_else(|_| Ok(Value::Null))
    }
}

#[async_trait::async_trait]
impl ApiHubAdapter for Sub2ApiAdapter {
    async fn list_groups(&self, ctx: &SiteCtx) -> Result<Vec<GroupInfo>, AppError> {
        let value = self.get_json(ctx, "/api/v1/groups/available").await?;
        let data = value.get("data").unwrap_or(&value);
        let mut groups = Vec::new();

        if let Some(arr) = data.as_array() {
            for item in arr {
                if let Some(name) = item.as_str() {
                    groups.push(GroupInfo {
                        name: name.to_string(),
                        ratio: None,
                        description: None,
                    });
                    continue;
                }

                let Some(obj) = item.as_object() else {
                    continue;
                };
                let name = obj
                    .get("name")
                    .or_else(|| obj.get("group_name"))
                    .or_else(|| obj.get("id"))
                    .and_then(|v| v.as_str().or_else(|| v.as_i64().map(|_| "")))
                    .unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                groups.push(GroupInfo {
                    name: name.to_string(),
                    ratio: obj.get("rate").or_else(|| obj.get("ratio")).and_then(|v| v.as_f64()),
                    description: obj
                        .get("description")
                        .or_else(|| obj.get("desc"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                });
            }
        }

        Ok(groups)
    }

    async fn list_models(&self, ctx: &SiteCtx) -> Result<Vec<ModelInfo>, AppError> {
        let channels = self.get_json(ctx, "/api/v1/channels/available").await?;
        let rates = self
            .get_json(ctx, "/api/v1/groups/rates")
            .await
            .unwrap_or(Value::Null);
        let model_group_map = parse_sub2api_model_groups(&rates);
        let data = channels.get("data").unwrap_or(&channels);
        let mut models = Vec::new();

        if let Some(arr) = data.as_array() {
            for item in arr {
                if let Some(name) = item.as_str() {
                    models.push(ModelInfo {
                        name: name.to_string(),
                        enable_groups: model_group_map.get(name).cloned().unwrap_or_default(),
                    });
                    continue;
                }
                if let Some(obj) = item.as_object() {
                    let maybe_models = obj.get("models").or_else(|| obj.get("model"));
                    if let Some(list) = maybe_models.and_then(|v| v.as_array()) {
                        for model in list.iter().filter_map(|v| v.as_str()) {
                            models.push(ModelInfo {
                                name: model.to_string(),
                                enable_groups: model_group_map
                                    .get(model)
                                    .cloned()
                                    .unwrap_or_else(|| parse_groups_from_value(obj.get("groups"))),
                            });
                        }
                    } else if let Some(model) = maybe_models.and_then(|v| v.as_str()) {
                        models.push(ModelInfo {
                            name: model.to_string(),
                            enable_groups: model_group_map
                                .get(model)
                                .cloned()
                                .unwrap_or_else(|| parse_groups_from_value(obj.get("groups"))),
                        });
                    }
                }
            }
        }

        models.sort_by(|a, b| a.name.cmp(&b.name));
        models.dedup_by(|a, b| a.name == b.name);
        Ok(models)
    }

    async fn list_tokens(&self, ctx: &SiteCtx) -> Result<Vec<TokenInfo>, AppError> {
        let value = self
            .get_json(ctx, "/api/v1/keys?page=1&page_size=200")
            .await?;
        let data = value.get("data").unwrap_or(&value);
        let arr = data
            .as_array()
            .cloned()
            .or_else(|| data.get("items").and_then(|v| v.as_array()).cloned())
            .unwrap_or_default();

        Ok(arr
            .into_iter()
            .filter_map(|item| {
                let id = item.get("id").and_then(|v| v.as_i64())?;
                Some(TokenInfo {
                    id,
                    name: item
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    group_name: item
                        .get("group")
                        .or_else(|| item.get("group_name"))
                        .or_else(|| item.get("group_id"))
                        .and_then(value_to_string),
                    key: item
                        .get("key")
                        .or_else(|| item.get("api_key"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    status: item.get("status").and_then(|v| v.as_i64()).map(|v| v as i32),
                    remain_quota: item
                        .get("quota")
                        .or_else(|| item.get("remain_quota"))
                        .and_then(|v| v.as_i64()),
                    expired_at: item
                        .get("expired_at")
                        .or_else(|| item.get("expires_at"))
                        .and_then(|v| v.as_i64()),
                })
            })
            .collect())
    }

    async fn create_token(
        &self,
        ctx: &SiteCtx,
        req: CreateTokenReq,
    ) -> Result<TokenInfo, AppError> {
        let body = json!({
            "name": req.name,
            "group_id": req.group,
            "group": req.group,
            "quota": if req.unlimited_quota { -1 } else { 0 },
            "expires_in_days": if req.expired_time < 0 { -1 } else { 30 },
        });
        self.send_json(ctx, reqwest::Method::POST, "/api/v1/keys", body)
            .await?;
        self.list_tokens(ctx)
            .await?
            .into_iter()
            .find(|token| token.name == req.name)
            .ok_or_else(|| AppError::Config("创建 key 成功但回查未找到对应记录".to_string()))
    }

    async fn rename_token(
        &self,
        ctx: &SiteCtx,
        token_id: i64,
        new_name: &str,
        group: &str,
    ) -> Result<(), AppError> {
        let path = format!("/api/v1/keys/{token_id}");
        let body = json!({
            "name": new_name,
            "group_id": group,
            "group": group,
        });
        self.send_json(ctx, reqwest::Method::PUT, &path, body).await?;
        Ok(())
    }

    async fn delete_token(&self, ctx: &SiteCtx, token_id: i64) -> Result<(), AppError> {
        let path = format!("/api/v1/keys/{token_id}");
        self.send_json(ctx, reqwest::Method::DELETE, &path, Value::Null)
            .await?;
        Ok(())
    }
}

fn parse_sub2api_model_groups(value: &Value) -> std::collections::HashMap<String, Vec<String>> {
    let mut out = std::collections::HashMap::new();
    let data = value.get("data").unwrap_or(value);

    if let Some(obj) = data.as_object() {
        if let Some(model_groups) = obj.get("model_groups").and_then(|v| v.as_object()) {
            for (model, groups) in model_groups {
                out.insert(model.clone(), parse_groups_from_value(Some(groups)));
            }
        } else {
            for (model, groups) in obj {
                let parsed = parse_groups_from_value(Some(groups));
                if !parsed.is_empty() {
                    out.insert(model.clone(), parsed);
                }
            }
        }
    }

    out
}

fn parse_groups_from_value(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(arr)) => arr.iter().filter_map(value_to_string).collect(),
        Some(Value::Object(obj)) => obj.keys().cloned().collect(),
        Some(value) => value_to_string(value).into_iter().collect(),
        None => Vec::new(),
    }
}

fn value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(String::from)
        .or_else(|| value.as_i64().map(|v| v.to_string()))
        .filter(|v| !v.is_empty())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}
