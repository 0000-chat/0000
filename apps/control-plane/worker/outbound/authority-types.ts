/**
 * A capability is bound to one mutable authority head.  The discriminant is
 * intentional: an owner/admin authority never carries an account-grant id,
 * and a delegated capability never carries an owner/admin id.
 */
export type OutboundCapability =
  | {
      kind: "account_grant";
      grant_id: string;
      authorization_epoch: number;
    }
  | {
      kind: "owner_admin";
      authority_id: string;
      authority_epoch: number;
    };

export type OutboundTuple = {
  tenant_id: string;
  membership_id: string;
  identity_id: string;
  account_id: string;
  conversation_id: string;
  connection_id: string;
};

export type OutboundCapabilityTuple = OutboundTuple & {
  grant_id: string | null;
  capability: OutboundCapability;
};

export type ReserveOutboundAcceptanceInput = OutboundTuple & {
  idempotency_key: string;
  request_digest: string;
  body_digest: string;
  capability: OutboundCapability;
  reservation_id?: string;
  now: string;
};

export type OutboundAcceptanceStatus = "reserved" | "committed" | "uncertain";

export type OutboundAcceptanceReservation = OutboundCapabilityTuple & {
  id: string;
  idempotency_key: string;
  request_digest: string;
  body_digest: string;
  status: OutboundAcceptanceStatus;
  command_id: string | null;
  message_id: string | null;
  dispatch_id: string | null;
  transaction_id: string | null;
  uncertain_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type OutboundAcceptanceReservationResult =
  | {
      status: "reserved";
      replayed: boolean;
      reservation: OutboundAcceptanceReservation;
    }
  | {
      status: "denied";
      reason:
        | "authorization_revoked"
        | "idempotency_conflict"
        | "invalid_input";
    };

export type FinalizeOutboundAcceptanceInput = OutboundCapabilityTuple & {
  reservation_id: string;
  idempotency_key: string;
  request_digest: string;
  body_digest: string;
  command_id: string;
  message_id: string;
  dispatch_id: string;
  transaction_id: string;
  now: string;
};

export type FinalizeOutboundAcceptanceResult =
  | {
      status: "committed";
      replayed: boolean;
      reservation: OutboundAcceptanceReservation;
    }
  | {
      status: "denied";
      reason:
        | "reservation_not_found"
        | "reservation_not_reserved"
        | "tuple_mismatch"
        | "invalid_input";
    };

export type MarkAcceptanceReservationUncertainInput = {
  tenant_id: string;
  reservation_id: string;
  reason: string;
  now: string;
};

export type MarkAcceptanceReservationUncertainResult =
  | {
      status: "uncertain";
      replayed: boolean;
      reservation: OutboundAcceptanceReservation;
    }
  | {
      status: "denied";
      reason:
        | "reservation_not_found"
        | "reservation_already_uncertain"
        | "invalid_input";
    };

export type ClaimOutboundDispatchInput = OutboundCapabilityTuple & {
  reservation_id: string;
  command_id: string;
  dispatch_id: string;
  transaction_id: string;
  request_digest: string;
  body_digest: string;
  claim_id?: string;
  now: string;
  expires_at: string;
};

export type OutboundDispatchClaimStatus = "claimed" | "uncertain";

export type OutboundDispatchClaim = OutboundCapabilityTuple & {
  id: string;
  reservation_id: string;
  command_id: string;
  dispatch_id: string;
  transaction_id: string;
  request_digest: string;
  body_digest: string;
  status: OutboundDispatchClaimStatus;
  uncertain_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type ClaimOutboundDispatchResult =
  | {
      status: "claimed";
      replayed: false;
      provider_allowed: true;
      claim: OutboundDispatchClaim;
    }
  | {
      status: "replayed";
      replayed: true;
      provider_allowed: false;
      claim: OutboundDispatchClaim;
    }
  | {
      status: "denied";
      reason:
        | "authorization_revoked"
        | "reservation_not_found"
        | "reservation_not_committed"
        | "tuple_mismatch"
        | "claim_conflict"
        | "invalid_input";
    };

export type MarkDispatchClaimUncertainInput = {
  tenant_id: string;
  claim_id: string;
  reason: string;
  now: string;
};

export type MarkDispatchClaimUncertainResult =
  | { status: "uncertain"; claim: OutboundDispatchClaim; replayed: boolean }
  | {
      status: "denied";
      reason: "claim_not_found" | "claim_already_uncertain" | "invalid_input";
    };

/** Provider operations with durable records outside the message ledger. */
export type PrivateAuthorityScope =
  | "conversation.create"
  | "receipt.send"
  | "group.create"
  | "group.manage";

export type PrivateAuthorityReservationInput = OutboundTuple & {
  operation_scope: PrivateAuthorityScope;
  operation_id: string;
  request_hash: string;
  session_generation: string;
  capability: OutboundCapability;
  reservation_id?: string;
  now: string;
};

export type PrivateAuthorityReservation = OutboundCapabilityTuple & {
  id: string;
  operation_scope: PrivateAuthorityScope;
  operation_id: string;
  request_hash: string;
  session_generation: string;
  status: "reserved" | "committed" | "uncertain";
  uncertain_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PrivateAuthorityReservationResult =
  | {
      status: "reserved";
      replayed: boolean;
      reservation: PrivateAuthorityReservation;
    }
  | {
      status: "denied";
      reason:
        | "authorization_revoked"
        | "idempotency_conflict"
        | "invalid_input";
    };

export type PrivateAuthorityClaimInput = OutboundCapabilityTuple & {
  operation_scope: PrivateAuthorityScope;
  reservation_id: string;
  operation_id: string;
  request_hash: string;
  session_generation: string;
  claim_id?: string;
  now: string;
  expires_at: string;
};

export type PrivateAuthorityClaim = OutboundCapabilityTuple & {
  id: string;
  operation_scope: PrivateAuthorityScope;
  reservation_id: string;
  operation_id: string;
  request_hash: string;
  session_generation: string;
  status: "claimed" | "uncertain";
  uncertain_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type PrivateAuthorityClaimResult =
  | {
      status: "claimed";
      replayed: false;
      provider_allowed: true;
      claim: PrivateAuthorityClaim;
    }
  | {
      status: "replayed";
      replayed: true;
      provider_allowed: false;
      claim: PrivateAuthorityClaim;
    }
  | {
      status: "denied";
      reason:
        | "authorization_revoked"
        | "reservation_not_found"
        | "reservation_not_committed"
        | "tuple_mismatch"
        | "claim_conflict"
        | "invalid_input";
    };
