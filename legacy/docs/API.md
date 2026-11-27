# Seven Seas Material Flow — Backend API

The browser app talks to the backend only through the endpoints below. Every example on this page was captured from
the running server (dev passwords, demo data).

- **Base URL:** `http://localhost:4000/api` when running the API by itself (`npm run dev:server`). In the browser
  during development, the web app on `http://localhost:5173` forwards `/api/...` to it. In production the app and
  the API are served from the same address, e.g. `https://flow.example.com/api`.
- **Format:** JSON in, JSON out (`content-type: application/json`, request body ≤ 200 kB).
- **Code:** routes in [server/src/app.ts](../server/src/app.ts), [authRoutes.ts](../server/src/authRoutes.ts),
  [flowRoutes.ts](../server/src/flowRoutes.ts), [customerRoutes.ts](../server/src/customerRoutes.ts); the action
  catalogue in [actions.ts](../server/src/actions.ts); the business rules in [src/flow/logic.ts](../src/flow/logic.ts).

---

## 1. How to see requests and responses

**A. In the browser (easiest).** Open the app → press **F12** → **Network** tab → type `api` in the filter box →
use the app. Click any request to see:
- **Headers** — URL, method, status code;
- **Payload** — what the screen sent (e.g. the gate entry form);
- **Response** — what the server answered (the changed documents, or `{"error": "..."}`).

Tick *Preserve log* to keep requests across page reloads.

**B. From the command line (curl).** Log in once, keep the session cookie in a file, then call anything:

```bash
B=http://localhost:4000/api
H='-H content-type:application/json -H x-flow-request:1 -b cookies.txt -c cookies.txt'

curl -s -X POST $B/auth/login $H -d '{"username":"gate","password":"seven@gate"}'
curl -s $B/version $H
curl -s $B/state $H
curl -s -X POST $B/auth/logout $H
```

(PowerShell: use `curl.exe` instead of `curl`.) Only use dev passwords (`seven@<department>`) on a development
database.

**C. The server log.** The terminal running the API prints one line per request:

```json
{"t":"2026-10-19T10:10:07.885Z","method":"GET","path":"/api/masters","status":200,"ms":3,"user":"gate","ip":"127.0.0.1"}
```

**D. The audit trail (database).** Every login, logout and action — allowed, refused or denied — is a row in
`audit_log` (who, role, action, outcome, message, time; the request payload is stored encrypted):

```sql
SELECT created_at, username, role, action, outcome, message FROM audit_log ORDER BY id DESC LIMIT 20;
```

**E. Working examples in code.** The test suites in [server/test/](../server/test/) call every endpoint the way the
app does — e.g. [flow.mjs](../server/test/flow.mjs) runs Tally PO → gate → GRN → QC → stock. Run them all with
`npm test` (they use their own test database, never yours).

---

## 2. Rules every request follows

| Rule | Detail |
|---|---|
| **Login session** | `POST /auth/login` sets an `httpOnly` cookie (`flow_sid` in development, `__Host-flow_sid` + `Secure` in production). The browser sends it automatically; curl needs `-b/-c cookies.txt`. Idle timeout 2 h, absolute 12 h. |
| **CSRF header** | Every `POST` must carry `x-flow-request: 1`, otherwise `403 {"error":"Request blocked."}`. |
| **Origin** | If the browser sends an `Origin`/`Referer`, it must equal `APP_ORIGIN` in `.env` (e.g. `http://localhost:5173`), otherwise `403 Request blocked.` — this is why opening the app on another port fails to log in. |
| **Role** | Each login has a role (gate, store, qc, packing, fgwh, accounts, purchase, security, admin). The server checks the role on every action and sends each role only the registers it may see. |
| **Password change** | A login with a temporary password gets `403 {"error":"Please set a new password first.","code":"PASSWORD_CHANGE_REQUIRED"}` on everything except `/auth/*` until it changes the password. |
| **Rate limits** | 600 requests/min per IP overall; 20 failed logins per IP per 15 min; 5 wrong passwords lock one login for 15 min. |
| **No caching** | API responses carry `Cache-Control: no-store`. |

