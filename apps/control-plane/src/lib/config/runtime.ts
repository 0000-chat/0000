import { z } from "zod";

const DeploymentEnvironmentSchema = z.enum(["local", "staging", "production"]);
const DataModeSchema = z.enum(["simulated", "live"]);

export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;
export type DataMode = z.infer<typeof DataModeSchema>;

function envValue(name: string) {
  const value = import.meta.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseEnum<T extends z.ZodEnum>(schema: T, value: string | undefined, fallback: z.infer<T>) {
  const result = schema.safeParse(value ?? fallback);
  if (!result.success) {
    throw new Error(`Invalid ${schema.description ?? "runtime"} configuration`);
  }
  return result.data;
}

const defaultDeploymentEnvironment = import.meta.env.PROD ? "production" : "local";
const defaultDataMode = import.meta.env.PROD ? "live" : "simulated";

export const runtimeConfig = {
  deploymentEnv: parseEnum(
    DeploymentEnvironmentSchema,
    envValue("VITE_DEPLOYMENT_ENV"),
    defaultDeploymentEnvironment,
  ),
  dataMode: parseEnum(DataModeSchema, envValue("VITE_DATA_MODE"), defaultDataMode),
} as const;

if (runtimeConfig.deploymentEnv === "production" && runtimeConfig.dataMode !== "live") {
  throw new Error("Simulated data is forbidden in production");
}
