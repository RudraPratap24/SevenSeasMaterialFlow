/**
 * The sheet's copies → one record per fact. Used by migration 44 (on the tables as first imported) and by the importer
 * (on a fresh export of the sheet), so both give the same result.
 *   FMS line vs PO-sheet row:  the FMS value wins (item code, qty, rate, value → total)
 *   PO header:                 the rule the page always used (first PO row; approval by precedence; first PDF)
 *   Indent-sheet row:          joined to its line (same item, timestamp within 1 s, nearest); the FMS wins, an empty
 *                              FMS value is filled from the Indent sheet; Indent-only fields move onto the line
 * Every value not kept is returned as an audit row (ps_import_audit), so nothing is lost.
 */
import { normPo } from "./core";

export type Rec = Record<string, unknown>;

const txt = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v));
export const same = (a: unknown, b: unknown) => {
  if (txt(a) === txt(b)) return true;
  const x = Number(a), y = Number(b);
  return txt(a) !== "" && txt(b) !== "" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-6;
};
const empty = (v: unknown) => txt(v).trim() === "";

/**
 * lines:      FMS lines with their PO copies (line_id, po_no, item_code, qty, rate, value, vendor, po_date, edd, pdf, lead_days, ts, item, indent_no, party …)
 * poRows:     PO-sheet rows (unmatched = 1: a row no FMS line matched); `id` = the row's place in the sheet
 * indentRows: Indent-sheet rows; `id` = the row's place in the sheet
 */
