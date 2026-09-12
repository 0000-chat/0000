import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  if (
    env.VITE_DEPLOYMENT_ENV === "production" &&
    env.VITE_DATA_MODE !== "live"
  ) {
    throw new Error("Simulated data is forbidden in production");
  }

  return {
    plugins: [
      // The current router generator scans src/routes during config resolution;
      // defer it until Task 4 creates the route tree.
      ...(existsSync(fileURLToPath(new URL("./src/routes", import.meta.url)))
        ? [tanstackRouter({ target: "react", autoCodeSplitting: true })]
        : []),
      react(),
      tailwindcss(),
      cloudflare(),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
  };
});
