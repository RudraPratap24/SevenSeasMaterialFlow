import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { FG_SUPERVISORS } from "../logic";
import { todayLabel, useFlow } from "../store";
import { Card, DateInput, EmptyNote, SearchPicker, Table, Td, TextInput, Tr, fmt } from "../ui";
import { downloadXlsx } from "../xlsx";
import { iso } from "./ProductionPlanning";

interface Row {
  productName: string;
  fg: string;
  productType: string;
  qtyInBox: string;
  totalBox: string;
  totalQty: string;
  palletNo: string;
  supervisor: string;
}

type Num = number | null;
interface SavedLine {
  productName: string;
  productType: string;
  qtyInBox: Num;
  totalBox: Num;
  totalQty: Num;
  palletNo: string;
  supervisor: string;
}
interface Note {
  noteNo: string;
  createdAt: string;
  createdBy: string;
  lines: SavedLine[];
}

const EMPTY_ROWS = 4;
const blank = (): Row => ({ productName: "", fg: "", productType: "", qtyInBox: "", totalBox: "", totalQty: "", palletNo: "", supervisor: "" });
const num = (v: string): Num => (v.trim() === "" ? null : Number(v));
const when = (isoTime: string) => new Date(isoTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const SUPERVISOR_OPTIONS = FG_SUPERVISORS.map((value) => ({ value }));
const HEADERS = ["#", "Product name", "FG code", "Product type", "Qty in box", "Total box", "Total qty", "Pallet no", "Supervisor name"];

const esc = (v: string | number) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * FG transfer note: finished goods sent from the line, filled per date as a draft. Final submit turns the rows into a
 * numbered note (several a day) and starts a fresh draft.
 */
export function FgTransferNote() {
  const { masters } = useFlow();
  const { can } = useAuth();
  const mayEdit = can("production.report");
  const [date, setDate] = useState(todayLabel());
  const [rows, setRows] = useState<Row[]>([]);
  const [draftInfo, setDraftInfo] = useState<{ savedBy: string; savedAt: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef("");

  const fgOf = (name: string) => masters.productByName.get(name)?.fg ?? "";

  async function load(d: string, keepMessage = false) {
    latest.current = d;
    setLoading(true);
    if (!keepMessage) setMessage(null);
    try {
      const r = await api<{ draft: { savedBy: string; savedAt: string; lines: SavedLine[] } | null; notes: Note[] }>("GET", `/fg-transfer/${iso(d)}`);
      if (latest.current !== d) return; // a newer date was picked meanwhile
      setDraftInfo(r.draft);
      setNotes(r.notes);
      setRows(
        r.draft
          ? r.draft.lines.map((l) => ({
              ...l,
              fg: fgOf(l.productName),
              qtyInBox: l.qtyInBox === null ? "" : String(l.qtyInBox),
              totalBox: l.totalBox === null ? "" : String(l.totalBox),
              totalQty: l.totalQty === null ? "" : String(l.totalQty),
            }))
          : Array.from({ length: EMPTY_ROWS }, blank),
      );
    } catch (e) {
      if (latest.current === d) setMessage({ text: (e as Error).message, error: true });
    } finally {
      if (latest.current === d) setLoading(false);
    }
  }

  useEffect(() => {
    if (date) void load(date);
    // masters arrive once; reload only when the date changes
  }, [date]);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const productOptions = useMemo(() => masters.products.map((p) => ({ value: p.name, hint: p.fg })), [masters.products]);
  const fgOptions = useMemo(() => masters.products.map((p) => ({ value: p.fg, hint: p.name })), [masters.products]);

  const filled = rows.filter((r) => r.productName.trim() !== "");
  const badProduct = filled.some((r) => !masters.productByName.has(r.productName));
  const readyFinal = filled.length > 0 && !badProduct && filled.every((r) => Number(r.qtyInBox) > 0 && Number(r.totalBox) > 0 && Number(r.totalQty) > 0 && r.supervisor.trim());
  const totalQty = (r: { qtyInBox: Num; totalBox: Num; totalQty: Num }) => r.totalQty ?? (r.qtyInBox ?? 0) * (r.totalBox ?? 0);
  /** Qty in box or total box changed: total qty follows (it can still be typed over). */
  const boxes = (i: number, patch: Partial<Row>) => {
    const r = { ...rows[i], ...patch };
    const n = Number(r.qtyInBox) * Number(r.totalBox);
    set(i, { ...patch, totalQty: n > 0 ? String(n) : "" });
  };
  const asLine = (r: Row): SavedLine => ({
    productName: r.productName,
    productType: r.productType.trim(),
    qtyInBox: num(r.qtyInBox),
    totalBox: num(r.totalBox),
    totalQty: num(r.totalQty),
    palletNo: r.palletNo.trim(),
    supervisor: r.supervisor.trim(),
  });

  async function save(final: boolean) {
    if (final && !window.confirm(`Final submit these ${filled.length} row(s) as an FG transfer note of ${date}? It cannot be changed afterwards.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ noteNo: string }>("POST", `/fg-transfer/${iso(date)}`, { final, lines: filled.map(asLine) });
      await load(date, true);
      setMessage({ text: final ? `FG transfer note ${r.noteNo} generated.` : `Draft of ${date} saved.`, error: false });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  /** Rows as plain values for the Excel and the PDF, with a total row. */
  const exportRows = (lines: SavedLine[]): (string | number | null)[][] => [
    HEADERS,
    ...lines.map((l, i) => [i + 1, l.productName, fgOf(l.productName), l.productType, l.qtyInBox, l.totalBox, totalQty(l), l.palletNo, l.supervisor]),
    ["TOTAL", `${lines.length} row(s)`, "", "", "", lines.reduce((n, l) => n + (l.totalBox ?? 0), 0), lines.reduce((n, l) => n + totalQty(l), 0), "", ""],
  ];
  const fileName = (noteNo?: string) => (noteNo ? `FG Transfer Note ${noteNo}` : `FG Transfer Note (${iso(date)}) draft`);

  function pdf(lines: SavedLine[], noteNo?: string, at?: string) {
    const w = window.open("", "_blank");
    if (!w) {
      setMessage({ text: "The browser blocked the PDF window — allow pop-ups for this site.", error: true });
      return;
    }
    const [head, ...body] = exportRows(lines);
    const status = noteNo ? `Note <b>${esc(noteNo)}</b> · generated ${esc(when(at!))}` : "Draft — not final submitted";
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(fileName(noteNo))}</title><style>
      body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1c2533;margin:24px}
      h1{text-align:center;font-size:20px;letter-spacing:.04em;margin:0 0 4px}
      .meta{text-align:center;font-size:12.5px;margin:2px 0 14px}
      table{width:100%;border-collapse:collapse;font-size:11.5px}
      th{border:1px solid #1c2533;background:#1c2533;color:#fff;font-weight:600;padding:6px 4px;font-size:10.5px}
      td{border:1px solid #d5dbe3;padding:5px 4px;text-align:center}
      tr:last-child td{font-weight:700;background:#f3f5f8;border-top:2px solid #1c2533}
      .sign{display:flex;justify-content:space-between;margin-top:56px;font-size:12px}
      @page{size:A4 landscape;margin:10mm}
      @media print{body{margin:0}th,tr:last-child td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
    </style></head><body>
      <h1>FG TRANSFER NOTE</h1>
      <p class="meta">Date <b>${esc(date)}</b> · ${status}</p>
      <table><thead><tr>${head.map((h) => `<th>${esc(h ?? "")}</th>`).join("")}</tr></thead>
      <tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c === null ? "" : esc(typeof c === "number" ? c.toLocaleString("en-IN") : c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <div class="sign"><span>Production supervisor</span><span>Received by (FG warehouse)</span></div>
    </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  const draftLines = filled.map(asLine);

  return (
    <Card
      title="FG transfer note"
      step={draftInfo ? "DRAFT SAVED" : "NEW"}
      right={
        <>
          {mayEdit && (
            <>
              <button className="btn h-8" onClick={() => setRows((rs) => [...rs, blank()])} disabled={busy || loading}>
                + Add row
              </button>
              <button className="btn h-8" onClick={() => void save(false)} disabled={busy || loading || filled.length === 0 || badProduct}>
                Save
              </button>
            </>
          )}
          <button className="btn h-8" onClick={() => pdf(draftLines)} disabled={filled.length === 0}>
            Generate PDF
          </button>
          <button className="btn h-8" onClick={() => downloadXlsx(fileName(), "FG Transfer Note", exportRows(draftLines))} disabled={filled.length === 0}>
            Generate Excel
          </button>
          {mayEdit && (
            <button
              className="btn btn-primary h-8"
              onClick={() => void save(true)}
              disabled={busy || loading || !readyFinal}
              title={readyFinal ? undefined : "Every row needs a product, qty in box, total box, total qty and the supervisor"}
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
          <DateInput value={date} onChange={setDate} ariaLabel="Date" />
        </label>
        <span className="text-muted">
          {loading
            ? "Loading…"
            : draftInfo
              ? `Draft for ${date} — ${filled.length} row(s) · saved by ${draftInfo.savedBy || "—"}, ${when(draftInfo.savedAt)}`
              : `New draft for ${date}`}
        </span>
        {badProduct && <span style={{ color: "var(--amber)" }}>Pick each product from the list.</span>}
        {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
      </div>

      <fieldset disabled={!mayEdit}>
        <Table minWidth={1300} headers={[...HEADERS.map((h, i) => (i >= 4 && i <= 6 ? { label: h, align: "right" as const } : h)), ""]}>
          {rows.map((r, i) => (
            <Tr key={i} zebra={i % 2 === 1}>
              <Td num muted>{i + 1}</Td>
              <Td>
                <SearchPicker
                  value={r.productName}
                  onChange={(v) => set(i, { productName: v, fg: fgOf(v) || (masters.productByName.has(r.productName) ? "" : r.fg) })}
                  options={productOptions}
                  placeholder="Search product"
                  ariaLabel={`Product name, row ${i + 1}`}
                  minWidth={320}
                />
              </Td>
              <Td>
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
              </Td>
              <Td>
                <TextInput value={r.productType} onChange={(v) => set(i, { productType: v })} placeholder="Optional" ariaLabel={`Product type, row ${i + 1}`} />
              </Td>
              <Td right>
                <TextInput numeric value={r.qtyInBox} onChange={(v) => boxes(i, { qtyInBox: v })} placeholder="0" ariaLabel={`Qty in box, row ${i + 1}`} />
              </Td>
              <Td right>
                <TextInput numeric value={r.totalBox} onChange={(v) => boxes(i, { totalBox: v })} placeholder="0" ariaLabel={`Total box, row ${i + 1}`} />
              </Td>
              <Td right>
                <TextInput numeric value={r.totalQty} onChange={(v) => set(i, { totalQty: v })} placeholder="0" ariaLabel={`Total qty, row ${i + 1}`} />
              </Td>
              <Td>
                <TextInput value={r.palletNo} onChange={(v) => set(i, { palletNo: v })} ariaLabel={`Pallet no, row ${i + 1}`} />
              </Td>
              <Td>
                <SearchPicker
                  value={r.supervisor}
                  onChange={(v) => set(i, { supervisor: v })}
                  options={SUPERVISOR_OPTIONS}
                  placeholder="Pick supervisor"
                  ariaLabel={`Supervisor name, row ${i + 1}`}
                  minWidth={200}
                />
              </Td>
              <Td>
                {mayEdit && (
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>
                    ×
                  </button>
                )}
              </Td>
            </Tr>
          ))}
        </Table>
      </fieldset>

      <h3 className="border-t border-rule px-3 pb-2 pt-4 text-center text-[11.5px] font-bold uppercase tracking-[.12em]">Notes generated on this date</h3>
      {notes.length === 0 ? (
        <EmptyNote>No note generated on this date yet.</EmptyNote>
      ) : (
        <Table
          minWidth={900}
          headers={["Note no", "Generated at", "By", { label: "Rows", align: "right" }, { label: "Total box", align: "right" }, { label: "Total qty", align: "right" }, ""]}
        >
          {notes.map((n, i) => (
            <Tr key={n.noteNo} zebra={i % 2 === 1}>
              <Td num strong>{n.noteNo}</Td>
              <Td num>{when(n.createdAt)}</Td>
              <Td>{n.createdBy || "—"}</Td>
              <Td right num>{n.lines.length}</Td>
              <Td right num>{fmt(n.lines.reduce((s, l) => s + (l.totalBox ?? 0), 0))}</Td>
              <Td right num strong>{fmt(n.lines.reduce((s, l) => s + totalQty(l), 0))}</Td>
              <Td>
                <span className="flex justify-end gap-1.5">
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => pdf(n.lines, n.noteNo, n.createdAt)}>
                    PDF
                  </button>
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => downloadXlsx(fileName(n.noteNo), "FG Transfer Note", exportRows(n.lines))}>
                    Excel
                  </button>
                </span>
              </Td>
            </Tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
