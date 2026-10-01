import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def document(path):
    return " ".join(line.lstrip("> ") for line in (ROOT / "docs" / path).read_text().splitlines()).strip()


def normalized_document(path):
    return " ".join(document(path).split())


class MessengerScopeContractTests(unittest.TestCase):
    def test_each_account_requires_independent_acceptance(self):
        validation = normalized_document("runbooks/mautrix-messenger-validation.md")
        for requirement in (
            "It records no live account completion",
            "NOT_TESTED",
            "Check portal isolation in both directions",
            "Do not claim symmetric two-account isolation",
            "separate pairing, E2EE, isolation, restart, and backup acceptance",
        ):
            self.assertIn(requirement, validation)

    def test_operations_preserve_account_owner_authentication_and_private_boundary(self):
        operations = normalized_document("runbooks/mautrix-messenger-operations.md")
        for requirement in (
            "Port 29319 must not be published",
            "split_portals: true",
            "disabled provisioning",
            "disabled backfill",
            "The owner completes authentication directly",
            "must not log out or unlink accounts",
        ):
            self.assertIn(requirement, operations)

    def test_restore_never_connects_copied_sessions_to_external_services(self):
        validation = normalized_document("runbooks/mautrix-messenger-validation.md")
        recovery = normalized_document("runbooks/matrix-core-recovery.md")
        self.assertIn("distinct Compose project", validation)
        self.assertIn("Never start the restored Messenger service", validation)
        self.assertIn("--network none", validation)
        self.assertIn("restored Messenger and Telegram services are never started", recovery)
        self.assertIn("does not create or authenticate an additional account", recovery)

    def test_historical_plan_is_not_a_deployment_acceptance_record(self):
        plan = normalized_document("superpowers/plans/2026-08-26-messenger-bridge-implementation-plan.md")
        self.assertIn("Archived design history", plan)
        self.assertIn("not a current execution plan or live deployment acceptance record", plan)
        self.assertIn("An unpaired identity remains `NOT_TESTED`", plan)
        for text in (plan, normalized_document("runbooks/mautrix-messenger-validation.md")):
            self.assertNotIn("DEFERRED_BY_USER", text)
            self.assertNotIn("human_messenger_pairing=PASS", text)


if __name__ == "__main__":
    unittest.main()
