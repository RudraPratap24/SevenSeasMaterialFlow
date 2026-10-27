/**
 * The business core of the Material Flow — pure functions only, no React, no I/O.
 *
 * Shared by the browser (derived stock, traceability) and the server, which runs
 * every reducer below inside a database transaction. A reducer takes the current
 * state plus the action's input and returns the next state, or throws FlowError
 * when the SOP forbids the action (over-issue, dispatch without PDI, …).
 */
import type { TabId } from "./perms";
import type {
  ComponentInfo,
  CustOrder,
  DispatchSlip,
  FgTransfer,
  FlowState,
  GateEntry,
  GateEntryLine,
  GrnLine,
  Indent,
  Mrn,
  PurchaseOrder,
  QcStatus,
  PoClosure,
  Requisition,
  TallyPo,
  TallyPoLine,
} from "./types";

/** A business-rule rejection. Its message is safe to show to the user. */
export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

/** A completely blank start: every register empty, every stock figure zero. */
export function emptyState(): FlowState {
  return {
    openings: {},
    minLevels: {},
    gateEntries: [],
    grnLines: [],
    qcIntimations: [],
    arRecords: [],
    requisitions: [],
    mrns: [],
    fgTransfers: [],
    pdiRecords: [],
    orders: [],
    dispatchSlips: [],
    indents: [],
    purchaseOrders: [],
    tallyPos: [],
    poClosures: [],
  };
}

/* ── document number series ─────────────────────────────────────────────────── */

