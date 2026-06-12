# Diagnostics

Diagnostics are designed for humans and coding agents debugging a failed bridge
thread end to end.

## Surfaces

| Surface | Purpose |
| --- | --- |
| Local stdout/stderr | Immediate bridge process output |
| `~/.0000/bridge-status.json` | Current local heartbeat and active work projection |
| SQLite journal | Durable queue, session, lifecycle, and result breadcrumbs |
| ACP process registry | Durable child-process ownership records used for restart recovery |
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
4. Check `processHealth` in `bridge-status.json`. `canClaim: false`,
   `ambiguousProcessCount > 0`, or `processCapExceeded: true` means the bridge
   intentionally stopped claiming queue work until local ownership is safe.
5. Inspect the SQLite journal for claim, prompt, cancel, result, and cleanup
   transitions.
6. Compare host log forwarding records with local bridge logs.
7. Reproduce locally with `bun run bridge:smoke-runtimes` or a focused custom ACP
   command.

## ACP Process Health

Each bridge registration owns a local JSON process registry under
`~/.0000/bridge-processes/<device>.json` unless
`ZERO_CHAT_BRIDGE_PROCESS_REGISTRY` or `--process-registry-file` overrides it.
The file is written with temp-file plus rename and owner-only permissions.

On startup, the bridge reconciles the registry before stale cleanup or queue
claiming. Dead registered children are removed. Live children are terminated
only when the registry pid and command fingerprint match; the bridge never kills
by process name alone. Corrupt registry JSON, a newer registry version, an
unverifiable live child, or a process-cap breach sets `processHealth.canClaim`
to `false`.

Relevant status fields:

- `processHealth.status`: `healthy`, `corrupt`, `newer_version`, `ambiguous`, or
  `cap_exceeded`.
- `processHealth.childCount`: registered ACP children still owned locally.
- `processHealth.childCountsByRuntimeProfile`: child counts grouped by runtime
  profile id or Hermes profile.
- `processHealth.ambiguousProcessCount`: live registry entries the bridge could
  not safely prove before acting.
- `processHealth.processCapExceeded`: whether local child count is above the
  configured cap.
- `lastStaleCleanupAt` and `lastStaleCleanup`: last host stale-claim cleanup
  attempt and result.

When `canClaim` is false, inspect the registry file and local process table.
If a process is still valid bridge-owned work, let it finish or terminate it
with pid-specific evidence. If the registry is corrupt or newer than the
installed bridge understands, preserve the file for debugging and reconnect or
upgrade the bridge before claiming new work.

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
