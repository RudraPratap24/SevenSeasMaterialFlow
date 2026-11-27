import { useState } from "react";
import { useAuth } from "../auth";
import { GST_LABEL, dateKey, debitNotesDue, deriveTallyPoProgress, gstSplit, numberTaken, tallyStatusOf } from "../logic";
import { api } from "../api";
import type { GstType, PurchaseOrder, Supplier } from "../types";
import { todayLabel, useFlow, useTallyStatus, type TallyStatus } from "../store";
import { Card, Chip, DateInput, EmptyNote, Field, Pager, SearchPicker, Table, Td, TextInput, Tr, fmt, fmtQty, usePaged } from "../ui";
import { ClipboardList, FilePlus2, FileMinus2, ShoppingCart, Store, Users } from "lucide-react";
import { VerifiedRequestsCard } from "./IndentRequests";
import { CardFlow, type Node } from "./ProductionTab";

const PURCHASE_CARDS: Node[] = [
  {
    title: "Indent Creation",
    tone: "purple",
    icon: FilePlus2,
    art: ClipboardList,
    view: () => (
      <div className="space-y-3">
        <VerifiedRequestsCard />
        <IndentsCard forPo={false} />
      </div>
    ),
  },
  {
    title: "Raise PO",
    tone: "blue",
    icon: ShoppingCart,
    art: ShoppingCart,
    view: () => (
      <div className="space-y-3">
        <IndentsCard forPo />
        <PurchaseOrdersCard />
      </div>
    ),
  },
  { title: "Debit Note", tone: "rose", icon: FileMinus2, art: FileMinus2, view: () => <DebitNotesCard /> },
  { title: "Suppliers", tone: "green", icon: Users, art: Store, view: () => <SuppliersCard /> },
];

export const PurchaseTab = () => <CardFlow root="Purchase" top={PURCHASE_CARDS} />;

/**
 * Indents, filtered by vendor. In Indent Creation: the list and "New indent". In Raise PO: Purchase ticks a vendor's
 * open indents and raises ONE PO for them — one line per item (ticked indents of the same item add up).
 */
