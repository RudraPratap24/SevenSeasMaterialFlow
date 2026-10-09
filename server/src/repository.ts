/**
 * The only code that talks SQL about registers.
 *
 * Storage is relational: every fact lives once, in one typed column of one table,
 * and documents refer to masters by key (component code, product id, supplier id,
 * customer id, batch id). Names are never copied into documents, so a rename in a
 * master is instantly true on every document; the derived values (QC status,
 * requisition/transfer/PO status, line totals, stock) are computed, not stored.
 *
 * `loadState` joins the tables into the FlowState shape the shared business rules
 * and the screens use — JSON exists only on the way out of the API.
 * `persistChanges` writes back exactly what an action changed, as rows, inside
 * the action's transaction, so every action is atomic, consistent, isolated
 * (serialised by the write lock) and durable (InnoDB).
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { DOC_COLLECTIONS, emptyState, FlowError, formatNo, SERIES, type DocCollection, type Series } from "../../src/flow/logic";
import type {
  ArRecord,
  BomLine,
  ComponentInfo,
  CustOrder,
  DispatchSlip,
  FgTransfer,
  FlowState,
  GateEntry,
  GrnLine,
  Indent,
  Mrn,
  PdiRecord,
  ProductMaster,
  PurchaseOrder,
  QcIntimation,
  Requisition,
  Supplier,
} from "../../src/flow/types";
import { blindIndex, decryptValue, encryptValue } from "./crypto";
import type { Conn, Queryable } from "./db";
import { HEADER } from "./tables";

type Row = RowDataPacket & Record<string, unknown>;

/* ── value conversions at the boundary ──────────────────────────────────────── */

