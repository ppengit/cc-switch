//! Api-Hub APIKey 对齐算法

use std::collections::HashSet;
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use serde::Serialize;

use crate::database::Database;
use crate::error::AppError;

use super::adapter::build_adapter;
use super::grouping::group_names_with_models;
use super::sync::{emit_progress, sync_site, API_HUB_BATCH_CONCURRENCY};
use super::types::{has_plain_api_key, AlignOptions, CreateTokenReq, ProgressPayload};

#[derive(Debug, Clone, Serialize, Default)]
pub struct AlignOutcome {
    pub site_id: String,
    pub site_name: String,
    pub renamed: usize,
    pub created: usize,
    pub deleted: usize,
    pub warnings: Vec<String>,
}

pub async fn align_site(
    db: Arc<Database>,
    site_id: &str,
    options: AlignOptions,
) -> Result<AlignOutcome, AppError> {
    align_site_for_groups(db, site_id, None, options).await
}

pub async fn align_site_for_groups(
    db: Arc<Database>,
    site_id: &str,
    only_groups: Option<HashSet<String>>,
    _options: AlignOptions,
) -> Result<AlignOutcome, AppError> {
    let site = db.api_hub_get_site_record(site_id)?;
    let mut outcome = AlignOutcome {
        site_id: site.id.clone(),
        site_name: site.site_name.clone(),
        ..Default::default()
    };

    let _ = sync_site(db.clone(), site_id).await?;
    let groups = db.api_hub_get_groups(site_id)?;
    let models = db.api_hub_get_models(site_id)?;
    let tokens = db.api_hub_get_tokens(site_id)?;
    let adapter = build_adapter(&site.site_type);
    let ctx = site.ctx();
    let groups_with_models = group_names_with_models(&groups, &models);

    for group in groups {
        if !groups_with_models.contains(&group.name) {
            continue;
        }
        if let Some(allowed) = &only_groups {
            if !allowed.contains(&group.name) {
                continue;
            }
        }
        let has_group_token = tokens.iter().any(|token| {
            token.group_name.as_deref() == Some(group.name.as_str())
                && token.name == group.name
                && has_plain_api_key(token.key.as_deref())
        });
        if has_group_token {
            continue;
        }

        adapter
            .create_token(
                &ctx,
                CreateTokenReq {
                    name: group.name.clone(),
                    group: group.name.clone(),
                    unlimited_quota: true,
                    expired_time: -1,
                    remark: Some("由 cc-switch Api-Hub 创建".to_string()),
                },
            )
            .await?;
        outcome.created += 1;
    }

    let _ = sync_site(db, site_id).await?;
    Ok(outcome)
}

pub async fn align_sites_with_progress(
    app: tauri::AppHandle,
    db: Arc<Database>,
    site_ids: Vec<String>,
    options: AlignOptions,
) -> Result<(), AppError> {
    let total = site_ids.len();
    stream::iter(site_ids.into_iter().enumerate())
        .for_each_concurrent(API_HUB_BATCH_CONCURRENCY, |(index, site_id)| {
            let app = app.clone();
            let db = db.clone();
            let options = options.clone();
            async move {
                let site_name = db
                    .api_hub_get_site_record(&site_id)
                    .map(|site| site.site_name)
                    .unwrap_or_else(|_| site_id.clone());
                emit_progress(
                    &app,
                    "api_hub_align_progress",
                    ProgressPayload {
                        site_id: site_id.clone(),
                        site_name: site_name.clone(),
                        index: index + 1,
                        total,
                        step: Some("align".to_string()),
                        status: "running".to_string(),
                        error: None,
                    },
                );
                let result = align_site(db.clone(), &site_id, options).await;
                emit_progress(
                    &app,
                    "api_hub_align_progress",
                    ProgressPayload {
                        site_id,
                        site_name,
                        index: index + 1,
                        total,
                        step: Some("align".to_string()),
                        status: if result.is_ok() { "success" } else { "failed" }.to_string(),
                        error: result.err().map(|err| err.to_string()),
                    },
                );
            }
        })
        .await;
    Ok(())
}
