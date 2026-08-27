import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

function OverviewRoute() {
  const { activeIdentity, isLoading: identityLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections(identityId),
    queryFn: () => apiClient.getConnections(identityId),
    enabled: Boolean(identityId),
  });
  const commandsQuery = useQuery({
    queryKey: queryKeys.commands(identityId),
    queryFn: () => apiClient.getCommands(identityId),
    enabled: Boolean(identityId),
  });
  const connectionCount = connectionsQuery.data?.length ?? 0;
  const commandCount = commandsQuery.data?.length ?? 0;

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
      <p className="max-w-2xl text-muted-foreground">
        Review the active identity&apos;s connection and command summary.
      </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link to="/connections" className="rounded-xl border bg-card p-4 shadow-sm hover:bg-accent">
          <span className="text-sm text-muted-foreground">Connections</span>
          <strong className="mt-1 block text-2xl">{identityLoading ? "…" : `${connectionCount} connection${connectionCount === 1 ? "" : "s"}`}</strong>
        </Link>
        <Link to="/activity" className="rounded-xl border bg-card p-4 shadow-sm hover:bg-accent">
          <span className="text-sm text-muted-foreground">Commands</span>
          <strong className="mt-1 block text-2xl">{identityLoading ? "…" : `${commandCount} command${commandCount === 1 ? "" : "s"}`}</strong>
        </Link>
      </div>
      <nav aria-label="Overview screens" className="flex flex-wrap gap-4 text-sm">
        <Link className="text-primary underline" to="/connections">Connections</Link>
        <Link className="text-primary underline" to="/conversations">Conversations</Link>
        <Link className="text-primary underline" to="/activity">Activity</Link>
        <Link className="text-primary underline" to="/system">System</Link>
      </nav>
    </section>
  );
}

export const Route = createFileRoute("/")({ component: OverviewRoute });
