# BUILD SPEC — Packing Material Planner (Client Demo)

**For:** Claude Code (Opus 5)
**Deliverable:** a running web app, demoed live to the client on a screen share.
**Read this whole document before writing code.** Everything you need is here or in the adjacent files.

---

## 0. TL;DR — what you are building

A web app for a cosmetics manufacturer. The user picks products and quantities they intend to
produce. The app explodes that plan through a real Bill of Materials, compares the result against
packing-material stock, and **shows in red exactly what they are short of.**

```
  Production plan            BOM                  Stock                Answer
  ─────────────────          ───────              ─────                ──────
  APF Foundation   ×5,000  →  6 components   →   on hand        →   1 SHORT: need 5,000 caps,
  LS-161 Lipstick  ×2,400  →  10 components  →   per component      have 2,807 — short 2,193
```

That "short by 2,193" number, in red, is the entire point of the demo. Everything else on
screen exists to make that number credible and easy to act on.

---

## 1. Context you need to have

The client manufactures cosmetics under two brands (**SEVEN SEAS**, **RED 4**) — foundations,
blushers, lipsticks, nail paints. They currently plan production in Apple Numbers and Google
Sheets by hand.

**Critical framing — do not get this wrong:** this app is about **packing materials** (bottles,
caps, stickers, boxes, outers, master cartons). It is **not** about chemical raw materials.
The client has no ingredient/formulation data. Never use the words "raw material", "ingredient",
"formulation" or "chemical" anywhere in the UI.

**What is real vs. what is invented — be honest about this in the UI:**

| Data | Status |
|---|---|
| 128 products and their recipes | **REAL** — the client's own BOM sheet |
| 717 packing components, names + codes | **REAL** — the client's own component list |
| Pack sizes (1 per 12, 1 per 144, …) | **REAL** — derived from their BOM |
| Vendor (China / Domestic) | **REAL** — from their VENDOR column |
| **Stock figures (opening/inward/outward/closing)** | **INVENTED FOR THE DEMO** |
| **TYPE column (Bottle/Cap/Box/…)** | **INVENTED** — inferred from component names |

The client's real stock columns are completely empty — that is precisely why this demo seeds
them. The app must say so, once, quietly (see §7.6). Do not hide it and do not belabour it.

---

## 2. Files you are given

Alongside this spec:

| File | What it is | Use |
|---|---|---|
| `bom.json` | 128 products, 717 component lines. Extracted from the client's real BOM. | **Ship as-is.** Primary data. |
| `inventory.json` | 717 components with seeded stock. | **Ship as-is.** Primary data. |
| `inventory_seed.csv` | Same inventory, in the client's exact column order. | Show the client; also the CSV-import format. |
| `extract_source_data.py` | Regenerates the two JSONs from the client's `.numbers` file. | Only if re-extracting. Not needed to build. |

You may also be given the client's original files (`PLANNING_SHEET.numbers`,
`Copy_of_FG_STOCK_AND_TRACKER.xlsx`, `CHINA_FG_ROL.numbers`). **You do not need to parse them.**
The JSONs are already extracted and verified. If you do choose to parse them, read §11 first —
there is a landmine that will cost you an hour.

### 2.1 `bom.json` shape

```jsonc
[
  {
    "name": "APF Apple Foundation Fine Touch",  // product name, shown to user
    "fg":   "APPLE FINE TOUCH",                 // the client's FG code
    "vendor": "Domestic",                       // "China" | "Domestic" | ""
    "comps": [
      { "n": "APF BOTTLE",           "c": "PMS0001", "p": 100.0     },
      { "n": "APF CAP",              "c": "PMS0002", "p": 100.0     },
      { "n": "APF STICKER",          "c": "PMS0003", "p": 100.0     },
      { "n": "APF box 12pcs",        "c": "PMS0004", "p": 8.3333    },
      { "n": "APF outer 144pcs",     "c": "PMS0005", "p": 0.694444  },
      { "n": "APF master outer 864", "c": "PMS0006", "p": 0.115741  }
    ]
  }
]
```

