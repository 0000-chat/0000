import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_ROOM_SCHEMA_VERSION, migrateRoomSchema } from "./room-schema";
import { ROOM_LIMITS } from "./room-domain";

function storage(database: Database) {
  return {
    transactionSync: <T>(callback: () => T) => database.transaction(callback)(),
    sql: {
      exec(query: string, ...values: unknown[]) {
        if (values.length === 0 && query.includes(";")) { database.exec(query); return []; }
        const statement = database.query(query);
        if (/^\s*(?:SELECT|PRAGMA)/i.test(query)) return statement.all(...(values as never[]));
        statement.run(...(values as never[])); return [];
      },
    },
  };
}

test("initializes a fresh durable schema at the current version", () => {
  const database = new Database(":memory:");
  migrateRoomSchema(storage(database));
  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
});

test("leaves an existing current schema unchanged", () => {
  const database = new Database(":memory:");
  const roomStorage = storage(database);
  migrateRoomSchema(roomStorage);
  migrateRoomSchema(roomStorage);
  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
});

test("fails closed when durable storage has a future schema", () => {
  const database = new Database(":memory:");
  const roomStorage = storage(database);
  migrateRoomSchema(roomStorage);
  database.query("UPDATE room_schema SET version = ?").run(CURRENT_ROOM_SCHEMA_VERSION + 1);
  expect(() => migrateRoomSchema(roomStorage)).toThrow("newer");
});

test("rebuilds legacy inactivity expiry from the last message without an absolute cap", () => {
  const database = new Database(":memory:");
  const roomStorage = storage(database);
  migrateRoomSchema(roomStorage);
  const lastMessageAt = 29 * 24 * 60 * 60 * 1000;
  const oldAbsoluteExpiry = 30 * 24 * 60 * 60 * 1000;
  database.query("UPDATE room_schema SET version = 2").run();
  database.query("INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash) VALUES (1, 2, 1, ?, ?, ?, ?, 2, 1, 5, 'active', NULL, 'hash')").run(0, lastMessageAt, oldAbsoluteExpiry, oldAbsoluteExpiry);

  migrateRoomSchema(roomStorage);

  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
  expect(database.query("SELECT schema_version, inactivity_expires_at FROM room_state").get()).toEqual({ schema_version: CURRENT_ROOM_SCHEMA_VERSION, inactivity_expires_at: lastMessageAt + ROOM_LIMITS.inactivityTtlMs });
});
