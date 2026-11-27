import { Fragment, useState } from "react";
import { FileMinus2, MessageSquare, ShoppingCart, type LucideIcon } from "lucide-react";
import { useAuth } from "../auth";
import { GRN_TOLERANCE, openEscalations } from "../logic";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, Table, Td, Tr, fmtQty } from "../ui";

const TOL = `${Math.round(GRN_TOLERANCE * 100)}%`;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

type Mode = "DEBIT" | "INDENT" | "REMARK";
const MODE_LABEL: Record<Mode, string> = { DEBIT: "Debit note", INDENT: "New PO for balance", REMARK: "Close with remark" };
const MODE_LOOK: Record<Mode, { icon: LucideIcon; color: string; soft: string }> = {
  DEBIT: { icon: FileMinus2, color: "var(--red)", soft: "var(--red-soft)" },
  INDENT: { icon: ShoppingCart, color: "var(--green)", soft: "var(--green-soft)" },
  REMARK: { icon: MessageSquare, color: "var(--ink)", soft: "var(--blue-soft)" },
};
interface Draft {
  mode: Mode;
  qty: string;
  rate: string;
  text: string;
}

/**
 * Escalations: GRNs Store counted more than 20% short or over what was still pending on the PO item. Each stays open
 * until Purchase/Admin settles it: a SHORT one by a debit note for the short qty, by an indent for the balance (→ new
 * PO), or with a remark; an EXCESS one with a remark.
 */
