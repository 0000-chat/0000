from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate-control-plane-oauth.py"
BOOTSTRAP = ROOT / "scripts" / "bootstrap-control-plane-oauth-client.py"


class ControlPlaneOAuthPackagingTest(unittest.TestCase):
    def test_upstream_and_downstream_callbacks_are_independent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            directory_path = Path(directory)
            env_file = directory_path / "oauth.env"
            client_file = directory_path / "oauth-client.json"
            env_file.write_text(
                "\n".join(
                    (
                        "COMMUNICATOR_OAUTH_ISSUER=https://communicator.example/",
                        "COMMUNICATOR_OAUTH_RESOURCE=https://communicator.example/mcp",
                        "COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS=900",
                        "COMMUNICATOR_OAUTH_HUMAN_AUTHORIZE_URL=https://idp.example/authorize",
                        "COMMUNICATOR_OAUTH_HUMAN_CLIENT_ID=communicator-human-client",
                        "COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI=https://communicator.example/oauth/callback",
                        'COMMUNICATOR_OAUTH_HUMAN_SCOPE="openid profile"',
                        "COMMUNICATOR_OAUTH_HUMAN_TOKEN_URL=https://idp.example/token",
                        "COMMUNICATOR_OAUTH_HUMAN_ISSUER=https://idp.example/",
                        "COMMUNICATOR_OAUTH_HUMAN_AUDIENCE=communicator-human-client",
                        "COMMUNICATOR_OAUTH_HUMAN_JWKS_URL=https://idp.example/.well-known/jwks.json",
                    )
                ),
                encoding="utf-8",
            )
            client_file.write_text(
                json.dumps(
                    {
                        "client_id": "chatgpt-work",
                        "client_name": "ChatGPT Work",
                        "redirect_uri": "https://mcp-client.example/callback",
                        "status": "active",
                    }
                ),
                encoding="utf-8",
            )

            validation = subprocess.run(
                [
                    sys.executable,
                    str(VALIDATOR),
                    "--env-file",
                    str(env_file),
                    "--client-file",
                    str(client_file),
                    "--environment",
                    "local",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(validation.returncode, 0, validation.stderr)

            bootstrap = subprocess.run(
                [
                    sys.executable,
                    str(BOOTSTRAP),
                    "--env-file",
                    str(env_file),
                    "--client-file",
                    str(client_file),
                    "--environment",
                    "local",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(bootstrap.returncode, 0, bootstrap.stderr)
            self.assertIn("--local", bootstrap.stdout)
            self.assertNotIn("--remote", bootstrap.stdout)
            self.assertNotIn("--env local", bootstrap.stdout)


if __name__ == "__main__":
    unittest.main()
