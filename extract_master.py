#!/usr/bin/env python3
"""
Item master from the client's sheets → reference-materials/out/master.json + report.md (both gitignored).

    python extract_master.py [reference-materials]

Reads (never writes) three workbooks in that folder:
  Rudra.xlsx                → the master: FG rows, each followed by its PM/RM rows; codes, vendors, purchase cost.
                              Category "Chemical" = raw material (bulk is made from them).
  PLANNING SHEET (6).xlsx   → "SEMI FINISHED STOCK" / "SEMFINISHED INWARD": names of bulk (semi-finished) items.
  PLANNING SHEET (6).xlsx   → "BOM AND REQUIREMENT": qty per 100 FG (old codes); "PMRM HEADER AND STOCK": name → SKU.
  StkSum.xlsx               → Tally stock summary (names, closing qty, rate) — for checking only.
Standard library only. Nothing is guessed: what does not match exactly (after normalising case/spaces/punctuation)
is listed in the report.
"""
import html
import json
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")
from collections import Counter, defaultdict
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "reference-materials")
OUT = SRC / "out"
RUDRA, PLANNING, STKSUM = SRC / "Rudra.xlsx", SRC / "PLANNING SHEET (6).xlsx", SRC / "StkSum.xlsx"


def rows(path, sheet):
    """A sheet as a list of {column letter: text}, empty rows dropped."""
    z = zipfile.ZipFile(path)
    names = z.namelist()
    shared = []
    if "xl/sharedStrings.xml" in names:
        xml = z.read("xl/sharedStrings.xml").decode()
        shared = [html.unescape(re.sub(r"<[^>]+>", "", m)) for m in re.findall(r"<si>(.*?)</si>", xml, re.S)]
    wb = z.read("xl/workbook.xml").decode()
    rels = z.read("xl/_rels/workbook.xml.rels").decode()
    ids = {html.unescape(a): b for a, b in re.findall(r'<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"', wb)}
    if sheet not in ids:
        raise SystemExit(f"{path.name}: no sheet {sheet!r} (has {list(ids)})")
    rel = re.search(rf'<Relationship [^>]*Id="{ids[sheet]}"[^>]*>', rels).group(0)
    target = re.search(r'Target="([^"]*)"', rel).group(1)
    xml = z.read("xl/" + target.split("xl/")[-1].lstrip("/")).decode()
    out = []
    for r in re.finditer(r"<row [^>]*>(.*?)</row>", xml, re.S):
        d = {}
        for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', r.group(1), re.S):
            col, attrs, body = c.group(1), c.group(2), c.group(3) or ""
            v = re.search(r"<v>(.*?)</v>", body, re.S)
            t = re.search(r't="(\w+)"', attrs)
            if t and t.group(1) == "s" and v:
                val = shared[int(v.group(1))]
            elif t and t.group(1) == "inlineStr":
                val = html.unescape(re.sub(r"<[^>]+>", "", body))
            elif v:
                val = html.unescape(v.group(1))
            else:
                continue
            if val.strip():
                d[col] = val.strip()
        if d:
            out.append(d)
    return out


