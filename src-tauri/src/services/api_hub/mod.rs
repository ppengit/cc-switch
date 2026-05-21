//! Api-Hub 服务模块
//!
//! 对接 api-hub 浏览器扩展导出的多站点账号信息，提供：
//! - 站点导入与持久化
//! - new-api / Sub2Api 两种协议的分组、模型、Token 的读写适配
//! - 「对齐 APIKey」 与 「批量导入到应用 Provider」的工作流

pub mod adapter;
pub mod align;
pub mod dao;
pub mod grouping;
pub mod new_api;
pub mod sub2api;
pub mod sync;
pub mod types;

pub use align::{align_site_for_groups, align_sites_with_progress};
pub use sync::{check_sites_with_progress, sync_site, sync_sites_with_progress};
pub use types::*;
