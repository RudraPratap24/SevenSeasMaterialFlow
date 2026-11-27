/**
 * Purchase System tables. Migration 43 (now in server/src/baseline.sql) copied the sheets as they were; migration 44
 * makes one record per fact:
 *   ps_lines        one row per LINE ID: the indent (incl. the Indent-sheet fields) and its follow-up state;
 *                   po_no points at the line's current PO
 *   ps_line_steps   the 5 follow-up steps of a line
 *   ps_pos          one row per PO (header: date, delivery date, vendor, approval, PDF …)
 *   ps_po_lines     one row per PO line (item, qty, rate, tax, total), line_id → ps_lines
 *   ps_grn          copy of the external GRN system, as it is
 *   ps_files, ps_guidelines, ps_settings
 *   ps_import_audit where the sheet held two different values for one fact: the one kept, the other one, why
 * Items, vendors and logins are the shared masters (components / products / suppliers / supplier_rates / users).
 * Planned dates, delays, receipt status and stage are worked out on read (core.ts), never stored.
 */
import type { Connection, RowDataPacket } from "mysql2/promise";
import type { Grant, Migration } from "../../../server/src/module";
import { oneRecordPerFact, type Rec } from "./records";

const T = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

const PS_POS = `CREATE TABLE IF NOT EXISTS ps_pos (
  po_no        VARCHAR(40)  NOT NULL PRIMARY KEY,
  seq          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, UNIQUE KEY uq_seq (seq),
  po_date      DATETIME NULL,
  edd          DATETIME NULL COMMENT 'required delivery date',
  company      VARCHAR(160) NOT NULL DEFAULT '',
  vendor       VARCHAR(200) NOT NULL DEFAULT '' COMMENT 'as printed on the PO',
  vendor_code  VARCHAR(20)  NOT NULL DEFAULT '',
  tax_type     VARCHAR(20)  NOT NULL DEFAULT '',
  lead_days    VARCHAR(10)  NOT NULL DEFAULT '',
  doer         VARCHAR(120) NOT NULL DEFAULT '',
  remarks      VARCHAR(1000) NOT NULL DEFAULT '',
  pdf          VARCHAR(500) NOT NULL DEFAULT '' COMMENT 'Drive link (old) or link to our file',
  approval     VARCHAR(20)  NOT NULL DEFAULT '' COMMENT 'PENDING / APPROVED / CANCELLED; "" = old PO (rule by GO_LIVE)',
  approved_by  VARCHAR(120) NOT NULL DEFAULT '',
  approved_at  DATETIME NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ${T}`;

const PS_PO_LINES = `CREATE TABLE IF NOT EXISTS ps_po_lines (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  po_no        VARCHAR(40)  NOT NULL,
  line_id      VARCHAR(40)  NULL COMMENT 'the FMS line; NULL = old PO line with no FMS line',
  item_code    VARCHAR(300) NOT NULL DEFAULT '',
  item_name    VARCHAR(300) NOT NULL DEFAULT '',
  vendor_item  VARCHAR(300) NOT NULL DEFAULT '',
  hsn          VARCHAR(40)  NOT NULL DEFAULT '',
  qty          DECIMAL(18,3) NOT NULL DEFAULT 0,
  unit         VARCHAR(20)  NOT NULL DEFAULT '',
  rate         DECIMAL(18,4) NOT NULL DEFAULT 0,
  gst          VARCHAR(10)  NOT NULL DEFAULT '' COMMENT 'GST % ("" = not given)',
  gst_amt      DECIMAL(18,2) NOT NULL DEFAULT 0,
  cgst         DECIMAL(18,2) NOT NULL DEFAULT 0,
  sgst         DECIMAL(18,2) NOT NULL DEFAULT 0,
  igst         DECIMAL(18,2) NOT NULL DEFAULT 0,
  amount       DECIMAL(18,2) NOT NULL DEFAULT 0,
  total        DECIMAL(18,2) NOT NULL DEFAULT 0,
  indent_no    VARCHAR(1000) NOT NULL DEFAULT '' COMMENT 'indent number(s) as quoted on the PO',
  UNIQUE KEY uq_po_line (po_no, line_id), KEY ix_line (line_id),
  CONSTRAINT fk_ps_po_lines_po FOREIGN KEY (po_no) REFERENCES ps_pos (po_no)
) ${T}`;

