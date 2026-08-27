import { createRouter } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";
import type { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";

export function createAppRouter(queryClient: QueryClient, options?: {
  history?: RouterHistory;
}) {
  const routerOptions = {
    routeTree,
    context: { queryClient },
    defaultPreload: "intent" as const,
  };
  return options?.history
    ? createRouter({ ...routerOptions, history: options.history })
    : createRouter(routerOptions);
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
