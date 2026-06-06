# Diagnostics

Diagnostics are designed for humans and coding agents debugging a failed bridge
thread end to end.

## Surfaces

| Surface | Purpose |
| --- | --- |
| Local stdout/stderr | Immediate bridge process output |
| `~/.0000/bridge-status.json` | Current local heartbeat and active work projection |
| SQLite journal | Durable queue, session, lifecycle, and result breadcrumbs |
| Host diagnostics endpoint | Host-visible bridge diagnostic records |
| Host log forwarding endpoint | Sanitized operational events for centralized search |

## Required Correlation Fields

Every important diagnostic should carry the identifiers available at that layer:

- organization id
- bridge device id
- runtime profile id
- queue item id
- session id
- thread id
- trace id or run id
- diagnostic reason code

If one of these identifiers is unavailable, the diagnostic should say which
boundary has not produced it yet.

## Safe Error Classification

Provider and runtime errors should be classified before they reach the host UI.
Examples:

| Class | Meaning |
| --- | --- |
| `provider_login_failed` | Runtime reached the provider but local auth is missing or expired |
| `runtime_unavailable` | Runtime command or gateway is not reachable |
| `runtime_prompt_failed` | Runtime accepted initialization but failed during prompt work |
| `cancellation_failed` | Stop/steer could not halt active work |
| `bridge_device_not_paired` | Local token or host pairing is invalid |

Never forward raw tokens, cookies, auth headers, full prompts, or full provider
payloads in diagnostics.

## Debug Runbook

1. Start with the host thread and queue item status.
2. Match the queue item to bridge diagnostics by queue item id and trace id.
3. Check `bridge-status.json` for active sessions and runtime profile state.
4. Inspect the SQLite journal for claim, prompt, cancel, result, and cleanup
   transitions.
5. Compare host log forwarding records with local bridge logs.
6. Reproduce locally with `bun run bridge:smoke-runtimes` or a focused custom ACP
   command.

## Local Doctor Bundle

Run the local doctor command when Convex, the ACP runtime, or the network may be
unavailable:

```bash
bun scripts/acp-bridge.ts doctor --trace <trace-id>
```

The command prints a redacted JSON bundle with bridge version, local config
summary, status-file presence, journal health, pending outbox rows, and local
diagnostics. Use `--device-id <bridge-device-id>` when the config has multiple
organizations, or `--journal-file <path>` when inspecting a copied SQLite file.

The doctor output is designed to be safe for coding-agent debugging. It keeps
ids, status, event types, reason codes, timestamps, and redacted metadata, but
does not print raw prompts, message content, bridge tokens, or provider output.
