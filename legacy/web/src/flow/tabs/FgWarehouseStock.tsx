import { useEffect, useMemo, useState } from "react";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, Pager, Table, Td, Tr, fmt, usePaged } from "../ui";

interface Row {
  code: string;
  name: string;
  type: string;
  opening: number;
  received: number;
  issued: number;
  closing: number;
  reserved: number;
  /** Open orders not yet dispatched — may be more than the stock; only `reserved` (≤ closing) is held. */
  ordered: number;
  underTest: number;
  rejected: number;
}

/**
 * FG stock per finished good, in PM Stock's columns. Like PM, usable stock is what passed its check (PDI):
 * closing = opening + received (PDI passed) − dispatched; batches waiting for PDI or failed are shown apart.
 */
export function FgWarehouseStock() {
  const { fgStock, orderProgress, masters } = useFlow();
  const [query, setQuery] = useState("");
  const [onlyMoved, setOnlyMoved] = useState(true);

  const all = useMemo(() => {
    const rows = new Map<string, Row>();
    const row = (name: string, code = "") => {
      let r = rows.get(name);
      if (!r) {
        const p = masters.productByName.get(name);
        r = { code: p?.fg || code, name, type: p?.category ?? "", opening: 0, received: 0, issued: 0, closing: 0, reserved: 0, ordered: 0, underTest: 0, rejected: 0 };
        rows.set(name, r);
      }
      return r;
    };
    for (const p of masters.products) row(p.name, p.fg);
    for (const b of fgStock) {
      const r = row(b.productName, b.productCode);
      if (b.pdi === "PENDING") r.underTest += b.inStock;
      else if (b.pdi === "FAILED") r.rejected += b.inStock;
      else {
        if (b.batchNo === "OPENING") r.opening += b.received;
        else r.received += b.received;
        r.issued += b.dispatched;
      }
    }
    for (const o of orderProgress) {
      if (!o.open) continue;
      for (const l of o.lines) if (l.balance > 0) row(l.productName, l.productCode).ordered += l.balance;
    }
    for (const r of rows.values()) {
      r.closing = r.opening + r.received - r.issued;
      r.reserved = Math.min(r.ordered, Math.max(0, r.closing)); // never hold more than is in stock
    }
    return [...rows.values()];
  }, [fgStock, orderProgress, masters]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) || r.type.toLowerCase().includes(q))
      .filter((r) => q || !onlyMoved || r.opening || r.received || r.issued || r.underTest || r.rejected || r.ordered)
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [all, query, onlyMoved]);
  const paged = usePaged(rows, 100);
  const { setPage } = paged;
  useEffect(() => setPage(0), [query, onlyMoved, setPage]);
  const dash = (n: number) => (n ? fmt(n) : "—");

  return (
    <Card
      title="FG Warehouse Stock"
      role="FG Warehouse"
      right={
        <>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted">
            <input type="checkbox" checked={onlyMoved} onChange={(e) => setOnlyMoved(e.target.checked)} />
            Only FG with stock or movement
          </label>
          <input
            className="field h-8 w-[240px]"
            type="search"
            placeholder="Search FG code, name or type…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search finished goods"
          />
        </>
      }
    >
      <Table
        minWidth={1100}
        headers={[
          "Code",
          "Finished good",
          "Type",
          { label: "Opening", align: "right" },
          { label: "Received", align: "right" },
          { label: "Issued", align: "right" },
          { label: "Returned", align: "right" },
          { label: "Closing", align: "right" },
          { label: "Reserved", align: "right" },
          { label: "Available", align: "right" },
          { label: "Under test", align: "right" },
          { label: "Hold", align: "right" },
          { label: "Rejected", align: "right" },
        ]}
      >
        {paged.rows.map((r, i) => (
          <Tr key={r.name} zebra={i % 2 === 1}>
            <Td num muted>{r.code || "—"}</Td>
            <Td>{r.name}</Td>
            <Td muted>{r.type}</Td>
            <Td right num>{fmt(r.opening)}</Td>
            <Td right num>{dash(r.received)}</Td>
            <Td right num>{dash(r.issued)}</Td>
            <Td right num>—</Td>
            <Td right num strong>{fmt(r.closing)}</Td>
            <Td right num muted>
              <span title={r.ordered > r.reserved ? `Open orders ${fmt(r.ordered)} — ${fmt(r.ordered - r.reserved)} more than in stock` : undefined}>
                {dash(r.reserved)}
              </span>
              {r.ordered > r.reserved && <Chip label={`SHORT ${fmt(r.ordered - r.reserved)}`} tone="amber" />}
            </Td>
            <Td right num>{fmt(Math.max(0, r.closing) - r.reserved)}</Td>
            <Td right num>{r.underTest > 0 ? <Chip label={fmt(r.underTest)} tone="blue" /> : "—"}</Td>
            <Td right num>—</Td>
            <Td right num>{r.rejected > 0 ? <Chip label={fmt(r.rejected)} tone="red" /> : "—"}</Td>
          </Tr>
        ))}
      </Table>
      <Pager {...paged} />
      {rows.length === 0 && <EmptyNote>{query.trim() ? "No finished good matches that search." : "No FG stock or movement yet."}</EmptyNote>}
      <p className="border-t border-rule px-3 py-2 text-[11px] leading-relaxed text-muted">
        Closing = opening + received (batches that passed PDI) − issued (dispatched). Reserved = open customer orders not yet
        dispatched, never more than the closing stock (orders beyond it show SHORT); Available = closing − reserved. Under test = received batches waiting for PDI; Rejected = batches that failed PDI —
        neither can be dispatched. FG has no hold or returns.
      </p>
    </Card>
  );
}
