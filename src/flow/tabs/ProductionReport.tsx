import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { FG_SUPERVISORS, LINE_LEADERS, PRODUCTION_FLOORS, PRODUCTION_LINES, PRODUCTION_SLOTS, PRODUCTION_STAGES, reportRowTotals } from "../logic";
import { todayLabel, useFlow } from "../store";
import { Card, DateInput, SearchPicker, TextInput, fmt } from "../ui";
import { downloadXlsx } from "../xlsx";
import { iso } from "./ProductionPlanning";

/** One report row as typed (numbers kept as text until saved). */
interface Row {
  floor: string;
  line: string;
  manpower: string;
  leader: string;
  supervisor: string;
  productName: string;
  fg: string;
  productType: string;
  stage: string;
  targetQty: string;
  slot: string;
  qtyFirst: string;
  qtySecond: string;
  qtyEvening: string;
  sfgQty: string;
  downtimeMin: string;
  reason: string;
}

type Num = number | null;
interface SavedLine {
  floor: string;
  line: string;
  manpower: Num;
  leader: string;
  supervisor: string;
  productName: string;
  productType: string;
  stage: string;
  targetQty: Num;
  slot: string;
  qtyFirst: Num;
  qtySecond: Num;
  qtyEvening: Num;
  sfgQty: Num;
  downtimeMin: Num;
  reason: string;
}
interface Saved {
  finalAt: string;
  finalBy: string;
  savedBy: string;
  savedAt: string;
  lines: SavedLine[];
}

