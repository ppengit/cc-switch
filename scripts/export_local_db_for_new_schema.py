from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = Path.home() / ".cc-switch" / "cc-switch.db"
OUTPUT_ROOT = ROOT / "exports"

CODEX_MCP_SECTION_RE = re.compile(r"^\s*\[(?P<header>[^\]]+)\]\s*(?:#.*)?$")
CODEX_INLINE_MCP_RE = re.compile(r"^\s*mcp_servers\s*=")
CODEX_INLINE_MCP_SERVERS_IN_MCP_RE = re.compile(r"^\s*servers\s*=")


def sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def normalize_line_endings(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def collapse_blank_lines(text: str, keep_trailing_newline: bool) -> str:
    normalized = normalize_line_endings(text)
    out: list[str] = []
    blank_run = 0
    for raw_line in normalized.split("\n"):
        line = raw_line.rstrip()
        if not line.strip():
            blank_run += 1
            if blank_run > 1:
                continue
        else:
            blank_run = 0
        out.append(line)
    joined = "\n".join(out).strip()
    if not joined:
        return ""
    return f"{joined}\n" if keep_trailing_newline else joined


def strip_codex_mcp_sections(text: str, keep_trailing_newline: bool) -> str:
    normalized = normalize_line_endings(text)
    current_section: str | None = None
    skipping_section = False
    out: list[str] = []

    for line in normalized.split("\n"):
        match = CODEX_MCP_SECTION_RE.match(line)
        if match:
            current_section = match.group("header").strip()
            skipping_section = current_section.startswith(
                "mcp_servers",
            ) or current_section.startswith("mcp.servers")
            if skipping_section:
                continue

        if skipping_section:
            continue

        if CODEX_INLINE_MCP_RE.match(line):
            continue
        if current_section == "mcp" and CODEX_INLINE_MCP_SERVERS_IN_MCP_RE.match(line):
            continue

        out.append(line)

    return collapse_blank_lines("\n".join(out), keep_trailing_newline)


def clean_codex_provider_settings(raw_settings: str) -> tuple[str, bool]:
    try:
        settings = json.loads(raw_settings)
    except json.JSONDecodeError:
        return raw_settings, False

    if not isinstance(settings, dict):
        return raw_settings, False

    config_text = settings.get("config")
    if not isinstance(config_text, str):
        return raw_settings, False

    cleaned_config = strip_codex_mcp_sections(config_text, keep_trailing_newline=True)
    if cleaned_config == config_text:
        return raw_settings, False

    settings["config"] = cleaned_config
    return json.dumps(settings, ensure_ascii=False, separators=(",", ":")), True


def clean_codex_common_setting(value: str) -> tuple[str | None, bool]:
    cleaned = strip_codex_mcp_sections(value, keep_trailing_newline=False)
    if not cleaned:
        return None, True
    return cleaned, cleaned != value


def fetch_rows(conn: sqlite3.Connection, table: str, order_by: str | None = None):
    sql = f"SELECT * FROM {table}"
    if order_by:
        sql += f" ORDER BY {order_by}"
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(sql).fetchall()]


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def build_insert_sql(table: str, columns: list[str], rows: list[dict]) -> list[str]:
    if not rows:
        return []

    column_sql = ", ".join(columns)
    statements = []
    for row in rows:
        values_sql = ", ".join(sql_literal(row.get(column)) for column in columns)
        statements.append(
            f"INSERT OR REPLACE INTO {table} ({column_sql}) VALUES ({values_sql});",
        )
    return statements


