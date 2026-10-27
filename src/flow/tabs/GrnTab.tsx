import { useMemo, useState } from "react";
import { useAuth } from "../auth";
import { awaitingGrn, isPcs, searchAwaitingGrn, type AwaitingGrn } from "../logic";
import { todayLabel, useFlow } from "../store";
import { Card, EmptyNote, Field, SearchPicker, StatusChip, Table, Td, Tr, fmt, fmtQty } from "../ui";

interface Draft {
  code: string;
  perBox: string;
  boxes: string;
  total: string;
  remark: string;
}

export function GrnTab({ onTrace }: { onTrace: (grnNo: string) => void }) {
  const { state, addGrnLine, sendToQc, setBarcoded, updateGrnQty, masters } = useFlow();
  const COMPONENTS = masters.components;
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  /** What Store has typed per waiting item, keyed "GE-0006:2" (":0" = arrival without PO). */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const intimatedGrns = useMemo(
    () => new Set(state.qcIntimations.map((q) => q.grnNo)),
    [state.qcIntimations],
  );
  const waiting = useMemo(() => awaitingGrn(state.gateEntries, state.grnLines), [state.gateEntries, state.grnLines]);

  /** The PMS code Store used before for a Tally item that has none of its own. */
  const remembered = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of state.grnLines) {
      const line =
        g.gateLineNo === null ? undefined : state.gateEntries.find((e) => e.id === g.gateEntryId)?.lines[g.gateLineNo - 1];
      if (line) m.set(line.itemName, g.componentCode);
    }
    return m;
  }, [state.grnLines, state.gateEntries]);

  const keyOf = (w: AwaitingGrn) => `${w.gate.id}:${w.lineNo ?? 0}`;
  const draftOf = (w: AwaitingGrn): Draft =>
    drafts[keyOf(w)] ?? {
      code: w.line ? w.line.itemCode || remembered.get(w.line.itemName) || "" : "",
      perBox: "",
      boxes: "",
      total: w.line ? String(w.line.qty) : "",
      remark: "",
    };
  const setDraft = (w: AwaitingGrn, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [keyOf(w)]: { ...draftOf(w), ...patch } }));
  /** Counted in boxes (qty in 1 box × boxes) or as a total — Kg and Doz items usually as a total. */
  const countOf = (d: Draft) => (d.perBox && d.boxes ? Number(d.perBox) * Number(d.boxes) : Number(d.total) || 0);

  const shown = searchAwaitingGrn(waiting, search);

  /** One click, no typing: the first item waiting for GRN, counted exactly as checked in at the gate. */
  function fillDemo() {
    const w = waiting[0];
    if (w) setDraft(w, { code: draftOf(w).code || "PMS0014", total: String(w.line?.qty ?? w.gate.invoiceQty ?? 2400) });
    setOpen(true);
  }

  async function save(w: AwaitingGrn) {
    const d = draftOf(w);
    const comp = masters.componentByCode.get(d.code.trim().toUpperCase());
    const total = countOf(d);
    if (!comp || total <= 0) return;
    const inBoxes = Boolean(d.perBox && d.boxes);
    const ok = await addGrnLine({
      gateEntryId: w.gate.id,
      gateLineNo: w.lineNo,
      componentCode: comp.code,
      componentName: comp.name,
      type: comp.type,
      brandName: "SEVEN SEAS",
      receivedDate: todayLabel(),
      poNo: w.gate.poNo,
      poQty: null,
      location: "Store — Floor 1",
      invoiceNo: w.gate.invoiceNo,
      supplierName: w.gate.supplierName,
      qtyPerBox: inBoxes ? Number(d.perBox) : null,
      totalBoxes: inBoxes ? Number(d.boxes) : null,
      totalQty: total,
      unit: "",
      remarkStore: d.remark.trim(),
    });
    if (ok) setDrafts(({ [keyOf(w)]: _, ...rest }) => rest);
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
                disabled={waiting.length === 0}
                title={waiting.length === 0 ? "Nothing is waiting for GRN" : "Fill the first waiting item with example values"}
              >
                Enter demo data
              </button>
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
                {open ? "Close" : `New GRN (${waiting.length} waiting)`}
              </button>
            </>
          ) : null
        }
      >
        {open && can("grn.create") && (
          <div className="space-y-2 border-b border-rule bg-zebra px-3 py-3">
            <Field label="Find what has come in — PO number, supplier, item name, PMS code or gate entry">
              <input
                className="field h-8 w-full"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g. 26SEV301, MAXCOMM, EYELINER, PMS0843, GE-0006"
                autoFocus
              />
            </Field>
            <div className="rounded border border-rule bg-white">
              <Table
                minWidth={1250}
                headers={[
                  "Gate entry",
                  "PO no",
                  "Supplier",
                  "Item",
                  { label: "At gate", align: "right" },
                  "PMS code",
                  { label: "Qty in 1 box", align: "right" },
                  { label: "Boxes", align: "right" },
                  { label: "Total counted", align: "right" },
                  "Remark",
                  "",
                ]}
              >
                {shown.slice(0, 50).map((w, i) => {
                  const d = draftOf(w);
                  const comp = masters.componentByCode.get(d.code.trim().toUpperCase());
                  const unit = w.line?.unit ?? "";
                  const total = countOf(d);
                  const short = w.line !== null && total > 0 && total < w.line.qty;
                  const inBoxes = Boolean(d.perBox && d.boxes);
                  return (
                    <Tr key={keyOf(w)} zebra={i % 2 === 1}>
                      <Td num strong>{w.gate.id}</Td>
                      <Td num>{w.gate.poNo || "—"}</Td>
                      <Td>{w.gate.supplierName}</Td>
                      <Td>{w.line?.itemName ?? (w.gate.productDesc || "—")}</Td>
                      <Td right num>
                        {w.line ? fmtQty(w.line.qty, unit) : w.gate.invoiceQty === null ? "—" : fmtQty(w.gate.invoiceQty)}
                      </Td>
                      <Td>
                        {w.line?.itemCode ? (
                          <span className="num">{w.line.itemCode}</span>
                        ) : (
                          <SearchPicker
                            className="field num h-7 w-24"
                            value={d.code}
                            onChange={(v) => setDraft(w, { code: v })}
                            placeholder="PMS…"
                            minWidth={320}
                            ariaLabel={`PMS code for ${w.line?.itemName ?? w.gate.id}`}
                            options={COMPONENTS.map((c) => ({ value: c.code, hint: c.name }))}
                          />
                        )}
                      </Td>
                      <Td right>
                        <input
                          className="field num h-7 w-20 text-right"
                          inputMode="numeric"
                          value={d.perBox}
                          onChange={(e) => setDraft(w, { perBox: e.target.value.replace(/[^\d]/g, "") })}
                          aria-label="Qty in 1 box"
                        />
                      </Td>
                      <Td right>
                        <input
                          className="field num h-7 w-16 text-right"
                          inputMode="numeric"
                          value={d.boxes}
                          onChange={(e) => setDraft(w, { boxes: e.target.value.replace(/[^\d]/g, "") })}
                          aria-label="Boxes"
                        />
                      </Td>
                      <Td right>
                        {inBoxes ? (
                          <span className="num font-semibold">{fmtQty(total, unit)}</span>
                        ) : (
                          <span className="flex items-center justify-end gap-1">
                            <input
                              className="field num h-7 w-24 text-right"
                              inputMode="decimal"
                              value={d.total}
                              onChange={(e) => setDraft(w, { total: e.target.value.replace(/[^\d.]/g, "") })}
                              aria-label="Total counted"
                            />
                            <span className="text-[11px] text-muted">{unit || "pcs"}</span>
                          </span>
                        )}
                      </Td>
                      <Td>
                        <input
                          className="field h-7 w-40"
                          value={d.remark}
                          onChange={(e) => setDraft(w, { remark: e.target.value })}
                          placeholder={short ? "Counted short — why?" : "Optional"}
                          aria-label="Store remark"
                        />
                      </Td>
                      <Td>
                        <button
                          className="btn btn-primary h-7 px-2 text-[11px]"
                          onClick={() => save(w)}
                          disabled={!comp || total <= 0}
                        >
                          Create GRN
                        </button>
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
              {shown.length === 0 && (
                <EmptyNote>
                  {waiting.length === 0 ? "Nothing is waiting for GRN." : `Nothing waiting matches "${search.trim()}".`}
                </EmptyNote>
              )}
            </div>
            <p className="text-[11px] text-muted">
              One GRN per item, in the PO's unit. Count in boxes, or type the total (Kg, Doz). The count can't be more
              than was checked in at the gate; a short count stays pending on the PO. New GRNs go to quarantine as
              UNDER TEST until QC decides.
            </p>
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
                      decimals={!isPcs(g.unit)}
                      onCommit={(v) => updateGrnQty(g.grnNo, v)}
                    />
                  ) : (
                    fmtQty(g.totalQty, g.unit)
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
        demo data loaded, GR0001–GR0003 are the real rows from your sheet.) Items checked in at the
        gate wait here for their GRN; Store's count is what the PO counts as received. New material
        waits in quarantine (UNDER TEST) until QC approves — step 5 of the SOP. The quantity can be
        corrected only until the GRN is sent to QC; from then on every passed stage is locked.
      </p>
    </div>
  );
}

/** Editable qty for material still in quarantine — commit on Enter or blur. */
function QtyCell({
  grnNo,
  value,
  decimals,
  onCommit,
}: {
  grnNo: string;
  value: number;
  /** Kg, Doz … from the PO: decimals allowed. */
  decimals: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="num h-7 w-[90px] rounded-[2px] border border-transparent bg-transparent text-right text-[12.5px] font-bold hover:border-rule focus:border-blue focus:bg-white"
      type="text"
      inputMode={decimals ? "decimal" : "numeric"}
      aria-label={`Total qty for ${grnNo}`}
      title="Editable while in quarantine"
      value={draft ?? value.toLocaleString("en-IN", { maximumFractionDigits: 3 })}
      onFocus={(e) => {
        setDraft(String(value));
        window.setTimeout(() => e.target.select(), 0);
      }}
      onChange={(e) => setDraft(e.target.value.replace(decimals ? /[^\d.]/g : /[^\d]/g, ""))}
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
