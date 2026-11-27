import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, SearchPicker, Table, Td, TextInput, Tr, fmt } from "../ui";
import { downloadXlsx } from "../xlsx";

interface NoteSummary {
  noteNo: string;
  date: string;
  rows: number;
  totalQty: number;
  status: "PENDING" | "RECEIVED";
  verifiedBy: string;
  receivedAt: string;
}
interface NoteLine {
  productName: string;
  productType: string;
  qtyInBox: number | null;
  totalBox: number | null;
  totalQty: number | null;
  palletNo: string;
  supervisor: string;
  verifiedQty: number | null;
  remark: string;
}
interface Note extends Omit<NoteSummary, "rows" | "totalQty"> {
  lines: NoteLine[];
}

const when = (t: string) => new Date(t).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const totalOf = (l: NoteLine) => l.totalQty ?? (l.qtyInBox ?? 0) * (l.totalBox ?? 0);

/** FG warehouse picks an FG transfer note, counts each row and marks the note received (then locked). */
export function FgTransferVerify() {
  const { masters, productionTick } = useFlow();
  const { can, user } = useAuth();
  const mayReceive = can("fg.receive");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [pick, setPick] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const [verified, setVerified] = useState<string[]>([]);
  const [remarks, setRemarks] = useState<string[]>([]);
  const [verifiedBy, setVerifiedBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api<{ notes: NoteSummary[] }>("GET", "/fg-transfer-notes").then((r) => setNotes(r.notes), (e) => setMessage({ text: (e as Error).message, error: true }));
  }, [productionTick, reload]);

  async function open(no: string) {
    setPick(no);
    setNote(null);
    setMessage(null);
    if (!notes.some((n) => n.noteNo === no)) return; // still typing
    try {
      const n = await api<Note>("GET", `/fg-transfer-notes/${encodeURIComponent(no)}`);
      setNote(n);
      setVerified(n.lines.map((l) => (l.verifiedQty === null ? "" : String(l.verifiedQty))));
      setRemarks(n.lines.map((l) => l.remark));
      setVerifiedBy(n.verifiedBy || user?.label || "");
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
  }

  const options = useMemo(
    () => notes.map((n) => ({ value: n.noteNo, hint: `${n.date} · ${n.rows} row(s) · ${fmt(n.totalQty)} pcs · ${n.status === "PENDING" ? "pending" : "received"}` })),
    [notes],
  );
  const locked = !mayReceive || note?.status === "RECEIVED";
  const missing = verified.some((v) => v.trim() === "");

  async function receive() {
    if (!note || !window.confirm(`Mark ${note.noteNo} as received? It cannot be changed afterwards.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/fg-transfer-notes/${encodeURIComponent(note.noteNo)}/receive`, {
        verifiedBy: verifiedBy.trim(),
        lines: verified.map((v, i) => ({ verifiedQty: Number(v), remark: (remarks[i] ?? "").trim() })),
      });
      setMessage({ text: `${note.noteNo} verified and marked received.`, error: false });
      setReload((n) => n + 1);
      await open(note.noteNo);
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const HEADERS = ["#", "Product name", "FG code", "Qty in box", "Total box", "Total qty", "Verified qty", "Difference", "Pallet no", "Supervisor", "Remark"];
  const excel = () =>
    note &&
    downloadXlsx(`FG Transfer Verify (${note.noteNo})`, "FG Transfer Verify", [
      HEADERS,
      ...note.lines.map((l, i) => {
        const v = verified[i] === "" ? null : Number(verified[i]);
        return [i + 1, l.productName, masters.productByName.get(l.productName)?.fg ?? "", l.qtyInBox, l.totalBox, totalOf(l), v, v === null ? "" : v - totalOf(l), l.palletNo, l.supervisor, remarks[i] ?? ""];
      }),
    ]);
  const td = "border-b border-r border-rule px-2 py-1 align-middle text-center";

  return (
    <div className="space-y-3">
      <Card
        title="FG transfer verify"
        step={note ? (note.status === "RECEIVED" ? "RECEIVED" : "PENDING") : "PICK A NOTE"}
        role="FG Warehouse"
        right={
          note && (
            <>
              {!locked && (
                <>
                  <button className="btn h-8" onClick={() => setVerified(note.lines.map((l) => String(totalOf(l))))} disabled={busy}>
                    Same as total qty
                  </button>
                  <button
                    className="btn btn-primary h-8"
                    onClick={() => void receive()}
                    disabled={busy || missing || !verifiedBy.trim()}
                    title={missing ? "Fill the verified qty of every row" : !verifiedBy.trim() ? "Fill in who verified" : undefined}
                  >
                    Verify & mark received
                  </button>
                </>
              )}
              <button className="btn h-8" onClick={excel}>
                Generate Excel
              </button>
            </>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
          <label className="flex items-center gap-2 font-semibold">
            FG transfer no
            <span className="w-[230px]">
              <SearchPicker value={pick} onChange={(v) => void open(v)} options={options} placeholder="Pick FTN number" ariaLabel="FG transfer number" minWidth={360} />
            </span>
          </label>
          {note && (
            <label className="flex items-center gap-2 font-semibold">
              Verified by
              <fieldset disabled={locked} className="contents">
                <TextInput value={verifiedBy} onChange={setVerifiedBy} placeholder="Name" ariaLabel="Verified by" />
              </fieldset>
            </label>
          )}
          {note && <span className="text-muted">Note date {note.date} · {note.lines.length} row(s)</span>}
          {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
        </div>
        {note?.status === "RECEIVED" && (
          <p className="border-b border-rule px-3 py-2 text-center text-[12.5px] font-semibold" style={{ background: "var(--green-soft, #E8F5EC)", color: "var(--green)" }}>
            Received — verified by {note.verifiedBy} on {when(note.receivedAt)}. Locked.
          </p>
        )}
        {!note ? (
          <EmptyNote>{notes.some((n) => n.status === "PENDING") ? "Pick an FG transfer number to load its rows." : "No FG transfer note waiting — every note is received."}</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <fieldset disabled={locked}>
              <table className="w-full border-collapse text-[12.5px]" style={{ minWidth: 1500 }}>
                <thead>
                  <tr className="bg-[#1c2533] text-white">
                    {HEADERS.map((h) => (
                      <th key={h} className="border-r border-white/15 px-2 py-2 text-center text-[10.5px] font-bold uppercase tracking-[.05em]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {note.lines.map((l, i) => {
                    const t = totalOf(l);
                    const v = verified[i] === "" ? null : Number(verified[i]);
                    const diff = v === null ? null : v - t;
                    return (
                      <tr key={i} style={{ background: i % 2 ? "#FAFAFA" : "var(--card)" }}>
                        <td className={`${td} num text-muted`}>{i + 1}</td>
                        <td className={td}>{l.productName}</td>
                        <td className={`${td} num`}>{masters.productByName.get(l.productName)?.fg ?? "—"}</td>
                        <td className={`${td} num`}>{l.qtyInBox === null ? "—" : fmt(l.qtyInBox)}</td>
                        <td className={`${td} num`}>{l.totalBox === null ? "—" : fmt(l.totalBox)}</td>
                        <td className={`${td} num font-semibold`}>{fmt(t)}</td>
                        <td className={`${td} w-[120px]`}>
                          <TextInput
                            numeric
                            value={verified[i] ?? ""}
                            onChange={(x) => setVerified((vs) => vs.map((y, j) => (j === i ? x.replace(/\D/g, "") : y)))}
                            placeholder=""
                            ariaLabel={`Verified qty, row ${i + 1}`}
                          />
                        </td>
                        <td className={`${td} num bg-[#EEF1F5] font-bold`} style={{ color: diff === null || diff === 0 ? undefined : "var(--red)" }}>
                          {diff === null ? "—" : diff > 0 ? `+${fmt(diff)}` : fmt(diff)}
                        </td>
                        <td className={`${td} num`}>{l.palletNo || "—"}</td>
                        <td className={td}>{l.supervisor || "—"}</td>
                        <td className={`${td} w-[200px]`}>
                          <TextInput value={remarks[i] ?? ""} onChange={(x) => setRemarks((rs) => rs.map((y, j) => (j === i ? x : y)))} ariaLabel={`Remark, row ${i + 1}`} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </fieldset>
          </div>
        )}
      </Card>

      <Card title="FG transfer notes" step="STATUS" role={`${notes.filter((n) => n.status === "PENDING").length} pending`}>
        {notes.length === 0 ? (
          <EmptyNote>No FG transfer note yet.</EmptyNote>
        ) : (
          <Table minWidth={800} headers={["FTN no", "Date", { label: "Rows", align: "right" }, { label: "Total qty", align: "right" }, "Status", "Verified by"]}>
            {notes.map((n, i) => (
              <Tr key={n.noteNo} zebra={i % 2 === 1}>
                <Td num strong>
                  <button className="underline-offset-2 hover:underline" onClick={() => void open(n.noteNo)}>
                    {n.noteNo}
                  </button>
                </Td>
                <Td num>{n.date}</Td>
                <Td right num>{n.rows}</Td>
                <Td right num>{fmt(n.totalQty)}</Td>
                <Td>
                  <Chip label={n.status} tone={n.status === "RECEIVED" ? "green" : "amber"} />
                </Td>
                <Td muted>{n.verifiedBy ? `${n.verifiedBy} · ${when(n.receivedAt)}` : "—"}</Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
