/**
 * Item photos from the client's Master Item Databank → the item masters (components / products .ps_photo).
 *   python -I tools/xlsx2json.py "<folder>/Master_Item_Databank.xlsx" "<folder>/out/databank.json"
 *   npm run master:photos -- <folder>/out/databank.json              dry run: report only
 *   npm run master:photos -- <folder>/out/databank.json --apply      fill the items that have no photo yet
 *   … --apply --overwrite                                            also replace a different photo with the databank's
 * Sheet "Item Master": SKU Code, Item Name, Item Photo (a Google Drive file link). Items are matched by SKU code (PM/RM:
 * components.code; FG: products.fg_code when unique), else by exact name. Nothing is created or deleted; items not in
 * the database are listed. Writes <folder of the file>/photos-report.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { maintenanceConnection } from "../src/db";
import { photoId } from "../src/photos";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply"), overwrite = args.includes("--overwrite");

async function main() {
  if (!file) throw new Error("Usage: npm run master:photos -- <databank.json> [--apply] [--overwrite]");
  const sheet = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[][]>)["Item Master"];
  if (!sheet) throw new Error(`No "Item Master" sheet in ${file}.`);
  const head = sheet[0].map((h) => String(h ?? "").trim().toLowerCase());
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`Item Master has no "${name}" column.`);
    return i;
  };
  const cSku = col("sku code"), cName = col("item name"), cPhoto = col("item photo");

  const conn = await maintenanceConnection();
  const lists: Record<string, string[]> = {};
  const list = (k: string, x: string) => (lists[k] ??= []).push(x);
  let same = 0, filled = 0, replaced = 0;
  try {
    const q = async (sql: string, p: unknown[] = []) => (await conn.query<RowDataPacket[]>(sql, p))[0];
    const items = [
      ...(await q("SELECT 'components' AS t, code AS k, code, name, ps_photo FROM components")),
      ...(await q("SELECT 'products' AS t, id AS k, fg_code AS code, name, ps_photo FROM products")),
    ];
    const byCode = new Map<string, RowDataPacket[]>(), byName = new Map<string, RowDataPacket[]>();
    for (const it of items) {
      if (it.code) byCode.set(String(it.code).toUpperCase(), [...(byCode.get(String(it.code).toUpperCase()) ?? []), it]);
      byName.set(String(it.name).trim().toLowerCase(), [...(byName.get(String(it.name).trim().toLowerCase()) ?? []), it]);
    }
    await conn.beginTransaction();
    const done = new Set<string>();
    for (const r of sheet.slice(1)) {
      const name = String(r[cName] ?? "").trim(), sku = String(r[cSku] ?? "").trim().toUpperCase(), link = String(r[cPhoto] ?? "").trim();
      if (!name || !link) continue;
      const id = photoId(link);
      if (!id) {
        list("Photo cell is not a Google Drive file link (skipped)", `${sku} ${name}: "${link.slice(0, 60)}"`);
        continue;
      }
      const codeHits = byCode.get(sku) ?? [];
      const hits = codeHits.length === 1 ? codeHits : (byName.get(name.toLowerCase()) ?? []);
      if (hits.length !== 1) {
        list(hits.length ? "Name matches more than one item (skipped)" : "Item not in the database (not created)", `${sku} ${name}`);
        continue;
      }
      const it = hits[0], ref = `${it.t}:${it.k}`;
      if (done.has(ref)) continue; // the item × vendor rows repeat the item
      done.add(ref);
      const cur = String(it.ps_photo ?? "");
      if (cur === id) {
        same++;
        continue;
      }
      if (cur && !overwrite) {
        list("Different photo in the database — kept (--overwrite takes the databank's)", `${it.code} ${it.name}: database ${cur} · databank ${id}`);
        continue;
      }
      await conn.query(`UPDATE ${it.t} SET ps_photo = ? WHERE ${it.t === "components" ? "code" : "id"} = ?`, [id, it.k]);
      if (cur) {
        replaced++;
        list("Photo replaced with the databank's", `${it.code} ${it.name}: ${cur} → ${id}`);
      } else {
        filled++;
        list("Photo added (the item had none)", `${it.code} ${it.name}`);
      }
    }
    if (apply) {
      await conn.query("INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', 'master.photos', 'ok', ?)", [
        `${filled} added, ${replaced} replaced, ${same} already the same`,
      ]);
      await conn.commit();
    } else await conn.rollback();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.end();
  }
  const out = [`# Item photos from the Master Item Databank — ${apply ? "APPLIED" : "dry run (nothing kept)"}\n`,
    `- already the same: ${same}`, `- added: ${filled}`, `- replaced: ${replaced}`];
  for (const [k, l] of Object.entries(lists)) out.push(`\n### ${k} — ${l.length}\n`, ...l.map((x) => `- ${x}`));
  const at = join(dirname(file), "photos-report.md");
  writeFileSync(at, out.join("\n") + "\n");
  console.log(out.slice(1, 4).join("\n"));
  console.log(Object.entries(lists).map(([k, l]) => `  ${l.length} × ${k}`).join("\n"));
  console.log(`\n${apply ? "Applied." : "Dry run — nothing changed."} Report: ${at}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
