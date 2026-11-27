/**
 * For each action: what it must lock, what it must check for conflicts, and what
 * slice of the registers its business rule needs — so an action reads a handful of
 * rows through indexes instead of the whole database, and only actions that touch
 * the same documents or the same stock ever wait for each other.
 *
 *   targets  documents the action changes. Locked, and refused if someone changed
 *            them after the user's screen was built (stale-screen guard).
 *   locks    shared resources its rule depends on: stock of a component (issues),
 *            FG stock of a batch (dispatch, PDI).
 *   slice    the data the rule and the server-side preparation read.
 *   series   the document number series it creates in.
 */
import type { RowDataPacket } from "mysql2/promise";
import { FlowError, type ActionName, type DocCollection, type Series } from "../../src/flow/logic";
import type { Queryable } from "./db";
import { toSqlDate, type Slice } from "./repository";

export interface Plan {
  targets: { c: DocCollection; key: string }[];
  locks: string[];
  slice: Exclude<Slice, "all">;
  series?: Series;
}

type Planner = (args: unknown[], db: Queryable) => Promise<Plan>;

const eq = (col: string, v: unknown) => ({ sql: `h.${col} = ?`, params: [v] });
const none = { sql: "0 = 1", params: [] as unknown[] };

async function col(db: Queryable, sql: string, params: unknown[]): Promise<string[]> {
  const [r] = await db.query<RowDataPacket[]>(sql, params);
  return r.map((x) => String(Object.values(x)[0]));
}

/** Everything the store-stock rule needs for these components. */
export function stockSlice(codes: string[]): Exclude<Slice, "all"> {
  if (codes.length === 0) return {};
  return {
    stockCodes: codes,
    grnLines: { sql: "h.component_code IN (?)", params: [codes] },
    requisitions: { sql: "h.req_no IN (SELECT req_no FROM requisition_lines WHERE component_code IN (?))", params: [codes] },
    mrns: { sql: "h.mrn_no IN (SELECT mrn_no FROM material_return_lines WHERE component_code IN (?))", params: [codes] },
    bomIssues: { sql: "h.bom_no IN (SELECT bom_no FROM bom_issue_lines WHERE component_code IN (?))", params: [codes] },
  };
}

/** Everything the FG-stock rule (received − dispatched, latest PDI) needs for these batches. */
async function batchSlice(db: Queryable, batches: { productName: string; batchNo: string }[]) {
  const ids: string[] = [];
  for (const b of batches) {
    ids.push(
      ...(await col(
        db,
        "SELECT b.id FROM production_batches b JOIN products p ON p.id = b.product_id WHERE p.name = ? AND b.batch_no = ?",
        [b.productName, b.batchNo],
      )),
    );
  }
  if (ids.length === 0) return { fgTransfers: none, dispatchSlips: none, pdiRecords: none };
  return {
    fgTransfers: { sql: "h.transfer_no IN (SELECT transfer_no FROM fg_transfer_lines WHERE batch_id IN (?))", params: [ids] },
    dispatchSlips: { sql: "h.dispatch_no IN (SELECT dispatch_no FROM dispatch_lines WHERE batch_id IN (?))", params: [ids] },
    pdiRecords: { sql: "h.batch_id IN (?)", params: [ids] },
  };
}

const batchLock = (productName: string, batchNo: string) => `batch:${productName}::${batchNo}`;

/** A GRN with its QC slip — the pair QC and Store both act on. */
const grnPlan = (grnNo: string): Plan => ({
  targets: [{ c: "grnLines", key: grnNo }],
  locks: [],
  slice: { grnLines: eq("grn_no", grnNo), qcIntimations: eq("grn_no", grnNo) },
});

