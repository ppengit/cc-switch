#!/usr/bin/env python3
"""Export cc-switch providers into one self-contained restore script.

The generated script intentionally restores only the `providers` table. It does
not export settings, MCP servers, sessions, usage logs, request logs, skills, or
application templates, so importing it into a freshly initialized database will
not bring back obsolete configuration mechanisms.

The generated script contains API keys and base URLs. Keep it local and do not
commit it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sqlite3
import textwrap
from typing import Iterable

PROVIDER_COLUMNS = [
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


def parse_args() -> argparse.Namespace:
    default_source = pathlib.Path.home() / ".cc-switch" / "cc-switch.db"
    default_output = pathlib.Path("release") / "provider-migration"
    default_name = f"restore_providers_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}"

    parser = argparse.ArgumentParser(
        description="Export providers from cc-switch.db into a restore script.",
    )
    parser.add_argument(
        "--source-db",
        default=str(default_source),
        help="Path to source cc-switch.db",
    )
    parser.add_argument(
        "--output-dir",
        default=str(default_output),
        help="Directory for generated restore script",
    )
    parser.add_argument(
        "--script-name",
        default=default_name,
        help="Generated script base name, without .py",
    )
    return parser.parse_args()


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict]:
    return [dict(row) for row in rows]


def get_table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})")}


def fetch_provider_rows(conn: sqlite3.Connection) -> list[dict]:
    columns = get_table_columns(conn, "providers")
    missing = [column for column in PROVIDER_COLUMNS if column not in columns]
    if missing:
        raise RuntimeError(f"Source providers table is missing columns: {missing}")

    sql = f"""
        SELECT {", ".join(PROVIDER_COLUMNS)}
        FROM providers
        ORDER BY app_type ASC, sort_index IS NULL, sort_index ASC, created_at ASC, name ASC
    """
    return rows_to_dicts(conn.execute(sql).fetchall())


def summarize_provider_rows(providers: list[dict]) -> dict[str, dict[str, int]]:
    summary: dict[str, dict[str, int]] = {}
    for provider in providers:
        app_type = str(provider.get("app_type") or "")
        entry = summary.setdefault(app_type, {"providers": 0, "current": 0, "failover": 0})
        entry["providers"] += 1
        if provider.get("is_current"):
            entry["current"] += 1
        if provider.get("in_failover_queue"):
            entry["failover"] += 1
    return dict(sorted(summary.items()))


def render_restore_script(providers: list[dict], source_db: pathlib.Path) -> str:
    exported_at = dt.datetime.now(dt.timezone.utc).isoformat()
    source_db_display = source_db.as_posix()
    providers_json = json.dumps(providers, ensure_ascii=False, indent=2)
    summary_json = json.dumps(summarize_provider_rows(providers), ensure_ascii=False, indent=2)

    return textwrap.dedent(
        f"""\
        #!/usr/bin/env python3
        \"\"\"Restore cc-switch providers into a target database.

        Scope:
        - Replaces providers for the exported app scopes.
        - Preserves sessions, request logs, usage data, MCP servers, settings,
          skills, prompts, WebDAV settings, and application config templates.

        Sensitive data:
        - This script embeds provider settings, including API keys and base URLs.
        - Keep it local and do not commit or share it.

        Generated at: {exported_at}
        Source DB: {source_db_display}
        \"\"\"

        from __future__ import annotations

        import argparse
        import datetime as dt
        import json
        import pathlib
        import shutil
        import sqlite3
        import sys

        PROVIDER_COLUMNS = {PROVIDER_COLUMNS!r}
        PROVIDERS_JSON = {providers_json!r}
        EXPORT_SUMMARY_JSON = {summary_json!r}


        def parse_args() -> argparse.Namespace:
            default_target = pathlib.Path.home() / ".cc-switch" / "cc-switch.db"
            parser = argparse.ArgumentParser(
                description="Restore cc-switch providers into a target cc-switch.db."
            )
            parser.add_argument(
                "--target-db",
                default=str(default_target),
                help="Target cc-switch.db path",
            )
            parser.add_argument(
                "--skip-backup",
                action="store_true",
                help="Do not create a backup copy before import",
            )
            parser.add_argument(
                "--dry-run",
                action="store_true",
                help="Validate and print summary without writing",
            )
            return parser.parse_args()


        def get_table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
            return {{str(row[1]) for row in conn.execute(f"PRAGMA table_info({{table}})")}}


        def ensure_target_schema(conn: sqlite3.Connection) -> None:
            found_tables = {{
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }}
            if "providers" not in found_tables:
                raise RuntimeError("Target database is missing providers table")

            columns = get_table_columns(conn, "providers")
            missing = [column for column in PROVIDER_COLUMNS if column not in columns]
            if missing:
                raise RuntimeError(f"Target providers table is missing columns: {{missing}}")


        def create_backup(target_db: pathlib.Path) -> pathlib.Path:
            timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = target_db.with_name(
                f"{{target_db.name}}.before-provider-restore.{{timestamp}}.bak"
            )
            shutil.copy2(target_db, backup_path)
            return backup_path


        def print_summary(providers: list[dict]) -> None:
            summary = json.loads(EXPORT_SUMMARY_JSON)
            print("Provider rows:", len(providers))
            print("App scopes:", ", ".join(summary.keys()) if summary else "-")
            for app_type, item in summary.items():
                print(
                    f"  - {{app_type}}: providers={{item['providers']}}, "
                    f"current={{item['current']}}, failover={{item['failover']}}"
                )


        def normalize_current_flags(conn: sqlite3.Connection, app_types: list[str]) -> None:
            for app_type in app_types:
                current_rows = conn.execute(
                    "SELECT id FROM providers WHERE app_type = ? AND is_current = 1 "
                    "ORDER BY sort_index IS NULL, sort_index ASC, created_at ASC, name ASC",
                    (app_type,),
                ).fetchall()

                if current_rows:
                    keep_id = current_rows[0][0]
                else:
                    fallback = conn.execute(
                        "SELECT id FROM providers WHERE app_type = ? "
                        "ORDER BY sort_index IS NULL, sort_index ASC, created_at ASC, name ASC LIMIT 1",
                        (app_type,),
                    ).fetchone()
                    keep_id = fallback[0] if fallback else None

                conn.execute("UPDATE providers SET is_current = 0 WHERE app_type = ?", (app_type,))
                if keep_id:
                    conn.execute(
                        "UPDATE providers SET is_current = 1 WHERE app_type = ? AND id = ?",
                        (app_type, keep_id),
                    )


        def restore(target_db: pathlib.Path, providers: list[dict], skip_backup: bool, dry_run: bool) -> None:
            if not target_db.exists():
                raise RuntimeError(f"Target database not found: {{target_db}}")

            app_types = sorted({{str(row["app_type"]) for row in providers if row.get("app_type")}})
            if not app_types:
                raise RuntimeError("No provider rows in embedded export")

            print("Target:", target_db)
            print_summary(providers)

            conn = sqlite3.connect(target_db)
            try:
                ensure_target_schema(conn)
                if dry_run:
                    print("Dry run completed; no changes written.")
                    return
            finally:
                conn.close()

            backup_path = None
            if not skip_backup:
                backup_path = create_backup(target_db)

            conn = sqlite3.connect(target_db)
            try:
                conn.execute("PRAGMA busy_timeout = 5000")
                ensure_target_schema(conn)
                conn.execute("BEGIN")

                for app_type in app_types:
                    conn.execute("DELETE FROM providers WHERE app_type = ?", (app_type,))

                placeholders = ", ".join("?" for _ in PROVIDER_COLUMNS)
                insert_sql = (
                    f"INSERT INTO providers ({{', '.join(PROVIDER_COLUMNS)}}) "
                    f"VALUES ({{placeholders}})"
                )
                payload = [
                    tuple(row.get(column) for column in PROVIDER_COLUMNS)
                    for row in providers
                ]
                conn.executemany(insert_sql, payload)
                normalize_current_flags(conn, app_types)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

            if backup_path:
                print("Backup created:", backup_path)
            print("Provider restore completed.")


        def main() -> int:
            args = parse_args()
            providers = json.loads(PROVIDERS_JSON)
            target_db = pathlib.Path(args.target_db).expanduser().resolve()
            restore(target_db, providers, args.skip_backup, args.dry_run)
            return 0


        if __name__ == "__main__":
            try:
                raise SystemExit(main())
            except Exception as exc:
                print(f"Provider restore failed: {{exc}}", file=sys.stderr)
                raise
        """
    )


def main() -> int:
    args = parse_args()
    source_db = pathlib.Path(args.source_db).expanduser().resolve()
    output_dir = pathlib.Path(args.output_dir).expanduser().resolve()
    script_name = args.script_name.strip()

    if not source_db.exists():
        raise SystemExit(f"Source database not found: {source_db}")
    if not script_name:
        raise SystemExit("script name cannot be empty")

    output_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db)
    conn.row_factory = sqlite3.Row
    try:
        providers = fetch_provider_rows(conn)
    finally:
        conn.close()

    if not providers:
        raise SystemExit("No providers found in source database")

    script_path = output_dir / f"{script_name}.py"
    readme_path = output_dir / f"{script_name}.README.txt"

    script_path.write_text(render_restore_script(providers, source_db), encoding="utf-8")
    readme_path.write_text(
        textwrap.dedent(
            f"""\
            Provider restore script generated from: {source_db}

            Files:
            - {script_path.name}: self-contained provider restore script

            Scope:
            - Restores only providers for exported app scopes.
            - Does not import settings, MCP servers, config templates, sessions,
              request logs, usage data, skills, prompts, or WebDAV settings.

            Sensitive data warning:
            - The script embeds API keys and base URLs.
            - Keep it local. Do not commit or share it.

            Usage:
            1. Install the new CC Switch build once so the new database is initialized.
            2. Close CC Switch.
            3. Run:
               python {script_path.name}
            4. The script creates a backup of the target database before writing.

            Dry run:
               python {script_path.name} --dry-run
            """
        ),
        encoding="utf-8",
    )

    summary = summarize_provider_rows(providers)
    print("Export complete:")
    print(f"  restore script: {script_path}")
    print(f"  readme:         {readme_path}")
    print(f"  providers:      {len(providers)}")
    print(f"  app scopes:     {', '.join(summary.keys()) if summary else '-'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
