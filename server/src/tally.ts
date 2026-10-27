/**
 * Purchase Orders from Tally — READ ONLY. Tally is never written to: we read its XML
 * (an "Export → XML (Data Interchange)" file today; the same XML over Tally's HTTP
 * interface once the connector runs next to Tally) and keep a copy the gate searches.
 * What has arrived against a PO is tracked on our gate entries, never on the PO.
 */
import type { RowDataPacket } from "mysql2/promise";
import type { FlowState, TallyPo } from "../../src/flow/types";
import type { Conn } from "./db";
import { loadState, persistChanges, requestResync, skipTallyPoNumbers } from "./repository";

export type ParsedPo = Omit<TallyPo, "syncedAt">;

/** Tally writes files as UTF-16 or UTF-8; either way we get text. */
export function readTallyXml(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  return buf.toString("utf8");
}

/** Tag text with entities decoded; Tally's own markers (&#4; etc.) and control characters dropped. */
function decode(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const field = (body: string, tag: string): string => {
  const m = body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : "";
};

/** The entry's own fields only — nested lists (batch, godown, accounting allocations) removed. */
const ownFields = (body: string) => body.replace(/<([A-Z0-9.]+\.LIST)\b[^>]*>[\s\S]*?<\/\1>/g, "");

/** " 5000 Pcs" / "12.500 Kg" / "120 Pcs = 10 Doz" (alternate unit) → the main quantity and unit. */
function quantity(raw: string): { qty: number; unit: string } | null {
  const m = raw.split("=")[0].trim().match(/^(-?[\d,]*\.?\d+)\s+([A-Za-z][A-Za-z.]*)$/);
  if (!m) return null; // empty, or a compound unit ("2 Box 5 Pcs") — refused rather than guessed
  return { qty: Math.abs(Number(m[1].replace(/,/g, ""))), unit: m[2] };
}

/** What one read of Tally gave: the POs to keep, the ones left out and why, and the expense POs. */
export interface TallyRead {
  pos: ParsedPo[];
  /** Left out because something in them cannot be read exactly — fixed in Tally, the next read takes them. */
  skipped: { poNo: string; reason: string }[];
  /** Expense/service POs (no stock items, e.g. promotional items): not material for gate, GRN and QC. */
  withoutItems: number;
}

/**
 * Every Purchase Order voucher in Tally's XML — an "Export → XML (Data Interchange)" file or the answer of
 * purchaseOrderRequest. `voucherTypes` are the client's PO voucher type names. A PO that cannot be read
 * exactly is never guessed: it is skipped and reported, and the rest come in.
 */
export function parseTallyPurchaseOrders(xml: string, voucherTypes: string[]): TallyRead {
  const types = new Set(voucherTypes.map((t) => t.trim().toLowerCase()));
  const read: { po: ParsedPo; problems: string[] }[] = [];
  const skipped: TallyRead["skipped"] = [];
  let withoutItems = 0;

  for (const v of xml.matchAll(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/g)) {
    const [, attrs, body] = v;
    const type = field(body, "VOUCHERTYPENAME") || decode(attrs.match(/VCHTYPE="([^"]*)"/)?.[1] ?? "");
    if (!types.has(type.toLowerCase())) continue;

    const poNo = field(body, "VOUCHERNUMBER");
    const d = field(body, "DATE").match(/^(\d{4})(\d{2})(\d{2})$/);
    const supplierName = field(body, "PARTYLEDGERNAME") || field(body, "PARTYNAME");
    const problems: string[] = [];
    if (!d) problems.push("date missing or not yyyymmdd");
    if (!supplierName) problems.push("supplier (party ledger) missing");

    const lines: ParsedPo["lines"] = [];
    for (const e of body.matchAll(/<(ALLINVENTORYENTRIES|INVENTORYENTRIES)\.LIST>([\s\S]*?)<\/\1\.LIST>/g)) {
      const own = ownFields(e[2]);
      const itemName = field(own, "STOCKITEMNAME");
      const raw = field(own, "ACTUALQTY") || field(own, "BILLEDQTY");
      if (!itemName && !raw) continue; // an empty item list, as on expense POs
      const q = quantity(raw);
      if (!itemName) problems.push("an item line without a stock item name");
      else if (!q || q.qty <= 0) problems.push(`"${itemName}" quantity "${raw}" cannot be read`);
      else {
        const same = lines.find((l) => l.itemName === itemName);
        // The same item twice on one PO is one row at the gate.
        if (same && same.unit !== q.unit) problems.push(`"${itemName}" appears in two different units`);
        else if (same) same.qty = Math.round((same.qty + q.qty) * 1000) / 1000;
        else lines.push({ itemName, itemCode: "", qty: q.qty, unit: q.unit });
      }
    }
    if (lines.length === 0 && problems.length === 0) {
      withoutItems++;
      continue;
    }
    if (!poNo) {
      skipped.push({ poNo: `(no number, ${supplierName || "no supplier"})`, reason: "voucher number missing" });
      continue;
    }
    read.push({
      po: {
        poNo,
        date: d ? `${d[3]}-${d[2]}-${d[1]}` : "",
        supplierName,
        cancelled: field(body, "ISCANCELLED").toLowerCase() === "yes",
        guid: field(body, "GUID"),
        alterId: Number(field(body, "ALTERID")) || 0,
        lines,
      },
      problems,
    });
  }

  // The gate finds a PO by its number: two POs sharing one cannot be told apart, so both wait for Tally to be fixed.
  const uses = new Map<string, number>();
  for (const r of read) uses.set(r.po.poNo, (uses.get(r.po.poNo) ?? 0) + 1);
  const pos: ParsedPo[] = [];
  for (const r of read) {
    const n = uses.get(r.po.poNo)!;
    if (n > 1) skipped.push({ poNo: r.po.poNo, reason: `PO number used ${n} times in Tally (${r.po.supplierName}, ${r.po.date})` });
    else if (r.problems.length) skipped.push({ poNo: r.po.poNo, reason: r.problems.join("; ") });
    else pos.push(r.po);
  }
  return { pos, skipped, withoutItems };
}

const xmlText = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The read-only request for Purchase Orders, POSTed to Tally's HTTP port (an Export — it cannot change data).
 * `company` "" = the company open in Tally; dates yyyymmdd.
 */
export function purchaseOrderRequest(company: string, from: string, to: string, voucherTypes: string[], since = 0, poNo = ""): string {
  const types = voucherTypes.map((t) => `$VoucherTypeName = "${xmlText(t)}"`).join(" OR ");
  const filter =
    since > 0 ? `(${types}) AND $AlterID > ${since}` : poNo ? `(${types}) AND $VoucherNumber = "${xmlText(poNo)}"` : types;
  return `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>SSB Purchase Orders</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES>
   ${company ? `<SVCURRENTCOMPANY>${xmlText(company)}</SVCURRENTCOMPANY>` : ""}
   <SVFROMDATE TYPE="Date">${from}</SVFROMDATE>
   <SVTODATE TYPE="Date">${to}</SVTODATE>
   <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
  </STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="SSB Purchase Orders" ISMODIFY="No">
    <TYPE>Voucher</TYPE>
    <FETCH>Date, VoucherNumber, VoucherTypeName, PartyLedgerName, IsCancelled, GUID, AlterID, AllInventoryEntries.*</FETCH>
    <FILTER>SSBIsPO</FILTER>
   </COLLECTION>
   <SYSTEM TYPE="Formulae" NAME="SSBIsPO">${filter}</SYSTEM>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;
}

/**
 * Saves the POs as the current copy from Tally (added, or replacing the previous copy), in the caller's
 * transaction. Item codes: the item synced from Tally (exact Tally name); else, for files imported before the item
 * list was synced, a component name only one component has; else the code Store picked at an earlier GRN.
 */
export async function importTallyPurchaseOrders(
  conn: Conn,
  pos: ParsedPo[],
  syncedAt: string,
): Promise<{ added: number; updated: number; unchanged: number; withoutCode: number; skipped: TallyRead["skipped"] }> {
  if (pos.length === 0) return { added: 0, updated: 0, unchanged: 0, withoutCode: 0, skipped: [] };
  const [comps] = await conn.query<RowDataPacket[]>("SELECT code, name, tally_name FROM components");
  const fromTally = new Map(
    comps.filter((c) => c.tally_name).map((c) => [String(c.tally_name).trim().toLowerCase(), String(c.code)]),
  );
  // shortcut: codes found by exact component name; Tally item names that differ from our master get no code
  // until the masters export (Tally aliases = PMS codes) is loaded — then map by alias instead.
  // Only a name that ONE component has: the master repeats some names (e.g. "LL-112 BOTTLE" is PMS0158 and
  // PMS0169), and guessing would put stock on the wrong component.
  const byName = new Map<string, string[]>();
  for (const c of comps) {
    const k = String(c.name).trim().toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), String(c.code)]);
  }
  const codeOf = new Map([...byName].filter(([, codes]) => codes.length === 1).map(([k, codes]) => [k, codes[0]]));
  const unique = new Set(codeOf.keys());
  // Else the code Store picked on an earlier GRN of the same Tally item (latest wins).
  const [picked] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
    `SELECT l.item_name, r.component_code FROM goods_receipts r
       JOIN gate_entry_lines l ON l.gate_entry_no = r.gate_entry_no AND l.line_no = r.gate_line_no
      ORDER BY r.seq`,
  );
  for (const p of picked) {
    const name = String(p.item_name).trim().toLowerCase();
    if (!unique.has(name)) codeOf.set(name, String(p.component_code));
  }
  for (const [name, code] of fromTally) codeOf.set(name, code); // the synced item list wins

  const before: FlowState = await loadState(conn, { tallyPos: { sql: "h.po_no IN (?)", params: [pos.map((p) => p.poNo)] } });
  const old = new Map(before.tallyPos.map((p) => [p.poNo, p]));
  const skipped: TallyRead["skipped"] = [];
  const fresh: TallyPo[] = [];
  for (const p of pos) {
    const prev = old.get(p.poNo);
    // Tally's numbering is manual: a number already held by ANOTHER Tally voucher is not overwritten.
    if (prev?.guid && p.guid && prev.guid !== p.guid) {
      skipped.push({ poNo: p.poNo, reason: `PO number already used by another Tally PO (${prev.supplierName}, ${prev.date})` });
      continue;
    }
    fresh.push({ ...p, syncedAt, lines: p.lines.map((l) => ({ ...l, itemCode: codeOf.get(l.itemName.toLowerCase()) ?? "" })) });
  }
  // A copy that has not changed keeps its old object, so nothing is written and no screen reloads it.
  const facts = (p: TallyPo) =>
    JSON.stringify([p.date, p.supplierName, p.cancelled, p.guid, p.alterId, p.lines.map((l) => [l.itemName, l.itemCode, l.qty, l.unit])]);
  const same = (a: TallyPo, b: TallyPo) => facts(a) === facts(b);
  const byNo = new Map(fresh.map((f) => [f.poNo, f]));
  let unchanged = 0;
  const after: FlowState = {
    ...before,
    tallyPos: [
      ...before.tallyPos.map((prev) => {
        const f = byNo.get(prev.poNo);
        if (!f || same(prev, f)) {
          if (f) unchanged++;
          return prev;
        }
        return f;
      }),
      ...fresh.filter((f) => !old.has(f.poNo)),
    ],
  };
  await persistChanges(conn, before, after, null);
  // shortcut: guards the numbers Tally had used by this import; two systems numbering POs at the same moment
  // can still clash — once the Tally API exists, let one side (Tally) give the number.
  await skipTallyPoNumbers(conn, pos.map((p) => p.poNo));
  const added = fresh.filter((f) => !old.has(f.poNo)).length;
  return {
    added,
    updated: fresh.length - added - unchanged,
    unchanged,
    withoutCode: fresh.flatMap((p) => p.lines).filter((l) => !l.itemCode).length,
    skipped,
  };
}

/* ── masters: stock items and vendors (the librarian's item list) ─────────────── */

export interface TallyItem {
  name: string;
  /** The alias that is one of our codes (PMS…, PMR…, PM…), else "". */
  code: string;
  unit: string;
  group: string;
  masterId: number;
  alterId: number;
}

/** An alias that is a code in the client's own series (PMS = packing material, PMR = PM of RM groups). */
const CODE_ALIAS = /^PM[SR]?\d+$/i;

const collectionRequest = (id: string, type: string, fetchList: string, company: string, filter: string) => `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES>
   ${company ? `<SVCURRENTCOMPANY>${xmlText(company)}</SVCURRENTCOMPANY>` : ""}
   <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
  </STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fetchList}</FETCH>${filter ? `<FILTER>${id}Filter</FILTER>` : ""}</COLLECTION>
   ${filter ? `<SYSTEM TYPE="Formulae" NAME="${id}Filter">${filter}</SYSTEM>` : ""}
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;

/** Read-only: the stock item list (with aliases), only items changed after `since` when > 0. */
export const stockItemRequest = (company: string, since = 0) =>
  collectionRequest("SSBItems", "StockItem", "Name, Parent, BaseUnits, MasterID, AlterID, LanguageName.*", company, since > 0 ? `$AlterID > ${since}` : "");

/** Read-only: the vendors (ledgers under Sundry Creditors), only those changed after `since` when > 0. */
export const vendorRequest = (company: string, since = 0) =>
  collectionRequest(
    "SSBVendors",
    "Ledger",
    "Name, Parent, MasterID, AlterID",
    company,
    since > 0 ? `$$IsBelongsTo:$$GroupSundryCreditors AND $AlterID > ${since}` : "$$IsBelongsTo:$$GroupSundryCreditors",
  );

export function parseTallyStockItems(xml: string): TallyItem[] {
  const out: TallyItem[] = [];
  for (const m of xml.matchAll(/<STOCKITEM NAME="([^"]*)"[^>]*>([\s\S]*?)<\/STOCKITEM>/g)) {
    const name = decode(m[1]);
    if (!name) continue;
    const aliases = [...m[2].matchAll(/<NAME>([\s\S]*?)<\/NAME>/g)].map((x) => decode(x[1])).filter((a) => a && a !== name);
    out.push({
      name,
      code: (aliases.find((a) => CODE_ALIAS.test(a)) ?? "").toUpperCase(),
      unit: field(m[2], "BASEUNITS"),
      group: field(m[2], "PARENT"),
      masterId: Number(field(m[2], "MASTERID")) || 0,
      alterId: Number(field(m[2], "ALTERID")) || 0,
    });
  }
  return out;
}