export function nextNo(prefix: string, existing: string[], pad: number): string {
  let max = 0;
  for (const id of existing) {
    const m = id.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(pad, "0")}`;
}

/** Every document series: its prefix and zero-padding (GE-0001, GR0001, 26SEV231, …). */
export const SERIES = {
  GE: { prefix: "GE-", pad: 4 },
  GR: { prefix: "GR", pad: 4 },
  QCI: { prefix: "QCI-", pad: 4 },
  AR: { prefix: "AR-", pad: 4 },
  REQ: { prefix: "REQ-", pad: 4 },
  MRN: { prefix: "MRN-", pad: 4 },
  FGT: { prefix: "FGT-", pad: 4 },
  PDI: { prefix: "PDI-", pad: 4 },
  WO: { prefix: "WO-", pad: 4 },
  DPS: { prefix: "DPS-", pad: 4 },
  IND: { prefix: "IND-", pad: 4 },
  PO: { prefix: "26SEV", pad: 3 },
} as const;
export type Series = keyof typeof SERIES;

export function formatNo(series: Series, n: number): string {
  return `${SERIES[series].prefix}${String(n).padStart(SERIES[series].pad, "0")}`;
}

/**
 * The number for a new document. The server allocates it from its sequence table
 * (passed in as `allocated`) — gap-free and safe under concurrent creation; without
 * one (e.g. a plain unit test) it is the next after the highest existing number.
 */
function numberFor(s: FlowState, series: Series, existing: string[]): string {
  return s.allocated?.[series] ?? nextNo(SERIES[series].prefix, existing, SERIES[series].pad);
}

/** The key field of each register's documents. */
export const DOC_KEYS = {
  gateEntries: "id",
  grnLines: "grnNo",
  qcIntimations: "id",
  arRecords: "arNo",
  requisitions: "id",
  mrns: "id",
  fgTransfers: "id",
  pdiRecords: "id",
  orders: "id",
  dispatchSlips: "id",
  indents: "id",
  purchaseOrders: "id",
  tallyPos: "poNo",
  poClosures: "poNo",
} as const;
export type DocCollection = keyof typeof DOC_KEYS;
export const DOC_COLLECTIONS = Object.keys(DOC_KEYS) as DocCollection[];

/**
 * Applies a set of changed documents (from the server) to a state: changed ones are
 * replaced where they stand, new ones appended in the order they were written.
 */
export function mergeChanges(state: FlowState, changes: FlowState): FlowState {
  const out: FlowState = { ...state };
  for (const c of DOC_COLLECTIONS) {
    const incoming = changes[c] as unknown as Record<string, unknown>[];
    if (incoming.length === 0) continue;
    const key = DOC_KEYS[c];
    const byKey = new Map(incoming.map((d) => [String(d[key]), d]));
    const current = state[c] as unknown as Record<string, unknown>[];
    const merged = current.map((d) => {
      const k = String(d[key]);
      const next = byKey.get(k);
      if (next) byKey.delete(k);
      return next ?? d;
    });
    (out[c] as unknown) = [...merged, ...byKey.values()];
  }
  return out;
}

/** "dd-mm-yyyy" → sortable number; unparseable dates sort first. */
export function dateKey(d: string): number {
  const m = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return 0;
  return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
}

export function todayLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export function nowHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/* ── derived stock ──────────────────────────────────────────────────────────── */

export interface PmStockRow {
  /** PMS code; for stock in another unit than pcs, "PMS0003 · Kg" (its own row). */
  code: string;
  /** "" = pcs (issuable to packing); else the PO unit (Kg, Doz …) of that row. */
  unit: string;
  name: string;
  type: string;
  opening: number;
  received: number; // QC-approved GRN qty
  issued: number; // issued to packing
  returned: number; // MRN returns
  closing: number;
  underTest: number;
  hold: number;
  rejected: number;
  minLevel: number | null;
}

export interface FgStockRow {
  productName: string;
  productCode: string;
  batchNo: string;
  received: number;
  dispatched: number;
  inStock: number;
  location: string;
  pdi: "PENDING" | "PASSED" | "FAILED";
}

/**
 * Store stock per component. `components` (from the master) gives every row its
 * name and type, including components with no movement; a code that moves but is
 * not in the list still gets a row, so a guard never under-counts stock.
 */
export function derivePmStock(
  grnLines: GrnLine[],
  requisitions: Requisition[],
  mrns: Mrn[],
  openings: Record<string, number>,
  minLevels: Record<string, number>,
  components: ComponentInfo[] = [],
): Map<string, PmStockRow> {
  const rows = new Map<string, PmStockRow>();
  const unitOf = new Map(components.map((c) => [c.code, c.unit]));
  const row = (code: string, name = code, type = "", unit = unitOf.get(code) ?? ""): PmStockRow => {
    let r = rows.get(code);
    if (!r) {
      const opening = openings[code] ?? 0;
      r = {
        code,
        unit,
        name,
        type,
        opening,
        received: 0,
        issued: 0,
        returned: 0,
        closing: opening,
        underTest: 0,
        hold: 0,
        rejected: 0,
        minLevel: minLevels[code] ?? null,
      };
      rows.set(code, r);
    }
    return r;
  };
  for (const c of components) row(c.code, c.name, c.type);
  for (const code of Object.keys(openings)) row(code);
  for (const g of grnLines) {
    // A receipt in the item's own unit (Kg items in Kg, pcs items in pcs) is its stock.
    // shortcut: a receipt in ANOTHER unit than the item's gets its own side row — convert once Tally's unit
    // conversions are loaded.
    const own = unitOf.get(g.componentCode) ?? "";
    const r = sameUnit(g.unit, own)
      ? row(g.componentCode, g.componentName, g.type)
      : row(`${g.componentCode} · ${g.unit}`, g.componentName, g.type, g.unit);
    if (g.qcStatus === "APPROVED") r.received += g.totalQty;
    else if (g.qcStatus === "UNDER_TEST") r.underTest += g.totalQty;
    else if (g.qcStatus === "HOLD") r.hold += g.totalQty;
    else r.rejected += g.totalQty;
  }
  for (const req of requisitions) {
    for (const line of req.lines) row(line.materialCode, line.materialName).issued += line.qtyIssued ?? 0;
  }
  for (const m of mrns) {
    for (const line of m.lines) row(line.componentCode, line.componentName).returned += line.qty;
  }
  for (const r of rows.values()) r.closing = r.opening + r.received - r.issued + r.returned;
  return rows;
}

export function deriveFgStock(state: {
  fgTransfers: FgTransfer[];
  dispatchSlips: DispatchSlip[];
  pdiRecords: FlowState["pdiRecords"];
}): Map<string, FgStockRow> {
  const rows = new Map<string, FgStockRow>();
  const key = (p: string, b: string) => `${p}::${b}`;
  const ensure = (p: string, code: string, b: string): FgStockRow => {
    const k = key(p, b);
    let r = rows.get(k);
    if (!r) {
      r = {
        productName: p,
        productCode: code,
        batchNo: b,
        received: 0,
        dispatched: 0,
        inStock: 0,
        location: "",
        pdi: "PENDING",
      };
      rows.set(k, r);
    }
    return r;
  };
  for (const t of state.fgTransfers) {
    if (t.status !== "RECEIVED") continue;
    for (const l of t.lines) {
      const r = ensure(l.productName, l.productCode, l.batchNo);
      r.received += l.totalQty;
      if (t.location) r.location = t.location;
    }
  }
  for (const d of state.dispatchSlips) {
    for (const l of d.lines) ensure(l.productName, l.productCode, l.batchNo).dispatched += l.totalQty;
  }
  for (const p of state.pdiRecords) {
    const r = rows.get(key(p.productName, p.batchNo));
    if (r) r.pdi = p.status; // records are appended; the last one wins
  }
  for (const r of rows.values()) r.inStock = r.received - r.dispatched;
  return rows;
}

/* ── purchase + order derivations ───────────────────────────────────────────── */

export interface PoProgress {
  po: PurchaseOrder;
  /** Per-line received (arrived at gate, any QC status) and pending. */
  lines: { code: string; name: string; qty: number; rate: number | null; received: number; pending: number }[];
  value: number | null;
  closed: boolean;
}

export interface OrderProgress {
  order: CustOrder;
  lines: { productName: string; productCode: string; qty: number; dispatched: number; balance: number }[];
  open: boolean;
}

export function deriveOrderProgress(orders: CustOrder[], dispatchSlips: DispatchSlip[]): OrderProgress[] {
  return orders.map((order) => {
    const lines = order.lines.map((l) => {
      const dispatched = dispatchSlips
        .filter((d) => d.orderId === order.id)
        .flatMap((d) => d.lines)
        .filter((x) => x.productName === l.productName)
        .reduce((n, x) => n + x.totalQty, 0);
      return { ...l, dispatched, balance: Math.max(0, l.qty - dispatched) };
    });
    return { order, lines, open: lines.some((l) => l.balance > 0) };
  });
}

/** Tally quantities carry up to 3 decimals (Kg, Grs); sums are rounded back to that. */
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Stock is kept in pieces; "" is a receipt from before Tally POs (always pcs). */
export const isPcs = (unit: string) => unit === "" || unit.toLowerCase() === "pcs";
const sameUnit = (a: string, b: string) => (isPcs(a) && isPcs(b)) || a.toLowerCase() === b.toLowerCase();

/** What Store counted for a gate-checked item, if its GRN exists. */
const grnOf = (grnLines: GrnLine[], gateEntryId: string, lineNo: number) =>
  grnLines.find((g) => g.gateEntryId === gateEntryId && g.gateLineNo === lineNo);

/** One item that has come in against a PO, as the received rule counts it. */
interface Arrival {
  itemName: string;
  itemCode: string;
  qty: number;
}

/**
 * What has come in against a PO. Per gate-checked item: Store's GRN count once the GRN exists, else the
 * quantity checked in at the gate. Gate entries from before item-wise check-in (no items): their GRNs.
 */
function arrivalsFor(poNo: string, gateEntries: GateEntry[], grnLines: GrnLine[]): Arrival[] {
  return gateEntries
    .filter((g) => g.poNo === poNo)
    .flatMap((g): Arrival[] =>
      g.lines.length > 0
        ? g.lines.map((l, i) => ({ itemName: l.itemName, itemCode: l.itemCode, qty: grnOf(grnLines, g.id, i + 1)?.totalQty ?? l.qty }))
        : grnLines
            .filter((r) => r.gateEntryId === g.id)
            .map((r) => ({ itemName: r.componentName, itemCode: r.componentCode, qty: r.totalQty })),
    );
}

/** The same PO item: by PMS code when both sides have one, else by name. */
const sameItem = (a: { itemName: string; itemCode: string }, b: { itemName: string; itemCode: string }) =>
  a.itemCode && b.itemCode ? a.itemCode === b.itemCode : a.itemName === b.itemName;

// shortcut: a Tally item without PMS code is matched by name; renaming it in Tally after a receipt would stop
// that receipt counting — match on Tally's line id once the live Tally API supplies it.
const receivedOf = (arrived: Arrival[], item: { itemName: string; itemCode: string }) =>
  r3(arrived.filter((a) => sameItem(a, item)).reduce((n, a) => n + a.qty, 0));

/**
 * The POs the gate receives against, one per number: POs raised and approved in this app, from the app's own record
 * (Tally's copy of them only confirms they are in Tally), plus POs made in Tally (their synced copy). A PO of ours
 * whose number Tally already gave another PO waits for its new number; that number is Tally's PO meanwhile.
 */
export function gatePos(s: Pick<FlowState, "tallyPos" | "purchaseOrders" | "poClosures">): TallyPo[] {
  const closed = new Set(s.poClosures.filter((c) => c.closed).map((c) => c.poNo));
  const approvedHere = s.purchaseOrders.filter((p) => p.status === "APPROVED" && !numberTaken(p));
  const ours = new Set(approvedHere.map((p) => p.id));
  return [
    ...s.tallyPos.filter((p) => !ours.has(p.poNo)),
    ...approvedHere.map(
      (p): TallyPo => ({
        poNo: p.id,
        date: p.date,
        supplierName: p.supplierName,
        cancelled: false,
        syncedAt: "",
        guid: "",
        alterId: 0,
        lines: p.lines.map((l) => ({ itemName: l.componentName, itemCode: l.componentCode, qty: l.qty, unit: "Pcs" })),
      }),
    ),
  ].map((p) => (closed.has(p.poNo) ? { ...p, closed: true } : p));
}

/**
 * Whether Tally has confirmed a PO raised here, from the latest copy read from Tally (never stored, so it
 * cannot go stale): same PO number with the same items and quantities in Pcs = IN_TALLY.
 */
export function tallyStatusOf(po: PurchaseOrder, tallyPos: TallyPo[]): "NOT_IN_TALLY" | "IN_TALLY" | "DIFFERS" {
  const copy = tallyPos.find((t) => t.poNo === po.id);
  if (!copy) return "NOT_IN_TALLY";
  const same =
    copy.lines.length === po.lines.length &&
    po.lines.every((l) =>
      copy.lines.some(
        (t) => sameItem(t, { itemName: l.componentName, itemCode: l.componentCode }) && isPcs(t.unit) && t.qty === l.qty,
      ),
    );
  return same && !copy.cancelled ? "IN_TALLY" : "DIFFERS";
}

/** How a refusal starts when Tally already has another PO with the number (the screen offers a new number). */
export const NUMBER_TAKEN = "Tally already has a PO numbered";
export const numberTaken = (po: PurchaseOrder) => po.tallyError.startsWith(NUMBER_TAKEN);

export function derivePoProgress(purchaseOrders: PurchaseOrder[], gateEntries: GateEntry[], grnLines: GrnLine[]): PoProgress[] {
  return purchaseOrders.map((po) => {
    const arrived = arrivalsFor(po.id, gateEntries, grnLines);
    const lines = po.lines.map((l) => {
      const received = receivedOf(arrived, { itemName: l.componentName, itemCode: l.componentCode });
      return {
        code: l.componentCode,
        name: l.componentName,
        qty: l.qty,
        rate: l.rate,
        received,
        pending: Math.max(0, r3(l.qty - received)),
      };
    });
    const value = po.lines.every((l) => l.rate !== null)
      ? po.lines.reduce((n, l) => n + l.qty * (l.rate ?? 0), 0)
      : null;
    return {
      po,
      lines,
      value,
      closed: po.status === "APPROVED" && lines.every((l) => l.pending === 0),
    };
  });
}

export interface TallyPoProgress {
  po: TallyPo;
  /** Per item: what has come in at the gate so far, and what is still pending. */
  lines: (TallyPoLine & { received: number; pending: number })[];
  /** Shown at the gate until every item is fully received (and the PO is not cancelled in Tally). */
  open: boolean;
}

/** The PO itself never changes; what it has received follows the one received rule (arrivalsFor). */
export function deriveTallyPoProgress(pos: TallyPo[], gateEntries: GateEntry[], grnLines: GrnLine[]): TallyPoProgress[] {
  return pos.map((po) => {
    const arrived = arrivalsFor(po.poNo, gateEntries, grnLines);
    const lines = po.lines.map((l) => {
      const received = receivedOf(arrived, l);
      return { ...l, received, pending: Math.max(0, r3(l.qty - received)) };
    });
    return { po, lines, open: !po.cancelled && !po.closed && lines.some((l) => l.pending > 0) };
  });
}

/** One gate-checked item (or a whole arrival without PO) that Store has not made a GRN for yet. */
export interface AwaitingGrn {
  gate: GateEntry;
  /** 1-based line of the gate entry; null for an arrival without PO. */
  lineNo: number | null;
  line: GateEntryLine | null;
}

export function awaitingGrn(gateEntries: GateEntry[], grnLines: GrnLine[]): AwaitingGrn[] {
  return gateEntries.flatMap((gate): AwaitingGrn[] =>
    gate.lines.length > 0
      ? gate.lines.map((line, i) => ({ gate, lineNo: i + 1, line })).filter((x) => !grnOf(grnLines, gate.id, x.lineNo))
      : grnLines.some((r) => r.gateEntryId === gate.id)
        ? []
        : [{ gate, lineNo: null, line: null }],
  );
}

/* ── searches (gate and GRN): any part of any field, any case ─────────────────── */

const matches = (term: string, fields: string[]) => {
  const t = term.trim().toLowerCase();
  return !t || fields.some((f) => f.toLowerCase().includes(t));
};

/** Open POs by PO number, supplier, item name or PMS code. */
export function searchPos(pos: TallyPoProgress[], term: string): TallyPoProgress[] {
  return pos.filter((p) => matches(term, [p.po.poNo, p.po.supplierName, ...p.lines.flatMap((l) => [l.itemName, l.itemCode])]));
}

/** Items waiting for GRN by gate entry, PO number, supplier, item name or PMS code. */
export function searchAwaitingGrn(items: AwaitingGrn[], term: string): AwaitingGrn[] {
  return items.filter((w) =>
    matches(term, [w.gate.id, w.gate.poNo, w.gate.supplierName, w.line?.itemName ?? w.gate.productDesc, w.line?.itemCode ?? ""]),
  );
}

/* ── reducers: one per register action ──────────────────────────────────────── */

type Rejected = never;
const reject = (message: string): Rejected => {
  throw new FlowError(message);
};

export const reducers = {
  addGateEntry(s: FlowState, e: Omit<GateEntry, "id">): FlowState {
    let supplierName = e.supplierName;
    let productDesc = e.productDesc;
    let lines: GateEntryLine[] = [];
    if (e.poNo) {
      const progress = deriveTallyPoProgress(
        gatePos(s).filter((p) => p.poNo === e.poNo),
        s.gateEntries,
        s.grnLines,
      )[0];
      if (s.purchaseOrders.some((p) => p.id === e.poNo && p.status !== "APPROVED") && !progress) {
        reject(`PO ${e.poNo} is waiting for the owner's approval — material cannot come in against it yet.`);
      }
      if (!progress) return reject(`PO ${e.poNo} is not among the purchase orders. Search again.`);
      if (progress.po.cancelled) reject(`PO ${e.poNo} is cancelled in Tally.`);
      if (progress.po.closed) reject(`PO ${e.poNo} is closed — Purchase can reopen it if material is still due.`);
      if (!progress.open) reject(`PO ${e.poNo} is already fully received.`);
      if (e.lines.length === 0) reject("Tick at least one item that has arrived.");
      const ticked = new Set<string>();
      // Item name, code and unit are the PO's own — only the quantity and remark come from the gate.
      lines = e.lines.map((l) => {
        const item = progress.lines.find((x) => x.itemName === l.itemName);
        if (!item) return reject(`${l.itemName} is not on PO ${e.poNo}.`);
        if (ticked.has(item.itemName)) reject(`${item.itemName} is ticked twice.`);
        ticked.add(item.itemName);
        // Never more than is still pending on the PO (client's rule: no over-supply is accepted).
        if (l.qty > item.pending) {
          reject(`${item.itemName}: ${l.qty} ${item.unit} is more than the ${item.pending} ${item.unit} still pending on PO ${e.poNo}.`);
        }
        return { itemName: item.itemName, itemCode: item.itemCode, unit: item.unit, qty: l.qty, remark: l.remark };
      });
      // Against a PO the supplier is the PO's — never retyped at the gate.
      supplierName = progress.po.supplierName;
      productDesc = lines.map((l) => l.itemName).join(", ");
    } else {
      if (e.lines.length > 0) reject("Items can only be checked in against a PO.");
      if (!supplierName.trim()) reject("Supplier name is required when there is no PO.");
      if (!productDesc.trim()) reject("Product / material is required when there is no PO.");
    }
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    if (e.invoiceNo && s.gateEntries.some((g) => same(g.invoiceNo, e.invoiceNo) && same(g.supplierName, supplierName))) {
      reject(`Invoice ${e.invoiceNo} from ${supplierName} is already in the gate register.`);
    }
    return {
      ...s,
      gateEntries: [
        ...s.gateEntries,
        {
          ...e,
          supplierName,
          productDesc,
          // Against a PO the quantities are per item, in each item's own unit.
          invoiceQty: e.poNo ? null : e.invoiceQty,
          lines,
          timeOut: "",
          id: numberFor(s, "GE", s.gateEntries.map((x) => x.id)),
        },
      ],
    };
  },

  /** The vehicle leaves after unloading: time out (server clock) and the driver's sign, once. */
  recordVehicleOut(s: FlowState, gateEntryId: string, driverSign: boolean, time: string): FlowState {
    const g = s.gateEntries.find((x) => x.id === gateEntryId);
    if (!g) return reject(`Gate entry ${gateEntryId} not found.`);
    if (g.timeOut) reject(`The vehicle of ${gateEntryId} already left at ${g.timeOut}.`);
    return {
      ...s,
      gateEntries: s.gateEntries.map((x) =>
        x.id === gateEntryId ? { ...x, timeOut: time, driverSign: x.driverSign || driverSign } : x,
      ),
    };
  },

  addGrnLine(s: FlowState, l: Omit<GrnLine, "grnNo" | "qcStatus" | "barcoded">): FlowState {
    const gate = s.gateEntries.find((g) => g.id === l.gateEntryId);
    if (!gate) return reject(`Gate entry ${l.gateEntryId} not found.`);
    let grn = l;
    if (gate.lines.length > 0) {
      // Against a PO: one GRN per gate-checked item, in the PO's unit, never more than came in.
      const item = l.gateLineNo === null ? undefined : gate.lines[l.gateLineNo - 1];
      if (!item) return reject(`Pick the item of ${gate.id} this GRN is for.`);
      if (grnOf(s.grnLines, gate.id, l.gateLineNo!)) reject(`${item.itemName} of ${gate.id} already has a GRN.`);
      if (item.itemCode && item.itemCode !== l.componentCode) {
        reject(`${item.itemName} is ${item.itemCode} — the GRN must use that code.`);
      }
      if (l.totalQty > item.qty) {
        reject(`${item.itemName}: ${l.totalQty} ${item.unit} counted is more than the ${item.qty} ${item.unit} checked in at the gate.`);
      }
      const poLine = gatePos(s).find((p) => p.poNo === gate.poNo)?.lines.find((x) => sameItem(x, item));
      grn = { ...l, unit: item.unit, poQty: poLine?.qty ?? null };
    } else if (l.gateLineNo !== null) {
      reject(`${gate.id} has no PO items — it was an arrival without PO.`);
    } else {
      grn = { ...l, unit: "" }; // arrival without PO: counted in pcs, as on the GRN sheet
    }
    if (l.totalQty <= 0) reject("The counted quantity must be more than zero.");
    return {
      ...s,
      grnLines: [
        ...s.grnLines,
        {
          ...grn,
          grnNo: numberFor(s, "GR", s.grnLines.map((x) => x.grnNo)),
          qcStatus: "UNDER_TEST" as const,
          barcoded: false,
        },
      ],
    };
  },

  updateGrnQty(s: FlowState, grnNo: string, totalQty: number): FlowState {
    const g = s.grnLines.find((x) => x.grnNo === grnNo);
    if (!g) return reject(`GRN ${grnNo} not found.`);
    const qty = Math.max(0, isPcs(g.unit) ? Math.round(totalQty) : r3(totalQty));
    const item = g.gateLineNo === null ? undefined : s.gateEntries.find((x) => x.id === g.gateEntryId)?.lines[g.gateLineNo - 1];
    if (item && qty > item.qty) reject(`${item.itemName}: ${qty} ${item.unit} is more than the ${item.qty} ${item.unit} checked in at the gate.`);
    // The count can be corrected only until the GRN goes to QC: from then on QC tests
    // exactly what the slip says, and nothing upstream of a passed stage may change.
    if (s.qcIntimations.some((q) => q.grnNo === grnNo) || g.qcStatus !== "UNDER_TEST") {
      return reject(`GRN ${grnNo} has been sent to QC — its quantity is locked.`);
    }
    return {
      ...s,
      grnLines: s.grnLines.map((x) => (x.grnNo === grnNo ? { ...x, totalQty: qty } : x)),
      qcIntimations: s.qcIntimations.map((q) => (q.grnNo === grnNo ? { ...q, totalQty: qty } : q)),
    };
  },

  sendToQc(
    s: FlowState,
    grnNo: string,
    extra: { batchNo: string; mfgDate: string; expiryDate: string },
  ): FlowState {
    const g = s.grnLines.find((x) => x.grnNo === grnNo);
    if (!g) return reject(`GRN ${grnNo} not found.`);
    if (s.qcIntimations.some((q) => q.grnNo === grnNo)) reject(`GRN ${grnNo} is already with QC.`);
    return {
      ...s,
      qcIntimations: [
        ...s.qcIntimations,
        {
          id: numberFor(s, "QCI", s.qcIntimations.map((x) => x.id)),
          date: g.receivedDate,
          timeOfIssue: nowHHMM(),
          grnNo,
          productName: g.componentName,
          code: g.componentCode,
          supplierName: g.supplierName,
          invoiceNo: g.invoiceNo,
          batchNo: extra.batchNo,
          mfgDate: extra.mfgDate,
          expiryDate: extra.expiryDate,
          totalQty: g.totalQty,
          totalBox: g.totalBoxes,
          remark: "",
        },
      ],
    };
  },

  recordAr(
    s: FlowState,
    intimationId: string,
    status: Exclude<QcStatus, "UNDER_TEST">,
    remark: string,
  ): FlowState {
    const qci = s.qcIntimations.find((x) => x.id === intimationId);
    if (!qci) return reject(`QC intimation ${intimationId} not found.`);
    const current = s.grnLines.find((g) => g.grnNo === qci.grnNo)?.qcStatus;
    if (current === "APPROVED" || current === "REJECTED") {
      reject(`${qci.grnNo} already has a final QC decision (${current}).`);
    }
    // A held item is re-tested once more and then decided — it cannot be held again.
    if (current === "HOLD" && status === "HOLD") reject(`${qci.grnNo} is already on hold — approve or reject it.`);
    return {
      ...s,
      // History is kept: a re-test APPENDS a new A.R. record.
      arRecords: [
        ...s.arRecords,
        {
          arNo: numberFor(s, "AR", s.arRecords.map((x) => x.arNo)),
          intimationId,
          date: todayLabel(),
          status,
          remark,
        },
      ],
      grnLines: s.grnLines.map((g) => (g.grnNo === qci.grnNo ? { ...g, qcStatus: status } : g)),
    };
  },

  setBarcoded(s: FlowState, grnNo: string, on: boolean): FlowState {
    const g = s.grnLines.find((x) => x.grnNo === grnNo);
    if (!g) return reject(`GRN ${grnNo} not found.`);
    if (g.qcStatus !== "APPROVED") reject("Only QC-approved material gets a barcode sticker.");
    // Recording that the sticker is on is final — it cannot be "un-pasted".
    if (g.barcoded && !on) reject(`The barcode on ${grnNo} is already recorded as pasted.`);
    if (g.barcoded === on) return s;
    return {
      ...s,
      grnLines: s.grnLines.map((x) => (x.grnNo === grnNo ? { ...x, barcoded: on } : x)),
    };
  },

  addRequisition(s: FlowState, r: Omit<Requisition, "id" | "status">): FlowState {
    if (r.lines.length === 0) reject("A requisition needs at least one material line.");
    return {
      ...s,
      requisitions: [
        ...s.requisitions,
        { ...r, id: numberFor(s, "REQ", s.requisitions.map((x) => x.id)), status: "PENDING" as const },
      ],
    };
  },

  issueRequisition(s: FlowState, id: string, issued: number[], storeSign: string): FlowState {
    const req = s.requisitions.find((r) => r.id === id);
    if (!req) return reject(`Requisition ${id} not found.`);
    if (req.status === "ISSUED") reject(`Requisition ${id} is already issued.`);
    // Guard: never issue more than the closing stock at this moment.
    const stock = derivePmStock(s.grnLines, s.requisitions, s.mrns, s.openings, s.minLevels);
    const available = new Map<string, number>();
    const clamped = req.lines.map((l, i) => {
      const avail =
        available.get(l.materialCode) ?? Math.max(0, stock.get(l.materialCode)?.closing ?? 0);
      const want = Math.max(0, Math.round(issued[i] ?? l.qtyRequired));
      const give = Math.min(want, avail);
      available.set(l.materialCode, avail - give);
      return give;
    });
    return {
      ...s,
      requisitions: s.requisitions.map((r) =>
        r.id === id
          ? {
              ...r,
              status: "ISSUED" as const,
              storeSign,
              lines: r.lines.map((l, i) => ({ ...l, qtyIssued: clamped[i] })),
            }
          : r,
      ),
    };
  },

  addMrn(s: FlowState, m: Omit<Mrn, "id">): FlowState {
    // A return can never exceed what was issued (minus earlier returns).
    const req = s.requisitions.find((r) => r.id === m.requisitionId);
    if (!req) return reject(`Requisition ${m.requisitionId} not found.`);
    if (req.status !== "ISSUED") reject(`Requisition ${req.id} has not been issued yet.`);
    const returnedSoFar = new Map<string, number>();
    for (const prev of s.mrns.filter((x) => x.requisitionId === m.requisitionId)) {
      for (const l of prev.lines) {
        returnedSoFar.set(l.componentCode, (returnedSoFar.get(l.componentCode) ?? 0) + l.qty);
      }
    }
    const lines = m.lines
      .map((l) => {
        const issuedQty = req.lines.find((x) => x.materialCode === l.componentCode)?.qtyIssued ?? 0;
        const max = Math.max(0, issuedQty - (returnedSoFar.get(l.componentCode) ?? 0));
        return { ...l, qty: Math.min(Math.max(0, Math.round(l.qty)), max) };
      })
      .filter((l) => l.qty > 0);
    if (lines.length === 0) reject("Nothing to return — quantities exceed what is left of the issue.");
    return {
      ...s,
      mrns: [...s.mrns, { ...m, lines, id: numberFor(s, "MRN", s.mrns.map((x) => x.id)) }],
    };
  },

  addFgTransfer(s: FlowState, t: Omit<FgTransfer, "id" | "status" | "receivedDate">): FlowState {
    return {
      ...s,
      fgTransfers: [
        ...s.fgTransfers,
        {
          ...t,
          id: numberFor(s, "FGT", s.fgTransfers.map((x) => x.id)),
          status: "IN_TRANSIT" as const,
          receivedDate: "",
        },
      ],
    };
  },

  receiveFgTransfer(s: FlowState, id: string, checkedBy: string, date: string, location: string): FlowState {
    const t = s.fgTransfers.find((x) => x.id === id);
    if (!t) return reject(`FG transfer ${id} not found.`);
    if (t.status === "RECEIVED") reject(`FG transfer ${id} is already received.`);
    return {
      ...s,
      fgTransfers: s.fgTransfers.map((x) =>
        x.id === id ? { ...x, status: "RECEIVED" as const, checkedBy, receivedDate: date, location } : x,
      ),
    };
  },

  recordPdi(
    s: FlowState,
    productName: string,
    batchNo: string,
    status: "PASSED" | "FAILED",
    remark: string,
  ): FlowState {
    const stock = deriveFgStock(s);
    if (!stock.has(`${productName}::${batchNo}`)) reject(`Batch ${batchNo} is not in FG stock.`);
    return {
      ...s,
      pdiRecords: [
        ...s.pdiRecords,
        {
          id: numberFor(s, "PDI", s.pdiRecords.map((x) => x.id)),
          date: todayLabel(),
          productName,
          batchNo,
          status,
          remark,
        },
      ],
    };
  },

  addOrder(s: FlowState, o: Omit<CustOrder, "id">): FlowState {
    return {
      ...s,
      orders: [...s.orders, { ...o, id: numberFor(s, "WO", s.orders.map((x) => x.id)) }],
    };
  },

  addDispatch(
    s: FlowState,
    d: Omit<DispatchSlip, "id" | "invoiceNo" | "invoiceDate" | "gateOut" | "gateOutTime" | "securitySign">,
  ): FlowState {
    if (d.orderId && !s.orders.some((o) => o.id === d.orderId)) reject(`Order ${d.orderId} not found.`);
    const stock = deriveFgStock(s);
    const drawn = new Map<string, number>();
    for (const l of d.lines) {
      const k = `${l.productName}::${l.batchNo}`;
      const row = stock.get(k);
      // Guards: covered by RECEIVED FG stock, and the batch has PASSED PDI.
      const inStock = (row?.inStock ?? 0) - (drawn.get(k) ?? 0);
      if (!row) reject(`Batch ${l.batchNo} is not in FG stock.`);
      if (row!.pdi !== "PASSED") reject(`Batch ${l.batchNo} has not passed PDI.`);
      if (l.totalQty <= 0) reject("Dispatch quantity must be more than zero.");
      if (l.totalQty > inStock) reject(`Only ${inStock} pcs of batch ${l.batchNo} in stock.`);
      drawn.set(k, (drawn.get(k) ?? 0) + l.totalQty);
    }
    return {
      ...s,
      dispatchSlips: [
        ...s.dispatchSlips,
        {
          ...d,
          id: numberFor(s, "DPS", s.dispatchSlips.map((x) => x.id)),
          invoiceNo: "",
          invoiceDate: "",
          securitySign: "",
          gateOut: false,
          gateOutTime: "",
        },
      ],
    };
  },

  addInvoice(s: FlowState, dispatchId: string, invoiceNo: string, date: string): FlowState {
    const d = s.dispatchSlips.find((x) => x.id === dispatchId);
    if (!d) return reject(`Dispatch ${dispatchId} not found.`);
    if (d.invoiceNo) reject(`Dispatch ${dispatchId} already has invoice ${d.invoiceNo}.`);
    return {
      ...s,
      dispatchSlips: s.dispatchSlips.map((x) =>
        x.id === dispatchId ? { ...x, invoiceNo, invoiceDate: date } : x,
      ),
    };
  },

  gateOut(s: FlowState, dispatchId: string, securitySign: string, time: string): FlowState {
    const d = s.dispatchSlips.find((x) => x.id === dispatchId);
    if (!d) return reject(`Dispatch ${dispatchId} not found.`);
    if (!d.invoiceNo) reject("Gate out needs the invoice first.");
    if (d.gateOut) reject(`Dispatch ${dispatchId} has already left the gate.`);
    return {
      ...s,
      dispatchSlips: s.dispatchSlips.map((x) =>
        x.id === dispatchId ? { ...x, gateOut: true, securitySign, gateOutTime: time } : x,
      ),
    };
  },

  addIndent(s: FlowState, i: Omit<Indent, "id" | "status">): FlowState {
    return {
      ...s,
      indents: [
        ...s.indents,
        { ...i, id: numberFor(s, "IND", s.indents.map((x) => x.id)), status: "OPEN" as const },
      ],
    };
  },

  raisePo(s: FlowState, p: Omit<PurchaseOrder, "id" | "status" | "approvedBy" | "tallyPushedAt" | "tallyError">): FlowState {
    if (p.indentIds.length === 0) reject("Tick at least one indent for the PO.");
    // One PO gathers open indents of ONE vendor; each item is one PO line.
    const inds = p.indentIds.map((id) => {
      const ind = s.indents.find((i) => i.id === id);
      if (!ind) return reject(`Indent ${id} not found.`);
      if (ind.status !== "OPEN") reject(`Indent ${id} already has a PO.`);
      if (ind.supplierName && ind.supplierName !== p.supplierName) {
        reject(`Indent ${id} is for ${ind.supplierName}, not ${p.supplierName}.`);
      }
      return ind;
    });
    const codes = p.lines.map((l) => l.componentCode);
    if (new Set(codes).size !== codes.length) reject("Each item can be on the PO only once — combine its indents into one line.");
    for (const ind of inds) {
      if (!codes.includes(ind.componentCode)) reject(`${ind.componentName} (indent ${ind.id}) is not on the PO.`);
    }
    for (const l of p.lines) {
      if (!inds.some((i) => i.componentCode === l.componentCode)) reject(`${l.componentName} has no ticked indent.`);
    }
    return {
      ...s,
      purchaseOrders: [
        ...s.purchaseOrders,
        {
          ...p,
          id: numberFor(s, "PO", [...s.purchaseOrders.map((x) => x.id), ...s.gateEntries.map((g) => g.poNo)]),
          status: "PENDING_APPROVAL" as const,
          approvedBy: "",
          tallyPushedAt: "",
          tallyError: "",
        },
      ],
      indents: s.indents.map((i) => (p.indentIds.includes(i.id) ? { ...i, status: "PO_RAISED" as const } : i)),
    };
  },

  /** Purchase marks a PO closed (e.g. received before go-live, vendor won't supply the balance). */
  closePo(s: FlowState, poNo: string, reason: string, date: string, by: string): FlowState {
    if (!gatePos(s).some((p) => p.poNo === poNo)) reject(`PO ${poNo} not found (or not approved yet).`);
    if (!reason.trim()) reject("Give a reason for closing the PO.");
    const prev = s.poClosures.find((c) => c.poNo === poNo);
    if (prev?.closed) reject(`PO ${poNo} is already closed.`);
    const closure: PoClosure = { poNo, closed: true, date, by, reason: reason.trim() };
    return {
      ...s,
      poClosures: prev ? s.poClosures.map((c) => (c.poNo === poNo ? closure : c)) : [...s.poClosures, closure],
    };
  },

  reopenPo(s: FlowState, poNo: string, date: string, by: string): FlowState {
    const prev = s.poClosures.find((c) => c.poNo === poNo);
    if (!prev?.closed) return reject(`PO ${poNo} is not closed.`);
    return {
      ...s,
      poClosures: s.poClosures.map((c) => (c.poNo === poNo ? { ...c, closed: false, date, by, reason: "reopened" } : c)),
    };
  },

  /**
   * Go-live cut-over: every PO dated before `before` that has nothing received in this app is closed —
   * Tally cannot tell which old POs were received (most purchase invoices don't name their PO).
   */
  closePosBefore(s: FlowState, before: string, reason: string, date: string, by: string): FlowState {
    if (!reason.trim()) reject("Give a reason for the cut-over.");
    const already = new Set(s.poClosures.filter((c) => c.closed).map((c) => c.poNo));
    const toClose = gatePos(s).filter(
      (p) =>
        dateKey(p.date) < dateKey(before) &&
        !p.cancelled &&
        !already.has(p.poNo) &&
        arrivalsFor(p.poNo, s.gateEntries, s.grnLines).length === 0,
    );
    if (toClose.length === 0) reject(`No open PO dated before ${before} without receipts.`);
    let next = s.poClosures;
    for (const p of toClose) {
      const closure: PoClosure = { poNo: p.poNo, closed: true, date, by, reason: reason.trim() };
      next = next.some((c) => c.poNo === p.poNo) ? next.map((c) => (c.poNo === p.poNo ? closure : c)) : [...next, closure];
    }
    return { ...s, poClosures: next };
  },

  approvePo(s: FlowState, poId: string, approvedBy: string): FlowState {
    const po = s.purchaseOrders.find((p) => p.id === poId);
    if (!po) return reject(`PO ${poId} not found.`);
    if (po.status === "APPROVED") reject(`PO ${poId} is already approved.`);
    return {
      ...s,
      purchaseOrders: s.purchaseOrders.map((p) =>
        p.id === poId ? { ...p, status: "APPROVED" as const, approvedBy } : p,
      ),
    };
  },
};

