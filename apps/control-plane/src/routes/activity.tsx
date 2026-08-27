import { createFileRoute } from "@tanstack/react-router";

function ActivityRoute() {
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
      <p className="max-w-2xl text-muted-foreground">
        Follow accepted commands and their delivery phases.
      </p>
    </section>
  );
}

export const Route = createFileRoute("/activity")({ component: ActivityRoute });
