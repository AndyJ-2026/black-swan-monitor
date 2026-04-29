#!/usr/bin/env python3
"""Black Swan Event Monitor - monitors competitor exchanges and on-chain anomalies."""

import json
import os
import subprocess
import sys
import time
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE_DIR = Path(__file__).parent
STATE_FILE = BASE_DIR / "state.json"
LARK_CLI = "/Users/jaker/lark-cli/lark"
LARK_CONFIG_DIR = os.environ.get("LARK_CONFIG_DIR", "/Users/jaker/lark-cli/.lark")

# Configure recipient - set via env var or hardcode your open_id/chat_id
LARK_RECIPIENT = os.environ.get("LARK_RECIPIENT", "ou_1e190806bb35d4346fed07a91724a36e")

REQUEST_TIMEOUT = 15

# ---------------------------------------------------------------------------
# Keywords & Severity
# ---------------------------------------------------------------------------

CRITICAL_KEYWORDS = [
    "suspend", "suspension", "halt", "halted", "pause", "paused",
    "disable", "disabled", "exploit", "hack", "hacked", "vulnerability",
    "emergency", "abnormal", "unusual", "incident",
    "暂停", "异常", "紧急", "攻击", "漏洞",
]

WARNING_KEYWORDS = [
    "maintenance", "network upgrade", "wallet maintenance",
    "scheduled maintenance", "维护", "升级", "网络升级",
]

INFO_KEYWORDS = [
    "delist", "delisting", "swap", "rebrand", "migration",
    "token swap", "下架", "迁移",
]

RELEVANT_KEYWORDS = CRITICAL_KEYWORDS + WARNING_KEYWORDS + INFO_KEYWORDS


def classify_severity(title: str) -> str:
    t = title.lower()
    for kw in CRITICAL_KEYWORDS:
        if kw in t:
            return "CRITICAL"
    for kw in WARNING_KEYWORDS:
        if kw in t:
            return "WARNING"
    for kw in INFO_KEYWORDS:
        if kw in t:
            return "INFO"
    return "INFO"


def is_relevant(title: str) -> bool:
    t = title.lower()
    return any(kw in t for kw in RELEVANT_KEYWORDS)


# ---------------------------------------------------------------------------
# State Management
# ---------------------------------------------------------------------------

def load_state() -> dict:
    default = {
        "last_run": None,
        "seen_binance": [],
        "seen_okx": [],
        "seen_bybit": [],
        "seen_onchain": [],
        "first_run": True,
    }
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                state = json.load(f)
            for k, v in default.items():
                state.setdefault(k, v)
            return state
        except json.JSONDecodeError:
            return default
    return default


def save_state(state: dict):
    for key in ["seen_binance", "seen_okx", "seen_bybit", "seen_onchain"]:
        if key in state:
            state[key] = state[key][-200:]
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    state["first_run"] = False
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Exchange Announcement Fetchers
# ---------------------------------------------------------------------------

def fetch_binance() -> list:
    """Fetch Binance maintenance/system announcements."""
    items = []
    # catalogId 48 = Latest News, 49 = Latest Activities, 157 = Maintenance Updates
    for catalog_id in [157, 48]:
        try:
            resp = requests.post(
                "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query",
                json={
                    "type": 1,
                    "pageNo": 1,
                    "pageSize": 20,
                    "catalogId": catalog_id,
                },
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=REQUEST_TIMEOUT,
            )
            data = resp.json()
            articles = data.get("data", {}).get("articles", [])
            for a in articles:
                title = a.get("title", "")
                if not is_relevant(title):
                    continue
                items.append({
                    "id": str(a.get("id", "")),
                    "exchange": "Binance",
                    "title": title,
                    "url": f"https://www.binance.com/en/support/announcement/{a.get('code', '')}",
                    "time": datetime.fromtimestamp(
                        a.get("releaseDate", 0) / 1000, tz=timezone.utc
                    ).strftime("%Y-%m-%d %H:%M UTC"),
                    "severity": classify_severity(title),
                })
        except Exception as e:
            print(f"[Binance] Error fetching catalogId={catalog_id}: {e}")
    return items