def main():
    if not DEFAULT_DB_PATH.exists():
        raise SystemExit(f"Source database not found: {DEFAULT_DB_PATH}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = OUTPUT_ROOT / f"local-db-export-{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(DEFAULT_DB_PATH)
    conn.row_factory = sqlite3.Row

    current_provider_by_app = {
        row["app_type"]: row["id"]
        for row in conn.execute(
            "SELECT app_type, id FROM providers WHERE is_current = 1 ORDER BY app_type, id",
        ).fetchall()
    }

    report: dict[str, object] = {
        "source_db": str(DEFAULT_DB_PATH),
        "generated_at": datetime.now().isoformat(),
        "cleanups": {
            "codex_provider_configs_removed_mcp": 0,
            "codex_common_config_removed_mcp": False,
            "codex_common_config_removed_entirely": False,
        },
        "included_tables": {},
        "excluded_runtime_tables": {},
        "unsupported_legacy_tables": {},
    }

    sql_lines: list[str] = [
        "-- CC Switch data import for fresh schema v9",
        "-- Generated automatically from the existing local database",
        "BEGIN IMMEDIATE;",
    ]

    providers_rows = fetch_rows(conn, "providers", "app_type, sort_index, created_at, id")
    cleaned_provider_rows = []
    for row in providers_rows:
        cleaned = dict(row)
        if cleaned.get("app_type") == "codex" and isinstance(
            cleaned.get("settings_config"),
            str,
        ):
            new_settings, changed = clean_codex_provider_settings(cleaned["settings_config"])
            cleaned["settings_config"] = new_settings
            if changed:
                report["cleanups"]["codex_provider_configs_removed_mcp"] += 1
        cleaned_provider_rows.append(cleaned)

    sql_lines.extend(
        build_insert_sql(
            "providers",
            [
                "id",
                "app_type",
                "name",
                "settings_config",
                "website_url",
                "category",
                "created_at",
                "sort_index",
                "notes",
                "icon",
                "icon_color",
                "meta",
                "is_current",
                "in_failover_queue",
                "cost_multiplier",
                "limit_daily_usd",
                "limit_monthly_usd",
                "provider_type",
            ],
            cleaned_provider_rows,
        ),
    )
    report["included_tables"]["providers"] = len(cleaned_provider_rows)

    if table_exists(conn, "provider_endpoints"):
        rows = fetch_rows(conn, "provider_endpoints", "id")
        sql_lines.extend(
            build_insert_sql(
                "provider_endpoints",
                ["id", "provider_id", "app_type", "url", "added_at"],
                rows,
            ),
        )
        report["included_tables"]["provider_endpoints"] = len(rows)

    if table_exists(conn, "mcp_servers"):
        rows = fetch_rows(conn, "mcp_servers", "id")
        sql_lines.extend(
            build_insert_sql(
                "mcp_servers",
                [
                    "id",
                    "name",
                    "server_config",
                    "description",
                    "homepage",
                    "docs",
                    "tags",
                    "enabled_claude",
                    "enabled_codex",
                    "enabled_gemini",
                    "enabled_opencode",
                ],
                rows,
            ),
        )
        report["included_tables"]["mcp_servers"] = len(rows)

    if table_exists(conn, "prompts"):
        rows = fetch_rows(conn, "prompts", "app_type, id")
        sql_lines.extend(
            build_insert_sql(
                "prompts",
                [
                    "id",
                    "app_type",
                    "name",
                    "content",
                    "description",
                    "enabled",
                    "created_at",
                    "updated_at",
                ],
                rows,
            ),
        )
        report["included_tables"]["prompts"] = len(rows)

    if table_exists(conn, "skills"):
        rows = fetch_rows(conn, "skills", "id")
        sql_lines.extend(
            build_insert_sql(
                "skills",
                [
                    "id",
                    "name",
                    "description",
                    "directory",
                    "repo_owner",
                    "repo_name",
                    "repo_branch",
                    "readme_url",
                    "enabled_claude",
                    "enabled_codex",
                    "enabled_gemini",
                    "enabled_opencode",
                    "installed_at",
                ],
                rows,
            ),
        )
        report["included_tables"]["skills"] = len(rows)

    if table_exists(conn, "skill_repos"):
        rows = fetch_rows(conn, "skill_repos", "owner, name")
        sql_lines.extend(
            build_insert_sql(
                "skill_repos",
                ["owner", "name", "branch", "enabled"],
                rows,
            ),
        )
        report["included_tables"]["skill_repos"] = len(rows)

    if table_exists(conn, "settings"):
        rows = fetch_rows(conn, "settings", "key")
        filtered_rows = []
        for row in rows:
            key = row["key"]
            value = row["value"]
            if key in {"common_config_legacy_migrated_v1", "skills_ssot_migration_pending"}:
                continue
            if key.startswith("proxy_takeover_"):
                continue
            if key == "common_config_codex" and isinstance(value, str):
                cleaned_value, changed = clean_codex_common_setting(value)
                if changed:
                    report["cleanups"]["codex_common_config_removed_mcp"] = True
                if cleaned_value is None:
                    report["cleanups"]["codex_common_config_removed_entirely"] = True
                    continue
                row = {"key": key, "value": cleaned_value}
            filtered_rows.append(row)

        sql_lines.extend(
            build_insert_sql(
                "settings",
                ["key", "value"],
                filtered_rows,
            ),
        )
        report["included_tables"]["settings"] = len(filtered_rows)

    if table_exists(conn, "proxy_config"):
        rows = fetch_rows(conn, "proxy_config", "app_type")
        mapped_rows = []
        for row in rows:
            mapped_rows.append(
                {
                    "app_type": row.get("app_type"),
                    "proxy_enabled": row.get("proxy_enabled", 0),
                    "listen_address": row.get("listen_address", "127.0.0.1"),
                    "listen_port": row.get("listen_port", 15721),
                    "enable_logging": row.get("enable_logging", 1),
                    "enabled": row.get("enabled", 0),
                    "auto_failover_enabled": row.get("auto_failover_enabled", 0),
                    "max_retries": row.get("max_retries", 3),
                    "streaming_first_byte_timeout": row.get("streaming_first_byte_timeout", 60),
                    "streaming_idle_timeout": row.get("streaming_idle_timeout", 120),
                    "non_streaming_timeout": row.get("non_streaming_timeout", 600),
                    "circuit_failure_threshold": row.get("circuit_failure_threshold", 4),
                    "circuit_success_threshold": row.get("circuit_success_threshold", 2),
                    "circuit_timeout_seconds": row.get("circuit_timeout_seconds", 60),
                    "circuit_error_rate_threshold": row.get("circuit_error_rate_threshold", 0.6),
                    "circuit_min_requests": row.get("circuit_min_requests", 10),
                    "default_cost_multiplier": row.get("default_cost_multiplier", "1"),
                    "pricing_model_source": row.get("pricing_model_source", "response"),
                    "force_model_enabled": row.get("force_model_enabled", 0),
                    "force_model": row.get("force_model", ""),
                    "session_routing_enabled": row.get("session_routing_enabled", 0),
                    "session_routing_strategy": row.get("session_routing_strategy", "priority"),
                    "session_default_provider_id": current_provider_by_app.get(
                        row.get("app_type"),
                        "",
                    ),
                    "session_max_sessions_per_provider": row.get(
                        "session_max_sessions_per_provider",
                        1,
                    ),
                    "session_allow_shared_when_exhausted": row.get(
                        "session_allow_shared_when_exhausted",
                        1,
                    ),
                    "session_idle_ttl_minutes": row.get("session_idle_ttl_minutes", 30),
                    "created_at": row.get("created_at"),
                    "updated_at": row.get("updated_at"),
                },
            )

        sql_lines.extend(
            build_insert_sql(
                "proxy_config",
                [
                    "app_type",
                    "proxy_enabled",
                    "listen_address",
                    "listen_port",
                    "enable_logging",
                    "enabled",
                    "auto_failover_enabled",
                    "max_retries",
                    "streaming_first_byte_timeout",
                    "streaming_idle_timeout",
                    "non_streaming_timeout",
                    "circuit_failure_threshold",
                    "circuit_success_threshold",
                    "circuit_timeout_seconds",
                    "circuit_error_rate_threshold",
                    "circuit_min_requests",
                    "default_cost_multiplier",
                    "pricing_model_source",
                    "force_model_enabled",
                    "force_model",
                    "session_routing_enabled",
                    "session_routing_strategy",
                    "session_default_provider_id",
                    "session_max_sessions_per_provider",
                    "session_allow_shared_when_exhausted",
                    "session_idle_ttl_minutes",
                    "created_at",
                    "updated_at",
                ],
                mapped_rows,
            ),
        )
        report["included_tables"]["proxy_config"] = len(mapped_rows)

    if table_exists(conn, "model_pricing"):
        rows = fetch_rows(conn, "model_pricing", "model_id")
        sql_lines.extend(
            build_insert_sql(
                "model_pricing",
                [
                    "model_id",
                    "display_name",
                    "input_cost_per_million",
                    "output_cost_per_million",
                    "cache_read_cost_per_million",
                    "cache_creation_cost_per_million",
                ],
                rows,
            ),
        )
        report["included_tables"]["model_pricing"] = len(rows)

    if table_exists(conn, "proxy_request_logs"):
        rows = fetch_rows(conn, "proxy_request_logs", "created_at, request_id")
        sql_lines.extend(
            build_insert_sql(
                "proxy_request_logs",
                [
                    "request_id",
                    "provider_id",
                    "app_type",
                    "model",
                    "request_model",
                    "input_tokens",
                    "output_tokens",
                    "cache_read_tokens",
                    "cache_creation_tokens",
                    "input_cost_usd",
                    "output_cost_usd",
                    "cache_read_cost_usd",
                    "cache_creation_cost_usd",
                    "total_cost_usd",
                    "latency_ms",
                    "first_token_ms",
                    "duration_ms",
                    "status_code",
                    "error_message",
                    "session_id",
                    "session_routing_active",
                    "provider_type",
                    "is_streaming",
                    "cost_multiplier",
                    "created_at",
                ],
                rows,
            ),
        )
        report["included_tables"]["proxy_request_logs"] = len(rows)

    if table_exists(conn, "stream_check_logs"):
        rows = fetch_rows(conn, "stream_check_logs", "tested_at, id")
        sql_lines.extend(
            build_insert_sql(
                "stream_check_logs",
                [
                    "id",
                    "provider_id",
                    "provider_name",
                    "app_type",
                    "status",
                    "success",
                    "message",
                    "response_time_ms",
                    "http_status",
                    "model_used",
                    "retry_count",
                    "tested_at",
                ],
                rows,
            ),
        )
        report["included_tables"]["stream_check_logs"] = len(rows)

    sql_lines.append("COMMIT;")

    excluded_runtime_tables = [
        "provider_health",
        "session_provider_bindings",
        "proxy_live_backup",
    ]
    excluded_runtime_data = {}
    for table in excluded_runtime_tables:
        if table_exists(conn, table):
            rows = fetch_rows(conn, table)
            excluded_runtime_data[table] = rows
            report["excluded_runtime_tables"][table] = len(rows)

    unsupported_tables = ["usage_daily_rollups"]
    unsupported_data = {}
    for table in unsupported_tables:
        if table_exists(conn, table):
            rows = fetch_rows(conn, table)
            unsupported_data[table] = rows
            report["unsupported_legacy_tables"][table] = len(rows)

    (output_dir / "import_clean_v9.sql").write_text(
        "\n".join(sql_lines) + "\n",
        encoding="utf-8",
    )
    (output_dir / "excluded_runtime_state.json").write_text(
        json.dumps(excluded_runtime_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "unsupported_legacy_tables.json").write_text(
        json.dumps(unsupported_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    readme_lines = [
        "CC Switch local DB export for fresh schema v9",
        "",
        f"Source DB: {DEFAULT_DB_PATH}",
        "",
        "Files:",
        "- import_clean_v9.sql: import into a fresh database created by the new app version",
        "- excluded_runtime_state.json: runtime/transient tables intentionally not imported",
        "- unsupported_legacy_tables.json: legacy tables not present in the new schema",
        "- report.json: export summary and cleanup counts",
        "",
        "Recommended import order:",
        "1. Start the new version once so it creates a fresh cc-switch.db, then close the app.",
        "2. Back up the fresh cc-switch.db.",
        "3. Execute import_clean_v9.sql against the fresh database.",
        "4. Reopen the app and verify providers, MCP, prompts, logs, and settings.",
        "",
        "Notes:",
        "- Codex common config and Codex provider configs were cleaned to remove mcp_servers blocks.",
        "- provider_health, session_provider_bindings, and proxy_live_backup were excluded to avoid importing stale runtime state.",
        "- usage_daily_rollups was exported separately because the new schema does not include that table.",
        "",
    ]
    (output_dir / "README.txt").write_text("\n".join(readme_lines), encoding="utf-8")

    print(output_dir)


if __name__ == "__main__":
    main()
