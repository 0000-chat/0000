import { Button } from "@/components/ui/button";
import type {
  Command,
  CommandStatus,
  ConfirmationDecision,
  OutboundAction,
} from "@communicator/contracts";

const phaseLabels: Record<CommandStatus, string> = {
  accepted: "Accepted",
  waiting_for_connection: "Waiting for connection",
  confirmation_required: "Confirmation required",
  delivery_uncertain: "Delivery uncertain",
  scheduled: "Scheduled",
  reading: "Reading",
  typing: "Typing",
  submitted_to_matrix: "Submitted to messaging service",
  matrix_confirmed: "Messaging service confirmed",
  bridged: "Bridged",
  delivered: "Delivered",
  cancelled: "Cancelled",
  unsupported: "Unsupported",
  failed: "Failed",
};

function phaseLabel(status: string) {
  return phaseLabels[status as CommandStatus] ?? "Status unavailable";
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function CommandTimeline({
  commands,
  identityLabels,
  canDecide = false,
  isDeciding = false,
  onDecision,
}: {
  commands: Command[];
  identityLabels?: ReadonlyMap<string, string>;
  canDecide?: boolean;
  isDeciding?: boolean;
  onDecision?: (
    commandId: string,
    decision: ConfirmationDecision | OutboundAction,
  ) => void;
}) {
  return (
    <ol aria-label="Command activity" className="grid gap-4">
      {commands.map((command) => (
        <li
          key={command.id}
          className="rounded-xl border bg-card p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold">{command.operation}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Identity:{" "}
                {identityLabels?.get(command.identity_id) ??
                  command.identity_id}
              </p>
            </div>
            <span
              className="rounded-full border px-2 py-1 text-xs font-medium"
              data-status={command.status}
            >
              {phaseLabel(command.status)}
            </span>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Account</dt>
              <dd className="font-medium">
                {command.account_id ?? "Unavailable"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Account identity</dt>
              <dd className="font-medium">
                {identityLabels?.get(
                  command.resource_identity_id ?? command.identity_id,
                ) ??
                  command.resource_identity_id ??
                  command.identity_id}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Conversation</dt>
              <dd className="font-medium">
                <a
                  className="underline underline-offset-2"
                  href={`/conversations/${encodeURIComponent(command.conversation_id)}?identity=${encodeURIComponent(command.resource_identity_id ?? command.identity_id)}`}
                >
                  {command.conversation_id}
                </a>
              </dd>
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <dt className="text-muted-foreground">Saved message</dt>
              <dd className="mt-1 break-words font-medium">
                {command.message_id ? (
                  <a
                    className="underline underline-offset-2"
                    href={`/conversations/${encodeURIComponent(command.conversation_id)}?identity=${encodeURIComponent(command.resource_identity_id ?? command.identity_id)}&message=${encodeURIComponent(command.message_id)}#${encodeURIComponent(command.message_id)}`}
                  >
                    Open saved message {command.message_id}
                  </a>
                ) : (
                  "Message reference unavailable"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Delivery mode</dt>
              <dd className="font-medium">
                {command.delivery_mode === "paced" ? "Human-paced" : "Direct"}
              </dd>
            </div>
            {command.transaction_id && (
              <div>
                <dt className="text-muted-foreground">Transaction</dt>
                <dd className="break-all font-medium">
                  {command.transaction_id}
                </dd>
              </div>
            )}
            {command.request_digest && (
              <div>
                <dt className="text-muted-foreground">Request digest</dt>
                <dd className="break-all font-medium">
                  {command.request_digest}
                </dd>
              </div>
            )}
            {command.matrix_stage && (
              <div>
                <dt className="text-muted-foreground">Matrix confirmation</dt>
                <dd className="font-medium">{command.matrix_stage}</dd>
              </div>
            )}
            {command.bridge_stage && (
              <div>
                <dt className="text-muted-foreground">Bridge acceptance</dt>
                <dd className="font-medium">{command.bridge_stage}</dd>
              </div>
            )}
            {command.provider_stage && (
              <div>
                <dt className="text-muted-foreground">Provider evidence</dt>
                <dd className="font-medium">{command.provider_stage}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Original save</dt>
              <dd className="font-medium">
                {formatTimestamp(command.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Updated</dt>
              <dd className="font-medium">
                {formatTimestamp(command.updated_at)}
              </dd>
            </div>
            {command.confirmation_due_at && (
              <div>
                <dt className="text-muted-foreground">Confirmation due</dt>
                <dd className="font-medium">
                  {formatTimestamp(command.confirmation_due_at)}
                </dd>
              </div>
            )}
            {command.confirmation_decision && (
              <div>
                <dt className="text-muted-foreground">Decision</dt>
                <dd className="font-medium">
                  {command.confirmation_decision === "confirm"
                    ? "Confirmed"
                    : "Cancelled"}
                </dd>
              </div>
            )}
            {command.confirmation_actor_principal_id && (
              <div>
                <dt className="text-muted-foreground">Decision actor</dt>
                <dd className="font-medium">
                  {command.confirmation_actor_principal_id}
                  {command.confirmation_actor_identity_id
                    ? ` (${identityLabels?.get(command.confirmation_actor_identity_id) ?? command.confirmation_actor_identity_id})`
                    : ""}
                </dd>
              </div>
            )}
            {command.confirmation_decided_at && (
              <div>
                <dt className="text-muted-foreground">Decision time</dt>
                <dd className="font-medium">
                  {formatTimestamp(command.confirmation_decided_at)}
                </dd>
              </div>
            )}
            {command.last_action && (
              <div>
                <dt className="text-muted-foreground">Human action</dt>
                <dd className="font-medium">{command.last_action}</dd>
              </div>
            )}
            {command.last_action_actor_principal_id && (
              <div>
                <dt className="text-muted-foreground">Action actor</dt>
                <dd className="font-medium">
                  {command.last_action_actor_principal_id}
                </dd>
              </div>
            )}
            {command.last_action_at && (
              <div>
                <dt className="text-muted-foreground">Action time</dt>
                <dd className="font-medium">
                  {formatTimestamp(command.last_action_at)}
                </dd>
              </div>
            )}
            {command.duplicate_risk && (
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-muted-foreground">Duplicate risk</dt>
                <dd className="font-medium text-orange-700">
                  A deliberate resend may create a duplicate message.
                </dd>
              </div>
            )}
          </dl>
          {command.status === "waiting_for_connection" && (
            <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
              Waiting for the saved account connection. The original save time
              and confirmation deadline remain fixed.
            </p>
          )}
          {command.status === "confirmation_required" && (
            <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
              Confirmation is required before this saved command can continue.
            </p>
          )}
          {command.status === "delivery_uncertain" && (
            <div className="mt-3 rounded-md border border-orange-500/40 bg-orange-500/10 p-3 text-sm">
              <p>
                Delivery is uncertain. Matrix and bridge evidence describe
                acceptance stages; provider evidence is required before this is
                shown as delivered.
              </p>
              {command.uncertainty_reason && (
                <p className="mt-1">Reason: {command.uncertainty_reason}</p>
              )}
              {command.chat_paused && (
                <p className="mt-1 font-medium">
                  New sends in this conversation are paused until a human
                  chooses an action.
                </p>
              )}
            </div>
          )}
          {command.status === "cancelled" &&
            command.confirmation_decision === "cancel" && (
              <p className="mt-3 rounded-md border p-2 text-sm">
                This saved command was cancelled by the recorded decision actor.
              </p>
            )}
          {canDecide && onDecision && (
            <div
              aria-label={`Controls for ${command.operation}`}
              className="mt-4 flex flex-wrap gap-2"
            >
              {command.status === "confirmation_required" && (
                <Button
                  type="button"
                  size="sm"
                  disabled={isDeciding}
                  onClick={() => onDecision(command.id, "confirm")}
                >
                  Confirm dispatch
                </Button>
              )}
              {(command.status === "waiting_for_connection" ||
                command.status === "confirmation_required" ||
                command.status === "accepted") && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={isDeciding}
                  onClick={() => onDecision(command.id, "cancel")}
                >
                  Cancel dispatch
                </Button>
              )}
              {command.status === "delivery_uncertain" && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={isDeciding}
                    onClick={() => onDecision(command.id, "cancel")}
                  >
                    Cancel uncertain send
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isDeciding}
                    onClick={() => onDecision(command.id, "continue")}
                  >
                    Continue chat
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={isDeciding}
                    onClick={() => onDecision(command.id, "resend")}
                  >
                    Deliberate resend (duplicate risk)
                  </Button>
                </>
              )}
            </div>
          )}
          {command.failure_code && (
            <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">
              Failure reason: {command.failure_code}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
