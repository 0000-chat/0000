import { Hono } from "hono";

const app = new Hono();

app.get("/health", (context) =>
  context.json({ status: "ok", service: "gateway" }, 200),
);

export default app;
