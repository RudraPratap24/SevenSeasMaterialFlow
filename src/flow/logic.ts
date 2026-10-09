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
  GrnLine,
  Indent,
  Mrn,
  PurchaseOrder,
  QcStatus,
  Requisition,
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
  code: string;
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
  const row = (code: string, name = code, type = ""): PmStockRow => {
    let r = rows.get(code);
    if (!r) {
      const opening = openings[code] ?? 0;
      r = {
        code,
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
    const r = row(g.componentCode, g.componentName, g.type);
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

export function derivePoProgress(purchaseOrders: PurchaseOrder[], grnLines: GrnLine[]): PoProgress[] {
  return purchaseOrders.map((po) => {
    const lines = po.lines.map((l) => {
      const received = grnLines
        .filter((g) => g.poNo === po.id && g.componentCode === l.componentCode)
        .reduce((n, g) => n + g.totalQty, 0);
      return {
        code: l.componentCode,
        name: l.componentName,
        qty: l.qty,
        rate: l.rate,
        received,
        pending: Math.max(0, l.qty - received),
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

/* ── reducers: one per register action ──────────────────────────────────────── */

type Rejected = never;
const reject = (message: string): Rejected => {
  throw new FlowError(message);
};

export const reducers = {
  addGateEntry(s: FlowState, e: Omit<GateEntry, "id">): FlowState {
    return {
      ...s,
      gateEntries: [...s.gateEntries, { ...e, id: numberFor(s, "GE", s.gateEntries.map((x) => x.id)) }],
    };
  },

  addGrnLine(s: FlowState, l: Omit<GrnLine, "grnNo" | "qcStatus" | "barcoded">): FlowState {
    if (!s.gateEntries.some((g) => g.id === l.gateEntryId)) reject(`Gate entry ${l.gateEntryId} not found.`);
    return {
      ...s,
      grnLines: [
        ...s.grnLines,
        {
          ...l,
          grnNo: numberFor(s, "GR", s.grnLines.map((x) => x.grnNo)),
          qcStatus: "UNDER_TEST" as const,
          barcoded: false,
        },
      ],
    };
  },

  updateGrnQty(s: FlowState, grnNo: string, totalQty: number): FlowState {
    const qty = Math.max(0, Math.round(totalQty));
    const g = s.grnLines.find((x) => x.grnNo === grnNo);
    if (!g) return reject(`GRN ${grnNo} not found.`);
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

  raisePo(s: FlowState, p: Omit<PurchaseOrder, "id" | "status" | "approvedBy">): FlowState {
    for (const id of p.indentIds) {
      const ind = s.indents.find((i) => i.id === id);
      if (!ind) reject(`Indent ${id} not found.`);
      if (ind!.status !== "OPEN") reject(`Indent ${id} already has a PO.`);
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
        },
      ],
      indents: s.indents.map((i) => (p.indentIds.includes(i.id) ? { ...i, status: "PO_RAISED" as const } : i)),
    };
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
