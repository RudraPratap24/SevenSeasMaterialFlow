import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { todayLabel } from "../store";
import { Card, DateInput, SearchPicker, Table, Td, TextInput, Tr, fmt } from "../ui";
import { iso } from "./ProductionPlanning";

export type BulkUnit = "KG" | "L";
export interface BulkItem {
  name: string;
  unit: BulkUnit;
}
export const unitLabel = (u: BulkUnit) => (u === "L" ? "L" : "Kg");
/** The unit of a listed bulk item (names match ignoring case, like the server). */
export const bulkUnitOf = (items: BulkItem[], name: string) => items.find((x) => x.name.toLowerCase() === name.trim().toLowerCase())?.unit;
/** Totals per unit — Kg and L are never added together. */
export const perUnit = (rows: { unit: BulkUnit; qty: number }[]) =>
  (["KG", "L"] as const)
    .map((u) => ({ u, n: rows.filter((r) => r.unit === u).reduce((s, r) => s + r.qty, 0) }))
    .filter((x) => x.n > 0)
    .map((x) => `${fmt(x.n)} ${unitLabel(x.u)}`)
    .join(" · ") || "0";

/** Kg / L picker; fixed to the item's own unit once the item is on the list. */
export function UnitSelect({ value, onChange, fixed, ariaLabel }: { value: BulkUnit; onChange: (u: BulkUnit) => void; fixed: boolean; ariaLabel: string }) {
  return (
    <select className="field h-8" value={value} onChange={(e) => onChange(e.target.value as BulkUnit)} disabled={fixed} aria-label={ariaLabel} title={fixed ? "This item's unit" : "Unit of this new item"}>
      <option value="KG">Kg</option>
      <option value="L">L</option>
    </select>
  );
}

interface Row {
  itemName: string;
  qty: string;
  unit: BulkUnit;
}

interface SavedPlan {
  savedBy: string;
  savedAt: string;
  lines: { itemName: string; unit: BulkUnit; qty: number }[];
}

const EMPTY_ROWS = 5;
const blankRow = (): Row => ({ itemName: "", qty: "", unit: "KG" });

/** Bulk production plan: the bulk (chemical mix) items and qty to make on a day, saved per date. */
export function BulkProductionPlan() {
  const { can } = useAuth();
  const maySave = can("production.plan");
  const [date, setDate] = useState(todayLabel());
  const [rows, setRows] = useState<Row[]>([]);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [saved, setSaved] = useState<SavedPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef("");

  async function load(d: string) {
    latest.current = d;
    setLoading(true);
    setMessage(null);
    try {
      const r = await api<{ items: BulkItem[]; plan: SavedPlan | null }>("GET", `/bulk-plans/${iso(d)}`);
      if (latest.current !== d) return; // a newer date was picked meanwhile
      setItems(r.items);
      setSaved(r.plan);
      setRows(r.plan ? r.plan.lines.map((l) => ({ itemName: l.itemName, unit: l.unit, qty: String(l.qty) })) : Array.from({ length: EMPTY_ROWS }, blankRow));
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
  const filled = rows.filter((r) => r.itemName.trim() && Number(r.qty) > 0);
  const incomplete = rows.some((r) => (r.itemName.trim() || r.qty) && !(r.itemName.trim() && Number(r.qty) > 0));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/bulk-plans/${iso(date)}`, { lines: filled.map((r) => ({ itemName: r.itemName.trim(), unit: r.unit, qty: Number(r.qty) })) });
      await load(date);
      setMessage({ text: `Bulk plan for ${date} saved.`, error: false });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Bulk production plan"
      step={saved ? "SAVED" : "NEW PLAN"}
      right={
        maySave && (
          <>
            <button className="btn h-8" onClick={() => setRows((rs) => [...rs, blankRow()])} disabled={loading}>
              + Add item
            </button>
            <button className="btn btn-primary h-8" onClick={() => void save()} disabled={busy || loading || filled.length === 0 || incomplete}>
              {busy ? "Saving…" : "Save plan"}
            </button>
          </>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
        <label className="flex items-center gap-2 font-semibold">
          Plan date
          <DateInput value={date} onChange={setDate} ariaLabel="Plan date" />
        </label>
        <span className="text-muted">
          {loading
            ? "Loading…"
            : saved
              ? `Saved plan for ${date} · by ${saved.savedBy || "—"} · ${new Date(saved.savedAt).toLocaleString("en-IN")}`
              : `No plan for ${date} — new plan`}
        </span>
        {incomplete && <span style={{ color: "var(--amber)" }}>Each row needs an item name and a qty.</span>}
        {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
      </div>
      <Table minWidth={700} headers={["#", "Item name (pick or type)", { label: "Qty", align: "right" }, "Unit", ""]}>
        {rows.map((r, i) => (
          <Tr key={i} zebra={i % 2 === 1}>
            <Td num muted>{i + 1}</Td>
            <Td>
              <SearchPicker
                value={r.itemName}
                onChange={(v) => set(i, { itemName: v, unit: bulkUnitOf(items, v) ?? r.unit })}
                options={options}
                placeholder="Search bulk item"
                ariaLabel={`Item name, row ${i + 1}`}
                minWidth={420}
              />
            </Td>
            <Td right>
              <TextInput numeric value={r.qty} onChange={(v) => set(i, { qty: v })} placeholder="0" ariaLabel={`Qty, row ${i + 1}`} />
            </Td>
            <Td>
              <UnitSelect value={r.unit} onChange={(unit) => set(i, { unit })} fixed={!maySave || Boolean(bulkUnitOf(items, r.itemName))} ariaLabel={`Unit, row ${i + 1}`} />
            </Td>
            <Td>
              {maySave && (
                <button className="btn h-7 px-2 text-[11px]" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>
                  ×
                </button>
              )}
            </Td>
          </Tr>
        ))}
        <tr className="border-t-2 border-ink bg-[#F3F5F8] text-[12.5px] font-bold">
          <td className="px-2 py-2.5" colSpan={2}>
            TOTAL — {filled.length} item(s)
          </td>
          <td className="num px-2 py-2.5 text-right" colSpan={2}>{perUnit(filled.map((r) => ({ unit: r.unit, qty: Number(r.qty) })))}</td>
          <td />
        </tr>
      </Table>
    </Card>
  );
}
