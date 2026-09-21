# Gateway foundation specification

**Status:** Approved specification.

**Approved:** 2026-09-21

## Problem Statement

Gateway is a scaffold-only service with no Worker entry, public health signal,
MCP endpoint, or production delivery path. Consumers cannot verify that the
Gateway is reachable, Codex cannot call a harmless MCP diagnostic through a
stable public URL, and release owners have no defined production smoke check
after deployment.

The first useful slice must establish the public entry boundary while keeping
the Gateway Capability contract deliberate. It must provide connectivity
evidence without implementing downstream Service Operations, identity
integration, or internal service calls.

## Solution

Create the first Gateway slice as one production Cloudflare Worker at
`gateway.0000.chat`. A plain Hono application provides `GET /health`. A
stateless `mcp-use@2.5.0` MCP server is composed into the Hono application
while preserving its expected request path, so the public MCP endpoint is
exactly `/mcp`. The health endpoint returns HTTP 200 with a JSON status of
`ok` and service name `gateway`; it indicates Worker liveness and does not
claim downstream readiness. The server exposes one named read-only
`gateway_info` diagnostic with no required input, a fixed nonsecret response,
and no downstream calls or mutations. It requires no persistent session state
or Views.

Use an MCP client to exercise initialize, list, and diagnostic call behavior
against the local Worker runtime and the deployed production URL. Add the
production MCP endpoint to Codex as a new, distinct Streamable HTTP server
entry. Preserve the existing `0000` configuration, which is a stdio server
without a URL; adding the new entry requires Desktop settings configuration,
Save + Restart, and a fresh task.

PR checks gate changes without triggering production deployments. The release
flow deploys automatically from the exact `main` commit whose required checks
passed, serializes production releases to prevent stale overwrites, and
finishes with a production smoke check. The `/health` endpoint and
`gateway_info` diagnostic are public. A failed smoke check triggers automatic
rollback only to the previous successful healthy deployment, verifies
recovery, and marks the release failed even when recovery succeeds. The first
deployment has no rollback target; it reports failure. A failed recovery also
reports failure.

Future Gateway Capabilities will be explicitly selected and implemented once
behind REST and MCP projections. Platform establishes identity, downstream
services retain their resource ACLs, and Cap'n Web over Cloudflare service
bindings is selected for future internal calls. The health endpoint and
`gateway_info` are operational connectivity checks, not Gateway Capabilities.
None of the later service operations, authorization integration, or internal
RPC calls belongs in the diagnostic milestone.

## User Stories

1. As a Gateway consumer, I want a stable production URL, so that I can address the Gateway consistently.
2. As a Gateway operator, I want a health endpoint, so that I can verify the Worker is reachable.
3. As a Gateway consumer, I want health to return HTTP 200 with JSON status `ok` and service `gateway`, so that I can confirm Worker liveness without reading product data or secrets.
4. As an MCP client, I want to initialize against the Gateway MCP endpoint, so that I can establish protocol connectivity.
5. As an MCP client, I want to list the named operational diagnostic, so that I can discover the connectivity probe exposed by the MCP boundary.
6. As an MCP client, I want to call `gateway_info` without input and receive a fixed nonsecret response, so that I can verify a complete harmless request and response through the MCP boundary.
7. As a Gateway operator, I want the diagnostic to be stateless, so that the first deployment does not depend on a session store.
8. As a Gateway operator, I want the diagnostic to avoid Views and persistent assets, so that the initial Worker remains focused on the public protocol boundary.
9. As a Codex user, I want to register the deployed Streamable HTTP endpoint under a new server name, so that the existing `0000` stdio configuration remains usable.
10. As a Codex user, I want the Desktop settings change to take effect after Save and Restart in a fresh task, so that I can verify the new connection from a clean client session.
11. As a Gateway developer, I want Hono to own the initial HTTP application, so that `/health` exists before the MCP handler is composed.
12. As a Gateway developer, I want the MCP Fetch handler composed while preserving its expected request path, so that the public MCP endpoint is exactly `/mcp` alongside the Hono health route.
13. As a release contributor, I want pull request checks to run before production delivery without deploying production, so that broken Gateway changes are caught before deployment.
14. As a release contributor, I want production deployment to use the exact `main` commit whose checks passed, so that an unverified commit cannot overwrite the approved Worker.
15. As a release owner, I want a post-deploy production smoke check, so that a successful deployment means the public Worker responds at its intended boundary.
16. As a release owner, I want a failed smoke check to roll back automatically to the previous successful healthy deployment, so that the public Worker can recover while the release remains marked failed.
17. As a security reviewer, I want `/health` and the harmless `gateway_info` diagnostic to be public, so that connectivity can be verified without business authentication.
18. As a Gateway owner, I want the first environment to use one production Worker, so that the initial operational surface stays bounded while connectivity is proven.
19. As a Gateway owner, I want downstream Service Operations exposed only through selected Gateway Capabilities, so that downstream evolution does not silently expand the public contract.
20. As a REST consumer, I want future selected business operations to use the shared application behavior, so that authorization and outcomes do not diverge from their MCP projections.
21. As an MCP consumer, I want future selected business operations to use the shared application behavior, so that MCP tools represent the same Gateway Capabilities as REST endpoints.
22. As a Platform owner, I want Platform to establish identity for future authenticated operations, so that the Gateway does not become the owner of identity policy.
23. As a downstream service owner, I want downstream services to retain their resource ACLs, so that Gateway-level checks do not replace service-owned resource authorization.
24. As a Gateway developer, I want Cap'n Web over Cloudflare service bindings reserved for future internal calls, so that the first diagnostic can remain independent of downstream RPC implementation.
25. As a test owner, I want the same external HTTP and MCP checks to run against the local Worker runtime and deployed production URL, so that local evidence and release evidence exercise the same public boundary.