function IndentsCard({ forPo }: { forPo: boolean }) {
  const { state, suppliers, raisePo } = useFlow();
  const { can } = useAuth();
  const [vendor, setVendor] = useState("");
  const [showAll, setShowAll] = useState(false); // usually only the active (open) indents
  const [ticked, setTicked] = useState<string[]>([]);
  /** Purchase's edits to a line, by PMS code; otherwise the indents' total and the price-master rate. */
  const [edits, setEdits] = useState<Record<string, { qty?: string; rate?: string }>>({});
  const [expected, setExpected] = useState(todayLabel);
  /** Chosen by Purchase for each PO (the vendor's state decides); never guessed. */
  const [gst, setGst] = useState<GstType | "">("");
  const mayRaise = forPo && can("purchase.po");

  // The typed vendor, once it is exactly one on the list; until then the text just narrows the indents.
  const exact = poVendors(suppliers).find((x) => x.name.toLowerCase() === vendor.trim().toLowerCase())?.name ?? "";
  const typed = vendor.trim().toLowerCase();
  const shown = state.indents
    .slice()
    .reverse()
    // indents made before vendors were recorded can be raised under any vendor
    .filter((i) => showAll || i.status === "OPEN")
    .filter((i) =>
      exact ? i.supplierName === exact || (i.status === "OPEN" && !i.supplierName) : !typed || i.supplierName.toLowerCase().includes(typed),
    );
  const activeCount = state.indents.filter((i) => i.status === "OPEN").length;
  const paged = usePaged(shown);
  const picked = state.indents.filter((i) => ticked.includes(i.id));
  const items = [...new Set(picked.map((i) => i.componentCode))].map((code) => {
    const of = picked.filter((i) => i.componentCode === code);
    const rate = of.find((i) => i.rate !== null)?.rate ?? suppliers.find((x) => x.name === exact)?.rates[code];
    return {
      code,
      name: of[0].componentName,
      qty: edits[code]?.qty ?? String(of.reduce((n, i) => n + i.qty, 0)),
      rate: edits[code]?.rate ?? (rate === undefined ? "" : String(rate)),
    };
  });
  const amountOf = (l: { qty: string; rate: string }) => (Number(l.qty) || 0) * (Number(l.rate) || 0);
  const total = items.reduce((n, l) => n + amountOf(l), 0);
  const tax = gstSplit(total, gst || undefined);
  const ready = exact && items.length > 0 && gst !== "" && items.every((l) => Number(l.qty) > 0 && Number(l.rate) > 0);

  function pickVendor(name: string) {
    setVendor(name);
    setTicked([]);
    setEdits({});
    setGst("");
    paged.setPage(0);
  }
  const tick = (id: string, on: boolean) => setTicked((t) => (on ? [...t, id] : t.filter((x) => x !== id)));
  const edit = (code: string, patch: { qty?: string; rate?: string }) =>
    setEdits((e) => ({ ...e, [code]: { ...e[code], ...patch } }));

  async function raise() {
    if (!ready) return;
    const ok = await raisePo({
      date: todayLabel(),
      supplierName: exact,
      lines: items.map((l) => ({
        componentCode: l.code,
        componentName: l.name,
        qty: Number(l.qty),
        rate: l.rate ? Number(l.rate) : null,
      })),
      expectedDate: expected.trim(),
      indentIds: ticked,
      gst: gst || undefined,
    });
    if (!ok) return;
    setTicked([]);
    setEdits({});
    setGst("");
    setExpected(todayLabel());
  }

  return (
    <Card
      title={forPo ? "Raise PO from indents" : "Indents"}
      step="PURCHASE REQUEST"
      role="Purchase"
      right={!forPo && can("purchase.indent") ? <ManualIndentButton /> : null}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-zebra px-3 py-2">
        <div className="w-[340px]">
          <span className="col-head">Vendor — type to search</span>
          <div className="mt-1">
            <SearchPicker
              value={vendor}
              onChange={pickVendor}
              placeholder="All vendors"
              ariaLabel="Filter indents by vendor"
              options={poVendors(suppliers).map((x) => {
                const open = state.indents.filter((i) => i.status === "OPEN" && i.supplierName === x.name).length;
                return { value: x.name, hint: [open ? `${open} open indent${open === 1 ? "" : "s"}` : "no open indents", x.city].filter(Boolean).join(" · ") };
              })}
            />
          </div>
        </div>
        <Field label="Show">
          <select
            className="field h-8"
            value={showAll ? "all" : "active"}
            onChange={(e) => {
              setShowAll(e.target.value === "all");
              paged.setPage(0);
            }}
            aria-label="Show indents"
          >
            <option value="active">Active ({activeCount})</option>
            <option value="all">All ({state.indents.length})</option>
          </select>
        </Field>
        {mayRaise && (
          <span className="text-[11px] text-muted">
            {exact ? "Tick the indents to put on one PO." : "Pick a vendor from the list to raise one PO for its open indents."}
          </span>
        )}
      </div>

      <div className="divide-y divide-rule">
        {paged.rows.map((ind) => (
          <label key={ind.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            {mayRaise && exact && ind.status === "OPEN" && (
              <input
                type="checkbox"
                checked={ticked.includes(ind.id)}
                onChange={(e) => tick(ind.id, e.target.checked)}
                aria-label={`Put ${ind.id} on the PO`}
              />
            )}
            <span className="num text-[12.5px] font-bold">{ind.id}</span>
            <span className="num text-[11.5px] text-muted">{ind.date}</span>
            <span className="text-[12.5px]">{ind.componentName}</span>
            <span className="num text-[12.5px] font-bold">{fmt(ind.qty)} pcs</span>
            <span className="num text-[12px]">
              {ind.rate === null ? <span className="text-muted">no rate</span> : `@ ₹${ind.rate} = ${rupees(ind.qty * ind.rate)}`}
            </span>
            <span className="text-[11.5px]">{ind.supplierName || <span className="text-muted">no vendor</span>}</span>
            <span className="text-[11.5px] text-muted">{ind.reason}</span>
            <span className="ml-auto">
              {ind.status === "PO_RAISED" ? (
                <Chip label={`PO ${state.purchaseOrders.find((p) => p.indentIds.includes(ind.id))?.id ?? "RAISED"}`} tone="blue" />
              ) : (
                <Chip label="OPEN" tone="amber" />
              )}
            </span>
          </label>
        ))}
      </div>
      <Pager {...paged} />
      {shown.length === 0 && (
        <EmptyNote>
          {vendor ? `No ${showAll ? "" : "active "}indents for "${vendor.trim()}".` : showAll ? "No indents yet." : "No active indents — all are on a PO."}
        </EmptyNote>
      )}

      {mayRaise && items.length > 0 && (
        <div className="border-t border-rule bg-zebra px-3 py-3">
          <div className="mb-2 text-[12.5px] font-semibold">
            New PO to {exact} — {ticked.length} indent{ticked.length === 1 ? "" : "s"}, {items.length} item
            {items.length === 1 ? "" : "s"}
          </div>
          <div className="rounded border border-rule bg-white">
            <Table
              headers={["Item", "Code", { label: "Qty (pcs)", align: "right" }, { label: "Rate ₹ *", align: "right" }, { label: "Amount ₹", align: "right" }]}
            >
              {items.map((l, i) => (
                <Tr key={l.code} zebra={i % 2 === 1}>
                  <Td>{l.name}</Td>
                  <Td num>{l.code}</Td>
                  <Td right>
                    <input
                      className="field num h-7 w-24 text-right"
                      inputMode="numeric"
                      value={l.qty}
                      onChange={(e) => edit(l.code, { qty: e.target.value.replace(/[^\d]/g, "") })}
                      aria-label={`PO qty for ${l.name}`}
                    />
                  </Td>
                  <Td right>
                    <input
                      className="field num h-7 w-24 text-right"
                      inputMode="decimal"
                      value={l.rate}
                      onChange={(e) => edit(l.code, { rate: e.target.value.replace(/[^\d.]/g, "") })}
                      placeholder="₹"
                      aria-label={`Rate for ${l.name}`}
                    />
                  </Td>
                  <Td right num>{amountOf(l) > 0 ? rupees(amountOf(l)) : "—"}</Td>
                </Tr>
              ))}
              {(
                [
                  ["Total (before GST)", total, true],
                  ...(gst === "INTRA"
                    ? [
                        ["CGST 9%", tax.cgst, false],
                        ["SGST 9%", tax.sgst, false],
                      ]
                    : gst === "INTER"
                      ? [["IGST 18%", tax.igst, false]]
                      : []),
                ] as [string, number, boolean][]
              ).map(([label, amount, strong]) => (
                <Tr key={label}>
                  <Td strong={strong}>{label}</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td right num strong={strong}>{rupees(amount)}</Td>
                </Tr>
              ))}
              {gst && (
                <Tr bg="var(--green-soft)">
                  <Td strong>Final amount (with GST)</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td>{""}</Td>
                  <Td right num strong>{rupees(tax.total)}</Td>
                </Tr>
              )}
            </Table>
          </div>
          <fieldset className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
            <legend className="col-head mb-1">GST * — vendor in which state?</legend>
            {(["INTRA", "INTER"] as const).map((g) => (
              <label key={g} className="flex cursor-pointer items-center gap-1.5 rounded-[3px] border border-rule bg-white px-2 py-1">
                <input type="radio" name="po-gst" checked={gst === g} onChange={() => setGst(g)} />
                {GST_LABEL[g]}
              </label>
            ))}
          </fieldset>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Expected date">
              <DateInput value={expected} onChange={setExpected} ariaLabel="Expected date" />
            </Field>
            <button className="btn btn-primary h-8" onClick={raise} disabled={!ready}>
              Raise one PO — {rupees(gst ? tax.total : total)}{gst ? " with GST" : ""} — goes for approval
            </button>
            {!ready && items.some((l) => !(Number(l.rate) > 0)) && (
              <span className="text-[11px] text-muted">Enter the rate for every item.</span>
            )}
            {!ready && gst === "" && <span className="text-[11px] text-muted">Choose GST: same state or other state.</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Manual indent — for materials without a minimum level, or a from-zero demo. */
function ManualIndentButton() {
  const { addIndent, masters, suppliers } = useFlow();
  const COMPONENTS = masters.components;
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("");
  const [vendor, setVendor] = useState("");
  const [rate, setRate] = useState("");

  const comp = masters.componentByCode.get(code.trim().toUpperCase());
  // The vendor with a fixed rate for this material, unless Purchase picks another (exactly one on the list).
  const suggested = comp
    ? (poVendors(suppliers).find((x) => comp.code in x.rates) ?? poVendors(suppliers).find((x) => x.supplies?.includes(comp.code)))?.name ?? ""
    : "";
  const chosen = vendor.trim()
    ? poVendors(suppliers).find((x) => x.name.toLowerCase() === vendor.trim().toLowerCase())?.name ?? ""
    : suggested;
  const fixed = comp ? suppliers.find((x) => x.name === chosen)?.rates[comp.code] : undefined;
  const rateNow = rate || (fixed === undefined ? "" : String(fixed));

  async function save() {
    if (!comp || !(Number(qty) > 0) || !chosen || !(Number(rateNow) > 0)) return;
    const ok = await addIndent({
      date: todayLabel(),
      componentCode: comp.code,
      componentName: comp.name,
      qty: Number(qty),
      reason: "Manual indent",
      supplierName: chosen,
      rate: Number(rateNow),
    });
    if (!ok) return;
    setOpen(false);
    setCode("");
    setQty("");
    setVendor("");
    setRate("");
  }

  return (
    <span className="flex items-center gap-2">
      {open && (
        <>
          <div className="w-[150px]">
            <SearchPicker
              value={code}
              onChange={setCode}
              placeholder="Code or item name"
              ariaLabel="Indent component code"
              minWidth={320}
              options={COMPONENTS.map((c) => ({ value: c.code, hint: c.name }))}
            />
          </div>
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
          <div className="w-[260px]">
            <SearchPicker
              value={vendor}
              onChange={setVendor}
              placeholder={suggested || "Vendor — type to search"}
              ariaLabel="Indent vendor"
              options={poVendors(suppliers).map((x) => ({
                value: x.name,
                hint: [
                  comp && comp.code in x.rates ? `fixed rate ₹${x.rates[comp.code]} for this item` : comp && x.supplies?.includes(comp.code) ? "supplies this item" : "",
                  x.city,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }))}
            />
          </div>
          <input
            className="num field h-8 w-[90px] text-right text-[12px]"
            value={rateNow}
            onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="Rate ₹"
            inputMode="decimal"
            aria-label="Indent rate per unit"
            title="Expected rate per unit — carried onto the PO"
          />
          <button className="btn btn-primary h-8" onClick={save} disabled={!comp || !(Number(qty) > 0) || !chosen || !(Number(rateNow) > 0)}>
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


/** One PO as Purchase sees it — raised here or copied from Tally. */
interface PoRow {
  poNo: string;
  date: string;
  supplierName: string;
  source: "APP" | "TALLY";
  expectedDate: string;
  value: number | null;
  cancelled: boolean;
  app?: PurchaseOrder;
  /** The indents this PO was raised from (app POs). */
  indentIds: string[];
  lines: {
    code: string;
    name: string;
    unit: string;
    qty: number;
    rate: number | null;
    received: number;
    pending: number;
    /** The indent(s) this item came from. */
    indents: string[];
  }[];
}
type PoState = "approval" | "open" | "received" | "closedByHand" | "cancelled" | "rejected";

/**
 * Every PO — raised in this app or from Tally — with its status, one place: pending approval → approved/open →
 * closed (fully received, automatically; or by hand with a reason) — or cancelled in Tally. 10 per page.
 */
function PurchaseOrdersCard() {
  const { state, poProgress, closePo, reopenPo, closePosBefore } = useFlow();
  const ours = new Set(state.purchaseOrders.filter((p) => !numberTaken(p)).map((p) => p.id));
  const { can } = useAuth();
  const status = useTallyStatus();
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "open" | "approval" | "closed">("all");
  const [reason, setReason] = useState("Received before go-live");
  const [before, setBefore] = useState(todayLabel);
  /** POs opened to show their items (all closed at first). */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpened((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const closure = new Map(state.poClosures.filter((c) => c.closed).map((c) => [c.poNo, c]));
  const rows: PoRow[] = [
    ...deriveTallyPoProgress(state.tallyPos.filter((p) => !ours.has(p.poNo)), state.gateEntries, state.grnLines).map(
      (p): PoRow => ({
        poNo: p.po.poNo,
        date: p.po.date,
        supplierName: p.po.supplierName,
        source: "TALLY",
        expectedDate: "",
        value: null,
        cancelled: p.po.cancelled,
        indentIds: [],
        lines: p.lines.map((l) => ({
          code: l.itemCode,
          name: l.itemName,
          unit: l.unit,
          qty: l.qty,
          rate: null,
          received: l.received,
          pending: l.pending,
          indents: [],
        })),
      }),
    ),
    // a PO raised here shows once, as ours (with rates and indents) — also after it went to Tally
    ...poProgress
      .map(
        (p): PoRow => ({
          poNo: p.po.id,
          date: p.po.date,
          supplierName: p.po.supplierName,
          source: "APP",
          expectedDate: p.po.expectedDate,
          value: p.value,
          cancelled: false,
          app: p.po,
          indentIds: p.po.indentIds,
          lines: p.lines.map((l) => ({
            code: l.code,
            name: l.name,
            unit: "Pcs",
            qty: l.qty,
            rate: l.rate,
            received: l.received,
            pending: l.pending,
            indents: state.indents.filter((i) => p.po.indentIds.includes(i.id) && i.componentCode === l.code).map((i) => i.id),
          })),
        }),
      ),
  ].sort((a, b) => dateKey(b.date) - dateKey(a.date) || b.poNo.localeCompare(a.poNo));

  const stateOf = (r: PoRow): PoState =>
    r.cancelled
      ? "cancelled"
      : closure.has(r.poNo)
        ? "closedByHand"
        : r.app?.status === "REJECTED"
          ? "rejected"
          : r.app && r.app.status !== "APPROVED"
            ? "approval"
          : r.lines.every((l) => l.pending === 0)
            ? "received"
            : "open";
  const term = search.trim().toLowerCase();
  const shown = rows.filter((r) => {
    const st = stateOf(r);
    if (show === "open" && st !== "open") return false;
    if (show === "approval" && st !== "approval") return false;
    if (show === "closed" && (st === "open" || st === "approval")) return false;
    return !term || [r.poNo, r.supplierName, ...r.indentIds, ...r.lines.flatMap((l) => [l.name, l.code])].some((v) => v.toLowerCase().includes(term));
  });
  const count = (st: PoState[]) => rows.filter((r) => st.includes(stateOf(r))).length;
  const paged = usePaged(shown);

  return (
    <Card
      title="Purchase orders"
      step="PO · OTIF"
      role={`Purchase · Owner approves · ${status?.syncedAt ? `Tally synced ${status.syncedAt}` : "not synced from Tally yet"}`}
    >
      <div className="flex flex-wrap items-end gap-2 border-b border-rule bg-zebra px-3 py-2">
        <Field label="Search — PO no, vendor, item, code or indent">
          <input
            className="field h-8 w-[300px]"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              paged.setPage(0);
            }}
            placeholder="26SEV1201, MAXCOMM, LL-112, PMS0842, IND-0003"
          />
        </Field>
        <Field label="Show">
          <select
            className="field h-8"
            value={show}
            onChange={(e) => {
              setShow(e.target.value as typeof show);
              paged.setPage(0);
            }}
            aria-label="Show POs"
          >
            <option value="all">All ({rows.length})</option>
            <option value="open">Open ({count(["open"])})</option>
            <option value="approval">Pending approval ({count(["approval"])})</option>
            <option value="closed">Closed ({count(["received", "closedByHand", "cancelled"])})</option>
          </select>
        </Field>
        {can("purchase.close") && (
          <Field label="Reason when closing a PO">
            <TextInput value={reason} onChange={setReason} ariaLabel="Reason for closing a PO" />
          </Field>
        )}
        {can("purchase.cutover") && (
          <>
            <Field label="Go-live: close POs dated before">
              <DateInput value={before} onChange={setBefore} ariaLabel="Close POs dated before" />
            </Field>
            <button
              className="btn h-8"
              disabled={!/^\d{2}-\d{2}-\d{4}$/.test(before) || !reason.trim()}
              onClick={() => {
                if (window.confirm(`Close every PO dated before ${before} with nothing received in the app? (Each can be reopened.)`)) {
                  void closePosBefore(before, reason, "", "");
                }
              }}
              title="Once at go-live: Tally can't tell which old POs were received. Only POs with nothing received in this app; each can be reopened."
            >
              Close old POs
            </button>
          </>
        )}
      </div>

      <div className="divide-y divide-rule">
        {paged.rows.map((r) => {
          const st = stateOf(r);
          const c = closure.get(r.poNo);
          const key = `${r.source}:${r.poNo}`;
          const isOpen = opened.has(key);
          const pendingItems = r.lines.filter((l) => l.pending > 0).length;
          return (
            <div key={key} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flex flex-wrap items-center gap-2 text-left"
                  onClick={() => toggle(key)}
                  aria-expanded={isOpen}
                  title={isOpen ? "Hide the items" : "Show the items"}
                >
                  <span className="w-3 text-[11px] text-muted" aria-hidden>
                    {isOpen ? "▼" : "▶"}
                  </span>
                  <span className="num text-[13px] font-bold">{r.poNo}</span>
                  <span className="num text-[12px] text-muted">{r.date}</span>
                  <span className="text-[12.5px] font-semibold">{r.supplierName}</span>
                  <Chip label={r.source === "TALLY" ? "FROM TALLY" : "RAISED HERE"} tone="muted" />
                  <span className="text-[11.5px] text-muted">
                    {r.lines.length} item{r.lines.length === 1 ? "" : "s"}
                    {pendingItems > 0 && pendingItems < r.lines.length ? ` · ${pendingItems} pending` : ""}
                  </span>
                  {r.indentIds.length > 0 && (
                    <span className="num text-[11.5px] text-muted">
                      Indent{r.indentIds.length === 1 ? "" : "s"} {r.indentIds.join(", ")}
                    </span>
                  )}
                  {r.expectedDate && <span className="num text-[11.5px] text-muted">expected {r.expectedDate}</span>}
                </button>
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {r.value !== null && <PoTotal value={r.value} gst={r.app?.gst} />}
                  {r.app?.status === "APPROVED" && <TallyChip po={r.app} />}
                  {st === "cancelled" && <Chip label="CANCELLED IN TALLY" tone="red" />}
                  {st === "closedByHand" && c && <Chip label={`CLOSED — ${c.reason} (${c.by}, ${c.date})`} tone="muted" />}
                  {st === "received" && <Chip label="CLOSED — FULLY RECEIVED" tone="green" />}
                  {st === "approval" && <Chip label="PENDING APPROVAL" tone="amber" />}
                  {st === "rejected" && <Chip label={`REJECTED — ${r.app?.rejectReason ?? ""} (${r.app?.rejectedBy ?? ""})`} tone="red" />}
                  {st === "open" && <Chip label={r.app ? `APPROVED — ${r.app.approvedBy}` : "OPEN"} tone="blue" />}
                  {can("purchase.close") && st === "open" && (
                    <button className="btn h-6 px-2 text-[11px]" disabled={!reason.trim()} onClick={() => closePo(r.poNo, reason, "", "")}>
                      Close
                    </button>
                  )}
                  {can("purchase.close") && st === "closedByHand" && (
                    <button className="btn h-6 px-2 text-[11px]" onClick={() => reopenPo(r.poNo, "", "")}>
                      Reopen
                    </button>
                  )}
                </span>
              </div>
              {isOpen && (
              <div className="mt-2 overflow-hidden rounded-[3px] border border-rule">
                <Table
                  headers={[
                    "Item",
                    "Code",
                    ...(r.indentIds.length ? ["Indent"] : []),
                    { label: "Rate", align: "right" },
                    { label: "Ordered", align: "right" },
                    { label: "Amount", align: "right" },
                    { label: "Received", align: "right" },
                    { label: "Pending", align: "right" },
                  ]}
                >
                  {r.lines.map((l, i) => (
                    <Tr key={`${l.code}:${l.name}`} zebra={i % 2 === 1}>
                      <Td>{l.name}</Td>
                      <Td num>{l.code || "—"}</Td>
                      {r.indentIds.length > 0 && <Td num>{l.indents.join(", ") || "—"}</Td>}
                      <Td right num>{l.rate === null ? "—" : `₹${l.rate}`}</Td>
                      <Td right num>{fmtQty(l.qty, l.unit)}</Td>
                      <Td right num>{l.rate === null ? "—" : rupees(l.qty * l.rate)}</Td>
                      <Td right num>{l.received > 0 ? fmtQty(l.received, l.unit) : "—"}</Td>
                      <Td right num strong>
                        {l.pending > 0 ? <span style={{ color: "var(--amber)" }}>{fmtQty(l.pending, l.unit)}</span> : "—"}
                      </Td>
                    </Tr>
                  ))}
                  {r.value !== null && <GstRows value={r.value} gst={r.app?.gst} before={r.indentIds.length ? 4 : 3} after={2} />}
                </Table>
              </div>
              )}
              {st === "approval" && (
                <p className="mt-2 text-[11.5px] text-muted">Waiting for the owner's approval — approved in the PO Approval tab.</p>
              )}
            </div>
          );
        })}
      </div>
      <Pager {...paged} />
      {shown.length === 0 && <EmptyNote>{rows.length ? "No PO matches." : "No purchase orders yet."}</EmptyNote>}

      <SyncHealth status={status} />
      {status?.skipped && status.skipped.length > 0 && (
        <div className="border-t border-rule px-3 py-2 text-[12px]">
          <div className="font-semibold">Left out of the last Tally sync — fix in Tally, the next sync takes them:</div>
          {status.skipped.map((x, i) => (
            <div key={i} className="text-muted">
              <span className="num font-semibold text-ink">{x.poNo}</span> — {x.reason}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Vendors (from Tally + the price master), searchable, 10 per page. */
function SuppliersCard() {
  const { suppliers, masters } = useFlow();
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const shown = suppliers.filter((s) => !term || s.name.toLowerCase().includes(term) || s.city.toLowerCase().includes(term));
  const paged = usePaged(shown);
  return (
    <Card
      title="Suppliers — price master"
      role={`${suppliers.length} vendors`}
      right={
        <input
          className="field h-8 w-[240px]"
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            paged.setPage(0);
          }}
          placeholder="Search vendor or city…"
          aria-label="Search suppliers"
        />
      }
    >
      <Table minWidth={600} headers={["Supplier", "City", "Materials with fixed rate", "Also supplies (no fixed rate)"]}>
        {paged.rows.map((s, i) => (
          <Tr key={s.name} zebra={i % 2 === 1}>
            <Td strong>{s.name}</Td>
            <Td muted>{s.city || "—"}</Td>
            <Td muted>
              {Object.entries(s.rates)
                .map(([code, rate]) => `${masters.componentByCode.get(code)?.name ?? code} @ ₹${rate}`)
                .join(" · ") || "—"}
            </Td>
            <Td muted>{s.supplies?.map((code) => masters.componentByCode.get(code)?.name ?? code).join(" · ") || "—"}</Td>
          </Tr>
        ))}
      </Table>
      <Pager {...paged} />
      {shown.length === 0 && <EmptyNote>No vendor matches.</EmptyNote>}
    </Card>
  );
}

/** A PO's total on its header line: the final amount with GST (POs from before GST: the plain total). */
export function PoTotal({ value, gst }: { value: number; gst?: GstType }) {
  return (
    <span className="num text-[12px] font-semibold" title={gst ? GST_LABEL[gst] : undefined}>
      Total {rupees(gstSplit(value, gst).total)}
      {gst && <span className="ml-1 text-[10.5px] font-normal text-muted">incl. GST</span>}
    </span>
  );
}

/** The rows under a PO's items: before GST, CGST + SGST or IGST, and the final amount. `before`/`after`: empty cells around the Amount column. */
export function GstRows({ value, gst, before, after }: { value: number; gst?: GstType; before: number; after: number }) {
  if (!gst) return null;
  const t = gstSplit(value, gst);
  const rows: [string, number][] = [
    ["Total (before GST)", t.taxable],
    ...(gst === "INTRA"
      ? ([
          ["CGST 9%", t.cgst],
          ["SGST 9%", t.sgst],
        ] as [string, number][])
      : ([["IGST 18%", t.igst]] as [string, number][])),
  ];
  const pad = (n: number) => Array.from({ length: n }, (_, i) => <Td key={i}>{""}</Td>);
  return (
    <>
      {rows.map(([label, amount], i) => (
        <Tr key={label}>
          <Td strong={i === 0}>{label}</Td>
          {pad(before)}
          <Td right num strong={i === 0}>{rupees(amount)}</Td>
          {pad(after)}
        </Tr>
      ))}
      <Tr bg="var(--green-soft)">
        <Td strong>Final amount (with GST)</Td>
        {pad(before)}
        <Td right num strong>{rupees(t.total)}</Td>
        {pad(after)}
      </Tr>
    </>
  );
}

/** ₹ with Indian grouping, paise kept when there are any. */
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;


/** Once vendors come from Tally, only those (so every PO can go to Tally); before that, every approved supplier. */
export const poVendors = (suppliers: Supplier[]) => (suppliers.some((x) => x.fromTally) ? suppliers.filter((x) => x.fromTally) : suppliers);

/**
 * Where an approved PO raised here stands with Tally: created there (read back, same items) / sent and waiting for the
 * read-back / refused, with Tally's reason and Retry / not sent yet (writing to Tally off).
 */
function TallyChip({ po }: { po: PurchaseOrder }) {
  const { state, reload } = useFlow();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState("");
  const status = tallyStatusOf(po, state.tallyPos);
  async function send(path: "/tally/push" | "/tally/renumber") {
    setBusy(true);
    setRetryError("");
    try {
      await api("POST", path, { poNo: po.id });
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "Not sent.");
    } finally {
      setBusy(false);
      await reload();
    }
  }
  // Another PO in Tally has this number (made there by hand): send ours under the next free number instead.
  if (numberTaken(po) && !retryError) {
    return (
      <span className="flex flex-wrap items-center gap-1" title={po.tallyError}>
        <Chip label={`NUMBER ${po.id} TAKEN IN TALLY`} tone="red" />
        {can("purchase.tally") && (
          <button className="btn h-6 px-2 text-[11px]" disabled={busy} onClick={() => void send("/tally/renumber")}>
            {busy ? "Sending…" : "New number & send"}
          </button>
        )}
      </span>
    );
  }
  if (status === "IN_TALLY") return <Chip label="IN TALLY ✓" tone="green" />;
  if (status === "DIFFERS") return <Chip label="DIFFERS FROM TALLY ⚠" tone="red" />;
  const error = retryError || po.tallyError;
  if (!error) return <Chip label={po.tallyPushedAt ? "SENT TO TALLY" : "NOT IN TALLY YET"} tone="amber" />;
  return (
    <span className="flex flex-wrap items-center gap-1" title={error}>
      <Chip label={`NOT SENT TO TALLY — ${error.length > 70 ? `${error.slice(0, 70)}…` : error}`} tone="red" />
      {can("purchase.tally") && (
        <button className="btn h-6 px-2 text-[11px]" disabled={busy} onClick={() => void send("/tally/push")}>
          {busy ? "Sending…" : "Retry"}
        </button>
      )}
    </span>
  );
}

/** "dd-mm-yyyy hh:mm" → minutes ago (null if unreadable). */
function minutesAgo(stampText: string): number | null {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/.exec(stampText);
  if (!m) return null;
  return (Date.now() - new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime()) / 60_000;
}

/** The scheduled Tally sync failing, or not running: the app keeps working on its last copy — say how old it is. */
function SyncHealth({ status }: { status: TallyStatus | null }) {
  if (!status) return null;
  const err = status.syncError;
  const age = minutesAgo(status.syncedAt);
  if (!err && (age === null || age < 3)) return null;
  return (
    <p className="mx-3 mb-3 rounded-[4px] border px-3 py-2 text-[12px]" style={err ? { borderColor: "var(--red)", background: "var(--red-soft)" } : { borderColor: "var(--amber)", background: "var(--amber-soft)" }} role="status">
      {err ? (
        <>
          <b style={{ color: "var(--red)" }}>Tally sync failing since {err.since}</b> (last try {err.at}): {err.error}
        </>
      ) : (
        <b style={{ color: "var(--amber)" }}>Tally sync has not run for {Math.round(age!)} minutes — is it running (npm run dev / npm run tally -- watch)?</b>
      )}{" "}
      The app keeps working on the copy from {status.syncedAt || "—"}.
    </p>
  );
}

/**
 * What QC rejected, waiting for Purchase's debit note to the vendor (rejected qty × rate), and the notes raised.
 * The rate comes from the app PO where it has one; POs copied from Tally carry no rate here, so Purchase enters it.
 */
function DebitNotesCard() {
  const { state, addDebitNote } = useFlow();
  const { can } = useAuth();
  const mayRaise = can("purchase.debitnote");
  const due = debitNotesDue(state);
  const [drafts, setDrafts] = useState<Record<string, { rate: string; reason: string }>>({});
  const poRate = (poNo: string, code: string) =>
    state.purchaseOrders.find((p) => p.id === poNo)?.lines.find((l) => l.componentCode === code)?.rate ?? null;

  return (
    <Card title="Debit notes" step="QC REJECTED" role={`Purchase · ${due.length} waiting`}>
      {due.length === 0 ? (
        <EmptyNote>Nothing waiting — every quantity QC rejected has its debit note.</EmptyNote>
      ) : (
        <Table
          minWidth={1150}
          headers={[
            "GRN no",
            "Supplier",
            "Invoice no",
            "PO no",
            "Item",
            { label: "Rejected", align: "right" },
            "QC reason (A.R.)",
            ...(mayRaise ? [{ label: "Rate ₹", align: "right" as const }, { label: "Amount", align: "right" as const }, "Reason to vendor", ""] : []),
          ]}
        >
          {due.map((d, i) => {
            const known = poRate(d.grn.poNo, d.grn.componentCode);
            const draft = drafts[d.grn.grnNo] ?? { rate: known === null ? "" : String(known), reason: d.reason };
            const set = (patch: Partial<typeof draft>) => setDrafts((x) => ({ ...x, [d.grn.grnNo]: { ...draft, ...patch } }));
            const rate = Number(draft.rate);
            return (
              <Tr key={d.grn.grnNo} zebra={i % 2 === 1}>
                <Td num strong>{d.grn.grnNo}</Td>
                <Td>{d.grn.supplierName}</Td>
                <Td num>{d.grn.invoiceNo || "—"}</Td>
                <Td num>{d.grn.poNo || "—"}</Td>
                <Td>
                  {d.grn.componentName} <span className="num text-muted">{d.grn.componentCode}</span>
                </Td>
                <Td right num strong>
                  {fmtQty(d.qty, d.grn.unit)} {d.grn.unit}
                </Td>
                <Td muted>
                  {d.reason || "—"} <span className="num">({d.arNo})</span>
                </Td>
                {mayRaise && (
                  <>
                    <Td right>
                      <input
                        className="field num h-7 w-24 text-right"
                        inputMode="decimal"
                        value={draft.rate}
                        onChange={(e) => set({ rate: e.target.value.replace(/[^\d.]/g, "") })}
                        placeholder={known === null ? "enter" : ""}
                        aria-label={`Rate for ${d.grn.grnNo}`}
                      />
                    </Td>
                    <Td right num>{rate > 0 ? rupees(Math.round(d.qty * rate * 100) / 100) : "—"}</Td>
                    <Td>
                      <input
                        className="field h-7 w-56"
                        value={draft.reason}
                        onChange={(e) => set({ reason: e.target.value })}
                        aria-label={`Reason for ${d.grn.grnNo}`}
                      />
                    </Td>
                    <Td>
                      <button
                        className="btn btn-primary h-7 px-2 text-[11px]"
                        disabled={!(rate > 0) || !draft.reason.trim()}
                        onClick={async () => {
                          if (await addDebitNote({ grnNo: d.grn.grnNo, rate, reason: draft.reason.trim() })) {
                            setDrafts(({ [d.grn.grnNo]: _, ...rest }) => rest);
                          }
                        }}
                      >
                        Create debit note
                      </button>
                    </Td>
                  </>
                )}
              </Tr>
            );
          })}
        </Table>
      )}
      {state.debitNotes.length > 0 && (
        <Table
          minWidth={1100}
          headers={[
            "DN no",
            "Type",
            "Date",
            "Supplier",
            "Invoice no",
            "GRN / PO",
            "Item",
            { label: "Qty", align: "right" },
            { label: "Rate", align: "right" },
            { label: "Amount", align: "right" },
            "Reason",
            "Raised by",
          ]}
        >
          {state.debitNotes
            .slice()
            .reverse()
            .map((n, i) => (
              <Tr key={n.id} zebra={i % 2 === 1}>
                <Td num strong>{n.id}</Td>
                <Td>{n.kind === "SHORT_SUPPLY" ? <Chip label="SHORT SUPPLY" tone="amber" /> : <Chip label="QC REJECTED" tone="red" />}</Td>
                <Td num>{n.date}</Td>
                <Td>{n.supplierName}</Td>
                <Td num strong>{n.invoiceNo || "—"}</Td>
                <Td num>
                  {n.grnNo} / {n.poNo || "—"}
                </Td>
                <Td>{n.componentName}</Td>
                <Td right num>
                  {fmtQty(n.qty, n.unit)} {n.unit}
                </Td>
                <Td right num>{rupees(n.rate)}</Td>
                <Td right num strong>{rupees(n.amount)}</Td>
                <Td muted>{n.reason}</Td>
                <Td muted>{n.raisedBy}</Td>
              </Tr>
            ))}
        </Table>
      )}
    </Card>
  );
}