export function oneRecordPerFact(lines: Rec[], poRows: Rec[], indentRows: Rec[]) {
  const audits: Rec[] = [];
  const note = (sheet: string, ref: string, field: string, kept: unknown, other: unknown, why: string) =>
    audits.push({ sheet, ref: ref.slice(0, 160), field, kept: txt(kept), other: txt(other), note: why });
  const byLine = new Map(lines.map((l) => [String(l.line_id), l]));

  /* PO headers */
  const heads = new Map<string, Rec>();
  for (const r of poRows) {
    if (Number(r.unmatched)) {
      note("PO", `${txt(r.po_no)} row ${txt(r.id)}`, "row", "", JSON.stringify(r), "PO-sheet row that matches no FMS line (not used)");
      continue;
    }
    const k = normPo(r.po_no);
    if (!k) continue;
    let h = heads.get(k);
    if (!h) {
      h = { po_no: r.po_no, po_date: r.po_date, edd: r.edd, company: r.company, vendor: r.vendor, vendor_code: r.vendor_code, doer: r.doer, remarks: r.remarks,
        tax_type: "", lead_days: "", pdf: "", approval: "", approved_by: "", approved_at: null, ...(r.created_at ? { created_at: r.created_at } : {}) };
      heads.set(k, h);
    } else {
      for (const f of ["po_date", "edd", "company", "vendor", "vendor_code", "doer", "remarks"]) {
        if (!same(h[f], r[f]) && !empty(r[f])) note("PO", `${txt(r.po_no)} row ${txt(r.id)}`, f, h[f], r[f], "PO header: first row kept");
      }
    }
    if (!h.tax_type && !empty(r.tax_type)) h.tax_type = r.tax_type;
    if (txt(h.lead_days) === "" && txt(r.lead_days) !== "") h.lead_days = txt(r.lead_days);
    if (!h.pdf && !empty(r.pdf)) h.pdf = r.pdf;
    else if (!empty(r.pdf) && !same(h.pdf, r.pdf)) note("PO", `${txt(r.po_no)} row ${txt(r.id)}`, "pdf", h.pdf, r.pdf, "PO header: first PDF kept");
    const a = txt(r.approval).toUpperCase();
    if (a && (!h.approval || a === "CANCELLED" || (a === "APPROVED" && h.approval !== "CANCELLED"))) h.approval = a;
    if (!h.approved_by && !empty(r.approved_by)) {
      h.approved_by = r.approved_by;
      h.approved_at = r.approved_at;
    }
  }

  /* PO lines: the PO row, with the FMS line's values where the line still points at this PO */
  const poLines: Rec[] = [];
  for (const r of poRows) {
    if (Number(r.unmatched)) continue;
    const h = heads.get(normPo(r.po_no));
    if (!h) continue;
    const l = r.line_id ? byLine.get(String(r.line_id)) : undefined;
    if (r.line_id && !l) note("PO", `${txt(r.po_no)} row ${txt(r.id)}`, "line_id", "", r.line_id, "line id not in the FMS (kept without a line)");
    const v: Rec = {
      po_no: h.po_no, line_id: l ? r.line_id : null, item_code: r.item_code, item_name: r.item_name, vendor_item: r.vendor_item, hsn: r.hsn, qty: r.qty, unit: r.unit,
      rate: r.rate, gst: r.gst, gst_amt: r.gst_amt, cgst: r.cgst, sgst: r.sgst, igst: r.igst, amount: r.amount, total: r.total, indent_no: r.indent_no,
    };
    if (l && normPo(l.po_no) === normPo(r.po_no)) {
      for (const [lf, pf] of [["item_code", "item_code"], ["qty", "qty"], ["rate", "rate"], ["value", "total"]]) {
        if (empty(l[lf]) || same(l[lf], v[pf])) continue;
        note("PO", `${txt(r.po_no)} / ${txt(l.line_id)}`, pf, l[lf], v[pf], "FMS value kept");
        v[pf] = l[lf];
      }
      // the line's copies of PO-level values: the header is the one record
      for (const lf of ["po_date", "edd", "vendor", "pdf", "lead_days"]) {
        if (!empty(l[lf]) && !same(l[lf], h[lf]) && !same(l[lf], r[lf])) note("FMS", txt(l.line_id), lf, h[lf], l[lf], "PO header value kept (one per PO)");
      }
    }
    poLines.push(v);
  }

  /* Indent sheet → its line */
  const lineSets = new Map<string, Rec>();
  const taken = new Set<string>();
  const secs = (v: unknown) => (v instanceof Date ? Math.round(v.getTime() / 1000) : NaN);
  const byItem = new Map<string, Rec[]>();
  for (const l of lines) byItem.set(txt(l.item).toLowerCase(), [...(byItem.get(txt(l.item).toLowerCase()) ?? []), l]);
  for (const i of indentRows) {
    const t = secs(i.ts);
    const l = (byItem.get(txt(i.item).toLowerCase()) ?? [])
      .filter((x) => !taken.has(String(x.line_id)) && Math.abs(secs(x.ts) - t) <= 1)
      .sort((a, b) => Math.abs(secs(a.ts) - t) - Math.abs(secs(b.ts) - t))[0];
    if (!l) {
      note("Indent", `${txt(i.indent_no)} row ${txt(i.id)}`, "row", "", JSON.stringify(i), "Indent-sheet row with no FMS line left to match");
      continue;
    }
    taken.add(String(l.line_id));
    const set: Rec = {
      in_register: 1, register_no: same(i.indent_no, l.indent_no) ? "" : i.indent_no, origin: i.origin, image_url: i.image_url, submitted_by: i.submitted_by,
      email_status: i.email_status, category: i.category, item_type: i.item_type, sku: i.sku, brand: i.brand, designer_status: i.designer_status,
      designer_at: i.designer_at, designer_image: i.designer_image, mrp: i.mrp, mrp_date: i.mrp_date,
    };
    for (const [lf, inf] of [["party", "party"], ["urgency", "urgency"], ["filled_by", "filled_by"], ["remark", "remarks"], ["indent_qty", "qty"], ["unit", "unit"], ["po_no", "po_no"]]) {
      if (empty(i[inf]) || same(l[lf], i[inf])) continue;
      if (empty(l[lf]) && lf !== "po_no") set[lf] = i[inf]; // the FMS had nothing here
      else note("Indent", `${txt(l.line_id)} (${txt(i.indent_no)})`, lf, l[lf], i[inf], "FMS value kept");
    }
    lineSets.set(String(l.line_id), set);
  }

  return { pos: [...heads.values()], poLines, lineSets, audits };
}
