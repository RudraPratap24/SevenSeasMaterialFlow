/**
 * Talking to Tally's HTTP port, and creating a PO raised + approved here in Tally — the only write to Tally.
 * Used by the server (on approval, and "Retry") and by `npm run tally -- push`. Off unless TALLY_ALLOW_WRITE=true.
 */
import type { RowDataPacket } from "mysql2/promise";
import { FlowError, nowHHMM, NUMBER_TAKEN, numberTaken, todayLabel } from "../../src/flow/logic";
import type { FlowState } from "../../src/flow/types";
import { config } from "./config";
import { decryptValue } from "./crypto";
import type { Conn } from "./db";
import { allocateNumber, loadState, persistChanges, renumberPo } from "./repository";
import {
  importTallyPurchaseOrders,
  parseImportResult,
  parseTallyPurchaseOrders,
  purchaseOrderCreateRequest,
  purchaseOrderRequest,
  readTallyXml,
  type PoForTally,
} from "./tally";

/** One request to Tally's HTTP port. */
export async function askTally(requestXml: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(config.TALLY_URL, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: requestXml,
      signal: AbortSignal.timeout(300_000),
    });
  } catch {
    throw new Error(`Tally does not answer at ${config.TALLY_URL} — is TallyPrime open with the company loaded and its server on?`);
  }
  if (!res.ok) throw new Error(`Tally answered HTTP ${res.status}.`);
  const xml = readTallyXml(Buffer.from(await res.arrayBuffer()));
  // An empty answer to everything means no company is open (a quiet company still has stock items).
  if (/<STOCKITEM>0<\/STOCKITEM>[\s\S]*<COLLECTION>\s*<\/COLLECTION>/.test(xml) && /SSBItems/.test(requestXml)) {
    throw new Error("Tally answered but has no company open" + (config.TALLY_COMPANY ? ` (TALLY_COMPANY="${config.TALLY_COMPANY}")` : "") + ".");
  }
  return xml;
}

export const stamp = () => `${todayLabel()} ${nowHHMM()}`;

/** POs from the start of last financial year (open orders can be older) to the end of this one, yyyymmdd. */
export function poWindow(): { from: string; to: string } {
  const now = new Date();
  const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // FY starts 1 April
  return { from: `${fy - 1}0401`, to: `${fy + 1}0331` };
}

/** What Tally needs for the PO — or why it can't go (each check stops before anything is sent). */
async function poForTally(conn: Conn, poNo: string, dateOverride: string): Promise<PoForTally> {
  const [[h]] = await conn.query<RowDataPacket[]>(
    `SELECT p.po_no, DATE_FORMAT(p.po_date, '%Y%m%d') AS po_date, DATE_FORMAT(p.expected_date, '%d-%m-%Y') AS due,
            p.approved_by, s.name AS supplier, s.from_tally
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.po_no = ?`,
    [poNo],
  );
  if (!h) throw new Error(`PO ${poNo} is not a PO raised in this app.`);
  if (h.approved_by === null) throw new Error(`PO ${poNo} is not approved yet — only approved POs go to Tally.`);
  if (Number(h.from_tally) !== 1) throw new Error(`Vendor "${h.supplier}" is not a ledger in Tally.`);
  const [lines] = await conn.query<RowDataPacket[]>(
    `SELECT l.component_code, c.tally_name, c.unit, l.qty, l.rate_enc
       FROM purchase_order_lines l JOIN components c ON c.code = l.component_code WHERE l.po_no = ? ORDER BY l.line_no`,
    [poNo],
  );
  const notInTally = lines.filter((l) => !l.tally_name).map((l) => l.component_code);
  if (notInTally.length) throw new Error(`Not stock items in Tally: ${notInTally.join(", ")}.`);
  const noRate = lines.filter((l) => !l.rate_enc).map((l) => l.component_code);
  if (noRate.length) throw new Error(`No rate on: ${noRate.join(", ")}.`);
  const [indents] = await conn.query<RowDataPacket[]>("SELECT indent_no FROM purchase_indents WHERE po_no = ? ORDER BY indent_no", [poNo]);
  const testDate = dateOverride || config.TALLY_TEST_DATE;
  return {
    poNo,
    date: testDate || String(h.po_date),
    party: String(h.supplier),
    // Educational mode refuses the due date too unless it is the 1st/2nd/31st: on a test date, due = that date.
    dueDate: h.due && !testDate ? String(h.due) : "",
    reference: indents.map((i) => String(i.indent_no)).join(", "),
    lines: lines.map((l) => ({
      item: String(l.tally_name),
      unit: String(l.unit) || "Pcs",
      qty: Number(l.qty),
      rate: Number(decryptValue<string>(String(l.rate_enc))),
    })),
  };
}

