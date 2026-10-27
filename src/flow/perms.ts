/**
 * Roles, tabs and permissions — shared by the browser (to show/hide buttons)
 * and the server (which is the real gatekeeper: every action and every read is
 * checked there). No passwords live here; accounts are stored in the database.
 */
import type { FlowState } from "./types";

export type TabId =
  | "flow"
  | "gate"
  | "grn"
  | "qc"
  | "pmstock"
  | "requisition"
  | "fg"
  | "dispatch"
  | "purchase";

export type Role =
  | "gate"
  | "store"
  | "qc"
  | "packing"
  | "fgwh"
  | "accounts"
  | "purchase"
  | "security"
  | "admin";

export const ROLES: Role[] = [
  "gate",
  "store",
  "qc",
  "packing",
  "fgwh",
  "accounts",
  "purchase",
  "security",
  "admin",
];

export interface RoleProfile {
  label: string;
  /** Tabs this role can open. First one is the landing tab. */
  tabs: TabId[];
  /** Tabs opened read-only (client: "production can see QC, QC can see GRN"). */
  viewOnly: TabId[];
}

export const ROLE_PROFILES: Record<Role, RoleProfile> = {
  gate: { label: "Gate Entry", tabs: ["gate"], viewOnly: [] },
  store: { label: "Store", tabs: ["grn", "pmstock", "requisition"], viewOnly: [] },
  qc: { label: "QC", tabs: ["qc", "grn"], viewOnly: ["grn"] },
  packing: { label: "Packing / Production", tabs: ["requisition", "fg", "qc"], viewOnly: ["qc"] },
  fgwh: { label: "FG Warehouse", tabs: ["fg", "dispatch"], viewOnly: [] },
  accounts: { label: "Accounts", tabs: ["dispatch"], viewOnly: [] },
  purchase: { label: "Purchase", tabs: ["purchase", "pmstock"], viewOnly: ["pmstock"] },
  security: { label: "Security", tabs: ["dispatch", "gate"], viewOnly: ["gate"] },
  admin: {
    label: "Admin (Owner)",
    tabs: ["flow", "gate", "grn", "qc", "pmstock", "requisition", "fg", "dispatch", "purchase"],
    viewOnly: [],
  },
};

export type Action =
  | "gate.create"
  | "grn.create"
  | "grn.qty"
  | "grn.barcode"
  | "grn.sendqc"
  | "qc.decide"
  | "qc.pdi"
  | "req.create"
  | "req.issue"
  | "mrn.create"
  | "fg.create"
  | "fg.receive"
  | "order.create"
  | "dispatch.create"
  | "invoice.add"
  | "gateout"
  | "purchase.indent"
  | "purchase.po"
  | "purchase.approve"
  | "purchase.close"
  | "purchase.cutover"
  | "purchase.tally"
  | "customer.edit"
  | "demo.data";

export const PERMS: Record<Action, Role[]> = {
  "gate.create": ["gate", "admin"],
  "grn.create": ["store", "admin"],
  "grn.qty": ["store", "admin"],
  "grn.barcode": ["store", "admin"],
  "grn.sendqc": ["store", "admin"],
  "qc.decide": ["qc", "admin"],
  "qc.pdi": ["qc", "admin"],
  "req.create": ["packing", "admin"],
  "req.issue": ["store", "admin"],
  "mrn.create": ["packing", "store", "admin"],
  "fg.create": ["packing", "admin"],
  "fg.receive": ["fgwh", "admin"],
  "order.create": ["fgwh", "accounts", "admin"],
  "dispatch.create": ["fgwh", "admin"],
  "invoice.add": ["accounts", "admin"],
  gateout: ["security", "admin"],
  "purchase.indent": ["purchase", "admin"],
  "purchase.po": ["purchase", "admin"],
  // Client: "management approves the PO" — the owner's button alone.
  "purchase.approve": ["admin"],
  // A PO can be closed/reopened by Purchase; the one-time go-live cut-over only by the owner.
  "purchase.close": ["purchase", "admin"],
  "purchase.cutover": ["admin"],
  // Send an approved PO to Tally again after Tally refused it (it goes on its own at approval).
  "purchase.tally": ["purchase", "admin"],
  // Customer master: name/address corrections apply to every order and dispatch.
  "customer.edit": ["accounts", "admin"],
  "demo.data": ["admin"],
};

export function roleCan(role: Role, action: Action): boolean {
  return PERMS[action].includes(role);
}

/**
 * Registers each role may READ. The server sends a role nothing outside this
 * list. Each list covers the role's own tabs, its view-only tabs, its pending
 * strip and the derived figures those screens show (e.g. the gate needs GRNs
 * to know how much of a PO is still pending).
 */
export type Collection = keyof FlowState;

export const READ_SCOPES: Record<Role, Collection[]> = {
  gate: ["gateEntries", "tallyPos", "purchaseOrders", "poClosures", "grnLines"],
  store: ["openings", "minLevels", "gateEntries", "grnLines", "qcIntimations", "requisitions", "mrns"],
  qc: ["gateEntries", "grnLines", "qcIntimations", "arRecords", "fgTransfers", "pdiRecords", "dispatchSlips"],
  packing: [
    "openings",
    "minLevels",
    "grnLines",
    "qcIntimations",
    "arRecords",
    "requisitions",
    "mrns",
    "fgTransfers",
    "pdiRecords",
    "dispatchSlips",
  ],
  fgwh: ["requisitions", "fgTransfers", "pdiRecords", "orders", "dispatchSlips"],
  accounts: ["fgTransfers", "pdiRecords", "orders", "dispatchSlips"],
  purchase: ["openings", "minLevels", "gateEntries", "grnLines", "requisitions", "mrns", "indents", "purchaseOrders", "tallyPos", "poClosures"],
  security: ["gateEntries", "purchaseOrders", "grnLines", "fgTransfers", "pdiRecords", "orders", "dispatchSlips"],
  admin: [
    "openings",
    "minLevels",
    "gateEntries",
    "grnLines",
    "qcIntimations",
    "arRecords",
    "requisitions",
    "mrns",
    "fgTransfers",
    "pdiRecords",
    "orders",
    "dispatchSlips",
    "indents",
    "purchaseOrders",
    "tallyPos",
    "poClosures",
  ],
};

/** Roles that may see commercial terms — PO rates/values and the supplier price master. */
export const PRICE_ROLES: Role[] = ["purchase", "admin"];

/** Roles that may see customer details (party name/address, customer PO, invoice no). */
export const CUSTOMER_ROLES: Role[] = ["fgwh", "accounts", "security", "admin"];
