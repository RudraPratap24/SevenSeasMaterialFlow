import { useMemo } from "react";
import { useFlow, type TabId, type TraceEvent } from "../store";
import { Card, Chip, Icon, RoleTag, fmt } from "../ui";

interface StepDef {
  n: number;
  title: string;
  role: string;
  tab: TabId;
}

/** The 22 steps of SOP/SCM/001 v2.1, as narrated in the client's video. */
const STEPS: StepDef[] = [
  { n: 1, title: "Material vehicle at factory gate", role: "Security / Supplier", tab: "gate" },
  { n: 2, title: "Entry in Gate Entry Register", role: "Security", tab: "gate" },
  { n: 3, title: "Invoice check + unload", role: "Store", tab: "grn" },
  { n: 4, title: "GRN created in system", role: "Store", tab: "grn" },
  { n: 5, title: "Quarantine — UNDER TEST until QC", role: "Store", tab: "grn" },
  { n: 6, title: "QC Intimation Slip to QC dept", role: "Store → QC", tab: "qc" },
  { n: 7, title: "Testing + A.R. No generated", role: "QC", tab: "qc" },
  { n: 8, title: "QC status: Approved / Hold / Reject", role: "QC", tab: "qc" },
  { n: 9, title: "Approved → warehouse · Rejected → rejection area", role: "QC → Store", tab: "pmstock" },
  { n: 10, title: "Barcode sticker on approved material", role: "Store", tab: "grn" },
  { n: 11, title: "Requisition slip from production", role: "Production", tab: "requisition" },
  { n: 12, title: "Material issued to packing", role: "Store → Packing", tab: "requisition" },
  { n: 13, title: "System update + signed receiving", role: "Store", tab: "requisition" },
  { n: 14, title: "Packing as per plan", role: "Packing", tab: "fg" },
  { n: 15, title: "FG Transfer Note to FG warehouse", role: "Production → FG WH", tab: "fg" },
  { n: 16, title: "FG receiving verified + signed", role: "FG Warehouse", tab: "fg" },
  { n: 17, title: "FG system stock, decided location", role: "FG Warehouse", tab: "fg" },
  { n: 18, title: "Order released → dispatch + system OUT", role: "FG WH (CRM order)", tab: "dispatch" },
  { n: 19, title: "Packing list to Accounts", role: "FG WH → Accounts", tab: "dispatch" },
  { n: 20, title: "Invoice prepared", role: "Accounts", tab: "dispatch" },
  { n: 21, title: "Security verifies invoice + packing list", role: "Security", tab: "dispatch" },
  { n: 22, title: "Gate out — dispatch complete", role: "Security", tab: "dispatch" },
];

const GROUPS: { label: string; from: number; to: number }[] = [
  { label: "Inward", from: 1, to: 5 },
  { label: "Quality Control", from: 6, to: 10 },
  { label: "Store → Packing", from: 11, to: 14 },
  { label: "FG Warehouse", from: 15, to: 17 },
  { label: "Dispatch", from: 18, to: 22 },
];

