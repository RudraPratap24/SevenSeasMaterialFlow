import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import {
  derivePmStock,
  emptyState,
  mergeChanges,
  deriveFgStock,
  deriveOrderProgress,
  derivePoProgress,
  traceBatch as traceBatchOf,
  traceGrn as traceGrnOf,
  type ActionArgs,
  type ActionName,
  type FgStockRow,
  type OrderProgress,
  type PmStockRow,
  type PoProgress,
  type TraceEvent,
} from "./logic";
import { PRICE_ROLES } from "./perms";
import type { BomLine, ComponentInfo, FlowState, Masters, ProductMaster, Supplier } from "./types";

export { todayLabel } from "./logic";

/** Master data with lookups, as served by the API — renames show up here on the next poll. */
export interface MasterLists {
  components: ComponentInfo[];
  componentByCode: Map<string, ComponentInfo>;
  products: ProductMaster[];
  productByName: Map<string, ProductMaster>;
  /** BOM lines of a product (empty for roles that do not raise requisitions). */
  bomOf(productName: string): BomLine[];
}

function toLists(m: Masters): MasterLists {
  return {
    components: m.components,
    componentByCode: new Map(m.components.map((c) => [c.code, c])),
    products: m.products,
    productByName: new Map(m.products.map((p) => [p.name, p])),
    bomOf: (name) => m.bom?.[name] ?? [],
  };
}
const NO_MASTERS = toLists({ components: [], products: [], bom: null });
export type { FgStockRow, OrderProgress, PmStockRow, PoProgress, TraceEvent } from "./logic";
export type { TabId } from "./perms";

/**
 * The registers, as the logged-in role is allowed to see them. The server is the
 * source of truth: every action is sent to it, checked and applied there inside
 * a transaction, and the confirmed state comes back. Derived figures (stock,
 * PO/order progress, traceability) are computed here with the same shared code
 * the server uses for its guards.
 *
 * Actions resolve to true on success; on a refusal they resolve to false and the
 * server's reason is shown in the shell's message bar.
 */
type Mutation<K extends ActionName> = (...args: ActionArgs<K>) => Promise<boolean>;

interface FlowApi {
  state: FlowState;
  pmStock: PmStockRow[];
  fgStock: FgStockRow[];
  poProgress: PoProgress[];
  orderProgress: OrderProgress[];
  /** Components below their minimum level — the purchase short list. */
  shortList: PmStockRow[];
  /** Approved suppliers with fixed rates — only for roles that may see prices. */
  suppliers: Supplier[];
  masters: MasterLists;
  epoch: number;
  hasData: boolean;
  loaded: boolean;
  /** An action is on its way to the server. */
  busy: boolean;
  error: string | null;
  dismissError(): void;
  /** Re-reads the registers now (e.g. after a master-data change elsewhere on screen). */
  reload(): Promise<void>;
  addGateEntry: Mutation<"addGateEntry">;
  addGrnLine: Mutation<"addGrnLine">;
  updateGrnQty: Mutation<"updateGrnQty">;
  sendToQc: Mutation<"sendToQc">;
  recordAr: Mutation<"recordAr">;
  setBarcoded: Mutation<"setBarcoded">;
  addRequisition: Mutation<"addRequisition">;
  issueRequisition: Mutation<"issueRequisition">;
  addMrn: Mutation<"addMrn">;
  addFgTransfer: Mutation<"addFgTransfer">;
  receiveFgTransfer: Mutation<"receiveFgTransfer">;
  recordPdi: Mutation<"recordPdi">;
  addOrder: Mutation<"addOrder">;
  addDispatch: Mutation<"addDispatch">;
  addInvoice: Mutation<"addInvoice">;
  gateOut: Mutation<"gateOut">;
  addIndent: Mutation<"addIndent">;
  raisePo: Mutation<"raisePo">;
  approvePo: Mutation<"approvePo">;
  /** Admin reset — needs the admin's password and the typed phrase; the server keeps a snapshot. */
  clearAll(password: string, confirm: string): Promise<ResetResult>;
  loadDemo(password: string, confirm: string): Promise<ResetResult>;
  traceBatch(batchNo: string): TraceEvent[];
  traceGrn(grnNo: string): TraceEvent[];
}

