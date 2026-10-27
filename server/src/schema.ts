import type { Connection, RowDataPacket } from "mysql2/promise";
import { addVersioning, convertLegacyData, dropLegacyTables } from "./legacy";
import { installStageLocks } from "./stageLocks";

/**
 * Database schema as ordered migrations. `npm run db:setup` applies any not yet
 * recorded in schema_migrations. Never edit an applied migration — add a new one.
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
  /** Data step run after the statements, on the admin connection. */
  run?: (conn: Connection) => Promise<void>;
}

/** The document-as-JSON tables of migration 1 (frozen — migration 3 replaces them). */
export const LEGACY_DOC_TABLES = [
  "gate_entries",
  "grn_lines",
  "qc_intimations",
  "ar_records",
  "requisitions",
  "material_returns",
  "fg_transfers",
  "pdi_records",
  "customer_orders",
  "dispatch_slips",
  "purchase_indents",
  "purchase_orders",
];

const docTable = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  seq        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doc_no     VARCHAR(40)  NOT NULL,
  status     VARCHAR(20)  NULL,
  doc_date   DATE         NULL,
  ref        VARCHAR(120) NULL,
  data       JSON         NOT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_doc_no (doc_no),
  KEY ix_status (status),
  KEY ix_date (doc_date),
  KEY ix_ref (ref),
  CONSTRAINT fk_${table}_created FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_${table}_updated FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id                   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        username             VARCHAR(40)  NOT NULL,
        password_hash        VARCHAR(255) NOT NULL,
        role                 ENUM('gate','store','qc','packing','fgwh','accounts','purchase','security','admin') NOT NULL,
        label                VARCHAR(80)  NOT NULL,
        active               TINYINT(1)   NOT NULL DEFAULT 1,
        must_change_password TINYINT(1)   NOT NULL DEFAULT 1,
        failed_logins        INT UNSIGNED NOT NULL DEFAULT 0,
        locked_until         DATETIME(3)  NULL,
        password_changed_at  DATETIME(3)  NULL,
        last_login_at        DATETIME(3)  NULL,
        created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS sessions (
        id           CHAR(64)     NOT NULL PRIMARY KEY COMMENT 'SHA-256 of the cookie token',
        user_id      INT UNSIGNED NOT NULL,
        created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        last_seen_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        expires_at   DATETIME(3)  NOT NULL,
        ip           VARCHAR(45)  NULL,
        user_agent   VARCHAR(255) NULL,
        KEY ix_user (user_id),
        KEY ix_expires (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS audit_log (
        id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        user_id  INT UNSIGNED NULL,
        username VARCHAR(40)  NULL,
        role     VARCHAR(20)  NULL,
        action   VARCHAR(60)  NOT NULL,
        outcome  ENUM('ok','rejected','denied','invalid','error') NOT NULL,
        message  VARCHAR(500) NULL,
        payload  MEDIUMTEXT   NULL COMMENT 'encrypted',
        ip       VARCHAR(45)  NULL,
        KEY ix_at (at),
        KEY ix_user (user_id),
        KEY ix_action (action)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS stock_levels (
        code       VARCHAR(16) NOT NULL PRIMARY KEY,
        opening    INT         NULL,
        min_level  INT         NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS suppliers (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(120) NOT NULL,
        city       VARCHAR(80)  NOT NULL DEFAULT '',
        rates      TEXT         NOT NULL COMMENT 'encrypted {code: rate}',
        active     TINYINT(1)   NOT NULL DEFAULT 1,
        created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS app_meta (
        k VARCHAR(40)  NOT NULL PRIMARY KEY,
        v VARCHAR(255) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `INSERT IGNORE INTO app_meta (k, v) VALUES ('state_version', '0')`,

      ...LEGACY_DOC_TABLES.map(docTable),
    ],
  },
  {
    version: 2,
    name: "state snapshots before destructive resets",
    statements: [
      `CREATE TABLE IF NOT EXISTS state_snapshots (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        created_by INT UNSIGNED NULL,
        username   VARCHAR(40)  NULL,
        reason     VARCHAR(60)  NOT NULL,
        documents  INT UNSIGNED NOT NULL,
        data       LONGTEXT     NOT NULL COMMENT 'encrypted full FlowState',
        KEY ix_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
];


/* ── migration 3: relational registers ──────────────────────────────────────── */

const T = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";
/** Who created / last changed a row and when — on every business table. */
const AUDIT_COLS = `
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (created_by) REFERENCES users (id),
  FOREIGN KEY (updated_by) REFERENCES users (id)`;
/** Insertion order of documents (registers list entries in the order they were written). */
const SEQ = "seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, UNIQUE KEY uq_seq (seq)";
/** Month-year as printed on labels (mm-yyyy), a full date (dd-mm-yyyy), or empty. */
const LABEL_DATE = (col: string) => `CHECK (${col} REGEXP '^(([0-9]{2}-)?[0-9]{2}-[0-9]{4})?$')`;

/**
 * Purchase Orders as they stand in Tally — a read-only copy, replaced on every import.
 * Tally is never written to; what has come in against a PO is tracked by the gate entry lines.
 */
const TALLY_PO_TABLES = [
  `CREATE TABLE IF NOT EXISTS tally_purchase_orders (
    po_no         VARCHAR(40)  NOT NULL PRIMARY KEY,
    ${SEQ},
    po_date       DATE         NOT NULL,
    supplier_name VARCHAR(160) NOT NULL,
    cancelled     TINYINT(1)   NOT NULL DEFAULT 0,
    synced_at     DATETIME     NOT NULL,
    guid          VARCHAR(80)  NOT NULL DEFAULT '' COMMENT 'Tally voucher GUID',
    alter_id      BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Tally change number of the copy',
    row_version   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'state version of the last change',
    ${AUDIT_COLS},
    KEY ix_row_version (row_version),
    KEY ix_supplier (supplier_name)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS tally_po_lines (
    po_no     VARCHAR(40)   NOT NULL,
    line_no   INT UNSIGNED  NOT NULL,
    item_name VARCHAR(160)  NOT NULL,
    item_code VARCHAR(16)   NOT NULL DEFAULT '' COMMENT 'PMS code when the item is in the component master',
    qty       DECIMAL(14,3) NOT NULL,
    unit      VARCHAR(16)   NOT NULL,
    PRIMARY KEY (po_no, line_no),
    FOREIGN KEY (po_no) REFERENCES tally_purchase_orders (po_no),
    CHECK (qty > 0)
  ) ${T}`,
];

/**
 * The librarian's copy of Tally's whole stock item list (masters only): lets a PO line be coded even when its
 * item did not change in this sync. Items we buy or code become `components`.
 */
const TALLY_ITEMS = `CREATE TABLE IF NOT EXISTS tally_items (
    name      VARCHAR(200)    NOT NULL PRIMARY KEY,
    alias     VARCHAR(80)     NOT NULL DEFAULT '',
    unit      VARCHAR(16)     NOT NULL DEFAULT '',
    grp       VARCHAR(120)    NOT NULL DEFAULT '',
    master_id BIGINT UNSIGNED NOT NULL,
    alter_id  BIGINT UNSIGNED NOT NULL,
    synced_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ${T}`;

/**
 * A PO marked closed in MySQL (by hand or the go-live cut-over) — keyed by PO number so it survives every Tally
 * re-sync and covers app POs too. Reopening sets closed = 0; rows are never deleted.
 */
const PO_CLOSURES = `CREATE TABLE IF NOT EXISTS po_closures (
    po_no       VARCHAR(40)  NOT NULL PRIMARY KEY,
    ${SEQ},
    closed      TINYINT(1)   NOT NULL,
    closed_on   DATE         NOT NULL,
    closed_by   VARCHAR(80)  NOT NULL,
    reason      VARCHAR(200) NOT NULL,
    row_version BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'state version of the last change',
    ${AUDIT_COLS},
    KEY ix_row_version (row_version)
  ) ${T}`;

/** What the guard checked in, item by item, against a Tally PO. Write-once (stage lock). */
const GATE_ENTRY_LINES = `CREATE TABLE IF NOT EXISTS gate_entry_lines (
    gate_entry_no VARCHAR(20)   NOT NULL,
    line_no       INT UNSIGNED  NOT NULL,
    item_name     VARCHAR(160)  NOT NULL,
    item_code     VARCHAR(16)   NOT NULL DEFAULT '',
    unit          VARCHAR(16)   NOT NULL,
    qty           DECIMAL(14,3) NOT NULL,
    remark        VARCHAR(300)  NOT NULL DEFAULT '',
    PRIMARY KEY (gate_entry_no, line_no),
    FOREIGN KEY (gate_entry_no) REFERENCES gate_entries (gate_entry_no),
    CHECK (qty > 0)
  ) ${T}`;

/** Migration 7 on an existing database (a fresh one already has all of it from migration 3). */
async function addTallyPurchaseOrders(conn: Connection): Promise<void> {
  for (const sql of TALLY_PO_TABLES) await conn.query(sql);
  const [col] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gate_entries' AND COLUMN_NAME = 'tally_po_no'",
  );
  if (col.length === 0) {
    await conn.query(`ALTER TABLE gate_entries
      ADD COLUMN tally_po_no VARCHAR(40) NULL COMMENT 'PO made in Tally (gate in against it)' AFTER external_po_ref,
      ADD FOREIGN KEY (tally_po_no) REFERENCES tally_purchase_orders (po_no),
      ADD CHECK ((po_no IS NOT NULL) + (external_po_ref IS NOT NULL) + (tally_po_no IS NOT NULL) <= 1)`);
  }
  await conn.query(GATE_ENTRY_LINES);
}

/** Migration 8 on an existing database: a GRN counts one gate-checked item, in the PO's unit. */
async function grnAgainstGateLines(conn: Connection): Promise<void> {
  const [col] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goods_receipts' AND COLUMN_NAME = 'gate_line_no'",
  );
  if (col.length > 0) return; // fresh install: created this way in migration 3
  await conn.query(`ALTER TABLE goods_receipts
    ADD COLUMN gate_line_no INT UNSIGNED NULL COMMENT 'the gate-checked PO item this GRN counts (NULL: arrival without PO)' AFTER gate_entry_no,
    MODIFY total_qty DECIMAL(14,3) NOT NULL,
    MODIFY po_qty DECIMAL(14,3) NULL,
    ADD COLUMN unit VARCHAR(16) NOT NULL DEFAULT '' COMMENT 'the PO unit; empty = pcs (before Tally POs)' AFTER total_qty,
    ADD UNIQUE KEY uq_gate_line (gate_entry_no, gate_line_no),
    ADD FOREIGN KEY (gate_entry_no, gate_line_no) REFERENCES gate_entry_lines (gate_entry_no, line_no)`);
}

/** Migration 9 on an existing database: an indent names its vendor, so one PO can gather a vendor's indents. */
async function indentVendor(conn: Connection): Promise<void> {
  const [col] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_indents' AND COLUMN_NAME = 'supplier_id'",
  );
  // PO numbers raised here continue after those already copied from Tally (same 26SEV… series).
  await conn.query(
    `UPDATE document_sequences SET last_no = GREATEST(last_no, COALESCE((
       SELECT MAX(CAST(SUBSTRING(po_no, 6) AS UNSIGNED)) FROM tally_purchase_orders WHERE po_no REGEXP '^26SEV[0-9]+$'), 0))
     WHERE series = 'PO'`,
  );
  if (col.length > 0) return; // fresh install: created this way in migration 3
  await conn.query(`ALTER TABLE purchase_indents
    ADD COLUMN supplier_id INT UNSIGNED NULL COMMENT 'the vendor this indent is to be bought from' AFTER reason,
    ADD FOREIGN KEY (supplier_id) REFERENCES suppliers (id)`);
}

const columnMissing = async (conn: Connection, table: string, column: string) => {
  const [r] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column],
  );
  return r.length === 0;
};

/** Migration 10 on an existing database: the app's item master and PO status follow the real Tally data. */
async function tallyMasters(conn: Connection): Promise<void> {
  await conn.query(TALLY_ITEMS);
  await conn.query(PO_CLOSURES);
  if (await columnMissing(conn, "components", "unit")) {
    await conn.query(`ALTER TABLE components
      ADD COLUMN unit VARCHAR(16) NOT NULL DEFAULT '' COMMENT 'Tally base unit; empty = pcs' AFTER type,
      ADD COLUMN tally_name VARCHAR(200) NULL COMMENT 'the stock item it is in Tally' AFTER unit,
      ADD UNIQUE KEY uq_tally_name (tally_name)`);
  }
  if (await columnMissing(conn, "tally_purchase_orders", "guid")) {
    await conn.query(`ALTER TABLE tally_purchase_orders
      ADD COLUMN guid VARCHAR(80) NOT NULL DEFAULT '' COMMENT 'Tally voucher GUID' AFTER synced_at,
      ADD COLUMN alter_id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Tally change number of the copy' AFTER guid`);
  }
  // Sync status (last run, POs left out and why) is longer than a counter.
  await conn.query("ALTER TABLE app_meta MODIFY v TEXT NOT NULL");
}

/** Migration 11 on an existing database: an indent carries its expected rate, so every PO has a total. */
async function indentRate(conn: Connection): Promise<void> {
  if (await columnMissing(conn, "purchase_indents", "rate_enc")) {
    await conn.query(
      "ALTER TABLE purchase_indents ADD COLUMN rate_enc VARCHAR(255) NULL COMMENT 'encrypted expected rate per unit (carried onto the PO line)' AFTER supplier_id",
    );
  }
}

/** Migration 12 on an existing database: excess beyond the tolerance waits for Purchase. */
async function gateExcess(conn: Connection): Promise<void> {
  if (await columnMissing(conn, "gate_entry_lines", "excess_qty")) {
    await conn.query(`ALTER TABLE gate_entry_lines
      ADD COLUMN excess_qty DECIMAL(14,3) NULL COMMENT 'arrived beyond ordered + tolerance' AFTER remark,
      ADD COLUMN excess_status ENUM('PENDING','APPROVED','REJECTED') NULL AFTER excess_qty,
      ADD COLUMN excess_decided_by VARCHAR(80) NULL AFTER excess_status,
      ADD COLUMN excess_decided_on DATE NULL AFTER excess_decided_by`);
  }
}

/** Migration 13: the client chose no tolerance (never accept more than pending) — migration 12's columns go. */
async function dropGateExcess(conn: Connection): Promise<void> {
  if (!(await columnMissing(conn, "gate_entry_lines", "excess_qty"))) {
    await conn.query(`ALTER TABLE gate_entry_lines
      DROP COLUMN excess_qty, DROP COLUMN excess_status, DROP COLUMN excess_decided_by, DROP COLUMN excess_decided_on`);
  }
}

/** Migration 14: approved POs go to Tally on their own (result kept on the PO); vendors known as Tally ledgers. */
async function poToTally(conn: Connection): Promise<void> {
  if (await columnMissing(conn, "purchase_orders", "tally_push_at")) {
    await conn.query(`ALTER TABLE purchase_orders
      ADD COLUMN tally_push_at DATETIME NULL COMMENT 'last attempt to create it in Tally' AFTER approved_at,
      ADD COLUMN tally_push_error VARCHAR(500) NULL COMMENT 'why Tally did not take it (empty = created)' AFTER tally_push_at`);
  }
  if (await columnMissing(conn, "suppliers", "from_tally")) {
    await conn.query("ALTER TABLE suppliers ADD COLUMN from_tally TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'a ledger in Tally (synced)' AFTER approved");
  }
}

/** Migration 15: an app PO whose number Tally already used is sent under a new number (kept here). */
async function poTallyNumber(conn: Connection): Promise<void> {
  if (await columnMissing(conn, "purchase_orders", "tally_po_no")) {
    await conn.query(`ALTER TABLE purchase_orders
      ADD COLUMN tally_po_no VARCHAR(40) NULL UNIQUE COMMENT 'number used in Tally when its own was taken there (NULL = po_no)' AFTER tally_push_error`);
  }
}

/**
 * Migration 16: one number per PO. A PO whose number Tally already used gets a new number of its own (its lines and
 * indents follow: ON UPDATE CASCADE; it is renumbered only before any gate entry, so gate entries never need to);
 * POs given a separate Tally number by migration 15 take that number.
 */
async function onePoNumber(conn: Connection): Promise<void> {
  const [fks] = await conn.query<RowDataPacket[]>(
    `SELECT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'purchase_orders' AND r.UPDATE_RULE <> 'CASCADE'
        AND k.TABLE_NAME IN ('purchase_order_lines', 'purchase_indents')`,
  );
  for (const fk of fks) {
    await conn.query(`ALTER TABLE ${fk.t} DROP FOREIGN KEY ${fk.name}`);
    await conn.query(`ALTER TABLE ${fk.t} ADD CONSTRAINT ${fk.name} FOREIGN KEY (po_no) REFERENCES purchase_orders (po_no) ON UPDATE CASCADE`);
  }
  if (await columnMissing(conn, "purchase_orders", "tally_po_no")) return;
  // the stage lock forbids a new number; db:setup installs it again right after the migrations
  await conn.query("DROP TRIGGER IF EXISTS trg_purchase_orders_stage_lock");
  const [moved] = await conn.query<RowDataPacket[]>("SELECT po_no, tally_po_no FROM purchase_orders WHERE tally_po_no IS NOT NULL");
  for (const m of moved) {
    await conn.query("UPDATE purchase_orders SET po_no = ?, tally_po_no = NULL WHERE po_no = ?", [m.tally_po_no, m.po_no]);
    await conn.query("UPDATE po_closures SET po_no = ? WHERE po_no = ?", [m.tally_po_no, m.po_no]);
  }
  await conn.query("ALTER TABLE purchase_orders DROP COLUMN tally_po_no");
  if (moved.length) await conn.query("UPDATE app_meta SET v = CAST(v AS UNSIGNED) + 1 WHERE k IN ('state_version', 'resync_version')");
}

export const RELATIONAL_TABLES: string[] = [
  /* masters */
  `CREATE TABLE IF NOT EXISTS components (
    code   VARCHAR(16)  NOT NULL PRIMARY KEY,
    name   VARCHAR(160) NOT NULL,
    type   VARCHAR(40)  NOT NULL DEFAULT '',
    unit   VARCHAR(16)  NOT NULL DEFAULT '' COMMENT 'Tally base unit; empty = pcs',
    tally_name VARCHAR(200) NULL COMMENT 'the stock item it is in Tally',
    active TINYINT(1)   NOT NULL DEFAULT 1,
    UNIQUE KEY uq_tally_name (tally_name),
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS products (
    id       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name     VARCHAR(160) NOT NULL,
    fg_code  VARCHAR(80)  NOT NULL DEFAULT '' COMMENT 'not unique in the client data',
    vendor   VARCHAR(20)  NOT NULL DEFAULT '',
    box_size INT UNSIGNED NULL COMMENT 'units per box',
    active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_name (name),
    CHECK (box_size IS NULL OR box_size > 0)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS bom_lines (
    product_id     INT UNSIGNED  NOT NULL,
    component_code VARCHAR(16)   NOT NULL,
    per_100        DECIMAL(14,6) NOT NULL COMMENT 'quantity per 100 finished units',
    PRIMARY KEY (product_id, component_code),
    FOREIGN KEY (product_id) REFERENCES products (id),
    FOREIGN KEY (component_code) REFERENCES components (code),
    CHECK (per_100 > 0)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS supplier_rates (
    supplier_id    INT UNSIGNED NOT NULL,
    component_code VARCHAR(16)  NOT NULL,
    rate_enc       VARCHAR(255) NOT NULL COMMENT 'encrypted fixed rate',
    PRIMARY KEY (supplier_id, component_code),
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
    FOREIGN KEY (component_code) REFERENCES components (code)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS locations (
    id   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80)  NOT NULL,
    UNIQUE KEY uq_name (name)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS customers (
    id          INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name_enc    VARCHAR(512)  NOT NULL,
    name_hash   CHAR(64)      NOT NULL COMMENT 'keyed hash of the normalised name: finds a customer without decrypting',
    address_enc VARCHAR(1024) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_name_hash (name_hash)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS production_batches (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    product_id INT UNSIGNED NOT NULL,
    batch_no   VARCHAR(40)  NOT NULL,
    created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_batch (product_id, batch_no),
    UNIQUE KEY uq_id_product (id, product_id),
    FOREIGN KEY (product_id) REFERENCES products (id)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS stock_settings (
    component_code VARCHAR(16) NOT NULL PRIMARY KEY,
    opening_qty    INT NULL,
    min_level      INT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    FOREIGN KEY (component_code) REFERENCES components (code),
    CHECK (opening_qty IS NULL OR opening_qty >= 0),
    CHECK (min_level IS NULL OR min_level >= 0)
  ) ${T}`,

  /* purchase */
  `CREATE TABLE IF NOT EXISTS purchase_orders (
    po_no         VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    po_date       DATE         NOT NULL,
    supplier_id   INT UNSIGNED NOT NULL,
    expected_date DATE         NULL,
    approved_by   INT UNSIGNED NULL COMMENT 'set = APPROVED',
    approved_at   DATETIME(3)  NULL,
    tally_push_at    DATETIME     NULL COMMENT 'last attempt to create it in Tally',
    tally_push_error VARCHAR(500) NULL COMMENT 'why Tally did not take it (empty = created)',
    ${AUDIT_COLS},
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
    FOREIGN KEY (approved_by) REFERENCES users (id),
    CHECK ((approved_by IS NULL) = (approved_at IS NULL))
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS purchase_order_lines (
    po_no          VARCHAR(20)       NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    component_code VARCHAR(16)       NOT NULL,
    qty            INT               NOT NULL,
    rate_enc       VARCHAR(255)      NULL COMMENT 'encrypted rate agreed on this PO',
    PRIMARY KEY (po_no, line_no),
    FOREIGN KEY (po_no) REFERENCES purchase_orders (po_no) ON UPDATE CASCADE,
    FOREIGN KEY (component_code) REFERENCES components (code),
    CHECK (qty > 0)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS purchase_indents (
    indent_no      VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    indent_date    DATE         NOT NULL,
    component_code VARCHAR(16)  NOT NULL,
    qty            INT          NOT NULL,
    reason         VARCHAR(200) NOT NULL DEFAULT '',
    supplier_id    INT UNSIGNED NULL COMMENT 'the vendor this indent is to be bought from',
    rate_enc       VARCHAR(255) NULL COMMENT 'encrypted expected rate per unit (carried onto the PO line)',
    po_no          VARCHAR(20)  NULL COMMENT 'set = PO_RAISED',
    ${AUDIT_COLS},
    FOREIGN KEY (component_code) REFERENCES components (code),
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
    FOREIGN KEY (po_no) REFERENCES purchase_orders (po_no) ON UPDATE CASCADE,
    CHECK (qty > 0)
  ) ${T}`,

  /* inward + QC */
  ...TALLY_PO_TABLES,
  `CREATE TABLE IF NOT EXISTS gate_entries (
    gate_entry_no   VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    entry_date      DATE         NOT NULL,
    supplier_id     INT UNSIGNED NOT NULL,
    product_desc    VARCHAR(300) NOT NULL DEFAULT '',
    invoice_no      VARCHAR(60)  NOT NULL DEFAULT '',
    invoice_date    DATE         NULL,
    invoice_qty     INT          NULL,
    po_no           VARCHAR(20)  NULL,
    external_po_ref VARCHAR(40)  NULL COMMENT 'PO numbers from before the system / on paper',
    tally_po_no     VARCHAR(40)  NULL COMMENT 'PO made in Tally (gate in against it)',
    transport_name  VARCHAR(120) NOT NULL DEFAULT '',
    lr_no_enc       VARCHAR(255) NULL,
    vehicle_no_enc  VARCHAR(255) NULL,
    time_in         TIME         NULL,
    time_out        TIME         NULL,
    driver_signed   TINYINT(1)   NOT NULL DEFAULT 0,
    remark          VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    KEY ix_date (entry_date),
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
    FOREIGN KEY (po_no) REFERENCES purchase_orders (po_no),
    FOREIGN KEY (tally_po_no) REFERENCES tally_purchase_orders (po_no),
    CHECK (invoice_qty IS NULL OR invoice_qty >= 0),
    CHECK (po_no IS NULL OR external_po_ref IS NULL),
    CHECK ((po_no IS NOT NULL) + (external_po_ref IS NOT NULL) + (tally_po_no IS NOT NULL) <= 1)
  ) ${T}`,
  GATE_ENTRY_LINES,
  TALLY_ITEMS,
  PO_CLOSURES,
  `CREATE TABLE IF NOT EXISTS goods_receipts (
    grn_no         VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    gate_entry_no  VARCHAR(20)  NOT NULL COMMENT 'supplier, invoice and PO come from here',
    gate_line_no   INT UNSIGNED NULL COMMENT 'the gate-checked PO item this GRN counts (NULL: arrival without PO)',
    component_code VARCHAR(16)  NOT NULL,
    brand_name     VARCHAR(60)  NOT NULL DEFAULT '',
    received_date  DATE         NOT NULL,
    po_qty         DECIMAL(14,3) NULL,
    qty_per_box    INT          NULL,
    total_boxes    INT          NULL,
    total_qty      DECIMAL(14,3) NOT NULL,
    unit           VARCHAR(16)  NOT NULL DEFAULT '' COMMENT 'the PO unit; empty = pcs (before Tally POs)',
    location_id    INT UNSIGNED NULL,
    barcoded       TINYINT(1)   NOT NULL DEFAULT 0,
    remark_store   VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    KEY ix_date (received_date),
    UNIQUE KEY uq_gate_line (gate_entry_no, gate_line_no),
    FOREIGN KEY (gate_entry_no) REFERENCES gate_entries (gate_entry_no),
    FOREIGN KEY (gate_entry_no, gate_line_no) REFERENCES gate_entry_lines (gate_entry_no, line_no),
    FOREIGN KEY (component_code) REFERENCES components (code),
    FOREIGN KEY (location_id) REFERENCES locations (id),
    CHECK (total_qty >= 0),
    CHECK (qty_per_box IS NULL OR qty_per_box > 0),
    CHECK (total_boxes IS NULL OR total_boxes > 0),
    CHECK (po_qty IS NULL OR po_qty >= 0)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS qc_intimations (
    intimation_no VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    grn_no        VARCHAR(20)  NOT NULL COMMENT 'product, qty, supplier, invoice come from the GRN',
    issued_on     DATE         NOT NULL,
    issued_time   TIME         NULL,
    batch_no      VARCHAR(40)  NOT NULL DEFAULT '' COMMENT 'supplier lot number',
    mfg_date      VARCHAR(10)  NOT NULL DEFAULT '',
    expiry_date   VARCHAR(10)  NOT NULL DEFAULT '',
    remark        VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    UNIQUE KEY uq_grn (grn_no),
    FOREIGN KEY (grn_no) REFERENCES goods_receipts (grn_no),
    ${LABEL_DATE("mfg_date")},
    ${LABEL_DATE("expiry_date")}
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS qc_results (
    ar_no         VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    intimation_no VARCHAR(20)  NOT NULL,
    decided_on    DATE         NOT NULL,
    status        ENUM('APPROVED','HOLD','REJECTED') NOT NULL,
    remark        VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    KEY ix_intimation (intimation_no, seq),
    FOREIGN KEY (intimation_no) REFERENCES qc_intimations (intimation_no)
  ) ${T}`,

  /* production */
  `CREATE TABLE IF NOT EXISTS requisitions (
    req_no       VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    req_date     DATE         NOT NULL,
    department   VARCHAR(40)  NOT NULL,
    product_id   INT UNSIGNED NULL,
    batch_id     INT UNSIGNED NULL,
    packing_sign VARCHAR(80)  NOT NULL DEFAULT '',
    store_sign   VARCHAR(80)  NOT NULL DEFAULT '',
    issued_at    DATETIME(3)  NULL COMMENT 'set = ISSUED',
    issued_by    INT UNSIGNED NULL,
    ${AUDIT_COLS},
    FOREIGN KEY (product_id) REFERENCES products (id),
    FOREIGN KEY (batch_id, product_id) REFERENCES production_batches (id, product_id),
    FOREIGN KEY (issued_by) REFERENCES users (id),
    CHECK (batch_id IS NULL OR product_id IS NOT NULL)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS requisition_lines (
    req_no         VARCHAR(20)       NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    component_code VARCHAR(16)       NOT NULL,
    unit           VARCHAR(12)       NOT NULL DEFAULT 'Pcs',
    qty_required   INT               NOT NULL,
    qty_issued     INT               NULL,
    remark         VARCHAR(500)      NOT NULL DEFAULT '',
    PRIMARY KEY (req_no, line_no),
    KEY ix_component (component_code),
    FOREIGN KEY (req_no) REFERENCES requisitions (req_no),
    FOREIGN KEY (component_code) REFERENCES components (code),
    CHECK (qty_required > 0),
    CHECK (qty_issued IS NULL OR qty_issued >= 0)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS material_returns (
    mrn_no   VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    mrn_date DATE         NOT NULL,
    req_no   VARCHAR(20)  NOT NULL,
    sign     VARCHAR(80)  NOT NULL,
    remark   VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    FOREIGN KEY (req_no) REFERENCES requisitions (req_no)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS material_return_lines (
    mrn_no         VARCHAR(20)       NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    component_code VARCHAR(16)       NOT NULL,
    qty            INT               NOT NULL,
    PRIMARY KEY (mrn_no, line_no),
    FOREIGN KEY (mrn_no) REFERENCES material_returns (mrn_no),
    FOREIGN KEY (component_code) REFERENCES components (code),
    CHECK (qty > 0)
  ) ${T}`,

  /* finished goods */
  `CREATE TABLE IF NOT EXISTS fg_transfers (
    transfer_no   VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    transfer_date DATE         NOT NULL,
    submitted_by  VARCHAR(80)  NOT NULL DEFAULT '',
    checked_by    VARCHAR(80)  NOT NULL DEFAULT '',
    location_id   INT UNSIGNED NULL,
    received_on   DATE         NULL COMMENT 'set = RECEIVED',
    received_by   INT UNSIGNED NULL,
    ${AUDIT_COLS},
    FOREIGN KEY (location_id) REFERENCES locations (id),
    FOREIGN KEY (received_by) REFERENCES users (id)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS fg_transfer_lines (
    transfer_no VARCHAR(20)       NOT NULL,
    line_no     SMALLINT UNSIGNED NOT NULL,
    batch_id    INT UNSIGNED      NOT NULL COMMENT 'product and SKU come from the batch',
    mfg_month   VARCHAR(10)       NOT NULL DEFAULT '',
    qty_per_box INT               NOT NULL,
    total_boxes INT               NOT NULL,
    loose_qty   INT               NOT NULL DEFAULT 0,
    total_qty   INT GENERATED ALWAYS AS (qty_per_box * total_boxes + loose_qty) STORED,
    remark      VARCHAR(500)      NOT NULL DEFAULT '',
    PRIMARY KEY (transfer_no, line_no),
    KEY ix_batch (batch_id),
    FOREIGN KEY (transfer_no) REFERENCES fg_transfers (transfer_no),
    FOREIGN KEY (batch_id) REFERENCES production_batches (id),
    CHECK (qty_per_box > 0),
    CHECK (total_boxes >= 0),
    CHECK (loose_qty >= 0),
    ${LABEL_DATE("mfg_month")}
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS pdi_records (
    pdi_no   VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    pdi_date DATE         NOT NULL,
    batch_id INT UNSIGNED NOT NULL,
    status   ENUM('PASSED','FAILED') NOT NULL,
    remark   VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    KEY ix_batch (batch_id, seq),
    FOREIGN KEY (batch_id) REFERENCES production_batches (id)
  ) ${T}`,

  /* sales + dispatch */
  `CREATE TABLE IF NOT EXISTS customer_orders (
    order_no       VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    order_date     DATE         NOT NULL,
    customer_id    INT UNSIGNED NOT NULL,
    cust_po_no_enc VARCHAR(255) NULL,
    delivery_date  DATE         NULL,
    remark         VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    FOREIGN KEY (customer_id) REFERENCES customers (id)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS order_lines (
    order_no   VARCHAR(20)       NOT NULL,
    line_no    SMALLINT UNSIGNED NOT NULL,
    product_id INT UNSIGNED      NOT NULL,
    qty        INT               NOT NULL,
    PRIMARY KEY (order_no, line_no),
    FOREIGN KEY (order_no) REFERENCES customer_orders (order_no),
    FOREIGN KEY (product_id) REFERENCES products (id),
    CHECK (qty > 0)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS dispatch_slips (
    dispatch_no    VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    dispatch_date  DATE         NOT NULL,
    order_no       VARCHAR(20)  NULL,
    customer_id    INT UNSIGNED NOT NULL,
    dispatch_sign  VARCHAR(80)  NOT NULL DEFAULT '',
    invoice_no_enc VARCHAR(255) NULL COMMENT 'set by Accounts',
    invoice_date   DATE         NULL,
    security_sign  VARCHAR(80)  NOT NULL DEFAULT '',
    gate_out_at    DATETIME(3)  NULL COMMENT 'set = left the gate',
    remark         VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    FOREIGN KEY (order_no) REFERENCES customer_orders (order_no),
    FOREIGN KEY (customer_id) REFERENCES customers (id),
    CHECK (gate_out_at IS NULL OR invoice_no_enc IS NOT NULL)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS dispatch_lines (
    dispatch_no VARCHAR(20)       NOT NULL,
    line_no     SMALLINT UNSIGNED NOT NULL,
    batch_id    INT UNSIGNED      NOT NULL,
    qty_per_box INT               NOT NULL,
    total_boxes INT               NOT NULL,
    total_qty   INT GENERATED ALWAYS AS (qty_per_box * total_boxes) STORED,
    PRIMARY KEY (dispatch_no, line_no),
    KEY ix_batch (batch_id),
    FOREIGN KEY (dispatch_no) REFERENCES dispatch_slips (dispatch_no),
    FOREIGN KEY (batch_id) REFERENCES production_batches (id),
    CHECK (qty_per_box > 0),
    CHECK (total_boxes > 0)
  ) ${T}`,

  /* derived value: the QC status of a GRN is its latest A.R. decision */
  `CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_grn_qc_status AS
    SELECT r.grn_no,
           COALESCE((SELECT q.status FROM qc_intimations i
                       JOIN qc_results q ON q.intimation_no = i.intimation_no
                      WHERE i.grn_no = r.grn_no
                      ORDER BY q.seq DESC LIMIT 1), 'UNDER_TEST') AS qc_status
      FROM goods_receipts r`,
];

MIGRATIONS.push(
  {
    version: 3,
    name: "relational registers + masters (converts the migration-1 JSON tables)",
    statements: [],
    run: convertLegacyData,
  },
  {
    version: 4,
    name: "drop the migration-1 JSON tables after the verified conversion",
    statements: [],
    run: dropLegacyTables,
  },
  {
    version: 5,
    name: "row versions for conflict detection + document number sequences",
    statements: [],
    run: addVersioning,
  },
  {
    version: 6,
    name: "stage locks: passed stages cannot be altered or deleted (database triggers)",
    statements: [],
    run: installStageLocks,
  },
  {
    version: 7,
    name: "Tally purchase orders (read-only copy) + gate entry lines",
    statements: [],
    run: addTallyPurchaseOrders,
  },
  {
    version: 8,
    name: "GRN per gate-checked item, in the PO's unit",
    statements: [],
    run: grnAgainstGateLines,
  },
  {
    version: 9,
    name: "indents name their vendor (one PO for several indents)",
    statements: [],
    run: indentVendor,
  },
  {
    version: 10,
    name: "item master, vendors and PO status from the real Tally data",
    statements: [],
    run: tallyMasters,
  },
  {
    version: 11,
    name: "indents carry the expected rate (PO totals)",
    statements: [],
    run: indentRate,
  },
  {
    version: 12,
    name: "excess beyond the tolerance at the gate waits for Purchase",
    statements: [],
    run: gateExcess,
  },
  {
    version: 13,
    name: "no tolerance at the gate after all: excess columns removed",
    statements: [],
    run: dropGateExcess,
  },
  {
    version: 14,
    name: "approved POs go to Tally automatically; vendors known as Tally ledgers",
    statements: [],
    run: poToTally,
  },
  {
    version: 15,
    name: "an app PO can be sent to Tally under a new number when its own is taken there",
    statements: [],
    run: poTallyNumber,
  },
  {
    version: 16,
    name: "one number per PO: a PO renumbered for Tally keeps one number everywhere",
    statements: [],
    run: onePoNumber,
  },
);

/* ── privileges of the runtime app account ──────────────────────────────────── */

export const BUSINESS_TABLES = [
  "purchase_orders",
  "purchase_order_lines",
  "purchase_indents",
  "gate_entries",
  "gate_entry_lines",
  "po_closures",
  "tally_purchase_orders",
  "tally_po_lines",
  "goods_receipts",
  "qc_intimations",
  "qc_results",
  "requisitions",
  "requisition_lines",
  "material_returns",
  "material_return_lines",
  "fg_transfers",
  "fg_transfer_lines",
  "pdi_records",
  "customer_orders",
  "order_lines",
  "dispatch_slips",
  "dispatch_lines",
];

/**
 * Every table the app account may touch, and how. Registers can be added to and
 * corrected, never deleted — unless this system allows the admin's demo reset.
 * The audit log and snapshots are append-only; product/component masters are
 * read-only (renames go through the maintenance command with the admin account).
 */
export function appGrants(allowReset: boolean): { table: string; privileges: string }[] {
  const register = allowReset ? "SELECT, INSERT, UPDATE, DELETE" : "SELECT, INSERT, UPDATE";
  const addOnly = allowReset ? "SELECT, INSERT, DELETE" : "SELECT, INSERT";
  return [
    { table: "users", privileges: "SELECT, INSERT, UPDATE, DELETE" },
    { table: "sessions", privileges: "SELECT, INSERT, UPDATE, DELETE" },
    { table: "audit_log", privileges: "SELECT, INSERT" },
    { table: "state_snapshots", privileges: "SELECT, INSERT" },
    { table: "app_meta", privileges: "SELECT, UPDATE" },
    { table: "schema_migrations", privileges: "SELECT" },
    { table: "components", privileges: "SELECT" },
    { table: "products", privileges: "SELECT" },
    { table: "bom_lines", privileges: "SELECT" },
    { table: "supplier_rates", privileges: "SELECT" },
    // Created on the fly when a document names one not yet on file.
    { table: "suppliers", privileges: addOnly },
    { table: "customers", privileges: allowReset ? "SELECT, INSERT, UPDATE, DELETE" : "SELECT, INSERT, UPDATE" },
    { table: "locations", privileges: addOnly },
    { table: "production_batches", privileges: addOnly },
    { table: "stock_settings", privileges: allowReset ? "SELECT, INSERT, UPDATE, DELETE" : "SELECT" },
    { table: "v_grn_qc_status", privileges: "SELECT" },
    // One row per series, locked only while a document of that series is being created.
    { table: "document_sequences", privileges: "SELECT, UPDATE" },
    ...BUSINESS_TABLES.map((table) => ({ table, privileges: register })),
  ];
}
