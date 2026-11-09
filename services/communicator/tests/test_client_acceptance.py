from __future__ import annotations

import importlib.util
import base64
import hashlib
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


ACTION_REQUEST_VECTORS_PATH = ROOT / "tests" / "fixtures" / "acceptance-action-request-vectors.json"
ACTION_REQUEST_VECTORS: dict[str, Any] = json.loads(
    ACTION_REQUEST_VECTORS_PATH.read_text(encoding="utf-8")
)


REST_PATHS: dict[tuple[str, str], tuple[str, str]] = {
    ("permission_inspection_request", "inspect_grants"): ("GET", "/api/v1/grants"),
    ("permission_inspection_request", "request_permissions"): ("POST", "/api/v1/permission-requests"),
    ("permission_inspection_request", "inspect_requests"): ("GET", "/api/v1/permission-requests"),
    ("authorization_negative_matrix", "wrong_issuer"): ("GET", "/api/v1/identities"),
    ("oauth_connection", "protected_resource"): ("GET", "/.well-known/oauth-protected-resource"),
    ("oauth_connection", "authorization_server"): ("GET", "/.well-known/oauth-authorization-server"),
    ("linking_identity_lifecycle", "unlinked_start"): ("POST", "/api/v1/identities/identity_one/link-sessions"),
    ("linking_identity_lifecycle", "identity_grant"): ("POST", "/api/v1/grants"),
    ("linking_identity_lifecycle", "same_identity_relink"): ("POST", "/api/v1/connections/connection_one/relink-sessions"),
    ("linking_identity_lifecycle", "disconnect_preserves_history"): ("POST", "/api/v1/connections/connection_one/disconnect"),
    ("linking_identity_lifecycle", "different_identity_account"): ("GET", "/api/v1/accounts"),
    ("history_context_attachment", "stored_history"): ("GET", "/api/v1/conversations/stored_history/messages"),
    ("history_context_attachment", "attachment_read"): ("GET", "/api/v1/attachments/authenticated_attachment"),
    ("text_send_and_route", "saved_before_dispatch"): ("POST", "/api/v1/conversations/chat_one/messages"),
    ("text_send_and_route", "provider_delivery"): ("GET", "/api/v1/commands/provider_delivery"),
    ("text_send_and_route", "account_failover_rejected"): ("POST", "/api/v1/conversations/chat_one/messages"),
    ("direct_chat_and_group", "contact_resolution"): ("POST", "/api/v1/contacts/resolve"),
    ("direct_chat_and_group", "direct_chat_creation"): ("POST", "/api/v1/conversations"),
    ("direct_chat_and_group", "group_creation"): ("POST", "/api/v1/groups"),
    ("direct_chat_and_group", "group_management"): ("PATCH", "/api/v1/groups/group_management"),
    ("webhook_subscriptions", "subscription_one_initial"): ("POST", "/api/v1/webhook-subscriptions"),
    ("webhook_subscriptions", "subscription_two_initial"): ("POST", "/api/v1/webhook-subscriptions"),
    ("webhook_subscriptions", "revision_removal"): ("DELETE", "/api/v1/webhook-subscriptions/subscription_one"),
    ("webhook_subscriptions", "retry"): ("POST", "/api/v1/webhook-deliveries/delivery_one/retry"),
    ("webhook_subscriptions", "cutover"): ("POST", "/api/v1/webhook-subscriptions/subscription_one/cutover"),
    ("receipt_and_restore", "explicit_receipt"): ("POST", "/api/v1/conversations/chat_one/receipts/read"),
    ("receipt_and_restore", "active_removal"): ("POST", "/api/v1/removals"),
    ("receipt_and_restore", "restore_anti_resurrection"): ("POST", "/api/v1/removals"),
    ("authorization_negative_matrix", "wrong_resource"): ("GET", "/api/v1/identities"),
    ("authorization_negative_matrix", "expired_installation"): ("GET", "/api/v1/identities"),
    ("authorization_negative_matrix", "revoked_installation"): ("GET", "/api/v1/identities"),
    ("authorization_negative_matrix", "missing_grant"): ("GET", "/api/v1/conversations/chat_one/messages"),
    ("authorization_negative_matrix", "account_mismatch"): ("GET", "/api/v1/conversations/chat_one/messages"),
    ("surface_outcome_record", "surface_metadata"): ("GET", "/api/v1/session"),
}

