import type { DocCollection } from "../../src/flow/logic";

/** Each register's header table and its primary key column. */
export const HEADER: Record<DocCollection, { table: string; key: string }> = {
  gateEntries: { table: "gate_entries", key: "gate_entry_no" },
  grnLines: { table: "goods_receipts", key: "grn_no" },
  qcIntimations: { table: "qc_intimations", key: "intimation_no" },
  arRecords: { table: "qc_results", key: "ar_no" },
  requisitions: { table: "requisitions", key: "req_no" },
  mrns: { table: "material_returns", key: "mrn_no" },
  fgTransfers: { table: "fg_transfers", key: "transfer_no" },
  pdiRecords: { table: "pdi_records", key: "pdi_no" },
  orders: { table: "customer_orders", key: "order_no" },
  dispatchSlips: { table: "dispatch_slips", key: "dispatch_no" },
  indents: { table: "purchase_indents", key: "indent_no" },
  purchaseOrders: { table: "purchase_orders", key: "po_no" },
  tallyPos: { table: "tally_purchase_orders", key: "po_no" },
  poClosures: { table: "po_closures", key: "po_no" },
};