`p` = **quantity of this component consumed per 100 finished units.** This is the client's own
convention, already in their sheet. `p = 100` → one per unit. `p = 8.3333` → one per 12 (100/12).

### 2.2 `inventory.json` shape

```jsonc
[
  { "code": "PMS0001", "name": "APF BOTTLE", "type": "Bottle",
    "opening": 3211, "inward": 4400, "outward": 2100, "closing": 5511 }
]
```

Invariant, taken from the client's own sheet design: **`closing = opening + inward − outward`**.
It holds for every row in the shipped data. Preserve it if you ever mutate stock.

---

## 3. The math — implement exactly this

```ts
// ── 1. Requirement, per component, across the whole plan ────────────────────
// Sum in floating point FIRST, round UP once at the end. Never round per-line
// and then sum — that inflates totals on shared components.
requirementExact[code] = Σ over plan lines of ( line.qty × comp.p / 100 )
requirement[code]      = Math.ceil(requirementExact[code] - 1e-9)   // epsilon kills float dust

// ── 2. What's on hand ───────────────────────────────────────────────────────
available[code] = inventory[code].closing

// ── 3. The answer ───────────────────────────────────────────────────────────
shortfall[code] = Math.max(0, requirement[code] - available[code])
coverage[code]  = requirement[code] === 0 ? 1 : available[code] / requirement[code]

// ── 4. Three-state status, drives all colour ────────────────────────────────
status =
  available <  requirement           ? "SHORT"   // red
: available <  requirement * 1.10    ? "TIGHT"   // amber — covered, but <10% headroom
:                                      "OK"      // green
```

**Pack size for display.** Derive, never hardcode:

```ts
function packSize(p: number): number | null {
  const q = 100 / p, r = Math.round(q);
  return Math.abs(q - r) < 0.02 * Math.max(r, 1) ? r : null;
}
function packLabel(p: number): string {
  const k = packSize(p);
  if (k === null) return `${p} per 100`;
  return k === 1 ? "1 per unit" : `1 per ${k.toLocaleString("en-IN")}`;
}
```

All 717 components in the shipped data produce a clean integer pack size — verified.

**Number formatting: `toLocaleString("en-IN")` everywhere.** The client is in India and expects
`1,20,000`, not `120,000`. This detail is noticed.

---

## 4. Tech stack

- **Vite + React 18 + TypeScript**
- **Tailwind CSS** for styling
- **lucide-react** for icons (use sparingly — see §6.6)
- No backend. No database. No router. No state library. `useState` + `useMemo` is enough.
- Data: import the two JSON files directly. They total ~130 KB — trivial.

```
src/
  data/ bom.json  inventory.json
  lib/  types.ts  calc.ts  format.ts  export.ts
  components/ PlanBuilder.tsx  VerdictBar.tsx  RequirementTable.tsx
              CoverageBar.tsx  InventoryView.tsx  ProductCombobox.tsx
  App.tsx  main.tsx  index.css
```

Must run with `npm install && npm run dev`, and build to a static bundle with `npm run build`
(so it can be shared as a folder or dropped on Netlify). Put both commands in the README.

---

## 5. Screens

Two tabs. Nothing more.

