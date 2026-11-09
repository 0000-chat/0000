---
repo: 0000-chat/0000
status: current
---

# Platform client transport

The shared Platform and guest clients use one bounded JSON transport. Each
client accepts an optional `timeoutMs` request deadline. The value must be a
finite integer from `1` through `60000` milliseconds; omitted values default to
`10000` milliseconds. The deadline covers the fetch and response body parsing.

The transport passes an `AbortSignal` to `fetch` and uses manual redirect mode,
rejecting every redirect response before its body is trusted, so credentials
and service or guest control material are not forwarded through redirects. A
timeout or transport/body failure returns
`authority_unavailable`. Guest mutations are not retried when their response
deadline expires because the server may already have committed the operation.

## Saved operations

`createPlatformClient` also exposes:

- `captureSavedOperation({credential, operationId, capability})`, which returns
  `{status: "allowed", authorization}`, `denied`, or `authority_unavailable`.
- `revalidateSavedOperation(authorization)`, which returns
  `{status: "allowed", principal}`, `denied`, or `authority_unavailable`.

The consumer stores the returned non-secret descriptor, not the original
bearer. The descriptor binds the actor, organization, service audience, operation
ID, and capability to Platform's persisted native authority lineage. A valid
scheduler credential does not replace this check. Service-owned resource ACLs
still apply immediately before execution.

The [Platform contract](../../services/platform/docs/saved-operations.md) defines
the supported actor matrix and retry behavior. Saved authority is capped by
the original credential's expiry and revocation, even when its installation
remains valid. Capture retries are idempotent for the same service and operation
ID but cannot change the credential, actor, capability, or lineage. Neither
method retries automatically or treats unavailability as permission.
