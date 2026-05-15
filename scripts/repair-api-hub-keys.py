import concurrent.futures
import argparse
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

import requests


DEFAULT_DB_PATH = Path.home() / ".cc-switch" / "cc-switch.db"
API_KEY_FIELDS = {
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "CODEX_API_KEY",
    "apiKey",
    "api_key",
}


def is_masked(value):
    return isinstance(value, str) and "*" in value


def normalize_api_key(value):
    value = (value or "").strip()
    if not value:
        return ""
    lowered = value.lower()
    if lowered.startswith("bearer "):
        return normalize_api_key(value[7:].strip())
    if lowered.startswith("sk-"):
        return value
    if value.startswith("sk"):
        return "sk-" + value[2:]
    if len(value) >= 16:
        return "sk-" + value
    return value


def headers(site):
    result = {
        "Authorization": site["access_token"],
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    user_id = site["user_id"]
    if user_id is not None:
        uid = str(user_id)
        for name in [
            "New-API-User",
            "Veloera-User",
            "voapi-user",
            "User-id",
            "Rix-Api-User",
            "neo-api-user",
            "done-api-user",
        ]:
            result[name] = uid
    return result


def fetch_key(row):
    site = dict(row)
    url = site["site_url"].rstrip("/") + f"/api/token/{site['token_id']}/key"
    try:
        resp = requests.post(url, headers=headers(site), timeout=20)
        resp.raise_for_status()
        payload = resp.json()
        key = (payload.get("data") or {}).get("key")
        if not isinstance(key, str) or not key.strip():
            return site["site_id"], site["token_id"], None, "empty key response"
        return site["site_id"], site["token_id"], normalize_api_key(key), None
    except Exception as exc:
        return site["site_id"], site["token_id"], None, str(exc)


def replace_masked_keys(value, replacement):
    changed = False

    def walk(node, key_name=None):
        nonlocal changed
        if isinstance(node, dict):
            return {key: walk(child, key) for key, child in node.items()}
        if isinstance(node, list):
            return [walk(child) for child in node]
        if isinstance(node, str) and key_name in API_KEY_FIELDS and is_masked(node):
            changed = True
            return replacement
        return node

    updated = walk(value)
    return updated, changed


def parse_args():
    parser = argparse.ArgumentParser(
        description="Repair Api-Hub imported providers whose API keys were saved as masked values."
    )
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB_PATH),
        help="Path to cc-switch.db. Defaults to the current user's .cc-switch database.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Number of concurrent token-key requests.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    db_path = Path(args.db).expanduser()
    if not db_path.exists():
        raise SystemExit(f"database not found: {db_path}")

    backup = db_path.with_name(f"{db_path.name}.bak-apihub-keys-{int(time.time())}")
    shutil.copy2(db_path, backup)
    print(f"backup={backup}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        """
        select s.id as site_id, s.site_name, s.site_url, s.access_token, s.user_id,
               t.token_id, t.name, t.group_name, t.key
        from api_hub_sites s
        join api_hub_tokens t on t.site_id = s.id
        where lower(s.site_type) in ('new-api', 'newapi', 'done-hub', 'wong-gongyi', 'anyrouter')
          and t.key like '%*%'
        order by s.site_name, t.token_id
        """
    ).fetchall()

    fetched = {}
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for site_id, token_id, key, error in pool.map(fetch_key, rows):
            if key:
                fetched[(site_id, token_id)] = key
            else:
                failures.append((site_id, token_id, error))

    print(f"fetched_keys={len(fetched)} failures={len(failures)}")

    with conn:
        for (site_id, token_id), key in fetched.items():
            conn.execute(
                "update api_hub_tokens set key = ? where site_id = ? and token_id = ?",
                (key, site_id, token_id),
            )

    group_keys = {}
    for row in conn.execute(
        """
        select site_id, name, group_name, key
        from api_hub_tokens
        where name = group_name and key is not null and trim(key) <> '' and key not like '%*%'
        """
    ):
        group_keys[(row["site_id"], row["group_name"])] = normalize_api_key(row["key"])

    providers = conn.execute(
        """
        select app_type, id, api_hub_origin, settings_config
        from providers
        where api_hub_origin is not null and api_hub_origin <> ''
          and settings_config like '%*%'
        """
    ).fetchall()

    updated = 0
    skipped = []
    with conn:
        for provider in providers:
            parts = provider["api_hub_origin"].split(":", 2)
            if len(parts) < 2:
                skipped.append((provider["app_type"], provider["id"], "bad origin"))
                continue
            site_id, group = parts[0], parts[1]
            key = group_keys.get((site_id, group))
            if not key:
                skipped.append((provider["app_type"], provider["id"], "missing plain group key"))
                continue
            config = json.loads(provider["settings_config"])
            next_config, changed = replace_masked_keys(config, key)
            if not changed:
                continue
            conn.execute(
                "update providers set settings_config = ? where app_type = ? and id = ?",
                (
                    json.dumps(next_config, ensure_ascii=False, separators=(",", ":")),
                    provider["app_type"],
                    provider["id"],
                ),
            )
            updated += 1

    remaining_masked_tokens = conn.execute(
        "select count(*) from api_hub_tokens where key like '%*%'"
    ).fetchone()[0]
    remaining_masked_providers = conn.execute(
        """
        select count(*) from providers
        where api_hub_origin is not null and api_hub_origin <> ''
          and settings_config like '%*%'
        """
    ).fetchone()[0]

    print(f"updated_providers={updated}")
    print(f"skipped_providers={len(skipped)}")
    print(f"remaining_masked_tokens={remaining_masked_tokens}")
    print(f"remaining_masked_providers={remaining_masked_providers}")
    if failures:
        print("fetch_failures_sample=" + json.dumps(failures[:10], ensure_ascii=False))
    if skipped:
        print("skipped_sample=" + json.dumps(skipped[:10], ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
