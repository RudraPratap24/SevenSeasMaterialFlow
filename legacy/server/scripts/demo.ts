/**
 * Replaces every register with the demo storyline (or empties them with --clear).
 * Refused on a production system unless ALLOW_DEMO_RESET=true.
 *   npm run db:demo
 *   npm run db:demo -- --clear
 */
import { emptyState } from "../../src/flow/logic";
import { seedState } from "../seed/demoStory";
import { config, isProd } from "../src/config";
import { maintenanceConnection } from "../src/db";
import { loadState, persistChanges, saveSnapshot } from "../src/repository";

async function main() {
  if (isProd && !config.ALLOW_DEMO_RESET) {
    throw new Error("Refusing to overwrite registers on a production system (ALLOW_DEMO_RESET is false).");
  }
  const clear = process.argv.includes("--clear");
  const conn = await maintenanceConnection();
  try {
    await conn.beginTransaction();
    const before = await loadState(conn);
    const snapshotId = await saveSnapshot(conn, before, clear ? "before cli demo.clear" : "before cli demo.load", {
      id: null,
      username: "cli",
    });
    await persistChanges(conn, before, clear ? emptyState() : seedState(), null, true);
    await conn.execute(
      "INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', ?, 'ok', 'run from command line')",
      [clear ? "demo.clear" : "demo.load"],
    );
    await conn.commit();
    console.log(clear ? "All registers emptied." : "Demo storyline loaded.");
    console.log(`Previous data saved as snapshot #${snapshotId} (undo: npm run snapshot -- restore ${snapshotId}).`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
