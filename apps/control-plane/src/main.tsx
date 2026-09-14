import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AppProviders } from "./app/providers";
import { runtimeConfig } from "./lib/config/runtime";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
const mountPoint = root;

async function bootstrap() {
  if (runtimeConfig.dataMode === "simulated") {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledRequest: "error" });
  }

  createRoot(mountPoint).render(
    <StrictMode>
      <AppProviders />
    </StrictMode>,
  );
}

void bootstrap();
