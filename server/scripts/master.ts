/**
 * Master-data maintenance. A rename changes ONE row; every document that refers
 * to it shows the new name immediately, because documents hold keys, not names.
 *
 *   npm run master -- rename-product "<old name>" "<new name>"
 *   npm run master -- rename-component <PMS code> "<new name>"
 *   npm run master -- rename-supplier "<old name>" "<new name>"
 *   npm run master -- rename-customer "<old name>" "<new name>"
 */
import type { ResultSetHeader } from "mysql2/promise";
import { blindIndex, encryptValue } from "../src/crypto";
import { maintenanceConnection } from "../src/db";

const [cmd, from, to] = process.argv.slice(2);

async function main() {
  if (!cmd || !from || !to?.trim()) {
    throw new Error('Usage: npm run master -- rename-product|rename-component|rename-supplier|rename-customer "<old>" "<new>"');
  }
  const conn = await maintenanceConnection();
  try {
    await conn.beginTransaction();
    let sql: string;
    let params: unknown[];
    switch (cmd) {
      case "rename-product":
        sql = "UPDATE products SET name = ? WHERE name = ?";
        params = [to.trim(), from];
        break;
      case "rename-component":
        sql = "UPDATE components SET name = ? WHERE code = ?";
        params = [to.trim(), from.toUpperCase()];
        break;
      case "rename-supplier":
        sql = "UPDATE suppliers SET name = ? WHERE name = ?";
        params = [to.trim(), from];
        break;
      case "rename-customer":
        // The name is encrypted; the customer is found by its blind index, and both are replaced together.
        sql = "UPDATE customers SET name_enc = ?, name_hash = ? WHERE name_hash = ?";
        params = [encryptValue(to.trim()), blindIndex(to), blindIndex(from)];
        break;
      default:
        throw new Error(`Unknown command ${cmd}.`);
    }
    const [r] = await conn.execute<ResultSetHeader>(sql, params as never[]);
    if (r.affectedRows !== 1) throw new Error(`Nothing renamed — no single match for "${from}".`);
    // Every open screen re-reads masters and registers.
    await conn.query("UPDATE app_meta SET v = CAST(v AS UNSIGNED) + 1 WHERE k IN ('masters_version', 'state_version', 'resync_version')");
    await conn.execute(
      "INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', ?, 'ok', ?)",
      [`master.${cmd}`, `${cmd.startsWith("rename-customer") ? "(customer)" : from} → ${cmd === "rename-customer" ? "(customer)" : to.trim()}`],
    );
    await conn.commit();
    console.log(`Renamed. Every document referring to it now shows "${to.trim()}".`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  const e = err as { code?: string; message?: string };
  console.error(e.code === "ER_DUP_ENTRY" ? `"${to}" is already used by another record.` : (e.message ?? err));
  process.exit(1);
});
