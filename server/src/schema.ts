import type { Connection } from "mysql2/promise";
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

export const RELATIONAL_TABLES: string[] = [
  /* masters */
  `CREATE TABLE IF NOT EXISTS components (
    code   VARCHAR(16)  NOT NULL PRIMARY KEY,
    name   VARCHAR(160) NOT NULL,
    type   VARCHAR(40)  NOT NULL DEFAULT '',
    active TINYINT(1)   NOT NULL DEFAULT 1,
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
    FOREIGN KEY (po_no) REFERENCES purchase_orders (po_no),
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
    po_no          VARCHAR(20)  NULL COMMENT 'set = PO_RAISED',
    ${AUDIT_COLS},
    FOREIGN KEY (component_code) REFERENCES components (code),
    FOREIGN KEY (po_no) REFERENCES purchase_orders (po_no),
    CHECK (qty > 0)
  ) ${T}`,

  /* inward + QC */
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
    CHECK (invoice_qty IS NULL OR invoice_qty >= 0),
    CHECK (po_no IS NULL OR external_po_ref IS NULL)
  ) ${T}`,
  `CREATE TABLE IF NOT EXISTS goods_receipts (
    grn_no         VARCHAR(20)  NOT NULL PRIMARY KEY,
    ${SEQ},
    gate_entry_no  VARCHAR(20)  NOT NULL COMMENT 'supplier, invoice and PO come from here',
    component_code VARCHAR(16)  NOT NULL,
    brand_name     VARCHAR(60)  NOT NULL DEFAULT '',
    received_date  DATE         NOT NULL,
    po_qty         INT          NULL,
    qty_per_box    INT          NULL,
    total_boxes    INT          NULL,
    total_qty      INT          NOT NULL,
    location_id    INT UNSIGNED NULL,
    barcoded       TINYINT(1)   NOT NULL DEFAULT 0,
    remark_store   VARCHAR(500) NOT NULL DEFAULT '',
    ${AUDIT_COLS},
    KEY ix_date (received_date),
    FOREIGN KEY (gate_entry_no) REFERENCES gate_entries (gate_entry_no),
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
);

/* ── privileges of the runtime app account ──────────────────────────────────── */

export const BUSINESS_TABLES = [
  "purchase_orders",
  "purchase_order_lines",
  "purchase_indents",
  "gate_entries",
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
