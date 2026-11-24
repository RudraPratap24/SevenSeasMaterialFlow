import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { todayLabel, useFlow } from "../store";
import { Card, Chip, EmptyNote, Pager, SearchPicker, Table, Td, TextInput, Tr, fmt, usePaged } from "../ui";
import { poVendors } from "./PurchaseTab";

export interface IndentRequest {
  requestNo: string;
  code: string;
  name: string;
  unit: string;
  qty: number;
  requiredDate: string;
  supervisor: string;
  remarks: string;
  raisedBy: string;
  raisedAt: string;
  status: "PENDING" | "VERIFIED" | "REJECTED";
  verifyRemarks: string;
  verifiedBy: string;
  verifiedAt: string;
  indentNo: string;
  poNo: string;
  /** still holds its item: no new request for it until this one is rejected or its indent is on a PO */
  open: boolean;
}

const stamp = (isoTime: string) => (isoTime ? new Date(isoTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "");

/** The requests list (open + recent) and each item's fixed indent qty; re-read when another login changes them. */
export function useIndentRequests() {
  const { productionTick } = useFlow();
  const [requests, setRequests] = useState<IndentRequest[]>([]);
  const [fixedQty, setFixedQty] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const r = await api<{ requests: IndentRequest[]; fixedQty: Record<string, number> }>("GET", "/indent-requests");
      setRequests(r.requests);
      setFixedQty(r.fixedQty);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, productionTick]);
  return { requests, fixedQty, error, reload };
}

export function RequestStatus({ r }: { r: IndentRequest }) {
  if (r.status === "REJECTED") return <Chip label="REJECTED" tone="red" />;
  // a PO line stays "on order" until it is fully received (or the PO is closed by hand)
  if (r.poNo) return r.open ? <Chip label={`ON ORDER · PO ${r.poNo}`} tone="blue" /> : <Chip label={`RECEIVED · PO ${r.poNo}`} tone="green" />;
  if (r.indentNo) return <Chip label={`INDENT ${r.indentNo}`} tone="blue" />;
  if (r.status === "VERIFIED") return <Chip label="VERIFIED" tone="green" />;
  return <Chip label="PENDING" tone="amber" />;
}

// shortcut: one minimum level for every item without its own (stock_settings.min_level) — replace with a real
// per-item evaluation (consumption × lead time) once that data is worked out
const DEFAULT_MIN_LEVEL = 20;

/**
 * Items whose store stock fell below their minimum level and have no open indent request; Store approves them one by
 * one or ticked together, and each becomes an indent request straight for Purchase. Once approved an item leaves this
 * list (its status is in "Indent requests") until its PO is received.
 */
