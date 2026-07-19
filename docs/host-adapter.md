# Host Adapter Contract

The bridge should be usable outside 0000 Chat. 0000 Chat is the first host
adapter, not a requirement baked into the bridge runtime.

## Stable Host Responsibilities

A host adapter must provide an authenticated realtime connection plus bounded
HTTPS endpoints for durable work operations:

| Operation | Direction | Purpose |
| --- | --- | --- |
| issue realtime ticket | bridge to host | Exchange bridge credentials and a nonce hash for a short-lived, one-time room ticket |
| connect device room | bidirectional | Deliver wake/control signals and publish compact status/liveness updates |
| pull control | bridge to host | Recover control state during startup and bounded safety resyncs |
| claim work | bridge to host | Atomically lease one or more work items, fenced by the current room connection epoch |
| cleanup work | bridge to host | Release stale or terminal local work |
| submit result | bridge to host | Persist success, failure, cancellation, and diagnostic result state |
| append diagnostics | bridge to host | Record structured debug breadcrumbs |
| forward logs | bridge to host | Store sanitized operational logs, if enabled |
| invoke agent tool | bridge to host | Let runtimes call host-mediated tools with policy checks |

The TypeScript adapter boundary lives in `scripts/acp-bridge/host-adapter.ts`.
The HTTP transport used by 0000 Chat lives in `scripts/acp-bridge/convex-http.ts`.

## Host-Neutral Work Item Shape

Work items should carry:

- stable queue item id
- organization or tenant id
- target runtime profile id
- thread or conversation id
- user-visible message metadata
- optional model/reasoning/runtime options
- cancellation and steering policy
- trace id

Hosts may add fields, but bridge code should ignore unknown fields and fail
clearly when required fields are absent.

## 0000 Chat Specifics

0000 Chat uses a Cloudflare Durable Object Device Room for realtime wake,
control, status, and liveness traffic. Convex backs queue claims, results,
diagnostics, control recovery, and thread projection. The bridge must not import
private Convex generated code; it uses the public realtime protocol and
authenticated HTTP adapter.

0000-specific hidden prompts and MCP guidance live in
`scripts/acp-bridge/zero-chat-policy.ts`. Other hosts should supply their own
policy text instead of reusing 0000 Chat product assumptions.

## Extension Rules

- Add new host capabilities through capability flags.
- Keep old hosts tolerant of unknown fields.
- Keep old bridges explicit when a required host feature is missing.
- Never make product rollout flags the only way to negotiate bridge protocol
  compatibility.
