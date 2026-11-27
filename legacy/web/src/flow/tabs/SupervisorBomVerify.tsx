import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { todayLabel } from "../store";
import { Card, Chip, DateInput, EmptyNote, Table, Td, TextInput, Tr, fmt } from "../ui";
import { iso } from "./ProductionPlanning";

interface SlipLine {
  code: string;
  name: string;
  unit: string;
  required: number;
  issued: number;
  remark: string;
  received: number | null;
}

interface Slip {
  bomNo: string;
  filledBy: string;
  issuedAt: string;
  verifiedBy: string;
  verifiedAt: string;
  lines: SlipLine[];
}

const signed = (n: number) => (n === 0 ? "—" : `${n > 0 ? "+" : ""}${fmt(n)}`);
const time = (isoTime: string) => new Date(isoTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

/**
 * Supervisor BOM verify: every BOM list Store issued on a date, one expandable row each (like the PO list), with what
 * actually reached the line. Each is verified on its own, once. Stock is not changed here — the issue slip already
 * took it out.
 */
export function SupervisorBomVerify() {
  const { can } = useAuth();
  const mayVerify = can("production.verify");
  const [date, setDate] = useState(todayLabel());
  const [slips, setSlips] = useState<Slip[]>([]);
  /** received qty typed, per BOM per line */
  const [received, setReceived] = useState<Record<string, string[]>>({});
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /** the supervisor's name, per BOM — each BOM is verified on its own */
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef("");

  async function load(d: string, keepMessage = false) {
    latest.current = d;
    if (!keepMessage) setMessage(null);
    try {
      const r = await api<{ slips: Slip[] }>("GET", `/production-verifications/${iso(d)}`);
      if (latest.current !== d) return; // a newer date was picked meanwhile
      setSlips(r.slips);
      // keep what was typed for BOMs still pending
      setReceived((prev) => Object.fromEntries(r.slips.filter((s) => !s.verifiedBy).map((s) => [s.bomNo, prev[s.bomNo] ?? s.lines.map(() => "")])));
    } catch (e) {
      if (latest.current === d) setMessage({ text: (e as Error).message, error: true });
    }
  }

  useEffect(() => {
    if (date) void load(date);
  }, [date]);

  const toggle = (bomNo: string) =>
    setOpened((o) => {
      const n = new Set(o);
      if (n.has(bomNo)) n.delete(bomNo);
      else n.add(bomNo);
      return n;
    });

  async function submit(s: Slip) {
    setBusy(s.bomNo);
    setMessage(null);
    try {
      await api("POST", "/production-verifications", { verifiedBy: (names[s.bomNo] ?? "").trim(), boms: [{ bomNo: s.bomNo, received: received[s.bomNo].map(Number) }] });
      setMessage({ text: `${s.bomNo} verified.`, error: false });
      await load(date, true);
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  }

  const setQty = (bomNo: string, i: number, v: string) =>
    setReceived((r) => ({ ...r, [bomNo]: r[bomNo].map((x, j) => (j === i ? v : x)) }));
  const pending = slips.filter((s) => !s.verifiedBy).length;

  return (
    <Card title="Supervisor BOM verify" role={`${slips.length} issued · ${pending} to verify`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-[12.5px]">
        <label className="flex items-center gap-2 font-semibold">
          Issued on
          <DateInput value={date} onChange={setDate} ariaLabel="Issue date" />
        </label>
        {message && <span style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}
      </div>

      {slips.length === 0 ? (
        <EmptyNote>No BOM issue slip was submitted on this date.</EmptyNote>
      ) : (
        <div className="divide-y divide-rule">
          {slips.map((s) => {
            const isOpen = opened.has(s.bomNo);
            const typed = received[s.bomNo];
            const lostOf = (l: SlipLine, i: number) => {
              const got = s.verifiedBy ? l.received : typed?.[i] === "" || typed?.[i] === undefined ? null : Number(typed[i]);
              return got === null ? null : l.issued - got;
            };
            const tooMuch = !s.verifiedBy && s.lines.some((l, i) => (lostOf(l, i) ?? 0) < 0);
            const name = names[s.bomNo] ?? "";
            const complete = !s.verifiedBy && name.trim() !== "" && Boolean(typed?.every((v) => v !== "")) && !tooMuch;
            const lostTotal = s.lines.reduce((n, l, i) => n + Math.max(0, lostOf(l, i) ?? 0), 0);
            return (
              <div key={s.bomNo} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="flex flex-wrap items-center gap-2 text-left"
                    onClick={() => toggle(s.bomNo)}
                    aria-expanded={isOpen}
                    title={isOpen ? "Hide the items" : "Show the items"}
                  >
                    <span className="w-3 text-[11px] text-muted" aria-hidden>
                      {isOpen ? "▼" : "▶"}
                    </span>
                    <span className="num text-[13px] font-bold">{s.bomNo}</span>
                    <span className="num text-[12px] text-muted">issued {time(s.issuedAt)}</span>
                    <span className="text-[12.5px]">
                      issued by <b>{s.filledBy}</b> (store)
                    </span>
                    <span className="text-[11.5px] text-muted">
                      {s.lines.length} item{s.lines.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    {lostTotal > 0 && <Chip label={`LOST ${fmt(lostTotal)}`} tone="red" />}
                    {s.verifiedBy ? (
                      <Chip label={`VERIFIED BY ${s.verifiedBy.toUpperCase()} — ${time(s.verifiedAt)}`} tone="green" />
                    ) : (
                      <Chip label="PENDING VERIFICATION" tone="amber" />
                    )}
                  </span>
                </div>

                {isOpen && (
                  <div className="mt-2 overflow-hidden rounded-[3px] border border-rule">
                    <Table
                      minWidth={1000}
                      headers={[
                        "#",
                        "PM required item name",
                        { label: "Required qty", align: "right" },
                        { label: "Actually dispatched", align: "right" },
                        { label: "Difference", align: "right" },
                        { label: "Received", align: "right" },
                        { label: "Qty lost", align: "right" },
                        "Store remark",
                      ]}
                    >
                      {s.lines.map((l, i) => {
                        const lost = lostOf(l, i);
                        return (
                          <Tr key={l.code} zebra={i % 2 === 1} bg={lost ? "var(--red-soft)" : undefined}>
                            <Td num muted>{i + 1}</Td>
                            <Td>
                              {l.name} <span className="num text-muted">{l.code}</span>
                            </Td>
                            <Td right num>{fmt(l.required)} {l.unit}</Td>
                            <Td right num strong>{fmt(l.issued)}</Td>
                            <Td right num>
                              <span style={{ color: l.issued < l.required ? "var(--red)" : undefined }}>{signed(l.issued - l.required)}</span>
                            </Td>
                            <Td right>
                              {s.verifiedBy || !mayVerify ? (
                                <span className="num">{l.received === null ? "—" : fmt(l.received)}</span>
                              ) : (
                                <>
                                  <TextInput numeric value={typed?.[i] ?? ""} onChange={(v) => setQty(s.bomNo, i, v)} placeholder="0" ariaLabel={`Received, ${l.name}`} />
                                  {lost !== null && lost < 0 && (
                                    <span className="mt-1 block text-[11px] font-semibold" style={{ color: "var(--red)" }}>
                                      more than dispatched
                                    </span>
                                  )}
                                </>
                              )}
                            </Td>
                            <Td right num strong>
                              {lost === null || lost <= 0 ? "—" : <span style={{ color: "var(--red)" }}>{fmt(lost)}</span>}
                            </Td>
                            <Td muted>{l.remark || "—"}</Td>
                          </Tr>
                        );
                      })}
                    </Table>
                    {mayVerify && !s.verifiedBy && (
                      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule bg-[#F7F8FA] px-3 py-2">
                        <label className="mr-auto flex items-center gap-2 text-[12.5px] font-semibold">
                          Verified by (supervisor)
                          <TextInput
                            value={name}
                            onChange={(v) => setNames((n) => ({ ...n, [s.bomNo]: v }))}
                            placeholder="Supervisor name"
                            ariaLabel={`Verified by, ${s.bomNo}`}
                          />
                        </label>
                        <button
                          className="btn h-8"
                          onClick={() => setReceived((r) => ({ ...r, [s.bomNo]: s.lines.map((l) => String(l.issued)) }))}
                          disabled={busy !== ""}
                        >
                          Same as dispatched
                        </button>
                        <button className="btn btn-primary h-8" onClick={() => void submit(s)} disabled={busy !== "" || !complete}>
                          {busy === s.bomNo ? "Submitting…" : "Final submit"}
                        </button>
                      </div>
                    )}
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
