import pathlib
import tempfile
import unittest

from scripts import validate_whatsapp_policy


VALID_CONFIG = '''bridge:
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin

relay:
  enabled: false
  admin_only: true
  default_relays: []
'''

IMAGE_GENERATED_CONFIG = '''bridge:
    split_portals: false
    relay:
        enabled: false
        admin_only: true
        allow_bridge: true
        default_relays: []
    permissions:
        "*": relay
        "@human:communicator.0000.gold": user
        "@agent:communicator.0000.gold": user
        "@platform-admin:communicator.0000.gold": admin

database:
  type: postgres
'''


class WhatsAppPolicyTests(unittest.TestCase):
    def validate(self, content: str) -> bool:
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.yaml"
            config.write_text(content)
            return validate_whatsapp_policy.validate(config)

    def test_accepts_exact_approved_policy(self):
        self.assertTrue(self.validate(VALID_CONFIG))

    def test_accepts_image_generated_nested_policy(self):
        self.assertTrue(self.validate(IMAGE_GENERATED_CONFIG))

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
                    "\n\nrelay:",
                    '\n    "@unexpected:communicator.0000.gold": user\n\nrelay:',
                )
            )
        )

    def test_rejects_enabled_relay(self):
        self.assertFalse(self.validate(VALID_CONFIG.replace("enabled: false", "enabled: true")))


if __name__ == "__main__":
    unittest.main()