### Tab 1 — **Plan** (the demo happens here)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Packing Material Planner            128 products · 717 components       │
├────────────────────────┬─────────────────────────────────────────────────┤
│ PRODUCTION PLAN        │  ┌───────────────────────────────────────────┐  │
│                        │  │  ⚠ 4 components short                     │  │
│ Product  [search…]     │  │  This plan cannot run with current stock  │  │
│ Quantity [    5,000]   │  │  [ Show only shortfalls ]  [ Export ]     │  │
│      [ Add to plan ]   │  └───────────────────────────────────────────┘  │
│                        │                                                 │
│ IN THIS PLAN           │  COMPONENT      REQUIRED  AVAILABLE  SHORT      │
│ ▸ APF Foundation       │  ▓▓▓▓▓▓░░░░  APF CAP                            │
│   5,000 units      ×   │  PMS0002        5,000     2,807    −2,193  ●RED │
│ ▸ LS-161 Lipstick      │  ▓▓▓▓▓▓▓▓▓▓  APF BOTTLE                         │
│   2,400 units      ×   │  PMS0001        5,000     8,140         —  ●OK  │
│                        │  …                                              │
└────────────────────────┴─────────────────────────────────────────────────┘
```

### Tab 2 — **Inventory**

The 717 components as a searchable table: code, name, type, opening, inward, outward, closing.
Search box, filter by type, sort by any column.

- **Stock is editable inline.** Click a `closing` cell, type a number, and the Plan tab
  recalculates. This is the single best moment in the demo — see §10.
- A **Reset to seed data** button.
- A note showing the source format (see §7.6).

---

## 6. Visual design

The client is a non-technical factory owner. This must look like a **serious operations tool** —
closer to a well-made bank statement than a SaaS landing page. No gradients, no glassmorphism,
no purple, no emoji, no rounded-pill everything, no hero section.

### 6.1 Palette

```css
--ink:        #16283D;   /* near-navy: all primary text, header bar          */
--paper:      #E9EEF3;   /* cool page background                             */
--card:       #FFFFFF;
--rule:       #D8E0E8;   /* borders, dividers                                */
--muted:      #64798F;   /* secondary text, labels                           */

--blue:       #1B4D8F;   /* primary action                                   */
--blue-dk:    #143A6B;
--blue-soft:  #EAF1F9;

--red:        #B3261E;   /* SHORT — the money colour                         */
--red-soft:   #FBEAE8;
--amber:      #B45309;   /* TIGHT                                            */
--amber-soft: #FDF3E5;
--green:      #0F7B5A;   /* OK                                               */
--green-soft: #E7F4EF;
```

Red appears **only** for shortfalls. Never for decoration, never for a delete icon, never for a
tab. When the client sees red anywhere on this screen, it means one thing.

### 6.2 Type

- UI: system sans stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …`).
- **All numbers in a monospace stack with `font-variant-numeric: tabular-nums`.** Non-negotiable —
  columns of figures must align vertically or the table looks amateur.
- Column headers: 9.5px, uppercase, `letter-spacing: .09em`, weight 700, muted.
- Body rows: 13px. Quantity figures: 14.5px, weight 700.

### 6.3 The signature element — the coverage bar

This is the one thing the client will remember. Each requirement row carries a slim horizontal
bar showing how far stock goes toward the requirement.

- 4px tall, full row width, `--rule` track, 2px radius.
- Fill width = `min(coverage, 1) × 100%`.
- Fill colour = the row's status colour.
- When `SHORT`, the **unfilled remainder is filled with a 45° red hatch** (repeating-linear-gradient),
  so the missing portion is visible as a *thing*, not as absence.
- Animate width on change, `180ms ease-out`, and respect `prefers-reduced-motion`.

```css
.hatch {
  background-image: repeating-linear-gradient(
    45deg, transparent 0 3px, rgba(179,38,30,.28) 3px 6px);
}
```

Spend your visual boldness here. Keep everything else quiet.

### 6.4 The verdict bar

Above the table, always visible, stating the answer in one sentence before any numbers:

- **All covered** → green left border, `--green-soft` background: *"This plan can run — all 16 components in stock."*
- **Any tight, none short** → amber: *"This plan can run, but 3 components have less than 10% headroom."*
- **Any short** → red: *"This plan cannot run — 4 components short."*

Big (17–19px), weight 700. This is the sentence the client reads out loud.

### 6.5 Table

Zebra stripe even rows `#FBFCFD`. Row height ~44px. Sticky header on scroll.
Sort default: **shortfall descending, then requirement descending** — biggest problem on top,
always. Do not make the client hunt for the red.

### 6.6 Restraint

One icon set, used only where an icon carries meaning (status dot, remove-from-plan ×, export).
No icon next to every heading. No card shadows beyond a hairline border. No animated counters.

---

## 7. Behaviour — precise requirements

