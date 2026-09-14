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
RUN_MODES = {"live_client", "controlled"}
EVIDENCE_STATUSES = {
    "pass",
    "unsupported",
    "unverified",
    "implementation_defect",
}
SENSITIVE_KEY = re.compile(
    r"(?:access.?token|authorization|bearer|client.?secret|cookie|password|secret|token)",
    re.IGNORECASE,
)
PLACEHOLDER = re.compile(
    r"(?:\.invalid(?:/|$)|\.example(?:/|$)|replace-with|your[-_]|<[^>]+>)",
    re.IGNORECASE,
)
JWT_SHAPE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
CONTENT_FIELD = re.compile(r"(?:^|_)(?:body|text|content|payload|bytes)(?:$|_)", re.IGNORECASE)
TEMPLATE = re.compile(r"\$\{([^}]+)\}")


class ConfigError(ValueError):
    """Raised when a run configuration cannot produce trustworthy evidence."""


class EvidenceError(ValueError):
    """Raised when an evidence bundle violates the evidence contract."""


@dataclass(frozen=True)
class Scenario:
    identifier: str
    tickets: tuple[str, ...]
    title: str
    minimum_operations: int = 1


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "oauth_connection",
        ("#35", "#36"),
        "OAuth and MCP connection with resource binding",
        2,
    ),
    Scenario(
        "linking_identity_lifecycle",
        ("#35",),
        "Unlinked start, identity verification, relink, disconnect, and a different identity",
        4,
    ),
    Scenario(
        "history_context_attachment",
        ("#35",),
        "Stored history, context, and authenticated attachment reads",
        2,
    ),
    Scenario(
        "text_send_and_route",
        ("#35", "#36"),
        "Text acceptance, account-owned routing, and provider evidence",
        1,
    ),
    Scenario(
        "direct_chat_and_group",
        ("#35",),
        "New direct chat and group create, rename, and membership changes",
        2,
    ),
    Scenario(
        "webhook_subscriptions",
        ("#35",),
        "Two subscription cases with revision, removal, retry, and cutover IDs",
        2,
    ),
    Scenario(
        "receipt_and_restore",
        ("#35",),
        "Explicit receipt result, removal, and restore anti-resurrection",
        2,
    ),
    Scenario(
        "authorization_negative_matrix",
        ("#35", "#36"),
        "Wrong resource, expired or revoked installation, missing grant, and account mismatch",
        4,
    ),
    Scenario(
        "grok_surface_read",
        ("#36",),
        "Grok surface read scope",
        1,
    ),
    Scenario(
        "grok_surface_send",
        ("#36",),
        "Grok surface durable text submission and provider evidence",
        1,
    ),
    Scenario(
        "grok_bot_identity",
        ("#36",),
        "Shared Bot member and installation binding",
        1,
    ),
    Scenario(
        "grok_failure_matrix",
        ("#36",),
        "Grok duplicate, timeout, uncertainty, reconnect, and rejection behavior",
        3,
    ),
    Scenario(
        "surface_outcome_record",
        ("#35", "#36"),
        "Exact surface version and explicit unsupported or unverified result",
        1,
    ),
)
SCENARIO_BY_ID = {scenario.identifier: scenario for scenario in SCENARIOS}


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


def reject_placeholder(value: str, label: str, *, live: bool) -> None:
    if live and PLACEHOLDER.search(value):
        raise ConfigError(f"{label} contains a placeholder value")


def redact(value: Any, key: str = "") -> Any:
    """Return a JSON-safe value with credentials removed."""

    if key and SENSITIVE_KEY.search(key):
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
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?", part)
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


