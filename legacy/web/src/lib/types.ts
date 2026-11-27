/** A single component line of a product's Bill of Materials. */
export interface BomComponent {
  /** Component name, as written on the client's BOM sheet. */
  n: string;
  /** Component code, e.g. "PMS0002". */
  c: string;
  /** Quantity of this component consumed per 100 finished units (client's own convention). */
  p: number;
}

export interface BomProduct {
  name: string;
  /** The client's FG (finished-goods) code. */
  fg: string;
  vendor: string;
  comps: BomComponent[];
}

/** One packing component's stock position. Invariant: closing = opening + inward − outward. */
export interface InventoryRow {
  code: string;
  name: string;
  type: string;
  opening: number;
  inward: number;
  outward: number;
  closing: number;
}

export type StockMap = Record<string, InventoryRow>;

/** One line of the production plan. `pid` is the product's index in the BOM array — FG codes are not unique. */
export interface PlanLine {
  pid: number;
  qty: number;
}

export type Status = "SHORT" | "TIGHT" | "OK";

/** What one product contributes to a component's requirement. */
export interface Contribution {
  name: string;
  fg: string;
  vendor: string;
  qty: number;
  /** Un-rounded requirement contributed by this product line. */
  exact: number;
}

export interface RequirementRow {
  code: string;
  name: string;
  type: string;
  /** Vendor(s) of the product(s) that need this component. "" when the sheet leaves it blank. */
  vendor: string;
  /** Per-100 factor, used to derive the pack label. */
  p: number;
  requirementExact: number;
  requirement: number;
  available: number;
  shortfall: number;
  coverage: number;
  status: Status;
  products: Contribution[];
}