export function parseTallyVendors(xml: string): { name: string; alterId: number }[] {
  return [...xml.matchAll(/<LEDGER NAME="([^"]*)"[^>]*>([\s\S]*?)<\/LEDGER>/g)]
    .map((m) => ({ name: decode(m[1]), alterId: Number(field(m[2], "ALTERID")) || 0 }))
    .filter((v) => v.name);
}

/**
 * Keeps the copy of Tally's item list, then makes every item we buy (on any PO) or that carries one of our codes
 * an item of the app: code = its PMS/PMR alias, else "T" + Tally's MasterID; name and unit as in Tally. An item
 * keeps the code it was first given (GRNs and stock refer to it). Returns what changed.
 */
export async function saveTallyItems(conn: Conn, items: TallyItem[], boughtNow: string[]): Promise<{ added: number; renamed: number }> {
  // An item renamed in Tally keeps its MasterID: it is the same item (same code, same stock), under its new name.
  const [mirrored] = await conn.query<RowDataPacket[]>("SELECT name, master_id FROM tally_items");
  const nameOfMaster = new Map(mirrored.map((m) => [Number(m.master_id), String(m.name)]));
  const renamedFrom = new Map<number, string>();
  for (const t of items) {
    const old = nameOfMaster.get(t.masterId);
    if (old && old !== t.name) {
      renamedFrom.set(t.masterId, old.toLowerCase());
      await conn.query("DELETE FROM tally_items WHERE name = ?", [old]);
    }
  }
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    await conn.query(
      `INSERT INTO tally_items (name, alias, unit, grp, master_id, alter_id) VALUES ?
       ON DUPLICATE KEY UPDATE alias = VALUES(alias), unit = VALUES(unit), grp = VALUES(grp),
                               master_id = VALUES(master_id), alter_id = VALUES(alter_id)`,
      [chunk.map((t) => [t.name, t.code, t.unit, t.group.slice(0, 120), t.masterId, t.alterId])],
    );
  }
  const [mirror] = await conn.query<RowDataPacket[]>("SELECT name, alias, unit, grp, master_id FROM tally_items");
  const [bought] = await conn.query<RowDataPacket[]>("SELECT DISTINCT item_name FROM tally_po_lines");
  const buys = new Set([...bought.map((b) => String(b.item_name)), ...boughtNow].map((n) => n.trim().toLowerCase()));
  const [comps] = await conn.query<RowDataPacket[]>("SELECT code, name, unit, tally_name FROM components");
  const byCode = new Map(comps.map((c) => [String(c.code), c]));
  const codeOfTally = new Map(comps.filter((c) => c.tally_name).map((c) => [String(c.tally_name).toLowerCase(), String(c.code)]));

  let added = 0;
  let renamed = 0;
  for (const t of mirror) {
    const name = String(t.name);
    const key = name.toLowerCase();
    const alias = String(t.alias);
    const was = renamedFrom.get(Number(t.master_id));
    const known = codeOfTally.get(key) ?? (was ? codeOfTally.get(was) : undefined);
    if (!alias && !known && !buys.has(key) && !(was && buys.has(was))) continue; // not bought, not ours: Tally only
    const claimed = alias && byCode.get(alias)?.tally_name && String(byCode.get(alias)!.tally_name).toLowerCase() !== key;
    const code = known ?? (alias && !claimed ? alias : `T${t.master_id}`);
    const unit = String(t.unit).slice(0, 16);
    const prev = byCode.get(code);
    if (prev) {
      if (prev.name === name && prev.unit === unit && String(prev.tally_name ?? "").toLowerCase() === key) continue;
      await conn.query("UPDATE components SET name = ?, unit = ?, tally_name = ?, active = 1 WHERE code = ?", [name.slice(0, 160), unit, name, code]);
      renamed++;
    } else {
      await conn.query("INSERT INTO components (code, name, type, unit, tally_name) VALUES (?, ?, ?, ?, ?)", [
        code,
        name.slice(0, 160),
        String(t.grp).slice(0, 40),
        unit,
        name,
      ]);
      added++;
    }
    byCode.set(code, { code, name, unit, tally_name: name } as RowDataPacket);
    codeOfTally.set(key, code);
  }
  if (added + renamed > 0) {
    // Every screen reloads the item list and the documents that show item names.
    await conn.query("UPDATE app_meta SET v = CAST(v AS UNSIGNED) + 1 WHERE k = 'masters_version'");
    await requestResync(conn);
  }
  return { added, renamed };
}

