#!/usr/bin/env python3
"""
Regenerate bom.json + inventory.json from the client's original source files.

You do NOT need to run this to build the app — bom.json and inventory.json are
already provided. Run it only to (a) verify the shipped data, or (b) re-extract
after the client sends updated sheets.

    pip install numbers-parser
    python extract_source_data.py /path/to/PLANNING_SHEET.numbers ./out

Source of truth:
    PLANNING_SHEET.numbers
      ├── "BOM AND REQUIREMENT"   -> product recipes      -> bom.json
      └── "PM HEADER AND STOCK"   -> component master     -> inventory.json (stock cols are EMPTY in source)
"""
import sys, json, csv, hashlib, math
from pathlib import Path
from collections import Counter

# ─────────────────────────────────────────────────────────────────────────────
# CRITICAL: memory guard for .numbers files.
#
# numbers-parser loads every object in the document. The client's files contain
# tens of thousands of StrokeLayerArchive objects (per-cell border styling).
# CHINA_FG_ROL.numbers has ~94,000 of them and will OOM-kill the process on a
# normal machine. PLANNING_SHEET.numbers is smaller but apply the guard anyway.
#
# This patch drops border-styling objects during load. They carry no cell data.
# ─────────────────────────────────────────────────────────────────────────────
def install_memory_guard():
    from numbers_parser import iwork
    from numbers_parser.iwafile import IWAFile, is_iwa_file

    SKIP = {"StrokeLayerArchive", "StrokeSidecarArchive"}
    original = iwork.IWork._store_blob

    def patched(self, filename, blob):
        if filename.startswith("Data/"):          # embedded images — not needed
            self._handler.store_file(filename, b"")
            return
        if filename.endswith(".iwa") and is_iwa_file(blob):
            iwaf = IWAFile.from_buffer(blob, filename)
            for archive in iwaf.chunks[0].archives:
                obj = archive.objects[0]
                if type(obj).__name__ in SKIP:
                    continue
                self._handler.store_object(filename, archive.header.identifier, obj)
            self._handler.store_file(filename, iwaf)
            return
        return original(self, filename, blob)

    iwork.IWork._store_blob = patched


def sheet_rows(doc, sheet_name):
    for s in doc.sheets:
        if s.name == sheet_name:
            return s.tables[0].rows(values_only=True)
    raise SystemExit(f"Sheet not found: {sheet_name!r}. Present: {[s.name for s in doc.sheets]}")


# ─────────────────────────────────────────────────────────────────────────────
# BOM extraction
#
# Layout of "BOM AND REQUIREMENT" — it is a nested list, not a flat table:
#
#   SR NO | COMPONENT NAME                | ITEM CODE | PERCENT | FG CODES | VENDOR
#   ------+------------------------------+-----------+---------+----------+--------
#   1     | APF Apple Foundation Fine T. |           |         | APPLE... | Domestic   <- PRODUCT header (SR NO present)
#         | APF BOTTLE                   | PMS0001   | 100     |          |            <- component
#         | APF CAP                      | PMS0002   | 100     |          |            <- component
#         | APF box 12pcs                | PMS0004   | 8.3333  |          |            <- component
#   2     | BL-678 (Bloom Liquid Blusher)|           |         | BL-678   | China      <- next PRODUCT
#
# Rule: a row with SR NO filled starts a new product. Rows after it with an
# ITEM CODE are that product's components, until the next SR NO.
# ─────────────────────────────────────────────────────────────────────────────
def extract_bom(doc):
    rows = sheet_rows(doc, "BOM AND REQUIREMENT")
    idx = {str(h): i for i, h in enumerate(rows[0])}

    def get(row, key):
        i = idx.get(key)
        if i is None or i >= len(row):
            return None
        v = row[i]
        return None if v in (None, "") else v

    products, current = [], None
    for row in rows[1:]:
        sr = get(row, "SR NO")
        if sr is not None:                                   # product header
            vendor_raw = str(get(row, "VENDOR") or "").lower()
            current = {
                "name":   str(get(row, "COMPONENT NAME") or "(unnamed)").strip(),
                "fg":     str(get(row, "FG CODES") or "").strip(),
                "vendor": "China" if "chin" in vendor_raw else ("Domestic" if "domest" in vendor_raw else ""),
                "comps":  [],
            }
            products.append(current)
        elif current is not None:                            # component line
            code = get(row, "ITEM CODE")
            if not code:
                continue
            try:
                pct = float(get(row, "PERCENT"))
            except (TypeError, ValueError):
                continue
            current["comps"].append({
                "n": str(get(row, "COMPONENT NAME") or "").strip(),
                "c": str(code).strip(),
                "p": pct,
            })

    products = [p for p in products if p["comps"]]           # drop headers with no components
    return products


