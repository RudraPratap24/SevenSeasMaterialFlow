import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { FG_SUPERVISORS } from "../logic";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, SearchPicker, Table, Td, TextInput, Tr, fmt } from "../ui";

interface MrnLine {
  code: string;
  name: string;
  unit: string;
  returned: number;
  received: number | null;
  remark: string;
}
interface Mrn {
  mrnNo: string;
  bomNo: string;
  returnedBy: string;
  remarks: string;
  raisedBy: string;
  raisedAt: string;
  status: "PENDING" | "APPROVED";
  verifiedBy: string;
  verifyRemarks: string;
  verifiedAt: string;
  lines: MrnLine[];
}
interface SourceLine {
  code: string;
  name: string;
  unit: string;
  issued: number;
  /** what the supervisor verified reached the line, if verified */
  received: number | null;
  /** already on earlier MRNs */
  returned: number;
  max: number;
}

const stamp = (t: string) => (t ? new Date(t).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
const SUPERVISORS = FG_SUPERVISORS.map((value) => ({ value }));
type Msg = { text: string; error: boolean } | null;
const Message = ({ m }: { m: Msg }) =>
  m && (
    <p className="border-b border-rule px-3 py-2 text-[12.5px]" style={{ color: m.error ? "var(--red)" : "var(--green)" }}>
      {m.text}
    </p>
  );

/** Issued BOM lists and the MRNs; re-read when another login raises or approves one. */
function useBomReturns() {
  const { productionTick } = useFlow();
  const [boms, setBoms] = useState<{ bomNo: string; issuedAt: string }[]>([]);
  const [returns, setReturns] = useState<Mrn[]>([]);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const r = await api<{ boms: { bomNo: string; issuedAt: string }[]; returns: Mrn[] }>("GET", "/bom-returns");
      setBoms(r.boms);
      setReturns(r.returns);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, productionTick]);
  return { boms, returns, error, reload };
}

