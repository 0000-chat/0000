import type {
  CommandStatus,
  ConfirmationDecision,
  OutboundDispatchStatus,
} from "@communicator/contracts";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

type TransitionableDispatchStatus = Extract<
  OutboundDispatchStatus,
  "pending" | "waiting_for_connection" | "confirmation_required" | "cancelled"
>;

export type OutboundLifecycleInput = Readonly<{
  dispatchStatus: OutboundDispatchStatus;
  commandStatus: CommandStatus;
  confirmationDecision: ConfirmationDecision | null;
  confirmationDueAt: string | null;
  createdAt: string;
  now: string;
  connectionAvailable: boolean;
}>;

export type OutboundLifecycleTransition = Readonly<{
  dispatchStatus: OutboundDispatchStatus;
  commandStatus: CommandStatus;
  confirmationDueAt: string | null;
}>;

const parseMilliseconds = (timestamp: string): number => {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("outbound lifecycle timestamp is invalid");
  }
  return milliseconds;
};

const originalDueAt = (input: OutboundLifecycleInput): string => {
  if (input.confirmationDueAt !== null) {
    parseMilliseconds(input.confirmationDueAt);
    return input.confirmationDueAt;
  }

  const dueMilliseconds = parseMilliseconds(input.createdAt) + FOUR_HOURS_MS;
  if (!Number.isSafeInteger(dueMilliseconds)) {
    throw new Error("outbound lifecycle due time is out of range");
  }
  return new Date(dueMilliseconds).toISOString();
};

const commandStatusForDispatch = (
  current: CommandStatus,
  dispatchStatus: OutboundDispatchStatus,
): CommandStatus => {
  switch (dispatchStatus) {
    case "pending":
      return "accepted";
    case "waiting_for_connection":
      return "waiting_for_connection";
    case "confirmation_required":
      return "confirmation_required";
    case "cancelled":
      return "cancelled";
    default:
      return current;
  }
};

const transitionable = (
  status: OutboundDispatchStatus,
): status is TransitionableDispatchStatus =>
  status === "pending" ||
  status === "waiting_for_connection" ||
  status === "confirmation_required" ||
  status === "cancelled";

/**
 * Apply one deterministic lifecycle step. The caller persists the returned
 * tuple in the same transaction as any decision record. No transition ever
 * changes the original created_at value; when a pending command first becomes
 * offline, its due time is derived from that original timestamp.
 */
export function transitionOutboundLifecycle(
  input: OutboundLifecycleInput,
): OutboundLifecycleTransition {
  const currentStatus = input.dispatchStatus;
  if (!transitionable(currentStatus)) {
    return {
      dispatchStatus: currentStatus,
      commandStatus: input.commandStatus,
      confirmationDueAt: input.confirmationDueAt,
    };
  }

  const nowMilliseconds = parseMilliseconds(input.now);
  const dueAt =
    input.confirmationDueAt === null
      ? null
      : originalDueAt(input);

  if (
    input.confirmationDecision === "cancel" &&
    currentStatus !== "cancelled"
  ) {
    return {
      dispatchStatus: "cancelled",
      commandStatus: "cancelled",
      confirmationDueAt: dueAt,
    };
  }

  if (currentStatus === "cancelled") {
    return {
      dispatchStatus: currentStatus,
      commandStatus: "cancelled",
      confirmationDueAt: dueAt,
    };
  }

  if (input.confirmationDecision === "confirm") {
    const nextStatus = input.connectionAvailable
      ? "pending"
      : "waiting_for_connection";
    return {
      dispatchStatus: nextStatus,
      commandStatus: commandStatusForDispatch(input.commandStatus, nextStatus),
      confirmationDueAt:
        nextStatus === "waiting_for_connection"
          ? (dueAt ?? originalDueAt(input))
          : dueAt,
    };
  }

  if (currentStatus === "confirmation_required") {
    return {
      dispatchStatus: currentStatus,
      commandStatus: commandStatusForDispatch(input.commandStatus, currentStatus),
      confirmationDueAt: dueAt ?? originalDueAt(input),
    };
  }

  if (currentStatus === "waiting_for_connection") {
    const waitingDueAt = dueAt ?? originalDueAt(input);
    if (nowMilliseconds >= parseMilliseconds(waitingDueAt)) {
      return {
        dispatchStatus: "confirmation_required",
        commandStatus: "confirmation_required",
        confirmationDueAt: waitingDueAt,
      };
    }
    const nextStatus = input.connectionAvailable
      ? "pending"
      : "waiting_for_connection";
    return {
      dispatchStatus: nextStatus,
      commandStatus: commandStatusForDispatch(input.commandStatus, nextStatus),
      confirmationDueAt: waitingDueAt,
    };
  }

  if (!input.connectionAvailable) {
    const pendingDueAt = dueAt ?? originalDueAt(input);
    const nextStatus =
      nowMilliseconds >= parseMilliseconds(pendingDueAt)
        ? "confirmation_required"
        : "waiting_for_connection";
    return {
      dispatchStatus: nextStatus,
      commandStatus: commandStatusForDispatch(input.commandStatus, nextStatus),
      confirmationDueAt: pendingDueAt,
    };
  }

  return {
    dispatchStatus: currentStatus,
    commandStatus: commandStatusForDispatch(input.commandStatus, currentStatus),
    confirmationDueAt: dueAt,
  };
}
