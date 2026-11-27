/**
 * Opening stock from the client's stock list (output.json: SKU Code, Item Type, Closing Stock).
 *   npm run master:opening -- reference-materials/output.json            dry run: does it all, then rolls back
 *   npm run master:opening -- reference-materials/output.json --apply    keeps it (back the database up first)
 *
 *  - PM / RM / other items: opening stock = Closing Stock (negative → 0, fractions rounded; both listed).
 *  - Finished goods with stock: ONE opening document — a received FG transfer, batch "OPENING", with PDI passed — so
 *    FG Warehouse, PDI and Dispatch use it like any other FG stock. Refused if opening FG stock was loaded before.
 * Writes <folder of the file>/out/opening-report.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { emptyState, todayLabel } from "../../src/flow/logic";
import type { FgTransfer, PdiRecord } from "../../src/flow/types";
import { maintenanceConnection } from "../src/db";
import { allocateNumber, persistChanges, requestResync } from "../src/repository";

const OPENING_BATCH = "OPENING";
const [file, flag] = process.argv.slice(2);

async function main() {
  if (!file || (flag && flag !== "--apply")) throw new Error("Usage: npm run master:opening -- <output.json> [--apply]");
  const list = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>[];
  const stock = new Map<string, { type: string; qty: number; name: string }>();
  for (const r of list) {
    const code = String(r["SKU Code"] ?? "").trim().toUpperCase();
    const qty = Number(r["Closing Stock"]);
    if (code && Number.isFinite(qty)) stock.set(code, { type: String(r["Item Type"]), qty, name: String(r["Item Name"]) });
  }

  const conn = await maintenanceConnection();
  const out: string[] = [`# Opening stock — ${flag ? "APPLIED" : "dry run (nothing kept)"}\n`];
  const negative: string[] = [];
  const rounded: string[] = [];
  const unknown: string[] = [];
  let items = 0;
  try {
    await conn.beginTransaction();
    const [comps] = await conn.query<RowDataPacket[]>("SELECT code FROM components");
    const known = new Set(comps.map((c) => String(c.code)));
    const [prods] = await conn.query<RowDataPacket[]>("SELECT name, fg_code FROM products WHERE fg_code <> ''");
    const productOf = new Map(prods.map((p) => [String(p.fg_code).toUpperCase(), String(p.name)]));

    // ── PM / RM / other items ──
    for (const [code, s] of stock) {
      if (s.type === "Finished Good") continue;
      if (!known.has(code)) {
        unknown.push(`${code} ${s.name}`);
        continue;
      }
      if (s.qty < 0) negative.push(`${code} ${s.name}: ${s.qty} → 0`);
      if (!Number.isInteger(s.qty)) rounded.push(`${code} ${s.name}: ${s.qty} → ${Math.round(s.qty)}`);
      await conn.query(
        "INSERT INTO stock_settings (component_code, opening_qty) VALUES (?, ?) ON DUPLICATE KEY UPDATE opening_qty = VALUES(opening_qty)",
        [code, Math.max(0, Math.round(s.qty))],
      );
      items++;
    }

    // ── finished goods: one received opening transfer + PDI passed ──
    const [[done]] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM production_batches WHERE batch_no = ?", [OPENING_BATCH]);
    if (Number(done.n) > 0) throw new Error("Opening FG stock was loaded before (batch OPENING exists) — nothing changed.");
    const fg = [...stock].filter(([, s]) => s.type === "Finished Good" && s.qty > 0);
    for (const [code, s] of stock) {
      if (s.type !== "Finished Good") continue;
      if (!productOf.has(code)) unknown.push(`${code} ${s.name} (FG)`);
      else if (s.qty < 0) negative.push(`${code} ${s.name} (FG): ${s.qty} → 0`);
    }
    const lines = fg
      .filter(([code]) => productOf.has(code))
      .map(([code, s]) => ({
        productCode: code,
        productName: productOf.get(code)!,
        sku: code,
        batchNo: OPENING_BATCH,
        mfgDate: "",
        qtyPerBox: 1, // the table needs > 0; all of it is loose
        totalBoxes: 0,
        looseQty: Math.round(s.qty),
        totalQty: Math.round(s.qty),
        remark: "Opening stock",
      }));
    if (lines.length) {
      const today = todayLabel();
      const transfer: FgTransfer = {
        id: await allocateNumber(conn, "FGT"),
        date: today,
        lines,
        submittedBy: "Opening stock",
        checkedBy: "Opening stock",
        location: "FG Godown A",
        status: "RECEIVED",
        receivedDate: today,
      };
      const pdi: PdiRecord[] = [];
      for (const l of lines) {
        pdi.push({ id: await allocateNumber(conn, "PDI"), date: today, productName: l.productName, batchNo: OPENING_BATCH, status: "PASSED", remark: "Opening stock — already in the godown" });
      }
      const base = emptyState(); // same openings object: only the two new documents are written
      await persistChanges(conn, base, { ...base, fgTransfers: [transfer], pdiRecords: pdi }, null);
      out.push(`FG opening document ${transfer.id}: ${lines.length} finished goods, ${lines.reduce((n, l) => n + l.totalQty, 0)} pcs.\n`);
    }
    await requestResync(conn);

    out.push(`PM / RM / other items with an opening stock set: ${items}\n`);
    for (const [title, l] of [
      ["Negative stock loaded as 0", negative],
      ["Fractions rounded", rounded],
      ["Code not in the app (skipped)", unknown],
    ] as const) {
      out.push(`\n### ${title} — ${l.length}\n`, ...l.map((x) => `- ${x}`));
    }
    if (flag === "--apply") {
      await conn.query("INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', 'master.opening', 'ok', ?)", [
        `${items} items, ${lines.length} FG`,
      ]);
      await conn.commit();
    } else {
      await conn.rollback();
    }
    const dir = join(dirname(file), "out");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opening-report.md"), out.join("\n") + "\n");
    console.log(out.filter((l) => !l.startsWith("- ")).join("\n"));
    console.log(`\n${flag ? "Applied." : "Dry run — rolled back, nothing changed."} Lists: ${join(dir, "opening-report.md")}`);
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
