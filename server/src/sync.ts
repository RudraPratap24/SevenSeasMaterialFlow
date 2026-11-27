/**
 * "Is it already there?" — merge rows from a sheet into a table by their natural key, for every module's importer.
 *   new key            → inserted
 *   same key, same     → left alone
 *   same key, differs  → updated when `overwrite`, else reported as a conflict (the database is the record)
 *   only in the table  → reported, never deleted
 * Runs on the caller's connection: wrap it in a transaction and roll back for a dry run.
 * Values are compared by column type (dates to the second, numbers as numbers, NULL = ""), so a re-import of the
 * same sheet changes nothing.
 */
import type { Connection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export type SyncRow = Record<string, unknown>;

export interface SyncReport {
  table: string;
  added: number;
  same: number;
  updated: number;
  /** "key: column old → new" — what was updated (overwrite) */
  changed: string[];
  /** "key: column db ≠ sheet" — what was NOT updated (no overwrite) */
  conflicts: string[];
  onlyInDb: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localText = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** the comparable text of a value in a column of this SQL type */
export function canon(v: unknown, type: string): string {
  if (v === null || v === undefined || v === "") return "";
  if (/date|time/.test(type)) {
    if (v instanceof Date) return isNaN(v.getTime()) ? "" : localText(v);
    return String(v).replace("T", " ").slice(0, 19);
  }
  if (/int|decimal|float|double/.test(type)) {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : String(v);
  }
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return String(v);
}

export async function syncRows(
  conn: Connection,
  table: string,
  keyCols: string[],
  rows: SyncRow[],
  /** where: only these rows of the table take part (a constant SQL condition from the code, never user input) */
  opts: { overwrite: boolean; where?: string; label?: (r: SyncRow) => string; maxListed?: number },
): Promise<SyncReport> {
  if (!/^\w+$/.test(table) || keyCols.some((k) => !/^\w+$/.test(k))) throw new Error("bad table / column name");
  const rep: SyncReport = { table, added: 0, same: 0, updated: 0, changed: [], conflicts: [], onlyInDb: 0 };
  const max = opts.maxListed ?? 300;
  if (!rows.length) return rep;
  const [meta] = await conn.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME AS c, DATA_TYPE AS t, COLUMN_KEY AS k FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
    [table],
  );
  const types = new Map(meta.map((m) => [String(m.c), String(m.t)]));
  const pk = meta.filter((m) => m.k === "PRI").map((m) => String(m.c));
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  for (const c of [...cols, ...keyCols]) if (!types.has(c)) throw new Error(`${table} has no column ${c}`);
  if (!pk.length) throw new Error(`${table} has no primary key`);

  // identical keys (a sheet without ids) are told apart by their order: 1st, 2nd … in the sheet and in the table
  const keyOf = (r: SyncRow, seen: Map<string, number>) => {
    const k = keyCols.map((c) => canon(r[c], types.get(c)!)).join("|");
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n > 1 ? `${k}#${n}` : k;
  };
  const [have] = await conn.query<RowDataPacket[]>(
    `SELECT ${[...new Set([...pk, ...keyCols, ...cols])].join(", ")} FROM ${table} ${opts.where ? "WHERE " + opts.where : ""} ORDER BY ${pk.join(", ")}`,
  );
  const seenDb = new Map<string, number>();
  const byKey = new Map(have.map((r) => [keyOf(r, seenDb), r]));
  const seenIn = new Map<string, number>();
  const label = (r: SyncRow, k: string) => (opts.label ? opts.label(r) : k);

  for (const r of rows) {
    const k = keyOf(r, seenIn);
    const cur = byKey.get(k);
    if (!cur) {
      await conn.query(`INSERT INTO ${table} SET ?`, [r]);
      rep.added++;
      continue;
    }
    byKey.delete(k);
    const diff = cols.filter((c) => !keyCols.includes(c) && c in r && canon(cur[c], types.get(c)!) !== canon(r[c], types.get(c)!));
    if (!diff.length) {
      rep.same++;
      continue;
    }
    const what = diff.map((c) => `${c} ${short(cur[c])} → ${short(r[c])}`).join("; ");
    if (opts.overwrite) {
      const set = Object.fromEntries(diff.map((c) => [c, r[c]]));
      await conn.query<ResultSetHeader>(`UPDATE ${table} SET ? WHERE ${pk.map((c) => `${c} = ?`).join(" AND ")}`, [set, ...pk.map((c) => cur[c])]);
      rep.updated++;
      if (rep.changed.length < max) rep.changed.push(`${label(r, k)}: ${what}`);
    } else if (rep.conflicts.length < max) rep.conflicts.push(`${label(r, k)}: ${what}`);
  }
  rep.onlyInDb = byKey.size;
  return rep;
}

const short = (v: unknown) => {
  const s = v instanceof Date ? localText(v) : v === null || v === undefined ? "∅" : String(v);
  return JSON.stringify(s.length > 60 ? s.slice(0, 57) + "…" : s);
};

/** the report as Markdown lines */
export function syncLines(reps: SyncReport[]): string[] {
  const out = ["| table | added | same | updated | conflicts (kept the database's) | only in the database |", "|---|---|---|---|---|---|"];
  for (const r of reps) out.push(`| ${r.table} | ${r.added} | ${r.same} | ${r.updated} | ${r.conflicts.length} | ${r.onlyInDb} |`);
  for (const r of reps) {
    if (r.changed.length) out.push(`\n### ${r.table}: updated from the sheet\n`, ...r.changed.map((x) => `- ${x}`));
    if (r.conflicts.length) out.push(`\n### ${r.table}: differs from the sheet, database kept\n`, ...r.conflicts.map((x) => `- ${x}`));
  }
  return out;
}
