import { LiveRealtimeClient } from "./live-client";
import { SimulatedRealtimeClient } from "./simulated-client";

const simulatedBuild = import.meta.env.VITE_DATA_MODE === "simulated"
  || (!import.meta.env.VITE_DATA_MODE && !import.meta.env.PROD);

export const runtimeRealtimeClient = simulatedBuild
  ? new SimulatedRealtimeClient()
  : new LiveRealtimeClient();
