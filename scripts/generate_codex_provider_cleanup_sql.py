from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path


DB_PATH = Path.home() / ".cc-switch" / "cc-switch.db"
ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / "exports"

COMMON_BLOCK_START = "# cc-switch common config start"
COMMON_BLOCK_END = "# cc-switch common config end"
HEADER_RE = re.compile(r"^\s*\[(?P<header>[^\]]+)\]\s*(?:#.*)?$")
ROOT_KEY_RE = re.compile(r"^\s*([A-Za-z0-9_-]+)\s*=")


def sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def normalize(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def collapse_blank_lines(text: str) -> str:
    out: list[str] = []
    blank_run = 0
    for raw_line in normalize(text).split("\n"):
        line = raw_line.rstrip()
        if not line.strip():
            blank_run += 1
            if blank_run > 1:
                continue
        else:
            blank_run = 0
        out.append(line)
    joined = "\n".join(out).strip()
    return f"{joined}\n" if joined else ""


def strip_managed_common_block(text: str) -> str:
    pattern = re.compile(
        re.escape(COMMON_BLOCK_START)
        + r"[\s\S]*?"
        + re.escape(COMMON_BLOCK_END)
        + r"\s*\n?",
        re.M,
    )
    return pattern.sub("", normalize(text))


def derive_common_metadata(common_text: str):
    root_keys: set[str] = set()
    table_prefixes: set[str] = set()
    current_section: str | None = None

    for line in normalize(common_text).split("\n"):
        header_match = HEADER_RE.match(line)
        if header_match:
            current_section = header_match.group("header").strip()
            table_prefixes.add(current_section)
            if current_section.startswith("notice."):
                table_prefixes.add("notice")
            if current_section.startswith("projects."):
                table_prefixes.add("projects")
            continue

        if current_section is not None:
            continue

        key_match = ROOT_KEY_RE.match(line)
        if key_match:
            root_keys.add(key_match.group(1))

    return root_keys, table_prefixes


def should_skip_table(header: str, table_prefixes: set[str]) -> bool:
    for prefix in table_prefixes:
        if header == prefix or header.startswith(prefix + "."):
            return True
    return False


def clean_codex_provider_config(config_text: str, common_text: str) -> tuple[str, bool]:
    root_keys, table_prefixes = derive_common_metadata(common_text)
    text = strip_managed_common_block(config_text)
    lines = normalize(text).split("\n")
    cleaned_lines: list[str] = []
    current_section: str | None = None
    skipping_section = False

    for line in lines:
        header_match = HEADER_RE.match(line)
        if header_match:
            current_section = header_match.group("header").strip()
            skipping_section = should_skip_table(current_section, table_prefixes)
            if skipping_section:
                continue
            cleaned_lines.append(line.rstrip())
            continue

        if skipping_section:
            continue

        if current_section is None:
            key_match = ROOT_KEY_RE.match(line)
            if key_match and key_match.group(1) in root_keys:
                continue

        cleaned_lines.append(line.rstrip())

    cleaned = collapse_blank_lines("\n".join(cleaned_lines))
    return cleaned, cleaned != collapse_blank_lines(config_text)


def main():
    if not DB_PATH.exists():
        raise SystemExit(f"Database not found: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    row = cur.execute(
        "SELECT value FROM settings WHERE key='common_config_codex'",
    ).fetchone()
    if not row or not isinstance(row[0], str) or not row[0].strip():
        raise SystemExit("common_config_codex is missing or empty")
    common_text = row[0]

    updates = []
    for provider_id, name, raw_settings in cur.execute(
        "SELECT id, name, settings_config FROM providers WHERE app_type='codex' ORDER BY name",
    ).fetchall():
        try:
            settings = json.loads(raw_settings)
        except json.JSONDecodeError:
            continue
        if not isinstance(settings, dict):
            continue
        config_text = settings.get("config")
        if not isinstance(config_text, str):
            continue
        cleaned_config, changed = clean_codex_provider_config(config_text, common_text)
        if not changed:
            continue
        settings["config"] = cleaned_config
        updates.append(
            {
                "id": provider_id,
                "name": name,
                "settings_config": json.dumps(settings, ensure_ascii=False, separators=(",", ":")),
            },
        )

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = OUTPUT_ROOT / f"codex-cleanup-{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    sql_lines = [
        "-- Clean duplicated Codex common config from imported providers",
        "BEGIN IMMEDIATE;",
    ]
    for item in updates:
        sql_lines.append(
            "UPDATE providers SET settings_config = "
            f"{sql_literal(item['settings_config'])} "
            "WHERE app_type = 'codex' "
            f"AND id = {sql_literal(item['id'])};",
        )
    sql_lines.append("COMMIT;")

    (output_dir / "codex_provider_cleanup.sql").write_text(
        "\n".join(sql_lines) + "\n",
        encoding="utf-8",
    )
    (output_dir / "report.json").write_text(
        json.dumps(
            {
                "db_path": str(DB_PATH),
                "generated_at": datetime.now().isoformat(),
                "providers_to_update": len(updates),
                "examples": updates[:10],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(output_dir)


if __name__ == "__main__":
    main()
