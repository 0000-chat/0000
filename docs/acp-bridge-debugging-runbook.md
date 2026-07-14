# ACP Bridge Debugging Runbook

## Tool completion versus session liveness

- `bridge.session.tool_call_tracked` records the bridge's timeout policy for a
  tool call without logging its arguments. Use `toolKind`, `toolClass`,
  `toolPolicyId`, and `classificationSource` to see why that policy applied.
- `bridge.session.tool_result_timeout` with `terminal: false` means the bridge
  did not observe a matching completion by the policy deadline. It is not proof
  that the ACP session died, and it does not cancel or replay the parent prompt.
- `classificationSource: "structured_kind"` means the ACP `kind` overrode
  display-title heuristics. `runtime_policy` and `generic_policy` identify the
  explicit title-matching paths used for executable or delegated work.
- A terminal `acp_method_timeout` with
  `failureClass: "provider_silent_after_tool"` means the provider remained idle
  through the ACP request deadline. Its safe tool metadata identifies where
  progress was last observed.
- Do not automatically replay a prompt after silence: earlier tool activity may
  already have requested permission, edited files, or started an execution.

## Triage order

1. Find `bridge.session.tool_call_tracked` for the queue item and note the
   classification source and policy.
2. Check for a matching result or reconciliation event. A later tool start or
   assistant output can legitimately reconcile a stale standard-tool call.
3. If an unresolved-tool observation exists, continue to the prompt's terminal
   result. Treat `acp_method_timeout`, process exit, and transport closure as
   the actual failure boundary.
4. Escalate a repeatable provider silence with the queue timestamp, runtime
   profile, tool kind/class/policy, and terminal reason. Do not include prompts,
   tool arguments, credentials, or raw payloads.
