-- Schema of migrations 1–43 (the old Material Flow app + Purchase System), generated once from a fresh database.
-- A new, empty database starts from this file (npm run db:setup); later changes are new migrations in schema.ts.
-- Never edit by hand. Statements are separated by a line holding only ";".

SET FOREIGN_KEY_CHECKS = 0
;
CREATE TABLE IF NOT EXISTS `app_meta` (
  `k` varchar(40) NOT NULL,
  `v` text NOT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `user_id` int unsigned DEFAULT NULL,
  `username` varchar(40) DEFAULT NULL,
  `role` varchar(20) DEFAULT NULL,
  `action` varchar(60) NOT NULL,
  `outcome` enum('ok','rejected','denied','invalid','error') NOT NULL,
  `message` varchar(500) DEFAULT NULL,
  `payload` mediumtext COMMENT 'encrypted',
  `ip` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_at` (`at`),
  KEY `ix_user` (`user_id`),
  KEY `ix_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_cancellations` (
  `bom_no` varchar(24) NOT NULL,
  `reason` varchar(200) NOT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`bom_no`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `bom_cancellations_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_documents` (`bom_no`),
  CONSTRAINT `bom_cancellations_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_document_lines` (
  `bom_no` varchar(24) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `required_qty` decimal(14,3) NOT NULL,
  `present_qty` decimal(14,3) NOT NULL COMMENT 'PM stock when the document was made',
  `used_in_skus` varchar(500) NOT NULL DEFAULT '',
  PRIMARY KEY (`bom_no`,`line_no`),
  KEY `component_code` (`component_code`),
  CONSTRAINT `bom_document_lines_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_documents` (`bom_no`),
  CONSTRAINT `bom_document_lines_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_document_products` (
  `bom_no` varchar(24) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `product_id` int unsigned NOT NULL,
  `target_qty` int unsigned NOT NULL,
  PRIMARY KEY (`bom_no`,`line_no`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `bom_document_products_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_documents` (`bom_no`),
  CONSTRAINT `bom_document_products_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_documents` (
  `bom_no` varchar(24) NOT NULL,
  `plan_date` date NOT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`bom_no`),
  KEY `ix_plan_date` (`plan_date`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `bom_documents_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_issue_lines` (
  `bom_no` varchar(24) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `required_qty` decimal(14,3) NOT NULL,
  `issued_qty` decimal(14,3) NOT NULL,
  `remark` varchar(200) NOT NULL DEFAULT '',
  PRIMARY KEY (`bom_no`,`line_no`),
  KEY `component_code` (`component_code`),
  CONSTRAINT `bom_issue_lines_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_issue_slips` (`bom_no`),
  CONSTRAINT `bom_issue_lines_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `bom_issue_lines_chk_1` CHECK ((`issued_qty` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_issue_slips` (
  `bom_no` varchar(24) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `filled_by` varchar(80) NOT NULL COMMENT 'the store person, as typed',
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`bom_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `ix_row_version` (`row_version`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `bom_issue_slips_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_documents` (`bom_no`),
  CONSTRAINT `bom_issue_slips_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_lines` (
  `product_id` int unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `per_100` decimal(14,6) NOT NULL COMMENT 'quantity per 100 finished units',
  `qty_source` enum('SHEET','PACK') NOT NULL DEFAULT 'SHEET' COMMENT 'PACK = from the pack size in the item name (no qty in the client sheet)',
  PRIMARY KEY (`product_id`,`component_code`),
  KEY `component_code` (`component_code`),
  CONSTRAINT `bom_lines_ibfk_1` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `bom_lines_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `bom_lines_chk_1` CHECK ((`per_100` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_return_lines` (
  `mrn_no` varchar(24) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `returned_qty` decimal(14,3) NOT NULL COMMENT 'what the supervisor says is coming back',
  `received_qty` decimal(14,3) DEFAULT NULL COMMENT 'what Store counted, at approval',
  `remark` varchar(200) NOT NULL DEFAULT '',
  PRIMARY KEY (`mrn_no`,`line_no`),
  KEY `component_code` (`component_code`),
  CONSTRAINT `bom_return_lines_ibfk_1` FOREIGN KEY (`mrn_no`) REFERENCES `bom_returns` (`mrn_no`),
  CONSTRAINT `bom_return_lines_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `bom_return_lines_chk_1` CHECK ((`returned_qty` > 0)),
  CONSTRAINT `bom_return_lines_chk_2` CHECK (((`received_qty` is null) or (`received_qty` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_returns` (
  `mrn_no` varchar(24) NOT NULL,
  `bom_no` varchar(24) NOT NULL,
  `returned_by` varchar(80) NOT NULL COMMENT 'the supervisor, as picked',
  `remarks` varchar(200) NOT NULL DEFAULT '',
  `status` enum('PENDING','APPROVED') NOT NULL DEFAULT 'PENDING',
  `verified_by` varchar(80) NOT NULL DEFAULT '' COMMENT 'the store login that approved',
  `verify_remarks` varchar(200) NOT NULL DEFAULT '',
  `verified_at` datetime(3) DEFAULT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`mrn_no`),
  KEY `ix_bom` (`bom_no`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `bom_returns_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_issue_slips` (`bom_no`),
  CONSTRAINT `bom_returns_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_verification_lines` (
  `bom_no` varchar(24) NOT NULL,
  `line_no` smallint unsigned NOT NULL COMMENT 'the issue slip line it checks',
  `received_qty` decimal(14,3) NOT NULL,
  PRIMARY KEY (`bom_no`,`line_no`),
  CONSTRAINT `bom_verification_lines_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_verifications` (`bom_no`),
  CONSTRAINT `bom_verification_lines_ibfk_2` FOREIGN KEY (`bom_no`, `line_no`) REFERENCES `bom_issue_lines` (`bom_no`, `line_no`),
  CONSTRAINT `bom_verification_lines_chk_1` CHECK ((`received_qty` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bom_verifications` (
  `bom_no` varchar(24) NOT NULL,
  `verified_by` varchar(80) NOT NULL COMMENT 'the supervisor, as typed',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`bom_no`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `bom_verifications_ibfk_1` FOREIGN KEY (`bom_no`) REFERENCES `bom_issue_slips` (`bom_no`),
  CONSTRAINT `bom_verifications_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bulk_items` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(16) DEFAULT NULL COMMENT 'item code (RM…) of the chemical',
  `name` varchar(120) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `unit` enum('KG','L') NOT NULL DEFAULT 'KG',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_name` (`name`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bulk_plan_lines` (
  `plan_date` date NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `bulk_item_id` int unsigned NOT NULL,
  `qty` decimal(12,3) NOT NULL,
  PRIMARY KEY (`plan_date`,`line_no`),
  KEY `bulk_item_id` (`bulk_item_id`),
  CONSTRAINT `bulk_plan_lines_ibfk_1` FOREIGN KEY (`plan_date`) REFERENCES `bulk_plans` (`plan_date`) ON DELETE CASCADE,
  CONSTRAINT `bulk_plan_lines_ibfk_2` FOREIGN KEY (`bulk_item_id`) REFERENCES `bulk_items` (`id`),
  CONSTRAINT `bulk_plan_lines_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bulk_plans` (
  `plan_date` date NOT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `updated_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`plan_date`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  CONSTRAINT `bulk_plans_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `bulk_plans_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bulk_qt` (
  `report_date` date NOT NULL,
  `row_no` smallint unsigned NOT NULL,
  `status` enum('ACCEPTED','REJECTED','HOLD') NOT NULL,
  `accepted_qty` decimal(12,3) DEFAULT NULL COMMENT 'into bulk stock; 0 when rejected, NULL on hold',
  `remarks` varchar(200) NOT NULL DEFAULT '',
  `decided_by` varchar(80) NOT NULL DEFAULT '',
  `decided_at` datetime(3) NOT NULL,
  PRIMARY KEY (`report_date`,`row_no`),
  CONSTRAINT `bulk_qt_ibfk_1` FOREIGN KEY (`report_date`, `row_no`) REFERENCES `bulk_report_lines` (`report_date`, `row_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bulk_report_lines` (
  `report_date` date NOT NULL,
  `row_no` smallint unsigned NOT NULL,
  `bulk_item_id` int unsigned NOT NULL,
  `shade` varchar(80) NOT NULL DEFAULT '',
  `order_date` date DEFAULT NULL,
  `responsible` varchar(80) NOT NULL DEFAULT '',
  `batch_size` decimal(12,3) DEFAULT NULL COMMENT 'planned, in the item''s unit',
  `actual_qty` decimal(12,3) DEFAULT NULL COMMENT 'made, in the item''s unit',
  `mfg_by` varchar(80) NOT NULL DEFAULT '',
  `remark` varchar(200) NOT NULL DEFAULT '',
  PRIMARY KEY (`report_date`,`row_no`),
  KEY `bulk_item_id` (`bulk_item_id`),
  CONSTRAINT `bulk_report_lines_ibfk_1` FOREIGN KEY (`report_date`) REFERENCES `bulk_reports` (`report_date`),
  CONSTRAINT `bulk_report_lines_ibfk_2` FOREIGN KEY (`bulk_item_id`) REFERENCES `bulk_items` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `bulk_reports` (
  `report_date` date NOT NULL,
  `final_at` datetime(3) DEFAULT NULL COMMENT 'final submit: the date is locked from then on',
  `final_by` int unsigned DEFAULT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `updated_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`report_date`),
  KEY `final_by` (`final_by`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  CONSTRAINT `bulk_reports_ibfk_1` FOREIGN KEY (`final_by`) REFERENCES `users` (`id`),
  CONSTRAINT `bulk_reports_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `bulk_reports_ibfk_3` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `components` (
  `code` varchar(16) NOT NULL,
  `name` varchar(160) NOT NULL,
  `type` varchar(40) NOT NULL DEFAULT '',
  `kind` varchar(8) NOT NULL DEFAULT '' COMMENT 'PM, RM, BULK, PROMO, MRO',
  `category` varchar(60) NOT NULL DEFAULT '',
  `origin` varchar(20) NOT NULL DEFAULT '',
  `unit` varchar(16) NOT NULL DEFAULT '' COMMENT 'Tally base unit; empty = pcs',
  `tally_name` varchar(200) DEFAULT NULL COMMENT 'the stock item it is in Tally',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `indent_qty` int unsigned DEFAULT NULL COMMENT 'the fixed qty this item is ordered in',
  `ps_item_type` varchar(80) NOT NULL DEFAULT '' COMMENT 'Item Master: Item Type',
  `ps_uom` varchar(20) NOT NULL DEFAULT '' COMMENT 'Item Master: UOM',
  `ps_pack_size` varchar(120) NOT NULL DEFAULT '',
  `ps_status` varchar(40) NOT NULL DEFAULT '',
  `ps_photo` varchar(500) NOT NULL DEFAULT '' COMMENT 'Drive file id (old) or ps_files id',
  `ps_spec` varchar(1000) NOT NULL DEFAULT '',
  `ps_mrp` varchar(40) NOT NULL DEFAULT '',
  `ps_remarks` varchar(1000) NOT NULL DEFAULT '',
  `ps_hsn` varchar(20) NOT NULL DEFAULT '',
  `ps_gst` varchar(10) NOT NULL DEFAULT '',
  `ps_moq` varchar(20) NOT NULL DEFAULT '',
  `ps_brand` varchar(60) NOT NULL DEFAULT '' COMMENT 'Item Master: Brand',
  PRIMARY KEY (`code`),
  UNIQUE KEY `uq_tally_name` (`tally_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `customer_orders` (
  `order_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_date` date NOT NULL,
  `customer_id` int unsigned NOT NULL,
  `cust_po_no_enc` varchar(255) DEFAULT NULL,
  `delivery_date` date DEFAULT NULL,
  `remark` varchar(500) NOT NULL DEFAULT '',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`order_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `customer_id` (`customer_id`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `customer_orders_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `customer_orders_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `customer_orders_ibfk_3` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `customers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name_enc` varchar(512) NOT NULL,
  `name_hash` char(64) NOT NULL COMMENT 'keyed hash of the normalised name: finds a customer without decrypting',
  `address_enc` varchar(1024) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_name_hash` (`name_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `debit_notes` (
  `dn_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `dn_date` date NOT NULL,
  `grn_no` varchar(20) NOT NULL,
  `kind` enum('QC_REJECTED','SHORT_SUPPLY') NOT NULL DEFAULT 'QC_REJECTED',
  `ar_no` varchar(20) DEFAULT NULL COMMENT 'the QC result debited; NULL on a short-supply note',
  `qty` decimal(14,3) NOT NULL,
  `unit` varchar(16) NOT NULL DEFAULT '',
  `rate_enc` varchar(255) NOT NULL COMMENT 'encrypted rate per unit',
  `reason` varchar(500) NOT NULL,
  `raised_by` varchar(80) NOT NULL,
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`dn_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  UNIQUE KEY `uq_grn_kind` (`grn_no`,`kind`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_row_version` (`row_version`),
  KEY `ar_no` (`ar_no`),
  CONSTRAINT `debit_notes_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `debit_notes_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `debit_notes_ibfk_3` FOREIGN KEY (`grn_no`) REFERENCES `goods_receipts` (`grn_no`),
  CONSTRAINT `debit_notes_ibfk_4` FOREIGN KEY (`ar_no`) REFERENCES `qc_results` (`ar_no`),
  CONSTRAINT `debit_notes_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `dispatch_lines` (
  `dispatch_no` varchar(20) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `batch_id` int unsigned NOT NULL,
  `qty_per_box` int NOT NULL,
  `total_boxes` int NOT NULL,
  `total_qty` int GENERATED ALWAYS AS ((`qty_per_box` * `total_boxes`)) STORED,
  PRIMARY KEY (`dispatch_no`,`line_no`),
  KEY `ix_batch` (`batch_id`),
  CONSTRAINT `dispatch_lines_ibfk_1` FOREIGN KEY (`dispatch_no`) REFERENCES `dispatch_slips` (`dispatch_no`),
  CONSTRAINT `dispatch_lines_ibfk_2` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`id`),
  CONSTRAINT `dispatch_lines_chk_1` CHECK ((`qty_per_box` > 0)),
  CONSTRAINT `dispatch_lines_chk_2` CHECK ((`total_boxes` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `dispatch_slips` (
  `dispatch_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `dispatch_date` date NOT NULL,
  `order_no` varchar(20) DEFAULT NULL,
  `customer_id` int unsigned NOT NULL,
  `dispatch_sign` varchar(80) NOT NULL DEFAULT '',
  `invoice_no_enc` varchar(255) DEFAULT NULL COMMENT 'set by Accounts',
  `invoice_date` date DEFAULT NULL,
  `security_sign` varchar(80) NOT NULL DEFAULT '',
  `gate_out_at` datetime(3) DEFAULT NULL COMMENT 'set = left the gate',
  `remark` varchar(500) NOT NULL DEFAULT '',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`dispatch_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `order_no` (`order_no`),
  KEY `customer_id` (`customer_id`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `dispatch_slips_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `dispatch_slips_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `dispatch_slips_ibfk_3` FOREIGN KEY (`order_no`) REFERENCES `customer_orders` (`order_no`),
  CONSTRAINT `dispatch_slips_ibfk_4` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `dispatch_slips_chk_1` CHECK (((`gate_out_at` is null) or (`invoice_no_enc` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `document_sequences` (
  `series` varchar(8) NOT NULL,
  `last_no` int unsigned NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`series`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `escalation_closures` (
  `grn_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `closed_on` date NOT NULL,
  `closed_by` varchar(80) NOT NULL,
  `resolution` varchar(500) NOT NULL,
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`grn_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `escalation_closures_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `escalation_closures_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `escalation_closures_ibfk_3` FOREIGN KEY (`grn_no`) REFERENCES `goods_receipts` (`grn_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfer_draft_lines` (
  `note_date` date NOT NULL,
  `row_no` smallint unsigned NOT NULL,
  `product_id` int unsigned NOT NULL,
  `product_type` varchar(160) NOT NULL DEFAULT '',
  `qty_in_box` int unsigned DEFAULT NULL,
  `total_box` int unsigned DEFAULT NULL,
  `total_qty` int unsigned DEFAULT NULL,
  `pallet_no` varchar(20) NOT NULL DEFAULT '',
  `supervisor` varchar(80) NOT NULL DEFAULT '',
  PRIMARY KEY (`note_date`,`row_no`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `fg_transfer_draft_lines_ibfk_1` FOREIGN KEY (`note_date`) REFERENCES `fg_transfer_drafts` (`note_date`) ON DELETE CASCADE,
  CONSTRAINT `fg_transfer_draft_lines_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfer_drafts` (
  `note_date` date NOT NULL,
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`note_date`),
  KEY `updated_by` (`updated_by`),
  CONSTRAINT `fg_transfer_drafts_ibfk_1` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfer_lines` (
  `transfer_no` varchar(20) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `batch_id` int unsigned NOT NULL COMMENT 'product and SKU come from the batch',
  `mfg_month` varchar(10) NOT NULL DEFAULT '',
  `qty_per_box` int NOT NULL,
  `total_boxes` int NOT NULL,
  `loose_qty` int NOT NULL DEFAULT '0',
  `total_qty` int GENERATED ALWAYS AS (((`qty_per_box` * `total_boxes`) + `loose_qty`)) STORED,
  `remark` varchar(500) NOT NULL DEFAULT '',
  PRIMARY KEY (`transfer_no`,`line_no`),
  KEY `ix_batch` (`batch_id`),
  CONSTRAINT `fg_transfer_lines_ibfk_1` FOREIGN KEY (`transfer_no`) REFERENCES `fg_transfers` (`transfer_no`),
  CONSTRAINT `fg_transfer_lines_ibfk_2` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`id`),
  CONSTRAINT `fg_transfer_lines_chk_1` CHECK ((`qty_per_box` > 0)),
  CONSTRAINT `fg_transfer_lines_chk_2` CHECK ((`total_boxes` >= 0)),
  CONSTRAINT `fg_transfer_lines_chk_3` CHECK ((`loose_qty` >= 0)),
  CONSTRAINT `fg_transfer_lines_chk_4` CHECK (regexp_like(`mfg_month`,_utf8mb4'^(([0-9]{2}-)?[0-9]{2}-[0-9]{4})?$'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfer_note_lines` (
  `note_no` varchar(24) NOT NULL,
  `row_no` smallint unsigned NOT NULL,
  `product_id` int unsigned NOT NULL,
  `product_type` varchar(160) NOT NULL DEFAULT '',
  `qty_in_box` int unsigned DEFAULT NULL,
  `total_box` int unsigned DEFAULT NULL,
  `total_qty` int unsigned DEFAULT NULL,
  `pallet_no` varchar(20) NOT NULL DEFAULT '',
  `supervisor` varchar(80) NOT NULL DEFAULT '',
  PRIMARY KEY (`note_no`,`row_no`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `fg_transfer_note_lines_ibfk_1` FOREIGN KEY (`note_no`) REFERENCES `fg_transfer_notes` (`note_no`),
  CONSTRAINT `fg_transfer_note_lines_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfer_notes` (
  `note_no` varchar(24) NOT NULL,
  `note_date` date NOT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`note_no`),
  KEY `ix_date` (`note_date`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `fg_transfer_notes_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfer_receipt_lines` (
  `note_no` varchar(24) NOT NULL,
  `row_no` smallint unsigned NOT NULL,
  `verified_qty` int unsigned NOT NULL,
  `remark` varchar(200) NOT NULL DEFAULT '',
  PRIMARY KEY (`note_no`,`row_no`),
  CONSTRAINT `fg_transfer_receipt_lines_ibfk_1` FOREIGN KEY (`note_no`) REFERENCES `fg_transfer_receipts` (`note_no`),
  CONSTRAINT `fg_transfer_receipt_lines_ibfk_2` FOREIGN KEY (`note_no`, `row_no`) REFERENCES `fg_transfer_note_lines` (`note_no`, `row_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfer_receipts` (
  `note_no` varchar(24) NOT NULL,
  `verified_by` varchar(80) NOT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`note_no`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `fg_transfer_receipts_ibfk_1` FOREIGN KEY (`note_no`) REFERENCES `fg_transfer_notes` (`note_no`),
  CONSTRAINT `fg_transfer_receipts_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `fg_transfers` (
  `transfer_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `transfer_date` date NOT NULL,
  `submitted_by` varchar(80) NOT NULL DEFAULT '',
  `checked_by` varchar(80) NOT NULL DEFAULT '',
  `location_id` int unsigned DEFAULT NULL,
  `received_on` date DEFAULT NULL COMMENT 'set = RECEIVED',
  `received_by` int unsigned DEFAULT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`transfer_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `location_id` (`location_id`),
  KEY `received_by` (`received_by`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `fg_transfers_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fg_transfers_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fg_transfers_ibfk_3` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`),
  CONSTRAINT `fg_transfers_ibfk_4` FOREIGN KEY (`received_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `gate_entries` (
  `gate_entry_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `entry_date` date NOT NULL,
  `supplier_id` int unsigned NOT NULL,
  `product_desc` varchar(300) NOT NULL DEFAULT '',
  `invoice_no` varchar(60) NOT NULL DEFAULT '',
  `invoice_date` date DEFAULT NULL,
  `invoice_qty` decimal(14,3) DEFAULT NULL,
  `invoice_qty_unit` varchar(20) NOT NULL DEFAULT '' COMMENT 'Box, Kg or as typed at the gate',
  `po_no` varchar(20) DEFAULT NULL,
  `external_po_ref` varchar(40) DEFAULT NULL COMMENT 'PO numbers from before the system / on paper',
  `tally_po_no` varchar(40) DEFAULT NULL COMMENT 'PO made in Tally (gate in against it)',
  `transport_name` varchar(120) NOT NULL DEFAULT '',
  `lr_no_enc` varchar(255) DEFAULT NULL,
  `vehicle_no_enc` varchar(255) DEFAULT NULL,
  `driver_name` varchar(80) NOT NULL DEFAULT '',
  `driver_phone_enc` varchar(255) DEFAULT NULL,
  `time_in` time DEFAULT NULL,
  `time_out` time DEFAULT NULL,
  `driver_signed` tinyint(1) NOT NULL DEFAULT '0',
  `remark` varchar(500) NOT NULL DEFAULT '',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`gate_entry_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_date` (`entry_date`),
  KEY `supplier_id` (`supplier_id`),
  KEY `po_no` (`po_no`),
  KEY `tally_po_no` (`tally_po_no`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `gate_entries_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `gate_entries_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `gate_entries_ibfk_3` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `gate_entries_ibfk_4` FOREIGN KEY (`po_no`) REFERENCES `purchase_orders` (`po_no`),
  CONSTRAINT `gate_entries_ibfk_5` FOREIGN KEY (`tally_po_no`) REFERENCES `tally_purchase_orders` (`po_no`),
  CONSTRAINT `gate_entries_chk_1` CHECK (((`invoice_qty` is null) or (`invoice_qty` >= 0))),
  CONSTRAINT `gate_entries_chk_2` CHECK (((`po_no` is null) or (`external_po_ref` is null))),
  CONSTRAINT `gate_entries_chk_3` CHECK (((((`po_no` is not null) + (`external_po_ref` is not null)) + (`tally_po_no` is not null)) <= 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `gate_entry_lines` (
  `gate_entry_no` varchar(20) NOT NULL,
  `line_no` int unsigned NOT NULL,
  `item_name` varchar(160) NOT NULL,
  `item_code` varchar(16) NOT NULL DEFAULT '',
  `unit` varchar(16) NOT NULL,
  `qty` decimal(14,3) NOT NULL,
  `remark` varchar(300) NOT NULL DEFAULT '',
  PRIMARY KEY (`gate_entry_no`,`line_no`),
  CONSTRAINT `gate_entry_lines_ibfk_1` FOREIGN KEY (`gate_entry_no`) REFERENCES `gate_entries` (`gate_entry_no`),
  CONSTRAINT `gate_entry_lines_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `gate_entry_photos` (
  `gate_entry_no` varchar(20) NOT NULL,
  `mime` varchar(40) NOT NULL,
  `bytes` mediumblob NOT NULL,
  `taken_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` int unsigned DEFAULT NULL,
  PRIMARY KEY (`gate_entry_no`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `gate_entry_photos_ibfk_1` FOREIGN KEY (`gate_entry_no`) REFERENCES `gate_entries` (`gate_entry_no`),
  CONSTRAINT `gate_entry_photos_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `goods_receipts` (
  `grn_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `gate_entry_no` varchar(20) NOT NULL COMMENT 'supplier, invoice and PO come from here',
  `gate_line_no` int unsigned DEFAULT NULL COMMENT 'the gate-checked PO item this GRN counts (NULL: arrival without PO)',
  `po_no` varchar(20) DEFAULT NULL COMMENT 'PO picked at GRN (raised in the app)',
  `tally_po_no` varchar(40) DEFAULT NULL COMMENT 'PO picked at GRN (made in Tally)',
  `po_item_name` varchar(160) NOT NULL DEFAULT '' COMMENT 'the PO item this GRN counts',
  `po_item_code` varchar(16) NOT NULL DEFAULT '',
  `pending_before` decimal(14,3) DEFAULT NULL COMMENT 'pending on the PO item before this GRN',
  `variance` varchar(10) NOT NULL DEFAULT '' COMMENT 'SHORT / EXCESS beyond the tolerance',
  `closes_item` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'completes its PO item',
  `component_code` varchar(16) NOT NULL,
  `brand_name` varchar(60) NOT NULL DEFAULT '',
  `received_date` date NOT NULL,
  `po_qty` decimal(14,3) DEFAULT NULL,
  `qty_per_box` int DEFAULT NULL,
  `total_boxes` int DEFAULT NULL,
  `total_qty` decimal(14,3) NOT NULL,
  `unit` varchar(16) NOT NULL DEFAULT '' COMMENT 'the PO unit; empty = pcs (before Tally POs)',
  `location_id` int unsigned DEFAULT NULL,
  `barcoded` tinyint(1) NOT NULL DEFAULT '0',
  `remark_store` varchar(500) NOT NULL DEFAULT '',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`grn_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  UNIQUE KEY `uq_gate_line` (`gate_entry_no`,`gate_line_no`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_date` (`received_date`),
  KEY `component_code` (`component_code`),
  KEY `location_id` (`location_id`),
  KEY `ix_row_version` (`row_version`),
  KEY `po_no` (`po_no`),
  KEY `tally_po_no` (`tally_po_no`),
  CONSTRAINT `goods_receipts_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `goods_receipts_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `goods_receipts_ibfk_3` FOREIGN KEY (`gate_entry_no`) REFERENCES `gate_entries` (`gate_entry_no`),
  CONSTRAINT `goods_receipts_ibfk_4` FOREIGN KEY (`gate_entry_no`, `gate_line_no`) REFERENCES `gate_entry_lines` (`gate_entry_no`, `line_no`),
  CONSTRAINT `goods_receipts_ibfk_5` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `goods_receipts_ibfk_6` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`),
  CONSTRAINT `goods_receipts_ibfk_7` FOREIGN KEY (`po_no`) REFERENCES `purchase_orders` (`po_no`),
  CONSTRAINT `goods_receipts_ibfk_8` FOREIGN KEY (`tally_po_no`) REFERENCES `tally_purchase_orders` (`po_no`),
  CONSTRAINT `goods_receipts_chk_1` CHECK ((`total_qty` >= 0)),
  CONSTRAINT `goods_receipts_chk_2` CHECK (((`qty_per_box` is null) or (`qty_per_box` > 0))),
  CONSTRAINT `goods_receipts_chk_3` CHECK (((`total_boxes` is null) or (`total_boxes` > 0))),
  CONSTRAINT `goods_receipts_chk_4` CHECK (((`po_qty` is null) or (`po_qty` >= 0))),
  CONSTRAINT `goods_receipts_chk_5` CHECK ((`variance` in (_utf8mb4'',_utf8mb4'SHORT',_utf8mb4'EXCESS'))),
  CONSTRAINT `goods_receipts_chk_6` CHECK (((`po_no` is null) or (`tally_po_no` is null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `indent_requests` (
  `request_no` varchar(24) NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `qty` int unsigned NOT NULL,
  `required_date` date DEFAULT NULL,
  `supervisor` varchar(80) NOT NULL DEFAULT '',
  `remarks` varchar(200) NOT NULL DEFAULT '',
  `raised_by` varchar(80) NOT NULL COMMENT 'name of the login that raised it',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `status` enum('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `verify_remarks` varchar(200) NOT NULL DEFAULT '',
  `verified_by` varchar(80) NOT NULL DEFAULT '',
  `verified_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`request_no`),
  KEY `ix_code` (`component_code`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `indent_requests_ibfk_1` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `indent_requests_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `indent_requests_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `locations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(80) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `material_return_lines` (
  `mrn_no` varchar(20) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `qty` int NOT NULL,
  PRIMARY KEY (`mrn_no`,`line_no`),
  KEY `component_code` (`component_code`),
  CONSTRAINT `material_return_lines_ibfk_1` FOREIGN KEY (`mrn_no`) REFERENCES `material_returns` (`mrn_no`),
  CONSTRAINT `material_return_lines_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `material_return_lines_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `material_returns` (
  `mrn_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `mrn_date` date NOT NULL,
  `req_no` varchar(20) NOT NULL,
  `sign` varchar(80) NOT NULL,
  `remark` varchar(500) NOT NULL DEFAULT '',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`mrn_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `req_no` (`req_no`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `material_returns_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `material_returns_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `material_returns_ibfk_3` FOREIGN KEY (`req_no`) REFERENCES `requisitions` (`req_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `order_lines` (
  `order_no` varchar(20) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `product_id` int unsigned NOT NULL,
  `qty` int NOT NULL,
  PRIMARY KEY (`order_no`,`line_no`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `order_lines_ibfk_1` FOREIGN KEY (`order_no`) REFERENCES `customer_orders` (`order_no`),
  CONSTRAINT `order_lines_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `order_lines_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `pdi_records` (
  `pdi_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `pdi_date` date NOT NULL,
  `batch_id` int unsigned NOT NULL,
  `status` enum('PASSED','FAILED') NOT NULL,
  `remark` varchar(500) NOT NULL DEFAULT '',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`pdi_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_batch` (`batch_id`,`seq`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `pdi_records_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `pdi_records_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `pdi_records_ibfk_3` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `po_closures` (
  `po_no` varchar(40) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `closed` tinyint(1) NOT NULL,
  `closed_on` date NOT NULL,
  `closed_by` varchar(80) NOT NULL,
  `reason` varchar(200) NOT NULL,
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`po_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `po_closures_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `po_closures_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `production_batches` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `product_id` int unsigned NOT NULL,
  `batch_no` varchar(40) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batch` (`product_id`,`batch_no`),
  UNIQUE KEY `uq_id_product` (`id`,`product_id`),
  CONSTRAINT `production_batches_ibfk_1` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `production_plan_lines` (
  `plan_date` date NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `product_id` int unsigned NOT NULL,
  `product_type` varchar(40) NOT NULL DEFAULT '',
  `target_qty` int unsigned NOT NULL,
  PRIMARY KEY (`plan_date`,`line_no`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `production_plan_lines_ibfk_1` FOREIGN KEY (`plan_date`) REFERENCES `production_plans` (`plan_date`) ON DELETE CASCADE,
  CONSTRAINT `production_plan_lines_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `production_plan_lines_chk_1` CHECK ((`target_qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `production_plans` (
  `plan_date` date NOT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `updated_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`plan_date`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  CONSTRAINT `production_plans_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `production_plans_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `production_report_lines` (
  `report_date` date NOT NULL,
  `row_no` smallint unsigned NOT NULL,
  `floor` varchar(8) NOT NULL DEFAULT '',
  `line_name` varchar(8) NOT NULL DEFAULT '',
  `manpower` smallint unsigned DEFAULT NULL,
  `line_leader` varchar(80) NOT NULL DEFAULT '',
  `supervisor` varchar(80) NOT NULL DEFAULT '',
  `product_id` int unsigned NOT NULL,
  `product_type` varchar(40) NOT NULL DEFAULT '',
  `stage` varchar(30) NOT NULL DEFAULT '',
  `target_qty` int unsigned DEFAULT NULL,
  `slot` varchar(12) NOT NULL DEFAULT '',
  `qty_first` int unsigned DEFAULT NULL COMMENT '9 am to 1 pm',
  `qty_second` int unsigned DEFAULT NULL COMMENT '1 pm to 5 pm',
  `qty_evening` int unsigned DEFAULT NULL COMMENT '5 pm to 7 pm',
  `sfg_qty` int unsigned DEFAULT NULL COMMENT 'total SFG in shift',
  `downtime_min` smallint unsigned DEFAULT NULL,
  `reason` varchar(200) NOT NULL DEFAULT '',
  PRIMARY KEY (`report_date`,`row_no`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `production_report_lines_ibfk_1` FOREIGN KEY (`report_date`) REFERENCES `production_reports` (`report_date`),
  CONSTRAINT `production_report_lines_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `production_reports` (
  `report_date` date NOT NULL,
  `supervisor` varchar(80) NOT NULL DEFAULT '',
  `final_at` datetime(3) DEFAULT NULL COMMENT 'final submit: the date is locked from then on',
  `final_by` int unsigned DEFAULT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `updated_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`report_date`),
  KEY `final_by` (`final_by`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  CONSTRAINT `production_reports_ibfk_1` FOREIGN KEY (`final_by`) REFERENCES `users` (`id`),
  CONSTRAINT `production_reports_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `production_reports_ibfk_3` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `products` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(160) NOT NULL,
  `fg_code` varchar(80) NOT NULL DEFAULT '' COMMENT 'not unique in the client data',
  `category` varchar(60) NOT NULL DEFAULT '',
  `brand` varchar(60) NOT NULL DEFAULT '',
  `origin` varchar(20) NOT NULL DEFAULT '',
  `vendor` varchar(20) NOT NULL DEFAULT '',
  `box_size` int unsigned DEFAULT NULL COMMENT 'units per box',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `ps_item_type` varchar(80) NOT NULL DEFAULT '' COMMENT 'Item Master: Item Type',
  `ps_uom` varchar(20) NOT NULL DEFAULT '' COMMENT 'Item Master: UOM',
  `ps_pack_size` varchar(120) NOT NULL DEFAULT '',
  `ps_status` varchar(40) NOT NULL DEFAULT '',
  `ps_photo` varchar(500) NOT NULL DEFAULT '' COMMENT 'Drive file id (old) or ps_files id',
  `ps_spec` varchar(1000) NOT NULL DEFAULT '',
  `ps_mrp` varchar(40) NOT NULL DEFAULT '',
  `ps_remarks` varchar(1000) NOT NULL DEFAULT '',
  `ps_hsn` varchar(20) NOT NULL DEFAULT '',
  `ps_gst` varchar(10) NOT NULL DEFAULT '',
  `ps_moq` varchar(20) NOT NULL DEFAULT '',
  `ps_type` varchar(60) NOT NULL DEFAULT '' COMMENT 'Item Master: Type',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_name` (`name`),
  CONSTRAINT `products_chk_1` CHECK (((`box_size` is null) or (`box_size` > 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_files` (
  `id` varchar(24) NOT NULL COMMENT 'F + random',
  `kind` varchar(20) NOT NULL COMMENT 'photo / signed / popdf',
  `name` varchar(300) NOT NULL,
  `mime` varchar(80) NOT NULL,
  `size` int unsigned NOT NULL,
  `sha256` char(64) NOT NULL,
  `bytes` longblob NOT NULL,
  `uploaded_by` varchar(120) NOT NULL DEFAULT '',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_grn` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `grn_id` varchar(60) NOT NULL DEFAULT '',
  `gate_entry_id` varchar(60) NOT NULL DEFAULT '',
  `po_no` varchar(40) NOT NULL DEFAULT '',
  `po_line_code` varchar(300) NOT NULL DEFAULT '',
  `po_item_name` varchar(300) NOT NULL DEFAULT '',
  `po_qty` varchar(40) NOT NULL DEFAULT '',
  `unit` varchar(20) NOT NULL DEFAULT '',
  `store_received_qty` varchar(40) NOT NULL DEFAULT '',
  `all_ok` varchar(40) NOT NULL DEFAULT '',
  `issue_details` varchar(1000) NOT NULL DEFAULT '',
  `decision` varchar(20) NOT NULL DEFAULT '',
  `approved_qty` varchar(40) NOT NULL DEFAULT '',
  `rejected_qty` varchar(40) NOT NULL DEFAULT '',
  `decision_by` varchar(120) NOT NULL DEFAULT '',
  `decision_at` datetime DEFAULT NULL,
  `po_status` varchar(40) NOT NULL DEFAULT '',
  `vendor_check` varchar(300) NOT NULL DEFAULT '',
  `qty_check` varchar(300) NOT NULL DEFAULT '',
  `exception_flag` varchar(300) NOT NULL DEFAULT '',
  `store_remark` varchar(1000) NOT NULL DEFAULT '',
  `source_row` varchar(20) NOT NULL DEFAULT '',
  `invoice_file_id` varchar(200) NOT NULL DEFAULT '',
  `invoice_file_name` varchar(300) NOT NULL DEFAULT '',
  `invoice_mime` varchar(80) NOT NULL DEFAULT '',
  `damaged_qty` varchar(40) NOT NULL DEFAULT '',
  `damage_type` varchar(80) NOT NULL DEFAULT '',
  `category` varchar(80) NOT NULL DEFAULT '',
  `location` varchar(120) NOT NULL DEFAULT '',
  `gate_entry_complete` varchar(40) NOT NULL DEFAULT '',
  `damage_photo_ids` text,
  `damage_photo_names` text,
  `transport_name` varchar(200) NOT NULL DEFAULT '',
  `bilty_charges` varchar(40) NOT NULL DEFAULT '',
  `bilty_charges_2` varchar(40) NOT NULL DEFAULT '',
  `bilty_lr_no` varchar(80) NOT NULL DEFAULT '',
  `damage_photo_sizes` text,
  `damage_photo_hashes` text,
  `item_photo_id` varchar(200) NOT NULL DEFAULT '',
  `item_photo_name` varchar(300) NOT NULL DEFAULT '',
  `item_photo_mime` varchar(80) NOT NULL DEFAULT '',
  `coa_file_id` varchar(200) NOT NULL DEFAULT '',
  `coa_file_name` varchar(300) NOT NULL DEFAULT '',
  `coa_mime` varchar(80) NOT NULL DEFAULT '',
  `packing_details` varchar(1000) NOT NULL DEFAULT '',
  `packing_total` varchar(40) NOT NULL DEFAULT '',
  `indent_no` varchar(1000) NOT NULL DEFAULT '',
  `grn_line_no` varchar(20) NOT NULL DEFAULT '',
  `submit_key` varchar(120) NOT NULL DEFAULT '',
  `vendor_item_code` varchar(120) NOT NULL DEFAULT '',
  `vendor_item_name` varchar(300) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `ix_po` (`po_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_guidelines` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `type` varchar(120) NOT NULL,
  `spec` varchar(1000) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_indent_rows` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ts` datetime DEFAULT NULL,
  `indent_no` varchar(40) NOT NULL DEFAULT '',
  `item` varchar(300) NOT NULL DEFAULT '',
  `party` varchar(200) NOT NULL DEFAULT '',
  `origin` varchar(20) NOT NULL DEFAULT '',
  `qty` varchar(60) NOT NULL DEFAULT '' COMMENT 'as typed (old rows: free text like 2lakh)',
  `unit` varchar(20) NOT NULL DEFAULT '',
  `urgency` varchar(40) NOT NULL DEFAULT '',
  `image_url` varchar(500) NOT NULL DEFAULT '',
  `filled_by` varchar(120) NOT NULL DEFAULT '',
  `remarks` text,
  `submitted_by` varchar(160) NOT NULL DEFAULT '',
  `email_status` varchar(30) NOT NULL DEFAULT '',
  `category` varchar(80) NOT NULL DEFAULT '',
  `item_type` varchar(80) NOT NULL DEFAULT '',
  `designer_status` varchar(80) NOT NULL DEFAULT '',
  `designer_at` varchar(40) NOT NULL DEFAULT '',
  `designer_image` varchar(500) NOT NULL DEFAULT '',
  `mrp` varchar(40) NOT NULL DEFAULT '',
  `mrp_date` varchar(40) NOT NULL DEFAULT '',
  `sku` varchar(40) NOT NULL DEFAULT '',
  `brand` varchar(60) NOT NULL DEFAULT '',
  `line_id` varchar(40) NOT NULL DEFAULT '',
  `po_no` varchar(40) NOT NULL DEFAULT '',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_line` (`line_id`),
  KEY `ix_ind` (`indent_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_line_steps` (
  `line_id` varchar(40) NOT NULL,
  `step` tinyint unsigned NOT NULL,
  `actual` datetime DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT '',
  `remark` varchar(1000) NOT NULL DEFAULT '' COMMENT 'REMARK (steps 1, 2, 5); steps 3, 4: remark when no next date',
  `next_date` datetime DEFAULT NULL COMMENT 'steps 3, 4: next follow-up date',
  `history` text COMMENT 'the sheet''s cell note: every update with who and when',
  PRIMARY KEY (`line_id`,`step`),
  CONSTRAINT `ps_line_steps_chk_1` CHECK ((`step` between 1 and 5))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_lines` (
  `line_id` varchar(40) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ts` datetime DEFAULT NULL,
  `indent_no` varchar(60) NOT NULL DEFAULT '',
  `item` varchar(300) NOT NULL DEFAULT '',
  `party` varchar(200) NOT NULL DEFAULT '',
  `urgency` varchar(40) NOT NULL DEFAULT '',
  `filled_by` varchar(120) NOT NULL DEFAULT '',
  `remark` text,
  `indent_qty` varchar(60) NOT NULL DEFAULT '' COMMENT 'as typed (number or old free text)',
  `signed_link` varchar(500) NOT NULL DEFAULT '',
  `po_no` varchar(40) NOT NULL DEFAULT '',
  `item_code` varchar(300) NOT NULL DEFAULT '',
  `qty` decimal(18,3) DEFAULT NULL,
  `rate` decimal(18,4) DEFAULT NULL,
  `value` decimal(18,2) DEFAULT NULL,
  `vendor` varchar(200) NOT NULL DEFAULT '',
  `po_date` datetime DEFAULT NULL,
  `edd` datetime DEFAULT NULL,
  `pdf` varchar(500) NOT NULL DEFAULT '',
  `override` varchar(20) NOT NULL DEFAULT '' COMMENT 'RECEIPT OVERRIDE: CANCELLED / RECEIVED / PARTIAL / OPEN / CLOSED',
  `signed_at` datetime DEFAULT NULL,
  `signed_note` varchar(300) NOT NULL DEFAULT '',
  `mailed_at` datetime DEFAULT NULL,
  `mailed_note` varchar(500) NOT NULL DEFAULT '',
  `note` text COMMENT 'SYSTEM NOTE',
  `lead_days` varchar(10) NOT NULL DEFAULT '',
  `unit` varchar(20) NOT NULL DEFAULT '',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`line_id`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `ix_po` (`po_no`),
  KEY `ix_ind` (`indent_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_po_rows` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `po_no` varchar(40) NOT NULL,
  `po_date` datetime DEFAULT NULL,
  `edd` datetime DEFAULT NULL,
  `company` varchar(160) NOT NULL DEFAULT '',
  `vendor` varchar(200) NOT NULL DEFAULT '',
  `item_code` varchar(300) NOT NULL DEFAULT '',
  `item_name` varchar(300) NOT NULL DEFAULT '',
  `hsn` varchar(40) NOT NULL DEFAULT '',
  `qty` decimal(18,3) NOT NULL DEFAULT '0.000',
  `unit` varchar(20) NOT NULL DEFAULT '',
  `rate` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `gst` varchar(10) NOT NULL DEFAULT '' COMMENT 'GST % as in the sheet ("" = not given)',
  `gst_amt` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `indent_no` varchar(1000) NOT NULL DEFAULT '',
  `doer` varchar(120) NOT NULL DEFAULT '',
  `pdf` varchar(500) NOT NULL DEFAULT '' COMMENT 'Drive link (old) or file id of the PDF made here',
  `approval` varchar(20) NOT NULL DEFAULT '' COMMENT 'PENDING / APPROVED / CANCELLED; "" = old PO (rule by GO_LIVE)',
  `approved_by` varchar(120) NOT NULL DEFAULT '',
  `approved_at` datetime DEFAULT NULL,
  `lead_days` varchar(10) NOT NULL DEFAULT '',
  `line_id` varchar(40) NOT NULL DEFAULT '',
  `remarks` varchar(1000) NOT NULL DEFAULT '',
  `vendor_code` varchar(20) NOT NULL DEFAULT '',
  `vendor_item` varchar(300) NOT NULL DEFAULT '',
  `tax_type` varchar(20) NOT NULL DEFAULT '',
  `cgst` decimal(18,2) NOT NULL DEFAULT '0.00',
  `sgst` decimal(18,2) NOT NULL DEFAULT '0.00',
  `igst` decimal(18,2) NOT NULL DEFAULT '0.00',
  `unmatched` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = a PO-sheet row no FMS line matched (kept as found, not used)',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_po` (`po_no`),
  KEY `ix_line` (`line_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `ps_settings` (
  `k` varchar(80) NOT NULL,
  `v` text NOT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `purchase_indents` (
  `indent_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `indent_date` date NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `qty` int NOT NULL,
  `reason` varchar(200) NOT NULL DEFAULT '',
  `supplier_id` int unsigned DEFAULT NULL COMMENT 'the vendor this indent is to be bought from',
  `rate_enc` varchar(255) DEFAULT NULL COMMENT 'encrypted expected rate per unit (carried onto the PO line)',
  `po_no` varchar(20) DEFAULT NULL COMMENT 'set = PO_RAISED',
  `request_no` varchar(24) DEFAULT NULL COMMENT 'the production indent request it came from',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`indent_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  UNIQUE KEY `uq_request` (`request_no`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `component_code` (`component_code`),
  KEY `supplier_id` (`supplier_id`),
  KEY `po_no` (`po_no`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `fk_indent_request` FOREIGN KEY (`request_no`) REFERENCES `indent_requests` (`request_no`),
  CONSTRAINT `purchase_indents_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `purchase_indents_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `purchase_indents_ibfk_3` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `purchase_indents_ibfk_4` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `purchase_indents_ibfk_5` FOREIGN KEY (`po_no`) REFERENCES `purchase_orders` (`po_no`) ON UPDATE CASCADE,
  CONSTRAINT `purchase_indents_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `purchase_order_lines` (
  `po_no` varchar(20) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `qty` int NOT NULL,
  `rate_enc` varchar(255) DEFAULT NULL COMMENT 'encrypted rate agreed on this PO',
  PRIMARY KEY (`po_no`,`line_no`),
  KEY `component_code` (`component_code`),
  CONSTRAINT `purchase_order_lines_ibfk_1` FOREIGN KEY (`po_no`) REFERENCES `purchase_orders` (`po_no`) ON UPDATE CASCADE,
  CONSTRAINT `purchase_order_lines_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `purchase_order_lines_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `purchase_orders` (
  `po_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `po_date` date NOT NULL,
  `supplier_id` int unsigned NOT NULL,
  `expected_date` date DEFAULT NULL,
  `approved_by` int unsigned DEFAULT NULL COMMENT 'set = APPROVED',
  `approved_at` datetime(3) DEFAULT NULL,
  `rejected_by` int unsigned DEFAULT NULL COMMENT 'set = REJECTED by the owner',
  `rejected_at` datetime(3) DEFAULT NULL,
  `reject_reason` varchar(300) DEFAULT NULL,
  `gst_type` enum('INTRA','INTER') DEFAULT NULL COMMENT 'INTRA = CGST 9% + SGST 9%, INTER = IGST 18%; NULL = before GST',
  `tally_push_at` datetime DEFAULT NULL COMMENT 'last attempt to create it in Tally',
  `tally_push_error` varchar(500) DEFAULT NULL COMMENT 'why Tally did not take it (empty = created)',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`po_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `supplier_id` (`supplier_id`),
  KEY `approved_by` (`approved_by`),
  KEY `ix_row_version` (`row_version`),
  KEY `fk_po_rejected_by` (`rejected_by`),
  CONSTRAINT `fk_po_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `users` (`id`),
  CONSTRAINT `purchase_orders_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `purchase_orders_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `purchase_orders_ibfk_3` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `purchase_orders_ibfk_4` FOREIGN KEY (`approved_by`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_po_not_both` CHECK (((`approved_by` is null) or (`rejected_at` is null))),
  CONSTRAINT `purchase_orders_chk_1` CHECK (((`approved_by` is null) = (`approved_at` is null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `qc_intimations` (
  `intimation_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `grn_no` varchar(20) NOT NULL COMMENT 'product, qty, supplier, invoice come from the GRN',
  `issued_on` date NOT NULL,
  `issued_time` time DEFAULT NULL,
  `batch_no` varchar(40) NOT NULL DEFAULT '' COMMENT 'supplier lot number',
  `mfg_date` varchar(10) NOT NULL DEFAULT '',
  `expiry_date` varchar(10) NOT NULL DEFAULT '',
  `remark` varchar(500) NOT NULL DEFAULT '',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`intimation_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  UNIQUE KEY `uq_grn` (`grn_no`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `qc_intimations_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `qc_intimations_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `qc_intimations_ibfk_3` FOREIGN KEY (`grn_no`) REFERENCES `goods_receipts` (`grn_no`),
  CONSTRAINT `qc_intimations_chk_1` CHECK (regexp_like(`mfg_date`,_utf8mb4'^(([0-9]{2}-)?[0-9]{2}-[0-9]{4})?$')),
  CONSTRAINT `qc_intimations_chk_2` CHECK (regexp_like(`expiry_date`,_utf8mb4'^(([0-9]{2}-)?[0-9]{2}-[0-9]{4})?$'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `qc_results` (
  `ar_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `intimation_no` varchar(20) NOT NULL,
  `decided_on` date NOT NULL,
  `status` enum('APPROVED','HOLD','REJECTED') NOT NULL,
  `remark` varchar(500) NOT NULL DEFAULT '',
  `accepted_qty` decimal(14,3) DEFAULT NULL COMMENT 'approved: the part accepted (the rest rejected → debit note); rejected: 0',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`ar_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_intimation` (`intimation_no`,`seq`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `qc_results_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `qc_results_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `qc_results_ibfk_3` FOREIGN KEY (`intimation_no`) REFERENCES `qc_intimations` (`intimation_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `requisition_lines` (
  `req_no` varchar(20) NOT NULL,
  `line_no` smallint unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `unit` varchar(12) NOT NULL DEFAULT 'Pcs',
  `qty_required` int NOT NULL,
  `qty_issued` int DEFAULT NULL,
  `remark` varchar(500) NOT NULL DEFAULT '',
  PRIMARY KEY (`req_no`,`line_no`),
  KEY `ix_component` (`component_code`),
  CONSTRAINT `requisition_lines_ibfk_1` FOREIGN KEY (`req_no`) REFERENCES `requisitions` (`req_no`),
  CONSTRAINT `requisition_lines_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `requisition_lines_chk_1` CHECK ((`qty_required` > 0)),
  CONSTRAINT `requisition_lines_chk_2` CHECK (((`qty_issued` is null) or (`qty_issued` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `requisitions` (
  `req_no` varchar(20) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `req_date` date NOT NULL,
  `department` varchar(40) NOT NULL,
  `product_id` int unsigned DEFAULT NULL,
  `batch_id` int unsigned DEFAULT NULL,
  `packing_sign` varchar(80) NOT NULL DEFAULT '',
  `store_sign` varchar(80) NOT NULL DEFAULT '',
  `issued_at` datetime(3) DEFAULT NULL COMMENT 'set = ISSUED',
  `issued_by` int unsigned DEFAULT NULL,
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  PRIMARY KEY (`req_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `product_id` (`product_id`),
  KEY `batch_id` (`batch_id`,`product_id`),
  KEY `issued_by` (`issued_by`),
  KEY `ix_row_version` (`row_version`),
  CONSTRAINT `requisitions_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `requisitions_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `requisitions_ibfk_3` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `requisitions_ibfk_4` FOREIGN KEY (`batch_id`, `product_id`) REFERENCES `production_batches` (`id`, `product_id`),
  CONSTRAINT `requisitions_ibfk_5` FOREIGN KEY (`issued_by`) REFERENCES `users` (`id`),
  CONSTRAINT `requisitions_chk_1` CHECK (((`batch_id` is null) or (`product_id` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `applied_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `sessions` (
  `id` char(64) NOT NULL COMMENT 'SHA-256 of the cookie token',
  `user_id` int unsigned NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` datetime(3) NOT NULL,
  `ip` varchar(45) DEFAULT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_user` (`user_id`),
  KEY `ix_expires` (`expires_at`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `state_snapshots` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` int unsigned DEFAULT NULL,
  `username` varchar(40) DEFAULT NULL,
  `reason` varchar(60) NOT NULL,
  `documents` int unsigned NOT NULL,
  `data` longtext NOT NULL COMMENT 'encrypted full FlowState',
  PRIMARY KEY (`id`),
  KEY `ix_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `stock_settings` (
  `component_code` varchar(16) NOT NULL,
  `opening_qty` int DEFAULT NULL,
  `min_level` int DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`component_code`),
  CONSTRAINT `stock_settings_ibfk_1` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`),
  CONSTRAINT `stock_settings_chk_1` CHECK (((`opening_qty` is null) or (`opening_qty` >= 0))),
  CONSTRAINT `stock_settings_chk_2` CHECK (((`min_level` is null) or (`min_level` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `supplier_rates` (
  `supplier_id` int unsigned NOT NULL,
  `component_code` varchar(16) NOT NULL,
  `rate_enc` varchar(255) DEFAULT NULL COMMENT 'encrypted fixed rate; NULL = vendor supplies it, no fixed rate',
  `vendor_item_name` varchar(300) NOT NULL DEFAULT '',
  `ps_origin` varchar(20) NOT NULL DEFAULT '' COMMENT 'origin on that Item Master row (CHINA rows are not offered)',
  `ps_row` int unsigned DEFAULT NULL COMMENT 'order in the Item Master (cheapest-first ties keep sheet order)',
  PRIMARY KEY (`supplier_id`,`component_code`),
  KEY `component_code` (`component_code`),
  CONSTRAINT `supplier_rates_ibfk_1` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `supplier_rates_ibfk_2` FOREIGN KEY (`component_code`) REFERENCES `components` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `suppliers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `vendor_code` varchar(20) DEFAULT NULL COMMENT 'the client vendor code (V-0076)',
  `city` varchar(80) NOT NULL DEFAULT '',
  `approved` tinyint(1) NOT NULL DEFAULT '1',
  `from_tally` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'a ledger in Tally (synced)',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `vm_status` varchar(40) DEFAULT NULL COMMENT 'Vendor Master status; NULL = not on the Vendor Master',
  `contact_person` varchar(160) NOT NULL DEFAULT '',
  `phone_enc` varchar(255) DEFAULT NULL,
  `email` varchar(255) NOT NULL DEFAULT '',
  `address` varchar(600) NOT NULL DEFAULT '',
  `gstin` varchar(20) NOT NULL DEFAULT '',
  `payment_terms` varchar(160) NOT NULL DEFAULT '',
  `bank_account_enc` varchar(255) DEFAULT NULL,
  `ifsc` varchar(20) NOT NULL DEFAULT '',
  `bank_name` varchar(120) NOT NULL DEFAULT '',
  `udyam_no` varchar(60) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_name` (`name`),
  UNIQUE KEY `uq_vendor_code` (`vendor_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `tally_items` (
  `name` varchar(200) NOT NULL,
  `alias` varchar(80) NOT NULL DEFAULT '',
  `unit` varchar(16) NOT NULL DEFAULT '',
  `grp` varchar(120) NOT NULL DEFAULT '',
  `master_id` bigint unsigned NOT NULL,
  `alter_id` bigint unsigned NOT NULL,
  `synced_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `tally_po_lines` (
  `po_no` varchar(40) NOT NULL,
  `line_no` int unsigned NOT NULL,
  `item_name` varchar(160) NOT NULL,
  `item_code` varchar(16) NOT NULL DEFAULT '' COMMENT 'PMS code when the item is in the component master',
  `qty` decimal(14,3) NOT NULL,
  `unit` varchar(16) NOT NULL,
  PRIMARY KEY (`po_no`,`line_no`),
  CONSTRAINT `tally_po_lines_ibfk_1` FOREIGN KEY (`po_no`) REFERENCES `tally_purchase_orders` (`po_no`),
  CONSTRAINT `tally_po_lines_chk_1` CHECK ((`qty` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `tally_purchase_orders` (
  `po_no` varchar(40) NOT NULL,
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `po_date` date NOT NULL,
  `supplier_name` varchar(160) NOT NULL,
  `cancelled` tinyint(1) NOT NULL DEFAULT '0',
  `synced_at` datetime NOT NULL,
  `guid` varchar(80) NOT NULL DEFAULT '' COMMENT 'Tally voucher GUID',
  `alter_id` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'Tally change number of the copy',
  `row_version` bigint unsigned NOT NULL DEFAULT '0' COMMENT 'state version of the last change',
  `created_by` int unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` int unsigned DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`po_no`),
  UNIQUE KEY `uq_seq` (`seq`),
  KEY `created_by` (`created_by`),
  KEY `updated_by` (`updated_by`),
  KEY `ix_row_version` (`row_version`),
  KEY `ix_supplier` (`supplier_name`),
  CONSTRAINT `tally_purchase_orders_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `tally_purchase_orders_ibfk_2` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE TABLE IF NOT EXISTS `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `username` varchar(40) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` enum('gate','store','qc','packing','fgwh','accounts','purchase','security','admin') NOT NULL,
  `label` varchar(80) NOT NULL,
  `full_name` varchar(80) NOT NULL DEFAULT '',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `must_change_password` tinyint(1) NOT NULL DEFAULT '1',
  `failed_logins` int unsigned NOT NULL DEFAULT '0',
  `locked_until` datetime(3) DEFAULT NULL,
  `password_changed_at` datetime(3) DEFAULT NULL,
  `last_login_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `ps_name` varchar(120) DEFAULT NULL COMMENT 'Purchase System login name (Doer)',
  `ps_access` varchar(120) NOT NULL DEFAULT '' COMMENT 'Doer B: ALL or STEP 1,STEP 2 …',
  `ps_types` varchar(120) NOT NULL DEFAULT '' COMMENT 'Doer Type: Chemical / Other / blank',
  `ps_email` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_username` (`username`),
  UNIQUE KEY `uq_ps_name` (`ps_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_grn_qc_status` AS select `r`.`grn_no` AS `grn_no`,coalesce((select `q`.`status` from (`qc_intimations` `i` join `qc_results` `q` on((`q`.`intimation_no` = `i`.`intimation_no`))) where (`i`.`grn_no` = `r`.`grn_no`) order by `q`.`seq` desc limit 1),'UNDER_TEST') AS `qc_status`,(select `q`.`accepted_qty` from (`qc_intimations` `i` join `qc_results` `q` on((`q`.`intimation_no` = `i`.`intimation_no`))) where (`i`.`grn_no` = `r`.`grn_no`) order by `q`.`seq` desc limit 1) AS `accepted_qty` from `goods_receipts` `r`
;
INSERT IGNORE INTO app_meta (k, v) VALUES ('masters_version', '0'), ('resync_version', '1'), ('state_version', '1')
;
INSERT IGNORE INTO document_sequences (series, last_no) VALUES ('AR', 0), ('BOM', 0), ('DN', 0), ('DPS', 0), ('FGT', 0), ('FTN', 0), ('GE', 0), ('GR', 0), ('IND', 0), ('IR', 0), ('MRB', 0), ('MRN', 0), ('PDI', 0), ('PO', 0), ('QCI', 0), ('REQ', 0), ('WO', 0)
;
SET FOREIGN_KEY_CHECKS = 1
;
