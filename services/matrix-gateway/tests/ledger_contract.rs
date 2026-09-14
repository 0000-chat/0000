use std::fmt::Write as _;

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::BackfillJob,
    config::MAX_BATCH_CANONICAL_BYTES,
    ingestion::PendingBatch,
    ledger::{
        BackfillCommitOutcome, BackfillState, FinalizeOutcome, LedgerPressure, LiveCommitOutcome,
        MAX_BACKFILL_PAGE_BATCHES, MAX_BACKFILL_PAGINATION_BYTES, MAX_BACKFILL_PARAMETERS_BYTES,
        MAX_LEDGER_ID_BYTES, MAX_WINDOW_BATCHES, MAX_WINDOW_ROOM_CANDIDATES, NewBackfillJob,
        NewLiveGapJob, NewLiveWindow, PendingIngestionBatch, PurgeOutcome, RoomAnchorCandidate,
        RoomEphemeralCandidate, STORE_BACKFILL_CONFLICT, STORE_BACKFILL_CORRUPT,
        STORE_BACKFILL_INVALID, STORE_BACKFILL_NOT_READY, STORE_LEDGER_CAS_MISMATCH,
        STORE_LEDGER_CONFLICT, STORE_LEDGER_CORRUPT, STORE_LEDGER_INVALID, STORE_LEDGER_NOT_READY,
        STORE_LEDGER_TOO_LARGE, StoredBackfillJob, StoredLiveGapJob,
    },
    store_types::MAX_ROOM_ANCHOR_BYTES,
};

const WINDOW_ID: &str = "window_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BATCH_ID: &str = "batch_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GAP_JOB_ID: &str = "gap_job_0123456789abcdef";
const BACKFILL_JOB_ID: &str = "018f0f00-0000-7000-8000-000000000001";
const CANARY: &str = "ledger-contract-secret-canary";

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("valid test timestamp")
}

fn secret(value: &str) -> Vec<u8> {
    value.as_bytes().to_vec()
}

fn assert_code(error: communicator_matrix_gateway::secret::SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert!(!error.to_string().contains(CANARY));
    assert!(!format!("{error:?}").contains(CANARY));
}

fn backfill_job() -> BackfillJob {
    BackfillJob::new(
        BACKFILL_JOB_ID,
        "!room:example.test",
        "2024-01-01T00:00:00.000Z",
        "2024-01-02T00:00:00.000Z",
        100,
    )
    .expect("valid backfill job")
}

#[test]
fn ledger_bounds_and_error_codes_are_frozen() {
    assert_eq!(MAX_WINDOW_BATCHES, 10_000);
    assert_eq!(MAX_WINDOW_ROOM_CANDIDATES, 100_000);
    assert_eq!(MAX_BACKFILL_PAGE_BATCHES, 10_000);
    assert_eq!(MAX_BACKFILL_PARAMETERS_BYTES, 64 * 1024);
    assert_eq!(MAX_BACKFILL_PAGINATION_BYTES, 64 * 1024);
    assert_eq!(MAX_LEDGER_ID_BYTES, 160);

    assert_eq!(STORE_LEDGER_INVALID, "store_ledger_invalid");
    assert_eq!(STORE_LEDGER_TOO_LARGE, "store_ledger_too_large");
    assert_eq!(STORE_LEDGER_CONFLICT, "store_ledger_conflict");
    assert_eq!(STORE_LEDGER_NOT_READY, "store_ledger_not_ready");
    assert_eq!(STORE_LEDGER_CAS_MISMATCH, "store_ledger_cas_mismatch");
    assert_eq!(STORE_LEDGER_CORRUPT, "store_ledger_corrupt");
    assert_eq!(STORE_BACKFILL_INVALID, "store_backfill_invalid");
    assert_eq!(STORE_BACKFILL_CONFLICT, "store_backfill_conflict");
    assert_eq!(STORE_BACKFILL_NOT_READY, "store_backfill_not_ready");
    assert_eq!(STORE_BACKFILL_CORRUPT, "store_backfill_corrupt");
}

