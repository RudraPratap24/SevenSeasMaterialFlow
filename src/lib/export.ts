import { fmt, packLabel, todayLabel } from "./format";
import type { BomProduct, PlanLine, RequirementRow } from "./types";

function cell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/** UTF-8 BOM so Excel opens the file without mojibake. §7.5 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["\ufeff", csv], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function planLines(
  plan: PlanLine[],
  products: BomProduct[],
): { name: string; fg: string; qty: number }[] {
  return plan
    .map((l) => products[l.pid])
    .map((p, i) => ({
      name: p?.name ?? "—",
      fg: p?.fg ?? "",
      qty: plan[i].qty,
    }));
}

/** Export 1 — every component in the plan, as a clean table Excel can pivot. */
export function exportFullRequirement(rows: RequirementRow[]): void {
  const body: (string | number)[][] = [
    [
      "COMPONENT NAME",
      "COMPONENT CODE",
      "TYPE",
      "PACK SIZE",
      "VENDOR",
      "REQUIRED",
      "AVAILABLE",
      "SHORTFALL",
      "STATUS",
    ],
  ];

  for (const r of rows) {
    body.push([
      r.name,
      r.code,
      r.type,
      packLabel(r.p),
      r.vendor,
      fmt(r.requirement),
      fmt(r.available),
      r.shortfall > 0 ? fmt(r.shortfall) : "0",
      r.status,
    ]);
  }

  downloadCsv(`packing-requirement-${fileStamp()}.csv`, toCsv(body));
}

/** Export 2 — shortfalls only, by vendor then worst first. This is what goes to purchasing. */
export function exportPurchaseIndent(
  rows: RequirementRow[],
  plan: PlanLine[],
  products: BomProduct[],
): void {
  const short = rows
    .filter((r) => r.shortfall > 0)
    .sort((a, b) => {
      // Blank vendors sort last.
      const av = a.vendor || "\uffff";
      const bv = b.vendor || "\uffff";
      if (av !== bv) return av.localeCompare(bv);
      if (a.shortfall !== b.shortfall) return b.shortfall - a.shortfall;
      return a.code.localeCompare(b.code);
    });

  const head: (string | number)[][] = [
    ["PURCHASE INDENT — PACKING MATERIAL"],
    ["Generated", todayLabel()],
    [],
    ["PRODUCTION PLAN"],
    ["Product", "FG code", "Units to produce"],
  ];

  for (const line of planLines(plan, products)) {
    head.push([line.name, line.fg, fmt(line.qty)]);
  }

  head.push([]);
  head.push([
    "COMPONENT NAME",
    "COMPONENT CODE",
    "TYPE",
    "PACK SIZE",
    "VENDOR",
    "REQUIRED",
    "AVAILABLE",
    "SHORT BY",
  ]);

  for (const r of short) {
    head.push([
      r.name,
      r.code,
      r.type,
      packLabel(r.p),
      r.vendor || "Not specified",
      fmt(r.requirement),
      fmt(r.available),
      fmt(r.shortfall),
    ]);
  }

  if (short.length === 0) {
    head.push(["No shortfalls — this plan can run with current stock."]);
  }

  downloadCsv(`purchase-indent-${fileStamp()}.csv`, toCsv(head));
}
