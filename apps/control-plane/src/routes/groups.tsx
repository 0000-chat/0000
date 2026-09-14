import { createFileRoute } from "@tanstack/react-router";
import { GroupManagementPage } from "@/features/groups/group-management-page";

function GroupsRoute() {
  return <GroupManagementPage />;
}

export const Route = createFileRoute("/groups")({ component: GroupsRoute });