/** Vendors as named in Tally become approved suppliers (rates stay as they are). Returns how many are new. */
export async function saveTallyVendors(conn: Conn, vendors: { name: string }[]): Promise<number> {
  const [known] = await conn.query<RowDataPacket[]>("SELECT name FROM suppliers");
  const onFile = new Set(known.map((k) => String(k.name).toLowerCase()));
  let added = 0;
  for (const v of vendors) {
    if (v.name.length > 120) continue;
    await conn.query(
      "INSERT INTO suppliers (name, city, approved, from_tally) VALUES (?, '', 1, 1) ON DUPLICATE KEY UPDATE approved = 1, from_tally = 1",
      [v.name],
    );
    if (!onFile.has(v.name.toLowerCase())) added++;
  }
  return added;
}

/* ── one sync run: items → vendors → POs ──────────────────────────────────────── */

export interface SyncResult {
  syncedAt: string;
  full: boolean;
  items: { read: number; added: number; renamed: number };
  vendors: { read: number; added: number };
  pos: { read: number; added: number; updated: number; unchanged: number; cancelled: number; withoutItems: number; withoutCode: number };
  skipped: TallyRead["skipped"];
}

async function getMeta(conn: Conn, k: string): Promise<string | null> {
  const [r] = await conn.query<RowDataPacket[]>("SELECT v FROM app_meta WHERE k = ?", [k]);
  return r[0] ? String(r[0].v) : null;
}
const setMeta = (conn: Conn, k: string, v: string) =>
  conn.query("INSERT INTO app_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [k, v]);

/** Why the scheduled sync is failing (since when, last try), for the screens — "" clears it once a sync works. */
export async function recordSyncError(conn: Conn, error: string, at: string): Promise<void> {
  const prev = JSON.parse((await getMeta(conn, "tally_sync_error")) ?? "null") as { since: string } | null;
  await setMeta(conn, "tally_sync_error", error ? JSON.stringify({ since: prev?.since ?? at, at, error: error.slice(0, 300) }) : "null");
}

/**
 * The librarian's visit to the library. `ask` sends one read-only request to Tally and returns its answer —
 * over HTTP today, through the connector later. Incremental (only what Tally changed since the last run, by
 * AlterID) unless `full`, which re-reads everything and marks POs that disappeared from Tally as cancelled.
 * Runs in the caller's transaction; the status (time, counts, POs left out) is kept for the screens.
 */
export async function syncFromTally(
  conn: Conn,
  ask: (requestXml: string) => Promise<string>,
  o: { full: boolean; company: string; voucherTypes: string[]; from: string; to: string; syncedAt: string },
): Promise<SyncResult> {
  const since = async (k: string) => (o.full ? 0 : Number((await getMeta(conn, k)) ?? 0) || 0);
  const [sItems, sVendors, sPos] = [await since("tally_alter_items"), await since("tally_alter_vendors"), await since("tally_alter_pos")];

  const items = parseTallyStockItems(await ask(stockItemRequest(o.company, sItems)));
  const vendors = parseTallyVendors(await ask(vendorRequest(o.company, sVendors)));
  const read = parseTallyPurchaseOrders(await ask(purchaseOrderRequest(o.company, o.from, o.to, o.voucherTypes, sPos)), o.voucherTypes);

  const it = await saveTallyItems(conn, items, read.pos.flatMap((p) => p.lines.map((l) => l.itemName)));
  const vendorsAdded = await saveTallyVendors(conn, vendors);

  let pos = read.pos;
  let cancelled = 0;
  if (o.full) {
    // A PO deleted in Tally: kept (gate entries point to it) but no longer open.
    const seen = new Set(read.pos.map((p) => p.guid).filter(Boolean));
    const skippedNos = new Set(read.skipped.map((x) => x.poNo));
    const all = await loadState(conn, { tallyPos: { sql: "h.guid <> '' AND h.cancelled = 0 AND h.po_date BETWEEN ? AND ?", params: [ymd(o.from), ymd(o.to)] } });
    const gone = all.tallyPos.filter((p) => !seen.has(p.guid) && !skippedNos.has(p.poNo));
    cancelled = gone.length;
    pos = [...pos, ...gone.map(({ syncedAt: _, ...p }) => ({ ...p, cancelled: true }))];
  }
  const r = await importTallyPurchaseOrders(conn, pos, o.syncedAt);
  const skipped = [...read.skipped, ...r.skipped];

  const maxAlter = (xs: { alterId: number }[], prev: number) => Math.max(prev, ...xs.map((x) => x.alterId));
  await setMeta(conn, "tally_alter_items", String(maxAlter(items, sItems)));
  await setMeta(conn, "tally_alter_vendors", String(maxAlter(vendors, sVendors)));
  await setMeta(conn, "tally_alter_pos", String(maxAlter(read.pos, sPos)));
  const result: SyncResult = {
    syncedAt: o.syncedAt,
    full: o.full,
    items: { read: items.length, ...it },
    vendors: { read: vendors.length, added: vendorsAdded },
    pos: {
      read: read.pos.length,
      added: r.added,
      updated: r.updated,
      unchanged: r.unchanged,
      cancelled,
      withoutItems: read.withoutItems,
      withoutCode: r.withoutCode,
    },
    skipped,
  };
  // Left-out POs stay listed until a later run takes them (an incremental run only sees what changed).
  const prev = JSON.parse((await getMeta(conn, "tally_status")) ?? "null") as SyncResult | null;
  const taken = new Set(read.pos.map((p) => p.poNo));
  const carried = o.full ? [] : (prev?.skipped ?? []).filter((x) => !taken.has(x.poNo) && !skipped.some((y) => y.poNo === x.poNo));
  await setMeta(conn, "tally_status", JSON.stringify({ ...result, skipped: [...skipped, ...carried] }));
  return result;
}

/** yyyymmdd → yyyy-mm-dd */
const ymd = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/* ── app → Tally: create a PO raised and approved here (the only write to Tally) ── */

export interface PoForTally {
  poNo: string;
  /** yyyymmdd */
  date: string;
  /** The vendor's ledger name exactly as in Tally. */
  party: string;
  /** dd-mm-yyyy or "" */
  dueDate: string;
  /** Indents the PO was raised from — kept in Tally's reference field. */
  reference: string;
  /** Item names and units exactly as in Tally. */
  lines: { item: string; unit: string; qty: number; rate: number }[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * The request that creates one Purchase Order in Tally, in the shape of the client's own POs (party ledger with the
 * total, items with rate/amount/qty, godown "Main Location", the PO number as order number, purchase ledger
 * "Purchase-Gst"). shortcut: no GST lines yet — the PO goes in at the before-GST total; add IGST / CGST+SGST once
 * the rule (vendor state × item GST rate) is agreed with Accounts.
 */
export function purchaseOrderCreateRequest(company: string, po: PoForTally, purchaseLedger = "Purchase-Gst", godown = "Main Location"): string {
  // Tally refuses an order line without a due date ("Due Date of Order is missing") and reads it only from the P
  // attribute, as in its own export. No due date on the PO: the PO date, as Tally does for a PO entered by hand.
  const [, d, m, y] = po.dueDate.match(/^(\d{2})-(\d{2})-(\d{4})$/) ?? [, po.date.slice(6, 8), po.date.slice(4, 6), po.date.slice(0, 4)];
  const dueText = `${Number(d)}-${MONTHS[Number(m) - 1]}-${y!.slice(2)}`;
  const total = po.lines.reduce((n, l) => n + Math.round(l.qty * l.rate * 100) / 100, 0);
  const items = po.lines
    .map((l) => {
      const amount = money(l.qty * l.rate);
      const qty = `${l.qty} ${xmlText(l.unit)}`;
      return `<ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${xmlText(l.item)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <RATE>${money(l.rate)}/${xmlText(l.unit)}</RATE>
      <AMOUNT>-${amount}</AMOUNT>
      <ACTUALQTY> ${qty}</ACTUALQTY>
      <BILLEDQTY> ${qty}</BILLEDQTY>
      <BATCHALLOCATIONS.LIST>
       <GODOWNNAME>${xmlText(godown)}</GODOWNNAME>
       <BATCHNAME>Primary Batch</BATCHNAME>
       <ORDERNO>${xmlText(po.poNo)}</ORDERNO>
       <ORDERDUEDATE P="${dueText}">${dueText}</ORDERDUEDATE>
       <AMOUNT>-${amount}</AMOUNT>
       <ACTUALQTY> ${qty}</ACTUALQTY>
       <BILLEDQTY> ${qty}</BILLEDQTY>
      </BATCHALLOCATIONS.LIST>
      <ACCOUNTINGALLOCATIONS.LIST>
       <LEDGERNAME>${xmlText(purchaseLedger)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>-${amount}</AMOUNT>
      </ACCOUNTINGALLOCATIONS.LIST>
     </ALLINVENTORYENTRIES.LIST>`;
    })
    .join("\n     ");
  return `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
 <BODY>
  <DESC><STATICVARIABLES>${company ? `<SVCURRENTCOMPANY>${xmlText(company)}</SVCURRENTCOMPANY>` : ""}</STATICVARIABLES></DESC>
  <DATA><TALLYMESSAGE>
   <VOUCHER VCHTYPE="Purchase Order" ACTION="Create" OBJVIEW="Invoice Voucher View">
     <DATE>${po.date}</DATE>
     <EFFECTIVEDATE>${po.date}</EFFECTIVEDATE>
     <VOUCHERTYPENAME>Purchase Order</VOUCHERTYPENAME>
     <VOUCHERNUMBER>${xmlText(po.poNo)}</VOUCHERNUMBER>
     <REFERENCE>${xmlText(po.reference || po.poNo)}</REFERENCE>
     <PARTYLEDGERNAME>${xmlText(po.party)}</PARTYLEDGERNAME>
     <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
     <NARRATION>Raised in Seven Seas Material Flow</NARRATION>
     ${items}
     <LEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlText(po.party)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
      <AMOUNT>${money(total)}</AMOUNT>
     </LEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE></DATA>
 </BODY>
</ENVELOPE>`;
}

/** Tally's answer to an Import: how many vouchers it created, and its error lines if it refused. */
export function parseImportResult(xml: string): { created: number; errors: number; messages: string[] } {
  const n = (tag: string) => Number(field(xml, tag)) || 0;
  const messages = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/g)].map((m) => decode(m[1])).filter(Boolean);
  return { created: n("CREATED"), errors: n("ERRORS") + (messages.length && !n("ERRORS") ? 1 : 0), messages };
}
