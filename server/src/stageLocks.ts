/**
 * Stage locks enforced by the DATABASE itself (BEFORE UPDATE / BEFORE DELETE
 * triggers), independent of the application code: once a document has passed a
 * stage, the facts of that stage cannot be altered — not by a bug, not by a direct
 * SQL edit, not by a compromised app account. Only the bookkeeping columns
 * (row_version, updated_by, updated_at) may change freely.
 *
 * The triggers are generated from the live table definitions, so a column added
 * later is locked by default until a rule here says otherwise. Re-installed on
 * every `npm run db:setup`.
 */
import type { Connection, RowDataPacket } from "mysql2/promise";

const FREE = new Set(["row_version", "updated_by", "updated_at"]);

interface Rule {
  /** NULL until a stage happens, then frozen (e.g. approved_by, gate_out_at). */
  setOnce?: string[];
  /** Changeable only while `cond` holds (on OLD); frozen afterwards. */
  until?: { cols: string[]; cond: string; why: string };
  /** Extra checks, in trigger SQL. */
  extra?: string;
  /** Columns handled by `extra` instead of the generic lock. */
  special?: string[];
  /** Key columns that may change only while the session says so (@flow_renumber = 1, set by renumberPo). */
  renumber?: string[];
}

/** Every register table. Tables without a rule are fully immutable once written. */
const RULES: Record<string, Rule> = {
  gate_entries: {
    setOnce: ["time_out"],
    special: ["driver_signed"],
    extra: `IF OLD.driver_signed = 1 AND NEW.driver_signed = 0 THEN
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Driver sign is already recorded and cannot be removed';
            END IF;`,
  },
  gate_entry_lines: {},
  goods_receipts: {
    until: {
      cols: ["total_qty", "location_id", "remark_store"],
      cond: "NOT EXISTS (SELECT 1 FROM qc_intimations q WHERE q.grn_no = OLD.grn_no)",
      why: "GRN quantity is locked once sent to QC",
    },
    special: ["barcoded"],
    // The sticker can only be recorded as pasted (0 → 1), and only on QC-approved material.
    extra: `IF NOT (OLD.barcoded <=> NEW.barcoded) AND (OLD.barcoded = 1 OR
              (SELECT qc_status FROM v_grn_qc_status WHERE grn_no = OLD.grn_no) <> 'APPROVED') THEN
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Barcode can only be recorded once, on approved material';
            END IF;`,
  },
  qc_intimations: {},
  qc_results: {},
  requisitions: {
    setOnce: ["issued_at", "issued_by"],
    until: { cols: ["store_sign"], cond: "OLD.issued_at IS NULL", why: "Requisition is issued and locked" },
  },
  requisition_lines: { setOnce: ["qty_issued"] },
  material_returns: {},
  material_return_lines: {},
  fg_transfers: {
    setOnce: ["received_on", "received_by"],
    until: { cols: ["checked_by", "location_id"], cond: "OLD.received_on IS NULL", why: "FG transfer is received and locked" },
  },
  fg_transfer_lines: {},
  pdi_records: {},
  customer_orders: {},
  order_lines: {},
  dispatch_slips: {
    setOnce: ["invoice_no_enc", "invoice_date", "gate_out_at"],
    until: { cols: ["security_sign"], cond: "OLD.gate_out_at IS NULL", why: "Dispatch has left the gate and is locked" },
  },
  dispatch_lines: {},
  // The Tally send result is bookkeeping: retried until Tally takes the PO.
  // A PO whose number Tally already used gets a new one (its lines and indents follow by ON UPDATE CASCADE).
  purchase_orders: {
    setOnce: ["approved_by", "approved_at"],
    special: ["tally_push_at", "tally_push_error"],
    renumber: ["po_no"],
  },
  purchase_order_lines: {},
  purchase_indents: { setOnce: ["po_no"] },
};

const same = (cols: string[]) => cols.map((c) => `OLD.\`${c}\` <=> NEW.\`${c}\``).join(" AND ");
const signal = (msg: string) => `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${msg.replace(/'/g, "''").slice(0, 120)}';`;

async function columnsOf(conn: Connection, table: string): Promise<string[]> {
  const [r] = await conn.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [table],
  );
  return r.map((x) => String(x.c));
}

export async function installStageLocks(conn: Connection): Promise<void> {
  for (const [table, rule] of Object.entries(RULES)) {
    const cols = await columnsOf(conn, table);
    if (cols.length === 0) continue;
    const managed = new Set([...(rule.setOnce ?? []), ...(rule.until?.cols ?? []), ...(rule.special ?? []), ...(rule.renumber ?? [])]);
    const locked = cols.filter((c) => !FREE.has(c) && !managed.has(c));

    const body: string[] = [];
    if (locked.length) body.push(`IF NOT (${same(locked)}) THEN ${signal(`${table}: a recorded entry cannot be changed`)} END IF;`);
    for (const c of rule.setOnce ?? []) {
      body.push(`IF OLD.\`${c}\` IS NOT NULL AND NOT (OLD.\`${c}\` <=> NEW.\`${c}\`) THEN ${signal(`${table}.${c} is already recorded and cannot change`)} END IF;`);
    }
    if (rule.until) body.push(`IF NOT (${rule.until.cond}) AND NOT (${same(rule.until.cols)}) THEN ${signal(rule.until.why)} END IF;`);
    if (rule.extra) body.push(rule.extra);
    for (const c of rule.renumber ?? []) {
      body.push(`IF NOT (OLD.\`${c}\` <=> NEW.\`${c}\`) AND COALESCE(@flow_renumber, 0) <> 1 THEN ${signal(`${table}.${c} cannot change`)} END IF;`);
    }

    await conn.query(`DROP TRIGGER IF EXISTS trg_${table}_stage_lock`);
    await conn.query(`CREATE TRIGGER trg_${table}_stage_lock BEFORE UPDATE ON ${table} FOR EACH ROW BEGIN ${body.join(" ")} END`);

    // Registers are never deleted — only the admin's protected reset/restore opens this,
    // on its own connection, for the duration of the wipe (and the live system grants no DELETE at all).
    await conn.query(`DROP TRIGGER IF EXISTS trg_${table}_no_delete`);
    await conn.query(
      `CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW BEGIN
         IF COALESCE(@flow_reset, 0) <> 1 THEN ${signal(`${table}: register entries are never deleted`)} END IF;
       END`,
    );
  }

  // The audit trail and the safety snapshots are append-only — for every database account.
  for (const table of ["audit_log", "state_snapshots"]) {
    for (const op of ["UPDATE", "DELETE"]) {
      await conn.query(`DROP TRIGGER IF EXISTS trg_${table}_no_${op.toLowerCase()}`);
      await conn.query(
        `CREATE TRIGGER trg_${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} FOR EACH ROW BEGIN ${signal(`${table} is append-only`)} END`,
      );
    }
  }
}
