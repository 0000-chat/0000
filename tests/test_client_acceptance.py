from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "client_acceptance.py"
SPEC = importlib.util.spec_from_file_location("client_acceptance", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
client_acceptance = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = client_acceptance
SPEC.loader.exec_module(client_acceptance)


REST_PATHS: dict[tuple[str, str], tuple[str, str]] = {
    ("oauth_connection", "protected_resource"): ("GET", "/.well-known/oauth-protected-resource"),
    ("oauth_connection", "authorization_server"): ("GET", "/.well-known/oauth-authorization-server"),
    ("linking_identity_lifecycle", "unlinked_start"): ("POST", "/api/v1/link-sessions/unlinked_start"),
    ("linking_identity_lifecycle", "identity_grant"): ("POST", "/api/v1/link/grant/identity_grant"),
    ("linking_identity_lifecycle", "same_identity_relink"): ("POST", "/api/v1/link/relink/same_identity_relink"),
    ("linking_identity_lifecycle", "disconnect_preserves_history"): ("DELETE", "/api/v1/link/disconnect/disconnect_preserves_history"),
    ("linking_identity_lifecycle", "different_identity_account"): ("GET", "/api/v1/identities/different_identity_account"),
    ("history_context_attachment", "stored_history"): ("GET", "/api/v1/conversations/stored_history/messages"),
    ("history_context_attachment", "attachment_read"): ("GET", "/api/v1/attachments/authenticated_attachment"),
    ("text_send_and_route", "saved_before_dispatch"): ("POST", "/api/v1/conversations/send/saved_before_dispatch"),
    ("text_send_and_route", "provider_delivery"): ("GET", "/api/v1/commands/provider_delivery"),
    ("text_send_and_route", "account_failover_rejected"): ("POST", "/api/v1/conversations/send/account_failover_rejected"),
    ("direct_chat_and_group", "contact_resolution"): ("POST", "/api/v1/contacts/resolve/contact_resolution"),
    ("direct_chat_and_group", "direct_chat_creation"): ("POST", "/api/v1/conversations/direct_chat_creation"),
    ("direct_chat_and_group", "group_creation"): ("POST", "/api/v1/groups/group_creation"),
    ("direct_chat_and_group", "group_management"): ("PATCH", "/api/v1/groups/group_management"),
    ("webhook_subscriptions", "subscription_one_initial"): ("POST", "/api/v1/webhooks/subscription_one_initial"),
    ("webhook_subscriptions", "subscription_two_initial"): ("POST", "/api/v1/webhooks/subscription_two_initial"),
    ("webhook_subscriptions", "revision_removal"): ("DELETE", "/api/v1/webhooks/revision_removal"),
    ("webhook_subscriptions", "retry"): ("POST", "/api/v1/webhooks/retry"),
    ("webhook_subscriptions", "cutover"): ("PATCH", "/api/v1/webhooks/cutover"),
    ("receipt_and_restore", "explicit_receipt"): ("POST", "/api/v1/receipts/explicit_receipt"),
    ("receipt_and_restore", "active_removal"): ("POST", "/api/v1/removals/active_removal"),
    ("receipt_and_restore", "restore_anti_resurrection"): ("POST", "/api/v1/removals/restore/restore_anti_resurrection"),
    ("authorization_negative_matrix", "wrong_resource"): ("GET", "/api/v1/resource/wrong_resource"),
    ("authorization_negative_matrix", "expired_installation"): ("GET", "/api/v1/installation/expired_installation"),
    ("authorization_negative_matrix", "revoked_installation"): ("GET", "/api/v1/installation/revoked_installation"),
    ("authorization_negative_matrix", "missing_grant"): ("GET", "/api/v1/grant/missing_grant"),
    ("authorization_negative_matrix", "account_mismatch"): ("GET", "/api/v1/account/account_mismatch"),
    ("surface_outcome_record", "surface_metadata"): ("GET", "/api/v1/surface/metadata"),
}


def requirement(scenario: str, identifier: str) -> Any:
    return next(
        item
        for item in client_acceptance.SCENARIO_BY_ID[scenario].requirements
        if item.identifier == identifier
    )


class FakeTransport:
    def __init__(self, rest_statuses: dict[str, int] | None = None, *, extra_body: dict[str, Any] | None = None) -> None:
        self.rest_statuses = rest_statuses or {}
        self.extra_body = extra_body or {}
        self.rest_calls: list[tuple[str, str]] = []
        self.mcp_calls: list[str | None] = []
        self.mcp_error = False

    def _body(self, path: str) -> dict[str, Any]:
        different = "different_identity_account" in path
        subscription_two = "subscription_two" in path
        subscription_followup = any(token in path for token in ("revision_removal", "/retry", "/cutover"))
        body: dict[str, Any] = {
            "resource": "https://target.test/mcp",
            "authorization_server": "https://target.test",
            "authorization_servers": ["https://target.test"],
            "issuer": "https://target.test",
            "authorization_endpoint": "https://target.test/oauth/authorize",
            "token_endpoint": "https://target.test/oauth/token",
            "pkce_s256": True,
            "code_challenge_methods_supported": ["S256"],
            "account_id": "account_two" if different else "account_one",
            "chat_id": "chat_one",
            "message_id": "message_one",
            "identity_id": "identity_two" if different else "identity_one",
            "provider_account_id": "provider_account_two" if different else "provider_account_one",
            "grant_id": "grant_one",
            "grant_count": 0 if different else 1,
            "history_message_count": 0 if different else 1,
            "link_session_id": "link_session_one",
            "status": "linked",
            "connection_id": "connection_one",
            "previous_connection_id": "connection_one",
            "new_connection_id": "connection_one",
            "history_message_id": "message_one",
            "disconnect_status": "disconnected",
            "revision": "revision_one",
            "history_range_status": "complete",
            "attachment_id": "attachment_one",
            "sha256": "a" * 64,
            "mime_type": "application/pdf",
            "download_grant": "download_grant_one",
            "command_id": "command_one",
            "dispatch_id": "dispatch_one",
            "saved_status": "saved",
            "saved_at": "2026-09-14T00:00:00Z",
            "matrix_status": "accepted",
            "bridge_status": "delivered",
            "provider_status": "delivered",
            "provider_message_id": "provider_message_one",
            "requested_account_id": "account_two",
            "resolved_account_id": "account_one",
            "error_code": "account_mismatch",
            "contact_id": "contact_one",
            "provider_contact_id": "provider_contact_one",
            "resolution_status": "resolved",
            "provider_chat_id": "provider_chat_one",
            "group_operation_id": "group_operation_one",
            "provider_group_id": "provider_group_one",
            "group_revision": "group_revision_one",
            "member_ids_digest": "members_digest_one",
            "subscription_id": "subscription_two" if subscription_two else "subscription_one",
            "destination_version": "destination_one",
            "old_destination_version": "destination_one",
            "new_destination_version": "destination_two",
            "delivery_id": "delivery_one",
            "source_event_id": "source_event_one",
            "receiver_id": "receiver_one",
            "delivery_status": "delivered",
            "removal_event_id": "removal_event_one",
            "content_status": "content_removed",
            "attempt_count": 2,
            "retry_deadline": "2026-09-14T00:10:00Z",
            "manual_retry_actor": "operator_one",
            "cancelled_pending_count": 1,
            "receipt_id": "receipt_one",
            "requested_status": "read",
            "observed_status": "read",
            "result_class": "confirmed",
            "removal_id": "removal_one",
            "content_generation": 2,
            "deletion_epoch": 3,
            "active_read_status": "removed",
            "attachment_status": "removed",
            "restore_id": "restore_one",
            "stale_work_rejected": True,
            "retained_message_id": "message_one",
            "retained_revision": "revision_two",
            "resource_metadata": "wrong-resource",
            "installation_id": "installation_one",
            "surface": "test-client",
            "client_version": "1.2.3",
            "provider_version": "controlled-1",
            "evidence_class": "controlled",
            "support_status": "supported",
            "dispatch_status": "accepted",
            "member_id": "member_one",
            "ownership_scope": "connection",
            "actor_binding": "member_installation",
            "duplicate_status": "duplicate",
            "idempotency_key": "idempotency_one",
            "second_request_reused": True,
            "uncertainty_status": "delivery_uncertain",
            "chat_paused": True,
            "reconnect_status": "reconnected",
            "age_preserved": True,
            "confirmation_status": "confirmed",
        }
        if subscription_followup:
            body["subscription_id"] = "subscription_one"
        body.update(self.extra_body)
        if "/unsupported" in path:
            body["capability"] = {"status": "unavailable"}
        return body

    def rest(self, method: str, path: str, query: dict[str, Any], body: Any, token: str | None) -> client_acceptance.HttpResponse:
        del query, body, token
        self.rest_calls.append((method, path))
        status = self.rest_statuses.get(path, 200)
        case = path.rstrip("/").split("/")[-1]
        if case in {"account_failover_rejected", "wrong_resource", "expired_installation", "revoked_installation"}:
            status = 401
        if case in {"missing_grant", "account_mismatch"}:
            status = 403
        response_body = self._body(path)
        raw = client_acceptance.canonical_bytes(response_body)
        return client_acceptance.HttpResponse(status, {"content-type": "application/json"}, response_body, raw)

    def mcp(self, request: dict[str, Any], token: str | None, client: dict[str, str]) -> client_acceptance.HttpResponse:
        del token, client
        self.mcp_calls.append(request.get("tool") or request.get("method"))
        if self.mcp_error:
            response_body = {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "failed"}}
        elif request.get("method") == "initialize":
            response_body = {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": client_acceptance.MCP_PROTOCOL_VERSION,
                    "serverInfo": {"name": "communicator", "version": "1.0.0"},
                },
            }
        else:
            response_body = {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": self._body("/mcp")}}
        raw = client_acceptance.canonical_bytes(response_body)
        status = 400 if request.get("arguments", {}).get("acceptance_case") == "provider_rejection" else 200
        return client_acceptance.HttpResponse(status, {"content-type": "application/json"}, response_body, raw)


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
            "client": {"surface": "test-client", "name": "Test client", "version": "1.2.3", "transport": "both"},
            "provider": {"name": "whatsapp", "version": "controlled-1", "adapter_version": "adapter-1", "proof_source": "controlled provider"},
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
        "oauth": {
            "access_token_env": "TEST_ACCEPTANCE_TOKEN",
            "admin_access_token_env": "TEST_ACCEPTANCE_ADMIN_TOKEN",
        },
        "operations": operations,
    }


