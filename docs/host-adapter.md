# Host Adapter Contract

The bridge should be usable outside 0000 Chat. 0000 Chat is the first host
adapter, not a requirement baked into the bridge runtime.

## Stable Host Responsibilities

A host adapter must provide authenticated HTTPS endpoints for:

| Operation | Direction | Purpose |
| --- | --- | --- |
| heartbeat | bridge to host | Register liveness, runtime profiles, capabilities, and status |
| poll queue | bridge to host | Discover queued work without claiming it |
| claim work | bridge to host | Atomically lease one or more work items |
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

0000 Chat uses Convex-backed queue, heartbeat, diagnostics, and thread
projection endpoints. The bridge must not import private Convex generated code;
it talks to those endpoints over the public authenticated HTTP adapter.

0000-specific hidden prompts and MCP guidance live in
`scripts/acp-bridge/zero-chat-policy.ts`. Other hosts should supply their own
policy text instead of reusing 0000 Chat product assumptions.

## Extension Rules

- Add new host capabilities through capability flags.
- Keep old hosts tolerant of unknown fields.
- Keep old bridges explicit when a required host feature is missing.
- Never make product rollout flags the only way to negotiate bridge protocol
  compatibility.
