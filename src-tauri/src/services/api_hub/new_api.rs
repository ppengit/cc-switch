//! new-api 协议 Adapter
//!
//! 兼容 newapi.pro / Veloera / OneAPI / done-hub / one-hub 等 fork：
//! - 鉴权：`Authorization: <token>`（裸 token，无 Bearer）
//!   + 多头扇出 user_id：New-API-User / Veloera-User / voapi-user / User-id /
//!     Rix-Api-User / neo-api-user / done-api-user
//! - 分组：GET /api/user/self/groups（失败降级 /api/user/groups）
//! - 模型：GET /api/pricing（失败降级 /api/user/models，无分组关联）
//! - Token CRUD：/api/token/，编辑用 PUT + body 寻址 id

use std::time::Duration;

use serde_json::{json, Value};

use crate::error::AppError;

use super::adapter::ApiHubAdapter;
use super::types::{CreateTokenReq, GroupInfo, ModelInfo, SiteCtx, TokenInfo};

pub struct NewApiAdapter;

impl NewApiAdapter {
    pub fn new() -> Self {
        Self
    }

    fn build_headers(&self, ctx: &SiteCtx) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        // Authorization 裸 token（new-api 系列 user token 约定，不加 Bearer）
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&ctx.access_token) {
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
        if let Some(uid) = ctx.user_id {
            let uid_str = uid.to_string();
            // 跨 fork 兼容扇出。值都是 user_id 字符串。
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
            .map_err(|e| AppError::Config(format!("GET {path} 失败: {e}")))?;

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
            .map_err(|e| AppError::Config(format!("{method} {path} 失败: {e}")))?;

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
}

#[async_trait::async_trait]
impl ApiHubAdapter for NewApiAdapter {
    async fn list_groups(&self, ctx: &SiteCtx) -> Result<Vec<GroupInfo>, AppError> {
        // 优先 /api/user/self/groups，失败降级 /api/user/groups
        let value = match self.get_json(ctx, "/api/user/self/groups").await {
            Ok(v) => v,
            Err(e) => {
                log::debug!("[ApiHub][new-api] self/groups 失败，降级 user/groups: {e}");
                self.get_json(ctx, "/api/user/groups").await?
            }
        };

        let data = value.get("data").unwrap_or(&value);
        let mut groups = Vec::new();
        if let Some(obj) = data.as_object() {
            for (name, info) in obj {
                groups.push(GroupInfo {
                    name: name.clone(),
                    ratio: info.get("ratio").and_then(|v| v.as_f64()),
                    description: info
                        .get("desc")
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
                        .or_else(|| obj.get("group"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    if !name.is_empty() {
                        groups.push(GroupInfo {
                            name,
                            ratio: obj.get("ratio").and_then(|v| v.as_f64()),
                            description: obj.get("desc").and_then(|v| v.as_str()).map(String::from),
                        });
                    }
                }
            }
        }
        Ok(groups)
    }

    async fn list_models(&self, ctx: &SiteCtx) -> Result<Vec<ModelInfo>, AppError> {
        // 优先 /api/pricing 获取 enable_groups 关联；失败降级 /api/user/models
        let value = match self.get_json(ctx, "/api/pricing").await {
            Ok(v) => v,
            Err(e) => {
                log::debug!("[ApiHub][new-api] /api/pricing 失败，降级 user/models: {e}");
                let v = self.get_json(ctx, "/api/user/models").await?;
                let arr = v.get("data").unwrap_or(&v);
                let mut out = Vec::new();
                if let Some(list) = arr.as_array() {
                    for item in list {
                        if let Some(name) = item.as_str() {
                            out.push(ModelInfo {
                                name: name.to_string(),
                                enable_groups: vec![],
                            });
                        }
                    }
                }
                return Ok(out);
            }
        };

        let data = value.get("data").unwrap_or(&value);
        let mut out = Vec::new();
        if let Some(list) = data.as_array() {
            for item in list {
                let name = item
                    .get("model_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                let groups = item
                    .get("enable_groups")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|g| g.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                out.push(ModelInfo {
                    name,
                    enable_groups: groups,
                });
            }
        }
        Ok(out)
    }

    async fn list_tokens(&self, ctx: &SiteCtx) -> Result<Vec<TokenInfo>, AppError> {
        let value = self.get_json(ctx, "/api/token/?p=0&size=200").await?;
        let items = match value.get("data") {
            Some(d) if d.is_array() => d.clone(),
            Some(d) if d.is_object() => d.get("items").cloned().unwrap_or(Value::Array(vec![])),
            _ => Value::Array(vec![]),
        };
        let arr = items.as_array().cloned().unwrap_or_default();

        let mut tokens = Vec::new();
        for item in arr {
            let id = item.get("id").and_then(|v| v.as_i64()).unwrap_or_default();
            if id == 0 {
                continue;
            }
            tokens.push(TokenInfo {
                id,
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                group_name: item
                    .get("group")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                key: item.get("key").and_then(|v| v.as_str()).map(String::from),
                status: item.get("status").and_then(|v| v.as_i64()).map(|x| x as i32),
                remain_quota: item.get("remain_quota").and_then(|v| v.as_i64()),
                expired_at: item.get("expired_time").and_then(|v| v.as_i64()),
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

        let success = value
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !success {
            return Err(AppError::Config(format!(
                "创建 token 失败: {}",
                value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知错误")
            )));
        }

        // 创建成功后通过列表回查（部分 fork 不返回新建 token 的 id）
        let tokens = self.list_tokens(ctx).await?;
        tokens
            .into_iter()
            .find(|t| t.name == req.name && t.group_name.as_deref() == Some(req.group.as_str()))
            .ok_or_else(|| {
                AppError::Config("创建 token 成功但回查未找到对应记录".to_string())
            })
    }

    async fn rename_token(
        &self,
        ctx: &SiteCtx,
        token_id: i64,
        new_name: &str,
        group: &str,
    ) -> Result<(), AppError> {
        // new-api 编辑 token：PUT /api/token/ + body 寻址 id；同时带 group 防被重置
        let body = json!({
            "id": token_id,
            "name": new_name,
            "group": group,
        });
        let value = self
            .send_json(ctx, reqwest::Method::PUT, "/api/token/", body)
            .await?;
        let success = value
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !success {
            return Err(AppError::Config(format!(
                "重命名 token 失败: {}",
                value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知错误")
            )));
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
            .map_err(|e| AppError::Config(format!("DELETE token 失败: {e}")))?;

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

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
