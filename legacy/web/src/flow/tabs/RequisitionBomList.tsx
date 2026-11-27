import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { planMaterials, type PlanMaterial } from "../logic";
import { todayLabel, useFlow } from "../store";
import { Card, DateInput, EmptyNote, Table, Td, Tr, fmt } from "../ui";
import { PmRequirementTable, iso } from "./ProductionPlanning";

interface PlanLine {
  productName: string;
  targetQty: number;
}

interface BomDoc {
  bomNo: string;
  planDate: string;
  createdAt: string;
  createdBy: string;
  /** true: the plan is unchanged since this document was made — same number again */
  reused: boolean;
  materials: PlanMaterial[];
}

const esc = (v: string | number) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The printable BOM list; the browser's print dialog saves it as the PDF. */
function bomHtml(d: BomDoc): string {
  const at = new Date(d.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  const rows = d.materials
    .map(
      (m) => `<tr${m.short ? ' class="short"' : ""}><td>${esc(m.name)}</td><td class="n">${fmt(m.required)}</td><td class="n">${fmt(m.present)}</td>` +
        `<td class="n">${m.short ? fmt(m.short) : "—"}</td><td>${m.short ? "SHORT" : "Available"}</td><td>${esc(m.skus.join(", "))}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.bomNo)}</title><style>
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1c2533;margin:40px}
    .n{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
    h1{text-align:center;letter-spacing:.04em;font-size:22px;margin:0 0 6px}
    .meta{text-align:center;font-size:14px;margin:2px 0}
    h2{text-align:center;letter-spacing:.14em;font-size:13px;margin:28px 0 8px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{border:1px solid #1c2533;border-bottom-width:2px;color:#5b6575;font-weight:600;letter-spacing:.06em;font-size:10.5px;padding:8px 4px;text-transform:uppercase}
    td{border:1px solid #d5dbe3;padding:7px 6px;text-align:center}
    tr.short td{background:#fdecec}
    @page{margin:12mm}
    @media print{body{margin:0}tr.short td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body>
    <h1>PM REQUIREMENT — BOM</h1>
    <p class="meta">Document no <b class="n">${esc(d.bomNo)}</b> · generated <span class="n">${stamp}</span></p>
    <p class="meta" style="font-size:12.5px">Plan date ${esc(d.planDate)} · by ${esc(d.createdBy)}</p>
    <h2>CONSOLIDATED PM REQUIREMENT</h2>
    <table><thead><tr><th>PM required item name</th><th>Total required qty</th><th>Available qty</th><th>Short by</th><th>Status</th><th>Used in SKUs</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </body></html>`;
}

/**
 * Requisition BOM list: a day's saved plan, the PM it needs per SKU and in total. "Generate PDF" freezes it under a
 * BOM number (the BOM issue slip finds it by that number) and opens it for printing / saving as PDF.
 */
export function RequisitionBomList() {
  const { masters, pmStock, openBoms, reloadReservations } = useFlow();
  const { can } = useAuth();
  const [date, setDate] = useState(todayLabel());
  const [lines, setLines] = useState<PlanLine[] | null>(null);
  const [loadedFor, setLoadedFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef("");

  const skuOf = (name: string) => masters.productByName.get(name)?.fg ?? "";

  async function load(d: string) {
    latest.current = d;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ plan: { lines: PlanLine[] } | null }>("GET", `/production-plans/${iso(d)}`);
      if (latest.current !== d) return; // a newer date was picked meanwhile
      setLines(r.plan?.lines ?? null);
      setLoadedFor(d);
      setMessage(r.plan ? { text: `Plan for ${d} — ${r.plan.lines.length} product(s)`, error: false } : { text: `No plan saved for ${d}.`, error: true });
    } catch (e) {
      if (latest.current === d) setMessage({ text: (e as Error).message, error: true });
    } finally {
      if (latest.current === d) setBusy(false);
    }
  }

  useEffect(() => {
    if (date) void load(date);
  }, [date]);

  async function generate() {
    // opened on the click itself, so the browser does not block it as a pop-up
    const w = window.open("", "_blank");
    if (!w) {
      setMessage({ text: "The browser blocked the PDF window — allow pop-ups for this site.", error: true });
      return;
    }
    w.document.write("<p style='font-family:sans-serif'>Generating…</p>");
    setBusy(true);
    setMessage(null);
    try {
      const { doc } = await api<{ doc: BomDoc }>("POST", "/production-boms", { planDate: iso(loadedFor) });
      w.document.open();
      w.document.write(bomHtml(doc));
      w.document.close();
      w.focus();
      w.print();
      void reloadReservations(); // this list now holds its stock
      setMessage({ text: doc.reused ? `${doc.bomNo} (plan unchanged — same BOM number).` : `${doc.bomNo} generated.`, error: false });
    } catch (e) {
      w.close();
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const planLines = lines ?? [];
  const materials = useMemo(
    () =>
      planMaterials(planLines.map((l) => ({ productName: l.productName, qty: l.targetQty })), masters.bomOf, skuOf, pmStock, {
        open: openBoms,
        planDate: iso(loadedFor || date),
      }),
    [lines, masters, pmStock, openBoms, loadedFor, date],
  );

  return (
    <div className="space-y-3">
      <Card
        title="Requisition BOM list"
        right={
          <>
            <button className="btn h-8" onClick={() => void load(date)} disabled={busy || !date} title="Read the plan again (if it was edited meanwhile)">
              Refresh
            </button>
            {can("production.bom") && (
              <button className="btn btn-primary h-8" onClick={() => void generate()} disabled={busy || planLines.length === 0}>
                Generate PDF
              </button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
          <label className="flex items-center gap-2 font-semibold">
            Plan date
            <DateInput
              value={date}
              onChange={(v) => {
                setDate(v);
                setLines(null); // a list from another date must not be printed under this one
                setMessage(null);
              }}
              ariaLabel="Plan date"
            />
          </label>
          {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
        </div>
        {planLines.length === 0 ? (
          <EmptyNote>{busy ? "Loading…" : "No plan for this date — save one in Production Planning."}</EmptyNote>
        ) : (
          <Table minWidth={700} headers={["#", "SKU code", "Product", { label: "Qty to be made (pcs)", align: "right" }, { label: "PM items", align: "right" }]}>
            {planLines.map((l, i) => (
              <Tr key={i} zebra={i % 2 === 1}>
                <Td num muted>{i + 1}</Td>
                <Td num strong>{skuOf(l.productName) || "—"}</Td>
                <Td>{l.productName}</Td>
                <Td right num>{fmt(l.targetQty)}</Td>
                <Td right num strong>{masters.bomOf(l.productName).length}</Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>

      {planLines.length > 0 && (
        <>
          <Card title="Consolidated PM requirement" role={`${materials.length} PM items`}>
            {materials.length === 0 ? <EmptyNote>These products have no BOM lines.</EmptyNote> : <PmRequirementTable materials={materials} />}
          </Card>

          <Card title="SKU-wise detail">
            <Table
              minWidth={800}
              headers={["SKU code", { label: "Qty to be made (pcs)", align: "right" }, "PM required item name", { label: "Qty per 100 pcs", align: "right" }, { label: "Required qty", align: "right" }]}
            >
              {planLines.flatMap((l, i) =>
                masters.bomOf(l.productName).map((b) => (
                  <Tr key={`${i}-${b.c}`} zebra={i % 2 === 1}>
                    <Td num strong>{skuOf(l.productName) || l.productName}</Td>
                    <Td right num>{fmt(l.targetQty)}</Td>
                    <Td>
                      {b.n} <span className="num text-muted">{b.c}</span>
                    </Td>
                    <Td right num>{b.p.toLocaleString("en-IN", { maximumFractionDigits: 3 })}</Td>
                    <Td right num>{fmt(Math.ceil((l.targetQty * b.p) / 100 - 1e-9))}</Td>
                  </Tr>
                )),
              )}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
