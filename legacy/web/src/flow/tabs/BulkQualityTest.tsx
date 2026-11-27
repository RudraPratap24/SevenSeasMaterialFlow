import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, StatusChip, Table, Td, Tr, fmt } from "../ui";
import { type BulkUnit, unitLabel } from "./BulkProductionPlan";

interface QtRow {
  date: string;
  isoDate: string;
  rowNo: number;
  itemName: string;
  unit: BulkUnit;
  shade: string;
  actualQty: number;
  mfgBy: string;
  status: "UNDER_TEST" | "ACCEPTED" | "REJECTED" | "HOLD";
  acceptedQty: number | null;
  remarks: string;
  decidedBy: string;
  decidedAt: string;
}

const q = (n: number, u: BulkUnit) => `${fmt(n)} ${unitLabel(u)}`;

/**
 * Quality Testing of bulk: every row of a final-submitted bulk manufacturing report waits here. QC accepts it (all or a
 * typed qty — the rest is rejected), rejects it or holds it for a re-test. Accepted qty is bulk stock (PM Stock tab).
 */
export function BulkQualityTest() {
  const { productionTick } = useFlow();
  const { can } = useAuth();
  const mayDecide = can("qc.decide");
  const [data, setData] = useState<{ rows: QtRow[] } | null>(null);
  const [accepted, setAccepted] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api<NonNullable<typeof data>>("GET", "/bulk-qt").then(setData, (e) => setMessage({ text: (e as Error).message, error: true }));
  }, [reload, productionTick]);

  const key = (r: QtRow) => `${r.isoDate}:${r.rowNo}`;
  const pending = data?.rows.filter((r) => r.status === "UNDER_TEST" || r.status === "HOLD") ?? [];
  const decided = data?.rows.filter((r) => r.status === "ACCEPTED" || r.status === "REJECTED") ?? [];

  async function decide(r: QtRow, status: "ACCEPTED" | "REJECTED" | "HOLD") {
    const k = key(r);
    const typed = accepted[k] ?? "";
    setBusy(k);
    setMessage(null);
    try {
      await api("POST", `/bulk-qt/${r.isoDate}/${r.rowNo}`, {
        status,
        acceptedQty: status === "ACCEPTED" && typed !== "" ? Number(typed) : null,
        remarks: (remarks[k] ?? "").trim(),
      });
      setAccepted((a) => ({ ...a, [k]: "" }));
      setRemarks((m) => ({ ...m, [k]: "" }));
      setMessage({ text: `${r.itemName}: ${status === "HOLD" ? "on hold" : status.toLowerCase()}.`, error: false });
      setReload((n) => n + 1);
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-3">
      <Card title="Waiting for Quality Testing" step="BULK QT" role="QC" right={message && <span className="text-[12px]" style={{ color: message.error ? "var(--red)" : "var(--green)" }}>{message.text}</span>}>
        {!data ? (
          <EmptyNote>Loading…</EmptyNote>
        ) : pending.length === 0 ? (
          <EmptyNote>Nothing waiting — every final-submitted bulk batch has a decision.</EmptyNote>
        ) : (
          <Table
            minWidth={1000}
            headers={[
              "Report date",
              "Product",
              "Shade",
              "Mfg by",
              { label: "Made qty", align: "right" },
              "Current",
              ...(mayDecide ? [{ label: "Accepted qty", align: "right" as const }, "Remark", "Decision"] : []),
            ]}
          >
            {pending.map((r, i) => {
              const k = key(r);
              const typed = accepted[k] ?? "";
              const take = typed === "" ? r.actualQty : Number(typed);
              const rejecting = Math.round((r.actualQty - take) * 1000) / 1000;
              const badQty = typed !== "" && !(take > 0 && take <= r.actualQty);
              const needReason = rejecting > 0 && !(remarks[k] ?? "").trim();
              return (
                <Tr key={k} zebra={i % 2 === 1}>
                  <Td num>{r.date}</Td>
                  <Td strong>{r.itemName}</Td>
                  <Td>{r.shade || "—"}</Td>
                  <Td>{r.mfgBy || "—"}</Td>
                  <Td right num>{q(r.actualQty, r.unit)}</Td>
                  <Td>{r.status === "HOLD" ? <StatusChip status="HOLD" /> : <StatusChip status="UNDER_TEST" />}</Td>
                  {mayDecide && (
                    <>
                      <Td right>
                        <input
                          className="field num h-7 w-28 text-right"
                          inputMode="decimal"
                          value={typed}
                          onChange={(e) => setAccepted((a) => ({ ...a, [k]: e.target.value.replace(/[^\d.]/g, "") }))}
                          placeholder={`all ${q(r.actualQty, r.unit)}`}
                          aria-label={`Accepted qty of ${r.itemName}`}
                        />
                        {rejecting > 0 && !badQty && (
                          <span className="mt-0.5 block text-[10.5px] font-semibold" style={{ color: "var(--red)" }}>
                            {q(rejecting, r.unit)} rejected
                          </span>
                        )}
                        {badQty && (
                          <span className="mt-0.5 block text-[10.5px] font-semibold" style={{ color: "var(--red)" }}>
                            above 0, up to {q(r.actualQty, r.unit)}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <input
                          className="field h-7 w-[200px] text-[12px]"
                          value={remarks[k] ?? ""}
                          onChange={(e) => setRemarks((m) => ({ ...m, [k]: e.target.value }))}
                          placeholder={rejecting > 0 ? "Why rejected?" : "Remark (optional)"}
                          aria-label={`QT remark for ${r.itemName}`}
                        />
                      </Td>
                      <Td>
                        <div className="flex gap-1">
                          <button
                            className="btn h-7 px-2 text-[11px]"
                            style={{ borderColor: "var(--green)", color: "var(--green)" }}
                            onClick={() => decide(r, "ACCEPTED")}
                            disabled={busy === k || badQty || needReason}
                            title={needReason ? "Say why the rest is rejected" : undefined}
                          >
                            {rejecting > 0 && !badQty ? `Accept ${q(take, r.unit)}` : "Accept all"}
                          </button>
                          {r.status !== "HOLD" && (
                            <button className="btn h-7 px-2 text-[11px]" style={{ borderColor: "var(--amber)", color: "var(--amber)" }} onClick={() => decide(r, "HOLD")} disabled={busy === k}>
                              Hold
                            </button>
                          )}
                          <button className="btn h-7 px-2 text-[11px]" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => decide(r, "REJECTED")} disabled={busy === k}>
                            Reject all
                          </button>
                        </div>
                      </Td>
                    </>
                  )}
                </Tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="QT decisions" step="LAST 60 DAYS">
        {decided.length === 0 ? (
          <EmptyNote>No decisions yet.</EmptyNote>
        ) : (
          <Table minWidth={900} headers={["Report date", "Product", { label: "Made", align: "right" }, { label: "Accepted", align: "right" }, "Decision", "Remark", "By"]}>
            {decided.map((r, i) => (
              <Tr key={key(r)} zebra={i % 2 === 1}>
                <Td num>{r.date}</Td>
                <Td>{r.itemName}</Td>
                <Td right num>{q(r.actualQty, r.unit)}</Td>
                <Td right num strong>{q(r.acceptedQty ?? 0, r.unit)}</Td>
                <Td>
                  <Chip label={r.status} tone={r.status === "ACCEPTED" ? "green" : "red"} />
                </Td>
                <Td muted>{r.remarks || "—"}</Td>
                <Td muted>
                  {r.decidedBy} · {new Date(r.decidedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
