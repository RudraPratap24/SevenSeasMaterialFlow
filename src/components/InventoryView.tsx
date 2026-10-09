import { memo, useMemo, useRef, useState } from "react";
import { Upload, RotateCcw } from "lucide-react";
import { fmt } from "../lib/format";
import { COMPONENT_TYPES, SEED_INVENTORY } from "../lib/data";
import { importStockCsv, importSummary, type ImportResult } from "../lib/csvImport";
import type { InventoryRow, StockMap } from "../lib/types";

const COLS = "96px minmax(0,1fr) 116px 96px 96px 96px 108px";

type Field = "opening" | "inward" | "outward" | "closing";
type SortCol = "code" | "name" | "type" | Field;

interface Props {
  stock: StockMap;
  onEdit: (code: string, field: Field, value: number) => void;
  onReplaceAll: (next: StockMap) => void;
  onReset: () => void;
}

export function InventoryView({ stock, onEdit, onReplaceAll, onReset }: Props) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("code");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [report, setReport] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = Object.values(stock);

    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q) ||
          r.type.toLowerCase().includes(q),
      );
    }
    if (type) list = list.filter((r) => r.type === type);

    const sign = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if (sortCol === "code" || sortCol === "name" || sortCol === "type") {
        const c = String(a[sortCol]).localeCompare(String(b[sortCol]), "en", {
          sensitivity: "base",
        });
        return c !== 0 ? sign * c : a.code.localeCompare(b.code);
      }
      const d = a[sortCol] - b[sortCol];
      return d !== 0 ? sign * d : a.code.localeCompare(b.code);
    });

    return list;
  }, [stock, query, type, sortCol, sortDir]);

  function sortBy(col: SortCol) {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir(col === "code" || col === "name" || col === "type" ? "asc" : "desc");
    }
  }

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onerror = () =>
      setReport({
        ok: false,
        updated: 0,
        known: Object.keys(stock).length,
        rowsRead: 0,
        unrecognised: [],
        warnings: [],
        errors: [{ row: null, message: "The file could not be read." }],
        next: null,
      });
    reader.onload = () => {
      const result = importStockCsv(String(reader.result ?? ""), stock);
      if (result.next && result.updated > 0) onReplaceAll(result.next);
      setReport(result);
    };
    reader.readAsText(file);
  }

  const total = Object.keys(stock).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="card flex flex-wrap items-center gap-2 px-3 py-2.5">
        <input
          className="field h-8 w-[260px]"
          type="search"
          placeholder="Search code, name or type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search components"
        />

        <select
          className="field h-8 w-[150px]"
          value={type}
          onChange={(e) => setType(e.target.value)}
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {COMPONENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <span className="num text-[11.5px] text-muted">
          {fmt(rows.length)} of {fmt(total)}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = "";
            }}
          />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Upload size={13} strokeWidth={2.25} />
            Import stock from CSV
          </button>
          <button
            className="btn"
            onClick={() => {
              onReset();
              setReport(null);
            }}
          >
            <RotateCcw size={13} strokeWidth={2.25} />
            Reset to seed data
          </button>
        </div>
      </div>

      {report && <ImportReport report={report} onDismiss={() => setReport(null)} />}

      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto">
          <div role="table" aria-label="Packing component stock">
            <div
              role="row"
              className="sticky top-0 z-10 grid gap-2 border-b border-rule bg-card px-3 py-2"
              style={{ gridTemplateColumns: COLS }}
            >
              <Head label="Code" col="code" {...{ sortCol, sortDir, sortBy }} />
              <Head label="Component name" col="name" {...{ sortCol, sortDir, sortBy }} />
              <Head label="Type" col="type" {...{ sortCol, sortDir, sortBy }} />
              <Head label="Opening" col="opening" align="right" {...{ sortCol, sortDir, sortBy }} />
              <Head label="Inward" col="inward" align="right" {...{ sortCol, sortDir, sortBy }} />
              <Head label="Outward" col="outward" align="right" {...{ sortCol, sortDir, sortBy }} />
              <Head label="Closing" col="closing" align="right" {...{ sortCol, sortDir, sortBy }} />
            </div>

            {rows.map((row, i) => (
              <StockRow key={row.code} row={row} zebra={i % 2 === 1} onEdit={onEdit} />
            ))}

            {rows.length === 0 && (
              <p className="px-3 py-6 text-[12.5px] text-muted">
                No component matches that search.
              </p>
            )}
          </div>
        </div>

        <p className="border-t border-rule px-3 py-2 text-[11px] leading-relaxed text-muted">
          Column order matches your <span className="font-semibold">PM HEADER AND STOCK</span>{" "}
          sheet exactly — SR NO · COMPONENT NAME · TYPE · COMPONENT CODE · OPENING · INWARD ·
          OUTWARD · CLOSING. Component names, codes and types are your data; the stock figures
          are demo values. Any cell here is editable, and editing CLOSING rebalances INWARD /
          OUTWARD so that opening + inward − outward = closing still holds.
        </p>
      </div>
    </div>
  );
}

