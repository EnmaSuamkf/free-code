#!/usr/bin/env python3
"""Jira REST: fetch issue changelog and compute SSD spec → review lead time (read-only).

Env:
  JIRA_URL              — e.g. https://jira.example.org (no trailing slash required)
  JIRA_PERSONAL_TOKEN   — Data Center PAT (Bearer), or use JIRA_API_TOKEN

Optional:
  JIRA_USERNAME — if Bearer returns 401, the client retries with HTTP Basic (user:token)
                 unless --basic forces Basic first. Set JIRA_FORCE_BEARER_ONLY=1 to
                 never fall back to Basic.

Usage:
  python3 lead_time_from_changelog.py PROJ-123
  python3 lead_time_from_changelog.py PROJ-123 --json
  python3 lead_time_from_changelog.py PROJ-123 --basic
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from base64 import b64encode
from datetime import datetime

LABEL_SPEC = "bot-cx-ai-spec"
LABEL_REVIEW_PASSED = "bot-cx-ai-review-passed"
LABEL_CODE_REVIEW = "bot-cx-ai-code-review"

LABELS_TRACKED = (LABEL_SPEC, LABEL_REVIEW_PASSED, LABEL_CODE_REVIEW)


class JiraHTTPError(Exception):
    """Raised for failed Jira HTTP responses; carries status and body text for retry / messaging."""

    def __init__(self, code: int, body: str):
        super().__init__(f"HTTP {code}")
        self.code = code
        self.body = body


def resolve_jira_token() -> str:
    t = os.environ.get("JIRA_PERSONAL_TOKEN", "").strip() or os.environ.get("JIRA_API_TOKEN", "").strip()
    if not t:
        sys.exit("Missing JIRA_PERSONAL_TOKEN or JIRA_API_TOKEN in environment.")
    return t


def _label_set(from_or_to_string: str | None) -> set[str]:
    if not from_or_to_string or not str(from_or_to_string).strip():
        return set()
    return {t for t in re.split(r"[\s,]+", str(from_or_to_string).strip()) if t}


def _labels_from_jira_structured(val) -> set[str]:
    """Normalize Jira label values from `from` / `to` (string, list of strings, or mixed)."""
    if val is None:
        return set()
    if isinstance(val, list):
        out: set[str] = set()
        for x in val:
            if x is None:
                continue
            if isinstance(x, str):
                out |= _label_set(x)
            else:
                out |= _label_set(str(x))
        return out
    return _label_set(str(val))


def _before_after_label_sets(item: dict) -> tuple[set[str], set[str]]:
    """Derive label sets before/after from fromString/toString and/or structured from/to."""
    fs = item.get("fromString")
    ts = item.get("toString")
    before = _label_set(fs if fs is not None else None)
    after = _label_set(ts if ts is not None else None)
    # Jira may expose structured fields (prefer merging with strings when both exist)
    if "from" in item:
        before |= _labels_from_jira_structured(item.get("from"))
    if "to" in item:
        after |= _labels_from_jira_structured(item.get("to"))
    return before, after


def _parse_jira_datetime(iso: str) -> datetime:
    s = iso.strip()
    if s.endswith("+0100"):
        s = s[:-5] + "+01:00"
    elif s.endswith("-0100"):
        s = s[:-5] + "-01:00"
    elif len(s) >= 5 and (s[-5] in "+-") and s[-5] != "Z" and ":" not in s[-6:]:
        pass
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")


def _format_duration(seconds: float) -> str:
    if seconds < 0:
        neg = True
        seconds = -seconds
    else:
        neg = False
    days, rem = divmod(int(seconds), 86400)
    hours, rem = divmod(rem, 3600)
    mins = rem // 60
    base = f"{days}d {hours}h {mins}m"
    return ("−" if neg else "") + base


def first_adds_from_histories(histories: list[dict]) -> dict[str, dict | None]:
    ordered = sorted(histories, key=lambda h: h.get("created") or "")
    first: dict[str, dict | None] = {lab: None for lab in LABELS_TRACKED}

    for h in ordered:
        ts = h.get("created")
        author_obj = h.get("author") or {}
        author = author_obj.get("displayName") or author_obj.get("name") or ""
        for item in h.get("items") or []:
            field = (item.get("field") or "").lower()
            if field not in ("labels", "label"):
                continue
            before, after = _before_after_label_sets(item)
            added = after - before
            for lab in LABELS_TRACKED:
                if lab in added and first[lab] is None:
                    first[lab] = {"at": ts, "author": author}

    return first


def _chosen_review_end(
    first: dict[str, dict | None],
) -> tuple[dict | None, str | None]:
    """Prefer review-passed; otherwise code-review (teams use one or the other)."""
    rp = first[LABEL_REVIEW_PASSED]
    cr = first[LABEL_CODE_REVIEW]
    if rp:
        return rp, LABEL_REVIEW_PASSED
    if cr:
        return cr, LABEL_CODE_REVIEW
    return None, None


def _issue_get(
    base_url: str,
    issue_key: str,
    headers: dict[str, str],
) -> dict:
    url = (
        f"{base_url.rstrip('/')}/rest/api/2/issue/{urllib.parse.quote(issue_key, safe='')}"
        f"?expand=changelog&fields=created,labels,summary"
    )
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise JiraHTTPError(e.code, body) from e


def _changelog_page(
    base_url: str,
    issue_key: str,
    start_at: int,
    max_results: int,
    headers: dict[str, str],
) -> dict:
    q = urllib.parse.urlencode({"startAt": start_at, "maxResults": max_results})
    url = (
        f"{base_url.rstrip('/')}/rest/api/2/issue/{urllib.parse.quote(issue_key, safe='')}"
        f"/changelog?{q}"
    )
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise JiraHTTPError(e.code, body) from e


def _merge_changelog_pages(
    base_url: str,
    issue_key: str,
    payload: dict,
    headers: dict[str, str],
) -> None:
    """Mutate payload: append paginated changelog histories when the first page is incomplete."""
    cl = payload.get("changelog") or {}
    histories: list[dict] = list(cl.get("histories") or [])
    total = cl.get("total")
    if not isinstance(total, int) or total <= len(histories):
        cl["histories"] = histories
        payload["changelog"] = cl
        return

    start = len(histories)
    page_size = 100
    while start < total:
        try:
            page = _changelog_page(base_url, issue_key, start, page_size, headers)
        except JiraHTTPError:
            break
        chunk = page.get("histories") or page.get("values") or []
        if not chunk:
            break
        histories.extend(chunk)
        start += len(chunk)
        if len(chunk) < page_size:
            break

    cl["histories"] = histories
    payload["changelog"] = cl


def fetch_issue_changelog(
    base_url: str,
    issue_key: str,
    *,
    bearer_token: str | None,
    basic_user: str | None,
    basic_pass: str | None,
    force_basic: bool = False,
) -> dict:
    """Fetch issue + changelog. Bearer first unless force_basic; on 401 retry Basic if credentials allow."""
    no_basic_fallback = os.environ.get("JIRA_FORCE_BEARER_ONLY", "").strip() in ("1", "true", "yes")

    def headers_bearer(tok: str) -> dict[str, str]:
        return {"Accept": "application/json", "Authorization": f"Bearer {tok}"}

    def headers_basic(user: str, pw: str) -> dict[str, str]:
        raw = f"{user}:{pw}".encode("utf-8")
        auth = "Basic " + b64encode(raw).decode("ascii")
        return {"Accept": "application/json", "Authorization": auth}

    def fail(exc: JiraHTTPError) -> None:
        raise SystemExit(f"HTTP {exc.code} from Jira: {exc.body[:500]}") from exc

    token = (bearer_token or basic_pass or "").strip()
    user = (basic_user or "").strip()

    if force_basic and user and token:
        hdr = headers_basic(user, token)
        try:
            payload = _issue_get(base_url, issue_key, hdr)
            _merge_changelog_pages(base_url, issue_key, payload, hdr)
            return payload
        except JiraHTTPError as e:
            fail(e)

    # Default: Bearer first (token always as bearer), optional Basic retry on 401
    if token:
        hdr = headers_bearer(token)
        try:
            payload = _issue_get(base_url, issue_key, hdr)
            _merge_changelog_pages(base_url, issue_key, payload, hdr)
            return payload
        except JiraHTTPError as e:
            if (
                e.code == 401
                and user
                and token
                and not force_basic
                and not no_basic_fallback
            ):
                try:
                    hdr_b = headers_basic(user, token)
                    payload = _issue_get(base_url, issue_key, hdr_b)
                    _merge_changelog_pages(base_url, issue_key, payload, hdr_b)
                    return payload
                except JiraHTTPError as e2:
                    fail(e2)
            fail(e)

    raise SystemExit("No token for Jira auth.")


def analyze(payload: dict, issue_key: str) -> dict:
    fields = payload.get("fields") or {}
    cl = payload.get("changelog") or {}
    histories = cl.get("histories") or []
    total = cl.get("total")
    max_results = cl.get("maxResults", len(histories))

    warning = None
    if isinstance(total, int) and total > len(histories):
        warning = (
            f"Changelog may be truncated (total={total}, returned={len(histories)}). "
            "Reconcile in Jira UI or verify pagination."
        )

    first = first_adds_from_histories(histories)
    end_ev, end_label = _chosen_review_end(first)

    ts_spec = (first[LABEL_SPEC] or {}).get("at")
    ts_rev = (end_ev or {}).get("at")

    duration_sec = None
    duration_h = None
    duration_fmt = None
    if ts_spec and ts_rev:
        d0 = _parse_jira_datetime(ts_spec)
        d1 = _parse_jira_datetime(ts_rev)
        duration_sec = (d1 - d0).total_seconds()
        duration_fmt = _format_duration(duration_sec)
        duration_h = duration_sec / 3600.0
        if duration_sec < 0:
            duration_h = None

    review_end = None
    if end_ev and end_label:
        review_end = {"label": end_label, "at": end_ev.get("at"), "author": end_ev.get("author")}

    has_any_tracked = any(first[lab] is not None for lab in LABELS_TRACKED)
    current_labels = list(fields.get("labels") or [])

    diagnostic: str | None = None
    diag_parts: list[str] = []
    if LABEL_SPEC in current_labels and first[LABEL_SPEC] is None:
        diag_parts.append("bot_cx_spec_on_issue_but_no_spec_add_in_changelog")
    if (LABEL_REVIEW_PASSED in current_labels or LABEL_CODE_REVIEW in current_labels) and not (
        first[LABEL_REVIEW_PASSED] or first[LABEL_CODE_REVIEW]
    ):
        diag_parts.append("end_label_on_issue_but_no_end_add_in_changelog")
    if diag_parts:
        diagnostic = ";".join(diag_parts)

    summary_line = None
    if ts_spec and ts_rev:
        if duration_sec is not None and duration_sec < 0:
            summary_line = (
                f"INVALID — review end ({end_label}) is before first spec add "
                f"(delta {duration_fmt}; ~{duration_sec / 3600:.2f} h). Check changelog order/data."
            )
        else:
            summary_line = f"Spec → code review: {duration_fmt} (~{duration_h:.2f} h wall; end=`{end_label}`)"
    elif not has_any_tracked:
        summary_line = (
            "N/A — no changelog adds for bot-cx-ai-spec or end labels "
            "(bot-cx-ai-review-passed / bot-cx-ai-code-review)"
        )
    elif not ts_spec:
        summary_line = "N/A — missing first add of bot-cx-ai-spec"
    else:
        summary_line = (
            "N/A — missing first add of bot-cx-ai-review-passed or bot-cx-ai-code-review"
        )

    return {
        "issue_key": payload.get("key") or issue_key,
        "summary": fields.get("summary"),
        "created": fields.get("created"),
        "current_labels": current_labels,
        "first_spec_add": first[LABEL_SPEC],
        "first_review_passed_add": first[LABEL_REVIEW_PASSED],
        "first_code_review_add": first[LABEL_CODE_REVIEW],
        "review_end": review_end,
        "duration_human": duration_fmt,
        "duration_hours_wall": duration_h,
        "summary_line": summary_line,
        "truncation_warning": warning,
        "changelog_histories_returned": len(histories),
        "changelog_total_reported": total,
        "diagnostic": diagnostic,
    }


def print_markdown(result: dict) -> None:
    key = result["issue_key"]
    print(f"## SSD spec → review lead time — {key}\n")
    print(f"**Summary**: {result['summary_line']}\n")
    if result.get("diagnostic"):
        print(f"**Diagnostic**: `{result['diagnostic']}`\n")
    print("| Label                   | First added | Author |")
    print("| ----------------------- | ----------- | ------ |")

    def row(label_key: str, first: dict | None):
        if not first:
            return f"| {label_key} | — | — |"
        return f"| {label_key} | {first.get('at')} | {first.get('author') or '—'} |"

    print(row(LABEL_SPEC, result["first_spec_add"]))
    print(row(LABEL_REVIEW_PASSED, result["first_review_passed_add"]))
    print(row(LABEL_CODE_REVIEW, result["first_code_review_add"]))
    re_end = result.get("review_end")
    if re_end:
        print(f"\n**End used for duration**: `{re_end.get('label')}` at {re_end.get('at')}\n")
    print("\n### Spec → code review\n")
    print("| Metric             | Duration | Notes |")
    print("| ------------------ | -------- | ----- |")
    dur = result["duration_human"] or "—"
    notes = "Jira REST `expand=changelog`"
    if result.get("review_end"):
        notes += f"; end=`{result['review_end']['label']}`"
    if result.get("truncation_warning"):
        notes += f"; WARN: {result['truncation_warning']}"
    if result.get("diagnostic"):
        notes += f"; diagnostic=`{result['diagnostic']}`"
    print(f"| Spec → code review | {dur} | {notes} |")
    print("\n### Current labels\n")
    labels = result.get("current_labels") or []
    print(", ".join(labels) if labels else "—")
    print("\n### Data source\n")
    print(
        "Jira REST GET `/rest/api/2/issue/{key}?expand=changelog&fields=created,labels,summary` (read-only). "
        "**Metric**: first add `bot-cx-ai-spec` → first add `bot-cx-ai-review-passed` "
        "(preferred) or `bot-cx-ai-code-review` if review-passed never appears in changelog."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="SSD spec→review lead time via Jira REST changelog.")
    parser.add_argument("issue_key", help="e.g. INFINITY-3538")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown")
    parser.add_argument(
        "--basic",
        action="store_true",
        help="Force HTTP Basic (JIRA_USERNAME + token). Default is Bearer first, Basic on 401.",
    )
    args = parser.parse_args()

    base = os.environ.get("JIRA_URL", "").strip()
    if not base:
        sys.exit("Missing JIRA_URL in environment.")

    token = resolve_jira_token()
    user = os.environ.get("JIRA_USERNAME", "").strip()

    payload = fetch_issue_changelog(
        base,
        args.issue_key,
        bearer_token=token,
        basic_user=user if user else None,
        basic_pass=token,
        force_basic=args.basic,
    )

    result = analyze(payload, args.issue_key)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_markdown(result)


if __name__ == "__main__":
    main()
