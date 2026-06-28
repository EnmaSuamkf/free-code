#!/usr/bin/env python3
"""Track SDD workflow adoption via Jira labels.

Reports which issues passed through each SDD workflow phase based on
current labels: bot-cx-ai-spec, bot-cx-ai-plan, bot-cx-ai-dev,
and bot-cx-ai-code-review.

Env:
  JIRA_URL              — base URL (e.g. https://jira.example.org)
  JIRA_PERSONAL_TOKEN   — PAT for Bearer auth (or JIRA_API_TOKEN)
Optional:
  JIRA_USERNAME         — enables Basic auth fallback on 401
  JIRA_FORCE_BEARER_ONLY — set to 1/true/yes to never fall back to Basic

Usage:
  python3 sdd_workflow_tracker.py --assignee pablo.castaneda --days 20
  python3 sdd_workflow_tracker.py --project SUMO --from-date 2026-03-01 --to-date 2026-03-31
  python3 sdd_workflow_tracker.py --assignee pablo.castaneda --project SUMO --days 30 --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from base64 import b64encode
from datetime import datetime, timedelta

LABEL_SPEC = "bot-cx-ai-spec"
LABEL_PLAN = "bot-cx-ai-plan"
LABEL_DEV = "bot-cx-ai-dev"
LABEL_CODE_REVIEW = "bot-cx-ai-code-review"

TRACKED_LABELS = [LABEL_SPEC, LABEL_PLAN, LABEL_DEV, LABEL_CODE_REVIEW]

PHASES = [
    {"label": LABEL_SPEC, "name": "Specify", "order": 1},
    {"label": LABEL_PLAN, "name": "Plan", "order": 2},
    {"label": LABEL_DEV, "name": "Dev", "order": 3},
    {"label": LABEL_CODE_REVIEW, "name": "Code Review", "order": 4},
]


class JiraHTTPError(Exception):
    def __init__(self, code: int, body: str):
        super().__init__(f"HTTP {code}")
        self.code = code
        self.body = body


def resolve_token() -> str:
    t = (
        os.environ.get("JIRA_PERSONAL_TOKEN", "").strip()
        or os.environ.get("JIRA_API_TOKEN", "").strip()
    )
    if not t:
        sys.exit("Missing JIRA_PERSONAL_TOKEN or JIRA_API_TOKEN in environment.")
    return t


def _headers_bearer(token: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }


def _headers_basic(user: str, pw: str) -> dict[str, str]:
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
    body = json.dumps({
        "jql": jql,
        "startAt": start_at,
        "maxResults": max_results,
        "fields": [
            "key", "summary", "labels", "assignee",
            "project", "status", "issuetype", "created", "updated",
        ],
    }).encode("utf-8")
    no_basic_fallback = (
        os.environ.get("JIRA_FORCE_BEARER_ONLY", "").strip()
        in ("1", "true", "yes")
    )

    def post(headers: dict[str, str]) -> dict:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode("utf-8", errors="replace")
            raise JiraHTTPError(e.code, body_txt) from e

    if force_basic and username:
        return post(_headers_basic(username, token))

    try:
        return post(_headers_bearer(token))
    except JiraHTTPError as e:
        if e.code == 401 and username and not force_basic and not no_basic_fallback:
            return post(_headers_basic(username, token))
        raise SystemExit(
            f"HTTP {e.code} from Jira search: {e.body[:800]}"
        ) from e


def collect_issues(
    base_url: str,
    jql: str,
    *,
    token: str,
    username: str,
    force_basic: bool,
    page_size: int = 50,
) -> list[dict]:
    out: list[dict] = []
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
            key = issue.get("key", "")
            fields = issue.get("fields") or {}
            labels = set(fields.get("labels") or [])
            assignee_obj = fields.get("assignee") or {}
            project_obj = fields.get("project") or {}
            status_obj = fields.get("status") or {}
            issuetype_obj = fields.get("issuetype") or {}
            out.append({
                "key": key,
                "summary": fields.get("summary") or "",
                "labels": labels,
                "assignee": (
                    assignee_obj.get("displayName")
                    or assignee_obj.get("name")
                    or ""
                ),
                "assignee_key": (
                    assignee_obj.get("name")
                    or assignee_obj.get("key")
                    or ""
                ),
                "project": project_obj.get("key") or "",
                "project_name": project_obj.get("name") or "",
                "status": status_obj.get("name") or "",
                "issuetype": issuetype_obj.get("name") or "",
                "created": fields.get("created") or "",
                "updated": fields.get("updated") or "",
            })
        total = int(data.get("total") or 0)
        start += len(issues)
        if start >= total or not issues:
            break
    return out


def build_jql(
    *,
    assignee: str | None = None,
    project: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    date_field: str = "updated",
) -> str:
    label_clause = (
        f'labels in ("{LABEL_SPEC}", "{LABEL_PLAN}", '
        f'"{LABEL_DEV}", "{LABEL_CODE_REVIEW}")'
    )
    parts = [label_clause]

    if assignee:
        parts.append(f'assignee = "{assignee}"')
    if project:
        parts.append(f'project = "{project}"')
    if date_from:
        parts.append(f'{date_field} >= "{date_from}"')
    if date_to:
        end_inc = datetime.strptime(date_to.strip(), "%Y-%m-%d")
        end_exclusive = (end_inc + timedelta(days=1)).strftime("%Y-%m-%d")
        parts.append(f'{date_field} < "{end_exclusive}"')

    return " AND ".join(parts) + " ORDER BY key ASC"


def _build_more_info(issue_list: list[dict]) -> str:
    """Summarize issue keys, types, and statuses for a grouped row."""
    parts: list[str] = []
    for iss in issue_list:
        detail = iss["key"]
        extras: list[str] = []
        if iss.get("issuetype"):
            extras.append(f"type {iss['issuetype'].lower()}")
        if iss.get("status"):
            extras.append(f"status {iss['status'].lower()}")
        if extras:
            detail += f" ({', '.join(extras)})"
        parts.append(detail)
    return ", ".join(parts)


def analyze_issues(issues: list[dict]) -> dict:
    phase_counts: dict[str, int] = {p["label"]: 0 for p in PHASES}

    for issue in issues:
        labels = issue["labels"]
        for p in PHASES:
            if p["label"] in labels:
                phase_counts[p["label"]] += 1

    total = len(issues)
    funnel: list[dict] = []
    for i, p in enumerate(PHASES):
        count = phase_counts[p["label"]]
        rate = (count / total * 100) if total > 0 else 0.0
        prev_count = phase_counts[PHASES[i - 1]["label"]] if i > 0 else total
        conversion = (count / prev_count * 100) if prev_count > 0 else 0.0
        funnel.append({
            "phase": p["name"],
            "label": p["label"],
            "count": count,
            "rate_of_total": round(rate, 1),
            "conversion_from_prev": round(conversion, 1) if i > 0 else None,
        })

    by_project: dict[str, dict[str, list[dict]]] = {}
    for issue in issues:
        proj = issue["project"] or "Unknown"
        assignee = issue["assignee"] or "Unassigned"
        by_project.setdefault(proj, {}).setdefault(assignee, []).append(issue)

    return {
        "total_issues": total,
        "phase_counts": phase_counts,
        "funnel": funnel,
        "by_project": by_project,
    }


def print_markdown(
    analysis: dict,
    *,
    jql: str,
    assignee: str | None,
    project: str | None,
    date_from: str | None,
    date_to: str | None,
    date_field: str,
) -> None:
    print("## SDD Workflow Tracker\n")

    print("### Filters\n")
    if assignee:
        print(f"- **Assignee**: `{assignee}`")
    if project:
        print(f"- **Project**: `{project}`")
    if date_from or date_to:
        print(
            f"- **Date range** (`{date_field}`): "
            f"`{date_from or '—'}` → `{date_to or '—'}`"
        )
    print(f"- **Issues found**: {analysis['total_issues']}")
    print()

    print("**JQL**:\n")
    print(f"```text\n{jql}\n```\n")

    print("### Phase Adoption\n")
    print("| # | Phase | Label | Count | % of Total |")
    print("| - | ----- | ----- | ----: | ---------: |")
    for idx, f in enumerate(analysis["funnel"]):
        print(
            f"| {idx + 1} | {f['phase']} | `{f['label']}` "
            f"| {f['count']} | {f['rate_of_total']}% |"
        )
    print()

    print("### Conversion Funnel\n")
    print("| Transition | Rate |")
    print("| ---------- | ---: |")
    for i, f in enumerate(analysis["funnel"]):
        if i == 0:
            continue
        prev = analysis["funnel"][i - 1]
        print(
            f"| {prev['phase']} → {f['phase']} "
            f"| {f['conversion_from_prev']}% ({f['count']}/{prev['count']}) |"
        )
    print()

    by_project = analysis["by_project"]
    for proj_key in sorted(by_project):
        assignees = by_project[proj_key]
        proj_total = sum(len(iss_list) for iss_list in assignees.values())
        print(f"\n| {proj_key} | Tickets | More info |")
        print("| --- | ---: | --- |")
        for name in sorted(assignees, key=lambda n: (-len(assignees[n]), n)):
            iss_list = assignees[name]
            info = _build_more_info(iss_list)
            print(f"| {name} | {len(iss_list)} | {info} |")
        print(f"| **Total {proj_key}** | **{proj_total}** | |")
        print()

    print("### Data source\n")
    print(
        "Jira REST `POST /rest/api/2/search` (read-only). "
        "Tracks current labels on issues; does not inspect changelog. "
        "Labels tracked: `bot-cx-ai-spec`, `bot-cx-ai-plan`, "
        "`bot-cx-ai-dev`, `bot-cx-ai-code-review`."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Track SDD workflow adoption via Jira labels."
    )
    parser.add_argument(
        "--assignee",
        help="Filter by Jira assignee username (e.g. pablo.castaneda)",
    )
    parser.add_argument(
        "--project",
        help="Filter by Jira project key (e.g. SUMO, OCTOPUS)",
    )
    parser.add_argument(
        "--days",
        type=int,
        help="Last N days (alternative to --from-date/--to-date)",
    )
    parser.add_argument(
        "--from-date",
        help="Start date inclusive (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--to-date",
        help="End date inclusive (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--date-field",
        choices=("updated", "created"),
        default="updated",
        help="Jira field for date filtering (default: updated)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON output instead of markdown",
    )
    parser.add_argument(
        "--basic",
        action="store_true",
        help="Force HTTP Basic auth (JIRA_USERNAME + token)",
    )
    args = parser.parse_args()

    base = os.environ.get("JIRA_URL", "").strip()
    if not base:
        sys.exit("Missing JIRA_URL in environment.")

    token = resolve_token()
    user = os.environ.get("JIRA_USERNAME", "").strip()

    if not args.assignee and not args.project:
        sys.exit(
            "At least one filter is required: --assignee or --project. "
            "Example: --assignee pablo.castaneda --days 20"
        )

    if args.days and (args.from_date or args.to_date):
        sys.exit("Cannot combine --days with --from-date/--to-date.")

    date_from = args.from_date
    date_to = args.to_date
    if args.days:
        today = datetime.now()
        date_from = (today - timedelta(days=args.days)).strftime("%Y-%m-%d")
        date_to = today.strftime("%Y-%m-%d")

    jql = build_jql(
        assignee=args.assignee,
        project=args.project,
        date_from=date_from,
        date_to=date_to,
        date_field=args.date_field,
    )

    issues = collect_issues(
        base,
        jql,
        token=token,
        username=user,
        force_basic=args.basic,
    )

    analysis = analyze_issues(issues)

    if args.json:
        serializable_projects: dict[str, dict] = {}
        for proj_key, assignees in analysis["by_project"].items():
            proj_assignees: dict[str, list[dict]] = {}
            for name, iss_list in assignees.items():
                proj_assignees[name] = [
                    {
                        "key": iss["key"],
                        "summary": iss["summary"],
                        "issuetype": iss.get("issuetype", ""),
                        "status": iss.get("status", ""),
                    }
                    for iss in iss_list
                ]
            serializable_projects[proj_key] = {
                "total": sum(len(v) for v in assignees.values()),
                "assignees": proj_assignees,
            }
        output = {
            "assignee": args.assignee,
            "project": args.project,
            "date_from": date_from,
            "date_to": date_to,
            "date_field": args.date_field,
            "jql": jql,
            "total_issues": analysis["total_issues"],
            "phase_counts": analysis["phase_counts"],
            "funnel": analysis["funnel"],
            "by_project": serializable_projects,
        }
        print(json.dumps(output, indent=2, default=str))
    else:
        print_markdown(
            analysis,
            jql=jql,
            assignee=args.assignee,
            project=args.project,
            date_from=date_from,
            date_to=date_to,
            date_field=args.date_field,
        )


if __name__ == "__main__":
    main()
