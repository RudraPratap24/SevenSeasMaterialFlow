import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthProvider, ChangePasswordScreen, LoginScreen, useAuth } from "./auth";
import { FlowProvider, useFlow, type ResetResult, type TabId } from "./store";
import { fmt } from "./ui";
import { FlowTab } from "./tabs/FlowTab";
import { GateTab } from "./tabs/GateTab";
import { GrnTab } from "./tabs/GrnTab";
import { QcTab } from "./tabs/QcTab";
import { PmStockTab } from "./tabs/PmStockTab";
import { RequisitionTab } from "./tabs/RequisitionTab";
import { FgTab } from "./tabs/FgTab";
import { DispatchTab } from "./tabs/DispatchTab";
import { PurchaseTab } from "./tabs/PurchaseTab";

const TAB_LABELS: Record<TabId, string> = {
  flow: "Flow",
  gate: "Gate Entry",
  grn: "GRN",
  qc: "QC",
  pmstock: "PM Stock",
  requisition: "Requisition",
  fg: "FG Warehouse",
  dispatch: "Dispatch",
  purchase: "Purchase",
};

export default function FlowApp() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate() {
  const { user, checking } = useAuth();
  if (checking) return <p className="p-6 text-[12px] text-muted">Loading…</p>;
  if (!user) return <LoginScreen />;
  if (user.mustChangePassword) return <ChangePasswordScreen />;
  // Keyed by login: nothing one department loaded survives into the next login.
  return (
    <FlowProvider key={user.username}>
      <Shell />
    </FlowProvider>
  );
}

