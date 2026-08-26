import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class WhatsAppValidationTests(unittest.TestCase):
    def setUp(self):
        self.validator = (ROOT / "scripts/validate-whatsapp.sh").read_text()
        self.deployer = (ROOT / "scripts/deploy-core.sh").read_text()
        self.core_validator = (ROOT / "scripts/validate-core.sh").read_text()

    def test_validator_has_identity_and_internal_health_guards(self):
        self.assertIn('[[ "$runtime_dir" == /srv/communicator ]]', self.validator)
        self.assertIn('[[ "$project" == communicator ]]', self.validator)
        self.assertIn("127.0.0.1:29318/_matrix/mau/live", self.validator)
        self.assertIn("127.0.0.1:29318/_matrix/mau/ready", self.validator)

    def test_live_validator_checks_exact_permission_policy(self):
        self.assertIn('config="$runtime_dir/whatsapp/config.yaml"', self.validator)
        self.assertIn('[[ "$(stat -c \'%a\' "$config")" == 600 ]]', self.validator)
        self.assertIn('python3 scripts/validate_whatsapp_policy.py "$config"', self.validator)
        self.assertNotIn('echo "whatsapp_permissions=PASS"', self.validator)

    def test_validator_has_no_secret_or_destructive_diagnostics(self):
        for forbidden in ("docker logs", ".Config.Env", "compose down", "compose stop", "rm -rf"):
            self.assertNotIn(forbidden, self.validator)
        for marker in (
            "whatsapp_container=running",
            "whatsapp_health=healthy",
            "whatsapp_ready=PASS",
            "whatsapp_ports=NONE",
            "whatsapp_history_sync=DISABLED",
            "whatsapp_provisioning=DISABLED",
        ):
            self.assertIn(marker, self.validator)

    def test_deployment_orders_bridge_setup_before_synapse_restart(self):
        self.assertLess(self.deployer.index("docker compose --env-file deploy/images.lock.env pull"), self.deployer.index("./scripts/init-whatsapp-db.sh"))
        self.assertLess(self.deployer.index("./scripts/init-whatsapp-db.sh"), self.deployer.index("./scripts/init-whatsapp-runtime.sh"))
        self.assertLess(self.deployer.index("./scripts/init-whatsapp-runtime.sh"), self.deployer.index("--whatsapp-registration"))
        synapse_restart = "up -d --no-deps --force-recreate --wait --wait-timeout 180 synapse"
        caddy_restart = "up -d --no-deps --force-recreate --wait --wait-timeout 180 caddy"
        whatsapp_restart = "up -d --no-deps --force-recreate --wait --wait-timeout 180 whatsapp"
        self.assertIn(synapse_restart, self.deployer)
        self.assertIn(caddy_restart, self.deployer)
        self.assertIn(whatsapp_restart, self.deployer)
        self.assertLess(self.deployer.index(synapse_restart), self.deployer.index(whatsapp_restart))

    def test_core_validator_requires_the_bridge_service(self):
        self.assertIn('runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}', self.core_validator)
        self.assertIn('project=${COMPOSE_PROJECT_NAME:-communicator}', self.core_validator)
        self.assertIn("caddy\\nmessenger\\npostgres\\nsynapse\\nwhatsapp\\n", self.core_validator)


if __name__ == "__main__":
    unittest.main()
