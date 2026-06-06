//! Api-Hub 数据访问层

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::provider::Provider;

use std::cmp::Ordering;
use std::collections::HashSet;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use super::grouping::group_names_with_models;
use super::types::{
    has_plain_api_key, AccountBackupEntry, GroupInfo, ImportReport, ModelCandidateFilter,
    ModelCandidateRow, ModelInfo, ModelMatchInfo, Paged, SiteDetail, SiteFilter, SiteRecord,
    SiteRow, TokenInfo,
};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn groups_to_json(groups: &[String]) -> Result<String, AppError> {
    serde_json::to_string(groups)
        .map_err(|e| AppError::Database(format!("序列化模型分组失败: {e}")))
}

fn groups_from_json(value: String) -> Vec<String> {
    serde_json::from_str(&value).unwrap_or_default()
}

fn apps_to_json(apps: &[String]) -> Result<String, AppError> {
    serde_json::to_string(apps)
        .map_err(|e| AppError::Database(format!("序列化已导入应用失败: {e}")))
}

fn apps_from_json(value: String) -> Vec<String> {
    let mut apps: Vec<String> = serde_json::from_str(&value).unwrap_or_default();
    apps.retain(|app| !app.trim().is_empty());
    apps.sort();
    apps.dedup();
    apps
}

fn normalized_imported_apps(apps: &[String]) -> Vec<String> {
    let mut apps: Vec<String> = apps
        .iter()
        .map(|app| app.trim().to_ascii_lowercase())
        .filter(|app| !app.is_empty())
        .collect();
    apps.sort();
    apps.dedup();
    apps
}

fn normalized_site_domain(value: &str) -> String {
    let trimmed = value.trim();
    if let Ok(parsed) = url::Url::parse(trimmed) {
        if let Some(host) = parsed.host_str() {
            return match parsed.port() {
                Some(port) => format!("{}:{port}", host.to_ascii_lowercase()),
                None => host.to_ascii_lowercase(),
            };
        }
    }

    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    without_scheme
        .split('/')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches(':')
        .to_ascii_lowercase()
}

fn site_type_rank(site_type: &str) -> i32 {
    match site_type.to_ascii_lowercase().as_str() {
        "new-api" | "newapi" | "one-api" | "oneapi" | "one-hub" | "onehub" | "done-hub"
        | "donehub" => 0,
        "sub2api" | "sub2-api" => 1,
        _ => 2,
    }
}

fn sort_direction_desc(direction: Option<&str>) -> bool {
    matches!(
        direction.unwrap_or("asc").to_ascii_lowercase().as_str(),
        "desc"
    )
}

fn with_direction(ordering: Ordering, desc: bool) -> Ordering {
    if desc {
        ordering.reverse()
    } else {
        ordering
    }
}

