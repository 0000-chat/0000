import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OWNER_FILE_MODE = 0o600;
const OWNER_FILE_VERSION = 1;
const FALLBACK_OWNER_TTL_MS = 2 * 60_000;

type OwnerFile = {
  instanceId: string;
  pid: number;
  processStartToken?: string;
  processStartedAt: string;
  registrationKey: string;
  updatedAt: string;
  version: number;
};

export type BridgeSingletonStatus =
  | {
      canClaim: true;
      lastReconciledAt?: string;
      ownerPath: string;
      status: "healthy";
    }
  | {
      canClaim: false;
      duplicateOwner: {
        instanceId?: string;
        pid: number;
        processStartedAt?: string;
        updatedAt?: string;
      };
      lastReconciledAt?: string;
      ownerPath: string;
      status: "duplicate_owner";
    };

export type BridgeSingletonGuardOptions = {
  instanceId: string;
  now?: () => Date;
  path: string;
  pid?: number;
  processStartToken?: string;
  processStartedAt: string;
  readProcessStartTime?: (pid: number) => string | undefined;
  registrationKey: string;
  fallbackOwnerTtlMs?: number;
};

export class BridgeSingletonGuard {
  private readonly instanceId: string;
  private readonly now: () => Date;
  private readonly fallbackOwnerTtlMs: number;
  private readonly path: string;
  private readonly pid: number;
  private readonly processStartToken?: string;
  private readonly processStartedAt: string;
  private readonly readProcessStartTime: (pid: number) => string | undefined;
  private readonly registrationKey: string;
  private status: BridgeSingletonStatus;

  constructor(options: BridgeSingletonGuardOptions) {
    this.instanceId = options.instanceId;
    this.fallbackOwnerTtlMs =
      options.fallbackOwnerTtlMs ?? FALLBACK_OWNER_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.path = options.path;
    this.pid = options.pid ?? process.pid;
    this.processStartToken = options.processStartToken;
    this.processStartedAt = options.processStartedAt;
    this.readProcessStartTime =
      options.readProcessStartTime ?? readLinuxProcessStartTime;
    this.registrationKey = options.registrationKey;
    this.status = {
      canClaim: true,
      ownerPath: this.path,
      status: "healthy",
    };
  }

  getStatus(): BridgeSingletonStatus {
    return this.status;
  }

  async reconcile(): Promise<BridgeSingletonStatus> {
    const now = this.now().toISOString();
    const existing = await this.readOwnerFile();
    if (existing && this.isSelf(existing)) {
      await this.writeOwnerFile(now);
      return this.updateHealthy(now);
    }
    if (existing && this.ownerIsLive(existing)) {
      this.status = {
        canClaim: false,
        duplicateOwner: {
          instanceId: existing.instanceId,
          pid: existing.pid,
          processStartedAt: existing.processStartedAt,
          updatedAt: existing.updatedAt,
        },
        lastReconciledAt: now,
        ownerPath: this.path,
        status: "duplicate_owner",
      };
      return this.status;
    }
    await this.writeOwnerFile(now);
    const confirmed = await this.readOwnerFile();
    if (confirmed && this.isSelf(confirmed)) {
      return this.updateHealthy(now);
    }
    if (confirmed && this.ownerIsLive(confirmed)) {
      this.status = {
        canClaim: false,
        duplicateOwner: {
          instanceId: confirmed.instanceId,
          pid: confirmed.pid,
          processStartedAt: confirmed.processStartedAt,
          updatedAt: confirmed.updatedAt,
        },
        lastReconciledAt: now,
        ownerPath: this.path,
        status: "duplicate_owner",
      };
      return this.status;
    }
    return this.updateHealthy(now);
  }

  async release(): Promise<void> {
    const existing = await this.readOwnerFile();
    if (!existing || !this.isSelf(existing)) {
      return;
    }
    await rm(this.path, { force: true });
  }

  private async readOwnerFile(): Promise<OwnerFile | undefined> {
    if (!existsSync(this.path)) {
      return undefined;
    }
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<OwnerFile>;
      if (
        raw.version !== OWNER_FILE_VERSION ||
        typeof raw.instanceId !== "string" ||
        typeof raw.pid !== "number" ||
        typeof raw.processStartedAt !== "string" ||
        typeof raw.registrationKey !== "string" ||
        typeof raw.updatedAt !== "string"
      ) {
        return undefined;
      }
      return {
        instanceId: raw.instanceId,
        pid: raw.pid,
        processStartToken:
          typeof raw.processStartToken === "string" ? raw.processStartToken : undefined,
        processStartedAt: raw.processStartedAt,
        registrationKey: raw.registrationKey,
        updatedAt: raw.updatedAt,
        version: OWNER_FILE_VERSION,
      };
    } catch {
      return undefined;
    }
  }

  private isSelf(existing: OwnerFile): boolean {
    return (
      existing.instanceId === this.instanceId &&
      existing.pid === this.pid &&
      existing.registrationKey === this.registrationKey
    );
  }

  private ownerIsLive(existing: OwnerFile): boolean {
    if (existing.pid <= 0) {
      return false;
    }
    const currentStartTime = this.readProcessStartTime(existing.pid);
    if (existing.processStartToken && currentStartTime) {
      return existing.processStartToken === currentStartTime;
    }
    if (existing.processStartToken && !currentStartTime) {
      return this.pidIsLive(existing.pid) && this.ownerUpdatedRecently(existing);
    }
    if (!existing.processStartToken) {
      return this.pidIsLive(existing.pid) && this.ownerUpdatedRecently(existing);
    }
    return false;
  }

  private pidIsLive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private ownerUpdatedRecently(existing: OwnerFile): boolean {
    const updatedAt = Date.parse(existing.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      return false;
    }
    return this.now().getTime() - updatedAt <= this.fallbackOwnerTtlMs;
  }

  private async writeOwnerFile(updatedAt: string): Promise<void> {
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    const ownerFile: OwnerFile = {
      instanceId: this.instanceId,
      pid: this.pid,
      ...(this.processStartToken ? { processStartToken: this.processStartToken } : {}),
      processStartedAt: this.processStartedAt,
      registrationKey: this.registrationKey,
      updatedAt,
      version: OWNER_FILE_VERSION,
    };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(ownerFile, null, 2)}\n`, {
      encoding: "utf8",
      mode: OWNER_FILE_MODE,
    });
    await chmod(tempPath, OWNER_FILE_MODE);
    await rename(tempPath, this.path);
    await chmod(this.path, OWNER_FILE_MODE);
  }

  private updateHealthy(lastReconciledAt: string): BridgeSingletonStatus {
    this.status = {
      canClaim: true,
      lastReconciledAt,
      ownerPath: this.path,
      status: "healthy",
    };
    return this.status;
  }
}

function readLinuxProcessStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) {
      return undefined;
    }
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}
