//! Api-Hub 同步协调器

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use tauri::Emitter;

use crate::database::Database;
use crate::error::AppError;

use super::adapter::{build_adapter, is_known_site_type};
use super::types::{GroupInfo, ModelInfo, ProgressPayload, SyncReport, TokenInfo};

pub(crate) const API_HUB_BATCH_CONCURRENCY: usize = 4;

pub async fn sync_site(db: Arc<Database>, site_id: &str) -> Result<SyncReport, AppError> {
    fetch_and_store_site(db, site_id).await
}

pub async fn check_site(db: Arc<Database>, site_id: &str) -> Result<SyncReport, AppError> {
    fetch_and_store_site(db, site_id).await
}

async fn fetch_and_store_site(db: Arc<Database>, site_id: &str) -> Result<SyncReport, AppError> {
    let site = db.api_hub_get_site_record(site_id)?;
    let adapter = build_adapter(&site.site_type);
    let fallback_used = !is_known_site_type(&site.site_type);
    let ctx = site.ctx();
    let previous_groups = db.api_hub_get_groups(site_id).unwrap_or_default();
    let previous_models = db.api_hub_get_models(site_id).unwrap_or_default();
    let previous_tokens = db.api_hub_get_tokens(site_id).unwrap_or_default();

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
            let change_summary = if site.last_synced_at.is_some() {
                summarize_changes(
                    &previous_groups,
                    &previous_models,
                    &previous_tokens,
                    &groups,
                    &models,
                    &tokens,
                )
            } else {
                None
            };
            db.api_hub_set_check_result(&site.id, change_summary.as_deref())?;
            Ok(SyncReport {
                site_id: site.id,
                site_name: site.site_name,
                groups_count: groups.len(),
                models_count: models.len(),
                tokens_count: tokens.len(),
                error: None,
                changed: change_summary.is_some(),
                change_summary,
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
                changed: false,
                change_summary: None,
                fallback_used,
            })
        }
    }
}

fn summarize_changes(
    previous_groups: &[GroupInfo],
    previous_models: &[ModelInfo],
    previous_tokens: &[TokenInfo],
    next_groups: &[GroupInfo],
    next_models: &[ModelInfo],
    next_tokens: &[TokenInfo],
) -> Option<String> {
    let previous_group_names: BTreeSet<String> = previous_groups
        .iter()
        .map(|group| group.name.clone())
        .collect();
    let next_group_names: BTreeSet<String> =
        next_groups.iter().map(|group| group.name.clone()).collect();
    let previous_model_names: BTreeSet<String> = previous_models
        .iter()
        .map(|model| model.name.clone())
        .collect();
    let next_model_names: BTreeSet<String> =
        next_models.iter().map(|model| model.name.clone()).collect();
    let previous_token_ids: BTreeSet<i64> = previous_tokens.iter().map(|token| token.id).collect();
    let next_token_ids: BTreeSet<i64> = next_tokens.iter().map(|token| token.id).collect();

    let changed_model_groups = count_model_group_changes(previous_models, next_models);
    let mut parts = Vec::new();
    push_added_removed(
        &mut parts,
        "分组",
        previous_group_names.difference(&next_group_names).count(),
        next_group_names.difference(&previous_group_names).count(),
    );
    push_added_removed(
        &mut parts,
        "模型",
        previous_model_names.difference(&next_model_names).count(),
        next_model_names.difference(&previous_model_names).count(),
    );
    if changed_model_groups > 0 {
        parts.push(format!("模型分组变更 {changed_model_groups}"));
    }
    push_added_removed(
        &mut parts,
        "APIKey",
        previous_token_ids.difference(&next_token_ids).count(),
        next_token_ids.difference(&previous_token_ids).count(),
    );

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("，"))
    }
}

fn push_added_removed(parts: &mut Vec<String>, label: &str, removed: usize, added: usize) {
    if added == 0 && removed == 0 {
        return;
    }
    parts.push(format!("{label} +{added}/-{removed}"));
}

fn count_model_group_changes(previous_models: &[ModelInfo], next_models: &[ModelInfo]) -> usize {
    let previous: BTreeMap<String, BTreeSet<String>> = previous_models
        .iter()
        .map(|model| {
            (
                model.name.clone(),
                model.enable_groups.iter().cloned().collect(),
            )
        })
        .collect();
    next_models
        .iter()
        .filter(|model| {
            let next_groups: BTreeSet<String> = model.enable_groups.iter().cloned().collect();
            previous
                .get(&model.name)
                .map(|groups| groups != &next_groups)
                .unwrap_or(false)
        })
        .count()
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

pub async fn check_sites_with_progress(
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
                    "api_hub_check_progress",
                    ProgressPayload {
                        site_id: site_id.clone(),
                        site_name: site_name.clone(),
                        index: index + 1,
                        total,
                        step: Some("check".to_string()),
                        status: "running".to_string(),
                        error: None,
                    },
                );

                let result = check_site(db.clone(), &site_id).await;
                let (status, error) = match result {
                    Ok(report) => {
                        if report.error.is_some() {
                            ("failed".to_string(), report.error)
                        } else if report.changed {
                            ("warn".to_string(), report.change_summary)
                        } else {
                            ("success".to_string(), None)
                        }
                    }
                    Err(err) => ("failed".to_string(), Some(err.to_string())),
                };

                emit_progress(
                    &app,
                    "api_hub_check_progress",
                    ProgressPayload {
                        site_id,
                        site_name,
                        index: index + 1,
                        total,
                        step: Some("check".to_string()),
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