export const PLANS: Record<ActionName, Planner> = {
  addGateEntry: async ([e]) => {
    const { invoiceNo } = e as { invoiceNo: string };
    return {
      targets: [],
      // One invoice entered twice at once is checked one after the other.
      locks: invoiceNo ? [`gate-invoice:${invoiceNo.toLowerCase()}`] : [],
      slice: { gateEntries: invoiceNo ? { sql: "h.invoice_no = ?", params: [invoiceNo] } : none },
      series: "GE",
    };
  },

  recordVehicleOut: async ([id]) => ({
    targets: [{ c: "gateEntries", key: String(id) }],
    locks: [],
    slice: { gateEntries: eq("gate_entry_no", id) },
  }),

  addGrnLine: async ([l]) => {
    const { gateEntryId, poNo } = l as { gateEntryId: string; poNo: string };
    // the PO of the GRN: Store's pick, or (older gate entries) the one the gate named
    const po = "COALESCE(NULLIF(?, ''), (SELECT COALESCE(po_no, tally_po_no) FROM gate_entries WHERE gate_entry_no = ?))";
    return {
      targets: [],
      // Two clerks counting against the same PO (or the same gate-checked item): the second one sees the first.
      locks: [`gate-grn:${gateEntryId}`, ...(poNo ? [`po-grn:${poNo}`] : [])],
      slice: {
        // the gate entry, and everything already received against the PO (pending = ordered − received)
        gateEntries: { sql: `h.gate_entry_no = ? OR h.po_no = ${po} OR h.tally_po_no = ${po}`, params: [gateEntryId, poNo, gateEntryId, poNo, gateEntryId] },
        grnLines: {
          sql: `h.gate_entry_no = ? OR h.po_no = ${po} OR h.tally_po_no = ${po} OR g.po_no = ${po} OR g.tally_po_no = ${po}`,
          params: [gateEntryId, poNo, gateEntryId, poNo, gateEntryId, poNo, gateEntryId, poNo, gateEntryId],
        },
        tallyPos: { sql: `h.po_no = ${po}`, params: [poNo, gateEntryId] },
        purchaseOrders: { sql: `h.po_no = ${po}`, params: [poNo, gateEntryId] },
        poClosures: { sql: `h.po_no = ${po}`, params: [poNo, gateEntryId] },
      },
      series: "GR",
    };
  },

  updateGrnQty: async ([grnNo]) => {
    const p = grnPlan(String(grnNo));
    // The gate-checked quantity caps the count.
    const gate = { sql: "h.gate_entry_no = (SELECT gate_entry_no FROM goods_receipts WHERE grn_no = ?)", params: [grnNo] };
    return { ...p, slice: { ...p.slice, gateEntries: gate } };
  },
  setBarcoded: async ([grnNo]) => grnPlan(String(grnNo)),
  closeEscalation: async ([grnNo]) => ({
    targets: [],
    locks: [`escalation:${String(grnNo)}`],
    slice: { grnLines: eq("grn_no", grnNo), escalationClosures: eq("grn_no", grnNo) },
  }),
  escalationDebitNote: async ([d]) => {
    const grnNo = (d as { grnNo: string }).grnNo;
    return {
      targets: [],
      locks: [`escalation:${grnNo}`, `debit-note:${grnNo}`],
      slice: { grnLines: eq("grn_no", grnNo), escalationClosures: eq("grn_no", grnNo), debitNotes: eq("grn_no", grnNo) },
      series: "DN",
    };
  },
  escalationIndent: async ([d]) => {
    const grnNo = (d as { grnNo: string }).grnNo;
    return { targets: [], locks: [`escalation:${grnNo}`], slice: { grnLines: eq("grn_no", grnNo), escalationClosures: eq("grn_no", grnNo) }, series: "IND" };
  },
  addDebitNote: async ([d]) => {
    const grnNo = (d as { grnNo: string }).grnNo;
    const p = grnPlan(grnNo);
    return {
      ...p,
      targets: [],
      // one debit note per GRN, even when two screens raise it at once
      locks: [`debit-note:${grnNo}`],
      slice: {
        ...p.slice,
        arRecords: { sql: "h.intimation_no IN (SELECT intimation_no FROM qc_intimations WHERE grn_no = ?)", params: [grnNo] },
        debitNotes: eq("grn_no", grnNo),
      },
      series: "DN",
    };
  },
  sendToQc: async ([grnNo]) => ({ ...grnPlan(String(grnNo)), series: "QCI" }),

  recordAr: async ([intimationId], db) => {
    const [grnNo] = await col(db, "SELECT grn_no FROM qc_intimations WHERE intimation_no = ?", [intimationId]);
    return {
      // QC decides on what the slip and its GRN say — both must still be as QC saw them.
      targets: [{ c: "qcIntimations", key: String(intimationId) }, ...(grnNo ? [{ c: "grnLines" as const, key: grnNo }] : [])],
      locks: [],
      slice: grnNo ? { grnLines: eq("grn_no", grnNo), qcIntimations: eq("grn_no", grnNo) } : {},
      series: "AR",
    };
  },

  addRequisition: async () => ({ targets: [], locks: [], slice: {}, series: "REQ" }),

  issueRequisition: async ([id], db) => {
    // A requisition's lines never change after it is written, so they can be read before locking.
    const codes = await col(db, "SELECT DISTINCT component_code FROM requisition_lines WHERE req_no = ?", [id]);
    const s = stockSlice(codes);
    return {
      targets: [{ c: "requisitions", key: String(id) }],
      locks: codes.map((c) => `stock:${c}`),
      slice: {
        ...s,
        requisitions: {
          sql: `h.req_no = ? OR ${s.requisitions?.sql ?? "0 = 1"}`,
          params: [id, ...(s.requisitions?.params ?? [])],
        },
      },
    };
  },

  addMrn: async ([m]) => {
    const reqId = (m as { requisitionId: string }).requisitionId;
    return {
      targets: [{ c: "requisitions", key: reqId }],
      locks: [],
      slice: { requisitions: eq("req_no", reqId), mrns: eq("req_no", reqId) },
      series: "MRN",
    };
  },

  addFgTransfer: async () => ({ targets: [], locks: [], slice: {}, series: "FGT" }),

  receiveFgTransfer: async ([id]) => ({
    targets: [{ c: "fgTransfers", key: String(id) }],
    locks: [],
    slice: { fgTransfers: eq("transfer_no", id) },
  }),

  recordPdi: async ([productName, batchNo], db) => ({
    targets: [],
    locks: [batchLock(String(productName), String(batchNo))],
    slice: await batchSlice(db, [{ productName: String(productName), batchNo: String(batchNo) }]),
    series: "PDI",
  }),

  addOrder: async () => ({ targets: [], locks: [], slice: {}, series: "WO" }),

  addDispatch: async ([d], db) => {
    const slip = d as { orderId: string; lines: { productName: string; batchNo: string }[] };
    return {
      targets: [],
      locks: slip.lines.map((l) => batchLock(l.productName, l.batchNo)),
      slice: {
        ...(await batchSlice(db, slip.lines)),
        ...(slip.orderId ? { orders: eq("order_no", slip.orderId) } : {}),
      },
      series: "DPS",
    };
  },

  addInvoice: async ([id]) => ({
    targets: [{ c: "dispatchSlips", key: String(id) }],
    locks: [],
    slice: { dispatchSlips: eq("dispatch_no", id) },
  }),

  gateOut: async ([id]) => ({
    targets: [{ c: "dispatchSlips", key: String(id) }],
    locks: [],
    slice: { dispatchSlips: eq("dispatch_no", id) },
  }),

  addIndent: async ([i], db) => {
    const requestNo = (i as { requestNo?: string }).requestNo;
    if (!requestNo) return { targets: [], locks: [], slice: {}, series: "IND" };
    // only a request Store verified can become an indent (verify never goes back, so checking before the lock is safe)
    const status = await col(db, "SELECT status FROM indent_requests WHERE request_no = ?", [requestNo]);
    if (status[0] !== "VERIFIED") throw new FlowError(`Indent request ${requestNo} is not verified by Store.`);
    // its indent, if any, loaded under the lock: the rule refuses a second one
    return { targets: [], locks: [`indentreq:${requestNo}`], slice: { indents: eq("request_no", requestNo) }, series: "IND" };
  },

  raisePo: async ([p]) => {
    const ids = (p as { indentIds: string[] }).indentIds;
    return {
      targets: ids.map((key) => ({ c: "indents" as const, key })),
      locks: [],
      slice: ids.length ? { indents: { sql: "h.indent_no IN (?)", params: [ids] } } : {},
      series: "PO",
    };
  },

  approvePo: async ([id]) => ({
    targets: [{ c: "purchaseOrders", key: String(id) }],
    locks: [],
    slice: { purchaseOrders: eq("po_no", id) },
  }),

  rejectPo: async ([id]) => ({
    targets: [{ c: "purchaseOrders", key: String(id) }],
    locks: [],
    // its indents go back to open
    slice: { purchaseOrders: eq("po_no", id), indents: eq("po_no", id) },
  }),

  closePo: async ([po]) => poClosurePlan(String(po)),
  reopenPo: async ([po]) => poClosurePlan(String(po)),

  // The one-time cut-over reads every PO before the date and what came in against any PO.
  closePosBefore: async ([before]) => {
    const day = toSqlDate(String(before));
    return {
      targets: [],
      locks: ["po-closures:cutover"],
      slice: {
        tallyPos: { sql: "h.po_date < ?", params: [day] },
        purchaseOrders: { sql: "h.po_date < ?", params: [day] },
        poClosures: { sql: "1 = 1", params: [] },
        gateEntries: { sql: "h.tally_po_no IS NOT NULL OR h.po_no IS NOT NULL", params: [] },
        // receipts against a PO: GRNs that name it (Store's pick), and older ones through their gate entry
        grnLines: { sql: "h.tally_po_no IS NOT NULL OR h.po_no IS NOT NULL OR g.tally_po_no IS NOT NULL OR g.po_no IS NOT NULL", params: [] },
      },
    };
  },
};

/** One PO's closure, with the PO itself (Tally copy or app PO) to check it exists. */
function poClosurePlan(poNo: string): Plan {
  return {
    targets: [{ c: "poClosures", key: poNo }],
    locks: [],
    slice: { poClosures: eq("po_no", poNo), tallyPos: eq("po_no", poNo), purchaseOrders: eq("po_no", poNo) },
  };
}