### 7.1 Product search
Combobox filtering on **product name and FG code**. Full keyboard support: `↓` `↑` navigate,
`Enter` select, `Esc` close. Show for each option: name, FG code, vendor tag, component count.
Selecting focuses and selects the quantity field.

### 7.2 Adding to the plan
Adding a product already in the plan **adds to** its quantity rather than creating a duplicate row.
Quantity is editable inline in the plan list; edits recalculate immediately. `×` removes a line.
`Enter` in the quantity field adds to plan.

### 7.3 Aggregation
Components shared by multiple products aggregate into one row, and that row shows
*"across N products"* under the name. This is a real advantage over the client's spreadsheet —
make sure it is visible.

### 7.4 Filter
Toggle: **All components** / **Only shortfalls**. When shortfalls exist, the toggle should be
obvious but must default to **All** (the client needs to see the whole picture first, then narrow).

### 7.5 Export
Two CSV exports, both `en-IN` formatted with a UTF-8 BOM (`\ufeff`) so Excel opens them cleanly:

1. **Full requirement** — every component: name, code, type, pack size, vendor, required, available, shortfall, status.
2. **Purchase indent** — shortfall rows only, sorted by vendor then shortfall descending.
   Header block lists the production plan it came from and the date.

Also a **Print** view: hides the left panel and both tabs' chrome, prints the verdict + table on
A4 portrait cleanly.

### 7.6 Honesty note
One line, muted, 11px, directly under the requirement table:

> *Product recipes and component codes are from your BOM sheet. Stock figures are demo data —
> your OPENING / INWARD / OUTWARD / CLOSING columns are currently empty. Replace with a real
> count and this becomes live.*

On the Inventory tab, one line noting the format matches their `PM HEADER AND STOCK` sheet exactly.

### 7.7 Empty state
Not a shrug. A prompt: *"No products in the plan yet — choose a product and enter how many units
you want to produce."* Plus a **Load example plan** button that adds two products (one of which
must produce visible shortfalls — see §10). The demo must be recoverable in one click if the
client's questions derail the flow.

### 7.8 Edge cases
- Quantity 0 or blank → treat as 1, never `NaN`. Clamp to `≥1`, integers only.
- Very large quantities (e.g. 10,000,000) must not break layout — numbers wrap gracefully.
- A component with `available = 0` shows a fully hatched bar, not an empty one.
- `requirement = 0` cannot occur with valid input, but guard the division anyway.

---

## 8. CSV import (build it, it takes 20 minutes and it closes the sale)

On the Inventory tab: **Import stock from CSV**.

Accept a CSV with the client's exact headers:

```
SR NO,COMPONENT NAME,TYPE,COMPONENT CODE,OPENING,INWARD,OUTWARD,CLOSING
```

- Match rows on `COMPONENT CODE`. Ignore `SR NO`.
- If `CLOSING` is blank but the other three are present, compute `opening + inward − outward`.
- Report a summary after import: *"Updated 717 of 717 components. 0 codes not recognised."*
- List unrecognised codes if any.
- Never crash on a malformed file — show what went wrong and which row.

`inventory_seed.csv` is a valid input, so importing it is a working round-trip you can demo.

**Why this matters:** it lets the client's answer to *"how do I get my real data in?"* be a
15-second demonstration instead of a promise.

---

## 9. Acceptance checklist

Verify every line before declaring done.

**Data**
- [ ] Header shows exactly **128 products** and **717 components**.
- [ ] Every BOM component code resolves to an inventory row (0 orphans).
- [ ] `closing = opening + inward − outward` holds for all 717 seed rows.

**Math**
- [ ] `APF Apple Foundation Fine Touch` × 5,000 yields exactly:
      `PMS0001 5,000 · PMS0002 5,000 · PMS0003 5,000 · PMS0004 417 · PMS0005 35 · PMS0006 6`
- [ ] That same plan shows **exactly 1 shortfall**: `PMS0002`, required 5,000, available 2,807, short **2,193**.
- [ ] Adding a second product aggregates shared components instead of duplicating rows.
- [ ] Totals are computed by summing floats then rounding up once — not by summing rounded values.

