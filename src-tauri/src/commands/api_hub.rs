use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tauri::State;

use crate::app_config::AppType;
use crate::provider::{Provider, ProviderMeta};
use crate::services::api_hub::{
    align_site_for_groups, align_sites_with_progress, has_plain_api_key, is_masked_api_key,
    sync_site, sync_sites_with_progress, AccountsBackup, AlignOptions, CleanupSiteProvidersReport,
    ImportFailure, ImportReport, ImportToAppsReport, ImportToAppsReq, ModelSelection, Paged,
    SiteDetail, SiteFilter, SiteRow, SyncReport,
};
use crate::services::provider::ProviderService;
use crate::store::AppState;

const API_HUB_API_KEY_PLACEHOLDER: &str = "__API_HUB_API_KEY__";

#[tauri::command]
pub fn api_hub_import_json(
    state: State<'_, AppState>,
    payload: AccountsBackup,
) -> Result<ImportReport, String> {
    state
        .db
        .api_hub_import_accounts(&payload.accounts.accounts)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_hub_list_sites(
    state: State<'_, AppState>,
    filter: SiteFilter,
) -> Result<Paged<SiteRow>, String> {
    state
        .db
        .api_hub_list_sites(filter)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_hub_get_site_detail(
    state: State<'_, AppState>,
    site_id: String,
) -> Result<SiteDetail, String> {
    state
        .db
        .api_hub_get_site_detail(&site_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_hub_clear_all(state: State<'_, AppState>) -> Result<(), String> {
    state.db.api_hub_clear_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_hub_delete_site(state: State<'_, AppState>, site_id: String) -> Result<(), String> {
    state
        .db
        .api_hub_delete_site(&site_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_hub_cleanup_site_providers(
    state: State<'_, AppState>,
    site_id: String,
) -> Result<CleanupSiteProvidersReport, String> {
    let origins = state
        .db
        .api_hub_list_provider_origins_for_site(&site_id)
        .map_err(|e| e.to_string())?;
    let mut report = CleanupSiteProvidersReport::default();

    for (app, provider_id) in origins {
        let app_type = match AppType::from_str(&app) {
            Ok(value) => value,
            Err(err) => {
                report.failed.push(format!("{app}/{provider_id}: {err}"));
                continue;
            }
        };

        match ProviderService::delete(state.inner(), app_type, &provider_id) {
            Ok(()) => report.deleted += 1,
            Err(err) => report.failed.push(format!("{app}/{provider_id}: {err}")),
        }
    }

    if report.failed.is_empty() {
        state
            .db
            .api_hub_clear_site_imported_apps(&site_id)
            .map_err(|e| e.to_string())?;
    }

    Ok(report)
}

#[tauri::command]
pub async fn api_hub_sync_site(
    state: State<'_, AppState>,
    site_id: String,
) -> Result<SyncReport, String> {
    sync_site(state.db.clone(), &site_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_hub_sync_sites(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    site_ids: Vec<String>,
) -> Result<(), String> {
    sync_sites_with_progress(app, state.db.clone(), site_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_hub_align_sites(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    site_ids: Vec<String>,
    options: Option<AlignOptions>,
) -> Result<(), String> {
    align_sites_with_progress(app, state.db.clone(), site_ids, options.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_hub_import_to_apps(
    state: State<'_, AppState>,
    req: ImportToAppsReq,
) -> Result<ImportToAppsReport, String> {
    import_to_apps(state.db.clone(), req)
        .await
        .map_err(|e| e.to_string())
}

async fn import_to_apps(
    db: Arc<crate::database::Database>,
    req: ImportToAppsReq,
) -> Result<ImportToAppsReport, crate::error::AppError> {
    let site = db.api_hub_get_site_record(&req.site_id)?;
    let group_ratio_map: HashMap<String, Option<f64>> = db
        .api_hub_get_groups(&req.site_id)?
        .into_iter()
        .map(|group| (group.name, group.ratio))
        .collect();
    let mut report = ImportToAppsReport::default();
    let mut imported_apps = HashSet::new();
    let groups: HashSet<String> = req
        .selections
        .iter()
        .map(|item| item.group.clone())
        .collect();

    let missing: HashSet<String> = groups
        .iter()
        .filter_map(
            |group| match db.api_hub_find_token_for_group(&req.site_id, group) {
                Ok(Some(token)) if !has_plain_api_key(token.key.as_deref()) => Some(group.clone()),
                Ok(Some(_)) => None,
                Ok(None) => Some(group.clone()),
                Err(_) => Some(group.clone()),
            },
        )
        .collect();

    if !missing.is_empty() {
        if req.auto_align_if_missing {
            let outcome = align_site_for_groups(
                db.clone(),
                &req.site_id,
                Some(missing.clone()),
                AlignOptions::default(),
            )
            .await?;
            report.auto_aligned_groups = missing.into_iter().collect();
            report.auto_aligned_groups.sort();
            if !outcome.warnings.is_empty() {
                log::warn!(
                    "[ApiHub] auto align warnings for {}: {:?}",
                    req.site_id,
                    outcome.warnings
                );
            }
        } else {
            return Err(crate::error::AppError::Config(format!(
                "以下分组缺少同名 APIKey: {}",
                sorted_join(missing)
            )));
        }
    }

    let tokens = db.api_hub_get_tokens(&req.site_id)?;
    let group_to_key: HashMap<String, String> = tokens
        .into_iter()
        .filter_map(|token| {
            let group = token.group_name?;
            if token.name != group {
                return None;
            }
            let raw_key = token.key?;
            let normalized_key = normalize_api_key(raw_key.trim());
            if normalized_key.is_empty() || is_masked_api_key(&normalized_key) {
                return None;
            }
            Some((group, normalized_key))
        })
        .collect();

    for app in &req.target_apps {
        let app_type = match AppType::from_str(app) {
            Ok(value) => value,
            Err(err) => {
                for selection in selections_for_app(&req.selections, app) {
                    report.failed.push(ImportFailure {
                        app: app.clone(),
                        group: selection.group.clone(),
                        model: selection.model.clone(),
                        error: err.to_string(),
                    });
                }
                continue;
            }
        };

        for selection in selections_for_app(&req.selections, app) {
            let settings_key = format!("{}::{}::{}", app, selection.group, selection.model);
            let Some(settings_config) = req.settings_configs.get(&settings_key).cloned() else {
                report.failed.push(ImportFailure {
                    app: app.clone(),
                    group: selection.group.clone(),
                    model: selection.model.clone(),
                    error: format!("缺少 settings_config: {settings_key}"),
                });
                continue;
            };

            let Some(api_key) = group_to_key.get(&selection.group) else {
                report.failed.push(ImportFailure {
                    app: app.clone(),
                    group: selection.group.clone(),
                    model: selection.model.clone(),
                    error: "分组缺少同名 APIKey 或 APIKey 未返回 key 字段".to_string(),
                });
                continue;
            };
            let settings_config = replace_api_key_placeholder(settings_config, api_key);

            let provider_id = build_provider_id(&site.id, &selection.group, &selection.model, app);
            let provider_name = format!(
                "{} · {} · {}",
                site.site_name, selection.group, selection.model
            );
            let origin = format!("{}:{}:{}", site.id, selection.group, selection.model);
            let meta = ProviderMeta {
                provider_type: Some(site.site_type.clone()),
                ..Default::default()
            };
            let ratio_text = group_ratio_map
                .get(&selection.group)
                .and_then(|ratio| *ratio)
                .map(format_ratio_value)
                .unwrap_or_else(|| "1".to_string());

            let provider = Provider {
                id: provider_id,
                name: provider_name,
                settings_config,
                website_url: Some(site.site_url.clone()),
                category: Some("aggregator".to_string()),
                created_at: Some(chrono::Utc::now().timestamp_millis()),
                sort_index: None,
                notes: Some(format!("倍率：{}x 分组：{}", ratio_text, selection.group)),
                meta: Some(meta),
                icon: Some("newapi".to_string()),
                icon_color: Some("#10b981".to_string()),
                in_failover_queue: false,
            };

            match db.api_hub_save_provider_origin(app_type.as_str(), &provider, &origin) {
                Ok(true) => {
                    report.updated += 1;
                    imported_apps.insert(app.clone());
                }
                Ok(false) => {
                    report.created += 1;
                    imported_apps.insert(app.clone());
                }
                Err(err) => report.failed.push(ImportFailure {
                    app: app.clone(),
                    group: selection.group.clone(),
                    model: selection.model.clone(),
                    error: err.to_string(),
                }),
            }
        }
    }

    if req.mark_as_imported && !imported_apps.is_empty() {
        let apps: Vec<String> = imported_apps.into_iter().collect();
        db.api_hub_mark_site_imported_apps(&req.site_id, &apps)?;
    }

    Ok(report)
}

fn selections_for_app<'a>(selections: &'a [ModelSelection], app: &str) -> Vec<&'a ModelSelection> {
    let app_specific: Vec<&ModelSelection> = selections
        .iter()
        .filter(|selection| selection.app.as_deref() == Some(app))
        .collect();
    if !app_specific.is_empty() {
        return app_specific;
    }
    selections
        .iter()
        .filter(|selection| selection.app.is_none())
        .collect()
}

fn sorted_join(values: HashSet<String>) -> String {
    let mut values: Vec<String> = values.into_iter().collect();
    values.sort();
    values.join(", ")
}

fn build_provider_id(site_id: &str, group: &str, model: &str, app: &str) -> String {
    let short = site_id
        .rsplit('-')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(site_id)
        .chars()
        .take(8)
        .collect::<String>();
    format!(
        "apihub-{}-{}-{}-{}",
        slug(&short),
        slug(group),
        slug(model),
        slug(app)
    )
}

fn slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "x".to_string()
    } else {
        trimmed
    }
}

fn normalize_api_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("bearer ") {
        return normalize_api_key(trimmed[7..].trim());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("sk-") {
        return trimmed.to_string();
    }
    if trimmed.starts_with("sk") {
        return format!("sk-{}", &trimmed[2..]);
    }
    if trimmed.len() >= 16 {
        return format!("sk-{trimmed}");
    }
    trimmed.to_string()
}

fn format_ratio_value(value: f64) -> String {
    if value.fract().abs() < f64::EPSILON {
        format!("{}", value as i64)
    } else {
        let text = format!("{value:.4}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

use std::str::FromStr;

fn replace_api_key_placeholder(value: serde_json::Value, api_key: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => {
            serde_json::Value::String(text.replace(API_HUB_API_KEY_PLACEHOLDER, api_key))
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|item| replace_api_key_placeholder(item, api_key))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, replace_api_key_placeholder(value, api_key)))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replace_api_key_placeholder_replaces_nested_strings_only() {
        let input = json!({
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "__API_HUB_API_KEY__",
                "ANTHROPIC_BASE_URL": "https://example.com"
            },
            "items": ["prefix-__API_HUB_API_KEY__", 1, true, null]
        });

        let output = replace_api_key_placeholder(input, "sk-test");

        assert_eq!(
            output,
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "sk-test",
                    "ANTHROPIC_BASE_URL": "https://example.com"
                },
                "items": ["prefix-sk-test", 1, true, null]
            })
        );
    }

    #[test]
    fn masked_keys_are_not_normalized_as_importable() {
        assert!(is_masked_api_key("sk-****"));
        assert!(is_masked_api_key("sk-abcd********wxyz"));
        assert_eq!(
            normalize_api_key("sk-abcd********wxyz"),
            "sk-abcd********wxyz"
        );
        assert!(is_masked_api_key(&normalize_api_key("sk-abcd********wxyz")));
    }

    #[test]
    fn selections_for_app_prefers_app_specific_rows() {
        let selections = vec![
            ModelSelection {
                group: "default".to_string(),
                model: "claude-model".to_string(),
                app: Some("claude".to_string()),
            },
            ModelSelection {
                group: "default".to_string(),
                model: "codex-model".to_string(),
                app: Some("codex".to_string()),
            },
            ModelSelection {
                group: "fallback".to_string(),
                model: String::new(),
                app: None,
            },
        ];

        let codex = selections_for_app(&selections, "codex");
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].model, "codex-model");

        let gemini = selections_for_app(&selections, "gemini");
        assert_eq!(gemini.len(), 1);
        assert_eq!(gemini[0].group, "fallback");
        assert_eq!(gemini[0].model, "");
    }
}