#[test]
fn live_window_validates_id_timestamp_and_getters() {
    let created_at = timestamp(1_700_000_000_000);
    let window = NewLiveWindow::new(WINDOW_ID, created_at, 7).expect("valid live window");
    assert_eq!(window.window_id(), WINDOW_ID);
    assert_eq!(window.created_at(), &created_at);
    assert_eq!(window.ignored_count(), 7);

    for invalid_id in [
        "window_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
        "window_0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDE",
        "wrong_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ] {
        assert_code(
            NewLiveWindow::new(invalid_id, created_at, 0).unwrap_err(),
            STORE_LEDGER_INVALID,
        );
    }

    assert_code(
        NewLiveWindow::new(WINDOW_ID, created_at + Duration::nanoseconds(1), 0).unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        NewLiveWindow::new(WINDOW_ID, created_at, u64::MAX).unwrap_err(),
        STORE_LEDGER_INVALID,
    );
}

#[test]
fn room_candidates_validate_fixed_lookups_protected_values_and_expiry() {
    let lookup = vec![0x42; 32];
    let expiry = timestamp(1_700_000_000_500);
    let anchor =
        RoomAnchorCandidate::new(lookup.clone(), secret(CANARY)).expect("valid anchor candidate");
    assert_eq!(anchor.room_lookup(), lookup.as_slice());
    assert_eq!(anchor.anchor_event().as_bytes(), CANARY.as_bytes());

    let ephemeral = RoomEphemeralCandidate::new(lookup.clone(), secret(CANARY), expiry)
        .expect("valid ephemeral candidate");
    assert_eq!(ephemeral.room_lookup(), lookup.as_slice());
    assert_eq!(ephemeral.typing_set().as_bytes(), CANARY.as_bytes());
    assert_eq!(ephemeral.typing_expires_at(), &expiry);

    for invalid_lookup in [Vec::new(), vec![0; 31], vec![0; 33]] {
        assert_code(
            RoomAnchorCandidate::new(invalid_lookup.clone(), secret("anchor")).unwrap_err(),
            STORE_LEDGER_INVALID,
        );
        assert_code(
            RoomEphemeralCandidate::new(invalid_lookup, secret("typing"), expiry).unwrap_err(),
            STORE_LEDGER_INVALID,
        );
    }
    assert_code(
        RoomAnchorCandidate::new(lookup.clone(), Vec::new()).unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        RoomEphemeralCandidate::new(lookup.clone(), Vec::new(), expiry).unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        RoomAnchorCandidate::new(lookup.clone(), vec![0; MAX_ROOM_ANCHOR_BYTES + 1]).unwrap_err(),
        STORE_LEDGER_TOO_LARGE,
    );
    assert_code(
        RoomEphemeralCandidate::new(lookup, vec![0; MAX_ROOM_ANCHOR_BYTES + 1], expiry)
            .unwrap_err(),
        STORE_LEDGER_TOO_LARGE,
    );
    assert_code(
        RoomEphemeralCandidate::new(
            vec![0; 32],
            secret("typing"),
            expiry + Duration::nanoseconds(1),
        )
        .unwrap_err(),
        STORE_LEDGER_INVALID,
    );
}

#[test]
fn pending_ingestion_batch_validates_exact_ids_counts_bytes_and_getters() {
    let next_attempt_at = timestamp(1_700_000_001_000);
    let pending = PendingBatch::new("tenant_demo", BATCH_ID, secret(CANARY));
    let value = PendingIngestionBatch::new(BATCH_ID, pending, 3, next_attempt_at)
        .expect("valid pending ingestion batch");
    assert_eq!(value.row_id(), BATCH_ID);
    assert_eq!(value.attempt_count(), 3);
    assert_eq!(value.next_attempt_at(), &next_attempt_at);
    assert_eq!(value.batch().tenant_id(), "tenant_demo");
    assert_eq!(value.batch().batch_id(), BATCH_ID);
    assert_eq!(value.batch().exact_request_bytes(), CANARY.as_bytes());

    assert_code(
        PendingIngestionBatch::new(
            "not-a-batch-id",
            PendingBatch::new("tenant_demo", BATCH_ID, secret("body")),
            0,
            next_attempt_at,
        )
        .unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        PendingIngestionBatch::new(
            BATCH_ID,
            PendingBatch::new("tenant_demo", "batch_wrong", secret("body")),
            0,
            next_attempt_at,
        )
        .unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        PendingIngestionBatch::new(
            BATCH_ID,
            PendingBatch::new("not-valid", BATCH_ID, secret("body")),
            0,
            next_attempt_at,
        )
        .unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        PendingIngestionBatch::new(
            BATCH_ID,
            PendingBatch::new("tenant_demo", BATCH_ID, Vec::new()),
            0,
            next_attempt_at,
        )
        .unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        PendingIngestionBatch::new(
            BATCH_ID,
            PendingBatch::new(
                "tenant_demo",
                BATCH_ID,
                vec![0; MAX_BATCH_CANONICAL_BYTES + 1],
            ),
            0,
            next_attempt_at,
        )
        .unwrap_err(),
        STORE_LEDGER_TOO_LARGE,
    );
    assert_code(
        PendingIngestionBatch::new(
            BATCH_ID,
            PendingBatch::new("tenant_demo", BATCH_ID, secret("body")),
            0,
            next_attempt_at + Duration::nanoseconds(1),
        )
        .unwrap_err(),
        STORE_LEDGER_INVALID,
    );
}

