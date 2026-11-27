# 3. Adding a module (a new client tool)

A **module** is one client tool that used to run on Google Sheets + Apps Script, now served by our backend from the
**one database**. The client's page is served **exactly as they wrote it**; their Apps Script functions are rewritten
on our side; their sheet data is moved into our tables. Purchase System (`purchase-system/`) is the worked example —
copy its shape. Read [02 — architecture](02-architecture.md) first.

```
modules/<name>/
  MODULE.md          what it is, status, sheet → table map, rules ported, page patches, import + cut-over steps
  source/            the client's files, untouched
    Index.html         their page (in Git — it is code)
    Code.gs            their Apps Script (local only: may hold staff emails)   ┐ gitignored:
    <workbook>.xlsx    their data (local only)                                  │ real data never
    out/               exports and import reports (local only)                  ┘ goes into Git
  server/
    module.ts        the definition (id, page, functions, jobs, grants, migrations) — registered in server/src/modules.ts
    api.ts           the ported functions: same names, same arguments, same return shapes, same error texts
    schema.ts        its tables (migrations) + what the app account may do on them (grants)
    import.ts        sheet export → database, merged by key (dry run by default)
    …                anything else it needs (pure rules in core.ts, PDF, …)
  test/*.mjs         end-to-end checks on synthetic data (run by npm test)
```

The core (`server/`) gives every module: login + sessions, the admin page (users, items, FG, vendors, item ↔ vendor),
the Apps Script bridge, mail (SMTP), the audit log, the merge helper, migrations and grants.

## The rules

1. **One database, one record per fact.** Before adding a column, look for the fact in what exists:
   - **Masters are shared** — `users`, `components` (PM/RM items), `products` (FG), `suppliers`, `supplier_rates`
     (item × vendor). A module adds columns to them only for facts the masters don't have (prefix them, e.g.
     `ps_hsn`), and never keeps its own copy of an item, vendor or person.
   - **Documents keep what was printed** (item text, vendor name, rate on a PO) **plus the master code** — that is a
     record of what happened, not a duplicate. Master facts (spec, HSN, GSTIN, bank) live only in the master.
   - A sheet that repeats a fact (the same line in two tabs, a header copied on every row) becomes one row; where the
     copies disagree, pick the copy the client's own pages work from, and keep every other value in an audit table
     (`<id>_import_audit`) — nothing is lost, nothing is guessed silently. Ask the owner when it is not clear.
   - Values the script **calculated** (planned dates, delays, status) are worked out on read, not stored.
2. **Tables are named `<id>_…`** (Purchase System = `ps_`). Migration versions are global: take the next free number.
3. **The client's page is not edited.** The bridge serves it with `google.script.run` working. If a change is
   unavoidable (e.g. a URL), declare it as a `patch` in `module.ts` — it must match exactly once or the server will not
   start — and list it in MODULE.md.
4. **Same behaviour as the script**, including its error texts (the page reacts to them). Close real holes the script
   had (unauthenticated actions, no rate limit on logins) and say so in MODULE.md.
5. **Real data never goes into Git or tests.** Tests make their own synthetic rows. Back up the working database
   before every migration or `--apply`.

## Steps

1. **Drop the client's files** into `modules/<name>/source/` (`Index.html`, `Code.gs`, the workbook).
2. **Read `Code.gs`**: list every function the page calls (`google.script.run.<fn>` in `Index.html`), every sheet and
   column it reads or writes, its time triggers, and its `doGet` template variables (`<?= name ?>`).
3. **Map the data** in MODULE.md, one line per sheet column: → existing master column / existing table / new column
   (and why). Check the real data for repeated facts and disagreements before deciding (`tools/xlsx2json.py`, then
   query or script over the JSON).
4. **Tables**: `server/schema.ts` exports `<ID>_MIGRATIONS` (`{ version, name, statements, run? }`) and `<ID>_GRANTS`
   (least privilege; DELETE only where a function really deletes).
5. **Port the functions** into `server/api.ts`. Each gets `(call, ...args)`; `call.token` is the first argument when it
   is text (Apps Script pages pass their session token there). Errors: `throw new Error("text the page expects")`.
6. **Define and register** the module: `server/module.ts` (copy Purchase System's), add it to `server/src/modules.ts`.
   Page at `/<id>`, calls at `/api/<id>/call/<fn>`, jobs (the script's time triggers) run inside the server.
7. **Import**: `python -I tools/xlsx2json.py "modules/<name>/source/<workbook>.xlsx"` → `source/out/sheets.json`;
   `server/import.ts` reads it, checks the headers it relies on, builds rows and merges them with `syncRows`
   (`server/src/sync.ts`): new rows added, same rows left alone, differing rows updated before go-live and only
   reported after it, nothing deleted. Dry run by default; `--apply` keeps it. Run it twice: the second run must
   report nothing new and nothing changed.
8. **Test**: `modules/<name>/test/<name>.mjs` — synthetic masters, every page call end to end, permissions, error
   texts, and "served page = source + declared patches". `npm test` runs it on its own `_test` database.
9. **Cut-over**: freeze the sheet, export, dry run, back up, `--apply --live`. From then on the database is the record
   and the sheet is read-only history.

## Commands

| | |
|---|---|
| `npm run dev` | server with reload (http://localhost:4000) |
| `npm test` | every suite on a fresh `_test` database |
| `npm run db:setup` | apply new migrations + grants (back up first) |
| `python -I tools/xlsx2json.py <xlsx>` | workbook → `out/sheets.json` |
| `npm run ps:import -- [--apply] [--only=grn] [--live]` | Purchase System import |

Next: [04 — Purchase System](../modules/purchase-system/MODULE.md) (the worked example) ·
[05 — pending work](05-pending-work.md).
