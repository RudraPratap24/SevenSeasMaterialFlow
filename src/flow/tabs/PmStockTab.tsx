import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { reservedTotals } from "../logic";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, Pager, Table, Td, Tr, fmt, fmtQty, usePaged } from "../ui";
import { type BulkUnit, unitLabel } from "./BulkProductionPlan";

interface BulkStockRow {
  itemName: string;
  unit: BulkUnit;
  stock: number;
  underTest: number;
  hold: number;
  rejected: number;
}

/** Bulk made in Bulk Manufacturing: in stock once Quality Testing accepts it. */
/** Every bulk item and its stock (shown in Production → Bulk Production). */
export function BulkStockCard() {
  const { productionTick } = useFlow();
  const [rows, setRows] = useState<BulkStockRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ items: BulkStockRow[] }>("GET", "/bulk-stock").then((r) => setRows(r.items), (e) => setError((e as Error).message));
  }, [productionTick]);
  const q = (n: number, u: BulkUnit) => (n > 0 ? `${fmt(n)} ${unitLabel(u)}` : "—");
  return (
    <Card title="Store Stock — Bulk" step="AFTER QUALITY TESTING" role={`${rows?.length ?? 0} item(s)`}>
      {error ? (
        <EmptyNote>{error}</EmptyNote>
      ) : !rows?.length ? (
        <EmptyNote>{rows ? "No bulk items yet." : "Loading…"}</EmptyNote>
      ) : (
        <Table
          minWidth={800}
          headers={["Bulk item", "Unit", { label: "In stock (QT OK)", align: "right" }, { label: "Under test", align: "right" }, { label: "Hold", align: "right" }, { label: "Rejected", align: "right" }]}
        >
          {rows.map((r, i) => (
            <Tr key={r.itemName} zebra={i % 2 === 1}>
              <Td>{r.itemName}</Td>
              <Td muted>{unitLabel(r.unit)}</Td>
              <Td right num strong>{q(r.stock, r.unit)}</Td>
              <Td right num>{r.underTest > 0 ? <Chip label={q(r.underTest, r.unit)} tone="blue" /> : "—"}</Td>
              <Td right num>{r.hold > 0 ? <Chip label={q(r.hold, r.unit)} tone="amber" /> : "—"}</Td>
              <Td right num>{r.rejected > 0 ? <Chip label={q(r.rejected, r.unit)} tone="red" /> : "—"}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

const KINDS = [
  { k: "ALL", label: "All" },
  { k: "PM", label: "PM" },
  { k: "RM", label: "RM" },
  { k: "OTHER", label: "Other" },
] as const;

export function PmStockTab() {
  const { pmStock, openBoms, masters } = useFlow();
  const [kind, setKind] = useState<(typeof KINDS)[number]["k"]>("ALL");
  // held by open BOM lists (soft reservation) — worked out, never stored
  const reserved = useMemo(
    () => reservedTotals(openBoms, new Map(pmStock.map((s) => [s.code, Math.max(0, s.closing)]))),
    [openBoms, pmStock],
  );
  const [query, setQuery] = useState("");
  const [onlyMoved, setOnlyMoved] = useState(true);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = pmStock;
    if (kind !== "ALL") {
      const kindOf = (code: string) => masters.componentByCode.get(code)?.kind ?? "";
      list = list.filter((r) => (kind === "OTHER" ? !["PM", "RM"].includes(kindOf(r.code)) : kindOf(r.code) === kind));
    }
    if (q) {
      list = list.filter(
        (r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) || r.type.toLowerCase().includes(q),
      );
    }
    if (onlyMoved && !q) {
      list = list.filter(
        (r) =>
          r.received > 0 || r.issued > 0 || r.returned > 0 || r.underTest > 0 || r.hold > 0 || r.rejected > 0,
      );
    }
    return list.slice().sort((a, b) => a.code.localeCompare(b.code));
  }, [pmStock, query, onlyMoved, kind, masters]);
  const paged = usePaged(rows, 100);
  const { setPage } = paged;
  useEffect(() => setPage(0), [query, onlyMoved, kind, setPage]);

  return (
    <div className="space-y-3">
      <Card
        title="Store Stock — PM & RM"
        step="STEPS 9–10"
        role="Store"
        right={
          <>
            <div className="flex overflow-hidden rounded-[3px] border border-rule" role="group" aria-label="Show items of kind">
              {KINDS.map((x) => (
                <button
                  key={x.k}
                  className="h-8 px-2.5 text-[11.5px] font-semibold"
                  style={kind === x.k ? { background: "var(--blue)", color: "#fff" } : undefined}
                  aria-pressed={kind === x.k}
                  onClick={() => setKind(x.k)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted">
              <input
                type="checkbox"
                checked={onlyMoved}
                onChange={(e) => setOnlyMoved(e.target.checked)}
              />
              Only components with movement
            </label>
            <input
              className="field h-8 w-[240px]"
              type="search"
              placeholder="Search code, name or type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search stock"
            />
          </>
        }
      >
        <Table
          minWidth={1150}
          headers={[
            "Code",
            "Component",
            "Type",
            { label: "Opening", align: "right" },
            { label: "Received (QC OK)", align: "right" },
            { label: "Issued", align: "right" },
            { label: "Returned (MRN)", align: "right" },
            { label: "Closing", align: "right" },
            { label: "Reserved", align: "right" },
            { label: "Available", align: "right" },
            { label: "Under test", align: "right" },
            { label: "Hold", align: "right" },
            { label: "Rejected", align: "right" },
          ]}
        >
          {paged.rows.map((r, i) => {
            // Pcs rows as before; a Kg/Doz row shows its unit on every figure.
            const q = (n: number) => (r.unit ? fmtQty(n, r.unit) : fmt(n));
            return (
            <Tr key={r.code} zebra={i % 2 === 1}>
              <Td num muted>{r.code}</Td>
              <Td>{r.name}</Td>
              <Td muted>{r.type}</Td>
              <Td right num>{fmt(r.opening)}</Td>
              <Td right num>{r.received > 0 ? q(r.received) : "—"}</Td>
              <Td right num>{r.issued > 0 ? fmt(r.issued) : "—"}</Td>
              <Td right num>{r.returned > 0 ? fmt(r.returned) : "—"}</Td>
              <Td right num strong>
                <span
                  style={
                    r.minLevel !== null && r.closing < r.minLevel
                      ? { color: "var(--amber)" }
                      : undefined
                  }
                  title={r.minLevel !== null ? `Minimum level ${r.minLevel}` : undefined}
                >
                  {q(r.closing)}
                </span>
              </Td>
              <Td right num muted>{reserved.get(r.code) ? fmt(reserved.get(r.code)!) : "—"}</Td>
              <Td right num>{q(Math.max(0, r.closing) - (reserved.get(r.code) ?? 0))}</Td>
              <Td right num>
                {r.underTest > 0 ? <Chip label={q(r.underTest)} tone="blue" /> : "—"}
              </Td>
              <Td right num>
                {r.hold > 0 ? <Chip label={q(r.hold)} tone="amber" /> : "—"}
              </Td>
              <Td right num>
                {r.rejected > 0 ? <Chip label={q(r.rejected)} tone="red" /> : "—"}
              </Td>
            </Tr>
            );
          })}
        </Table>
        <Pager {...paged} />
        {rows.length === 0 && (
          <EmptyNote>
            {query.trim()
              ? "No component matches that search."
              : "No stock movement yet — receive material through a GRN and approve it in QC, or untick the filter to browse all components."}
          </EmptyNote>
        )}
      </Card>


      <p className="text-[11px] leading-relaxed text-muted">
        Closing = opening + QC-approved receipts − issues + MRN returns. Reserved = held by open BOM lists
        (generated, not yet issued or cancelled; earlier production date first); Available = closing − reserved. Amber closing = below
        minimum level (on the purchase short list). Under-test, hold and
        rejected quantities are counted separately and are not usable stock — exactly the SOP's
        quarantine rule. Material received in Kg or Doz has its own row in that unit until
        the unit conversions are loaded; it cannot be issued as pieces yet. Component list and codes are your data ({fmt(pmStock.length)} components,
        PMS series); opening balances are zero on an empty start and seeded figures with demo
        data loaded.
      </p>
    </div>
  );
}