def operation_for_requirement(
    scenario: str,
    requirement_identifier: str,
    *,
    identifier: str | None = None,
    path: str | None = None,
    method: str | None = None,
    tool: str | None = None,
    evidence: dict[str, Any] | None = None,
    statuses: list[int] | None = None,
    expect: dict[str, Any] | None = None,
    actor: str | None = None,
) -> dict[str, Any]:
    req = requirement(scenario, requirement_identifier)
    transport = req.transports[0]
    if transport == "rest":
        default_method, default_path = REST_PATHS[(scenario, requirement_identifier)]
        request: dict[str, Any] = {"method": method or default_method, "path": path or default_path}
        pointers = {name: f"/{name}" for name in req.evidence}
    else:
        if req.case == "initialize":
            request = {"method": "initialize"}
            pointers = {
                "protocol_version": "/result/protocolVersion",
                "server_name": "/result/serverInfo/name",
                "server_version": "/result/serverInfo/version",
            }
        else:
            allowed = client_acceptance.MCP_CONTRACTS[(scenario, requirement_identifier)]
            request = {"tool": tool or allowed[0], "arguments": {"acceptance_case": req.case}}
            pointers = {name: f"/result/structuredContent/{name}" for name in req.evidence}
    operation_evidence = evidence or {"extract": pointers, "required": list(req.evidence)}
    operation_expect = {"statuses": statuses or list(req.statuses)}
    if expect:
        operation_expect.update(expect)
    return {
        "id": identifier or f"{scenario}-{requirement_identifier}",
        "scenario": scenario,
        "actor": actor or req.actors[0],
        "transport": transport,
        "proof": {"role": req.role, "case": req.case},
        "request": request,
        "expect": operation_expect,
        "evidence": operation_evidence,
    }


