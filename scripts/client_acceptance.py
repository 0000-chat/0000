#!/usr/bin/env python3
"""Run generic REST/MCP client acceptance and write secret-free evidence."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol


SCHEMA_VERSION = 1
MCP_PROTOCOL_VERSION = "2025-11-25"
RUN_MODES = {"live_client", "controlled"}
EVIDENCE_STATUSES = {
    "pass",
    "unsupported",
    "unverified",
    "implementation_defect",
}
SENSITIVE_KEY = re.compile(
    r"(?:access.?token|bearer|client.?secret|cookie|password|refresh.?token|secret|api.?key|credential|private.?key)",
    re.IGNORECASE,
)
PLACEHOLDER = re.compile(
    r"(?:\.invalid(?:/|$)|\.example(?:/|$)|replace-with|your[-_]|<[^>]+>)",
    re.IGNORECASE,
)
JWT_SHAPE = re.compile(r"^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$")
CONTENT_FIELD = re.compile(r"^(?:body|text|content|payload|bytes)$|(?:^|_)(?:body|text|payload|bytes)$", re.IGNORECASE)
TEMPLATE = re.compile(r"\$\{([^}]+)\}")
SCALAR_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
COMMUNICATOR_ID = re.compile(r"^[a-z]+_[a-z0-9_]+$")
HEX_DIGEST = re.compile(r"^[0-9a-fA-F]{32,128}$")
ISO_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
MIME_TYPE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$", re.IGNORECASE)


EVIDENCE_FIELD_KINDS: dict[str, str] = {
    "resource": "url",
    "authorization_server": "url",
    "issuer": "url",
    "authorization_endpoint": "url",
    "token_endpoint": "url",
    "pkce_s256": "bool",
    "stale_work_rejected": "bool",
    "second_request_reused": "bool",
    "chat_paused": "bool",
    "age_preserved": "bool",
    "grant_count": "count",
    "history_message_count": "count",
    "attempt_count": "count",
    "cancelled_pending_count": "count",
    "content_generation": "count",
    "deletion_epoch": "count",
    "saved_at": "timestamp",
    "retry_deadline": "timestamp",
    "sha256": "digest",
    "member_ids_digest": "digest",
    "mime_type": "mime",
    "protocol_version": "version",
    "server_version": "version",
    "client_version": "version",
    "provider_version": "version",
    "destination_version": "version",
    "old_destination_version": "version",
    "new_destination_version": "version",
    "revision": "version",
    "group_revision": "version",
    "retained_revision": "version",
    "evidence_class": "evidence_class",
}
EVIDENCE_FIELD_KINDS.update(
    {
        name: "id"
        for name in (
            "account_id",
            "chat_id",
            "message_id",
            "identity_id",
            "link_session_id",
            "grant_id",
            "connection_id",
            "disconnect_operation_id",
            "previous_connection_id",
            "new_connection_id",
            "history_message_id",
            "attachment_id",
            "download_grant",
            "command_id",
            "dispatch_id",
            "provider_message_id",
            "requested_account_id",
            "resolved_account_id",
            "contact_id",
            "provider_contact_id",
            "provider_chat_id",
            "group_operation_id",
            "provider_group_id",
            "subscription_id",
            "delivery_id",
            "source_event_id",
            "receiver_id",
            "removal_event_id",
            "manual_retry_actor",
            "receipt_id",
            "removal_id",
            "restore_id",
            "retained_message_id",
            "installation_id",
            "member_id",
            "idempotency_key",
        )
    }
)
EVIDENCE_FIELD_KINDS.update(
    {
        name: "token"
        for name in (
            "status",
            "disconnect_status",
            "history_range_status",
            "saved_status",
            "matrix_status",
            "bridge_status",
            "provider_status",
            "error_code",
            "resolution_status",
            "delivery_status",
            "content_status",
            "requested_status",
            "observed_status",
            "result_class",
            "active_read_status",
            "attachment_status",
            "resource_metadata",
            "support_status",
            "dispatch_status",
            "ownership_scope",
            "actor_binding",
            "duplicate_status",
            "uncertainty_status",
            "reconnect_status",
            "confirmation_status",
            "surface",
        )
    }
)
EVIDENCE_FIELD_KINDS["surface"] = "label"
EVIDENCE_FIELD_KINDS["server_name"] = "label"


def _is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return normalized in {"authorization", "token", "secret", "password", "cookie"} or bool(
        SENSITIVE_KEY.search(normalized)
    )


class ConfigError(ValueError):
    """Raised when a run configuration cannot produce trustworthy evidence."""


class EvidenceError(ValueError):
    """Raised when an evidence bundle violates the evidence contract."""


@dataclass(frozen=True)
class Requirement:
    identifier: str
    role: str
    case: str
    evidence: tuple[str, ...] = ()
    transports: tuple[str, ...] = ("rest", "mcp")
    actors: tuple[str, ...] = ("agent", "admin", "none")
    statuses: tuple[int, ...] = ()
    bindings: tuple[str, ...] = ()
    expected: tuple[tuple[str, Any], ...] = ()
    rest_methods: tuple[str, ...] = ()
    path_fragments: tuple[str, ...] = ()
    mcp_tools: tuple[str, ...] = ()
    observations: tuple[tuple[str, tuple[str, ...]], ...] = ()


@dataclass(frozen=True)
class Relation:
    kind: str
    left: str
    right: str
    fields: tuple[str, ...]


@dataclass(frozen=True)
class Scenario:
    identifier: str
    tickets: tuple[str, ...]
    title: str
    requirements: tuple[Requirement, ...]
    relations: tuple[Relation, ...] = ()


@dataclass(frozen=True)
class RestRequestContract:
    """Request requirements for one configured REST action."""

    required_headers: tuple[str, ...] = ()
    body_required: bool = False
    body_keys: frozenset[str] | None = None
    required_body_keys: frozenset[str] = frozenset()
    idempotency_key_min_length: int = 1


def _requirement(
    identifier: str,
    role: str,
    case: str,
    evidence: tuple[str, ...],
    *,
    transports: tuple[str, ...] = ("rest", "mcp"),
    actor: str | None = None,
    statuses: tuple[int, ...] = (),
    bindings: tuple[str, ...] = (),
    expected: tuple[tuple[str, Any], ...] = (),
    rest_methods: tuple[str, ...] = (),
    path_fragments: tuple[str, ...] = (),
    mcp_tools: tuple[str, ...] = (),
    observations: tuple[tuple[str, tuple[str, ...]], ...] = (),
) -> Requirement:
    actors = (actor,) if actor is not None else ("agent", "admin", "none")
    return Requirement(
        identifier,
        role,
        case,
        evidence,
        transports,
        actors,
        statuses,
        bindings,
        expected,
        rest_methods,
        path_fragments,
        mcp_tools,
        observations,
    )


def _relation(kind: str, left: str, right: str, *fields: str) -> Relation:
    return Relation(kind, left, right, fields)


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "oauth_connection",
        ("#35", "#36"),
        "OAuth and MCP connection with resource binding",
        (
            _requirement(
                "protected_resource",
                "oauth_metadata",
                "protected_resource",
                ("resource", "authorization_server"),
                transports=("rest",),
                actor="none",
                statuses=(200,),
            ),
            _requirement(
                "authorization_server",
                "oauth_metadata",
                "authorization_server",
                (
                    "issuer",
                    "authorization_endpoint",
                    "token_endpoint",
                    "pkce_s256",
                ),
                transports=("rest",),
                actor="none",
                statuses=(200,),
            ),
            _requirement(
                "mcp_initialize",
                "mcp_session",
                "initialize",
                ("protocol_version", "server_name", "server_version"),
                transports=("mcp",),
                actor="agent",
                statuses=(200,),
                bindings=("resource", "installation_id"),
                expected=(("protocol_version", MCP_PROTOCOL_VERSION),),
            ),
            _requirement(
                "mcp_scoped_read",
                "mcp_session",
                "scoped_read",
                ("account_id", "chat_id", "message_id"),
                transports=("mcp",),
                actor="agent",
                statuses=(200,),
                bindings=("resource", "installation_id", "grant_ids", "account_ids", "chat_ids"),
            ),
        ),
    ),
    Scenario(
        "linking_identity_lifecycle",
        ("#35",),
        "Unlinked start, identity verification, relink, disconnect, and a different identity",
        (
            _requirement(
                "unlinked_start",
                "linking_lifecycle",
                "unlinked_start",
                ("identity_id", "link_session_id", "status"),
                transports=("rest",),
                actor="admin",
                statuses=(200, 201),
                bindings=("identity_ids",),
            ),
            _requirement(
                "identity_grant",
                "linking_lifecycle",
                "identity_grant",
                ("identity_id", "account_id", "grant_id"),
                transports=("rest",),
                actor="admin",
                statuses=(200, 201),
                bindings=("identity_ids", "account_ids", "grant_ids"),
                observations=(
                    ("grant_result", ("identity_id", "account_id", "grant_id")),
                ),
            ),
            _requirement(
                "same_identity_relink",
                "linking_lifecycle",
                "same_identity_relink",
                (
                    "identity_id",
                    "account_id",
                    "chat_id",
                    "grant_id",
                    "connection_id",
                    "link_session_id",
                    "previous_connection_id",
                    "new_connection_id",
                ),
                transports=("rest",),
                actor="admin",
                statuses=(200, 201),
                bindings=("identity_ids", "account_ids", "grant_ids", "chat_ids", "connection_ids"),
                observations=(
                    (
                        "relink_result",
                        ("identity_id", "account_id", "connection_id", "link_session_id"),
                    ),
                    ("relink_operation", ("previous_connection_id", "new_connection_id")),
                    ("relink_grant", ("identity_id", "account_id", "grant_id")),
                    ("relink_chat", ("identity_id", "account_id", "chat_id")),
                ),
            ),
            _requirement(
                "disconnect_preserves_history",
                "linking_lifecycle",
                "disconnect_preserves_history",
                (
                    "identity_id",
                    "account_id",
                    "chat_id",
                    "connection_id",
                    "history_message_id",
                    "disconnect_status",
                ),
                transports=("rest",),
                actor="admin",
                statuses=(200, 204),
                bindings=("identity_ids", "account_ids", "chat_ids", "connection_ids"),
                observations=(
                    (
                        "disconnect_result",
                        ("connection_id", "disconnect_operation_id", "disconnect_status"),
                    ),
                    (
                        "history_after_disconnect",
                        (
                            "identity_id",
                            "account_id",
                            "chat_id",
                            "connection_id",
                            "history_message_id",
                        ),
                    ),
                ),
            ),
            _requirement(
                "different_identity_account",
                "linking_lifecycle",
                "different_identity_account",
                (
                    "identity_id",
                    "account_id",
                    "grant_count",
                    "history_message_count",
                ),
                transports=("rest",),
                actor="admin",
                statuses=(200, 201),
                expected=(("grant_count", 0), ("history_message_count", 0)),
                observations=(
                    ("account_result", ("identity_id", "account_id")),
                    ("grant_count", ("grant_count",)),
                    ("history_count", ("history_message_count",)),
                ),
            ),
        ),
        (
            _relation("equal", "identity_grant", "same_identity_relink", "identity_id", "account_id", "grant_id"),
            _relation("equal", "identity_grant", "disconnect_preserves_history", "identity_id", "account_id"),
            _relation("distinct", "identity_grant", "different_identity_account", "identity_id", "account_id"),
        ),
    ),
    Scenario(
        "history_context_attachment",
        ("#35",),
        "Stored history, context, and authenticated attachment reads",
        (
            _requirement(
                "stored_history",
                "history_read",
                "stored_history",
                ("account_id", "chat_id", "message_id", "revision", "history_range_status"),
                actor="agent",
                statuses=(200,),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
            _requirement(
                "attachment_read",
                "attachment_read",
                "authenticated_attachment",
                (
                    "account_id",
                    "chat_id",
                    "message_id",
                    "attachment_id",
                    "sha256",
                    "mime_type",
                    "download_grant",
                ),
                actor="agent",
                statuses=(200,),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
        ),
    ),
    Scenario(
        "text_send_and_route",
        ("#35", "#36"),
        "Text acceptance, account-owned routing, and provider evidence",
        (
            _requirement(
                "saved_before_dispatch",
                "text_send",
                "saved_before_dispatch",
                (
                    "command_id",
                    "message_id",
                    "dispatch_id",
                    "account_id",
                    "chat_id",
                    "saved_status",
                    "saved_at",
                ),
                actor="agent",
                statuses=(200, 201),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
            _requirement(
                "provider_delivery",
                "text_send",
                "provider_delivery",
                (
                    "command_id",
                    "account_id",
                    "chat_id",
                    "matrix_status",
                    "bridge_status",
                    "provider_status",
                    "provider_message_id",
                ),
                actor="agent",
                statuses=(200,),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
            _requirement(
                "account_failover_rejected",
                "text_send",
                "account_failover_rejected",
                ("requested_account_id", "resolved_account_id", "error_code"),
                actor="agent",
                statuses=(401, 403),
            ),
        ),
        (
            _relation("equal", "saved_before_dispatch", "provider_delivery", "command_id", "account_id", "chat_id"),
        ),
    ),
    Scenario(
        "direct_chat_and_group",
        ("#35",),
        "New direct chat and group create, rename, and membership changes",
        (
            _requirement(
                "contact_resolution",
                "recipient_resolution",
                "contact_resolution",
                ("account_id", "contact_id", "provider_contact_id", "resolution_status"),
                actor="agent",
                statuses=(200,),
                bindings=("account_ids", "grant_ids"),
            ),
            _requirement(
                "direct_chat_creation",
                "recipient_resolution",
                "direct_chat_creation",
                ("account_id", "chat_id", "contact_id", "provider_chat_id", "provider_status"),
                actor="agent",
                statuses=(200, 201),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
            _requirement(
                "group_creation",
                "group_operation",
                "group_creation",
                ("account_id", "chat_id", "group_operation_id", "provider_group_id", "provider_status"),
                actor="agent",
                statuses=(200, 201),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
            _requirement(
                "group_management",
                "group_operation",
                "group_management",
                ("account_id", "chat_id", "provider_group_id", "group_revision", "member_ids_digest", "provider_status"),
                actor="agent",
                statuses=(200,),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
        ),
        (
            _relation("equal", "contact_resolution", "direct_chat_creation", "account_id", "contact_id"),
            _relation("equal", "group_creation", "group_management", "account_id", "chat_id", "provider_group_id"),
        ),
    ),
    Scenario(
        "webhook_subscriptions",
        ("#35",),
        "Two subscription cases with revision, removal, retry, and cutover IDs",
        (
            _requirement(
                "subscription_one_initial",
                "webhook_delivery",
                "subscription_one_initial",
                (
                    "subscription_id",
                    "destination_version",
                    "delivery_id",
                    "source_event_id",
                    "receiver_id",
                    "revision",
                    "delivery_status",
                ),
                actor="agent",
                statuses=(200, 201),
                bindings=("account_ids", "grant_ids"),
            ),
            _requirement(
                "subscription_two_initial",
                "webhook_delivery",
                "subscription_two_initial",
                (
                    "subscription_id",
                    "destination_version",
                    "delivery_id",
                    "source_event_id",
                    "receiver_id",
                    "revision",
                    "delivery_status",
                ),
                actor="agent",
                statuses=(200, 201),
                bindings=("account_ids", "grant_ids"),
            ),
            _requirement(
                "revision_removal",
                "webhook_delivery",
                "revision_removal",
                (
                    "subscription_id",
                    "source_event_id",
                    "delivery_id",
                    "revision",
                    "removal_event_id",
                    "content_status",
                ),
                actor="agent",
                statuses=(200,),
                bindings=("grant_ids",),
            ),
            _requirement(
                "retry",
                "webhook_delivery",
                "retry",
                (
                    "subscription_id",
                    "delivery_id",
                    "source_event_id",
                    "attempt_count",
                    "retry_deadline",
                    "manual_retry_actor",
                ),
                actor="agent",
                statuses=(200,),
                bindings=("grant_ids",),
            ),
            _requirement(
                "cutover",
                "webhook_delivery",
                "cutover",
                (
                    "subscription_id",
                    "old_destination_version",
                    "new_destination_version",
                    "cancelled_pending_count",
                ),
                actor="admin",
                statuses=(200,),
                bindings=("grant_ids",),
            ),
        ),
        (
            _relation("distinct", "subscription_one_initial", "subscription_two_initial", "subscription_id"),
            _relation("equal", "subscription_one_initial", "revision_removal", "subscription_id"),
            _relation("equal", "subscription_one_initial", "retry", "subscription_id"),
            _relation("equal", "subscription_one_initial", "cutover", "subscription_id"),
        ),
    ),
    Scenario(
        "receipt_and_restore",
        ("#35",),
        "Explicit receipt result, removal, and restore anti-resurrection",
        (
            _requirement(
                "explicit_receipt",
                "receipt",
                "explicit_receipt",
                (
                    "receipt_id",
                    "account_id",
                    "chat_id",
                    "message_id",
                    "requested_status",
                    "observed_status",
                    "result_class",
                ),
                actor="agent",
                statuses=(200, 201),
                bindings=("account_ids", "chat_ids", "grant_ids"),
            ),
            _requirement(
                "active_removal",
                "removal_restore",
                "active_removal",
                (
                    "removal_id",
                    "message_id",
                    "content_generation",
                    "deletion_epoch",
                    "active_read_status",
                    "attachment_status",
                    "delivery_status",
                ),
                actor="admin",
                statuses=(200, 201),
                bindings=("account_ids", "chat_ids"),
            ),
            _requirement(
                "restore_anti_resurrection",
                "removal_restore",
                "restore_anti_resurrection",
                (
                    "restore_id",
                    "removal_id",
                    "deletion_epoch",
                    "stale_work_rejected",
                    "retained_message_id",
                    "retained_revision",
                ),
                actor="admin",
                statuses=(200,),
                bindings=("account_ids", "chat_ids"),
            ),
        ),
        (
            _relation("equal", "active_removal", "restore_anti_resurrection", "removal_id", "deletion_epoch"),
        ),
    ),
    Scenario(
        "authorization_negative_matrix",
        ("#35", "#36"),
        "Wrong resource, expired or revoked installation, missing grant, and account mismatch",
        (
            _requirement(
                "wrong_resource",
                "authorization_negative",
                "wrong_resource",
                ("error_code", "resource_metadata"),
                actor="agent",
                statuses=(401,),
            ),
            _requirement(
                "expired_installation",
                "authorization_negative",
                "expired_installation",
                ("error_code", "installation_id"),
                actor="agent",
                statuses=(401,),
            ),
            _requirement(
                "revoked_installation",
                "authorization_negative",
                "revoked_installation",
                ("error_code", "installation_id"),
                actor="agent",
                statuses=(401,),
            ),
            _requirement(
                "missing_grant",
                "authorization_negative",
                "missing_grant",
                ("error_code", "account_id"),
                actor="agent",
                statuses=(403,),
            ),
            _requirement(
                "account_mismatch",
                "authorization_negative",
                "account_mismatch",
                ("error_code", "requested_account_id", "resolved_account_id"),
                actor="agent",
                statuses=(403,),
            ),
        ),
    ),
    Scenario(
        "grok_surface_read",
        ("#36",),
        "Grok surface read scope",
        (
            _requirement(
                "surface_scoped_read",
                "grok_surface",
                "scoped_read",
                ("surface", "installation_id", "account_id", "chat_id", "grant_id", "message_id"),
                transports=("mcp",),
                actor="agent",
                statuses=(200,),
                bindings=("resource", "installation_id", "grant_ids", "account_ids", "chat_ids"),
            ),
        ),
    ),
    Scenario(
        "grok_surface_send",
        ("#36",),
        "Grok surface durable text submission and provider evidence",
        (
            _requirement(
                "surface_text_send",
                "grok_surface",
                "text_send",
                (
                    "surface",
                    "command_id",
                    "message_id",
                    "account_id",
                    "chat_id",
                    "saved_status",
                    "dispatch_status",
                    "provider_status",
                    "provider_message_id",
                ),
                transports=("mcp",),
                actor="agent",
                statuses=(200,),
                bindings=("resource", "installation_id", "grant_ids", "account_ids", "chat_ids"),
            ),
        ),
    ),
    Scenario(
        "grok_bot_identity",
        ("#36",),
        "Shared Bot member and installation binding",
        (
            _requirement(
                "bot_member_binding",
                "grok_bot",
                "member_binding",
                ("surface", "installation_id", "member_id", "ownership_scope", "actor_binding"),
                transports=("mcp",),
                actor="agent",
                statuses=(200,),
                bindings=("resource", "installation_id"),
                expected=(("ownership_scope", "connection"), ("actor_binding", "member_installation")),
            ),
        ),
    ),
    Scenario(
        "grok_failure_matrix",
        ("#36",),
        "Grok duplicate, timeout, uncertainty, reconnect, and rejection behavior",
        (
            _requirement(
                "duplicate_request",
                "grok_failure",
                "duplicate_request",
                ("command_id", "duplicate_status", "idempotency_key", "second_request_reused"),
                transports=("mcp",),
                actor="agent",
                statuses=(200, 409),
                bindings=("resource", "installation_id", "account_ids", "chat_ids"),
                expected=(("second_request_reused", True),),
            ),
            _requirement(
                "timeout_uncertainty",
                "grok_failure",
                "timeout_uncertainty",
                ("command_id", "uncertainty_status", "chat_paused", "provider_status"),
                transports=("mcp",),
                actor="agent",
                statuses=(200, 202),
                bindings=("resource", "installation_id", "account_ids", "chat_ids"),
                expected=(("uncertainty_status", "delivery_uncertain"), ("chat_paused", True)),
            ),
            _requirement(
                "reconnect",
                "grok_failure",
                "reconnect",
                ("command_id", "reconnect_status", "saved_at", "age_preserved", "confirmation_status"),
                transports=("mcp",),
                actor="agent",
                statuses=(200,),
                bindings=("resource", "installation_id", "account_ids", "chat_ids"),
                expected=(("age_preserved", True),),
            ),
            _requirement(
                "provider_rejection",
                "grok_failure",
                "provider_rejection",
                ("command_id", "error_code", "provider_status"),
                transports=("mcp",),
                actor="agent",
                statuses=(400, 409, 422, 503),
                bindings=("resource", "installation_id", "account_ids", "chat_ids"),
            ),
        ),
    ),
    Scenario(
        "surface_outcome_record",
        ("#35", "#36"),
        "Exact surface version and explicit unsupported or unverified result",
        (
            _requirement(
                "surface_metadata",
                "surface_metadata",
                "client_provider_versions",
                ("surface", "client_version", "provider_version", "evidence_class", "support_status"),
                actor="none",
                statuses=(200,),
                expected=(("surface", "${target.client.surface}"), ("evidence_class", "${mode}")),
            ),
        ),
    ),
)
SCENARIO_BY_ID = {scenario.identifier: scenario for scenario in SCENARIOS}
REQUIREMENT_BY_KEY = {
    (scenario.identifier, requirement.case): requirement
    for scenario in SCENARIOS
    for requirement in scenario.requirements
}


def _observation_fields(requirement: Requirement, observation: str) -> tuple[str, ...]:
    """Return the typed fields one response role may contribute to a case."""

    for name, fields in requirement.observations:
        if name == observation:
            return fields
    if observation == "response" and not requirement.observations:
        return requirement.evidence
    return ()


def _declared_observations(requirement: Requirement) -> dict[str, tuple[str, ...]]:
    if requirement.observations:
        return dict(requirement.observations)
    return {"response": requirement.evidence}


# A proof label is bound to one concrete application entrypoint.  Matching the
# complete route keeps a successful but unrelated endpoint from satisfying a
# semantic case.  IDs remain wildcards because the configured bindings supply
# the concrete values at run time.
RouteContract = tuple[tuple[str, ...], str]
REST_ROUTE_CONTRACTS: dict[tuple[str, str, str], tuple[RouteContract, ...]] = {
    ("oauth_connection", "protected_resource", "response"): (("GET", r"/\.well-known/oauth-protected-resource"),),
    ("oauth_connection", "authorization_server", "response"): (("GET", r"/\.well-known/oauth-authorization-server"),),
    ("linking_identity_lifecycle", "unlinked_start", "response"): (("POST", r"/api/v1/identities/[^/]+/link-sessions"),),
    ("linking_identity_lifecycle", "identity_grant", "grant_result"): (("POST", r"/api/v1/grants(?:/[^/]+)?"), ("PATCH", r"/api/v1/grants/[^/]+")),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_result"): (("POST", r"/api/v1/connections/[^/]+/relink-sessions"),),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_operation"): (("GET", r"/api/v1/connections/[^/]+/lifecycle-operations/[^/]+"),),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_grant"): (("POST", r"/api/v1/grants(?:/[^/]+)?"), ("PATCH", r"/api/v1/grants/[^/]+")),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_chat"): (("GET", r"/api/v1/identities/[^/]+/conversations/[^/]+"),),
    ("linking_identity_lifecycle", "disconnect_preserves_history", "disconnect_result"): (("POST", r"/api/v1/connections/[^/]+/disconnect"),),
    ("linking_identity_lifecycle", "disconnect_preserves_history", "history_after_disconnect"): (("GET", r"/api/v1/conversations/[^/]+/messages"),),
    ("linking_identity_lifecycle", "different_identity_account", "account_result"): (("GET", r"/api/v1/accounts"),),
    ("linking_identity_lifecycle", "different_identity_account", "grant_count"): (("GET", r"/api/v1/grants"),),
    ("linking_identity_lifecycle", "different_identity_account", "history_count"): (("GET", r"/api/v1/identities/[^/]+/conversations"),),
    ("history_context_attachment", "stored_history", "response"): (("GET", r"/api/v1/conversations/[^/]+/messages"),),
    ("history_context_attachment", "attachment_read", "response"): (("GET", r"/api/v1/attachments/[^/]+(?:/download)?"),),
    ("text_send_and_route", "saved_before_dispatch", "response"): (("POST", r"/api/v1/conversations/[^/]+/messages"),),
    ("text_send_and_route", "provider_delivery", "response"): (("GET", r"/api/v1/commands/[^/]+"), ("GET", r"/api/v1/commands/[^/]+/evidence")),
    ("text_send_and_route", "account_failover_rejected", "response"): (("POST", r"/api/v1/conversations/[^/]+/messages"),),
    ("direct_chat_and_group", "contact_resolution", "response"): (("POST", r"/api/v1/contacts/resolve"),),
    ("direct_chat_and_group", "direct_chat_creation", "response"): (("POST", r"/api/v1/conversations"),),
    ("direct_chat_and_group", "group_creation", "response"): (("POST", r"/api/v1/groups"),),
    ("direct_chat_and_group", "group_management", "response"): (("PATCH", r"/api/v1/groups/[^/]+"), ("POST", r"/api/v1/groups/[^/]+/participants"), ("DELETE", r"/api/v1/groups/[^/]+/participants")),
    ("webhook_subscriptions", "subscription_one_initial", "response"): (("POST", r"/api/v1/webhook-subscriptions"),),
    ("webhook_subscriptions", "subscription_two_initial", "response"): (("POST", r"/api/v1/webhook-subscriptions"),),
    ("webhook_subscriptions", "revision_removal", "response"): (("DELETE", r"/api/v1/webhook-subscriptions/[^/]+"), ("POST", r"/api/v1/webhook-deliveries/[^/]+/retry")),
    ("webhook_subscriptions", "retry", "response"): (("POST", r"/api/v1/webhook-deliveries/[^/]+/retry"),),
    ("webhook_subscriptions", "cutover", "response"): (("POST", r"/api/v1/webhook-subscriptions/[^/]+/cutover"),),
    ("receipt_and_restore", "explicit_receipt", "response"): (("POST", r"/api/v1/conversations/[^/]+/receipts/read"), ("GET", r"/api/v1/receipts/[^/]+")),
    ("receipt_and_restore", "active_removal", "response"): (("POST", r"/api/v1/removals"),),
    ("receipt_and_restore", "restore_anti_resurrection", "response"): (("POST", r"/api/v1/removals"),),
    # Negative cases are intentionally tied to real read/metadata routes; the
    # expected error status and capability evidence still come from the target.
    ("authorization_negative_matrix", "wrong_resource", "response"): (("GET", r"/api/v1/identities"),),
    ("authorization_negative_matrix", "expired_installation", "response"): (("GET", r"/api/v1/identities"),),
    ("authorization_negative_matrix", "revoked_installation", "response"): (("GET", r"/api/v1/identities"),),
    ("authorization_negative_matrix", "missing_grant", "response"): (("GET", r"/api/v1/conversations/[^/]+/messages"),),
    ("authorization_negative_matrix", "account_mismatch", "response"): (("GET", r"/api/v1/conversations/[^/]+/messages"),),
    ("surface_outcome_record", "surface_metadata", "response"): (("GET", r"/api/v1/session"),),
}

# Request contracts mirror the current Worker route declarations.  The
# response route contract alone is insufficient for a mutation: a successful
# response from a request that omitted an idempotency key or JSON body is not
# proof that the configured client can perform the action.  Body values are
# intentionally not copied into evidence; validation records only their
# presence and top-level keys.
REST_REQUEST_CONTRACTS: dict[tuple[str, str, str], RestRequestContract] = {
    ("linking_identity_lifecycle", "unlinked_start", "response"): RestRequestContract(
        required_headers=("idempotency-key",),
        body_required=True,
        body_keys=frozenset({"provider", "method", "confirmed_identity_id"}),
        required_body_keys=frozenset({"provider", "method", "confirmed_identity_id"}),
        idempotency_key_min_length=8,
    ),
    ("linking_identity_lifecycle", "identity_grant", "grant_result"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {
                "membership_id",
                "identity_id",
                "account_id",
                "operation_scope",
                "chat_scope",
                "chat_ids",
                "idempotency_key",
            }
        ),
        required_body_keys=frozenset(
            {
                "membership_id",
                "identity_id",
                "account_id",
                "operation_scope",
                "chat_scope",
                "chat_ids",
                "idempotency_key",
            }
        ),
    ),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_result"): RestRequestContract(
        required_headers=("idempotency-key",),
        body_required=True,
        body_keys=frozenset(
            {"provider", "method", "confirmed_identity_id", "expected_session_generation"}
        ),
        required_body_keys=frozenset({"provider", "method", "confirmed_identity_id"}),
        idempotency_key_min_length=8,
    ),
    ("linking_identity_lifecycle", "same_identity_relink", "relink_grant"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {
                "membership_id",
                "identity_id",
                "account_id",
                "operation_scope",
                "chat_scope",
                "chat_ids",
                "idempotency_key",
            }
        ),
        required_body_keys=frozenset(
            {
                "membership_id",
                "identity_id",
                "account_id",
                "operation_scope",
                "chat_scope",
                "chat_ids",
                "idempotency_key",
            }
        ),
    ),
    # The Worker requires this header even though the JSON action body is
    # currently empty (or carries only the optional generation guard).
    ("linking_identity_lifecycle", "disconnect_preserves_history", "disconnect_result"): RestRequestContract(
        required_headers=("idempotency-key",),
        body_required=True,
        body_keys=frozenset({"expected_session_generation"}),
        idempotency_key_min_length=8,
    ),
    ("text_send_and_route", "saved_before_dispatch", "response"): RestRequestContract(
        required_headers=("idempotency-key",),
        body_required=True,
        body_keys=frozenset({"identity_id", "account_id", "body", "delivery_mode"}),
        required_body_keys=frozenset({"identity_id", "body", "delivery_mode"}),
    ),
    ("text_send_and_route", "account_failover_rejected", "response"): RestRequestContract(
        required_headers=("idempotency-key",),
        body_required=True,
        body_keys=frozenset({"identity_id", "account_id", "body", "delivery_mode"}),
        required_body_keys=frozenset({"identity_id", "body", "delivery_mode"}),
    ),
    ("direct_chat_and_group", "contact_resolution", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset({"identity_id", "account_id", "phone"}),
        required_body_keys=frozenset({"identity_id", "account_id", "phone"}),
    ),
    ("direct_chat_and_group", "direct_chat_creation", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {"identity_id", "account_id", "contact_id", "candidate_revision", "idempotency_key"}
        ),
        required_body_keys=frozenset(
            {"identity_id", "account_id", "contact_id", "candidate_revision", "idempotency_key"}
        ),
    ),
    ("direct_chat_and_group", "group_creation", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset({"identity_id", "account_id", "name", "participants", "idempotency_key"}),
        required_body_keys=frozenset(
            {"identity_id", "account_id", "name", "participants", "idempotency_key"}
        ),
    ),
    ("direct_chat_and_group", "group_management", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {
                "identity_id",
                "account_id",
                "conversation_id",
                "expected_revision",
                "idempotency_key",
                "name",
                "participants",
            }
        ),
        required_body_keys=frozenset(
            {"identity_id", "account_id", "conversation_id", "expected_revision", "idempotency_key"}
        ),
    ),
    ("webhook_subscriptions", "subscription_one_initial", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {
                "owner_installation_id",
                "logical_agent_id",
                "destination",
                "event_filter",
                "global_enabled",
                "account_rules",
                "chat_rules",
                "idempotency_key",
            }
        ),
        required_body_keys=frozenset({"destination", "idempotency_key"}),
    ),
    ("webhook_subscriptions", "subscription_two_initial", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {
                "owner_installation_id",
                "logical_agent_id",
                "destination",
                "event_filter",
                "global_enabled",
                "account_rules",
                "chat_rules",
                "idempotency_key",
            }
        ),
        required_body_keys=frozenset({"destination", "idempotency_key"}),
    ),
    ("webhook_subscriptions", "revision_removal", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset({"idempotency_key"}),
        required_body_keys=frozenset({"idempotency_key"}),
    ),
    ("webhook_subscriptions", "retry", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset({"idempotency_key"}),
        required_body_keys=frozenset({"idempotency_key"}),
    ),
    ("webhook_subscriptions", "cutover", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset({"destination", "idempotency_key"}),
        required_body_keys=frozenset({"destination", "idempotency_key"}),
    ),
    ("receipt_and_restore", "explicit_receipt", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {"schema_version", "identity_id", "account_id", "message_id", "idempotency_key"}
        ),
        required_body_keys=frozenset(
            {"schema_version", "identity_id", "account_id", "message_id", "idempotency_key"}
        ),
    ),
    ("receipt_and_restore", "active_removal", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {
                "tenant_id",
                "resource_type",
                "resource_id",
                "content_generation",
                "account_id",
                "conversation_id",
                "source_event_id",
                "source_object_key",
                "reason",
                "removed_at",
            }
        ),
        required_body_keys=frozenset(
            {"tenant_id", "resource_type", "resource_id", "content_generation", "reason"}
        ),
    ),
    ("receipt_and_restore", "restore_anti_resurrection", "response"): RestRequestContract(
        body_required=True,
        body_keys=frozenset(
            {
                "tenant_id",
                "resource_type",
                "resource_id",
                "content_generation",
                "account_id",
                "conversation_id",
                "source_event_id",
                "source_object_key",
                "reason",
                "removed_at",
            }
        ),
        required_body_keys=frozenset(
            {"tenant_id", "resource_type", "resource_id", "content_generation", "reason"}
        ),
    ),
}

REST_CANONICAL_POINTERS: dict[tuple[str, str, str], dict[str, Any]] = {
    ("linking_identity_lifecycle", "identity_grant", "grant_result"): {
        "identity_id": "/identity_id", "account_id": "/account_id", "grant_id": "/id"
    },
    ("linking_identity_lifecycle", "same_identity_relink", "relink_result"): {
        "identity_id": "/identity_id", "account_id": "/account_id", "connection_id": "/connection_id", "link_session_id": "/id"
    },
    ("linking_identity_lifecycle", "same_identity_relink", "relink_operation"): {
        "previous_connection_id": "/connection_id", "new_connection_id": "/replacement_connection_id"
    },
    ("linking_identity_lifecycle", "same_identity_relink", "relink_grant"): {
        "identity_id": "/identity_id", "account_id": "/account_id", "grant_id": "/id"
    },
    ("linking_identity_lifecycle", "same_identity_relink", "relink_chat"): {
        "identity_id": "/identity_id", "account_id": "/account_id", "chat_id": "/id"
    },
    ("linking_identity_lifecycle", "disconnect_preserves_history", "disconnect_result"): {
        "connection_id": "/connection_id", "disconnect_operation_id": "/operation_id", "disconnect_status": "/status"
    },
    ("linking_identity_lifecycle", "disconnect_preserves_history", "history_after_disconnect"): {
        "identity_id": "/items/0/identity_id", "account_id": "/items/0/account_id", "chat_id": "/items/0/conversation_id", "connection_id": "/items/0/connection_id", "history_message_id": "/items/0/id"
    },
    ("linking_identity_lifecycle", "different_identity_account", "account_result"): {
        "identity_id": "/items/0/identity_id", "account_id": "/items/0/account_id"
    },
    ("linking_identity_lifecycle", "different_identity_account", "grant_count"): {
        "grant_count": {"pointer": "/items", "transform": "count"}
    },
    ("linking_identity_lifecycle", "different_identity_account", "history_count"): {
        "history_message_count": {"pointer": "/items", "transform": "count"}
    },
}

MCP_CANONICAL_POINTERS: dict[tuple[str, str, str, str], dict[str, Any]] = {
    ("oauth_connection", "mcp_initialize", "response", "initialize"): {
        "protocol_version": "/result/protocolVersion",
        "server_name": "/result/serverInfo/name",
        "server_version": "/result/serverInfo/version",
    },
    ("oauth_connection", "mcp_scoped_read", "response", "list_messages"): {
        "account_id": "/result/structuredContent/items/0/account_id",
        "chat_id": "/result/structuredContent/items/0/conversation_id",
        "message_id": "/result/structuredContent/items/0/id",
    },
}

# Compatibility name retained for callers that inspect the contract catalog.
REQUEST_CONTRACTS = REST_ROUTE_CONTRACTS
MCP_CONTRACTS: dict[tuple[str, str], tuple[str, ...]] = {
    ("oauth_connection", "mcp_scoped_read"): ("list_messages",),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def is_absolute_url(value: str) -> bool:
    parsed = urllib.parse.urlsplit(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def origin_for(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigError(f"expected absolute URL, got {value!r}")
    return f"{parsed.scheme}://{parsed.netloc}"


def _is_loopback_host(hostname: str | None) -> bool:
    return hostname in {"localhost", "127.0.0.1", "::1"}


def validate_oauth_endpoint(value: str, label: str) -> str:
    if not is_absolute_url(value):
        raise ConfigError(f"{label} must be an absolute URL")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https":
        raise ConfigError(f"{label} must use HTTPS")
    if parsed.username or parsed.password or parsed.fragment:
        raise ConfigError(f"{label} contains unsafe URL credentials or fragment")
    return value


def validate_redirect_uri(value: str) -> str:
    if not is_absolute_url(value):
        raise ConfigError("oauth.redirect_uri must be an absolute URL")
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.fragment:
        raise ConfigError("oauth.redirect_uri contains unsafe URL credentials or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and _is_loopback_host(parsed.hostname)):
        raise ConfigError("oauth.redirect_uri must use HTTPS, except for loopback HTTP")
    return value


def reject_placeholder(value: str, label: str, *, live: bool) -> None:
    if live and PLACEHOLDER.search(value):
        raise ConfigError(f"{label} contains a placeholder value")


def redact(value: Any, key: str = "") -> Any:
    """Return a JSON-safe value with credentials removed."""

    if key and _is_sensitive_key(key):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(item_key): redact(item, str(item_key)) for item_key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return [redact(item) for item in value]
    if isinstance(value, str):
        if value.lower().startswith("bearer ") or JWT_SHAPE.fullmatch(value):
            return "<redacted>"
        return value
    return value


def json_pointer(value: Any, pointer: str) -> Any:
    if pointer == "":
        return value
    if not pointer.startswith("/"):
        raise ConfigError(f"JSON pointer must start with /: {pointer}")
    current = value
    for raw_part in pointer[1:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return None
    return current


def _lookup_path(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*)(?:\[(\d+)\])?", part)
        if match is None:
            raise ConfigError(f"invalid template path: {path}")
        name, index = match.groups()
        if not isinstance(current, dict) or name not in current:
            raise ConfigError(f"template path is missing: {path}")
        current = current[name]
        if index is not None:
            if not isinstance(current, list) or int(index) >= len(current):
                raise ConfigError(f"template path index is missing: {path}")
            current = current[int(index)]
    return current


def resolve_templates(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {key: resolve_templates(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_templates(item, context) for item in value]
    if not isinstance(value, str):
        return value

    matches = list(TEMPLATE.finditer(value))
    if not matches:
        return value
    if len(matches) == 1 and matches[0].span() == (0, len(value)):
        return _lookup_path(context, matches[0].group(1))

    result = value
    for match in reversed(matches):
        replacement = str(_lookup_path(context, match.group(1)))
        result = result[: match.start()] + replacement + result[match.end() :]
    return result


def _safe_evidence_value(name: str, value: Any) -> Any:
    """Validate a named evidence field against its declared scalar type."""

    if name not in EVIDENCE_FIELD_KINDS:
        raise EvidenceError(f"evidence field {name!r} is not allowlisted")
    if value is None:
        return None
    if CONTENT_FIELD.search(name) or _is_sensitive_key(name):
        raise EvidenceError(f"evidence field {name!r} may contain content or a credential")
    kind = EVIDENCE_FIELD_KINDS[name]
    if kind == "bool":
        if not isinstance(value, bool):
            raise EvidenceError(f"evidence field {name!r} must be a boolean")
        return value
    if kind == "count":
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise EvidenceError(f"evidence field {name!r} must be a non-negative integer")
        return value
    if not isinstance(value, str):
        raise EvidenceError(f"evidence field {name!r} must be a typed scalar")
    if len(value) > 2048 or "\n" in value or "\r" in value:
        raise EvidenceError(f"evidence field {name!r} is too large or contains a line break")
    if value.lower().startswith("bearer ") or JWT_SHAPE.fullmatch(value):
        raise EvidenceError(f"evidence field {name!r} looks like a credential")
    if kind == "url":
        if not is_absolute_url(value) or urllib.parse.urlsplit(value).username or urllib.parse.urlsplit(value).password:
            raise EvidenceError(f"evidence field {name!r} must be an absolute URL without credentials")
    elif kind == "id":
        if not COMMUNICATOR_ID.fullmatch(value):
            raise EvidenceError(f"evidence field {name!r} must be a Communicator ID")
    elif kind == "digest":
        if not HEX_DIGEST.fullmatch(value):
            raise EvidenceError(f"evidence field {name!r} must be a hexadecimal digest")
    elif kind == "timestamp":
        if not ISO_TIMESTAMP.fullmatch(value):
            raise EvidenceError(f"evidence field {name!r} must be an ISO timestamp")
    elif kind == "mime":
        if not MIME_TYPE.fullmatch(value):
            raise EvidenceError(f"evidence field {name!r} must be a MIME type")
    elif kind == "evidence_class":
        if value not in RUN_MODES:
            raise EvidenceError(f"evidence field {name!r} must name an evidence class")
    elif kind == "version":
        if not SCALAR_TOKEN.fullmatch(value):
            raise EvidenceError(f"evidence field {name!r} must be a bounded version token")
    elif kind == "token":
        if not SCALAR_TOKEN.fullmatch(value):
            raise EvidenceError(f"evidence field {name!r} must be a bounded token")
    elif kind == "label":
        if not value.strip() or len(value) > 128 or any(ord(char) < 32 for char in value):
            raise EvidenceError(f"evidence field {name!r} must be a bounded label")
    return value


def _validate_extract_spec(spec: Any, label: str) -> None:
    if isinstance(spec, str):
        if not spec.startswith("/"):
            raise ConfigError(f"{label} must be a JSON pointer")
        return
    if not isinstance(spec, dict) or set(spec) != {"pointer", "transform"}:
        raise ConfigError(f"{label} must be a JSON pointer or a declared transform")
    if not isinstance(spec["pointer"], str) or not spec["pointer"].startswith("/"):
        raise ConfigError(f"{label}.pointer must be a JSON pointer")
    if spec["transform"] != "count":
        raise ConfigError(f"{label}.transform is unsupported")


def _extract_evidence_value(body: Any, spec: Any) -> Any:
    if isinstance(spec, str):
        return json_pointer(body, spec)
    if isinstance(spec, dict) and spec.get("transform") == "count":
        value = json_pointer(body, spec["pointer"])
        return len(value) if isinstance(value, list) else None
    return None


def _route_contracts_for(
    scenario: str, requirement: Requirement, observation: str
) -> tuple[RouteContract, ...]:
    return REST_ROUTE_CONTRACTS.get(
        (scenario, requirement.identifier, observation),
        REST_ROUTE_CONTRACTS.get((scenario, requirement.identifier, "response"), ()),
    )


def _rest_request_contract(
    scenario: str, requirement: Requirement, observation: str
) -> RestRequestContract | None:
    return REST_REQUEST_CONTRACTS.get(
        (scenario, requirement.identifier, observation),
        REST_REQUEST_CONTRACTS.get((scenario, requirement.identifier, "response")),
    )


def _request_headers(request: dict[str, Any]) -> dict[str, str]:
    value = request.get("headers", {})
    if not isinstance(value, dict):
        return {}
    return {
        str(key).lower(): item
        for key, item in value.items()
        if isinstance(key, str) and isinstance(item, str)
    }


def _safe_transport_headers(
    value: dict[str, str] | None, *, min_idempotency_length: int = 1
) -> dict[str, str]:
    """Allow only the bounded action header surface used by Worker routes."""

    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError("request headers must be an object")
    safe: dict[str, str] = {}
    for name, header_value in value.items():
        if not isinstance(name, str) or not isinstance(header_value, str) or not header_value.strip():
            raise ConfigError("request headers must map names to non-empty strings")
        if name.lower() != "idempotency-key":
            raise ConfigError("request headers only permit Idempotency-Key")
        if len(header_value.strip()) < min_idempotency_length:
            raise ConfigError(
                "Idempotency-Key must be at least "
                f"{min_idempotency_length} characters"
            )
        safe["Idempotency-Key"] = header_value
    return safe


def _request_body_shape(request: dict[str, Any]) -> tuple[bool, set[str] | None, str]:
    if "body" in request:
        body = request.get("body")
        if body is None:
            return False, None, "null"
        if isinstance(body, dict):
            return True, set(body), "object"
        return True, None, type(body).__name__
    if "body_present" in request:
        present = request.get("body_present") is True
        keys = request.get("body_keys")
        return (
            present,
            set(keys) if isinstance(keys, list) and all(isinstance(key, str) for key in keys) else None,
            str(request.get("body_type", "unknown")),
        )
    return False, None, "missing"


def _route_path_for_matching(path: str) -> str:
    parsed = urllib.parse.urlsplit(path)
    path_only = parsed.path or path.split("?", 1)[0]
    return TEMPLATE.sub("placeholder", path_only)


def _request_contract_errors(
    requirement: Requirement,
    scenario: str,
    request: dict[str, Any],
    transport: str,
    observation: str = "response",
) -> list[str]:
    errors: list[str] = []
    if transport == "rest":
        method = str(request.get("method", "")).upper()
        contracts = _route_contracts_for(scenario, requirement, observation)
        if requirement.rest_methods and method not in requirement.rest_methods:
            errors.append(f"HTTP method {method or '<missing>'} is not a {requirement.case} entrypoint")
        if contracts and not any(
            method in methods and re.fullmatch(pattern, _route_path_for_matching(str(request.get("path", ""))))
            for methods, pattern in contracts
        ):
            errors.append(f"route is not the declared {requirement.case} entrypoint")
        elif not contracts and requirement.path_fragments:
            path = str(request.get("path", "")).lower()
            if not any(fragment.lower() == path for fragment in requirement.path_fragments):
                errors.append(f"route is not the declared {requirement.case} entrypoint")
        action_contract = _rest_request_contract(scenario, requirement, observation)
        if action_contract is not None:
            headers = _request_headers(request)
            for header in action_contract.required_headers:
                value = headers.get(header.lower())
                if not value:
                    errors.append(f"{requirement.case} request requires the {header} header")
                elif header.lower() == "idempotency-key" and len(value.strip()) < action_contract.idempotency_key_min_length:
                    errors.append(
                        f"{requirement.case} request {header} must be at least "
                        f"{action_contract.idempotency_key_min_length} characters"
                    )
            present, body_keys, body_type = _request_body_shape(request)
            if action_contract.body_required and not present:
                errors.append(f"{requirement.case} request requires a JSON body")
            if action_contract.body_required and present and body_type != "object":
                errors.append(f"{requirement.case} request body must be a JSON object")
            if action_contract.body_keys is not None and present and body_keys is not None:
                unknown = sorted(body_keys - action_contract.body_keys)
                if unknown:
                    errors.append(
                        f"{requirement.case} request body has unsupported fields: {', '.join(unknown)}"
                    )
                missing = sorted(action_contract.required_body_keys - body_keys)
                if missing:
                    errors.append(
                        f"{requirement.case} request body is missing fields: {', '.join(missing)}"
                    )
        elif _request_body_shape(request)[0]:
            errors.append(f"{requirement.case} entrypoint does not declare a JSON body")
    else:
        if requirement.case == "initialize":
            if request.get("method") != "initialize":
                errors.append("MCP initialize proof must invoke initialize")
        else:
            tools = requirement.mcp_tools or MCP_CONTRACTS.get((scenario, requirement.identifier), ())
            tool = request.get("tool")
            if not tools or tool not in tools:
                errors.append(f"MCP tool {tool!r} is not a {requirement.case} entrypoint")
    return errors


def _canonical_evidence_pointers(
    requirement: Requirement,
    scenario: str,
    observation: str,
    request: dict[str, Any],
    transport: str,
) -> dict[str, Any] | None:
    if transport == "rest":
        return REST_CANONICAL_POINTERS.get((scenario, requirement.identifier, observation))
    tool = request.get("tool") or request.get("method")
    if not isinstance(tool, str):
        return None
    return MCP_CANONICAL_POINTERS.get((scenario, requirement.identifier, observation, tool))


def _evidence_contract_errors(
    requirement: Requirement,
    scenario: str,
    observation: str,
    request: dict[str, Any],
    transport: str,
    extract: dict[str, Any],
) -> list[str]:
    expected = _canonical_evidence_pointers(requirement, scenario, observation, request, transport)
    if expected is None:
        if transport == "mcp" or requirement.identifier == "provider_delivery":
            return [
                f"no canonical evidence mapping exists for {transport} {requirement.case}"
            ]
        return []
    errors: list[str] = []
    for name, pointer in extract.items():
        if name in expected and pointer != expected[name]:
            errors.append(f"evidence pointer for {name} is not the canonical {requirement.case} response field")
    unknown = sorted(set(extract) - set(expected))
    if unknown:
        errors.append(f"evidence fields are not present in the {requirement.case} response schema: {', '.join(unknown)}")
    return errors


def _secret_key_in(value: Any, path: str = "") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if _is_sensitive_key(str(key)) and str(key) not in {
                "access_token_env",
                "admin_access_token_env",
                "access_token_file",
                "admin_access_token_file",
                "client_secret_env",
                "authorization_server",
            }:
                return child_path
            found = _secret_key_in(child, child_path)
            if found:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = _secret_key_in(child, f"{path}[{index}]")
            if found:
                return found
    return None


def _require_string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ConfigError(f"{label} must be a non-empty string")
    return value


def _require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ConfigError(f"{label} must be an array of strings")
    return value


def validate_config(config: dict[str, Any]) -> dict[str, Any]:
    if config.get("schema_version") != SCHEMA_VERSION:
        raise ConfigError(f"schema_version must be {SCHEMA_VERSION}")
    mode = config.get("mode")
    if mode not in RUN_MODES:
        raise ConfigError("mode must be live_client or controlled")
    live = mode == "live_client"

    target = config.get("target")
    if not isinstance(target, dict):
        raise ConfigError("target must be an object")
    for key in ("base_url", "mcp_url", "resource"):
        value = _require_string(target.get(key), f"target.{key}")
        if not is_absolute_url(value):
            raise ConfigError(f"target.{key} must be an absolute URL")
        parsed_target = urllib.parse.urlsplit(value)
        if parsed_target.username or parsed_target.password or parsed_target.fragment:
            raise ConfigError(f"target.{key} contains unsafe URL credentials or fragment")
        if live and urllib.parse.urlsplit(value).scheme != "https":
            raise ConfigError(f"target.{key} must use HTTPS for live_client")
        reject_placeholder(value, f"target.{key}", live=live)
    if not target["mcp_url"].startswith(target["base_url"].rstrip("/") + "/"):
        raise ConfigError("target.mcp_url must be below target.base_url")

    client = target.get("client")
    if not isinstance(client, dict):
        raise ConfigError("target.client must be an object")
    for key in ("surface", "name", "version", "transport"):
        value = _require_string(client.get(key), f"target.client.{key}")
        reject_placeholder(value, f"target.client.{key}", live=live)
    if client["transport"] not in {"rest", "mcp", "both"}:
        raise ConfigError("target.client.transport must be rest, mcp, or both")

    provider = target.get("provider")
    if not isinstance(provider, dict):
        raise ConfigError("target.provider must be an object")
    for key in ("name", "version", "adapter_version", "proof_source"):
        value = _require_string(provider.get(key), f"target.provider.{key}")
        reject_placeholder(value, f"target.provider.{key}", live=live)

    bindings = target.get("bindings")
    if not isinstance(bindings, dict):
        raise ConfigError("target.bindings must be an object")
    _require_string(bindings.get("tenant_id"), "target.bindings.tenant_id")
    _require_string(bindings.get("installation_id"), "target.bindings.installation_id", allow_empty=True)
    for key in (
        "grant_ids",
        "account_ids",
        "chat_ids",
        "connection_ids",
        "provider_account_ids",
        "identity_ids",
    ):
        _require_string_list(bindings.get(key), f"target.bindings.{key}")

    oauth = config.get("oauth")
    if not isinstance(oauth, dict):
        raise ConfigError("oauth must be an object")
    token_sources = [
        oauth.get("access_token_env"),
        oauth.get("access_token_file"),
    ]
    if sum(source is not None for source in token_sources) != 1:
        raise ConfigError("oauth must configure exactly one access_token_env or access_token_file")
    for key in ("access_token_env", "admin_access_token_env", "client_secret_env"):
        if key in oauth and oauth[key] is not None:
            _require_string(oauth[key], f"oauth.{key}")
    for key in ("access_token_file", "admin_access_token_file", "authorization_server", "client_id", "redirect_uri", "scope"):
        if key in oauth and oauth[key] is not None:
            _require_string(oauth[key], f"oauth.{key}")
    if "client_id" in oauth:
        reject_placeholder(oauth["client_id"], "oauth.client_id", live=live)
    if "redirect_uri" in oauth:
        validate_redirect_uri(oauth["redirect_uri"])
        reject_placeholder(oauth["redirect_uri"], "oauth.redirect_uri", live=live)
    if "authorization_server" in oauth:
        validate_oauth_endpoint(oauth["authorization_server"], "oauth.authorization_server")
        reject_placeholder(oauth["authorization_server"], "oauth.authorization_server", live=live)

    if "preflight" in config and not isinstance(config["preflight"], dict):
        raise ConfigError("preflight must be an object")
    if mode == "live_client" and config.get("preflight", {}).get("enabled", True) is False:
        raise ConfigError("live_client runs must perform OAuth metadata preflight")

    operations = config.get("operations")
    if not isinstance(operations, list):
        raise ConfigError("operations must be an array")
    operation_ids: set[str] = set()
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise ConfigError(f"operations[{index}] must be an object")
        identifier = _require_string(operation.get("id"), f"operations[{index}].id")
        if identifier in operation_ids:
            raise ConfigError(f"duplicate operation id: {identifier}")
        operation_ids.add(identifier)
        scenario = _require_string(operation.get("scenario"), f"operations[{index}].scenario")
        if scenario not in SCENARIO_BY_ID:
            raise ConfigError(f"operations[{index}] uses unknown scenario {scenario!r}")
        proof = operation.get("proof")
        if not isinstance(proof, dict):
            raise ConfigError(
                f"operations[{index}].proof must name a scenario requirement"
            )
        role = _require_string(proof.get("role"), f"operations[{index}].proof.role")
        case = _require_string(proof.get("case"), f"operations[{index}].proof.case")
        requirement = REQUIREMENT_BY_KEY.get((scenario, case))
        if requirement is None or requirement.role != role:
            raise ConfigError(
                f"operations[{index}] proof {role}/{case} is not declared for {scenario}"
            )
        observation = proof.get("observation", "response")
        if not isinstance(observation, str) or not observation:
            raise ConfigError(f"operations[{index}].proof.observation must be a non-empty string")
        observation_fields = _observation_fields(requirement, observation)
        if not observation_fields:
            declared = ", ".join(sorted(_declared_observations(requirement)))
            raise ConfigError(
                f"operations[{index}] proof observation {observation!r} is not declared; use {declared}"
            )
        transport = operation.get("transport")
        if transport not in {"rest", "mcp"}:
            raise ConfigError(f"operations[{index}].transport must be rest or mcp")
        if transport not in requirement.transports:
            raise ConfigError(
                f"operations[{index}] proof {role}/{case} requires transport "
                f"{', '.join(requirement.transports)}"
            )
        request = operation.get("request")
        if not isinstance(request, dict):
            raise ConfigError(f"operations[{index}].request must be an object")
        if transport == "rest":
            method = _require_string(request.get("method"), f"operations[{index}].request.method")
            if method.upper() not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                raise ConfigError(f"operations[{index}] uses unsupported HTTP method")
            path = _require_string(request.get("path"), f"operations[{index}].request.path")
            if not path.startswith("/") or is_absolute_url(path):
                raise ConfigError(f"operations[{index}].request.path must be relative")
            headers = request.get("headers", {})
            if not isinstance(headers, dict):
                raise ConfigError(f"operations[{index}].request.headers must be an object")
            for header_name, header_value in headers.items():
                if not isinstance(header_name, str) or not isinstance(header_value, str) or not header_value.strip():
                    raise ConfigError(
                        f"operations[{index}].request.headers must map names to non-empty strings"
                    )
                normalized_header = header_name.lower()
                if normalized_header != "idempotency-key":
                    raise ConfigError(
                        f"operations[{index}].request.headers only permits Idempotency-Key"
                    )
        else:
            if not isinstance(request.get("tool"), str) and request.get("method") not in {
                "initialize",
                "tools/list",
                "resources/list",
            }:
                raise ConfigError(
                    f"operations[{index}].request needs a tool or a supported MCP method"
                )
        actor = operation.get("actor", "agent")
        if actor not in {"agent", "admin", "none"}:
            raise ConfigError(f"operations[{index}].actor must be agent, admin, or none")
        if actor not in requirement.actors:
            raise ConfigError(
                f"operations[{index}] proof {role}/{case} requires actor "
                f"{', '.join(requirement.actors)}"
            )
        expect = operation.get("expect", {})
        if not isinstance(expect, dict):
            raise ConfigError(f"operations[{index}].expect must be an object")
        statuses = expect.get("statuses", [200])
        if (
            not isinstance(statuses, list)
            or not statuses
            or any(not isinstance(status, int) for status in statuses)
        ):
            raise ConfigError(
                f"operations[{index}].expect.statuses must be a non-empty integer array"
            )
        expected_outcome = expect.get("outcome", "pass")
        if expected_outcome not in {"pass", "unsupported", "unverified"}:
            raise ConfigError(f"operations[{index}].expect.outcome is invalid")
        unsupported_statuses = expect.get("unsupported_statuses", [])
        if (
            not isinstance(unsupported_statuses, list)
            or any(not isinstance(status, int) for status in unsupported_statuses)
        ):
            raise ConfigError(
                f"operations[{index}].expect.unsupported_statuses must be an integer array"
            )
        if unsupported_statuses and expected_outcome != "unsupported":
            raise ConfigError(
                f"operations[{index}] unsupported_statuses require an explicit unsupported outcome"
            )
        if expected_outcome == "unsupported":
            unsupported_evidence = expect.get("unsupported_evidence")
            if (
                not isinstance(unsupported_evidence, list)
                or not unsupported_evidence
                or any(not isinstance(pointer, str) or not pointer.startswith("/") for pointer in unsupported_evidence)
            ):
                raise ConfigError(
                    f"operations[{index}] unsupported outcome needs explicit unsupported_evidence pointers"
                )
            if any(
                pointer.rsplit("/", 1)[-1] not in {
                    "status",
                    "supported",
                    "support_status",
                    "capability",
                    "feature",
                    "error_code",
                    "code",
                    "reason",
                }
                for pointer in unsupported_evidence
            ):
                raise ConfigError(
                    f"operations[{index}] unsupported_evidence must identify capability metadata"
                )
            if not unsupported_statuses:
                raise ConfigError(
                    f"operations[{index}] unsupported outcome needs explicit unsupported_statuses"
                )
        evidence = operation.get("evidence", {})
        if not isinstance(evidence, dict):
            raise ConfigError(f"operations[{index}].evidence must be an object")
        extract = evidence.get("extract", {})
        if not isinstance(extract, dict):
            raise ConfigError(f"operations[{index}].evidence.extract must map names to JSON pointers")
        for name, pointer in extract.items():
            _validate_extract_spec(pointer, f"operations[{index}].evidence.extract.{name}")
        if any(CONTENT_FIELD.search(str(name)) for name in extract):
            raise ConfigError(
                f"operations[{index}] may extract identifiers and hashes, not message content"
            )
        if any(_is_sensitive_key(str(name)) for name in extract):
            raise ConfigError(
                f"operations[{index}] may not extract credential-like fields"
            )
        if any(name not in EVIDENCE_FIELD_KINDS for name in extract):
            unknown = sorted(str(name) for name in set(extract) - set(EVIDENCE_FIELD_KINDS))
            raise ConfigError(
                f"operations[{index}] extracts non-typed evidence fields: {', '.join(unknown)}"
            )
        if any(name not in observation_fields for name in extract):
            unknown = sorted(set(extract) - set(observation_fields))
            raise ConfigError(
                f"operations[{index}] extracts fields outside observation {observation!r}: {', '.join(unknown)}"
            )
        required = evidence.get("required", [])
        if (
            not isinstance(required, list)
            or not required
            or any(not isinstance(name, str) for name in required)
            or len(set(required)) != len(required)
            or any(name not in extract for name in required)
            or any(name not in observation_fields for name in required)
        ):
            raise ConfigError(
                f"operations[{index}].evidence.required must name at least one field from observation {observation!r}"
            )
        contract_errors = _request_contract_errors(
            requirement, scenario, request, transport, observation
        )
        if contract_errors:
            raise ConfigError(
                f"operations[{index}] request is outside the declared {case} contract: "
                + "; ".join(contract_errors)
            )
        evidence_contract_errors = _evidence_contract_errors(
            requirement, scenario, observation, request, transport, extract
        )
        if evidence_contract_errors and not (
            expected_outcome == "unverified"
            and all(error.startswith("no canonical evidence mapping exists") for error in evidence_contract_errors)
        ):
            raise ConfigError(
                f"operations[{index}].evidence is outside the declared response schema: "
                + "; ".join(evidence_contract_errors)
            )
        assertions = operation.get("assert", [])
        if not isinstance(assertions, list):
            raise ConfigError(f"operations[{index}].assert must be an array")
        for assertion_index, assertion in enumerate(assertions):
            if not isinstance(assertion, dict) or set(assertion) != {"path", "equals"}:
                raise ConfigError(
                    f"operations[{index}].assert[{assertion_index}] must compare one contract field"
                )
            assertion_path = assertion.get("path")
            if not isinstance(assertion_path, str) or not assertion_path.startswith("/"):
                raise ConfigError(f"operations[{index}].assert[{assertion_index}].path is invalid")
            terminal = assertion_path.rsplit("/", 1)[-1].replace("~1", "/").replace("~0", "~")
            if terminal not in requirement.evidence:
                raise ConfigError(
                    f"operations[{index}].assert[{assertion_index}] targets undeclared evidence"
                )
            expected_assertion = assertion.get("equals")
            if isinstance(expected_assertion, (dict, list)):
                raise ConfigError(
                    f"operations[{index}].assert[{assertion_index}] expected value must be scalar"
                )

    secret_path = _secret_key_in(config)
    if secret_path:
        raise ConfigError(f"inline secret or credential at {secret_path}; use an environment variable or file")
    return config


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigError(f"cannot read JSON {path}: {error}") from error


def load_config(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if not isinstance(value, dict):
        raise ConfigError("configuration must be a JSON object")
    return validate_config(value)


def load_credential(source: str | None, file_source: str | None) -> str | None:
    if source:
        value = os.environ.get(source)
        return value if value else None
    if file_source:
        try:
            value = Path(file_source).read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None
    return None


@dataclass
class HttpResponse:
    status: int | None
    headers: dict[str, str]
    body: Any = None
    raw: bytes = b""
    error: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


class Transport(Protocol):
    def rest(
        self,
        method: str,
        path: str,
        query: dict[str, Any],
        body: Any,
        token: str | None,
        headers: dict[str, str] | None = None,
    ) -> HttpResponse:
        ...

    def mcp(
        self,
        request: dict[str, Any],
        token: str | None,
        client: dict[str, str],
    ) -> HttpResponse:
        ...


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        return None


class NetworkTransport:
    """Network implementation used by the CLI. Tests inject a fake Transport."""

    def __init__(self, target: dict[str, Any], timeout: float = 30.0):
        self.target = target
        self.timeout = timeout
        self._mcp_sessions: dict[str, McpSession] = {}
        self._opener = urllib.request.build_opener(NoRedirect())

    def _request(
        self,
        url: str,
        method: str,
        body: bytes | None,
        headers: dict[str, str],
    ) -> HttpResponse:
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read()
                response_headers = {key.lower(): value for key, value in response.headers.items()}
                return HttpResponse(
                    response.status,
                    response_headers,
                    decode_http_body(raw, response_headers),
                    raw,
                )
        except urllib.error.HTTPError as error:
            raw = error.read()
            response_headers = {key.lower(): value for key, value in error.headers.items()}
            return HttpResponse(
                error.code,
                response_headers,
                decode_http_body(raw, response_headers),
                raw,
            )
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return HttpResponse(None, {}, error=str(error))

    def rest(
        self,
        method: str,
        path: str,
        query: dict[str, Any],
        body: Any,
        token: str | None,
        headers: dict[str, str] | None = None,
    ) -> HttpResponse:
        base = self.target["base_url"].rstrip("/")
        query_string = urllib.parse.urlencode(query, doseq=True)
        url = f"{base}{path}" + (f"?{query_string}" if query_string else "")
        safe_headers = _safe_transport_headers(headers)
        request_headers = {
            "Accept": "application/json",
            "Origin": origin_for(self.target["base_url"]),
            **safe_headers,
        }
        payload = None
        if body is not None:
            payload = canonical_bytes(body)
            request_headers["Content-Type"] = "application/json"
        if token:
            request_headers["Authorization"] = f"Bearer {token}"
        return self._request(url, method.upper(), payload, request_headers)

    def absolute_get(self, url: str) -> HttpResponse:
        return self._request(url, "GET", None, {"Accept": "application/json"})

    def mcp(
        self,
        request: dict[str, Any],
        token: str | None,
        client: dict[str, str],
    ) -> HttpResponse:
        if not token:
            return HttpResponse(None, {}, error="missing MCP access token")
        session_key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        session = self._mcp_sessions.setdefault(
            session_key,
            McpSession(self, self.target["mcp_url"], token, client),
        )
        return session.call(request)


def decode_http_body(raw: bytes, headers: dict[str, str]) -> Any:
    if not raw:
        return None
    content_type = headers.get("content-type", "").lower()
    if "text/event-stream" in content_type:
        return parse_sse(raw)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return raw.decode("utf-8", errors="replace")


def parse_sse(raw: bytes) -> Any:
    messages: list[Any] = []
    data_lines: list[str] = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line.strip() and data_lines:
            joined = "\n".join(data_lines)
            try:
                messages.append(json.loads(joined))
            except json.JSONDecodeError:
                messages.append(joined)
            data_lines = []
    if data_lines:
        joined = "\n".join(data_lines)
        try:
            messages.append(json.loads(joined))
        except json.JSONDecodeError:
            messages.append(joined)
    if len(messages) == 1:
        return messages[0]
    return messages


class McpSession:
    def __init__(self, transport: NetworkTransport, url: str, token: str, client: dict[str, str]):
        self.transport = transport
        self.url = url
        self.token = token
        self.client = client
        self.request_id = 0
        self.session_id: str | None = None
        self.initialized = False
        self.initialization: HttpResponse | None = None

    def _send(self, payload: dict[str, Any]) -> HttpResponse:
        self.request_id += 1
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Origin": origin_for(self.url),
            "Authorization": f"Bearer {self.token}",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if self.session_id:
            headers["MCP-Session-Id"] = self.session_id
        response = self.transport._request(self.url, "POST", canonical_bytes(payload), headers)
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            self.session_id = session_id
        response.details["jsonrpc_request_id"] = payload.get("id")
        response.details["jsonrpc_method"] = payload.get("method")
        return response

    def ensure_initialized(self) -> HttpResponse:
        if self.initialized and self.initialization is not None:
            return self.initialization
        response = self._send(
            {
                "jsonrpc": "2.0",
                "id": self.request_id + 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": self.client["name"],
                        "version": self.client["version"],
                    },
                },
            }
        )
        self.initialization = response
        if response.error is None and response.status is not None and 200 <= response.status < 300:
            if _validate_mcp_response(response) is None:
                self.initialized = True
                notification = self._send(
                    {"jsonrpc": "2.0", "method": "notifications/initialized"}
                )
                response.details["initialized_notification_status"] = notification.status
                notification_payload = _jsonrpc_payload(notification)
                notification_error = (
                    notification.error
                    or (
                        "notification returned a JSON-RPC error"
                        if isinstance(notification_payload, dict) and "error" in notification_payload
                        else None
                    )
                )
                if (
                    notification_error is None
                    and notification.body is not None
                    and _validate_mcp_response(notification) is not None
                ):
                    notification_error = "initialized notification was not a valid JSON-RPC response"
                response.details["initialized_notification_error"] = notification_error
                if notification_error or notification.status is None or not 200 <= notification.status < 300:
                    self.initialized = False
        return response

    def call(self, request: dict[str, Any]) -> HttpResponse:
        initialization = self.ensure_initialized()
        if not self.initialized:
            return HttpResponse(
                initialization.status,
                initialization.headers,
                initialization.body,
                initialization.raw,
                error="MCP initialize failed",
                details={"initialize": response_summary(initialization)},
            )
        method = request.get("method")
        if method == "initialize":
            return initialization
        if method in {"tools/list", "resources/list"}:
            payload = {
                "jsonrpc": "2.0",
                "id": self.request_id + 1,
                "method": method,
                "params": {},
            }
        else:
            tool = request.get("tool")
            arguments = request.get("arguments", {})
            payload = {
                "jsonrpc": "2.0",
                "id": self.request_id + 1,
                "method": "tools/call",
                "params": {"name": tool, "arguments": arguments},
            }
        response = self._send(payload)
        response.details["initialize"] = response_summary(initialization)
        return response


def response_summary(response: HttpResponse) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "http_status": response.status,
        "body_sha256": sha256_bytes(response.raw),
        "headers": {
            key: value
            for key, value in response.headers.items()
            if key in {"content-type", "www-authenticate", "mcp-session-id"}
        },
    }
    if response.error:
        summary["error"] = response.error
    if isinstance(response.body, dict) and isinstance(response.body.get("error"), dict):
        summary["jsonrpc_error"] = redact(response.body["error"])
    payload = _jsonrpc_payload(response)
    if payload is not None and "jsonrpc" in payload:
        summary.update(
            {
                "jsonrpc_version": payload.get("jsonrpc"),
                "jsonrpc_id": payload.get("id"),
                "jsonrpc_request_id": response.details.get("jsonrpc_request_id"),
                "jsonrpc_has_result": "result" in payload,
            }
        )
    return summary


def _binding_snapshot(target: dict[str, Any]) -> dict[str, Any]:
    return {
        "resource": target["resource"],
        "tenant_id": target["bindings"]["tenant_id"],
        "installation_id": target["bindings"]["installation_id"],
        "grant_ids": list(target["bindings"]["grant_ids"]),
        "account_ids": list(target["bindings"]["account_ids"]),
        "chat_ids": list(target["bindings"]["chat_ids"]),
        "connection_ids": list(target["bindings"]["connection_ids"]),
        "provider_account_ids": list(target["bindings"]["provider_account_ids"]),
        "identity_ids": list(target["bindings"]["identity_ids"]),
    }


def _response_body_for_extraction(response: HttpResponse) -> Any:
    return response.body


def _jsonrpc_payload(response: HttpResponse) -> dict[str, Any] | None:
    body = response.body
    if isinstance(body, dict):
        return body
    if isinstance(body, list):
        for item in body:
            if isinstance(item, dict) and ("result" in item or "error" in item):
                return item
    return None


def _validate_mcp_response(response: HttpResponse) -> str | None:
    payload = _jsonrpc_payload(response)
    if payload is None:
        return "MCP response is not a JSON-RPC object"
    if payload.get("jsonrpc") != "2.0":
        return "MCP response has no JSON-RPC 2.0 version"
    if "id" not in payload or payload.get("id") is None:
        return "MCP response has no JSON-RPC request id"
    expected_id = response.details.get("jsonrpc_request_id")
    if expected_id is not None and payload.get("id") != expected_id:
        return "MCP response id does not match the request"
    if "error" in payload:
        return "MCP returned a JSON-RPC error"
    if "result" not in payload:
        return "MCP response has neither result nor an accepted error"
    return None


def _binding_has_value(context: dict[str, Any], name: str) -> bool:
    if name == "resource":
        value = context["target"].get("resource")
    else:
        value = context["binding"].get(name)
    if isinstance(value, list):
        return bool(value) and all(isinstance(item, str) and item for item in value)
    return isinstance(value, str) and bool(value)


def _operation_requirement(operation: dict[str, Any]) -> Requirement:
    proof = operation.get("proof", {})
    requirement = REQUIREMENT_BY_KEY.get((operation.get("scenario"), proof.get("case")))
    if requirement is None or requirement.role != proof.get("role"):
        raise ConfigError("operation proof does not name a declared requirement")
    return requirement


def _assertions_pass(body: Any, assertions: list[dict[str, Any]], context: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for assertion in assertions:
        path = assertion.get("path")
        if not isinstance(path, str):
            errors.append("assertion path is missing")
            continue
        actual = json_pointer(body, path)
        if "equals" in assertion:
            expected = resolve_templates(assertion["equals"], context)
            if actual != expected:
                errors.append(f"{path} expected {expected!r}, got {actual!r}")
        elif "contains" in assertion:
            expected = resolve_templates(assertion["contains"], context)
            if not isinstance(actual, (str, list)) or expected not in actual:
                errors.append(f"{path} does not contain {expected!r}")
        elif "in" in assertion:
            expected = resolve_templates(assertion["in"], context)
            if not isinstance(expected, list) or actual not in expected:
                errors.append(f"{path} value {actual!r} is outside the expected binding")
        else:
            errors.append(f"{path} has no supported assertion")
    return errors


def classify_response(
    response: HttpResponse,
    operation: dict[str, Any],
    context: dict[str, Any],
    request: dict[str, Any] | None = None,
) -> tuple[str, str | None, dict[str, Any]]:
    if response.error:
        return "unverified", response.error, {}
    expect = operation.get("expect", {})
    statuses = set(expect.get("statuses", [200]))
    unsupported_statuses = set(expect.get("unsupported_statuses", []))
    expected_outcome = expect.get("outcome", "pass")
    if expected_outcome == "unsupported" and response.status in unsupported_statuses:
        unsupported_values: dict[str, Any] = {}
        for index, pointer in enumerate(expect.get("unsupported_evidence", [])):
            value = json_pointer(_response_body_for_extraction(response), pointer)
            try:
                terminal = pointer.rsplit("/", 1)[-1].replace("~1", "/").replace("~0", "~")
                typed_name = terminal if terminal in EVIDENCE_FIELD_KINDS else "support_status"
                _safe_evidence_value(typed_name, value)
                unsupported_values[f"unsupported_{index}"] = value
            except EvidenceError:
                return "unverified", "unsupported response lacks scalar capability evidence", {}
        if any(value is None for value in unsupported_values.values()):
            return "unverified", "unsupported response lacks explicit capability evidence", {}
        return "unsupported", f"target explicitly reported HTTP {response.status} as unsupported", {}
    if response.status not in statuses:
        if response.status in unsupported_statuses:
            return "implementation_defect", f"HTTP {response.status} was not declared as a capability outcome", {}
        return "implementation_defect", f"unexpected HTTP status {response.status}", {}

    requirement = _operation_requirement(operation)
    observation = operation.get("proof", {}).get("observation", "response")
    if request is not None:
        contract_errors = _request_contract_errors(
            requirement,
            operation["scenario"],
            request,
            operation["transport"],
            observation,
        )
        if contract_errors:
            return "unverified", "; ".join(contract_errors), {}
    missing_bindings = [name for name in requirement.bindings if not _binding_has_value(context, name)]
    if missing_bindings:
        return "unverified", f"required target bindings are absent: {', '.join(missing_bindings)}", {}
    if requirement.statuses and response.status not in requirement.statuses:
        return "unverified", f"status {response.status} is outside the {requirement.case} contract", {}
    if operation["transport"] == "mcp":
        mcp_error = _validate_mcp_response(response)
        if mcp_error:
            return "implementation_defect", mcp_error, {}

    evidence = operation.get("evidence", {})
    evidence_contract_errors = _evidence_contract_errors(
        requirement,
        operation["scenario"],
        observation,
        request or operation.get("request", {}),
        operation["transport"],
        evidence.get("extract", {}),
    )
    if evidence_contract_errors and not (
        expected_outcome == "unverified"
        and all(error.startswith("no canonical evidence mapping exists") for error in evidence_contract_errors)
    ):
        return "unverified", "; ".join(evidence_contract_errors), {}
    extracted: dict[str, Any] = {}
    for name, pointer in evidence.get("extract", {}).items():
        value = _extract_evidence_value(_response_body_for_extraction(response), pointer)
        try:
            extracted[name] = _safe_evidence_value(name, value)
        except EvidenceError as error:
            return "unverified", str(error), extracted
    missing = [name for name in evidence.get("required", []) if extracted.get(name) is None]
    missing = list(dict.fromkeys(missing))
    if missing:
        return "unverified", f"required evidence fields are absent: {', '.join(missing)}", extracted

    expected_errors = []
    for field_name, expected in requirement.expected:
        if field_name not in extracted:
            continue
        resolved = resolve_templates(expected, context)
        if extracted.get(field_name) != resolved:
            expected_errors.append(
                f"{field_name} expected {resolved!r}, got {extracted.get(field_name)!r}"
            )
    if expected_errors:
        return "implementation_defect", "; ".join(expected_errors), extracted

    assertion_errors = _assertions_pass(
        _response_body_for_extraction(response),
        operation.get("assert", []),
        context,
    )
    if assertion_errors:
        return "implementation_defect", "; ".join(assertion_errors), extracted
    if expected_outcome == "unsupported":
        return "implementation_defect", "target returned a supported status for an unsupported declaration", extracted
    if expected_outcome == "unverified":
        return "unverified", expect.get("reason", "the target did not establish this capability"), extracted
    return "pass", None, extracted


def aggregate_status(records: list[dict[str, Any]]) -> tuple[str, str | None]:
    if not records:
        return "unverified", "no operation was configured for this scenario"
    statuses = [record["status"] for record in records]
    if "implementation_defect" in statuses:
        return "implementation_defect", "one or more operations returned an unexpected result"
    if "unverified" in statuses:
        return "unverified", "one or more required operations lack proof"
    if "unsupported" in statuses:
        return "unsupported", "one or more required capabilities are unsupported"
    return "pass", None


def evaluate_scenario(
    scenario: Scenario,
    records: list[dict[str, Any]],
    context: dict[str, Any] | None = None,
) -> tuple[str, str | None, list[str], list[dict[str, Any]], list[dict[str, Any]]]:
    """Evaluate every named observation, then combine only passing evidence."""

    selected: dict[str, dict[str, Any]] = {}
    coverage: list[dict[str, Any]] = []
    operation_ids: list[str] = []
    for requirement in scenario.requirements:
        candidates = [
            record
            for record in records
            if record.get("proof", {}).get("role") == requirement.role
            and record.get("proof", {}).get("case") == requirement.case
        ]
        observation_results: list[dict[str, Any]] = []
        passing_records: list[dict[str, Any]] = []
        for observation, fields in _declared_observations(requirement).items():
            observation_candidates = [
                record
                for record in candidates
                if record.get("proof", {}).get("observation", "response") == observation
            ]
            passing = [record for record in observation_candidates if record.get("status") == "pass"]
            observed: dict[str, Any] = {}
            conflicts: set[str] = set()
            for record in passing:
                for name, value in record.get("extracted", {}).items():
                    if value is None:
                        continue
                    if name in observed and observed[name] != value:
                        conflicts.add(name)
                    else:
                        observed[name] = value
            missing = [name for name in fields if name not in observed]
            if conflicts:
                obs_status, obs_reason = "implementation_defect", (
                    f"passing {observation} observations disagree on: {', '.join(sorted(conflicts))}"
                )
            elif not observation_candidates:
                obs_status, obs_reason = "unverified", f"no operation was configured for observation {observation}"
            elif missing:
                obs_status, obs_reason = (
                    "unverified",
                    f"{observation} lacks evidence fields: {', '.join(missing)}",
                )
            elif passing:
                obs_status, obs_reason = "pass", None
            else:
                obs_status, obs_reason = aggregate_status(observation_candidates)
            observation_results.append(
                {
                    "name": observation,
                    "status": obs_status,
                    "reason": obs_reason,
                    "operation_ids": [record["id"] for record in passing]
                    or [record["id"] for record in observation_candidates],
                    "observed_fields": sorted(observed),
                }
            )
            if obs_status == "pass":
                passing_records.extend(passing)

        aggregate: dict[str, Any] = {}
        conflicts: set[str] = set()
        for record in passing_records:
            for name, value in record.get("extracted", {}).items():
                if value is None:
                    continue
                if name in aggregate and aggregate[name] != value:
                    conflicts.add(name)
                else:
                    aggregate[name] = value
        expected_errors: list[str] = []
        for field_name, expected in requirement.expected:
            if field_name not in aggregate:
                continue
            resolved = resolve_templates(expected, context or {})
            if aggregate[field_name] != resolved:
                expected_errors.append(
                    f"{field_name} expected {resolved!r}, got {aggregate[field_name]!r}"
                )
        observation_statuses = [item["status"] for item in observation_results]
        if conflicts:
            case_status, case_reason = "implementation_defect", (
                f"passing observations disagree on: {', '.join(sorted(conflicts))}"
            )
        elif expected_errors:
            case_status, case_reason = "implementation_defect", "; ".join(expected_errors)
        elif all(status == "pass" for status in observation_statuses):
            selected[requirement.identifier] = {
                "id": requirement.identifier,
                "extracted": aggregate,
                "operation_ids": [record["id"] for record in passing_records],
            }
            operation_ids.extend(record["id"] for record in passing_records)
            case_status, case_reason = "pass", None
        elif "implementation_defect" in observation_statuses:
            case_status, case_reason = "implementation_defect", "a named observation failed"
        elif "unverified" in observation_statuses:
            case_status, case_reason = "unverified", "one or more named observations lack proof"
        else:
            case_status, case_reason = "unsupported", "one or more named observations are unsupported"
        selected_ids = [record["id"] for record in passing_records]
        operation_ids.extend(
            record["id"] for record in candidates if record["id"] not in operation_ids and not selected_ids
        )
        coverage.append(
            {
                "requirement": requirement.identifier,
                "role": requirement.role,
                "case": requirement.case,
                "status": case_status,
                "reason": case_reason,
                "operation_ids": selected_ids
                or [record["id"] for record in candidates],
                "observed_fields": sorted(aggregate),
                "observations": observation_results,
            }
        )

    relations: list[dict[str, Any]] = []
    for relation in scenario.relations:
        left = selected.get(relation.left)
        right = selected.get(relation.right)
        detail: dict[str, Any] = {
            "kind": relation.kind,
            "left": relation.left,
            "right": relation.right,
            "fields": list(relation.fields),
        }
        if left is None or right is None:
            detail.update(
                {
                    "status": "unverified",
                    "reason": "both related passing cases are required",
                }
            )
        else:
            left_values = left.get("extracted", {})
            right_values = right.get("extracted", {})
            missing = [
                field
                for field in relation.fields
                if left_values.get(field) is None or right_values.get(field) is None
            ]
            if missing:
                detail.update(
                    {
                        "status": "unverified",
                        "reason": f"related evidence is missing: {', '.join(missing)}",
                    }
                )
            elif relation.kind == "equal":
                mismatched = [
                    field for field in relation.fields if left_values[field] != right_values[field]
                ]
                detail.update(
                    {
                        "status": "implementation_defect" if mismatched else "pass",
                        "reason": (
                            f"related IDs differ: {', '.join(mismatched)}" if mismatched else None
                        ),
                    }
                )
            elif relation.kind == "distinct":
                same = all(left_values[field] == right_values[field] for field in relation.fields)
                detail.update(
                    {
                        "status": "implementation_defect" if same else "pass",
                        "reason": "related cases unexpectedly reused every identity" if same else None,
                    }
                )
            else:
                detail.update({"status": "implementation_defect", "reason": "unknown relation kind"})
        relations.append(detail)

    coverage_statuses = [item["status"] for item in coverage]
    relation_statuses = [item["status"] for item in relations]
    if "implementation_defect" in coverage_statuses or "implementation_defect" in relation_statuses:
        status, reason = "implementation_defect", "a required case or identity relation failed"
    elif "unverified" in coverage_statuses or "unverified" in relation_statuses:
        status, reason = "unverified", "one or more required semantic cases lack proof"
    elif "unsupported" in coverage_statuses or "unsupported" in relation_statuses:
        status, reason = "unsupported", "one or more required semantic cases are unsupported"
    else:
        status, reason = "pass", None
    return status, reason, operation_ids, coverage, relations


class AcceptanceRunner:
    def __init__(
        self,
        config: dict[str, Any],
        transport: Transport | None = None,
        now: str | None = None,
    ):
        self.config = validate_config(config)
        self.target = self.config["target"]
        self.mode = self.config["mode"]
        self.transport = transport or NetworkTransport(self.target)
        self.now = now or utc_now()
        self.records: list[dict[str, Any]] = []
        self.preflight: list[dict[str, Any]] = []
        self.observed_bindings: list[dict[str, Any]] = []
        self.observed: dict[str, dict[str, Any]] = {}
        self.preflight_blocked = False

    def _context(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "binding": self.target["bindings"],
            "vars": self.config.get("vars", {}),
            "observed": self.observed,
            "mode": self.mode,
        }

    def _token(self, actor: str) -> str | None:
        oauth = self.config["oauth"]
        if actor == "none":
            return None
        if actor == "admin":
            return load_credential(
                oauth.get("admin_access_token_env"),
                oauth.get("admin_access_token_file"),
            )
        return load_credential(oauth.get("access_token_env"), oauth.get("access_token_file"))

    def _preflight_request(self, identifier: str, path: str, url: str | None = None) -> HttpResponse:
        absolute_get = getattr(self.transport, "absolute_get", None)
        response = (
            absolute_get(url)
            if url is not None and callable(absolute_get)
            else self.transport.rest("GET", path, {}, None, None)
        )
        status = "pass" if response.error is None and response.status == 200 else "unverified"
        reason = response.error or (None if status == "pass" else f"metadata returned HTTP {response.status}")
        if status == "pass" and path.endswith("oauth-protected-resource"):
            observed = json_pointer(response.body, "/resource")
            authorities = json_pointer(response.body, "/authorization_servers")
            if observed != self.target["resource"]:
                status = "implementation_defect"
                reason = f"resource metadata is {observed!r}, expected {self.target['resource']!r}"
            elif (
                not isinstance(authorities, list)
                or not authorities
                or any(not isinstance(authority, str) or not is_absolute_url(authority) for authority in authorities)
            ):
                status = "implementation_defect"
                reason = "protected-resource metadata has no valid authorization server"
            elif any(urllib.parse.urlsplit(authority).scheme != "https" for authority in authorities):
                status = "implementation_defect"
                reason = "protected-resource metadata contains a non-HTTPS authorization server"
        if status == "pass" and path.endswith("oauth-authorization-server"):
            for field_name in ("issuer", "authorization_endpoint", "token_endpoint"):
                value = json_pointer(response.body, f"/{field_name}")
                if not isinstance(value, str) or not is_absolute_url(value):
                    status = "implementation_defect"
                    reason = f"authorization metadata is missing {field_name}"
                    break
                try:
                    validate_oauth_endpoint(value, f"authorization metadata {field_name}")
                except ConfigError as error:
                    status = "implementation_defect"
                    reason = str(error)
                    break
            methods = json_pointer(response.body, "/code_challenge_methods_supported")
            if status == "pass" and (not isinstance(methods, list) or "S256" not in methods):
                status = "implementation_defect"
                reason = "authorization metadata does not advertise PKCE S256"
        self.preflight.append(
            {
                "id": identifier,
                "path": path,
                "status": status,
                "reason": reason,
                "evidence_class": self.mode,
                "response": response_summary(response),
            }
        )
        return response

    def run_preflight(self) -> None:
        if self.config.get("preflight", {}).get("enabled", True) is False:
            self.preflight.append(
                {
                    "id": "oauth-metadata",
                    "path": None,
                    "status": "unverified",
                    "reason": "preflight was disabled for a controlled run",
                    "evidence_class": self.mode,
                    "response": None,
                }
            )
            return
        protected = self._preflight_request(
            "protected-resource-metadata", "/.well-known/oauth-protected-resource"
        )
        authority = self.config["oauth"].get("authorization_server")
        if not authority:
            discovered = json_pointer(protected.body, "/authorization_servers/0")
            if isinstance(discovered, str):
                authority = discovered
        if authority:
            metadata = (
                authority
                if authority.endswith(".well-known/oauth-authorization-server")
                else authority.rstrip("/") + "/.well-known/oauth-authorization-server"
            )
            path = urllib.parse.urlsplit(metadata).path or "/.well-known/oauth-authorization-server"
            self._preflight_request(
                "authorization-server-metadata",
                path,
                metadata,
            )
        else:
            self._preflight_request(
                "authorization-server-metadata",
                "/.well-known/oauth-authorization-server",
            )

    def execute_operation(self, operation: dict[str, Any]) -> dict[str, Any]:
        identifier = operation["id"]
        actor = operation.get("actor", "agent")
        token = self._token(actor)
        context = self._context()
        request = resolve_templates(operation["request"], context)
        transport_name = operation["transport"]
        request_summary: dict[str, Any] = {"transport": transport_name}
        if transport_name == "rest":
            method = str(request["method"]).upper()
            path = request["path"]
            query = request.get("query", {})
            body = request.get("body")
            request_headers = request.get("headers", {})
            request_summary.update(
                {
                    "method": method,
                    "path": path,
                    "query": redact(query),
                    "headers": redact(request_headers),
                    "body_present": body is not None,
                    "body_type": (
                        "object"
                        if isinstance(body, dict)
                        else type(body).__name__ if body is not None else "null"
                    ),
                    "body_keys": sorted(body) if isinstance(body, dict) else [],
                    "body_sha256": sha256_json(body) if body is not None else None,
                }
            )
        else:
            tool = request.get("tool")
            arguments = request.get("arguments", {})
            request_summary.update(
                {
                    "method": request.get("method", "tools/call"),
                    "tool": tool,
                    "arguments_sha256": sha256_json(arguments),
                }
            )

        base_record: dict[str, Any] = {
            "id": identifier,
            "scenario": operation["scenario"],
            "ticket": list(SCENARIO_BY_ID[operation["scenario"]].tickets),
            "actor": actor,
            "transport": transport_name,
            "evidence_class": self.mode,
            "bindings": _binding_snapshot(self.target),
            "proof": redact(operation["proof"]),
            "request": request_summary,
            "evidence": redact(operation["evidence"]),
        }
        if self.preflight_blocked:
            base_record.update(
                {
                    "status": "unverified",
                    "reason": "live operation blocked because OAuth metadata preflight did not pass",
                    "response": None,
                    "extracted": {},
                }
            )
            self.records.append(base_record)
            return base_record
        if token is None and actor != "none":
            env_or_file = (
                self.config["oauth"].get("admin_access_token_env")
                if actor == "admin"
                else self.config["oauth"].get("access_token_env")
            ) or (
                self.config["oauth"].get("admin_access_token_file")
                if actor == "admin"
                else self.config["oauth"].get("access_token_file")
            )
            base_record.update(
                {
                    "status": "unverified",
                    "reason": f"credential source is empty: {env_or_file}",
                    "response": None,
                    "extracted": {},
                }
            )
            self.records.append(base_record)
            return base_record

        if transport_name == "rest":
            response = self.transport.rest(
                request["method"],
                request["path"],
                request.get("query", {}),
                request.get("body"),
                token,
                request.get("headers", {}),
            )
        else:
            response = self.transport.mcp(request, token, self.target["client"])
        status, reason, extracted = classify_response(response, operation, context, request)
        if status == "pass" and extracted:
            self.observed[identifier] = dict(extracted)
            for name, value in extracted.items():
                if not (
                    name == "resource"
                    or name == "sha256"
                    or name.endswith("_id")
                    or name.endswith("_digest")
                ):
                    continue
                observation = {"operation": identifier, "name": name, "value": value}
                if observation not in self.observed_bindings:
                    self.observed_bindings.append(observation)
        base_record.update(
            {
                "status": status,
                "reason": reason,
                "response": response_summary(response),
                "extracted": extracted,
            }
        )
        self.records.append(base_record)
        return base_record

    def run(self) -> dict[str, Any]:
        started = self.now
        if self.mode not in RUN_MODES:
            raise ConfigError("fixture evidence can only be validated, not executed")
        self.run_preflight()
        self.preflight_blocked = self.mode == "live_client" and any(
            item.get("status") != "pass" for item in self.preflight
        )
        for operation in self.config["operations"]:
            self.execute_operation(operation)
        scenarios: list[dict[str, Any]] = []
        for scenario in SCENARIOS:
            records = [record for record in self.records if record["scenario"] == scenario.identifier]
            status, reason, operation_ids, coverage, relations = evaluate_scenario(
                scenario, records, self._context()
            )
            scenarios.append(
                {
                    "id": scenario.identifier,
                    "tickets": list(scenario.tickets),
                    "title": scenario.title,
                    "status": status,
                    "reason": reason,
                    "operation_ids": operation_ids,
                    "coverage": coverage,
                    "relations": relations,
                    "evidence_class": self.mode,
                }
            )
        preflight_passed = self.mode != "live_client" or all(
            item.get("status") == "pass" for item in self.preflight
        )
        all_passed = preflight_passed and all(scenario["status"] == "pass" for scenario in scenarios)
        target = self.target
        bundle: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "run": {
                "run_id": self.config.get("run_id", f"acceptance-{secrets.token_hex(8)}"),
                "started_at": started,
                "finished_at": utc_now(),
                "status": "complete" if all_passed else "incomplete",
                "mode": self.mode,
                "environment": self.config.get("environment", "unspecified"),
                "source_commit": self.config.get("source_commit"),
                "client": redact(target["client"]),
                "provider": redact(target["provider"]),
                "resource": target["resource"],
                "bindings": _binding_snapshot(target),
                "observed_bindings": self.observed_bindings,
            },
            "preflight": self.preflight,
            "operations": self.records,
            "scenarios": scenarios,
            "controls": {
                "credentials_redacted": True,
                "raw_message_bodies_stored": False,
                "provider_delivery_claimed_from_http_success": False,
                "fixture_evidence_is_client_proof": False,
                "live_actions_requested_by_harness": bool(self.records),
            },
        }
        validate_bundle(bundle)
        return bundle


def _require_object_keys(
    value: Any,
    required: set[str],
    optional: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be an object")
    keys = set(value)
    missing = required - keys
    extra = keys - required - optional
    if missing:
        raise EvidenceError(f"{label} is missing: {', '.join(sorted(missing))}")
    if extra:
        raise EvidenceError(f"{label} has unsupported fields: {', '.join(sorted(extra))}")
    return value


def _validate_bundle_bindings(value: Any, label: str) -> None:
    bindings = _require_object_keys(
        value,
        {
            "resource",
            "tenant_id",
            "installation_id",
            "grant_ids",
            "account_ids",
            "chat_ids",
            "connection_ids",
            "provider_account_ids",
            "identity_ids",
        },
        set(),
        label,
    )
    for key in ("resource", "tenant_id", "installation_id"):
        if not isinstance(bindings[key], str):
            raise EvidenceError(f"{label}.{key} must be a string")
    for key in (
        "grant_ids",
        "account_ids",
        "chat_ids",
        "connection_ids",
        "provider_account_ids",
        "identity_ids",
    ):
        if not isinstance(bindings[key], list) or any(
            not isinstance(item, str) for item in bindings[key]
        ):
            raise EvidenceError(f"{label}.{key} must be an array of strings")


def _validate_bundle_response(value: Any, label: str) -> None:
    if value is None:
        return
    response = _require_object_keys(
        value,
        set(),
        {
            "http_status",
            "body_sha256",
            "headers",
            "error",
            "jsonrpc_error",
            "jsonrpc_version",
            "jsonrpc_id",
            "jsonrpc_request_id",
            "jsonrpc_has_result",
        },
        label,
    )
    if response.get("http_status") is not None and not isinstance(response["http_status"], int):
        raise EvidenceError(f"{label}.http_status must be an integer or null")
    if response.get("body_sha256") is not None and (
        not isinstance(response["body_sha256"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", response["body_sha256"])
    ):
        raise EvidenceError(f"{label}.body_sha256 must be a SHA-256 digest or null")
    if "headers" in response and (
        not isinstance(response["headers"], dict)
        or any(not isinstance(key, str) or not isinstance(item, str) for key, item in response["headers"].items())
    ):
        raise EvidenceError(f"{label}.headers must map strings to strings")
    if "error" in response and not isinstance(response["error"], str):
        raise EvidenceError(f"{label}.error must be a string")
    if "jsonrpc_error" in response and not isinstance(response["jsonrpc_error"], dict):
        raise EvidenceError(f"{label}.jsonrpc_error must be an object")
    if "jsonrpc_version" in response and response["jsonrpc_version"] is not None and not isinstance(response["jsonrpc_version"], str):
        raise EvidenceError(f"{label}.jsonrpc_version must be a string or null")
    if "jsonrpc_id" in response and response["jsonrpc_id"] is not None and not isinstance(response["jsonrpc_id"], (str, int)):
        raise EvidenceError(f"{label}.jsonrpc_id must be a scalar or null")
    if "jsonrpc_request_id" in response and response["jsonrpc_request_id"] is not None and not isinstance(response["jsonrpc_request_id"], (str, int)):
        raise EvidenceError(f"{label}.jsonrpc_request_id must be a scalar or null")
    if "jsonrpc_has_result" in response and not isinstance(response["jsonrpc_has_result"], bool):
        raise EvidenceError(f"{label}.jsonrpc_has_result must be a boolean")


def _validate_bundle_request(value: Any, label: str, transport: str) -> None:
    if transport == "rest":
        request = _require_object_keys(
            value,
            {
                "transport",
                "method",
                "path",
                "query",
                "headers",
                "body_present",
                "body_type",
                "body_keys",
                "body_sha256",
            },
            set(),
            label,
        )
        if request["transport"] != "rest":
            raise EvidenceError(f"{label}.transport does not match the operation")
        if not isinstance(request["method"], str) or not request["method"]:
            raise EvidenceError(f"{label}.method must be a non-empty string")
        if (
            not isinstance(request["path"], str)
            or not request["path"].startswith("/")
            or is_absolute_url(request["path"])
        ):
            raise EvidenceError(f"{label}.path must be a relative path")
        if not isinstance(request["query"], dict):
            raise EvidenceError(f"{label}.query must be an object")
        try:
            _safe_transport_headers(request["headers"])
        except ConfigError as error:
            raise EvidenceError(f"{label}.headers: {error}") from error
        if not isinstance(request["body_present"], bool):
            raise EvidenceError(f"{label}.body_present must be a boolean")
        if not isinstance(request["body_type"], str) or not request["body_type"]:
            raise EvidenceError(f"{label}.body_type must be a non-empty string")
        if not isinstance(request["body_keys"], list) or any(
            not isinstance(key, str) for key in request["body_keys"]
        ):
            raise EvidenceError(f"{label}.body_keys must be an array of strings")
        if request["body_keys"] != sorted(set(request["body_keys"])):
            raise EvidenceError(f"{label}.body_keys must be sorted and unique")
        digest = request["body_sha256"]
        if digest is not None and (
            not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            raise EvidenceError(f"{label}.body_sha256 must be a SHA-256 digest or null")
        if request["body_present"]:
            if request["body_type"] == "null" or digest is None:
                raise EvidenceError(f"{label} does not prove the declared JSON body")
        elif request["body_type"] != "null" or request["body_keys"] or digest is not None:
            raise EvidenceError(f"{label} contains body metadata for an absent body")
        return

    request = _require_object_keys(
        value,
        {"transport", "method", "tool", "arguments_sha256"},
        set(),
        label,
    )
    if request["transport"] != "mcp":
        raise EvidenceError(f"{label}.transport does not match the operation")
    if not isinstance(request["method"], str) or not request["method"]:
        raise EvidenceError(f"{label}.method must be a non-empty string")
    if request["tool"] is not None and not isinstance(request["tool"], str):
        raise EvidenceError(f"{label}.tool must be a string or null")
    if request["tool"] is None and request["method"] not in {
        "initialize",
        "tools/list",
        "resources/list",
    }:
        raise EvidenceError(f"{label} has no tool for its MCP method")
    if request["tool"] is not None and request["method"] != "tools/call":
        raise EvidenceError(f"{label}.method must be tools/call for a named tool")
    if not isinstance(request["arguments_sha256"], str) or not re.fullmatch(
        r"[0-9a-f]{64}", request["arguments_sha256"]
    ):
        raise EvidenceError(f"{label}.arguments_sha256 must be a SHA-256 digest")


def _validate_passing_response(
    response: Any,
    label: str,
    requirement: Requirement | None = None,
    transport: str | None = None,
) -> None:
    if response is None:
        raise EvidenceError(f"{label} is required for a passing operation")
    _validate_bundle_response(response, label)
    if not isinstance(response, dict):
        raise EvidenceError(f"{label} must be an object")
    status = response.get("http_status")
    digest = response.get("body_sha256")
    if not isinstance(status, int):
        raise EvidenceError(f"{label}.http_status must be an integer")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise EvidenceError(f"{label}.body_sha256 is required for passing evidence")
    if response.get("error") is not None or response.get("jsonrpc_error") is not None:
        raise EvidenceError(f"{label} contains a transport or JSON-RPC error")
    if requirement is not None and requirement.statuses:
        if status not in requirement.statuses:
            raise EvidenceError(f"{label}.http_status is outside the declared requirement statuses")
    elif not 200 <= status < 300:
        raise EvidenceError(f"{label}.http_status must be a successful HTTP status")
    if transport == "mcp":
        if response.get("jsonrpc_version") != "2.0":
            raise EvidenceError(f"{label} does not prove JSON-RPC 2.0")
        if response.get("jsonrpc_id") is None or response.get("jsonrpc_has_result") is not True:
            raise EvidenceError(f"{label} does not prove a matching JSON-RPC result")
        if (
            response.get("jsonrpc_request_id") is not None
            and response.get("jsonrpc_id") != response.get("jsonrpc_request_id")
        ):
            raise EvidenceError(f"{label} JSON-RPC id does not match the request")


def validate_bundle(bundle: dict[str, Any]) -> None:
    _require_object_keys(
        bundle,
        {"schema_version", "run", "preflight", "operations", "scenarios", "controls"},
        set(),
        "bundle",
    )
    if bundle["schema_version"] != SCHEMA_VERSION:
        raise EvidenceError(f"schema_version must be {SCHEMA_VERSION}")
    run = _require_object_keys(
        bundle["run"],
        {
            "run_id",
            "started_at",
            "finished_at",
            "status",
            "mode",
            "environment",
            "client",
            "provider",
            "resource",
            "bindings",
            "observed_bindings",
        },
        {"source_commit"},
        "run",
    )
    if run["mode"] not in RUN_MODES or run["status"] not in {"complete", "incomplete"}:
        raise EvidenceError("run.mode or run.status is invalid")
    for key in ("run_id", "started_at", "finished_at", "environment", "resource"):
        if not isinstance(run[key], str) or not run[key]:
            raise EvidenceError(f"run.{key} must be a non-empty string")
    if "source_commit" in run and run["source_commit"] is not None and not isinstance(run["source_commit"], str):
        raise EvidenceError("run.source_commit must be a string or null")
    client = _require_object_keys(run["client"], {"surface", "name", "version", "transport"}, set(), "run.client")
    if any(not isinstance(client[key], str) or not client[key] for key in ("surface", "name", "version")):
        raise EvidenceError("run.client names and version must be non-empty strings")
    if client["transport"] not in {"rest", "mcp", "both"}:
        raise EvidenceError("run.client.transport is invalid")
    provider = _require_object_keys(
        run["provider"],
        {"name", "version", "adapter_version", "proof_source"},
        set(),
        "run.provider",
    )
    if any(not isinstance(provider[key], str) or not provider[key] for key in provider):
        raise EvidenceError("run.provider values must be non-empty strings")
    _validate_bundle_bindings(run["bindings"], "run.bindings")
    if not isinstance(run["observed_bindings"], list):
        raise EvidenceError("run.observed_bindings must be an array")
    for index, observed in enumerate(run["observed_bindings"]):
        item = _require_object_keys(observed, {"operation", "name", "value"}, set(), f"run.observed_bindings[{index}]")
        if not isinstance(item["operation"], str) or not isinstance(item["name"], str):
            raise EvidenceError(f"run.observed_bindings[{index}] has invalid values")
        try:
            _safe_evidence_value(item["name"], item["value"])
        except EvidenceError as error:
            raise EvidenceError(f"run.observed_bindings[{index}]: {error}") from error

    preflight = bundle["preflight"]
    if not isinstance(preflight, list):
        raise EvidenceError("preflight must be an array")
    for index, item in enumerate(preflight):
        record = _require_object_keys(
            item,
            {"id", "status", "evidence_class", "response"},
            {"path", "reason"},
            f"preflight[{index}]",
        )
        if not isinstance(record["id"], str) or record["status"] not in EVIDENCE_STATUSES:
            raise EvidenceError(f"preflight[{index}] has invalid identity or status")
        if record["evidence_class"] != run["mode"]:
            raise EvidenceError(f"preflight[{index}].evidence_class is invalid")
        if "path" in record and record["path"] is not None and not isinstance(record["path"], str):
            raise EvidenceError(f"preflight[{index}].path must be a string or null")
        if "reason" in record and record["reason"] is not None and not isinstance(record["reason"], str):
            raise EvidenceError(f"preflight[{index}].reason must be a string or null")
        _validate_bundle_response(record["response"], f"preflight[{index}].response")
        if record["status"] == "pass":
            _validate_passing_response(record["response"], f"preflight[{index}].response")

    records = bundle["operations"]
    if not isinstance(records, list):
        raise EvidenceError("operations must be an array")
    records_by_id: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(records):
        record = _require_object_keys(
            item,
            {
                "id",
                "scenario",
                "ticket",
                "actor",
                "transport",
                "evidence_class",
                "bindings",
                "proof",
                "request",
                "evidence",
                "status",
                "reason",
                "response",
                "extracted",
            },
            set(),
            f"operations[{index}]",
        )
        if not isinstance(record["id"], str) or record["id"] in records_by_id:
            raise EvidenceError(f"operations[{index}].id must be unique")
        records_by_id[record["id"]] = record
        scenario = SCENARIO_BY_ID.get(record["scenario"])
        if scenario is None:
            raise EvidenceError(f"operations[{index}] uses an unknown scenario")
        if record["ticket"] != list(scenario.tickets):
            raise EvidenceError(f"operations[{index}].ticket does not match its scenario")
        if record["actor"] not in {"agent", "admin", "none"} or record["transport"] not in {"rest", "mcp"}:
            raise EvidenceError(f"operations[{index}] actor or transport is invalid")
        if record["evidence_class"] != run["mode"] or record["status"] not in EVIDENCE_STATUSES:
            raise EvidenceError(f"operations[{index}] evidence class or status is invalid")
        _validate_bundle_bindings(record["bindings"], f"operations[{index}].bindings")
        if record["bindings"] != run["bindings"]:
            raise EvidenceError(f"operations[{index}].bindings do not match the run binding snapshot")
        proof = _require_object_keys(
            record["proof"], {"role", "case"}, {"observation"}, f"operations[{index}].proof"
        )
        requirement = REQUIREMENT_BY_KEY.get((record["scenario"], proof["case"]))
        if requirement is None or proof["role"] != requirement.role:
            raise EvidenceError(f"operations[{index}] proof is not a declared requirement")
        if record["transport"] not in requirement.transports or record["actor"] not in requirement.actors:
            raise EvidenceError(f"operations[{index}] proof transport or actor is invalid")
        if not isinstance(record["request"], dict) or not isinstance(record["evidence"], dict) or not isinstance(record["extracted"], dict):
            raise EvidenceError(f"operations[{index}] request or extracted is invalid")
        _validate_bundle_request(
            record["request"], f"operations[{index}].request", record["transport"]
        )
        if record["reason"] is not None and not isinstance(record["reason"], str):
            raise EvidenceError(f"operations[{index}].reason must be a string or null")
        _validate_bundle_response(record["response"], f"operations[{index}].response")
        observation = proof.get("observation", "response")
        observation_fields = _observation_fields(requirement, observation)
        if not observation_fields:
            raise EvidenceError(f"operations[{index}] uses an undeclared proof observation")
        if set(record["extracted"]) - set(observation_fields):
            raise EvidenceError(f"operations[{index}] contains evidence outside its proof observation")
        if record["status"] == "pass" and not record["extracted"]:
            raise EvidenceError(f"operations[{index}] claims pass without observed evidence")
        evidence = _require_object_keys(
            record["evidence"], {"extract", "required"}, set(), f"operations[{index}].evidence"
        )
        extract = evidence["extract"]
        required = evidence["required"]
        if not isinstance(extract, dict) or not isinstance(required, list):
            raise EvidenceError(f"operations[{index}].evidence has invalid shape")
        for name, pointer in extract.items():
            if not isinstance(name, str) or name not in observation_fields:
                raise EvidenceError(f"operations[{index}].evidence.extract contains an undeclared field")
            try:
                _validate_extract_spec(pointer, f"operations[{index}].evidence.extract.{name}")
            except ConfigError as error:
                raise EvidenceError(str(error)) from error
        if set(record["extracted"]) - set(extract):
            raise EvidenceError(f"operations[{index}].extracted contains a field absent from evidence.extract")
        if (
            not required
            or any(not isinstance(name, str) or name not in extract for name in required)
            or len(set(required)) != len(required)
        ):
            raise EvidenceError(f"operations[{index}].evidence.required is invalid")
        request_summary = record["request"]
        contract_request = (
            {
                "method": request_summary.get("method"),
                "path": request_summary.get("path"),
                "headers": request_summary.get("headers", {}),
                "body_present": request_summary.get("body_present", False),
                "body_type": request_summary.get("body_type", "unknown"),
                "body_keys": request_summary.get("body_keys", []),
            }
            if record["transport"] == "rest"
            else {"method": request_summary.get("method"), "tool": request_summary.get("tool")}
        )
        contract_errors = _request_contract_errors(
            requirement,
            record["scenario"],
            contract_request,
            record["transport"],
            observation,
        )
        evidence_contract_errors = _evidence_contract_errors(
            requirement,
            record["scenario"],
            observation,
            contract_request,
            record["transport"],
            extract,
        )
        if record["status"] == "pass" and (contract_errors or evidence_contract_errors):
            raise EvidenceError(f"operations[{index}] claims pass outside its request contract")
        if record["status"] == "pass":
            _validate_passing_response(
                record["response"],
                f"operations[{index}].response",
                requirement,
                record["transport"],
            )
        for name, value in record["extracted"].items():
            try:
                _safe_evidence_value(name, value)
            except EvidenceError as error:
                raise EvidenceError(f"operations[{index}]: {error}") from error

    scenarios = bundle["scenarios"]
    if not isinstance(scenarios, list) or {item.get("id") for item in scenarios if isinstance(item, dict)} != set(SCENARIO_BY_ID):
        raise EvidenceError("bundle must contain exactly the declared acceptance scenarios")
    if len(scenarios) != len(SCENARIOS):
        raise EvidenceError("bundle contains duplicate or missing scenarios")
    for index, item in enumerate(scenarios):
        scenario_record = _require_object_keys(
            item,
            {"id", "tickets", "title", "status", "reason", "operation_ids", "coverage", "relations", "evidence_class"},
            set(),
            f"scenarios[{index}]",
        )
        scenario = SCENARIO_BY_ID[scenario_record["id"]]
        if scenario_record["tickets"] != list(scenario.tickets) or scenario_record["title"] != scenario.title:
            raise EvidenceError(f"scenarios[{index}] metadata does not match the contract")
        if scenario_record["status"] not in EVIDENCE_STATUSES or scenario_record["evidence_class"] != run["mode"]:
            raise EvidenceError(f"scenarios[{index}] status or evidence class is invalid")
        if scenario_record["reason"] is not None and not isinstance(scenario_record["reason"], str):
            raise EvidenceError(f"scenarios[{index}].reason must be a string or null")
        if not isinstance(scenario_record["operation_ids"], list) or any(
            operation_id not in records_by_id for operation_id in scenario_record["operation_ids"]
        ):
            raise EvidenceError(f"scenarios[{index}].operation_ids references an unknown operation")
        coverage = scenario_record["coverage"]
        if not isinstance(coverage, list) or {item.get("requirement") for item in coverage if isinstance(item, dict)} != {
            requirement.identifier for requirement in scenario.requirements
        }:
            raise EvidenceError(f"scenarios[{index}] coverage does not name every requirement")
        coverage_values: dict[str, dict[str, Any]] = {}
        for case in coverage:
            coverage_record = _require_object_keys(
                case,
                {"requirement", "role", "case", "status", "reason", "operation_ids", "observed_fields", "observations"},
                set(),
                f"scenarios[{index}].coverage",
            )
            requirement = next(
                requirement for requirement in scenario.requirements if requirement.identifier == coverage_record["requirement"]
            )
            if coverage_record["role"] != requirement.role or coverage_record["case"] != requirement.case:
                raise EvidenceError(f"scenarios[{index}] coverage contract mismatch")
            if (
                coverage_record["status"] not in EVIDENCE_STATUSES
                or not isinstance(coverage_record["operation_ids"], list)
                or not isinstance(coverage_record["observed_fields"], list)
                or not isinstance(coverage_record["observations"], list)
                or any(not isinstance(name, str) for name in coverage_record["observed_fields"])
            ):
                raise EvidenceError(f"scenarios[{index}] coverage status is invalid")
            matching_records = [records_by_id.get(operation_id) for operation_id in coverage_record["operation_ids"]]
            if any(record is None for record in matching_records):
                raise EvidenceError(f"scenarios[{index}] coverage references an unknown operation")
            if any(
                record["scenario"] != scenario.identifier
                or record["proof"]["role"] != requirement.role
                or record["proof"]["case"] != requirement.case
                for record in matching_records
            ):
                raise EvidenceError(f"scenarios[{index}] coverage references the wrong requirement")
            passing_records = [record for record in matching_records if record["status"] == "pass"]
            observed_values: dict[str, Any] = {}
            conflicts: set[str] = set()
            for record in passing_records:
                for name, value in record["extracted"].items():
                    if value is None:
                        continue
                    if name in observed_values and observed_values[name] != value:
                        conflicts.add(name)
                    else:
                        observed_values[name] = value
            if coverage_record["observed_fields"] != sorted(observed_values):
                raise EvidenceError(f"scenarios[{index}] coverage observed_fields do not match passing operations")
            declared_observations = _declared_observations(requirement)
            if {item.get("name") for item in coverage_record["observations"] if isinstance(item, dict)} != set(declared_observations):
                raise EvidenceError(f"scenarios[{index}] coverage does not name every required observation")
            observation_values: dict[str, dict[str, Any]] = {}
            for observation_record in coverage_record["observations"]:
                observation_data = _require_object_keys(
                    observation_record,
                    {"name", "status", "reason", "operation_ids", "observed_fields"},
                    set(),
                    f"scenarios[{index}].coverage.observations",
                )
                observation = observation_data["name"]
                fields = declared_observations.get(observation)
                if fields is None or observation_data["status"] not in EVIDENCE_STATUSES:
                    raise EvidenceError(f"scenarios[{index}] coverage observation is invalid")
                observation_ids = observation_data["operation_ids"]
                if not isinstance(observation_ids, list):
                    raise EvidenceError(f"scenarios[{index}] coverage observation IDs are invalid")
                observation_records = [records_by_id.get(operation_id) for operation_id in observation_ids]
                if any(record is None for record in observation_records):
                    raise EvidenceError(f"scenarios[{index}] coverage observation references an unknown operation")
                if any(
                    record["proof"].get("observation", "response") != observation
                    for record in observation_records
                ):
                    raise EvidenceError(f"scenarios[{index}] coverage observation references the wrong source")
                observation_passing = [record for record in observation_records if record["status"] == "pass"]
                values: dict[str, Any] = {}
                observation_conflicts: set[str] = set()
                for record in observation_passing:
                    for name, value in record["extracted"].items():
                        if value is None:
                            continue
                        if name in values and values[name] != value:
                            observation_conflicts.add(name)
                        else:
                            values[name] = value
                if observation_data["observed_fields"] != sorted(values):
                    raise EvidenceError(f"scenarios[{index}] observation fields do not match passing operations")
                if observation_data["status"] == "pass":
                    if not observation_records or any(record["status"] != "pass" for record in observation_records):
                        raise EvidenceError(f"scenarios[{index}] observation claims pass without passing evidence")
                    if set(fields) - set(values):
                        raise EvidenceError(f"scenarios[{index}] observation claims pass without complete fields")
                    if observation_conflicts:
                        raise EvidenceError(f"scenarios[{index}] observation has conflicting fields")
                observation_values[observation] = values
            if coverage_record["status"] == "pass" and (
                not matching_records or any(record["status"] != "pass" for record in matching_records)
            ):
                raise EvidenceError(f"scenarios[{index}] coverage claims pass without passing evidence")
            if coverage_record["status"] == "pass":
                missing = set(requirement.evidence) - set(observed_values)
                if missing:
                    raise EvidenceError(
                        f"scenarios[{index}] coverage claims pass without fields: {', '.join(sorted(missing))}"
                    )
                if conflicts:
                    raise EvidenceError(
                        f"scenarios[{index}] coverage has conflicting fields: {', '.join(sorted(conflicts))}"
                    )
                if any(item["status"] != "pass" for item in coverage_record["observations"]):
                    raise EvidenceError(f"scenarios[{index}] coverage claims pass without complete observations")
            elif conflicts:
                raise EvidenceError(
                    f"scenarios[{index}] coverage has conflicting passing fields: {', '.join(sorted(conflicts))}"
                )
            coverage_values[coverage_record["requirement"]] = observed_values
        coverage_by_requirement = {case["requirement"]: case for case in coverage}
        relations = scenario_record["relations"]
        if not isinstance(relations, list) or len(relations) != len(scenario.relations):
            raise EvidenceError(f"scenarios[{index}] relation coverage is incomplete")
        for relation_record, relation in zip(relations, scenario.relations):
            relation_data = _require_object_keys(
                relation_record,
                {"kind", "left", "right", "fields", "status", "reason"},
                set(),
                f"scenarios[{index}].relations",
            )
            if (
                relation_data["kind"],
                relation_data["left"],
                relation_data["right"],
                relation_data["fields"],
            ) != (relation.kind, relation.left, relation.right, list(relation.fields)):
                raise EvidenceError(f"scenarios[{index}] relation contract mismatch")
            if relation_data["status"] not in EVIDENCE_STATUSES:
                raise EvidenceError(f"scenarios[{index}] relation status is invalid")
            left_coverage = coverage_by_requirement[relation.left]
            right_coverage = coverage_by_requirement[relation.right]
            left_values = coverage_values[relation.left]
            right_values = coverage_values[relation.right]
            if relation_data["status"] == "pass":
                if left_coverage["status"] != "pass" or right_coverage["status"] != "pass":
                    raise EvidenceError(f"scenarios[{index}] relation passes without passing cases")
                if any(field not in left_values or field not in right_values for field in relation.fields):
                    raise EvidenceError(f"scenarios[{index}] relation passes without relation fields")
                if relation.kind == "equal" and any(left_values[field] != right_values[field] for field in relation.fields):
                    raise EvidenceError(f"scenarios[{index}] equal relation does not hold")
                if relation.kind == "distinct" and all(left_values[field] == right_values[field] for field in relation.fields):
                    raise EvidenceError(f"scenarios[{index}] distinct relation does not hold")
        if scenario_record["status"] == "pass":
            if any(case["status"] != "pass" for case in coverage) or any(
                relation["status"] != "pass" for relation in relations
            ):
                raise EvidenceError(f"scenario {scenario.identifier} claims pass without complete semantic coverage")
            if not scenario_record["operation_ids"] or any(
                records_by_id[operation_id]["status"] != "pass"
                for operation_id in scenario_record["operation_ids"]
            ):
                raise EvidenceError(f"scenario {scenario.identifier} claims pass without passing operations")

    controls = _require_object_keys(
        bundle["controls"],
        {
            "credentials_redacted",
            "raw_message_bodies_stored",
            "provider_delivery_claimed_from_http_success",
            "fixture_evidence_is_client_proof",
            "live_actions_requested_by_harness",
        },
        set(),
        "controls",
    )
    if controls["credentials_redacted"] is not True or controls["raw_message_bodies_stored"] is not False:
        raise EvidenceError("controls do not guarantee credential and message redaction")
    if controls["provider_delivery_claimed_from_http_success"] is not False or controls["fixture_evidence_is_client_proof"] is not False:
        raise EvidenceError("controls permit an unsupported delivery or fixture claim")
    if not isinstance(controls["live_actions_requested_by_harness"], bool):
        raise EvidenceError("controls.live_actions_requested_by_harness must be boolean")
    if run["mode"] == "live_client" and run["status"] == "complete" and any(
        item["status"] != "pass" for item in preflight
    ):
        raise EvidenceError("live complete bundle has a failed OAuth preflight")
    if run["status"] == "complete" and any(item["status"] != "pass" for item in scenarios):
        raise EvidenceError("complete bundle has a non-passing scenario")
    serialized = json.dumps(bundle, ensure_ascii=False)
    if re.search(r"Bearer\s+[A-Za-z0-9._~-]{8,}", serialized, re.IGNORECASE):
        raise EvidenceError("bundle contains a bearer credential")
    for key in ("access_token", "refresh_token", "client_secret", "api_key"):
        if f'"{key}"' in serialized:
            raise EvidenceError(f"bundle contains {key}")


def write_bundle(path: Path, bundle: dict[str, Any]) -> None:
    validate_bundle(bundle)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def build_authorization_url(
    metadata: dict[str, Any],
    oauth: dict[str, Any],
    state: str,
    verifier: str,
    resource: str,
) -> str:
    endpoint = metadata.get("authorization_endpoint")
    if not isinstance(endpoint, str):
        raise ConfigError("authorization metadata has no valid authorization_endpoint")
    validate_oauth_endpoint(endpoint, "authorization_endpoint")
    methods = metadata.get("code_challenge_methods_supported")
    if not isinstance(methods, list) or "S256" not in methods:
        raise ConfigError("authorization metadata does not support PKCE S256")
    client_id = _require_string(oauth.get("client_id"), "oauth.client_id")
    redirect_uri = validate_redirect_uri(_require_string(oauth.get("redirect_uri"), "oauth.redirect_uri"))
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": oauth.get("scope", "communicator.read"),
        "state": state,
        "code_challenge": pkce_challenge(verifier),
        "code_challenge_method": "S256",
        "resource": resource,
    }
    return endpoint + "?" + urllib.parse.urlencode(params)


def metadata_url(config: dict[str, Any]) -> str:
    oauth = config["oauth"]
    authority = oauth.get("authorization_server")
    if authority:
        if authority.endswith(".well-known/oauth-authorization-server"):
            return authority
        return authority.rstrip("/") + "/.well-known/oauth-authorization-server"
    return config["target"]["base_url"].rstrip("/") + "/.well-known/oauth-authorization-server"


def fetch_json(url: str, timeout: float = 30.0) -> dict[str, Any]:
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with opener.open(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise ConfigError(f"cannot fetch OAuth metadata: {error}") from error
    if not isinstance(value, dict):
        raise ConfigError("OAuth metadata must be a JSON object")
    return value


def oauth_start(config: dict[str, Any], state_path: Path, timeout: float) -> str:
    metadata = fetch_json(metadata_url(config), timeout)
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    state_record = {
        "schema_version": 1,
        "state": state,
        "verifier": verifier,
        "resource": config["target"]["resource"],
        "metadata_url": metadata_url(config),
        "client_id": config["oauth"].get("client_id"),
        "redirect_uri": config["oauth"].get("redirect_uri"),
        "created_at": utc_now(),
    }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state_record, indent=2) + "\n", encoding="utf-8")
    state_path.chmod(0o600)
    return build_authorization_url(
        metadata,
        config["oauth"],
        state,
        verifier,
        config["target"]["resource"],
    )


def oauth_exchange(config: dict[str, Any], state_path: Path, redirect_url: str, output_path: Path, timeout: float) -> None:
    state_record = load_json(state_path)
    if not isinstance(state_record, dict):
        raise ConfigError("OAuth state file must contain an object")
    callback = urllib.parse.urlsplit(redirect_url)
    query = urllib.parse.parse_qs(callback.query)
    returned_state = query.get("state", [None])[0]
    code = query.get("code", [None])[0]
    if returned_state != state_record.get("state"):
        raise ConfigError("OAuth callback state does not match the protected state file")
    if not code:
        raise ConfigError("OAuth callback has no authorization code")
    metadata = fetch_json(str(state_record["metadata_url"]), timeout)
    token_endpoint = metadata.get("token_endpoint")
    if not isinstance(token_endpoint, str):
        raise ConfigError("authorization metadata has no valid token_endpoint")
    validate_oauth_endpoint(token_endpoint, "token_endpoint")
    configured_redirect = validate_redirect_uri(_require_string(state_record.get("redirect_uri"), "OAuth state redirect_uri"))
    if (callback.scheme, callback.netloc, callback.path) != (
        urllib.parse.urlsplit(configured_redirect).scheme,
        urllib.parse.urlsplit(configured_redirect).netloc,
        urllib.parse.urlsplit(configured_redirect).path,
    ):
        raise ConfigError("OAuth callback does not match the protected redirect URI")
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": state_record["client_id"],
        "redirect_uri": state_record["redirect_uri"],
        "code_verifier": state_record["verifier"],
        "resource": state_record["resource"],
    }
    client_secret_env = config["oauth"].get("client_secret_env")
    if client_secret_env:
        client_secret = os.environ.get(client_secret_env)
        if client_secret:
            form["client_secret"] = client_secret
    request = urllib.request.Request(
        token_endpoint,
        data=urllib.parse.urlencode(form).encode("ascii"),
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            token_response = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise ConfigError(f"OAuth token exchange failed: {error}") from error
    if not isinstance(token_response, dict) or not isinstance(token_response.get("access_token"), str):
        raise ConfigError("OAuth token response did not contain access_token")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(token_response["access_token"] + "\n", encoding="utf-8")
    output_path.chmod(0o600)


def dry_run_summary(config: dict[str, Any]) -> dict[str, Any]:
    configured = {operation["scenario"] for operation in config["operations"]}
    return {
        "mode": config["mode"],
        "client": redact(config["target"]["client"]),
        "provider": redact(config["target"]["provider"]),
        "resource": config["target"]["resource"],
        "configured_scenarios": sorted(configured),
        "missing_scenarios": sorted(set(SCENARIO_BY_ID) - configured),
        "network_requests": False,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="execute configured REST/MCP operations")
    run_parser.add_argument("--config", type=Path, required=True)
    run_parser.add_argument("--output", type=Path, required=True)
    run_parser.add_argument("--timeout", type=float, default=30.0)
    run_parser.add_argument("--dry-run", action="store_true")

    validate_parser = subparsers.add_parser("validate-evidence", help="validate an evidence JSON file")
    validate_parser.add_argument("--input", type=Path, required=True)

    start_parser = subparsers.add_parser("oauth-start", help="create a PKCE authorization URL")
    start_parser.add_argument("--config", type=Path, required=True)
    start_parser.add_argument("--state-file", type=Path, required=True)
    start_parser.add_argument("--timeout", type=float, default=30.0)

    exchange_parser = subparsers.add_parser("oauth-exchange", help="exchange a PKCE callback code")
    exchange_parser.add_argument("--config", type=Path, required=True)
    exchange_parser.add_argument("--state-file", type=Path, required=True)
    exchange_parser.add_argument("--redirect-url", required=True)
    exchange_parser.add_argument("--output-token", type=Path, required=True)
    exchange_parser.add_argument("--timeout", type=float, default=30.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "validate-evidence":
            bundle = load_json(args.input)
            if not isinstance(bundle, dict):
                raise EvidenceError("evidence must be a JSON object")
            validate_bundle(bundle)
            print(json.dumps({"status": "valid", "run_status": bundle["run"]["status"]}))
            return 0

        config = load_config(args.config)
        if args.command == "run":
            if args.dry_run:
                print(json.dumps(dry_run_summary(config), indent=2))
                return 0
            bundle = AcceptanceRunner(
                config,
                transport=NetworkTransport(config["target"], args.timeout),
            ).run()
            write_bundle(args.output, bundle)
            print(
                json.dumps(
                    {
                        "status": bundle["run"]["status"],
                        "output": str(args.output),
                        "mode": bundle["run"]["mode"],
                    }
                )
            )
            return 0 if bundle["run"]["status"] == "complete" else 3
        if args.command == "oauth-start":
            print(oauth_start(config, args.state_file, args.timeout))
            return 0
        if args.command == "oauth-exchange":
            oauth_exchange(config, args.state_file, args.redirect_url, args.output_token, args.timeout)
            print(json.dumps({"status": "token_written", "output": str(args.output_token)}))
            return 0
        raise ConfigError(f"unsupported command {args.command}")
    except (ConfigError, EvidenceError, OSError) as error:
        print(f"client acceptance error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