## Implementation Decisions

- The Gateway remains a stable entry and adaptation boundary. It does not own product data, identity policy, or downstream Service Operation behavior.
- The first milestone is one production Cloudflare Worker at `gateway.0000.chat`. A separate staging Worker is not part of this milestone.
- Plain Hono is the initial HTTP application. It serves `GET /health` before the MCP handler is composed, returning HTTP 200 with JSON status `ok` and service name `gateway`; this reports Worker liveness, not downstream readiness.
- `mcp-use@2.5.0` is the selected package for the diagnostic prototype. Its Worker-compatible package export and documented Fetch composition have been inspected from the published package and pinned source.
- The MCP server Fetch handler is composed into the Hono application while preserving its expected request path, making the public MCP endpoint exactly `/mcp`. The default MCP transport is stateless Streamable HTTP.
- The diagnostic is a harmless, read-only operational probe named `gateway_info`. It takes no required input, returns a fixed nonsecret response, makes no downstream calls, performs no mutations, and has no persistent MCP session store, Durable Object, View, or product data dependency. The name is an implementation detail of this specification, not a domain term or Gateway Capability.
- REST endpoints and MCP tools are protocol projections of selected Gateway Capabilities. The health endpoint and `gateway_info` operational probe do not establish a downstream business contract.
- Platform remains the intended identity owner for later authenticated operations. Downstream services retain resource ACLs. Platform middleware and authenticated service operations are not implemented by this spec, and public diagnostics do not bypass business authorization for future Gateway Capabilities.
- Cap'n Web over Cloudflare service bindings is the selected direction for future internal calls. The first diagnostic does not call a downstream service; future wiring is outside this milestone.
- Existing Codex server `0000` is preserved as a stdio configuration. The new Streamable HTTP registration uses a distinct name and is manually enabled through Desktop settings with Save + Restart before a fresh task.
- PR checks run before release without deploying production. The intended production flow deploys only the exact `main` commit whose required checks passed, serializes production releases to prevent stale overwrites, and runs a post-deploy production smoke check.
- `/health` and the harmless `gateway_info` diagnostic are public. This public operational access does not bypass Platform identity or downstream resource ACLs for future business Gateway Capabilities.
- A failed production smoke check triggers rollback only to the previous successful healthy deployment, verifies recovery, and marks the release failed even if recovery succeeds. A first deployment reports failure when no rollback target exists, and a failed recovery reports failure.

## Testing Decisions

- Tests assert external behavior at the public Worker entry. They do not inspect private handlers, internal composition, or package implementation details.
- The highest useful local seam is the real Worker HTTP entry under `workerd`. The local suite should assert `GET /health` returns HTTP 200 with the `ok` status and `gateway` service name, without implying downstream readiness, then assert MCP initialize, MCP tool listing, and one `gateway_info` call through a real MCP client at the public `/mcp` endpoint.
- The same HTTP and MCP behavior should be checked against the deployed production URL after release. The production check should verify health, MCP initialize/list, and the diagnostic call without requiring a downstream service.
- Repeated `gateway_info` calls should demonstrate that the operational probe does not require persistent session state and always returns the fixed nonsecret response without downstream calls or mutations. The test should observe behavior across requests rather than inspect storage internals.
- Codex connectivity has a separate manual acceptance step: configure a distinct Streamable HTTP server entry, Save + Restart, start a fresh task, and call the diagnostic.
- CI and release behavior are tested at the CI/release boundary. Required checks must pass for the exact `main` commit deployed; pull request events must not deploy production, production releases must be serialized, and the post-deploy smoke check must run against the deployed URL. A failed smoke check must exercise rollback only to the previous successful healthy deployment, verify recovery, and mark the release failed whether recovery succeeds or fails; a first deployment reports failure when no target exists.
- Existing prior art includes Communicator's health test, which requests the application boundary and checks a nonsecret response, and msg's Miniflare/workerd Worker boundary tests. Gateway should follow those external-boundary styles.
- Package documentation and source for `mcp-use@2.5.0` have been verified, but a local `workerd` execution has not yet run. The prototype is a required proof gate for the selected compatibility date and `nodejs_compat` configuration.

## Out of Scope

- Implementing authenticated downstream Service Operations or selecting the first business operation.
- Implementing Platform authentication middleware, identity policy, or downstream resource ACL checks.
- Calling any downstream Worker or service from the diagnostic.
- Implementing Cap'n Web or configuring future internal RPC calls beyond recording the selected direction over Cloudflare service bindings.
- Automatically mirroring downstream operations into Gateway Capabilities.
- Adding a staging Worker, Views, static assets, persistent MCP sessions, or a Durable Object.
- Executing deployments or changing Codex configuration while authoring this specification; implementation work performs those actions.

## Further Notes

- This specification is standalone and records the approved external HTTP/MCP, CI/release, and Codex acceptance boundaries.
- The published `mcp-use@2.5.0` package, Worker export, and pinned source documentation were inspected. The Fetch mount shape is documented, but no local `workerd` run or deployment has validated it.
- The compatibility date and `nodejs_compat` flags remain a local Worker proof-gate decision. No untested compatibility claim is treated as settled.
- The existing Codex `0000` entry is stdio with no URL and must remain intact. The new Streamable HTTP entry must use a distinct name and a fresh task after Desktop settings Save + Restart.
- Cloudflare `org.main` readiness was last observed on 2026-09-19 as requiring OAuth reauthorization with `invalid_grant`; current readiness remains unverified. This historical observation is not presented as a current deployment check, and another account must not be probed.
- Public `/health` and `gateway_info` access, plus automatic rollback and failed-release reporting, are approved behaviors.
