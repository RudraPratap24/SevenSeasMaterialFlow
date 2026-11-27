# 4. Purchase System (`ps`) — module 1

← [back to the start](../../README.md) · how modules work: [docs/02](../../docs/02-architecture.md)

The client's "Purchase System" Google Sheet + Apps Script (Code.gs v2.0): indent → PO → approval → mail to vendor →
5-step follow-up → receipt (from the GRN system). Served by our backend; the sheet is no longer needed.

- Page: `/ps` (staff) and `/ps?page=indent` (public indent form, password) — `source/Index.html`, unchanged.
- Calls: `/api/ps/call/<fn>` — the 33 functions of Code.gs in `server/api.ts`, same names/arguments/returns/errors.
- Files: `/api/ps/file/<id>` (photos, PO PDFs, signed copies stored here; old ones stay on Google Drive).
- Jobs: `autoRun` every 30 min (auto-close old indents that already have a PO), `dailyDigest` 09:00 (task mail).
- Status (2026-11-27): data imported (1,541 lines, 547 POs, 611 indent rows, 197 GRN rows, 310 vendors, 7 logins); not live yet
  (`ps_settings.live` empty → a re-import still follows the sheet).

## Sheets → tables

| Sheet | Goes to | Key |
|---|---|---|
| Doer | `users` (`ps_name`, `ps_access` steps, `ps_types`, `ps_email`; password hashed once, then the person's) | `ps_name` |
| Vendor Master | `suppliers` (contact, phone🔒, email, address, GSTIN, terms, bank🔒, IFSC, Udyam, `vm_status`) | vendor code, else name |
| Item Master | `components` (PM/RM, `ps_*` fields) / `products` (FG) + `supplier_rates` (item × vendor: rate🔒, vendor item name, origin, `ps_row` order) | SKU code / FG code or name |
| Guidelines | `ps_guidelines` | type + text |
| FMS (one row per line) | `ps_lines` (indent part, follow-up state, `po_no` → current PO) + `ps_line_steps` (5 steps) | LINE ID |
| Indent | onto its `ps_lines` row (`in_register`, `register_no`, origin, image, submitted by, email status, category, item type, SKU, brand, designer, MRP) | time ±1 s + item |
| PO | `ps_pos` (one per PO) + `ps_po_lines` (one per line, `line_id` → `ps_lines`) | PO no. / PO no. + LINE ID |
| GRN | `ps_grn` (copy of the external GRN system, all 50 columns) | GRN id + line + PO + item, in order |

🔒 = encrypted. Column positions: `server/import.ts` (`F`, `STEP_COL`, `GRN_COLS`, Indent/PO readers).
Not stored (worked out on read in `server/core.ts`): planned dates, delays, receipt status, stage, archive.

## One record per fact (migration 44, `server/records.ts`)

The sheet kept the same line in three tabs (Indent, PO, FMS) and the PO header on every PO row, and the copies
disagree. Owner's decision (2026-11-25): **the FMS wins**; the PO header follows the rule the page always used
(first PO row; approval by precedence; first PDF); an empty FMS value is filled from the other sheet; every value not
kept is in `ps_import_audit` (sheet, ref, field, kept, other, note).

| What was dropped | Count |
|---|---|
| PO-sheet rows matching no FMS line | 273 |
| PO header values differing between rows of one PO (PDF 97, EDD 10, date 9, vendor 9, company 7, doer 7) | 139 |
| Indent-sheet values differing from the FMS (party 3, remark 1, qty 1) | 5 |

Kept as two named facts (not a duplicate): the Indent-sheet number (`register_no`) where it differs from the FMS
indent number (358 lines) — POs quote either. Effect on the pages: stage and receipt status unchanged for all 1,541
lines and the PO register unchanged for all 547 POs; 3 lines shift a planned date/delay (their PO had two dates);
600 lines now show the unit typed on the indent (the FMS had none).

## Page patches (the only changes to `source/Index.html`)

1. `const thumb = …` — photos uploaded here are our files (`F…`) → `/api/ps/file/<id>`; older ones stay on Drive.

`<?= mode ?>` is filled by the bridge (`indent` for `?page=indent`, else `app`), as `doGet` did.

## Import / cut-over

```
python -I tools/xlsx2json.py "modules/purchase-system/source/<workbook>.xlsx"
npm run ps:import                        # dry run → source/out/ps-import-report.md
npm run ps:import -- --apply             # back up first
npm run ps:import -- --apply --only=grn  # GRN copy only (until the GRN module writes ps_grn)
npm run ps:import -- --apply --live      # cut-over day: after this the database is the record
```
A re-import of the same sheet reports 0 new / 0 changed. After `--live` the masters are not read (admin page owns
them) and differing rows are reported as conflicts, not overwritten (`--overwrite` forces the sheet).

## Closed holes (the script had them)

Unauthenticated recalc/archive and `getPublicBoot(true)` bypass removed; logins and the indent password rate-limited;
passwords only as hashes; sessions server-side (token = first argument of each call).

## Open

What is left to make it complete (browser check, email, passwords, editors for indent password and guidelines,
hosting, cut-over, GRN): [docs/05-pending-work.md](../../docs/05-pending-work.md#a-finish-the-purchase-system-until-the-client-can-stop-using-the-sheet).
