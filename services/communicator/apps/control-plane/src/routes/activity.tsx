import { createFileRoute } from "@tanstack/react-router";
import { ActivityPage } from "@/features/activity/activity-page";

function ActivityRoute() {
  return <ActivityPage />;
}

export const Route = createFileRoute("/activity")({ component: ActivityRoute });
