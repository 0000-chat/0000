import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { server } from "@/mocks/server";
import { simulatedStore } from "@/mocks/store";

Object.defineProperty(window, "scrollTo", {
  value: () => undefined,
  writable: true,
});

configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => simulatedStore.reset());
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
