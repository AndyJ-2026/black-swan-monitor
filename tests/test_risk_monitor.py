import tempfile
import unittest
from pathlib import Path

import risk_monitor


class RiskMonitorTests(unittest.TestCase):
    def test_classifies_security_incident(self):
        text = "SWEAT wallet compromised after exploit, funds stolen"
        self.assertEqual(risk_monitor.classify_event_type(text), "security_incident")
        self.assertEqual(risk_monitor.classify_severity(text), "CRITICAL")

    def test_classifies_project_blowup_events(self):
        self.assertEqual(risk_monitor.classify_event_type("bridge halted after exploit"), "bridge_incident")
        self.assertEqual(risk_monitor.classify_event_type("team rugged and exit scam confirmed"), "rug_or_exit")
        self.assertEqual(risk_monitor.classify_event_type("private key leak caused mint exploit"), "contract_or_key_incident")

    def test_deposit_withdrawal_noise_is_not_a_signal(self):
        text = "Exchange withdrawals and deposits are temporarily suspended"
        self.assertEqual(risk_monitor.classify_event_type(text), "risk_signal")
        self.assertEqual(risk_monitor.classify_severity(text), "INFO")

    def test_parse_cookie_header(self):
        cookies = risk_monitor.parse_cookie_header("auth_token=abc; ct0=def; twid=u%3D123")
        self.assertEqual(cookies["auth_token"], "abc")
        self.assertEqual(cookies["ct0"], "def")

    def test_project_relevance_filters_other_project_news(self):
        account = risk_monitor.Account("TLF", "tradeleaf")
        other_project_news = "#Aave sees $5B outflows after a $290M exploit"
        own_project_alert = "Our bridge is halted while the team investigates a contract issue"

        self.assertFalse(risk_monitor.is_project_relevant(account, other_project_news))
        self.assertTrue(risk_monitor.is_project_relevant(account, own_project_alert))

    def test_dedupes_identical_coin_and_event(self):
        now = risk_monitor.utc_now().isoformat()
        candidate = risk_monitor.CandidateEvent(
            coin="SWEAT",
            event_type="security_incident",
            severity="CRITICAL",
            summary="SWEAT exploit confirmed",
            source="test",
            url="https://example.com",
            detected_at=now,
        )
        state = {"events": []}

        should_send, reason, existing = risk_monitor.should_send_event(state, candidate, 12)
        self.assertTrue(should_send)
        self.assertEqual(reason, "new_event")

        risk_monitor.record_event(state, candidate, reason, existing)
        should_send, reason, _ = risk_monitor.should_send_event(state, candidate, 12)
        self.assertFalse(should_send)
        self.assertEqual(reason, "duplicate")

    def test_bucket_selection_rotates_without_skipping_bucket_state(self):
        accounts = [
            risk_monitor.Account("AAA", "aaa"),
            risk_monitor.Account("SWEAT", "SweatEconomy"),
            risk_monitor.Account("DRIFT", "DriftProtocol"),
            risk_monitor.Account("BBB", "bbb"),
            risk_monitor.Account("CCC", "ccc"),
            risk_monitor.Account("DDD", "ddd"),
        ]
        state = {"meta": {"scan_bucket": 0}}

        first = risk_monitor.choose_accounts(accounts, 0, 3, None, state)
        second = risk_monitor.choose_accounts(accounts, 0, 3, None, state)
        third = risk_monitor.choose_accounts(accounts, 0, 3, None, state)

        self.assertEqual([account.coin for account in first], ["AAA", "BBB"])
        self.assertEqual([account.coin for account in second], ["SWEAT", "CCC"])
        self.assertEqual([account.coin for account in third], ["DRIFT", "DDD"])
        self.assertEqual(state["meta"]["scan_bucket"], 0)

    def test_state_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sent_events.json"
            state = {"version": 1, "meta": {"scan_bucket": 2}, "events": []}
            risk_monitor.save_event_state(state, path)
            loaded = risk_monitor.load_event_state(path)
            self.assertEqual(loaded["meta"]["scan_bucket"], 2)


if __name__ == "__main__":
    unittest.main()
