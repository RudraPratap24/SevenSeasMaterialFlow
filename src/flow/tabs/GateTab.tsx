import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiUpload } from "../api";
import { useAuth } from "../auth";
import { CameraCapture, PhotoViewer, type Photo } from "../Camera";
import { nowHHMM } from "../logic";
import { useFlow, todayLabel } from "../store";
import { Card, Chip, DateInput, EmptyNote, Field, SearchPicker, Table, Td, TextInput, Tr } from "../ui";

const UNITS = ["Box", "Kg", "Other"] as const;

const blank = () => ({
  supplierName: "",
  invoiceNo: "",
  invoiceDate: todayLabel(),
  invoiceQty: "",
  unit: "Box" as (typeof UNITS)[number],
  otherUnit: "",
  transportName: "",
  lrNo: "",
  vehicleNo: "",
  driverName: "",
  driverPhone: "",
});

const PHONE = /^(\+?\d{10,13})?$/;
const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

/**
 * The gate register: the guard records the vehicle and the paper it carries, with one photo — no PO (Store reads
 * the invoice and picks the PO at GRN). Number, date and time in are the server's; time out at "Vehicle out".
 */
export function GateTab() {
  const { state, addGateEntry, recordVehicleOut, reload } = useFlow();
  const { can, user } = useAuth();
  const mayCreate = can("gate.create");
  const [form, setForm] = useState(blank);
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null);
  /** The camera is open: for the new entry ("new") or to add the missing photo of a saved one. */
  const [camera, setCamera] = useState<"new" | string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState("");
  const [vendors, setVendors] = useState<string[]>([]);
  /** The GRNs Store made for each gate entry: one or more closes it. */
  const grnsOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const g of state.grnLines) m.set(g.gateEntryId, [...(m.get(g.gateEntryId) ?? []), g.grnNo]);
    return m;
  }, [state.grnLines]);
  /** Driver-sign ticks on vehicles still inside, sent with "Vehicle out". */
  const [signed, setSigned] = useState<Record<string, boolean>>({});
  /** The photo of the entry just saved, sent as soon as that entry shows in the register (after the save's refresh). */
  const waiting = useRef<{ photo: Photo; before: Set<string>; vehicleNo: string; supplierName: string } | null>(null);
  const set = (k: keyof ReturnType<typeof blank>) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!mayCreate) return;
    api<{ vendors: string[] }>("GET", "/vendors")
      .then((r) => setVendors(r.vendors))
      .catch(() => undefined);
  }, [mayCreate]);

  const unit = form.unit === "Other" ? form.otherUnit.trim() : form.unit;
  const vendorOk = vendors.includes(form.supplierName);
  const phoneOk = PHONE.test(form.driverPhone.trim());
  const qtyOk = !form.invoiceQty || (Number(form.invoiceQty) > 0 && unit !== "");
  const complete = vendorOk && Boolean(form.vehicleNo.trim()) && phoneOk && qtyOk && photo !== null;

  async function upload(id: string, p: Photo): Promise<boolean> {
    try {
      await apiUpload(`/gate-entries/${encodeURIComponent(id)}/photo`, p.blob);
      setPhotoError("");
      return true;
    } catch (e) {
      setPhotoError(`${id} is saved, but its photo was not: ${e instanceof Error ? e.message : "upload failed"} — press "Add photo" on its row.`);
      return false;
    } finally {
      await reload();
    }
  }

  useEffect(() => {
    const w = waiting.current;
    if (!w) return;
    const made = state.gateEntries.find((g) => !w.before.has(g.id) && g.vehicleNo === w.vehicleNo && g.supplierName === w.supplierName);
    if (!made) return;
    waiting.current = null;
    if (!made.hasPhoto) void upload(made.id, w.photo);
  }, [state.gateEntries]);

  async function save() {
    if (!complete || !photo) return;
    const before = new Set(state.gateEntries.map((g) => g.id));
    waiting.current = null;
    const vehicleNo = form.vehicleNo.trim().toUpperCase();
    const ok = await addGateEntry({
      supplierName: form.supplierName,
      invoiceNo: form.invoiceNo.trim().toUpperCase(),
      invoiceDate: form.invoiceDate,
      invoiceQty: form.invoiceQty ? Number(form.invoiceQty) : null,
      invoiceQtyUnit: form.invoiceQty ? unit : "",
      transportName: form.transportName.trim(),
      lrNo: form.lrNo.trim().toUpperCase(),
      vehicleNo,
      driverName: form.driverName.trim(),
      driverPhone: form.driverPhone.trim(),
    });
    if (!ok) return;
    waiting.current = { photo, before, vehicleNo, supplierName: form.supplierName };
    setForm(blank());
    setPhoto(null);
    setOpen(false);
  }

  async function vehicleOut(id: string, driverSign: boolean) {
    if (await recordVehicleOut(id, signed[id] ?? driverSign, nowHHMM())) {
      setSigned(({ [id]: _, ...rest }) => rest);
    }
  }

  return (
    <div className="space-y-3">
      <Card
        title="Gate Entry Register"
        step="STEPS 1–2"
        role="Security / Gate"
        right={
          mayCreate ? (
            <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
              {open ? "Close" : "Vehicle in"}
            </button>
          ) : null
        }
      >
        {open && mayCreate && (
          <div className="space-y-3 border-b border-rule bg-zebra px-3 py-3">
            <p className="text-[12px] text-muted">
              Gate entry no <b className="text-ink">given on save</b> · Date <b className="num text-ink">{todayLabel()}</b> · Time in
              is taken when you save · Guard <b className="text-ink">{user?.name || user?.label || "—"}</b> ({user?.username})
            </p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Field label="Supplier *">
                <SearchPicker
                  className="field h-8 w-full"
                  value={form.supplierName}
                  onChange={set("supplierName")}
                  placeholder="Type to search the vendor"
                  minWidth={320}
                  ariaLabel="Supplier"
                  options={vendors.map((v) => ({ value: v }))}
                />
              </Field>
              <Field label="Invoice no">
                <TextInput caps value={form.invoiceNo} onChange={set("invoiceNo")} placeholder="Invoice no" />
              </Field>
              <Field label="Invoice date">
                <DateInput value={form.invoiceDate} onChange={set("invoiceDate")} />
              </Field>
              <Field label="Qty">
                <span className="flex gap-1">
                  <input
                    className="field num h-8 w-24 text-right"
                    inputMode="decimal"
                    value={form.invoiceQty}
                    onChange={(e) => set("invoiceQty")(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder="0"
                    aria-label="Quantity"
                  />
                  <select className="field h-8" value={form.unit} onChange={(e) => set("unit")(e.target.value)} aria-label="Unit">
                    {UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u === "Other" ? "Other…" : u}
                      </option>
                    ))}
                  </select>
                  {form.unit === "Other" && (
                    <input
                      className="field h-8 w-24"
                      value={form.otherUnit}
                      onChange={(e) => set("otherUnit")(e.target.value)}
                      placeholder="e.g. Drum"
                      aria-label="Unit"
                    />
                  )}
                </span>
              </Field>
              <Field label="Transport">
                <TextInput value={form.transportName} onChange={set("transportName")} placeholder="Transporter" />
              </Field>
              <Field label="LR no">
                <TextInput caps value={form.lrNo} onChange={set("lrNo")} placeholder="LR no" />
              </Field>
              <Field label="Vehicle no *">
                <TextInput caps value={form.vehicleNo} onChange={set("vehicleNo")} placeholder="HR55-…" />
              </Field>
              <Field label="Driver name">
                <TextInput value={form.driverName} onChange={set("driverName")} placeholder="Driver name" />
              </Field>
              <Field label="Driver phone">
                <input
                  className="field num h-8 w-full"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={14}
                  value={form.driverPhone}
                  onChange={(e) => set("driverPhone")(e.target.value.replace(/[^\d+]/g, ""))}
                  placeholder="10-digit mobile"
                />
              </Field>
              <Field label="Photo *">
                <span className="flex items-center gap-2">
                  {photo && <img src={photo.preview} alt="Gate photo to be saved" className="h-12 w-16 rounded border border-rule object-cover" />}
                  <button className="btn h-8" onClick={() => setCamera("new")}>
                    {photo ? "Retake photo" : "📷 Take photo"}
                  </button>
                </span>
              </Field>
            </div>
            {form.driverPhone && !phoneOk && (
              <p className="text-[11.5px] font-semibold" style={{ color: "var(--red)" }}>
                Driver phone must be a 10-digit number.
              </p>
            )}
            {form.supplierName && !vendorOk && (
              <p className="text-[11.5px] font-semibold" style={{ color: "var(--red)" }}>
                Pick the supplier from the list.
              </p>
            )}
            <div>
              <button className="btn btn-primary" onClick={() => void save()} disabled={!complete}>
                Create gate entry
              </button>
              <span className="ml-3 text-[11px] text-muted">
                * required. Time out and the driver's sign are recorded when the vehicle leaves.
              </span>
            </div>
          </div>
        )}

        {photoError && (
          <p className="border-b border-rule px-3 py-2 text-[12px] font-semibold" style={{ color: "var(--red)", background: "var(--red-soft)" }} role="alert">
            {photoError}
          </p>
        )}

        <Table
          minWidth={1350}
          headers={[
            "Gate entry no",
            "Date",
            "Supplier",
            "Invoice no",
            "Invoice date",
            { label: "Qty", align: "right" },
            "Transport",
            "LR no",
            "Vehicle no",
            "Driver",
            "Time in",
            "Time out",
            "Guard",
            "Driver sign",
            "Photo",
            "GRN",
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
                <Td num>{e.invoiceNo || "—"}</Td>
                <Td num>{e.invoiceDate || "—"}</Td>
                <Td right num>
                  {e.invoiceQty !== null ? (
                    `${qty(e.invoiceQty)} ${e.invoiceQtyUnit}`.trim()
                  ) : e.lines.length ? (
                    // an entry from before the gate became manual: the items it checked in against its PO
                    <span className="block text-[11.5px] leading-snug" title={`Checked in against PO ${e.poNo} (before the gate became manual)`}>
                      {e.lines.map((l, k) => (
                        <span key={k} className="block">
                          {qty(l.qty)} {l.unit} <span className="text-muted">{l.itemName}</span>
                        </span>
                      ))}
                      <span className="block text-muted">PO {e.poNo}</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{e.transportName || "—"}</Td>
                <Td num>{e.lrNo || "—"}</Td>
                <Td num>{e.vehicleNo || "—"}</Td>
                <Td>{[e.driverName, e.driverPhone].filter(Boolean).join(" · ") || "—"}</Td>
                <Td num>{e.timeIn || "—"}</Td>
                <Td num>
                  {e.timeOut ||
                    (mayCreate ? (
                      <button className="btn h-7 px-2 text-[11px]" onClick={() => void vehicleOut(e.id, e.driverSign)}>
                        Vehicle out
                      </button>
                    ) : (
                      "Inside"
                    ))}
                </Td>
                <Td>
                  {e.guard || "—"}
                  {e.guardLogin && <span className="block text-[11px] text-muted">{e.guardLogin}</span>}
                </Td>
                <Td muted>
                  {e.driverSign || e.timeOut || !mayCreate ? (
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
                <Td>
                  {e.hasPhoto ? (
                    <button className="btn h-7 px-2 text-[11px]" onClick={() => setViewing(e.id)}>
                      📷 View
                    </button>
                  ) : mayCreate && e.lines.length === 0 && !e.poNo ? (
                    <button className="btn h-7 px-2 text-[11px]" style={{ color: "var(--red)" }} onClick={() => setCamera(e.id)}>
                      Add photo
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted">—</span>
                  )}
                </Td>
                <Td>
                  {grnsOf.get(e.id)?.length ? (
                    <span title={grnsOf.get(e.id)!.join(", ")}>
                      <Chip label={`CLOSED · ${grnsOf.get(e.id)!.length} GRN`} tone="green" />
                    </span>
                  ) : (
                    <Chip label="OPEN · WAITING FOR GRN" tone="amber" />
                  )}
                </Td>
              </Tr>
            ))}
        </Table>
        {state.gateEntries.length === 0 && <EmptyNote>No gate entries yet.</EmptyNote>}
      </Card>

      <p className="text-[11px] leading-relaxed text-muted">
        The guard records the vehicle and its invoice as it arrives, with a photo. Store reads the invoice and picks the PO
        when it makes the GRN. Time in is taken when the entry is saved; when the vehicle leaves, tick the driver's sign
        and press "Vehicle out" — both times come from the server clock.
      </p>

      {camera && (
        <CameraCapture
          title={camera === "new" ? "Photo of the vehicle / material" : `Photo for ${camera}`}
          onCancel={() => setCamera(null)}
          onDone={(p) => {
            const target = camera;
            setCamera(null);
            if (target === "new") setPhoto(p);
            else void upload(target, p);
          }}
        />
      )}
      {viewing && <PhotoViewer gateEntryId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
