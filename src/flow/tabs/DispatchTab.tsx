import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { CUSTOMER_ROLES } from "../perms";
import { useAuth } from "../auth";
import { todayLabel, useFlow } from "../store";
import { Card, Chip, EmptyNote, Field, Table, Td, TextInput, Tr, fmt } from "../ui";

export function DispatchTab() {
  return (
    <div className="space-y-3">
      <OrdersCard />
      <SlipsCard />
      <CustomersCard />

      <p className="text-[11px] leading-relaxed text-muted">
        The slip matches your handwritten Dispatch Packing Slip. A work order stays open until
        fully dispatched; a batch must pass PDI before it can go out; Accounts adds the invoice;
        security verifies invoice + packing slip before the vehicle leaves. Gate out needs both.
      </p>
    </div>
  );
}

function OrdersCard() {
    const { state, fgStock, orderProgress, addOrder, masters } = useFlow();
    const PRODUCTS = masters.products;
    const { can } = useAuth();
    const [open, setOpen] = useState(false);
    const [partyName, setPartyName] = useState("");
    const [partyAddress, setPartyAddress] = useState("");
    const [custPoNo, setCustPoNo] = useState("");
    const [productName, setProductName] = useState("");
    const [qty, setQty] = useState("");
    const [deliveryDate, setDeliveryDate] = useState("");

    function fillDemo() {
      setPartyName("Meera Cosmetics");
      setPartyAddress("Karol Bagh, New Delhi");
      setCustPoNo(`MC/${120 + state.orders.length}`);
      setProductName(fgStock.find((r) => r.inStock > 0)?.productName ?? PRODUCTS[0].name);
      setQty("600");
      setDeliveryDate("");
      setOpen(true);
    }

    async function save() {
      const p = PRODUCTS.find((x) => x.name === productName);
      if (!p || !(Number(qty) > 0) || !partyName.trim()) return;
      const ok = await addOrder({
        date: todayLabel(),
        partyName: partyName.trim(),
        partyAddress: partyAddress.trim(),
        custPoNo: custPoNo.trim(),
        deliveryDate: deliveryDate.trim(),
        lines: [{ productName: p.name, productCode: p.fg, qty: Number(qty) }],
        remark: "",
      });
      if (!ok) return;
      setOpen(false);
      setPartyName("");
      setPartyAddress("");
      setCustPoNo("");
      setProductName("");
      setQty("");
    }

    return (
      <Card
        title="Customer work orders"
        step="STEP 18"
        role="CRM / FG Warehouse"
        right={
          can("order.create") ? (
            <>
              <button className="btn" onClick={fillDemo} title="Fill the form with example values">
                Enter demo data
              </button>
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
                {open ? "Close" : "New order"}
              </button>
            </>
          ) : null
        }
      >
        {open && can("order.create") && (
          <div className="border-b border-rule bg-zebra px-3 py-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
              <Field label="Party name">
                <TextInput value={partyName} onChange={setPartyName} placeholder="Customer name" />
              </Field>
              <Field label="Party address">
                <TextInput value={partyAddress} onChange={setPartyAddress} placeholder="City" />
              </Field>
              <Field label="Customer PO no">
                <TextInput value={custPoNo} onChange={setCustPoNo} placeholder="Their PO" />
              </Field>
              <Field label="Product">
                <select
                  className="field h-8"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  aria-label="Order product"
                >
                  <option value="">Select product…</option>
                  {PRODUCTS.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Qty (pcs)">
                <TextInput value={qty} onChange={setQty} numeric placeholder="600" />
              </Field>
              <Field label="Delivery date">
                <TextInput value={deliveryDate} onChange={setDeliveryDate} placeholder="dd-mm-yyyy" />
              </Field>
            </div>
            <button
              className="btn btn-primary mt-3"
              onClick={save}
              disabled={!partyName.trim() || !productName || !(Number(qty) > 0)}
            >
              Save order
            </button>
          </div>
        )}

        <Table
          minWidth={950}
          headers={[
            "Order no",
            "Date",
            "Party",
            "Cust. PO",
            "Product",
            { label: "Ordered", align: "right" },
            { label: "Dispatched", align: "right" },
            { label: "Balance", align: "right" },
            "Delivery",
            "Status",
          ]}
        >
          {orderProgress
            .slice()
            .reverse()
            .flatMap((op, oi) =>
              op.lines.map((l, li) => (
                <Tr key={`${op.order.id}-${li}`} zebra={oi % 2 === 1}>
                  <Td num strong>{op.order.id}</Td>
                  <Td num>{op.order.date}</Td>
                  <Td>{op.order.partyName}</Td>
                  <Td num>{op.order.custPoNo || "—"}</Td>
                  <Td>{l.productName}</Td>
                  <Td right num>{fmt(l.qty)}</Td>
                  <Td right num>{l.dispatched > 0 ? fmt(l.dispatched) : "—"}</Td>
                  <Td right num strong>
                    {l.balance > 0 ? (
                      <span style={{ color: "var(--amber)" }}>{fmt(l.balance)}</span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td num>{op.order.deliveryDate || "—"}</Td>
                  <Td>
                    {op.open ? <Chip label="OPEN" tone="amber" /> : <Chip label="COMPLETE" tone="green" />}
                  </Td>
                </Tr>
              )),
            )}
        </Table>
        {state.orders.length === 0 && <EmptyNote>No customer orders yet.</EmptyNote>}
      </Card>
    );
}

function SlipsCard() {
    const { state, fgStock, orderProgress, addDispatch, addInvoice, gateOut } = useFlow();
    const { can } = useAuth();
    const [open, setOpen] = useState(false);
    const [orderId, setOrderId] = useState("");
    const [partyName, setPartyName] = useState("");
    const [partyAddress, setPartyAddress] = useState("");
    const [batchKey, setBatchKey] = useState("");
    const [boxes, setBoxes] = useState("");

    // Only PDI-passed batches with stock can be dispatched.
    const available = useMemo(
      () => fgStock.filter((r) => r.inStock > 0 && r.pdi === "PASSED"),
      [fgStock],
    );
    const notPassed = useMemo(
      () => fgStock.filter((r) => r.inStock > 0 && r.pdi !== "PASSED"),
      [fgStock],
    );
    const chosen = available.find((r) => `${r.productName}::${r.batchNo}` === batchKey);

    const transferLine = useMemo(() => {
      if (!chosen) return null;
      for (const t of state.fgTransfers) {
        for (const l of t.lines) {
          if (l.productName === chosen.productName && l.batchNo === chosen.batchNo) return l;
        }
      }
      return null;
    }, [chosen, state.fgTransfers]);

    const qtyPerBox = transferLine?.qtyPerBox ?? 12;
    const totalQty = (Number(boxes) || 0) * qtyPerBox;
    const exceeds = chosen ? totalQty > chosen.inStock : false;

    const openOrders = orderProgress.filter((o) => o.open);

    function pickOrder(id: string) {
      setOrderId(id);
      const op = openOrders.find((o) => o.order.id === id);
      if (!op) return;
      setPartyName(op.order.partyName);
      setPartyAddress(op.order.partyAddress);
      const line = op.lines.find((l) => l.balance > 0);
      if (line) {
        const batch = available.find((r) => r.productName === line.productName);
        if (batch) {
          setBatchKey(`${batch.productName}::${batch.batchNo}`);
          let perBox = 12;
          for (const t of state.fgTransfers) {
            for (const l of t.lines) {
              if (l.productName === batch.productName && l.batchNo === batch.batchNo) perBox = l.qtyPerBox;
            }
          }
          setBoxes(String(Math.max(1, Math.floor(Math.min(line.balance, batch.inStock) / perBox))));
        }
      }
    }

    function fillDemo() {
      const op = openOrders[0];
      if (op) {
        pickOrder(op.order.id);
      } else {
        const first = available[0];
        if (!first) return;
        setPartyName("Meera Cosmetics");
        setPartyAddress("Karol Bagh, New Delhi");
        setBatchKey(`${first.productName}::${first.batchNo}`);
        let perBox = 12;
        for (const t of state.fgTransfers) {
          for (const l of t.lines) {
            if (l.productName === first.productName && l.batchNo === first.batchNo) perBox = l.qtyPerBox;
          }
        }
        setBoxes(String(Math.max(1, Math.min(50, Math.floor(first.inStock / perBox)))));
      }
      setOpen(true);
    }

    async function save() {
      if (!chosen || totalQty <= 0 || exceeds || !partyName.trim()) return;
      const ok = await addDispatch({
        date: todayLabel(),
        orderId,
        partyName: partyName.trim(),
        partyAddress: partyAddress.trim(),
        lines: [
          {
            productName: chosen.productName,
            productCode: chosen.productCode,
            batchNo: chosen.batchNo,
            qtyPerBox,
            totalBoxes: Number(boxes) || 0,
            totalQty,
          },
        ],
        dispatchSign: "FG WH",
        remark: "",
      });
      if (!ok) return;
      setOpen(false);
      setOrderId("");
      setPartyName("");
      setPartyAddress("");
      setBatchKey("");
      setBoxes("");
    }

    return (
      <Card
        title="Dispatch Packing Slip"
        step="STEPS 19–22"
        role="FG Warehouse · Accounts · Security"
        right={
          can("dispatch.create") ? (
            <>
              <button
                className="btn"
                onClick={fillDemo}
                disabled={available.length === 0}
                title={
                  available.length === 0
                    ? "No PDI-passed batch in FG stock"
                    : "Fill the form with example values"
                }
              >
                Enter demo data
              </button>
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
                {open ? "Close" : "New dispatch"}
              </button>
            </>
          ) : null
        }
      >
        {open && can("dispatch.create") && (
          <div className="border-b border-rule bg-zebra px-3 py-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Field label="Against order (optional)">
                <select
                  className="field h-8"
                  value={orderId}
                  onChange={(e) => pickOrder(e.target.value)}
                  aria-label="Against order"
                >
                  <option value="">No order — direct</option>
                  {openOrders.map((o) => (
                    <option key={o.order.id} value={o.order.id}>
                      {o.order.id} — {o.order.partyName} (bal {fmt(o.lines.reduce((n, l) => n + l.balance, 0))})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Party name">
                <TextInput value={partyName} onChange={setPartyName} placeholder="Customer name" />
              </Field>
              <Field label="Party address">
                <TextInput value={partyAddress} onChange={setPartyAddress} placeholder="City" />
              </Field>
              <Field label="Product · batch (PDI passed)">
                <select
                  className="field h-8"
                  value={batchKey}
                  onChange={(e) => setBatchKey(e.target.value)}
                  aria-label="Product and batch"
                >
                  <option value="">Select…</option>
                  {available.map((r) => (
                    <option key={`${r.productName}::${r.batchNo}`} value={`${r.productName}::${r.batchNo}`}>
                      {r.productName} · {r.batchNo} ({fmt(r.inStock)} in stock)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Boxes (× ${fmt(qtyPerBox)}/box)`}>
                <TextInput value={boxes} onChange={setBoxes} numeric placeholder="40" />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                className="btn btn-primary"
                onClick={save}
                disabled={!chosen || totalQty <= 0 || exceeds || !partyName.trim()}
              >
                Create dispatch slip — {fmt(totalQty)} pcs
              </button>
              {exceeds && chosen && (
                <span className="text-[12px] font-bold" style={{ color: "var(--red)" }}>
                  Only {fmt(chosen.inStock)} pcs in stock for this batch.
                </span>
              )}
              {notPassed.length > 0 && (
                <span className="text-[11px] text-muted">
                  {notPassed.length} batch{notPassed.length === 1 ? "" : "es"} in stock waiting for
                  PDI — not listed until QC passes them.
                </span>
              )}
            </div>
          </div>
        )}

        <div className="divide-y divide-rule">
          {state.dispatchSlips
            .slice()
            .reverse()
            .map((d) => (
              <div key={d.id} className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num text-[13px] font-bold">{d.id}</span>
                  <span className="num text-[12px] text-muted">{d.date}</span>
                  <span className="text-[12.5px] font-semibold">{d.partyName}</span>
                  <span className="text-[11.5px] text-muted">{d.partyAddress}</span>
                  {d.orderId && <Chip label={`Order ${d.orderId}`} />}
                  <span className="ml-auto flex items-center gap-1.5">
                    {d.invoiceNo ? (
                      <Chip label={`Invoice ${d.invoiceNo}`} tone="green" />
                    ) : (
                      <Chip label="Awaiting invoice" tone="amber" />
                    )}
                    {d.gateOut ? (
                      <Chip label={`Gate out ${d.gateOutTime}`} tone="green" />
                    ) : (
                      <Chip label="In factory" tone="blue" />
                    )}
                  </span>
                </div>

                <div className="mt-2 overflow-hidden rounded-[3px] border border-rule">
                  <Table
                    headers={[
                      "Product name",
                      "Product code",
                      "Batch",
                      { label: "Qty in one box", align: "right" },
                      { label: "Total box", align: "right" },
                      { label: "Total qty", align: "right" },
                    ]}
                  >
                    {d.lines.map((l, i) => (
                      <Tr key={i} zebra={i % 2 === 1}>
                        <Td>{l.productName}</Td>
                        <Td num>{l.productCode}</Td>
                        <Td num>{l.batchNo}</Td>
                        <Td right num>{fmt(l.qtyPerBox)}</Td>
                        <Td right num>{fmt(l.totalBoxes)}</Td>
                        <Td right num strong>{fmt(l.totalQty)}</Td>
                      </Tr>
                    ))}
                  </Table>
                </div>

                <DispatchActions
                  id={d.id}
                  hasInvoice={!!d.invoiceNo}
                  gateOutDone={d.gateOut}
                  dispatchSign={d.dispatchSign}
                  securitySign={d.securitySign}
                  mayInvoice={can("invoice.add")}
                  mayGateOut={can("gateout")}
                  onInvoice={(no) => addInvoice(d.id, no, todayLabel())}
                  onGateOut={(sign) => {
                    const now = new Date();
                    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                    gateOut(d.id, sign, hhmm);
                  }}
                />
              </div>
            ))}
        </div>
        {state.dispatchSlips.length === 0 && <EmptyNote>No dispatches yet.</EmptyNote>}
      </Card>
    );
}

function DispatchActions({
  id,
  hasInvoice,
  gateOutDone,
  dispatchSign,
  securitySign,
  mayInvoice,
  mayGateOut,
  onInvoice,
  onGateOut,
}: {
  id: string;
  hasInvoice: boolean;
  gateOutDone: boolean;
  dispatchSign: string;
  securitySign: string;
  mayInvoice: boolean;
  mayGateOut: boolean;
  onInvoice: (no: string) => void;
  onGateOut: (sign: string) => void;
}) {
  const [invoiceNo, setInvoiceNo] = useState("");
  const [sign, setSign] = useState("");

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
      <span>
        Dispatch sign: <b className="text-ink">{dispatchSign || "—"}</b>
      </span>
      <span>
        Security sign: <b className="text-ink">{securitySign || "—"}</b>
      </span>

      {!hasInvoice && mayInvoice && (
        <span className="ml-auto flex items-center gap-2">
          <input
            className="field h-7 w-[180px] text-[12px]"
            placeholder="Invoice no (Accounts)"
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            aria-label={`Invoice no for ${id}`}
          />
          <button
            className="btn h-7 px-2 text-[11px]"
            disabled={!invoiceNo.trim()}
            onClick={() => onInvoice(invoiceNo.trim())}
          >
            Record invoice
          </button>
        </span>
      )}
      {!hasInvoice && !mayInvoice && (
        <span className="ml-auto text-[11px]">Waiting for Accounts to add the invoice.</span>
      )}

      {hasInvoice && !gateOutDone && mayGateOut && (
        <span className="ml-auto flex items-center gap-2">
          <input
            className="field h-7 w-[160px] text-[12px]"
            placeholder="Security sign (name)"
            value={sign}
            onChange={(e) => setSign(e.target.value)}
            aria-label={`Security sign for ${id}`}
          />
          <button
            className="btn h-7 px-2 text-[11px]"
            disabled={!sign.trim()}
            onClick={() => onGateOut(sign.trim())}
          >
            Verify &amp; gate out
          </button>
        </span>
      )}
      {hasInvoice && !gateOutDone && !mayGateOut && (
        <span className="ml-auto text-[11px]">Waiting for security to verify and gate out.</span>
      )}
    </div>
  );
}

interface Customer {
  id: number;
  name: string;
  address: string;
  orders: number;
  dispatches: number;
  version: string;
}

/**
 * Customer master. One record per customer: correcting a name or address here
 * changes it on every order and dispatch slip at once.
 */
function CustomersCard() {
  const { user, can } = useAuth();
  const { reload } = useFlow();
  const [list, setList] = useState<Customer[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const mayEdit = can("customer.edit");
  const maySee = !!user && CUSTOMER_ROLES.includes(user.role);

  const load = useCallback(async () => {
    try {
      setList((await api<{ customers: Customer[] }>("GET", "/customers")).customers);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load customers.");
    }
  }, []);

  useEffect(() => {
    if (maySee) void load();
  }, [maySee, load]);

  if (!maySee) return null;

  function start(c: Customer) {
    setEditing(c);
    setName(c.name);
    setAddress(c.address);
    setError("");
  }

  async function save() {
    if (!editing || !name.trim()) return;
    setSaving(true);
    try {
      const r = await api<{ customers: Customer[] }>("POST", `/customers/${editing.id}`, {
        name: name.trim(),
        address: address.trim(),
        version: editing.version,
      });
      setList(r.customers);
      setEditing(null);
      await reload(); // orders and slips show the new details straight away
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save.");
      if (e instanceof ApiError && e.status === 409) void load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Customers" step="MASTER" role={mayEdit ? "Accounts · Admin edit" : "View"}>
      {error && (
        <p className="border-b border-rule px-3 py-2 text-[12px] font-bold" style={{ color: "var(--red)" }} role="alert">
          {error}
        </p>
      )}
      <Table
        minWidth={700}
        headers={[
          "Party name",
          "Address",
          { label: "Orders", align: "right" },
          { label: "Dispatches", align: "right" },
          ...(mayEdit ? [""] : []),
        ]}
      >
        {(list ?? []).map((c, i) =>
          editing?.id === c.id ? (
            <Tr key={c.id} zebra={i % 2 === 1}>
              <Td>
                <input className="field h-7 text-[12px]" value={name} onChange={(e) => setName(e.target.value)}
                  aria-label="Party name" maxLength={120} autoFocus />
              </Td>
              <Td>
                <input className="field h-7 text-[12px]" value={address} onChange={(e) => setAddress(e.target.value)}
                  aria-label="Party address" maxLength={300} />
              </Td>
              <Td right num>{fmt(c.orders)}</Td>
              <Td right num>{fmt(c.dispatches)}</Td>
              <Td>
                <div className="flex gap-1">
                  <button className="btn btn-primary h-7 px-2 text-[11px]" onClick={() => void save()}
                    disabled={saving || !name.trim()}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => setEditing(null)} disabled={saving}>
                    Cancel
                  </button>
                </div>
              </Td>
            </Tr>
          ) : (
            <Tr key={c.id} zebra={i % 2 === 1}>
              <Td strong>{c.name}</Td>
              <Td muted>{c.address || "—"}</Td>
              <Td right num>{fmt(c.orders)}</Td>
              <Td right num>{fmt(c.dispatches)}</Td>
              {mayEdit && (
                <Td>
                  <button className="btn h-6 px-2 text-[11px]" onClick={() => start(c)} disabled={editing !== null}>
                    Edit
                  </button>
                </Td>
              )}
            </Tr>
          ),
        )}
      </Table>
      {list !== null && list.length === 0 && (
        <EmptyNote>No customers yet — the first order or dispatch to a party creates it.</EmptyNote>
      )}
      <p className="border-t border-rule px-3 py-2 text-[11px] text-muted">
        One record per customer. A corrected name or address shows on every order and dispatch slip
        at once; two people editing the same customer cannot overwrite each other.
      </p>
    </Card>
  );
}
