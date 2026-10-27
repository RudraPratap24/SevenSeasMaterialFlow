# Seven Seas Material Flow

The client's Material Management SOP (SOP/SCM/001 v2.1) as a multi-user web application — the
complete 22-step flow from a material vehicle at the factory gate to finished-goods dispatch and
gate-out. Every register mirrors one of the client's own documents, column for column.

React + Vite frontend, Node.js + Express backend (TypeScript), MySQL 8 relational database
(see `docs/DATABASE_DESIGN.md`; every endpoint with real requests and responses in `docs/API.md`). Department logins, role-based
access enforced on the server, sensitive fields encrypted at rest, every action audited.

## Run it locally (Laragon MySQL)

```bash
npm install
npm run env:init                    # writes .env with fresh secrets (never commit it)
npm run db:setup -- --dev-passwords # database, app account, schema, suppliers, 9 logins (seven@<dept>)
npm run db:demo                     # optional: load the demo storyline
npm run dev                         # API on :4000 + web on http://localhost:5173
```

`db:setup` connects as `DB_ADMIN_USER` (Laragon: `root`, empty password) only to create the
database and a restricted `flow_app` account; the server itself always runs as `flow_app`.
Without `--dev-passwords`, random temporary passwords are printed once and each department must
choose its own at first login.

## Production

```bash
npm run env:init -- --production   # then edit APP_ORIGIN (https://…) and DB_* in .env
npm run db:setup                   # prints the temporary department passwords ONCE
npm run build                      # dist/ (frontend) + dist-server/ (backend)
npm start                          # one process serves the API and the frontend
```

Put it behind a TLS reverse proxy (Caddy or Nginx) on the same host, set `TRUST_PROXY=1`, keep
`HOST=127.0.0.1` so Node is not reachable directly, and keep `ALLOW_DEMO_RESET=false`. Back up the
database daily **and** `DATA_ENCRYPTION_KEY` separately — without the key the encrypted fields in
the database and its backups cannot be read. Remove `DB_ADMIN_*` from `.env` after setup.

User management is command-line only (deliberately not exposed over the web):

```bash
npm run user -- list
npm run user -- create ramesh store "Store — Ramesh"
npm run user -- reset ramesh      # new temporary password, signs out everywhere
npm run user -- disable ramesh    # blocks login, signs out everywhere
npm run user -- unlock ramesh     # after 5 wrong passwords
```

**Customers** are edited on the Dispatch tab (Accounts and Admin): a corrected name or address
shows on every order and dispatch at once; a stale edit (someone else saved first) and a
duplicate name are refused.

Other master data is renamed in one place, and every document shows the new name at once
(maintenance command, admin database account):

```bash
npm run master -- rename-product "LL-112 Ultra Matter liquid Lipstick" "LL-112 Ultra Matte Liquid Lipstick"
npm run master -- rename-component PMS0002 "APF CAP (black)"
npm run master -- rename-supplier "Aplay Creation" "Aplay Creations Pvt Ltd"
npm run master -- rename-customer "Meera Cosmetics" "Meera Cosmetics LLP"
```

## Tally (MySQL keeps the copy)

The app never calls Tally from a screen. A sync reads Tally and keeps a copy in MySQL; every screen reads
MySQL only, so the app keeps working when Tally is closed or offline. The only write: an approved PO (below).

```bash
npm run tally -- sync            # what changed in Tally since the last sync (by Tally's AlterID)
npm run tally -- sync --full     # everything again; POs deleted in Tally are marked cancelled
npm run tally -- watch           # the above every TALLY_SYNC_SECONDS (30), full once a day — `npm run dev` starts it;
                                 # on its own: if Tally is closed it records why (Purchase screen) and retries
npm run tally -- import <file>   # POs from an "Export → XML (Data Interchange)" file instead
npm run tally -- push <PO no> [--date yyyymmdd]   # create a PO raised + approved here in Tally (see below)
```

**Creating a PO in Tally** (the only write to Tally) is off unless `TALLY_ALLOW_WRITE=true` — use it on a
test copy of Tally until Accounts agrees (Educational mode takes only the 1st or 2nd: set `TALLY_TEST_DATE`,
e.g. `20261001`, or `--date`). When on, **approving a PO sends it to Tally on its own**; the Purchase screen shows
IN TALLY ✓, or NOT SENT TO TALLY with the reason and a **Retry** button (`push` does the same from the command line).
It sends only an approved PO whose number Tally doesn't have yet, whose vendor is a Tally ledger, whose items are
Tally stock items and whose lines all have a rate, in the shape of the company's own POs (vendor ledger, items,
godown Main Location, Purchase-Gst; no GST lines yet), then reads it back. Once vendors are synced from Tally,
indents and POs can only use Tally vendors.

