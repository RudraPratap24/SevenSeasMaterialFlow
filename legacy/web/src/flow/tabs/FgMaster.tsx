import { useEffect, useMemo, useState } from "react";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, Pager, Table, Td, Tr, usePaged } from "../ui";

const dec = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 4 });

/** Read-only: every finished good and the items (with qty per 100) the production plan uses for it. */
export function FgMaster() {
  const { masters } = useFlow();
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const all = useMemo(() => masters.products.map((p) => ({ ...p, lines: masters.bomOf(p.name) })), [masters]);
  const missing = all.filter((p) => p.lines.length === 0).length;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (p) =>
        (!onlyMissing || p.lines.length === 0) &&
        (!q || p.name.toLowerCase().includes(q) || p.fg.toLowerCase().includes(q) || p.lines.some((l) => l.c.toLowerCase().includes(q))),
    );
  }, [all, query, onlyMissing]);
  const paged = usePaged(rows, 20);
  const { setPage } = paged;
  useEffect(() => setPage(0), [query, onlyMissing, setPage]);

  return (
    <Card
      title="FG Master / BOM"
      step="READ ONLY"
      role={`${all.length} FG · ${missing} without BOM`}
      right={
        <>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            Only FG without BOM
          </label>
          <input
            className="field h-8 w-[240px]"
            type="search"
            placeholder="Search FG code, name or item code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search finished goods"
          />
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyNote>No finished good matches.</EmptyNote>
      ) : (
        <Table headers={["FG code", "Finished good", { label: "Items", align: "right" }, "BOM"]}>
          {paged.rows.map((p, i) => (
            <FgRow key={p.name} zebra={i % 2 === 1} p={p} open={open === p.name} toggle={() => setOpen(open === p.name ? null : p.name)} />
          ))}
        </Table>
      )}
      <Pager {...paged} />
    </Card>
  );
}

function FgRow({
  p,
  zebra,
  open,
  toggle,
}: {
  p: { fg: string; name: string; lines: { c: string; n: string; p: number }[] };
  zebra: boolean;
  open: boolean;
  toggle: () => void;
}) {
  return (
    <>
      <Tr zebra={zebra}>
        <Td num strong>{p.fg || "—"}</Td>
        <Td>
          {p.lines.length ? (
            <button className="text-left hover:underline" onClick={toggle} aria-expanded={open}>
              {open ? "▾" : "▸"} {p.name}
            </button>
          ) : (
            p.name
          )}
        </Td>
        <Td right num>{p.lines.length || "—"}</Td>
        <Td>
          {p.lines.length ? <Chip label="BOM OK" tone="green" /> : <Chip label="NO BOM" tone="red" />}
        </Td>
      </Tr>
      {open && (
        <tr>
          <td colSpan={4} className="bg-zebra px-3 py-2">
            <div className="overflow-hidden rounded-[3px] border border-rule bg-white">
              <Table headers={["Item code", "Item", { label: "Qty per 1 FG", align: "right" }]}>
                {p.lines.map((l, i) => (
                  <Tr key={l.c} zebra={i % 2 === 1}>
                    <Td num>{l.c}</Td>
                    <Td>{l.n}</Td>
                    <Td right num>{dec(l.p / 100)}</Td>
                  </Tr>
                ))}
              </Table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