const PS_IMPORT_AUDIT = `CREATE TABLE IF NOT EXISTS ps_import_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sheet       VARCHAR(20)  NOT NULL COMMENT 'where the other value came from: Indent / PO / FMS',
  ref         VARCHAR(160) NOT NULL COMMENT 'line id, PO no., indent no. or row',
  field       VARCHAR(40)  NOT NULL,
  kept        TEXT NULL,
  other       MEDIUMTEXT NULL,
  note        VARCHAR(200) NOT NULL DEFAULT '',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_ref (ref)
) ${T}`;

/** Indent-sheet fields that only the Indent sheet had → now on the line */
const LINE_COLUMNS = `ALTER TABLE ps_lines
  ADD COLUMN in_register   TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = the line is (or was) on the Indent sheet',
  ADD COLUMN register_no   VARCHAR(40)  NOT NULL DEFAULT '' COMMENT 'the Indent sheet number when it differs from indent_no (POs may quote either)',
  ADD COLUMN origin        VARCHAR(20)  NOT NULL DEFAULT '',
  ADD COLUMN image_url     VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN submitted_by  VARCHAR(160) NOT NULL DEFAULT '',
  ADD COLUMN email_status  VARCHAR(30)  NOT NULL DEFAULT '',
  ADD COLUMN category      VARCHAR(80)  NOT NULL DEFAULT '',
  ADD COLUMN item_type     VARCHAR(80)  NOT NULL DEFAULT '',
  ADD COLUMN sku           VARCHAR(40)  NOT NULL DEFAULT '',
  ADD COLUMN brand         VARCHAR(60)  NOT NULL DEFAULT '',
  ADD COLUMN designer_status VARCHAR(80) NOT NULL DEFAULT '',
  ADD COLUMN designer_at   VARCHAR(40)  NOT NULL DEFAULT '',
  ADD COLUMN designer_image VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN mrp           VARCHAR(40)  NOT NULL DEFAULT '',
  ADD COLUMN mrp_date      VARCHAR(40)  NOT NULL DEFAULT ''`;

/** migration 44: the tables as first imported → one record per fact (rules in records.ts), then the copies are dropped */
async function oneRecord(conn: Connection): Promise<void> {
  const q = async (sql: string) => (await conn.query<RowDataPacket[]>(sql))[0] as Rec[];
  const r = oneRecordPerFact(await q("SELECT * FROM ps_lines ORDER BY seq"), await q("SELECT * FROM ps_po_rows ORDER BY id"), await q("SELECT * FROM ps_indent_rows ORDER BY id"));
  for (const h of r.pos) await conn.query("INSERT INTO ps_pos SET ?", [h]);
  for (const l of r.poLines) await conn.query("INSERT INTO ps_po_lines SET ?", [l]);
  for (const [id, set] of r.lineSets) await conn.query("UPDATE ps_lines SET ? WHERE line_id = ?", [set, id]);
  for (const a of r.audits) await conn.query("INSERT INTO ps_import_audit SET ?", [a]);
  await conn.query("ALTER TABLE ps_lines DROP COLUMN item_code, DROP COLUMN qty, DROP COLUMN rate, DROP COLUMN value, DROP COLUMN vendor, DROP COLUMN po_date, DROP COLUMN edd, DROP COLUMN pdf, DROP COLUMN lead_days");
  await conn.query("DROP TABLE ps_indent_rows, ps_po_rows");
}

export const PS_MIGRATIONS: Migration[] = [
  {
    version: 44,
    name: "Purchase System: one record per fact (PO header + PO lines; Indent-sheet fields on the line; audit of dropped copies)",
    statements: [PS_POS, PS_PO_LINES, PS_IMPORT_AUDIT, LINE_COLUMNS],
    run: oneRecord,
  },
];

/** What the app account may do on the Purchase System tables (lines and POs are corrected, never deleted). */
export const PS_GRANTS: Grant[] = [
  { table: "ps_lines", privileges: "SELECT, INSERT, UPDATE" },
  // cancelling a PO clears the follow-up steps of its indent lines (they are open indents again)
  { table: "ps_line_steps", privileges: "SELECT, INSERT, UPDATE, DELETE" },
  { table: "ps_pos", privileges: "SELECT, INSERT, UPDATE" },
  { table: "ps_po_lines", privileges: "SELECT, INSERT, UPDATE" },
  { table: "ps_grn", privileges: "SELECT" },
  { table: "ps_files", privileges: "SELECT, INSERT" },
  { table: "ps_guidelines", privileges: "SELECT" },
  { table: "ps_settings", privileges: "SELECT, INSERT, UPDATE" },
  // it also writes two shared masters (an item's photo, the vendor's own item name): covered by the core grants
];
