import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { todayLabel } from "../store";
import { Card, DateInput, SearchPicker, TextInput } from "../ui";
import { downloadXlsx } from "../xlsx";
import { type BulkItem, type BulkUnit, UnitSelect, bulkUnitOf, perUnit, unitLabel } from "./BulkProductionPlan";
import { iso } from "./ProductionPlanning";

/** One report row as typed (numbers kept as text until saved). */
interface Row {
  itemName: string;
  unit: BulkUnit;
  shade: string;
  orderDate: string; // dd-mm-yyyy
  responsible: string;
  batchSize: string;
  actualQty: string;
  mfgBy: string;
  remark: string;
}

type Num = number | null;
interface Saved {
  finalAt: string;
  finalBy: string;
  savedBy: string;
  savedAt: string;
  lines: (Omit<Row, "batchSize" | "actualQty"> & { batchSize: Num; actualQty: Num })[];
}

const blank = (): Row => ({ itemName: "", unit: "KG", shade: "", orderDate: "", responsible: "", batchSize: "", actualQty: "", mfgBy: "", remark: "" });
const str = (v: Num) => (v === null ? "" : String(v));
const num = (v: string): Num => (v.trim() === "" ? null : Number(v));
const when = (isoTime: string) => new Date(isoTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
/** Actual ÷ batch size, one decimal; none without a batch size. */
export const bulkAchievement = (batchSize: Num, actual: Num) => (batchSize && actual !== null ? Math.round((actual / batchSize) * 1000) / 10 : null);

// shortcut: fixed list of bulk responsible persons; any other name can be typed
const PEOPLE = ["SANTOSH", "DEEPAK", "BHARAT", "BHOPAL"].map((value) => ({ value }));
const HEADERS = [
  "#", "Product name (pick or type)", "Unit", "Shade / colour", "Order date", "Responsible person", "Batch size (Kg/L)",
  "Total batch qty (actual)", "Mfg by", "Achievement % (vs plan)", "Remark",
];
const esc = (v: string | number) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Bulk manufacturing report: the actual bulk made on a day, started from that day's bulk plan. Saved as a draft any
 * number of times; final submit locks the date — the actual qty then waits for Quality Testing.
 */
export function BulkManufacturing() {
  const { can } = useAuth();
  const mayEdit = can("production.report");
  const [date, setDate] = useState(todayLabel());
  const [rows, setRows] = useState<Row[]>([]);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [fromPlan, setFromPlan] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef("");
  const locked = Boolean(saved?.finalAt) || !mayEdit;

  async function load(d: string, keepMessage = false) {
    latest.current = d;
    setLoading(true);
    if (!keepMessage) setMessage(null);
    try {
      const r = await api<{ items: BulkItem[]; report: Saved | null; plan: { itemName: string; unit: BulkUnit; qty: number }[] }>(
        "GET",
        `/bulk-reports/${iso(d)}`,
      );
      if (latest.current !== d) return; // a newer date was picked meanwhile
      setItems(r.items);
      setSaved(r.report);
      setFromPlan(r.report ? 0 : r.plan.length);
      setRows(
        r.report
          ? r.report.lines.map((l) => ({ ...l, batchSize: str(l.batchSize), actualQty: str(l.actualQty) }))
          : r.plan.length
            ? r.plan.map((p) => ({ ...blank(), itemName: p.itemName, unit: p.unit, batchSize: String(p.qty) }))
            : Array.from({ length: 5 }, blank),
      );
    } catch (e) {
      if (latest.current === d) setMessage({ text: (e as Error).message, error: true });
    } finally {
      if (latest.current === d) setLoading(false);
    }
  }

  useEffect(() => {
    if (date) void load(date);
  }, [date]);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const options = useMemo(() => items.map((x) => ({ value: x.name, hint: unitLabel(x.unit) })), [items]);
  const filled = rows.filter((r) => r.itemName.trim() !== "");
  const notReady = filled.some((r) => num(r.actualQty) === null || !r.responsible.trim());
  const total = (k: "batchSize" | "actualQty") => perUnit(filled.map((r) => ({ unit: r.unit, qty: num(r[k]) ?? 0 })));

  async function save(final: boolean) {
    if (final && !window.confirm(`Final submit the bulk report of ${date}? It cannot be changed afterwards, and the actual qty goes to Quality Testing.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/bulk-reports/${iso(date)}`, {
        final,
        lines: filled.map((r) => ({
          itemName: r.itemName.trim(),
          unit: r.unit,
          shade: r.shade.trim(),
          orderDate: r.orderDate ? iso(r.orderDate) : "",
          responsible: r.responsible.trim(),
          batchSize: num(r.batchSize),
          actualQty: num(r.actualQty),
          mfgBy: r.mfgBy.trim(),
          remark: r.remark.trim(),
        })),
      });
      await load(date, true);
      setMessage({ text: final ? `Bulk report of ${date} final-submitted — sent to Quality Testing.` : `Bulk report of ${date} saved.`, error: false });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  /** The table as plain values — shared by the Excel and the PDF. */
  const exportRows = (): (string | number | null)[][] => [
    HEADERS,
    ...filled.map((r, i) => {
      const a = bulkAchievement(num(r.batchSize), num(r.actualQty));
      return [i + 1, r.itemName, unitLabel(r.unit), r.shade, r.orderDate, r.responsible, num(r.batchSize), num(r.actualQty), r.mfgBy, a === null ? "" : `${a}%`, r.remark];
    }),
    ["TOTAL", `${filled.length} row(s)`, "", "", "", "", total("batchSize"), total("actualQty"), "", "", ""],
  ];
  const fileName = `Bulk Manufacturing Report (${iso(date)})`;

  function pdf() {
    const w = window.open("", "_blank");
    if (!w) {
      setMessage({ text: "The browser blocked the PDF window — allow pop-ups for this site.", error: true });
      return;
    }
    const [head, ...body] = exportRows();
    const status = saved?.finalAt ? `Final submitted ${when(saved.finalAt)} by ${saved.finalBy}` : "Draft — not final submitted";
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
      body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1c2533;margin:24px}
      h1{text-align:center;font-size:20px;letter-spacing:.04em;margin:0 0 4px}
      .meta{text-align:center;font-size:12.5px;margin:2px 0 14px}
      table{width:100%;border-collapse:collapse;font-size:10.5px}
      th{border:1px solid #1c2533;background:#1c2533;color:#fff;font-weight:600;padding:5px 3px;font-size:9.5px}
      td{border:1px solid #d5dbe3;padding:4px 3px;text-align:center}
      tr:last-child td{font-weight:700;background:#f3f5f8;border-top:2px solid #1c2533}
      @page{size:A4 landscape;margin:8mm}
      @media print{body{margin:0}th,tr:last-child td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
    </style></head><body>
      <h1>BULK MANUFACTURING REPORT</h1>
      <p class="meta">Date <b>${esc(date)}</b> · ${esc(status)}</p>
      <table><thead><tr>${head.map((h) => `<th>${esc(h ?? "")}</th>`).join("")}</tr></thead>
      <tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c === null ? "" : esc(typeof c === "number" ? c.toLocaleString("en-IN") : c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  const td = "border-b border-r border-rule px-1 py-1 align-middle";
  const text = (i: number, k: "shade" | "mfgBy" | "remark", label: string) => (
    <TextInput value={rows[i][k]} onChange={(v) => set(i, { [k]: v })} ariaLabel={`${label}, row ${i + 1}`} />
  );
  const numIn = (i: number, k: "batchSize" | "actualQty", label: string) => (
    <TextInput numeric value={rows[i][k]} onChange={(v) => set(i, { [k]: v })} placeholder="" ariaLabel={`${label}, row ${i + 1}`} />
  );

  return (
    <Card
      title="Bulk manufacturing"
      step={saved?.finalAt ? "FINAL · TO QUALITY TESTING" : saved ? "DRAFT SAVED" : "NEW"}
      right={
        <>
          {!locked && (
            <>
              <button className="btn h-8" onClick={() => setRows((rs) => [...rs, blank()])} disabled={busy || loading}>
                + Add row
              </button>
              <button className="btn h-8" onClick={() => void save(false)} disabled={busy || loading || filled.length === 0}>
                Save entry
              </button>
            </>
          )}
          <button className="btn h-8" onClick={pdf} disabled={filled.length === 0}>
            Generate PDF
          </button>
          <button className="btn h-8" onClick={() => downloadXlsx(fileName, "Bulk Manufacturing", exportRows())} disabled={filled.length === 0}>
            Generate Excel
          </button>
          {!locked && (
            <button
              className="btn btn-primary h-8"
              onClick={() => void save(true)}
              disabled={busy || loading || filled.length === 0 || notReady}
              title={notReady ? "Every row needs the actual batch qty and the responsible person" : undefined}
            >
              Final submit
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
        <label className="flex items-center gap-2 font-semibold">
          Date
          <DateInput value={date} onChange={setDate} ariaLabel="Report date" />
        </label>
        <span className="text-muted">
          {loading
            ? "Loading…"
            : saved
              ? `${rows.length} row(s) · saved by ${saved.savedBy || "—"}, ${when(saved.savedAt)}`
              : fromPlan
                ? `New report — ${fromPlan} item(s) taken from the bulk plan of ${date}`
                : `New report — no bulk plan saved for ${date}`}
        </span>
        {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
      </div>
      {saved?.finalAt && (
        <p className="border-b border-rule px-3 py-2 text-center text-[12.5px] font-semibold" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
          Final submitted on {when(saved.finalAt)} by {saved.finalBy} — locked; the actual qty waits for Quality Testing.
        </p>
      )}

      <div className="overflow-x-auto">
        <fieldset disabled={locked}>
          <table className="w-full border-collapse text-[12.5px]" style={{ minWidth: 1900 }}>
            <thead>
              <tr className="bg-[#1c2533] text-white">
                {HEADERS.map((h) => (
                  <th key={h} className="whitespace-normal border-r border-white/15 px-2 py-2 text-center text-[10.5px] font-bold uppercase tracking-[.05em]">
                    {h}
                  </th>
                ))}
                <th className="w-8" aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const a = bulkAchievement(num(r.batchSize), num(r.actualQty));
                return (
                  <tr key={i} style={{ background: i % 2 ? "#FAFAFA" : "var(--card)" }}>
                    <td className={`${td} num w-8 text-center text-muted`}>{i + 1}</td>
                    <td className={`${td} w-[280px]`}>
                      <SearchPicker
                        value={r.itemName}
                        onChange={(v) => set(i, { itemName: v, unit: bulkUnitOf(items, v) ?? r.unit })}
                        options={options}
                        placeholder="Search bulk item"
                        ariaLabel={`Product name, row ${i + 1}`}
                        minWidth={360}
                      />
                    </td>
                    <td className={`${td} w-[70px] text-center`}>
                      <UnitSelect value={r.unit} onChange={(unit) => set(i, { unit })} fixed={locked || Boolean(bulkUnitOf(items, r.itemName))} ariaLabel={`Unit, row ${i + 1}`} />
                    </td>
                    <td className={`${td} w-[150px]`}>{text(i, "shade", "Shade / colour")}</td>
                    <td className={`${td} w-[150px]`}>
                      <DateInput value={r.orderDate} onChange={(v) => set(i, { orderDate: v })} ariaLabel={`Order date, row ${i + 1}`} />
                    </td>
                    <td className={`${td} w-[180px]`}>
                      <SearchPicker
                        value={r.responsible}
                        onChange={(v) => set(i, { responsible: v })}
                        options={PEOPLE}
                        placeholder="Pick or type"
                        ariaLabel={`Responsible person, row ${i + 1}`}
                        minWidth={200}
                      />
                    </td>
                    <td className={`${td} w-[110px]`}>{numIn(i, "batchSize", "Batch size")}</td>
                    <td className={`${td} w-[120px]`}>{numIn(i, "actualQty", "Total batch qty actual")}</td>
                    <td className={`${td} w-[150px]`}>{text(i, "mfgBy", "Mfg by")}</td>
                    <td
                      className={`${td} num w-[100px] bg-[#EEF1F5] text-center font-bold`}
                      style={{ color: a === null ? undefined : a >= 100 ? "var(--green)" : a < 80 ? "var(--red)" : undefined }}
                    >
                      {a === null ? "—" : `${a}%`}
                    </td>
                    <td className={`${td} w-[220px]`}>{text(i, "remark", "Remark")}</td>
                    <td className={`${td} w-8 text-center`}>
                      {!locked && (
                        <button className="btn h-7 px-2 text-[11px]" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-ink bg-[#F3F5F8] text-[12.5px] font-bold">
                <td className="px-2 py-2.5" colSpan={6}>
                  TOTAL — {filled.length} row(s)
                </td>
                <td className="num px-2 text-center">{total("batchSize")}</td>
                <td className="num px-2 text-center">{total("actualQty")}</td>
                <td colSpan={4} />
              </tr>
            </tbody>
          </table>
        </fieldset>
      </div>
    </Card>
  );
}
