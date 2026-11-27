/**
 * Tally ↔ app.
 *   npm run tally -- sync            items, vendors and Purchase Orders that changed in Tally since the last sync
 *   npm run tally -- sync --full     everything again; POs deleted in Tally are marked cancelled
 *   npm run tally -- watch           sync every TALLY_SYNC_SECONDS (30), on its own, apart from the app (npm run dev
 *                                    starts it); a full sync once a day; failures are shown on the Purchase screen
 *   npm run tally -- import <file>   Purchase Orders from a Tally "XML (Data Interchange)" export file
 *   npm run tally -- push <PO no> [--date yyyymmdd]
 *                                    create a PO raised and approved here in Tally (the only write to Tally;
 *                                    needs TALLY_ALLOW_WRITE=true — a test copy of Tally only, until Accounts agrees)
 *
 * Tally must be open with the company loaded and its server on (F1 → Settings → Connectivity). A PO that cannot
 * be read exactly is skipped and listed — fix it in Tally, a later run takes it. Settings in .env: TALLY_URL,
 * TALLY_COMPANY, TALLY_PO_VOUCHER_TYPES, TALLY_ALLOW_WRITE. Run `sync` every few minutes with Task Scheduler.
 */
import { readFileSync } from "node:fs";
import { config } from "../src/config";
import { maintenanceConnection } from "../src/db";
import { todayLabel } from "../../src/flow/logic";
import { importTallyPurchaseOrders, parseTallyPurchaseOrders, readTallyXml, recordSyncError, syncFromTally } from "../src/tally";
import { askTally, markPush, poWindow, pushPoToTally, stamp } from "../src/tallyPush";

type Conn = Awaited<ReturnType<typeof maintenanceConnection>>;

/** Runs `fn` in one transaction on a maintenance connection. */
async function inTransaction<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
  const conn = await maintenanceConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

async function sync(full: boolean, quiet = false) {
  const r = await inTransaction(async (conn) => {
    const res = await syncFromTally(conn, askTally, {
      full,
      company: config.TALLY_COMPANY,
      voucherTypes: config.TALLY_PO_VOUCHER_TYPES,
      ...poWindow(),
      syncedAt: stamp(),
    });
    // the watcher runs every 30 s: its runs are audited only when they brought something
    if (!quiet || changed(res)) {
      await audit(
        conn,
        "tally.sync",
        `sync${full ? " --full" : ""}: items +${res.items.added}/~${res.items.renamed}, vendors +${res.vendors.added}, POs +${res.pos.added}/~${res.pos.updated}/x${res.pos.cancelled}, ${res.skipped.length} skipped`,
      );
    }
    return res;
  });
  if (quiet) return r;
  console.log(`Tally sync (${full ? "full" : "changes only"}) at ${r.syncedAt}`);
  console.log(`  items:   ${r.items.read} read, ${r.items.added} new in the app, ${r.items.renamed} renamed/updated`);
  console.log(`  vendors: ${r.vendors.read} read, ${r.vendors.added} new`);
  console.log(`  POs:     ${r.pos.read} read, ${r.pos.added} added, ${r.pos.updated} updated, ${r.pos.unchanged} unchanged, ${r.pos.cancelled} gone from Tally`);
  if (r.pos.withoutItems) console.log(`  ${r.pos.withoutItems} expense/service PO(s) without stock items left out (not material for the gate).`);
  if (r.pos.withoutCode) console.log(`  ${r.pos.withoutCode} PO item line(s) without a code — Store picks it at the first GRN.`);
  report(r.skipped);
  return r;
}

type SyncResult = Awaited<ReturnType<typeof syncFromTally>>;
const changed = (r: SyncResult) => r.items.added + r.items.renamed + r.vendors.added + r.pos.added + r.pos.updated + r.pos.cancelled > 0;

/**
 * The sync on its own clock, apart from the app, so the app never depends on it: a failed run (Tally closed, the
 * company not open, the database busy) is recorded for the Purchase screen and tried again next time — the loop
 * never stops on an error. The first run of each day is a full one (marks POs deleted in Tally as cancelled).
 */
