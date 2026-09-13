import { useQuery } from "@tanstack/react-query";
import { ConnectionCard } from "./connection-card";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

export function ConnectionsPage() {
  const { activeIdentity, isLoading: identitiesLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const { data: connections = [], isLoading } = useQuery({
    queryKey: queryKeys.connections(identityId),
    queryFn: () => apiClient.getConnections(identityId),
    enabled: Boolean(identityId),
  });

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Identity-scoped connections
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Connections
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Review provider connections for the selected identity. Account pairing
          is not available in simulation.
        </p>
      </div>

      {(identitiesLoading || isLoading) && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading connections…
        </p>
      )}
      {!identitiesLoading && !isLoading && connections.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No connections are available for this identity.
        </p>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        {connections.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection} />
        ))}
      </div>
    </section>
  );
}
