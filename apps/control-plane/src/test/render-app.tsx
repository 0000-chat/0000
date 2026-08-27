import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { createAppQueryClient } from "@/app/providers";
import { createAppRouter } from "@/app/router";

export function renderApp(path = "/") {
  const queryClient = createAppQueryClient(true);
  const router = createAppRouter(queryClient, {
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const result = render(<RouterHarness router={router} />);
  return { ...result, router, queryClient };
}

function RouterHarness({ router }: { router: ReturnType<typeof createAppRouter> }) {
  return <RouterProvider router={router} />;
}