/** "dd-mm-yyyy" → "yyyy-mm-dd"; anything else → NULL. */
export function toSqlDate(label: string | null | undefined): string | null {
  const m = (label ?? "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
/** "yyyy-mm-dd[ …]" → "dd-mm-yyyy"; NULL → "". */
function fromSqlDate(v: unknown): string {
  const m = typeof v === "string" ? v.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}
function toSqlTime(hhmm: string | null | undefined): string | null {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm ?? "") ? `${hhmm}:00` : null;
}
function fromSqlTime(v: unknown): string {
  return typeof v === "string" && v.length >= 5 ? v.slice(0, 5) : "";
}
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const sealed = (v: string | null | undefined): string | null => (v ? encryptValue(v) : null);
const opened = (v: unknown): string => (typeof v === "string" && v ? decryptValue<string>(v) : "");

function groupBy<T extends Row>(rows: T[], key: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(r[key]);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

async function rows(db: Queryable, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [r] = await db.query<Row[]>(sql, params);
  return r;
}

/* ── masters ────────────────────────────────────────────────────────────────── */

export interface ProductRecord extends ProductMaster {
  id: number;
}

export interface MasterData {
  version: number;
  components: ComponentInfo[];
  products: ProductRecord[];
  bom: Record<string, BomLine[]>;
  componentByCode: Map<string, ComponentInfo>;
  productByName: Map<string, ProductRecord>;
}

export async function getMastersVersion(db: Queryable): Promise<number> {
  const r = await rows(db, "SELECT v FROM app_meta WHERE k = 'masters_version'");
  return Number(r[0]?.v ?? 0);
}

export async function loadMasters(db: Queryable): Promise<MasterData> {
  const version = await getMastersVersion(db);
  const components = (await rows(db, "SELECT code, name, type FROM components WHERE active = 1 ORDER BY code")).map(
    (r) => ({ code: str(r.code), name: str(r.name), type: str(r.type) }),
  );
  const products = (
    await rows(db, "SELECT id, name, fg_code, vendor, box_size FROM products WHERE active = 1 ORDER BY id")
  ).map((r) => ({ id: num(r.id), name: str(r.name), fg: str(r.fg_code), vendor: str(r.vendor), boxSize: numOrNull(r.box_size) }));
  const bomRows = await rows(
    db,
    `SELECT p.name AS product, b.component_code, c.name AS component, b.per_100
       FROM bom_lines b JOIN products p ON p.id = b.product_id JOIN components c ON c.code = b.component_code
      ORDER BY p.id, b.component_code`,
  );
  const bom: Record<string, BomLine[]> = {};
  for (const r of bomRows) {
    (bom[str(r.product)] ??= []).push({ n: str(r.component), c: str(r.component_code), p: Number(r.per_100) });
  }
  return {
    version,
    components,
    products,
    bom,
    componentByCode: new Map(components.map((c) => [c.code, c])),
    productByName: new Map(products.map((p) => [p.name, p])),
  };
}

/* ── read: tables → FlowState ───────────────────────────────────────────────── */

/** A WHERE condition on a register's header table (alias `h`). */
export interface Cond {
  sql: string;
  params: unknown[];
}

/**
 * Which part of the registers to load. `"all"` = everything; otherwise only the
 * registers named, each restricted by its condition (indexed columns) — an action
 * loads just the documents its rule needs, and a screen just what changed.
 */
export type Slice =
  | "all"
  | (Partial<Record<DocCollection, Cond>> & {
      /** Component codes whose opening/minimum level to load. */
      stockCodes?: string[];
    });

const ALL: Cond = { sql: "1 = 1", params: [] };

function condFor(slice: Slice, c: DocCollection): Cond | null {
  if (slice === "all") return ALL;
  return slice[c] ?? null;
}

/** Child rows of the loaded documents only. */
async function linesOf(db: Queryable, sql: string, keys: string[], groupKey: string): Promise<Map<string, Row[]>> {
  if (keys.length === 0) return new Map();
  return groupBy(await rows(db, sql, [keys]), groupKey);
}

export async function loadState(db: Queryable, slice: Slice = "all"): Promise<FlowState> {
  const s = emptyState();
  const header = async (c: DocCollection, sql: string): Promise<Row[]> => {
    const cond = condFor(slice, c);
    if (!cond) return [];
    return rows(db, sql.replace("/*WHERE*/", `WHERE (${cond.sql})`), cond.params);
  };

  if (slice === "all" || (slice.stockCodes && slice.stockCodes.length > 0)) {
    const levels =
      slice === "all"
        ? await rows(db, "SELECT component_code, opening_qty, min_level FROM stock_settings")
        : await rows(db, "SELECT component_code, opening_qty, min_level FROM stock_settings WHERE component_code IN (?)", [
            slice.stockCodes,
          ]);
    for (const r of levels) {
      if (r.opening_qty !== null) s.openings[str(r.component_code)] = num(r.opening_qty);
      if (r.min_level !== null) s.minLevels[str(r.component_code)] = num(r.min_level);
    }
  }

  /* purchase */
  s.indents = (
    await header(
      "indents",
      `SELECT h.indent_no, h.indent_date, h.component_code, c.name AS component, h.qty, h.reason, h.po_no
         FROM purchase_indents h JOIN components c ON c.code = h.component_code /*WHERE*/ ORDER BY h.seq`,
    )
  ).map(
    (r): Indent => ({
      id: str(r.indent_no),
      date: fromSqlDate(r.indent_date),
      componentCode: str(r.component_code),
      componentName: str(r.component),
      qty: num(r.qty),
      reason: str(r.reason),
      status: r.po_no ? "PO_RAISED" : "OPEN",
    }),
  );
  const poRows = await header(
    "purchaseOrders",
    `SELECT h.po_no, h.po_date, s.name AS supplier, h.expected_date, h.approved_by, u.label AS approver,
            (SELECT GROUP_CONCAT(x.indent_no ORDER BY x.seq) FROM purchase_indents x WHERE x.po_no = h.po_no) AS indent_ids
       FROM purchase_orders h JOIN suppliers s ON s.id = h.supplier_id
       LEFT JOIN users u ON u.id = h.approved_by /*WHERE*/ ORDER BY h.seq`,
  );
  const poLines = await linesOf(
    db,
    `SELECT l.po_no, l.component_code, c.name AS component, l.qty, l.rate_enc
       FROM purchase_order_lines l JOIN components c ON c.code = l.component_code
      WHERE l.po_no IN (?) ORDER BY l.po_no, l.line_no`,
    poRows.map((r) => str(r.po_no)),
    "po_no",
  );
  s.purchaseOrders = poRows.map(
    (r): PurchaseOrder => ({
      id: str(r.po_no),
      date: fromSqlDate(r.po_date),
      supplierName: str(r.supplier),
      lines: (poLines.get(str(r.po_no)) ?? []).map((l) => ({
        componentCode: str(l.component_code),
        componentName: str(l.component),
        qty: num(l.qty),
        rate: l.rate_enc ? Number(opened(l.rate_enc)) : null,
      })),
      expectedDate: fromSqlDate(r.expected_date),
      status: r.approved_by !== null ? "APPROVED" : "PENDING_APPROVAL",
      approvedBy: str(r.approver),
      indentIds: r.indent_ids ? str(r.indent_ids).split(",") : [],
    }),
  );

  /* inward */
  s.gateEntries = (
    await header(
      "gateEntries",
      "SELECT h.*, s.name AS supplier FROM gate_entries h JOIN suppliers s ON s.id = h.supplier_id /*WHERE*/ ORDER BY h.seq",
    )
  ).map(
    (r): GateEntry => ({
      id: str(r.gate_entry_no),
      date: fromSqlDate(r.entry_date),
      supplierName: str(r.supplier),
      productDesc: str(r.product_desc),
      invoiceNo: str(r.invoice_no),
      invoiceDate: fromSqlDate(r.invoice_date),
      poNo: str(r.po_no ?? r.external_po_ref),
      invoiceQty: numOrNull(r.invoice_qty),
      transportName: str(r.transport_name),
      lrNo: opened(r.lr_no_enc),
      vehicleNo: opened(r.vehicle_no_enc),
      timeIn: fromSqlTime(r.time_in),
      timeOut: fromSqlTime(r.time_out),
      driverSign: num(r.driver_signed) === 1,
      remark: str(r.remark),
    }),
  );
  s.grnLines = (
    await header(
      "grnLines",
      `SELECT h.*, c.name AS component, c.type AS ctype, g.po_no, g.external_po_ref, g.invoice_no,
              s.name AS supplier, loc.name AS location, v.qc_status
         FROM goods_receipts h
         JOIN components c ON c.code = h.component_code
         JOIN gate_entries g ON g.gate_entry_no = h.gate_entry_no
         JOIN suppliers s ON s.id = g.supplier_id
         JOIN v_grn_qc_status v ON v.grn_no = h.grn_no
         LEFT JOIN locations loc ON loc.id = h.location_id
        /*WHERE*/ ORDER BY h.seq`,
    )
  ).map(
    (r): GrnLine => ({
      grnNo: str(r.grn_no),
      gateEntryId: str(r.gate_entry_no),
      componentCode: str(r.component_code),
      componentName: str(r.component),
      type: str(r.ctype),
      brandName: str(r.brand_name),
      receivedDate: fromSqlDate(r.received_date),
      poNo: str(r.po_no ?? r.external_po_ref),
      poQty: numOrNull(r.po_qty),
      invoiceNo: str(r.invoice_no),
      supplierName: str(r.supplier),
      qtyPerBox: numOrNull(r.qty_per_box),
      totalBoxes: numOrNull(r.total_boxes),
      totalQty: num(r.total_qty),
      remarkStore: str(r.remark_store),
      location: str(r.location),
      qcStatus: r.qc_status as GrnLine["qcStatus"],
      barcoded: num(r.barcoded) === 1,
    }),
  );
  s.qcIntimations = (
    await header(
      "qcIntimations",
      `SELECT h.*, r.component_code, c.name AS component, s.name AS supplier, g.invoice_no, r.total_qty, r.total_boxes
         FROM qc_intimations h
         JOIN goods_receipts r ON r.grn_no = h.grn_no
         JOIN components c ON c.code = r.component_code
         JOIN gate_entries g ON g.gate_entry_no = r.gate_entry_no
         JOIN suppliers s ON s.id = g.supplier_id
        /*WHERE*/ ORDER BY h.seq`,
    )
  ).map(
    (r): QcIntimation => ({
      id: str(r.intimation_no),
      date: fromSqlDate(r.issued_on),
      timeOfIssue: fromSqlTime(r.issued_time),
      grnNo: str(r.grn_no),
      productName: str(r.component),
      code: str(r.component_code),
      supplierName: str(r.supplier),
      invoiceNo: str(r.invoice_no),
      batchNo: str(r.batch_no),
      mfgDate: str(r.mfg_date),
      expiryDate: str(r.expiry_date),
      totalQty: num(r.total_qty),
      totalBox: numOrNull(r.total_boxes),
      remark: str(r.remark),
    }),
  );
  s.arRecords = (await header("arRecords", "SELECT h.* FROM qc_results h /*WHERE*/ ORDER BY h.seq")).map(
    (r): ArRecord => ({
      arNo: str(r.ar_no),
      intimationId: str(r.intimation_no),
      date: fromSqlDate(r.decided_on),
      status: r.status as ArRecord["status"],
      remark: str(r.remark),
    }),
  );

  /* production */
  const mrnRows = await header("mrns", "SELECT h.* FROM material_returns h /*WHERE*/ ORDER BY h.seq");
  const mrnLines = await linesOf(
    db,
    `SELECT l.mrn_no, l.component_code, c.name AS component, l.qty
       FROM material_return_lines l JOIN components c ON c.code = l.component_code
      WHERE l.mrn_no IN (?) ORDER BY l.mrn_no, l.line_no`,
    mrnRows.map((r) => str(r.mrn_no)),
    "mrn_no",
  );
  s.mrns = mrnRows.map(
    (r): Mrn => ({
      id: str(r.mrn_no),
      date: fromSqlDate(r.mrn_date),
      requisitionId: str(r.req_no),
      lines: (mrnLines.get(str(r.mrn_no)) ?? []).map((l) => ({
        componentCode: str(l.component_code),
        componentName: str(l.component),
        qty: num(l.qty),
      })),
      sign: str(r.sign),
      remark: str(r.remark),
    }),
  );
  const reqRows = await header(
    "requisitions",
    `SELECT h.*, p.name AS product, b.batch_no FROM requisitions h
       LEFT JOIN products p ON p.id = h.product_id
       LEFT JOIN production_batches b ON b.id = h.batch_id
      /*WHERE*/ ORDER BY h.seq`,
  );
  const reqLines = await linesOf(
    db,
    // "Return material" on the slip = what the MRNs against it returned (computed, not stored).
    `SELECT l.*, c.name AS component,
            (SELECT SUM(ml.qty) FROM material_return_lines ml JOIN material_returns m ON m.mrn_no = ml.mrn_no
              WHERE m.req_no = l.req_no AND ml.component_code = l.component_code) AS returned
       FROM requisition_lines l JOIN components c ON c.code = l.component_code
      WHERE l.req_no IN (?) ORDER BY l.req_no, l.line_no`,
    reqRows.map((r) => str(r.req_no)),
    "req_no",
  );
  s.requisitions = reqRows.map(
    (r): Requisition => ({
      id: str(r.req_no),
      date: fromSqlDate(r.req_date),
      department: str(r.department),
      productName: str(r.product),
      batchNo: str(r.batch_no),
      lines: (reqLines.get(str(r.req_no)) ?? []).map((l) => ({
        materialName: str(l.component),
        materialCode: str(l.component_code),
        unit: str(l.unit),
        qtyRequired: num(l.qty_required),
        qtyIssued: numOrNull(l.qty_issued),
        returnQty: numOrNull(l.returned),
        remark: str(l.remark),
      })),
      packingSign: str(r.packing_sign),
      storeSign: str(r.store_sign),
      status: r.issued_at !== null ? "ISSUED" : "PENDING",
    }),
  );

  /* finished goods */
  const fgRows = await header(
    "fgTransfers",
    "SELECT h.*, loc.name AS location FROM fg_transfers h LEFT JOIN locations loc ON loc.id = h.location_id /*WHERE*/ ORDER BY h.seq",
  );
  const fgLines = await linesOf(
    db,
    `SELECT l.*, p.name AS product, p.fg_code, b.batch_no FROM fg_transfer_lines l
       JOIN production_batches b ON b.id = l.batch_id JOIN products p ON p.id = b.product_id
      WHERE l.transfer_no IN (?) ORDER BY l.transfer_no, l.line_no`,
    fgRows.map((r) => str(r.transfer_no)),
    "transfer_no",
  );
  s.fgTransfers = fgRows.map(
    (r): FgTransfer => ({
      id: str(r.transfer_no),
      date: fromSqlDate(r.transfer_date),
      lines: (fgLines.get(str(r.transfer_no)) ?? []).map((l) => ({
        productCode: str(l.fg_code),
        productName: str(l.product),
        sku: str(l.fg_code),
        batchNo: str(l.batch_no),
        mfgDate: str(l.mfg_month),
        qtyPerBox: num(l.qty_per_box),
        totalBoxes: num(l.total_boxes),
        looseQty: num(l.loose_qty),
        totalQty: num(l.total_qty),
        remark: str(l.remark),
      })),
      submittedBy: str(r.submitted_by),
      checkedBy: str(r.checked_by),
      location: str(r.location),
      status: r.received_on !== null ? "RECEIVED" : "IN_TRANSIT",
      receivedDate: fromSqlDate(r.received_on),
    }),
  );
  s.pdiRecords = (
    await header(
      "pdiRecords",
      `SELECT h.*, p.name AS product, b.batch_no FROM pdi_records h
         JOIN production_batches b ON b.id = h.batch_id JOIN products p ON p.id = b.product_id /*WHERE*/ ORDER BY h.seq`,
    )
  ).map(
    (r): PdiRecord => ({
      id: str(r.pdi_no),
      date: fromSqlDate(r.pdi_date),
      productName: str(r.product),
      batchNo: str(r.batch_no),
      status: r.status as PdiRecord["status"],
      remark: str(r.remark),
    }),
  );

  /* sales + dispatch */
  const orderRows = await header("orders", "SELECT h.* FROM customer_orders h /*WHERE*/ ORDER BY h.seq");
  const slipRows = await header(
    "dispatchSlips",
    "SELECT h.*, DATE_FORMAT(h.gate_out_at, '%H:%i') AS gate_out_time FROM dispatch_slips h /*WHERE*/ ORDER BY h.seq",
  );
  const customerIds = [...new Set([...orderRows, ...slipRows].map((r) => num(r.customer_id)))];
  const customers = new Map<number, { name: string; address: string }>();
  if (customerIds.length > 0) {
    for (const r of await rows(db, "SELECT id, name_enc, address_enc FROM customers WHERE id IN (?)", [customerIds])) {
      customers.set(num(r.id), { name: opened(r.name_enc), address: opened(r.address_enc) });
    }
  }
  const orderLines = await linesOf(
    db,
    `SELECT l.*, p.name AS product, p.fg_code FROM order_lines l JOIN products p ON p.id = l.product_id
      WHERE l.order_no IN (?) ORDER BY l.order_no, l.line_no`,
    orderRows.map((r) => str(r.order_no)),
    "order_no",
  );
  s.orders = orderRows.map(
    (r): CustOrder => ({
      id: str(r.order_no),
      date: fromSqlDate(r.order_date),
      partyName: customers.get(num(r.customer_id))?.name ?? "",
      partyAddress: customers.get(num(r.customer_id))?.address ?? "",
      custPoNo: opened(r.cust_po_no_enc),
      deliveryDate: fromSqlDate(r.delivery_date),
      lines: (orderLines.get(str(r.order_no)) ?? []).map((l) => ({
        productName: str(l.product),
        productCode: str(l.fg_code),
        qty: num(l.qty),
      })),
      remark: str(r.remark),
    }),
  );
  const dispatchLines = await linesOf(
    db,
    `SELECT l.*, p.name AS product, p.fg_code, b.batch_no FROM dispatch_lines l
       JOIN production_batches b ON b.id = l.batch_id JOIN products p ON p.id = b.product_id
      WHERE l.dispatch_no IN (?) ORDER BY l.dispatch_no, l.line_no`,
    slipRows.map((r) => str(r.dispatch_no)),
    "dispatch_no",
  );
  s.dispatchSlips = slipRows.map(
    (r): DispatchSlip => ({
      id: str(r.dispatch_no),
      date: fromSqlDate(r.dispatch_date),
      partyName: customers.get(num(r.customer_id))?.name ?? "",
      partyAddress: customers.get(num(r.customer_id))?.address ?? "",
      orderId: str(r.order_no),
      lines: (dispatchLines.get(str(r.dispatch_no)) ?? []).map((l) => ({
        productName: str(l.product),
        productCode: str(l.fg_code),
        batchNo: str(l.batch_no),
        qtyPerBox: num(l.qty_per_box),
        totalBoxes: num(l.total_boxes),
        totalQty: num(l.total_qty),
      })),
      dispatchSign: str(r.dispatch_sign),
      securitySign: str(r.security_sign),
      invoiceNo: opened(r.invoice_no_enc),
      invoiceDate: fromSqlDate(r.invoice_date),
      gateOut: r.gate_out_at !== null,
      gateOutTime: str(r.gate_out_time),
      remark: str(r.remark),
    }),
  );

  return s;
}

/** Every document changed after `since` (the change number a screen last saw). */
export function changedSince(since: number): Slice {
  const cond: Cond = { sql: "h.row_version > ?", params: [since] };
  return Object.fromEntries(DOC_COLLECTIONS.map((c) => [c, cond])) as Slice;
}

export interface Versions {
  /** Last committed change number. */
  version: number;
  /** Bumped when every screen must reload everything (reset, restore, customer edit). */
  resyncVersion: number;
}

export async function getVersions(db: Queryable): Promise<Versions> {
  const r = await rows(db, "SELECT k, v FROM app_meta WHERE k IN ('state_version', 'resync_version')");
  const get = (k: string) => Number(r.find((x) => x.k === k)?.v ?? 0);
  return { version: get("state_version"), resyncVersion: get("resync_version") };
}

/**
 * Reads, in ONE consistent snapshot, the versions and the requested slice — so the
 * version handed to a screen exactly describes the data handed with it.
 */
export async function loadConsistent(conn: Conn, slice: Slice): Promise<Versions & { state: FlowState }> {
  await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  try {
    const v = await getVersions(conn);
    return { ...v, state: await loadState(conn, slice) };
  } finally {
    await conn.query("COMMIT");
  }
}

export async function getVersion(db: Queryable): Promise<number> {
  const r = await rows(db, "SELECT v FROM app_meta WHERE k = 'state_version'");
  return Number(r[0]?.v ?? 0);
}

/* ── write: FlowState changes → rows ────────────────────────────────────────── */

/** Integrity failure inside the server (a bug), never shown to users verbatim. */
class ConsistencyError extends Error {}

/**
 * Resolves names to keys inside the running transaction. Suppliers, customers,
 * batches and locations a document names for the first time are created here —
 * as part of the same transaction, so they exist only if the document does.
 */
class Resolver {
  private suppliers = new Map<string, number>();
  private products = new Map<string, number>();
  private customers = new Map<string, number>();
  private batches = new Map<string, number>();
  private locations = new Map<string, number | null>();
  private users = new Map<string, number | null>();

  constructor(
    private conn: Conn,
    private actorId: number | null,
  ) {}

  private async insertId(sql: string, params: unknown[]): Promise<number> {
    const [r] = await this.conn.execute<ResultSetHeader>(sql, params as never[]);
    return r.insertId;
  }

  async supplier(name: string): Promise<number> {
    const key = name.trim().toLowerCase();
    const hit = this.suppliers.get(key);
    if (hit) return hit;
    const found = await rows(this.conn, "SELECT id FROM suppliers WHERE name = ?", [name.trim()]);
    // A supplier not on the approved list yet (direct arrival) is recorded, unapproved.
    const id = found[0]
      ? num(found[0].id)
      : await this.insertId("INSERT INTO suppliers (name, city, approved) VALUES (?, '', 0)", [name.trim()]);
    this.suppliers.set(key, id);
    return id;
  }

  async product(name: string): Promise<number> {
    const hit = this.products.get(name);
    if (hit) return hit;
    const found = await rows(this.conn, "SELECT id FROM products WHERE name = ?", [name]);
    if (!found[0]) throw new FlowError(`"${name}" is not a known product.`);
    this.products.set(name, num(found[0].id));
    return num(found[0].id);
  }

  async batch(productName: string, batchNo: string): Promise<number> {
    const key = `${productName}::${batchNo.trim()}`;
    const hit = this.batches.get(key);
    if (hit) return hit;
    const productId = await this.product(productName);
    const found = await rows(this.conn, "SELECT id FROM production_batches WHERE product_id = ? AND batch_no = ?", [
      productId,
      batchNo.trim(),
    ]);
    const id = found[0]
      ? num(found[0].id)
      : await this.insertId("INSERT INTO production_batches (product_id, batch_no) VALUES (?, ?)", [productId, batchNo.trim()]);
    this.batches.set(key, id);
    return id;
  }

  async location(name: string): Promise<number | null> {
    const clean = name.trim();
    if (!clean) return null;
    if (this.locations.has(clean)) return this.locations.get(clean)!;
    const found = await rows(this.conn, "SELECT id FROM locations WHERE name = ?", [clean]);
    const id = found[0] ? num(found[0].id) : await this.insertId("INSERT INTO locations (name) VALUES (?)", [clean]);
    this.locations.set(clean, id);
    return id;
  }

  /** Finds a customer by its blind index; a first order/dispatch creates the customer. */
  async customer(name: string, address: string): Promise<number> {
    const hash = blindIndex(name);
    const hit = this.customers.get(hash);
    if (hit) return hit;
    const found = await rows(this.conn, "SELECT id, address_enc FROM customers WHERE name_hash = ?", [hash]);
    let id: number;
    if (found[0]) {
      id = num(found[0].id);
      // Fill in an address the master did not have yet; an existing address is master data.
      if (!found[0].address_enc && address.trim()) {
        await this.conn.execute("UPDATE customers SET address_enc = ? WHERE id = ?", [sealed(address.trim()), id]);
      }
    } else {
      id = await this.insertId("INSERT INTO customers (name_enc, name_hash, address_enc) VALUES (?, ?, ?)", [
        encryptValue(name.trim()),
        hash,
        sealed(address.trim()),
      ]);
    }
    this.customers.set(hash, id);
    return id;
  }

  /** The account behind an approval: the acting user; for imported history, matched by label, else the admin. */
  async approver(label: string): Promise<number | null> {
    if (this.actorId !== null) return this.actorId;
    if (this.users.has(label)) return this.users.get(label)!;
    const found =
      (await rows(this.conn, "SELECT id FROM users WHERE label = ? LIMIT 1", [label]))[0] ??
      (await rows(this.conn, "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"))[0];
    const id = found ? num(found.id) : null;
    this.users.set(label, id);
    return id;
  }
}

/** Registers in dependency order — parents are written before the rows that reference them. */
const DOC_ORDER = [
  "purchaseOrders",
  "indents",
  "gateEntries",
  "grnLines",
  "qcIntimations",
  "arRecords",
  "requisitions",
  "mrns",
  "fgTransfers",
  "pdiRecords",
  "orders",
  "dispatchSlips",
] as const;
type DocKey = (typeof DOC_ORDER)[number];

const KEY_OF: Record<DocKey, (d: never) => string> = {
  purchaseOrders: (d: PurchaseOrder) => d.id,
  indents: (d: Indent) => d.id,
  gateEntries: (d: GateEntry) => d.id,
  grnLines: (d: GrnLine) => d.grnNo,
  qcIntimations: (d: QcIntimation) => d.id,
  arRecords: (d: ArRecord) => d.arNo,
  requisitions: (d: Requisition) => d.id,
  mrns: (d: Mrn) => d.id,
  fgTransfers: (d: FgTransfer) => d.id,
  pdiRecords: (d: PdiRecord) => d.id,
  orders: (d: CustOrder) => d.id,
  dispatchSlips: (d: DispatchSlip) => d.id,
};

export function countDocuments(state: FlowState): number {
  return DOC_ORDER.reduce((n, c) => n + state[c].length, 0);
}

/** Children first: the order rows must be deleted in for a full replace. */
const DELETE_ORDER = [
  "dispatch_lines",
  "dispatch_slips",
  "order_lines",
  "customer_orders",
  "pdi_records",
  "fg_transfer_lines",
  "fg_transfers",
  "material_return_lines",
  "material_returns",
  "requisition_lines",
  "requisitions",
  "qc_results",
  "qc_intimations",
  "goods_receipts",
  "gate_entries",
  "purchase_indents",
  "purchase_order_lines",
  "purchase_orders",
  "stock_settings",
  "production_batches",
  "customers",
  "locations",
];

class Writer {
  constructor(
    private conn: Conn,
    private r: Resolver,
    private by: number | null,
    /** True when importing history (demo load, migration, restore) rather than acting now. */
    private bulk: boolean,
    private after: FlowState,
  ) {}

  private async exec(sql: string, params: unknown[]): Promise<void> {
    await this.conn.execute(sql, params as never[]);
  }

  /**
   * When something happened: now (database clock, factory time zone) for a live
   * action; for imported history, the document's own date.
   */
  private when(docDate: string): { sql: string; params: unknown[] } {
    const day = toSqlDate(docDate);
    return this.bulk && day ? { sql: "TIMESTAMP(?)", params: [day] } : { sql: "NOW(3)", params: [] };
  }

  /* inserts */

  async purchaseOrders(d: PurchaseOrder) {
    const approved = d.status === "APPROVED";
    const at = this.when(d.date);
    await this.exec(
      `INSERT INTO purchase_orders (po_no, po_date, supplier_id, expected_date, approved_by, approved_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ${approved ? at.sql : "NULL"}, ?, ?)`,
      [
        d.id,
        toSqlDate(d.date),
        await this.r.supplier(d.supplierName),
        toSqlDate(d.expectedDate),
        approved ? await this.r.approver(d.approvedBy) : null,
        ...(approved ? at.params : []),
        this.by,
        this.by,
      ],
    );
    let n = 0;
    for (const l of d.lines) {
      await this.exec(
        "INSERT INTO purchase_order_lines (po_no, line_no, component_code, qty, rate_enc) VALUES (?, ?, ?, ?, ?)",
        [d.id, ++n, l.componentCode, l.qty, l.rate === null ? null : encryptValue(String(l.rate))],
      );
    }
  }

  private poOfIndent(id: string): string | null {
    return this.after.purchaseOrders.find((p) => p.indentIds.includes(id))?.id ?? null;
  }

  async indents(d: Indent) {
    await this.exec(
      `INSERT INTO purchase_indents (indent_no, indent_date, component_code, qty, reason, po_no, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.id, toSqlDate(d.date), d.componentCode, d.qty, d.reason, d.status === "PO_RAISED" ? this.poOfIndent(d.id) : null, this.by, this.by],
    );
  }

  async gateEntries(d: GateEntry) {
    const inSystem = d.poNo !== "" && this.after.purchaseOrders.some((p) => p.id === d.poNo);
    await this.exec(
      `INSERT INTO gate_entries (gate_entry_no, entry_date, supplier_id, product_desc, invoice_no, invoice_date, invoice_qty,
         po_no, external_po_ref, transport_name, lr_no_enc, vehicle_no_enc, time_in, time_out, driver_signed, remark,
         created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.id,
        toSqlDate(d.date),
        await this.r.supplier(d.supplierName),
        d.productDesc,
        d.invoiceNo,
        toSqlDate(d.invoiceDate),
        d.invoiceQty,
        inSystem ? d.poNo : null,
        !inSystem && d.poNo ? d.poNo : null,
        d.transportName,
        sealed(d.lrNo),
        sealed(d.vehicleNo),
        toSqlTime(d.timeIn),
        toSqlTime(d.timeOut),
        d.driverSign ? 1 : 0,
        d.remark,
        this.by,
        this.by,
      ],
    );
  }

  async grnLines(d: GrnLine) {
    // The GRN carries supplier, invoice and PO only through its gate entry — refuse a disagreeing copy.
    const gate = this.after.gateEntries.find((g) => g.id === d.gateEntryId);
    if (!gate) throw new FlowError(`Gate entry ${d.gateEntryId} not found.`);
    if (gate.supplierName !== d.supplierName || gate.invoiceNo !== d.invoiceNo || gate.poNo !== d.poNo) {
      throw new ConsistencyError(`GRN ${d.grnNo}: supplier/invoice/PO differ from gate entry ${gate.id}`);
    }
    await this.exec(
      `INSERT INTO goods_receipts (grn_no, gate_entry_no, component_code, brand_name, received_date, po_qty, qty_per_box,
         total_boxes, total_qty, location_id, barcoded, remark_store, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.grnNo,
        d.gateEntryId,
        d.componentCode,
        d.brandName,
        toSqlDate(d.receivedDate),
        d.poQty,
        d.qtyPerBox,
        d.totalBoxes,
        d.totalQty,
        await this.r.location(d.location),
        d.barcoded ? 1 : 0,
        d.remarkStore,
        this.by,
        this.by,
      ],
    );
  }

  async qcIntimations(d: QcIntimation) {
    const grn = this.after.grnLines.find((g) => g.grnNo === d.grnNo);
    if (!grn || grn.totalQty !== d.totalQty) {
      throw new ConsistencyError(`QC slip ${d.id}: quantity differs from GRN ${d.grnNo}`);
    }
    await this.exec(
      `INSERT INTO qc_intimations (intimation_no, grn_no, issued_on, issued_time, batch_no, mfg_date, expiry_date, remark,
         created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.id, d.grnNo, toSqlDate(d.date), toSqlTime(d.timeOfIssue), d.batchNo, d.mfgDate, d.expiryDate, d.remark, this.by, this.by],
    );
  }

  async arRecords(d: ArRecord) {
    await this.exec(
      "INSERT INTO qc_results (ar_no, intimation_no, decided_on, status, remark, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [d.arNo, d.intimationId, toSqlDate(d.date), d.status, d.remark, this.by, this.by],
    );
  }

  async requisitions(d: Requisition) {
    if (d.batchNo && !d.productName) throw new FlowError("A batch needs its product.");
    const issued = d.status === "ISSUED";
    const at = this.when(d.date);
    await this.exec(
      `INSERT INTO requisitions (req_no, req_date, department, product_id, batch_id, packing_sign, store_sign, issued_at,
         issued_by, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${issued ? at.sql : "NULL"}, ?, ?, ?)`,
      [
        d.id,
        toSqlDate(d.date),
        d.department,
        d.productName ? await this.r.product(d.productName) : null,
        d.batchNo ? await this.r.batch(d.productName, d.batchNo) : null,
        d.packingSign,
        d.storeSign,
        ...(issued ? at.params : []),
        issued ? this.by : null,
        this.by,
        this.by,
      ],
    );
    let n = 0;
    for (const l of d.lines) {
      await this.exec(
        `INSERT INTO requisition_lines (req_no, line_no, component_code, unit, qty_required, qty_issued, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [d.id, ++n, l.materialCode, l.unit, l.qtyRequired, l.qtyIssued, l.remark],
      );
    }
  }

  async mrns(d: Mrn) {
    await this.exec(
      "INSERT INTO material_returns (mrn_no, mrn_date, req_no, sign, remark, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [d.id, toSqlDate(d.date), d.requisitionId, d.sign, d.remark, this.by, this.by],
    );
    let n = 0;
    for (const l of d.lines) {
      await this.exec("INSERT INTO material_return_lines (mrn_no, line_no, component_code, qty) VALUES (?, ?, ?, ?)", [
        d.id,
        ++n,
        l.componentCode,
        l.qty,
      ]);
    }
  }

  async fgTransfers(d: FgTransfer) {
    const received = d.status === "RECEIVED";
    await this.exec(
      `INSERT INTO fg_transfers (transfer_no, transfer_date, submitted_by, checked_by, location_id, received_on, received_by,
         created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.id,
        toSqlDate(d.date),
        d.submittedBy,
        d.checkedBy,
        await this.r.location(d.location),
        received ? toSqlDate(d.receivedDate) : null,
        received ? this.by : null,
        this.by,
        this.by,
      ],
    );
    let n = 0;
    for (const l of d.lines) {
      if (l.totalQty !== l.qtyPerBox * l.totalBoxes + l.looseQty) {
        throw new ConsistencyError(`FG transfer ${d.id}: total qty does not equal boxes × per box + loose`);
      }
      await this.exec(
        `INSERT INTO fg_transfer_lines (transfer_no, line_no, batch_id, mfg_month, qty_per_box, total_boxes, loose_qty, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, ++n, await this.r.batch(l.productName, l.batchNo), l.mfgDate, l.qtyPerBox, l.totalBoxes, l.looseQty, l.remark],
      );
    }
  }

  async pdiRecords(d: PdiRecord) {
    await this.exec(
      "INSERT INTO pdi_records (pdi_no, pdi_date, batch_id, status, remark, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [d.id, toSqlDate(d.date), await this.r.batch(d.productName, d.batchNo), d.status, d.remark, this.by, this.by],
    );
  }

  async orders(d: CustOrder) {
    await this.exec(
      `INSERT INTO customer_orders (order_no, order_date, customer_id, cust_po_no_enc, delivery_date, remark, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.id,
        toSqlDate(d.date),
        await this.r.customer(d.partyName, d.partyAddress),
        sealed(d.custPoNo),
        toSqlDate(d.deliveryDate),
        d.remark,
        this.by,
        this.by,
      ],
    );
    let n = 0;
    for (const l of d.lines) {
      await this.exec("INSERT INTO order_lines (order_no, line_no, product_id, qty) VALUES (?, ?, ?, ?)", [
        d.id,
        ++n,
        await this.r.product(l.productName),
        l.qty,
      ]);
    }
  }

  async dispatchSlips(d: DispatchSlip) {
    await this.exec(
      `INSERT INTO dispatch_slips (dispatch_no, dispatch_date, order_no, customer_id, dispatch_sign, invoice_no_enc,
         invoice_date, security_sign, gate_out_at, remark, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.id,
        toSqlDate(d.date),
        d.orderId || null,
        await this.r.customer(d.partyName, d.partyAddress),
        d.dispatchSign,
        sealed(d.invoiceNo),
        toSqlDate(d.invoiceDate),
        d.securitySign,
        d.gateOut ? `${toSqlDate(d.date)} ${toSqlTime(d.gateOutTime) ?? "00:00:00"}` : null,
        d.remark,
        this.by,
        this.by,
      ],
    );
    let n = 0;
    for (const l of d.lines) {
      if (l.totalQty !== l.qtyPerBox * l.totalBoxes) {
        throw new ConsistencyError(`Dispatch ${d.id}: total qty does not equal boxes × per box`);
      }
      await this.exec("INSERT INTO dispatch_lines (dispatch_no, line_no, batch_id, qty_per_box, total_boxes) VALUES (?, ?, ?, ?, ?)", [
        d.id,
        ++n,
        await this.r.batch(l.productName, l.batchNo),
        l.qtyPerBox,
        l.totalBoxes,
      ]);
    }
  }

  /* updates — only what the business rules can change; anything else is refused */

  async update(c: DocKey, before: unknown, after: unknown): Promise<void> {
    switch (c) {
      case "grnLines": {
        const a = after as GrnLine;
        await this.exec(
          `UPDATE goods_receipts SET total_qty = ?, barcoded = ?, location_id = ?, remark_store = ?, updated_by = ?
            WHERE grn_no = ?`,
          [a.totalQty, a.barcoded ? 1 : 0, await this.r.location(a.location), a.remarkStore, this.by, a.grnNo],
        );
        return; // qcStatus and the QC slip's qty follow automatically (computed)
      }
      case "qcIntimations":
        return; // its qty/product/supplier are read from the GRN — nothing of its own changes
      case "requisitions": {
        const b = before as Requisition;
        const a = after as Requisition;
        if (a.lines.length !== b.lines.length) throw new ConsistencyError(`Requisition ${a.id}: lines cannot be added or removed`);
        const newlyIssued = b.status !== "ISSUED" && a.status === "ISSUED";
        await this.exec(
          `UPDATE requisitions SET store_sign = ?, ${newlyIssued ? "issued_at = NOW(3), issued_by = ?," : ""} updated_by = ?
            WHERE req_no = ?`,
          [a.storeSign, ...(newlyIssued ? [this.by] : []), this.by, a.id],
        );
        for (let i = 0; i < a.lines.length; i++) {
          if (a.lines[i].qtyIssued !== b.lines[i].qtyIssued || a.lines[i].remark !== b.lines[i].remark) {
            await this.exec("UPDATE requisition_lines SET qty_issued = ?, remark = ? WHERE req_no = ? AND line_no = ?", [
              a.lines[i].qtyIssued,
              a.lines[i].remark,
              a.id,
              i + 1,
            ]);
          }
        }
        return;
      }
      case "fgTransfers": {
        const a = after as FgTransfer;
        const received = a.status === "RECEIVED";
        await this.exec(
          `UPDATE fg_transfers SET checked_by = ?, location_id = ?, received_on = ?, received_by = ?, updated_by = ?
            WHERE transfer_no = ?`,
          [a.checkedBy, await this.r.location(a.location), received ? toSqlDate(a.receivedDate) : null, received ? this.by : null, this.by, a.id],
        );
        return;
      }
      case "dispatchSlips": {
        const b = before as DispatchSlip;
        const a = after as DispatchSlip;
        // Each stage writes only its own fields, once: Accounts the invoice, Security the gate-out.
        if (!b.invoiceNo && a.invoiceNo) {
          await this.exec("UPDATE dispatch_slips SET invoice_no_enc = ?, invoice_date = ?, updated_by = ? WHERE dispatch_no = ?", [
            sealed(a.invoiceNo),
            toSqlDate(a.invoiceDate),
            this.by,
            a.id,
          ]);
        }
        if (!b.gateOut && a.gateOut) {
          await this.exec(
            "UPDATE dispatch_slips SET security_sign = ?, gate_out_at = TIMESTAMP(CURDATE(), ?), updated_by = ? WHERE dispatch_no = ?",
            [a.securitySign, toSqlTime(a.gateOutTime) ?? "00:00:00", this.by, a.id],
          );
        }
        return;
      }
      case "indents": {
        const a = after as Indent;
        await this.exec("UPDATE purchase_indents SET po_no = ?, updated_by = ? WHERE indent_no = ?", [
          a.status === "PO_RAISED" ? this.poOfIndent(a.id) : null,
          this.by,
          a.id,
        ]);
        return;
      }
      case "purchaseOrders": {
        const b = before as PurchaseOrder;
        const a = after as PurchaseOrder;
        if (b.status !== "APPROVED" && a.status === "APPROVED") {
          await this.exec("UPDATE purchase_orders SET approved_by = ?, approved_at = NOW(3), updated_by = ? WHERE po_no = ?", [
            await this.r.approver(a.approvedBy),
            this.by,
            a.id,
          ]);
        }
        return;
      }
      default:
        throw new ConsistencyError(`${c} documents cannot be changed once written`);
    }
  }

  async insert(c: DocKey, doc: unknown): Promise<void> {
    await (this[c] as (d: unknown) => Promise<void>).call(this, doc);
  }
}

/**
 * Writes the difference between `before` and `after` as rows. Unchanged
 * documents are skipped by identity (reducers return the same object for them).
 * `replaceAll` wipes and re-imports every register (demo load, restore, migration).
 */
export async function persistChanges(
  conn: Conn,
  before: FlowState,
  after: FlowState,
  userId: number | null,
  replaceAll = false,
): Promise<number> {
  const writer = new Writer(conn, new Resolver(conn, userId), userId, replaceAll, after);
  let changes = 0;
  /** Documents whose screen copy is now out of date: the ones written, plus those that derive from them. */
  const touched = new Map<DocCollection, Set<string>>();
  const touch = (c: DocCollection, key: string) => {
    let set = touched.get(c);
    if (!set) touched.set(c, (set = new Set()));
    set.add(key);
  };

  if (replaceAll) {
    // Opens the database's no-delete lock for this connection only, for the wipe (see stageLocks.ts).
    await conn.query("SET @flow_reset = 1");
    try {
      for (const table of DELETE_ORDER) await conn.query(`DELETE FROM ${table}`);
    } finally {
      await conn.query("SET @flow_reset = NULL"); // never left open on a pooled connection
    }
    // Suppliers first seen on a document (not on the approved list) go with their documents.
    await conn.query(
      "DELETE FROM suppliers WHERE approved = 0 AND id NOT IN (SELECT supplier_id FROM supplier_rates)",
    );
    before = emptyState();
    const codes = new Set([...Object.keys(after.openings), ...Object.keys(after.minLevels)]);
    for (const code of codes) {
      await conn.execute("INSERT INTO stock_settings (component_code, opening_qty, min_level) VALUES (?, ?, ?)", [
        code,
        after.openings[code] ?? null,
        after.minLevels[code] ?? null,
      ]);
    }
    changes++;
  } else if (before.openings !== after.openings || before.minLevels !== after.minLevels) {
    throw new ConsistencyError("Opening stock and minimum levels are not changed by register actions");
  }

  for (const c of DOC_ORDER) {
    const prev = before[c] as unknown[];
    const next = after[c] as unknown[];
    if (prev === next) continue;
    const key = KEY_OF[c] as (d: unknown) => string;
    const prevByKey = new Map(prev.map((d) => [key(d), d]));
    const nextKeys = new Set<string>();
    for (const doc of next) {
      const k = key(doc);
      nextKeys.add(k);
      const old = prevByKey.get(k);
      if (old === undefined) {
        await writer.insert(c, doc);
        touch(c, k);
        changes++;
      } else if (old !== doc) {
        await writer.update(c, old, doc);
        touch(c, k);
        changes++;
      }
    }
    for (const k of prevByKey.keys()) {
      if (!nextKeys.has(k)) throw new ConsistencyError(`${c} ${k}: register documents are never deleted`);
    }
  }

  if (changes === 0) return 0;

  // Values shown on one document but stored on another: mark the showing document changed too.
  for (const q of after.qcIntimations) {
    if (touched.get("grnLines")?.has(q.grnNo)) touch("qcIntimations", q.id); // the slip shows the GRN's qty
  }
  for (const ar of after.arRecords.filter((a) => touched.get("arRecords")?.has(a.arNo))) {
    const grnNo = after.qcIntimations.find((q) => q.id === ar.intimationId)?.grnNo; // QC status shows on the GRN
    if (grnNo) touch("grnLines", grnNo);
  }
  for (const m of after.mrns.filter((x) => touched.get("mrns")?.has(x.id))) {
    touch("requisitions", m.requisitionId); // the slip shows returned qty
  }
  for (const i of after.indents.filter((x) => touched.get("indents")?.has(x.id))) {
    const po = after.purchaseOrders.find((p) => p.indentIds.includes(i.id));
    if (po) touch("purchaseOrders", po.id); // the PO lists its indents
  }

  if (replaceAll) await seedSequences(conn, after);
  await stampVersion(conn, touched, replaceAll);
  return changes;
}

/**
 * Assigns the next change number and stamps it on every touched document. Runs as
 * the LAST step of a write: the counter row stays locked only from here to COMMIT,
 * so numbers are handed out in commit order and a screen that has seen version N
 * has seen every change up to N.
 */
async function stampVersion(conn: Conn, touched: Map<DocCollection, Set<string>>, everything: boolean): Promise<void> {
  await conn.query("UPDATE app_meta SET v = CAST(v AS UNSIGNED) + 1 WHERE k = 'state_version'");
  const v = await getVersion(conn);
  if (everything) {
    for (const { table } of Object.values(HEADER)) await conn.query(`UPDATE ${table} SET row_version = ?`, [v]);
    await conn.query("UPDATE app_meta SET v = CAST(v AS UNSIGNED) + 1 WHERE k = 'resync_version'");
    return;
  }
  for (const [c, keys] of touched) {
    const { table, key } = HEADER[c];
    await conn.query(`UPDATE ${table} SET row_version = ? WHERE ${key} IN (?)`, [v, [...keys]]);
  }
}

/** Tells every open screen to reload everything (used where many documents change at once). */
export async function requestResync(conn: Conn): Promise<void> {
  await conn.query("UPDATE app_meta SET v = CAST(v AS UNSIGNED) + 1 WHERE k IN ('state_version', 'resync_version')");
}

/* ── document numbers ───────────────────────────────────────────────────────── */

const trailingNo = (id: string): number => Number(id.match(/(\d+)\s*$/)?.[1] ?? 0);

/** Sets every series to continue from the highest number present in `state`. */
export async function seedSequences(conn: Conn, state: FlowState): Promise<void> {
  const existing: Record<Series, string[]> = {
    GE: state.gateEntries.map((x) => x.id),
    GR: state.grnLines.map((x) => x.grnNo),
    QCI: state.qcIntimations.map((x) => x.id),
    AR: state.arRecords.map((x) => x.arNo),
    REQ: state.requisitions.map((x) => x.id),
    MRN: state.mrns.map((x) => x.id),
    FGT: state.fgTransfers.map((x) => x.id),
    PDI: state.pdiRecords.map((x) => x.id),
    WO: state.orders.map((x) => x.id),
    DPS: state.dispatchSlips.map((x) => x.id),
    IND: state.indents.map((x) => x.id),
    // PO numbers continue the client's series, including paper POs quoted at the gate.
    PO: [...state.purchaseOrders.map((x) => x.id), ...state.gateEntries.map((g) => g.poNo).filter((p) => p.startsWith(SERIES.PO.prefix))],
  };
  for (const series of Object.keys(SERIES) as Series[]) {
    const last = Math.max(0, ...existing[series].map(trailingNo));
    // UPDATE first: the app account may update sequences but not create them (setup does that).
    const [r] = await conn.query<ResultSetHeader>("UPDATE document_sequences SET last_no = ? WHERE series = ?", [last, series]);
    if (r.affectedRows === 0) {
      await conn.query("INSERT INTO document_sequences (series, last_no) VALUES (?, ?)", [series, last]);
    }
  }
}

/**
 * The next number of a series. The sequence row stays locked until the transaction
 * ends — creations of the same series queue for a moment, other series do not wait —
 * and a rolled-back action gives its number back, so the series has no gaps.
 */
export async function allocateNumber(conn: Conn, series: Series): Promise<string> {
  const [r] = await conn.query<ResultSetHeader>(
    "UPDATE document_sequences SET last_no = LAST_INSERT_ID(last_no + 1) WHERE series = ?",
    [series],
  );
  if (r.affectedRows !== 1) throw new Error(`Document series ${series} is not set up — run npm run db:setup.`);
  return formatNo(series, r.insertId);
}

/** Change numbers of specific documents (0 = unknown document). */
export async function rowVersions(conn: Conn, targets: { c: DocCollection; key: string }[]): Promise<number[]> {
  const out: number[] = [];
  for (const t of targets) {
    const { table, key } = HEADER[t.c];
    const r = await rows(conn, `SELECT row_version FROM ${table} WHERE ${key} = ?`, [t.key]);
    out.push(r[0] ? num(r[0].row_version) : 0);
  }
  return out;
}

/* ── safety snapshots before destructive resets ─────────────────────────────── */

/** Saves the whole state, encrypted, so a reset can always be undone. Returns the snapshot id. */
export async function saveSnapshot(
  conn: Conn,
  state: FlowState,
  reason: string,
  user: { id: number | null; username: string },
): Promise<number> {
  const [r] = await conn.execute<ResultSetHeader>(
    "INSERT INTO state_snapshots (created_by, username, reason, documents, data) VALUES (?, ?, ?, ?, ?)",
    [user.id, user.username.slice(0, 40), reason.slice(0, 60), countDocuments(state), encryptValue(state)],
  );
  return r.insertId;
}

export async function loadSnapshot(db: Queryable, id: number): Promise<FlowState | null> {
  const r = await rows(db, "SELECT data FROM state_snapshots WHERE id = ?", [id]);
  return r[0] ? decryptValue<FlowState>(str(r[0].data)) : null;
}

/* ── suppliers (price master) ───────────────────────────────────────────────── */

export async function loadSuppliers(db: Queryable): Promise<Supplier[]> {
  const list = await rows(db, "SELECT id, name, city FROM suppliers WHERE active = 1 AND approved = 1 ORDER BY id");
  const rates = groupBy(await rows(db, "SELECT supplier_id, component_code, rate_enc FROM supplier_rates"), "supplier_id");
  return list.map((s) => ({
    name: str(s.name),
    city: str(s.city),
    rates: Object.fromEntries(
      (rates.get(str(s.id)) ?? []).map((r) => [str(r.component_code), Number(opened(r.rate_enc))]),
    ),
  }));
}

/* ── customer master ────────────────────────────────────────────────────────── */

export interface CustomerRecord {
  id: number;
  name: string;
  address: string;
  orders: number;
  dispatches: number;
  /** Optimistic-concurrency token: the row's last change time. */
  version: string;
}

export async function listCustomers(db: Queryable): Promise<CustomerRecord[]> {
  const list = await rows(
    db,
    `SELECT c.id, c.name_enc, c.address_enc, c.updated_at,
            (SELECT COUNT(*) FROM customer_orders o WHERE o.customer_id = c.id) AS orders,
            (SELECT COUNT(*) FROM dispatch_slips d WHERE d.customer_id = c.id) AS dispatches
       FROM customers c`,
  );
  return list
    .map((r) => ({
      id: num(r.id),
      name: opened(r.name_enc),
      address: opened(r.address_enc),
      orders: num(r.orders),
      dispatches: num(r.dispatches),
      version: str(r.updated_at),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Changes one customer row — every order and dispatch refers to it, so all of them
 * show the new name/address at once. Refuses if someone else changed the customer
 * since it was loaded (`expectedVersion`), or if the name belongs to another customer.
 */
export async function updateCustomer(
  conn: Conn,
  id: number,
  name: string,
  address: string,
  expectedVersion: string,
): Promise<void> {
  const current = await rows(conn, "SELECT updated_at FROM customers WHERE id = ? FOR UPDATE", [id]);
  if (!current[0]) throw new FlowError("Customer not found.");
  if (str(current[0].updated_at) !== expectedVersion) {
    throw new FlowError("Someone else changed this customer just now — reload and try again.");
  }
  const hash = blindIndex(name);
  const clash = await rows(conn, "SELECT id FROM customers WHERE name_hash = ? AND id <> ?", [hash, id]);
  if (clash[0]) throw new FlowError("Another customer already has that name.");
  await conn.execute("UPDATE customers SET name_enc = ?, name_hash = ?, address_enc = ? WHERE id = ?", [
    encryptValue(name.trim()),
    hash,
    sealed(address.trim()),
    id,
  ]);
  // The name/address shows on many orders and slips: every screen reloads.
  await requestResync(conn);
}
