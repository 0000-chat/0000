import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED_IMAGE = (
    "dock.mau.dev/mautrix/telegram:v26.08@"
    "sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8"
)


class TelegramValidationTests(unittest.TestCase):
    def setUp(self):
        validator_path = ROOT / "scripts/validate-telegram.sh"
        self.assertTrue(validator_path.exists())
        self.validator = validator_path.read_text()
        self.deployer = (ROOT / "scripts/deploy-core.sh").read_text()
        self.core_validator = (ROOT / "scripts/validate-core.sh").read_text()

    def test_validator_has_identity_image_health_and_private_port_guards(self):
        self.assertIn('[[ "$runtime_dir" == /srv/communicator ]]', self.validator)
        self.assertIn('[[ "$project" == communicator ]]', self.validator)
        self.assertIn("communicator-telegram-1", self.validator)
        self.assertIn(f'[[ "$TELEGRAM_IMAGE" == {EXPECTED_IMAGE} ]]', self.validator)
        self.assertIn("{{.State.Health.Status}}", self.validator)
        self.assertIn(":(5432|8008|8448|29317|29318|29319|2019)$", self.validator)

    def test_validator_checks_modes_policy_database_and_network_reachability(self):
        for required in (
            '"$runtime_dir/telegram/config.yaml"',
            '"$runtime_dir/telegram/registration.yaml"',
            "[[ \"$(stat -c '%a' \"$file\")\" == 600 ]]",
            "python3 scripts/validate_telegram_policy.py",
            "psql -At -U synapse -d telegram_bridge",
            "information_schema.tables",
            "http://telegram:29317/_matrix/mau/ready",
            "29317",
        ):
            self.assertIn(required, self.validator)

    def test_validator_rejects_public_route_and_secret_diagnostics(self):
        self.assertIn("deploy/caddy/Caddyfile", self.validator)
        self.assertIn("telegram|29317", self.validator)
        for forbidden in (
            "docker logs",
            ".Config.Env",
            "printenv",
            'cat "$runtime_dir/telegram/config.yaml"',
            'cat "$runtime_dir/secrets/',
            "compose down",
            "compose stop",
        ):
            self.assertNotIn(forbidden, self.validator)
        self.assertIn("telegram_validation=PASS", self.validator)

    def test_deployment_order_contains_all_bridge_setup_and_validation_steps(self):
        steps = (
            "docker compose --env-file deploy/images.lock.env pull",
            "./scripts/init-whatsapp-db.sh",
            "./scripts/init-messenger-db.sh",
            "./scripts/init-telegram-db.sh",
            "./scripts/init-whatsapp-runtime.sh",
            "./scripts/init-messenger-runtime.sh",
            "./scripts/init-telegram-runtime.sh",
            "--telegram-registration",
            "force-recreate --wait --wait-timeout 180 synapse",
            "force-recreate --wait --wait-timeout 180 caddy",
            "force-recreate --wait --wait-timeout 180 whatsapp",
            "force-recreate --wait --wait-timeout 180 messenger",
            "force-recreate --wait --wait-timeout 180 telegram",
            "./scripts/validate-core.sh",
            "./scripts/validate-whatsapp.sh",
            "./scripts/validate-messenger.sh",
            "./scripts/validate-telegram.sh",
        )
        for step in steps:
            self.assertIn(step, self.deployer)
        positions = [self.deployer.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions))

    def test_core_validator_requires_telegram_and_rejects_its_port(self):
        self.assertIn("29317", self.core_validator)
        self.assertIn("caddy\\nmessenger\\npostgres\\nsynapse\\ntelegram\\nwhatsapp\\n", self.core_validator)


if __name__ == "__main__":
    unittest.main()
