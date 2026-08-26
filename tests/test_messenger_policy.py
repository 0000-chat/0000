import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import validate_messenger_policy


VALID_CONFIG = '''bridge:
  split_portals: true
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin
  relay:
    enabled: false
    admin_only: true
    prefer_default: true
    allow_bridge: false
    default_relays: []
'''


class MessengerPolicyTests(unittest.TestCase):
    def validate(self, content: str) -> bool:
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.yaml"
            config.write_text(content)
            return validate_messenger_policy.validate(config)

    def test_accepts_exact_approved_policy(self):
        self.assertTrue(self.validate(VALID_CONFIG))

    def test_rejects_missing_agent(self):
        self.assertFalse(
            self.validate(
                VALID_CONFIG.replace(
                    '    "@agent:communicator.0000.gold": user\n', ""
                )
            )
        )

    def test_rejects_agent_admin(self):
        self.assertFalse(
            self.validate(
                VALID_CONFIG.replace(
                    '"@agent:communicator.0000.gold": user',
                    '"@agent:communicator.0000.gold": admin',
                )
            )
        )

    def test_rejects_unexpected_explicit_identity(self):
        self.assertFalse(
            self.validate(
                VALID_CONFIG.replace(
                    "\n  relay:",
                    '\n    "@unexpected:communicator.0000.gold": user\n  relay:',
                )
            )
        )

    def test_rejects_enabled_relay(self):
        self.assertFalse(self.validate(VALID_CONFIG.replace("enabled: false", "enabled: true")))

    def test_rejects_split_portals_false(self):
        self.assertFalse(self.validate(VALID_CONFIG.replace("split_portals: true", "split_portals: false")))

    def test_rejects_missing_split_portals(self):
        self.assertFalse(self.validate(VALID_CONFIG.replace("  split_portals: true\n", "")))

    def test_rejects_duplicate_permissions_block(self):
        self.assertFalse(self.validate(VALID_CONFIG.replace("  relay:", "  permissions:\n    \"*\": relay\n  relay:")))

    def test_rejects_duplicate_relay_block(self):
        self.assertFalse(self.validate(VALID_CONFIG + "  relay:\n    enabled: false\n"))


if __name__ == "__main__":
    unittest.main()