/** Production supervisor: pick an issued BOM number, keep the items going back (delete the rest), give the qty. */
export function MrnForm() {
  const { can } = useAuth();
  const mayRaise = can("production.verify");
  const { boms, returns, error, reload } = useBomReturns();
  const [bomNo, setBomNo] = useState("");
  const [rows, setRows] = useState<(SourceLine & { qty: string; remark: string })[]>([]);
  const [returnedBy, setReturnedBy] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Msg>(null);

  async function pick(no: string) {
    setBomNo(no);
    setRows([]);
    setMessage(null);
    if (!boms.some((b) => b.bomNo === no)) return;
    try {
      const r = await api<{ lines: SourceLine[] }>("GET", `/bom-returns/source/${encodeURIComponent(no)}`);
      const left = r.lines.filter((l) => l.max > 0);
      setRows(left.map((l) => ({ ...l, qty: "", remark: "" })));
      if (!left.length) setMessage({ text: `Everything issued against ${no} is already returned.`, error: true });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
  }
  const set = (code: string, patch: { qty?: string; remark?: string }) => setRows((rs) => rs.map((r) => (r.code === code ? { ...r, ...patch } : r)));
  const bad = rows.find((r) => !(Number(r.qty) > 0) || Number(r.qty) > r.max);
  const ready = rows.length > 0 && !bad && returnedBy.trim();

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ mrnNo: string }>("POST", "/bom-returns", {
        bomNo,
        returnedBy: returnedBy.trim(),
        remarks: remarks.trim(),
        lines: rows.map((x) => ({ code: x.code, qty: Number(x.qty), remark: x.remark.trim() })),
      });
      setMessage({ text: `${r.mrnNo} raised — waiting for Store to verify what came back.`, error: false });
      setRows([]);
      setBomNo("");
      setRemarks("");
      await reload();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Card title="MRN — material return against a BOM" step="PRODUCTION SUPERVISOR">
        {mayRaise && (
          <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
            <label className="flex items-center gap-2 font-semibold">
              BOM number
              <SearchPicker
                value={bomNo}
                onChange={(v) => void pick(v)}
                options={boms.map((b) => ({ value: b.bomNo, hint: `issued ${stamp(b.issuedAt)}` }))}
                placeholder="Pick an issued BOM"
                ariaLabel="BOM number"
                minWidth={260}
              />
            </label>
            <label className="flex items-center gap-2 font-semibold">
              Returned by
              <SearchPicker value={returnedBy} onChange={setReturnedBy} options={SUPERVISORS} placeholder="Supervisor" ariaLabel="Returned by" minWidth={200} />
            </label>
            <label className="flex items-center gap-2 font-semibold">
              Remarks
              <TextInput value={remarks} onChange={setRemarks} placeholder="Optional" ariaLabel="MRN remarks" />
            </label>
            <button className="btn btn-primary h-8" onClick={() => void submit()} disabled={busy || !ready}>
              {busy ? "Submitting…" : `Submit MRN (${rows.length} item${rows.length === 1 ? "" : "s"})`}
            </button>
            {bad && <span style={{ color: "var(--amber)" }}>Each row needs a qty above 0 and up to what can come back — or delete the row.</span>}
          </div>
        )}
        <Message m={message ?? (error ? { text: error, error: true } : null)} />
        {rows.length === 0 ? (
          <EmptyNote>{bomNo ? "No item left on this MRN." : "Pick an issued BOM number to list the items received against it."}</EmptyNote>
        ) : (
          <Table
            minWidth={1000}
            headers={[
              "PM item",
              { label: "Issued", align: "right" },
              { label: "Received on line", align: "right" },
              { label: "Already returned", align: "right" },
              { label: "Can return", align: "right" },
              { label: "Return qty *", align: "right" },
              "Remark",
              "",
            ]}
          >
            {rows.map((r, i) => (
              <Tr key={r.code} zebra={i % 2 === 1}>
                <Td>
                  {r.name} <span className="num text-muted">{r.code}</span>
                </Td>
                <Td right num>{fmt(r.issued)} {r.unit}</Td>
                <Td right num muted>{r.received === null ? "not verified" : fmt(r.received)}</Td>
                <Td right num muted>{r.returned ? fmt(r.returned) : "—"}</Td>
                <Td right num strong>{fmt(r.max)}</Td>
                <Td right>
                  <TextInput numeric value={r.qty} onChange={(v) => set(r.code, { qty: v })} ariaLabel={`Return qty, ${r.name}`} />
                </Td>
                <Td>
                  <TextInput value={r.remark} onChange={(v) => set(r.code, { remark: v })} ariaLabel={`Remark, ${r.name}`} />
                </Td>
                <Td>
                  <button
                    className="btn h-7 px-2 text-[11px]"
                    onClick={() => setRows((rs) => rs.filter((x) => x.code !== r.code))}
                    aria-label={`Delete ${r.name} from the MRN`}
                    title="Not returning this item"
                  >
                    ✕
                  </button>
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
      <MrnList returns={returns} />
    </div>
  );
}

/** Store: counts what came back on each pending MRN and approves — the received qty goes back into PM stock. */
export function MrnVerify() {
  const { can } = useAuth();
  const mayApprove = can("production.issue");
  const { returns, error, reload } = useBomReturns();
  const [got, setGot] = useState<Record<string, string[]>>({});
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<Msg>(null);
  const pending = returns.filter((m) => m.status === "PENDING");

  async function approve(m: Mrn, received: number[]) {
    setBusy(m.mrnNo);
    setMessage(null);
    try {
      await api("POST", `/bom-returns/${encodeURIComponent(m.mrnNo)}/approve`, { received, remarks: (remarks[m.mrnNo] ?? "").trim() });
      setMessage({ text: `${m.mrnNo} approved — the received qty is back in PM stock.`, error: false });
      await reload();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-3">
      <Card title="MRN verify" step="STORE" role={`${pending.length} pending`}>
        <Message m={message ?? (error ? { text: error, error: true } : null)} />
        {pending.length === 0 && <EmptyNote>No MRN waiting — the supervisor raises them from Production Flow → Production Supervisor → MRN.</EmptyNote>}
        {pending.map((m) => {
          const qty = got[m.mrnNo] ?? m.lines.map((l) => String(l.returned)); // starts at the claimed qty
          const nums = qty.map(Number);
          const wrong = nums.findIndex((n, i) => !(n >= 0) || qty[i].trim() === "" || n > m.lines[i].returned);
          return (
            <div key={m.mrnNo} className="border-b border-rule">
              <div className="flex flex-wrap items-center gap-3 bg-zebra px-3 py-2 text-[12.5px]">
                <span className="num font-bold">{m.mrnNo}</span>
                <span>
                  BOM <span className="num font-semibold">{m.bomNo}</span>
                </span>
                <span className="text-muted">
                  returned by {m.returnedBy} · raised by {m.raisedBy || "—"} · {stamp(m.raisedAt)}
                </span>
                {m.remarks && <span className="text-muted">“{m.remarks}”</span>}
              </div>
              <Table minWidth={800} headers={["PM item", { label: "Returned (supervisor)", align: "right" }, { label: "Received by store *", align: "right" }, "Remark"]}>
                {m.lines.map((l, i) => (
                  <Tr key={l.code} zebra={i % 2 === 1}>
                    <Td>
                      {l.name} <span className="num text-muted">{l.code}</span>
                    </Td>
                    <Td right num>{fmt(l.returned)} {l.unit}</Td>
                    <Td right>
                      {mayApprove ? (
                        <TextInput
                          numeric
                          value={qty[i]}
                          onChange={(v) => setGot((g) => ({ ...g, [m.mrnNo]: qty.map((x, j) => (j === i ? v : x)) }))}
                          ariaLabel={`Received qty, ${l.name}`}
                        />
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td muted>{l.remark || "—"}</Td>
                  </Tr>
                ))}
              </Table>
              {mayApprove && (
                <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[12.5px]">
                  <TextInput value={remarks[m.mrnNo] ?? ""} onChange={(v) => setRemarks((r) => ({ ...r, [m.mrnNo]: v }))} placeholder="Store remarks" ariaLabel={`Store remarks, ${m.mrnNo}`} />
                  <button className="btn btn-primary h-8" disabled={busy !== "" || wrong >= 0} onClick={() => void approve(m, nums)}>
                    {busy === m.mrnNo ? "Approving…" : "Approve — add to stock"}
                  </button>
                  {wrong >= 0 && <span style={{ color: "var(--amber)" }}>Received must be 0 or more, and not more than returned.</span>}
                </div>
              )}
            </div>
          );
        })}
      </Card>
      <MrnList returns={returns} />
    </div>
  );
}

/** Every MRN of the last 60 days (and any still pending), one row per item. */
function MrnList({ returns }: { returns: Mrn[] }) {
  return (
    <Card title="MRNs" role={`${returns.length} shown`}>
      {returns.length === 0 ? (
        <EmptyNote>No MRN yet.</EmptyNote>
      ) : (
        <Table
          minWidth={1200}
          headers={[
            "MRN no",
            "BOM no",
            "Raised at",
            "Returned by",
            "PM item",
            { label: "Returned", align: "right" },
            { label: "Received", align: "right" },
            "Status",
            "Verified",
          ]}
        >
          {returns.flatMap((m, k) =>
            m.lines.map((l, i) => (
              <Tr key={`${m.mrnNo}-${l.code}`} zebra={k % 2 === 1}>
                <Td num strong>{i === 0 ? m.mrnNo : ""}</Td>
                <Td num>{i === 0 ? m.bomNo : ""}</Td>
                <Td num>{i === 0 ? stamp(m.raisedAt) : ""}</Td>
                <Td>{i === 0 ? m.returnedBy : ""}</Td>
                <Td>
                  {l.name} <span className="num text-muted">{l.code}</span>
                </Td>
                <Td right num>{fmt(l.returned)} {l.unit}</Td>
                <Td right num strong>{l.received === null ? "—" : fmt(l.received)}</Td>
                <Td>{i === 0 && (m.status === "APPROVED" ? <Chip label="APPROVED · IN STOCK" tone="green" /> : <Chip label="PENDING" tone="amber" />)}</Td>
                <Td muted>{i === 0 && m.verifiedBy ? `${m.verifiedBy}, ${stamp(m.verifiedAt)}${m.verifyRemarks ? ` — ${m.verifyRemarks}` : ""}` : ""}</Td>
              </Tr>
            )),
          )}
        </Table>
      )}
    </Card>
  );
}
