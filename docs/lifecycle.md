# Lifecycle Contract

The bridge is not just an event passthrough. It owns local lifecycle state for
claimed work, active ACP sessions, idle pruning, cancellation, steering, and
diagnostic recovery. The host remains the stable source of truth for queue and
thread projection; the bridge provides durable local evidence and bounded
runtime control.

## Command Summary

| Command | Host intent | Bridge behavior | Terminal result |
| --- | --- | --- | --- |
| `cancel-session` | Stop an active turn | Calls the runtime cancel operation for the active session and records a cancelling transition | `cancelled`, or failed with `cancel_not_acknowledged` / runtime error |
| `steer-session` | Stop current progress and replace instructions | Cancels the active turn first, then sends the replacement prompt on the same session when cancel is acknowledged | `steered`, or failed with `steer_cancel_failed`, `steer_reprompt_failed`, or validation error |
| `close-session` | Close an idle or selected ACP session | Closes the local ACP session if present and clears timers | `closed: true` or `closed: false` when already absent |
| `revive-session` | Reopen work for a thread after local idle close | Reuses an active session, loads native context when supported, or falls back to thread history | `revived` with `native-load` or `thread-history` mode |
| `updateWhenIdle` | Update bridge code after active work drains | Defers update until no in-flight queue work or running session queues remain | update attempt/result diagnostic |
| `restartWhenIdle` | Restart bridge process after active work drains | Defers restart until no in-flight queue work or running session queues remain | restart attempt/result diagnostic |

Unknown lifecycle commands must fail clearly instead of becoming no-ops.

## Stop

Stop is represented as `cancel-session`. The bridge records a local cancelling
transition before calling the runtime. A runtime cancel result of `false`, a
missing active session, or a thrown runtime error must produce a terminal failed
queue result with a sanitized diagnostic. Successful cancellation emits a
user-visible cancelled message event and marks the work item cancelled.

Hosts should not keep showing an indefinite "working" state after a terminal
cancel failure. If the runtime cannot stop, the host should surface the failure
and may offer a replacement-session retry.

## Steer

Steering is not normal queueing. It means "interrupt the active turn and continue
with these replacement instructions." The bridge validates that instructions are
present, rejects duplicate or already-cancelling steering requests, calls runtime
cancel, and only sends the replacement prompt after cancellation is acknowledged.

If cancellation fails, the bridge must not silently append the replacement prompt
behind the still-running turn. It should fail the steer command with
`steer_cancel_failed` and leave enough diagnostics for the host to offer a new
session fallback.

## Close And Idle Prune

Close is an explicit host command. Idle prune is local bridge housekeeping. Both
must clear the local idle timer and attempt bounded ACP shutdown. A runtime that
does not support native close should be reported as a capability limitation
rather than a host contract failure.

Idle ACP sessions may be closed to free memory. Idle sessions do not block
developer hot reload or restart-when-idle. In-flight prompts and running session
queues do block updates and restarts.

## Revive

When a new message arrives for a thread whose local ACP session was idle-closed,
the host can send `revive-session` before prompt work. The bridge should:

1. Reuse the active local session if it still exists.
2. Prefer native runtime context loading when the runtime supports it and an
   external ACP session id is available.
3. Fall back to host-provided thread history when native resume is disabled or
   unavailable.
4. Close any newly created session if native start/load fails.

Revive results must identify whether the bridge used `native-load` or
`thread-history`.

## Queue And Concurrency

The host owns global queue ordering and active-session limits. The bridge must
still enforce local safety:

- do not claim work while local journal health is hard-failed
- do not run two prompts concurrently for the same scoped session
- scope sessions by organization, bridge device, agent, thread, and runtime
  profile
- keep lifecycle commands fenced to the claimed queue item/session
- report stale, duplicate, or ambiguous lifecycle commands as terminal queue
  results

## Required Diagnostics

Lifecycle diagnostics should include every identifier available at the bridge
boundary: organization id, bridge device id, runtime profile id, thread id,
session id, queue item id, and trace id. Diagnostic reason codes are defined in
`scripts/acp-bridge/bridge-contract-v2.ts`.

Important codes include:

- `cancel_not_acknowledged`
- `session_close_unsupported`
- `session_close_failed`
- `session_revive_failed`
- `stop_already_cancelling`
- `steer_cancel_failed`
- `steer_reprompt_failed`
- `steer_empty_instruction`
- `steer_duplicate_request`

Diagnostics must classify provider/runtime failures without forwarding raw
provider payloads, tokens, auth headers, prompts, or full user content.