const blank = (): Row => ({
  floor: "", line: "", manpower: "", leader: "", supervisor: "", productName: "", fg: "", productType: "", stage: "", targetQty: "",
  slot: "", qtyFirst: "", qtySecond: "", qtyEvening: "", sfgQty: "", downtimeMin: "", reason: "",
});
const str = (v: Num) => (v === null ? "" : String(v));
const num = (v: string): Num => (v.trim() === "" ? null : Number(v));
const when = (isoTime: string) => new Date(isoTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

const LEADER_OPTIONS = LINE_LEADERS.map((value) => ({ value }));
const SUPERVISOR_OPTIONS = FG_SUPERVISORS.map((value) => ({ value }));

const HEADERS = [
  "#", "Floor", "Line no", "Fix man power", "Line leader name", "Supervisor", "Product name", "FG code", "Product type", "Stage",
  "Total target qty (pcs)", "Production slot", "Qty first half (9 to 1 pm)", "Qty second half (1 to 5 pm)", "Qty (5 to 7 pm)",
  "Total line FG", "Total SFG in shift", "Down time in minutes", "Reason", "Achievement %",
];

const esc = (v: string | number) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Production report: the day's line-wise output by time slot, started from the day's plan. Saved as a draft any number
 * of times; final submit locks the date. Achievement = total line FG ÷ the row's target.
 */
export function ProductionReport() {
  const { masters } = useFlow();
  const { can } = useAuth();
  const mayEdit = can("production.report");
  const [date, setDate] = useState(todayLabel());
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [fromPlan, setFromPlan] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef("");

  const fgOf = (name: string) => masters.productByName.get(name)?.fg ?? "";
  const locked = Boolean(saved?.finalAt) || !mayEdit;

  async function load(d: string, keepMessage = false) {
    latest.current = d;
    setLoading(true);
    if (!keepMessage) setMessage(null);
    try {
      const r = await api<{ report: Saved | null; plan: { productName: string; productType: string; targetQty: number }[] }>(
        "GET",
        `/production-reports/${iso(d)}`,
      );
      if (latest.current !== d) return; // a newer date was picked meanwhile
      setSaved(r.report);
      setFromPlan(r.report ? 0 : r.plan.length);
      setRows(
        r.report
          ? r.report.lines.map((l) => ({
              ...l,
              fg: fgOf(l.productName),
              manpower: str(l.manpower),
              targetQty: str(l.targetQty),
              qtyFirst: str(l.qtyFirst),
              qtySecond: str(l.qtySecond),
              qtyEvening: str(l.qtyEvening),
              sfgQty: str(l.sfgQty),
              downtimeMin: str(l.downtimeMin),
            }))
          : r.plan.length
            ? r.plan.map((p) => ({ ...blank(), productName: p.productName, fg: fgOf(p.productName), productType: p.productType, targetQty: String(p.targetQty) }))
            : Array.from({ length: 4 }, blank),
      );
    } catch (e) {
      if (latest.current === d) setMessage({ text: (e as Error).message, error: true });
    } finally {
      if (latest.current === d) setLoading(false);
    }
  }

  useEffect(() => {
    if (date) void load(date);
    // masters arrive once; the report is reloaded only when the date changes
  }, [date]);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const productOptions = useMemo(() => masters.products.map((p) => ({ value: p.name, hint: p.fg })), [masters.products]);
  const fgOptions = useMemo(() => masters.products.map((p) => ({ value: p.fg, hint: p.name })), [masters.products]);

  const filled = rows.filter((r) => r.productName.trim() !== "");
  const badProduct = filled.some((r) => !masters.productByName.has(r.productName));
  const noSupervisor = filled.some((r) => !r.supervisor.trim());
  const totals = rows.map((r) => reportRowTotals({ qtyFirst: num(r.qtyFirst), qtySecond: num(r.qtySecond), qtyEvening: num(r.qtyEvening), targetQty: num(r.targetQty) }));
  const sum = (k: keyof Row) => filled.reduce((n, r) => n + (num(r[k]) ?? 0), 0);
  const grand = reportRowTotals({ qtyFirst: sum("qtyFirst"), qtySecond: sum("qtySecond"), qtyEvening: sum("qtyEvening"), targetQty: sum("targetQty") || null });

  async function save(final: boolean) {
    if (final && !window.confirm(`Final submit the production report of ${date}? It cannot be changed afterwards.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/production-reports/${iso(date)}`, {
        final,
        lines: filled.map((r) => ({
          floor: r.floor,
          line: r.line,
          manpower: num(r.manpower),
          leader: r.leader.trim(),
          supervisor: r.supervisor.trim(),
          productName: r.productName,
          productType: r.productType.trim(),
          stage: r.stage,
          targetQty: num(r.targetQty),
          slot: r.slot,
          qtyFirst: num(r.qtyFirst),
          qtySecond: num(r.qtySecond),
          qtyEvening: num(r.qtyEvening),
          sfgQty: num(r.sfgQty),
          downtimeMin: num(r.downtimeMin),
          reason: r.reason.trim(),
        })),
      });
      await load(date, true);
      setMessage({ text: final ? `Report of ${date} final-submitted and locked.` : `Report of ${date} saved.`, error: false });
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
      const t = reportRowTotals({ qtyFirst: num(r.qtyFirst), qtySecond: num(r.qtySecond), qtyEvening: num(r.qtyEvening), targetQty: num(r.targetQty) });
      return [
        i + 1, r.floor, r.line, num(r.manpower), r.leader, r.supervisor, r.productName, fgOf(r.productName) || r.fg, r.productType, r.stage,
        num(r.targetQty), r.slot, num(r.qtyFirst), num(r.qtySecond), num(r.qtyEvening), t.total, num(r.sfgQty), num(r.downtimeMin),
        r.reason, t.achievement === null ? "" : `${t.achievement}%`,
      ];
    }),
    [
      "TOTAL", "", "", sum("manpower"), "", "", `${filled.length} row(s)`, "", "", "", sum("targetQty"), "", sum("qtyFirst"), sum("qtySecond"),
      sum("qtyEvening"), grand.total, sum("sfgQty"), sum("downtimeMin"), "", grand.achievement === null ? "" : `${grand.achievement}%`,
    ],
  ];
  const fileName = `Production Report (${iso(date)})`;

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
      <h1>PRODUCTION REPORT</h1>
      <p class="meta">Date <b>${esc(date)}</b> · ${esc(status)}</p>
      <table><thead><tr>${head.map((h) => `<th>${esc(h ?? "")}</th>`).join("")}</tr></thead>
      <tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c === null ? "" : esc(typeof c === "number" ? c.toLocaleString("en-IN") : c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  const sel = (i: number, k: "floor" | "line" | "stage" | "slot", list: readonly string[], label: string) => (
    <select className="field h-8 w-full" value={rows[i][k]} onChange={(e) => set(i, { [k]: e.target.value })} aria-label={`${label}, row ${i + 1}`}>
      <option value="">—</option>
      {list.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
  const numIn = (i: number, k: keyof Row, label: string) => (
    <TextInput numeric value={rows[i][k]} onChange={(v) => set(i, { [k]: v })} placeholder="" ariaLabel={`${label}, row ${i + 1}`} />
  );
  const td = "border-b border-r border-rule px-1 py-1 align-middle";

  return (
    <Card
      title="Production report"
      step={saved?.finalAt ? "FINAL" : saved ? "DRAFT SAVED" : "NEW"}
      right={
        <>
          {!locked && (
            <>
              <button className="btn h-8" onClick={() => setRows((rs) => [...rs, blank()])} disabled={busy || loading}>
                + Add row
              </button>
              <button className="btn h-8" onClick={() => void save(false)} disabled={busy || loading || filled.length === 0 || badProduct}>
                Save entry
              </button>
            </>
          )}
          <button className="btn h-8" onClick={pdf} disabled={filled.length === 0}>
            Generate PDF
          </button>
          <button className="btn h-8" onClick={() => downloadXlsx(fileName, "Production Report", exportRows())} disabled={filled.length === 0}>
            Generate Excel
          </button>
          {!locked && (
            <button
              className="btn btn-primary h-8"
              onClick={() => void save(true)}
              disabled={busy || loading || filled.length === 0 || badProduct || noSupervisor}
              title={noSupervisor ? "Pick the supervisor of every row first" : undefined}
            >
              Final submit
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
        <label className="flex items-center gap-2 font-semibold">
          Entry date
          <DateInput value={date} onChange={setDate} ariaLabel="Entry date" />
        </label>
        <span className="text-muted">
          {loading
            ? "Loading…"
            : saved
              ? `${rows.length} row(s) · saved by ${saved.savedBy || "—"}, ${when(saved.savedAt)}`
              : fromPlan
                ? `New report — ${fromPlan} product(s) taken from the plan of ${date}`
                : `New report — no plan saved for ${date}`}
        </span>
        {badProduct && <span style={{ color: "var(--amber)" }}>Pick each product from the list.</span>}
        {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
      </div>
      {saved?.finalAt && (
        <p className="border-b border-rule px-3 py-2 text-center text-[12.5px] font-semibold" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
          Final submitted on {when(saved.finalAt)} by {saved.finalBy} — this date is locked and cannot be changed.
        </p>
      )}

      <div className="overflow-x-auto">
        <fieldset disabled={locked}>
          <table className="w-full border-collapse text-[12.5px]" style={{ minWidth: 2510 }}>
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
                const t = totals[i];
                return (
                  <tr key={i} style={{ background: i % 2 ? "#FAFAFA" : "var(--card)" }}>
                    <td className={`${td} num w-8 text-center text-muted`}>{i + 1}</td>
                    <td className={`${td} w-[80px]`}>{sel(i, "floor", PRODUCTION_FLOORS, "Floor")}</td>
                    <td className={`${td} w-[84px]`}>{sel(i, "line", PRODUCTION_LINES, "Line no")}</td>
                    <td className={`${td} w-[80px]`}>{numIn(i, "manpower", "Fix man power")}</td>
                    <td className={`${td} w-[150px]`}>
                      <SearchPicker
                        value={r.leader}
                        onChange={(v) => set(i, { leader: v.toUpperCase() })}
                        options={LEADER_OPTIONS}
                        placeholder="Pick leader"
                        ariaLabel={`Line leader, row ${i + 1}`}
                        minWidth={180}
                      />
                    </td>
                    <td className={`${td} w-[160px]`}>
                      <SearchPicker
                        value={r.supervisor}
                        onChange={(v) => set(i, { supervisor: v })}
                        options={SUPERVISOR_OPTIONS}
                        placeholder="Pick supervisor"
                        ariaLabel={`Supervisor, row ${i + 1}`}
                        minWidth={180}
                      />
                    </td>
                    <td className={`${td} w-[250px]`}>
                      <SearchPicker
                        value={r.productName}
                        onChange={(v) => set(i, { productName: v, fg: fgOf(v) || (masters.productByName.has(r.productName) ? "" : r.fg) })}
                        options={productOptions}
                        placeholder="Search product"
                        ariaLabel={`Product name, row ${i + 1}`}
                        minWidth={320}
                      />
                    </td>
                    <td className={`${td} w-[130px]`}>
                      <SearchPicker
                        value={r.fg}
                        onChange={(v) => {
                          // FG codes are not unique: fill the name only when the code names one product
                          const hits = masters.products.filter((p) => p.fg === v);
                          set(i, { fg: v, productName: hits.length === 1 ? hits[0].name : masters.productByName.get(r.productName)?.fg === v ? r.productName : "" });
                        }}
                        options={fgOptions}
                        placeholder="FG code"
                        ariaLabel={`FG code, row ${i + 1}`}
                        minWidth={320}
                      />
                    </td>
                    <td className={`${td} w-[150px]`}>
                      <TextInput value={r.productType} onChange={(v) => set(i, { productType: v })} placeholder="Optional" ariaLabel={`Product type, row ${i + 1}`} />
                    </td>
                    <td className={`${td} w-[150px]`}>{sel(i, "stage", PRODUCTION_STAGES, "Stage")}</td>
                    <td className={`${td} w-[100px]`}>{numIn(i, "targetQty", "Total target qty")}</td>
                    <td className={`${td} w-[100px]`}>{sel(i, "slot", PRODUCTION_SLOTS, "Production slot")}</td>
                    <td className={`${td} w-[100px]`}>{numIn(i, "qtyFirst", "Qty first half")}</td>
                    <td className={`${td} w-[100px]`}>{numIn(i, "qtySecond", "Qty second half")}</td>
                    <td className={`${td} w-[100px]`}>{numIn(i, "qtyEvening", "Qty 5 to 7 pm")}</td>
                    <td className={`${td} num w-[90px] bg-[#EEF1F5] text-center font-bold`}>{t.total ? fmt(t.total) : "—"}</td>
                    <td className={`${td} w-[100px]`}>{numIn(i, "sfgQty", "Total SFG in shift")}</td>
                    <td className={`${td} w-[90px]`}>{numIn(i, "downtimeMin", "Down time minutes")}</td>
                    <td className={`${td} w-[200px]`}>
                      <TextInput value={r.reason} onChange={(v) => set(i, { reason: v })} ariaLabel={`Reason, row ${i + 1}`} />
                    </td>
                    <td
                      className={`${td} num w-[90px] bg-[#EEF1F5] text-center font-bold`}
                      style={{ color: t.achievement === null ? undefined : t.achievement >= 100 ? "var(--green)" : t.achievement < 80 ? "var(--red)" : undefined }}
                    >
                      {t.achievement === null ? "—" : `${t.achievement}%`}
                    </td>
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
                <td className="px-2 py-2.5" colSpan={3}>
                  TOTAL
                </td>
                <td className="num px-2 text-center">{fmt(sum("manpower"))}</td>
                <td className="px-2" colSpan={6}>
                  {filled.length} row(s)
                </td>
                <td className="num px-2 text-center">{fmt(sum("targetQty"))}</td>
                <td />
                <td className="num px-2 text-center">{fmt(sum("qtyFirst"))}</td>
                <td className="num px-2 text-center">{fmt(sum("qtySecond"))}</td>
                <td className="num px-2 text-center">{fmt(sum("qtyEvening"))}</td>
                <td className="num px-2 text-center">{fmt(grand.total)}</td>
                <td className="num px-2 text-center">{fmt(sum("sfgQty"))}</td>
                <td className="num px-2 text-center">{fmt(sum("downtimeMin"))}</td>
                <td />
                <td className="num px-2 text-center">{grand.achievement === null ? "—" : `${grand.achievement}%`}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </fieldset>
      </div>
    </Card>
  );
}
