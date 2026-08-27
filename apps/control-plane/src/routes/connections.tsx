import { createFileRoute } from "@tanstack/react-router";

function ConnectionsRoute() {
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold tracking-tight">Connections</h1>
      <p className="max-w-2xl text-muted-foreground">
        Review provider connections for the selected identity.
      </p>
    </section>
  );
}

export const Route = createFileRoute("/connections")({ component: ConnectionsRoute });
