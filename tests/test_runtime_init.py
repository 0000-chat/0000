import os
import pathlib
import stat
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RuntimeInitTests(unittest.TestCase):
    def test_messenger_runtime_guard_matches_locked_image_digest(self):
        script = (ROOT / "scripts/init-messenger-runtime.sh").read_text()
        lock = dict(
            line.split("=", 1)
            for line in (ROOT / "deploy/images.lock.env").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertIn(f'[[ "$MESSENGER_IMAGE" == {lock["MESSENGER_IMAGE"]} ]]', script)

    def test_messenger_bootstrap_renders_before_and_after_registration(self):
        script = (ROOT / "scripts/init-messenger-runtime.sh").read_text()
        upstream = 'docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps messenger'
        renderer = "python3 scripts/render-messenger-config.py"
        config_generation = 'if [[ ! -f "$config" ]]; then'
        registration_generation = 'if [[ ! -f "$registration" ]]; then'
        self.assertIn('[[ "$project" == communicator ]]', script)
        self.assertIn(config_generation, script)
        self.assertIn(registration_generation, script)
        self.assertEqual(2, script.count(upstream))
        self.assertEqual(2, script.count(renderer))
        self.assertLess(script.index(config_generation), script.index(registration_generation))
        self.assertLess(script.index(registration_generation), script.index(renderer))
        self.assertIn("--registration", script)

    def test_whatsapp_runtime_guard_matches_locked_image_digest(self):
        script = (ROOT / "scripts/init-whatsapp-runtime.sh").read_text()
        lock = dict(
            line.split("=", 1)
            for line in (ROOT / "deploy/images.lock.env").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertIn(f'[[ "$WHATSAPP_IMAGE" == {lock["WHATSAPP_IMAGE"]} ]]', script)

    def test_official_generation_precedes_project_config_render(self):
        script = (ROOT / "scripts/init-whatsapp-runtime.sh").read_text()
        config_generation = 'if [[ ! -f "$config" ]]; then'
        registration_generation = 'if [[ ! -f "$registration" ]]; then'
        renderer = script.index("python3 scripts/render-whatsapp-config.py")
        self.assertIn(config_generation, script)
        self.assertIn(registration_generation, script)
        self.assertLess(script.index(config_generation), script.index(registration_generation))
        self.assertLess(script.index(registration_generation), renderer)
        self.assertEqual(2, script.count("docker compose --env-file deploy/images.lock.env --project-name \"$project\" run --rm --no-deps whatsapp"))

    def test_creates_private_secret_files_without_printing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ | {"COMMUNICATOR_RUNTIME_DIR": directory}
            result = subprocess.run(
                [ROOT / "scripts/init-runtime.sh"],
                env=env,
                check=True,
                text=True,
                capture_output=True,
            )
            secret = pathlib.Path(directory) / "secrets/postgres.env"
            self.assertTrue(secret.exists())
            self.assertEqual(0o600, stat.S_IMODE(secret.stat().st_mode))
            self.assertIn("POSTGRES_PASSWORD=", secret.read_text())
            self.assertNotIn(secret.read_text().split("=", 1)[1].strip(), result.stdout)
            self.assertTrue((pathlib.Path(directory) / "whatsapp").is_dir())
            self.assertTrue((pathlib.Path(directory) / "whatsapp-backups").is_dir())
            self.assertTrue((pathlib.Path(directory) / "messenger").is_dir())
            messenger_password = pathlib.Path(directory) / "secrets/messenger-db.password"
            messenger_env = pathlib.Path(directory) / "secrets/messenger-db.env"
            self.assertEqual(0o600, stat.S_IMODE(messenger_password.stat().st_mode))
            self.assertEqual(0o600, stat.S_IMODE(messenger_env.stat().st_mode))
            self.assertIn("MESSENGER_DB_PASSWORD=", messenger_env.read_text())
            self.assertNotIn(messenger_password.read_text().strip(), result.stdout)
            bridge_password = pathlib.Path(directory) / "secrets/whatsapp-db.password"
            bridge_env = pathlib.Path(directory) / "secrets/whatsapp-db.env"
            self.assertEqual(0o600, stat.S_IMODE(bridge_password.stat().st_mode))
            self.assertEqual(0o600, stat.S_IMODE(bridge_env.stat().st_mode))
            self.assertIn("WHATSAPP_DB_PASSWORD=", bridge_env.read_text())
            self.assertNotIn(bridge_password.read_text().strip(), result.stdout)
            for directory_name in ("telegram", "telegram-backups"):
                directory_path = pathlib.Path(directory) / directory_name
                self.assertTrue(directory_path.is_dir())
                self.assertEqual(0o700, stat.S_IMODE(directory_path.stat().st_mode))
            telegram_password = pathlib.Path(directory) / "secrets/telegram-db.password"
            telegram_env = pathlib.Path(directory) / "secrets/telegram-db.env"
            self.assertEqual(0o600, stat.S_IMODE(telegram_password.stat().st_mode))
            self.assertEqual(0o600, stat.S_IMODE(telegram_env.stat().st_mode))
            self.assertIn("TELEGRAM_DB_PASSWORD=", telegram_env.read_text())
            self.assertNotIn(telegram_password.read_text().strip(), result.stdout)

            self.assertFalse((pathlib.Path(directory) / "secrets/telegram-api-id").exists())
            self.assertFalse((pathlib.Path(directory) / "secrets/telegram-api-hash").exists())

    def test_runtime_initializer_does_not_manage_telegram_api_credentials(self):
        script = (ROOT / "scripts/init-runtime.sh").read_text()
        self.assertNotIn("telegram-api-id", script)
        self.assertNotIn("telegram-api-hash", script)

    def test_telegram_database_initializer_is_additive(self):
        initializer = ROOT / "scripts/init-telegram-db.sh"
        self.assertTrue(initializer.exists())
        source = initializer.read_text()
        self.assertIn("CREATE ROLE telegram_bridge", source)
        self.assertIn("ALTER ROLE telegram_bridge", source)
        self.assertIn("CREATE DATABASE telegram_bridge OWNER telegram_bridge", source)
        for forbidden in ("DROP DATABASE", "DROP ROLE", "compose down", "rm -rf"):
            self.assertNotIn(forbidden, source)

    def test_telegram_runtime_bootstraps_before_render_and_guards_image(self):
        runtime = ROOT / "scripts/init-telegram-runtime.sh"
        self.assertTrue(runtime.exists())
        source = runtime.read_text()
        lock = dict(
            line.split("=", 1)
            for line in (ROOT / "deploy/images.lock.env").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertIn(f'[[ "$TELEGRAM_IMAGE" == {lock["TELEGRAM_IMAGE"]} ]]', source)
        self.assertIn('[[ "$project" == communicator ]]', source)
        self.assertEqual(
            2,
            source.count(
                'docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps --entrypoint /docker-run.sh telegram'
            ),
        )
        config_generation = source.index('if [[ ! -f "$config" ]]; then')
        first_render = source.index("python3 scripts/render-telegram-config.py")
        registration_generation = source.index(
            'if [[ ! -f "$registration" ]]; then', config_generation + 1
        )
        final_render = source.index("python3 scripts/render-telegram-config.py", first_render + 1)
        self.assertLess(
            config_generation,
            first_render,
        )
        self.assertLess(first_render, registration_generation)
        self.assertLess(registration_generation, final_render)
        for required in (
            'telegram-api-id',
            'telegram-api-hash',
            'stat -c',
            'install -o 991 -g 991 -m 0600',
        ):
            self.assertIn(required, source)
        self.assertEqual(2, source.count("--entrypoint /docker-run.sh"))

    def test_telegram_runtime_initializer_is_executable(self):
        runtime = ROOT / "scripts/init-telegram-runtime.sh"
        self.assertEqual(0o755, stat.S_IMODE(runtime.stat().st_mode))

    def test_second_run_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ | {"COMMUNICATOR_RUNTIME_DIR": directory}
            subprocess.run([ROOT / "scripts/init-runtime.sh"], env=env, check=True)
            secret = pathlib.Path(directory) / "secrets/postgres.env"
            before = secret.read_text()
            bridge_password = pathlib.Path(directory) / "secrets/whatsapp-db.password"
            bridge_before = bridge_password.read_text()
            messenger_password = pathlib.Path(directory) / "secrets/messenger-db.password"
            messenger_before = messenger_password.read_text()
            telegram_password = pathlib.Path(directory) / "secrets/telegram-db.password"
            self.assertTrue(telegram_password.exists())
            telegram_before = telegram_password.read_text()
            subprocess.run([ROOT / "scripts/init-runtime.sh"], env=env, check=True)
            self.assertEqual(before, secret.read_text())
            self.assertEqual(bridge_before, bridge_password.read_text())
            self.assertEqual(messenger_before, messenger_password.read_text())
            self.assertEqual(telegram_before, telegram_password.read_text())

    def test_messenger_database_initializer_is_additive(self):
        script = (ROOT / "scripts/init-messenger-db.sh").read_text()
        self.assertIn('"$project" == communicator || "$project" == communicator-restore-test', script)
        self.assertIn("CREATE ROLE messenger_bridge", script)
        self.assertIn("ALTER ROLE messenger_bridge", script)
        self.assertIn("CREATE DATABASE messenger_bridge OWNER messenger_bridge", script)
        for forbidden in ("DROP DATABASE", "DROP ROLE", "compose down", "rm -rf"):
            self.assertNotIn(forbidden, script)


if __name__ == "__main__":
    unittest.main()