def key(s):
    """Names compared without case, spaces or punctuation."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


KIND = {
    "Finished Good": "FG",
    "Packaging Material": "PM",
    "Raw Material": "RM",
    "Promotional Material": "PROMO",
    "MRO(Maintenance, Repairs and Operations)": "MRO",
}
assert key("NP-303 Box 24 PCS") == key("np303 box 24pcs")
assert num("4.2") == 4.2 and num("") is None

report = []
say = report.append


def listing(title, lines, limit=None):
    say(f"\n### {title} — {len(lines)}\n")
    for line in lines[:limit] if limit else lines:
        say(f"- {line}")
    if limit and len(lines) > limit:
        say(f"- … {len(lines) - limit} more")


# ── Rudra: the master ─────────────────────────────────────────────────────────
R = rows(RUDRA, "Sheet1")
head, R = R[0], R[1:]
assert head.get("A") == "SKU Code" and head.get("C") == "Item Name" and head.get("L", "").startswith("Purchase Cost"), head

fg, items, vendors, rates = {}, {}, {}, {}
supplies = set()  # (item, vendor code) — every vendor named for an item, with or without a cost
no_code, name_conflict, rate_conflict, unknown_type, mistyped = [], [], [], [], []
blocks = []  # (fg code, [child codes]) in sheet order
current = None
for i, r in enumerate(R, start=2):
    code, name, typ = r.get("A", "").upper(), r.get("C", ""), r.get("B", "")
    if not code:
        no_code.append(f"row {i}: {typ} — {name}")
        continue
    kind = KIND.get(typ)
    if not kind:
        unknown_type.append(f"row {i}: {code} {name} — type {typ!r}")
        continue
    if kind == "FG":
        if code in fg:
            name_conflict.append(f"{code}: FG listed twice — {fg[code]['name']!r} / {name!r}")
            current = None
            continue
        fg[code] = {"code": code, "name": name, "category": r.get("D", ""), "brand": r.get("E", ""),
                    "origin": r.get("R", ""), "active": r.get("Q", "Active") != "Inactive"}
        current = (code, [])
        blocks.append(current)
        continue
    if kind == "RM" and r.get("D") != "Chemical":
        mistyped.append(f"{code} {name} (category {r.get('D', '')})")
    if code in items:
        if key(items[code]["name"]) != key(name):
            name_conflict.append(f"{code}: {items[code]['name']!r} / {name!r} — first kept")
    else:
        items[code] = {"code": code, "name": name, "kind": kind, "category": r.get("D", ""), "type": r.get("F", ""),
                       "uom": r.get("G", "").upper(), "origin": r.get("R", "")}
    # under an FG: its own items (named with its code) or shared ones of its category; chemicals, promo and loose
    # items listed after the last FG belong to none
    f = fg[current[0]] if current else None
    if f and r.get("D") != "Chemical" and code not in current[1] and (
            key(name).startswith(key(f["code"])) or (r.get("D") and r.get("D") == f["category"])):
        current[1].append(code)
    vcode, vname = r.get("I", "").upper(), r.get("J", "").strip()
    if vcode:
        vendors.setdefault(vcode, vname.upper())
        supplies.add((code, vcode))
        cost = num(r.get("L"))
        if cost is not None and cost > 0:
            had = rates.get((code, vcode))
            if had is not None and abs(had - cost) > 1e-9:
                rate_conflict.append(f"{code} × {vcode}: {had} / {cost} — first kept")
            rates.setdefault((code, vcode), cost)

name_to_code = defaultdict(set)
for it in items.values():
    name_to_code[key(it["name"])].add(it["code"])
fg_by_name = {key(f["name"]): c for c, f in fg.items()}


def rudra_code(code, name):
    """The Rudra code of an item named elsewhere: its own code if Rudra has it under the same name, else by name."""
    code = (code or "").upper()
    if code in items and key(items[code]["name"]) == key(name):
        return code, "code"
    hit = name_to_code.get(key(name), set())
    if len(hit) == 1:
        return next(iter(hit)), "name"
    return None, ("ambiguous name" if hit else "no match")


# ── PMRM header: more name → SKU pairs ────────────────────────────────────────
H = rows(PLANNING, "PMRM HEADER AND STOCK")
assert H[0].get("B") == "Item Name" and H[0].get("E") == "SKU Code", H[0]
for h in H[1:]:
    sku, nm = h.get("E", "").upper(), h.get("B", "")
    if sku in items and nm and key(nm) not in name_to_code:
        name_to_code[key(nm)].add(sku)

# ── Planning BOM: qty per 100, under old codes ────────────────────────────────
B = rows(PLANNING, "BOM AND REQUIREMENT")
assert B[0].get("C") == "COMPONENT NAME" and B[0].get("E") == "ITEM CODE" and B[0].get("F") == "PERCENT", B[0]
qty = {}  # (fg code, item code) → per 100
old_to_new, unmapped_bom, unmapped_fg, qty_conflict = {}, [], [], []
fg_codes_by_len = sorted(fg, key=len, reverse=True)
member_of = defaultdict(set)  # item → Rudra FGs whose block lists it
for code, kids in blocks:
    for k in kids:
        member_of[k].add(code)
plan_blocks = []  # [planning FG name, FG CODES, [(old code, name, per 100)]]
for b in B[1:]:
    if b.get("A"):
        plan_blocks.append([b.get("C", ""), b.get("D", "").upper(), []])
    elif b.get("E") and plan_blocks:
        plan_blocks[-1][2].append((b.get("E", "").upper(), b.get("C", ""), num(b.get("F"))))
by_vote, loose = [], []
for nm, codes, lines in plan_blocks:
    mapped = []
    for old, cnm, pct in lines:
        new, how = rudra_code(old, cnm)
        if not new:
            unmapped_bom.append(f"{old} {cnm} — {how}")
            continue
        mapped.append((new, pct))
        if old != new and re.fullmatch(r"(PMS|PMR|PM|RM)\d+", old):
            prev = old_to_new.get(old)
            if prev and prev["new"] != new:
                qty_conflict.append(f"old code {old} named for both {prev['new']} and {new} — first kept")
            else:
                old_to_new[old] = {"old": old, "new": new, "how": how, "name": cnm}
    plan_fg = codes if codes in fg else fg_by_name.get(key(nm)) or next(
        (c for c in fg_codes_by_len if key(nm).startswith(key(c))), None)
    if not plan_fg:
        # named differently: the Rudra FG whose block holds most of its items (at least half)
        votes = Counter(f for new, _ in mapped for f in member_of[new])
        top = votes.most_common(2)
        if top and top[0][1] * 2 >= len(mapped) and (len(top) == 1 or top[0][1] > top[1][1]):
            plan_fg = top[0][0]
            by_vote.append(f"{nm} ({codes}) → {plan_fg} ({top[0][1]} of {len(mapped)} items)")
        else:
            unmapped_fg.append(f"{nm} ({codes})")
            continue
    for new, pct in mapped:
        if not (pct and pct > 0):
            continue
        it, f = items[new], fg[plan_fg]
        # the planning sheet's last FG is followed by a loose list of other items: keep only its own
        if not (plan_fg in member_of[new] or key(it["name"]).startswith(key(plan_fg))
                or (it["category"] and it["category"] == f["category"])):
            loose.append(f"{plan_fg} × {new} {it['name']} ({pct} per 100)")
            continue
        had = qty.get((plan_fg, new))
        if had is not None and abs(had - pct) > 1e-6:
            qty_conflict.append(f"{plan_fg} × {new}: per 100 = {had} / {pct} — first kept")
        qty.setdefault((plan_fg, new), pct)

def pack_qty(name):
    """Qty per 100 FG from the pack size in the item name: "BOX 24 PCS" → 100/24, else 1 per FG (100).
    Matches the planning sheet's own qty on 1,145 of its 1,146 lines."""
    m = re.search(r"(\d+)\s*(?:PCS|PC)\b", name.upper())
    return 100 / int(m.group(1)) if m and int(m.group(1)) > 1 else 100.0


