import type {
  ProjectionStatus,
  ProjectionStatusInput,
} from "@communicator/contracts";
import { DurableObject } from "cloudflare:workers";
import { projectionError } from "./errors";

export class TenantProjectionDO extends DurableObject<Cloudflare.Env> {
  async getStatus(_input: ProjectionStatusInput): Promise<ProjectionStatus> {
    throw projectionError("projection_unavailable");
  }
}