export function FlowTab({
  goTo,
  trace,
  traceValue,
  onPickTrace,
}: {
  goTo: (tab: TabId) => void;
  trace: { label: string; events: TraceEvent[] } | null;
  /** "batch::LL112-B01" | "grn::GR0004" | "" — the select mirrors the shown trace. */
  traceValue: string;
  onPickTrace: (value: string) => void;
}) {
  const { state, pmStock, fgStock, hasData } = useFlow();

  const counts = useMemo(() => {
    const grn = state.grnLines;
    return {
      gate: state.gateEntries.length,
      grn: grn.length,
      underTest: grn.filter((g) => g.qcStatus === "UNDER_TEST").length,
      hold: grn.filter((g) => g.qcStatus === "HOLD").length,
      rejected: grn.filter((g) => g.qcStatus === "REJECTED").length,
      approved: grn.filter((g) => g.qcStatus === "APPROVED").length,
      reqPending: state.requisitions.filter((r) => r.status === "PENDING").length,
      reqIssued: state.requisitions.filter((r) => r.status === "ISSUED").length,
      fgInTransit: state.fgTransfers.filter((t) => t.status === "IN_TRANSIT").length,
      fgStockUnits: fgStock.reduce((n, r) => n + r.inStock, 0),
      dispatchOpen: state.dispatchSlips.filter((d) => !d.gateOut).length,
      dispatchDone: state.dispatchSlips.filter((d) => d.gateOut).length,
      pmWithStock: pmStock.filter((r) => r.closing > 0).length,
    };
  }, [state, pmStock, fgStock]);

  const badgeFor = (n: number): { label: string; tone: "muted" | "blue" | "green" | "amber" | "red" } | null => {
    switch (n) {
      case 2:
        return { label: `${fmt(counts.gate)} entries`, tone: "muted" };
      case 4:
        return { label: `${fmt(counts.grn)} GRNs`, tone: "muted" };
      case 5:
        return counts.underTest > 0
          ? { label: `${fmt(counts.underTest)} under test`, tone: "blue" }
          : null;
      case 8:
        return counts.hold > 0 ? { label: `${fmt(counts.hold)} on hold`, tone: "amber" } : null;
      case 9:
        return counts.rejected > 0
          ? { label: `${fmt(counts.rejected)} rejected`, tone: "red" }
          : null;
      case 11:
        return counts.reqPending > 0
          ? { label: `${fmt(counts.reqPending)} pending`, tone: "amber" }
          : { label: `${fmt(counts.reqIssued)} issued`, tone: "muted" };
      case 15:
        return counts.fgInTransit > 0
          ? { label: `${fmt(counts.fgInTransit)} in transit`, tone: "amber" }
          : null;
      case 17:
        return { label: `${fmt(counts.fgStockUnits)} pcs in FG stock`, tone: "muted" };
      case 22:
        return counts.dispatchOpen > 0
          ? { label: `${fmt(counts.dispatchOpen)} awaiting gate out`, tone: "amber" }
          : { label: `${fmt(counts.dispatchDone)} dispatched`, tone: "muted" };
      default:
        return null;
    }
  };

  const batches = useMemo(() => {
    const set = new Set<string>();
    for (const t of state.fgTransfers) for (const l of t.lines) set.add(l.batchNo);
    for (const r of state.requisitions) if (r.batchNo) set.add(r.batchNo);
    return [...set].sort();
  }, [state.fgTransfers, state.requisitions]);

  return (
    <div className="space-y-3">
      {!hasData && (
        <div
          className="rounded-[4px] border border-rule px-4 py-3"
          style={{ background: "var(--blue-soft)", borderLeft: "3px solid var(--blue)" }}
        >
          <p className="text-[14px] font-bold">Everything is empty — the registers are yours to fill.</p>
          <p className="mt-1 text-[12px] text-muted">
            Follow the SOP top to bottom: start with a <b>Gate Entry</b>, make a <b>GRN</b> against
            it, send it to <b>QC</b> and approve — stock appears the moment QC clears it. Or press{" "}
            <b>Load demo data</b> (top right) to see a filled example.
          </p>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <Card title="Material flow — inward to dispatch" step="22 STEPS" role="SOP/SCM/001 v2.1">
        <div className="px-3 py-2">
          {GROUPS.map((grp) => (
            <div key={grp.label} className="mb-2 last:mb-0">
              <p className="col-head mb-1 mt-2">{grp.label}</p>
              <ol>
                {STEPS.filter((s) => s.n >= grp.from && s.n <= grp.to).map((s) => {
                  const badge = badgeFor(s.n);
                  return (
                    <li key={s.n} className="border-b border-rule last:border-b-0">
                      <button
                        className="flex w-full items-center gap-2 px-1 py-[7px] text-left hover:bg-blue-soft"
                        onClick={() => goTo(s.tab)}
                        title={`Open the ${s.title} register`}
                      >
                        <span className="num w-6 shrink-0 text-right text-[11px] font-bold text-muted">
                          {s.n}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                          {s.title}
                        </span>
                        {badge && <Chip label={badge.label} tone={badge.tone} />}
                        <RoleTag role={s.role} />
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      </Card>

      <div className="space-y-3">
        <Card
          title="Traceability"
          role="Any document, end to end"
          right={
            <select
              className="field h-8 w-[220px]"
              value={traceValue}
              onChange={(e) => onPickTrace(e.target.value)}
              aria-label="Pick a batch or GRN to trace"
            >
              <option value="">Trace a batch or GRN…</option>
              <optgroup label="FG batches">
                {batches.map((b) => (
                  <option key={b} value={`batch::${b}`}>
                    Batch {b}
                  </option>
                ))}
              </optgroup>
              <optgroup label="GRNs (components)">
                {state.grnLines.map((g) => (
                  <option key={g.grnNo} value={`grn::${g.grnNo}`}>
                    {g.grnNo} — {g.componentName}
                  </option>
                ))}
              </optgroup>
            </select>
          }
        >
          {!trace ? (
            <p className="px-3 py-5 text-[12.5px] text-muted">
              Pick a batch or a GRN — every register it touched appears here as one timeline:
              gate entry to gate out.
            </p>
          ) : trace.events.length === 0 ? (
            <p className="px-3 py-5 text-[12.5px] text-muted">
              No movements recorded yet for {trace.label}.
            </p>
          ) : (
            <div className="px-3 py-3">
              <p className="mb-2 text-[13px] font-bold">{trace.label}</p>
              <ol className="relative ml-2 border-l border-rule pl-4">
                {trace.events.map((e, i) => (
                  <li key={i} className="relative pb-3 last:pb-0">
                    <span
                      className="absolute -left-[21px] top-[5px] h-2 w-2 rounded-full"
                      style={{
                        background:
                          e.title.includes("REJECTED") || e.title.includes("Reject")
                            ? "var(--red)"
                            : e.stage >= 22
                              ? "var(--green)"
                              : "var(--blue)",
                      }}
                      aria-hidden="true"
                    />
                    <button
                      className="w-full text-left hover:bg-blue-soft"
                      onClick={() => goTo(e.tab)}
                      title="Open this register"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="num text-[10.5px] font-bold text-muted">Step {e.stage}</span>
                        <span className="text-[12.5px] font-semibold">{e.title}</span>
                        <span className="num text-[11px] text-muted">{e.doc}</span>
                        <span className="num ml-auto text-[10.5px] text-muted">{e.date}</span>
                      </div>
                      <div className="mt-[2px] flex items-center gap-2">
                        <RoleTag role={e.role} />
                        <span className="truncate text-[11.5px] text-muted">{e.detail}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>

        <Card title="Today at a glance" role="Live from the registers">
          <div className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-3">
            {(
              [
                { label: "GRNs under test", value: counts.underTest, icon: "box", alert: false },
                { label: "On hold", value: counts.hold, icon: "pause", alert: false },
                { label: "Rejected", value: counts.rejected, icon: "reject", alert: true },
                { label: "Requisitions pending", value: counts.reqPending, icon: "doc", alert: false },
                { label: "FG transfers in transit", value: counts.fgInTransit, icon: "truck", alert: false },
                { label: "Awaiting gate out", value: counts.dispatchOpen, icon: "exit", alert: false },
              ] as const
            ).map((s) => {
              // only rejections are red; everything else stays black and white
              const color = s.alert && s.value ? "var(--red)" : "var(--ink)";
              return (
                <div key={s.label} className="flex items-start justify-between bg-card px-5 py-5">
                  <div>
                    <p className="num text-[24px] font-bold leading-none" style={{ color }}>
                      {fmt(s.value)}
                    </p>
                    <p className="mt-3 text-[11px] font-semibold uppercase tracking-[.06em] text-muted">{s.label}</p>
                  </div>
                  <span style={{ color: s.alert && s.value ? "var(--red)" : "var(--muted)" }}>
                    <Icon name={s.icon} size={22} />
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      </div>
    </div>
  );
}
