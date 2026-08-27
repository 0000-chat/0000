import { createFileRoute } from "@tanstack/react-router";

function SystemRoute() {
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold tracking-tight">System</h1>
      <p className="max-w-2xl text-muted-foreground">
        Inspect API, data-mode, realtime, and fixture diagnostics.
      </p>
    </section>
  );
}

export const Route = createFileRoute("/system")({ component: SystemRoute });
