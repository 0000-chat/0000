import { useQuery } from "@tanstack/react-query";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { CommandTimeline } from "./command-timeline";

export function ActivityPage() {
  const { activeIdentity, isLoading: identityLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const { data: commands = [], isLoading } = useQuery({
    queryKey: queryKeys.commands(identityId),
    queryFn: () => apiClient.getCommands(identityId),
    enabled: Boolean(identityId),
  });

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Identity-scoped command history</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Follow accepted commands and their delivery phases.
        </p>
      </div>
      {(identityLoading || isLoading) && <p role="status">Loading activity…</p>}
      {!identityLoading && !isLoading && commands.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No commands are available for this identity.
        </p>
      )}
      <CommandTimeline commands={commands} identityLabel={activeIdentity?.display_name ?? "Unavailable"} />
    </section>
  );
}