function Shell() {
  const { clearAll, loadDemo, traceBatch, traceGrn, epoch, loaded, busy, error, dismissError, masters } = useFlow();
  const { user, logout, can, canSee, isViewOnly, demoReset } = useAuth();
  const [tab, setTab] = useState<TabId>(user?.tabs[0] ?? "flow");
  const [changingPassword, setChangingPassword] = useState(false);
  const [resetOp, setResetOp] = useState<"load" | "clear" | null>(null);
  const [tracePick, setTracePick] = useState<{ kind: "batch" | "grn"; key: string } | null>(null);

  useEffect(() => {
    setTracePick(null);
  }, [epoch]);

  const trace = useMemo(() => {
    if (!tracePick) return null;
    if (tracePick.kind === "batch") {
      return { label: `Batch ${tracePick.key}`, events: traceBatch(tracePick.key) };
    }
    return { label: `GRN ${tracePick.key}`, events: traceGrn(tracePick.key) };
  }, [tracePick, traceBatch, traceGrn]);

  const traceFromRegister = useCallback(
    (kind: "batch" | "grn", key: string) => {
      if (!canSee("flow")) return;
      setTracePick({ kind, key });
      setTab("flow");
    },
    [canSee],
  );

  const goTo = useCallback(
    (t: TabId) => {
      if (canSee(t)) setTab(t);
    },
    [canSee],
  );

  const visibleTabs = user?.tabs ?? [];
  const mayReset = can("demo.data") && demoReset;

  if (changingPassword) return <ChangePasswordScreen onDone={() => setChangingPassword(false)} />;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-[52px] shrink-0 items-center justify-between bg-ink px-5 text-white">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15.5px] font-bold tracking-[.01em]">
            Seven Seas Beauty — Material Flow
          </h1>
          <span className="num hidden text-[11px] text-white/60 md:inline">
            SOP/SCM/001 v2.1 · {fmt(masters.products.length)} products · {fmt(masters.components.length)} components
          </span>
        </div>
        <div className="flex items-center gap-2">
          {mayReset && (
            <>
              <button
                className="rounded-[3px] border border-white/25 px-2.5 py-1 text-[11.5px] font-semibold text-white/85 hover:bg-white/10"
                onClick={() => setResetOp("load")}
                disabled={busy}
                title="Replace every register on the server with a worked example"
              >
                Load demo data
              </button>
              <button
                className="rounded-[3px] border border-white/25 px-2.5 py-1 text-[11.5px] font-semibold text-white/85 hover:bg-white/10"
                onClick={() => setResetOp("clear")}
                disabled={busy}
                title="Empty every register on the server and set all stock to zero"
              >
                Clear all
              </button>
            </>
          )}
          <span className="ml-2 rounded-[3px] bg-white/15 px-2.5 py-1 text-[11.5px] font-bold">
            {user?.label}
          </span>
          <button
            className="rounded-[3px] border border-white/25 px-2.5 py-1 text-[11.5px] font-semibold text-white/85 hover:bg-white/10"
            onClick={() => setChangingPassword(true)}
          >
            Password
          </button>
          <button
            className="rounded-[3px] border border-white/25 px-2.5 py-1 text-[11.5px] font-semibold text-white/85 hover:bg-white/10"
            onClick={() => void logout()}
          >
            Log out
          </button>
        </div>
      </header>

      <nav
        className="flex shrink-0 items-stretch overflow-x-auto border-b border-rule bg-card px-5"
        aria-label="Registers"
      >
        {visibleTabs.map((t) => (
          <button
            key={t}
            className="relative whitespace-nowrap px-3 py-2.5 text-[12px] font-bold uppercase tracking-[.06em]"
            style={{
              color: tab === t ? "var(--blue-dk)" : "var(--muted)",
              boxShadow: tab === t ? "inset 0 -2px 0 var(--blue)" : "none",
            }}
            aria-current={tab === t ? "page" : undefined}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
            {isViewOnly(t) && <span className="ml-1 text-[9px] font-semibold normal-case tracking-normal">(view)</span>}
          </button>
        ))}
      </nav>

      <PendingStrip goTo={goTo} />

      {resetOp && (
        <ResetDialog
          op={resetOp}
          run={resetOp === "load" ? loadDemo : clearAll}
          onClose={() => setResetOp(null)}
        />
      )}

      {error && (
        <div
          className="flex shrink-0 items-center gap-3 border-b border-rule px-5 py-2"
          style={{ background: "var(--red-soft)" }}
          role="alert"
        >
          <span className="text-[12px] font-bold" style={{ color: "var(--red)" }}>
            Not saved — {error}
          </span>
          <button className="btn ml-auto h-6 px-2 text-[11px]" onClick={dismissError}>
            Dismiss
          </button>
        </div>
      )}

      <main
        key={epoch}
        className="min-h-0 flex-1 overflow-y-auto p-4"
        aria-busy={busy}
        style={busy ? { pointerEvents: "none", opacity: 0.7, cursor: "progress" } : undefined}
      >
        {!loaded && <p className="mb-3 text-[12px] text-muted">Loading registers from the server…</p>}
        {isViewOnly(tab) && (
          <p className="mb-3 rounded-[4px] border border-rule bg-blue-soft px-3 py-2 text-[12px] font-semibold text-blue-dk">
            View only — {user?.label} can see this register but cannot change it.
          </p>
        )}
        {tab === "flow" && (
          <FlowTab
            goTo={goTo}
            trace={trace}
            traceValue={tracePick ? `${tracePick.kind}::${tracePick.key}` : ""}
            onPickTrace={(value) => {
              if (!value) {
                setTracePick(null);
                return;
              }
              const [kind, key] = value.split("::") as ["batch" | "grn", string];
              setTracePick({ kind, key });
            }}
          />
        )}
        {tab === "gate" && <GateTab />}
        {tab === "grn" && <GrnTab onTrace={(g) => traceFromRegister("grn", g)} />}
        {tab === "qc" && <QcTab />}
        {tab === "pmstock" && <PmStockTab />}
        {tab === "requisition" && <RequisitionTab />}
        {tab === "fg" && <FgTab onTraceBatch={(b) => traceFromRegister("batch", b)} />}
        {tab === "dispatch" && <DispatchTab />}
        {tab === "purchase" && <PurchaseTab />}

        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Register formats are your own documents. Component and product lists are from your BOM.
          Entries are saved on the server and shared live between departments; every action is
          recorded in the audit log{mayReset ? ". Load demo data fills a worked example, Clear all starts from zero" : ""}.
        </p>
      </main>
    </div>
  );
}

