import { createFileRoute } from "@tanstack/react-router";
import { ConversationsShell } from "@/features/conversations/conversations-shell";

export const Route = createFileRoute("/conversations/")({ component: ConversationsShell });
