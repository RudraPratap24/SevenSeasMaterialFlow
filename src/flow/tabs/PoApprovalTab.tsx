import { useState } from "react";
import { useAuth } from "../auth";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, Table, Td, Tr } from "../ui";
import { GstRows, PoTotal } from "./PurchaseTab";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The owner's tab: every PO raised by Purchase that waits for approval — one row each, opened to see its items. */
export function PoApprovalTab() {
  const { state, poProgress, approvePo, rejectPo } = useFlow();
  const { can, user } = useAuth();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /** The PO whose reject reason is being typed. */
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const toggle = (no: string) =>
    setOpened((o) => {
      const n = new Set(o);
      if (n.has(no)) n.delete(no);
      else n.add(no);
      return n;
    });
  const waiting = poProgress.filter((p) => p.po.status === "PENDING_APPROVAL");

  return (
    <Card title="PO approval" step="OWNER APPROVES" role={`${waiting.length} waiting`}>
      {waiting.length === 0 && <EmptyNote>No PO waiting for approval.</EmptyNote>}
      <div className="divide-y divide-rule">
        {waiting.map((p) => {
          const isOpen = opened.has(p.po.id);
          const ids = p.po.indentIds;
          return (
            <div key={p.po.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flex flex-wrap items-center gap-2 text-left"
                  onClick={() => toggle(p.po.id)}
                  aria-expanded={isOpen}
                  title={isOpen ? "Hide the items" : "Show the items"}
                >
                  <span className="w-3 text-[11px] text-muted" aria-hidden>
                    {isOpen ? "▼" : "▶"}
                  </span>
                  <span className="num text-[13px] font-bold">{p.po.id}</span>
                  <span className="num text-[12px] text-muted">{p.po.date}</span>
                  <span className="text-[12.5px] font-semibold">{p.po.supplierName}</span>
                  <Chip label="RAISED HERE" tone="muted" />
                  <span className="text-[11.5px] text-muted">
                    {p.lines.length} item{p.lines.length === 1 ? "" : "s"}
                  </span>
                  {ids.length > 0 && (
                    <span className="num text-[11.5px] text-muted">
                      Indent{ids.length === 1 ? "" : "s"} {ids.join(", ")}
                    </span>
                  )}
                  {p.po.expectedDate && <span className="num text-[11.5px] text-muted">expected {p.po.expectedDate}</span>}
                </button>
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {p.value !== null && <PoTotal value={p.value} gst={p.po.gst} />}
                  <Chip label="PENDING APPROVAL" tone="amber" />
                  {can("purchase.approve") && (
                    <>
                      <button
                        className="btn h-6 px-2 text-[11px]"
                        style={{ borderColor: "var(--green)", color: "var(--green)" }}
                        onClick={() => approvePo(p.po.id, user?.label ?? "Owner")}
                      >
                        Approve PO
                      </button>
                      <button
                        className="btn h-6 px-2 text-[11px]"
                        style={{ borderColor: "var(--red)", color: rejecting?.id === p.po.id ? "#fff" : "var(--red)", background: rejecting?.id === p.po.id ? "var(--red)" : undefined }}
                        onClick={() => setRejecting(rejecting?.id === p.po.id ? null : { id: p.po.id, reason: "" })}
                        aria-expanded={rejecting?.id === p.po.id}
                      >
                        Reject PO
                      </button>
                    </>
                  )}
                </span>
              </div>
              {rejecting?.id === p.po.id && (
                <div
                  className="mt-2 flex flex-wrap items-center gap-2 rounded-[3px] px-3 py-2 text-[12px]"
                  style={{ background: "var(--red-soft)", borderLeft: "3px solid var(--red)" }}
                >
                  <span className="font-semibold" style={{ color: "var(--red)" }}>
                    Reject {p.po.id}
                  </span>
                  <input
                    className="field h-7 min-w-[280px] flex-1"
                    value={rejecting.reason}
                    onChange={(e) => setRejecting({ id: p.po.id, reason: e.target.value })}
                    placeholder="Reason (required) — e.g. rate too high, wrong vendor"
                    aria-label={`Reason to reject ${p.po.id}`}
                    autoFocus
                  />
                  <button
                    className="btn h-7 px-3 text-[11px]"
                    style={{ background: "var(--red)", borderColor: "var(--red)", color: "#fff" }}
                    disabled={!rejecting.reason.trim()}
                    onClick={async () => {
                      if (await rejectPo(p.po.id, rejecting.reason.trim(), "")) setRejecting(null);
                    }}
                  >
                    Confirm reject
                  </button>
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => setRejecting(null)}>
                    Cancel
                  </button>
                  <span className="basis-full text-[11px] text-muted">
                    The PO is not sent to the vendor or Tally; its indents go back to Purchase to raise a new PO.
                  </span>
                </div>
              )}
              {isOpen && (
                <div className="mt-2 overflow-hidden rounded-[3px] border border-rule">
                  <Table
                    headers={["Item", "Code", "Indent", { label: "Rate", align: "right" }, { label: "Ordered", align: "right" }, { label: "Amount", align: "right" }, "Indent reason"]}
                  >
                    {p.lines.map((l, i) => {
                      const ind = state.indents.filter((x) => ids.includes(x.id) && x.componentCode === l.code);
                      return (
                        <Tr key={l.code} zebra={i % 2 === 1}>
                          <Td>{l.name}</Td>
                          <Td num>{l.code}</Td>
                          <Td num>{ind.map((x) => x.id).join(", ") || "—"}</Td>
                          <Td right num>{l.rate === null ? "—" : `₹${l.rate}`}</Td>
                          <Td right num>{l.qty.toLocaleString("en-IN")}</Td>
                          <Td right num strong>{l.rate === null ? "—" : rupees(l.qty * l.rate)}</Td>
                          <Td muted>{ind.map((x) => x.reason).join("; ") || "—"}</Td>
                        </Tr>
                      );
                    })}
                    {p.value !== null && <GstRows value={p.value} gst={p.po.gst} before={4} after={1} />}
                  </Table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
