import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class MessengerValidationTests(unittest.TestCase):
    def setUp(self):
        self.validator = (ROOT / "scripts/validate-messenger.sh").read_text()
        self.deployer = (ROOT / "scripts/deploy-core.sh").read_text()
        self.core_validator = (ROOT / "scripts/validate-core.sh").read_text()

    def test_deployment_orders_all_messenger_setup_before_restarts(self):
        ordered = [
            "docker compose --env-file deploy/images.lock.env pull",
            "./scripts/init-whatsapp-db.sh",
            "./scripts/init-messenger-db.sh",
            "./scripts/init-whatsapp-runtime.sh",
            "./scripts/init-messenger-runtime.sh",
            "--messenger-registration \"$runtime_dir/synapse/messenger-registration.yaml\"",
            "up -d --no-deps --force-recreate --wait --wait-timeout 180 synapse",
            "up -d --no-deps --force-recreate --wait --wait-timeout 180 caddy",
            "up -d --no-deps --force-recreate --wait --wait-timeout 180 whatsapp",
            "up -d --no-deps --force-recreate --wait --wait-timeout 180 messenger",
        ]
        positions = [self.deployer.index(item) for item in ordered]
        self.assertEqual(positions, sorted(positions))

    def test_validator_has_identity_health_policy_and_port_guards(self):
        self.assertIn('[[ "$runtime_dir" == /srv/communicator ]]', self.validator)
        self.assertIn('[[ "$project" == communicator ]]', self.validator)
        self.assertIn('container_id=$("${compose[@]}" ps -q messenger)', self.validator)
        self.assertIn("{{.State.Status}}", self.validator)
        self.assertIn("{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}", self.validator)
        self.assertIn("127.0.0.1:29319/_matrix/mau/live", self.validator)
        self.assertIn("127.0.0.1:29319/_matrix/mau/ready", self.validator)
        self.assertIn('config="$runtime_dir/messenger/config.yaml"', self.validator)
        self.assertIn('[[ "$(stat -c \'%a\' "$config")" == 600 ]]', self.validator)
        self.assertIn('registration="$runtime_dir/synapse/messenger-registration.yaml"', self.validator)
        self.assertIn('bridge_registration="$runtime_dir/messenger/registration.yaml"', self.validator)
        self.assertIn('python3 scripts/validate_messenger_policy.py "$config"', self.validator)
        self.assertIn('.provisioning.shared_secret == "disable"', self.validator)
        self.assertIn('.provisioning.allow_matrix_auth == false', self.validator)
        self.assertIn('.public_media.enabled == false', self.validator)
        self.assertIn('.direct_media.enabled == false', self.validator)
        self.assertIn(":(5432|8008|8448|29319|2019)$", self.validator)

    def test_validator_emits_only_approved_markers_and_safe_diagnostics(self):
        for marker in (
            "messenger_container=running",
            "messenger_health=healthy",
            "messenger_live=PASS",
            "messenger_ready=PASS",
            "messenger_ports=NONE",
            "messenger_registration=PASS",
            "messenger_policy=PASS",
            "messenger_backfill=DISABLED",
            "messenger_provisioning=DISABLED",
        ):
            self.assertIn(marker, self.validator)
        for forbidden in ("docker logs", ".Config.Env", "compose down", "compose stop", "rm -rf"):
            self.assertNotIn(forbidden, self.validator)

    def test_core_validator_requires_sorted_messenger_service_set_and_private_port(self):
        self.assertIn("caddy\\nmessenger\\npostgres\\nsynapse\\nwhatsapp\\n", self.core_validator)
        self.assertIn(":(5432|8008|8448|29318|29319|2019)$", self.core_validator)


if __name__ == "__main__":
    unittest.main()
