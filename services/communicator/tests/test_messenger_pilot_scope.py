import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PLAN = (ROOT / "docs/superpowers/plans/2026-08-26-messenger-bridge-implementation-plan.md").read_text()
VALIDATION = (ROOT / "docs/runbooks/mautrix-messenger-validation.md").read_text()
OPERATIONS = (ROOT / "docs/runbooks/mautrix-messenger-operations.md").read_text()
CORE_OPERATIONS = (ROOT / "docs/runbooks/matrix-core-operations.md").read_text()
CORE_RECOVERY = (ROOT / "docs/runbooks/matrix-core-recovery.md").read_text()


DEFERRED_MARKERS = (
    "agent_messenger_pairing=DEFERRED_BY_USER",
    "agent_messenger_inbound_text=NOT_TESTED",
    "agent_messenger_outbound_text=NOT_TESTED",
    "agent_messenger_e2ee=NOT_TESTED",
    "human_cannot_access_agent_messenger=NOT_TESTED",
)

FORBIDDEN_AGENT_PASS_MARKERS = (
    "agent_messenger_pairing=PASS",
    "agent_messenger_inbound_text=PASS",
    "agent_messenger_outbound_text=PASS",
    "agent_messenger_e2ee=PASS",
    "human_cannot_access_agent_messenger=PASS",
    "both_messenger_sessions_restart_persistence=PASS",
)


def normalized(text: str) -> str:
    return " ".join(text.split())


class MessengerPilotScopeContractTests(unittest.TestCase):
    def test_plan_records_human_only_variance_and_human_recovery(self):
        plan = normalized(PLAN)
        self.assertIn("one connected Human Messenger account", plan)
        self.assertIn("Agent Messenger onboarding is deferred by user", plan)
        self.assertIn("human_messenger_session_preserved=PASS", PLAN)
        self.assertIn("post_messenger_pairing_backup=PASS", PLAN)
        self.assertIn("post_messenger_pairing_restore_test=PASS", PLAN)
        for marker in DEFERRED_MARKERS:
            self.assertIn(marker, PLAN)

    def test_validation_runbook_records_only_human_completion(self):
        validation = normalized(VALIDATION)
        self.assertIn("one connected Human Messenger account", validation)
        self.assertIn("Future Agent onboarding requires its own pairing, isolation, restart, and backup acceptance", validation)
        for marker in DEFERRED_MARKERS:
            self.assertIn(marker, VALIDATION)
        for marker in FORBIDDEN_AGENT_PASS_MARKERS:
            self.assertNotIn(marker, VALIDATION)

    def test_operations_runbook_preserves_future_agent_configuration_without_claiming_login(self):
        operations = normalized(OPERATIONS)
        self.assertIn("one connected Human Messenger account", operations)
        self.assertIn("Agent Messenger onboarding is deferred by user", operations)
        self.assertIn("Do not create an Agent session", operations)
        for marker in DEFERRED_MARKERS:
            self.assertIn(marker, OPERATIONS)
        for marker in FORBIDDEN_AGENT_PASS_MARKERS:
            self.assertNotIn(marker, OPERATIONS)

    def test_core_runbooks_do_not_claim_two_messenger_sessions(self):
        core_operations = normalized(CORE_OPERATIONS)
        core_recovery = normalized(CORE_RECOVERY)
        self.assertIn("Agent onboarding is deferred by user", core_operations)
        self.assertIn("no Agent session is created", core_recovery)
        self.assertNotIn("both account sessions", core_operations)
        self.assertNotIn("either restored account", core_recovery)


if __name__ == "__main__":
    unittest.main()