export type ResetResult = { ok: true; snapshotId: number } | { ok: false; error: string };

/** Everything this login may see, with the change number it is current as of. */
interface FullResponse {
  version: number;
  resyncVersion: number;
  state: FlowState;
}
/** Only the documents changed since the screen's change number. */
interface ChangesResponse {
  version: number;
  resyncVersion: number;
  changes: FlowState;
}

/** How often each screen checks for other departments' work. */
const POLL_MS = 10_000;

const Ctx = createContext<FlowApi | null>(null);

export function useFlow(): FlowApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFlow outside provider");
  return v;
}

export function FlowProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<FlowState>(() => emptyState());
  const [loaded, setLoaded] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [masters, setMasters] = useState<MasterLists>(NO_MASTERS);
  /** The change number this screen is current as of — sent with every action as its basis. */
  const version = useRef(-1);
  const resyncVersion = useRef(-1);
  const mastersVersion = useRef(-1);
  const inFlight = useRef(false);

  const applyFull = useCallback((r: FullResponse) => {
    version.current = r.version;
    resyncVersion.current = r.resyncVersion;
    setState(r.state);
    setLoaded(true);
  }, []);

  const refreshMasters = useCallback(async () => {
    try {
      const m = await api<Masters & { version: number }>("GET", "/masters");
      mastersVersion.current = m.version;
      setMasters(toLists(m));
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) setError(e.message);
    }
  }, []);

  /** Full reload — on login, and when the server asks every screen to reload. */
  const refresh = useCallback(async () => {
    try {
      applyFull(await api<FullResponse>("GET", "/state"));
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) setError(e.message);
    }
  }, [applyFull]);

  /** Brings the screen up to date with only what changed (or everything, if a full reload is due). */
  const catchUp = useCallback(
    async (given?: ChangesResponse) => {
      const r = given ?? (await api<ChangesResponse>("GET", `/changes?since=${Math.max(0, version.current)}`));
      if (r.resyncVersion !== resyncVersion.current) return refresh();
      if (r.version <= version.current) return; // an older answer arriving late
      version.current = r.version;
      setState((s) => mergeChanges(s, r.changes));
    },
    [refresh],
  );

  // First load, then poll: a cheap version check, then only the changed documents.
  useEffect(() => {
    void refreshMasters();
    void refresh();
    const timer = window.setInterval(async () => {
      if (inFlight.current || document.hidden || version.current < 0) return;
      try {
        const v = await api<{ version: number; resyncVersion: number; mastersVersion: number }>("GET", "/version");
        if (v.mastersVersion !== mastersVersion.current) await refreshMasters();
        if (inFlight.current) return;
        if (v.resyncVersion !== resyncVersion.current) await refresh();
        else if (v.version !== version.current) await catchUp();
      } catch {
        /* transient — the next tick tries again */
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, refreshMasters, catchUp]);

  useEffect(() => {
    if (!user || !PRICE_ROLES.includes(user.role)) return;
    api<{ suppliers: Supplier[] }>("GET", "/masters/suppliers")
      .then((r) => setSuppliers(r.suppliers))
      .catch(() => setSuppliers([]));
  }, [user]);

  /**
   * Sends one action, with the change number this screen shows as its basis — the
   * server refuses it if a document it touches changed since. One at a time: a
   * double-click can never file a document twice.
   */
  const send = useCallback(
    async (path: string, args: unknown[]): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      try {
        await catchUp(await api<ChangesResponse>("POST", path, { args, basis: Math.max(0, version.current) }));
        setError(null);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
        // Someone else may have changed things meanwhile — show the latest truth.
        if (!(e instanceof ApiError && e.status === 401)) void catchUp().catch(() => undefined);
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [catchUp],
  );

  const pmStock = useMemo(
    () => [
      ...derivePmStock(
        state.grnLines,
        state.requisitions,
        state.mrns,
        state.openings,
        state.minLevels,
        masters.components,
      ).values(),
    ],
    [state.grnLines, state.requisitions, state.mrns, state.openings, state.minLevels, masters.components],
  );

  const shortList = useMemo(
    () =>
      pmStock
        .filter((r) => r.minLevel !== null && r.closing < r.minLevel)
        .sort((a, b) => (b.minLevel! - b.closing) - (a.minLevel! - a.closing)),
    [pmStock],
  );

  const fgStock = useMemo(
    () =>
      [
        ...deriveFgStock({
          fgTransfers: state.fgTransfers,
          dispatchSlips: state.dispatchSlips,
          pdiRecords: state.pdiRecords,
        }).values(),
      ],
    [state.fgTransfers, state.dispatchSlips, state.pdiRecords],
  );

  const poProgress = useMemo(
    () => derivePoProgress(state.purchaseOrders, state.grnLines),
    [state.purchaseOrders, state.grnLines],
  );
  const orderProgress = useMemo(
    () => deriveOrderProgress(state.orders, state.dispatchSlips),
    [state.orders, state.dispatchSlips],
  );

  const api_ = useMemo<FlowApi>(() => {
    const action =
      <K extends ActionName>(name: K): Mutation<K> =>
      (...args) =>
        send(`/actions/${name}`, args);

    const reset =
      (op: "load" | "clear") =>
      async (password: string, confirm: string): Promise<ResetResult> => {
        if (inFlight.current) return { ok: false, error: "Another save is still running — try again." };
        inFlight.current = true;
        setBusy(true);
        try {
          const r = await api<FullResponse & { snapshotId: number }>("POST", `/demo/${op}`, { password, confirm });
          applyFull(r);
          setEpoch((e) => e + 1);
          setError(null);
          return { ok: true, snapshotId: r.snapshotId };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "Reset failed." };
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      };

    const hasData =
      state.gateEntries.length > 0 ||
      state.grnLines.length > 0 ||
      state.requisitions.length > 0 ||
      state.fgTransfers.length > 0 ||
      state.dispatchSlips.length > 0 ||
      state.purchaseOrders.length > 0 ||
      Object.keys(state.openings).length > 0;

    return {
      state,
      pmStock,
      fgStock,
      poProgress,
      orderProgress,
      shortList,
      suppliers,
      masters,
      epoch,
      hasData,
      loaded,
      busy,
      error,
      dismissError: () => setError(null),
      reload: refresh,
      addGateEntry: action("addGateEntry"),
      addGrnLine: action("addGrnLine"),
      updateGrnQty: action("updateGrnQty"),
      sendToQc: action("sendToQc"),
      recordAr: action("recordAr"),
      setBarcoded: action("setBarcoded"),
      addRequisition: action("addRequisition"),
      issueRequisition: action("issueRequisition"),
      addMrn: action("addMrn"),
      addFgTransfer: action("addFgTransfer"),
      receiveFgTransfer: action("receiveFgTransfer"),
      recordPdi: action("recordPdi"),
      addOrder: action("addOrder"),
      addDispatch: action("addDispatch"),
      addInvoice: action("addInvoice"),
      gateOut: action("gateOut"),
      addIndent: action("addIndent"),
      raisePo: action("raisePo"),
      approvePo: action("approvePo"),
      clearAll: reset("clear"),
      loadDemo: reset("load"),
      traceBatch: (batchNo) => traceBatchOf(state, batchNo),
      traceGrn: (grnNo) => traceGrnOf(state, grnNo),
    };
  }, [state, pmStock, fgStock, poProgress, orderProgress, shortList, suppliers, masters, epoch, loaded, busy, error, send, applyFull, refresh]);

  return <Ctx.Provider value={api_}>{children}</Ctx.Provider>;
}
