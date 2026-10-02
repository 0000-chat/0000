import {
  createConfiguredGatewayApp,
  type GatewayRuntimeBindings,
} from "./runtime";

const apps = new WeakMap<
  object,
  ReturnType<typeof createConfiguredGatewayApp>
>();

export default {
  fetch(request: Request, environment: GatewayRuntimeBindings) {
    let app = apps.get(environment);
    if (!app) {
      app = createConfiguredGatewayApp(environment);
      apps.set(environment, app);
    }
    return app.fetch(request);
  },
};
