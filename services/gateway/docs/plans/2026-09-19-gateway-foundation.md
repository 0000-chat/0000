---
repo: 0000-chat/0000
status: draft
---

# Gateway foundation

**Status:** Approved planning record; implementation and deployment are separate execution work.

**Approved:** 2026-09-21

This document records the approved Gateway shape and its execution boundaries. Package documentation and current workflow configuration have been checked; local `workerd` validation and hostname verification are release prerequisites.

The maintained cross-service contract is the root [MCP topology](../../../../docs/architecture/mcp-topology.md).
It supersedes the earlier curated-only exposure wording below: enabled,
service-published tools enter the default Gateway catalog, while Access Profile
discovery and grants plus downstream resource authorization govern use. This
plan still does not claim that a route or deployment exists.

## Design tree

| Area | Status | Current direction |
| --- | --- | --- |
| Initial milestone | Approved | Deploy the Gateway, verify health and connectivity, and make a stateless, harmless `gateway_info` MCP diagnostic callable by Codex first; no persistent session store or Views are needed. Add authenticated service operations later. |
| Client behavior | Approved | Implement Gateway-owned operations and authorization checks once in a shared application layer, with REST and MCP adapters. Enabled service-published tools use the default catalog; Access Profiles and downstream services retain their authorization boundaries, and `/health` is REST-only. |
| Operation exposure | Approved | Add enabled, service-published tools to the default Gateway catalog. Access Profile discovery and grants and downstream resource authorization govern use; Gateway does not mirror arbitrary downstream HTTP routes. |
| Gateway protocols | Approved | Provide both REST and MCP interfaces. REST endpoints and MCP tools are protocol projections, not separate business concepts. |
| HTTP framework and health route | Approved / validation required | Keep plain Hono first and provide public `/health`. It returns HTTP 200 with JSON status `ok` and service name `gateway`, indicating Worker liveness rather than downstream readiness. Verify the compatibility date and `nodejs_compat` setting in the local Worker prototype. |
| MCP integration | Approved / validation required | Keep the plain-Hono-first sequence. The published `mcp-use@2.5.0` tarball has a `workerd` export. Compose its Fetch handler while preserving the server's expected request path so the public MCP endpoint is exactly `/mcp` ([pinned v2.5.0 server docs](https://github.com/mcp-use/mcp-use/blob/d816a3ff0d2972030e3d3562909247c23fb34b15/docs/typescript/api-reference/server/middleware.mdx)); this is Fetch-handler composition, not a generic `app.use` middleware package. Expose the public, read-only, stateless `gateway_info` diagnostic with no required input and a fixed nonsecret response. For Codex, adding a direct Streamable HTTP entry requires Desktop settings configuration, Save + Restart, and a fresh task. Existing server `0000` is stdio with no URL; use a distinct new name and preserve `0000`. |
| Internal service calls | Resolved for future integration | Use Cap'n Web over Cloudflare service bindings for future internal calls. No internal RPC is needed for the first single-Worker diagnostic milestone. Future wiring is outside this milestone. |
| Authentication integration | Deferred to Platform integration | Platform establishes identity for future authenticated operations, with Gateway-level checks shared in the application layer and downstream services retaining their resource ACLs. Public operational diagnostics do not bypass business authorization. The current Worker remains diagnostics-only; business authentication and authenticated Service Operations are outside this first milestone. |
| Runtime and address | Approved | Target the canonical `https://0000.chat/mcp` route and the standalone `https://gateway.0000.chat/mcp` host as the same direct MCP surface, without a redirect. Route provisioning and environment mapping remain operator-owned; the target does not claim deployment. |
| Production delivery | Approved for first deployment / workflow required | Public CI publishes the immutable Gateway artifact and does not deploy it. Private Cloud and the operator-owned release path supply environment routes, staging, promotion, rollback, and deployment evidence. Required checks must pass for the exact source commit consumed by promotion; a pull request result alone does not authorize production deployment. |

## Approved decisions

1. The first milestone is the diagnostics-only Worker, its health and connectivity checks, and the public, harmless, stateless `gateway_info` MCP diagnostic callable by Codex. Hosted route provisioning and authenticated service operations come later through the operator-owned release path.
2. REST and MCP share Gateway-owned operations and authorization behavior through one application layer where Gateway owns the operation. Enabled, service-published tools use the default catalog; Access Profiles and downstream services still control whether a caller can use them. Operational `/health` remains REST-only.
3. Gateway's default catalog includes enabled, service-published tools without requiring per-user opt-in to expose them. It does not automatically mirror arbitrary downstream HTTP routes or grant execution access.
4. Public CI publishes a deterministic artifact; private Cloud and the operator-owned release path perform any staging or production promotion after the required checks and deployment evidence are available.
5. Cap'n Web is selected over Cloudflare service bindings for future internal calls; the first diagnostic milestone does not require an internal RPC.
6. Public `/health` returns HTTP 200 with JSON status `ok` and service name `gateway`; it reports Worker liveness and not downstream readiness. Public `gateway_info` is read-only, takes no required input, and returns a fixed nonsecret response without downstream calls or mutations.
7. A failed hosted smoke check follows the operator-owned release contract, including rollback to the previous successful healthy deployment where a rollback target exists; this planning record does not claim that a deployment has occurred.

These decisions define the approved scope. Implementation and deployment remain separate execution work.

## Verification and delivery notes

- Required validation: run a local `workerd` prototype under the intended Wrangler config, checking public `GET /health`, MCP initialize/list, and the public `gateway_info` call. Once the operator-owned routes are provisioned, exercise the same MCP checks at both the canonical apex and standalone host without following a redirect. Verify the selected compatibility date and `nodejs_compat` flags against the [Cloudflare Node.js compatibility documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/). Published package/docs have been inspected; Worker execution and deployment are separate release steps.
- Complete the Codex MCP acceptance by configuring a distinct Streamable HTTP entry for the canonical Gateway target, Save + Restart, starting a fresh task, and calling `gateway_info` once the operator-owned route is available.
- Platform auth integration, authenticated Service Operations, and future Cap'n Web calls remain outside this first milestone.
- Verify the target host and apex route through the operator-owned release path before claiming a hosted deployment. The preferred Cloudflare Executor connection `org.main` last observed on 2026-09-19 reported `oauth_reauth_required` / `invalid_grant`; recheck that same connection first. Do not probe another account.
- Repository status: the Gateway Worker remains a diagnostics-only implementation in this public repository; the connected-tool catalog and hosted topology are target behavior until release evidence records otherwise.

## Validation follow-up

The tracked-file allowlist in [`scripts/check`](../../scripts/check) includes the glossary, ADR, plan, and approved specification. Its exact-file check requires these documentation and check files to be tracked in Git.
