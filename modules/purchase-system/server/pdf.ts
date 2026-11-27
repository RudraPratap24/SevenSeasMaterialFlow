/**
 * PO PDF in the company format (the script's poPdfHtml_): purple band with logo, PO no. and dates, buyer, vendor /
 * ship-to boxes, requisitioner row, items, comments + terms, tax rows and total in words, approval, then each item's
 * photo with its specification (Guidelines). ECOMMERCE-only POs are on the Delhi entity, everything else Haryana.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { CFG, diffDays, entityOf, fmt, key, money, r2, str, taxSplit, taxType, words, type Item, type PoRec } from "./core";
import type { Vendor } from "./store";

const PUR = "#3b1670", GOLD = "#f5b82e", LINE = "#cfc3e4", MUT = "#5b4a78", INK = "#241038";
const asset = (f: string) => readFileSync(path.resolve(process.cwd(), "modules/purchase-system/server/assets", f));

function specFor(it: Item | undefined, guides: { type: string; spec: string }[]): { type: string; specs: string[] } {
  if (!it) return { type: "", specs: [] };
  const g: Record<string, { type: string; specs: string[] }> = {};
  for (const x of guides) (g[key(x.type)] ??= { type: x.type, specs: [] }).specs.push(x.spec);
  let hit = [it.pt, it.t, it.c].map(key).filter(Boolean).map((k) => g[k]).find(Boolean);
  if (!hit) {
    const nm = " " + str(it.n).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    hit = Object.values(g).find((x) => nm.includes(" " + x.type.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " "));
  }
  return hit || { type: "", specs: [] };
}

export async function poPdf(
  rec: PoRec,
  o: { vendor: Vendor; im: Record<string, Item>; guides: { type: string; spec: string }[]; photo: (id: string, big: boolean) => Promise<string> },
): Promise<Buffer> {
  const lines = rec.lines.filter((l) => l.name || l.code);
  const E = entityOf(lines, false), C = { ...CFG.COMPANY, ...E };
  const v = o.vendor;
  const sub = lines.reduce((a, l) => a + (l.amount || r2(l.qty * l.rate)), 0), gst = lines.reduce((a, l) => a + l.gstAmt, 0), total = r2(sub + gst);
  const inds = Array.from(new Set(lines.map((l) => l.ind).filter((x) => /IND/i.test(x)))).join(", ");
  const lead = rec.lead !== "" ? rec.lead : rec.pd && rec.ed ? diffDays(rec.ed, rec.pd) : "";
  const terms = str((rec.rem.match(/Terms: ([^|]+)/) || [])[1]) || v.terms || "";
  const remark = rec.rem ? str(rec.rem.replace(/Terms: [^|]+\|?/, "")) : "";
  const N = lines.length, FS = N <= 4 ? 8.5 : N <= 8 ? 7.8 : 7.2, SM = FS - 1;

  const doc = new PDFDocument({ size: "A4", margin: 26, info: { Title: "Purchase Order " + rec.po } });
  const done = new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
  const X = doc.page.margins.left, W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = doc.page.margins.top;
  const room = (h: number) => {
    if (y + h > doc.page.height - doc.page.margins.bottom - 16) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };
  const txt = (t: string, x: number, yy: number, w: number, opt: { size?: number; bold?: boolean; color?: string; align?: "left" | "right" | "center" } = {}) => {
    doc.font(opt.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opt.size ?? FS).fillColor(opt.color ?? INK).text(t, x, yy, { width: w, align: opt.align ?? "left" });
    return doc.heightOfString(t, { width: w });
  };
  const hOf = (t: string, w: number, size = FS, bold = false) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).heightOfString(t || " ", { width: w });

  // ── purple band: logo · PURCHASE ORDER · PO no.
  doc.rect(X, y, W, 48).fill(PUR);
  try {
    doc.image(asset("logo-pdf.jpg"), X + 8, y + 6, { height: 36 });
  } catch {
    /* logo file missing: band without it */
  }
  txt("PURCHASE ORDER", X, y + 10, W - 12, { size: 16, bold: true, color: GOLD, align: "right" });
  txt(rec.po, X, y + 30, W - 12, { size: 10, bold: true, color: "#ffffff", align: "right" });
  y += 48;
  doc.rect(X, y, W, 3).fill(GOLD);
  y += 9;

  // ── buyer (left) + PO facts (right)
  const leftW = W * 0.6;
  const buyer = C.address + "\nContact: " + C.phone + " · Email: " + C.email + "\nGSTIN: " + C.gstin;
  txt(C.poCompany, X, y, leftW, { size: FS + 2.5, bold: true });
  const by0 = y + hOf(C.poCompany, leftW, FS + 2.5, true);
  const bh = txt(buyer, X, by0, leftW);
  const facts: [string, string][] = [["PO #", rec.po], ["DATE", fmt(rec.pd)], ["DELIVERY DATE", fmt(rec.ed)], ["LEAD TIME", lead === "" ? "" : lead + " days"]];
  let fy = y;
  const fx = X + leftW + 10, fw = W - leftW - 10;
  for (const [k, val] of facts) {
    txt(k, fx, fy + 3, fw * 0.42 - 4, { size: SM, color: MUT, align: "right" });
    doc.rect(fx + fw * 0.42, fy, fw * 0.58, 15).lineWidth(0.6).stroke(LINE);
    txt(val, fx + fw * 0.42 + 4, fy + 3, fw * 0.58 - 8, { bold: k === "PO #" || k === "DELIVERY DATE" });
    fy += 16;
  }
  y = Math.max(by0 + bh, fy) + 8;

  // ── vendor · ship to
  const vRows = [v.contact && "Attn: " + v.contact, v.address, v.phone && "Phone: " + v.phone, v.email && "Email: " + v.email, v.gstin && "GSTIN: " + v.gstin,
    v.udyam && "Udyam: " + v.udyam, (v.acc || v.bank) && "Bank: " + [v.bank, v.acc && "A/c " + v.acc, v.ifsc && "IFSC " + v.ifsc].filter(Boolean).join(" · ")].filter(Boolean) as string[];
  const boxW = (W - 10) / 2;
  const vendorBody = [v.n, ...vRows].join("\n"), shipBody = [C.poCompany, C.address, "Contact: " + C.phone, "GSTIN: " + C.gstin].join("\n");
  const boxH = Math.max(hOf(vendorBody, boxW - 12), hOf(shipBody, boxW - 12)) + 22;
  room(boxH);
  for (const [i, title, body] of [[0, "VENDOR" + (v.code ? " · " + v.code : ""), vendorBody], [1, "SHIP TO", shipBody]] as [number, string, string][]) {
    const bx = X + i * (boxW + 10);
    doc.rect(bx, y, boxW, boxH).lineWidth(0.6).stroke(LINE);
    doc.rect(bx, y, boxW, 13).fill(PUR);
    txt(title, bx + 6, y + 3, boxW - 12, { size: SM, bold: true, color: "#ffffff" });
    const [first, ...rest] = body.split("\n");
    const h1 = txt(first, bx + 6, y + 17, boxW - 12, { bold: true });
    txt(rest.join("\n"), bx + 6, y + 17 + h1, boxW - 12);
  }
  y += boxH + 8;

  // ── table helper
  const table = (cols: { h: string; w: number; a?: "left" | "right" | "center" }[], data: string[][], boldCol = -1) => {
    const ws = cols.map((c) => c.w * W);
    room(16);
    doc.rect(X, y, W, 13).fill(PUR);
    let cx = X;
    cols.forEach((c, i) => {
      txt(c.h, cx + 3, y + 3, ws[i] - 6, { size: SM, bold: true, color: "#ffffff", align: c.a });
      cx += ws[i];
    });
    y += 13;
    for (const row of data) {
      const h = Math.max(...row.map((t, i) => hOf(t, ws[i] - 6, FS, i === boldCol))) + 6;
      room(h);
      cx = X;
      row.forEach((t, i) => {
        txt(t, cx + 3, y + 3, ws[i] - 6, { bold: i === boldCol, align: cols[i].a });
        cx += ws[i];
      });
      y += h;
      doc.moveTo(X, y).lineTo(X + W, y).lineWidth(0.5).stroke(LINE);
    }
    y += 8;
  };
  table([{ h: "REQUISITIONER", w: 0.25 }, { h: "INDENT NO.", w: 0.25 }, { h: "PAYMENT TERMS", w: 0.25 }, { h: "PREPARED BY", w: 0.25 }],
    [[rec.reqBy || "", inds, terms, rec.doer]]);
  table(
    [{ h: "#", w: 0.04, a: "center" }, { h: "VENDOR ITEM NAME", w: 0.16 }, { h: "DESCRIPTION", w: 0.25 }, { h: "HSN", w: 0.07 }, { h: "QTY", w: 0.08, a: "right" },
      { h: "UNIT", w: 0.06 }, { h: "RATE (Rs)", w: 0.09, a: "right" }, { h: "GST %", w: 0.06, a: "right" }, { h: "TAX (Rs)", w: 0.09, a: "right" }, { h: "TAXABLE (Rs)", w: 0.1, a: "right" }],
    lines.map((l, i) => [String(i + 1), l.vitem || "-", l.name + (l.code && key(l.code) !== key(l.name) ? " (" + l.code + ")" : ""), l.hsn === "-" ? "" : l.hsn,
      money(l.qty).replace(/\.00$/, ""), l.unit, money(l.rate), l.gst === "" ? "" : l.gst + "%", money(l.gstAmt), money(l.amount || l.qty * l.rate)]),
    2,
  );

  // ── comments + terms (left) · tax rows, total, words, approval (right)
  const type = rec.taxType || taxType(v, E), byRate: Record<number, { amt: number; tax: number }> = {};
  lines.forEach((l) => {
    const g = l.gst === "" ? 0 : Number(l.gst);
    byRate[g] ??= { amt: 0, tax: 0 };
    byRate[g].amt += l.amount || r2(l.qty * l.rate);
    byRate[g].tax += l.gstAmt;
  });
  const tax: [string, string][] = [["SUBTOTAL (taxable)", money(sub)]];
  Object.keys(byRate).map(Number).sort((a, b) => a - b).forEach((g) => {
    if (!g) return;
    if (type === "IGST") tax.push(["IGST @ " + g + "%", money(byRate[g].tax)]);
    else {
      const h = taxSplit(byRate[g].tax, type);
      tax.push(["CGST @ " + g / 2 + "%", money(h.cgst)], ["SGST @ " + g / 2 + "%", money(h.sgst)]);
    }
  });
  tax.push(["TOTAL TAX", money(gst)]);
  const lw = W * 0.56, rx = X + lw + 10, rw = W - lw - 10;
  const termsText = (remark ? remark + "\n" : "") + CFG.PO_TERMS.map((t, i) => i + 1 + ". " + t).join("\n");
  const leftH = 14 + hOf(termsText, lw - 12, SM) + 8;
  const rightH = tax.length * 13 + 18 + 30 + 30;
  room(Math.max(leftH, rightH));
  doc.rect(X, y, lw, 13).fill(PUR);
  txt("COMMENTS OR SPECIAL INSTRUCTIONS", X + 6, y + 3, lw - 12, { size: SM, bold: true, color: "#ffffff" });
  doc.rect(X, y + 13, lw, leftH - 13).lineWidth(0.6).stroke(LINE);
  txt(termsText, X + 6, y + 17, lw - 12, { size: SM });
  let ty = y;
  for (const [k, val] of tax) {
    txt(k, rx, ty + 2, rw * 0.58, { align: "right" });
    txt(val, rx + rw * 0.58, ty + 2, rw * 0.42 - 4, { align: "right" });
    doc.moveTo(rx + rw * 0.58, ty + 13).lineTo(rx + rw, ty + 13).lineWidth(0.5).stroke(LINE);
    ty += 13;
  }
  doc.rect(rx, ty + 2, rw, 16).fill(GOLD);
  txt("TOTAL (Rs)", rx, ty + 6, rw * 0.58, { size: FS + 1.5, bold: true, align: "right" });
  txt(money(total), rx + rw * 0.58, ty + 6, rw * 0.42 - 4, { size: FS + 1.5, bold: true, align: "right" });
  ty += 22;
  ty += txt(words(total), rx, ty, rw, { size: SM, align: "right" }) + 6;
  const appr = rec.appr === "APPROVED" ? "APPROVED" + (rec.by ? " by " + rec.by : "") + (rec.at ? " on " + fmt(rec.at, "dd/MM/yyyy") : "")
    : rec.appr === "CANCELLED" ? "CANCELLED" : "APPROVAL PENDING – not valid until approved";
  ty += txt(appr, rx, ty, rw, { bold: true, color: rec.appr === "APPROVED" ? "#165c2c" : "#a12a36", align: "right", size: rec.appr === "CANCELLED" ? FS + 3 : FS });
  ty += txt("Authorised signatory · " + C.poCompany, rx, ty + 2, rw, { size: SM, color: MUT, align: "right" });
  y = Math.max(y + leftH, ty) + 10;

  // ── item photo + specification
  const pics: { id: string; n: number; name: string; spec: { type: string; specs: string[] } }[] = [], seen = new Set<string>();
  lines.forEach((l, i) => {
    const it = o.im[l.name.toLowerCase()];
    if (!it || !it.ph || seen.has(it.ph)) return;
    seen.add(it.ph);
    pics.push({ id: it.ph, n: i + 1, name: l.name, spec: specFor(it, o.guides) });
  });
  if (pics.length) {
    room(30);
    doc.rect(X, y, W, 13).fill(PUR);
    txt("ITEM PHOTO & SPECIFICATION – MATCH THE SUPPLY WITH THESE", X + 6, y + 3, W - 12, { size: SM, bold: true, color: "#ffffff" });
    y += 17;
    const size = 110, colW = (W - 10) / 2;
    let col = 0, rowH = 0;
    for (const p of pics) {
      const src = await o.photo(p.id, true);
      const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(src);
      if (!m) continue;
      if (col === 0) room(size + 24);
      const cx = X + col * (colW + 10);
      txt(p.n + ". " + p.name, cx, y, colW, { size: SM, bold: true });
      doc.rect(cx, y + 12, size, size).lineWidth(0.6).stroke(LINE);
      try {
        doc.image(Buffer.from(m[2], "base64"), cx + 3, y + 15, { fit: [size - 6, size - 6], align: "center", valign: "center" });
      } catch {
        /* unreadable image: frame stays empty */
      }
      const specTxt = p.spec.specs.length ? p.spec.specs.map((s) => "• " + s).join("\n") : "No specification in the Guidelines sheet for this product type.";
      txt("SPECIFICATION" + (p.spec.type ? " – " + p.spec.type : ""), cx + size + 8, y + 12, colW - size - 8, { size: SM, bold: true, color: PUR });
      doc.save();
      doc.rect(cx + size + 8, y + 22, colW - size - 8, size - 10).clip();
      txt(specTxt, cx + size + 8, y + 22, colW - size - 8, { size: SM, color: p.spec.specs.length ? INK : MUT });
      doc.restore();
      rowH = Math.max(rowH, size + 18);
      col++;
      if (col === 2) {
        col = 0;
        y += rowH;
        rowH = 0;
      }
    }
    if (col) y += rowH;
  }

  // ── footer
  room(20);
  doc.moveTo(X, y + 4).lineTo(X + W, y + 4).lineWidth(1.5).stroke(GOLD);
  txt("Questions about this purchase order? Contact " + C.email + " · " + C.phone, X, y + 8, W, { size: SM, color: MUT, align: "center" });
  doc.end();
  return done;
}
