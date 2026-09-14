from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "client_acceptance.py"
SPEC = importlib.util.spec_from_file_location("client_acceptance", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
client_acceptance = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = client_acceptance
SPEC.loader.exec_module(client_acceptance)


class FakeTransport:
    def __init__(self, rest_statuses: dict[str, int] | None = None) -> None:
        self.rest_statuses = rest_statuses or {}
        self.rest_calls: list[tuple[str, str]] = []
        self.mcp_calls: list[str | None] = []

    def rest(
        self,
        method: str,
        path: str,
        query: dict[str, Any],
        body: Any,
        token: str | None,
    ) -> client_acceptance.HttpResponse:
        del query, body
        self.rest_calls.append((method, path))
        status = self.rest_statuses.get(path, 200)
        response_body: dict[str, Any] = {
            "ok": True,
            "resource": "https://target.test/mcp",
            "account_id": "account_one",
            "provider_message_id": "provider_message_one",
        }
        raw = client_acceptance.canonical_bytes(response_body)
        return client_acceptance.HttpResponse(status, {"content-type": "application/json"}, response_body, raw)

    def mcp(
        self,
        request: dict[str, Any],
        token: str | None,
        client: dict[str, str],
    ) -> client_acceptance.HttpResponse:
        del token, client
        self.mcp_calls.append(request.get("tool"))
        response_body = {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "structuredContent": {
                    "ok": True,
                    "account_id": "account_one",
                    "provider_message_id": "provider_message_one",
                }
            },
        }
        raw = client_acceptance.canonical_bytes(response_body)
        return client_acceptance.HttpResponse(200, {"content-type": "application/json"}, response_body, raw)


def config_with_operations(operations: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "run_id": "test-run",
        "mode": "controlled",
        "environment": "test",
        "source_commit": "test-commit",
        "preflight": {"enabled": False},
        "target": {
            "base_url": "http://target.test",
            "mcp_url": "http://target.test/mcp",
            "resource": "https://target.test/mcp",
            "client": {
                "surface": "test-client",
                "name": "Test client",
                "version": "1.2.3",
                "transport": "both",
            },
            "provider": {
                "name": "whatsapp",
                "version": "controlled-1",
                "adapter_version": "adapter-1",
                "proof_source": "controlled provider",
            },
            "bindings": {
                "tenant_id": "tenant_one",
                "installation_id": "installation_one",
                "grant_ids": ["grant_one"],
                "account_ids": ["account_one"],
                "chat_ids": ["chat_one"],
                "connection_ids": ["connection_one"],
                "provider_account_ids": ["provider_account_one"],
                "identity_ids": ["identity_one"],
            },
        },
        "oauth": {"access_token_env": "TEST_ACCEPTANCE_TOKEN"},
        "operations": operations,
    }


def operation(
    identifier: str,
    scenario: str,
    transport: str = "rest",
    *,
    path: str | None = None,
    tool: str | None = None,
    evidence: dict[str, Any] | None = None,
    statuses: list[int] | None = None,
    unsupported_statuses: list[int] | None = None,
) -> dict[str, Any]:
    request: dict[str, Any]
    if transport == "rest":
        request = {"method": "GET", "path": path or f"/{identifier}"}
    else:
        request = {"tool": tool or identifier, "arguments": {}}
    expect: dict[str, Any] = {"statuses": statuses or [200]}
    if unsupported_statuses is not None:
        expect["unsupported_statuses"] = unsupported_statuses
    return {
        "id": identifier,
        "scenario": scenario,
        "transport": transport,
        "request": request,
        "expect": expect,
        "evidence": evidence or {},
    }


def all_scenario_operations() -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    for scenario in client_acceptance.SCENARIOS:
        for index in range(scenario.minimum_operations):
            transport = "mcp" if scenario.identifier == "oauth_connection" and index == 1 else "rest"
            operations.append(
                operation(
                    f"{scenario.identifier}-{index + 1}",
                    scenario.identifier,
                    transport,
                    tool="list_identities" if transport == "mcp" else None,
                )
            )
    return operations


class ClientAcceptanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_token = os.environ.get("TEST_ACCEPTANCE_TOKEN")
        os.environ["TEST_ACCEPTANCE_TOKEN"] = "controlled-token-value"

    def tearDown(self) -> None:
        if self.previous_token is None:
            os.environ.pop("TEST_ACCEPTANCE_TOKEN", None)
        else:
            os.environ["TEST_ACCEPTANCE_TOKEN"] = self.previous_token

    def test_complete_controlled_run_uses_rest_and_mcp_and_records_bindings(self) -> None:
        config = config_with_operations(all_scenario_operations())
        transport = FakeTransport()
        bundle = client_acceptance.AcceptanceRunner(config, transport=transport, now="2026-09-14T00:00:00Z").run()

        self.assertEqual(bundle["run"]["status"], "complete")
        self.assertTrue(transport.rest_calls)
        self.assertEqual(transport.mcp_calls, ["list_identities"])
        self.assertEqual(len(bundle["scenarios"]), len(client_acceptance.SCENARIOS))
        self.assertEqual(bundle["run"]["bindings"]["grant_ids"], ["grant_one"])
        self.assertFalse("controlled-token-value" in json.dumps(bundle))
        client_acceptance.validate_bundle(bundle)

    def test_missing_scenarios_are_unverified_and_never_pass(self) -> None:
        config = config_with_operations([])
        bundle = client_acceptance.AcceptanceRunner(config, transport=FakeTransport()).run()

        self.assertEqual(bundle["run"]["status"], "incomplete")
        self.assertTrue(all(item["status"] == "unverified" for item in bundle["scenarios"]))
        self.assertEqual(bundle["operations"], [])

    def test_required_response_evidence_prevents_a_false_pass(self) -> None:
        config = config_with_operations(
            [
                operation(
                    "send-text",
                    "text_send_and_route",
                    evidence={"extract": {"provider_id": "/missing"}, "required": ["provider_id"]},
                )
            ]
        )
        bundle = client_acceptance.AcceptanceRunner(config, transport=FakeTransport()).run()
        record = next(item for item in bundle["operations"] if item["id"] == "send-text")

        self.assertEqual(record["status"], "unverified")
        self.assertIn("provider_id", record["reason"] or "")
        scenario = next(item for item in bundle["scenarios"] if item["id"] == "text_send_and_route")
        self.assertEqual(scenario["status"], "unverified")

    def test_unsupported_and_unexpected_statuses_are_separate(self) -> None:
        config = config_with_operations(
            [
                operation(
                    "unsupported-media",
                    "history_context_attachment",
                    path="/unsupported",
                    statuses=[200],
                    unsupported_statuses=[404],
                ),
                operation(
                    "broken-read",
                    "history_context_attachment",
                    path="/broken",
                    statuses=[200],
                ),
            ]
        )
        transport = FakeTransport({"/unsupported": 404, "/broken": 500})
        bundle = client_acceptance.AcceptanceRunner(config, transport=transport).run()
        statuses = {item["id"]: item["status"] for item in bundle["operations"]}

        self.assertEqual(statuses["unsupported-media"], "unsupported")
        self.assertEqual(statuses["broken-read"], "implementation_defect")

    def test_inline_credentials_are_rejected(self) -> None:
        config = config_with_operations([])
        config["oauth"]["access_token"] = "do-not-store-this"
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config)

    def test_oauth_authorization_server_is_allowed_as_metadata(self) -> None:
        config = config_with_operations([])
        config["oauth"].update(
            {
                "authorization_server": "https://target.test",
                "client_id": "controlled-client",
                "redirect_uri": "https://client.test/callback",
            }
        )
        client_acceptance.validate_config(config)

    def test_evidence_cannot_extract_raw_message_content(self) -> None:
        config = config_with_operations(
            [
                operation(
                    "history-body",
                    "history_context_attachment",
                    evidence={"extract": {"body": "/body"}, "required": ["body"]},
                )
            ]
        )
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config)

    def test_fixture_or_missing_operation_cannot_validate_as_a_completed_bundle(self) -> None:
        config = config_with_operations([])
        bundle = client_acceptance.AcceptanceRunner(config, transport=FakeTransport()).run()
        bundle["scenarios"][0]["status"] = "pass"
        with self.assertRaises(client_acceptance.EvidenceError):
            client_acceptance.validate_bundle(bundle)

    def test_sse_parser_and_pkce_match_protocol_values(self) -> None:
        payload = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1}\n\n"
        self.assertEqual(client_acceptance.parse_sse(payload), {"jsonrpc": "2.0", "id": 1})
        self.assertEqual(
            client_acceptance.pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        )

    def test_oauth_state_and_token_files_are_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "oauth" / "state.json"
            token_path = Path(directory) / "oauth" / "token"
            state_path.parent.mkdir()
            state_path.write_text("{}", encoding="utf-8")
            token_path.write_text("token", encoding="utf-8")
            state_path.chmod(0o600)
            token_path.chmod(0o600)
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(token_path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
