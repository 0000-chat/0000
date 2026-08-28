import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { runtimeConfig } from "@/lib/config/runtime";
import { runtimeRealtimeClient } from "@/lib/realtime/runtime-client";
import { clearChannelOrderPreferences } from "@/features/conversations/channel-order";

const simulatedBuild = runtimeRealtimeClient !== null;

export function SystemPage() {
  const queryClient = useQueryClient();
  const { activeIdentity } = useIdentityContext();
  const realtime = runtimeRealtimeClient;
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [lastSequence, setLastSequence] = useState(realtime?.lastSequence ?? 0);
  const [fixtureResetTime, setFixtureResetTime] = useState("Fixture loaded");
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiClient.getHealth(),
  });
  const identityId = activeIdentity?.id ?? "";
  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections(identityId),
    queryFn: () => apiClient.getConnections(identityId),
    enabled: Boolean(identityId),
  });

  useEffect(() => {
    if (!realtime) return;
    const unsubscribe = realtime.subscribe(() => setLastSequence(realtime.lastSequence));
    void realtime.connect().then(() => setRealtimeConnected(true));
    return () => {
      unsubscribe();
      realtime.close();
    };
  }, [realtime]);

  const resetScenario = async () => {
    const resetResponse = await apiClient.resetSimulation();
    clearChannelOrderPreferences();
    queryClient.clear();
    realtime?.reset();
    setLastSequence(realtime?.lastSequence ?? 0);
    setFixtureResetTime(resetResponse.fixture_reset_at);
    setResetMessage("Simulation reset complete");
  };

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Operational diagnostics</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">System</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Inspect API, data-mode, realtime, and fixture diagnostics.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <DiagnosticCard label="API health" value={healthQuery.data?.status ?? (healthQuery.isLoading ? "Loading" : "Unavailable")} />
        <DiagnosticCard label="Data mode" value={runtimeConfig.dataMode} />
        <DiagnosticCard label="Realtime connection" value={realtime ? (realtimeConnected ? "Connected" : "Connecting") : "Not configured"} />
        <DiagnosticCard label="Last sequence" value={realtime ? String(lastSequence) : "—"} />
        <DiagnosticCard label="Fixture reset time" value={fixtureResetTime} />
        <DiagnosticCard label="Active connection count" value={String(connectionsQuery.data?.length ?? 0)} />
      </div>

      {simulatedBuild && (
        <div className="rounded-xl border border-dashed p-4">
          <p className="text-sm text-muted-foreground">
            Scenario controls are local-only and never contact a provider.
          </p>
          <Button type="button" className="mt-3" onClick={() => void resetScenario()}>
            Reset simulated scenario
          </Button>
          {resetMessage && (
            <p role="status" aria-label="Simulation reset complete" className="mt-3 text-sm">
              {resetMessage}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function DiagnosticCard({ label, value }: { label: string; value: string }) {
  return (
    <dl className="rounded-xl border bg-card p-4 shadow-sm">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </dl>
  );
}
