import { Fragment, useMemo, useState } from "react";
import { useAuth } from "../auth";
import { deriveTallyPoProgress, gatePos, nowHHMM, searchPos, type TallyPoProgress } from "../logic";
import { useFlow, useTallyStatus, todayLabel } from "../store";
import { Card, DateInput, EmptyNote, Field, Table, Td, TextInput, Tr } from "../ui";

const blank = {
  supplierName: "",
  productDesc: "",
  invoiceNo: "",
  invoiceDate: "",
  invoiceQty: "",
  transportName: "",
  lrNo: "",
  vehicleNo: "",
  timeIn: "",
  remark: "",
};

/** Tally quantities can carry decimals (Kg, Grs) — shown as on the PO, never rounded away. */
const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

/** The guard's check-in of one PO item: ticked, how much arrived, and a remark if short. */
interface Check {
  ticked: boolean;
  qty: string;
  remark: string;
}

export function GateTab() {
  const { state, addGateEntry, recordVehicleOut } = useFlow();
  const { can } = useAuth();
  // every new entry starts with today's date as the invoice date (changeable)
  const [form, setForm] = useState(() => ({ ...blank, invoiceDate: todayLabel() }));
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  /** The PO picked from the search; "" = none yet. */
  const [poNo, setPoNo] = useState("");
  /** Arrival without a PO (e.g. free material) — supplier and material typed in. */
  const [direct, setDirect] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  /** Driver-sign ticks on vehicles still inside, sent with "Vehicle out". */
  const [signed, setSigned] = useState<Record<string, boolean>>({});
  const set = (k: keyof typeof blank) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const mayCreate = can("gate.create");

  const openPos = useMemo(
    () => deriveTallyPoProgress(gatePos(state), state.gateEntries, state.grnLines).filter((p) => p.open),
    [state],
  );
  const picked = openPos.find((p) => p.po.poNo === poNo);
  const lastSync = useTallyStatus()?.syncedAt;

  // PO number, supplier name, item name or PMS code — any part of it, any case.
  const term = search.trim().toLowerCase();
  const results = term ? searchPos(openPos, term) : [];

  function pick(p: TallyPoProgress) {
    setPoNo(p.po.poNo);
    setDirect(false);
    setSearch("");
    setChecks(
      Object.fromEntries(
        p.lines.filter((l) => l.pending > 0).map((l) => [l.itemName, { ticked: false, qty: String(l.pending), remark: "" }]),
      ),
    );
  }

  function changePo() {
    setPoNo("");
    setChecks({});
  }

  const setCheck = (item: string, patch: Partial<Check>) =>
    setChecks((c) => ({ ...c, [item]: { ...c[item], ...patch } }));

  const ticked = Object.entries(checks).filter(([, c]) => c.ticked);
  const itemsOk = ticked.length > 0 && ticked.every(([, c]) => Number(c.qty) > 0);
  const complete =
    Boolean(form.vehicleNo.trim() && form.timeIn.trim()) &&
    (picked ? itemsOk : direct && Boolean(form.supplierName.trim() && form.productDesc.trim()));

  function toggleForm() {
    if (!open && !form.timeIn) setForm((f) => ({ ...f, timeIn: nowHHMM() }));
    setOpen(!open);
  }

  /** One click, no typing: the first open PO with every pending item ticked as fully arrived. */
  function fillDemo() {
    const p = openPos[0];
    if (p) pick(p);
    if (p) setChecks((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, ticked: true }])));
    else setDirect(true);
    setForm({
      ...blank,
      supplierName: p ? "" : "China Imports Co",
      productDesc: p ? "" : "BL-686 Blush blusher powder",
      invoiceNo: `CI/2026/${88 + state.gateEntries.length}`,
      invoiceDate: todayLabel(),
      invoiceQty: p ? "" : "2400",
      transportName: "Blue Dart",
      lrNo: `LR-9${1544 + state.gateEntries.length}`,
      vehicleNo: "DL1M-4432",
      timeIn: nowHHMM(),
    });
    setOpen(true);
  }

  async function vehicleOut(id: string, driverSign: boolean) {
    if (await recordVehicleOut(id, signed[id] ?? driverSign, nowHHMM())) {
      setSigned(({ [id]: _, ...rest }) => rest);
    }
  }

  async function save() {
    if (!complete) return;
    const ok = await addGateEntry({
      date: todayLabel(),
      supplierName: picked ? picked.po.supplierName : form.supplierName.trim(),
      productDesc: picked ? "" : form.productDesc.trim(),
      invoiceNo: form.invoiceNo.trim(),
      invoiceDate: form.invoiceDate.trim(),
      poNo: picked ? picked.po.poNo : "",
      invoiceQty: !picked && form.invoiceQty ? Number(form.invoiceQty) : null,
      transportName: form.transportName.trim(),
      lrNo: form.lrNo.trim(),
      vehicleNo: form.vehicleNo.trim(),
      timeIn: form.timeIn.trim(),
      timeOut: "",
      driverSign: false,
      remark: form.remark.trim(),
      lines: picked
        ? ticked.map(([itemName, c]) => ({ itemName, itemCode: "", unit: "", qty: Number(c.qty), remark: c.remark.trim() }))
        : [],
    });
    if (!ok) return;
    setForm({ ...blank, invoiceDate: todayLabel() });
    changePo();
    setDirect(false);
    setOpen(false);
  }

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
              <button className={`btn ${open ? "" : "btn-primary"}`} onClick={toggleForm}>
                {open ? "Close" : "Vehicle in"}
              </button>
            </>
          ) : null
        }
      >
        {open && mayCreate && (
          <div className="space-y-3 border-b border-rule bg-zebra px-3 py-3">
            {/* 1 — which PO the vehicle brings */}
            {!picked && !direct && (
              <div>
                <Field label="Find the PO — PO number, supplier, item name or PMS code">
                  <input
                    className="field h-8 w-full"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="e.g. 26SEV231, Shree Packwell, APF CAP, PMS0002"
                    autoFocus
                  />
                </Field>
                <p className="mt-1 text-[11px] text-muted">
                  {openPos.length} open PO{openPos.length === 1 ? "" : "s"}
                  {lastSync ? ` · list updated ${lastSync}` : ""}.{" "}
                  <button className="underline" onClick={() => setDirect(true)}>
                    No PO (free material / direct arrival)
                  </button>
                </p>
                {term && (
                  <div className="mt-2 max-h-72 overflow-y-auto rounded border border-rule bg-white">
                    {results.length === 0 && <EmptyNote>No open PO matches "{search.trim()}".</EmptyNote>}
                    {results.slice(0, 30).map((p) => (
                      <button
                        key={p.po.poNo}
                        className="block w-full border-b border-rule px-3 py-2 text-left last:border-b-0 hover:bg-zebra"
                        onClick={() => pick(p)}
                      >
                        <span className="num font-semibold">{p.po.poNo}</span> · {p.po.supplierName} ·{" "}
                        <span className="num">{p.po.date}</span>
                        <span className="block text-[11px] text-muted">
                          {p.lines
                            .filter((l) => l.pending > 0)
                            .map((l) => `${l.itemName} (${qty(l.pending)} ${l.unit} pending)`)
                            .join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 2 — the PO's items, one row each: tick what arrived */}
            {picked && (
              <div>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span>
                    PO <span className="num font-semibold">{picked.po.poNo}</span> · {picked.po.supplierName} · dated{" "}
                    <span className="num">{picked.po.date}</span>
                  </span>
                  <button className="btn h-7 px-2 text-[11px]" onClick={changePo}>
                    Change PO
                  </button>
                </div>
                <div className="mt-2 rounded border border-rule bg-white">
                  <Table
                    minWidth={900}
                    headers={[
                      "Arrived",
                      "Code",
                      "Item",
                      "Unit",
                      { label: "PO qty", align: "right" },
                      { label: "Received earlier", align: "right" },
                      { label: "Pending", align: "right" },
                      { label: "Qty received now", align: "right" },
                      "Remark (if short)",
                    ]}
                  >
                    {picked.lines.map((l, i) => {
                      const c = checks[l.itemName];
                      return (
                        <Tr key={l.itemName} zebra={i % 2 === 1}>
                          <Td>
                            {c ? (
                              <input
                                type="checkbox"
                                checked={c.ticked}
                                onChange={(e) => setCheck(l.itemName, { ticked: e.target.checked })}
                                aria-label={`${l.itemName} arrived`}
                              />
                            ) : (
                              <span className="text-[11px] text-muted">Done</span>
                            )}
                          </Td>
                          <Td num>{l.itemCode || "—"}</Td>
                          <Td>{l.itemName}</Td>
                          <Td>{l.unit}</Td>
                          <Td right num>{qty(l.qty)}</Td>
                          <Td right num>{qty(l.received)}</Td>
                          <Td right num strong>{qty(l.pending)}</Td>
                          <Td right>
                            {c?.ticked && Number(c.qty) > l.pending && (
                              <span className="mb-1 block text-[10.5px] font-semibold" style={{ color: "var(--red)" }}>
                                Only {qty(l.pending)} {l.unit} pending — the extra goes back with the vehicle
                              </span>
                            )}
                            {c?.ticked ? (
                              <input
                                className="field num h-7 w-24 text-right"
                                inputMode="decimal"
                                value={c.qty}
                                onChange={(e) => setCheck(l.itemName, { qty: e.target.value.replace(/[^\d.]/g, "") })}
                                aria-label={`Quantity of ${l.itemName} received`}
                              />
                            ) : (
                              "—"
                            )}
                          </Td>
                          <Td>
                            {c?.ticked ? (
                              <input
                                className="field h-7 w-48"
                                value={c.remark}
                                onChange={(e) => setCheck(l.itemName, { remark: e.target.value })}
                                placeholder={Number(c.qty) < l.pending ? "e.g. 20 short" : "Optional"}
                                aria-label={`Remark for ${l.itemName}`}
                              />
                            ) : (
                              ""
                            )}
                          </Td>
                        </Tr>
                      );
                    })}
                  </Table>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  Tick each item on the invoice that has arrived. Anything not ticked, or received short, stays open
                  on the PO until it comes.
                </p>
              </div>
            )}

            {direct && (
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span>No PO — direct arrival</span>
                <button className="btn h-7 px-2 text-[11px]" onClick={() => setDirect(false)}>
                  Search a PO instead
                </button>
              </div>
            )}

            {/* 3 — the vehicle and the invoice */}
            {(picked || direct) && (
              <>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                  {direct && (
                    <>
                      <Field label="Supplier name *">
                        <TextInput value={form.supplierName} onChange={set("supplierName")} placeholder="Supplier name" />
                      </Field>
                      <Field label="Product / material *">
                        <TextInput value={form.productDesc} onChange={set("productDesc")} placeholder="What is arriving" />
                      </Field>
                      <Field label="Invoice qty">
                        <TextInput value={form.invoiceQty} onChange={set("invoiceQty")} numeric placeholder="Qty" />
                      </Field>
                    </>
                  )}
                  <Field label="Invoice no">
                    <TextInput value={form.invoiceNo} onChange={set("invoiceNo")} placeholder="Invoice no" />
                  </Field>
                  <Field label="Invoice date">
                    <DateInput value={form.invoiceDate} onChange={set("invoiceDate")} />
                  </Field>
                  <Field label="Transport name">
                    <TextInput value={form.transportName} onChange={set("transportName")} placeholder="Transporter" />
                  </Field>
                  <Field label="LR no">
                    <TextInput value={form.lrNo} onChange={set("lrNo")} placeholder="LR no" />
                  </Field>
                  <Field label="Vehicle no *">
                    <TextInput value={form.vehicleNo} onChange={set("vehicleNo")} placeholder="HR55-…" />
                  </Field>
                  <Field label="Time in *">
                    <TextInput value={form.timeIn} onChange={set("timeIn")} placeholder="hh:mm" />
                  </Field>
                  <Field label="Remark">
                    <TextInput value={form.remark} onChange={set("remark")} placeholder="Optional" />
                  </Field>
                </div>
                <div>
                  <button className="btn btn-primary" onClick={save} disabled={!complete}>
                    Save — vehicle in
                  </button>
                  <span className="ml-3 text-[11px] text-muted">
                    * required{picked ? ", and at least one item ticked" : ""}. Time out and driver sign are recorded
                    when the vehicle leaves.
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        <Table
          minWidth={1300}
          headers={[
            "Gate entry no",
            "Date",
            "Product",
            "Product code",
            "Supplier",
            "Invoice no",
            "Invoice date",
            "PO no",
            { label: "Qty", align: "right" },
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
            .map((e, i) => {
              // One register row per item checked in; a direct arrival is a single row.
              const rows = e.lines.length
                ? e.lines.map((l) => ({ name: l.itemName, code: l.itemCode, q: `${qty(l.qty)} ${l.unit}`, remark: l.remark }))
                : [{ name: e.productDesc, code: "", q: e.invoiceQty === null ? "" : qty(e.invoiceQty), remark: "" }];
              return (
                <Fragment key={e.id}>
                  {rows.map((r, j) => (
                    <Tr key={j} zebra={i % 2 === 1}>
                      <Td num strong>{e.id}</Td>
                      <Td num>{e.date}</Td>
                      <Td>{r.name || "—"}</Td>
                      <Td num>{r.code || "—"}</Td>
                      <Td>{e.supplierName}</Td>
                      <Td num>{e.invoiceNo || "—"}</Td>
                      <Td num>{e.invoiceDate || "—"}</Td>
                      <Td num>{e.poNo || "—"}</Td>
                      <Td right num>{r.q || "—"}</Td>
                      <Td>{e.transportName || "—"}</Td>
                      <Td num>{e.lrNo || "—"}</Td>
                      <Td num>{e.vehicleNo || "—"}</Td>
                      <Td num>{e.timeIn || "—"}</Td>
                      <Td num>
                        {e.timeOut ||
                          (j > 0 ? (
                            ""
                          ) : mayCreate ? (
                            <button className="btn h-7 px-2 text-[11px]" onClick={() => vehicleOut(e.id, e.driverSign)}>
                              Vehicle out
                            </button>
                          ) : (
                            "Inside"
                          ))}
                      </Td>
                      <Td muted>
                        {j > 0 ? (
                          ""
                        ) : e.driverSign || e.timeOut || !mayCreate ? (
                          e.driverSign ? "Signed" : "—"
                        ) : (
                          <label className="flex cursor-pointer items-center gap-1 text-[11px]">
                            <input
                              type="checkbox"
                              checked={signed[e.id] ?? false}
                              onChange={(ev) => setSigned((m) => ({ ...m, [e.id]: ev.target.checked }))}
                              aria-label={`Driver signed for ${e.id}`}
                            />
                            Signed
                          </label>
                        )}
                      </Td>
                      <Td muted>{[r.remark, j === 0 ? e.remark : ""].filter(Boolean).join(" · ") || "—"}</Td>
                    </Tr>
                  ))}
                </Fragment>
              );
            })}
        </Table>
        {state.gateEntries.length === 0 && <EmptyNote>No gate entries yet.</EmptyNote>}
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        Columns match your handwritten Gate Entry Register, one row per item. The list holds every open, approved
        purchase order. Search by PO number, or by supplier when the vendor has not attached the PO. When the vehicle leaves, tick the driver's sign and press "Vehicle out" — the time is taken
        from the server clock.
      </p>
    </div>
  );
}

