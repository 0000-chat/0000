import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

const statusVariant = (status: string) => {
  if (status === "succeeded") return "default" as const;
  if (status === "failed" || status === "human_action_required")
    return "destructive" as const;
  return "secondary" as const;
};

export function GroupManagementPage() {
  const [evidenceOperationId, setEvidenceOperationId] = useState<string | null>(
    null,
  );
  const {
    session,
    isLoading: identityLoading,
    authStatus,
  } = useIdentityContext();
  const protectedApiReady = authStatus === "authenticated";
  const isAdministrator =
    protectedApiReady &&
    (session?.membership.role === "owner" ||
      session?.membership.role === "admin") &&
    (session?.principal.type === "human" ||
      session?.principal.type === "operator");
  const operationsQuery = useQuery({
    queryKey: queryKeys.groupManagementOperations,
    queryFn: () => apiClient.getGroupManagementOperations({ limit: 50 }),
    enabled: isAdministrator,
  });
  const evidenceQuery = useQuery({
    queryKey: queryKeys.groupManagementEvidence(evidenceOperationId ?? "none"),
    queryFn: () =>
      apiClient.getGroupManagementEvidence(evidenceOperationId ?? ""),
    enabled: isAdministrator && evidenceOperationId !== null,
  });
  const operations = operationsQuery.data?.items ?? [];

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Administrator group review
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Group management
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Review account-bound group changes, provider evidence, and the current
          member revision before treating a change as complete.
        </p>
      </div>
      {identityLoading && <p role="status">Loading group management…</p>}
      {!identityLoading && !isAdministrator && (
        <p role="alert" className="rounded-lg border border-dashed p-6 text-sm">
          Administrator access is required to review group management.
        </p>
      )}
      {isAdministrator && operationsQuery.isLoading && (
        <p role="status">Loading group management…</p>
      )}
      {isAdministrator && operationsQuery.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Unable to load group management operations.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void operationsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {isAdministrator &&
        !operationsQuery.isLoading &&
        !operationsQuery.isError &&
        operations.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No group management operations are available for this tenant.
          </p>
        )}
      {isAdministrator && !operationsQuery.isError && operations.length > 0 && (
        <div className="grid gap-4">
          {operations.map((operation) => {
            const evidenceOpen = evidenceOperationId === operation.operation_id;
            const evidence = evidenceOpen ? (evidenceQuery.data ?? []) : [];
            return (
              <Card key={operation.operation_id}>
                <CardHeader className="border-b">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <CardTitle>{operation.action}</CardTitle>
                    <Badge variant={statusVariant(operation.status)}>
                      {operation.status}
                    </Badge>
                  </div>
                  <CardDescription>
                    Operation {operation.operation_id} · conversation{" "}
                    {operation.conversation_id}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2">
                  <div>
                    <p className="font-medium">Provider group</p>
                    <p className="text-muted-foreground">
                      {operation.provider_group_id} on {operation.account_id}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">Current revision</p>
                    <p className="text-muted-foreground">
                      {operation.current_revision}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="font-medium">Current members</p>
                    <p className="text-muted-foreground">
                      {operation.current_member_provider_ids.join(", ") ||
                        "None"}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">Evidence path</p>
                    <p className="text-muted-foreground">
                      {operation.evidence_path ?? "Awaiting provider evidence"}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">Failure / risk</p>
                    <p className="text-muted-foreground">
                      {operation.failure_code ??
                        (operation.duplicate_risk ? "Duplicate risk" : "None")}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setEvidenceOperationId((current) =>
                          current === operation.operation_id
                            ? null
                            : operation.operation_id,
                        )
                      }
                    >
                      {evidenceOpen
                        ? "Hide provider evidence"
                        : "View provider evidence"}
                    </Button>
                    {evidenceOpen && (
                      <div className="mt-3 rounded-md border p-3 text-xs">
                        {evidenceQuery.isFetching && <p>Loading evidence…</p>}
                        {evidenceQuery.isError && (
                          <p role="alert">Unable to load provider evidence.</p>
                        )}
                        {!evidenceQuery.isFetching &&
                          !evidenceQuery.isError && (
                            <ul className="grid gap-2">
                              {evidence.map((item) => (
                                <li
                                  key={`${item.evidence_id}-${item.observed_at}`}
                                >
                                  {item.source} · {item.evidence_id} · revision{" "}
                                  {item.revision} ·{" "}
                                  {item.accepted ? "accepted" : "rejected"}
                                  {item.reason ? ` · ${item.reason}` : ""}
                                </li>
                              ))}
                            </ul>
                          )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