export type Reducers = typeof reducers;
export type ActionName = keyof Reducers;
/** The input of an action — the reducer's parameters after the state. */
export type ActionArgs<K extends ActionName> = Reducers[K] extends (s: FlowState, ...args: infer A) => FlowState
  ? A
  : never;

/* ── traceability ───────────────────────────────────────────────────────────── */

/** One event in a document trail, ordered by stage. */
export interface TraceEvent {
  stage: number;
  role: string;
  doc: string;
  title: string;
  detail: string;
  date: string;
  tab: TabId;
}

export function traceGrn(state: FlowState, grnNo: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  const g = state.grnLines.find((x) => x.grnNo === grnNo);
  if (!g) return out;
  const po = state.purchaseOrders.find((p) => p.id === g.poNo);
  if (po) {
    out.push({
      stage: 0,
      role: "PURCHASE",
      doc: po.id,
      title: "Purchase order",
      detail: `${po.supplierName} · ${po.status === "APPROVED" ? `approved by ${po.approvedBy}` : "pending approval"}`,
      date: po.date,
      tab: "purchase",
    });
  }
  const ge = state.gateEntries.find((x) => x.id === g.gateEntryId);
  if (ge) {
    out.push({
      stage: 2,
      role: "SECURITY",
      doc: ge.id,
      title: "Gate entry",
      detail: `${ge.supplierName} · ${ge.vehicleNo || "—"} · in ${ge.timeIn || "—"}`,
      date: ge.date,
      tab: "gate",
    });
  }
  out.push({
    stage: 4,
    role: "STORE",
    doc: g.grnNo,
    title: "GRN created",
    detail: `${g.componentName} · ${g.totalQty.toLocaleString("en-IN")} pcs${g.location ? ` · ${g.location}` : ""}`,
    date: g.receivedDate,
    tab: "grn",
  });
  const qci = state.qcIntimations.find((x) => x.grnNo === grnNo);
  if (qci) {
    out.push({
      stage: 6,
      role: "STORE → QC",
      doc: qci.id,
      title: "QC intimation",
      detail: `Batch ${qci.batchNo || "—"} · ${qci.totalQty.toLocaleString("en-IN")} pcs`,
      date: qci.date,
      tab: "qc",
    });
    for (const ar of state.arRecords.filter((x) => x.intimationId === qci.id)) {
      out.push({
        stage: 8,
        role: "QC",
        doc: ar.arNo,
        title: `QC decision — ${ar.status}`,
        detail: ar.remark || "Parameters checked",
        date: ar.date,
        tab: "qc",
      });
    }
  }
  if (g.barcoded) {
    out.push({
      stage: 10,
      role: "STORE",
      doc: g.grnNo,
      title: "Barcode sticker pasted",
      detail: "Approved material labelled",
      date: g.receivedDate,
      tab: "grn",
    });
  }
  if (g.qcStatus === "APPROVED") {
    for (const req of state.requisitions) {
      if (dateKey(req.date) < dateKey(g.receivedDate)) continue;
      for (const l of req.lines) {
        if (l.materialCode === g.componentCode && l.qtyIssued) {
          out.push({
            stage: 12,
            role: "STORE → PACKING",
            doc: req.id,
            title: "Component issued to packing",
            detail: `${l.qtyIssued.toLocaleString("en-IN")} pcs · dept ${req.department} (issues draw on all approved lots)`,
            date: req.date,
            tab: "requisition",
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.stage - b.stage);
}

export function traceBatch(state: FlowState, batchNo: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const req of state.requisitions) {
    if (req.batchNo !== batchNo) continue;
    out.push({
      stage: 11,
      role: "PRODUCTION",
      doc: req.id,
      title: "Requisition slip",
      detail: `${req.lines.length} materials · dept ${req.department}`,
      date: req.date,
      tab: "requisition",
    });
    if (req.status === "ISSUED") {
      out.push({
        stage: 12,
        role: "STORE → PACKING",
        doc: req.id,
        title: "Material issued",
        detail: req.lines
          .map((l) => `${l.materialCode} × ${(l.qtyIssued ?? 0).toLocaleString("en-IN")}`)
          .join(" · "),
        date: req.date,
        tab: "requisition",
      });
    }
    for (const m of state.mrns.filter((x) => x.requisitionId === req.id)) {
      out.push({
        stage: 13,
        role: "PACKING → STORE",
        doc: m.id,
        title: "Material returned (MRN)",
        detail: m.lines.map((l) => `${l.componentCode} × ${l.qty.toLocaleString("en-IN")}`).join(" · "),
        date: m.date,
        tab: "requisition",
      });
    }
  }
  for (const t of state.fgTransfers) {
    for (const l of t.lines) {
      if (l.batchNo !== batchNo) continue;
      out.push({
        stage: 15,
        role: "PRODUCTION → FG WH",
        doc: t.id,
        title: "FG transfer note",
        detail: `${l.totalQty.toLocaleString("en-IN")} pcs (${l.totalBoxes} boxes + ${l.looseQty} loose)`,
        date: t.date,
        tab: "fg",
      });
      if (t.status === "RECEIVED") {
        out.push({
          stage: 16,
          role: "FG WAREHOUSE",
          doc: t.id,
          title: "FG receiving signed",
          detail: t.checkedBy || "Received",
          date: t.receivedDate,
          tab: "fg",
        });
        out.push({
          stage: 17,
          role: "FG WAREHOUSE",
          doc: t.id,
          title: "In FG stock",
          detail: `Batch ${l.batchNo}${t.location ? ` · ${t.location}` : ""}`,
          date: t.receivedDate,
          tab: "fg",
        });
      }
    }
  }
  for (const p of state.pdiRecords.filter((x) => x.batchNo === batchNo)) {
    out.push({
      stage: 18,
      role: "QC",
      doc: p.id,
      title: `PDI — ${p.status}`,
      detail: p.remark || "Pre-dispatch inspection",
      date: p.date,
      tab: "qc",
    });
  }
  for (const d of state.dispatchSlips) {
    for (const l of d.lines) {
      if (l.batchNo !== batchNo) continue;
      out.push({
        stage: 19,
        role: "FG WAREHOUSE",
        doc: d.id,
        title: `Dispatch — ${d.partyName}`,
        detail: `${l.totalQty.toLocaleString("en-IN")} pcs · ${l.totalBoxes} boxes${d.orderId ? ` · against ${d.orderId}` : ""}`,
        date: d.date,
        tab: "dispatch",
      });
      if (d.invoiceNo) {
        out.push({
          stage: 20,
          role: "ACCOUNTS",
          doc: d.invoiceNo,
          title: "Invoice prepared",
          detail: d.partyName,
          date: d.invoiceDate,
          tab: "dispatch",
        });
      }
      if (d.gateOut) {
        out.push({
          stage: 22,
          role: "SECURITY",
          doc: d.id,
          title: "Gate out — dispatch complete",
          detail: `Security: ${d.securitySign || "—"} · ${d.gateOutTime}`,
          date: d.date,
          tab: "dispatch",
        });
      }
    }
  }
  return out.sort((a, b) => a.stage - b.stage);
}
