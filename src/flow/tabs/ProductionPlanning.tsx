import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { planMaterials, type PlanMaterial } from "../logic";
import { todayLabel, useFlow } from "../store";
import { Card, Chip, DateInput, EmptyNote, SearchPicker, Table, Td, TextInput, Tr, fmt } from "../ui";

interface Row {
  productName: string;
  fg: string;
  productType: string;
  qty: string;
}

interface SavedPlan {
  savedBy: string;
  savedAt: string;
  lines: { productName: string; productType: string; targetQty: number }[];
}

const EMPTY_ROWS = 4;
const blankRow = (): Row => ({ productName: "", fg: "", productType: "", qty: "" });
/** "dd-mm-yyyy" → "yyyy-mm-dd" for the API. */
export const iso = (d: string) => d.split("-").reverse().join("-");

/**
 * Production planning: the products and target qty for a day, saved per date. The material table below works out
 * from the BOM what PM the plan needs against today's PM stock.
 */
export function ProductionPlanning() {
  const { masters, pmStock, openBoms } = useFlow();
  const { can } = useAuth();
  const maySave = can("production.plan");
  const [date, setDate] = useState(todayLabel());
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<SavedPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef("");

  const fgOf = (name: string) => masters.productByName.get(name)?.fg ?? "";

  async function load(d: string) {
    latest.current = d;
    setLoading(true);
    setMessage(null);
    try {
      const r = await api<{ plan: SavedPlan | null }>("GET", `/production-plans/${iso(d)}`);
      if (latest.current !== d) return; // a newer date was picked meanwhile
      setSaved(r.plan);
      setRows(
        r.plan
          ? r.plan.lines.map((l) => ({ productName: l.productName, fg: fgOf(l.productName), productType: l.productType, qty: String(l.targetQty) }))
          : Array.from({ length: EMPTY_ROWS }, blankRow),
      );
    } catch (e) {
      if (latest.current === d) setMessage({ text: (e as Error).message, error: true });
    } finally {
      if (latest.current === d) setLoading(false);
    }
  }

  useEffect(() => {
    if (date) void load(date);
    // fgOf reads masters, which arrive once; a reload of the plan is only wanted when the date changes
  }, [date]);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // every FG is listed (with how many BOM items it has), not only the first 50
  const bomHint = (name: string) => {
    const n = masters.bomOf(name).length;
    return n ? `${n} items` : "no BOM";
  };
  const productOptions = useMemo(
    () => masters.products.map((p) => ({ value: p.name, hint: [p.fg, bomHint(p.name)].filter(Boolean).join(" · ") })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [masters],
  );
  const fgOptions = useMemo(
    () => masters.products.filter((p) => p.fg).map((p) => ({ value: p.fg, hint: `${p.name} · ${bomHint(p.name)}` })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [masters],
  );

  const filled = rows.filter((r) => masters.productByName.has(r.productName) && Number(r.qty) > 0);
  const incomplete = rows.some((r) => (r.productName || r.qty) && !(masters.productByName.has(r.productName) && Number(r.qty) > 0));

  /** PM needed for the plan: BOM qty per 100 × target, summed per PM item across the products. */
  const materials = useMemo(
    () =>
      planMaterials(filled.map((r) => ({ productName: r.productName, qty: Number(r.qty) })), masters.bomOf, fgOf, pmStock, {
        open: openBoms,
        planDate: iso(date),
      }),
    [filled, pmStock, masters, openBoms, date],
  );

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/production-plans/${iso(date)}`, {
        lines: filled.map((r) => ({ productName: r.productName, productType: r.productType.trim(), targetQty: Number(r.qty) })),
      });
      await load(date);
      setMessage({ text: `Plan for ${date} saved.`, error: false });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const shorts = materials.filter((m) => m.short > 0).length;

  return (
    <div className="space-y-3">
      <Card
        title="Production plan"
        step={saved ? "SAVED" : "NEW PLAN"}
        right={
          maySave && (
            <>
              <button className="btn h-8" onClick={() => setRows((rs) => [...rs, blankRow()])} disabled={loading}>
                + Add row
              </button>
              <button className="btn btn-primary h-8" onClick={() => void save()} disabled={busy || loading || filled.length === 0 || incomplete || shorts > 0}
                title={shorts ? "Material is short — remove the item or decrease its quantity" : undefined}
              >
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
          {incomplete && <span style={{ color: "var(--amber)" }}>Each row needs a product from the list and a qty.</span>}
          {shorts > 0 && (
            <span style={{ color: "var(--red)" }}>
              {shorts} item(s) short — cannot save. Please remove the item or decrease its quantity (see the red rows below).
            </span>
          )}
          {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
        </div>
        <Table minWidth={900} headers={["#", "Product name", "FG code", "Product type", { label: "Total target qty (pcs)", align: "right" }, ""]}>
          {rows.map((r, i) => (
            <Tr key={i} zebra={i % 2 === 1}>
              <Td num muted>{i + 1}</Td>
              <Td>
                <SearchPicker
                  value={r.productName}
                  onChange={(v) => set(i, { productName: v, fg: fgOf(v) || (masters.productByName.has(r.productName) ? "" : r.fg) })}
                  options={productOptions}
                  limit={1000}
                  placeholder="Search product"
                  ariaLabel={`Product name, row ${i + 1}`}
                  minWidth={320}
                />
              </Td>
              <Td>
                <SearchPicker
                  value={r.fg}
                  onChange={(v) => {
                    // FG codes are not unique in the product list: fill the name only when the code names one product
                    const hits = masters.products.filter((p) => p.fg === v);
                    set(i, { fg: v, productName: hits.length === 1 ? hits[0].name : masters.productByName.get(r.productName)?.fg === v ? r.productName : "" });
                  }}
                  options={fgOptions}
                  limit={1000}
                  placeholder="Search FG code"
                  ariaLabel={`FG code, row ${i + 1}`}
                  minWidth={320}
                />
              </Td>
              <Td>
                <TextInput value={r.productType} onChange={(v) => set(i, { productType: v })} placeholder="Optional" ariaLabel={`Product type, row ${i + 1}`} />
              </Td>
              <Td right>
                <TextInput numeric value={r.qty} onChange={(v) => set(i, { qty: v })} placeholder="0" ariaLabel={`Target qty, row ${i + 1}`} />
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
        </Table>
      </Card>

      <Card title="Material availability for this plan" step={shorts ? `${shorts} SHORT` : undefined} role={`${materials.length} PM items`}>
        {materials.length === 0 ? (
          <EmptyNote>Add products and target qty to see the material requirement.</EmptyNote>
        ) : (
          <PmRequirementTable materials={materials} />
        )}
      </Card>
    </div>
  );
}

/** PM required vs present for a plan, short rows tinted, with a total row. */
export function PmRequirementTable({ materials }: { materials: PlanMaterial[] }) {
  const shorts = materials.filter((m) => m.short > 0).length;
  return (
    <Table
      minWidth={900}
      headers={[
        "PM required item name",
        { label: "Required qty", align: "right" },
        { label: "On hand", align: "right" },
        { label: "Reserved by other plans", align: "right" },
        { label: "Available", align: "right" },
        { label: "Short by", align: "right" },
        "Status",
        "Used in SKUs",
      ]}
    >
      {materials.map((m, i) => (
        <Tr key={m.code} zebra={i % 2 === 1} bg={m.short ? "var(--red-soft)" : undefined}>
          <Td>
            {m.name} <span className="num text-muted">{m.code}</span>
          </Td>
          <Td right num>{fmt(m.required)} {m.unit}</Td>
          <Td right num>{fmt(m.onHand)}</Td>
          <Td right num muted>{m.reservedOthers ? fmt(m.reservedOthers) : "—"}</Td>
          <Td right num>{fmt(m.present)} {m.unit}</Td>
          <Td right num strong>{m.short ? `${fmt(m.short)} ${m.unit}` : "—"}</Td>
          <Td>{m.short ? <Chip label="SHORT" tone="red" /> : <Chip label="AVAILABLE" tone="green" />}</Td>
          <Td muted>{m.skus.join(", ")}</Td>
        </Tr>
      ))}
      <tr className="border-t-2 border-ink bg-[#F3F5F8] text-[12.5px] font-bold">
        <td className="px-2 py-2.5">TOTAL — {materials.length} PM item(s)</td>
        <td className="num px-2 py-2.5 text-right">{fmt(materials.reduce((n, m) => n + m.required, 0))}</td>
        <td className="px-2 py-2.5 text-center" colSpan={5}>
          {shorts} item(s) short
        </td>
        <td className="px-2 py-2.5">{new Set(materials.flatMap((m) => m.skus)).size} SKU(s)</td>
      </tr>
    </Table>
  );
}