fn sort_sites(items: &mut [SiteRow], sort_by: Option<&str>, sort_direction: Option<&str>) {
    let sort_by = sort_by.unwrap_or("site_type");
    let desc = sort_direction_desc(sort_direction);

    items.sort_by(|left, right| {
        let primary = match sort_by {
            "site_name" => left.site_name.cmp(&right.site_name),
            "site_url" => left.site_url.cmp(&right.site_url),
            "group_count" => left.group_count.cmp(&right.group_count),
            "model_count" => left.model_count.cmp(&right.model_count),
            "token_count" => left.token_count.cmp(&right.token_count),
            "last_synced_at" => left
                .last_synced_at
                .unwrap_or(0)
                .cmp(&right.last_synced_at.unwrap_or(0)),
            "last_change_at" => left
                .last_change_at
                .unwrap_or(0)
                .cmp(&right.last_change_at.unwrap_or(0)),
            "imported_apps" => left.imported_apps.len().cmp(&right.imported_apps.len()),
            _ => site_type_rank(&left.site_type)
                .cmp(&site_type_rank(&right.site_type))
                .then_with(|| left.site_type.cmp(&right.site_type)),
        };

        with_direction(primary, desc)
            .then_with(|| left.sort_index.cmp(&right.sort_index))
            .then_with(|| left.site_name.cmp(&right.site_name))
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn api_hub_get_groups_on_conn(
    conn: &Connection,
    site_id: &str,
) -> Result<Vec<GroupInfo>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT group_name, ratio, description
         FROM api_hub_groups
         WHERE site_id = ?1
         ORDER BY sort_index ASC, group_name ASC",
    )?;
    let rows = stmt.query_map(params![site_id], |row| {
        Ok(GroupInfo {
            name: row.get(0)?,
            ratio: row.get(1)?,
            description: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn api_hub_get_models_on_conn(
    conn: &Connection,
    site_id: &str,
) -> Result<Vec<ModelInfo>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT model_name, enable_groups
         FROM api_hub_models
         WHERE site_id = ?1
         ORDER BY model_name ASC",
    )?;
    let rows = stmt.query_map(params![site_id], |row| {
        let groups_json: String = row.get(1)?;
        Ok(ModelInfo {
            name: row.get(0)?,
            enable_groups: groups_from_json(groups_json),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn api_hub_get_tokens_on_conn(
    conn: &Connection,
    site_id: &str,
) -> Result<Vec<TokenInfo>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT token_id, name, group_name, key, status, remain_quota, expired_at
         FROM api_hub_tokens
         WHERE site_id = ?1
         ORDER BY token_id ASC",
    )?;
    let rows = stmt.query_map(params![site_id], |row| {
        Ok(TokenInfo {
            id: row.get(0)?,
            name: row.get(1)?,
            group_name: row.get(2)?,
            key: row.get(3)?,
            status: row.get(4)?,
            remain_quota: row.get(5)?,
            expired_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn api_hub_count_groups_with_models_on_conn(
    conn: &Connection,
    site_id: &str,
) -> Result<i64, AppError> {
    let groups = api_hub_get_groups_on_conn(conn, site_id)?;
    let models = api_hub_get_models_on_conn(conn, site_id)?;
    Ok(group_names_with_models(&groups, &models).len() as i64)
}

fn api_hub_model_matches_on_conn(
    conn: &Connection,
    site_id: &str,
    model_search: &str,
) -> Result<Vec<ModelMatchInfo>, AppError> {
    let keyword = model_search.trim().to_lowercase();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }

    let groups = api_hub_get_groups_on_conn(conn, site_id)?;
    let models = api_hub_get_models_on_conn(conn, site_id)?;
    let all_group_names: Vec<String> = groups.into_iter().map(|group| group.name).collect();
    let mut matches = Vec::new();
    for model in models {
        if !model.name.to_lowercase().contains(&keyword) {
            continue;
        }
        matches.push(ModelMatchInfo {
            model_name: model.name,
            groups: if model.enable_groups.is_empty() {
                all_group_names.clone()
            } else {
                model.enable_groups
            },
        });
    }
    Ok(matches)
}

fn site_matches_change_filter(site: &SiteRow, filter: &str) -> bool {
    match filter {
        "changed" => site.last_change_summary.is_some(),
        "needs_review" => site.last_change_summary.is_some() && !site.imported_apps.is_empty(),
        "unsynced" => site.last_synced_at.is_none(),
        "not_aligned" => site.group_count > 0 && !site.is_aligned,
        _ => true,
    }
}

impl Database {
    pub fn api_hub_import_accounts(
        &self,
        accounts: &[AccountBackupEntry],
    ) -> Result<ImportReport, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let mut report = ImportReport {
            new_count: 0,
            update_count: 0,
            skipped: Vec::new(),
        };
        let now = now_ms();

        for (index, account) in accounts.iter().enumerate() {
            if account.id.trim().is_empty()
                || account.site_name.trim().is_empty()
                || account.site_url.trim().is_empty()
                || account.account_info.access_token.trim().is_empty()
            {
                report.skipped.push(format!(
                    "第 {} 条记录缺少 id/site_name/site_url/access_token",
                    index + 1
                ));
                continue;
            }

            let site_domain = normalized_site_domain(&account.site_url);
            let existing_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM api_hub_sites WHERE id = ?1",
                    params![account.id],
                    |row| row.get(0),
                )
                .optional()?
                .or_else(|| {
                    let mut stmt = match tx.prepare("SELECT id, site_url FROM api_hub_sites") {
                        Ok(stmt) => stmt,
                        Err(_) => return None,
                    };
                    let rows = match stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    }) {
                        Ok(rows) => rows,
                        Err(_) => return None,
                    };
                    let sites = rows.filter_map(Result::ok).collect::<Vec<_>>();
                    sites
                        .into_iter()
                        .find(|(_, url)| normalized_site_domain(url) == site_domain)
                        .map(|(id, _)| id)
                });
            let target_id = existing_id.as_deref().unwrap_or(account.id.as_str());

            if existing_id.is_some() {
                report.update_count += 1;
            } else {
                report.new_count += 1;
            }

            tx.execute(
                "INSERT INTO api_hub_sites (
                    id, site_name, site_url, site_type, access_token, user_id, username,
                    exchange_rate, imported_apps, sort_index, notes, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]',
                    COALESCE((SELECT MAX(sort_index) + 1 FROM api_hub_sites), 0),
                    ?9, ?10, ?10
                )
                ON CONFLICT(id) DO UPDATE SET
                    site_name = excluded.site_name,
                    site_url = excluded.site_url,
                    site_type = excluded.site_type,
                    access_token = excluded.access_token,
                    user_id = excluded.user_id,
                    username = excluded.username,
                    exchange_rate = excluded.exchange_rate,
                    notes = excluded.notes,
                    updated_at = excluded.updated_at",
                params![
                    target_id,
                    account.site_name,
                    account.site_url,
                    account.site_type,
                    account.account_info.access_token,
                    account.account_info.id,
                    account.account_info.username,
                    account.exchange_rate.unwrap_or(1.0),
                    account.notes,
                    now,
                ],
            )?;
        }

        tx.commit()?;
        Ok(report)
    }

    pub fn api_hub_list_sites(&self, filter: SiteFilter) -> Result<Paged<SiteRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let search = filter.search.unwrap_or_default().trim().to_lowercase();
        let site_type = filter.site_type.unwrap_or_default().trim().to_lowercase();
        let model_search = filter
            .model_search
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let change_filter = filter
            .change_filter
            .unwrap_or_else(|| "all".to_string())
            .trim()
            .to_lowercase();
        let page = filter.page.max(1);
        let page_size = filter.page_size.clamp(1, 100);
        let offset = ((page - 1) * page_size) as usize;
        let mut clauses = Vec::new();
        let mut query_params = Vec::new();
        if !search.is_empty() {
            clauses.push("(LOWER(s.site_name) LIKE ? OR LOWER(s.site_url) LIKE ?)");
            let like = format!("%{search}%");
            query_params.push(like.clone());
            query_params.push(like);
        }
        if !site_type.is_empty() && site_type != "all" {
            clauses.push("LOWER(s.site_type) = ?");
            query_params.push(site_type);
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let list_sql = format!(
            "SELECT
                s.id, s.site_name, s.site_url, s.site_type, s.exchange_rate, s.username,
                s.imported_apps, s.last_synced_at, s.last_checked_at, s.last_change_at,
                s.last_change_summary, s.last_sync_error, s.sort_index,
                (SELECT COUNT(*) FROM api_hub_models m WHERE m.site_id = s.id) AS model_count,
                (SELECT COUNT(*) FROM api_hub_tokens t WHERE t.site_id = s.id) AS token_count
             FROM api_hub_sites s
             {where_sql}"
        );
        let mut stmt = conn.prepare(&list_sql)?;
        let mapper = |row: &rusqlite::Row<'_>| {
            let imported_apps_json: String = row.get(6)?;
            Ok(SiteRow {
                id: row.get(0)?,
                site_name: row.get(1)?,
                site_url: row.get(2)?,
                site_type: row.get(3)?,
                exchange_rate: row.get(4)?,
                username: row.get(5)?,
                imported_apps: apps_from_json(imported_apps_json),
                last_synced_at: row.get(7)?,
                last_checked_at: row.get(8)?,
                last_change_at: row.get(9)?,
                last_change_summary: row.get(10)?,
                last_sync_error: row.get(11)?,
                sort_index: row.get(12)?,
                group_count: 0,
                aligned_group_count: 0,
                is_aligned: false,
                model_count: row.get(13)?,
                token_count: row.get(14)?,
                model_matches: Vec::new(),
            })
        };

        let mut items = stmt
            .query_map(params_from_iter(query_params.iter()), mapper)?
            .collect::<Result<Vec<_>, _>>()?;
        for item in &mut items {
            item.group_count = api_hub_count_groups_with_models_on_conn(&conn, &item.id)?;
            let groups = api_hub_get_groups_on_conn(&conn, &item.id)?;
            let models = api_hub_get_models_on_conn(&conn, &item.id)?;
            let groups_with_models = group_names_with_models(&groups, &models);
            let tokens = api_hub_get_tokens_on_conn(&conn, &item.id)?;
            let aligned_group_count = tokens
                .into_iter()
                .filter_map(|token| {
                    if !has_plain_api_key(token.key.as_deref()) {
                        return None;
                    }
                    let group = token
                        .group_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|group| !group.is_empty())
                        .or_else(|| {
                            let name = token.name.trim();
                            if groups_with_models.contains(name) {
                                Some(name)
                            } else {
                                None
                            }
                        })?;
                    groups_with_models
                        .contains(group)
                        .then(|| group.to_string())
                })
                .collect::<HashSet<_>>()
                .len() as i64;
            item.aligned_group_count = aligned_group_count;
            item.is_aligned = item.group_count > 0 && aligned_group_count >= item.group_count;
            item.model_matches = api_hub_model_matches_on_conn(&conn, &item.id, &model_search)?;
        }
        if !model_search.is_empty() {
            items.retain(|site| !site.model_matches.is_empty());
        }
        if change_filter != "all" {
            items.retain(|site| site_matches_change_filter(site, &change_filter));
        }
        sort_sites(
            &mut items,
            filter.sort_by.as_deref(),
            filter.sort_direction.as_deref(),
        );
        let total = items.len() as u64;
        let items = items
            .into_iter()
            .skip(offset)
            .take(page_size as usize)
            .collect();

        Ok(Paged {
            items,
            total,
            page,
            page_size,
        })
    }

    pub fn api_hub_get_site_record(&self, site_id: &str) -> Result<SiteRecord, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, site_name, site_url, site_type, access_token, user_id, username,
                    exchange_rate, sort_index, last_synced_at, last_checked_at,
                    last_change_at, last_change_summary, last_sync_error, notes
             FROM api_hub_sites WHERE id = ?1",
            params![site_id],
            |row| {
                Ok(SiteRecord {
                    id: row.get(0)?,
                    site_name: row.get(1)?,
                    site_url: row.get(2)?,
                    site_type: row.get(3)?,
                    access_token: row.get(4)?,
                    user_id: row.get(5)?,
                    username: row.get(6)?,
                    exchange_rate: row.get(7)?,
                    sort_index: row.get(8)?,
                    last_synced_at: row.get(9)?,
                    last_checked_at: row.get(10)?,
                    last_change_at: row.get(11)?,
                    last_change_summary: row.get(12)?,
                    last_sync_error: row.get(13)?,
                    notes: row.get(14)?,
                })
            },
        )
        .map_err(|e| AppError::Database(format!("读取 Api-Hub 站点失败: {e}")))
    }

    pub fn api_hub_get_site_detail(&self, site_id: &str) -> Result<SiteDetail, AppError> {
        let site = self
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: None,
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 10_000,
                ..Default::default()
            })?
            .items
            .into_iter()
            .find(|site| site.id == site_id)
            .ok_or_else(|| AppError::Config(format!("Api-Hub 站点不存在: {site_id}")))?;

        Ok(SiteDetail {
            site,
            groups: self.api_hub_get_groups(site_id)?,
            models: self.api_hub_get_models(site_id)?,
            tokens: self.api_hub_get_tokens(site_id)?,
        })
    }

    pub fn api_hub_get_groups(&self, site_id: &str) -> Result<Vec<GroupInfo>, AppError> {
        let conn = lock_conn!(self.conn);
        api_hub_get_groups_on_conn(&conn, site_id)
    }

    pub fn api_hub_get_models(&self, site_id: &str) -> Result<Vec<ModelInfo>, AppError> {
        let conn = lock_conn!(self.conn);
        api_hub_get_models_on_conn(&conn, site_id)
    }

    pub fn api_hub_get_tokens(&self, site_id: &str) -> Result<Vec<TokenInfo>, AppError> {
        let conn = lock_conn!(self.conn);
        api_hub_get_tokens_on_conn(&conn, site_id)
    }

    pub fn api_hub_replace_cache(
        &self,
        site_id: &str,
        groups: &[GroupInfo],
        models: &[ModelInfo],
        tokens: &[TokenInfo],
        sync_error: Option<&str>,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM api_hub_groups WHERE site_id = ?1",
            params![site_id],
        )?;
        tx.execute(
            "DELETE FROM api_hub_models WHERE site_id = ?1",
            params![site_id],
        )?;
        tx.execute(
            "DELETE FROM api_hub_tokens WHERE site_id = ?1",
            params![site_id],
        )?;

        for (index, group) in groups.iter().enumerate() {
            tx.execute(
                "INSERT INTO api_hub_groups (site_id, group_name, ratio, description, sort_index)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    site_id,
                    group.name,
                    group.ratio,
                    group.description,
                    index as i64
                ],
            )?;
        }

        for model in models {
            tx.execute(
                "INSERT INTO api_hub_models (site_id, model_name, enable_groups)
                 VALUES (?1, ?2, ?3)",
                params![site_id, model.name, groups_to_json(&model.enable_groups)?],
            )?;
        }

        let now = now_ms();
        for token in tokens {
            tx.execute(
                "INSERT INTO api_hub_tokens
                    (site_id, token_id, name, group_name, key, status, remain_quota, expired_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    site_id,
                    token.id,
                    token.name,
                    token.group_name,
                    token.key,
                    token.status,
                    token.remain_quota,
                    token.expired_at,
                    now,
                ],
            )?;
        }

        tx.execute(
            "UPDATE api_hub_sites
             SET last_synced_at = ?1, last_checked_at = ?1, last_sync_error = ?2, updated_at = ?1
             WHERE id = ?3",
            params![now, sync_error, site_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn api_hub_set_check_result(
        &self,
        site_id: &str,
        change_summary: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let now = now_ms();
        let change_at: Option<i64> = change_summary.map(|_| now);
        conn.execute(
            "UPDATE api_hub_sites
             SET last_checked_at = ?1,
                 last_change_at = CASE WHEN ?2 IS NULL THEN last_change_at ELSE ?2 END,
                 last_change_summary = ?3,
                 updated_at = ?1
             WHERE id = ?4",
            params![now, change_at, change_summary, site_id],
        )?;
        Ok(())
    }

    pub fn api_hub_set_sync_error(
        &self,
        site_id: &str,
        error: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let now = now_ms();
        conn.execute(
            "UPDATE api_hub_sites SET last_sync_error = ?1, updated_at = ?2 WHERE id = ?3",
            params![error, now, site_id],
        )?;
        Ok(())
    }

    pub fn api_hub_clear_all(&self) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM api_hub_tokens", [])?;
        tx.execute("DELETE FROM api_hub_models", [])?;
        tx.execute("DELETE FROM api_hub_groups", [])?;
        tx.execute("DELETE FROM api_hub_sites", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn api_hub_delete_site(&self, site_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("DELETE FROM api_hub_sites WHERE id = ?1", params![site_id])?;
        Ok(())
    }

    pub fn api_hub_mark_site_imported_apps(
        &self,
        site_id: &str,
        apps: &[String],
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let current_json: String = conn
            .query_row(
                "SELECT imported_apps FROM api_hub_sites WHERE id = ?1",
                params![site_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Config(format!("Api-Hub 站点不存在: {site_id}")))?;
        let mut current = apps_from_json(current_json);
        current.extend(normalized_imported_apps(apps));
        current = normalized_imported_apps(&current);
        conn.execute(
            "UPDATE api_hub_sites SET imported_apps = ?1, updated_at = ?2 WHERE id = ?3",
            params![apps_to_json(&current)?, now_ms(), site_id],
        )?;
        Ok(())
    }

    pub fn api_hub_clear_site_imported_apps(&self, site_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE api_hub_sites SET imported_apps = '[]', updated_at = ?1 WHERE id = ?2",
            params![now_ms(), site_id],
        )?;
        Ok(())
    }

    pub fn api_hub_list_provider_origins_for_site(
        &self,
        site_id: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        let conn = lock_conn!(self.conn);
        let origin_prefix = format!("{site_id}:%");
        let mut stmt = conn.prepare(
            "SELECT app_type, id
             FROM providers
             WHERE api_hub_origin LIKE ?1
             ORDER BY app_type ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![origin_prefix], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn api_hub_find_token_for_group(
        &self,
        site_id: &str,
        group: &str,
    ) -> Result<Option<TokenInfo>, AppError> {
        let conn = lock_conn!(self.conn);
        let target = group.trim();
        let mut tokens: Vec<TokenInfo> = api_hub_get_tokens_on_conn(&conn, site_id)?
            .into_iter()
            .filter(|token| {
                token.group_name.as_deref().map(str::trim) == Some(target)
                    || (token.group_name.is_none() && token.name.trim() == target)
            })
            .collect();
        tokens.sort_by_key(|token| {
            (
                !has_plain_api_key(token.key.as_deref()),
                token.name.trim() != target,
                token.id,
            )
        });
        Ok(tokens.into_iter().next())
    }

    pub fn api_hub_list_model_candidates(
        &self,
        filter: ModelCandidateFilter,
    ) -> Result<Vec<ModelCandidateRow>, AppError> {
        let site_ids: HashSet<String> = filter
            .site_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        let keyword = filter
            .model_search
            .unwrap_or_default()
            .trim()
            .to_lowercase();

        let sites = self
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: filter.site_type,
                model_search: None,
                change_filter: None,
                sort_by: Some("site_type".to_string()),
                sort_direction: Some("asc".to_string()),
                page: 1,
                page_size: 10_000,
            })?
            .items;

        let mut rows = Vec::new();
        for site in sites {
            if !site_ids.is_empty() && !site_ids.contains(&site.id) {
                continue;
            }

            let groups = self.api_hub_get_groups(&site.id)?;
            if groups.is_empty() {
                continue;
            }
            let models = self.api_hub_get_models(&site.id)?;
            let tokens = self.api_hub_get_tokens(&site.id)?;
            let keyed_groups: HashSet<String> = tokens
                .into_iter()
                .filter_map(|token| {
                    let group = token.group_name?;
                    if token.name != group || !has_plain_api_key(token.key.as_deref()) {
                        return None;
                    }
                    Some(group)
                })
                .collect();
            let all_group_names: Vec<String> =
                groups.iter().map(|group| group.name.clone()).collect();

            for model in models {
                let model_matches =
                    keyword.is_empty() || model.name.to_lowercase().contains(&keyword);
                let enabled_groups = if model.enable_groups.is_empty() {
                    all_group_names.clone()
                } else {
                    model.enable_groups.clone()
                };
                let enabled_set: HashSet<&str> =
                    enabled_groups.iter().map(String::as_str).collect();

                for group in &groups {
                    if !enabled_set.contains(group.name.as_str()) {
                        continue;
                    }
                    let group_matches =
                        keyword.is_empty() || group.name.to_lowercase().contains(&keyword);
                    if !model_matches && !group_matches {
                        continue;
                    }
                    let has_api_key = keyed_groups.contains(&group.name);
                    rows.push(ModelCandidateRow {
                        site_id: site.id.clone(),
                        site_name: site.site_name.clone(),
                        site_url: site.site_url.clone(),
                        site_type: site.site_type.clone(),
                        imported_apps: site.imported_apps.clone(),
                        group: group.name.clone(),
                        model: model.name.clone(),
                        ratio: group.ratio,
                        has_api_key,
                        is_aligned: has_api_key,
                    });
                }
            }
        }

        rows.sort_by(|left, right| {
            site_type_rank(&left.site_type)
                .cmp(&site_type_rank(&right.site_type))
                .then_with(|| left.site_name.cmp(&right.site_name))
                .then_with(|| left.group.cmp(&right.group))
                .then_with(|| left.model.cmp(&right.model))
        });
        Ok(rows)
    }

    pub fn api_hub_save_provider_origin(
        &self,
        app_type: &str,
        provider: &Provider,
        origin: &str,
    ) -> Result<bool, AppError> {
        let existed = self.get_provider_by_id(&provider.id, app_type)?.is_some();
        self.save_provider(app_type, provider)?;
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE providers SET api_hub_origin = ?1 WHERE id = ?2 AND app_type = ?3",
            params![origin, provider.id, app_type],
        )?;
        Ok(existed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn backup_account(id: &str, site_name: &str) -> AccountBackupEntry {
        backup_account_with_type(id, site_name, "new-api")
    }

    fn backup_account_with_type(id: &str, site_name: &str, site_type: &str) -> AccountBackupEntry {
        AccountBackupEntry {
            id: id.to_string(),
            site_name: site_name.to_string(),
            site_url: format!("https://{id}.example.com"),
            site_type: site_type.to_string(),
            exchange_rate: Some(1.0),
            account_info: super::super::types::AccountInfoEntry {
                id: Some(1),
                access_token: "test-token".to_string(),
                username: Some("tester".to_string()),
            },
            notes: None,
        }
    }

    #[test]
    fn api_hub_import_then_list_sites_without_search_returns_rows() {
        let db = Database::memory().expect("memory database");
        let report = db
            .api_hub_import_accounts(&[backup_account("site-1", "Site One")])
            .expect("import accounts");

        assert_eq!(report.new_count, 1);

        let page = db
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: None,
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 20,
                ..Default::default()
            })
            .expect("list sites");

        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "site-1");
        assert_eq!(page.items[0].site_name, "Site One");
    }

    #[test]
    fn api_hub_import_updates_existing_site_with_same_domain() {
        let db = Database::memory().expect("memory database");
        db.api_hub_import_accounts(&[backup_account_with_type("site-old", "Old Hub", "new-api")])
            .expect("import first account");

        let mut next = backup_account_with_type("site-new", "Renamed Hub", "sub2api");
        next.site_url = "https://site-old.example.com/".to_string();
        next.account_info.access_token = "updated-token".to_string();
        next.account_info.username = Some("updated-user".to_string());

        let report = db
            .api_hub_import_accounts(&[next])
            .expect("import same domain account");

        assert_eq!(report.new_count, 0);
        assert_eq!(report.update_count, 1);

        let page = db
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: None,
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 20,
                ..Default::default()
            })
            .expect("list sites");

        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "site-old");
        assert_eq!(page.items[0].site_name, "Renamed Hub");
        assert_eq!(page.items[0].site_type, "sub2api");

        let record = db
            .api_hub_get_site_record("site-old")
            .expect("read updated site");
        assert_eq!(record.access_token, "updated-token");
        assert_eq!(record.username.as_deref(), Some("updated-user"));
    }

    #[test]
    fn api_hub_list_sites_filters_by_site_type() {
        let db = Database::memory().expect("memory database");
        db.api_hub_import_accounts(&[
            backup_account_with_type("site-new", "New API Hub", "new-api"),
            backup_account_with_type("site-sub", "Sub2Api Hub", "sub2api"),
        ])
        .expect("import accounts");

        let page = db
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: Some("sub2api".to_string()),
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 20,
                ..Default::default()
            })
            .expect("list filtered sites");

        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "site-sub");
        assert_eq!(page.items[0].site_type, "sub2api");
    }

    #[test]
    fn api_hub_list_model_candidates_expands_models_by_group_and_key_status() {
        let db = Database::memory().expect("memory database");
        db.api_hub_import_accounts(&[backup_account("site-1", "Site One")])
            .expect("import account");
        db.api_hub_replace_cache(
            "site-1",
            &[
                GroupInfo {
                    name: "default".to_string(),
                    ratio: Some(1.0),
                    description: None,
                },
                GroupInfo {
                    name: "vip".to_string(),
                    ratio: Some(2.5),
                    description: None,
                },
            ],
            &[
                ModelInfo {
                    name: "claude-opus-4-7".to_string(),
                    enable_groups: vec!["default".to_string(), "vip".to_string()],
                },
                ModelInfo {
                    name: "gpt-5".to_string(),
                    enable_groups: vec!["default".to_string()],
                },
            ],
            &[
                TokenInfo {
                    id: 1,
                    name: "default".to_string(),
                    group_name: Some("default".to_string()),
                    key: Some("sk-default".to_string()),
                    status: Some(1),
                    remain_quota: None,
                    expired_at: None,
                },
                TokenInfo {
                    id: 2,
                    name: "vip".to_string(),
                    group_name: Some("vip".to_string()),
                    key: Some("sk-abcd********wxyz".to_string()),
                    status: Some(1),
                    remain_quota: None,
                    expired_at: None,
                },
            ],
            None,
        )
        .expect("replace cache");

        let rows = db
            .api_hub_list_model_candidates(super::super::types::ModelCandidateFilter {
                site_ids: vec!["site-1".to_string()],
                model_search: Some("opus".to_string()),
                site_type: None,
            })
            .expect("list candidates");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].group, "default");
        assert_eq!(rows[0].model, "claude-opus-4-7");
        assert_eq!(rows[0].ratio, Some(1.0));
        assert!(rows[0].has_api_key);
        assert_eq!(rows[1].group, "vip");
        assert_eq!(rows[1].ratio, Some(2.5));
        assert!(!rows[1].has_api_key);
    }

    #[test]
    fn api_hub_list_sites_counts_only_groups_with_models() {
        let db = Database::memory().expect("memory database");
        db.api_hub_import_accounts(&[backup_account("site-1", "Site One")])
            .expect("import accounts");

        db.api_hub_replace_cache(
            "site-1",
            &[
                GroupInfo {
                    name: "with-model".to_string(),
                    ratio: Some(1.0),
                    description: None,
                },
                GroupInfo {
                    name: "empty".to_string(),
                    ratio: Some(2.0),
                    description: None,
                },
            ],
            &[ModelInfo {
                name: "gpt-5".to_string(),
                enable_groups: vec!["with-model".to_string()],
            }],
            &[],
            None,
        )
        .expect("replace cache");

        let page = db
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: None,
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 20,
                ..Default::default()
            })
            .expect("list sites");

        assert_eq!(page.items[0].group_count, 1);
        assert_eq!(page.items[0].model_count, 1);
    }

    #[test]
    fn api_hub_list_sites_does_not_count_masked_keys_as_aligned() {
        let db = Database::memory().expect("memory database");
        db.api_hub_import_accounts(&[backup_account("site-1", "Site One")])
            .expect("import accounts");

        db.api_hub_replace_cache(
            "site-1",
            &[GroupInfo {
                name: "default".to_string(),
                ratio: Some(1.0),
                description: None,
            }],
            &[ModelInfo {
                name: "gpt-5".to_string(),
                enable_groups: vec!["default".to_string()],
            }],
            &[TokenInfo {
                id: 10,
                name: "default".to_string(),
                group_name: Some("default".to_string()),
                key: Some("sk-****".to_string()),
                status: Some(1),
                remain_quota: None,
                expired_at: Some(-1),
            }],
            None,
        )
        .expect("replace cache");

        let page = db
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: None,
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 20,
                ..Default::default()
            })
            .expect("list sites");

        assert_eq!(page.items[0].group_count, 1);
        assert_eq!(page.items[0].aligned_group_count, 0);
        assert!(!page.items[0].is_aligned);
    }

    #[test]
    fn api_hub_list_sites_defaults_new_api_before_sub2api() {
        let db = Database::memory().expect("memory database");
        db.api_hub_import_accounts(&[
            backup_account_with_type("site-sub", "Sub2Api Hub", "sub2api"),
            backup_account_with_type("site-new", "New API Hub", "new-api"),
            backup_account_with_type("site-one", "One Hub", "one-hub"),
            backup_account_with_type("site-done", "Done Hub", "done-hub"),
            backup_account_with_type("site-other", "Other Hub", "custom"),
        ])
        .expect("import accounts");

        let page = db
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: None,
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 20,
                ..Default::default()
            })
            .expect("list sites");

        let ids: Vec<_> = page.items.into_iter().map(|site| site.id).collect();
        assert_eq!(
            ids,
            vec![
                "site-done",
                "site-new",
                "site-one",
                "site-sub",
                "site-other"
            ]
        );
    }

    #[test]
    fn api_hub_list_sites_counts_unique_aligned_groups() {
        let db = Database::memory().expect("memory database");
        db.api_hub_import_accounts(&[backup_account("site-1", "Site One")])
            .expect("import accounts");

        db.api_hub_replace_cache(
            "site-1",
            &[GroupInfo {
                name: "default".to_string(),
                ratio: Some(1.0),
                description: None,
            }],
            &[ModelInfo {
                name: "gpt-5".to_string(),
                enable_groups: vec!["default".to_string()],
            }],
            &[
                TokenInfo {
                    id: 10,
                    name: "default".to_string(),
                    group_name: Some("default".to_string()),
                    key: Some("sk-one".to_string()),
                    status: Some(1),
                    remain_quota: None,
                    expired_at: Some(-1),
                },
                TokenInfo {
                    id: 11,
                    name: "another-name".to_string(),
                    group_name: Some("default".to_string()),
                    key: Some("sk-two".to_string()),
                    status: Some(1),
                    remain_quota: None,
                    expired_at: Some(-1),
                },
            ],
            None,
        )
        .expect("replace cache");

        let page = db
            .api_hub_list_sites(SiteFilter {
                search: None,
                site_type: None,
                sort_by: None,
                sort_direction: None,
                page: 1,
                page_size: 20,
                ..Default::default()
            })
            .expect("list sites");

        assert_eq!(page.items[0].group_count, 1);
        assert_eq!(page.items[0].aligned_group_count, 1);
        assert!(page.items[0].is_aligned);
    }
}