#[test]
fn backfill_and_gap_dtos_validate_and_expose_only_wrappers() {
    let created_at = timestamp(1_700_000_000_000);
    let job = NewBackfillJob::new(backfill_job(), secret(CANARY), created_at)
        .expect("valid new backfill job");
    assert_eq!(job.job().job_id(), BACKFILL_JOB_ID);
    assert_eq!(job.parameters().as_bytes(), CANARY.as_bytes());
    assert_eq!(job.created_at(), &created_at);

    assert_code(
        NewBackfillJob::new(backfill_job(), Vec::new(), created_at).unwrap_err(),
        STORE_BACKFILL_INVALID,
    );
    assert_code(
        NewBackfillJob::new(
            backfill_job(),
            vec![0; MAX_BACKFILL_PARAMETERS_BYTES + 1],
            created_at,
        )
        .unwrap_err(),
        STORE_BACKFILL_INVALID,
    );
    assert_code(
        NewBackfillJob::new(
            backfill_job(),
            secret("params"),
            created_at + Duration::nanoseconds(1),
        )
        .unwrap_err(),
        STORE_BACKFILL_INVALID,
    );

    let stored = StoredBackfillJob::new(
        backfill_job(),
        BackfillState::Running,
        secret(CANARY),
        Some(secret("page")),
        9,
    )
    .expect("valid stored backfill job");
    assert_eq!(stored.job().job_id(), BACKFILL_JOB_ID);
    assert_eq!(stored.state(), BackfillState::Running);
    assert_eq!(stored.parameters().as_bytes(), CANARY.as_bytes());
    assert_eq!(stored.pagination().expect("pagination").as_bytes(), b"page");
    assert_eq!(stored.accepted_events(), 9);

    assert_code(
        StoredBackfillJob::new(
            backfill_job(),
            BackfillState::Running,
            secret("params"),
            Some(Vec::new()),
            0,
        )
        .unwrap_err(),
        STORE_BACKFILL_INVALID,
    );
    assert_code(
        StoredBackfillJob::new(
            backfill_job(),
            BackfillState::Running,
            secret("params"),
            Some(vec![0; MAX_BACKFILL_PAGINATION_BYTES + 1]),
            0,
        )
        .unwrap_err(),
        STORE_BACKFILL_INVALID,
    );
    assert_code(
        StoredBackfillJob::new(
            backfill_job(),
            BackfillState::Running,
            secret("params"),
            None,
            101,
        )
        .unwrap_err(),
        STORE_BACKFILL_INVALID,
    );

    let gap = NewLiveGapJob::new(GAP_JOB_ID, WINDOW_ID, secret(CANARY), created_at)
        .expect("valid live gap job");
    assert_eq!(gap.job_id(), GAP_JOB_ID);
    assert_eq!(gap.live_window_id(), WINDOW_ID);
    assert_eq!(gap.parameters().as_bytes(), CANARY.as_bytes());
    assert_eq!(gap.created_at(), &created_at);

    assert_code(
        NewLiveGapJob::new(GAP_JOB_ID, "not-a-window", secret("params"), created_at).unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        NewLiveGapJob::new(GAP_JOB_ID, WINDOW_ID, Vec::new(), created_at).unwrap_err(),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        NewLiveGapJob::new(
            GAP_JOB_ID,
            WINDOW_ID,
            vec![0; MAX_BACKFILL_PARAMETERS_BYTES + 1],
            created_at,
        )
        .unwrap_err(),
        STORE_LEDGER_TOO_LARGE,
    );

    let stored_gap = StoredLiveGapJob::new(
        GAP_JOB_ID,
        WINDOW_ID,
        BackfillState::Quarantined,
        secret(CANARY),
        4,
    )
    .expect("valid stored live gap job");
    assert_eq!(stored_gap.job_id(), GAP_JOB_ID);
    assert_eq!(stored_gap.live_window_id(), WINDOW_ID);
    assert_eq!(stored_gap.state(), BackfillState::Quarantined);
    assert_eq!(stored_gap.parameters().as_bytes(), CANARY.as_bytes());
    assert_eq!(stored_gap.accepted_events(), 4);
}