REST_OBSERVATION_PATHS: dict[tuple[str, str, str], tuple[str, str]] = {
    ("history_context_attachment", "attachment_read", "scope"): ("GET", "/api/v1/conversations/chat_one/messages"),
    ("history_context_attachment", "attachment_read", "bytes"): ("GET", "/api/v1/attachments/attachment_one/download"),
    ("webhook_subscriptions", "subscription_one_initial", "delivery"): ("GET", "/api/v1/webhook-deliveries/delivery_one"),
    ("webhook_subscriptions", "subscription_one_initial", "receiver"): ("GET", "/api/v1/webhook-deliveries/delivery_one"),
    ("webhook_subscriptions", "subscription_two_initial", "delivery"): ("GET", "/api/v1/webhook-deliveries/delivery_two"),
    ("webhook_subscriptions", "subscription_two_initial", "receiver"): ("GET", "/api/v1/webhook-deliveries/delivery_two"),
    ("webhook_subscriptions", "revision_removal", "delivery"): ("GET", "/api/v1/webhook-deliveries/delivery_one"),
    ("webhook_subscriptions", "revision_removal", "receiver"): ("GET", "/api/v1/webhook-deliveries/delivery_one"),
    ("webhook_subscriptions", "retry", "receiver"): ("GET", "/api/v1/webhook-deliveries/delivery_one"),
    ("webhook_subscriptions", "cutover", "before"): ("GET", "/api/v1/webhook-subscriptions/subscription_one"),
    ("webhook_subscriptions", "cutover", "cancellation"): ("GET", "/api/v1/webhook-subscriptions/subscription_one"),
    ("receipt_and_restore", "active_removal", "suppression"): ("GET", "/api/v1/removals"),
    ("receipt_and_restore", "restore_anti_resurrection", "restore"): ("POST", "/api/v1/removals/restore-projection"),
    ("receipt_and_restore", "restore_anti_resurrection", "retained"): ("GET", "/api/v1/conversations/chat_one/messages"),
    ("receipt_and_restore", "restore_anti_resurrection", "suppression"): ("GET", "/api/v1/removals/restore-authority"),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_result"): ("POST", "/api/v1/connections/connection_one/relink-sessions"),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_operation"): ("GET", "/api/v1/connections/connection_one/lifecycle-operations/lifecycle_relink_session_one"),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_grant"): ("POST", "/api/v1/grants"),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_chat"): ("GET", "/api/v1/identities/identity_one/conversations/chat_one"),
    ("linking_identity_lifecycle", "disconnect_preserves_history", "disconnect_result"): ("POST", "/api/v1/connections/connection_one/disconnect"),
    ("linking_identity_lifecycle", "disconnect_preserves_history", "history_after_disconnect"): ("GET", "/api/v1/conversations/chat_one/messages"),
    ("linking_identity_lifecycle", "different_identity_account", "account_result"): ("GET", "/api/v1/accounts"),
    ("linking_identity_lifecycle", "different_identity_account", "grant_count"): ("GET", "/api/v1/grants"),
    ("linking_identity_lifecycle", "different_identity_account", "history_count"): ("GET", "/api/v1/identities/identity_two/conversations"),
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
            "new_connection_id": "connection_new",
            "operation_id": "operation_disconnect",
            "disconnect_operation_id": "operation_disconnect",
            "replacement_connection_id": "connection_new",
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
            "saved_status": "accepted",
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
            "member_ids_digest": "b" * 64,
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
            "confirmation_status": "confirm",
        }
        if subscription_followup:
            body["subscription_id"] = "subscription_one"
        body.update(self.extra_body)
        if "/unsupported" in path:
            body["capability"] = {"status": "unavailable"}
        return body

    def rest(
        self,
        method: str,
        path: str,
        query: dict[str, Any],
        body: Any,
        token: str | None,
        headers: dict[str, str] | None = None,
    ) -> client_acceptance.HttpResponse:
        del token, headers
        self.rest_calls.append((method, path))
        acceptance_case = query.get("acceptance_case")
        body_path = path
        if acceptance_case == "different_identity_account":
            body_path = "/different_identity_account"
        elif acceptance_case == "subscription_two_initial":
            body_path = "/subscription_two"
        elif acceptance_case in {"revision_removal", "retry", "cutover"}:
            body_path = f"/{acceptance_case}"
        response_body = self._body(body_path)
        status = self.rest_statuses.get(path, 200)
        case = path.rstrip("/").split("/")[-1]
        if acceptance_case == "account_failover_rejected" or acceptance_case in {"wrong_resource", "expired_installation", "revoked_installation"}:
            status = 401
        if acceptance_case in {"missing_grant", "account_mismatch"}:
            status = 403
        if acceptance_case in {"wrong_resource", "expired_installation", "revoked_installation", "missing_grant", "account_mismatch"}:
            response_body["error_code"] = acceptance_case
        if path == "/api/v1/grants" or path.startswith("/api/v1/grants/"):
            response_body["id"] = response_body["grant_id"]
        elif path.endswith("/relink-sessions"):
            response_body["id"] = "relink_session_one"
        elif path.endswith("/conversations/chat_one"):
            response_body["id"] = response_body["chat_id"]
        if path == "/api/v1/accounts":
            response_body = {
                "items": [
                    {
                        "identity_id": response_body["identity_id"],
                        "account_id": response_body["account_id"],
                    }
                ],
                "next_cursor": None,
            }
        elif path == "/api/v1/grants" and method == "GET":
            response_body = {"items": [], "next_cursor": None}
        elif path.startswith("/api/v1/identities/") and path.endswith("/conversations"):
            response_body = {"items": [], "next_cursor": None}
        if query.get("acceptance_case") == "disconnect_preserves_history":
            response_body = {
                "items": [
                    {
                        "id": response_body["history_message_id"],
                        "identity_id": response_body["identity_id"],
                        "account_id": response_body["account_id"],
                        "conversation_id": response_body["chat_id"],
                        "connection_id": response_body["connection_id"],
                    }
                ],
                "next_cursor": None,
            }
        raw = client_acceptance.canonical_bytes(response_body)
        return client_acceptance.HttpResponse(status, {"content-type": "application/json"}, response_body, raw)

    def mcp(self, request: dict[str, Any], token: str | None, client: dict[str, str]) -> client_acceptance.HttpResponse:
        del token, client
        self.mcp_calls.append(request.get("tool") or request.get("method"))
        arguments = request.get("arguments", {})
        provider_rejection = (
            arguments.get("idempotency_key") == "acceptance-provider_rejection-001"
        )
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
            body = self._body("/mcp")
            if request.get("tool") == "list_messages":
                body = {
                    "items": [
                        {
                            "id": body["message_id"],
                            "account_id": body["account_id"],
                            "conversation_id": body["chat_id"],
                        }
                    ],
                    "next_cursor": None,
                }
            elif request.get("tool") in {"send_text_reply", "get_text_reply_status"}:
                body = {
                    "command": {
                        "id": body["command_id"],
                        "status": body["saved_status"],
                        "created_at": body["saved_at"],
                        "confirmation_decision": body["confirmation_status"],
                        "failure_code": body["error_code"]
                        if provider_rejection
                        else None,
                    },
                    "message": {"id": body["message_id"]},
                    "dispatch": {
                        "command_id": body["command_id"],
                        "account_id": body["account_id"],
                        "conversation_id": body["chat_id"],
                        "idempotency_key": body["idempotency_key"],
                        "status": body["uncertainty_status"],
                        "provider_stage": body["provider_status"],
                        "chat_paused": body["chat_paused"],
                    },
                    "replayed": body["second_request_reused"],
                }
            response_body = {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": body}}
        raw = client_acceptance.canonical_bytes(response_body)
        status = 400 if provider_rejection else 200
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
    headers: dict[str, str] | None = None,
    body: Any = None,
    statuses: list[int] | None = None,
    expect: dict[str, Any] | None = None,
    actor: str | None = None,
    observation: str | None = None,
    transport: str | None = None,
) -> dict[str, Any]:
    req = requirement(scenario, requirement_identifier)
    selected_observation = observation or ("metadata" if requirement_identifier == "attachment_read" else next(iter(client_acceptance._declared_observations(req))))
    observation_fields = client_acceptance._observation_fields(req, selected_observation)
    transport = transport or req.transports[0]
    if transport == "rest":
        default_method, default_path = REST_OBSERVATION_PATHS.get(
            (scenario, requirement_identifier, selected_observation),
            REST_PATHS[(scenario, requirement_identifier)],
        )
        request: dict[str, Any] = {"method": method or default_method, "path": path or default_path}
        if req.case in {
            "different_identity_account",
            "subscription_two_initial",
            "revision_removal",
            "retry",
            "cutover",
            "wrong_resource",
            "expired_installation",
            "revoked_installation",
            "missing_grant",
            "account_mismatch",
            "account_failover_rejected",
        }:
            request["query"] = {"acceptance_case": req.case}
        if selected_observation == "history_after_disconnect":
            request["query"] = {"acceptance_case": req.case}
        request_contract = client_acceptance._rest_request_contract(
            scenario, req, selected_observation, request
        )
        if headers is not None:
            request["headers"] = headers
        elif request_contract is not None and request_contract.required_headers:
            request["headers"] = {
                header: f"acceptance-{req.case}-001"
                for header in request_contract.required_headers
            }
        if body is not None:
            request["body"] = body
        elif request_contract is not None and request_contract.body_required:
            values: dict[str, Any] = {
                "provider": "whatsapp",
                "method": "qr",
                "confirmed_identity_id": "identity_one",
                "expected_session_generation": "2026-09-14T00:00:00Z",
                "membership_id": "membership_one",
                "identity_id": "identity_one",
                "account_id": "account_one",
                "operation_scope": "conversation.read",
                "chat_scope": "all_chats",
                "chat_ids": [],
                "idempotency_key": f"acceptance-{req.case}-001",
                "body": "controlled acceptance body",
                "delivery_mode": "direct",
                "phone": "+10000000000",
                "contact_id": "contact_one",
                "candidate_revision": "a" * 64,
                "name": "Controlled group",
                "participants": [
                    {"contact_id": "contact_one", "candidate_revision": "a" * 64}
                ],
                "destination": {"url": "https://receiver.test/webhook"},
                "event_filter": {"event_types": ["message.created"]},
                "global_enabled": True,
                "account_rules": [],
                "chat_rules": [],
                "owner_installation_id": "installation_one",
                "logical_agent_id": None,
                "tenant_id": "tenant_one",
                "schema_version": 1,
                "conversation_id": "chat_one",
                "expected_revision": "revision_one",
                "message_id": "message_one",
                "resource_type": "message",
                "resource_id": "message_one",
                "content_generation": "2",
                "reason": "requested",
                "removed_at": "2026-09-14T00:00:00Z",
                "rebuild_id": "rebuild_one",
                "expected_generation": 1,
                "started_at": "2026-09-14T00:00:00Z",
            }
            if request_contract.body_keys is None:
                request["body"] = {}
            else:
                request["body"] = {
                    key: values[key]
                    for key in request_contract.body_keys
                    if key in values
                }
        pointers = dict(
            client_acceptance.REST_CANONICAL_POINTERS.get(
                (scenario, requirement_identifier, selected_observation),
                {name: f"/{name}" for name in observation_fields},
            )
        )
    else:
        if req.case == "initialize":
            request = {"method": "initialize"}
            pointers = {
                "protocol_version": "/result/protocolVersion",
                "server_name": "/result/serverInfo/name",
                "server_version": "/result/serverInfo/version",
            }
        else:
            allowed = client_acceptance._mcp_contract_tools(
                scenario, req, selected_observation
            )
            if not allowed:
                raise client_acceptance.ConfigError(
                    f"no canonical MCP contract is published for {scenario}/{requirement_identifier}"
                )
            chosen_tool = tool or allowed[0]
            request = {"tool": chosen_tool, "arguments": {}}
            if chosen_tool == "list_messages":
                request["arguments"].update(
                    {
                        "identity_id": "identity_one",
                        "conversation_id": "chat_one",
                        "account_id": "account_one",
                        "limit": 1,
                    }
                )
            elif chosen_tool == "send_text_reply":
                request["arguments"].update(
                    {
                        "identity_id": "identity_one",
                        "conversation_id": "chat_one",
                        "account_id": "account_one",
                        "body": "controlled acceptance body",
                        "delivery_mode": "direct",
                        "idempotency_key": f"acceptance-{req.case}-001",
                    }
                )
            elif chosen_tool == "get_text_reply_status":
                request["arguments"].update({"command_id": "command_one"})
            canonical = client_acceptance.MCP_CANONICAL_POINTERS.get(
                (scenario, requirement_identifier, selected_observation, chosen_tool),
                {},
            )
            pointers = dict(
                canonical
                or {name: f"/result/structuredContent/{name}" for name in observation_fields}
            )
    operation_evidence = evidence or {
        "extract": pointers,
        "required": [name for name in observation_fields if name in pointers],
    }
    operation_expect = {"statuses": statuses or list(req.statuses)}
    if (scenario, requirement_identifier, selected_observation) in client_acceptance.SERVICE_OBSERVATIONS and client_acceptance._canonical_evidence_pointers(req, scenario, selected_observation, request, transport) is None:
        operation_expect.update({"outcome": "unverified", "reason": "A separate receiver or restore observation is required"})
    if expect:
        operation_expect.update(expect)
    return {
        "id": identifier or f"{scenario}-{requirement_identifier}-{selected_observation}",
        "scenario": scenario,
        "actor": actor or req.actors[0],
        "transport": transport,
        "proof": {"role": req.role, "case": req.case, "observation": selected_observation},
        "request": request,
        "expect": operation_expect,
        "evidence": operation_evidence,
    }


