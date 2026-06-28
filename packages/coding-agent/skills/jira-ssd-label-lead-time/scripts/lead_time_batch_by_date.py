#!/usr/bin/env python3
"""Jira REST: search issues by date window + labels, then spec→review lead time per issue.

Uses the same changelog rules as lead_time_from_changelog.py.

Env (same as single-issue script):
  JIRA_URL, JIRA_PERSONAL_TOKEN or JIRA_API_TOKEN
  Optional: JIRA_USERNAME — Bearer first; on 401 retries Basic unless JIRA_FORCE_BEARER_ONLY=1

Usage:
  python3 lead_time_batch_by_date.py --from-date 2026-03-01 --to-date 2026-03-20
  python3 lead_time_batch_by_date.py --from-date 2026-03-01 --to-date 2026-03-20 --json
  python3 lead_time_batch_by_date.py --from-date 2026-03-01 --to-date 2026-03-20 --labels-mode spec-only
  python3 lead_time_batch_by_date.py --from-date 2026-03-01 --to-date 2026-03-20 --basic
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from base64 import b64encode
from datetime import datetime, timedelta
from pathlib import Path

# Same directory as this file
sys.path.insert(0, str(Path(__file__).resolve().parent))
import lead_time_from_changelog as lt  # noqa: E402


def _search_headers_bearer(token: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }


def _search_headers_basic(user: str, pw: str) -> dict[str, str]:
    raw = f"{user}:{pw}".encode("utf-8")
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": "Basic " + b64encode(raw).decode("ascii"),
    }


def jira_search_page(
    base_url: str,
    jql: str,
    *,
    token: str,
    username: str,
    force_basic: bool,
    start_at: int,
    max_results: int,
) -> dict:
    url = f"{base_url.rstrip('/')}/rest/api/2/search"
    body = json.dumps(
        {
            "jql": jql,
            "startAt": start_at,
            "maxResults": max_results,
            "fields": ["key", "summary"],
        }
    ).encode("utf-8")
    no_basic_fallback = os.environ.get("JIRA_FORCE_BEARER_ONLY", "").strip() in ("1", "true", "yes")

    def post(headers: dict[str, str]) -> dict:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode("utf-8", errors="replace")
            raise lt.JiraHTTPError(e.code, body_txt) from e

    if force_basic and username:
        return post(_search_headers_basic(username, token))

    try:
        return post(_search_headers_bearer(token))
    except lt.JiraHTTPError as e:
        if e.code == 401 and username and not force_basic and not no_basic_fallback:
            return post(_search_headers_basic(username, token))
        raise SystemExit(f"HTTP {e.code} from Jira search: {e.body[:800]}") from e


def collect_issue_keys(
    base_url: str,
    jql: str,
    *,
    token: str,
    username: str,
    force_basic: bool,
    page_size: int = 50,
) -> list[tuple[str, str | None]]:
    """Return [(key, summary), ...] for all pages."""
    out: list[tuple[str, str | None]] = []
    start = 0
    while True:
        data = jira_search_page(
            base_url,
            jql,
            token=token,
            username=username,
            force_basic=force_basic,
            start_at=start,
            max_results=page_size,
        )
        issues = data.get("issues") or []
        for issue in issues:
            key = issue.get("key") or ""
            fields = issue.get("fields") or {}
            summ = fields.get("summary")
            if key:
                out.append((key, summ))
        total = int(data.get("total") or 0)
        start += len(issues)
        if start >= total or not issues:
            break
    return out


def build_jql(
    date_from: str,
    date_to: str,
    *,
    date_field: str,
    labels_mode: str,
) -> str:
    if date_field not in ("updated", "created"):
        raise ValueError("date_field must be 'updated' or 'created'")
    if labels_mode == "both":
        label_clause = (
            'labels = "bot-cx-ai-spec" AND '
            '(labels = "bot-cx-ai-review-passed" OR labels = "bot-cx-ai-code-review")'
        )
    elif labels_mode == "spec-only":
        label_clause = 'labels = "bot-cx-ai-spec"'
    else:
        raise ValueError("labels_mode must be 'both' or 'spec-only'")

    # Inclusive calendar range on [date_from, date_to]: JQL uses >= from and < (to + 1 day).
    datetime.strptime(date_from.strip(), "%Y-%m-%d")
    end_inc = datetime.strptime(date_to.strip(), "%Y-%m-%d")
    end_exclusive = (end_inc + timedelta(days=1)).strftime("%Y-%m-%d")
    parts = [
        label_clause,
        f'{date_field} >= "{date_from}"',
        f'{date_field} < "{end_exclusive}"',
    ]
    return " AND ".join(parts) + " ORDER BY key ASC"


def print_markdown_report(
    *,
    jql: str,
    date_from: str,
    date_to: str,
    date_field: str,
    labels_mode: str,
    rows: list[dict],
) -> None:
    valid = [r for r in rows if r.get("duration_hours_wall") is not None]
    na = [r for r in rows if r.get("duration_hours_wall") is None]
    total_h = sum(r["duration_hours_wall"] for r in valid)
    n = len(valid)

    print("## SSD spec → review lead time — batch by date\n")
    print(f"- **From**: `{date_from}`  **To** (inclusive): `{date_to}`")
    print(f"- **Jira filter field**: `{date_field}`")
    print(
        f"- **Labels mode**: `{labels_mode}` (`both` = spec + "
        f"(review-passed OR code-review))"
    )
    print(f"- **Issues matched**: {len(rows)}")
    print(f"- **With duration** (both first-adds in changelog): {n}")
    if na:
        print(
            f"- **N/A** (missing first add in changelog, invalid/negative span, or truncated): "
            f"{len(na)} — {', '.join(r['issue_key'] for r in na)}"
        )
    print()
    print("**JQL used**:\n\n```text")
    print(jql)
    print("```\n")
    print("| Issue | Hours (wall) | Duration | Summary |")
    print("| ----- | ------------: | -------- | ------- |")
    for r in sorted(rows, key=lambda x: x["issue_key"]):
        dh = r.get("duration_hours_wall")
        hs = f"{dh:.2f}" if dh is not None else "—"
        hum = r.get("duration_human") or "—"
        summ = (r.get("summary") or "").replace("|", "\\|")
        if len(summ) > 80:
            summ = summ[:77] + "..."
        print(f"| {r['issue_key']} | {hs} | {hum} | {summ} |")
    print()
    print("### Aggregate (spec → review)\n")
    print("| Metric | Value |")
    print("| ------ | ----- |")
    print(f"| Sum of hours (wall), valid rows only | **{total_h:.2f} h** (~{total_h / 24:.2f} d) |")
    print(f"| Mean hours per valid issue | **{(total_h / n) if n else 0:.2f} h** |")
    print()
    print("### Data source\n")
    print(
        "Jira REST `POST /rest/api/2/search` + per-issue changelog (read-only). "
        "Same metric as single-issue script: first add `bot-cx-ai-spec` → "
        "first add `bot-cx-ai-review-passed` (preferred) or `bot-cx-ai-code-review`."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch SSD spec→review lead times for issues matching a date range and labels."
    )
    parser.add_argument("--from-date", required=True, help="Start date inclusive (YYYY-MM-DD).")
    parser.add_argument("--to-date", required=True, help="End date inclusive (YYYY-MM-DD).")
    parser.add_argument(
        "--date-field",
        choices=("updated", "created"),
        default="updated",
        help="Which issue field bounds the range in JQL (default: updated).",
    )
    parser.add_argument(
        "--labels-mode",
        choices=("both", "spec-only"),
        default="both",
        help="both: spec AND (review-passed OR code-review) on the issue. "
        "spec-only: only bot-cx-ai-spec (more issues; some may be N/A).",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=50,
        help="Search page size (max 50 typical for Jira).",
    )
    parser.add_argument("--json", action="store_true", help="Emit one JSON object (stdout).")
    parser.add_argument(
        "--basic",
        action="store_true",
        help="Force HTTP Basic (JIRA_USERNAME + token). Default: Bearer first, Basic on 401.",
    )
    args = parser.parse_args()

    base = os.environ.get("JIRA_URL", "").strip()
    if not base:
        sys.exit("Missing JIRA_URL in environment.")

    token = lt.resolve_jira_token()
    user = os.environ.get("JIRA_USERNAME", "").strip()

    jql = build_jql(
        args.from_date,
        args.to_date,
        date_field=args.date_field,
        labels_mode=args.labels_mode,
    )

    keys = collect_issue_keys(
        base,
        jql,
        token=token,
        username=user,
        force_basic=args.basic,
        page_size=min(max(args.page_size, 1), 100),
    )

    rows: list[dict] = []
    for key, _summ in keys:
        payload = lt.fetch_issue_changelog(
            base,
            key,
            bearer_token=token,
            basic_user=user if user else None,
            basic_pass=token,
            force_basic=args.basic,
        )
        row = lt.analyze(payload, key)
        rows.append(row)

    payload_out = {
        "from_date": args.from_date,
        "to_date": args.to_date,
        "date_field": args.date_field,
        "labels_mode": args.labels_mode,
        "jql": jql,
        "issue_count": len(rows),
        "issues": rows,
        "valid_count": sum(1 for r in rows if r.get("duration_hours_wall") is not None),
        "total_hours_wall": sum(
            r["duration_hours_wall"] for r in rows if r.get("duration_hours_wall") is not None
        ),
    }
    if args.json:
        print(json.dumps(payload_out, indent=2))
        return

    print_markdown_report(
        jql=jql,
        date_from=args.from_date,
        date_to=args.to_date,
        date_field=args.date_field,
        labels_mode=args.labels_mode,
        rows=rows,
    )


if __name__ == "__main__":
    main()
