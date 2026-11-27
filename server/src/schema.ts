/**
 * The one database: a baseline (old migrations 1–43, in baseline.sql) plus migrations added since.
 * `npm run db:setup` applies whatever is not yet recorded in schema_migrations. Never edit an applied migration —
 * add a new one. Versions are global: a module's migration takes the next free number.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Grant, Migration } from "./module";
import { MODULES } from "./modules";

export type { Migration } from "./module";

/** the last version that baseline.sql contains */
export const BASELINE_VERSION = 43;

/** baseline.sql as single statements (they are separated by a line holding only ";") */
export function baselineStatements(): string[] {
  const sql = readFileSync(path.resolve(process.cwd(), "server/src/baseline.sql"), "utf8");
  return sql
    .split(/\r?\n;\r?\n/)
    .map((s) => s.replace(/^(--[^\n]*\n)+/gm, "").trim())
    .filter(Boolean);
}

/** core migrations after the baseline go here; module migrations come from each module */
const CORE_MIGRATIONS: Migration[] = [];

export const MIGRATIONS: Migration[] = [...CORE_MIGRATIONS, ...MODULES.flatMap((m) => m.migrations ?? [])].sort(
  (a, b) => a.version - b.version,
);
{
  const seen = new Set<number>();
  for (const m of MIGRATIONS) {
    if (m.version <= BASELINE_VERSION || seen.has(m.version)) throw new Error(`migration version ${m.version} is taken`);
    seen.add(m.version);
  }
}

/** what the app's database account may do. Old Material Flow registers get nothing (legacy, not served). */
export function appGrants(): Grant[] {
  return [
    { table: "users", privileges: "SELECT, INSERT, UPDATE, DELETE" },
    { table: "sessions", privileges: "SELECT, INSERT, UPDATE, DELETE" },
    { table: "audit_log", privileges: "SELECT, INSERT" },
    { table: "app_meta", privileges: "SELECT, UPDATE" },
    { table: "schema_migrations", privileges: "SELECT" },
    // shared masters — edited on the admin page, read (and partly written) by modules
    { table: "components", privileges: "SELECT, INSERT, UPDATE" },
    { table: "products", privileges: "SELECT, INSERT, UPDATE" },
    { table: "suppliers", privileges: "SELECT, INSERT, UPDATE" },
    { table: "supplier_rates", privileges: "SELECT, INSERT, UPDATE, DELETE" },
    ...MODULES.flatMap((m) => m.grants),
  ];
}