#[test]
fn state_and_outcome_conversions_are_closed_and_exact() {
    let states = [
        (BackfillState::Pending, "pending"),
        (BackfillState::Running, "running"),
        (BackfillState::Completed, "completed"),
        (BackfillState::Cancelled, "cancelled"),
        (BackfillState::Quarantined, "quarantined"),
    ];
    for (state, text) in states {
        assert_eq!(state.as_str(), text);
        assert_eq!(state.to_string(), text);
        assert_eq!(format!("{state:?}"), text);
    }

    assert_eq!(
        FinalizeOutcome::Prepared { batch_count: 2 },
        FinalizeOutcome::Prepared { batch_count: 2 }
    );
    assert_eq!(
        LiveCommitOutcome::BatchAccepted {
            accepted_count: 1,
            batch_count: 2,
        },
        LiveCommitOutcome::BatchAccepted {
            accepted_count: 1,
            batch_count: 2,
        }
    );
    assert_eq!(
        BackfillCommitOutcome::BatchAccepted { accepted_events: 3 },
        BackfillCommitOutcome::BatchAccepted { accepted_events: 3 }
    );
}

#[test]
fn scalar_outcomes_have_borrowed_getters_and_safe_debug() {
    let purge = PurgeOutcome::new(1, 2, 3, 4, 5);
    assert_eq!(purge.inbox_rows(), 1);
    assert_eq!(purge.windows(), 2);
    assert_eq!(purge.crypto_rows(), 3);
    assert_eq!(purge.ingestion_rows(), 4);
    assert_eq!(purge.live_gap_jobs(), 5);

    let oldest = timestamp(1_700_000_000_000);
    let pressure = LedgerPressure::new(6, 7, 8, Some(oldest)).expect("valid pressure");
    assert_eq!(pressure.pending_batches(), 6);
    assert_eq!(pressure.pending_bytes(), 7);
    assert_eq!(pressure.quarantined_windows(), 8);
    assert_eq!(pressure.oldest_pending_at(), Some(&oldest));
    assert_eq!(
        LedgerPressure::new(0, 0, 0, None)
            .expect("empty pressure")
            .oldest_pending_at(),
        None
    );
}

#[test]
fn protected_dto_debug_is_redacted_and_fields_are_private() {
    let anchor = RoomAnchorCandidate::new(vec![0; 32], secret(CANARY)).expect("valid anchor");
    let ephemeral = RoomEphemeralCandidate::new(vec![0; 32], secret(CANARY), timestamp(0))
        .expect("valid ephemeral");
    let pending = PendingIngestionBatch::new(
        BATCH_ID,
        PendingBatch::new("tenant_demo", BATCH_ID, secret(CANARY)),
        0,
        timestamp(0),
    )
    .expect("valid pending batch");
    let new_backfill = NewBackfillJob::new(backfill_job(), secret(CANARY), timestamp(0))
        .expect("valid new backfill");
    let new_gap = NewLiveGapJob::new(GAP_JOB_ID, WINDOW_ID, secret(CANARY), timestamp(0))
        .expect("valid new gap");
    let stored_backfill = StoredBackfillJob::new(
        backfill_job(),
        BackfillState::Running,
        secret(CANARY),
        None,
        0,
    )
    .expect("valid stored backfill");
    let stored_gap = StoredLiveGapJob::new(
        GAP_JOB_ID,
        WINDOW_ID,
        BackfillState::Running,
        secret(CANARY),
        0,
    )
    .expect("valid stored gap");

    let formatted = [
        format!("{anchor:?}"),
        format!("{ephemeral:?}"),
        format!("{pending:?}"),
        format!("{new_backfill:?}"),
        format!("{new_gap:?}"),
        format!("{stored_backfill:?}"),
        format!("{stored_gap:?}"),
    ]
    .join(" ");
    assert!(formatted.contains("REDACTED"));
    assert!(!formatted.contains(CANARY));

    let source = include_str!("../src/ledger.rs");
    assert!(source.contains("pub(crate) fn from_str(value: &str)"));
    assert!(!source.contains("pub fn from_str(value: &str)"));
    let mut field_check = String::new();
    write!(&mut field_check, "{source}").expect("copy source for field check");
    assert!(field_check.contains("window_id: String"));
    assert!(!field_check.contains("pub window_id: String"));
}
