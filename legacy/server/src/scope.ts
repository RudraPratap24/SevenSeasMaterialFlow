import { CUSTOMER_ROLES, PRICE_ROLES, READ_SCOPES, type Role } from "../../src/flow/perms";
import type { FlowState, GrnLine } from "../../src/flow/types";

function blank(): FlowState {
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
    debitNotes: [],
    escalationClosures: [],
    bomIssues: [],
  };
}

/**
 * What a role is allowed to read. Registers outside the role's scope are not
 * sent at all; inside the scope, commercial terms and customer details are
 * blanked for roles that have no business seeing them.
 */
export function scopeStateFor(role: Role, full: FlowState): FlowState {
  const out = blank();
  for (const c of READ_SCOPES[role]) (out[c] as unknown) = full[c];

  if (!PRICE_ROLES.includes(role)) {
    out.purchaseOrders = out.purchaseOrders.map((p) => ({
      ...p,
      tallyPushedAt: "",
      tallyError: "",
      lines: p.lines.map((l) => ({ ...l, rate: null })),
    }));
    out.indents = out.indents.map((i) => ({ ...i, rate: null }));
    out.debitNotes = out.debitNotes.map((d) => ({ ...d, rate: 0, amount: 0 }));
  }
  // the driver's name and phone: only the gate that recorded them, and the admin
  if (role !== "gate" && role !== "admin") {
    out.gateEntries = out.gateEntries.map((g) => ({ ...g, driverName: "", driverPhone: "" }));
  }
  // the gate needs only which of its entries have a GRN (open / closed), not the GRNs themselves
  if (role === "gate") {
    // (every field kept, with blank values: the shared screen code reads them all and must not crash)
    out.grnLines = out.grnLines.map(
      (g): GrnLine => ({
        grnNo: g.grnNo,
        gateEntryId: g.gateEntryId,
        gateLineNo: null,
        componentCode: "",
        componentName: "",
        type: "",
        brandName: "",
        receivedDate: "",
        poNo: "",
        poQty: null,
        invoiceNo: "",
        supplierName: "",
        qtyPerBox: null,
        totalBoxes: null,
        totalQty: 0,
        unit: "",
        remarkStore: "",
        location: "",
        qcStatus: "UNDER_TEST",
        barcoded: false,
        acceptedQty: null,
        poItemName: "",
        poItemCode: "",
        pendingBefore: null,
        variance: "",
        closesItem: false,
      }),
    );
  }
  if (!CUSTOMER_ROLES.includes(role)) {
    out.orders = out.orders.map((o) => ({ ...o, partyName: "", partyAddress: "", custPoNo: "" }));
    out.dispatchSlips = out.dispatchSlips.map((d) => ({
      ...d,
      partyName: "",
      partyAddress: "",
      invoiceNo: d.invoiceNo ? "•••" : "",
    }));
  }
  return out;
}