One sync reads three things, nothing else:
- **stock items** → the app's items: the PMS/PMR alias is the code, else `T` + Tally's MasterID; name and unit
  as in Tally. Only items bought on a PO or carrying a PMS/PMR code become app items; a rename in Tally keeps
  the code (matched by MasterID).
- **vendors** (ledgers under Sundry Creditors) → approved suppliers.
- **Purchase Orders** → the PO copy the gate searches (expense POs without stock items are left out; a PO
  that cannot be read exactly — e.g. a number used twice — is skipped and listed on the Purchase screen).

Settings in `.env`: `TALLY_URL` (default `http://localhost:9000`), `TALLY_COMPANY` (empty = the company open
in Tally), `TALLY_PO_VOUCHER_TYPES`. Tally must be open with the company loaded and its server on
(F1 → Settings → Connectivity → Client/Server configuration, port 9000); block the port from the network
(`New-NetFirewallRule … -LocalPort 9000 -Action Block`) — it has no login. To keep MySQL up to date, run
`npm run tally -- sync` every 10 minutes from Windows Task Scheduler (start in this folder).

**PO open / closed:** a PO is open until every item has arrived (Store's GRN count once it exists, else the gate
qty). Tally cannot tell which older POs were received (most purchase invoices don't name their PO), so a PO can
be **closed in MySQL**: by Purchase (with a reason) on the Purchase screen, reopened the same way, and once at
go-live by the owner — *Close old POs* closes every PO dated before a date that has nothing received in the app.

## Security model

| Concern | How it is handled |
|---|---|
| Passwords | scrypt (N=2¹⁵, per-user salt), never stored or logged in clear; policy ≥10 chars, 3 character classes; temporary passwords must be changed at first login |
| Sessions | 256-bit random token in an `httpOnly`, `SameSite=Strict`, `Secure` (`__Host-`) cookie; only its SHA-256 is stored; 2 h idle / 12 h absolute expiry; fresh token on login; password change signs out other sessions |
| Brute force | 5 wrong passwords lock the login for 15 min (atomic counter); 20 failed logins per IP per 15 min; same message and timing for unknown users |
| CSRF | SameSite=Strict cookie + required `X-Flow-Request` header + Origin/Referer must equal `APP_ORIGIN`; CORS is never enabled |
| Authorisation | every action checked server-side against the shared `PERMS` table (`src/flow/perms.ts`); buttons hidden in the UI are only cosmetic |
| Read restriction | each role receives only the registers its screens need (`READ_SCOPES`); PO rates and the supplier price master only for Purchase/Admin; customer names, addresses, customer PO and invoice numbers only for FG WH, Accounts, Security, Admin |
| Input | strict zod schema per action: unknown fields, wrong types, oversized values, unknown component/product codes and bad dates are refused; 200 kB body limit |
| Integrity | the server stamps document dates/times, takes names/codes from the master data, recomputes totals, carries GRN supplier/PO/invoice from the gate entry, and signs PO approval with the logged-in identity |
| Concurrency | each action locks only the documents it changes and the stock/batch its rule depends on (unrelated work runs in parallel), in one transaction; refused if a document it changes was changed after the user's screen loaded; gap-free numbering from per-series sequences; safe across several server processes |
| Stage locks | once a stage is passed its facts are frozen — in the business rules **and** by MySQL triggers (so not even a bug, a direct SQL edit or a compromised app account can alter them): gate entries, QC slips/results, MRNs, PDI, orders, lines are write-once; approval, PO link, issue, receipt, invoice and gate-out are set once; a GRN's quantity locks when it goes to QC; a barcode can only be recorded once, on approved material; register entries can never be deleted; the audit log and snapshots are append-only even for the database admin |
| Encryption at rest | AES-256-GCM (authenticated) for customer party name/address/PO, dispatch invoice no, PO lines (rates), supplier rates, vehicle/LR numbers, and audit payloads |
| Database | runtime account has table-level privileges only; `audit_log` is INSERT-only for it (append-only trail); parameterised queries, multi-statements off |
| Destructive resets | "Clear all" / "Load demo data" exist only where `ALLOW_DEMO_RESET=true`, only for the admin, and need the admin's password **and** a typed phrase (`CLEAR ALL` / `LOAD DEMO`), both checked on the server; wrong passwords count toward the lockout; 5 failed attempts per 15 min; an encrypted snapshot of all registers is saved in the same transaction first (the app account can add snapshots but never delete them) |
| Audit | every login, logout, password change and action — allowed, refused, denied or invalid — with user, role, IP and time |
| HTTP | Helmet: strict CSP (`script-src 'self'`), HSTS, frame-ancestors none, no-sniff, referrer policy; API responses `no-store`; errors never leak internals |

Undo a reset (server command line): `npm run snapshot -- list`, then `npm run snapshot -- restore <id>`
(the data being replaced is itself snapshotted first, so a restore can be undone too).

**Tests: `npm test`** runs every suite below on its own database (`<DB_NAME>_test`, recreated each
run) and its own API on port 4001 — the working database is never touched. `node server/test/flow.mjs`
is the inward flow end to end (Tally PO → gate → GRN with shortage → QC approved into PM stock,
rejected into the rejected count → PO closes when everything has arrived). Each suite can also be run
alone against a development server with demo data:
`npm run test:api`, `node server/test/concurrency.mjs`, `node server/test/reset.mjs`,
`node server/test/integrity.mjs` (renames stay consistent; MySQL rejects broken references,
impossible values and gate-out without invoice; failed transactions leave nothing behind),
`node server/test/parallel.mjs` (stale-screen refusal, parallel saves, gap-free numbers,
change-only sync). `node server/test/gate.mjs` (Tally PO import, item-wise gate in, partial delivery keeps the PO
open, supplier/code/unit from the PO, real dates, no duplicate invoice, vehicle out recorded once). `node server/test/grn.mjs` (one GRN per gate-checked item in the PO's unit, never more than
came in, Store's count is what the PO has received, a picked PMS code is remembered).
`node server/test/tallysync.mjs` (the sync against a fake Tally: codes, units, vendors, changes only, rename
keeps the code, edited/deleted POs, duplicate numbers; creating a PO in Tally and its guards; PO close / reopen /
go-live cut-over). Run `concurrency.mjs` last — it locks a login and changes a password on purpose.

## The flow it implements

Inward → QC → Store → Packing → FG Warehouse → Dispatch, as narrated in the client's SOP video:

1–2 Gate entry register (Security) · 3–5 Invoice check, GRN, quarantine UNDER TEST (Store) ·
6–8 QC intimation, A.R. No, decision Approved / Hold / Reject (QC) · 9–10 Approved stock into
warehouse + barcode (Store) · 11–13 Requisition and material issue to packing (Production/Store) ·
14–17 Packing, FG transfer note, FG receiving, FG system stock (Packing/FG WH) · 18–22 Dispatch
slip on order, packing list, invoice (Accounts), security verification, gate out.

Documents carry forward automatically (gate entry no → GRN → QC slip → A.R. no), QC status gates
stock (only APPROVED material is usable; rejected material never enters stock), and every batch
or GRN can be traced end-to-end on the **Flow** tab.

## The registers and their sources

| App tab | Client document |
|---|---|
| Gate Entry | Handwritten *Gate Entry Register* (diary) |
| GRN | *GRN* Excel sheet — rows GR0001–GR0003 in the app are the sheet's real rows |
| QC | Handwritten *Q.C Intimation Slip (PM/RM)* + *Q.C Testing and A.R. No Generator* |
| PM Stock | Derived ledger: opening + QC-approved receipts − issues |
| Requisition | Printed *Raw Material / Packing Material Requisition Slip* |
| FG Warehouse | Letterheaded *FG Transfer Details — Packing List* + FG stock |
| Dispatch | Handwritten *Dispatch Packing Slip* (with security sign), invoice, gate out |

## Real vs demo data

**Real (client's own):** the 128-product and 717-component BOM masters (`src/data/bom.json`,
`src/data/inventory.json` names/codes/types), the three GRN rows GR0001–GR0003, the two new
component codes PMS0848/PMS0849, supplier names, the requisition slip of 10-Aug-2026
(LL dept, 1,440 pcs), and every register's column layout.

**Demo:** all stock figures, dates, batch numbers (`LL112-B01` style), signatures, parties and
the remaining register entries — seeded in `server/seed/demoStory.ts` so the demo starts mid-story with
material under test, on hold, rejected, in FG stock and awaiting gate-out. **Load demo data**
(admin header button, only where `ALLOW_DEMO_RESET=true`, or `npm run db:demo`) restores this state.

## Code layout

```
src/flow/            shared by browser and server
  types.ts           document shapes, one per register
  perms.ts           roles, tabs, PERMS, READ_SCOPES — no passwords
  logic.ts           the business core: reducers (one per action), derived stock, traceability
  api.ts, auth.tsx, store.tsx   browser: API client, login, server-backed registers + masters
  tabs/, ui.tsx      one screen per register
server/
  src/               Express app: config, sessions, auth, actions, scope, repository, audit
  scripts/           env:init, db:setup, db:demo, user, snapshot, master
  seed/              import sources: BOM/inventory masters, suppliers, demo storyline
  test/              security, concurrency, reset and data-integrity checks
```

Storage is relational: every fact is stored once, documents refer to masters by key, and
statuses, line totals and stock are computed — never stored twice. A write runs the shared
reducer from `logic.ts`, then saves exactly the rows that changed, inside one transaction
(serialised by a database lock), and answers with what was read back from the database.

The earlier Packing Material Planner still lives in `src/components/` and `src/lib/` but is not
routed. `extract_source_data.py` regenerates the BOM JSONs from the client's source sheets.
