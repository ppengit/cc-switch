from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from export_local_db_for_new_schema import (
    DEFAULT_DB_PATH,
    OUTPUT_ROOT,
    clean_codex_common_setting,
    clean_codex_provider_settings,
    sql_literal,
)


COMMON_CONFIG_KEYS = [
    "common_config_claude",
    "common_config_codex",
    "common_config_gemini",
    "common_config_opencode",
    "common_config_openclaw",
]
CODEX_AUTH_PATH = Path.home() / ".codex" / "auth.json"


def pretty_json_string(raw: str) -> str:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    return json.dumps(parsed, ensure_ascii=False, indent=2)


def main():
    if not DEFAULT_DB_PATH.exists():
        raise SystemExit(f"Source database not found: {DEFAULT_DB_PATH}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = OUTPUT_ROOT / f"providers-only-export-{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(DEFAULT_DB_PATH)
    conn.row_factory = sqlite3.Row

    report: dict[str, object] = {
        "source_db": str(DEFAULT_DB_PATH),
        "generated_at": datetime.now().isoformat(),
        "providers_exported": 0,
        "common_config_keys_exported": [],
        "cleanups": {
            "codex_provider_configs_removed_mcp": 0,
            "codex_common_config_removed_mcp": False,
        },
        "codex_live_auth_exported": CODEX_AUTH_PATH.exists(),
    }

    common_config_snippets: dict[str, str] = {}
    settings_rows = []
    for key in COMMON_CONFIG_KEYS:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?",
            (key,),
        ).fetchone()
        if row is None:
            continue
        value = row["value"]
        if key == "common_config_codex":
            cleaned_value, changed = clean_codex_common_setting(value)
            if cleaned_value is None:
                continue
            value = cleaned_value
            if changed:
                report["cleanups"]["codex_common_config_removed_mcp"] = True
        common_config_snippets[key] = value
        settings_rows.append({"key": key, "value": value})

    providers = []
    provider_sql_rows = []
    rows = conn.execute(
        "SELECT * FROM providers ORDER BY app_type, COALESCE(sort_index, 999999), name, id",
    ).fetchall()
    for row in rows:
        row_dict = dict(row)
        settings_raw = row_dict.get("settings_config") or "{}"
        if row_dict.get("app_type") == "codex":
            settings_raw, changed = clean_codex_provider_settings(settings_raw)
            if changed:
                report["cleanups"]["codex_provider_configs_removed_mcp"] += 1

        pretty_settings = pretty_json_string(settings_raw)
        provider_sql_rows.append(
            {
                **row_dict,
                "settings_config": pretty_settings,
            },
        )

        try:
            parsed_settings = json.loads(pretty_settings)
        except json.JSONDecodeError:
            parsed_settings = pretty_settings

        providers.append(
            {
                "id": row_dict["id"],
                "appType": row_dict["app_type"],
                "name": row_dict["name"],
                "websiteUrl": row_dict.get("website_url"),
                "category": row_dict.get("category"),
                "createdAt": row_dict.get("created_at"),
                "sortIndex": row_dict.get("sort_index"),
                "notes": row_dict.get("notes"),
                "icon": row_dict.get("icon"),
                "iconColor": row_dict.get("icon_color"),
                "meta": json.loads(row_dict["meta"]) if row_dict.get("meta") else {},
                "isCurrent": bool(row_dict.get("is_current")),
                "inFailoverQueue": bool(row_dict.get("in_failover_queue")),
                "costMultiplier": row_dict.get("cost_multiplier"),
                "limitDailyUsd": row_dict.get("limit_daily_usd"),
                "limitMonthlyUsd": row_dict.get("limit_monthly_usd"),
                "providerType": row_dict.get("provider_type"),
                "settingsConfig": parsed_settings,
            },
        )

    report["providers_exported"] = len(providers)
    report["common_config_keys_exported"] = list(common_config_snippets.keys())

    sql_lines = [
        "-- CC Switch providers-only import",
        "-- Import this into a fresh database created by the new app version",
        "BEGIN IMMEDIATE;",
    ]
    for item in settings_rows:
        sql_lines.append(
            "INSERT OR REPLACE INTO settings (key, value) VALUES "
            f"({sql_literal(item['key'])}, {sql_literal(item['value'])});",
        )

    provider_columns = [
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
    ]
    for row in provider_sql_rows:
        values_sql = ", ".join(sql_literal(row.get(column)) for column in provider_columns)
        sql_lines.append(
            "INSERT OR REPLACE INTO providers "
            f"({', '.join(provider_columns)}) VALUES ({values_sql});",
        )
    sql_lines.append("COMMIT;")

    bundle = {
        "commonConfigSnippets": common_config_snippets,
        "providers": providers,
    }

    if CODEX_AUTH_PATH.exists():
        try:
            bundle["codexLiveAuth"] = json.loads(CODEX_AUTH_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            bundle["codexLiveAuth"] = CODEX_AUTH_PATH.read_text(encoding="utf-8")

    (output_dir / "providers_import.sql").write_text(
        "\n".join(sql_lines) + "\n",
        encoding="utf-8",
    )
    (output_dir / "providers_clean.json").write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if CODEX_AUTH_PATH.exists():
        (output_dir / "codex_auth_live.json").write_text(
            json.dumps(bundle["codexLiveAuth"], ensure_ascii=False, indent=2)
            if isinstance(bundle["codexLiveAuth"], dict)
            else str(bundle["codexLiveAuth"]),
            encoding="utf-8",
        )
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    readme = [
        "CC Switch providers-only export",
        "",
        f"Source DB: {DEFAULT_DB_PATH}",
        "",
        "Files:",
        "- providers_import.sql: import only providers + common config snippets into the fresh DB",
        "- providers_clean.json: organized provider data for inspection",
        "- codex_auth_live.json: snapshot of current ~/.codex/auth.json",
        "- report.json: cleanup summary",
        "",
        "Notes:",
        "- Codex provider config TOML and common_config_codex were cleaned to remove mcp_servers blocks.",
        "- Codex auth is already embedded in each provider.settings_config.auth; codex_auth_live.json is just a reference snapshot.",
        "",
    ]
    (output_dir / "README.txt").write_text("\n".join(readme), encoding="utf-8")

    print(output_dir)


if __name__ == "__main__":
    main()
