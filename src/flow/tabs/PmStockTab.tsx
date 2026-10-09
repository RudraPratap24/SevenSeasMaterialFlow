import { useMemo, useState } from "react";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, Table, Td, Tr, fmt } from "../ui";

export function PmStockTab() {
  const { pmStock } = useFlow();
  const [query, setQuery] = useState("");
  const [onlyMoved, setOnlyMoved] = useState(true);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = pmStock;
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
  }, [pmStock, query, onlyMoved]);

  return (
    <div className="space-y-3">
      <Card
        title="Store Stock — Packing Material"
        step="STEPS 9–10"
        role="Store"
        right={
          <>
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
          minWidth={1000}
          headers={[
            "Code",
            "Component",
            "Type",
            { label: "Opening", align: "right" },
            { label: "Received (QC OK)", align: "right" },
            { label: "Issued", align: "right" },
            { label: "Returned (MRN)", align: "right" },
            { label: "Closing", align: "right" },
            { label: "Under test", align: "right" },
            { label: "Hold", align: "right" },
            { label: "Rejected", align: "right" },
          ]}
        >
          {rows.map((r, i) => (
            <Tr key={r.code} zebra={i % 2 === 1}>
              <Td num muted>{r.code}</Td>
              <Td>{r.name}</Td>
              <Td muted>{r.type}</Td>
              <Td right num>{fmt(r.opening)}</Td>
              <Td right num>{r.received > 0 ? fmt(r.received) : "—"}</Td>
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
                  {fmt(r.closing)}
                </span>
              </Td>
              <Td right num>
                {r.underTest > 0 ? <Chip label={fmt(r.underTest)} tone="blue" /> : "—"}
              </Td>
              <Td right num>
                {r.hold > 0 ? <Chip label={fmt(r.hold)} tone="amber" /> : "—"}
              </Td>
              <Td right num>
                {r.rejected > 0 ? <Chip label={fmt(r.rejected)} tone="red" /> : "—"}
              </Td>
            </Tr>
          ))}
        </Table>
        {rows.length === 0 && (
          <EmptyNote>
            {query.trim()
              ? "No component matches that search."
              : "No stock movement yet — receive material through a GRN and approve it in QC, or untick the filter to browse all components."}
          </EmptyNote>
        )}
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        Closing = opening + QC-approved receipts − issues + MRN returns. Amber closing = below
        minimum level (on the purchase short list). Under-test, hold and
        rejected quantities are counted separately and are not usable stock — exactly the SOP's
        quarantine rule. Component list and codes are your data ({fmt(pmStock.length)} components,
        PMS series); opening balances are zero on an empty start and seeded figures with demo
        data loaded.
      </p>
    </div>
  );
}
