/**
 * Indian digit grouping everywhere — the client expects 1,20,000, not 120,000.
 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-IN");
}

/** Pack size derived from the per-100 factor — never hardcoded. §3 */
export function packSize(p: number): number | null {
  const q = 100 / p;
  const r = Math.round(q);
  return Math.abs(q - r) < 0.02 * Math.max(r, 1) ? r : null;
}

export function packLabel(p: number): string {
  const k = packSize(p);
  if (k === null) return `${p} per 100`;
  return k === 1 ? "1 per unit" : `1 per ${k.toLocaleString("en-IN")}`;
}

/** "—" when nothing is short; "−2,193" when something is. */
export function shortLabel(shortfall: number): string {
  return shortfall > 0 ? `−${fmt(shortfall)}` : "—";
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function todayLabel(): string {
  return new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Coverage as a whole-number percentage, capped for display. */
export function coveragePct(coverage: number): number {
  if (!Number.isFinite(coverage)) return 100;
  return Math.max(0, Math.min(1, coverage)) * 100;
}
