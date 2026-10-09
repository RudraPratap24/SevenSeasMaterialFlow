import bomJson from "../data/bom.json";
import inventoryJson from "../data/inventory.json";
import type { BomProduct, InventoryRow, PlanLine, StockMap } from "./types";

/** The client's own BOM: 128 products, 717 component lines. Real data. */
export const PRODUCTS = bomJson as BomProduct[];

/** 717 components. Names, codes and types ship as-is; stock figures are seeded. */
export const SEED_INVENTORY = inventoryJson as InventoryRow[];

export const PRODUCT_COUNT = PRODUCTS.length;
export const COMPONENT_COUNT = SEED_INVENTORY.length;

export function seedStock(): StockMap {
  const map: StockMap = {};
  for (const row of SEED_INVENTORY) map[row.code] = { ...row };
  return map;
}

export const COMPONENT_TYPES: string[] = Array.from(
  new Set(SEED_INVENTORY.map((r) => r.type).filter(Boolean)),
).sort((a, b) => a.localeCompare(b));

function indexOfProduct(name: string): number {
  const i = PRODUCTS.findIndex((p) => p.name === name);
  return i >= 0 ? i : 0;
}

/**
 * §7.7 — one click back to a known-good demo state: 16 components, 4 of them short.
 */
export const EXAMPLE_PLAN: PlanLine[] = [
  { pid: indexOfProduct("APF Apple Foundation Fine Touch"), qty: 5000 },
  { pid: indexOfProduct("LL-112 Ultra Matter liquid Lipstick"), qty: 2400 },
];
