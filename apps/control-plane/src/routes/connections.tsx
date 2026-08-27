import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsPage } from "@/features/connections/connections-page";

function ConnectionsRoute() {
  return <ConnectionsPage />;
}

export const Route = createFileRoute("/connections")({ component: ConnectionsRoute });