function Head({
  label,
  col,
  align = "left",
  sortCol,
  sortDir,
  sortBy,
}: {
  label: string;
  col: SortCol;
  align?: "left" | "right";
  sortCol: SortCol;
  sortDir: "asc" | "desc";
  sortBy: (c: SortCol) => void;
}) {
  const active = sortCol === col;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        className={`col-head w-full ${align === "right" ? "text-right" : "text-left"} hover:text-blue`}
        style={active ? { color: "var(--blue-dk)" } : undefined}
        onClick={() => sortBy(col)}
      >
        {label}
        <span aria-hidden="true">{active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span>
      </button>
    </div>
  );
}

const StockRow = memo(function StockRow({
  row,
  zebra,
  onEdit,
}: {
  row: InventoryRow;
  zebra: boolean;
  onEdit: (code: string, field: Field, value: number) => void;
}) {
  const seed = SEED_LOOKUP[row.code];
  const changed =
    seed &&
    (seed.opening !== row.opening ||
      seed.inward !== row.inward ||
      seed.outward !== row.outward ||
      seed.closing !== row.closing);

  return (
    <div
      role="row"
      className="grid items-center gap-2 border-b border-rule px-3"
      style={{ background: zebra ? "#FBFCFD" : "var(--card)", gridTemplateColumns: COLS }}
    >
      <div role="cell" className="num py-2 text-[12px] text-muted">
        {row.code}
      </div>
      <div role="cell" className="truncate py-2 text-[13px] font-medium" title={row.name}>
        {row.name}
        {changed && (
          <span className="ml-2 text-[10px] font-bold uppercase tracking-[.06em] text-blue">
            edited
          </span>
        )}
      </div>
      <div role="cell" className="truncate py-2 text-[11.5px] text-muted">
        {row.type}
      </div>
      <Cell row={row} field="opening" onEdit={onEdit} />
      <Cell row={row} field="inward" onEdit={onEdit} />
      <Cell row={row} field="outward" onEdit={onEdit} />
      <Cell row={row} field="closing" onEdit={onEdit} strong />
    </div>
  );
});

const SEED_LOOKUP: Record<string, InventoryRow> = Object.fromEntries(
  SEED_INVENTORY.map((r) => [r.code, r]),
);

/** Click, type, Enter. Commit happens on Enter or blur; Esc cancels. §5 */
function Cell({
  row,
  field,
  onEdit,
  strong = false,
}: {
  row: InventoryRow;
  field: Field;
  onEdit: (code: string, field: Field, value: number) => void;
  strong?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div role="cell" className="py-1">
      <input
        className={`num h-7 w-full rounded-[2px] border border-transparent bg-transparent px-1.5 text-right ${
          strong ? "text-[14.5px] font-bold" : "text-[13px]"
        } hover:border-rule focus:border-blue focus:bg-white`}
        type="text"
        inputMode="numeric"
        aria-label={`${field} for ${row.code}`}
        value={draft ?? fmt(row[field])}
        onFocus={(e) => {
          setDraft(String(row[field]));
          window.setTimeout(() => e.target.select(), 0);
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => {
          if (draft !== null && draft !== String(row[field])) {
            onEdit(row.code, field, Number(draft === "" ? 0 : draft));
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function ImportReport({
  report,
  onDismiss,
}: {
  report: ImportResult;
  onDismiss: () => void;
}) {
  const failed = report.updated === 0;
  return (
    <div
      className="card px-3 py-2.5"
      style={{
        background: failed ? "var(--amber-soft)" : "var(--blue-soft)",
        borderLeft: `3px solid ${failed ? "var(--amber)" : "var(--blue)"}`,
      }}
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold">{importSummary(report)}</p>

          {report.unrecognised.length > 0 && (
            <p className="mt-1 text-[11.5px] text-muted">
              Not recognised:{" "}
              <span className="num">
                {report.unrecognised.slice(0, 12).join(", ")}
                {report.unrecognised.length > 12
                  ? ` … +${report.unrecognised.length - 12} more`
                  : ""}
              </span>
            </p>
          )}

          {report.errors.slice(0, 5).map((e, i) => (
            <p key={`e${i}`} className="mt-1 text-[11.5px]" style={{ color: "var(--amber)" }}>
              {e.row ? `Row ${e.row}: ` : ""}
              {e.message}
            </p>
          ))}

          {report.warnings.slice(0, 5).map((w, i) => (
            <p key={`w${i}`} className="mt-1 text-[11.5px] text-muted">
              {w.row ? `Row ${w.row}: ` : ""}
              {w.message}
            </p>
          ))}

          {report.errors.length + report.warnings.length > 10 && (
            <p className="mt-1 text-[11.5px] text-muted">
              … and {report.errors.length + report.warnings.length - 10} more notes.
            </p>
          )}
        </div>

        <button className="btn h-7 shrink-0" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
