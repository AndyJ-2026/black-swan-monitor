import argparse
import tempfile
import unittest
from pathlib import Path

import risk_monitor


class RiskMonitorTests(unittest.TestCase):
    def test_classifies_security_incident(self):
        text = "SWEAT wallet compromised after exploit, funds stolen"
        self.assertEqual(risk_monitor.classify_event_type(text), "security_incident")
        self.assertEqual(risk_monitor.classify_severity(text), "CRITICAL")

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

    def test_priority_accounts_are_always_first(self):
        accounts = [
            risk_monitor.Account("AAA", "aaa"),
            risk_monitor.Account("SWEAT", "SweatEconomy"),
            risk_monitor.Account("DRIFT", "DriftProtocol"),
            risk_monitor.Account("BBB", "bbb"),
        ]
        state = {"meta": {"scan_offset": 0}}
        selected = risk_monitor.choose_accounts(accounts, ["SWEAT", "DRIFT"], 3, state)

        self.assertEqual([account.coin for account in selected], ["SWEAT", "DRIFT", "AAA"])

    def test_state_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sent_events.json"
            state = {"version": 1, "meta": {"scan_offset": 4}, "events": []}
            risk_monitor.save_event_state(state, path)
            loaded = risk_monitor.load_event_state(path)
            self.assertEqual(loaded["meta"]["scan_offset"], 4)


if __name__ == "__main__":
    unittest.main()