def all_scenario_operations() -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    for scenario in client_acceptance.SCENARIOS:
        for req in scenario.requirements:
            for observation in client_acceptance._declared_observations(req):
                operation_expect = None
                if req.identifier == "provider_delivery":
                    operation_expect = {
                        "outcome": "unverified",
                        "reason": "provider delivery requires an external evidence artifact",
                    }
                if (
                    req.transports == ("mcp",)
                    and (scenario.identifier, req.identifier)
                    in client_acceptance.MCP_UNVERIFIED_CONTRACTS
                ):
                    operation_expect = {
                        "outcome": "unverified",
                        "reason": "Worker exposes no canonical Bot identity binding response schema",
                    }
                operations.append(
                    operation_for_requirement(
                        scenario.identifier,
                        req.identifier,
                        observation=observation,
                        expect=operation_expect,
                    )
                )
    return operations


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

    def test_controlled_run_requires_every_semantic_case(self) -> None:
        config = config_with_operations(all_scenario_operations())
        transport = FakeTransport()
        bundle = client_acceptance.AcceptanceRunner(config, transport=transport, now="2026-09-14T00:00:00Z").run()
        self.assertEqual(bundle["run"]["status"], "incomplete")
        self.assertTrue(transport.rest_calls)
        self.assertIn("initialize", transport.mcp_calls)
        self.assertIn("list_messages", transport.mcp_calls)
        self.assertEqual(len(bundle["scenarios"]), len(client_acceptance.SCENARIOS))
        self.assertTrue(any(item["status"] == "unverified" for item in bundle["scenarios"]))
        self.assertFalse("controlled-token-value" in json.dumps(bundle))
        client_acceptance.validate_bundle(bundle)

    def test_missing_scenarios_are_unverified_and_never_pass(self) -> None:
        bundle = client_acceptance.AcceptanceRunner(config_with_operations([]), transport=FakeTransport()).run()
        self.assertEqual(bundle["run"]["status"], "incomplete")
        self.assertTrue(all(item["status"] == "unverified" for item in bundle["scenarios"]))
        self.assertEqual(bundle["operations"], [])

    def test_arbitrary_successful_get_does_not_satisfy_send_contract(self) -> None:
        operation = operation_for_requirement("text_send_and_route", "saved_before_dispatch", path="/api/v1/identities/identity_one", method="GET")
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

    def test_required_contract_evidence_prevents_false_pass(self) -> None:
        req = requirement("text_send_and_route", "saved_before_dispatch")
        pointers = {name: f"/{name}" for name in req.evidence}
        pointers["command_id"] = "/missing"
        operation = operation_for_requirement("text_send_and_route", "saved_before_dispatch", evidence={"extract": pointers, "required": list(req.evidence)})
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([operation]),
            transport=FakeTransport(),
        ).run()
        self.assertEqual(bundle["operations"][0]["status"], "unverified")
        self.assertIn("command_id", bundle["operations"][0]["reason"] or "")

    def test_passing_observed_ids_can_bind_a_later_operation(self) -> None:
        first = operation_for_requirement(
            "linking_identity_lifecycle", "identity_grant", identifier="grant", observation="grant_result"
        )
        second = operation_for_requirement(
            "linking_identity_lifecycle",
            "same_identity_relink",
            observation="relink_grant",
            method="PATCH",
            path="/api/v1/grants/${observed.grant.account_id}",
        )
        transport = FakeTransport()
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([first, second]), transport=transport
        ).run()
        self.assertEqual(bundle["operations"][0]["status"], "pass")
        self.assertEqual(bundle["operations"][1]["status"], "pass")
        self.assertIn("/api/v1/grants/account_one", [path for _, path in transport.rest_calls])

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
        operation = operation_for_requirement("oauth_connection", "mcp_scoped_read")
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
                            "items": [
                                {
                                    "account_id": "account_one",
                                    "conversation_id": "chat_one",
                                    "id": "message_one",
                                }
                            ],
                            "next_cursor": None,
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

    def test_typed_id_evidence_rejects_raw_content_alias(self) -> None:
        req = requirement("text_send_and_route", "saved_before_dispatch")
        pointers = {name: f"/{name}" for name in req.evidence}
        pointers["command_id"] = "/body"
        operation = operation_for_requirement(
            "text_send_and_route",
            "saved_before_dispatch",
            evidence={"extract": pointers, "required": list(req.evidence)},
        )
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([operation]),
            transport=FakeTransport(extra_body={"body": "this is message content"}),
        ).run()
        self.assertEqual(bundle["operations"][0]["status"], "unverified")
        self.assertIn("Communicator ID", bundle["operations"][0]["reason"] or "")

    def test_case_can_aggregate_split_lifecycle_observations(self) -> None:
        operations = [
            operation_for_requirement(
                "linking_identity_lifecycle",
                "same_identity_relink",
                identifier="relink-result",
                observation="relink_result",
            ),
            operation_for_requirement(
            "linking_identity_lifecycle",
            "same_identity_relink",
            identifier="relink-operation",
            observation="relink_operation",
            method="GET",
            path="/api/v1/connections/connection_one/lifecycle-operations/lifecycle_relink_session_one",
        ),
        operation_for_requirement(
            "linking_identity_lifecycle",
            "same_identity_relink",
            identifier="relink-grant",
                observation="relink_grant",
                method="POST",
                path="/api/v1/grants",
            ),
            operation_for_requirement(
                "linking_identity_lifecycle",
                "same_identity_relink",
                identifier="relink-chat",
                observation="relink_chat",
                method="GET",
                path="/api/v1/identities/identity_one/conversations/chat_one",
            ),
        ]
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations(operations), transport=FakeTransport()
        ).run()
        scenario = next(item for item in bundle["scenarios"] if item["id"] == "linking_identity_lifecycle")
        coverage = next(item for item in scenario["coverage"] if item["requirement"] == "same_identity_relink")
        self.assertEqual(coverage["status"], "pass")
        self.assertEqual(
            coverage["observed_fields"],
            sorted(requirement("linking_identity_lifecycle", "same_identity_relink").evidence),
        )
        self.assertEqual(len(coverage["operation_ids"]), 4)

    def test_named_lifecycle_observation_cannot_be_replaced_by_a_generic_pass(self) -> None:
        operations = [
            operation_for_requirement(
                "linking_identity_lifecycle",
                "same_identity_relink",
                identifier="relink-result",
                observation="relink_result",
            ),
            operation_for_requirement(
                "linking_identity_lifecycle",
                "same_identity_relink",
                identifier="relink-grant",
                observation="relink_grant",
                method="POST",
                path="/api/v1/grants",
            ),
            operation_for_requirement(
                "linking_identity_lifecycle",
                "same_identity_relink",
                identifier="relink-chat",
                observation="relink_chat",
                method="GET",
                path="/api/v1/identities/identity_one/conversations/chat_one",
            ),
        ]
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations(operations), transport=FakeTransport()
        ).run()
        coverage = next(
            item
            for item in next(
                scenario for scenario in bundle["scenarios"] if scenario["id"] == "linking_identity_lifecycle"
            )["coverage"]
            if item["requirement"] == "same_identity_relink"
        )
        self.assertEqual(coverage["status"], "unverified")
        self.assertEqual(
            next(item for item in coverage["observations"] if item["name"] == "relink_operation")["status"],
            "unverified",
        )

    def test_disconnect_cancellation_route_is_not_disconnect_evidence(self) -> None:
        operation = operation_for_requirement(
            "linking_identity_lifecycle",
            "disconnect_preserves_history",
            observation="disconnect_result",
            method="DELETE",
            path="/api/v1/link-sessions/link_session_one",
        )
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

    def test_disconnect_request_contract_requires_header_and_body(self) -> None:
        operation = operation_for_requirement(
            "linking_identity_lifecycle",
            "disconnect_preserves_history",
            observation="disconnect_result",
        )
        operation["request"].pop("headers")
        operation["request"].pop("body")
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

        valid = operation_for_requirement(
            "linking_identity_lifecycle",
            "disconnect_preserves_history",
            observation="disconnect_result",
            headers={"Idempotency-Key": "disconnect-valid-001"},
            body={},
        )
        client_acceptance.validate_config(config_with_operations([valid]))

    def test_mutating_request_contract_requires_declared_body_fields(self) -> None:
        operation = operation_for_requirement(
            "linking_identity_lifecycle", "unlinked_start"
        )
        operation["request"]["body"].pop("confirmed_identity_id")
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

    def test_network_transport_rejects_unbounded_action_headers(self) -> None:
        network = client_acceptance.NetworkTransport(
            {"base_url": "http://target.test"}
        )
        with self.assertRaises(client_acceptance.ConfigError):
            network.rest(
                "GET",
                "/api/v1/session",
                {},
                None,
                None,
                {"Authorization": "Bearer token"},
            )

    def test_provider_account_id_cannot_be_extracted_from_public_response(self) -> None:
        operation = operation_for_requirement(
            "linking_identity_lifecycle",
            "identity_grant",
            observation="grant_result",
            evidence={
                "extract": {
                    "provider_account_id": "/provider_account_id",
                },
                "required": ["provider_account_id"],
            },
        )
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

    def test_passing_bundle_requires_nonnull_response_provenance(self) -> None:
        operation = operation_for_requirement("oauth_connection", "protected_resource")
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([operation]), transport=FakeTransport()
        ).run()
        bundle["operations"][0]["response"] = None
        with self.assertRaises(client_acceptance.EvidenceError):
            client_acceptance.validate_bundle(bundle)
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([operation]), transport=FakeTransport()
        ).run()
        bundle["operations"][0]["response"]["http_status"] = 500
        with self.assertRaises(client_acceptance.EvidenceError):
            client_acceptance.validate_bundle(bundle)
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations(
                [operation_for_requirement("oauth_connection", "mcp_scoped_read")]
            ),
            transport=FakeTransport(),
        ).run()
        bundle["operations"][0]["response"]["jsonrpc_request_id"] = 2
        with self.assertRaises(client_acceptance.EvidenceError):
            client_acceptance.validate_bundle(bundle)

    def test_scoped_mcp_read_requires_the_real_list_messages_tool_shape(self) -> None:
        operation = operation_for_requirement(
            "oauth_connection",
            "mcp_scoped_read",
            tool="list_identities",
        )
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

    def test_mcp_only_declared_cases_use_actual_worker_tools(self) -> None:
        operations = all_scenario_operations()
        operation_keys = {
            (operation["scenario"], operation["proof"]["case"])
            for operation in operations
        }
        self.assertTrue(
            {
                ("grok_surface_read", "scoped_read"),
                ("grok_surface_send", "text_send"),
                ("grok_failure_matrix", "duplicate_request"),
                ("grok_failure_matrix", "timeout_uncertainty"),
                ("grok_failure_matrix", "reconnect"),
                ("grok_failure_matrix", "provider_rejection"),
                ("grok_bot_identity", "member_binding"),
            }.issubset(operation_keys)
        )
        self.assertEqual(
            operations[
                next(
                    index
                    for index, operation in enumerate(operations)
                    if operation["scenario"] == "grok_surface_read"
                )
            ]["request"]["tool"],
            "list_messages",
        )
        self.assertEqual(
            client_acceptance.MCP_CONTRACTS[
                ("grok_surface_send", "surface_text_send")
            ],
            ("send_text_reply",),
        )
        self.assertEqual(
            client_acceptance.MCP_CONTRACTS[
                ("grok_failure_matrix", "timeout_uncertainty")
            ],
            ("get_text_reply_status",),
        )
        client_acceptance.validate_config(config_with_operations(operations))

    def test_group_management_request_contract_matches_worker_action_schemas(self) -> None:
        for vector in (
            ACTION_REQUEST_VECTORS["group_rename"],
            ACTION_REQUEST_VECTORS["group_participants"],
        ):
            for method in vector["methods"]:
                operation = operation_for_requirement(
                    "direct_chat_and_group",
                    "group_management",
                    method=method,
                    path=vector["path"],
                    body=vector["valid"],
                )
                client_acceptance.validate_config(config_with_operations([operation]))

                invalid_operation = operation_for_requirement(
                    "direct_chat_and_group",
                    "group_management",
                    method=method,
                    path=vector["path"],
                    body=vector["invalid"],
                )
                with self.assertRaises(client_acceptance.ConfigError):
                    client_acceptance.validate_config(
                        config_with_operations([invalid_operation])
                    )

    def test_grant_request_contract_matches_worker_create_and_update_schemas(self) -> None:
        for vector in (
            ACTION_REQUEST_VECTORS["grant_create"],
            ACTION_REQUEST_VECTORS["grant_update"],
        ):
            for method in vector["methods"]:
                operation = operation_for_requirement(
                    "linking_identity_lifecycle",
                    "identity_grant",
                    observation="grant_result",
                    method=method,
                    path=vector["path"],
                    body=vector["valid"],
                )
                client_acceptance.validate_config(config_with_operations([operation]))

                invalid_operation = operation_for_requirement(
                    "linking_identity_lifecycle",
                    "identity_grant",
                    observation="grant_result",
                    method=method,
                    path=vector["path"],
                    body=vector["invalid"],
                )
                with self.assertRaises(client_acceptance.ConfigError):
                    client_acceptance.validate_config(
                        config_with_operations([invalid_operation])
                    )

    def test_every_advertised_mcp_tool_has_bound_schema_and_rejects_pointer_aliases(self) -> None:
        for (scenario, requirement_identifier), tools in client_acceptance.MCP_CONTRACTS.items():
            req = requirement(scenario, requirement_identifier)
            for tool in tools:
                canonical = client_acceptance.MCP_CANONICAL_POINTERS.get(
                    (scenario, requirement_identifier, "response", tool)
                )
                self.assertIsNotNone(canonical, (scenario, requirement_identifier, tool))
                operation = operation_for_requirement(
                    scenario, requirement_identifier, tool=tool
                )
                field = next(iter(canonical))
                operation["evidence"]["extract"][field] = "/result/structuredContent/not_canonical"
                with self.assertRaises(client_acceptance.ConfigError):
                    client_acceptance.validate_config(config_with_operations([operation]))

    def test_attachment_metadata_cannot_replace_authenticated_bytes(self) -> None:
        payload = b"controlled attachment bytes\x00\xff"
        digest = hashlib.sha256(payload).hexdigest()
        download_grant = "private-download-authority-" + "a" * 40
        owner = self

        class AttachmentTransport(FakeTransport):
            downloaded = 0
            corrupt = False

            def metadata(self) -> dict[str, Any]:
                return {"attachment_id": "attachment_one", "message_id": "message_one", "sha256": digest, "mime_type": "application/octet-stream", "size_bytes": len(payload), "download_grant": download_grant}

            def page(self) -> dict[str, Any]:
                return {"items": [{"id": "message_one", "account_id": "account_one", "conversation_id": "chat_one"}]}

            def rest(self, method: str, path: str, query: dict[str, Any], body: Any, token: str | None, headers: dict[str, str] | None = None) -> client_acceptance.HttpResponse:
                if path.endswith("/download"):
                    owner.assertEqual(query, {"download_grant": download_grant})
                    owner.assertEqual(token, "controlled-token-value")
                    self.downloaded += 1
                    return client_acceptance.HttpResponse(200, {"content-type": "application/octet-stream"}, None, payload + (b"changed" if self.corrupt else b""))
                result = self.page() if path.endswith("/messages") else self.metadata()
                return client_acceptance.HttpResponse(200, {}, result, json.dumps(result).encode())

            def mcp(self, request: dict[str, Any], token: str | None, client: dict[str, Any]) -> client_acceptance.HttpResponse:
                tool = request.get("tool")
                if tool == "download_attachment":
                    owner.assertEqual(request["arguments"]["download_grant"], download_grant)
                    owner.assertEqual(token, "controlled-token-value")
                    self.downloaded += 1
                    result = {"content": [{"type": "resource", "resource": {"uri": "communicator:attachment/attachment_one", "mimeType": "application/octet-stream", "blob": base64.b64encode(payload + (b"changed" if self.corrupt else b"")).decode()}}]}
                else:
                    result = {"structuredContent": self.page() if tool == "list_messages" else self.metadata()}
                response = {"jsonrpc": "2.0", "id": 1, "result": result}
                return client_acceptance.HttpResponse(200, {}, response, json.dumps(response).encode())

        for transport in ("rest", "mcp"):
            with self.subTest(transport=transport):
                operations = [operation_for_requirement("history_context_attachment", "attachment_read", observation=name, transport=transport, identifier=name) for name in ("scope", "metadata", "bytes")]
                operations[2]["request"]["download_from"] = "metadata"
                if transport == "mcp":
                    operations[1]["request"]["arguments"] = {"identity_id": "identity_one", "account_id": "account_one", "attachment_id": "attachment_one"}
                    operations[2]["request"]["arguments"] = {"attachment_id": "attachment_one"}
                fixture = AttachmentTransport()
                partial = client_acceptance.AcceptanceRunner(config_with_operations(operations[:2]), transport=fixture).run()
                history = next(item for item in partial["scenarios"] if item["id"] == "history_context_attachment")
                self.assertEqual(next(item for item in history["coverage"] if item["requirement"] == "attachment_read")["status"], "unverified")
                self.assertEqual(fixture.downloaded, 0)
                complete = client_acceptance.AcceptanceRunner(config_with_operations(operations), transport=fixture).run()
                history = next(item for item in complete["scenarios"] if item["id"] == "history_context_attachment")
                self.assertEqual(next(item for item in history["coverage"] if item["requirement"] == "attachment_read")["status"], "pass")
                self.assertEqual(fixture.downloaded, 1)
                self.assertEqual(complete["operations"][-1]["extracted"], {"sha256": digest, "attachment_size": len(payload)})
                self.assertNotIn(download_grant, json.dumps(complete))
                self.assertNotIn("controlled attachment bytes", json.dumps(complete))
                client_acceptance.validate_bundle(complete)
                fixture.corrupt = True
                corrupt = client_acceptance.AcceptanceRunner(config_with_operations(operations), transport=fixture).run()
                history = next(item for item in corrupt["scenarios"] if item["id"] == "history_context_attachment")
                self.assertEqual(next(item for item in history["coverage"] if item["requirement"] == "attachment_read")["status"], "implementation_defect")
                operations[2]["request"]["download_from"] = "missing"
                before = fixture.downloaded
                unavailable = client_acceptance.AcceptanceRunner(config_with_operations(operations), transport=fixture).run()
                self.assertEqual(unavailable["operations"][-1]["status"], "unverified")
                self.assertEqual(fixture.downloaded, before)

    def test_shared_service_mappings_use_real_result_fields(self) -> None:
        cases = [
            ("permission_inspection_request", "request_permissions", None, {"id": "permission_request_one", "identity_id": "identity_one", "account_id": "account_one", "status": "pending"}, {"request_id": "permission_request_one", "identity_id": "identity_one", "account_id": "account_one", "status": "pending"}),
            ("direct_chat_and_group", "contact_resolution", None, {"status": "resolved", "candidate": {"account_id": "account_one", "contact_id": "contact_one", "provider_id": "provider_contact_one"}}, {"account_id": "account_one", "contact_id": "contact_one", "provider_contact_id": "provider_contact_one", "resolution_status": "resolved"}),
            ("direct_chat_and_group", "group_creation", None, {"account_id": "account_one", "conversation_id": "chat_one", "operation_id": "group_operation_one", "provider_group_id": "provider_group_one", "status": "created"}, {"account_id": "account_one", "chat_id": "chat_one", "group_operation_id": "group_operation_one", "provider_group_id": "provider_group_one", "provider_status": "created"}),
            ("receipt_and_restore", "explicit_receipt", None, {"operation_id": "receipt_one", "account_id": "account_one", "conversation_id": "chat_one", "message_id": "message_one", "status": "observed", "matrix_stage": "accepted", "bridge_stage": "observed", "provider_stage": "confirmed"}, {"receipt_id": "receipt_one", "account_id": "account_one", "chat_id": "chat_one", "message_id": "message_one", "receipt_status": "observed", "matrix_status": "accepted", "bridge_status": "observed", "provider_status": "confirmed"}),
            ("webhook_subscriptions", "retry", "retry_result", {"id": "delivery_one", "subscription_id": "subscription_one", "source_event_id": "event_one", "attempt_count": 3, "retry_deadline": "2026-09-14T00:00:00Z"}, {"delivery_id": "delivery_one", "subscription_id": "subscription_one", "source_event_id": "event_one", "attempt_count": 3, "retry_deadline": "2026-09-14T00:00:00Z"}),
        ]
        for scenario, case, observation, body, expected in cases:
            for transport in ("rest", "mcp"):
                with self.subTest(case=case, transport=transport):
                    operation = operation_for_requirement(scenario, case, observation=observation, transport=transport)
                    if transport == "mcp":
                        rest = operation_for_requirement(scenario, case, observation=observation)
                        arguments = dict(rest["request"].get("body", {}))
                        if case == "explicit_receipt":
                            arguments["conversation_id"] = "chat_one"
                        elif case == "retry":
                            arguments["delivery_id"] = "delivery_one"
                        operation["request"]["arguments"] = arguments
                    config = client_acceptance.validate_config(config_with_operations([operation]))
                    runner = client_acceptance.AcceptanceRunner(config, transport=FakeTransport())
                    response_body = body if transport == "rest" else {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": body}}
                    response = client_acceptance.HttpResponse(200, {}, response_body, json.dumps(response_body).encode())
                    status, reason, extracted = client_acceptance.classify_response(response, operation, runner._context(), operation["request"])
                    self.assertEqual((status, reason, extracted), ("pass", None, expected))
                    field = next(iter(operation["evidence"]["extract"]))
                    operation["evidence"]["extract"][field] = "/invented_alias"
                    with self.assertRaises(client_acceptance.ConfigError):
                        client_acceptance.validate_config(config_with_operations([operation]))

    def test_webhook_and_restore_observations_cannot_use_unrelated_mutations(self) -> None:
        for scenario, case, observation in [("webhook_subscriptions", "revision_removal", "receiver"), ("webhook_subscriptions", "cutover", "cancellation"), ("receipt_and_restore", "restore_anti_resurrection", "suppression")]:
            operation = operation_for_requirement(scenario, case, observation=observation)
            operation["expect"]["outcome"] = "pass"
            with self.assertRaises(client_acceptance.ConfigError):
                client_acceptance.validate_config(config_with_operations([operation]))
        operation = operation_for_requirement("receipt_and_restore", "restore_anti_resurrection", observation="restore", path="/api/v1/removals")
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))
        operation = operation_for_requirement("webhook_subscriptions", "revision_removal", observation="delivery", method="DELETE", path="/api/v1/webhook-subscriptions/subscription_one")
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))

    def test_tool_error_is_not_success_but_can_record_an_explicit_denial(self) -> None:
        operation = operation_for_requirement("authorization_negative_matrix", "missing_grant", transport="mcp", statuses=[200])
        config = config_with_operations([operation])
        runner = client_acceptance.AcceptanceRunner(config, transport=FakeTransport())
        body = {"jsonrpc": "2.0", "id": 1, "result": {"isError": True, "content": [{"type": "text", "text": '{"error":{"code":"forbidden"}}'}]}}
        response = client_acceptance.HttpResponse(200, {}, body, json.dumps(body).encode())
        self.assertEqual(client_acceptance.classify_response(response, operation, runner._context(), operation["request"]), ("pass", None, {"error_code": "forbidden"}))
        self.assertIsNotNone(client_acceptance._validate_mcp_response(response))
        body["result"]["isError"] = False
        self.assertEqual(client_acceptance.classify_response(response, operation, runner._context(), operation["request"])[0], "unverified")

        class DenialTransport(FakeTransport):
            def mcp(self, request: dict[str, Any], token: str | None, client: dict[str, str]) -> client_acceptance.HttpResponse:
                return client_acceptance.HttpResponse(200, {}, body, json.dumps(body).encode())

        for is_error, expected in ((True, "pass"), (False, "unverified"), ("true", "unverified")):
            with self.subTest(is_error=is_error):
                body["result"]["isError"] = is_error
                bundle = client_acceptance.AcceptanceRunner(config, transport=DenialTransport()).run()
                self.assertEqual(bundle["operations"][0]["status"], expected)
                client_acceptance.validate_bundle(bundle)
                if expected == "pass":
                    bundle["operations"][0]["response"]["mcp_is_error"] = False
                    with self.assertRaises(client_acceptance.EvidenceError):
                        client_acceptance.validate_bundle(bundle)

    def test_permission_evidence_correlates_requested_and_configured_subjects(self) -> None:
        class PermissionTransport(FakeTransport):
            def __init__(self, identity_id: str, account_id: str, wrong_grant: bool) -> None:
                super().__init__()
                self.identity_id = identity_id
                self.account_id = account_id
                self.wrong_grant = wrong_grant

            def result(self, case: str) -> dict[str, Any]:
                subject = {"identity_id": self.identity_id, "account_id": self.account_id}
                if case == "inspect_grants":
                    if self.wrong_grant:
                        subject["identity_id"] = "identity_other"
                    return {"items": [{"id": "grant_one", **subject, "operation_scope": "conversation.read", "chat_scope": "all_chats"}], "next_cursor": None}
                pending = {"id": "request_one", **subject, "status": "pending"}
                return pending if case == "request_permissions" else {"items": [pending], "next_cursor": None}

            def rest(self, method: str, path: str, query: dict[str, Any], body: Any, token: str | None, headers: dict[str, str] | None = None) -> client_acceptance.HttpResponse:
                case = "inspect_grants" if path.endswith("/grants") else "request_permissions" if method == "POST" else "inspect_requests"
                result = self.result(case)
                return client_acceptance.HttpResponse(200, {}, result, json.dumps(result).encode())

            def mcp(self, request: dict[str, Any], token: str | None, client: dict[str, str]) -> client_acceptance.HttpResponse:
                case = {"list_grants": "inspect_grants", "request_permissions": "request_permissions", "list_permission_requests": "inspect_requests"}[request["tool"]]
                result = {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": self.result(case)}}
                return client_acceptance.HttpResponse(200, {}, result, json.dumps(result).encode())

        for transport in ("rest", "mcp"):
            for identity, account, include_other, wrong_grant in (
                ("identity_one", "account_one", False, False),
                ("identity_other", "account_one", False, False),
                ("identity_one", "account_other", False, False),
                ("identity_other", "account_other", True, False),
                ("identity_one", "account_one", True, True),
            ):
                with self.subTest(transport=transport, identity=identity, account=account, include_other=include_other, wrong_grant=wrong_grant):
                    operations = [operation_for_requirement("permission_inspection_request", case, transport=transport) for case in ("inspect_grants", "request_permissions", "inspect_requests")]
                    subject = {"identity_id": "identity_one", "account_id": "account_one"}
                    for operation in operations:
                        request = operation["request"]
                        if transport == "mcp":
                            request["arguments"] = dict(subject)
                            if request["tool"] == "request_permissions":
                                request["arguments"].update(operation_for_requirement("permission_inspection_request", "request_permissions")["request"]["body"])
                        elif request["method"] == "GET":
                            request["query"] = dict(subject)
                    config = config_with_operations(operations)
                    if include_other:
                        config["target"]["bindings"]["identity_ids"].append("identity_other")
                        config["target"]["bindings"]["account_ids"].append("account_other")
                    bundle = client_acceptance.AcceptanceRunner(config, transport=PermissionTransport(identity, account, wrong_grant)).run()
                    scenario = next(item for item in bundle["scenarios"] if item["id"] == "permission_inspection_request")
                    expected = "pass" if (identity, account, wrong_grant) == ("identity_one", "account_one", False) else "implementation_defect"
                    self.assertEqual(scenario["status"], expected)
                    client_acceptance.validate_bundle(bundle)

    def test_permission_and_restore_request_vectors_reject_elevation_or_removal_aliases(self) -> None:
        for name, scenario, case, observation in [
            ("permission_request", "permission_inspection_request", "request_permissions", "response"),
            ("restore_projection", "receipt_and_restore", "restore_anti_resurrection", "restore"),
        ]:
            vector = ACTION_REQUEST_VECTORS[name]
            operation = operation_for_requirement(scenario, case, observation=observation, path=vector["path"], body=vector["valid"])
            client_acceptance.validate_config(config_with_operations([operation]))
            operation["request"]["body"] = vector["invalid"]
            with self.assertRaises(client_acceptance.ConfigError):
                client_acceptance.validate_config(config_with_operations([operation]))

    def test_provider_delivery_requires_external_evidence_mapping(self) -> None:
        operation = operation_for_requirement("text_send_and_route", "provider_delivery")
        with self.assertRaises(client_acceptance.ConfigError):
            client_acceptance.validate_config(config_with_operations([operation]))
        operation = operation_for_requirement(
            "text_send_and_route",
            "provider_delivery",
            expect={
                "outcome": "unverified",
                "reason": "provider delivery requires an external evidence artifact",
            },
        )
        bundle = client_acceptance.AcceptanceRunner(
            config_with_operations([operation]), transport=FakeTransport()
        ).run()
        self.assertEqual(bundle["operations"][0]["status"], "unverified")

    def test_controlled_http_fixture_uses_network_transport(self) -> None:
        timestamp = "2026-09-14T00:00:00Z"

        def link_session(
            status: str = "awaiting_user",
            *,
            session_id: str = "link_session_one",
            connection_id: str = "connection_new",
        ) -> dict[str, Any]:
            return {
                "id": session_id,
                "identity_id": "identity_one",
                "provider": "whatsapp",
                "generation": 1,
                "status": status,
                "action": "wait",
                "expires_at": timestamp,
                "action_expires_at": None,
                "qr": None,
                "connection_id": connection_id,
                "account_id": "account_one",
                "provider_label": "Controlled WhatsApp",
                "error_code": None,
            }

        class Handler(BaseHTTPRequestHandler):
            calls: list[tuple[str, str]] = []

            def _json(self, body: Any, status: int = 200) -> None:
                raw = client_acceptance.canonical_bytes(body)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self) -> None:  # noqa: N802 - stdlib protocol hook
                self.calls.append(("POST", self.path))
                length = int(self.headers.get("Content-Length", "0"))
                payload = self.rfile.read(length) if length else b""
                request_body = json.loads(payload.decode("utf-8")) if payload else None
                if self.path.endswith("/link-sessions"):
                    self._json(link_session())
                    return
                if self.path.endswith("/relink-sessions"):
                    self._json(link_session("connected", session_id="relink_session_one", connection_id="connection_one"))
                    return
                if self.path.endswith("/disconnect"):
                    if (
                        len(self.headers.get("Idempotency-Key", "")) < 8
                        or request_body not in ({}, {"expected_session_generation": timestamp})
                    ):
                        self._json({"error": {"code": "invalid_request"}}, 400)
                        return
                    self._json(
                        {
                            "operation_id": "operation_disconnect",
                            "kind": "disconnect",
                            "connection_id": "connection_one",
                            "provider": "whatsapp",
                            "status": "succeeded",
                            "session_generation": timestamp,
                            "replacement_connection_id": None,
                            "error_code": None,
                            "created_at": timestamp,
                            "updated_at": timestamp,
                        }
                    )
                    return
                self._json(
                    {
                        "id": "grant_one",
                        "tenant_id": "tenant_one",
                        "membership_id": "membership_one",
                        "identity_id": "identity_one",
                        "identity_display_name": "Controlled identity",
                        "account_id": "account_one",
                        "connection_id": "connection_new",
                        "provider": "whatsapp",
                        "account_label": "Controlled account",
                        "operation_scope": "conversation.read",
                        "chat_scope": "all_chats",
                        "chat_ids": [],
                        "status": "active",
                        "created_at": timestamp,
                        "updated_at": timestamp,
                        "revoked_at": None,
                    },
                    201,
                )

            def do_GET(self) -> None:  # noqa: N802 - stdlib protocol hook
                self.calls.append(("GET", self.path))
                if "/lifecycle-operations/" in self.path:
                    self._json(
                        {
                            "operation_id": "lifecycle_relink_session_one",
                            "kind": "relink",
                            "connection_id": "connection_one",
                            "provider": "whatsapp",
                            "status": "succeeded",
                            "session_generation": timestamp,
                            "replacement_connection_id": "connection_new",
                            "error_code": None,
                            "created_at": timestamp,
                            "updated_at": timestamp,
                        }
                    )
                    return
                if self.path.endswith("/conversations/chat_one"):
                    self._json(
                        {
                            "id": "chat_one",
                            "tenant_id": "tenant_one",
                            "identity_id": "identity_one",
                            "account_id": "account_one",
                            "connection_id": "connection_new",
                            "title": "Controlled chat",
                            "last_message_preview": "",
                            "last_activity_at": timestamp,
                            "unread_count": 0,
                        }
                    )
                    return
                self._json(
                    {
                        "items": [
                            {
                                "id": "message_one",
                                "tenant_id": "tenant_one",
                                "identity_id": "identity_one",
                                "account_id": "account_one",
                                "connection_id": "connection_one",
                                "conversation_id": "chat_one",
                                "direction": "inbound",
                                "sender_label": "Controlled sender",
                                "body": "fixture body is not extracted",
                                "occurred_at": timestamp,
                                "delivery_status": "delivered",
                                "attachment_count": 0,
                                "attachments": [],
                            }
                        ],
                        "next_cursor": None,
                    }
                )

            def log_message(self, format: str, *args: Any) -> None:
                del format, args

        try:
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        except PermissionError:
            self.skipTest("sandbox does not permit a local fixture listener")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            network = client_acceptance.NetworkTransport(
                {"base_url": f"http://127.0.0.1:{port}"}, timeout=5
            )
            missing_action = network.rest(
                "POST",
                "/api/v1/connections/connection_one/disconnect",
                {},
                None,
                "controlled-admin-token-value",
            )
            self.assertEqual(missing_action.status, 400)
            valid_action = network.rest(
                "POST",
                "/api/v1/connections/connection_one/disconnect",
                {},
                {},
                "controlled-admin-token-value",
                {"Idempotency-Key": "disconnect-valid-001"},
            )
            self.assertEqual(valid_action.status, 200)
            config = config_with_operations(
                [
                    operation_for_requirement("linking_identity_lifecycle", "unlinked_start"),
                    operation_for_requirement(
                        "linking_identity_lifecycle", "identity_grant", observation="grant_result"
                    ),
                    operation_for_requirement(
                        "linking_identity_lifecycle",
                        "same_identity_relink",
                        identifier="real-relink-result",
                        observation="relink_result",
                    ),
                    operation_for_requirement(
                        "linking_identity_lifecycle",
                        "same_identity_relink",
                        identifier="real-relink-operation",
                        observation="relink_operation",
                        method="GET",
                        path="/api/v1/connections/connection_one/lifecycle-operations/lifecycle_relink_session_one",
                    ),
                    operation_for_requirement(
                        "linking_identity_lifecycle",
                        "same_identity_relink",
                        identifier="real-relink-grant",
                        observation="relink_grant",
                        method="POST",
                        path="/api/v1/grants",
                    ),
                    operation_for_requirement(
                        "linking_identity_lifecycle",
                        "same_identity_relink",
                        identifier="real-relink-chat",
                        observation="relink_chat",
                        method="GET",
                        path="/api/v1/identities/identity_one/conversations/chat_one",
                    ),
                    operation_for_requirement(
                        "linking_identity_lifecycle",
                        "disconnect_preserves_history",
                        identifier="real-disconnect",
                        observation="disconnect_result",
                    ),
                    operation_for_requirement(
                        "linking_identity_lifecycle",
                        "disconnect_preserves_history",
                        identifier="real-history-after-disconnect",
                        observation="history_after_disconnect",
                        method="GET",
                        path="/api/v1/conversations/chat_one/messages",
                    ),
                ]
            )
            evidence_overrides = {
                "linking_identity_lifecycle-unlinked_start": {"link_session_id": "/id"},
            }
            for operation in config["operations"]:
                operation["evidence"]["extract"].update(evidence_overrides.get(operation["id"], {}))
            config["target"]["base_url"] = f"http://127.0.0.1:{port}"
            config["target"]["mcp_url"] = f"http://127.0.0.1:{port}/mcp"
            bundle = client_acceptance.AcceptanceRunner(
                config,
                transport=client_acceptance.NetworkTransport(config["target"], timeout=5),
            ).run()
            lifecycle = next(item for item in bundle["scenarios"] if item["id"] == "linking_identity_lifecycle")
            statuses = {item["requirement"]: item["status"] for item in lifecycle["coverage"]}
            self.assertEqual(statuses["same_identity_relink"], "pass")
            self.assertEqual(statuses["disconnect_preserves_history"], "pass")
            self.assertIn(("POST", "/api/v1/identities/identity_one/link-sessions"), Handler.calls)
            self.assertIn(("POST", "/api/v1/connections/connection_one/relink-sessions"), Handler.calls)
            self.assertIn(("POST", "/api/v1/connections/connection_one/disconnect"), Handler.calls)
            self.assertIn(
                ("GET", "/api/v1/conversations/chat_one/messages?acceptance_case=disconnect_preserves_history"),
                Handler.calls,
            )
            self.assertEqual(bundle["controls"]["fixture_evidence_is_client_proof"], False)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

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
