//! Api-Hub 同步协调器

use std::sync::Arc;

use futures::stream::{self, StreamExt};
use tauri::Emitter;

use crate::database::Database;
use crate::error::AppError;

use super::adapter::{build_adapter, is_known_site_type};
use super::types::{ProgressPayload, SyncReport};

pub(crate) const API_HUB_BATCH_CONCURRENCY: usize = 4;

pub async fn sync_site(db: Arc<Database>, site_id: &str) -> Result<SyncReport, AppError> {
    let site = db.api_hub_get_site_record(site_id)?;
    let adapter = build_adapter(&site.site_type);
    let fallback_used = !is_known_site_type(&site.site_type);
    let ctx = site.ctx();

    let result = async {
        let groups = adapter.list_groups(&ctx).await?;
        let models = adapter.list_models(&ctx).await?;
        let tokens = adapter.list_tokens(&ctx).await?;
        Ok::<_, AppError>((groups, models, tokens))
    }
    .await;

    match result {
        Ok((groups, models, tokens)) => {
            db.api_hub_replace_cache(&site.id, &groups, &models, &tokens, None)?;
            Ok(SyncReport {
                site_id: site.id,
                site_name: site.site_name,
                groups_count: groups.len(),
                models_count: models.len(),
                tokens_count: tokens.len(),
                error: None,
                fallback_used,
            })
        }
        Err(err) => {
            let message = if fallback_used {
                format!("已按 new-api 协议尝试，失败原因: {err}")
            } else {
                err.to_string()
            };
            db.api_hub_set_sync_error(&site.id, Some(&message))?;
            Ok(SyncReport {
                site_id: site.id,
                site_name: site.site_name,
                groups_count: 0,
                models_count: 0,
                tokens_count: 0,
                error: Some(message),
                fallback_used,
            })
        }
    }
}

pub async fn sync_sites_with_progress(
    app: tauri::AppHandle,
    db: Arc<Database>,
    site_ids: Vec<String>,
) -> Result<(), AppError> {
    let total = site_ids.len();
    stream::iter(site_ids.into_iter().enumerate())
        .for_each_concurrent(API_HUB_BATCH_CONCURRENCY, |(index, site_id)| {
            let app = app.clone();
            let db = db.clone();
            async move {
                let site_name = db
                    .api_hub_get_site_record(&site_id)
                    .map(|site| site.site_name)
                    .unwrap_or_else(|_| site_id.clone());
                emit_progress(
                    &app,
                    "api_hub_sync_progress",
                    ProgressPayload {
                        site_id: site_id.clone(),
                        site_name: site_name.clone(),
                        index: index + 1,
                        total,
                        step: Some("sync".to_string()),
                        status: "running".to_string(),
                        error: None,
                    },
                );

                let result = sync_site(db.clone(), &site_id).await;
                let (status, error) = match result {
                    Ok(report) => {
                        if report.error.is_some() {
                            ("failed".to_string(), report.error)
                        } else {
                            ("success".to_string(), None)
                        }
                    }
                    Err(err) => ("failed".to_string(), Some(err.to_string())),
                };

                emit_progress(
                    &app,
                    "api_hub_sync_progress",
                    ProgressPayload {
                        site_id,
                        site_name,
                        index: index + 1,
                        total,
                        step: Some("sync".to_string()),
                        status,
                        error,
                    },
                );
            }
        })
        .await;
    Ok(())
}

pub(crate) fn emit_progress(app: &tauri::AppHandle, event: &str, payload: ProgressPayload) {
    if let Err(err) = app.emit(event, payload) {
        log::debug!("emit {event} failed: {err}");
    }
}
