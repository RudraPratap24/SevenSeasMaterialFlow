# 7. Rules and operations

## Rules (agreed with the owner — keep them)

1. **Real company data never goes into Git** — not the spreadsheets, not SQL dumps, not import reports, not test
   data. `.gitignore` keeps `modules/*/source/*` (except `Index.html`), `reference-materials/` and `.env` out.
   Tests make their own synthetic rows.
2. **Back up before every migration, `db:setup` or `--apply` import** (command below).
3. **Tests never touch the working database.** `npm test` builds and uses `<DB_NAME>_test`.
4. **The client cannot fix their data** and neither can we: import it as given, never "clean" it silently. Where two
   copies disagree, follow the owner's rule (for the Purchase System: the FMS wins) and keep the other value in the
   module's audit table.
5. **The client's pages are not edited.** Only declared patches (listed in the module's MODULE.md).
6. **The `.env` and its `DATA_ENCRYPTION_KEY`** are kept outside Git and backed up separately. Losing the key makes
   every encrypted field (bank, phone, rates) unreadable, in the database and in every backup.
7. **Do not log in with people's real passwords** to test. Use the synthetic test users or set a temporary password
   on `/admin`.
8. **Tally** (legacy only): no stored credentials, port 9000 never on the network, writes only to the test copy.

## Everyday commands

| | |
|---|---|
| `npm run dev` | server with reload on http://localhost:4000 |
| `npm test` | all suites on the `_test` database |
| `npm run typecheck` · `npm run build` · `npm start` | check · build `dist-server/` · run the build |
| `npm run db:setup` | apply new migrations + the app account's rights (back up first) |
| `npm run user -- list \| create <id> <role> \| reset <id> \| disable <id> \| enable <id> \| unlock <id>` | logins |
| `npm run ps:import -- [--apply] [--only=grn] [--live]` | Purchase System sheet → database |
| `python -I tools/xlsx2json.py <file.xlsx>` | workbook → JSON for an importer |
| `npm run master:photos -- <databank.json> [--apply] [--overwrite]` | item photos from the client's Master Item Databank (fills items without a photo) |

**Backup / restore** (Laragon terminal):
```bash
mysqldump -uroot --single-transaction --routines --triggers seven_seas_flow > backup-YYYYMMDD.sql
mysql -uroot seven_seas_flow < backup-YYYYMMDD.sql
```

## Deploy

**Sharing from the office PC (quick):** `npm run build`, then `npm start`, then a Cloudflare tunnel to port 4000.
A *quick* tunnel (`cloudflared tunnel --url http://localhost:4000`) gets a new address every start — set
`APP_ORIGIN` to it and restart each time. A *named* tunnel on your own domain keeps one address:
```bash
cloudflared tunnel login
cloudflared tunnel create seven-seas
cloudflared tunnel route dns seven-seas app.<your-domain>
cloudflared tunnel run --url http://localhost:4000 seven-seas
```

**Cloud (recommended for real use):** one region in India (e.g. DigitalOcean Bangalore or AWS Mumbai):
1. Managed MySQL 8 (daily backups on; reachable only from the app server; `max_allowed_packet` ≥ 32 MB).
2. One app server (2 GB, Ubuntu, Node 20+), same private network; `npm ci`, `npm run build`, run `npm start` as a
   service (pm2 or systemd).
3. Load the data: `mysqldump --skip-triggers` here → import there → `npm run db:setup`.
4. `.env` copied by hand: the **same** `DATA_ENCRYPTION_KEY`, `NODE_ENV=production`, `APP_ORIGIN=https://…`,
   `DB_SSL=true`, `TZ=Asia/Kolkata`, `TRUST_PROXY=1` behind a proxy, `SMTP_*`. Remove `DB_ADMIN_*` after setup.
5. Cloudflare in front (domain, HTTPS). One server is enough; resize it rather than adding servers (jobs and the
   indent-form tokens assume one server).

## Users and roles

- `/admin` (role `admin`): add people, set starting passwords (they must change them at first login), disable,
  change role; items, FG, vendors and item ↔ vendor rates — the masters every module reads.
- Purchase System rights are on the same user: *Purchase System name*, *steps* (`ALL` = Director/admin of the
  Purchase System, or `STEP 1,STEP 2 …`), *item types*, *email*.