**Errors** always look like `{"error": "<message for the user>"}`:

| Status | Meaning | Example |
|---|---|---|
| 400 | Input is malformed (wrong type, missing field, bad date) | `{"error":"Invalid input: vehicleNo is required."}` |
| 401 | Not logged in / session expired | `{"error":"Please log in."}` |
| 403 | Blocked request, or this role may not do it | `{"error":"Your login is not allowed to do this."}` |
| 404 | Unknown endpoint or action | `{"error":"Unknown action."}` |
| 409 | A business rule refused it, or the screen was out of date | `{"error":"PO 26SEV301 is already fully received."}` — out-of-date screens also get `"code":"STALE"` |
| 429 | Too many attempts | `{"error":"Too many wrong passwords. Try again in 15 min."}` |

---

## 3. Endpoints

### Health

`GET /health` → `{"ok": true}` (no login needed).

### Login and session — `/auth`

**`POST /auth/login`**

```json
// request
{ "username": "gate", "password": "seven@gate" }

// 200 response (+ Set-Cookie: flow_sid=…; HttpOnly; SameSite=Strict)
{
  "user": { "username": "gate", "role": "gate", "label": "Gate Entry",
            "tabs": ["gate"], "viewOnly": [], "mustChangePassword": false },
  "demoReset": true
}
```

Wrong ID or password (same message for both, on purpose): `401 {"error":"Wrong ID or password."}`.

**`GET /auth/me`** → same `{user, demoReset}` for the logged-in session (401 if none).

**`POST /auth/logout`** → `{"ok": true}`.

**`POST /auth/change-password`**

```json
{ "currentPassword": "…", "newPassword": "…" }
```

Policy: ≥ 10 characters, not containing the login ID, three of lower/upper/digit/symbol (or 16+ characters).
Signs out the user's other sessions. Response: `{user, demoReset}`.

### Reading the registers

**`GET /version`** — the change number the data is at; screens poll this every few seconds.

```json
{ "version": 97, "resyncVersion": 12, "mastersVersion": 6 }
```

**`GET /state`** — everything this role may see (loaded at login and after a reset).

```json
{
  "version": 97,
  "resyncVersion": 12,
  "state": {
    "openings": {}, "minLevels": {},
    "gateEntries": [ … ], "grnLines": [ … ], "qcIntimations": [ … ], "arRecords": [ … ],
    "requisitions": [ … ], "mrns": [ … ], "fgTransfers": [ … ], "pdiRecords": [ … ],
    "orders": [ … ], "dispatchSlips": [ … ], "indents": [ … ],
    "purchaseOrders": [ … ], "tallyPos": [ … ]
  }
}
```

Registers a role may not read come back as empty lists (e.g. the gate gets no orders); PO rates are `null` for every
role except Purchase and Admin; customer names/addresses are blank for roles that don't deal with customers. The
document shapes are in [src/flow/types.ts](../src/flow/types.ts). Two real examples:

