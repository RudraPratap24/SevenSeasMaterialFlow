import { useMemo, useState } from "react";
import { useAuth } from "../auth";
import { todayLabel, useFlow } from "../store";
import { Card, EmptyNote, Field, StatusChip, Table, Td, TextInput, Tr, fmt } from "../ui";

export function GrnTab({ onTrace }: { onTrace: (grnNo: string) => void }) {
  const { state, addGrnLine, sendToQc, setBarcoded, updateGrnQty, masters } = useFlow();
  const COMPONENTS = masters.components;
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [gateEntryId, setGateEntryId] = useState("");
  const [code, setCode] = useState("");
  const [qtyPerBox, setQtyPerBox] = useState("");
  const [boxes, setBoxes] = useState("");

  const comp = masters.componentByCode.get(code.trim().toUpperCase());
  const gate = state.gateEntries.find((g) => g.id === gateEntryId);
  const totalQty = (Number(qtyPerBox) || 0) * (Number(boxes) || 0);

  const intimatedGrns = useMemo(
    () => new Set(state.qcIntimations.map((q) => q.grnNo)),
    [state.qcIntimations],
  );

  /** One click, no typing: latest gate entry + the BL-686 ready-stock component. */
  function fillDemo() {
    const latest = state.gateEntries[state.gateEntries.length - 1];
    if (!latest) return;
    setGateEntryId(latest.id);
    setCode("PMS0014");
    setQtyPerBox("100");
    setBoxes("24");
    setOpen(true);
  }

  async function save() {
    if (!comp || !gate || totalQty <= 0) return;
    const ok = await addGrnLine({
      gateEntryId: gate.id,
      componentCode: comp.code,
      componentName: comp.name,
      type: comp.type,
      brandName: "SEVEN SEAS",
      receivedDate: todayLabel(),
      poNo: gate.poNo,
      poQty: null,
      location: "Store — Floor 1",
      invoiceNo: gate.invoiceNo,
      supplierName: gate.supplierName,
      qtyPerBox: Number(qtyPerBox),
      totalBoxes: Number(boxes),
      totalQty,
      remarkStore: "",
    });
    if (!ok) return;
    setCode("");
    setQtyPerBox("");
    setBoxes("");
    setOpen(false);
  }

  return (
    <div className="space-y-3">
      <Card
        title="GRN Register — Goods Received Note"
        step="STEPS 3–5"
        role="Store"
        right={
          can("grn.create") ? (
            <>
              <button
                className="btn"
                onClick={fillDemo}
                disabled={state.gateEntries.length === 0}
                title={
                  state.gateEntries.length === 0
                    ? "Make a gate entry first"
                    : "Fill the form with example values against the latest gate entry"
                }
              >
                Enter demo data
              </button>
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
                {open ? "Close" : "New GRN"}
              </button>
            </>
          ) : null
        }
      >
        {open && can("grn.create") && (
          <div className="border-b border-rule bg-zebra px-3 py-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Field label="Against gate entry">
                <select
                  className="field h-8"
                  value={gateEntryId}
                  onChange={(e) => setGateEntryId(e.target.value)}
                  aria-label="Against gate entry"
                >
                  <option value="">Select…</option>
                  {state.gateEntries
                    .slice()
                    .reverse()
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.id} — {g.supplierName}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Component code">
                <TextInput
                  value={code}
                  onChange={setCode}
                  placeholder="PMS0164"
                  ariaLabel="Component code"
                  list="component-codes"
                />
              </Field>
              <Field label="Component name">
                <div className="field flex h-8 items-center truncate text-[12px] text-muted">
                  {comp ? comp.name : "Type a PMS code"}
                </div>
              </Field>
              <Field label="Qty in 1 box">
                <TextInput value={qtyPerBox} onChange={setQtyPerBox} numeric placeholder="30" />
              </Field>
              <Field label="Total boxes">
                <TextInput value={boxes} onChange={setBoxes} numeric placeholder="100" />
              </Field>
            </div>
            <datalist id="component-codes">
              {COMPONENTS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </datalist>
            <div className="mt-3 flex items-center gap-3">
              <button className="btn btn-primary" onClick={save} disabled={!comp || !gate || totalQty <= 0}>
                Create GRN — total {fmt(totalQty)} pcs
              </button>
              <span className="text-[11px] text-muted">
                New GRN goes to quarantine as UNDER TEST until QC decides.
              </span>
            </div>
          </div>
        )}

        <Table
          minWidth={1200}
          headers={[
            "GRN no",
            "Component",
            "Type",
            "Code",
            "Brand",
            "Received",
            "Gate entry",
            "PO no",
            "Invoice no",
            "Supplier",
            { label: "Qty/box", align: "right" },
            { label: "Boxes", align: "right" },
            { label: "Total qty", align: "right" },
            "QC status",
            "Barcode",
            "",
          ]}
        >
          {state.grnLines
            .slice()
            .reverse()
            .map((g, i) => (
              <Tr key={g.grnNo} zebra={i % 2 === 1}>
                <Td num strong>{g.grnNo}</Td>
                <Td>{g.componentName}</Td>
                <Td muted>{g.type}</Td>
                <Td num>{g.componentCode}</Td>
                <Td muted>{g.brandName}</Td>
                <Td num>{g.receivedDate}</Td>
                <Td num>{g.gateEntryId}</Td>
                <Td num>{g.poNo || "—"}</Td>
                <Td num>{g.invoiceNo || "—"}</Td>
                <Td>{g.supplierName}</Td>
                <Td right num>{g.qtyPerBox === null ? "—" : fmt(g.qtyPerBox)}</Td>
                <Td right num>{g.totalBoxes === null ? "—" : fmt(g.totalBoxes)}</Td>
                <Td right num strong>
                  {g.qcStatus === "UNDER_TEST" && !intimatedGrns.has(g.grnNo) && can("grn.qty") ? (
                    <QtyCell
                      grnNo={g.grnNo}
                      value={g.totalQty}
                      onCommit={(v) => updateGrnQty(g.grnNo, v)}
                    />
                  ) : (
                    fmt(g.totalQty)
                  )}
                </Td>
                <Td><StatusChip status={g.qcStatus} /></Td>
                <Td>
                  {g.qcStatus === "APPROVED" ? (
                    <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        checked={g.barcoded}
                        disabled={!can("grn.barcode") || g.barcoded}
                        onChange={(e) => setBarcoded(g.grnNo, e.target.checked)}
                        aria-label={`Barcode pasted on ${g.grnNo}`}
                      />
                      {g.barcoded ? "Pasted" : "Pending"}
                    </label>
                  ) : (
                    <span className="text-[11px] text-muted">—</span>
                  )}
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {g.qcStatus === "UNDER_TEST" && !intimatedGrns.has(g.grnNo) && can("grn.sendqc") && (
                      <button
                        className="btn h-6 px-2 text-[11px]"
                        onClick={() => sendToQc(g.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" })}
                      >
                        Send to QC
                      </button>
                    )}
                    <button className="btn h-6 px-2 text-[11px]" onClick={() => onTrace(g.grnNo)}>
                      Trace
                    </button>
                  </div>
                </Td>
              </Tr>
            ))}
        </Table>
        {state.grnLines.length === 0 && <EmptyNote>No GRNs yet.</EmptyNote>}
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        Columns match your GRN sheet exactly — SR NO · COMPONENT NAME · TYPE · COMPONENT CODE ·
        BRAND NAME · RECEIVED DATE · GATE ENTRY NO · PO NO · PO QTY · INVOICE NO · SUPPLIER NAME ·
        QTY IN 1 BOX · TOTAL BOX RECEIVED · TOTAL QTY RECEIVED · REMARK STORE · GRN NO. (With
        demo data loaded, GR0001–GR0003 are the real rows from your sheet.) New material waits
        in quarantine (UNDER TEST) until QC approves — step 5 of the SOP. The quantity can be
        corrected only until the GRN is sent to QC; from then on every passed stage is locked.
      </p>
    </div>
  );
}

/** Editable qty for material still in quarantine — commit on Enter or blur. */
function QtyCell({
  grnNo,
  value,
  onCommit,
}: {
  grnNo: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="num h-7 w-[90px] rounded-[2px] border border-transparent bg-transparent text-right text-[12.5px] font-bold hover:border-rule focus:border-blue focus:bg-white"
      type="text"
      inputMode="numeric"
      aria-label={`Total qty for ${grnNo}`}
      title="Editable while in quarantine"
      value={draft ?? fmt(value)}
      onFocus={(e) => {
        setDraft(String(value));
        window.setTimeout(() => e.target.select(), 0);
      }}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={() => {
        if (draft !== null && draft !== String(value)) onCommit(Number(draft || 0));
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