export function EscalationTab() {
  const { state, closeEscalation, escalationDebitNote, escalationIndent } = useFlow();
  const { can } = useAuth();
  const mayClose = can("escalation.close");
  const [draft, setDraft] = useState<(Draft & { grnNo: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const poRate = (poNo: string, code: string) =>
    state.purchaseOrders.find((p) => p.id === poNo)?.lines.find((l) => l.componentCode === code)?.rate ?? null;
  const open = openEscalations(state).slice().reverse();
  const gateOf = new Map(state.gateEntries.map((g) => [g.id, g]));
  const grnOf = new Map(state.grnLines.map((g) => [g.grnNo, g]));
  const closed = state.escalationClosures.slice().reverse().slice(0, 50);

  return (
    <div className="space-y-3">
      <Card title="Open escalations" step={`BEYOND ±${TOL}`} role={`${open.length} open`}>
        {open.length === 0 ? (
          <EmptyNote>No open escalation — every GRN beyond the tolerance has been settled.</EmptyNote>
        ) : (
          <Table
            minWidth={1350}
            headers={[
              "GRN no",
              "Received",
              "Supplier",
              "Invoice no",
              "PO no",
              "Item",
              { label: "Pending before", align: "right" },
              { label: "Received", align: "right" },
              { label: "Difference", align: "right" },
              "Escalation",
              "Store remark",
              ...(mayClose ? ["Resolve"] : []),
            ]}
          >
            {open.map((g, i) => {
              const diff = Math.round((g.totalQty - (g.pendingBefore ?? 0)) * 1000) / 1000;
              const short = Math.max(0, -diff);
              const known = poRate(g.poNo, g.componentCode);
              const start = (mode: Mode) =>
                setDraft({ grnNo: g.grnNo, mode, qty: mode === "REMARK" ? "" : String(short), rate: known === null ? "" : String(known), text: "" });
              const d = draft?.grnNo === g.grnNo ? draft : null;
              const set = (patch: Partial<Draft>) => setDraft((x) => (x ? { ...x, ...patch } : x));
              const qty = Number(d?.qty);
              const rate = Number(d?.rate);
              const ready = d && (d.mode === "REMARK" ? d.text.trim() !== "" : qty > 0 && rate > 0 && (d.mode === "INDENT" || d.text.trim() !== ""));
              async function confirm() {
                if (!d) return;
                setBusy(true);
                const ok =
                  d.mode === "DEBIT"
                    ? await escalationDebitNote({ grnNo: g.grnNo, qty, rate, reason: d.text.trim() })
                    : d.mode === "INDENT"
                      ? await escalationIndent({ grnNo: g.grnNo, qty, rate, reason: d.text.trim() })
                      : await closeEscalation(g.grnNo, d.text.trim(), "", "");
                setBusy(false);
                if (ok) setDraft(null);
              }
              return (
                <Fragment key={g.grnNo}>
                <Tr zebra={i % 2 === 1}>
                  <Td num strong>{g.grnNo}</Td>
                  <Td num>{g.receivedDate}</Td>
                  <Td>{g.supplierName}</Td>
                  <Td num>{g.invoiceNo || "—"}</Td>
                  <Td num>{g.poNo || "—"}</Td>
                  <Td>
                    {g.poItemName || g.componentName} <span className="num text-muted">{g.componentCode}</span>
                  </Td>
                  <Td right num>{g.pendingBefore === null ? "—" : `${fmtQty(g.pendingBefore, g.unit)} ${g.unit}`}</Td>
                  <Td right num>{fmtQty(g.totalQty, g.unit)} {g.unit}</Td>
                  <Td right num strong>
                    <span style={{ color: g.variance === "SHORT" ? "var(--amber)" : "var(--red)" }}>
                      {diff > 0 ? "+" : ""}
                      {fmtQty(diff, g.unit)} {g.unit}
                    </span>
                  </Td>
                  <Td>
                    {g.variance === "SHORT" ? <Chip label={`SHORT >${TOL}`} tone="amber" /> : <Chip label={`EXCESS >${TOL}`} tone="red" />}
                  </Td>
                  <Td muted>{g.remarkStore || "—"}</Td>
                  {mayClose && (
                    <Td>
                      <span className="flex gap-1.5">
                        {(g.variance === "SHORT" ? (["DEBIT", "INDENT", "REMARK"] as const) : (["REMARK"] as const)).map((m) => {
                          const look = MODE_LOOK[m];
                          const on = d?.mode === m;
                          return (
                            <button
                              key={m}
                              className="btn inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors"
                              style={{ borderColor: look.color, color: on ? "#fff" : look.color, background: on ? look.color : look.soft }}
                              onClick={() => (on ? setDraft(null) : start(m))}
                              aria-expanded={on}
                            >
                              <look.icon size={13} strokeWidth={2.2} aria-hidden />
                              {MODE_LABEL[m]}
                            </button>
                          );
                        })}
                      </span>
                    </Td>
                  )}
                </Tr>
                {d && (
                  <tr>
                    <td colSpan={12} className="border-b border-rule px-3 py-2.5" style={{ background: MODE_LOOK[d.mode].soft, borderLeft: `3px solid ${MODE_LOOK[d.mode].color}` }}>
                      <div className="flex flex-wrap items-end gap-3 text-[12px]">
                        <span className="font-bold">{MODE_LABEL[d.mode]} — {g.grnNo}</span>
                        {d.mode !== "REMARK" && (
                          <>
                            <label className="flex flex-col gap-0.5">
                              <span className="text-muted">{d.mode === "DEBIT" ? "Short qty to debit (billed, not received)" : "Balance qty to buy"} · {g.unit}</span>
                              <input className="field num h-7 w-32 text-right" inputMode="decimal" value={d.qty} onChange={(e) => set({ qty: e.target.value.replace(/[^\d.]/g, "") })} aria-label="Quantity" />
                            </label>
                            <label className="flex flex-col gap-0.5">
                              <span className="text-muted">Rate ₹ per unit{known === null ? "" : " (PO rate)"}</span>
                              <input className="field num h-7 w-28 text-right" inputMode="decimal" value={d.rate} onChange={(e) => set({ rate: e.target.value.replace(/[^\d.]/g, "") })} aria-label="Rate" />
                            </label>
                            <span className="num pb-1.5 font-semibold">{qty > 0 && rate > 0 ? rupees(Math.round(qty * rate * 100) / 100) : "—"}</span>
                          </>
                        )}
                        <label className="flex min-w-[260px] flex-1 flex-col gap-0.5">
                          <span className="text-muted">
                            {d.mode === "DEBIT" ? "Reason to vendor *" : d.mode === "INDENT" ? "Remark (optional)" : "Remark — how it was settled *"}
                          </span>
                          <input
                            className="field h-7"
                            value={d.text}
                            onChange={(e) => set({ text: e.target.value })}
                            placeholder={d.mode === "DEBIT" ? "e.g. invoiced 5000, received 2000" : d.mode === "INDENT" ? "e.g. vendor to send the rest" : g.variance === "SHORT" ? "e.g. rest not needed" : "e.g. excess kept, billed"}
                            aria-label="Remark"
                          />
                        </label>
                        <button
                          className="btn h-7 px-3 text-[11px]"
                          style={{ background: MODE_LOOK[d.mode].color, borderColor: MODE_LOOK[d.mode].color, color: "#fff" }}
                          disabled={!ready || busy}
                          onClick={() => void confirm()}
                        >
                          {d.mode === "DEBIT" ? "Create debit note & close" : d.mode === "INDENT" ? "Raise indent & close" : "Close escalation"}
                        </button>
                        <button className="btn h-7 px-2 text-[11px]" onClick={() => setDraft(null)}>
                          Cancel
                        </button>
                      </div>
                      {d.mode === "INDENT" && (
                        <p className="mt-1.5 text-[11px] text-muted">
                          Makes an open indent for {g.componentName} from {g.supplierName}; raise its PO in Purchase → Raise PO.
                        </p>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </Table>
        )}
      </Card>

      {closed.length > 0 && (
        <Card title="Closed escalations" role="latest 50">
          <Table minWidth={1000} headers={["GRN no", "Supplier", "Item", "Escalation", "Closed on", "By", "Resolution"]}>
            {closed.map((c, i) => {
              const g = grnOf.get(c.grnNo);
              return (
                <Tr key={c.grnNo} zebra={i % 2 === 1}>
                  <Td num strong>{c.grnNo}</Td>
                  <Td>{g?.supplierName ?? gateOf.get(g?.gateEntryId ?? "")?.supplierName ?? "—"}</Td>
                  <Td>{g ? g.poItemName || g.componentName : "—"}</Td>
                  <Td>{g?.variance === "SHORT" ? <Chip label="SHORT" tone="amber" /> : g?.variance === "EXCESS" ? <Chip label="EXCESS" tone="red" /> : "—"}</Td>
                  <Td num>{c.date}</Td>
                  <Td muted>{c.by}</Td>
                  <Td>{c.resolution}</Td>
                </Tr>
              );
            })}
          </Table>
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-muted">
        A GRN is escalated when Store's count is more than {TOL} short of, or over, what was still pending on the PO item.
        SHORT: what came is accepted and the PO item is closed. Settle it with a <b>debit note</b> (the vendor billed more than came),
        a <b>new PO for the balance</b> (an indent is raised), or <b>close with a remark</b>. EXCESS: all of it was accepted; close it with a
        remark. The resolution is kept with who closed it and when.
      </p>
    </div>
  );
}
