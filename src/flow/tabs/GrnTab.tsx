import { useMemo, useState } from "react";
import { useAuth } from "../auth";
import { PhotoViewer } from "../Camera";
import {
  GRN_TOLERANCE,
  awaitingGrn,
  deriveTallyPoProgress,
  gatePos,
  grnVariance,
  isPcs,
  searchPos,
  type AwaitingGrn,
  type TallyPoProgress,
} from "../logic";
import { todayLabel, useFlow } from "../store";
import type { GateEntry, GrnLine } from "../types";
import { Card, Chip, EmptyNote, Field, SearchPicker, StatusChip, Table, Td, Tr, fmt, fmtQty } from "../ui";

interface Draft {
  code: string;
  perBox: string;
  boxes: string;
  total: string;
  remark: string;
}

const EMPTY: Draft = { code: "", perBox: "", boxes: "", total: "", remark: "" };
const TOL = `${Math.round(GRN_TOLERANCE * 100)}%`;

/** Counted in boxes (qty in 1 box × boxes) or as a total — Kg and Doz items usually as a total. */
const countOf = (d: Draft) => (d.perBox && d.boxes ? Number(d.perBox) * Number(d.boxes) : Number(d.total) || 0);

/** How Store's count stands against what was pending on the PO item (±20%). */
function VarianceChip({ variance, closes }: { variance: GrnLine["variance"]; closes: boolean }) {
  if (variance === "SHORT") return <Chip label={`SHORT >${TOL} · escalation`} tone="amber" />;
  if (variance === "EXCESS") return <Chip label={`EXCESS >${TOL} · escalation`} tone="red" />;
  return closes ? <Chip label={`Within ±${TOL} · item complete`} tone="green" /> : <span className="text-[11px] text-muted">—</span>;
}