```json
// a PO as copied from Tally (state.tallyPos[0])
{
  "poNo": "26SEV301", "date": "01-10-2026", "supplierName": "MAXCOMM INDIA PVT LTD",
  "cancelled": false, "syncedAt": "13-10-2026 09:00",
  "lines": [
    { "itemName": "6ML EYELINER bottle", "itemCode": "PMS0842", "qty": 10000, "unit": "Pcs" },
    { "itemName": "6ML EYELINER cap",    "itemCode": "PMS0843", "qty": 10000, "unit": "Pcs" },
    { "itemName": "6 ML EYE LINER box 12pcs", "itemCode": "", "qty": 850, "unit": "Doz" }
  ]
}

// a gate entry with items checked in against that PO (state.gateEntries)
{
  "id": "GE-0006", "date": "06-10-2026", "supplierName": "MAXCOMM INDIA PVT LTD",
  "productDesc": "6ML EYELINER bottle, 6ML EYELINER cap",
  "invoiceNo": "INV/2026-27/0412", "invoiceDate": "05-10-2026", "poNo": "26SEV301", "invoiceQty": null,
  "transportName": "VRL Logistics", "lrNo": "LR-93120", "vehicleNo": "HR55-C-8082",
  "timeIn": "11:20", "timeOut": "12:40", "driverSign": true, "remark": "",
  "lines": [
    { "itemName": "6ML EYELINER bottle", "itemCode": "PMS0842", "unit": "Pcs", "qty": 10000, "remark": "" },
    { "itemName": "6ML EYELINER cap", "itemCode": "PMS0843", "unit": "Pcs", "qty": 6000,
      "remark": "4000 Pcs short — balance next week" }
  ]
}
```

Stock, PO pending and order balances are **not** fields here — they are calculated from these documents (the same
functions run on the server and in the browser: `derivePmStock`, `deriveTallyPoProgress`, `derivePoProgress` in
[logic.ts](../src/flow/logic.ts)).

**`GET /changes?since=<version>`** — only the documents changed after `since`, in the same shape (`changes` instead of
`state`). If `resyncVersion` has moved, reload `/state` instead (a reset, restore or rename happened).

```json
{ "version": 97, "resyncVersion": 12, "changes": { "gateEntries": [], "grnLines": [], … } }
```

**`GET /masters`** — component and product lists (the BOM only for roles that raise requisitions, else `null`):

```json
{
  "version": 6,
  "components": [ { "code": "PMS0001", "name": "APF BOTTLE", "type": "Bottle" }, … 719 ],
  "products":   [ { "name": "APF Apple Foundation Fine Touch", "fg": "APPLE FINE TOUCH",
                    "vendor": "Domestic", "boxSize": 12 }, … 128 ],
  "bom": null
}
```

**`GET /tally-status`** — the last Tally sync, for the screens. Purchase/Admin get the whole record, the gate only
the time; others `403`.

```json
{ "status": { "syncedAt": "20-10-2026 14:28", "full": true,
              "items": { "read": 4849, "added": 671, "renamed": 652 }, "vendors": { "read": 320, "added": 319 },
              "pos": { "read": 509, "added": 0, "updated": 509, "unchanged": 0, "cancelled": 0, "withoutItems": 29, "withoutCode": 1 },
              "skipped": [ { "poNo": "26SEV1028", "reason": "PO number used 2 times in Tally (…)" } ] } }
```

**`GET /masters/suppliers`** — approved vendors with fixed rates. Purchase and Admin only (others: `403 Not allowed.`).

```json
{ "suppliers": [ { "name": "MAXCOMM INDIA PVT LTD", "city": "Delhi", "rates": { "PMS0158": 2.1, … } }, … ] }
```

### Changing data — `POST /actions/:name`

**Every change** (gate entry, GRN, QC decision, PO …) goes through this one endpoint:

```json
// request
{ "args": [ … ], "basis": 97 }
```

- `args` — the action's inputs (table below), as a list.
- `basis` — the `version` the user's screen was showing. If a document this action changes was changed by someone
  else after that, the server refuses with `409` and `"code":"STALE"` so nobody overwrites what they haven't seen.

What the server does, in order: role check → strict input check → lock just the documents/stock involved → business
rules → save in one transaction → audit → answer with everything changed since `basis`:

```json
// POST /api/actions/addGateEntry — 200 response
{
  "version": 98, "resyncVersion": 12,
  "changes": {
    "gateEntries": [ { "id": "GE-0007", "date": "19-10-2026", "supplierName": "Aplay Creation",
                       "productDesc": "APF STICKER", "poNo": "26SEV303", "vehicleNo": "HR55-D-0001",
                       "timeIn": "00:00", "timeOut": "",
                       "lines": [ { "itemName": "APF STICKER", "itemCode": "PMS0003", "unit": "Kg",
                                    "qty": 5, "remark": "" } ], … } ],
    "grnLines": [], …
  }
}
```

