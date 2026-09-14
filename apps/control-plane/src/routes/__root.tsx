import { createRootRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "@/components/layout/app-shell";

export const Route = createRootRoute({
  validateSearch: z.object({
    identity: z.string().optional(),
    channel: z.string().optional(),
    message: z.string().optional(),
  }),
  component: AppShell,
});
