import { useMemo, useState } from "react";
import { useAuth } from "../auth";
import { todayLabel, useFlow } from "../store";
import { Card, Chip, EmptyNote, Field, Table, Td, TextInput, Tr, fmt } from "../ui";
import type { RequisitionLine } from "../types";

export function RequisitionTab() {
  const { state, addRequisition, issueRequisition, pmStock, masters } = useFlow();
  const PRODUCTS = masters.products;
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [productName, setProductName] = useState("");
  const [qty, setQty] = useState("1440");
  const [department, setDepartment] = useState("LL");
  const [batchNo, setBatchNo] = useState("");

  const stockOf = useMemo(
    () => Object.fromEntries(pmStock.map((r) => [r.code, r.closing])),
    [pmStock],
  );

  /** BOM helper: name the product + units, get the component lines pre-filled. */
  const helperLines = useMemo<RequisitionLine[]>(() => {
    const n = Number(qty) || 0;
    if (!productName || n <= 0) return [];
    return masters.bomOf(productName).map((c) => ({
      materialName: c.n,
      materialCode: c.c,
      unit: "Pcs",
      qtyRequired: Math.ceil((n * c.p) / 100 - 1e-9),
      qtyIssued: null,
      returnQty: null,
      remark: "",
    }));
  }, [productName, qty, masters]);

  /** One click, no typing: BL-686 for 1,200 units with an auto-numbered batch. */
  function fillDemo() {
    const n = state.requisitions.filter((r) => r.batchNo.startsWith("BL686-B")).length + 1;
    setProductName("BL-686 Blush blusher powder");
    setQty("1200");
    setDepartment("BL");
    setBatchNo(`BL686-B${String(n).padStart(2, "0")}`);
    setOpen(true);
  }

  async function save() {
    if (helperLines.length === 0) return;
    const ok = await addRequisition({
      date: todayLabel(),
      department: department.trim() || "—",
      productName,
      batchNo: batchNo.trim(),
      lines: helperLines,
      packingSign: "",
      storeSign: "",
    });
    if (!ok) return;
    setOpen(false);
    setProductName("");
    setBatchNo("");
  }

  return (
    <div className="space-y-3">
      <Card
        title="Raw Material / Packing Material Requisition Slip"
        step="STEPS 11–13"
        role="Production → Store"
        right={
          can("req.create") ? (
            <>
              <button className="btn" onClick={fillDemo} title="Fill the form with example values">
                Enter demo data
              </button>
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
                {open ? "Close" : "New requisition"}
              </button>
            </>
          ) : null
        }
      >
        {open && can("req.create") && (
          <div className="border-b border-rule bg-zebra px-3 py-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Field label="Product">
                <select
                  className="field h-8"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  aria-label="Product"
                >
                  <option value="">Select product…</option>
                  {PRODUCTS.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Units to pack">
                <TextInput value={qty} onChange={setQty} numeric placeholder="1440" />
              </Field>
              <Field label="Department">
                <TextInput value={department} onChange={setDepartment} placeholder="LL" />
              </Field>
              <Field label="Batch / lot no">
                <TextInput value={batchNo} onChange={setBatchNo} placeholder="LL112-B03" />
              </Field>
            </div>

            {helperLines.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-[3px] border border-rule bg-card">
                <Table
                  headers={[
                    "Material name",
                    "Material code",
                    "Unit",
                    { label: "Qty required", align: "right" },
                    { label: "In stock", align: "right" },
                  ]}
                >
                  {helperLines.map((l, i) => {
                    const stock = stockOf[l.materialCode] ?? 0;
                    const short = stock < l.qtyRequired;
                    return (
                      <Tr key={l.materialCode} zebra={i % 2 === 1}>
                        <Td>{l.materialName}</Td>
                        <Td num>{l.materialCode}</Td>
                        <Td muted>{l.unit}</Td>
                        <Td right num strong>{fmt(l.qtyRequired)}</Td>
                        <Td right num>
                          <span style={short ? { color: "var(--red)", fontWeight: 700 } : undefined}>
                            {fmt(stock)}
                          </span>
                        </Td>
                      </Tr>
                    );
                  })}
                </Table>
              </div>
            )}

            <div className="mt-3 flex items-center gap-3">
              <button className="btn btn-primary" onClick={save} disabled={helperLines.length === 0}>
                Save requisition slip
              </button>
              <span className="text-[11px] text-muted">
                Components and quantities come from the product's own BOM — the slip still shows
                every material line, same as your printed form.
              </span>
            </div>
          </div>
        )}

        <div className="divide-y divide-rule">
          {state.requisitions
            .slice()
            .reverse()
            .map((r) => (
              <RequisitionCard
                key={r.id}
                id={r.id}
                stockOf={stockOf}
                canIssue={can("req.issue")}
                onIssue={(issued, sign) => issueRequisition(r.id, issued, sign)}
              />
            ))}
        </div>
        {state.requisitions.length === 0 && <EmptyNote>No requisition slips yet.</EmptyNote>}
      </Card>

      <MrnCard />

      <p className="text-[11px] leading-relaxed text-muted">
        The form matches your printed slip — Requisition Details (DATE · REQUEST SLIP NO ·
        BATCH/LOT NO · DEPARTMENT · PRODUCT NAME) and the table MATERIAL NAME · MATERIAL CODE ·
        UNIT · QUANTITY REQUIRED · QUANTITY ISSUED · RETURN MATERIAL · REMARK, with Packing Dept
        and Store Dept signatures. Issuing deducts store stock immediately (steps 12–13).
      </p>
    </div>
  );
}

