import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { Button } from "@/components/ui/button";
import { apiClient, isDefinitiveRequestRejection } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { CommandTimeline } from "./command-timeline";
import { ReceiptOperations } from "./receipt-operations";
import type {
  ConfirmationDecision,
  OutboundAction,
  OutboundEvidenceRecord,
} from "@communicator/contracts";

export function ActivityPage() {
  const queryClient = useQueryClient();
  const [evidenceCommandId, setEvidenceCommandId] = useState<string | null>(
    null,
  );
  const {
    session,
    identities,
    isLoading: identityLoading,
  } = useIdentityContext();
  const isAdministrator =
    (session?.membership.role === "owner" ||
      session?.membership.role === "admin") &&
    (session?.principal.type === "human" ||
      session?.principal.type === "operator");
  const commandsQuery = useQuery({
    queryKey: queryKeys.commands(),
    queryFn: () => apiClient.getCommands(),
    enabled: isAdministrator,
  });
  const evidenceQuery = useQuery({
    queryKey: queryKeys.commandEvidence(evidenceCommandId ?? "none"),
    queryFn: () => apiClient.getCommandEvidence(evidenceCommandId ?? ""),
    enabled: isAdministrator && evidenceCommandId !== null,
  });
  const receiptOperationsQuery = useQuery({
    queryKey: queryKeys.readReceiptOperations,
    queryFn: () => apiClient.getReadReceiptOperations({ limit: 50 }),
    enabled: isAdministrator,
  });
  const decisionMutation = useMutation({
    mutationFn: ({
      commandId,
      decision,
      duplicateRiskAcknowledged,
    }: {
      commandId: string;
      decision: ConfirmationDecision | OutboundAction;
      duplicateRiskAcknowledged?: boolean;
    }) =>
      apiClient.decideCommand(
        commandId,
        decision,
        `activity-${commandId}-${decision}`,
        duplicateRiskAcknowledged,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.commands(),
      });
    },
  });
  const commands = commandsQuery.data ?? [];
  const identityLabels = new Map(
    identities.map((identity) => [identity.id, identity.display_name]),
  );
  const evidenceByCommand = new Map<string, OutboundEvidenceRecord[]>();
  if (evidenceCommandId !== null && evidenceQuery.data !== undefined) {
    evidenceByCommand.set(evidenceCommandId, evidenceQuery.data);
  }

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Administrator delivery review
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Review every saved outbound command and make the explicit human
          decision required before stale offline delivery can continue.
        </p>
      </div>
      {identityLoading && <p role="status">Loading activity…</p>}
      {!identityLoading && !isAdministrator && (
        <p role="alert" className="rounded-lg border border-dashed p-6 text-sm">
          Administrator access is required to review outbound delivery.
        </p>
      )}
      {isAdministrator && commandsQuery.isLoading && (
        <p role="status">Loading activity…</p>
      )}
      {isAdministrator && commandsQuery.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Unable to load administrator delivery activity.</p>
          <button
            type="button"
            className="underline"
            onClick={() => void commandsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      )}
      {decisionMutation.isError && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
        >
          <p>
            {isDefinitiveRequestRejection(decisionMutation.error)
              ? "Decision rejected. This command may be stale; refresh the activity list and review its current status."
              : "The delivery decision could not be saved. Refresh the activity list and try again."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              decisionMutation.reset();
              void commandsQuery.refetch();
            }}
          >
            Refresh activity
          </Button>
        </div>
      )}
      {evidenceQuery.isError && evidenceCommandId !== null && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
        >
          <p>Unable to load evidence for this saved command.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void evidenceQuery.refetch()}
          >
            Refresh evidence
          </Button>
        </div>
      )}
      {isAdministrator &&
        !commandsQuery.isLoading &&
        !commandsQuery.isError &&
        commands.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No outbound commands are available for this tenant.
          </p>
        )}
      {isAdministrator && !commandsQuery.isError && (
        <CommandTimeline
          commands={commands}
          identityLabels={identityLabels}
          canDecide
          isDeciding={decisionMutation.isPending}
          evidenceByCommand={evidenceByCommand}
          evidenceCommandId={evidenceCommandId}
          isLoadingEvidence={evidenceQuery.isFetching}
          onEvidenceRequest={(commandId) =>
            setEvidenceCommandId((current) =>
              current === commandId ? null : commandId,
            )
          }
          onDecision={(commandId, decision) =>
            decisionMutation.mutate({
              commandId,
              decision,
              duplicateRiskAcknowledged: decision === "resend",
            })
          }
        />
      )}
      {isAdministrator && receiptOperationsQuery.isLoading && (
        <p role="status">Loading read receipts…</p>
      )}
      {isAdministrator && receiptOperationsQuery.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Unable to load read receipt operations.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void receiptOperationsQuery.refetch()}
          >
            Retry read receipts
          </Button>
        </div>
      )}
      {isAdministrator && !receiptOperationsQuery.isError && (
        <ReceiptOperations
          operations={receiptOperationsQuery.data?.items ?? []}
        />
      )}
    </section>
  );
}
