# Conductor 401 Bridge Recovery Design

## Context

The OVH bridge process hosts two registrations. One registration remains healthy,
while `bridge_065772f00e669bf8ed95b55b` stopped polling after Convex returned:

```text
401 {"error":"Instance not served by this Conductor"}
```

The bridge currently classifies every HTTP 401 as a permanent authentication
failure. It stores `registrationFailure`, marks the registration disconnected,
and skips every later loop iteration until the process restarts. The affected
registration therefore looked unavailable locally while its last cloud device
record still looked online. Three prompt queue rows were accepted but remained
unclaimed indefinitely.

## Goals

- Recover the currently stranded registration and verify the three reported
  queue rows progress.
- Treat the known Convex Conductor-routing response as transient even when its
  HTTP status is 401.
- Preserve permanent disablement for genuine invalid, revoked, unpaired, or
  wrong-scope bridge credentials.
- Add regression coverage at both classification and registration-loop levels.
- Keep the change isolated to the public bridge runtime unless recovery exposes
  a separate app/backend defect.

## Non-goals

- Broadly retry every HTTP 401 or 403.
- Change bridge credentials, pairing state, or Convex deployment configuration.
- Redesign the queue protocol or registration scheduler.
- Automatically replay failed agent output; the existing durable queued prompts
  remain the source of work.

## Chosen Design

### Immediate recovery

Before restarting, read the aggregate bridge status and require zero active
sessions and zero in-flight commands across registrations. Restart the user
systemd bridge service, then verify:

1. the affected registration no longer has `registrationFailure`;
2. it reports `connected: true` and current poll/heartbeat timestamps;
3. the three queue rows leave `queued/eligible_unclaimed` or produce an explicit
   new terminal reason;
4. agent sessions and thread activity begin receiving bridge events.

If the Conductor response persists after restart, stop and collect the new
response rather than changing credentials.

### Durable classification fix

Add an explicit transient-response predicate in
`scripts/acp-bridge/bridge-availability.ts`. It recognizes the bounded,
case-insensitive phrase `Instance not served by this Conductor` before the
generic HTTP-status rules.

`classifyBridgeCloudFailure` will return `retryable` for that response regardless
of the accompanying 401. Existing credential-specific response bodies and other
401/403 responses continue to return `auth_failed`.

`buildBridgeRegistrationFailure` already delegates to this classifier. A
retryable result therefore returns no permanent registration failure, allowing
the existing loop error/backoff path to retry without introducing a second
recovery mechanism.

### Error handling and observability

- Preserve the existing redaction path for cloud errors.
- Do not include tokens, credentials, prompts, or response content beyond the
  existing bounded error message.
- Retry through the existing loop error handler and cadence.
- Do not emit `bridge.registration.disabled` for the Conductor-routing response.
- Continue emitting the permanent-disable event for genuine authentication
  failures.

## Testing

Add failing tests first for:

1. `classifyBridgeCloudFailure` returning `retryable` for the Conductor response
   with status 401;
2. genuine invalid-token and revoked-device responses remaining `auth_failed`;
3. `buildBridgeRegistrationFailure` returning `undefined` for the Conductor
   response;
4. a loop iteration routing the response through the retryable error path without
   setting `status.registrationFailure` or logging
   `bridge.registration.disabled`.

Run the focused bridge tests, then the repository-required full suite and
typecheck.

## Delivery

Implement from current `origin/main` in `codex/conductor-401-retry`, commit the
focused change, and push the feature branch for review. Do not push directly to
`main`. The operational restart is independent of branch landing and restores
service immediately when the upstream response is no longer present.