async function watch(once: boolean) {
  process.on("unhandledRejection", (e) => console.error(`${stamp()} Tally sync: ${String(e)}`));
  if (!once) console.log(`Tally sync every ${config.TALLY_SYNC_SECONDS}s from ${config.TALLY_URL} — the app works without it.`);
  let failing: string | null = null; // null = not known yet (the first run clears an old failure)
  let fullOn = "";
  for (;;) {
    const day = todayLabel();
    try {
      const r = await sync(fullOn !== day, true);
      fullOn = day;
      if (failing !== "") await inTransaction((conn) => recordSyncError(conn, "", r.syncedAt));
      if (failing) console.log(`${stamp()} Tally sync is working again.`);
      failing = "";
      if (changed(r)) {
        console.log(`${r.syncedAt} from Tally: items +${r.items.added}/~${r.items.renamed}, vendors +${r.vendors.added}, POs +${r.pos.added}/~${r.pos.updated}/x${r.pos.cancelled}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== failing) console.error(`${stamp()} Tally sync failed — the app keeps its last copy, retrying: ${msg}`);
      failing = msg;
      await inTransaction((conn) => recordSyncError(conn, msg, stamp())).catch(() => undefined);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, config.TALLY_SYNC_SECONDS * 1000));
  }
}

/** Creates one approved app PO in Tally (the same as on approval in the app), and keeps the result on the PO. */
async function push(poNo: string, dateOverride: string) {
  console.log(`Creating PO ${poNo} in Tally at ${config.TALLY_URL}${config.TALLY_COMPANY ? ` (${config.TALLY_COMPANY})` : ""}…`);
  let error = "";
  let message = "";
  try {
    message = await inTransaction((conn) => pushPoToTally(conn, poNo, dateOverride));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await inTransaction(async (conn) => {
    if (config.TALLY_ALLOW_WRITE) await markPush(conn, poNo, error);
    await audit(conn, "tally.push", `${poNo}: ${error || "created in Tally"}`);
  });
  if (error) throw new Error(error);
  console.log(message);
  console.log("Read back from Tally — the Purchase screen shows it as IN TALLY.");
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  if (cmd === "sync") {
    await sync(arg === "--full");
  } else if (cmd === "watch") {
    await watch(arg === "--once");
  } else if (cmd === "push" && arg) {
    const d = rest[0] === "--date" ? rest[1] ?? "" : "";
    if (d && !/^\d{8}$/.test(d)) throw new Error("--date must be yyyymmdd");
    await push(arg, d);
  } else if (cmd === "import" && arg) {
    const { pos, skipped, withoutItems } = parseTallyPurchaseOrders(readTallyXml(readFileSync(arg)), config.TALLY_PO_VOUCHER_TYPES);
    const r = await inTransaction(async (conn) => {
      const res = await importTallyPurchaseOrders(conn, pos, stamp());
      await audit(conn, "tally.import", `${arg}: ${res.added} added, ${res.updated} updated, ${skipped.length + res.skipped.length} skipped, ${withoutItems} without items`);
      return res;
    });
    console.log(`Tally purchase orders: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged.`);
    if (withoutItems) console.log(`${withoutItems} expense/service PO(s) without stock items left out (not material for the gate).`);
    if (r.withoutCode) console.log(`${r.withoutCode} item line(s) have no PMS code yet — Store picks it at the first GRN.`);
    report([...skipped, ...r.skipped]);
  } else {
    throw new Error("Usage: npm run tally -- sync [--full]  |  watch [--once]  |  import <export.xml>  |  push <PO no> [--date yyyymmdd]");
  }
}

function report(skipped: { poNo: string; reason: string }[]) {
  if (!skipped.length) return;
  console.log(`${skipped.length} PO(s) skipped — fix in Tally, the next run takes them:`);
  for (const s of skipped) console.log(`  ${s.poNo}: ${s.reason}`);
}

const audit = (conn: Conn, action: string, message: string) =>
  conn.execute("INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', ?, 'ok', ?)", [
    action,
    message.slice(0, 500),
  ]);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
