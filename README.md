# Seven Seas — one backend for the client's tools

The client (Seven Seas Beauty Products Pvt Ltd) runs its daily tools as **Google Sheets + Apps Script**. This project
takes them over: each tool's own page is served **unchanged** by **one backend** (Express + TypeScript), and its data
lives in **one MySQL database** that is the single source of truth. Each tool is a **module**; all modules share one
core (logins, admin page, database, mail, audit).

| Address | What |
|---|---|
| `/` | links to every module and the admin page |
| `/ps` | **Purchase System** — indent → PO → approval → vendor mail → follow-up → receipt (module 1) |
| `/admin` | users, items, finished goods, vendors, item ↔ vendor — the shared masters (admin only) |

## Start here — read in this order

| # | Document | For |
|---|---|---|
| 1 | [Set up on your computer (Laragon)](docs/01-setup-laragon.md) | getting it running with the handed-over SQL file |
| 2 | [How it is built](docs/02-architecture.md) | core backend, modules, database, security, imports |
| 3 | [Adding a module](docs/03-adding-a-module.md) | taking over the next client tool |
| 4 | [Purchase System](modules/purchase-system/MODULE.md) | the first module: tables, decisions, import, cut-over |
| 5 | [Pending work](docs/05-pending-work.md) | **what is left**, starting with finishing the Purchase System |
| 6 | [The legacy full-flow app](docs/06-legacy-full-flow.md) | the earlier gate → dispatch app in `legacy/` — keep it |
| 7 | [Rules and operations](docs/07-rules-and-operations.md) | the rules, commands, backups, deploy, users |

## Folders

```
server/    the core backend (shared by every module)
modules/   one folder per client tool — purchase-system/ today
tools/     xlsx2json.py (spreadsheet → JSON for imports)
docs/      the documents above
legacy/    the earlier full Material Flow app (React) — reference only, not built or served; do not delete
```

## Quick start

```bash
npm install
# .env from the person handing over (or: npm run env:init)   — see docs/01
# load seven_seas_flow.sql into MySQL                          — see docs/01
npm run db:setup
npm run dev          # http://localhost:4000
npm test             # all tests, on a separate _test database
```
