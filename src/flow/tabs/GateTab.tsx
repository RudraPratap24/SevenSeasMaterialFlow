import { useState } from "react";
import { useAuth } from "../auth";
import { useFlow, todayLabel } from "../store";
import { Card, EmptyNote, Field, Table, Td, TextInput, Tr, fmt } from "../ui";

const blank = {
  poNo: "",
  supplierName: "",
  productDesc: "",
  invoiceNo: "",
  invoiceDate: "",
  invoiceQty: "",
  transportName: "",
  lrNo: "",
  vehicleNo: "",
  timeIn: "",
};

export function GateTab() {
  const { state, poProgress, addGateEntry } = useFlow();
  const { can } = useAuth();
  const [form, setForm] = useState(blank);
  const [open, setOpen] = useState(false);
  const set = (k: keyof typeof blank) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Approved POs with material still pending — the gate person picks from these.
  const openPos = poProgress.filter(
    (p) => p.po.status === "APPROVED" && p.lines.some((l) => l.pending > 0),
  );

  function pickPo(poId: string) {
    const p = openPos.find((x) => x.po.id === poId);
    if (!p) {
      setForm((f) => ({ ...f, poNo: poId }));
      return;
    }
    setForm((f) => ({
      ...f,
      poNo: p.po.id,
      supplierName: p.po.supplierName,
      productDesc: p.lines.map((l) => l.name).join(", "),
      invoiceQty: String(p.lines.reduce((n, l) => n + l.pending, 0)),
    }));
  }

  /** One click, no typing: opens the form filled with a realistic arrival. */
  function fillDemo() {
    const po = openPos[0];
    if (po) {
      setForm({
        ...blank,
        poNo: po.po.id,
        supplierName: po.po.supplierName,
        productDesc: po.lines.map((l) => l.name).join(", "),
        invoiceNo: `CI/2026/${88 + state.gateEntries.length}`,
        invoiceDate: todayLabel(),
        invoiceQty: String(po.lines.reduce((n, l) => n + l.pending, 0)),
        transportName: "Blue Dart",
        lrNo: `LR-9${1544 + state.gateEntries.length}`,
        vehicleNo: "DL1M-4432",
        timeIn: "10:15",
      });
    } else {
      setForm({
        poNo: "",
        supplierName: "China Imports Co",
        productDesc: "BL-686 Blush blusher powder",
        invoiceNo: `CI/2026/${88 + state.gateEntries.length}`,
        invoiceDate: todayLabel(),
        invoiceQty: "2400",
        transportName: "Blue Dart",
        lrNo: `LR-9${1544 + state.gateEntries.length}`,
        vehicleNo: "DL1M-4432",
        timeIn: "10:15",
      });
    }
    setOpen(true);
  }

  async function save() {
    if (!form.supplierName.trim()) return;
    const ok = await addGateEntry({
      date: todayLabel(),
      supplierName: form.supplierName.trim(),
      productDesc: form.productDesc.trim(),
      invoiceNo: form.invoiceNo.trim(),
      invoiceDate: form.invoiceDate.trim(),
      poNo: form.poNo.trim(),
      invoiceQty: form.invoiceQty ? Number(form.invoiceQty) : null,
      transportName: form.transportName.trim(),
      lrNo: form.lrNo.trim(),
      vehicleNo: form.vehicleNo.trim(),
      timeIn: form.timeIn.trim(),
      timeOut: "",
      driverSign: false,
      remark: "",
    });
    if (!ok) return;
    setForm(blank);
    setOpen(false);
  }

  const mayCreate = can("gate.create");

  return (
    <div className="space-y-3">
      <Card
        title="Gate Entry Register"
        step="STEPS 1–2"
        role="Security / Gate"
        right={
          mayCreate ? (
            <>
              <button className="btn" onClick={fillDemo} title="Fill the form with example values">
                Enter demo data
              </button>
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
                {open ? "Close" : "New gate entry"}
              </button>
            </>
          ) : null
        }
      >
        {open && mayCreate && (
          <div className="border-b border-rule bg-zebra px-3 py-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Field label="Against PO (details fill in)">
                <select
                  className="field h-8"
                  value={openPos.some((p) => p.po.id === form.poNo) ? form.poNo : ""}
                  onChange={(e) => pickPo(e.target.value)}
                  aria-label="Against PO"
                >
                  <option value="">No PO / direct arrival</option>
                  {openPos.map((p) => (
                    <option key={p.po.id} value={p.po.id}>
                      {p.po.id} — {p.po.supplierName} ({fmt(p.lines.reduce((n, l) => n + l.pending, 0))} pcs pending)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Supplier name">
                <TextInput value={form.supplierName} onChange={set("supplierName")} placeholder="Supplier name" />
              </Field>
              <Field label="Product / material">
                <TextInput value={form.productDesc} onChange={set("productDesc")} placeholder="What is arriving" />
              </Field>
              <Field label="Invoice no">
                <TextInput value={form.invoiceNo} onChange={set("invoiceNo")} placeholder="Invoice no" />
              </Field>
              <Field label="Invoice date">
                <TextInput value={form.invoiceDate} onChange={set("invoiceDate")} placeholder="dd-mm-yyyy" />
              </Field>
              <Field label="Invoice qty">
                <TextInput value={form.invoiceQty} onChange={set("invoiceQty")} numeric placeholder="Qty" />
              </Field>
              <Field label="Transport name">
                <TextInput value={form.transportName} onChange={set("transportName")} placeholder="Transporter" />
              </Field>
              <Field label="LR no">
                <TextInput value={form.lrNo} onChange={set("lrNo")} placeholder="LR no" />
              </Field>
              <Field label="Vehicle no">
                <TextInput value={form.vehicleNo} onChange={set("vehicleNo")} placeholder="HR55-…" />
              </Field>
              <Field label="Time in">
                <TextInput value={form.timeIn} onChange={set("timeIn")} placeholder="hh:mm" />
              </Field>
            </div>
            <button className="btn btn-primary mt-3" onClick={save} disabled={!form.supplierName.trim()}>
              Save gate entry
            </button>
          </div>
        )}

        <Table
          minWidth={1150}
          headers={[
            "Gate entry no",
            "Date",
            "Supplier",
            "Product",
            "Invoice no",
            "Invoice date",
            "PO no",
            { label: "Invoice qty", align: "right" },
            "Transport",
            "LR no",
            "Vehicle no",
            "Time in",
            "Time out",
            "Driver sign",
            "Remark",
          ]}
        >
          {state.gateEntries
            .slice()
            .reverse()
            .map((e, i) => (
              <Tr key={e.id} zebra={i % 2 === 1}>
                <Td num strong>{e.id}</Td>
                <Td num>{e.date}</Td>
                <Td>{e.supplierName}</Td>
                <Td>{e.productDesc || "—"}</Td>
                <Td num>{e.invoiceNo || "—"}</Td>
                <Td num>{e.invoiceDate || "—"}</Td>
                <Td num>{e.poNo || "—"}</Td>
                <Td right num>{e.invoiceQty === null ? "—" : fmt(e.invoiceQty)}</Td>
                <Td>{e.transportName || "—"}</Td>
                <Td num>{e.lrNo || "—"}</Td>
                <Td num>{e.vehicleNo || "—"}</Td>
                <Td num>{e.timeIn || "—"}</Td>
                <Td num>{e.timeOut || "—"}</Td>
                <Td muted>{e.driverSign ? "Signed" : "—"}</Td>
                <Td muted>{e.remark || "—"}</Td>
              </Tr>
            ))}
        </Table>
        {state.gateEntries.length === 0 && <EmptyNote>No gate entries yet.</EmptyNote>}
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        Columns match your handwritten Gate Entry Register exactly. Picking an approved PO fills
        supplier and material details automatically — as answered in the questionnaire; direct
        arrivals without a PO are also allowed.
      </p>
    </div>
  );
}
