import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "@/features/system/system-page";

function SystemRoute() {
  return <SystemPage />;
}

export const Route = createFileRoute("/system")({ component: SystemRoute });