export function BelowMinimumCard() {
  const { pmStock } = useFlow();
  const { can } = useAuth();
  const { requests, fixedQty, reload } = useIndentRequests();
  const [ticked, setTicked] = useState<Record<string, { qty: string; remarks: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  // items that never moved (no opening, nothing received) are left out, or the whole item master would be listed
  const below = useMemo(() => {
    const open = new Set(requests.filter((r) => r.open).map((r) => r.code));
    return pmStock
      .map((r) => ({ ...r, min: r.minLevel ?? DEFAULT_MIN_LEVEL }))
      .filter((r) => (r.opening > 0 || r.received > 0 || r.minLevel !== null) && r.closing < r.min && !open.has(r.code))
      .sort((a, b) => a.closing - a.min - (b.closing - b.min));
  }, [pmStock, requests]);
  const mayApprove = can("production.issue");
  const picked = below.filter((m) => ticked[m.code]);
  const free = below;
  const allTicked = free.length > 0 && picked.length === free.length;
  const ready = picked.length > 0 && picked.every((m) => Number(ticked[m.code].qty) > 0);
  const defaultQty = (m: (typeof below)[number]) => String(fixedQty[m.code] ?? Math.ceil(m.min - m.closing));
  const set = (code: string, patch: { qty?: string; remarks?: string }) => setTicked((t) => ({ ...t, [code]: { ...t[code], ...patch } }));
  const tick = (m: (typeof below)[number], on: boolean) =>
    setTicked((t) => {
      const n = { ...t };
      if (on) n[m.code] = { qty: defaultQty(m), remarks: "" };
      else delete n[m.code];
      return n;
    });

  /** The ticked items, or just one row (its typed qty if ticked, else the default). */
  async function approve(only?: (typeof below)[number]) {
    const items = only
      ? [{ code: only.code, qty: Number(ticked[only.code]?.qty ?? defaultQty(only)), remarks: (ticked[only.code]?.remarks ?? "").trim() }]
      : picked.map((m) => ({ code: m.code, qty: Number(ticked[m.code].qty), remarks: ticked[m.code].remarks.trim() }));
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ requestNos: string[] }>("POST", "/indent-requests", { items });
      setTicked((t) => {
        const n = { ...t };
        for (const i of items) delete n[i.code];
        return n;
      });
      setMessage({ text: `Approved ${r.requestNos.join(", ")} — sent to Purchase.`, error: false });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      await reload(); // also shows what someone else approved meanwhile
      setBusy(false);
    }
  }

  return (
    <Card title="Below minimum level" role={`${below.length} item(s) to approve`}>
      {mayApprove && (
        <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
          <button
            className="btn h-8"
            disabled={busy || free.length === 0}
            onClick={() =>
              setTicked(allTicked ? {} : (t) => Object.fromEntries(free.map((m) => [m.code, t[m.code] ?? { qty: defaultQty(m), remarks: "" }])))
            }
          >
            {allTicked ? "Clear all" : `Select all (${free.length})`}
          </button>
          <button className="btn btn-primary h-8" onClick={() => void approve()} disabled={busy || !ready}>
            {busy ? "Approving…" : `Approve selected (${picked.length})`}
          </button>
          {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
        </div>
      )}
      {below.length === 0 ? (
        <EmptyNote>Nothing to approve — every item is at or above its minimum level, or already has an indent request.</EmptyNote>
      ) : (
        <Table
          minWidth={1100}
          headers={[
            "",
            "PM item",
            { label: "Stock", align: "right" },
            { label: "Min level", align: "right" },
            { label: "Fixed indent qty", align: "right" },
            { label: "Indent qty", align: "right" },
            "Remarks",
            ...(mayApprove ? [""] : []),
          ]}
        >
          {below.map((m, i) => {
            const t = ticked[m.code];
            return (
              <Tr key={m.code} zebra={i % 2 === 1}>
                <Td>
                  {mayApprove && (
                    <input type="checkbox" checked={Boolean(t)} onChange={(e) => tick(m, e.target.checked)} aria-label={`Approve indent for ${m.name}`} />
                  )}
                </Td>
                <Td>
                  {m.name} <span className="num text-muted">{m.code}</span>
                </Td>
                <Td right num strong>
                  <span style={{ color: "var(--amber)" }}>{fmt(m.closing)}</span> {m.unit}
                </Td>
                <Td right num muted>{fmt(m.min)}</Td>
                <Td right num muted>{fixedQty[m.code] ? fmt(fixedQty[m.code]) : "—"}</Td>
                <Td right>
                  {t ? <TextInput numeric value={t.qty} onChange={(v) => set(m.code, { qty: v })} ariaLabel={`Indent qty, ${m.name}`} /> : <span className="num text-muted">{defaultQty(m)}</span>}
                </Td>
                <Td>{t ? <TextInput value={t.remarks} onChange={(v) => set(m.code, { remarks: v })} ariaLabel={`Remarks, ${m.name}`} /> : "—"}</Td>
                {mayApprove && (
                  <Td>
                    <button
                      className="btn h-7 px-2.5 text-[11px]"
                      style={{ borderColor: "var(--green)", color: "var(--green)" }}
                      disabled={busy || !(Number(t?.qty ?? defaultQty(m)) > 0)}
                      onClick={() => void approve(m)}
                    >
                      Approve
                    </button>
                  </Td>
                )}
              </Tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

/** All indent requests (open + last 60 days); Store can still verify or reject any old pending one. */
export function IndentRequests() {
  const { masters } = useFlow();
  const { can } = useAuth();
  const mayVerify = can("production.issue");
  const { requests, error, reload } = useIndentRequests();
  const paged = usePaged(requests);
  const [adding, setAdding] = useState(false);
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const itemOptions = useMemo(() => masters.components.map((c) => ({ value: `${c.code} · ${c.name}`, hint: c.type })), [masters.components]);
  const itemCode = masters.components.find((c) => `${c.code} · ${c.name}` === item)?.code;

  async function raise() {
    setBusy("new");
    setMessage(null);
    try {
      const r = await api<{ requestNos: string[] }>("POST", "/indent-requests", { items: [{ code: itemCode, qty: Number(qty), remarks: note.trim() }] });
      setMessage({ text: `Indent request ${r.requestNos.join(", ")} raised — sent to Purchase.`, error: false });
      setItem("");
      setQty("");
      setNote("");
      setAdding(false);
      await reload();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  }
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function verify(r: IndentRequest, approve: boolean) {
    setBusy(r.requestNo);
    setMessage(null);
    try {
      await api("POST", `/indent-requests/${r.requestNo}/verify`, { approve, remarks: (remarks[r.requestNo] ?? "").trim() });
      setMessage({ text: `${r.requestNo} ${approve ? "verified" : "rejected"}.`, error: false });
      await reload();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  }

  const pending = requests.filter((r) => r.status === "PENDING").length;
  return (
    <Card
      title="Indent requests"
      role={`${requests.length} shown · ${pending} pending`}
      right={
        <>
          {mayVerify && (
            <button className="btn btn-primary h-8" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
              {adding ? "Cancel" : "+ New indent request"}
            </button>
          )}
          <button className="btn h-8" onClick={() => void reload()}>
            Refresh
          </button>
        </>
      }
    >
      {adding && (
        <div className="flex flex-wrap items-end gap-3 border-b border-rule px-3 py-2.5 text-[12px]" style={{ background: "var(--blue-soft)" }}>
          <label className="flex min-w-[320px] flex-1 flex-col gap-0.5">
            <span className="text-muted">PM item *</span>
            <SearchPicker value={item} onChange={setItem} options={itemOptions} placeholder="Search code or name" ariaLabel="PM item" minWidth={420} />
          </label>
          <label className="flex w-28 flex-col gap-0.5">
            <span className="text-muted">Qty *</span>
            <TextInput numeric value={qty} onChange={setQty} placeholder="0" ariaLabel="Qty" />
          </label>
          <label className="flex min-w-[220px] flex-1 flex-col gap-0.5">
            <span className="text-muted">Remarks</span>
            <TextInput value={note} onChange={setNote} placeholder="Why it is needed" ariaLabel="Remarks" />
          </label>
          <button className="btn btn-primary h-8" disabled={busy !== "" || !itemCode || !(Number(qty) > 0)} onClick={() => void raise()}>
            Raise indent request
          </button>
        </div>
      )}
      {(message || error) && (
        <p className="border-b border-rule px-3 py-2 text-[12.5px]" style={{ color: message && !message.error ? "var(--green)" : "var(--red)" }}>
          {message?.text ?? error}
        </p>
      )}
      {requests.length === 0 ? (
        <EmptyNote>No indent request yet — approve items from "Below minimum level" above.</EmptyNote>
      ) : (
        <Table
          minWidth={1500}
          headers={[
            "Indent no",
            "Raised at",
            "Raised by",
            "Item name",
            { label: "Qty", align: "right" },
            "Supervisor",
            "Date of requirement",
            "Remarks",
            "Verify",
            "Store remarks",
            "Verified at",
          ]}
        >
          {paged.rows.map((r, i) => (
            <Tr key={r.requestNo} zebra={i % 2 === 1}>
              <Td num strong>{r.requestNo}</Td>
              <Td num>{stamp(r.raisedAt)}</Td>
              <Td>{r.raisedBy}</Td>
              <Td>
                {r.name} <span className="num text-muted">{r.code}</span>
              </Td>
              <Td right num strong>
                {fmt(r.qty)} {r.unit}
              </Td>
              <Td>{r.supervisor || "—"}</Td>
              <Td num>{r.requiredDate ? r.requiredDate.split("-").reverse().join("-") : "—"}</Td>
              <Td>{r.remarks || "—"}</Td>
              <Td>
                {r.status === "PENDING" && mayVerify ? (
                  <span className="flex gap-1">
                    <button className="btn btn-primary h-7 px-2 text-[11px]" disabled={busy !== ""} onClick={() => void verify(r, true)}>
                      Verify
                    </button>
                    <button
                      className="btn h-7 px-2 text-[11px]"
                      disabled={busy !== "" || !(remarks[r.requestNo] ?? "").trim()}
                      title="Type a remark to reject"
                      onClick={() => void verify(r, false)}
                    >
                      Reject
                    </button>
                  </span>
                ) : (
                  <RequestStatus r={r} />
                )}
              </Td>
              <Td>
                {r.status === "PENDING" && mayVerify ? (
                  <TextInput
                    value={remarks[r.requestNo] ?? ""}
                    onChange={(v) => setRemarks((m) => ({ ...m, [r.requestNo]: v }))}
                    placeholder="Remarks"
                    ariaLabel={`Store remarks, ${r.requestNo}`}
                  />
                ) : (
                  <span>
                    {r.verifyRemarks || "—"}
                    {r.verifiedBy && <span className="block text-[11px] text-muted">by {r.verifiedBy}</span>}
                  </span>
                )}
              </Td>
              <Td num>{stamp(r.verifiedAt) || "—"}</Td>
            </Tr>
          ))}
        </Table>
      )}
      <Pager {...paged} />
    </Card>
  );
}

/** Purchase: Store-verified requests waiting for an indent; Purchase adds vendor and rate and creates it. */
export function VerifiedRequestsCard() {
  const { addIndent, suppliers } = useFlow();
  const { can } = useAuth();
  const { requests, reload } = useIndentRequests();
  const [edits, setEdits] = useState<Record<string, { qty?: string; vendor?: string; rate?: string }>>({});
  const waiting = requests.filter((r) => r.status === "VERIFIED" && !r.indentNo);
  if (!can("purchase.indent")) return null;
  if (waiting.length === 0)
    return (
      <Card title="Indent requests from production" step="VERIFIED BY STORE" role="0 waiting">
        <EmptyNote>No request waiting — Store's approved requests show here.</EmptyNote>
      </Card>
    );

  const vendors = poVendors(suppliers);
  const edit = (no: string, patch: { qty?: string; vendor?: string; rate?: string }) => setEdits((e) => ({ ...e, [no]: { ...e[no], ...patch } }));

  return (
    <Card title="Indent requests from production" step="VERIFIED BY STORE" role={`${waiting.length} waiting`}>
      <Table
        minWidth={1200}
        headers={["Request no", "Item", "Raised by", "Required by", { label: "Qty *", align: "right" }, "Vendor *", { label: "Rate ₹ *", align: "right" }, ""]}
      >
        {waiting.map((r, i) => {
          const e = edits[r.requestNo] ?? {};
          // the vendor with a fixed rate for this item, unless Purchase picks another (exactly one on the list)
          const suggested = (vendors.find((x) => r.code in x.rates) ?? vendors.find((x) => x.supplies?.includes(r.code)))?.name ?? "";
          const vendor = e.vendor === undefined ? suggested : vendors.find((x) => x.name.toLowerCase() === e.vendor!.trim().toLowerCase())?.name ?? "";
          const fixed = suppliers.find((x) => x.name === vendor)?.rates[r.code];
          const qty = e.qty ?? String(r.qty);
          const rate = e.rate ?? (fixed === undefined ? "" : String(fixed));
          const ready = Number(qty) > 0 && vendor && Number(rate) > 0;
          return (
            <Tr key={r.requestNo} zebra={i % 2 === 1}>
              <Td num strong>{r.requestNo}</Td>
              <Td>
                {r.name} <span className="num text-muted">{r.code}</span>
                {r.remarks && <span className="block text-[11px] text-muted">{r.remarks}</span>}
              </Td>
              <Td>{r.raisedBy}</Td>
              <Td num>{r.requiredDate ? r.requiredDate.split("-").reverse().join("-") : "—"}</Td>
              <Td right>
                <TextInput numeric value={qty} onChange={(v) => edit(r.requestNo, { qty: v })} ariaLabel={`Qty, ${r.requestNo}`} />
              </Td>
              <Td>
                <SearchPicker
                  value={e.vendor ?? suggested}
                  onChange={(v) => edit(r.requestNo, { vendor: v, rate: undefined })}
                  placeholder="Vendor — type to search"
                  ariaLabel={`Vendor, ${r.requestNo}`}
                  minWidth={300}
                  options={vendors.map((x) => ({
                    value: x.name,
                    hint: r.code in x.rates ? `fixed rate ₹${x.rates[r.code]}` : x.supplies?.includes(r.code) ? "supplies this item" : x.city,
                  }))}
                />
              </Td>
              <Td right>
                <input
                  className="field num h-8 w-24 text-right"
                  inputMode="decimal"
                  value={rate}
                  onChange={(ev) => edit(r.requestNo, { rate: ev.target.value.replace(/[^\d.]/g, "") })}
                  placeholder="₹"
                  aria-label={`Rate, ${r.requestNo}`}
                />
              </Td>
              <Td>
                <button
                  className="btn btn-primary h-7 px-2 text-[11px]"
                  disabled={!ready}
                  onClick={async () => {
                    const ok = await addIndent({
                      date: todayLabel(),
                      componentCode: r.code,
                      componentName: r.name,
                      qty: Number(qty),
                      reason: `Production request ${r.requestNo}`,
                      supplierName: vendor,
                      rate: Number(rate),
                      requestNo: r.requestNo,
                    });
                    if (ok) await reload();
                  }}
                >
                  Create indent
                </button>
              </Td>
            </Tr>
          );
        })}
      </Table>
    </Card>
  );
}