def _secret_key_in(value: Any, path: str = "") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if SENSITIVE_KEY.search(str(key)) and str(key) not in {
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
        if not is_absolute_url(oauth["redirect_uri"]):
            raise ConfigError("oauth.redirect_uri must be an absolute URL")
        reject_placeholder(oauth["redirect_uri"], "oauth.redirect_uri", live=live)
    if "authorization_server" in oauth:
        if not is_absolute_url(oauth["authorization_server"]):
            raise ConfigError("oauth.authorization_server must be an absolute URL")
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
        transport = operation.get("transport")
        if transport not in {"rest", "mcp"}:
            raise ConfigError(f"operations[{index}].transport must be rest or mcp")
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
        else:
            if not isinstance(request.get("tool"), str) and request.get("method") not in {
                "tools/list",
                "resources/list",
            }:
                raise ConfigError(
                    f"operations[{index}].request needs a tool or a supported MCP method"
                )
        actor = operation.get("actor", "agent")
        if actor not in {"agent", "admin", "none"}:
            raise ConfigError(f"operations[{index}].actor must be agent, admin, or none")
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
        evidence = operation.get("evidence", {})
        if not isinstance(evidence, dict):
            raise ConfigError(f"operations[{index}].evidence must be an object")
        extract = evidence.get("extract", {})
        if not isinstance(extract, dict) or any(not isinstance(pointer, str) for pointer in extract.values()):
            raise ConfigError(f"operations[{index}].evidence.extract must map names to JSON pointers")
        if any(CONTENT_FIELD.search(str(name)) for name in extract):
            raise ConfigError(
                f"operations[{index}] may extract identifiers and hashes, not message content"
            )
        required = evidence.get("required", [])
        if not isinstance(required, list) or any(name not in extract for name in required):
            raise ConfigError(f"operations[{index}].evidence.required must name extracted fields")

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
    ) -> HttpResponse:
        base = self.target["base_url"].rstrip("/")
        query_string = urllib.parse.urlencode(query, doseq=True)
        url = f"{base}{path}" + (f"?{query_string}" if query_string else "")
        headers = {
            "Accept": "application/json",
            "Origin": origin_for(self.target["base_url"]),
        }
        payload = None
        if body is not None:
            payload = canonical_bytes(body)
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return self._request(url, method.upper(), payload, headers)

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
            "MCP-Protocol-Version": "2025-06-18",
        }
        if self.session_id:
            headers["MCP-Session-Id"] = self.session_id
        response = self.transport._request(self.url, "POST", canonical_bytes(payload), headers)
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            self.session_id = session_id
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
                    "protocolVersion": "2025-06-18",
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
            if isinstance(response.body, dict) and "error" not in response.body:
                self.initialized = True
                notification = self._send(
                    {"jsonrpc": "2.0", "method": "notifications/initialized"}
                )
                response.details["initialized_notification_status"] = notification.status
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
        "body_sha256": sha256_bytes(response.raw) if response.raw else None,
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
) -> tuple[str, str | None, dict[str, Any]]:
    if response.error:
        return "unverified", response.error, {}
    expect = operation.get("expect", {})
    statuses = set(expect.get("statuses", [200]))
    unsupported_statuses = set(expect.get("unsupported_statuses", [404, 405, 501]))
    if response.status not in statuses:
        if response.status in unsupported_statuses:
            return "unsupported", f"target returned HTTP {response.status}", {}
        return "implementation_defect", f"unexpected HTTP status {response.status}", {}

    evidence = operation.get("evidence", {})
    extracted: dict[str, Any] = {}
    for name, pointer in evidence.get("extract", {}).items():
        extracted[name] = redact(json_pointer(_response_body_for_extraction(response), pointer), name)
    missing = [name for name in evidence.get("required", []) if extracted.get(name) is None]
    if missing:
        return "unverified", f"required evidence fields are absent: {', '.join(missing)}", extracted

    assertion_errors = _assertions_pass(
        _response_body_for_extraction(response),
        operation.get("assert", []),
        context,
    )
    if assertion_errors:
        return "implementation_defect", "; ".join(assertion_errors), extracted
    expected_outcome = expect.get("outcome", "pass")
    if expected_outcome == "unsupported":
        return "unsupported", expect.get("reason", "the target reported an unsupported capability"), extracted
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

    def _context(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "binding": self.target["bindings"],
            "vars": self.config.get("vars", {}),
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

    def _preflight_request(self, identifier: str, path: str, url: str | None = None) -> None:
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
            if observed != self.target["resource"]:
                status = "implementation_defect"
                reason = f"resource metadata is {observed!r}, expected {self.target['resource']!r}"
        if status == "pass" and path.endswith("oauth-authorization-server"):
            for field_name in ("issuer", "authorization_endpoint", "token_endpoint"):
                if not isinstance(json_pointer(response.body, f"/{field_name}"), str):
                    status = "implementation_defect"
                    reason = f"authorization metadata is missing {field_name}"
                    break
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
        self._preflight_request("protected-resource-metadata", "/.well-known/oauth-protected-resource")
        authority = self.config["oauth"].get("authorization_server")
        if authority:
            parsed = urllib.parse.urlsplit(authority)
            path = parsed.path or "/.well-known/oauth-authorization-server"
            self._preflight_request(
                "authorization-server-metadata",
                path,
                metadata_url(self.config),
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
            request_summary.update(
                {
                    "method": method,
                    "path": path,
                    "query": redact(query),
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
            "request": request_summary,
        }
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
            )
        else:
            response = self.transport.mcp(request, token, self.target["client"])
        status, reason, extracted = classify_response(response, operation, context)
        if extracted:
            self.observed_bindings.append({"operation": identifier, "values": extracted})
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
        for operation in self.config["operations"]:
            self.execute_operation(operation)
        scenarios: list[dict[str, Any]] = []
        for scenario in SCENARIOS:
            records = [record for record in self.records if record["scenario"] == scenario.identifier]
            status, reason = aggregate_status(records)
            if len(records) < scenario.minimum_operations and status == "pass":
                status = "unverified"
                reason = (
                    f"{scenario.identifier} requires at least {scenario.minimum_operations} operations; "
                    f"only {len(records)} were configured"
                )
            scenarios.append(
                {
                    "id": scenario.identifier,
                    "tickets": list(scenario.tickets),
                    "title": scenario.title,
                    "status": status,
                    "reason": reason,
                    "operation_ids": [record["id"] for record in records],
                    "evidence_class": self.mode,
                }
            )
        all_passed = all(scenario["status"] == "pass" for scenario in scenarios)
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


def validate_bundle(bundle: dict[str, Any]) -> None:
    if bundle.get("schema_version") != SCHEMA_VERSION:
        raise EvidenceError(f"schema_version must be {SCHEMA_VERSION}")
    run = bundle.get("run")
    if not isinstance(run, dict):
        raise EvidenceError("run must be an object")
    if run.get("mode") not in RUN_MODES:
        raise EvidenceError("run.mode must be live_client or controlled")
    for key in ("client", "provider", "resource", "bindings"):
        if key not in run:
            raise EvidenceError(f"run.{key} is required")
    bindings = run["bindings"]
    if not isinstance(bindings, dict) or not isinstance(bindings.get("grant_ids"), list):
        raise EvidenceError("run.bindings must include grant_ids")
    scenarios = bundle.get("scenarios")
    if not isinstance(scenarios, list):
        raise EvidenceError("scenarios must be an array")
    scenario_ids = {item.get("id") for item in scenarios if isinstance(item, dict)}
    if scenario_ids != set(SCENARIO_BY_ID):
        raise EvidenceError("bundle must contain exactly the declared acceptance scenarios")
    records = bundle.get("operations")
    if not isinstance(records, list):
        raise EvidenceError("operations must be an array")
    records_by_id = {record.get("id"): record for record in records if isinstance(record, dict)}
    for scenario in scenarios:
        if scenario.get("status") not in EVIDENCE_STATUSES:
            raise EvidenceError(f"invalid scenario status for {scenario.get('id')}")
        if scenario.get("status") == "pass":
            operation_ids = scenario.get("operation_ids", [])
            matching = [records_by_id.get(identifier) for identifier in operation_ids]
            if not matching or any(record is None or record.get("status") != "pass" for record in matching):
                raise EvidenceError(f"scenario {scenario.get('id')} claims pass without passing operations")
    if bundle.get("controls", {}).get("credentials_redacted") is not True:
        raise EvidenceError("credentials_redacted must be true")
    serialized = json.dumps(bundle, ensure_ascii=False)
    if re.search(r"Bearer\s+[A-Za-z0-9._~-]{8,}", serialized, re.IGNORECASE):
        raise EvidenceError("bundle contains a bearer credential")
    for key in ("access_token", "refresh_token", "client_secret"):
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
    if not isinstance(endpoint, str) or not is_absolute_url(endpoint):
        raise ConfigError("authorization metadata has no valid authorization_endpoint")
    client_id = _require_string(oauth.get("client_id"), "oauth.client_id")
    redirect_uri = _require_string(oauth.get("redirect_uri"), "oauth.redirect_uri")
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
    if not isinstance(token_endpoint, str) or not is_absolute_url(token_endpoint):
        raise ConfigError("authorization metadata has no valid token_endpoint")
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
