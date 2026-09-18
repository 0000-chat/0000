import { getAuthTables } from "better-auth/db";
import { jwt, organization } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const createAuthPlugins = () => [
  jwt({ disableSettingJwtHeader: true }),
  organization(),
  oauthProvider({
    disableJwtPlugin: true,
    storeTokens: "hashed",
    loginPage: "/login",
    consentPage: "/consent",
    scopes: ["openid", "profile", "email", "offline_access", "resource:read"],
    resources: [
      {
        identifier: "https://fixture.0000.test",
        name: "Platform T01 resource fixture",
        allowedScopes: ["resource:read", "offline_access"],
      },
    ],
    refreshTokenReuseInterval: 0,
    enforcePerClientResources: true,
    clientRegistrationDefaultResources: ["https://fixture.0000.test"],
    clientRegistrationAllowedResources: ["https://fixture.0000.test"],
    clientRegistrationRequirePKCE: true,
    allowDynamicClientRegistration: false,
  }),
];

const authTables = getAuthTables({ plugins: createAuthPlugins() });

type Field = {
  type: string;
  required?: boolean;
  unique?: boolean;
  defaultValue?: unknown;
  references?: { model: string; field: string; onDelete?: string };
  fieldName?: string;
};
type TableDefinition = {
  modelName: string;
  fields: Record<string, Field>;
  indexes?: Array<{ fields: string[]; unique?: boolean }>;
};

function createColumn(name: string, field: Field): any {
  const databaseName = field.fieldName ?? name;
  let column: any;
  switch (field.type) {
    case "date":
      column = integer(databaseName, { mode: "timestamp_ms" });
      break;
    case "boolean":
      column = integer(databaseName, { mode: "boolean" });
      break;
    case "number":
      column = integer(databaseName);
      break;
    case "json":
    case "string[]":
      column = text(databaseName, { mode: "json" });
      break;
    default:
      column = text(databaseName);
  }
  if (field.required) column = column.notNull();
  if (field.unique) column = column.unique();
  return column;
}

function buildAuthSchema(): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [key, rawDefinition] of Object.entries(authTables)) {
    const definition = rawDefinition as TableDefinition;
    const columns: Record<string, any> = { id: text("id").primaryKey() };
    for (const [name, field] of Object.entries(definition.fields)) {
      columns[name] = createColumn(name, field);
    }
    schema[key] = (sqliteTable as any)(
      definition.modelName,
      columns,
      (table: any) =>
        (definition.indexes ?? [])
          .map((index, indexNumber) => {
            if (!index.unique) return undefined;
            const indexName = `${definition.modelName}_${index.fields.join("_")}_${indexNumber}_idx`;
            return (uniqueIndex(indexName) as any).on(
              ...index.fields.map((field) => table[field]),
            );
          })
          .filter(Boolean),
    );
  }
  return schema;
}

export const authSchema = buildAuthSchema();
export type AuthSchema = typeof authSchema;

export function getAuthMigrationStatements(): string[] {
  const statements: string[] = [];
  for (const rawDefinition of Object.values(authTables)) {
    const definition = rawDefinition as TableDefinition;
    const columns = [
      '"id" TEXT PRIMARY KEY NOT NULL',
      ...Object.entries(definition.fields).map(([name, field]) => {
        const type = ["date", "boolean", "number"].includes(field.type)
          ? "INTEGER"
          : "TEXT";
        const parts = [`"${field.fieldName ?? name}"`, type];
        if (field.required) parts.push("NOT NULL");
        if (field.unique) parts.push("UNIQUE");
        if (field.references) {
          parts.push(
            `REFERENCES "${field.references.model}"("${field.references.field}")`,
          );
          if (field.references.onDelete) {
            parts.push(`ON DELETE ${field.references.onDelete.toUpperCase()}`);
          }
        }
        return parts.join(" ");
      }),
    ];
    statements.push(
      `CREATE TABLE IF NOT EXISTS "${definition.modelName}" (\n  ${columns.join(",\n  ")}\n);`,
    );
    for (const [indexNumber, index] of (definition.indexes ?? []).entries()) {
      if (!index.unique) continue;
      const indexName = `${definition.modelName}_${index.fields.join("_")}_${indexNumber}_idx`;
      statements.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${definition.modelName}" (${index.fields.map((field) => `"${field}"`).join(", ")});`,
      );
    }
  }
  return statements;
}
