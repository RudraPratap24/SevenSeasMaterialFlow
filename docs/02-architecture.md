# 2. How it is built: one backend, one database, many modules

## The idea

The client runs small tools on **Google Sheets + Apps Script** (a page `Index.html`, server code `Code.gs`, data in
sheets). We take each tool over:

- their **page** is served by our backend **exactly as they wrote it** (no redesign, users see nothing new);
- their **server code** is rewritten by us in TypeScript, with the same function names and behaviour;
- their **sheet data** moves into our **one MySQL database**, which becomes the only source of truth.

Each tool is a **module**. Every module shares one **core**: logins, the admin page, the database, mail, audit log.

```
                    browser (the client's own page, unchanged)
                         │  google.script.run.fn(args)
                         ▼
   /gas/shim.js  ──►  POST /api/<module>/call/<fn>  {args:[…]}
                         │
   ┌─────────────────────┴───────────────────────────── server (Express + TypeScript) ──┐
   │ core: security headers · rate limits · CSRF check · sessions · audit · mail · jobs   │
   │   /admin           users, items, FG, vendors, item ↔ vendor (shared masters)         │
   │   /<id>            the module's page (served from modules/<name>/source/Index.html)  │
   │   /api/<id>/…      the module's functions (modules/<name>/server/api.ts)             │
   └─────────────────────┬───────────────────────────────────────────────────────────────┘
                         ▼
          MySQL `seven_seas_flow` — shared masters + each module's tables (<id>_…)
```

## Folders

```
server/                 THE CORE (every module uses it)
  src/index.ts            starts the server, runs the modules' timed jobs
  src/app.ts              security, /api, mounts every module, /admin, the front page /
  src/modules.ts          the list of modules — add a new one here
  src/module.ts           what a module must provide (the contract, see below)
  src/gas/bridge.ts       Apps Script bridge: serves a client page, runs its calls
  src/gas/shim.js         google.script.run / google.script.url in the browser
  src/admin/              the admin page (page.html, admin.js) and its API (routes.ts)
  src/authRoutes.ts       login / logout / change password (cookie session, used by /admin)
  src/sessions.ts         sessions in the `sessions` table
  src/schema.ts           migrations; baseline.sql = the schema up to version 43
  src/sync.ts             "is it already there?" merge, used by every importer
  src/crypto.ts           password hashing, encryption of sensitive fields
  src/mail.ts audit.ts config.ts db.ts roles.ts
  scripts/                setup.ts (db:setup), user.ts (logins), importMaster.ts, master.ts, init-env.ts
  test/                   run.mjs (npm test), core.mjs
modules/<name>/         ONE CLIENT TOOL
  MODULE.md               everything about it (read this first)
  source/                 the client's files (only Index.html is in Git)
  server/                 module.ts (definition) · api.ts (functions) · schema.ts (tables) · import.ts …
  test/                   its tests (synthetic data)
tools/xlsx2json.py      any workbook → JSON, first step of every import
legacy/                 the earlier full Material Flow app — see 06-legacy-full-flow.md
docs/                   these documents
```

## The module contract (`server/src/module.ts`)

A module exports one object (see `modules/purchase-system/server/module.ts`):

| Field | What |
|---|---|
| `id` | short name: page `/<id>`, calls `/api/<id>/call/<fn>`, tables `<id>_…` (Purchase System = `ps`) |
| `page` | `file` (the client's Index.html), `vars` (values for `<?= name ?>`), `patches` (the only allowed edits), `csp` |
| `functions` | name → function, the same names as in Code.gs. Each gets `(call, ...args)`; `call.token` = first argument if text |
| `guarded` | login-type functions: limited to 30 tries / 15 min per address + name |
| `routes` | extra endpoints (files, images) under `/api/<id>` |
| `jobs` | what Apps Script time-triggers did: `everyMinutes` or `at: "09:00"` |
| `grants` | what the app's database account may do on the module's tables |
| `migrations` | its table changes (versions are global: take the next free number) |

The bridge refuses to start if a declared patch no longer matches the page, or the page uses an Apps Script template
feature we do not support — so a changed client file is noticed at once, not in front of users.

## The database

- **One database** (`seven_seas_flow`). The app connects as `flow_app`, which has rights **table by table** (from
  `appGrants()` in `schema.ts` + each module's `grants`). `npm run db:setup` (admin account) creates tables and rights.
- **Shared masters** (one copy for all modules, edited on `/admin`):
  `users` (logins + per-module rights, e.g. `ps_access`), `components` (PM/RM items), `products` (finished goods),
  `suppliers` (vendors), `supplier_rates` (item × vendor: rate, vendor's item name).
- **Module tables** are named `<id>_…`. They point at masters by code; documents keep what was printed plus the code.
- **Calculated values are not stored** (planned dates, delays, status): worked out on read, like the sheet formulas.
- **Encrypted columns** (`*_enc`, rates): AES with `DATA_ENCRYPTION_KEY`. Passwords: hashed (scrypt), never stored.
- **Migrations**: `baseline.sql` creates everything up to version 43 on an empty database; newer changes are in
  `schema.ts` / the module's `schema.ts`. Never edit an applied migration — add a new one. Back up first.
- Old Material Flow tables (gate entries, GRN lines, stock …) are still in the database but unused; the app account
  has no rights on them.

## Security in short

Cookie sessions for `/admin` (SameSite=Strict, 12 h max, 2 h idle); module pages send a session token as the first
argument (as the Apps Script page did). Every write needs the header `x-flow-request: 1` and the right `Origin`
(`APP_ORIGIN`). Rate limits on all API calls and logins; lock-out after wrong passwords. Request logs never contain
bodies. Strict Content-Security-Policy everywhere except module pages (client pages use inline scripts).
Every change on `/admin` and important module actions go to `audit_log`.

## Importing a sheet

`python -I tools/xlsx2json.py <workbook>` → `out/sheets.json` → the module's `import.ts` reads it, checks the headers
it depends on, builds rows, and merges them with `syncRows` (`server/src/sync.ts`):

| Row in the sheet… | Result |
|---|---|
| not in the database | added |
| same as the database | left alone |
| different | **before go-live**: updated (sheet is the record) · **after go-live**: listed as a conflict, database kept |
| only in the database | listed, never deleted |

Dry run by default (everything rolls back) with a Markdown report; `--apply` keeps it. Running the same sheet twice
must report nothing new and nothing changed.

Next: [03 — adding a module](03-adding-a-module.md).
