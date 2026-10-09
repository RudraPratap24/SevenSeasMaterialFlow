import { useState } from "react";
import { useAuth } from "../auth";
import { todayLabel, useFlow } from "../store";
import { Card, Chip, EmptyNote, Field, Table, Td, TextInput, Tr, fmt } from "../ui";

export function PurchaseTab() {
  const { shortList, state, poProgress, suppliers, addIndent, approvePo, masters } = useFlow();
  const { can, user } = useAuth();

  return (
    <div className="space-y-3">
      <Card title="Below minimum level — buy list" step="SHORT LIST" role="Purchase">
        <Table
          minWidth={800}
          headers={[
            "Code",
            "Component",
            { label: "Minimum level", align: "right" },
            { label: "In stock", align: "right" },
            { label: "Short by", align: "right" },
            "",
          ]}
        >
          {shortList.map((r, i) => {
            const hasIndent = state.indents.some(
              (x) => x.componentCode === r.code && x.status === "OPEN",
            );
            const hasPo = poProgress.some(
              (p) => !p.closed && p.lines.some((l) => l.code === r.code && l.pending > 0),
            );
            return (
              <Tr key={r.code} zebra={i % 2 === 1}>
                <Td num muted>{r.code}</Td>
                <Td>{r.name}</Td>
                <Td right num>{fmt(r.minLevel ?? 0)}</Td>
                <Td right num>{fmt(r.closing)}</Td>
                <Td right num strong>
                  <span style={{ color: "var(--amber)" }}>{fmt((r.minLevel ?? 0) - r.closing)}</span>
                </Td>
                <Td>
                  {hasPo ? (
                    <Chip label="PO RAISED" tone="blue" />
                  ) : hasIndent ? (
                    <Chip label="INDENT OPEN" tone="amber" />
                  ) : can("purchase.indent") ? (
                    <button
                      className="btn h-6 px-2 text-[11px]"
                      onClick={() =>
                        addIndent({
                          date: todayLabel(),
                          componentCode: r.code,
                          componentName: r.name,
                          qty: Math.max(0, (r.minLevel ?? 0) * 2 - r.closing),
                          reason: "Below minimum level",
                        })
                      }
                    >
                      Create indent
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted">—</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </Table>
        {shortList.length === 0 && (
          <EmptyNote>
            Nothing below minimum level. Minimum levels come with your data (demo data loads
            example levels); an indent can always be made manually from the Indents card.
          </EmptyNote>
        )}
      </Card>

      <Card
        title="Indents"
        step="PURCHASE REQUEST"
        role="Purchase"
        right={can("purchase.indent") ? <ManualIndentButton /> : null}
      >
        <div className="divide-y divide-rule">
          {state.indents
            .slice()
            .reverse()
            .map((ind) => (
              <IndentRow key={ind.id} id={ind.id} />
            ))}
        </div>
        {state.indents.length === 0 && <EmptyNote>No indents yet.</EmptyNote>}
      </Card>

      <Card title="Purchase orders" step="PO · OTIF" role="Purchase · Owner approves">
        <div className="divide-y divide-rule">
          {poProgress
            .slice()
            .reverse()
            .map((p) => (
              <div key={p.po.id} className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num text-[13px] font-bold">{p.po.id}</span>
                  <span className="num text-[12px] text-muted">{p.po.date}</span>
                  <span className="text-[12.5px] font-semibold">{p.po.supplierName}</span>
                  {p.po.expectedDate && (
                    <span className="num text-[11.5px] text-muted">expected {p.po.expectedDate}</span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    {p.value !== null && (
                      <span className="num text-[11.5px] text-muted">
                        ₹{p.value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </span>
                    )}
                    {p.closed ? (
                      <Chip label="CLOSED — FULLY RECEIVED" tone="green" />
                    ) : p.po.status === "APPROVED" ? (
                      <Chip label={`APPROVED — ${p.po.approvedBy}`} tone="blue" />
                    ) : (
                      <Chip label="PENDING APPROVAL" tone="amber" />
                    )}
                  </span>
                </div>
                <div className="mt-2 overflow-hidden rounded-[3px] border border-rule">
                  <Table
                    headers={[
                      "Component",
                      "Code",
                      { label: "Rate", align: "right" },
                      { label: "Ordered", align: "right" },
                      { label: "Received", align: "right" },
                      { label: "Pending", align: "right" },
                    ]}
                  >
                    {p.lines.map((l, i) => (
                      <Tr key={l.code} zebra={i % 2 === 1}>
                        <Td>{l.name}</Td>
                        <Td num>{l.code}</Td>
                        <Td right num>{l.rate === null ? "—" : `₹${l.rate}`}</Td>
                        <Td right num>{fmt(l.qty)}</Td>
                        <Td right num>{l.received > 0 ? fmt(l.received) : "—"}</Td>
                        <Td right num strong>
                          {l.pending > 0 ? (
                            <span style={{ color: "var(--amber)" }}>{fmt(l.pending)}</span>
                          ) : (
                            "—"
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </Table>
                </div>
                {p.po.status === "PENDING_APPROVAL" && can("purchase.approve") && (
                  <button
                    className="btn mt-2 h-7 px-2 text-[11px]"
                    style={{ borderColor: "var(--green)", color: "var(--green)" }}
                    onClick={() => approvePo(p.po.id, user?.label ?? "Owner")}
                  >
                    Approve PO
                  </button>
                )}
                {p.po.status === "PENDING_APPROVAL" && !can("purchase.approve") && (
                  <p className="mt-2 text-[11.5px] text-muted">
                    Waiting for the owner's approval — management approves every PO.
                  </p>
                )}
              </div>
            ))}
        </div>
        {poProgress.length === 0 && <EmptyNote>No purchase orders yet.</EmptyNote>}
      </Card>

      <Card title="Approved suppliers — price master" role="Fixed rates">
        <Table
          minWidth={600}
          headers={["Supplier", "City", "Materials with fixed rate"]}
        >
          {suppliers.map((s, i) => (
            <Tr key={s.name} zebra={i % 2 === 1}>
              <Td strong>{s.name}</Td>
              <Td muted>{s.city}</Td>
              <Td muted>
                {Object.entries(s.rates)
                  .map(([code, rate]) => `${masters.componentByCode.get(code)?.name ?? code} @ ₹${rate}`)
                  .join(" · ")}
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        The chain follows your answers: minimum level → indent → purchase raises the PO →
        management approves → gate picks the PO on arrival → GRN receipts reduce the pending
        quantity, PO closes when fully received (OTIF). Rates come from the fixed price master.
        Minimum levels shown are demo values until your real list arrives.
      </p>
    </div>
  );
}

function IndentRow({ id }: { id: string }) {
  const { state, suppliers, raisePo } = useFlow();
  const { can } = useAuth();
  const ind = state.indents.find((x) => x.id === id);
  const [open, setOpen] = useState(false);
  const [supplierName, setSupplierName] = useState("");
  const [qty, setQty] = useState("");
  const [rate, setRate] = useState("");
  const [expected, setExpected] = useState("");

  if (!ind) return null;

  const suggested = suppliers.filter((s) => ind.componentCode in s.rates);
  const supplierList = suggested.length > 0 ? suggested : suppliers;

  function openForm() {
    const first = supplierList[0];
    setSupplierName(first?.name ?? "");
    setQty(String(ind!.qty));
    setRate(first && ind!.componentCode in first.rates ? String(first.rates[ind!.componentCode]) : "");
    setExpected("");
    setOpen(true);
  }

  function pickSupplier(name: string) {
    setSupplierName(name);
    const s = suppliers.find((x) => x.name === name);
    if (s && ind!.componentCode in s.rates) setRate(String(s.rates[ind!.componentCode]));
  }

  async function save() {
    if (!supplierName || !(Number(qty) > 0)) return;
    const ok = await raisePo({
      date: todayLabel(),
      supplierName,
      lines: [
        {
          componentCode: ind!.componentCode,
          componentName: ind!.componentName,
          qty: Number(qty),
          rate: rate ? Number(rate) : null,
        },
      ],
      expectedDate: expected.trim(),
      indentIds: [ind!.id],
    });
    if (!ok) return;
    setOpen(false);
  }

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-[12.5px] font-bold">{ind.id}</span>
        <span className="num text-[11.5px] text-muted">{ind.date}</span>
        <span className="text-[12.5px]">{ind.componentName}</span>
        <span className="num text-[12.5px] font-bold">{fmt(ind.qty)} pcs</span>
        <span className="text-[11.5px] text-muted">{ind.reason}</span>
        <span className="ml-auto flex items-center gap-2">
          {ind.status === "PO_RAISED" ? (
            <Chip label="PO RAISED" tone="blue" />
          ) : can("purchase.po") ? (
            <button className="btn h-6 px-2 text-[11px]" onClick={() => (open ? setOpen(false) : openForm())}>
              {open ? "Close" : "Raise PO"}
            </button>
          ) : (
            <Chip label="OPEN" tone="amber" />
          )}
        </span>
      </div>

      {open && ind.status === "OPEN" && (
        <div className="mt-2 rounded-[3px] border border-rule bg-zebra px-3 py-2.5">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Field label="Supplier">
              <select
                className="field h-8"
                value={supplierName}
                onChange={(e) => pickSupplier(e.target.value)}
                aria-label={`Supplier for ${ind.id}`}
              >
                {supplierList.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Qty">
              <TextInput value={qty} onChange={setQty} numeric ariaLabel={`PO qty for ${ind.id}`} />
            </Field>
            <Field label="Rate (from price master)">
              <TextInput value={rate} onChange={setRate} numeric ariaLabel={`Rate for ${ind.id}`} placeholder="₹" />
            </Field>
            <Field label="Expected date">
              <TextInput value={expected} onChange={setExpected} placeholder="dd-mm-yyyy" ariaLabel={`Expected date for ${ind.id}`} />
            </Field>
          </div>
          <button className="btn btn-primary mt-2 h-7 px-3 text-[11.5px]" onClick={save} disabled={!supplierName || !(Number(qty) > 0)}>
            Raise PO — goes for approval
          </button>
        </div>
      )}
    </div>
  );
}


/** Manual indent — for materials without a minimum level, or a from-zero demo. */
function ManualIndentButton() {
  const { addIndent, masters } = useFlow();
  const COMPONENTS = masters.components;
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("");

  const comp = masters.componentByCode.get(code.trim().toUpperCase());

  async function save() {
    if (!comp || !(Number(qty) > 0)) return;
    const ok = await addIndent({
      date: todayLabel(),
      componentCode: comp.code,
      componentName: comp.name,
      qty: Number(qty),
      reason: "Manual indent",
    });
    if (!ok) return;
    setOpen(false);
    setCode("");
    setQty("");
  }

  return (
    <span className="flex items-center gap-2">
      {open && (
        <>
          <input
            className="field h-8 w-[130px] text-[12px]"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="PMS0014"
            aria-label="Indent component code"
            list="indent-codes"
          />
          <datalist id="indent-codes">
            {COMPONENTS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </datalist>
          <span className="max-w-[180px] truncate text-[11px] text-muted">
            {comp ? comp.name : "Type a PMS code"}
          </span>
          <input
            className="num field h-8 w-[90px] text-right text-[12px]"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="Qty"
            aria-label="Indent qty"
          />
          <button className="btn btn-primary h-8" onClick={save} disabled={!comp || !(Number(qty) > 0)}>
            Save indent
          </button>
        </>
      )}
      <button className="btn h-8" onClick={() => setOpen(!open)}>
        {open ? "Close" : "New indent"}
      </button>
    </span>
  );
}
