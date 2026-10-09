import type {
  BomProduct,
  Contribution,
  PlanLine,
  RequirementRow,
  Status,
  StockMap,
} from "./types";

/** Kills floating-point dust before rounding up (e.g. 416.99999999999994 → 417). §3 */
const EPS = 1e-9;

/** Below this much headroom a covered component still counts as TIGHT. §3 */
const TIGHT_FACTOR = 1.1;

export function statusOf(available: number, requirement: number): Status {
  if (available < requirement) return "SHORT";
  // Same epsilon trick as the requirement rounding: 100 * 1.1 is 110.00000000000001
  // in binary floating point, which would call exactly-10%-headroom TIGHT.
  if (available < requirement * TIGHT_FACTOR - EPS) return "TIGHT";
  return "OK";
}

/**
 * Explode the plan through the BOM and compare against stock.
 *
 * The whole point of §3: requirements are summed as floats across every plan line
 * FIRST and rounded up ONCE at the end. Rounding per line and then summing would
 * inflate any component shared by several products.
 */
export function buildRequirements(
  plan: PlanLine[],
  products: BomProduct[],
  stock: StockMap,
): RequirementRow[] {
  const exact = new Map<string, number>();
  const meta = new Map<
    string,
    { name: string; p: number; products: Contribution[] }
  >();

  for (const line of plan) {
    const product = products[line.pid];
    if (!product) continue;
    const qty = normaliseQty(line.qty);

    for (const comp of product.comps) {
      const contribution = (qty * comp.p) / 100;
      exact.set(comp.c, (exact.get(comp.c) ?? 0) + contribution);

      let entry = meta.get(comp.c);
      if (!entry) {
        entry = { name: comp.n, p: comp.p, products: [] };
        meta.set(comp.c, entry);
      }
      entry.products.push({
        name: product.name,
        fg: product.fg,
        vendor: product.vendor,
        qty,
        exact: contribution,
      });
    }
  }

  const rows: RequirementRow[] = [];
  for (const [code, exactQty] of exact) {
    const entry = meta.get(code)!;
    const requirement = Math.max(0, Math.ceil(exactQty - EPS));
    const inv = stock[code];
    const available = inv ? inv.closing : 0;
    const shortfall = Math.max(0, requirement - available);
    const coverage = requirement === 0 ? 1 : available / requirement;

    rows.push({
      code,
      name: inv?.name ?? entry.name,
      type: inv?.type ?? "",
      vendor: vendorOf(entry.products),
      p: entry.p,
      requirementExact: exactQty,
      requirement,
      available,
      shortfall,
      coverage,
      status: statusOf(available, requirement),
      products: entry.products,
    });
  }

  return sortRequirements(rows, "shortfall", "desc");
}

/** Quantity is clamped to a whole number ≥ 1 — blank, 0 and NaN all become 1. §7.8 */
export function normaliseQty(qty: number): number {
  if (!Number.isFinite(qty)) return 1;
  return Math.max(1, Math.floor(qty));
}

/** A component's vendor is the vendor of the product(s) that consume it. */
function vendorOf(contributions: Contribution[]): string {
  const seen: string[] = [];
  for (const c of contributions) {
    const v = c.vendor.trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen.join(" / ");
}

export type SortKey =
  | "shortfall"
  | "requirement"
  | "available"
  | "name"
  | "code";
export type SortDir = "asc" | "desc";

/**
 * Default view is worst-shortfall-first, then biggest requirement — the client
 * must never have to hunt for the red. §6.5
 */
export function sortRequirements(
  rows: RequirementRow[],
  key: SortKey,
  dir: SortDir,
): RequirementRow[] {
  const sign = dir === "desc" ? -1 : 1;
  const out = rows.slice();

  out.sort((a, b) => {
    if (key === "shortfall") {
      // Default ordering carries its own tie-break chain.
      if (a.shortfall !== b.shortfall) return sign * (a.shortfall - b.shortfall);
      if (a.requirement !== b.requirement)
        return sign * (a.requirement - b.requirement);
      return a.code.localeCompare(b.code);
    }
    if (key === "name") {
      const c = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
      return c !== 0 ? sign * c : a.code.localeCompare(b.code);
    }
    if (key === "code") return sign * a.code.localeCompare(b.code);

    const av = key === "requirement" ? a.requirement : a.available;
    const bv = key === "requirement" ? b.requirement : b.available;
    if (av !== bv) return sign * (av - bv);
    return a.code.localeCompare(b.code);
  });

  return out;
}

export interface PlanSummary {
  total: number;
  short: number;
  tight: number;
  ok: number;
  shortUnits: number;
}

export function summarise(rows: RequirementRow[]): PlanSummary {
  let short = 0;
  let tight = 0;
  let ok = 0;
  let shortUnits = 0;
  for (const r of rows) {
    if (r.status === "SHORT") {
      short++;
      shortUnits += r.shortfall;
    } else if (r.status === "TIGHT") tight++;
    else ok++;
  }
  return { total: rows.length, short, tight, ok, shortUnits };
}

/** closing = opening + inward − outward, kept true whichever field is edited. §2.2 */
export function rebalance(
  row: { opening: number; inward: number; outward: number; closing: number },
  field: "opening" | "inward" | "outward" | "closing",
  value: number,
): { opening: number; inward: number; outward: number; closing: number } {
  const v = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const next = { ...row, [field]: v };

  if (field === "closing") {
    // A physical count was entered: absorb the difference into inward, and if that
    // would go negative, into outward instead. Both stay ≥ 0, invariant holds.
    const inward = next.closing - next.opening + next.outward;
    if (inward >= 0) return { ...next, inward };
    return { ...next, inward: 0, outward: Math.max(0, next.opening - next.closing) };
  }

  return { ...next, closing: next.opening + next.inward - next.outward };
}