assert abs(pack_qty("NP-303 PETTI 72 PCS") - 1.3889) < 1e-3 and pack_qty("NP-303 CAP") == 100.0
assert pack_qty("LL-270 TRAY BP-78") == 100.0 and pack_qty("X monocarton single pcs dibbi") == 100.0

# the BOM: every planning line with a qty (source SHEET); Rudra items under an FG without one get it from the
# pack size in their name (source PACK, marked as such on the screens)
bom = [{"fg": f, "item": k, "per100": pct, "source": "SHEET"} for (f, k), pct in qty.items()]
no_qty, not_in_rudra_block = [], []
for code, kids in blocks:
    for k in kids:
        if (code, k) not in qty:
            no_qty.append(f"{code} × {k} {items[k]['name']} → {round(pack_qty(items[k]['name']), 4)} per 100")
            bom.append({"fg": code, "item": k, "per100": pack_qty(items[k]["name"]), "source": "PACK"})
for (f, k), pct in qty.items():
    if f not in member_of[k]:
        not_in_rudra_block.append(f"{f} × {k} {items[k]['name']} ({pct} per 100)")
empty_fg = [f"{c} {fg[c]['name']}" for c, kids in blocks if not kids]

# ── bulk: semi-finished items made here ───────────────────────────────────────
bulk = {}
for sh in ("SEMI FINISHED STOCK", "SEMFINISHED INWARD"):
    for r in rows(PLANNING, sh)[1:]:
        nm = re.sub(r"\s+", " ", r.get("A", "")).strip()
        if nm:
            bulk.setdefault(key(nm), nm)

