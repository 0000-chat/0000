import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { createAppRouter } from "./router";

export function createAppQueryClient(isTest = false) {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: isTest ? false : 1 },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({
  router: providedRouter,
}: {
  router?: ReturnType<typeof createAppRouter>;
}) {
  const [queryClient] = useState(() => createAppQueryClient());
  const [router] = useState(() =>
    providedRouter ?? createAppRouter(queryClient),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