def fetch_okx() -> list:
    """Fetch OKX announcements."""
    items = []
    try:
        resp = requests.get(
            "https://www.okx.com/api/v5/support/announcements",
            params={"page": "1", "limit": "20"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=REQUEST_TIMEOUT,
        )
        data = resp.json()
        for a in data.get("data", []):
            title = a.get("title", "")
            if not is_relevant(title):
                continue
            items.append({
                "id": str(a.get("announcementId", a.get("id", ""))),
                "exchange": "OKX",
                "title": title,
                "url": a.get("url", ""),
                "time": a.get("pTime", ""),
                "severity": classify_severity(title),
            })
    except Exception as e:
        print(f"[OKX] Error: {e}")
    return items


def fetch_bybit() -> list:
    """Fetch Bybit announcements."""
    items = []
    try:
        resp = requests.get(
            "https://api.bybit.com/v5/announcements/index",
            params={"locale": "en-US", "limit": "20"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=REQUEST_TIMEOUT,
        )
        data = resp.json()
        rows = data.get("result", {}).get("list", data.get("result", {}).get("rows", []))
        for a in rows:
            title = a.get("title", "")
            if not is_relevant(title):
                continue
            ts = a.get("dateTimestamp", a.get("publish_timestamp", 0))
            if isinstance(ts, str):
                ts = int(ts) if ts.isdigit() else 0
            item_id = str(a.get("id", "")) or hashlib.md5(title.encode()).hexdigest()[:12]
            items.append({
                "id": item_id,
                "exchange": "Bybit",
                "title": title,
                "url": a.get("url", f"https://announcements.bybit.com/en/"),
                "time": datetime.fromtimestamp(
                    ts / 1000 if ts > 1e12 else ts, tz=timezone.utc
                ).strftime("%Y-%m-%d %H:%M UTC") if ts else "N/A",
                "severity": classify_severity(title),
            })
    except Exception as e:
        print(f"[Bybit] Error: {e}")
    return items


# ---------------------------------------------------------------------------
# On-Chain Anomaly Detection
# ---------------------------------------------------------------------------

CHAINS = {
    "Ethereum": {
        "rpc": "https://eth.llamarpc.com",
        "expected_block_time": 12,
        "threshold_multiplier": 5,
    },
    "BSC": {
        "rpc": "https://bsc-dataseed1.binance.org",
        "expected_block_time": 3,
        "threshold_multiplier": 5,
    },
    "Arbitrum": {
        "rpc": "https://arb1.arbitrum.io/rpc",
        "expected_block_time": 1,
        "threshold_multiplier": 10,
    },
}

# USDT and USDC contract addresses on Ethereum
STABLECOIN_CONTRACTS = {
    "USDT (Ethereum)": {
        "rpc": "https://eth.llamarpc.com",
        "address": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "paused_selector": "0x5c975abb",  # paused()
    },
    "USDC (Ethereum)": {
        "rpc": "https://eth.llamarpc.com",
        "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "paused_selector": "0x5c975abb",
    },
}


def check_block_delays() -> list:
    """Check if major chains have abnormal block production delays."""
    alerts = []
    for chain_name, cfg in CHAINS.items():
        try:
            # Get latest block number
            resp = requests.post(
                cfg["rpc"],
                json={"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
                timeout=REQUEST_TIMEOUT,
            )
            block_hex = resp.json().get("result", "0x0")
            block_num = int(block_hex, 16)

            # Get latest block timestamp
            resp2 = requests.post(
                cfg["rpc"],
                json={
                    "jsonrpc": "2.0",
                    "method": "eth_getBlockByNumber",
                    "params": [hex(block_num), False],
                    "id": 2,
                },
                timeout=REQUEST_TIMEOUT,
            )
            block = resp2.json().get("result", {})
            block_ts = int(block.get("timestamp", "0x0"), 16)
            now_ts = int(time.time())
            delay = now_ts - block_ts

            threshold = cfg["expected_block_time"] * cfg["threshold_multiplier"]
            if delay > threshold:
                alert_id = f"block_delay_{chain_name}_{block_num}"
                alerts.append({
                    "id": alert_id,
                    "exchange": "On-Chain",
                    "title": f"{chain_name} block production delay: {delay}s since last block (expected ~{cfg['expected_block_time']}s)",
                    "url": "",
                    "time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                    "severity": "CRITICAL" if delay > threshold * 3 else "WARNING",
                    "type": "block_delay",
                    "chain": chain_name,
                    "delay_seconds": delay,
                })
        except Exception as e:
            print(f"[On-Chain] Error checking {chain_name}: {e}")
    return alerts


def check_stablecoin_paused() -> list:
    """Check if major stablecoins have their contracts paused."""
    alerts = []
    for name, cfg in STABLECOIN_CONTRACTS.items():
        try:
            resp = requests.post(
                cfg["rpc"],
                json={
                    "jsonrpc": "2.0",
                    "method": "eth_call",
                    "params": [
                        {"to": cfg["address"], "data": cfg["paused_selector"]},
                        "latest",
                    ],
                    "id": 1,
                },
                timeout=REQUEST_TIMEOUT,
            )
            result = resp.json().get("result", "0x")
            is_paused = result != "0x" and int(result, 16) == 1
            if is_paused:
                alert_id = f"paused_{name}_{int(time.time()) // 3600}"
                alerts.append({
                    "id": alert_id,
                    "exchange": "On-Chain",
                    "title": f"{name} contract is PAUSED",
                    "url": "",
                    "time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                    "severity": "CRITICAL",
                    "type": "contract_paused",
                    "chain": "Ethereum",
                })
        except Exception as e:
            print(f"[On-Chain] Error checking {name}: {e}")
    return alerts


def check_onchain() -> list:
    """Run all on-chain checks."""
    alerts = []
    alerts.extend(check_block_delays())
    time.sleep(1)  # avoid RPC rate limits
    alerts.extend(check_stablecoin_paused())
    return alerts


# ---------------------------------------------------------------------------
# Notification
# ---------------------------------------------------------------------------

def format_exchange_alert(item: dict) -> str:
    severity = item.get("severity", "INFO")
    exchange = item.get("exchange", "Unknown")
    title = item.get("title", "")
    t = item.get("time", "")
    url = item.get("url", "")

    link_line = f"**Link:** [View Announcement]({url})" if url else ""

    template = ""
    if severity == "CRITICAL":
        template = f"""
---

**Suggested Announcement Template (edit and publish):**

Dear Users,

Due to {exchange} announcing [{title}], we will take the following precautionary measures:

1. Deposits and withdrawals on the affected network will be temporarily suspended
2. Spot trading will not be affected
3. Services will resume once the situation is confirmed stable

We apologize for any inconvenience.
[Exchange Name] Team"""

    return f"""**[{severity}] Competitor Deposit/Withdrawal Alert**

**Exchange:** {exchange}
**Title:** {title}
**Time:** {t}
{link_line}
{template}"""


def format_onchain_alert(item: dict) -> str:
    severity = item.get("severity", "WARNING")
    chain = item.get("chain", "Unknown")
    title = item.get("title", "")
    t = item.get("time", "")
    alert_type = item.get("type", "unknown")

    if alert_type == "block_delay":
        delay = item.get("delay_seconds", 0)
        suggestion = f"Monitor {chain} network status. Consider preemptively suspending deposits/withdrawals."
    elif alert_type == "contract_paused":
        suggestion = f"IMMEDIATELY suspend related token deposits/withdrawals on {chain}."
    else:
        suggestion = "Investigate and assess impact on operations."

    return f"""**[{severity}] On-Chain Anomaly Detected**

**Chain:** {chain}
**Type:** {alert_type.replace('_', ' ').title()}
**Details:** {title}
**Time:** {t}
**Action:** {suggestion}"""


def send_lark(message: str):
    """Send message via lark-cli."""
    if not LARK_RECIPIENT:
        print(f"[Lark] No recipient configured. Message:\n{message}")
        return

    env = os.environ.copy()
    env["LARK_CONFIG_DIR"] = LARK_CONFIG_DIR

    try:
        result = subprocess.run(
            [LARK_CLI, "msg", "send", "--to", LARK_RECIPIENT, "--text", message],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            print(f"[Lark] Send failed: {result.stderr}")
        else:
            print(f"[Lark] Message sent successfully")
    except Exception as e:
        print(f"[Lark] Error sending: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"=== Black Swan Monitor - {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} ===")

    state = load_state()
    is_first_run = state.get("first_run", True)
    all_alerts = []

    # Fetch exchange announcements
    fetchers = [
        (fetch_binance, "seen_binance"),
        (fetch_okx, "seen_okx"),
        (fetch_bybit, "seen_bybit"),
    ]

    for fetch_fn, seen_key in fetchers:
        try:
            items = fetch_fn()
            print(f"[{seen_key}] Fetched {len(items)} relevant items")

            new_items = []
            for item in items:
                if item["id"] not in state[seen_key]:
                    state[seen_key].append(item["id"])
                    if not is_first_run:
                        new_items.append(item)

            if new_items:
                print(f"[{seen_key}] {len(new_items)} NEW alerts!")
                all_alerts.extend(new_items)
        except Exception as e:
            print(f"[{seen_key}] Error: {e}")

    # On-chain checks
    try:
        onchain_items = check_onchain()
        print(f"[on-chain] {len(onchain_items)} anomalies detected")

        for item in onchain_items:
            if item["id"] not in state["seen_onchain"]:
                state["seen_onchain"].append(item["id"])
                if not is_first_run:
                    all_alerts.append(item)
    except Exception as e:
        print(f"[on-chain] Error: {e}")

    # Send alerts
    if all_alerts:
        print(f"\n>>> Sending {len(all_alerts)} alert(s) via Lark <<<")
        for item in all_alerts:
            if item.get("exchange") == "On-Chain":
                msg = format_onchain_alert(item)
            else:
                msg = format_exchange_alert(item)
            send_lark(msg)
            print(f"  - [{item['severity']}] {item['title']}")
    elif is_first_run:
        print("\nFirst run - recorded baseline state, no alerts sent.")
    else:
        print("\nNo new alerts.")

    save_state(state)
    print(f"\nState saved. Total tracked: "
          f"Binance={len(state['seen_binance'])}, "
          f"OKX={len(state['seen_okx'])}, "
          f"Bybit={len(state['seen_bybit'])}, "
          f"OnChain={len(state['seen_onchain'])}")


if __name__ == "__main__":
    main()
