---
repo: 0000-chat/0000
status: current
---

# Saved operation authorization

Platform captures an operation's original actor authority and revalidates it
against current local state. A scheduler's service identity does not replace
the original actor. The descriptor is not a credential or a resource grant.

## Service contract

Both endpoints require `Authorization: Bearer <service verifier>`. Platform
derives the audience from that service's active registration. Request fields
cannot select another service or audience.

| Endpoint | JSON body | Successful response |
| --- | --- | --- |
| `POST /internal/v1/saved-operations/capture` | `{credential, operationId, capability}` | `{status: "allowed", authorization}` |
| `POST /internal/v1/saved-operations/revalidate` | The complete `authorization` descriptor | `{status: "allowed", principal}` |

The shared `createPlatformClient` exposes `captureSavedOperation(input)` and
`revalidateSavedOperation(authorization)` with these shapes. Its existing
deadline, redirect rejection, and response validation apply to both methods.
The shared types and descriptor parser belong to `@0000/contracts`.

`authorization` contains `id`, `authority`, `subjectId`, `organizationId`,
`audience`, `operationId`, and `capability`. All fields must match Platform's
immutable persisted row. Neither the returned descriptor nor the saved row
contains the original bearer, its hash, a session token, or a refresh token.
Platform retains the credential ID and native session, installation, or grant
reference. Existing credential verifiers remain in Platform's credential store.

`operationId` is a nonempty service-owned identifier of at most 256 characters.
`capability` uses Platform's bounded capability-name syntax. The service owns
the operation's immutable payload and its account, chat, and resource ACLs.
Changing a payload or performing an explicit resend requires a distinct
operation ID. Revalidation is a current check, not a reusable execution token.
The consumer checks its resource permissions immediately before execution.

## Outcomes

| HTTP status | Result | Meaning |
| --- | --- | --- |
| `200` | `allowed` | The saved binding and original actor's current authority are valid. |
| `403` | `denied` | Revoked, expired, unsupported, missing, malformed, or mismatched actor authority or descriptor. Conflicting captures are also denied. |
| `503` | `authority_unavailable` | Platform cannot establish current authority, including failed service-verifier authentication or unavailable D1 state. |

Protected-route limits can return `429`; the client treats that response as
`authority_unavailable`. Transport failures, redirects, invalid responses, and
deadline expiry also return `authority_unavailable`. Neither failure category
permits execution. No positive authorization cache or automatic retry exists.
An operation already authorized may finish while revocation races with it.

## Actor and lineage support

| Original actor | Capture | Required current lineage |
| --- | --- | --- |
| Human with first-party browser OAuth credential | Supported | The exact Better Auth session that originated its OAuth flow, plus the browser installation, membership, consent, client, credential, and catalog. Session deletion or expiry denies saved work even when ordinary OAuth authentication remains valid. |
| Personal-harness OAuth agent | Supported | Its exact delegated installation and grant, current membership, consent, client, credential, catalog, and any refresh-family checks used by ordinary authentication. The human's browser sign-out alone does not revoke this delegation. |
| Organization-owned managed agent | Supported | Its exact organization-owned agent grant, enabled agent, organization, credential, and catalog. The creator's departure does not revoke the organization's agent. |
| Personal human API credential without originating session lineage | Denied | It does not establish a revocation-checkable originating session. |
| Service principal, including a scheduler | Denied as original actor | A service credential cannot stand in for saved actor authorization. The registered resource service's verifier authenticates the contract calls. |
| Guest credential or guest bootstrap control | Denied | Guest resource grants are not this organization-bound saved-operation contract. |

## Expiry and capture retries

Saved authority never outlives the captured credential's validity. Credential
expiry, rotation, or revocation denies existing saved work, even if an
installation or grant remains active. Refresh does not silently transfer saved
authority to a successor access credential. Work scheduled beyond the captured
credential's lifetime requires a new explicit authorized operation. This is a
conservative bound, not a long-lived delegation issuer.

`(service_id, operationId)` is the capture idempotency key. Concurrent or
lost-response retries with the same current credential, actor, capability, and
lineage return the same descriptor. Different bindings are denied and never
overwrite the row. Retries after revocation or expiry are denied. A new login,
replacement membership, credential, or grant cannot resurrect the old operation.
A lost response does not authorize persisting the user's bearer for later retry.
The consumer can retry while the original request credential is still available;
otherwise it preserves the work as unresolved rather than assuming permission.

## Local verification boundary

`worker/test/saved-operations.test.ts` exercises real Worker HTTP and D1 state,
tampering, capture races, managed-grant revocation, expiry, unsupported actors,
and authority failure. Existing browser and harness OAuth tests cover native
session deletion, session expiry, installation revocation, and membership loss.
`scripts/test-restart.mjs` checks binding persistence, capture retry after a
fresh runtime, and revoked-grant denial across another runtime restart.

These are local Platform contract checks, not Communicator adoption, outbound
delivery, provider acceptance, production migration, or release packaging.
