import type { Command, CommandStatus } from "@communicator/contracts";

const phaseLabels: Record<CommandStatus, string> = {
  accepted: "Accepted",
  waiting_for_connection: "Waiting for connection",
  confirmation_required: "Confirmation required",
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
  identityLabel,
}: {
  commands: Command[];
  identityLabel?: string;
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
                Identity: {identityLabel ?? command.identity_id}
              </p>
            </div>
            <span className="rounded-full border px-2 py-1 text-xs font-medium">
              {phaseLabel(command.status)}
            </span>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Delivery mode</dt>
              <dd className="font-medium">
                {command.delivery_mode === "paced" ? "Human-paced" : "Direct"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Created</dt>
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
          </dl>
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
