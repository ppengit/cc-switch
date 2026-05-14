//! Adapter trait + 工厂函数

use crate::error::AppError;

use super::new_api::NewApiAdapter;
use super::sub2api::Sub2ApiAdapter;
use super::types::{CreateTokenReq, GroupInfo, ModelInfo, SiteCtx, TokenInfo};

#[async_trait::async_trait]
pub trait ApiHubAdapter: Send + Sync {
    async fn list_groups(&self, ctx: &SiteCtx) -> Result<Vec<GroupInfo>, AppError>;
    async fn list_models(&self, ctx: &SiteCtx) -> Result<Vec<ModelInfo>, AppError>;
    async fn list_tokens(&self, ctx: &SiteCtx) -> Result<Vec<TokenInfo>, AppError>;
    async fn create_token(
        &self,
        ctx: &SiteCtx,
        req: CreateTokenReq,
    ) -> Result<TokenInfo, AppError>;
    async fn rename_token(
        &self,
        ctx: &SiteCtx,
        token_id: i64,
        new_name: &str,
        group: &str,
    ) -> Result<(), AppError>;
    async fn delete_token(&self, ctx: &SiteCtx, token_id: i64) -> Result<(), AppError>;
}

/// Adapter 工厂：未知 site_type 兜底为 new-api。
pub fn build_adapter(site_type: &str) -> Box<dyn ApiHubAdapter> {
    match site_type.to_ascii_lowercase().as_str() {
        "sub2api" => Box::new(Sub2ApiAdapter::new()),
        _ => Box::new(NewApiAdapter::new()),
    }
}

/// 是否为已识别的协议（用于决定 SyncReport.fallback_used）
pub fn is_known_site_type(site_type: &str) -> bool {
    matches!(
        site_type.to_ascii_lowercase().as_str(),
        "new-api" | "newapi" | "sub2api"
    )
}
