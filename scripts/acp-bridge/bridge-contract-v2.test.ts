import { describe, expect, test } from "bun:test"

import {
  BRIDGE_CONTRACT_VERSION,
  bridgeDiagnosticReasonCodes,
  bridgeFeatureEnabled,
  bridgeV2FeatureDefaults,
  isBridgeDiagnosticReasonCode,
  requireBridgeTraceFields,
  validateBridgeDiagnosticPacketInput,
} from "./bridge-contract-v2"

const expectedBridgeDiagnosticReasonCodes = [
  "bridge_device_stale",
  "pairing_code_expired",
  "pairing_code_invalid",
  "duplicate_profile_import",
  "runtime_profile_unavailable",
  "contract_version_unsupported",
  "capability_missing",
  "agent_concurrency_limit_reached",
  "runtime_concurrency_limit_reached",
  "runtime_concurrency_limit_lower_than_configured",
  "bridge_max_in_flight_reached",
  "mailbox_fanout_limit_reached",
  "control_lane_busy",
  "queue_claim_expired",
  "host_poll_failed",
  "host_heartbeat_rejected",
  "host_schema_validation_failed",
  "host_time_skew_detected",
  "sqlite_migration_failed",
  "sqlite_lock_busy",
  "local_persistence_unavailable",
  "local_journal_healthy",
  "local_disk_full",
  "outbox_sequence_gap",
  "payload_too_large",
  "diagnostic_packet_publish_failed",
  "runtime_profile_probe_failed",
  "runtime_conformance_missing",
  "runtime_conformance_stale",
  "runtime_conformance_failed",
  "runtime_conformance_insufficient",
  "runtime_quarantined",
  "runtime_profile_changed_mid_turn",
  "runtime_isolation_unverified",
  "runtime_cwd_switch_required",
  "runtime_config_option_unavailable",
  "runtime_config_apply_failed",
  "runtime_config_restore_failed",
  "acp_process_start_failed",
  "acp_session_create_failed",
  "acp_session_resume_failed",
  "acp_method_timeout",
  "acp_invalid_response",
  "acp_unknown_notification",
  "prompt_send_failed",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_silent_timeout",
  "provider_event_malformed",
  "provider_stop_reason_missing",
  "normalization_failed",
  "permission_timeout",
  "permission_timeout_denied",
  "permission_response_unmatched",
  "permission_request_orphaned",
  "interaction_expired",
  "interaction_response_rejected",
  "interaction_delivery_failed",
  "secret_input_redirect_required",
  "cancel_not_acknowledged",
  "session_close_unsupported",
  "session_close_failed",
  "session_revive_failed",
  "session_replacement_required",
  "ambiguous_after_crash",
  "outbox_replayed",
  "stop_already_terminal",
  "stop_already_cancelling",
  "steer_cancel_failed",
  "steer_reprompt_failed",
  "steer_empty_instruction",
  "steer_duplicate_request",
  "mailbox_delivery_failed",
  "mailbox_loop_budget_exhausted",
  "mailbox_group_fanout_partial_failure",
  "thread_deleted_before_claim",
  "thread_archived_policy_blocked",
  "thread_activity_projection_failed",
  "event_idempotency_conflict",
  "convex_write_retrying",
  "convex_write_failed",
  "runtime_process_exited",
  "feature_flag_disabled_for_work",
  "v2_pending_work_blocked",
  "organization_link_revoked",
] as const

describe("bridge contract v2 helpers", () => {
  test("accept the spec reason catalog and reject unknown codes", () => {
    expect(BRIDGE_CONTRACT_VERSION).toBe(2)

    expect(bridgeDiagnosticReasonCodes).toEqual(expectedBridgeDiagnosticReasonCodes)

    for (const reasonCode of expectedBridgeDiagnosticReasonCodes) {
      expect(isBridgeDiagnosticReasonCode(reasonCode)).toBe(true)
    }

    expect(isBridgeDiagnosticReasonCode("not_a_bridge_reason_code")).toBe(false)
  })

  test("apply feature defaults and explicit overrides", () => {
    expect(bridgeV2FeatureDefaults.v2Claiming).toBe(false)
    expect(bridgeFeatureEnabled(undefined, "v2Claiming")).toBe(false)
    expect(bridgeFeatureEnabled({ v2Claiming: true }, "v2Claiming")).toBe(true)
    expect(bridgeFeatureEnabled({ v2Claiming: false }, "v2Claiming")).toBe(false)
  })

  test("report missing required trace fields", () => {
    expect(() =>
      requireBridgeTraceFields(
        {
          traceId: "trace_123",
          spanId: "span_123",
          organizationId: "org_123",
        },
        ["traceId", "spanId", "bridgeLinkId", "bridgeDeviceId"],
      ),
    ).toThrow("Missing required trace fields: bridgeLinkId, bridgeDeviceId")
  })

  test("reject unknown diagnostic reason codes before persistence", () => {
    expect(() =>
      validateBridgeDiagnosticPacketInput({
        reasonCode: "not_a_bridge_reason_code",
        trace: {
          bridgeDeviceId: "device_123",
          bridgeLinkId: "link_123",
          organizationId: "org_123",
          spanId: "span_123",
          traceId: "trace_123",
        },
      }),
    ).toThrow("Unknown bridge diagnostic reason code: not_a_bridge_reason_code")
  })
})
