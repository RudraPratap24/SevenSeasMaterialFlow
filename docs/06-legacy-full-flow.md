# 6. The legacy app: the full Material Flow (`legacy/`)

## What it is

Before the module approach, we built the client's whole **Material Management SOP (SOP/SCM/001 v2.1)** as one
React + Express app — the 22-step flow from a material vehicle at the gate to finished-goods dispatch:

| Stage | What the app did |
|---|---|
| Gate | gate entry register (Security), vehicle photo, guard name |
| Inward | invoice check, GRN against PO lines, quarantine *UNDER TEST*, tolerance / short / excess, escalation, debit notes |
| QC | QC intimation, A.R. number, Approved / Hold / Reject (only approved material enters stock) |
| Store | PM/RM stock ledger (opening + approved receipts − issues), minimum levels, indent requests |
| Purchase | indents → POs with GST (CGST+SGST / IGST), owner approval / reject, POs sent to **Tally** |
| Production | production plans, BOM issue slips, supervisor verification, production reports, bulk (semi-finished) |
| FG / Dispatch | FG transfer notes, FG warehouse stock (with reservations), customer orders, dispatch slip, gate out |
| Masters / admin | item master (client's real codes), FG + BOM, vendors + rates, users with roles, audit log |
| Tally | read stock items, vendors and POs from TallyPrime; write POs to a test copy |

Its own documents are in `legacy/README.md` and `legacy/docs/` (database design, API, Tally queries, the overview
PDFs).

## Why it was replaced

In November 2026 the client chose to keep working in **their own Google-Sheet tools** and asked us to take those
over instead (same pages, our backend, one database). The full flow app is therefore **paused**, not deleted.

## Keep it

**Do not delete `legacy/`.** If the client's requirements change again (they want the gate → dispatch flow, stock,
Tally, production), most of the work is done there: the stock rules, QC gating, document numbering, Tally XML, the
production and FG logic, and its test suites. Re-use its pieces as new modules rather than starting over.

Its database tables are still in `seven_seas_flow` (the current app account has no rights on them), and the shared
masters (`users`, `components`, `products`, `bom_lines`, `suppliers`, `supplier_rates`) are the same ones the modules
use today.

## Running it again

The files in `legacy/` are kept for reading; they no longer run from this folder (the frontend packages were removed
and the folders moved). The last runnable version is **Git commit `6493b18`** ("Final Work flow", 2026-11-24). Run it
in a separate folder and a **separate database**, so it never touches the live data:

```bash
git worktree add ../star-legacy 6493b18
cd ../star-legacy
npm install
npm run env:init            # then in .env: DB_NAME=seven_seas_legacy, DB_USER=flow_legacy, APP_ORIGIN=http://localhost:5173
npm run db:setup -- --dev-passwords
npm run db:demo             # demo story data
npm run dev                 # web http://localhost:5173, API :4000 (stop the module server first, or change PORT)
```
Logins: `gate`, `store`, `qc`, `packing`, `fgwh`, `accounts`, `purchase`, `security`, `admin` — password
`seven@<login>`. Its own README (in that folder) explains every tab and the Tally setup.

**Tally rules (if you ever use it):** never store Tally credentials; port 9000 stays local; write POs only to the
local test copy (`TALLY_ALLOW_WRITE=true` there only) until Accounts agree; never restore the test copy to the cloud.

## Its open items

Paused with it — only relevant if it comes back:

- Stock: physical count + approved adjustment, go-live plan for opening stock, real per-item minimum level (a flat 20
  today), PM stock deducted at supervisor-verified qty instead of at BOM issue, a `db:clean` that keeps masters.
- Item master / BOM: 435 old items not in the client's master, duplicate LL-112 parts, 51 FG with no BOM, 367 BOM
  quantities taken from the pack size in the name, bulk units.
- Production / FG / dispatch: BPR download, FG Receipt card, dispatch rework, bulk consumption.
- Tally: PO sync off, Tally-vs-app stock report; small: PO balance reopen, sync "left out" bar, pager.
