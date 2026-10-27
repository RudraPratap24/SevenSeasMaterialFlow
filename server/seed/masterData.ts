/**
 * Source data for the master tables — read ONLY by the database importer
 * (`npm run db:setup`) and the demo storyline. At runtime the app reads masters
 * from the database; nothing here is shipped to the browser.
 */
import bomJson from "../../src/data/bom.json";
import inventoryJson from "../../src/data/inventory.json";
import type { BomLine, ComponentInfo, ProductMaster } from "../../src/flow/types";

interface BomProduct {
  name: string;
  fg: string;
  vendor: string;
  comps: BomLine[];
}
interface InvRow {
  code: string;
  name: string;
  type: string;
  closing: number;
}

export const BOM_SOURCE = bomJson as BomProduct[];
const INV = inventoryJson as InvRow[];

/**
 * The client's 717 components, continuing their own PMS series with the two new
 * codes seen on the real GRN sheet (PMS0848 tray, PMS0849 barcode).
 */
export const SEED_COMPONENTS: ComponentInfo[] = [
  ...INV.map((r) => ({ code: r.code, name: r.name, type: r.type, unit: "" })),
  { code: "PMS0848", name: "LL-112 TRAY (POP)", type: "POP", unit: "" },
  { code: "PMS0849", name: "BARCODE LABEL SEVEN SEAS", type: "Barcode", unit: "" },
];

/** Units per box from the product's own BOM "…box N pcs" line (p = 100/N). */
function boxSizeOf(p: BomProduct): number | null {
  const box = p.comps.find((c) => /box/i.test(c.n) && !/shrink|outer|master/i.test(c.n));
  if (!box || box.p <= 0) return null;
  const q = 100 / box.p;
  const r = Math.round(q);
  return Math.abs(q - r) < 0.02 * Math.max(r, 1) ? r : null;
}

export const SEED_PRODUCTS: ProductMaster[] = BOM_SOURCE.map((p) => ({
  fg: p.fg,
  name: p.name,
  vendor: p.vendor,
  boxSize: boxSizeOf(p),
}));

/** Demo opening balances (the seeded stock figures). A live start uses zeroes. */
export const SEED_OPENINGS: Record<string, number> = {
  ...Object.fromEntries(INV.map((r) => [r.code, r.closing])),
  PMS0848: 0,
  PMS0849: 0,
};

/** Demo minimum levels — the client is sending real ones. */
export const MIN_LEVELS: Record<string, number> = {
  PMS0002: 4000,
  PMS0005: 100,
  PMS0014: 1000,
  PMS0158: 2000,
  PMS0161: 2000,
  PMS0164: 1000,
  PMS0165: 200,
  PMS0849: 50000,
};
