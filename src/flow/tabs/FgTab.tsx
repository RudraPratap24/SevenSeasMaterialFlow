import { useMemo, useState } from "react";
import { useAuth } from "../auth";
import { todayLabel, useFlow } from "../store";
import { Card, Chip, EmptyNote, Field, Table, Td, TextInput, Tr, fmt } from "../ui";

export function FgTab({ onTraceBatch }: { onTraceBatch: (batch: string) => void }) {
  const { state, fgStock, addFgTransfer, receiveFgTransfer, masters } = useFlow();
  const PRODUCTS = masters.products;
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [productName, setProductName] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [boxes, setBoxes] = useState("");
  const [loose, setLoose] = useState("0");

  const product = masters.productByName.get(productName);
  const qtyPerBox = product?.boxSize ?? 12;
  const totalQty = (Number(boxes) || 0) * qtyPerBox + (Number(loose) || 0);

  const received = useMemo(() => fgStock.filter((r) => r.received > 0), [fgStock]);

  /** One click, no typing: the latest issued requisition's product and batch. */
  function fillDemo() {
    const lastIssued = [...state.requisitions].reverse().find((r) => r.status === "ISSUED");
    setProductName(lastIssued?.productName || "BL-686 Blush blusher powder");
    setBatchNo(lastIssued?.batchNo || "BL686-B01");
    setBoxes("100");
    setLoose("0");
    setOpen(true);
  }

  async function save() {
    if (!product || !batchNo.trim() || totalQty <= 0) return;
    const ok = await addFgTransfer({
      date: todayLabel(),
      lines: [
        {
          productCode: product.fg,
          productName: product.name,
          sku: product.fg,
          batchNo: batchNo.trim(),
          mfgDate: todayLabel().slice(3),
          qtyPerBox,
          totalBoxes: Number(boxes) || 0,
          looseQty: Number(loose) || 0,
          totalQty,
          remark: "",
        },
      ],
      submittedBy: "Production",
      checkedBy: "",
      location: "",
    });
    if (!ok) return;
    setOpen(false);
    setProductName("");
    setBatchNo("");
    setBoxes("");
    setLoose("0");
  }

  return (
    <div className="space-y-3">
      <Card
        title="FG Transfer Details — Packing List"
        step="STEPS 14–16"
        role="Production → FG Warehouse"
        right={
          can("fg.create") ? (
            <>
              <button className="btn" onClick={fillDemo} title="Fill the form with example values">
                Enter demo data
              </button>
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
                {open ? "Close" : "New FG transfer note"}
              </button>
            </>
          ) : null
        }
      >
        {open && can("fg.create") && (
          <div className="border-b border-rule bg-zebra px-3 py-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Field label="Product">
                <select
                  className="field h-8"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  aria-label="FG product"
                >
                  <option value="">Select product…</option>
                  {PRODUCTS.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Batch no">
                <TextInput value={batchNo} onChange={setBatchNo} placeholder="LL112-B03" />
              </Field>
              <Field label="Qty per box">
                <div className="field num flex h-8 items-center justify-end text-[12.5px]">
                  {product ? fmt(qtyPerBox) : "—"}
                </div>
              </Field>
              <Field label="Total boxes">
                <TextInput value={boxes} onChange={setBoxes} numeric placeholder="100" />
              </Field>
              <Field label="Loose qty">
                <TextInput value={loose} onChange={setLoose} numeric placeholder="0" />
              </Field>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                className="btn btn-primary"
                onClick={save}
                disabled={!product || !batchNo.trim() || totalQty <= 0}
              >
                Submit transfer — total {fmt(totalQty)} pcs
              </button>
              <span className="text-[11px] text-muted">
                Qty per box comes from the product's BOM. FG warehouse signs the receiving next.
              </span>
            </div>
          </div>
        )}

        <Table
          minWidth={1050}
          headers={[
            "Transfer no",
            "Date",
            "Product code",
            "Product name",
            "SKU",
            "Batch no",
            "MFG date",
            { label: "Qty/box", align: "right" },
            { label: "Boxes", align: "right" },
            { label: "Loose", align: "right" },
            { label: "Total qty", align: "right" },
            "Submitted by",
            "Checked by (FG)",
            "Status",
            "",
          ]}
        >
          {state.fgTransfers
            .slice()
            .reverse()
            .flatMap((t, ti) =>
              t.lines.map((l, li) => (
                <Tr key={`${t.id}-${li}`} zebra={ti % 2 === 1}>
                  <Td num strong>{t.id}</Td>
                  <Td num>{t.date}</Td>
                  <Td num>{l.productCode}</Td>
                  <Td>{l.productName}</Td>
                  <Td num>{l.sku}</Td>
                  <Td num>{l.batchNo}</Td>
                  <Td num>{l.mfgDate || "—"}</Td>
                  <Td right num>{fmt(l.qtyPerBox)}</Td>
                  <Td right num>{fmt(l.totalBoxes)}</Td>
                  <Td right num>{fmt(l.looseQty)}</Td>
                  <Td right num strong>{fmt(l.totalQty)}</Td>
                  <Td muted>{t.submittedBy || "—"}</Td>
                  <Td muted>{t.checkedBy || "—"}</Td>
                  <Td>
                    {t.status === "RECEIVED" ? (
                      <Chip label="RECEIVED" tone="green" />
                    ) : (
                      <Chip label="IN TRANSIT" tone="amber" />
                    )}
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      {t.status === "IN_TRANSIT" && can("fg.receive") && (
                        <button
                          className="btn h-6 px-2 text-[11px]"
                          onClick={() => receiveFgTransfer(t.id, "FG WH — Sunil", todayLabel(), "FG Godown A")}
                        >
                          Sign receiving
                        </button>
                      )}
                      <button className="btn h-6 px-2 text-[11px]" onClick={() => onTraceBatch(l.batchNo)}>
                        Trace
                      </button>
                    </div>
                  </Td>
                </Tr>
              )),
            )}
        </Table>
        {state.fgTransfers.length === 0 && <EmptyNote>No FG transfers yet.</EmptyNote>}
      </Card>

      <Card title="FG Warehouse Stock" step="STEP 17" role="FG Warehouse">
        <Table
          minWidth={800}
          headers={[
            "Product",
            "SKU",
            "Batch no",
            "Location",
            { label: "Received", align: "right" },
            { label: "Dispatched", align: "right" },
            { label: "In stock", align: "right" },
            "PDI",
            "",
          ]}
        >
          {received.map((r, i) => (
            <Tr key={`${r.productName}-${r.batchNo}`} zebra={i % 2 === 1}>
              <Td>{r.productName}</Td>
              <Td num>{r.productCode}</Td>
              <Td num>{r.batchNo}</Td>
              <Td muted>{r.location || "—"}</Td>
              <Td right num>{fmt(r.received)}</Td>
              <Td right num>{r.dispatched > 0 ? fmt(r.dispatched) : "—"}</Td>
              <Td right num strong>{fmt(r.inStock)}</Td>
              <Td>
                {r.pdi === "PASSED" ? (
                  <Chip label="PDI OK" tone="green" />
                ) : r.pdi === "FAILED" ? (
                  <Chip label="PDI FAILED" tone="red" />
                ) : (
                  <Chip label="PDI PENDING" tone="amber" />
                )}
              </Td>
              <Td>
                <button className="btn h-6 px-2 text-[11px]" onClick={() => onTraceBatch(r.batchNo)}>
                  Trace
                </button>
              </Td>
            </Tr>
          ))}
        </Table>
        {received.length === 0 && <EmptyNote>Nothing in FG stock yet.</EmptyNote>}
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        The transfer form matches your letterheaded FG TRANSFER DETAILS — PACKING LIST (SR NO ·
        PRODUCT CODE · PRODUCT NAME · SKU · BATCH NO · MFG DATE · QTY/BOX · TOTAL BOXES · LOOSE
        QTY · TOTAL QTY · DATE · REMARK) with the Checked-by and Submitted-to sign blocks. Signing
        the receiving puts the batch into FG system stock — steps 16 and 17.
      </p>
    </div>
  );
}
