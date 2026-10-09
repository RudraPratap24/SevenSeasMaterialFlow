/**
 * Safety snapshots — taken automatically before every "Clear all" / "Load demo data".
 *   npm run snapshot -- list
 *   npm run snapshot -- restore <id>   puts that snapshot back (the current data is snapshotted first)
 */
import type { RowDataPacket } from "mysql2/promise";
import { maintenanceConnection } from "../src/db";
import { countDocuments, loadSnapshot, loadState, persistChanges, saveSnapshot } from "../src/repository";

const [cmd, idArg] = process.argv.slice(2);

const conn = await maintenanceConnection();

async function main() {
  if (cmd === "list") {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT id, created_at, username, reason, documents FROM state_snapshots ORDER BY id DESC LIMIT 50",
    );
    if (rows.length === 0) console.log("No snapshots yet.");
    else console.table(rows.map((r) => ({ id: r.id, at: r.created_at, by: r.username, reason: r.reason, documents: r.documents })));
    return;
  }
  if (cmd === "restore") {
    const id = Number(idArg);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Usage: npm run snapshot -- restore <id>");
    const snap = await loadSnapshot(conn, id);
    if (!snap) throw new Error(`No snapshot #${id}.`);
    try {
      await conn.beginTransaction();
      const before = await loadState(conn);
      const safety = await saveSnapshot(conn, before, `before restore of #${id}`, { id: null, username: "cli" });
      await persistChanges(conn, before, snap, null, true);
      await conn.execute(
        "INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', 'snapshot.restore', 'ok', ?)",
        [`restored #${id} (${countDocuments(snap)} documents); previous data saved as #${safety}`],
      );
      await conn.commit();
      console.log(`Restored snapshot #${id} (${countDocuments(snap)} documents). Data it replaced is snapshot #${safety}.`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
    return;
  }
  throw new Error("Usage: npm run snapshot -- list | restore <id>");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => conn.end());