# ── StkSum: Tally stock (check only) ──────────────────────────────────────────
S = rows(STKSUM, "Stock Summary")
start = next(i for i, s in enumerate(S) if s.get("A") == "Particulars") + 3
tally = [s for s in S[start:] if s.get("A") and num(s.get("B")) is not None]
plan_name_to_new = {key(v["name"]): v["new"] for v in old_to_new.values()}
vendor_item = {key(r.get("K")): r.get("A", "").upper() for r in R if r.get("K") and r.get("A")}
in_tally, tally_only, rate_vs_tally = {}, [], []
for s in tally:
    k = key(s["A"])
    hit = name_to_code.get(k, set())
    code = next(iter(hit)) if len(hit) == 1 else plan_name_to_new.get(k) or vendor_item.get(k)
    if code in items or code in fg:
        in_tally[code] = s["A"]
        t_rate, ours = num(s.get("C")), [v for (c, _), v in rates.items() if c == code]
        if t_rate and ours and all(abs(o - t_rate) / t_rate > 0.2 for o in ours):
            rate_vs_tally.append(f"{code} {s['A']}: Rudra {', '.join(map(str, ours))} vs Tally {t_rate}")
    else:
        tally_only.append(f"{s['A']} (qty {s.get('B')})")
not_in_tally = [f"{c} {it['name']}" for c, it in items.items() if c not in in_tally]

# ── write ─────────────────────────────────────────────────────────────────────
OUT.mkdir(exist_ok=True)
per_kind = Counter(it["kind"] for it in items.values())
multi_vendor = defaultdict(list)
for (c, v) in rates:
    multi_vendor[c].append(v)
master = {
    "fg": [{**f, "components": [k for c, kids in blocks if c == code for k in kids]} for code, f in fg.items()],
    "items": list(items.values()),
    "vendors": [{"code": c, "name": n} for c, n in vendors.items()],
    "rates": [{"item": c, "vendor": v, "cost": cost} for (c, v), cost in rates.items()],
    "supplies": [{"item": c, "vendor": v} for (c, v) in sorted(supplies) if c in items],
    "bom": bom,
    "oldToNew": list(old_to_new.values()),
    "inTally": in_tally,
    "bulk": sorted(bulk.values()),
}
(OUT / "master.json").write_text(json.dumps(master, indent=1, ensure_ascii=False), encoding="utf-8")

say("# Item master — extraction report\n")
say(f"Source: {RUDRA.name}, {PLANNING.name} (BOM AND REQUIREMENT, PMRM HEADER AND STOCK), {STKSUM.name}\n")
say("| | count |\n|---|---|")
for label, n in [
    ("Finished goods (FG)", len(fg)), ("Items — PM", per_kind["PM"]), ("Items — RM (incl. chemicals)", per_kind["RM"]),
    ("Bulk (semi-finished) items", len(bulk)), ("Items — Promotional", per_kind["PROMO"]),
    ("Items — MRO", per_kind["MRO"]), ("Vendors", len(vendors)), ("Item × vendor mappings", len(supplies)), ("…of which with a cost", len(rates)),
    ("Items with 2+ vendors", sum(1 for v in multi_vendor.values() if len(v) > 1)),
    ("BOM lines with qty (FG × item)", len(bom)), ("Old code → Rudra code pairs", len(old_to_new)),
    ("Items/FG found in Tally stock summary", len(in_tally)),
]:
    say(f"| {label} | {n} |")
say("\nEverything below needs a look; nothing here was guessed.")
listing("Rows without a code (skipped)", no_code)
listing("Same code, different name / FG listed twice", name_conflict)
listing("Unknown item type (skipped)", unknown_type)
listing("Raw Material that is not a chemical (check: PM?)", mistyped)
listing("FG with no PM/RM under it in Rudra", empty_fg)
listing("Under an FG in Rudra, no qty in the planning BOM — qty taken from the pack size in the name", no_qty)
listing("In the planning BOM but not under that FG in Rudra (kept in the BOM — check)", not_in_rudra_block)
listing("Planning FG named differently, matched by its items", by_vote)
listing("Planning BOM line under an FG it does not belong to (dropped)", loose)
listing("Planning BOM FG not found in Rudra", unmapped_fg)
listing("Planning BOM component not found in Rudra", unmapped_bom)
listing("Qty / code conflicts in the planning BOM", qty_conflict)
listing("Same item × vendor with two costs", rate_conflict)
listing("Items with no vendor", [f"{c} {it['name']}" for c, it in items.items() if c not in multi_vendor])
listing("Cost differs >20% from Tally's stock rate", rate_vs_tally)
listing("Rudra items not found in Tally stock summary (by name)", not_in_tally, 60)
listing("Tally stock items not in Rudra (by name)", tally_only, 60)
(OUT / "report.md").write_text("\n".join(report) + "\n", encoding="utf-8")
print("\n".join(report[: report.index("\nEverything below needs a look; nothing here was guessed.")]))
print(f"\nWrote {OUT / 'master.json'} and {OUT / 'report.md'}")
