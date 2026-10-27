/**
 * Document types for the Material Management flow — SOP/SCM/001 v2.1, 22 steps,
 * extended per the client's questionnaire answers: purchase (indent → PO →
 * approval), PDI before dispatch, MRN returns, work orders, locations.
 */

export type QcStatus = "UNDER_TEST" | "APPROVED" | "HOLD" | "REJECTED";

/** Gate Entry Register — handwritten diary format. SOP step 2. */
export interface GateEntry {
  id: string; // GE-0001
  date: string;
  supplierName: string;
  productDesc: string;
  invoiceNo: string;
  invoiceDate: string;
  poNo: string;
  invoiceQty: number | null;
  transportName: string;
  lrNo: string;
  vehicleNo: string;
  timeIn: string;
  timeOut: string;
  driverSign: boolean;
  remark: string;
  /** Items checked in against a Tally PO, one row each. Empty for a direct arrival without PO. */
  lines: GateEntryLine[];
}

/** One PO item the guard checked in: name, code and unit come from the Tally PO. */
export interface GateEntryLine {
  itemName: string;
  itemCode: string;
  unit: string;
  qty: number;
  /** e.g. "20 Doz short" — the item stays open on the PO until fully received. */
  remark: string;
}

/** A Purchase Order as it stands in Tally (read-only copy; Tally is never written to). */
export interface TallyPo {
  poNo: string;
  date: string;
  supplierName: string;
  cancelled: boolean;
  /** When this copy was last taken from Tally (dd-mm-yyyy hh:mm). */
  syncedAt: string;
  /** Tally's id of the voucher and its change number ("" / 0 for copies made before they were kept). */
  guid: string;
  alterId: number;
  lines: TallyPoLine[];
  /** Set by gatePos from the PO closures — never stored on the copy. */
  closed?: boolean;
}

/** A PO marked closed in MySQL (Purchase by hand, or the go-live cut-over); reopening sets closed false. */
export interface PoClosure {
  poNo: string;
  closed: boolean;
  date: string;
  by: string;
  reason: string;
}

export interface TallyPoLine {
  itemName: string;
  /** PMS code when the item is in the component master, else "". */
  itemCode: string;
  qty: number;
  unit: string;
}

/** GRN register — the Store's Excel sheet, one row per component receipt. SOP step 4. */
export interface GrnLine {
  grnNo: string; // GR0001
  gateEntryId: string;
  /** The gate-checked PO item (1-based line of the gate entry) this GRN counts; null for an arrival without PO. */
  gateLineNo: number | null;
  componentCode: string;
  componentName: string;
  type: string;
  brandName: string;
  receivedDate: string;
  poNo: string;
  poQty: number | null;
  invoiceNo: string;
  supplierName: string;
  qtyPerBox: number | null;
  totalBoxes: number | null;
  totalQty: number;
  /** The PO's unit (Doz, Kg, Pcs …); "" = pcs (receipts from before Tally POs). */
  unit: string;
  remarkStore: string;
  /** Where the material is kept — client wants stock place-wise. */
  location: string;
  /** Lifecycle after receipt: quarantine → QC decision. Steps 5–9. */
  qcStatus: QcStatus;
  /** Step 10 — barcode sticker pasted on approved material. */
  barcoded: boolean;
}

/** Q.C Intimation Slip (PM/RM) — handwritten format ②. SOP step 6. */
export interface QcIntimation {
  id: string; // QCI-0001
  date: string;
  timeOfIssue: string;
  grnNo: string;
  productName: string;
  code: string;
  supplierName: string;
  invoiceNo: string;
  batchNo: string;
  mfgDate: string;
  expiryDate: string;
  totalQty: number;
  totalBox: number | null;
  remark: string;
}

/** Q.C Testing and AR No Generator — handwritten format ③. SOP steps 7–8. */
export interface ArRecord {
  arNo: string; // AR-0001
  intimationId: string;
  date: string;
  status: Exclude<QcStatus, "UNDER_TEST">;
  remark: string;
}

/** One line of a Requisition Slip. */
export interface RequisitionLine {
  materialName: string;
  materialCode: string;
  unit: string;
  qtyRequired: number;
  qtyIssued: number | null;
  returnQty: number | null;
  remark: string;
}

/** Raw Material / Packing Material Requisition Slip — printed form. Steps 11–13. */
export interface Requisition {
  id: string; // REQ-0001
  date: string;
  department: string;
  productName: string;
  batchNo: string;
  lines: RequisitionLine[];
  packingSign: string;
  storeSign: string;
  status: "PENDING" | "ISSUED";
}

/** Material Return Note — leftover material back to store. Client: "It's called MRN." */
export interface MrnLine {
  componentCode: string;
  componentName: string;
  qty: number;
}
export interface Mrn {
  id: string; // MRN-0001
  date: string;
  requisitionId: string;
  lines: MrnLine[];
  sign: string;
  remark: string;
}

export interface FgTransferLine {
  productCode: string; // FG code
  productName: string;
  sku: string;
  batchNo: string;
  mfgDate: string;
  qtyPerBox: number;
  totalBoxes: number;
  looseQty: number;
  totalQty: number;
  remark: string;
}