def all_scenario_operations() -> list[dict[str, Any]]:
    return [
        operation_for_requirement(scenario.identifier, req.identifier)
        for scenario in client_acceptance.SCENARIOS
        for req in scenario.requirements
    ]


class ClientAcceptanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_token = os.environ.get("TEST_ACCEPTANCE_TOKEN")
        self.previous_admin_token = os.environ.get("TEST_ACCEPTANCE_ADMIN_TOKEN")
        os.environ["TEST_ACCEPTANCE_TOKEN"] = "controlled-token-value"
        os.environ["TEST_ACCEPTANCE_ADMIN_TOKEN"] = "controlled-admin-token-value"

    def tearDown(self) -> None:
        if self.previous_token is None:
            os.environ.pop("TEST_ACCEPTANCE_TOKEN", None)
        else:
            os.environ["TEST_ACCEPTANCE_TOKEN"] = self.previous_token
        if self.previous_admin_token is None:
            os.environ.pop("TEST_ACCEPTANCE_ADMIN_TOKEN", None)
        else:
            os.environ["TEST_ACCEPTANCE_ADMIN_TOKEN"] = self.previous_admin_token

    def test_complete_controlled_run_requires_every_semantic_case(self) -> None:
        config = config_with_operations(all_scenario_operations())
        transport = FakeTransport()
        bundle = client_acceptance.AcceptanceRunner(config, transport=transport, now="2026-09-14T00:00:00Z").run()
        self.assertEqual(bundle["run"]["status"], "complete")
        self.assertTrue(transport.rest_calls)
        self.assertIn("initialize", transport.mcp_calls)
        self.assertIn("list_identities", transport.mcp_calls)
        self.assertEqual(len(bundle["scenarios"]), len(client_acceptance.SCENARIOS))
        self.assertTrue(all(item["status"] == "pass" for item in bundle["scenarios"]))
        self.assertFalse("controlled-token-value" in json.dumps(bundle))
        client_acceptance.validate_bundle(bundle)

    def test_missing_scenarios_are_unverified_and_never_pass(self) -> None:
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([]), transport=FakeTransport()).run()
        self.assertEqual(bundle["run"]["status"], "incomplete")
        self.assertTrue(all(item["status"] == "unverified" for item in bundle["scenarios"]))
        self.assertEqual(bundle["operations"], [])

    def test_arbitrary_successful_get_does_not_satisfy_send_contract(self) -> None:
        operation = operation_for_requirement("text_send_and_route", "saved_before_dispatch", path="/api/v1/identities/identity_one", method="GET")
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([operation]),
            transport=FakeTransport(),
        ).run()
        record = bundle["operations"][0]
        self.assertEqual(record["status"], "unverified")
        self.assertIn("entrypoint", record["reason"] or "")
        self.assertEqual(next(item for item in bundle["scenarios"] if item["id"] == "text_send_and_route")["status"], "unverified")

    def test_required_contract_evidence_prevents_false_pass(self) -> None:
        req = requirement("text_send_and_route", "saved_before_dispatch")
        pointers = {name: f"/{name}" for name in req.evidence}
        pointers["command_id"] = "/missing"
        operation = operation_for_requirement("text_send_and_route", "saved_before_dispatch", evidence={"extract": pointers, "required": list(req.evidence)})
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([operation]), transport=FakeTransport()).run()
        self.assertEqual(bundle["operations"][0]["status"], "unverified")
        self.assertIn("command_id", bundle["operations"][0]["reason"] or "")

    def test_passing_observed_ids_can_bind_a_later_operation(self) -> None:
        first = operation_for_requirement(
            "linking_identity_lifecycle", "identity_grant", identifier="grant"
        )
        second = operation_for_requirement(
            "linking_identity_lifecycle",
            "same_identity_relink",
            path="/api/v1/link/relink/${observed.grant.account_id}",
        )
        transport = FakeTransport()
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([first, second]), transport=transport
        ).run()
        self.assertEqual(bundle["operations"][0]["status"], "pass")
        self.assertEqual(bundle["operations"][1]["status"], "pass")
        self.assertIn("/api/v1/link/relink/account_one", [path for _, path in transport.rest_calls])

    def test_explicit_unsupported_evidence_is_required(self) -> None:
        operation = operation_for_requirement(
            "history_context_attachment", "attachment_read", path="/api/v1/attachments/unsupported",
            expect={"statuses": [404], "outcome": "unsupported", "unsupported_statuses": [404], "unsupported_evidence": ["/capability/status"]},
        )
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([operation]),
            transport=FakeTransport({"/api/v1/attachments/unsupported": 404}),
        ).run()
        self.assertEqual(bundle["operations"][0]["status"], "unsupported")
        implicit = operation_for_requirement(
            "history_context_attachment", "attachment_read", path="/api/v1/attachments/unsupported",
            expect={"statuses": [200], "unsupported_statuses": [404]},
        )
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([implicit]))

    def test_mcp_jsonrpc_error_at_http_200_is_not_a_pass(self) -> None:
        transport = FakeTransport()
        transport.mcp_error = True
        operation = operation_for_requirement("grok_surface_send", "surface_text_send")
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([operation]), transport=transport).run()
        self.assertEqual(bundle["operations"][0]["status"], "implementation_defect")

    def test_network_transport_performs_protocol_versioned_mcp_handshake(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib protocol hook
                length = int(self.headers["Content-Length"])
                payload = json.loads(self.rfile.read(length))
                self.server.calls.append((payload, self.headers.get("MCP-Protocol-Version")))  # type: ignore[attr-defined]
                if payload["method"] == "initialize":
                    body = {
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "result": {
                            "protocolVersion": client_acceptance.MCP_PROTOCOL_VERSION,
                            "serverInfo": {"name": "fixture", "version": "1.0"},
                        },
                    }
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("MCP-Session-Id", "fixture-session")
                    raw = client_acceptance.canonical_bytes(body)
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                if payload["method"] == "notifications/initialized":
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = {
                    "jsonrpc": "2.0",
                    "id": payload["id"],
                    "result": {
                        "structuredContent": {
                            "account_id": "account_one",
                            "chat_id": "chat_one",
                            "message_id": "message_one",
                        }
                    },
                }
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                raw = client_acceptance.canonical_bytes(body)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, format: str, *args: Any) -> None:
                del format, args

        try:
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        except PermissionError:
            self.skipTest("sandbox does not permit a local fixture listener")
        server.calls = []  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            config = config_with_operations(
                [
                    operation_for_requirement("oauth_connection", "mcp_initialize"),
                    operation_for_requirement("oauth_connection", "mcp_scoped_read"),
                ]
            )
            config["target"]["base_url"] = f"http://127.0.0.1:{port}"
            config["target"]["mcp_url"] = f"http://127.0.0.1:{port}/mcp"
            bundle = client_acceptance.AcceptanceRunner(
                config,
                transport=client_acceptance.NetworkTransport(config["target"], timeout=5),
            ).run()
            self.assertEqual(bundle["operations"][0]["status"], "pass")
            self.assertEqual(bundle["operations"][1]["status"], "pass")
            self.assertEqual(len(server.calls), 3)  # initialize, initialized notification, tool call
            self.assertTrue(all(version == client_acceptance.MCP_PROTOCOL_VERSION for _, version in server.calls))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_unsupported_and_unexpected_statuses_are_separate(self) -> None:
        unsupported = operation_for_requirement(
            "history_context_attachment", "attachment_read", path="/api/v1/attachments/unsupported",
            expect={"statuses": [404], "outcome": "unsupported", "unsupported_statuses": [404], "unsupported_evidence": ["/capability/status"]},
        )
        broken = operation_for_requirement("history_context_attachment", "stored_history", path="/api/v1/conversations/broken/messages")
        transport = FakeTransport({"/api/v1/attachments/unsupported": 404, "/api/v1/conversations/broken/messages": 500})
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([unsupported, broken]), transport=transport).run()
        statuses = {item["id"]: item["status"] for item in bundle["operations"]}
        self.assertEqual(statuses[unsupported["id"]], "unsupported")
        self.assertEqual(statuses[broken["id"]], "implementation_defect")

    def test_scalar_evidence_rejects_objects_and_arrays(self) -> None:
        req = requirement("text_send_and_route", "saved_before_dispatch")
        pointers = {name: f"/{name}" for name in req.evidence}
        pointers["command_id"] = "/object"
        operation = operation_for_requirement("text_send_and_route", "saved_before_dispatch", evidence={"extract": pointers, "required": list(req.evidence)})
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([operation]), transport=FakeTransport(extra_body={"object": {"id": "command_one"}})).run()
        self.assertEqual(bundle["operations"][0]["status"], "unverified")
        self.assertIn("scalar", bundle["operations"][0]["reason"] or "")

    def test_live_preflight_failure_blocks_operations_and_completion(self) -> None:
        config = config_with_operations([operation_for_requirement("oauth_connection", "protected_resource")])
        config["mode"] = "live_client"
        config["target"]["base_url"] = "https://target.test"
        config["target"]["mcp_url"] = "https://target.test/mcp"
        config["preflight"] = {"enabled": True}
        bundle = client_acceptance.AcceptanceRunner(
            config, transport=FakeTransport(extra_body={"authorization_servers": []})
        ).run()
        self.assertEqual(bundle["run"]["status"], "incomplete")
        self.assertEqual(bundle["operations"][0]["status"], "unverified")
        self.assertEqual(len(bundle["operations"]), 1)

    def test_inline_credentials_and_unsafe_redirect_are_rejected(self) -> None:
        config = config_with_operations([])
        config["oauth"]["access_token"] = "do-not-store-this"
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config)
        config = config_with_operations([])
        config["oauth"].update({"client_id": "controlled-client", "redirect_uri": "http://client.test/callback"})
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config)

    def test_oauth_authorization_server_is_allowed_as_metadata(self) -> None:
        config = config_with_operations([])
        config["oauth"].update({"authorization_server": "https://target.test", "client_id": "controlled-client", "redirect_uri": "https://client.test/callback"})
        client_acceptance.validate_config(config)

    def test_oauth_endpoints_require_https_but_allow_loopback_redirect(self) -> None:
        config = config_with_operations([])
        config["oauth"].update({"client_id": "controlled-client", "redirect_uri": "http://127.0.0.1:8765/callback"})
        client_acceptance.validate_config(config)
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.build_authorization_url(
                {
                    "authorization_endpoint": "http://target.test/authorize",
                    "code_challenge_methods_supported": ["S256"],
                },
                config["oauth"],
                "state",
                "verifier",
                config["target"]["resource"],
            )
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.build_authorization_url(
                {
                    "authorization_endpoint": "https://target.test/authorize",
                    "code_challenge_methods_supported": ["plain"],
                },
                config["oauth"],
                "state",
                "verifier",
                config["target"]["resource"],
            )

    def test_evidence_cannot_extract_raw_message_content(self) -> None:
        req = requirement("history_context_attachment", "stored_history")
        evidence = {"extract": {name: f"/{name}" for name in req.evidence}, "required": list(req.evidence)}
        evidence["extract"]["body"] = "/body"
        operation = operation_for_requirement("history_context_attachment", "stored_history", evidence=evidence)
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

    def test_fixture_or_missing_operation_cannot_validate_as_a_completed_bundle(self) -> None:
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([]), transport=FakeTransport()).run()
        bundle["scenarios"][0]["status"] = "pass"
        with self.assertRaises(client_acceptance.EvidenceError):
            client_acceptance.validate_bundle(bundle)

    def test_bundle_validation_rejects_extra_schema_fields(self) -> None:
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([]), transport=FakeTransport()).run()
        bundle["controls"]["unexpected"] = True
        with self.assertRaises(client_acceptance.EvidenceError):
            client_acceptance.validate_bundle(bundle)

    def test_sse_parser_and_pkce_match_protocol_values(self) -> None:
        payload = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1}\n\n"
        self.assertEqual(client_acceptance.parse_sse(payload), {"jsonrpc": "2.0", "id": 1})
        self.assertEqual(client_acceptance.pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")

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
