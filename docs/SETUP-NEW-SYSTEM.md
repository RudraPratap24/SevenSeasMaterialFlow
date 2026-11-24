# Setting up Seven Seas Material Flow on a new system

Two ways to set up the database: **2A** (empty) or **2B** (copy the current data).

---

## 1. Install on the new PC
1. Install **Laragon** (it includes MySQL 8). Start it with **Start All**.
2. Install **Node.js 20+**.
3. Install **TallyPrime** and open the company. Turn on its server: F1 → Settings → Connectivity → *TallyPrime acts as* = **Server**, port **9000**.
4. Copy the project folder, **except** `node_modules`, `dist` and `dist-server`.
5. In the project folder:
   ```
   npm install
   ```

---

## 2A. Fresh database (empty)
```
npm run env:init
```
Edit `.env` (see section 4), then:
```
npm run db:setup
```
- This creates the database, all tables, the locks and the app's own MySQL login.
- It prints a **temporary password for each department login**. Note them down; each user changes theirs at the first login.

---

## 2B. Same data as now (copy)
On the **old** PC:
```
C:\laragon\bin\mysql\mysql-8.4.3-winx64\bin\mysqldump -uroot --single-transaction --routines --triggers seven_seas_flow > seven_seas_flow.sql
```
On the **new** PC, with MySQL running:
```
C:\laragon\bin\mysql\mysql-8.4.3-winx64\bin\mysql -uroot -e "CREATE DATABASE seven_seas_flow"
C:\laragon\bin\mysql\mysql-8.4.3-winx64\bin\mysql -uroot seven_seas_flow < seven_seas_flow.sql
```
- Copy the old `.env` to the new PC. **`DATA_ENCRYPTION_KEY` must stay the same**, or rates, driver phones and vehicle numbers can no longer be read.
- Then run:
  ```
  npm run db:setup
  ```
  It adds anything missing and re-creates the app's MySQL login.

---

## 3. Load the Tally data (items, vendors, POs)
Keep Tally open with the company loaded, then run:
```
npm run tally -- sync --full
```
Check that it prints the number of items, vendors and POs read, and no error.

To keep it up to date automatically:
- **Development:** `npm run dev` already syncs every 30 s.
- **Production:** run this in its own window or as a service:
  ```
  npm run tally -- watch
  ```

---

## 4. `.env` on the new system

| Key | Set to |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `127.0.0.1` (tunnel or proxy on the same PC), or `0.0.0.0` (users on the LAN) |
| `APP_ORIGIN` | the exact address users open, e.g. `https://flow.yourcompany.com` |
| `TRUST_PROXY` | `1` behind Cloudflare or Nginx, otherwise `0` |
| `DB_PASSWORD` | strong, 16+ characters (production refuses anything shorter) |
| `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` | MySQL root; remove these two lines after setup |
| `DATA_ENCRYPTION_KEY` | new system: made by `env:init`. Copied data: the old key. Back it up separately |
| `TALLY_URL` | `http://localhost:9000` (Tally on the same PC) |
| `TALLY_COMPANY` | the exact company name in Tally |
| `TALLY_TEST_DATE` | **empty** on a licensed Tally |
| `TALLY_ALLOW_WRITE` | `true` only once Accounts agree that POs go to Tally |
| `ALLOW_DEMO_RESET` | `false` |
| `TALLY_SYNC_SECONDS` | `30` |

---

## 5. Build and run (production)
```
npm run build
npm start
```
Open the `APP_ORIGIN` address and log in.

---

## 6. Before going live
1. Reset every default password:
   ```
   npm run user -- reset gate
   ```
   Repeat for store, qc, packing, fgwh, accounts, purchase, security and admin.
2. Never use `--dev-passwords` in production (production refuses it anyway).
3. Firewall: block ports **9000** (Tally) and **3306** (MySQL) from the network.
4. Daily backup: the `mysqldump` command from 2B. Keep `.env` (the key) in a separate safe place.
5. After every code change, run `npm run build`, then restart `npm start`.