export function GrnTab({ onTrace }: { onTrace: (grnNo: string) => void }) {
  const { state, addGrnLine, sendToQc, setBarcoded, updateGrnQty, masters } = useFlow();
  const COMPONENTS = masters.components;
  const { can } = useAuth();
  const mayCreate = can("grn.create");
  const [open, setOpen] = useState(false);
  const [gateSearch, setGateSearch] = useState("");
  const [gateId, setGateId] = useState("");
  const [poSearch, setPoSearch] = useState("");
  const [poNo, setPoNo] = useState("");
  /** Free material / an arrival without a PO: one row, no tolerance. */
  const [noPo, setNoPo] = useState(false);
  /** Store's count per PO item name ("" = the no-PO row; "GE-0006:2" = an older gate-checked item). */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const intimatedGrns = useMemo(() => new Set(state.qcIntimations.map((q) => q.grnNo)), [state.qcIntimations]);
  const grnsOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of state.grnLines) m.set(g.gateEntryId, (m.get(g.gateEntryId) ?? 0) + 1);
    return m;
  }, [state.grnLines]);

  /** The PMS code Store used before for a PO item that has none of its own. */
  const remembered = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of state.grnLines) {
      if (g.poItemName) m.set(g.poItemName, g.componentCode);
      const line = g.gateLineNo === null ? undefined : state.gateEntries.find((e) => e.id === g.gateEntryId)?.lines[g.gateLineNo - 1];
      if (line) m.set(line.itemName, g.componentCode);
    }
    return m;
  }, [state.grnLines, state.gateEntries]);

  const draftOf = (key: string, fallback: Partial<Draft> = {}): Draft => drafts[key] ?? { ...EMPTY, ...fallback };
  const setDraft = (key: string, base: Draft, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [key]: { ...base, ...patch } }));

  // 1 — the vehicle: gate entries of the manual gate, newest first (older ones with PO items are below)
  // 1 — the vehicle: open gate entries only, i.e. no GRN made for them yet (a GRN closes the entry)
  const gates = useMemo(() => {
    const t = gateSearch.trim().toLowerCase();
    return state.gateEntries
      .filter((g) => !grnsOf.get(g.id) && g.lines.length === 0 && !g.poNo)
      .filter((g) => !t || [g.id, g.supplierName, g.invoiceNo, g.vehicleNo].some((f) => f.toLowerCase().includes(t)))
      .slice()
      .reverse();
  }, [state.gateEntries, gateSearch, grnsOf]);
  const gate = state.gateEntries.find((g) => g.id === gateId);

  // 2 — the PO, as Store reads it from the invoice: PO number, company or item; the vehicle's vendor first
  const openPos = useMemo(
    () => deriveTallyPoProgress(gatePos(state), state.gateEntries, state.grnLines).filter((p) => p.open),
    [state],
  );
  const poResults = useMemo(() => {
    const found = searchPos(openPos, poSearch);
    const mine = (p: TallyPoProgress) => (gate && p.po.supplierName === gate.supplierName ? 0 : 1);
    return found.slice().sort((a, b) => mine(a) - mine(b));
  }, [openPos, poSearch, gate]);
  const picked = openPos.find((p) => p.po.poNo === poNo);
  const pickedDone = poNo !== "" && !picked; // just completed by the GRNs made

  function pickGate(g: GateEntry) {
    setGateId(g.id);
    setPoNo("");
    setNoPo(false);
    setPoSearch("");
    setDrafts({});
  }

  /** One GRN per counted item, made one after the other; stops at the first the server refuses. */
  async function saveAll(rows: { key: string; poItemName: string; draft: Draft }[]) {
    if (!gate || saving) return;
    setSaving(true);
    try {
      for (const r of rows) {
        const comp = masters.componentByCode.get(r.draft.code.trim().toUpperCase());
        const total = countOf(r.draft);
        if (!comp || total <= 0) continue;
        const inBoxes = Boolean(r.draft.perBox && r.draft.boxes);
        const ok = await addGrnLine({
          gateEntryId: gate.id,
          gateLineNo: null,
          componentCode: comp.code,
          componentName: comp.name,
          type: comp.type,
          brandName: "SEVEN SEAS",
          receivedDate: todayLabel(),
          poNo: r.poItemName ? poNo : "",
          poItemName: r.poItemName,
          poQty: null,
          location: "Store — Floor 1",
          invoiceNo: gate.invoiceNo,
          supplierName: gate.supplierName,
          qtyPerBox: inBoxes ? Number(r.draft.perBox) : null,
          totalBoxes: inBoxes ? Number(r.draft.boxes) : null,
          totalQty: total,
          unit: "",
          remarkStore: r.draft.remark.trim(),
        });
        if (!ok) return;
        setDrafts(({ [r.key]: _, ...rest }) => rest);
      }
      setNoPo(false);
    } finally {
      setSaving(false);
    }
  }

  const poRows = picked
    ? picked.lines
        .filter((l) => l.pending > 0)
        .map((l) => ({ line: l, draft: draftOf(l.itemName, { code: l.itemCode || remembered.get(l.itemName) || "" }) }))
    : [];
  const counted = poRows.filter((r) => countOf(r.draft) > 0);
  const poReady = counted.length > 0 && counted.every((r) => masters.componentByCode.has(r.draft.code.trim().toUpperCase()));
  const free = draftOf("");
  const freeReady = countOf(free) > 0 && masters.componentByCode.has(free.code.trim().toUpperCase());

  const legacy = useMemo(() => awaitingGrn(state.gateEntries, state.grnLines).filter((w) => w.line !== null), [state.gateEntries, state.grnLines]);

  return (
    <div className="space-y-3">
      <Card
        title="GRN Register — Goods Received Note"
        step="STEPS 3–5"
        role="Store"
        right={
          mayCreate ? (
            <button className={`btn ${open ? "" : "btn-primary"}`} onClick={() => setOpen(!open)}>
              {open ? "Close" : "New GRN"}
            </button>
          ) : null
        }
      >
        {open && mayCreate && (
          <div className="space-y-3 border-b border-rule bg-zebra px-3 py-3">
            {/* 1 — which vehicle */}
            {!gate ? (
              <div>
                <Field label={`1 · The vehicle — ${gates.length} open gate entr${gates.length === 1 ? "y" : "ies"} (no GRN yet); search by gate entry no, supplier, invoice or vehicle no`}>
                  <input
                    className="field h-8 w-full"
                    value={gateSearch}
                    onChange={(e) => setGateSearch(e.target.value)}
                    placeholder="e.g. GE-0012, Aplay, INV-884, HR55"
                    autoFocus
                  />
                </Field>
                <div className="mt-2 max-h-72 overflow-y-auto rounded border border-rule bg-white">
                  {gates.length === 0 && (
                    <EmptyNote>{gateSearch.trim() ? "No open gate entry matches." : "No open gate entry — every vehicle has its GRN."}</EmptyNote>
                  )}
                  {gates.map((g) => (
                    <button
                      key={g.id}
                      className="block w-full border-b border-rule px-3 py-2 text-left last:border-b-0 hover:bg-zebra"
                      onClick={() => pickGate(g)}
                    >
                      <span className="num font-semibold">{g.id}</span> · <span className="num">{g.date}</span> · {g.supplierName}
                      <span className="block text-[11px] text-muted">
                        Invoice {g.invoiceNo || "—"} · {g.invoiceQty !== null ? `${fmtQty(g.invoiceQty)} ${g.invoiceQtyUnit}` : "qty —"} · {g.vehicleNo}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span>
                  Vehicle <span className="num font-semibold">{gate.id}</span> · {gate.supplierName} · invoice{" "}
                  <span className="num">{gate.invoiceNo || "—"}</span> ·{" "}
                  {gate.invoiceQty !== null ? `${fmtQty(gate.invoiceQty)} ${gate.invoiceQtyUnit}` : "qty —"} · {gate.vehicleNo}
                </span>
                {gate.hasPhoto && (
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => setViewing(gate.id)}>
                    📷 Photo
                  </button>
                )}
                <button className="btn h-7 px-2 text-[11px]" onClick={() => setGateId("")}>
                  Pick other gate entry
                </button>
              </div>
            )}

            {/* 2 — which PO (read from the invoice) */}
            {gate && !picked && !noPo && (
              <div>
                {pickedDone && (
                  <p className="mb-2 text-[12px] font-semibold" style={{ color: "var(--green)" }}>
                    PO {poNo} is now complete.
                  </p>
                )}
                <Field label="2 · The PO on the invoice — PO number, company name or item">
                  <input
                    className="field h-8 w-full"
                    value={poSearch}
                    onChange={(e) => setPoSearch(e.target.value)}
                    placeholder="e.g. 26SEV1269, 20 Microns, NP-303, PMS0052"
                  />
                </Field>
                <p className="mt-1 text-[11px] text-muted">
                  {openPos.length} open PO{openPos.length === 1 ? "" : "s"}; POs of {gate.supplierName} first.{" "}
                  <button className="underline" onClick={() => setNoPo(true)}>
                    No PO (free material)
                  </button>
                </p>
                {poSearch.trim() && (
                  <div className="mt-2 max-h-72 overflow-y-auto rounded border border-rule bg-white">
                    {poResults.length === 0 && <EmptyNote>No open PO matches "{poSearch.trim()}".</EmptyNote>}
                    {poResults.slice(0, 30).map((p) => (
                      <button
                        key={p.po.poNo}
                        className="block w-full border-b border-rule px-3 py-2 text-left last:border-b-0 hover:bg-zebra"
                        onClick={() => {
                          setPoNo(p.po.poNo);
                          setDrafts({});
                        }}
                      >
                        <span className="num font-semibold">{p.po.poNo}</span> · {p.po.supplierName} · <span className="num">{p.po.date}</span>
                        <span className="block text-[11px] text-muted">
                          {p.lines
                            .filter((l) => l.pending > 0)
                            .map((l) => `${l.itemName} (${fmtQty(l.pending, l.unit)} ${l.unit} pending)`)
                            .join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 3 — count each item of the PO */}
            {gate && picked && (
              <div>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span>
                    PO <span className="num font-semibold">{picked.po.poNo}</span> · {picked.po.supplierName} · dated{" "}
                    <span className="num">{picked.po.date}</span>
                  </span>
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => setPoNo("")}>
                    Change PO
                  </button>
                </div>
                <div className="mt-2 rounded border border-rule bg-white">
                  <Table
                    minWidth={1250}
                    headers={[
                      "PMS code",
                      "Item",
                      { label: "Ordered", align: "right" },
                      { label: "Received earlier", align: "right" },
                      { label: "Pending", align: "right" },
                      { label: "Qty in 1 box", align: "right" },
                      { label: "Boxes", align: "right" },
                      { label: "Received now", align: "right" },
                      `Result (±${TOL})`,
                      "Remark",
                    ]}
                  >
                    {poRows.map(({ line: l, draft: d }, i) => {
                      const total = countOf(d);
                      const judged = total > 0 ? grnVariance(l.pending, total) : null;
                      const inBoxes = Boolean(d.perBox && d.boxes);
                      return (
                        <Tr key={l.itemName} zebra={i % 2 === 1}>
                          <Td>
                            {l.itemCode ? (
                              <span className="num">{l.itemCode}</span>
                            ) : (
                              <SearchPicker
                                className="field num h-7 w-24"
                                value={d.code}
                                onChange={(v) => setDraft(l.itemName, d, { code: v })}
                                placeholder="PMS…"
                                minWidth={320}
                                ariaLabel={`PMS code for ${l.itemName}`}
                                options={COMPONENTS.map((c) => ({ value: c.code, hint: c.name }))}
                              />
                            )}
                          </Td>
                          <Td>{l.itemName}</Td>
                          <Td right num>{fmtQty(l.qty, l.unit)} {l.unit}</Td>
                          <Td right num>{fmtQty(l.received, l.unit)}</Td>
                          <Td right num strong>{fmtQty(l.pending, l.unit)}</Td>
                          <Td right>
                            <input
                              className="field num h-7 w-20 text-right"
                              inputMode="numeric"
                              value={d.perBox}
                              onChange={(e) => setDraft(l.itemName, d, { perBox: e.target.value.replace(/[^\d]/g, "") })}
                              aria-label={`Qty in 1 box of ${l.itemName}`}
                            />
                          </Td>
                          <Td right>
                            <input
                              className="field num h-7 w-16 text-right"
                              inputMode="numeric"
                              value={d.boxes}
                              onChange={(e) => setDraft(l.itemName, d, { boxes: e.target.value.replace(/[^\d]/g, "") })}
                              aria-label={`Boxes of ${l.itemName}`}
                            />
                          </Td>
                          <Td right>
                            {inBoxes ? (
                              <span className="num font-semibold">{fmtQty(total, l.unit)}</span>
                            ) : (
                              <span className="flex items-center justify-end gap-1">
                                <input
                                  className="field num h-7 w-24 text-right"
                                  inputMode="decimal"
                                  value={d.total}
                                  onChange={(e) => setDraft(l.itemName, d, { total: e.target.value.replace(/[^\d.]/g, "") })}
                                  aria-label={`Received now of ${l.itemName}`}
                                />
                                <span className="text-[11px] text-muted">{l.unit}</span>
                              </span>
                            )}
                          </Td>
                          <Td>{judged ? <VarianceChip variance={judged.variance} closes={judged.closesItem} /> : <span className="text-[11px] text-muted">—</span>}</Td>
                          <Td>
                            <input
                              className="field h-7 w-40"
                              value={d.remark}
                              onChange={(e) => setDraft(l.itemName, d, { remark: e.target.value })}
                              placeholder={judged?.variance ? "Why? (for the escalation)" : "Optional"}
                              aria-label={`Store remark for ${l.itemName}`}
                            />
                          </Td>
                        </Tr>
                      );
                    })}
                  </Table>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    className="btn btn-primary"
                    disabled={!poReady || saving}
                    onClick={() => void saveAll(counted.map((r) => ({ key: r.line.itemName, poItemName: r.line.itemName, draft: r.draft })))}
                  >
                    {saving ? "Saving…" : `Create GRN${counted.length > 1 ? `s (${counted.length})` : ""}`}
                  </button>
                  <span className="text-[11px] text-muted">
                    Fill only the items that came. Within ±{TOL} of pending the item is complete; more than {TOL} short stays
                    open for the rest; more than {TOL} over is all accepted. Both are flagged for escalation.
                  </span>
                </div>
              </div>
            )}

            {/* 3 — free material without a PO */}
            {gate && noPo && (
              <div>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span>No PO — free material</span>
                  <button className="btn h-7 px-2 text-[11px]" onClick={() => setNoPo(false)}>
                    Search a PO instead
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label="PMS code">
                    <SearchPicker
                      className="field num h-8 w-28"
                      value={free.code}
                      onChange={(v) => setDraft("", free, { code: v })}
                      placeholder="PMS…"
                      minWidth={320}
                      ariaLabel="PMS code"
                      options={COMPONENTS.map((c) => ({ value: c.code, hint: c.name }))}
                    />
                  </Field>
                  <Field label="Qty in 1 box">
                    <input className="field num h-8 w-24 text-right" inputMode="numeric" value={free.perBox} onChange={(e) => setDraft("", free, { perBox: e.target.value.replace(/[^\d]/g, "") })} aria-label="Qty in 1 box" />
                  </Field>
                  <Field label="Boxes">
                    <input className="field num h-8 w-20 text-right" inputMode="numeric" value={free.boxes} onChange={(e) => setDraft("", free, { boxes: e.target.value.replace(/[^\d]/g, "") })} aria-label="Boxes" />
                  </Field>
                  <Field label="Total (pcs)">
                    <input className="field num h-8 w-24 text-right" inputMode="numeric" value={free.perBox && free.boxes ? String(countOf(free)) : free.total} disabled={Boolean(free.perBox && free.boxes)} onChange={(e) => setDraft("", free, { total: e.target.value.replace(/[^\d]/g, "") })} aria-label="Total" />
                  </Field>
                  <Field label="Remark">
                    <input className="field h-8 w-48" value={free.remark} onChange={(e) => setDraft("", free, { remark: e.target.value })} aria-label="Store remark" />
                  </Field>
                  <button className="btn btn-primary h-8" disabled={!freeReady || saving} onClick={() => void saveAll([{ key: "", poItemName: "", draft: free }])}>
                    Create GRN
                  </button>
                </div>
              </div>
            )}

            {legacy.length > 0 && <LegacyRows items={legacy} remembered={remembered} />}
          </div>
        )}

        <Table
          minWidth={1350}
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
            `Count vs PO (±${TOL})`,
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
                    <QtyCell grnNo={g.grnNo} value={g.totalQty} decimals={!isPcs(g.unit)} onCommit={(v) => updateGrnQty(g.grnNo, v)} />
                  ) : (
                    fmtQty(g.totalQty, g.unit)
                  )}
                </Td>
                <Td>
                  {g.pendingBefore !== null ? (
                    <span title={`Pending before: ${fmtQty(g.pendingBefore, g.unit)}`}>
                      <VarianceChip variance={g.variance} closes={g.closesItem} />
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted">—</span>
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
                      <button className="btn h-6 px-2 text-[11px]" onClick={() => sendToQc(g.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" })}>
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
        Store picks the vehicle from the gate register, reads its invoice and picks the PO, then counts each item. The count
        is judged against what is still pending on the PO item: within ±{TOL} the item is complete and the PO closes once all
        its items are; beyond it the GRN is flagged SHORT or EXCESS for escalation. New material waits in quarantine (UNDER
        TEST) until QC approves. The quantity can be corrected only until the GRN is sent to QC.
      </p>
      {viewing && <PhotoViewer gateEntryId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** Older gate entries whose items were checked in against a PO at the gate: one GRN per item, as before. */
function LegacyRows({ items, remembered }: { items: AwaitingGrn[]; remembered: Map<string, string> }) {
  const { addGrnLine, masters } = useFlow();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const keyOf = (w: AwaitingGrn) => `${w.gate.id}:${w.lineNo}`;
  const draftOf = (w: AwaitingGrn): Draft =>
    drafts[keyOf(w)] ?? { ...EMPTY, code: w.line!.itemCode || remembered.get(w.line!.itemName) || "", total: String(w.line!.qty) };
  const setDraft = (w: AwaitingGrn, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [keyOf(w)]: { ...draftOf(w), ...patch } }));

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
      poItemName: "",
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
    <div>
      <p className="mb-1 text-[12px] font-semibold">Older gate entries — items checked in against a PO at the gate</p>
      <div className="rounded border border-rule bg-white">
        <Table
          minWidth={1100}
          headers={["Gate entry", "PO no", "Item", { label: "At gate", align: "right" }, "PMS code", { label: "Qty in 1 box", align: "right" }, { label: "Boxes", align: "right" }, { label: "Total counted", align: "right" }, ""]}
        >
          {items.slice(0, 50).map((w, i) => {
            const d = draftOf(w);
            const comp = masters.componentByCode.get(d.code.trim().toUpperCase());
            const total = countOf(d);
            return (
              <Tr key={keyOf(w)} zebra={i % 2 === 1}>
                <Td num strong>{w.gate.id}</Td>
                <Td num>{w.gate.poNo}</Td>
                <Td>{w.line!.itemName}</Td>
                <Td right num>{fmtQty(w.line!.qty, w.line!.unit)} {w.line!.unit}</Td>
                <Td>
                  {w.line!.itemCode ? (
                    <span className="num">{w.line!.itemCode}</span>
                  ) : (
                    <SearchPicker
                      className="field num h-7 w-24"
                      value={d.code}
                      onChange={(v) => setDraft(w, { code: v })}
                      placeholder="PMS…"
                      minWidth={320}
                      ariaLabel={`PMS code for ${w.line!.itemName}`}
                      options={masters.components.map((c) => ({ value: c.code, hint: c.name }))}
                    />
                  )}
                </Td>
                <Td right>
                  <input className="field num h-7 w-20 text-right" inputMode="numeric" value={d.perBox} onChange={(e) => setDraft(w, { perBox: e.target.value.replace(/[^\d]/g, "") })} aria-label="Qty in 1 box" />
                </Td>
                <Td right>
                  <input className="field num h-7 w-16 text-right" inputMode="numeric" value={d.boxes} onChange={(e) => setDraft(w, { boxes: e.target.value.replace(/[^\d]/g, "") })} aria-label="Boxes" />
                </Td>
                <Td right>
                  {d.perBox && d.boxes ? (
                    <span className="num font-semibold">{fmtQty(total, w.line!.unit)}</span>
                  ) : (
                    <input className="field num h-7 w-24 text-right" inputMode="decimal" value={d.total} onChange={(e) => setDraft(w, { total: e.target.value.replace(/[^\d.]/g, "") })} aria-label="Total counted" />
                  )}
                </Td>
                <Td>
                  <button className="btn btn-primary h-7 px-2 text-[11px]" onClick={() => void save(w)} disabled={!comp || total <= 0}>
                    Create GRN
                  </button>
                </Td>
              </Tr>
            );
          })}
        </Table>
      </div>
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
