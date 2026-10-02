import worker from "../src/worker";
import {
  DatabaseObject,
  type DatabaseBindings,
  type DatabaseResource,
  type DurableCallOutcome,
} from "../src/database-object";
export { DatabaseRegistry } from "../src/database-registry";

export class FailOnceDatabaseObject extends DatabaseObject {
  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_creation_failures (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      failed INTEGER NOT NULL CHECK (failed IN (0, 1))
    )`);
  }

  override ensureCreated(
    input: Parameters<DatabaseObject["ensureCreated"]>[0],
  ): DurableCallOutcome<DatabaseResource> {
    const initialized = super.ensureCreated(input);
    if (!initialized.ok) return initialized;
    const failThisAttempt = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ failed: number }>(
          "SELECT failed FROM test_creation_failures WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO test_creation_failures (singleton, failed) VALUES (1, 1)",
      );
      return true;
    });
    if (failThisAttempt)
      throw new Error(
        "simulated lost create response after durable initialization",
      );
    return initialized;
  }
}

export class TestClockDatabaseObject extends DatabaseObject {
  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_clock (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      now_ms INTEGER NOT NULL CHECK (now_ms >= 0)
    )`);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/clock" && request.method === "POST") {
      const rawTime = request.headers.get("x-test-now-ms");
      const now = rawTime === null ? Number.NaN : Number(rawTime);
      if (!Number.isSafeInteger(now) || now < 0)
        return new Response(null, { status: 400 });
      this.ctx.storage.sql.exec(
        `INSERT INTO test_clock (singleton, now_ms) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET now_ms = excluded.now_ms`,
        now,
      );
      return new Response(null, { status: 204 });
    }

    const clock = this.ctx.storage.sql
      .exec<{ now_ms: number }>(
        "SELECT now_ms FROM test_clock WHERE singleton = 1",
      )
      .toArray()[0];
    if (!clock) return super.fetch(request);

    const realNow = Date.now;
    Date.now = () => clock.now_ms;
    try {
      return await super.fetch(request);
    } finally {
      Date.now = realNow;
    }
  }
}

export default worker;
