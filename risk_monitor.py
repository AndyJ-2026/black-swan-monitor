#!/usr/bin/env python3
"""Token-level black swan risk scanner.

This scanner is designed for stateless remote triggers: it keeps the durable
dedupe state in sent_events.json, prioritizes recent problem coins, and rotates
through the larger listed-token universe between runs.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import quote_plus

import requests

BASE_DIR = Path(__file__).parent
TWITTER_HANDLES_FILE = BASE_DIR / "twitter_handles.txt"
SENT_EVENTS_FILE = BASE_DIR / "sent_events.json"
REPORTS_DIR = BASE_DIR / "reports"
LATEST_REPORT_FILE = REPORTS_DIR / "latest.json"

DEFAULT_RELAY_URL = "https://black-swan-mcp.ysf63453.workers.dev/send-lark"
REQUEST_TIMEOUT = 12
DEFAULT_LIMIT = 80
DEFAULT_MAX_WORKERS = 8
DEFAULT_EVENT_TTL_DAYS = 30
DEFAULT_UPDATE_COOLDOWN_HOURS = 12
DEFAULT_PRIORITY_COINS = ["SWEAT", "AAVE", "DRIFT"]

RISK_KEYWORDS = [
    "hack",
    "hacked",
    "exploit",
    "exploited",
    "stolen",
    "stole",
    "drained",
    "drain",
    "compromised",
    "breach",
    "attack",
    "vulnerability",
    "incident",
    "abnormal",
    "suspicious",
    "phishing",
    "emergency",
    "pause",
    "paused",
    "suspend",
    "suspended",
    "withdrawal",
    "withdrawals",
    "deposit",
    "deposits",
    "migration",
    "migrate",
    "token swap",
    "contract swap",
    "new contract",
    "delist",
    "delisting",
    "被盗",
    "攻击",
    "漏洞",
    "异常",
    "暂停",
    "迁移",
    "下架",
]

CRITICAL_KEYWORDS = [
    "hack",
    "hacked",
    "exploit",
    "exploited",
    "stolen",
    "stole",
    "drained",
    "compromised",
    "breach",
    "attack",
    "vulnerability",
    "phishing",
    "emergency",
    "被盗",
    "攻击",
    "漏洞",
]

WARNING_KEYWORDS = [
    "abnormal",
    "suspicious",
    "incident",
    "pause",
    "paused",
    "suspend",
    "suspended",
    "withdrawal",
    "withdrawals",
    "deposit",
    "deposits",
    "异常",
    "暂停",
]

EVENT_TYPE_KEYWORDS = [
    ("security_incident", CRITICAL_KEYWORDS),
    ("service_suspension", WARNING_KEYWORDS),
    ("token_migration", ["migration", "migrate", "token swap", "contract swap", "new contract", "迁移"]),
    ("delisting", ["delist", "delisting", "下架"]),
]


@dataclass
class Account:
    coin: str
    handle: str


@dataclass
class CandidateEvent:
    coin: str
    event_type: str
    severity: str
    summary: str
    source: str
    url: str
    detected_at: str


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip()).lower()


def summary_fingerprint(summary: str) -> str:
    normalized = normalize_text(summary)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def classify_event_type(text: str) -> str:
    lower = text.lower()
    for event_type, keywords in EVENT_TYPE_KEYWORDS:
        if any(keyword in lower for keyword in keywords):
            return event_type
    return "risk_signal"


def classify_severity(text: str) -> str:
    lower = text.lower()
    if any(keyword in lower for keyword in CRITICAL_KEYWORDS):
        return "CRITICAL"
    if any(keyword in lower for keyword in WARNING_KEYWORDS):
        return "WARNING"
    return "INFO"


def load_accounts(path: Path = TWITTER_HANDLES_FILE) -> list[Account]:
    accounts: list[Account] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 2:
                continue
            coin = row[0].strip()
            handle = row[1].strip().lstrip("@")
            if not coin or not handle or coin.lower() == "currency":
                continue
            accounts.append(Account(coin=coin.upper(), handle=handle))
    return accounts


def load_event_state(path: Path = SENT_EVENTS_FILE) -> dict:
    default = {"version": 1, "meta": {"scan_offset": 0}, "events": []}
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except json.JSONDecodeError:
        return default
    state.setdefault("version", 1)
    state.setdefault("meta", {})
    state["meta"].setdefault("scan_offset", 0)
    state.setdefault("events", [])
    return state


def save_event_state(state: dict, path: Path = SENT_EVENTS_FILE) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
        f.write("\n")


def cleanup_old_events(state: dict, ttl_days: int = DEFAULT_EVENT_TTL_DAYS) -> None:
    cutoff = utc_now() - timedelta(days=ttl_days)
    fresh = []
    for event in state.get("events", []):
        last_sent = parse_iso(event.get("last_sent"))
        if not last_sent or last_sent >= cutoff:
            fresh.append(event)
    state["events"] = fresh


def choose_accounts(accounts: list[Account], priority_coins: Iterable[str], limit: int, state: dict) -> list[Account]:
    priority_order = [coin.upper() for coin in priority_coins]
    priority_set = set(priority_order)
    priority_by_coin: dict[str, Account] = {}
    regular = []
    seen_keys = set()

    for account in accounts:
        key = (account.coin, account.handle.lower())
        if key in seen_keys:
            continue
        seen_keys.add(key)
        if account.coin in priority_set:
            priority_by_coin.setdefault(account.coin, account)
        else:
            regular.append(account)

    priority = [priority_by_coin[coin] for coin in priority_order if coin in priority_by_coin]
    if limit <= len(priority):
        return priority[:limit]

    offset = int(state.get("meta", {}).get("scan_offset", 0))
    remaining = limit - len(priority)
    rotated = regular[offset:] + regular[:offset]
    selected_regular = rotated[:remaining]
    if regular:
        state["meta"]["scan_offset"] = (offset + len(selected_regular)) % len(regular)
    return priority + selected_regular


def extract_relevant_lines(text: str, max_lines: int = 8) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    snippets = []
    for i, line in enumerate(lines):
        lower = line.lower()
        if any(keyword in lower for keyword in RISK_KEYWORDS):
            start = max(0, i - 1)
            end = min(len(lines), i + 3)
            snippets.extend(lines[start:end])
    unique = []
    for line in snippets:
        if line not in unique:
            unique.append(line)
    return "\n".join(unique[:max_lines])


def scan_jina(account: Account) -> Optional[CandidateEvent]:
    # Jina accepts both twitter.com and x.com; twitter.com is slightly more stable.
    url = f"https://r.jina.ai/http://twitter.com/{account.handle}"
    resp = requests.get(url, headers={"Accept": "text/markdown"}, timeout=REQUEST_TIMEOUT)
    if not resp.ok or len(resp.text) < 120:
        raise RuntimeError(f"Jina returned HTTP {resp.status_code} for @{account.handle}")

    context = extract_relevant_lines(resp.text)
    if not context:
        return None

    return CandidateEvent(
        coin=account.coin,
        event_type=classify_event_type(context),
        severity=classify_severity(context),
        summary=context,
        source="jina_twitter",
        url=f"https://x.com/{account.handle}",
        detected_at=utc_now().isoformat(),
    )


def scan_gdelt(account: Account) -> Optional[CandidateEvent]:
    query = (
        f'"{account.coin}" '
        "(hack OR hacked OR exploit OR stolen OR drained OR compromised OR vulnerability "
        "OR suspend OR paused OR migration OR delisting)"
    )
    url = (
        "https://api.gdeltproject.org/api/v2/doc/doc"
        f"?query={quote_plus(query)}&mode=ArtList&format=json&maxrecords=5&sort=HybridRel"
    )
    resp = requests.get(url, headers={"User-Agent": "black-swan-monitor/1.0"}, timeout=REQUEST_TIMEOUT)
    if not resp.ok:
        raise RuntimeError(f"GDELT returned HTTP {resp.status_code} for {account.coin}")
    data = resp.json()
    articles = data.get("articles", [])
    snippets = []
    for article in articles:
        title = article.get("title", "")
        domain = article.get("domain", "")
        article_url = article.get("url", "")
        text = f"{title} {domain}"
        if account.coin.lower() in text.lower() and any(keyword in text.lower() for keyword in RISK_KEYWORDS):
            snippets.append(f"- {title} ({domain}) {article_url}".strip())

    if not snippets:
        return None

    summary = "\n".join(snippets[:5])
    return CandidateEvent(
        coin=account.coin,
        event_type=classify_event_type(summary),
        severity=classify_severity(summary),
        summary=summary,
        source="gdelt_news_fallback",
        url=url,
        detected_at=utc_now().isoformat(),
    )


def scan_account(account: Account, use_fallback: bool = True) -> tuple[Optional[CandidateEvent], Optional[str]]:
    try:
        return scan_jina(account), None
    except Exception as exc:
        if not use_fallback:
            return None, f"{account.coin}(@{account.handle}) Jina failed: {exc}"
        try:
            return scan_gdelt(account), f"{account.coin}(@{account.handle}) Jina failed; used fallback"
        except Exception as fallback_exc:
            return None, f"{account.coin}(@{account.handle}) Jina failed: {exc}; fallback failed: {fallback_exc}"


def should_send_event(state: dict, candidate: CandidateEvent, cooldown_hours: int) -> tuple[bool, str, Optional[dict]]:
    fingerprint = summary_fingerprint(candidate.summary)
    now = parse_iso(candidate.detected_at) or utc_now()

    for event in state.get("events", []):
        if event.get("coin") != candidate.coin or event.get("event_type") != candidate.event_type:
            continue
        if event.get("summary_hash") == fingerprint:
            return False, "duplicate", event
        last_sent = parse_iso(event.get("last_sent"))
        if last_sent and now - last_sent < timedelta(hours=cooldown_hours):
            return False, "cooldown", event
        return True, "material_update", event

    return True, "new_event", None


def record_event(state: dict, candidate: CandidateEvent, reason: str, existing: Optional[dict]) -> None:
    fingerprint = summary_fingerprint(candidate.summary)
    now = candidate.detected_at

    if existing:
        existing.update(
            {
                "last_sent": now,
                "summary": candidate.summary,
                "summary_hash": fingerprint,
                "severity": candidate.severity,
                "source": candidate.source,
                "url": candidate.url,
                "update_count": int(existing.get("update_count", 0)) + 1,
            }
        )
        return

    state.setdefault("events", []).append(
        {
            "coin": candidate.coin,
            "event_type": candidate.event_type,
            "first_seen": now,
            "last_sent": now,
            "summary": candidate.summary,
            "summary_hash": fingerprint,
            "severity": candidate.severity,
            "source": candidate.source,
            "url": candidate.url,
            "send_reason": reason,
            "update_count": 0,
        }
    )


def build_report(events: list[tuple[CandidateEvent, str]], scanned: int, failures: list[str]) -> dict:
    now = utc_now().strftime("%Y-%m-%d %H:%M UTC")
    if events:
        max_severity = "CRITICAL" if any(e.severity == "CRITICAL" for e, _ in events) else "WARNING"
        header_color = "red" if max_severity == "CRITICAL" else "orange"
        header_title = f"黑天鹅币种监控：{len(events)} 条风险信号"
        lines = [f"**扫描时间:** {now}", f"**覆盖:** {scanned} 个币种账号", ""]
        for event, reason in events:
            label = "进展更新" if reason == "material_update" else "新事件"
            lines.extend(
                [
                    f"### [{event.severity}] {event.coin} - {event.event_type} ({label})",
                    f"**来源:** {event.source}",
                    f"**链接:** {event.url}",
                    "",
                    event.summary[:1800],
                    "",
                ]
            )
    else:
        header_color = "green"
        header_title = "黑天鹅币种监控：暂无新增风险"
        lines = [f"**扫描时间:** {now}", f"**覆盖:** {scanned} 个币种账号", "暂无可推送新增事件。"]

    if failures:
        lines.extend(["", "**扫描异常:**", *[f"- {failure}" for failure in failures[:20]]])

    return {
        "header_title": header_title,
        "header_color": header_color,
        "report": "\n".join(lines),
        "event_count": len(events),
        "scanned_count": scanned,
        "failure_count": len(failures),
        "generated_at": utc_now().isoformat(),
    }


def save_report(report: dict) -> None:
    REPORTS_DIR.mkdir(exist_ok=True)
    with open(LATEST_REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
        f.write("\n")


def send_report(report: dict) -> dict:
    if report["event_count"] == 0 and os.environ.get("BSM_SEND_EMPTY", "false").lower() != "true":
        return {"ok": True, "skipped": "empty_report"}

    relay_secret = os.environ.get("BSM_RELAY_SECRET", "")
    webhook_url = os.environ.get("BSM_LARK_WEBHOOK_URL", "")
    webhook_secret = os.environ.get("BSM_LARK_WEBHOOK_SECRET", "")
    relay_url = os.environ.get("BSM_RELAY_URL") or DEFAULT_RELAY_URL

    if not relay_secret or not webhook_url:
        raise RuntimeError("Missing BSM relay secret or Lark webhook URL")

    resp = requests.post(
        relay_url,
        json={
            "secret": relay_secret,
            "webhook_url": webhook_url,
            "webhook_secret": webhook_secret,
            "header_title": report["header_title"],
            "header_color": report["header_color"],
            "content": report["report"],
        },
        timeout=REQUEST_TIMEOUT,
    )
    body = resp.text
    try:
        parsed = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"Relay returned non-JSON response: {body}") from exc

    if not resp.ok or not parsed.get("ok"):
        raise RuntimeError(f"Relay send failed: HTTP {resp.status_code} {body}")
    return parsed


def run_scan(args: argparse.Namespace) -> dict:
    state = load_event_state()
    cleanup_old_events(state, ttl_days=args.ttl_days)

    priority = [coin.strip().upper() for coin in args.priority_coins.split(",") if coin.strip()]
    priority_set = set(priority)
    accounts = load_accounts()
    selected = choose_accounts(accounts, priority, args.limit, state)

    sendable: list[tuple[CandidateEvent, str]] = []
    failures: list[str] = []

    with ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        futures = {
            executor.submit(
                scan_account,
                account,
                (not args.no_fallback) and account.coin in priority_set,
            ): account
            for account in selected
        }
        completed = []
        for future in as_completed(futures):
            completed.append((futures[future], future.result()))

    completed.sort(key=lambda item: selected.index(item[0]))

    for account, (candidate, warning) in completed:
        if warning:
            failures.append(warning)
        if not candidate:
            continue
        should_send, reason, existing = should_send_event(state, candidate, args.cooldown_hours)
        if should_send:
            sendable.append((candidate, reason))
            if not args.dry_run:
                record_event(state, candidate, reason, existing)
        time.sleep(args.sleep)

    report = build_report(sendable, scanned=len(selected), failures=failures)
    if not args.dry_run:
        state["meta"]["last_scan"] = utc_now().isoformat()
        save_event_state(state)
        save_report(report)
        if args.send:
            report["send_result"] = send_report(report)
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scan listed tokens for black swan risk signals.")
    parser.add_argument("--limit", type=int, default=int(os.environ.get("BSM_SCAN_LIMIT", DEFAULT_LIMIT)))
    parser.add_argument(
        "--priority-coins",
        default=os.environ.get("BSM_PRIORITY_COINS", ",".join(DEFAULT_PRIORITY_COINS)),
        help="Comma-separated coins scanned first every run.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--send", action="store_true", default=os.environ.get("BSM_SEND_LARK", "false").lower() == "true")
    parser.add_argument("--no-fallback", action="store_true", help="Disable GDELT fallback when Jina fails.")
    parser.add_argument("--ttl-days", type=int, default=DEFAULT_EVENT_TTL_DAYS)
    parser.add_argument("--cooldown-hours", type=int, default=DEFAULT_UPDATE_COOLDOWN_HOURS)
    parser.add_argument("--max-workers", type=int, default=int(os.environ.get("BSM_MAX_WORKERS", DEFAULT_MAX_WORKERS)))
    parser.add_argument("--sleep", type=float, default=float(os.environ.get("BSM_SCAN_SLEEP", "0.5")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = run_scan(args)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
