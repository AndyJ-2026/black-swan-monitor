#!/usr/bin/env python3
"""Token-level black swan risk scanner.

This scanner is designed for post-listing operations: it monitors project
official X/Twitter accounts for project-level blow-up signals, keeps durable
dedupe state in sent_events.json, and scans account buckets to reduce X rate
limit risk.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import time
from html import unescape
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus

import requests

BASE_DIR = Path(__file__).parent
TWITTER_HANDLES_FILE = BASE_DIR / "twitter_handles.txt"
SENT_EVENTS_FILE = BASE_DIR / "sent_events.json"
REPORTS_DIR = BASE_DIR / "reports"
LATEST_REPORT_FILE = REPORTS_DIR / "latest.json"

DEFAULT_RELAY_URL = "https://black-swan-mcp.ysf63453.workers.dev/send-lark"
REQUEST_TIMEOUT = 12
DEFAULT_LIMIT = 0
DEFAULT_MAX_WORKERS = 8
DEFAULT_BUCKETS = 3
DEFAULT_EVENT_TTL_DAYS = 30
DEFAULT_UPDATE_COOLDOWN_HOURS = 12

X_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

X_FEATURES = {
    "rweb_video_screen_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "rweb_tipjar_consumption_enabled": True,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "premium_content_api_read_enabled": False,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "responsive_web_jetfuel_frame": False,
    "responsive_web_grok_share_attachment_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "responsive_web_grok_show_grok_translated_post": False,
    "responsive_web_grok_analysis_button_from_backend": False,
    "creator_subscriptions_quote_tweet_preview_enabled": False,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "responsive_web_grok_image_annotation_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
}

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
    "private key",
    "key leak",
    "leaked key",
    "oracle issue",
    "reentrancy",
    "mint exploit",
    "infinite mint",
    "contract bug",
    "contract issue",
    "contract compromised",
    "bridge exploit",
    "bridge hacked",
    "bridge halted",
    "bridge down",
    "bridge issue",
    "rug",
    "rugged",
    "rugpull",
    "rug pull",
    "exit scam",
    "team abandoned",
    "abandoned project",
    "insolvent",
    "insolvency",
    "bankruptcy",
    "shut down",
    "shutdown",
    "cease operations",
    "halt operations",
    "stopping operations",
    "tokenomics",
    "supply issue",
    "depeg",
    "incident",
    "abnormal",
    "suspicious",
    "phishing",
    "emergency",
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
    "私钥",
    "密钥泄露",
    "预言机",
    "重入",
    "增发",
    "无限铸造",
    "合约异常",
    "合约漏洞",
    "桥断",
    "跨链桥",
    "跑路",
    "软跑路",
    "Rug",
    "卷款",
    "破产",
    "资不抵债",
    "停止运营",
    "项目停止",
    "脱锚",
    "经济模型",
    "异常",
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
    "private key",
    "key leak",
    "leaked key",
    "oracle issue",
    "reentrancy",
    "mint exploit",
    "infinite mint",
    "contract compromised",
    "bridge exploit",
    "bridge hacked",
    "rug",
    "rugged",
    "rugpull",
    "rug pull",
    "exit scam",
    "insolvent",
    "bankruptcy",
    "shut down",
    "shutdown",
    "phishing",
    "emergency",
    "被盗",
    "攻击",
    "漏洞",
    "私钥",
    "密钥泄露",
    "预言机",
    "重入",
    "无限铸造",
    "合约漏洞",
    "桥断",
    "跨链桥",
    "跑路",
    "软跑路",
    "卷款",
    "破产",
    "停止运营",
]

WARNING_KEYWORDS = [
    "abnormal",
    "suspicious",
    "incident",
    "bridge halted",
    "bridge down",
    "bridge issue",
    "contract bug",
    "contract issue",
    "tokenomics",
    "supply issue",
    "depeg",
    "migration",
    "token swap",
    "contract swap",
    "new contract",
    "delist",
    "delisting",
    "异常",
    "合约异常",
    "脱锚",
    "经济模型",
    "迁移",
    "下架",
]

EVENT_TYPE_KEYWORDS = [
    ("rug_or_exit", ["rug", "rugged", "rugpull", "rug pull", "exit scam", "team abandoned", "abandoned project", "跑路", "软跑路", "卷款"]),
    ("bridge_incident", ["bridge exploit", "bridge hacked", "bridge halted", "bridge down", "bridge issue", "跨链桥", "桥断"]),
    ("contract_or_key_incident", ["private key", "key leak", "leaked key", "oracle issue", "reentrancy", "mint exploit", "infinite mint", "contract bug", "contract issue", "contract compromised", "私钥", "密钥泄露", "预言机", "重入", "无限铸造", "合约"]),
    ("security_incident", CRITICAL_KEYWORDS),
    ("project_shutdown", ["insolvent", "insolvency", "bankruptcy", "shut down", "shutdown", "cease operations", "halt operations", "stopping operations", "破产", "资不抵债", "停止运营", "项目停止"]),
    ("tokenomics_or_depeg", ["tokenomics", "supply issue", "depeg", "经济模型", "脱锚"]),
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


@dataclass
class Tweet:
    id: str
    text: str
    url: str


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


def parse_cookie_header(cookie_header: str) -> dict[str, str]:
    cookies = {}
    for part in cookie_header.split(";"):
        if "=" not in part:
            continue
        key, value = part.strip().split("=", 1)
        if key:
            cookies[key] = value
    return cookies


def load_x_cookie_pool() -> list[str]:
    raw = os.environ.get("BSM_X_COOKIES_JSON", "").strip()
    if not raw:
        return []
    data = json.loads(raw)
    if isinstance(data, str):
        return [data]
    if isinstance(data, list):
        pool = []
        for item in data:
            if isinstance(item, str):
                pool.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("cookie"), str):
                    pool.append(item["cookie"])
                elif isinstance(item.get("cookies"), dict):
                    pool.append("; ".join(f"{k}={v}" for k, v in item["cookies"].items()))
        return [cookie for cookie in pool if cookie]
    if isinstance(data, dict):
        if isinstance(data.get("cookie"), str):
            return [data["cookie"]]
        if isinstance(data.get("cookies"), dict):
            return ["; ".join(f"{k}={v}" for k, v in data["cookies"].items())]
    return []


def extract_tweets_from_graphql(payload: dict, handle: str) -> list[Tweet]:
    tweets: list[Tweet] = []

    def walk(value):
        if isinstance(value, dict):
            legacy = value.get("legacy")
            tweet_id = value.get("rest_id")
            if isinstance(legacy, dict) and tweet_id and legacy.get("full_text"):
                text = unescape(str(legacy["full_text"]))
                tweets.append(Tweet(id=str(tweet_id), text=text, url=f"https://x.com/{handle}/status/{tweet_id}"))
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(payload)
    unique = []
    seen = set()
    for tweet in tweets:
        if tweet.id in seen:
            continue
        seen.add(tweet.id)
        unique.append(tweet)
    return unique


class XWebClient:
    def __init__(self, cookie_header: str):
        self.cookie_header = cookie_header
        self.cookies = parse_cookie_header(cookie_header)
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": X_USER_AGENT,
                "Accept": "*/*",
                "Cookie": cookie_header,
                "x-csrf-token": self.cookies.get("ct0", ""),
                "x-twitter-auth-type": "OAuth2Session",
                "x-twitter-active-user": "yes",
                "x-twitter-client-language": "en",
            }
        )
        self.bearer = ""
        self.user_by_screen_name_query_id = ""
        self.user_tweets_query_id = ""

    def bootstrap(self) -> None:
        resp = self.session.get("https://x.com/home", timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        script_match = re.search(r'https://abs\.twimg\.com/responsive-web/client-web/main\.[^"\s]+\.js', resp.text)
        if not script_match:
            raise RuntimeError("Could not find X main JS")
        main_js = self.session.get(script_match.group(0), timeout=REQUEST_TIMEOUT)
        main_js.raise_for_status()

        bearer_match = re.search(r"Bearer ([A-Za-z0-9%]+)", main_js.text)
        user_match = re.search(r'queryId:"([^"]+)",operationName:"UserByScreenName"', main_js.text)
        tweets_match = re.search(r'queryId:"([^"]+)",operationName:"UserTweets"', main_js.text)
        if not bearer_match or not user_match or not tweets_match:
            raise RuntimeError("Could not parse X GraphQL query metadata")

        self.bearer = bearer_match.group(1)
        self.user_by_screen_name_query_id = user_match.group(1)
        self.user_tweets_query_id = tweets_match.group(1)
        self.session.headers.update({"authorization": f"Bearer {self.bearer}"})

    def get_user_id(self, handle: str) -> str:
        params = {
            "variables": json.dumps({"screen_name": handle}, separators=(",", ":")),
            "features": json.dumps(X_FEATURES, separators=(",", ":")),
        }
        resp = self.session.get(
            f"https://x.com/i/api/graphql/{self.user_by_screen_name_query_id}/UserByScreenName",
            params=params,
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code == 429:
            raise RuntimeError(f"X rate limited while resolving @{handle}")
        resp.raise_for_status()
        user_id = resp.json().get("data", {}).get("user", {}).get("result", {}).get("rest_id")
        if not user_id:
            raise RuntimeError(f"X did not return user id for @{handle}")
        return str(user_id)

    def get_tweets(self, account: Account, count: int = 20) -> list[Tweet]:
        user_id = self.get_user_id(account.handle)
        variables = {
            "userId": user_id,
            "count": count,
            "includePromotedContent": False,
            "withQuickPromoteEligibilityTweetFields": True,
            "withVoice": True,
            "withV2Timeline": True,
        }
        field_toggles = {"withArticlePlainText": False}
        params = {
            "variables": json.dumps(variables, separators=(",", ":")),
            "features": json.dumps(X_FEATURES, separators=(",", ":")),
            "fieldToggles": json.dumps(field_toggles, separators=(",", ":")),
        }
        resp = self.session.get(
            f"https://x.com/i/api/graphql/{self.user_tweets_query_id}/UserTweets",
            params=params,
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code == 429:
            raise RuntimeError(f"X rate limited while reading @{account.handle}")
        resp.raise_for_status()
        return extract_tweets_from_graphql(resp.json(), account.handle)


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
    default = {"version": 1, "meta": {"scan_bucket": 0}, "events": []}
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except json.JSONDecodeError:
        return default
    state.setdefault("version", 1)
    state.setdefault("meta", {})
    state["meta"].setdefault("scan_bucket", 0)
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


def choose_accounts(accounts: list[Account], limit: int, buckets: int, bucket_index: Optional[int], state: dict) -> list[Account]:
    unique = []
    seen_keys = set()

    for account in accounts:
        key = (account.coin, account.handle.lower())
        if key in seen_keys:
            continue
        seen_keys.add(key)
        unique.append(account)

    if limit and limit > 0:
        return unique[:limit]

    buckets = max(1, buckets)
    if buckets == 1:
        state.setdefault("meta", {})["scan_bucket"] = 0
        return unique

    meta = state.setdefault("meta", {})
    active_bucket = bucket_index if bucket_index is not None else int(meta.get("scan_bucket", 0))
    active_bucket = active_bucket % buckets
    selected = [account for idx, account in enumerate(unique) if idx % buckets == active_bucket]
    meta["scan_bucket"] = (active_bucket + 1) % buckets
    meta["scan_buckets"] = buckets
    meta["last_scan_bucket"] = active_bucket
    return selected


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


def is_project_relevant(account: Account, text: str) -> bool:
    lower = text.lower()
    coin = re.escape(account.coin.lower())
    handle = re.escape(account.handle.lower())
    if re.search(rf"(?<![a-z0-9])[$#]?{coin}(?![a-z0-9])", lower):
        return True
    if account.handle and re.search(rf"(?<![a-z0-9_])@?{handle}(?![a-z0-9_])", lower):
        return True

    first_person_patterns = [
        r"\bwe\b",
        r"\bwe['’]re\b",
        r"\bwe are\b",
        r"\bour\b",
        r"\bours\b",
        r"\bus\b",
        r"\bteam\b",
        r"\bcommunity\b",
        r"\bprotocol\b",
        r"\bbridge\b",
        r"\bcontract\b",
        r"\bwallet\b",
        r"\bapp\b",
        r"\bdapp\b",
        r"\bmainnet\b",
        r"\btoken\b",
        r"\busers\b",
        "用户",
        "我们",
        "团队",
        "社区",
        "协议",
        "合约",
        "钱包",
        "应用",
        "主网",
        "代币",
    ]
    if any(re.search(pattern, lower) for pattern in first_person_patterns):
        return True

    return False


def build_event_from_text(account: Account, text: str, source: str, url: str) -> Optional[CandidateEvent]:
    if not is_project_relevant(account, text):
        return None
    context = extract_relevant_lines(text)
    if not context:
        return None
    return CandidateEvent(
        coin=account.coin,
        event_type=classify_event_type(context),
        severity=classify_severity(context),
        summary=context,
        source=source,
        url=url,
        detected_at=utc_now().isoformat(),
    )


def scan_x_native(account: Account, x_client: XWebClient) -> Optional[CandidateEvent]:
    tweets = x_client.get_tweets(account)
    if not tweets:
        return None
    relevant_tweets = []
    for tweet in tweets:
        text = f"{tweet.url}\n{tweet.text}"
        if is_project_relevant(account, tweet.text) and extract_relevant_lines(tweet.text):
            relevant_tweets.append(text)
    if not relevant_tweets:
        return None
    combined = "\n\n".join(relevant_tweets)
    return build_event_from_text(account, combined, "x_native_graphql", f"https://x.com/{account.handle}")


def scan_jina(account: Account) -> Optional[CandidateEvent]:
    # Jina accepts both twitter.com and x.com; twitter.com is slightly more stable.
    url = f"https://r.jina.ai/http://twitter.com/{account.handle}"
    resp = requests.get(url, headers={"Accept": "text/markdown"}, timeout=REQUEST_TIMEOUT)
    if not resp.ok or len(resp.text) < 120:
        raise RuntimeError(f"Jina returned HTTP {resp.status_code} for @{account.handle}")

    return build_event_from_text(account, resp.text, "jina_twitter", f"https://x.com/{account.handle}")


def scan_gdelt(account: Account) -> Optional[CandidateEvent]:
    query = (
        f'"{account.coin}" '
        "(hack OR hacked OR exploit OR stolen OR drained OR compromised OR vulnerability OR rug "
        "OR rugpull OR \"exit scam\" OR \"private key\" OR \"bridge exploit\" OR \"bridge halted\" "
        "OR \"shut down\" OR bankruptcy OR insolvent OR depeg OR tokenomics)"
    )
    url = (
        "https://api.gdeltproject.org/api/v2/doc/doc"
        f"?query={quote_plus(query)}&mode=ArtList&format=json&maxrecords=5&sort=HybridRel"
    )
    resp = requests.get(url, headers={"User-Agent": "black-swan-monitor/1.0"}, timeout=REQUEST_TIMEOUT)
    if not resp.ok:
        raise RuntimeError(f"GDELT returned HTTP {resp.status_code} for {account.coin}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"GDELT returned non-JSON response for {account.coin}: {resp.text[:120]}") from exc
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


def scan_account(
    account: Account,
    use_fallback: bool = True,
    x_client: Optional[XWebClient] = None,
) -> tuple[Optional[CandidateEvent], Optional[str]]:
    if x_client:
        try:
            return scan_x_native(account, x_client), None
        except Exception as exc:
            if not use_fallback:
                return None, f"{account.coin}(@{account.handle}) X native failed: {exc}"
            native_error = exc
        try:
            return scan_jina(account), f"{account.coin}(@{account.handle}) X native failed; used Jina fallback"
        except Exception as jina_exc:
            try:
                return scan_gdelt(account), f"{account.coin}(@{account.handle}) X native failed: {native_error}; Jina failed: {jina_exc}; used news fallback"
            except Exception as fallback_exc:
                return None, f"{account.coin}(@{account.handle}) X native failed: {native_error}; Jina failed: {jina_exc}; fallback failed: {fallback_exc}"

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
        header_color = "red" if max_severity == "CRITICAL" or failures else "orange"
        header_title = f"项目方爆雷监控：{len(events)} 条风险信号"
        lines = [f"**扫描时间:** {now}", f"**覆盖项目方账号:** {scanned}", ""]
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
        header_color = "red" if failures else "green"
        header_title = "项目方爆雷监控：扫描不完整" if failures else "项目方爆雷监控：暂无新增风险"
        lines = [
            f"**扫描时间:** {now}",
            f"**覆盖项目方账号:** {scanned}",
            "本轮未发现项目方爆雷信号。" if not failures else "本轮存在账号抓取失败，不能视为完整安全结论。",
        ]

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
    if (
        report["event_count"] == 0
        and report.get("failure_count", 0) == 0
        and os.environ.get("BSM_SEND_EMPTY", "false").lower() != "true"
    ):
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

    accounts = load_accounts()
    bucket_index = args.bucket_index if args.bucket_index >= 0 else None
    selected = choose_accounts(accounts, args.limit, args.buckets, bucket_index, state)

    sendable: list[tuple[CandidateEvent, str]] = []
    failures: list[str] = []
    x_clients: list[XWebClient] = []

    for cookie_header in load_x_cookie_pool():
        try:
            client = XWebClient(cookie_header)
            client.bootstrap()
            x_clients.append(client)
        except Exception as exc:
            failures.append(f"X native account bootstrap failed: {exc}")

    if x_clients:
        completed = []
        for index, account in enumerate(selected):
            client = x_clients[index % len(x_clients)]
            completed.append((account, scan_account(account, not args.no_fallback, client)))
            time.sleep(args.sleep)
    else:
        with ThreadPoolExecutor(max_workers=args.max_workers) as executor:
            futures = {
                executor.submit(
                    scan_account,
                    account,
                    not args.no_fallback,
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
        if not x_clients:
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
    parser = argparse.ArgumentParser(description="Scan project official X/Twitter accounts for post-listing blow-up signals.")
    parser.add_argument("--limit", type=int, default=int(os.environ.get("BSM_SCAN_LIMIT", DEFAULT_LIMIT)))
    parser.add_argument("--buckets", type=int, default=int(os.environ.get("BSM_SCAN_BUCKETS", DEFAULT_BUCKETS)))
    parser.add_argument("--bucket-index", type=int, default=int(os.environ.get("BSM_SCAN_BUCKET_INDEX", "-1")))
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
