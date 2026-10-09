import { memo } from "react";
import { CoverageBar } from "./CoverageBar";
import { fmt, packLabel, shortLabel } from "../lib/format";
import type { SortDir, SortKey } from "../lib/calc";
import type { RequirementRow, Status } from "../lib/types";

const COLS = "minmax(0,1fr) 104px 104px 104px 92px";

const TONE: Record<Status, { dot: string; label: string }> = {
  SHORT: { dot: "var(--red)", label: "Short" },
  TIGHT: { dot: "var(--amber)", label: "Tight" },
  OK: { dot: "var(--green)", label: "OK" },
};

interface Props {
  rows: RequirementRow[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}

export function RequirementTable({ rows, sortKey, sortDir, onSort }: Props) {
  return (
    <div role="table" aria-label="Packing material requirement" className="min-w-0">
      <div
        role="row"
        className="print-sticky sticky top-0 z-10 grid items-end gap-2 border-b border-rule bg-card px-3 pb-1.5 pt-2"
        style={{ gridTemplateColumns: COLS }}
      >
        <HeaderCell label="Component" k="name" {...{ sortKey, sortDir, onSort }} />
        <HeaderCell label="Required" k="requirement" align="right" {...{ sortKey, sortDir, onSort }} />
        <HeaderCell label="Available" k="available" align="right" {...{ sortKey, sortDir, onSort }} />
        <HeaderCell label="Short" k="shortfall" align="right" {...{ sortKey, sortDir, onSort }} />
        <div role="columnheader" className="col-head text-right">
          Status
        </div>
      </div>

      {rows.map((row, i) => (
        <Row key={row.code} row={row} zebra={i % 2 === 1} />
      ))}
    </div>
  );
}

function HeaderCell({
  label,
  k,
  align = "left",
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  k: SortKey;
  align?: "left" | "right";
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const activeSort = sortKey === k;
  return (
    <div role="columnheader" aria-sort={activeSort ? (sortDir === "desc" ? "descending" : "ascending") : "none"}>
      <button
        className={`col-head w-full ${align === "right" ? "text-right" : "text-left"} hover:text-blue`}
        style={activeSort ? { color: "var(--blue-dk)" } : undefined}
        onClick={() => onSort(k)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <span aria-hidden="true">{activeSort ? (sortDir === "desc" ? " ↓" : " ↑") : ""}</span>
      </button>
    </div>
  );
}

const Row = memo(function Row({ row, zebra }: { row: RequirementRow; zebra: boolean }) {
  const tone = TONE[row.status];
  const short = row.shortfall > 0;

  return (
    <div
      role="row"
      className="print-row border-b border-rule px-3 pb-1.5 pt-1.5"
      style={{ background: zebra ? "#FBFCFD" : "var(--card)" }}
    >
      <div className="grid items-center gap-2" style={{ gridTemplateColumns: COLS }}>
        <div role="cell" className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight" title={row.name}>
            {row.name}
          </div>
          <div className="mt-[2px] flex flex-wrap items-center gap-x-2 text-[10.5px] leading-tight text-muted">
            <span className="num">{row.code}</span>
            <span>{packLabel(row.p)}</span>
            {row.type && <span>{row.type}</span>}
            {row.products.length > 1 && (
              <span style={{ color: "var(--blue-dk)" }}>
                across {row.products.length} products
              </span>
            )}
          </div>
        </div>

        <div role="cell" className="num text-right text-[14.5px] font-bold">
          {fmt(row.requirement)}
        </div>

        <div role="cell" className="num text-right text-[14.5px]">
          {fmt(row.available)}
        </div>

        <div
          role="cell"
          className="num text-right text-[14.5px] font-bold"
          style={{ color: short ? "var(--red)" : "var(--muted)" }}
        >
          {shortLabel(row.shortfall)}
        </div>

        <div role="cell" className="flex items-center justify-end gap-1.5">
          <span
            className="inline-block h-[7px] w-[7px] rounded-full"
            style={{ background: tone.dot }}
            aria-hidden="true"
          />
          <span
            className="text-[10.5px] font-bold uppercase tracking-[.06em]"
            style={{ color: short ? "var(--red)" : "var(--muted)" }}
          >
            {tone.label}
          </span>
        </div>
      </div>

      <div className="mt-1.5">
        <CoverageBar coverage={row.coverage} status={row.status} />
      </div>
    </div>
  );
});
