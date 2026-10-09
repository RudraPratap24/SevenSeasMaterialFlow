import { coveragePct } from "../lib/format";
import type { Status } from "../lib/types";

const FILL: Record<Status, string> = {
  SHORT: "var(--red)",
  TIGHT: "var(--amber)",
  OK: "var(--green)",
};

/**
 * §6.3 — how far stock goes toward the requirement. When the row is short the
 * missing remainder is hatched in red, so the gap reads as a thing, not as absence.
 */
export function CoverageBar({
  coverage,
  status,
}: {
  coverage: number;
  status: Status;
}) {
  const pct = coveragePct(coverage);

  return (
    <div
      className="flex h-1 w-full overflow-hidden rounded-[2px] bg-rule"
      aria-hidden="true"
    >
      <div
        className="h-full motion-safe:transition-[width] motion-safe:duration-[180ms] motion-safe:ease-out"
        style={{ width: `${pct}%`, background: FILL[status] }}
      />
      {status === "SHORT" && <div className="hatch h-full flex-1" />}
    </div>
  );
}
