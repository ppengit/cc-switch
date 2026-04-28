#!/usr/bin/env python3
"""Export provider-domain data from cc-switch.db into a portable bundle.

The generated bundle contains sensitive material such as API keys and custom
config snippets. Keep it local and do not commit it.
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

MCP_COLUMNS = [
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
    "enabled_hermes",
]

SETTING_PREFIXES = (
    "common_config_",
    "config_template_",
    "provider_default_template_",
    "current_provider_",
)

SETTING_EXACT_KEYS = {
    "common_config_legacy_migrated_v1",
}


def parse_args() -> argparse.Namespace:
    default_source = pathlib.Path.home() / ".cc-switch" / "cc-switch.db"
    default_output = pathlib.Path("release") / "provider-migration"
    default_name = f"providers_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}"

    parser = argparse.ArgumentParser(
        description="Export provider-domain records from cc-switch.db.",
    )
    parser.add_argument(
        "--source-db",
        default=str(default_source),
        help="Path to source cc-switch.db",
    )
    parser.add_argument(
        "--output-dir",
        default=str(default_output),
        help="Directory for generated bundle files",
    )
    parser.add_argument(
        "--bundle-name",
        default=default_name,
        help="Base file name for the exported bundle",
    )
    parser.add_argument(
        "--skip-mcp",
        action="store_true",
        help="Do not include mcp_servers in the export bundle",
    )
    return parser.parse_args()


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict]:
    return [dict(row) for row in rows]


def should_export_setting(key: str) -> bool:
    return key in SETTING_EXACT_KEYS or key.startswith(SETTING_PREFIXES)


def fetch_provider_rows(conn: sqlite3.Connection) -> list[dict]:
    sql = f"""
        SELECT {", ".join(PROVIDER_COLUMNS)}
        FROM providers
        ORDER BY app_type ASC, sort_index IS NULL, sort_index ASC, created_at ASC, name ASC
    """
    return rows_to_dicts(conn.execute(sql).fetchall())


def fetch_mcp_rows(conn: sqlite3.Connection) -> list[dict]:
    sql = f"""
        SELECT {", ".join(MCP_COLUMNS)}
        FROM mcp_servers
        ORDER BY id ASC
    """
    return rows_to_dicts(conn.execute(sql).fetchall())


def fetch_setting_rows(conn: sqlite3.Connection) -> list[dict]:
    rows = rows_to_dicts(
        conn.execute("SELECT key, value FROM settings ORDER BY key ASC").fetchall()
    )
    return [row for row in rows if should_export_setting(str(row["key"]))]


def render_import_script(bundle_filename: str) -> str:
    return textwrap.dedent(
        f"""\
        #!/usr/bin/env python3
        \"\"\"Import provider-domain data into a target cc-switch.db.

        This importer only replaces provider-related records:
        - providers for the exported app scopes
        - provider-related settings keys included in the bundle
        - MCP servers, if the bundle asks to replace them

        It does not touch sessions, usage logs, prompts, skills, or other tables.
        \"\"\"

        from __future__ import annotations

        import argparse
        import datetime as dt
        import json
        import pathlib
        import shutil
        import sqlite3
        import sys

        BUNDLE_PATH = pathlib.Path(__file__).resolve().parent / {bundle_filename!r}

        PROVIDER_COLUMNS = {PROVIDER_COLUMNS!r}
        MCP_COLUMNS = {MCP_COLUMNS!r}


        def parse_args() -> argparse.Namespace:
            default_target = pathlib.Path.home() / ".cc-switch" / "cc-switch.db"
            parser = argparse.ArgumentParser(
                description="Import provider-domain data into cc-switch.db."
            )
            parser.add_argument(
                "--target-db",
                default=str(default_target),
                help="Target cc-switch.db path",
            )
            parser.add_argument(
                "--bundle",
                default=str(BUNDLE_PATH),
                help="Provider bundle JSON path",
            )
            parser.add_argument(
                "--skip-backup",
                action="store_true",
                help="Do not create a backup copy of the target db before import",
            )
            parser.add_argument(
                "--dry-run",
                action="store_true",
                help="Validate bundle and print summary without writing to the target db",
            )
            return parser.parse_args()


        def ensure_tables(conn: sqlite3.Connection) -> None:
            required = {{"providers", "settings"}}
            found = {{
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }}
            missing = sorted(required - found)
            if missing:
                raise RuntimeError(f"Target database is missing required tables: {{missing}}")


        def create_backup(target_db: pathlib.Path) -> pathlib.Path:
            timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = target_db.with_name(
                f"{{target_db.name}}.before-provider-import.{{timestamp}}.bak"
            )
            shutil.copy2(target_db, backup_path)
            return backup_path


        def insert_many(conn: sqlite3.Connection, table: str, columns: list[str], rows: list[dict]) -> None:
            if not rows:
                return
            placeholders = ", ".join("?" for _ in columns)
            sql = (
                f"INSERT OR REPLACE INTO {{table}} ({{', '.join(columns)}}) "
                f"VALUES ({{placeholders}})"
            )
            payload = [tuple(row.get(column) for column in columns) for row in rows]
            conn.executemany(sql, payload)


        def main() -> int:
            args = parse_args()
            target_db = pathlib.Path(args.target_db).expanduser().resolve()
            bundle_path = pathlib.Path(args.bundle).expanduser().resolve()

            if not bundle_path.exists():
                raise SystemExit(f"Bundle file not found: {{bundle_path}}")
            if not target_db.exists():
                raise SystemExit(f"Target database not found: {{target_db}}")

            bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
            providers = bundle["tables"].get("providers", [])
            settings = bundle["tables"].get("settings", [])
            mcp_servers = bundle["tables"].get("mcp_servers", [])
            app_types = bundle["meta"].get("app_types", [])
            replace_mcp = bool(bundle["meta"].get("replace_mcp_servers", False))

            print("Bundle:", bundle_path)
            print("Target:", target_db)
            print("Providers:", len(providers))
            print("Settings:", len(settings))
            print("MCP servers:", len(mcp_servers), "(replace=" + str(replace_mcp) + ")")
            print("App scopes:", ", ".join(app_types) if app_types else "-")

            if args.dry_run:
                return 0

            backup_path = None
            if not args.skip_backup:
                backup_path = create_backup(target_db)

            conn = sqlite3.connect(target_db)
            try:
                ensure_tables(conn)
                conn.execute("BEGIN")

                for app_type in app_types:
                    conn.execute("DELETE FROM providers WHERE app_type = ?", (app_type,))

                if settings:
                    conn.executemany(
                        "DELETE FROM settings WHERE key = ?",
                        [(row["key"],) for row in settings],
                    )

                if replace_mcp and mcp_servers:
                    conn.execute("DELETE FROM mcp_servers")

                insert_many(conn, "providers", PROVIDER_COLUMNS, providers)
                insert_many(conn, "settings", ["key", "value"], settings)
                if replace_mcp:
                    insert_many(conn, "mcp_servers", MCP_COLUMNS, mcp_servers)

                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

            if backup_path is not None:
                print("Backup created:", backup_path)
            print("Provider-domain import completed.")
            return 0


        if __name__ == "__main__":
            try:
                raise SystemExit(main())
            except Exception as exc:  # pragma: no cover - CLI path
                print(f"Import failed: {{exc}}", file=sys.stderr)
                raise
        """
    )


def main() -> int:
    args = parse_args()
    source_db = pathlib.Path(args.source_db).expanduser().resolve()
    output_dir = pathlib.Path(args.output_dir).expanduser().resolve()

    if not source_db.exists():
        raise SystemExit(f"Source database not found: {source_db}")

    output_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source_db)
    conn.row_factory = sqlite3.Row
    try:
        providers = fetch_provider_rows(conn)
        settings = fetch_setting_rows(conn)
        mcp_servers = [] if args.skip_mcp else fetch_mcp_rows(conn)
    finally:
        conn.close()

    app_types = sorted({row["app_type"] for row in providers})
    bundle = {
        "meta": {
            "bundle_name": args.bundle_name,
            "source_db": str(source_db),
            "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "app_types": app_types,
            "replace_mcp_servers": not args.skip_mcp,
            "contains_secrets": True,
            "notes": [
                "This bundle contains provider-domain records only.",
                "Keep it local. It may include API keys and custom config snippets.",
            ],
            "counts": {
                "providers": len(providers),
                "settings": len(settings),
                "mcp_servers": len(mcp_servers),
            },
        },
        "tables": {
            "providers": providers,
            "settings": settings,
            "mcp_servers": mcp_servers,
        },
    }

    bundle_path = output_dir / f"{args.bundle_name}.json"
    import_script_path = output_dir / f"import_{args.bundle_name}.py"
    readme_path = output_dir / f"{args.bundle_name}.README.txt"

    bundle_path.write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    import_script_path.write_text(
        render_import_script(bundle_path.name),
        encoding="utf-8",
    )
    readme_path.write_text(
        textwrap.dedent(
            f"""\
            Provider bundle generated from: {source_db}

            Files:
            - {bundle_path.name}: exported provider-domain data
            - {import_script_path.name}: importer for a target cc-switch.db

            Sensitive data warning:
            - This export may contain API keys, base URLs, custom templates, and common config.
            - Keep these files local. Do not commit or share them.

            Basic usage:
            1. Install the new CC Switch build once so the new database is created.
            2. Close CC Switch.
            3. Run:
               python {import_script_path.name}
            4. The importer will back up the target database automatically before writing.
            """
        ),
        encoding="utf-8",
    )

    print("Export complete:")
    print(f"  bundle:   {bundle_path}")
    print(f"  importer: {import_script_path}")
    print(f"  readme:   {readme_path}")
    print(f"  apps:     {', '.join(app_types) if app_types else '-'}")
    print(f"  providers:{len(providers)}  settings:{len(settings)}  mcp:{len(mcp_servers)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
