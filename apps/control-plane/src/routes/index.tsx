import { createFileRoute, Link } from "@tanstack/react-router";

function OverviewRoute() {
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
      <p className="max-w-2xl text-muted-foreground">
        Review the active identity&apos;s connection and command summary.
      </p>
      <p><Link className="text-primary underline" to="/connections">Open Connections</Link></p>
    </section>
  );
}

export const Route = createFileRoute("/")({ component: OverviewRoute });