Note what the server decided itself here: the date (server clock), the supplier, the item code and the unit (from the
PO) — whatever the screen sent for those is ignored. The same is true across actions: **dates and times, names and
codes from the masters, totals, units, approver identity are always the server's**, never the browser's.

#### Action catalogue

`{…}` = one object argument; otherwise the arguments are positional. Field lists show what the server accepts; fields
marked *server* are overwritten by the server.

| Action | Who | `args` |
|---|---|---|
| **Gate** | | |
| `addGateEntry` | gate, admin | `[{ date*server*, supplierName, productDesc, invoiceNo, invoiceDate "dd-mm-yyyy", poNo, invoiceQty, transportName, lrNo, vehicleNo (required), timeIn "hh:mm" (required), timeOut "", driverSign, remark, lines: [{ itemName, itemCode*server*, unit*server*, qty, remark }] }]` — with `poNo`: a Tally PO or an approved app PO, ≥ 1 item, each ≤ pending (no over-supply is accepted); without: supplier + material required, no lines |
| `recordVehicleOut` | gate, admin | `[gateEntryNo, driverSigned (true/false), time*server*]` — once per entry |
| **Store — GRN** | | |
| `addGrnLine` | store, admin | `[{ gateEntryId, gateLineNo (1-based item of the gate entry; null without PO), componentCode, qtyPerBox, totalBoxes, totalQty, remarkStore, location, … }]` — PO, supplier, invoice, unit, PO qty, names *server*; count ≤ what came in at the gate; one GRN per item |
| `updateGrnQty` | store, admin | `[grnNo, qty]` — only until sent to QC |
| `sendToQc` | store, admin | `[grnNo, { batchNo, mfgDate, expiryDate }]` |
| `setBarcoded` | store, admin | `[grnNo, true]` — QC-approved material only, once |
| **QC** | | |
| `recordAr` | qc, admin | `[qcIntimationNo, "APPROVED" \| "HOLD" \| "REJECTED", remark]` — approved goes into PM stock, rejected into the rejected count |
| `recordPdi` | qc, admin | `[productName, batchNo, "PASSED" \| "FAILED", remark]` |
| **Production / store issue** | | |
| `addRequisition` | packing, admin | `[{ date, department, productName, batchNo, lines: [{ materialCode, unit, qtyRequired, … }], packingSign }]` |
| `issueRequisition` | store, admin | `[requisitionNo, [qtyIssued per line], storeSign]` — never more than in stock |
| `addMrn` | packing, store, admin | `[{ date, requisitionId, lines: [{ componentCode, qty }], sign, remark }]` |
| **Finished goods** | | |
| `addFgTransfer` | packing, admin | `[{ date, lines: [{ productName, batchNo, mfgDate, qtyPerBox, totalBoxes, looseQty, … }], submittedBy }]` |
| `receiveFgTransfer` | fgwh, admin | `[transferNo, checkedBy, date*server*, location]` |
| **Sales / dispatch** | | |
| `addOrder` | fgwh, accounts, admin | `[{ date, partyName, partyAddress, custPoNo, deliveryDate, lines: [{ productName, qty }], remark }]` |
| `addDispatch` | fgwh, admin | `[{ date, orderId, partyName, partyAddress, lines: [{ productName, batchNo, qtyPerBox, totalBoxes, … }], dispatchSign, remark }]` — batch must have passed PDI |
| `addInvoice` | accounts, admin | `[dispatchNo, invoiceNo, date*server*]` |
| `gateOut` | security, admin | `[dispatchNo, securitySign, time*server*]` — needs the invoice first |
| **Purchase** | | |
| `addIndent` | purchase, admin | `[{ date, componentCode, qty, reason, supplierName, rate }]` — vendor must be on the approved list; `rate` (₹ per unit, > 0) is required and carried onto the PO line |
| `raisePo` | purchase, admin | `[{ date, supplierName, lines: [{ componentCode, qty, rate }], expectedDate, indentIds: [...] }]` — ticked open indents of that vendor, one line per item; every line needs a rate (> 0), so every PO has a total |
| `approvePo` | admin | `[poNo, approvedBy*server*]` — signed with the logged-in owner's name; only then the gate can receive against it |
| `closePo` | purchase, admin | `[poNo, reason, date*server*, by*server*]` — a Tally or app PO no longer expected (or received before go-live); the gate can't receive against it |
| `reopenPo` | purchase, admin | `[poNo, date*server*, by*server*]` |
| `closePosBefore` | admin | `[beforeDate "dd-mm-yyyy", reason, date*server*, by*server*]` — go-live cut-over: closes every PO dated before it with nothing received in the app |