**UI**
- [ ] Red appears only for shortfalls.
- [ ] All numeric columns align on tabular figures.
- [ ] Numbers render Indian-grouped (`1,20,000`).
- [ ] Rows sort worst-shortfall-first by default.
- [ ] Verdict bar states the answer in one plain sentence.
- [ ] Editing a `closing` value on the Inventory tab updates the Plan tab immediately.
- [ ] Both CSVs open in Excel with no mojibake.
- [ ] Works down to a 1280×800 laptop screen (the likely screen-share resolution).
- [ ] Keyboard: full flow — search → select → quantity → add — without touching the mouse.
- [ ] Visible focus rings. `prefers-reduced-motion` respected.
- [ ] No console errors or warnings.

---

## 10. The demo script (design the app so this flow works)

Build so that this exact 90-second sequence is smooth. Test it end to end yourself.

1. Land on **Plan**, empty state. Header reads *128 products · 717 components* — this establishes
   immediately that it is running on the client's real catalogue.
2. Type `APF` → real product names appear. Select **APF Apple Foundation Fine Touch**.
3. Quantity `5000` → **Add to plan**.
4. Table fills. Verdict bar turns red: *"This plan cannot run — 1 component short."*
   `APF CAP` sits at top: required 5,000, available 2,807, **short 2,193**, hatched bar.
   *This is the moment the demo lands.*
5. Add a second product at 2,400 → shortfalls grow to 4; shared components visibly aggregate.
6. **Show only shortfalls** → the purchase list, alone.
7. **Export purchase indent** → open the CSV. This is what goes to the purchase team.
8. Switch to **Inventory**, find `PMS0002`, change closing from `2,807` to `9,000`.
9. Back to **Plan** — that row is now green and the verdict has changed.
   *"When your real stock numbers go in, this is exactly how it behaves."*
10. Close on **Import stock from CSV**, showing the format matches their existing sheet.

Steps 8–9 answer the client's real question — *is this actually connected to my data, or is it a
picture?* — better than any explanation.

---

## 11. Landmine: parsing the client's `.numbers` files

**Only relevant if you re-extract. Skip if you use the shipped JSONs.**

`numbers-parser` loads every object in the document into memory. The client's files contain
enormous numbers of `StrokeLayerArchive` objects (per-cell border styling) —
`CHINA_FG_ROL.numbers` has **~94,000** and will get the process **OOM-killed** with no useful
error, just `Killed`. `PLANNING_SHEET.numbers` is smaller but apply the guard regardless.

The fix — monkey-patch the loader to drop styling objects (they hold no cell data). Full working
implementation is in `extract_source_data.py::install_memory_guard()`. Do not try to solve this by
unzipping and re-zipping the package; that breaks table resolution.

Also note: the `.xlsx` file's lookup formulas are Google Sheets `MAP`/`LAMBDA`/`FILTER`, which
land in Excel as dead `__xludf.DUMMYFUNCTION` strings. Ignore that file entirely — it contains no
data this app needs.

---

## 12. Out of scope — do not build

Say no to these even if they seem natural. Scope creep will make the demo late and worse.

- Any backend, auth, or user accounts.
- Bill/invoice photo upload and OCR extraction *(that is Phase 2 of the roadmap)*.
- Finished-goods stock, order accept/reject gating *(Phase 3)*.
- Multi-user, audit trails, batch/lot tracking.
- Charts, dashboards, KPI tiles. This is a working tool, not an executive dashboard.
- The `CHINA_FG_ROL.numbers` re-order data.
- Anything involving chemical raw materials.

---

## 13. README to ship with the project

Include a short `README.md` covering: what it is in two sentences, `npm install && npm run dev`,
`npm run build`, where the data lives, **which parts are the client's real data and which are
seeded**, how to swap in real stock (CSV import or replace `inventory.json`), and a note that
`extract_source_data.py` regenerates the data from source sheets.

---

## 14. Definition of done

The 90-second script in §10 runs start to finish without a stumble, on a 1280×800 screen, with no
console errors — and every box in §9 is ticked.
