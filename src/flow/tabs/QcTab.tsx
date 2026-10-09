import { useState } from "react";
import { useAuth } from "../auth";
import { useFlow } from "../store";
import { Card, Chip, EmptyNote, StatusChip, Table, Td, Tr, fmt } from "../ui";
import type { QcStatus } from "../types";

export function QcTab() {
  const { state, fgStock, recordAr, recordPdi } = useFlow();
  const { can } = useAuth();
  const [remarks, setRemarks] = useState<Record<string, string>>({});

  const decided = new Map(state.arRecords.map((a) => [a.intimationId, a]));

  const pending = state.qcIntimations.filter((q) => {
    const ar = decided.get(q.id);
    return !ar || ar.status === "HOLD";
  });

  // PDI queue: every FG batch in stock without a PASSED inspection. Step: PDI.
  const pdiQueue = fgStock.filter((r) => r.inStock > 0 && r.pdi !== "PASSED");

  async function decide(qciId: string, status: Exclude<QcStatus, "UNDER_TEST">) {
    if (await recordAr(qciId, status, remarks[qciId] ?? "")) setRemarks((r) => ({ ...r, [qciId]: "" }));
  }

  const mayDecide = can("qc.decide");
  const mayPdi = can("qc.pdi");

  return (
    <div className="space-y-3">
      <Card title="Waiting for QC decision" step="STEP 8" role="QC">
        {pending.length === 0 ? (
          <EmptyNote>Nothing waiting — every intimation has a final decision.</EmptyNote>
        ) : (
          <Table
            minWidth={900}
            headers={[
              "Intimation",
              "GRN no",
              "Product name",
              { label: "Qty", align: "right" },
              "Current",
              ...(mayDecide ? ["QC remark", "Decision"] : []),
            ]}
          >
            {pending.map((q, i) => {
              const ar = decided.get(q.id);
              return (
                <Tr key={q.id} zebra={i % 2 === 1}>
                  <Td num strong>{q.id}</Td>
                  <Td num>{q.grnNo}</Td>
                  <Td>{q.productName}</Td>
                  <Td right num>{fmt(q.totalQty)}</Td>
                  <Td>{ar ? <StatusChip status="HOLD" /> : <StatusChip status="UNDER_TEST" />}</Td>
                  {mayDecide && (
                    <>
                      <Td>
                        <input
                          className="field h-7 w-[220px] text-[12px]"
                          value={remarks[q.id] ?? ""}
                          onChange={(e) => setRemarks((r) => ({ ...r, [q.id]: e.target.value }))}
                          placeholder="Remark (optional)"
                          aria-label={`QC remark for ${q.id}`}
                        />
                      </Td>
                      <Td>
                        <div className="flex gap-1">
                          <button
                            className="btn h-7 px-2 text-[11px]"
                            style={{ borderColor: "var(--green)", color: "var(--green)" }}
                            onClick={() => decide(q.id, "APPROVED")}
                          >
                            Approve
                          </button>
                          {!ar && (
                            <button
                              className="btn h-7 px-2 text-[11px]"
                              style={{ borderColor: "var(--amber)", color: "var(--amber)" }}
                              onClick={() => decide(q.id, "HOLD")}
                            >
                              Hold
                            </button>
                          )}
                          <button
                            className="btn h-7 px-2 text-[11px]"
                            style={{ borderColor: "var(--red)", color: "var(--red)" }}
                            onClick={() => decide(q.id, "REJECTED")}
                          >
                            Reject
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

      <Card title="PDI — pre-dispatch inspection" step="BEFORE DISPATCH" role="QC">
        {pdiQueue.length === 0 ? (
          <EmptyNote>No batch waiting for PDI — every batch in FG stock is inspected.</EmptyNote>
        ) : (
          <Table
            minWidth={800}
            headers={[
              "Product",
              "Batch",
              { label: "In stock", align: "right" },
              "PDI status",
              ...(mayPdi ? ["Decision"] : []),
            ]}
          >
            {pdiQueue.map((r, i) => (
              <Tr key={`${r.productName}-${r.batchNo}`} zebra={i % 2 === 1}>
                <Td>{r.productName}</Td>
                <Td num>{r.batchNo}</Td>
                <Td right num>{fmt(r.inStock)}</Td>
                <Td>
                  {r.pdi === "FAILED" ? (
                    <Chip label="PDI FAILED" tone="red" />
                  ) : (
                    <Chip label="PDI PENDING" tone="amber" />
                  )}
                </Td>
                {mayPdi && (
                  <Td>
                    <div className="flex gap-1">
                      <button
                        className="btn h-7 px-2 text-[11px]"
                        style={{ borderColor: "var(--green)", color: "var(--green)" }}
                        onClick={() => recordPdi(r.productName, r.batchNo, "PASSED", "")}
                      >
                        Pass PDI
                      </button>
                      <button
                        className="btn h-7 px-2 text-[11px]"
                        style={{ borderColor: "var(--red)", color: "var(--red)" }}
                        onClick={() => recordPdi(r.productName, r.batchNo, "FAILED", "PDI failed")}
                      >
                        Fail
                      </button>
                    </div>
                  </Td>
                )}
              </Tr>
            ))}
          </Table>
        )}
        <p className="border-t border-rule px-3 py-2 text-[11px] text-muted">
          A batch cannot be dispatched until QC passes its PDI — as per your answer: “every batch
          is checked before dispatch.”
        </p>
      </Card>

      <Card title="Q.C Intimation Slip — PM/RM" step="STEP 6" role="Store → QC">
        <Table
          minWidth={1100}
          headers={[
            "Slip no",
            "Date",
            "Time",
            "GRN no",
            "Product name",
            "Code",
            "Supplier",
            "Invoice no",
            "Batch no",
            "MFG date",
            "Expiry",
            { label: "Total qty", align: "right" },
            { label: "Total box", align: "right" },
            "Remark",
          ]}
        >
          {state.qcIntimations
            .slice()
            .reverse()
            .map((q, i) => (
              <Tr key={q.id} zebra={i % 2 === 1}>
                <Td num strong>{q.id}</Td>
                <Td num>{q.date}</Td>
                <Td num>{q.timeOfIssue}</Td>
                <Td num>{q.grnNo}</Td>
                <Td>{q.productName}</Td>
                <Td num>{q.code}</Td>
                <Td>{q.supplierName}</Td>
                <Td num>{q.invoiceNo || "—"}</Td>
                <Td num>{q.batchNo || "—"}</Td>
                <Td num>{q.mfgDate || "—"}</Td>
                <Td num>{q.expiryDate || "—"}</Td>
                <Td right num>{fmt(q.totalQty)}</Td>
                <Td right num>{q.totalBox === null ? "—" : fmt(q.totalBox)}</Td>
                <Td muted>{q.remark || "—"}</Td>
              </Tr>
            ))}
        </Table>
        {state.qcIntimations.length === 0 && (
          <EmptyNote>No intimations yet — send a GRN to QC from the GRN register.</EmptyNote>
        )}
      </Card>

      <Card title="Q.C Testing and A.R. No Generator" step="STEPS 7–9" role="QC Analyst">
        <Table
          minWidth={1000}
          headers={[
            "A.R. no",
            "Date",
            "Intimation",
            "GRN no",
            "Product name",
            { label: "Total qty", align: "right" },
            "Status",
            "Remark",
          ]}
        >
          {state.arRecords
            .slice()
            .reverse()
            .map((a, i) => {
              const q = state.qcIntimations.find((x) => x.id === a.intimationId);
              return (
                <Tr key={a.arNo} zebra={i % 2 === 1}>
                  <Td num strong>{a.arNo}</Td>
                  <Td num>{a.date}</Td>
                  <Td num>{a.intimationId}</Td>
                  <Td num>{q?.grnNo ?? "—"}</Td>
                  <Td>{q?.productName ?? "—"}</Td>
                  <Td right num>{q ? fmt(q.totalQty) : "—"}</Td>
                  <Td><StatusChip status={a.status} /></Td>
                  <Td muted>{a.remark || "—"}</Td>
                </Tr>
              );
            })}
        </Table>
        {state.arRecords.length === 0 && <EmptyNote>No A.R. records yet.</EmptyNote>}
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        Both registers match your handwritten formats. Approving moves the material into store
        stock; rejected material never enters stock — it goes to the rejection list and, per your
        answer, is destroyed after communication with the vendor, not returned. A held item is
        re-tested and then approved or rejected; the earlier HOLD record stays in the register.
      </p>
    </div>
  );
}
