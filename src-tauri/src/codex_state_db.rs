//! Locating Codex's per-thread state SQLite databases.
//!
//! Codex stores thread metadata in `state_5.sqlite`, normally inside the Codex
//! config dir (`CODEX_HOME` / `~/.codex`). The SQLite location can be moved with
//! the `sqlite_home` key in `config.toml` or the `CODEX_SQLITE_HOME` env var;
//! when set, a second DB lives there. Both history migration and the session
//! list's title lookup need the same resolution, so it lives here once.

use std::path::{Path, PathBuf};

use toml_edit::DocumentMut;

use crate::config::get_home_dir;

/// Filename of Codex's per-thread state database. Codex bumps the version
/// number across releases; update this single source of truth when a new state
/// DB version ships.
pub(crate) const CODEX_STATE_DB_FILENAME: &str = "state_5.sqlite";

/// Env var that overrides the Codex SQLite state directory.
const CODEX_SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";

/// Resolve every candidate `state_5.sqlite` path: the config-dir DB plus, when
/// Codex is configured to keep its SQLite state elsewhere, that DB too.
///
/// `config_dir` is the Codex config dir (`~/.codex`); `config_text` is the raw
/// `config.toml` contents, used to detect a `sqlite_home` override.
pub(crate) fn codex_state_db_paths(config_dir: &Path, config_text: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    push_unique_path(&mut paths, config_dir.join(CODEX_STATE_DB_FILENAME));
    // Codex lets SQLite state move away from CODEX_HOME; config takes precedence.
    if let Some(sqlite_home) = sqlite_home_from_codex_config(config_text) {
        push_unique_path(&mut paths, sqlite_home.join(CODEX_STATE_DB_FILENAME));
    } else if let Some(sqlite_home) = sqlite_home_from_env() {
        push_unique_path(&mut paths, sqlite_home.join(CODEX_STATE_DB_FILENAME));
    }
    paths
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

fn sqlite_home_from_codex_config(config_text: &str) -> Option<PathBuf> {
    if let Ok(doc) = config_text.parse::<DocumentMut>() {
        if let Some(raw) = doc.get("sqlite_home").and_then(|item| item.as_str()) {
            let raw = raw.trim();
            if !raw.is_empty() {
                return Some(resolve_user_path(raw));
            }
        }
    }

    let raw = top_level_toml_string_value(config_text, "sqlite_home")?;
    if raw.is_empty() {
        return None;
    }
    Some(resolve_user_path(&raw))
}

fn top_level_toml_string_value(config_text: &str, key: &str) -> Option<String> {
    for line in config_text.lines() {
        let line = line.trim_start();
        if line.starts_with('[') {
            break;
        }

        let Some((candidate_key, value)) = line.split_once('=') else {
            continue;
        };
        if candidate_key.trim() != key {
            continue;
        }

        let raw = lenient_toml_string_value(value.trim())?.trim().to_string();
        if !raw.is_empty() {
            return Some(raw);
        }
    }

    None
}

fn lenient_toml_string_value(value: &str) -> Option<&str> {
    let quote = value.chars().next()?;
    if quote == '"' || quote == '\'' {
        let rest = &value[quote.len_utf8()..];
        let end = rest.find(quote)?;
        return Some(&rest[..end]);
    }

    Some(value.split('#').next().unwrap_or(value).trim())
}

fn sqlite_home_from_env() -> Option<PathBuf> {
    let raw = std::env::var(CODEX_SQLITE_HOME_ENV).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    Some(resolve_user_path(raw))
}

fn resolve_user_path(raw: &str) -> PathBuf {
    if raw == "~" {
        return get_home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return get_home_dir().join(rest);
    }
    if let Some(rest) = raw.strip_prefix("~\\") {
        return get_home_dir().join(rest);
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn includes_config_sqlite_home() {
        let temp = tempdir().expect("tempdir");
        let sqlite_home = temp.path().join("sqlite-home");
        // 用 TOML 字面量字符串(单引号)承载路径：Windows 路径含反斜杠，basic string(双引号)
        // 会把 `\U`/`\s` 等当作非法转义导致解析失败。
        let config_text = format!("sqlite_home = '{}'\n", sqlite_home.display());

        let paths = codex_state_db_paths(temp.path(), &config_text);

        assert_eq!(
            paths,
            vec![
                temp.path().join(CODEX_STATE_DB_FILENAME),
                sqlite_home.join(CODEX_STATE_DB_FILENAME),
            ]
        );
    }

    #[test]
    fn config_sqlite_home_accepts_raw_windows_backslashes() {
        let config_dir = PathBuf::from(r"C:\Users\tester\.codex");
        let config_text = r#"sqlite_home = "C:\Users\tester\AppData\Local\Codex State""#;

        let paths = codex_state_db_paths(&config_dir, config_text);

        assert_eq!(
            paths,
            vec![
                config_dir.join(CODEX_STATE_DB_FILENAME),
                PathBuf::from(r"C:\Users\tester\AppData\Local\Codex State")
                    .join(CODEX_STATE_DB_FILENAME),
            ]
        );
    }
}
