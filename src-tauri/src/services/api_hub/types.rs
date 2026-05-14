//! Api-Hub 数据类型定义

use serde::{Deserialize, Serialize};

/// 调用 Adapter 时所需的站点上下文（鉴权 + 入参）
#[derive(Debug, Clone)]
pub struct SiteCtx {
    pub site_id: String,
    pub site_url: String,
    pub access_token: String,
    pub user_id: Option<i64>,
}

/// 分组信息（new-api 与 Sub2Api 通用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInfo {
    pub name: String,
    pub ratio: Option<f64>,
    pub description: Option<String>,
}

/// 模型信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    /// 该模型可在哪些分组下使用
    #[serde(default)]
    pub enable_groups: Vec<String>,
}

/// Token / APIKey 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenInfo {
    pub id: i64,
    pub name: String,
    pub group_name: Option<String>,
    /// sk- 实际密钥（可选，部分接口不返回）
    pub key: Option<String>,
    /// 1 = active
    pub status: Option<i32>,
    pub remain_quota: Option<i64>,
    /// Unix 秒；-1 = never
    pub expired_at: Option<i64>,
}

/// 创建 Token 请求
#[derive(Debug, Clone)]
pub struct CreateTokenReq {
    pub name: String,
    pub group: String,
    /// 是否无限配额
    pub unlimited_quota: bool,
    /// Unix 秒；-1 = never
    pub expired_time: i64,
    pub remark: Option<String>,
}

/// 站点行（列表展示用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteRow {
    pub id: String,
    pub site_name: String,
    pub site_url: String,
    pub site_type: String,
    pub exchange_rate: f64,
    pub username: Option<String>,
    #[serde(default)]
    pub imported_apps: Vec<String>,
    pub last_synced_at: Option<i64>,
    pub last_sync_error: Option<String>,
    pub sort_index: i32,
    pub group_count: i64,
    pub model_count: i64,
    pub token_count: i64,
}

/// 后端内部使用的完整站点记录（含 access_token）
#[derive(Debug, Clone)]
pub struct SiteRecord {
    pub id: String,
    pub site_name: String,
    pub site_url: String,
    pub site_type: String,
    pub access_token: String,
    pub user_id: Option<i64>,
    pub username: Option<String>,
    pub exchange_rate: f64,
    pub sort_index: i32,
    pub last_synced_at: Option<i64>,
    pub last_sync_error: Option<String>,
    pub notes: Option<String>,
}

impl SiteRecord {
    pub fn ctx(&self) -> SiteCtx {
        SiteCtx {
            site_id: self.id.clone(),
            site_url: self.site_url.clone(),
            access_token: self.access_token.clone(),
            user_id: self.user_id,
        }
    }
}

/// 站点详情（弹层 / dialog 用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteDetail {
    pub site: SiteRow,
    pub groups: Vec<GroupInfo>,
    pub models: Vec<ModelInfo>,
    pub tokens: Vec<TokenInfo>,
}

/// 列表查询参数
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SiteFilter {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub site_type: Option<String>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_direction: Option<String>,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

fn default_page() -> u32 {
    1
}
fn default_page_size() -> u32 {
    20
}

/// 分页结果
#[derive(Debug, Clone, Serialize)]
pub struct Paged<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
}

/// 导入 JSON 时单个账号（仅取必需字段）
#[derive(Debug, Clone, Deserialize)]
pub struct AccountBackupEntry {
    pub id: String,
    pub site_name: String,
    pub site_url: String,
    pub site_type: String,
    #[serde(default)]
    pub exchange_rate: Option<f64>,
    pub account_info: AccountInfoEntry,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountInfoEntry {
    #[serde(default)]
    pub id: Option<i64>,
    pub access_token: String,
    #[serde(default)]
    pub username: Option<String>,
}

/// 导入 JSON 顶层结构（仅匹配 accounts.accounts 数组）
#[derive(Debug, Clone, Deserialize)]
pub struct AccountsBackup {
    #[serde(default)]
    pub version: Option<String>,
    pub accounts: AccountsContainer,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountsContainer {
    pub accounts: Vec<AccountBackupEntry>,
}

/// 导入 JSON 报告
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub new_count: usize,
    pub update_count: usize,
    pub skipped: Vec<String>,
}

/// 单站同步结果
#[derive(Debug, Clone, Serialize, Default)]
pub struct SyncReport {
    pub site_id: String,
    pub site_name: String,
    pub groups_count: usize,
    pub models_count: usize,
    pub tokens_count: usize,
    pub error: Option<String>,
    /// 是否走了协议兜底（site_type 非 new-api/sub2api，按 new-api 尝试）
    pub fallback_used: bool,
}

/// 对齐选项
#[derive(Debug, Clone, Deserialize)]
pub struct AlignOptions {
    #[serde(default = "default_true")]
    pub rename_existing: bool,
    #[serde(default = "default_true")]
    pub delete_extra: bool,
}

impl Default for AlignOptions {
    fn default() -> Self {
        Self {
            rename_existing: true,
            delete_extra: true,
        }
    }
}

fn default_true() -> bool {
    true
}

/// 单个模型选择（导入应用用）
#[derive(Debug, Clone, Deserialize)]
pub struct ModelSelection {
    pub group: String,
    pub model: String,
}

/// 导入到应用的请求
#[derive(Debug, Clone, Deserialize)]
pub struct ImportToAppsReq {
    pub site_id: String,
    pub target_apps: Vec<String>,
    pub selections: Vec<ModelSelection>,
    #[serde(default = "default_true")]
    pub auto_align_if_missing: bool,
    #[serde(default = "default_true")]
    pub mark_as_imported: bool,
    /// 由前端按各应用模板生成的 settings_config，key = "<app>::<group>::<model>"
    /// value = JSON object
    pub settings_configs: std::collections::HashMap<String, serde_json::Value>,
}

/// 清理站点导入记录结果
#[derive(Debug, Clone, Serialize, Default)]
pub struct CleanupSiteProvidersReport {
    pub deleted: usize,
    pub failed: Vec<String>,
}

/// 导入到应用结果
#[derive(Debug, Clone, Serialize, Default)]
pub struct ImportToAppsReport {
    pub created: usize,
    pub updated: usize,
    pub failed: Vec<ImportFailure>,
    pub auto_aligned_groups: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportFailure {
    pub app: String,
    pub group: String,
    pub model: String,
    pub error: String,
}

/// 进度事件载荷
#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub site_id: String,
    pub site_name: String,
    pub index: usize,
    pub total: usize,
    pub step: Option<String>,
    pub status: String, // "pending" | "running" | "success" | "failed" | "warn"
    pub error: Option<String>,
}
