#!/usr/bin/env python3
"""
Any workbook → JSON (typed cells), the first step of every module's import (see docs/03-adding-a-module.md).

    python -I tools/xlsx2json.py "modules/<module>/source/<workbook>.xlsx" [out.json]

Writes out.json (default: <folder of the workbook>/out/sheets.json): {sheet name: [[cell, …] per row]}, every sheet,
every row kept with its cells in column order (A = index 0). Numbers stay numbers (dates are sheet serial numbers, as
Apps Script's getValues sees them), text stays text, empty = "". No mapping or cleaning here — the module's importer
does that and checks the headers it relies on. Standard library only; reads the file, never changes it.
"""
import html
import json
import re
import sys
import zipfile
from pathlib import Path

def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        xml = z.read("xl/sharedStrings.xml").decode()
        # a shared string may be split in runs (<r><t>…</t></r>): join every <t> of the item
        for si in re.findall(r"<si>(.*?)</si>", xml, re.S):
            shared.append(html.unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S))))
    wb = z.read("xl/workbook.xml").decode()
    rels = z.read("xl/_rels/workbook.xml.rels").decode()
    out = {}
    for name, rid in re.findall(r'<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"', wb):
        name = html.unescape(name)
        rel = re.search(rf'<Relationship [^>]*Id="{rid}"[^>]*>', rels).group(0)
        target = re.search(r'Target="([^"]*)"', rel).group(1)
        xml = z.read("xl/" + target.split("xl/")[-1].lstrip("/")).decode()
        rows = []
        for r in re.finditer(r'<row [^>]*r="(\d+)"[^>]*>(.*?)</row>', xml, re.S):
            rn = int(r.group(1))
            while len(rows) < rn - 1:
                rows.append([])
            cells = []
            for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', r.group(2), re.S):
                i = col_index(c.group(1))
                attrs, body = c.group(2), c.group(3) or ""
                v = re.search(r"<v>(.*?)</v>", body, re.S)
                t = re.search(r't="(\w+)"', attrs)
                kind = t.group(1) if t else "n"
                if kind == "s" and v:
                    val = shared[int(v.group(1))]
                elif kind == "inlineStr":
                    val = html.unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", body, re.S)))
                elif kind in ("str", "e") and v:
                    val = html.unescape(v.group(1))
                elif kind == "b" and v:
                    val = v.group(1) == "1"
                elif v:
                    f = float(v.group(1))
                    val = int(f) if f.is_integer() and abs(f) < 2**53 else f
                else:
                    continue
                while len(cells) < i:
                    cells.append("")
                cells.append(val)
            rows.append(cells)
        out[name] = rows
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python -I tools/xlsx2json.py <workbook.xlsx> [out.json]")
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.parent / "out" / "sheets.json"
    data = read(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for k, v in data.items():
        print(f"{k}: {len(v)} rows")
    print(f"Wrote {dst}")