# ─────────────────────────────────────────────────────────────────────────────
# Component master. In the source, COMPONENT CODE + COMPONENT NAME are fully
# populated (717 rows) but TYPE / OPENING / INWARD / OUTWARD / CLOSING are ALL
# EMPTY. We take the real names+codes and synthesise plausible stock for the demo.
# ─────────────────────────────────────────────────────────────────────────────
def infer_type(name):
    u = (name or "").upper()
    if "MASTER" in u:                                  return "Master Outer"
    if "OUTER"  in u:                                  return "Outer"
    if "BOX"    in u:                                  return "Box"
    if "BOTTLE" in u or "JAR" in u or "TUBE" in u:     return "Bottle"
    if "CAP"    in u:                                  return "Cap"
    if "STICKER" in u or "LABEL" in u:                 return "Sticker"
    if "READ"   in u:                                  return "Ready Stock"
    return "Other"


REF_PLAN = 5000   # reference production run used to size demo stock


def seed_inventory(products):
    """Deterministic demo stock. ~33% short, ~12% tight, ~55% healthy — so the
    demo always shows red without anyone having to hunt for it."""
    comps = {}
    for p in products:
        for c in p["comps"]:
            r = comps.setdefault(c["c"], {"name": c["n"], "maxpct": 0.0})
            r["maxpct"] = max(r["maxpct"], c["p"])

    def rnd(code, salt):
        return int(hashlib.md5(f"{code}|{salt}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF

    out, bands = [], Counter()
    for i, code in enumerate(sorted(comps), 1):
        r = comps[code]
        demand = REF_PLAN * r["maxpct"] / 100.0
        u = rnd(code, "band")
        if   u < 0.33: factor, band = 0.05 + rnd(code, "f1") * 0.80, "short"
        elif u < 0.45: factor, band = 1.00 + rnd(code, "f2") * 0.09, "tight"
        else:          factor, band = 1.35 + rnd(code, "f3") * 3.20, "healthy"
        bands[band] += 1

        closing = max(0, int(round(demand * factor)))
        outward = int(round(demand * (0.35 + rnd(code, "o") * 0.95)))
        inward  = int(round(demand * (0.45 + rnd(code, "i") * 1.25)))
        opening = closing - inward + outward
        if opening < 0:                       # keep every figure non-negative
            opening = 0
            inward  = closing + outward       # re-solve so the identity holds
        assert opening + inward - outward == closing

        out.append({"code": code, "name": r["name"], "type": infer_type(r["name"]),
                    "opening": opening, "inward": inward,
                    "outward": outward, "closing": closing})
    return out, bands


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    out = Path(sys.argv[2] if len(sys.argv) > 2 else ".")
    out.mkdir(parents=True, exist_ok=True)

    install_memory_guard()
    from numbers_parser import Document
    doc = Document(str(src))

    products = extract_bom(doc)
    inventory, bands = seed_inventory(products)

    # ---- integrity checks: these MUST pass ----
    n_comp_lines = sum(len(p["comps"]) for p in products)
    bom_codes    = {c["c"] for p in products for c in p["comps"]}
    inv_codes    = {r["code"] for r in inventory}
    assert bom_codes == inv_codes, "BOM codes and inventory codes disagree"
    bad_pct = [c["p"] for p in products for c in p["comps"]
               if abs(100 / c["p"] - round(100 / c["p"])) > 0.02 * max(round(100 / c["p"]), 1)]

    print(f"products        : {len(products)}      (expect 128)")
    print(f"component lines : {n_comp_lines}      (expect 717)")
    print(f"unique codes    : {len(inv_codes)}      (expect 717)")
    print(f"unclean PERCENT : {len(bad_pct)}        (expect 0)")
    print(f"seed bands      : {dict(bands)}")

    (out / "bom.json").write_text(json.dumps(products, separators=(",", ":")))
    (out / "inventory.json").write_text(json.dumps(inventory, separators=(",", ":")))

    cols = ["SR NO", "COMPONENT NAME", "TYPE", "COMPONENT CODE",
            "OPENING", "INWARD", "OUTWARD", "CLOSING"]
    with (out / "inventory_seed.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for i, r in enumerate(inventory, 1):
            w.writerow({"SR NO": i, "COMPONENT NAME": r["name"], "TYPE": r["type"],
                        "COMPONENT CODE": r["code"], "OPENING": r["opening"],
                        "INWARD": r["inward"], "OUTWARD": r["outward"],
                        "CLOSING": r["closing"]})
    print(f"\nwrote -> {out}/bom.json, inventory.json, inventory_seed.csv")


if __name__ == "__main__":
    main()
