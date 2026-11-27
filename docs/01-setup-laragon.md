# 1. Set up the project on your computer (Windows + Laragon)

About 30 minutes. At the end you will have the backend running on http://localhost:4000 with the real data.

## What you need

| | |
|---|---|
| **Laragon** (Full) | gives you MySQL 8 and HeidiSQL — https://laragon.org |
| **Node.js 20 or newer** (LTS) | https://nodejs.org — check with `node -v` in a new terminal |
| **Python 3** | only for importing a spreadsheet (`tools/xlsx2json.py`) — check with `python --version` |
| **Git** + an editor (VS Code) | |
| From the person handing over | 1. the database file **`seven_seas_flow.sql`** · 2. the **`.env`** file (or at least its `DATA_ENCRYPTION_KEY`) |

> **Why the `.env` matters.** Vendor phone numbers, bank accounts and purchase rates are stored encrypted with
> `DATA_ENCRYPTION_KEY`. The SQL file is useless for those fields without the **same** key. Get it handed over
> privately (not by email/chat in plain text), keep a copy somewhere safe, and never commit it.

## Steps

1. **Start MySQL.** Open Laragon → **Start All**. MySQL must show as running.
   Laragon's `root` user has no password by default; the project expects that locally.

2. **Get the code** and install the packages. In a terminal, in the project folder (the one with `package.json`):
   ```bash
   npm install
   ```

3. **Settings file.** Put the handed-over `.env` in the project folder. Check these lines in it:
   ```ini
   APP_ORIGIN=http://localhost:4000   # the exact address you open in the browser
   DB_NAME=seven_seas_flow
   DB_ADMIN_USER=root                 # used only by "npm run db:setup"
   DB_ADMIN_PASSWORD=
   ```
   *Starting from nothing instead* (no data, no key): `npm run env:init` makes a new `.env` with a fresh key —
   but then the encrypted fields of a handed-over SQL file cannot be read. Only do this for an empty setup.

4. **Create the database and load the SQL file.** Either way works:
   - **HeidiSQL** (Laragon → Database): right-click the server → *Create new* → *Database* → name `seven_seas_flow`,
     collation `utf8mb4_0900_ai_ci`. Select it → *File* → *Run SQL file…* → choose `seven_seas_flow.sql`.
   - **Terminal** (Laragon → Terminal):
     ```bash
     mysql -uroot -e "CREATE DATABASE seven_seas_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
     mysql -uroot seven_seas_flow < seven_seas_flow.sql
     ```

5. **Finish the database.** This adds any newer table changes and creates the restricted account the app runs as
   (`flow_app`, password from `.env`). Existing users and data are left as they are.
   ```bash
   npm run db:setup
   ```

6. **Run it.**
   ```bash
   npm run dev
   ```
   Open http://localhost:4000 → links to **Purchase System** (`/ps`) and **Admin** (`/admin`).

7. **Log in.**
   - `/admin` → login `admin`. If nobody gives you the password: `npm run user -- reset admin` prints a temporary
     one (you set your own at first login).
   - `/ps` → the Purchase System's own names ("Doers"). An admin can set a new password for any of them on `/admin`
     (Users → the person → *New starting password*), or inside `/ps` as a Director (Admin → Users).

8. **Check everything works.**
   ```bash
   npm test
   ```
   This builds its own `seven_seas_flow_test` database from scratch and runs every test — it never touches your
   working database. Expect `all suites passed`.

## Starting with an empty database (no SQL file)

Steps 1–3 with `npm run env:init`, then `npm run db:setup -- --dev-passwords` (creates every table and the login
`admin` / `seven@admin`), then `npm run dev`. Fill it with the client's spreadsheet: see the module's import steps
([Purchase System](../modules/purchase-system/MODULE.md#import--cut-over)).

## Making the SQL file (for the person handing over)

```bash
C:\laragon\bin\mysql\mysql-8.4.3-winx64\bin\mysqldump -uroot --single-transaction --routines --triggers seven_seas_flow > seven_seas_flow.sql
```
(the version folder may differ). It holds real company data: share it privately, never put it in Git.

## Problems

| You see | Do this |
|---|---|
| `Invalid configuration: …` when starting | a line in `.env` is missing or wrong — compare with `.env.example` |
| `Has the database been set up?` | MySQL not running (Laragon → Start All) or step 4–5 not done |
| Page loads but every action says *Request blocked* | `APP_ORIGIN` is not the address in your browser bar — fix it, restart |
| Vendor bank/phone/rates show errors | the `DATA_ENCRYPTION_KEY` is not the one the data was saved with |
| Port 4000 in use | another `npm run dev` is still running — close it (or set `PORT` in `.env`) |