/** FG Transfer Details / Packing List — letterheaded form. Steps 15–16. */
export interface FgTransfer {
  id: string; // FGT-0001
  date: string;
  lines: FgTransferLine[];
  submittedBy: string; // Production
  checkedBy: string; // FG WH sign on receiving
  /** Decided location in the FG godown — SOP step 17. */
  location: string;
  status: "IN_TRANSIT" | "RECEIVED";
  receivedDate: string;
}

/** Pre-Dispatch Inspection — client: "every batch is checked before dispatch, it's called PDI." */
export interface PdiRecord {
  id: string; // PDI-0001
  date: string;
  productName: string;
  batchNo: string;
  status: "PASSED" | "FAILED";
  remark: string;
}

/** Customer work order — stays open until fully dispatched. */
export interface OrderLine {
  productName: string;
  productCode: string;
  qty: number;
}
export interface CustOrder {
  id: string; // WO-0001
  date: string;
  partyName: string;
  partyAddress: string;
  custPoNo: string;
  deliveryDate: string;
  lines: OrderLine[];
  remark: string;
}

export interface DispatchLine {
  productName: string;
  productCode: string;
  batchNo: string;
  qtyPerBox: number;
  totalBoxes: number;
  totalQty: number;
}

/** Dispatch Packing Slip — handwritten diary format. Steps 18–22. */
export interface DispatchSlip {
  id: string; // DPS-0001
  date: string;
  partyName: string;
  partyAddress: string;
  /** Work order this dispatch counts against, if any. */
  orderId: string;
  lines: DispatchLine[];
  dispatchSign: string;
  securitySign: string;
  invoiceNo: string; // filled by Accounts, step 20
  invoiceDate: string;
  gateOut: boolean;
  gateOutTime: string;
  remark: string;
}

/* ── purchase: indent → PO → approval ───────────────────────────────────────── */

export interface Indent {
  id: string; // IND-0001
  date: string;
  componentCode: string;
  componentName: string;
  qty: number;
  reason: string;
  /** The vendor to buy from — a PO gathers the open indents of one vendor. "" on indents made before vendors were recorded. */
  supplierName: string;
  /** Expected rate per unit (₹), carried onto the PO line; null on indents made before rates were asked. */
  rate: number | null;
  status: "OPEN" | "PO_RAISED";
}

export interface PoLine {
  componentCode: string;
  componentName: string;
  qty: number;
  rate: number | null;
}

export interface PurchaseOrder {
  id: string; // continues the client's series: 26SEV231…
  date: string;
  supplierName: string;
  lines: PoLine[];
  expectedDate: string;
  status: "PENDING_APPROVAL" | "APPROVED";
  approvedBy: string;
  indentIds: string[];
  /** Last attempt to create it in Tally (dd-mm-yyyy hh:mm, "" = never) and why Tally refused ("" = created). */
  tallyPushedAt: string;
  tallyError: string;
}

/** Component master — the client's PMS component list (database table `components`). */
export interface ComponentInfo {
  code: string;
  name: string;
  type: string;
  /** Tally base unit (Pcs, Kg …); "" = pcs. */
  unit: string;
}

/** One BOM line: component code `c`, name `n`, quantity per 100 finished units `p`. */
export interface BomLine {
  n: string;
  c: string;
  p: number;
}

/** Master data the screens need, served by the API (never compiled into the frontend). */
export interface Masters {
  components: ComponentInfo[];
  products: ProductMaster[];
  /** Product name → BOM lines. Only sent to roles that raise requisitions. */
  bom: Record<string, BomLine[]> | null;
}

/** Finished-goods master — from the client's BOM product list. */
export interface ProductMaster {
  fg: string;
  name: string;
  vendor: string;
  /** Units per box, derived from the BOM's "box" component where present. */
  boxSize: number | null;
}

/** Approved supplier with fixed rates — client's "price master". */
export interface Supplier {
  name: string;
  city: string;
  /** A ledger in Tally (synced) — once Tally is connected, only these can be on an indent or PO. */
  fromTally: boolean;
  /** Fixed rate per component code. */
  rates: Record<string, number>;
}

export interface FlowState {
  /**
   * Server only: document numbers allocated for the action being applied
   * (series → number). Never sent to the browser.
   */
  allocated?: Partial<Record<string, string>>;
  /** Opening stock per component code. Empty start = everything at zero. */
  openings: Record<string, number>;
  /** Minimum level per component code. Empty start = none set. */
  minLevels: Record<string, number>;
  gateEntries: GateEntry[];
  grnLines: GrnLine[];
  qcIntimations: QcIntimation[];
  arRecords: ArRecord[];
  requisitions: Requisition[];
  mrns: Mrn[];
  fgTransfers: FgTransfer[];
  pdiRecords: PdiRecord[];
  orders: CustOrder[];
  dispatchSlips: DispatchSlip[];
  indents: Indent[];
  purchaseOrders: PurchaseOrder[];
  tallyPos: TallyPo[];
  poClosures: PoClosure[];
}
