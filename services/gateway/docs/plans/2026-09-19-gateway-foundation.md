# Gateway foundation

**Status:** Approved planning record; implementation and deployment are separate execution work.

**Approved:** 2026-09-21

This document records the approved Gateway shape and its execution boundaries. Package documentation and current workflow configuration have been checked; local `workerd` validation and hostname verification are release prerequisites.

## Design tree

| Area | Status | Current direction |
| --- | --- | --- |
| Initial milestone | Approved | Deploy the Gateway, verify health and connectivity, and make a stateless, harmless `gateway_info` MCP diagnostic callable by Codex first; no persistent session store or Views are needed. Add authenticated service operations later. |
| Client behavior | Approved | Implement selected business operations and Gateway-level authorization checks once in a shared application layer, with REST and MCP adapters. Downstream services retain their resource ACLs, Platform establishes identity, and `/health` is REST-only. |
| Operation exposure | Approved | Expose explicitly selected downstream operations. Do not mirror downstream operations automatically. |
| Gateway protocols | Approved | Provide both REST and MCP interfaces. REST endpoints and MCP tools are protocol projections, not separate business concepts. |
| HTTP framework and health route | Approved / validation required | Keep plain Hono first and provide public `/health`. It returns HTTP 200 with JSON status `ok` and service name `gateway`, indicating Worker liveness rather than downstream readiness. Verify the compatibility date and `nodejs_compat` setting in the local Worker prototype. |
| MCP integration | Approved / validation required | Keep the plain-Hono-first sequence. The published `mcp-use@2.5.0` tarball has a `workerd` export. Compose its Fetch handler while preserving the server's expected request path so the public MCP endpoint is exactly `/mcp` ([pinned v2.5.0 server docs](https://github.com/mcp-use/mcp-use/blob/d816a3ff0d2972030e3d3562909247c23fb34b15/docs/typescript/api-reference/server/middleware.mdx)); this is Fetch-handler composition, not a generic `app.use` middleware package. Expose the public, read-only, stateless `gateway_info` diagnostic with no required input and a fixed nonsecret response. For Codex, adding a direct Streamable HTTP entry requires Desktop settings configuration, Save + Restart, and a fresh task. Existing server `0000` is stdio with no URL; use a distinct new name and preserve `0000`. |
| Internal service calls | Resolved for future integration | Use Cap'n Web over Cloudflare service bindings for future internal calls. No internal RPC is needed for the first single-Worker diagnostic milestone. Future wiring is outside this milestone. |
| Authentication integration | Deferred to Platform integration | Platform establishes identity for future authenticated operations, with Gateway-level checks shared in the application layer and downstream services retaining their resource ACLs. Public operational diagnostics do not bypass business authorization. Gateway and Platform remain scaffold-only locally and on origin; business authentication and authenticated Service Operations are outside this first milestone. |
| Runtime and address | Approved | Deploy a Cloudflare Worker at `gateway.0000.chat`. |
| Production delivery | Approved for first deployment / workflow required | Start with one production Worker. PR checks gate changes without deploying production. Required checks must pass for the exact `main` commit being deployed; a pull request result alone does not authorize production deployment. Production releases are serialized to prevent stale overwrites, and a post-deploy production smoke check verifies the deployment. A failed smoke check rolls back only to the previous successful healthy deployment, verifies recovery, and marks the release failed even if recovery succeeds. A first deployment reports failure when no rollback target exists, and failed recovery reports failure. The active repository-root [check workflow](../../../../.github/workflows/check.yml) runs on pushes and pull requests and installs Gateway tooling before `check:application`; it does not deploy or define concurrency. The nested Gateway [quality workflow](../../.github/workflows/quality.yml) is inert. Any future deployment workflow belongs at the repository root, for example `.github/workflows/deploy-gateway.yml`; no deployment workflow is authorized or implemented here. |

## Approved decisions

1. The first milestone is deployment, health and connectivity checks, plus the public, harmless, stateless `gateway_info` MCP diagnostic callable by Codex. Authenticated service operations come later.
2. REST and MCP share selected business operations and Gateway-level authorization behavior through one application layer. Downstream services retain their resource ACLs, Platform establishes identity, and operational `/health` remains REST-only.
3. Gateway exposes only explicitly selected downstream operations. It does not automatically mirror whatever operations downstream services provide.
4. The first deployment uses one production Worker, with PR checks that do not deploy production, required checks passing for the exact `main` commit being deployed, serialized production releases, and a post-deploy production smoke check.
5. Cap'n Web is selected over Cloudflare service bindings for future internal calls; the first diagnostic milestone does not require an internal RPC.
6. Public `/health` returns HTTP 200 with JSON status `ok` and service name `gateway`; it reports Worker liveness and not downstream readiness. Public `gateway_info` is read-only, takes no required input, and returns a fixed nonsecret response without downstream calls or mutations.
7. A failed production smoke check rolls back only to the previous successful healthy deployment, verifies recovery, and marks the release failed even if recovery succeeds. A first deployment reports failure when no rollback target exists, and failed recovery reports failure.

These decisions define the approved scope. Implementation and deployment remain separate execution work.

## Verification and delivery notes

- Required validation: run a local `workerd` prototype under the intended Wrangler config, checking public `GET /health`, MCP initialize/list, and the public `gateway_info` call. Verify the selected compatibility date and `nodejs_compat` flags against the [Cloudflare Node.js compatibility documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/). Published package/docs have been inspected; Worker execution and deployment are separate release steps.
- Complete the Codex MCP acceptance by configuring a distinct Streamable HTTP entry, Save + Restart, starting a fresh task, and calling `gateway_info`.
- Platform auth integration, authenticated Service Operations, and future Cap'n Web calls remain outside this first milestone.
- Verify the `gateway.0000.chat` hostname before deployment. The preferred Cloudflare Executor connection `org.main` last observed on 2026-09-19 reported `oauth_reauth_required` / `invalid_grant`; recheck that same connection first. Do not probe another account.
- Repository status: 14 newer commits on origin are message-only; Gateway and Platform remain scaffold-only locally and on origin.

## Validation follow-up

The tracked-file allowlist in [`scripts/check`](../../scripts/check) includes the glossary, ADR, plan, and approved specification. Its exact-file check requires these documentation and check files to be tracked in Git.