The exact input rules (lengths, formats) are the zod schemas in [actions.ts](../server/src/actions.ts); the business
rules and their messages are the reducers of the same name in [logic.ts](../src/flow/logic.ts).

### Customers — `/customers`

- `GET /customers` → `{ "customers": [ { "id", "name", "address", "orders", "dispatches", "version" } ] }` — FG warehouse, Accounts, Security, Admin.
- `POST /customers/:id` with `{ "name", "address", "version" }` → corrected everywhere at once. Accounts and Admin;
  refused with `409` if someone else saved first (stale `version`) or the name already exists.

### Demo data — `/demo/:op` (admin, only where `ALLOW_DEMO_RESET=true`)

`POST /demo/load` with `{ "password": "<admin password>", "confirm": "LOAD DEMO" }`, or `POST /demo/clear` with
`"confirm": "CLEAR ALL"`. Replaces **all** registers for everyone; a snapshot of the previous data is saved first
(`snapshotId` in the response; undo with `npm run snapshot -- restore <id>`).

---

## 4. Tally

Tally is **not** called through this API, and never from a screen. `npm run tally -- sync` reads Tally's HTTP port
(read-only Export requests: stock items, vendors, Purchase Orders — only what changed, by AlterID) and stores the copy
in MySQL; the screens see it in `state.tallyPos`, `/masters` (items) and `/tally-status`. The requests and readers
are in [server/src/tally.ts](../server/src/tally.ts) (`stockItemRequest`, `vendorRequest`, `purchaseOrderRequest`,
`syncFromTally`); a connector on the Tally machine will later send the same requests and post the answers here.

**The one write — approved POs.** With `TALLY_ALLOW_WRITE=true` the server creates a PO in Tally right after
`approvePo` succeeds (in the background; the approval never waits for or depends on Tally). The result is kept on the
PO: `tallyPushedAt` ("dd-mm-yyyy hh:mm" of the last attempt) and `tallyError` ("" = created, else Tally's or our reason,
e.g. a vendor that is not a Tally ledger). Once vendors come from Tally, `addIndent` / `raisePo` accept only Tally
vendors (`409 … is not a vendor in Tally`).

**`POST /tally/push`** `{ "poNo": "26SEV305" }` — Purchase/Admin (`purchase.tally`): send a refused PO again.
`200 { "ok": true }` when Tally created it, `409 { "error": "…" }` otherwise (not approved, Tally already has that
number, writing switched off, Tally's own refusal).

**`POST /tally/renumber`** `{ "poNo": "26SEV1264" }` — Purchase/Admin (`purchase.tally`): for a PO Tally refused because
another Tally PO already has its number (typed there by hand). The PO takes the next number of the PO series that
Tally does not have (Tally is asked for each; up to 5) — **one number everywhere**: its lines and indents follow
(ON UPDATE CASCADE), every open screen reloads — and is created in Tally under it. `200 { "ok": true, "poNo":
"26SEV1269" }`; `409` if it was not refused for its number, or material has already come in against it (it then
keeps its number; fix the other PO in Tally). Outside this step the database refuses any change of a PO number.
