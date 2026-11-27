# 5. Pending work

In order. Tick items here as you finish them. Real data lists (names, numbers) are in the import reports and the
`ps_import_audit` table — never copy them into Git.

## A. Finish the Purchase System (until the client can stop using the sheet)

**Where it stands (2026-11-27):** all sheet data is in the database (1,541 lines, 547 POs, 611 indent rows, 197 GRN
rows, 310 vendors, 7 logins) in one-record-per-fact form; the client's page runs on our backend at `/ps`; 48
automated checks pass. **Nobody has clicked through it in a browser against the sheet yet, and it is not live.**

1. **Click through every page in a browser and compare with the sheet.** Log in as each Doer at `/ps`:
   Home, Indent (and the public form `/ps?page=indent`), Make PO, PO register + approval, PDF, Mail to vendor,
   Signed copy upload, Follow-up tasks (steps 1–5), GRN list, Tally XML, Dashboard, Performance, Admin.
   Note every difference; fix it in `modules/purchase-system/server/api.ts` (rules in `core.ts`) and add a check
   to `test/ps.mjs`.
2. **Email.** Fill `SMTP_HOST / PORT / SECURE / USER / PASS / FROM` in `.env` (the company mail provider gives these).
   Until then: indent mails show *Email Failed*, *Mail to vendor* says email is not set up, no 09:00 digest.
3. **Doer emails.** The Doer sheet had none. Add each person's email on `/admin` → Users → Email
   (the 09:00 task digest and approval mails go there).
4. **Company settings live in code.** Purchase mail, director mail, company name/address, go-live date, GST rates,
   urgency list, approval on/off: the `CFG` object at the top of `modules/purchase-system/server/core.ts` (copied
   from Code.gs). Confirm them with the owner; move to `ps_settings` + `/admin` if they change often.
5. **Passwords.** Doer passwords came from the sheet in plain text (now stored only as hashes). Ask everyone to set
   a new one; delete the password column from the sheet. Change `admin`'s password too.
6. **Things the admin cannot edit yet** (the sheet was the editor; after go-live there is no screen):
   - the **indent-form password(s)** (`ps_settings.indent_passwords`, hashed) — add a "set indent password" on
     `/admin` or a command;
   - the **Guidelines** (spec lines printed on POs, `ps_guidelines`) — add a small list editor on `/admin`.
7. **Review the import with the Purchase team** (`modules/purchase-system/source/out/ps-import-report.md`,
   table `ps_import_audit`): 273 PO-sheet rows with no FMS line, 139 PO-header values that differed between rows,
   5 Indent values that differed (all kept in the audit, not shown); 358 lines with two indent numbers (both kept);
   26 vendor names that differ from the app's; 19 vendors only in the Item Master; 36 FG names; 1 item without SKU.
   Owner's rule so far: **the FMS wins**. Anything they want different: change `server/records.ts`, re-import.
8. **Hosting.** Decide where it runs (see [07 — operations](07-rules-and-operations.md#deploy)): a fixed address
   (own domain + named Cloudflare tunnel, or a cloud server in India), `NODE_ENV=production`, `npm run build` +
   `npm start` as a service, daily backups.
9. **Cut-over day.** Freeze the sheet (view only) → export it → `python -I tools/xlsx2json.py "<file>.xlsx"` →
   `npm run ps:import` (dry run, read the report) → back up → `npm run ps:import -- --apply --live`.
   From then on the database is the record; tell everyone the new link.
10. **GRN.** `ps_grn` is a copy of the separate GRN system (another sheet). Until it becomes a module, refresh the copy
    after each export: `npm run ps:import -- --apply --only=grn` (the copy always follows that sheet).
11. **Old Google Drive files** (old photos, PO PDFs, signed copies): must stay shared "anyone with the link" — the
    page still shows them from Drive. New files are stored in our database (`ps_files`).

12. **Item photos.** Loaded from `Master_Item_Databank.xlsx` on 2026-11-27 (`npm run master:photos`): 19 added,
    337 already the same. Still open: 14 items where the databank has a **different** photo than the Purchase System
    sheet (re-run with `--overwrite` if the owner says the databank's are the right ones), 7 databank items not in our
    item master yet, 3 photo cells that are text instead of a link (list: `photos-report.md` next to the export).
    Photos show only if each Drive file is shared "anyone with the link"; new ones can be pasted on `/admin`.

### Smaller, after go-live
- **Purchase Archive** sheet (lines the script moved out when closed): import it if the client finds it.
- **Signed / mailed dates** are still kept per line (the sheet's shape); they belong on the PO (`ps_pos`).
- **Page security:** `/ps` has to allow inline scripts (the client page has 108 inline handlers).
- **PO PDF speed:** a PO with many old Drive photos fetches each one from Drive. Watch it.
- **09:00 digest** runs only if the server is up at 09:00 (a restart at 09:05 skips that day).
- **Files in the database** (`ps_files`, LONGBLOB): fine for now; move to object storage if it grows past a few GB.

## B. Next modules

- **GRN module** — the GRN system becomes a module that writes `ps_grn` (or its own `grn_` tables) directly.
- Any further client tool: put its files in `modules/<name>/source/` and follow [03](03-adding-a-module.md).
- When a second module needs file storage, promote `ps_files` to a shared `files` table.

## C. Server

- MySQL listens on every network address in Laragon by default: add `bind-address = 127.0.0.1` to `my.ini`.
- Never expose MySQL (3306) or Tally (9000) to the network.

## D. Later

- An assistant (RAG agent) over the modules: rewrite `legacy/docs/AGENT_RULEBOOK.md` for the modules first.
- Old Material Flow items (stock count, minimum levels, BOM, Tally…) are paused with the legacy app — see
  [06](06-legacy-full-flow.md#its-open-items).
