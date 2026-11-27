import type { StockMap } from "./types";

/**
 * §8 — import stock from a CSV using the client's own column headers:
 *   SR NO,COMPONENT NAME,TYPE,COMPONENT CODE,OPENING,INWARD,OUTWARD,CLOSING
 * Rows are matched on COMPONENT CODE. SR NO is ignored. Nothing here throws.
 */

export interface ImportIssue {
  /** 1-based line number in the file, as the user sees it in Excel. */
  row: number | null;
  message: string;
}

export interface ImportResult {
  ok: boolean;
  updated: number;
  known: number;
  rowsRead: number;
  unrecognised: string[];
  warnings: ImportIssue[];
  errors: ImportIssue[];
  next: StockMap | null;
}

/** Tolerant RFC-4180 reader: handles quotes, escaped quotes, CRLF and a leading BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // CRLF: let the \n do the work. A lone CR still ends the row.
      if (src[i + 1] === "\n") continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

/** "1,20,000" and " 4 400 " both read as numbers; "" and "-" read as blank. */
function readNumber(raw: string): number | null | "invalid" {
  const s = raw.replace(/[,\s]/g, "").trim();
  if (s === "" || s === "-" || s === "—") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return "invalid";
  return Math.round(n);
}

export function importStockCsv(text: string, current: StockMap): ImportResult {
  const result: ImportResult = {
    ok: false,
    updated: 0,
    known: Object.keys(current).length,
    rowsRead: 0,
    unrecognised: [],
    warnings: [],
    errors: [],
    next: null,
  };

  try {
    const rows = parseCsv(text);
    if (rows.length === 0) {
      result.errors.push({ row: null, message: "The file is empty." });
      return result;
    }

    const header = rows[0].map(norm);
    const col = (...names: string[]) => {
      for (const n of names) {
        const i = header.indexOf(norm(n));
        if (i >= 0) return i;
      }
      return -1;
    };

    const iCode = col("COMPONENT CODE", "CODE");
    const iOpening = col("OPENING");
    const iInward = col("INWARD");
    const iOutward = col("OUTWARD");
    const iClosing = col("CLOSING");

    if (iCode < 0) {
      result.errors.push({
        row: 1,
        message:
          'No COMPONENT CODE column found. Expected headers: SR NO, COMPONENT NAME, TYPE, COMPONENT CODE, OPENING, INWARD, OUTWARD, CLOSING.',
      });
      return result;
    }

    if (iOpening < 0 && iInward < 0 && iOutward < 0 && iClosing < 0) {
      result.errors.push({
        row: 1,
        message:
          "No stock columns found. At least one of OPENING, INWARD, OUTWARD or CLOSING is required.",
      });
      return result;
    }

    const next: StockMap = {};
    for (const code of Object.keys(current)) next[code] = { ...current[code] };

    const seen = new Set<string>();

    for (let r = 1; r < rows.length; r++) {
      const line = rows[r];
      const lineNo = r + 1;
      result.rowsRead++;

      const code = (line[iCode] ?? "").trim().toUpperCase();
      if (!code) {
        result.warnings.push({ row: lineNo, message: "Blank component code — row skipped." });
        continue;
      }

      const existing = next[code];
      if (!existing) {
        if (!result.unrecognised.includes(code)) result.unrecognised.push(code);
        continue;
      }

      if (seen.has(code)) {
        result.warnings.push({
          row: lineNo,
          message: `${code} appears more than once — the last row wins.`,
        });
      }
      seen.add(code);

      const pick = (i: number) => (i < 0 ? null : readNumber(line[i] ?? ""));
      const opening = pick(iOpening);
      const inward = pick(iInward);
      const outward = pick(iOutward);
      const closing = pick(iClosing);

      const fields: { label: string; value: number | null | "invalid" }[] = [
        { label: "OPENING", value: opening },
        { label: "INWARD", value: inward },
        { label: "OUTWARD", value: outward },
        { label: "CLOSING", value: closing },
      ];
      const bad = fields.find((f) => f.value === "invalid");

      if (bad) {
        result.errors.push({
          row: lineNo,
          message: `${code}: ${bad.label} is not a number — row skipped.`,
        });
        continue;
      }

      const o = (opening as number | null) ?? existing.opening;
      const i = (inward as number | null) ?? existing.inward;
      const out = (outward as number | null) ?? existing.outward;
      let c = closing as number | null;

      // Blank CLOSING with the other three present — compute it. §8
      if (c === null) c = o + i - out;
      else if (c !== o + i - out) {
        result.warnings.push({
          row: lineNo,
          message: `${code}: CLOSING ${c.toLocaleString("en-IN")} does not equal OPENING + INWARD − OUTWARD (${(o + i - out).toLocaleString("en-IN")}). CLOSING used as given.`,
        });
      }

      next[code] = { ...existing, opening: o, inward: i, outward: out, closing: c };
      result.updated++;
    }

    result.next = next;
    result.ok = result.updated > 0 || result.errors.length === 0;
    return result;
  } catch (err) {
    result.errors.push({
      row: null,
      message: `Could not read the file: ${err instanceof Error ? err.message : String(err)}`,
    });
    return result;
  }
}

export function importSummary(r: ImportResult): string {
  return `Updated ${r.updated.toLocaleString("en-IN")} of ${r.known.toLocaleString("en-IN")} components. ${r.unrecognised.length.toLocaleString("en-IN")} ${r.unrecognised.length === 1 ? "code" : "codes"} not recognised.`;
}
