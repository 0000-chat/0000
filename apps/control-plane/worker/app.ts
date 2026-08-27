import { OpenAPIHono } from "@hono/zod-openapi";
import { healthRoute } from "./routes/health";

type Bindings = {
  COMMUNICATOR_DATA_MODE?: "simulated" | "live";
};

const app = new OpenAPIHono<{ Bindings: Bindings }>();

app.openapi(healthRoute, (context) => context.json({
  status: "ok",
  service: "communicator-control-plane",
  data_mode: context.env?.COMMUNICATOR_DATA_MODE ?? "unconfigured",
}, 200));

export default app;