function RequisitionCard({
  id,
  stockOf,
  canIssue,
  onIssue,
}: {
  id: string;
  stockOf: Record<string, number>;
  canIssue: boolean;
  onIssue: (issued: number[], sign: string) => void;
}) {
  const { state } = useFlow();
  const r = state.requisitions.find((x) => x.id === id);
  const [drafts, setDrafts] = useState<string[] | null>(null);
  const [sign, setSign] = useState("");

  if (!r) return null;
  const issued = r.status === "ISSUED";
  const draftValues = r.lines.map((l, i) =>
    Number((drafts?.[i] ?? String(l.qtyRequired)) || 0),
  );
  // Never let more go out than is on the shelf — same rule the store enforces.
  const overIssue = !issued && draftValues.some((v, i) => v > (stockOf[r.lines[i].materialCode] ?? 0));

  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-[13px] font-bold">{r.id}</span>
        <span className="num text-[12px] text-muted">{r.date}</span>
        <Chip label={`Dept ${r.department}`} />
        {r.productName && <span className="text-[12px] font-semibold">{r.productName}</span>}
        {r.batchNo && <Chip label={`Batch ${r.batchNo}`} tone="blue" />}
        <span className="ml-auto">
          {issued ? <Chip label="ISSUED" tone="green" /> : <Chip label="PENDING" tone="amber" />}
        </span>
      </div>

      <div className="mt-2 overflow-hidden rounded-[3px] border border-rule">
        <Table
          headers={
            issued
              ? [
                  "Material name",
                  "Material code",
                  "Unit",
                  { label: "Qty required", align: "right" },
                  { label: "Qty issued", align: "right" },
                  { label: "Return", align: "right" },
                  "Remark",
                ]
              : [
                  "Material name",
                  "Material code",
                  "Unit",
                  { label: "Qty required", align: "right" },
                  { label: "In stock", align: "right" },
                  { label: "Qty issued", align: "right" },
                  { label: "Return", align: "right" },
                  "Remark",
                ]
          }
        >
          {r.lines.map((l, i) => {
            const stock = stockOf[l.materialCode] ?? 0;
            const over = !issued && draftValues[i] > stock;
            return (
              <Tr key={i} zebra={i % 2 === 1}>
                <Td>{l.materialName}</Td>
                <Td num>{l.materialCode}</Td>
                <Td muted>{l.unit}</Td>
                <Td right num strong>{fmt(l.qtyRequired)}</Td>
                {!issued && (
                  <Td right num>
                    <span style={over ? { color: "var(--red)", fontWeight: 700 } : undefined}>
                      {fmt(stock)}
                    </span>
                  </Td>
                )}
                <Td right num>
                  {issued ? (
                    fmt(l.qtyIssued ?? 0)
                  ) : (
                    <input
                      className="num field h-7 w-[90px] text-right text-[12px]"
                      style={over ? { borderColor: "var(--red)", color: "var(--red)" } : undefined}
                      value={drafts?.[i] ?? String(l.qtyRequired)}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^\d]/g, "");
                        setDrafts((d) => {
                          const base = d ?? r.lines.map((x) => String(x.qtyRequired));
                          return base.map((x, j) => (j === i ? v : x));
                        });
                      }}
                      aria-label={`Issue qty for ${l.materialCode}`}
                    />
                  )}
                </Td>
                <Td right num>{l.returnQty === null ? "—" : fmt(l.returnQty)}</Td>
                <Td muted>{l.remark || "—"}</Td>
              </Tr>
            );
          })}
        </Table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
        <span>
          Packing Dept: <b className="text-ink">{r.packingSign || "—"}</b>
        </span>
        <span>
          Store Dept: <b className="text-ink">{r.storeSign || "—"}</b>
        </span>
        {!issued && canIssue && (
          <span className="ml-auto flex items-center gap-2">
            {overIssue && (
              <span className="text-[11.5px] font-bold" style={{ color: "var(--red)" }}>
                More than store stock — reduce the red quantity.
              </span>
            )}
            <input
              className="field h-7 w-[140px] text-[12px]"
              placeholder="Store sign (name)"
              value={sign}
              onChange={(e) => setSign(e.target.value)}
              aria-label={`Store sign for ${r.id}`}
            />
            <button
              className="btn h-7 px-2 text-[11px]"
              disabled={!sign.trim() || overIssue}
              onClick={() => onIssue(draftValues, sign.trim())}
            >
              Issue material
            </button>
          </span>
        )}
      </div>
    </div>
  );
}