/**
 * Creates the PO in Tally, then reads it back into the PO copy (so the screens show IN TALLY). Throws with the
 * reason — ours or Tally's own — when nothing was created. Runs in the caller's transaction.
 */
export async function pushPoToTally(conn: Conn, poNo: string, dateOverride = ""): Promise<string> {
  if (!config.TALLY_ALLOW_WRITE) {
    throw new Error("Writing to Tally is switched off (TALLY_ALLOW_WRITE) — a test copy of Tally only, until Accounts agrees.");
  }
  const po = await poForTally(conn, poNo, dateOverride);
  const { from, to } = poWindow();
  // Tally numbers POs by hand and would take the same number twice — ask it first, never trust a stale copy.
  const already = parseTallyPurchaseOrders(await askTally(purchaseOrderRequest(config.TALLY_COMPANY, from, to, config.TALLY_PO_VOUCHER_TYPES, 0, poNo)), config.TALLY_PO_VOUCHER_TYPES);
  if (already.pos.length || already.skipped.length) throw new Error(`${NUMBER_TAKEN} ${poNo} — nothing sent.`);

  const answer = parseImportResult(await askTally(purchaseOrderCreateRequest(config.TALLY_COMPANY, po)));
  if (answer.created !== 1) throw new Error(`Tally did not create it: ${answer.messages.join(" | ") || `${answer.errors} error(s)`}`);

  // Read it back now; if that fails, the next sync brings it — the PO is in Tally either way.
  try {
    const back = parseTallyPurchaseOrders(await askTally(purchaseOrderRequest(config.TALLY_COMPANY, from, to, config.TALLY_PO_VOUCHER_TYPES, 0, poNo)), config.TALLY_PO_VOUCHER_TYPES);
    await importTallyPurchaseOrders(conn, back.pos, stamp());
  } catch {
    /* the scheduled sync reads it back */
  }
  return `Tally created PO ${poNo} (${po.party}, ${po.lines.length} item(s), dated ${po.date}).`;
}

/**
 * Tally refused the PO because another PO there already has its number: the PO takes the next number of our series
 * that Tally does not have either (Tally is asked for each), everywhere at once. Caller's transaction. Returns it.
 */
export async function renumberForTally(conn: Conn, poNo: string): Promise<string> {
  const before: FlowState = await loadState(conn, { purchaseOrders: { sql: "h.po_no = ?", params: [poNo] } });
  const po = before.purchaseOrders[0];
  if (!po) throw new FlowError(`PO ${poNo} is not a PO raised in this app.`);
  if (!numberTaken(po)) throw new FlowError(`PO ${poNo} was not refused for its number — nothing to change.`);
  const [[used]] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM gate_entries WHERE po_no = ?", [poNo]);
  if (Number(used.n) > 0) throw new FlowError(`Material has already come in against ${poNo} — it keeps its number; fix the other PO in Tally.`);
  const { from, to } = poWindow();
  for (let tries = 0; tries < 5; tries++) {
    const next = await allocateNumber(conn, "PO");
    const there = parseTallyPurchaseOrders(await askTally(purchaseOrderRequest(config.TALLY_COMPANY, from, to, config.TALLY_PO_VOUCHER_TYPES, 0, next)), config.TALLY_PO_VOUCHER_TYPES);
    if (there.pos.length || there.skipped.length) continue; // Tally has that one too — take the next
    await renumberPo(conn, poNo, next);
    return next;
  }
  throw new FlowError("Tally already has the next 5 numbers of the PO series — sync with Tally and try again.");
}

/** Keeps the result on the PO (when, and Tally's reason if it refused), so every screen shows it. Caller's transaction. */
export async function markPush(conn: Conn, poNo: string, error: string): Promise<void> {
  const before: FlowState = await loadState(conn, { purchaseOrders: { sql: "h.po_no = ?", params: [poNo] } });
  const po = before.purchaseOrders[0];
  // Only approved POs are sent; "not approved yet" is not a Tally result to show on the PO.
  if (!po || po.status !== "APPROVED") return;
  const after: FlowState = { ...before, purchaseOrders: [{ ...po, tallyPushedAt: stamp(), tallyError: error.slice(0, 500) }] };
  await persistChanges(conn, before, after, null);
}
