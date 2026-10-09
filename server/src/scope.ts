import { CUSTOMER_ROLES, PRICE_ROLES, READ_SCOPES, type Role } from "../../src/flow/perms";
import type { FlowState } from "../../src/flow/types";

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
      lines: p.lines.map((l) => ({ ...l, rate: null })),
    }));
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