const RESET_COPY = {
  clear: {
    title: "Clear all registers",
    phrase: "CLEAR ALL",
    action: "Clear everything",
    what: "Every gate entry, GRN, QC record, requisition, MRN, FG transfer, PDI, order, dispatch, indent and PO will be deleted for ALL departments, and every stock figure set to zero.",
  },
  load: {
    title: "Load demo data",
    phrase: "LOAD DEMO",
    action: "Replace with demo data",
    what: "Every register will be REPLACED by the demo storyline for ALL departments. Everything entered so far will be removed.",
  },
} as const;

/**
 * Destructive reset — needs the admin's own password and the typed phrase.
 * The server checks both again and saves a snapshot of the current data first.
 */
function ResetDialog({
  op,
  run,
  onClose,
}: {
  op: "load" | "clear";
  run: (password: string, confirm: string) => Promise<ResetResult>;
  onClose: () => void;
}) {
  const copy = RESET_COPY[op];
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const ready = phrase.trim() === copy.phrase && password.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function confirm() {
    if (!ready || busy) return;
    setBusy(true);
    const r = await run(password, phrase.trim());
    setBusy(false);
    setPassword("");
    if (r.ok) setDone(r.snapshotId);
    else setError(r.error);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-title"
    >
      <div className="w-full max-w-[460px] rounded-[6px] border border-rule bg-card shadow-lg">
        <div className="border-b border-rule px-5 py-3" style={{ background: "var(--red-soft)" }}>
          <h2 id="reset-title" className="text-[15px] font-bold" style={{ color: "var(--red)" }}>
            {copy.title}
          </h2>
        </div>
        {done !== null ? (
          <div className="px-5 py-4">
            <p className="text-[13px] font-bold">Done.</p>
            <p className="mt-1 text-[12px] text-muted">
              The previous data was saved as snapshot <b className="num text-ink">#{done}</b>. To undo,
              run on the server: <code className="num text-ink">npm run snapshot -- restore {done}</code>
            </p>
            <button className="btn btn-primary mt-4" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        ) : (
          <form
            className="px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <p className="text-[12.5px]">{copy.what}</p>
            <p className="mt-2 text-[11.5px] text-muted">
              A snapshot of the current data is kept on the server so this can be undone by the
              administrator. Logins and the supplier price master are not affected.
            </p>
            <label className="mt-3 block">
              <span className="col-head">
                Type <b className="num text-ink">{copy.phrase}</b> to confirm
              </span>
              <input
                className="field num mt-1"
                value={phrase}
                onChange={(e) => { setPhrase(e.target.value); setError(""); }}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-label="Confirmation phrase"
              />
            </label>
            <label className="mt-3 block">
              <span className="col-head">Your admin password</span>
              <input
                className="field mt-1"
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(""); }}
                autoComplete="current-password"
                aria-label="Admin password"
              />
            </label>
            {error && (
              <p className="mt-2 text-[12px] font-bold" style={{ color: "var(--red)" }} role="alert">
                {error}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="submit"
                className="btn flex-1 justify-center"
                style={ready ? { background: "var(--red)", borderColor: "var(--red)", color: "#fff" } : undefined}
                disabled={!ready || busy}
              >
                {busy ? "Working…" : copy.action}
              </button>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * The client's "barriers" made visible: each login lands on its pending work.
 * QC sees what waits for testing; store sees what waits for GRN or issue; and so on.
 */
function PendingStrip({ goTo }: { goTo: (t: TabId) => void }) {
  const { state, fgStock, shortList, poProgress, orderProgress } = useFlow();
  const { user, canSee } = useAuth();
  if (!user) return null;

  const grnDone = new Set(state.grnLines.map((g) => g.gateEntryId));
  const decided = new Map(state.arRecords.map((a) => [a.intimationId, a.status]));

  const items: { label: string; count: number; tab: TabId }[] = [];
  const add = (label: string, count: number, tab: TabId) => {
    if (count > 0 && canSee(tab)) items.push({ label, count, tab });
  };

  const gateWithoutGrn = state.gateEntries.filter((g) => !grnDone.has(g.id)).length;
  const grnNotSent = state.grnLines.filter(
    (g) => g.qcStatus === "UNDER_TEST" && !state.qcIntimations.some((q) => q.grnNo === g.grnNo),
  ).length;
  const qcPending = state.qcIntimations.filter((q) => {
    const st = decided.get(q.id);
    return !st || st === "HOLD";
  }).length;
  const pdiPending = fgStock.filter((r) => r.inStock > 0 && r.pdi !== "PASSED").length;
  const reqPending = state.requisitions.filter((r) => r.status === "PENDING").length;
  const fgInTransit = state.fgTransfers.filter((t) => t.status === "IN_TRANSIT").length;
  const awaitingInvoice = state.dispatchSlips.filter((d) => !d.invoiceNo).length;
  const awaitingGateOut = state.dispatchSlips.filter((d) => d.invoiceNo && !d.gateOut).length;
  const posToApprove = poProgress.filter((p) => p.po.status === "PENDING_APPROVAL").length;
  const openOrders = orderProgress.filter((o) => o.open).length;
  const approvedPosPending = poProgress.filter(
    (p) => p.po.status === "APPROVED" && !p.closed,
  ).length;

  switch (user.role) {
    case "gate":
      add("PO arrivals expected", approvedPosPending, "gate");
      break;
    case "store":
      add("gate entries without GRN", gateWithoutGrn, "grn");
      add("GRNs to send to QC", grnNotSent, "grn");
      add("requisitions to issue", reqPending, "requisition");
      break;
    case "qc":
      add("materials waiting for QC", qcPending, "qc");
      add("batches waiting for PDI", pdiPending, "qc");
      break;
    case "packing":
      add("requisitions pending issue", reqPending, "requisition");
      break;
    case "fgwh":
      add("transfers to receive", fgInTransit, "fg");
      add("open customer orders", openOrders, "dispatch");
      break;
    case "accounts":
      add("dispatches awaiting invoice", awaitingInvoice, "dispatch");
      break;
    case "security":
      add("vehicles awaiting gate-out", awaitingGateOut, "dispatch");
      break;
    case "purchase":
      add("items below minimum level", shortList.length, "purchase");
      add("POs awaiting owner approval", posToApprove, "purchase");
      break;
    case "admin":
      add("waiting for QC", qcPending, "qc");
      add("PDI pending", pdiPending, "qc");
      add("requisitions to issue", reqPending, "requisition");
      add("transfers to receive", fgInTransit, "fg");
      add("awaiting invoice", awaitingInvoice, "dispatch");
      add("awaiting gate-out", awaitingGateOut, "dispatch");
      add("below min level", shortList.length, "purchase");
      add("POs to approve", posToApprove, "purchase");
      break;
  }

  if (items.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-amber-soft px-5 py-2">
      <span className="text-[11px] font-bold uppercase tracking-[.07em]" style={{ color: "var(--amber)" }}>
        Your pending work
      </span>
      {items.map((it) => (
        <button
          key={it.label}
          className="rounded-[3px] border border-rule bg-card px-2 py-1 text-[11.5px] font-semibold hover:bg-blue-soft"
          onClick={() => goTo(it.tab)}
        >
          <b className="num">{fmt(it.count)}</b> {it.label}
        </button>
      ))}
    </div>
  );
}