/** Material Return Note — leftover material back to store; stock goes back up. */
function MrnCard() {
  const { state, addMrn } = useFlow();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [reqId, setReqId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sign, setSign] = useState("");

  const issuedReqs = state.requisitions.filter((r) => r.status === "ISSUED");
  const req = issuedReqs.find((r) => r.id === reqId);

  const returnedSoFar = useMemo(() => {
    const map = new Map<string, number>();
    if (!req) return map;
    for (const m of state.mrns.filter((x) => x.requisitionId === req.id)) {
      for (const l of m.lines) map.set(l.componentCode, (map.get(l.componentCode) ?? 0) + l.qty);
    }
    return map;
  }, [req, state.mrns]);

  async function save() {
    if (!req || !sign.trim()) return;
    const lines = req.lines
      .map((l) => ({
        componentCode: l.materialCode,
        componentName: l.materialName,
        qty: Number(drafts[l.materialCode] || 0),
      }))
      .filter((l) => l.qty > 0);
    if (lines.length === 0) return;
    const ok = await addMrn({
      date: todayLabel(),
      requisitionId: req.id,
      lines,
      sign: sign.trim(),
      remark: "",
    });
    if (!ok) return;
    setOpen(false);
    setReqId("");
    setDrafts({});
    setSign("");
  }

  return (
    <Card
      title="Material Return Note (MRN)"
      step="LEFTOVER BACK TO STORE"
      role="Packing → Store"
      right={
        can("mrn.create") ? (
          <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
            {open ? "Close" : "New MRN"}
          </button>
        ) : null
      }
    >
      {open && can("mrn.create") && (
        <div className="border-b border-rule bg-zebra px-3 py-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Field label="Against issued requisition">
              <select
                className="field h-8"
                value={reqId}
                onChange={(e) => { setReqId(e.target.value); setDrafts({}); }}
                aria-label="MRN against requisition"
              >
                <option value="">Select…</option>
                {issuedReqs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} — {r.productName || r.department} ({r.batchNo || "no batch"})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Returned by (sign)">
              <TextInput value={sign} onChange={setSign} placeholder="Name" ariaLabel="MRN sign" />
            </Field>
          </div>

          {req && (
            <div className="mt-2 overflow-hidden rounded-[3px] border border-rule bg-card">
              <Table
                headers={[
                  "Material",
                  "Code",
                  { label: "Issued", align: "right" },
                  { label: "Already returned", align: "right" },
                  { label: "Return now", align: "right" },
                ]}
              >
                {req.lines.map((l, i) => {
                  const prev = returnedSoFar.get(l.materialCode) ?? 0;
                  const max = Math.max(0, (l.qtyIssued ?? 0) - prev);
                  return (
                    <Tr key={l.materialCode} zebra={i % 2 === 1}>
                      <Td>{l.materialName}</Td>
                      <Td num>{l.materialCode}</Td>
                      <Td right num>{fmt(l.qtyIssued ?? 0)}</Td>
                      <Td right num>{prev > 0 ? fmt(prev) : "—"}</Td>
                      <Td right num>
                        <input
                          className="num field h-7 w-[90px] text-right text-[12px]"
                          value={drafts[l.materialCode] ?? ""}
                          placeholder={`max ${max}`}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^\d]/g, "");
                            setDrafts((d) => ({ ...d, [l.materialCode]: v }));
                          }}
                          aria-label={`Return qty for ${l.materialCode}`}
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            </div>
          )}

          <button
            className="btn btn-primary mt-3"
            onClick={save}
            disabled={!req || !sign.trim()}
          >
            Save MRN — stock goes back up
          </button>
        </div>
      )}

      <Table
        minWidth={700}
        headers={["MRN no", "Date", "Against", "Materials returned", "Sign"]}
      >
        {state.mrns
          .slice()
          .reverse()
          .map((m, i) => (
            <Tr key={m.id} zebra={i % 2 === 1}>
              <Td num strong>{m.id}</Td>
              <Td num>{m.date}</Td>
              <Td num>{m.requisitionId}</Td>
              <Td>
                {m.lines.map((l) => `${l.componentName} × ${fmt(l.qty)}`).join(" · ")}
              </Td>
              <Td muted>{m.sign}</Td>
            </Tr>
          ))}
      </Table>
      {state.mrns.length === 0 && <EmptyNote>No returns yet.</EmptyNote>}
    </Card>
  );
}
