import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { reservePm, reservedTotals, type PlanMaterial } from "../logic";
import { todayLabel, useFlow } from "../store";
import { Card, Chip, DateInput, EmptyNote, Table, Td, TextInput, Tr, fmt } from "../ui";
import { iso } from "./ProductionPlanning";

interface BomListItem {
  bomNo: string;
  planDate: string;
  createdAt: string;
  items: number;
  shorts: number;
}

interface Line {
  qty: string;
  remark: string;
}

const stamp = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * BOM issue slip: Store picks a BOM list (latest per plan, not yet issued), enters what it
 * actually gave per PM item, and submits once.
 */
export function BomIssueSlip() {
  const { can } = useAuth();
  const { pmStock, openBoms, reloadReservations } = useFlow();
  const [boms, setBoms] = useState<BomListItem[]>([]);
  const [bomNo, setBomNo] = useState("");
  const [materials, setMaterials] = useState<PlanMaterial[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [filledBy, setFilledBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  /** bumped on each submit, so the issued list below re-reads */
  const [issuedCount, setIssuedCount] = useState(0);

  async function reloadLists(keepMessage = false) {
    setBusy(true);
    if (!keepMessage) setMessage(null);
    try {
      const r = await api<{ boms: BomListItem[] }>("GET", "/production-boms");
      setBoms(r.boms);
      if (!r.boms.some((b) => b.bomNo === bomNo)) pick(r.boms[0]?.bomNo ?? "");
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function pick(no: string) {
    setBomNo(no);
    setMaterials([]);
    setLines([]);
    if (!no) return;
    try {
      const r = await api<{ doc: { materials: PlanMaterial[] } }>("GET", `/production-boms/${encodeURIComponent(no)}`);
      setMaterials(r.doc.materials);
      setLines(r.doc.materials.map(() => ({ qty: "", remark: "" })));
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
  }

  useEffect(() => {
    void reloadLists();
  }, []);

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const complete = filledBy.trim() !== "" && lines.length > 0 && lines.every((l) => l.qty !== "");

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/production-boms/${encodeURIComponent(bomNo)}/issue`, {
        filledBy: filledBy.trim(),
        lines: materials.map((m, i) => ({ componentCode: m.code, issuedQty: Number(lines[i].qty), remark: lines[i].remark.trim() })),
      });
      setMessage({ text: `Issue slip for ${bomNo} submitted.`, error: false });
      void reloadReservations();
      setIssuedCount((n) => n + 1);
      setBomNo("");
      setMaterials([]);
      setLines([]);
      await reloadLists(true);
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const reason = window.prompt(`Cancel ${bomNo}? It stops holding PM stock and leaves this list.

Reason:`)?.trim();
    if (!reason) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/production-boms/${encodeURIComponent(bomNo)}/cancel`, { reason });
      setMessage({ text: `${bomNo} cancelled.`, error: false });
      void reloadReservations();
      await reloadLists(true);
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  // soft reservation: what the queue of open BOM lists holds for this one, and what is free of any hold
  const onHand = useMemo(() => new Map(pmStock.map((s) => [s.code, Math.max(0, s.closing)])), [pmStock]);
  const held = useMemo(() => reservePm(openBoms, onHand).get(bomNo), [openBoms, onHand, bomNo]);
  const totals = useMemo(() => reservedTotals(openBoms, onHand), [openBoms, onHand]);

  const current = boms.find((b) => b.bomNo === bomNo);
  const mayIssue = can("production.issue");

  return (
    <div className="space-y-3">
    <Card
      title="BOM issue slip"
      right={
        <>
          <button className="btn h-8" onClick={() => void reloadLists()} disabled={busy}>
            Reload lists
          </button>
          {can("production.bom") && (
            <button className="btn h-8" style={{ color: "var(--red)" }} onClick={() => void cancel()} disabled={busy || !bomNo}>
              Cancel BOM list
            </button>
          )}
          {mayIssue && (
            <>
              <button
                className="btn h-8"
                onClick={() => setLines((ls) => ls.map((l, i) => ({ ...l, qty: String(materials[i].required) })))}
                disabled={busy || materials.length === 0}
              >
                Same as required
              </button>
              <button className="btn btn-primary h-8" onClick={() => void submit()} disabled={busy || !complete}>
                Final submit
              </button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
        <label className="flex items-center gap-2 font-semibold">
          Filled by
          <TextInput value={filledBy} onChange={setFilledBy} placeholder="Store person name" ariaLabel="Filled by" />
        </label>
        <label className="flex items-center gap-2 font-semibold">
          BOM list waiting
          <select className="field h-8 min-w-[300px]" value={bomNo} onChange={(e) => void pick(e.target.value)} aria-label="BOM list">
            {boms.length === 0 && <option value="">No BOM list waiting</option>}
            {boms.map((b) => (
              <option key={b.bomNo} value={b.bomNo}>
                {b.bomNo} · made {stamp(b.createdAt)} · plan {b.planDate.split("-").reverse().join("-")}
              </option>
            ))}
          </select>
        </label>
        {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
      </div>
      {current && (
        <p className="border-b border-rule px-3 py-1.5 text-center text-[12px] text-muted">
          <b className="num text-ink">{current.bomNo}</b> — {current.items} item(s) · {current.shorts} item(s) were short when this BOM list was made
        </p>
      )}
      {materials.length === 0 ? (
        <EmptyNote>{boms.length ? "Pick a BOM list." : "No BOM list waiting — generate one from Requisition BOM List."}</EmptyNote>
      ) : (
        <Table
          minWidth={900}
          headers={[
            "#",
            "PM required item name",
            { label: "Required qty", align: "right" },
            { label: "Reserved for this BOM", align: "right" },
            { label: "Actual qty dispatched", align: "right" },
            { label: "Difference", align: "right" },
            "Remarks",
          ]}
        >
          {materials.map((m, i) => {
            const l = lines[i];
            const diff = l.qty === "" ? null : Number(l.qty) - m.required;
            const mine = held?.get(m.code)?.reserved ?? 0;
            const free = (onHand.get(m.code) ?? 0) - (totals.get(m.code) ?? 0);
            // giving more than this list holds, beyond the free stock, takes what other plans are counting on
            const takes = l.qty === "" ? 0 : Math.max(0, Number(l.qty) - mine - free);
            return (
              <Tr key={m.code} zebra={i % 2 === 1} bg={mine < m.required ? "var(--red-soft)" : undefined}>
                <Td num muted>{i + 1}</Td>
                <Td>
                  {m.name} <span className="num text-muted">{m.code}</span>
                </Td>
                <Td right num strong>{fmt(m.required)} {m.unit}</Td>
                <Td right num>{fmt(mine)}</Td>
                <Td right>
                  <TextInput numeric value={l.qty} onChange={(v) => set(i, { qty: v })} placeholder="0" ariaLabel={`Actual qty, ${m.name}`} />
                  {takes > 0 && (
                    <span className="mt-1 block text-[11px] font-semibold" style={{ color: "var(--red)" }}>
                      takes {fmt(takes)} reserved for other plans
                    </span>
                  )}
                </Td>
                <Td right num strong>
                  {diff === null || diff === 0 ? (
                    "—"
                  ) : (
                    <span style={{ color: diff < 0 ? "var(--red)" : "var(--amber)" }}>
                      {diff > 0 ? "+" : ""}
                      {fmt(diff)}
                    </span>
                  )}
                </Td>
                <Td>
                  <TextInput value={l.remark} onChange={(v) => set(i, { remark: v })} placeholder="Optional" ariaLabel={`Remark, ${m.name}`} />
                </Td>
              </Tr>
            );
          })}
        </Table>
      )}
    </Card>
    <IssuedOnDate refresh={issuedCount} />
    </div>
  );
}

interface IssuedSlip {
  bomNo: string;
  filledBy: string;
  issuedAt: string;
  verifiedBy: string;
  lines: { code: string; name: string; unit: string; required: number; issued: number; remark: string }[];
}

/** The BOM lists Store issued on a date, each opening to its items and the qty issued. */
function IssuedOnDate({ refresh }: { refresh: number }) {
  const [date, setDate] = useState(todayLabel());
  const [slips, setSlips] = useState<IssuedSlip[]>([]);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    if (!date) return;
    let stale = false; // a newer date picked meanwhile wins
    api<{ slips: IssuedSlip[] }>("GET", `/production-verifications/${iso(date)}`).then(
      (r) => !stale && (setSlips(r.slips), setError("")),
      (e) => !stale && setError((e as Error).message),
    );
    return () => {
      stale = true;
    };
  }, [date, refresh]);

  const toggle = (no: string) =>
    setOpened((o) => {
      const n = new Set(o);
      if (n.has(no)) n.delete(no);
      else n.add(no);
      return n;
    });

  return (
    <Card title="BOM lists issued" role={`${slips.length} on ${date}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
        <label className="flex items-center gap-2 font-semibold">
          Issued on
          <DateInput value={date} onChange={setDate} ariaLabel="Issued on" />
        </label>
        {error && <span style={{ color: "var(--red)" }}>{error}</span>}
      </div>
      {slips.length === 0 ? (
        <EmptyNote>No BOM list was issued on this date.</EmptyNote>
      ) : (
        <div className="divide-y divide-rule">
          {slips.map((s) => {
            const isOpen = opened.has(s.bomNo);
            const total = s.lines.reduce((n, l) => n + l.issued, 0);
            return (
              <div key={s.bomNo} className="px-3 py-2.5">
                <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => toggle(s.bomNo)} aria-expanded={isOpen}>
                  <span className="w-3 text-[11px] text-muted" aria-hidden>
                    {isOpen ? "▼" : "▶"}
                  </span>
                  <span className="num text-[13px] font-bold">{s.bomNo}</span>
                  <span className="num text-[12px] text-muted">issued {stamp(s.issuedAt)}</span>
                  <span className="text-[12.5px]">
                    by <b>{s.filledBy}</b>
                  </span>
                  <span className="text-[11.5px] text-muted">
                    {s.lines.length} item(s) · {fmt(total)} issued in all
                  </span>
                  <span className="ml-auto">
                    {s.verifiedBy ? <Chip label={`VERIFIED BY ${s.verifiedBy.toUpperCase()}`} tone="green" /> : <Chip label="NOT VERIFIED YET" tone="amber" />}
                  </span>
                </button>
                {isOpen && (
                  <div className="mt-2 overflow-hidden rounded-[3px] border border-rule">
                    <Table
                      minWidth={800}
                      headers={["#", "PM item", { label: "Required qty", align: "right" }, { label: "Qty issued", align: "right" }, { label: "Difference", align: "right" }, "Remarks"]}
                    >
                      {s.lines.map((l, i) => {
                        const diff = l.issued - l.required;
                        return (
                          <Tr key={l.code} zebra={i % 2 === 1}>
                            <Td num muted>{i + 1}</Td>
                            <Td>
                              {l.name} <span className="num text-muted">{l.code}</span>
                            </Td>
                            <Td right num>{fmt(l.required)} {l.unit}</Td>
                            <Td right num strong>{fmt(l.issued)}</Td>
                            <Td right num>
                              {diff === 0 ? "—" : <span style={{ color: diff < 0 ? "var(--red)" : "var(--amber)" }}>{diff > 0 ? "+" : ""}{fmt(diff)}</span>}
                            </Td>
                            <Td muted>{l.remark || "—"}</Td>
                          </Tr>
                        );
                      })}
                    </Table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
