/**
 * Purchase System — the 33 functions the page calls (same names, positional arguments, return shapes and error texts
 * as the Apps Script Code.gs v2.0), on the database instead of the sheets.
 */
import { randomUUID } from "node:crypto";
import { audit } from "../../../server/src/audit";
import type { Call } from "../../../server/src/module";
import { config } from "../../../server/src/config";
import { hashPassword, hashToken, newToken, verifyDummy, verifyPassword } from "../../../server/src/crypto";
import { pool, type Queryable } from "../../../server/src/db";
import {
  ARCHIVE_STAGES, calcRow, CFG, day, dayKey, diffDays, entityOf, esc, fmt, isArchived, isDibbi, isInnerPeti, isoToDate, key, lineId, money, ms, normPo,
  num, qtyParse, r2, roundUpPack, STAGE, STEPS, str, taxSplit, taxType, toDate, today,
  type Calc, type Ctx as CalcCtx, type Item, type Line, type PoRec,
} from "./core";
import { sendMail } from "../../../server/src/mail";
import { poPdf } from "./pdf";
import {
  blankVendor, context, doerOf, exec, fileUrl, findItem, isOurFile, itemMap, loadDoers, loadItems, loadLines, loadVendors, rows, saveFile, setSetting, setting,
  vendorFind, withLock, type Doer, type Vendor,
} from "./store";

interface Sess extends Omit<Doer, "active"> {
  canPo: boolean;
}

/* ── sessions ── */
/** The token from login is the session: kept hashed in `sessions` (idle and absolute expiry as for the main app). */
async function session(c: Call): Promise<Sess> {
  if (!/^S[0-9A-Za-z_-]{20,100}$/.test(c.token)) throw new Error("SESSION_EXPIRED");
  const id = hashToken(c.token);
  const [r] = await rows(pool, `SELECT TIMESTAMPDIFF(SECOND, s.last_seen_at, NOW(3)) AS idle, u.id, u.ps_name, u.ps_access, u.ps_types, u.ps_email, u.active
                                  FROM sessions s JOIN users u ON u.id = s.user_id
                                 WHERE s.id = ? AND s.expires_at > NOW(3) AND u.active = 1 AND u.ps_name IS NOT NULL`, [id]);
  if (!r) throw new Error("SESSION_EXPIRED");
  if (Number(r.idle) > config.SESSION_IDLE_MINUTES * 60) {
    await exec(pool, "DELETE FROM sessions WHERE id = ?", [id]);
    throw new Error("SESSION_EXPIRED");
  }
  if (Number(r.idle) > 60) await exec(pool, "UPDATE sessions SET last_seen_at = NOW(3) WHERE id = ?", [id]);
  const d = doerOf(r);
  return { id: d.id, name: d.name, steps: d.steps, admin: d.admin, email: d.email, types: d.types, canPo: d.admin || d.steps.includes(1) };
}
const indentTokens = new Map<string, number>();
let indentFails: { n: number; until: number } = { n: 0, until: 0 };
async function indentHashes(): Promise<string[]> {
  try {
    return JSON.parse((await setting(pool, "indent_passwords")) || "[]");
  } catch {
    return [];
  }
}
async function indentOk(t: unknown): Promise<boolean> {
  if (!(await indentHashes()).length) return true;
  const exp = indentTokens.get(str(t));
  return !!exp && exp > Date.now();
}
const isIndentToken = (t: unknown) => !t || String(t).charAt(0) === "I";

/* ── item type per doer ── */
let doerTypeKeysMemo: { at: number; k: Record<string, 1> } | null = null;
async function doerTypeKeys(): Promise<Record<string, 1>> {
  if (doerTypeKeysMemo && Date.now() - doerTypeKeysMemo.at < 5000) return doerTypeKeysMemo.k;
  const k: Record<string, 1> = {};
  (await loadDoers(pool)).forEach((d) => d.types.forEach((t) => {
    if (t !== "other" && t !== "all") k[t] = 1;
  }));
  doerTypeKeysMemo = { at: Date.now(), k };
  return k;
}
function itemGroup(itemName: unknown, im: Record<string, Item>, keys: Record<string, 1>) {
  const it = im[str(itemName).toLowerCase()] || ({} as Item);
  return [it.c, it.t, it.pt].map(key).find((x) => x && keys[x]) || "other";
}
function allowedItem(s: Sess | null, itemName: unknown, im: Record<string, Item>, keys: Record<string, 1>) {
  if (!s || s.admin || !s.types || !s.types.length || s.types.includes("all")) return true;
  return s.types.includes(itemGroup(itemName, im, keys));
}
const allowedPo = (s: Sess, rec: PoRec | undefined, im: Record<string, Item>, keys: Record<string, 1>) =>
  !rec || rec.lines.some((l) => allowedItem(s, l.name || l.code, im, keys)) || !rec.lines.length;
const typesTxt = (s: Sess) => s.types.map((t) => t.charAt(0).toUpperCase() + t.slice(1) + " items").join(", ");
function needPo(s: Sess) {
  if (!s.canPo) throw new Error("Only the Step 1 user (Purchase) or the Admin can do this.");
}
function needAdmin(s: Sess) {
  if (!s.admin) throw new Error("Only the Admin (Doer = ALL) can do this.");
}
const isDirectorName = (n: unknown) => /\(director\)\s*$/i.test(str(n));
function needDirector(s: Sess) {
  if (!s.admin || !isDirectorName(s.name)) throw new Error("Only a Director login can manage users.");
}

/* ── shared reads ── */
// full links: the page may run on Google's site (Apps Script) and load these from here
const logo = (k: "LOGO" | "RED4") => config.APP_ORIGIN + "/api/ps/asset/" + (k === "LOGO" ? "logo.png" : "logo-red4.jpg");
async function units(items: Item[]) {
  const u: Record<string, 1> = {};
  CFG.UNITS.concat(items.map((i) => i.u)).forEach((x) => {
    x = str(x).toUpperCase();
    if (x) u[x] = 1;
  });
  return Object.keys(u);
}
function indentItems(items: Item[]) {
  return items
    .filter((it) => !it.fg && !/inactive|discontinued|block/i.test(it.st) && it.o === "INDIAN")
    .map((it) => {
      const vi: Record<string, string> = {};
      it.v.forEach((x) => {
        if (x[2]) vi[x[0]] = x[2];
      });
      const o: Record<string, unknown> = { n: it.n, s: it.s, t: it.t, c: it.c, b: it.b, u: it.u, o: it.o, v: it.v.map((x) => x[0]), ch: it.ch, vi, p: it.ph || "" };
      if (it.set) o.set = it.set;
      if (it.peti) o.peti = it.peti;
      if (it.moq) o.moq = it.moq;
      if (it.pkgs && it.pkgs.length) o.pkgs = it.pkgs;
      return o;
    });
}
async function filledBy(db: Queryable): Promise<string[]> {
  const set: Record<string, string> = {};
  (await rows(db, "SELECT DISTINCT filled_by FROM ps_lines WHERE in_register = 1 AND filled_by <> ''")).forEach((r) => {
    const n = str(r.filled_by);
    if (n) set[n.toUpperCase()] = n;
  });
  (await loadDoers(db)).forEach((d) => {
    if (!set[d.name.toUpperCase()]) set[d.name.toUpperCase()] = d.name;
  });
  return Object.keys(set).map((k) => set[k]).sort((a, b) => a.localeCompare(b));
}

/** the working view: every line with its calculation; archived = what the script had moved to the archive file */
async function view(db: Queryable = pool) {
  const t = today();
  const ctx = await context(db, t);
  const lines = await loadLines(db);
  const calc = new Map<string, Calc>();
  for (const l of lines) calc.set(l.id, calcRow(l, ctx as CalcCtx));
  const arch = (l: Line) => isArchived(calc.get(l.id)!.stage, l.poDate);
  return { lines, calc, ctx, today: t, arch };
}
type View = Awaited<ReturnType<typeof view>>;

/** Code.gs compactRow_: one line → small object (GRN list, done lists, analytics) */
function compactRow(l: Line, c: Calc, im: Record<string, Item>) {
  const it = im[l.item.toLowerCase()] || ({} as Item);
  const steps = STEPS.map((s) => {
    const x = l.steps[s.id];
    return [ms(c.plans[s.id] || null), ms(x.act), x.st.toUpperCase(), c.delays[s.id], s.exType === "NEXT_DATE" ? ms(x.nx) : null, s.exType === "NEXT_DATE" ? "" : x.ex];
  });
  const got = c.gate[6] === "" ? 0 : num(c.gate[6]);
  return {
    id: l.id, po: l.po, ind: l.ind, it: l.item || l.code, code: l.code, q: num(l.qty), iq: qtyParse(l.iqty).q, u: l.unit, ve: l.vendor, party: l.party, by: l.by, urg: l.urg,
    at: ms(l.ts), pd: ms(l.poDate), ed: ms(l.edd), rate: num(l.rate), val: num(l.value) || r2(num(l.qty) * num(l.rate)), rc: c.rc, stage: c.stage, ge: c.gate[0], inv: c.gate[1],
    got, lead: num(l.lead) || (l.poDate && l.edd ? Math.max(0, diffDays(l.edd, l.poDate)) : ""), pdf: l.pdf, cat: it.c || "", brand: it.b || "", type: it.pt || "",
    itype: it.t || "", ph: it.ph || "", steps,
  };
}

/* ═════════════════════════════ LOGIN / BOOT ═════════════════════════════ */
async function getLoginList() {
  return (await loadDoers(pool)).map((d) => ({ name: d.name, role: d.admin ? "Admin" : "Step " + d.steps.join(", ") }));
}
async function getLoginBoot() {
  return { logo: logo("LOGO"), logo2: logo("RED4"), users: await getLoginList(), portal: CFG.PORTAL, publicIndent: CFG.PUBLIC_INDENT, version: CFG.VERSION };
}
async function login(c: Call, name: unknown, pass: unknown) {
  const nm = str(name);
  const [u] = await rows(pool, `SELECT id, ps_name, ps_access, ps_types, ps_email, password_hash, active, (locked_until IS NOT NULL AND locked_until > NOW(3)) AS locked
                                  FROM users WHERE ps_name = ?`, [nm]);
  if (!u || Number(u.active) !== 1) {
    await verifyDummy(String(pass ?? ""));
    await audit(c.req, { action: "ps.login", outcome: "denied", message: "unknown or switched-off user", username: nm.slice(0, 40) });
    throw new Error("Wrong name or password.");
  }
  if (Number(u.locked) === 1) {
    await verifyDummy(String(pass ?? ""));
    throw new Error("Wrong password 5 times. Try again after 10 minutes.");
  }
  if (!(await verifyPassword(String(pass ?? ""), u.password_hash))) {
    await exec(pool, "UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?", [u.id]);
    await exec(pool, "UPDATE users SET failed_logins = 0, locked_until = DATE_ADD(NOW(3), INTERVAL 10 MINUTE) WHERE id = ? AND failed_logins >= 5", [u.id]);
    await audit(c.req, { action: "ps.login", outcome: "denied", message: "wrong password", username: nm.slice(0, 40) });
    throw new Error("Wrong name or password.");
  }
  await exec(pool, "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(3) WHERE id = ?", [u.id]);
  const token = "S" + newToken();
  await exec(pool, "INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL ? HOUR), ?, ?)",
    [hashToken(token), u.id, config.SESSION_ABSOLUTE_HOURS, c.req.ip?.slice(0, 45) ?? null, (c.req.get("user-agent") ?? "").slice(0, 255)]);
  const d = doerOf(u);
  await audit(c.req, { action: "ps.login", outcome: "ok", username: nm.slice(0, 40) });
  return { token, name: d.name, steps: d.steps, admin: d.admin, email: d.email, canPo: d.admin || d.steps.includes(1), types: d.types };
}
async function logout(c: Call) {
  if (c.token) await exec(pool, "DELETE FROM sessions WHERE id = ?", [hashToken(c.token)]);
  return true;
}
async function indentLogin(pass: unknown) {
  const list = await indentHashes();
  if (indentFails.until > Date.now() && indentFails.n >= 10) throw new Error("Too many wrong passwords. Try again after 10 minutes.");
  if (list.length) {
    let ok = false;
    for (const h of list) if (await verifyPassword(str(pass), h)) ok = true;
    if (!ok) {
      indentFails = { n: (indentFails.until > Date.now() ? indentFails.n : 0) + 1, until: Date.now() + 600000 };
      throw new Error("Wrong indent password.");
    }
  }
  const t = "I" + randomUUID();
  indentTokens.set(t, Date.now() + 6 * 3600 * 1000);
  for (const [k, exp] of indentTokens) if (exp < Date.now()) indentTokens.delete(k);
  return t;
}
async function publicBoot() {
  const items = await loadItems(pool);
  return {
    logo: logo("LOGO"), logo2: logo("RED4"), items: indentItems(items), units: await units(items), urgency: CFG.URGENCY, filledBy: await filledBy(pool),
    vendors: (await loadVendors(pool, items)).filter((v) => !/inactive/i.test(v.status)).map((v) => v.n), portal: CFG.PORTAL, version: CFG.VERSION,
  };
}
async function getPublicBoot(itok: unknown) {
  // the old script let `true` skip the password; here only a valid indent token opens the form
  if (!(await indentOk(itok))) return { needPass: true, logo: logo("LOGO"), logo2: logo("RED4"), portal: CFG.PORTAL };
  return publicBoot();
}
async function getAppBoot(c: Call) {
  const s = await session(c);
  return {
    ...(await publicBoot()), user: s, steps: STEPS.map((x) => ({ id: x.id, label: x.label, opts: x.opts, req: x.req, exType: x.exType })),
    gst: CFG.GST_RATES, defGst: CFG.DEFAULT_GST, lead: CFG.DEFAULT_LEAD_DAYS, today: dayKey(new Date()), reqAppr: CFG.REQUIRE_APPROVAL, url: appUrl(c),
  };
}
const appUrl = (_c: Call) => config.APP_ORIGIN + "/ps";

/* ═════════════════════════════ ITEM PHOTO ═════════════════════════════ */
async function photoData(id: string, big: boolean): Promise<string> {
  if (!id) return "";
  try {
    if (isOurFile(id)) {
      const [f] = await rows(pool, "SELECT mime, bytes FROM ps_files WHERE id = ?", [id]);
      return f ? "data:" + f.mime + ";base64," + Buffer.from(f.bytes).toString("base64") : "";
    }
    // an old photo on Google Drive (shared "anyone with the link"): its thumbnail
    const r = await fetch("https://drive.google.com/thumbnail?id=" + encodeURIComponent(id) + "&sz=w" + (big ? 900 : 200), { signal: AbortSignal.timeout(15000) });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !/^image\//.test(ct)) return "";
    return "data:" + ct + ";base64," + Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch {
    return "";
  }
}
async function getItemPhoto(name: unknown, big: unknown) {
  const it = itemMap(await loadItems(pool))[str(name).toLowerCase()];
  return it && it.ph ? photoData(it.ph, !!big) : "";
}
async function savePhotoCore(db: Queryable, itemName: unknown, ph: { data?: string; mime?: string; name?: string } | null, by: string) {
  const it = itemMap(await loadItems(db))[str(itemName).toLowerCase()];
  if (!it) throw new Error('"' + str(itemName) + '" is not in Item Master.');
  const mime = str(ph && ph.mime).toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(mime)) throw new Error("The photo must be JPG / PNG.");
  const bytes = Buffer.from(String((ph && ph.data) || ""), "base64");
  if (!bytes.length || bytes.length > CFG.MAX_UPLOAD_MB * 1048576) throw new Error("The photo is empty or larger than " + CFG.MAX_UPLOAD_MB + " MB.");
  const id = await saveFile(db, "photo", it.n.replace(/[\\/:*?"<>|]/g, "_") + " - " + fmt(new Date(), "yyyyMMdd-HHmmss"), mime, bytes, by);
  const r = await exec(db, "UPDATE components SET ps_photo = ? WHERE name = ? AND ps_item_type <> ''", [id, it.n]);
  return { id, url: fileUrl(id), master: r.affectedRows + " row(s) of Item Master updated" };
}
async function setItemPhoto(c: Call, token: unknown, itemName: unknown, ph: { data?: string; mime?: string; name?: string }) {
  let by = "indent form";
  if (!isIndentToken(token)) by = (await session(c)).name;
  else if (!(await indentOk(token))) throw new Error("Please enter the indent password again.");
  const r = await savePhotoCore(pool, itemName, ph, by);
  return { id: r.id, message: "Photo updated (" + r.master + ")." };
}

/* ═════════════════════════════ INDENT ═════════════════════════════ */
async function nextIndentNo(db: Queryable) {
  let max = num(await setting(db, "lastInd"));
  for (const r of await rows(db, "SELECT indent_no AS v FROM ps_lines UNION ALL SELECT register_no FROM ps_lines WHERE register_no <> ''")) {
    const m = /IND\s*-?\s*(\d+)/i.exec(str(r.v));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
interface IndentLine {
  it: Item;
  qty: number;
  unit: string;
  vendor: string;
  rem: string;
  urg: string;
  photo?: { data?: string; mime?: string; name?: string } | null;
  child?: boolean;
  img?: string;
}
async function submitIndent(c: Call, token: unknown, p: { filledBy?: string; remarks?: string; lines?: Record<string, unknown>[] }) {
  let s: Sess | null = null;
  if (!isIndentToken(token)) s = await session(c);
  else if (!CFG.PUBLIC_INDENT) throw new Error("Please log in.");
  else if (!(await indentOk(token))) throw new Error("Please enter the indent password again (session expired).");
  if (!p || !Array.isArray(p.lines) || !p.lines.length) throw new Error("Add at least one item.");
  const fill = await filledBy(pool), byIn = str(p.filledBy) || (s ? s.name : "");
  const by = fill.find((x) => x.toLowerCase() === byIn.toLowerCase());
  if (!by) throw new Error('Choose a name from the "Filled by" list.');
  const items = await loadItems(pool);
  const rem = str(p.remarks).slice(0, 2000), ok: Record<string, Item> = {}, vendAll = (await loadVendors(pool, items)).map((v) => v.n), unitList = await units(items);
  items.filter((it) => !it.fg && !/inactive|discontinued|block/i.test(it.st) && it.o === "INDIAN").forEach((x) => (ok[x.n.toLowerCase()] = x));
  const canon = (val: unknown, list: string[], label: string) => {
    const m = list.find((x) => String(x).toLowerCase() === str(val).toLowerCase());
    if (!m) throw new Error(label + ' "' + str(val) + '" is not in the list.');
    return m;
  };
  const groups: IndentLine[][] = [];
  for (const l of p.lines) {
    const it = ok[str(l.item).toLowerCase()];
    if (!it) throw new Error('Item "' + str(l.item) + '" is not in the list (Indian origin items only). Choose it from the dropdown.');
    const qty = num(l.qty);
    if (!(qty > 0)) throw new Error(it.n + ": enter the quantity.");
    const urg = canon(l.urgency, CFG.URGENCY, "Urgency");
    const vIn = str(l.vendor) || "N/A";
    const photo = l.photo as IndentLine["photo"];
    let lines: IndentLine[];
    if (isDibbi(it.n)) {
      const k = it.set as Record<string, unknown> | undefined;
      if (!k || !k.ok || k.dibbi !== it.n) throw new Error(it.n + ": set link needs master review (" + (k ? k.reason : "link missing") + ").");
      if (!Number.isSafeInteger(qty)) throw new Error(it.n + ": enter whole dibbi pieces.");
      const vendor = canon(vIn, (k.vendors as string[]).concat(vendAll), "Vendor"), boxes = Math.ceil(qty / (k.capacity as number)), box = ok[String(k.box).toLowerCase()];
      if (!box) throw new Error(k.box + " is not in the item list.");
      const detail = "SET " + k.family + ": requested " + qty + " dibbi pcs; " + boxes + " boxes x " + k.capacity + " pcs. Dibbi + box only; peti excluded.";
      lines = [{ it, qty, unit: it.u || "PCS", vendor, rem: [rem, detail].filter(Boolean).join("\n"), urg, photo },
        { it: box, qty: boxes, unit: box.u || "PCS", vendor, rem: [rem, detail].filter(Boolean).join("\n"), urg, child: true }];
    } else if (isInnerPeti(it.n) && !(it.peti && it.peti.standalone)) {
      const k = it.peti as Record<string, unknown> | undefined;
      if (!k || !k.ok || k.inner !== it.n) throw new Error(it.n + ": peti link needs master review (" + (k ? k.reason : "link missing") + ").");
      if (!Number.isSafeInteger(qty)) throw new Error(it.n + ": enter whole inner peti units.");
      const vendor = canon(vIn, (k.vendors as string[]).concat(vendAll), "Vendor"), masters = Math.ceil(qty / (k.ratio as number)), mst = ok[String(k.master).toLowerCase()];
      if (!mst) throw new Error(k.master + " is not in the item list.");
      const detail = "PETI SET " + k.family + ": requested " + qty + " inner peti units (" + k.innerCapacity + " pcs capacity each); " + masters + " master peti units (" +
        k.masterCapacity + " pcs capacity each). " + k.ratio + " inner per master, rounded UP. Separate from dibbi + box.";
      lines = [{ it, qty, unit: it.u || "PCS", vendor, rem: [rem, detail].filter(Boolean).join("\n"), urg, photo },
        { it: mst, qty: masters, unit: mst.u || "PCS", vendor, rem: [rem, detail].filter(Boolean).join("\n"), urg, child: true }];
    } else {
      const vendor = vIn === "N/A" ? "N/A" : canon(vIn, it.v.map((x) => x[0]).concat(vendAll), "Vendor");
      const unit = canon(str(l.unit) || it.u || "PCS", unitList, "Unit");
      let q = qty;
      if (it.pkgs && it.pkgs.length) {
        const pk = it.pkgs.find((x) => x.label === str(l.pack)) || it.pkgs[0];
        q = roundUpPack(qty, pk.kg);
      }
      lines = [{
        it, qty: q, unit, vendor, urg, photo, rem: [rem,
          isInnerPeti(it.n) && it.peti && it.peti.standalone ? "Standalone peti: entered quantity is peti units. No master peti defined; no automatic master line." : "",
          !it.v.length ? (vendor === "N/A" ? "MASTER CLEANUP: supplier not linked or selected." : "MASTER CLEANUP: supplier selected manually from Vendor Master: " + vendor + ".") : "",
        ].filter(Boolean).join("\n"),
      }];
    }
    groups.push(lines);
  }
  const all = groups.flat(), seen: Record<string, 1> = {};
  all.forEach((l) => {
    const k = l.it.n.toLowerCase();
    if (seen[k]) throw new Error(l.it.n + " is added twice. Remove the duplicate item / set.");
    seen[k] = 1;
  });
  const res = await withLock(async (db) => {
    for (const g of groups) {
      const main = g[0];
      if (main.photo && main.photo.data) main.it.ph = (await savePhotoCore(db, main.it.n, main.photo, by)).id;
      main.img = fileUrl(main.it.ph);
      if (CFG.PHOTO_REQUIRED && !main.img) throw new Error(main.it.n + ": no photo in Item Master. Uploading a photo is required.");
      g.slice(1).forEach((ch) => (ch.img = fileUrl(ch.it.ph) || main.img));
    }
    const ind = CFG.IND_PREFIX + (await nextIndentNo(db));
    const now = new Date(), submitted = (s && s.email) || by;
    const ids: string[] = [];
    for (const l of all) {
      const id = lineId();
      ids.push(id);
      await exec(db, "INSERT INTO ps_lines SET ?", [{
        line_id: id, ts: now, indent_no: ind, item: l.it.n, party: l.vendor, urgency: l.urg, filled_by: by, remark: l.rem, indent_qty: String(l.qty), unit: l.unit,
        in_register: 1, origin: l.it.o || "INDIAN", image_url: l.img, submitted_by: submitted, email_status: "Email Pending", category: l.it.c, item_type: l.it.t, sku: l.it.s, brand: l.it.b,
      }]);
    }
    await setSetting(db, "lastInd", ind.replace(CFG.IND_PREFIX, ""));
    return { ind, ids, submitted };
  });
  // emails never block the indent
  const td = (x: unknown) => '<td style="padding:8px;border:1px solid #ddd">' + x + "</td>";
  const tbl = all.map((l, i) => "<tr>" + td(i + 1) + td("<b>" + esc(l.it.n) + "</b><br><small>" + esc(l.rem).replace(/\n/g, "<br>") + "</small>") + td(esc(l.it.t || "-")) +
    td(esc(l.it.c || "-")) + td(esc(l.vendor)) + td(esc(l.qty) + " " + esc(l.unit)) + td(esc(l.urg)) + td(l.img ? '<a href="' + esc(absUrl(c, l.img)) + '">Photo</a>' : "") + "</tr>").join("");
  const head = ["#", "Item Name", "Type", "Category", "Vendor", "Qty", "Urgency", "Photo"].map((h) => '<th style="padding:10px;border:1px solid #ddd;text-align:left">' + h + "</th>").join("");
  const html = '<div style="font-family:Arial"><h2 style="color:#3b1670">New PO Demand Request – ' + esc(res.ind) + "</h2><p><b>Filled By:</b> " + esc(by) + "<br><b>Submitted By:</b> " +
    esc(res.submitted) + "<br><b>Remarks:</b> " + esc(rem || "No remarks") + '</p><table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="background:#f2f7ff;color:#3b1670">' +
    head + "</tr>" + tbl + "</table><p>Purchase System ▸ Purchase Order ▸ Make PO.</p></div>";
  let mail = "Email Sent";
  if (CFG.NOTIFY_ON_INDENT) {
    try {
      await sendMail({ to: CFG.PURCHASE_EMAIL, subject: "PO Demand - " + res.ind + " - " + all.length + " Item(s)", html, fromName: CFG.PORTAL });
    } catch {
      mail = "Email Failed";
    }
  }
  await exec(pool, "UPDATE ps_lines SET email_status = ? WHERE line_id IN (?)", [mail, res.ids]);
  return { ok: true, requestId: res.ind, ids: [res.ind], lines: all.length, message: "Indent " + res.ind + " saved (" + all.length + " item" + (all.length === 1 ? "" : "s") + ")." };
}
const absUrl = (_c: Call, u: string) => (u.startsWith("/") ? config.APP_ORIGIN + u : u);

async function checkRepeat(name: unknown) {
  const k = key(name);
  if (!k) return [];
  const v = await view();
  const cut = new Date(Date.now() - CFG.REPEAT_DAYS * 864e5), out = [];
  for (let i = v.lines.length - 1; i >= 0 && out.length < 5; i--) {
    const r = v.lines[i];
    if (key(r.item) !== k || v.arch(r)) continue;
    if (!r.ts || r.ts < cut) continue;
    out.push({ ind: r.ind, d: fmt(r.ts), q: r.iqty, po: r.po, st: v.calc.get(r.id)!.stage });
  }
  return out;
}

function indentRow(l: Line, c: Calc, t: Date, im: Record<string, Item>) {
  const it = im[l.item.toLowerCase()] || ({} as Item);
  return {
    id: l.id, row: l.seq, ind: l.ind, at: ms(l.ts), age: l.ts ? Math.max(0, diffDays(t, l.ts)) : "", it: l.item, party: l.party, urg: l.urg, by: l.by, rem: l.rem,
    q: qtyParse(l.iqty).q || l.iqty, u: l.unit, po: l.po, pd: ms(l.poDate), ve: l.vendor, stage: c.stage, rc: c.rc, n: Number((l.ind.match(/\d+/) || [0])[0]),
    ph: it.ph || "", cat: it.c || "", type: it.t || "", brand: it.b || "", sku: it.s || "",
    hint: /^POSSIBLE PO/.test(l.note) ? l.note.replace(/^POSSIBLE PO: /, "").replace(/ \(.*$/, "") : "",
  };
}
const openIndentLine = (l: Line, c: Calc, v: View) =>
  /IND\d+/i.test(l.ind) && !ARCHIVE_STAGES.includes(c.stage) && !v.arch(l) && !(!l.po && /^(CANCELLED|CLOSED)$/i.test(l.override));
async function getIndents(c: Call, token: unknown) {
  let sess: Sess | null = null;
  if (!isIndentToken(token)) sess = await session(c);
  else if (!(await indentOk(token))) throw new Error("Please enter the indent password again.");
  const v = await view(), im = itemMap(await loadItems(pool)), keys = await doerTypeKeys(), out = [];
  for (const l of v.lines) {
    const cc = v.calc.get(l.id)!;
    if (!openIndentLine(l, cc, v)) continue;
    if (sess && !allowedItem(sess, l.item || l.code, im, keys)) continue;
    out.push(indentRow(l, cc, v.today, im));
  }
  out.sort((a, b) => a.n - b.n || a.row - b.row);
  return { list: out };
}
async function getIndentVisibility(c: Call) {
  const sess = await session(c);
  const v = await view(), im = itemMap(await loadItems(pool)), keys = await doerTypeKeys(), out = [];
  for (const l of v.lines) {
    const cc = v.calc.get(l.id)!;
    if (!openIndentLine(l, cc, v)) continue;
    out.push({ canAct: sess.canPo && !!l.id && allowedItem(sess, l.item || l.code, im, keys), ...indentRow(l, cc, v.today, im) });
  }
  out.sort((a, b) => a.n - b.n || a.row - b.row);
  return { list: out };
}
async function closeIndents(c: Call, ids: unknown, mode: unknown, reason: unknown) {
  const s = await session(c);
  needPo(s);
  const why = str(reason).slice(0, 300);
  if (!why) throw new Error("Please write the reason.");
  const im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  return withLock(async (db) => {
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      const [l] = await loadLines(db, "WHERE l.line_id = ?", [str(id)]);
      if (!l || l.po || !allowedItem(s, l.item || l.code, im, keys)) continue;
      await exec(db, "UPDATE ps_lines SET override = ?, note = ? WHERE line_id = ?", [mode === "OUTSIDE" ? "CLOSED" : "CANCELLED",
        (mode === "OUTSIDE" ? "PO MADE OUTSIDE: " : "INDENT CANCELLED: ") + why + " · " + s.name + " · " + fmt(new Date(), "dd/MM/yyyy HH:mm"), l.id]);
      n++;
    }
    return { message: n + " indent(s) closed. They will move to the archive." };
  });
}

/* ═════════════════════════════ MAKE PO ═════════════════════════════ */
function poHistory(poRows: Awaited<ReturnType<typeof context>>["poRows"]) {
  const out: Record<string, { h: string; g: number | "" }> = {};
  for (const r of poRows) {
    const k = key(r.item_name);
    if (!k) continue;
    const x = (out[k] ??= { h: "", g: "" });
    const h = str(r.hsn);
    if (h && h !== "-" && !/^#/.test(h)) x.h = h;
    const g = str(r.gst) === "" ? NaN : num(str(r.gst).replace("%", ""));
    if (g > 0 && CFG.GST_RATES.includes(g)) x.g = g;
  }
  return out;
}
const hsnFor = (it: Item | null, hist: ReturnType<typeof poHistory>) => (it && it.hs) || (hist[key(it && it.n)] || { h: "" }).h || "";
const gstFor = (it: Item | null, hist: ReturnType<typeof poHistory>) => {
  const h = hist[key(it && it.n)] || { g: "" };
  return it && it.gs !== "" && it.gs !== undefined ? it.gs : h.g !== "" && h.g !== undefined ? h.g : CFG.DEFAULT_GST;
};
async function nextPoNo(db: Queryable) {
  let max = num(await setting(db, "lastPo"));
  const re = new RegExp(CFG.PO_SERIES + "(\\d+)", "i");
  for (const r of await rows(db, "SELECT po_no FROM ps_pos")) {
    const m = re.exec(normPo(r.po_no));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
async function getPoMakerData(c: Call, ids: unknown) {
  const s = await session(c);
  needPo(s);
  const v = await view(), items = await loadItems(pool), im = itemMap(items), keys = await doerTypeKeys(), hist = poHistory(v.ctx.poRows);
  const lines: Record<string, unknown>[] = [], skipped: string[] = [];
  const byId = new Map(v.lines.map((l) => [l.id, l]));
  for (const id of Array.isArray(ids) ? ids : []) {
    const r = byId.get(str(id));
    if (!r || v.arch(r)) {
      skipped.push("line not found");
      continue;
    }
    if (r.po) {
      skipped.push(r.ind + " (PO " + r.po + ")");
      continue;
    }
    if (!/IND\d+/i.test(r.ind)) {
      skipped.push(r.ind || "row " + r.seq);
      continue;
    }
    if (!allowedItem(s, r.item || r.code, im, keys)) {
      skipped.push(r.ind + " (other item type)");
      continue;
    }
    const it = findItem(im, r.item), qp = qtyParse(r.iqty);
    lines.push({ lid: r.id, ind: r.ind, it: r.item, sku: it ? it.s : "", hsn: hsnFor(it, hist), qty: qp.q, qtyText: r.iqty, unit: r.unit || qp.u || (it ? it.u : "") || "PCS",
      gst: gstFor(it, hist), party: r.party, vend: it ? it.v.map((x) => [x[0], x[1], x[2]]) : [], ph: it ? it.ph : "" });
  }
  if (Array.isArray(ids) && ids.length && !lines.length) throw new Error('The selected indents already have a PO or are closed. Please refresh "Open indents".');
  const vlist = await loadVendors(pool, items);
  let sug: Vendor | null = null;
  lines.some((l) => {
    const x = l.party && l.party !== "N/A" ? vendorFind(vlist, l.party) : null;
    if (x) sug = x;
    return !!x;
  });
  const first = lines[0] as { vend: [string][] } | undefined;
  if (!sug && first && first.vend.length) sug = vendorFind(vlist, first.vend[0][0]) || blankVendor(first.vend[0][0]);
  const sv = sug as Vendor | null;
  return {
    lines, skipped, vendor: sv ? sv.n : "", vendorCode: sv ? sv.code : "", vendors: vlist, nextPo: CFG.PO_SERIES + (await nextPoNo(pool)),
    entities: { HR: CFG.ENTITIES.HR, DL: CFG.ENTITIES.DL }, ecom: CFG.ECOM_REGEX.source,
    items: items.filter((x) => !x.fg).map((x) => ({ n: x.n, s: x.s, u: x.u, hs: hsnFor(x, hist), gs: gstFor(x, hist), ph: x.ph || "", v: x.v.map((y) => [y[0], y[1], y[2]]) })),
  };
}

interface PoIn {
  vendor?: string;
  vendorCode?: string;
  poDate?: string;
  edd?: string;
  terms?: string;
  remarks?: string;
  allowInactive?: boolean;
  lines?: Record<string, unknown>[];
}
async function createPo(c: Call, p: PoIn) {
  const s = await session(c);
  needPo(s);
  if (!p) throw new Error("PO details missing.");
  if (!str(p.vendor) && !str(p.vendorCode)) throw new Error("Select a vendor.");
  const items = await loadItems(pool), im = itemMap(items), keys = await doerTypeKeys();
  const vlist = await loadVendors(pool, items);
  const vendor = vendorFind(vlist, p.vendor, p.vendorCode) || blankVendor(p.vendor);
  if (!vendor.n) throw new Error("Select a vendor.");
  if (CFG.BLOCK_INACTIVE_VENDOR && /inactive/i.test(vendor.status) && p.allowInactive !== true) throw new Error("INACTIVE_VENDOR: " + vendor.n + " is Inactive in Vendor Master.");
  const ent = entityOf((p.lines || []).map((l) => ({ name: str(l.it) })), true);
  (p.lines || []).forEach((l) => {
    if (str(l.it) && !allowedItem(s, l.it, im, keys)) throw new Error(str(l.it) + ": this item type is not yours (" + typesTxt(s) + " only).");
  });
  const terms = str(p.terms) || vendor.terms, tType = taxType(vendor, ent);
  const pd = isoToDate(p.poDate, "PO date"), edd = isoToDate(p.edd, "Delivery date");
  if (edd < pd) throw new Error("Delivery date cannot be before the PO date.");
  const lead = diffDays(edd, pd);
  const lines = (p.lines || []).map((l, i) => {
    const qty = num(l.qty), rate = num(l.rate), gst = num(l.gst);
    if (!str(l.it)) throw new Error("Line " + (i + 1) + ": enter the item.");
    if (!(qty > 0)) throw new Error("Line " + (i + 1) + ": enter the quantity.");
    if (!(rate > 0)) throw new Error("Line " + (i + 1) + ": enter the rate.");
    if (!CFG.GST_RATES.includes(gst)) throw new Error("Line " + (i + 1) + ": select the GST %.");
    const amount = r2(qty * rate), gstAmt = r2((amount * gst) / 100), tx = taxSplit(gstAmt, tType);
    return { lid: str(l.lid), ind: str(l.ind), it: str(l.it), sku: str(l.sku), vitem: str(l.vitem), hsn: str(l.hsn), qty, unit: str(l.unit).toUpperCase() || "PCS", rate, gst, amount,
      gstAmt, cgst: tx.cgst, sgst: tx.sgst, igst: tx.igst, total: r2(amount + gstAmt), id: "" };
  });
  if (!lines.length) throw new Error("Add at least one line.");
  const po = await withLock(async (db) => {
    const no = CFG.PO_SERIES + (await nextPoNo(db)), now = new Date();
    for (const l of lines) {
      if (!l.lid) continue;
      const [r] = await rows(db, "SELECT po_no FROM ps_lines WHERE line_id = ? FOR UPDATE", [l.lid]);
      if (!r) throw new Error(l.ind + " not found in the FMS. Please refresh.");
      if (str(r.po_no)) throw new Error(l.ind + " already has a PO (" + str(r.po_no) + ").");
    }
    const appr = CFG.REQUIRE_APPROVAL ? "PENDING" : "APPROVED";
    await exec(db, "INSERT INTO ps_pos SET ?", [{
      po_no: no, po_date: pd, edd, company: ent.poCompany, vendor: vendor.n, vendor_code: vendor.code, tax_type: tType, lead_days: String(lead), doer: s.name,
      remarks: [terms ? "Terms: " + terms : "", str(p.remarks)].filter(Boolean).join(" | ").slice(0, 1000), approval: appr,
      approved_by: CFG.REQUIRE_APPROVAL ? "" : s.name, approved_at: CFG.REQUIRE_APPROVAL ? null : now,
    }]);
    for (const l of lines) {
      l.id = l.lid || lineId();
      if (l.lid) {
        await exec(db, "UPDATE ps_lines SET po_no = ?, unit = IF(unit = '', ?, unit) WHERE line_id = ?", [no, l.unit, l.lid]);
      } else {
        await exec(db, "INSERT INTO ps_lines (line_id, ts, indent_no, item, indent_qty, filled_by, po_no, unit) VALUES (?, ?, 'PO only - no indent', ?, ?, ?, ?, ?)",
          [l.id, now, l.it, String(l.qty), s.name, no, l.unit]);
      }
      await exec(db, "INSERT INTO ps_po_lines SET ?", [{
        po_no: no, line_id: l.id, item_code: l.sku || l.it, item_name: l.it, vendor_item: l.vitem, hsn: l.hsn || "-", qty: l.qty, unit: l.unit, rate: l.rate, gst: String(l.gst),
        gst_amt: l.gstAmt, cgst: l.cgst, sgst: l.sgst, igst: l.igst, amount: l.amount, total: l.total, indent_no: l.ind,
      }]);
    }
    await setSetting(db, "lastPo", no.replace(CFG.PO_SERIES, ""));
    // vendor's own item name typed here → the Item Master row of this item + vendor
    for (const l of lines) {
      const it = im[l.it.toLowerCase()];
      if (!l.vitem || !it) continue;
      const vx = it.v.find((x) => key(x[0]) === key(vendor.n));
      if (vx && str(vx[2]) !== l.vitem) {
        await exec(db, `UPDATE supplier_rates r JOIN suppliers sp ON sp.id = r.supplier_id SET r.vendor_item_name = ? WHERE r.component_code = ? AND sp.name = ? AND r.ps_row IS NOT NULL`,
          [l.vitem.slice(0, 300), it.s, vx[0]]);
      }
    }
    return no;
  });
  let url = "";
  try {
    url = await makePoPdf(pool, po);
  } catch (e) {
    console.warn("PO PDF: " + (e as Error).message);
  }
  if (CFG.REQUIRE_APPROVAL) {
    try {
      const to = (await loadDoers(pool)).filter((d) => d.admin && d.email).map((d) => d.email).join(",") || CFG.DIRECTOR_EMAIL;
      await sendMail({ to, subject: "PO " + po + " approval pending – " + vendor.n, fromName: CFG.PORTAL,
        html: '<div style="font-family:Arial"><p>' + esc(s.name) + " made PO <b>" + esc(po) + "</b> for " + esc(vendor.n) + " (" + lines.length + " lines, Rs " +
          money(lines.reduce((a, l) => a + l.total, 0)) + ").</p>" + (url ? '<p><a href="' + esc(absUrl(c, url)) + '">Open PO PDF</a></p>' : "") + "<p>Purchase System ▸ PO register ▸ Approve.</p></div>" });
    } catch (e) {
      console.warn("approval mail: " + (e as Error).message);
    }
  }
  return { po, pdf: url, lead, message: "PO " + po + " created (" + lines.length + " line" + (lines.length === 1 ? "" : "s") + ", lead time " + lead + " days)." +
    (CFG.REQUIRE_APPROVAL ? " Send it to the vendor after admin approval." : "") };
}

/* ═════════════════════════════ PO PDF ═════════════════════════════ */
async function makePoPdf(db: Queryable, po: string): Promise<string> {
  const ctx = await context(db, today());
  const rec = ctx.po.by[normPo(po)];
  if (!rec) throw new Error("PO " + po + " not found in the PO sheet.");
  const reqBy: string[] = [];
  for (const r of await loadLines(db, "WHERE l.po_no = ?", [rec.po])) if (/IND/i.test(r.ind) && r.by && !reqBy.includes(r.by)) reqBy.push(r.by);
  rec.reqBy = reqBy.join(", ");
  const items = await loadItems(db), vlist = await loadVendors(db, items), guides = await rows(db, "SELECT type, spec FROM ps_guidelines ORDER BY id");
  const ver = num(await setting(db, "pdfv_" + normPo(po))) + 1;
  const bytes = await poPdf(rec, { vendor: vendorFind(vlist, rec.ve, rec.vcode) || blankVendor(rec.ve), im: itemMap(items), guides: guides as { type: string; spec: string }[], photo: photoData });
  const name = (rec.po + " - " + rec.ve).replace(/[\\/:*?"<>|]/g, "_").slice(0, 110) + (rec.appr === "APPROVED" ? "" : " - DRAFT") + (ver > 1 ? " v" + ver : "") + ".pdf";
  const id = await saveFile(db, "popdf", name, "application/pdf", bytes, "system");
  await setSetting(db, "pdfv_" + normPo(po), String(ver));
  const url = fileUrl(id);
  await exec(db, "UPDATE ps_pos SET pdf = ? WHERE po_no = ?", [url, rec.po]);
  return url;
}
async function poPdfFile(db: Queryable, po: string): Promise<{ name: string; bytes: Buffer } | null> {
  const rec = (await context(db, today())).po.by[normPo(po)];
  const m = rec && /\/api\/ps\/file\/(F[0-9a-f]{18})/.exec(rec.pdf);
  if (!m) return null;
  const [f] = await rows(db, "SELECT name, bytes FROM ps_files WHERE id = ?", [m[1]]);
  return f ? { name: str(f.name), bytes: Buffer.from(f.bytes) } : null;
}

/* ═════════════════════════════ PO REGISTER / APPROVAL / MAIL ═════════════════════════════ */
async function poList(s: Sess, withAct: boolean) {
  const v = await view(), im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  const fm: Record<string, { stages: Record<string, number>; mailed: Date | null; signed: string; rc: Record<string, number>; s1: boolean }> = {};
  for (const r of v.lines) {
    const k = normPo(r.po);
    if (!k || v.arch(r)) continue;
    const c = v.calc.get(r.id)!;
    const x = (fm[k] ??= { stages: {}, mailed: null, signed: "", rc: {}, s1: false });
    x.stages[c.stage] = (x.stages[c.stage] || 0) + 1;
    if (c.rc) x.rc[c.rc] = (x.rc[c.rc] || 0) + 1;
    if (r.mailedAt) x.mailed = r.mailedAt;
    if (r.signed) x.signed = r.signed;
    if (r.steps[1].act || r.steps[1].st.toUpperCase() === "DONE") x.s1 = true;
  }
  // the PO sheet kept only OPEN POs (the rest went to the archive): open = has an open line and is not cancelled
  const order = v.ctx.po.order.filter((k) => fm[k] && v.ctx.po.by[k].appr !== "CANCELLED");
  const out = order.filter((k) => withAct || allowedPo(s, v.ctx.po.by[k], im, keys)).map((k) => {
    const x = v.ctx.po.by[k], f = fm[k] || { stages: {}, rc: {}, mailed: null, signed: "", s1: false };
    const top = Object.keys(f.stages).sort((a, b) => f.stages[b] - f.stages[a])[0] || (x.appr === "CANCELLED" ? STAGE.cancelled : "");
    const ok = allowedPo(s, x, im, keys);
    return {
      ...(withAct ? { canExport: ok, canAct: s.canPo && ok } : {}),
      po: x.po, pd: ms(x.pd), ed: ms(x.ed), ve: x.ve, n: x.lines.filter((l) => l.name || l.code).length, value: r2(x.lines.reduce((a, l) => a + (l.total || l.amount), 0)),
      lead: x.lead !== "" ? x.lead : x.pd && x.ed ? diffDays(x.ed, x.pd) : "", appr: x.appr, by: x.by, pdf: x.pdf, doer: x.doer, stage: top, mailed: ms(f.mailed),
      signed: f.signed || "", s1: !!f.s1, rc: Object.keys(f.rc).join(", "), inFms: !!fm[k],
      lines: x.lines.filter((l) => l.name || l.code).map((l) => ({ it: l.name, c: l.code, q: l.qty, u: l.unit, ra: l.rate, g: l.gst, t: l.total, ind: l.ind, ph: (im[l.name.toLowerCase()] || ({} as Item)).ph || "" })),
    };
  });
  out.sort((a, b) => (b.pd || 0) - (a.pd || 0) || String(b.po).localeCompare(String(a.po)));
  return { list: out };
}
async function getPoVisibility(c: Call) {
  return poList(await session(c), true);
}
async function approvePo(c: Call, po: unknown) {
  const s = await session(c);
  needAdmin(s);
  await withLock(async (db) => {
    const rec = (await context(db, today())).po.by[normPo(po)];
    if (!rec) throw new Error("PO not found.");
    if (rec.appr === "CANCELLED") throw new Error("This PO is already cancelled.");
    await exec(db, "UPDATE ps_pos SET approval = 'APPROVED', approved_by = ?, approved_at = ? WHERE po_no = ?", [s.name, new Date(), rec.po]);
  });
  let url = "";
  try {
    url = await makePoPdf(pool, str(po));
  } catch (e) {
    console.warn("PDF: " + (e as Error).message);
  }
  await audit(c.req, { action: "ps.approvePo", outcome: "ok", message: str(po) });
  return { message: "PO " + str(po) + " approved. The Step 1 user can now mail it to the vendor.", pdf: url };
}
async function cancelPo(c: Call, po: unknown, reason: unknown) {
  const s = await session(c);
  needPo(s);
  const why = str(reason);
  if (!why) throw new Error("Please write the reason.");
  const im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  return withLock(async (db) => {
    const rec = (await context(db, today())).po.by[normPo(po)];
    if (!rec) throw new Error("PO not found.");
    if (!allowedPo(s, rec, im, keys)) throw new Error("This PO has items of another type (you work on " + typesTxt(s) + " only).");
    const lines = await loadLines(db, "WHERE l.po_no = ?", [rec.po]);
    const stamp = " · " + s.name + " · " + fmt(new Date(), "dd/MM/yyyy HH:mm");
    if (!s.admin && lines.some((r) => r.mailedAt)) throw new Error("The PO has already been sent to the vendor. Only the Admin can cancel it.");
    await exec(db, "UPDATE ps_pos SET approval = 'CANCELLED', remarks = ? WHERE po_no = ?", [("CANCELLED: " + why + stamp).slice(0, 1000), rec.po]);
    for (const r of lines) {
      if (/IND\d+/i.test(r.ind)) {
        // back to open indent: PO part, steps, gate, signed / mailed and lead cleared
        await exec(db, `UPDATE ps_lines SET signed_link = '', po_no = '', signed_at = NULL, signed_note = '', mailed_at = NULL, mailed_note = '', note = ? WHERE line_id = ?`,
          ["PO " + rec.po + " CANCELLED (" + why + ")" + stamp + " – indent open again", r.id]);
        await exec(db, "DELETE FROM ps_line_steps WHERE line_id = ?", [r.id]);
      } else {
        await exec(db, "UPDATE ps_lines SET override = 'CANCELLED', note = ? WHERE line_id = ?", ["PO CANCELLED: " + why + stamp, r.id]);
      }
    }
    return { message: "PO " + rec.po + " cancelled. Its indents are back in \"Open indents\"." };
  });
}
async function getMailDraft(c: Call, po: unknown) {
  const s = await session(c);
  needPo(s);
  const items = await loadItems(pool), im = itemMap(items), keys = await doerTypeKeys();
  const rec = (await context(pool, today())).po.by[normPo(po)];
  if (!rec) throw new Error("PO not found.");
  if (!allowedPo(s, rec, im, keys)) throw new Error("This PO has items of another type (you work on " + typesTxt(s) + " only).");
  if (rec.appr !== "APPROVED") throw new Error("PO " + str(po) + " is not approved yet.");
  const v = vendorFind(await loadVendors(pool, items), rec.ve, rec.vcode) || blankVendor(rec.ve);
  const total = rec.lines.reduce((a, l) => a + (l.total || l.amount), 0);
  return {
    po: rec.po, vendor: rec.ve, to: v.email || "", cc: CFG.DIRECTOR_EMAIL, pdf: rec.pdf,
    subject: "Purchase Order " + rec.po + " – " + CFG.COMPANY.name + " – " + fmt(rec.pd, "dd MMM yyyy"),
    message: "Dear " + (v.contact || "Sir / Madam") + ",\n\nPlease find attached our Purchase Order " + rec.po + " dated " + fmt(rec.pd, "dd MMM yyyy") + " (total Rs " + money(total) +
      " incl. GST).\nRequired delivery date: " + fmt(rec.ed, "dd MMM yyyy") + ".\n\nKindly confirm receipt of this PO and the dispatch date.",
  };
}
const parseEmails = (t: unknown) =>
  Array.from(new Set(String(t || "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(x))));
async function sendPoMail(c: Call, req: { po?: string; to?: string; cc?: string; subject?: string; message?: string }) {
  const s = await session(c);
  needPo(s);
  const d = await getMailDraft(c, req.po), to = parseEmails(req.to), cc = parseEmails(req.cc);
  if (!to.length) throw new Error("Enter the vendor email.");
  let file = await poPdfFile(pool, d.po);
  if (!file) {
    await makePoPdf(pool, d.po);
    file = await poPdfFile(pool, d.po);
  }
  if (!file) throw new Error("PO PDF not found.");
  const msg = str(req.message) || d.message;
  await sendMail({
    to: to.join(","), cc: cc.join(","), subject: str(req.subject) || d.subject, text: msg, replyTo: CFG.COMPANY.email, fromName: CFG.COMPANY.name + " – Purchase",
    html: '<div style="font-family:Arial;font-size:14px;white-space:pre-wrap">' + esc(msg) + '</div><p style="font-family:Arial;font-size:13px">Regards,<br><b>' + esc(s.name) +
      "</b><br>Purchase Department · " + esc(CFG.COMPANY.name) + "</p>",
    attachments: [{ filename: file.name, content: file.bytes }],
  });
  await withLock(async (db) => {
    const now = new Date();
    for (const r of await loadLines(db, "WHERE l.po_no = ?", [d.po])) {
      await exec(db, "UPDATE ps_lines SET mailed_at = ?, mailed_note = ? WHERE line_id = ?", [now, ("Mailed to " + to.join(", ") + " by " + s.name).slice(0, 500), r.id]);
      const x = r.steps[1];
      await exec(db, `INSERT INTO ps_line_steps (line_id, step, actual, status, remark) VALUES (?, 1, ?, 'DONE', ?)
                      ON DUPLICATE KEY UPDATE actual = IFNULL(actual, VALUES(actual)), status = IF(status = '', 'DONE', status), remark = IF(remark = '', VALUES(remark), remark)`,
        [r.id, x.act || now, ("PO mailed to " + to.join(", ")).slice(0, 1000)]);
    }
  });
  await audit(c.req, { action: "ps.sendPoMail", outcome: "ok", message: d.po + " → " + to.join(", ") });
  return { message: "PO " + d.po + " mailed to " + to.join(", ") + ". Step 1 DONE – Step 2 is open." };
}
async function uploadSigned(c: Call, req: { po?: string; data?: string; mime?: string }) {
  const s = await session(c);
  needPo(s);
  const po = str(req && req.po), mime = str(req && req.mime).toLowerCase();
  const im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  const rec = (await context(pool, today())).po.by[normPo(po)];
  if (rec && !allowedPo(s, rec, im, keys)) throw new Error("This PO has items of another type (you work on " + typesTxt(s) + " only).");
  if (!["application/pdf", "image/jpeg", "image/png"].includes(mime)) throw new Error("PDF / JPG / PNG only.");
  const bytes = Buffer.from(String((req && req.data) || ""), "base64");
  if (!bytes.length || bytes.length > CFG.MAX_UPLOAD_MB * 1048576) throw new Error("The file is empty or larger than " + CFG.MAX_UPLOAD_MB + " MB.");
  return withLock(async (db) => {
    const lines = await loadLines(db, "WHERE l.po_no = ?", [po]);
    if (!lines.length) throw new Error("PO " + po + " not found in the FMS.");
    const id = await saveFile(db, "signed", po + " - SIGNED - " + fmt(new Date(), "yyyyMMdd-HHmm"), mime, bytes, s.name);
    await exec(db, "UPDATE ps_lines SET signed_link = ?, signed_at = ?, signed_note = ? WHERE po_no = ?", [fileUrl(id), new Date(), "Uploaded by " + s.name, po]);
    return { message: "Signed copy saved for " + po + ".", url: fileUrl(id) };
  });
}
async function getTallyXml(c: Call, pos: unknown) {
  await session(c);
  const P0 = (await context(pool, today())).po, x = (s: unknown) => esc(s).replace(/&#39;/g, "&apos;");
  let body = "", comp = "";
  for (const k of (Array.isArray(pos) ? pos : []).map(normPo)) {
    const r = P0.by[k];
    if (!r || r.appr !== "APPROVED") continue;
    const cp = entityOf(r.lines, false).poCompany;
    if (comp && comp !== cp) throw new Error("Select POs of one company only (Haryana or Delhi) for one Tally file.");
    comp = cp;
    const dd = fmt(r.pd || new Date(), "yyyyMMdd");
    body += '<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Purchase Order" ACTION="Create" OBJVIEW="Invoice Voucher View"><DATE>' + dd + "</DATE><EFFECTIVEDATE>" + dd +
      "</EFFECTIVEDATE><VOUCHERTYPENAME>Purchase Order</VOUCHERTYPENAME><VOUCHERNUMBER>" + x(r.po) + "</VOUCHERNUMBER><REFERENCE>" + x(r.po) + "</REFERENCE><PARTYLEDGERNAME>" + x(r.ve) +
      "</PARTYLEDGERNAME><BASICBASEPARTYNAME>" + x(r.ve) + "</BASICBASEPARTYNAME><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISOPTIONAL>No</ISOPTIONAL>";
    r.lines.filter((l) => l.name).forEach((l) => {
      const q = l.qty + (l.unit ? " " + x(l.unit) : "");
      body += "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>" + x(l.name) + "</STOCKITEMNAME><ACTUALQTY>" + q + "</ACTUALQTY><BILLEDQTY>" + q + "</BILLEDQTY>" +
        (l.unit ? "<RATE>" + l.rate.toFixed(2) + "/" + x(l.unit) + "</RATE>" : "") + "<AMOUNT>" + (l.amount || l.qty * l.rate).toFixed(2) + "</AMOUNT></ALLINVENTORYENTRIES.LIST>";
    });
    body += "<NARRATION>" + x("PO " + r.po + " | Delivery " + fmt(r.ed) + " | Purchase System") + "</NARRATION></VOUCHER></TALLYMESSAGE>";
  }
  if (!body) throw new Error("None of the selected POs is approved.");
  return "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>" +
    x(comp) + "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>" + body + "</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>";
}

/* ═════════════════════════════ TASKS (Step 1-5) ═════════════════════════════ */
function taskList(v: View, steps: number[], s: Sess | null, im: Record<string, Item>, keys: Record<string, 1>) {
  const t = v.today, tomorrow = new Date(t.getTime() + 864e5), from = new Date(t.getTime() - 60 * 864e5), out = [];
  for (const r of v.lines) {
    if (!r.po) continue;
    const c = v.calc.get(r.id)!, stg = c.stage, arch = v.arch(r);
    if (stg === STAGE.cancelled || stg === STAGE.dup) continue;
    if (s && !allowedItem(s, r.item || r.code, im, keys)) continue;
    for (const id of steps) {
      const st = STEPS[id - 1], plan = c.plans[id] || null;
      if (!plan) continue;
      const x = r.steps[id], act = x.act, stt = x.st.toUpperCase();
      const nx = st.exType === "NEXT_DATE" ? x.nx : null, done = !!act || /^(DONE|NOT DONE|NOT RECEIVED|CANCELLED)$/.test(stt);
      let b: string;
      if (done) {
        if (!act || act < from) continue;
        b = "done";
      } else {
        if (arch) continue; // the archive keeps only done tasks
        const due = nx || plan;
        b = due < t ? "overdue" : due < tomorrow ? "today" : "upcoming";
      }
      out.push({
        id: r.id, row: arch ? 0 : r.seq, s: id, b, po: r.po, ind: r.ind, it: r.item || r.code, code: r.code, q: num(r.qty), u: r.unit, ve: r.vendor, pd: ms(r.poDate), ed: ms(r.edd),
        pl: ms(plan), ad: ms(act), nx: ms(nx), st: stt, ex: nx ? "" : x.ex, dl: c.delays[id], pdf: r.pdf, signed: arch ? "" : r.signed, rc: c.rc, stage: stg,
        gq: arch ? (c.gate[6] === "" ? 0 : num(c.gate[6])) : c.gate[6] === "" ? "" : String(c.gate[6]), lead: r.lead, ph: (im[r.item.toLowerCase()] || ({} as Item)).ph || "",
        ...(arch ? { arch: 1 } : {}),
      });
    }
  }
  out.sort((a, b) => ((a.nx || a.pl) as number) - ((b.nx || b.pl) as number));
  return out;
}
async function getTasks(c: Call) {
  const s = await session(c);
  return { list: taskList(await view(), s.steps, s, itemMap(await loadItems(pool)), await doerTypeKeys()) };
}
async function updateTasks(c: Call, req: { ids?: unknown[]; step?: unknown; status?: unknown; remark?: unknown; nextDate?: unknown; remarkOnly?: unknown }) {
  const s = await session(c), st = STEPS[Number(req && req.step) - 1];
  if (!st || !s.steps.includes(st.id)) throw new Error("This step is not assigned to you.");
  const remarkOnly = req.remarkOnly === true, status = remarkOnly ? "IN PROGRESS" : str(req.status).toUpperCase();
  if (!remarkOnly && !st.opts.includes(status)) throw new Error("Select a status.");
  const remark = str(req.remark).slice(0, 500);
  if ((remarkOnly || st.req.includes(status)) && !remark) throw new Error("A remark is required for this status.");
  let nx: Date | null = null;
  if (st.exType === "NEXT_DATE" && str(req.nextDate)) {
    nx = isoToDate(req.nextDate, "Next date");
    if (nx < today()) throw new Error("The next date must be today or later.");
    nx.setHours(10);
  }
  const ids = Array.from(new Set((Array.isArray(req.ids) ? req.ids : []).map(str).filter(Boolean)));
  if (!ids.length) throw new Error("No line selected.");
  const im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  const res = await withLock(async (db) => {
    const v = await view(db), now = new Date(), done: string[] = [], fail: string[] = [];
    const byId = new Map(v.lines.map((l) => [l.id, l]));
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) {
        fail.push(id + ": not found");
        continue;
      }
      if (!allowedItem(s, r.item || r.code, im, keys)) {
        fail.push(r.po + ": other item type");
        continue;
      }
      if (!v.calc.get(id)!.plans[st.id]) {
        fail.push(r.po + ": the task is not open yet");
        continue;
      }
      if (r.steps[st.id].act) {
        fail.push(r.po + ": already done");
        continue;
      }
      const x = r.steps[st.id];
      const hist = remark ? (x.history ? x.history + "\n" : "") + fmt(now, "dd/MM HH:mm") + " " + s.name + " – " + status + ": " + remark : x.history;
      await exec(db, `INSERT INTO ps_line_steps (line_id, step, actual, status, remark, next_date, history) VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON DUPLICATE KEY UPDATE actual = VALUES(actual), status = VALUES(status), remark = VALUES(remark), next_date = VALUES(next_date), history = VALUES(history)`,
        [id, st.id, remarkOnly ? x.act : now, status, nx ? x.ex : remark || x.ex, nx || x.nx, hist]);
      done.push(id);
    }
    return { done, fail };
  });
  if (!res.done.length) return { message: "Nothing updated. " + res.fail.join("; ") };
  return { message: res.done.length + " line(s) updated" + (remarkOnly ? " (remark saved, the task stays on this step)" : " – the next step is open") + "." +
    (res.fail.length ? " Not done: " + res.fail.join("; ") : "") };
}

/* ═════════════════════════════ HOME / GRN / ANALYTICS / PERFORMANCE ═════════════════════════════ */
async function getHome(c: Call) {
  const s = await session(c), v = await view(), im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  const stages: Record<string, number> = {};
  for (const r of v.lines) {
    if (v.arch(r)) continue;
    const st = v.calc.get(r.id)!.stage;
    if (st && allowedItem(s, r.item || r.code, im, keys)) stages[st] = (stages[st] || 0) + 1;
  }
  const tasks = taskList(v, s.steps, s, im, keys).filter((t) => !("arch" in t));
  const poPend = v.ctx.po.order.filter((k) => v.ctx.po.by[k].appr === "PENDING" && allowedPo(s, v.ctx.po.by[k], im, keys)).length;
  return {
    stages, poPending: poPend, overdue: tasks.filter((t) => t.b === "overdue").length, today: tasks.filter((t) => t.b === "today").length,
    due: tasks.filter((t) => t.b === "overdue" || t.b === "today").slice(0, 12), lastDerive: fmt(new Date(), "dd/MM/yyyy HH:mm") + " (live)",
    lastArchive: (await setting(pool, "lastArchive")) || "",
  };
}
async function getGrnList(c: Call) {
  const sess = await session(c), v = await view(), im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  const from = v.today.getTime() - 120 * 864e5, out = [];
  for (const r of v.lines) {
    const x = { ...compactRow(r, v.calc.get(r.id)!, im), arch: v.arch(r) ? 1 : 0 };
    if (!x.po || !allowedItem(sess, x.it, im, keys) || x.stage === STAGE.cancelled || x.stage === STAGE.dup || /CANCEL/.test(x.rc)) continue;
    const done = /^RECEIVED/.test(x.rc);
    if (!done && ![STAGE.follow, STAGE.part].includes(x.stage as never)) continue;
    if (done && x.arch && (x.pd || 0) < from) continue;
    out.push({ id: x.id, b: done ? "done" : "pending", po: x.po, ind: x.ind, it: x.it, code: x.code, q: x.q, u: x.u, ve: x.ve, pd: x.pd, ed: x.ed, got: x.got,
      bal: Math.max(0, r2(x.q - x.got)), rc: x.rc || "OPEN", ge: x.ge, inv: x.inv, stage: x.stage, ph: x.ph, arch: x.arch,
      late: !done && x.ed && x.ed < v.today.getTime() ? diffDays(v.today, new Date(x.ed)) : 0 });
  }
  return { list: out };
}
async function getAnalytics(c: Call) {
  const sess = await session(c), v = await view(), im = itemMap(await loadItems(pool)), keys = await doerTypeKeys();
  const all = v.lines.map((r) => ({ ...compactRow(r, v.calc.get(r.id)!, im), ...(v.arch(r) ? { arch: 1 } : {}) })).filter((x) => x.it || x.po)
    .map((x) => {
      const o: Record<string, unknown> = { ...x };
      delete o.pdf;
      delete o.ph;
      return o;
    });
  const res = { rows: all, at: fmt(new Date(), "dd/MM/yyyy HH:mm"), stepNames: STEPS.map((s) => s.label) };
  if (sess.admin || !sess.types.length) return res;
  return { ...res, rows: all.filter((x) => allowedItem(sess, x.it, im, keys)), scope: sess.types.join(", ") };
}
async function getPerformance(c: Call, from: unknown, to: unknown) {
  await session(c);
  const a = isoToDate(from, "From"), b = isoToDate(to, "To"), end = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 23, 59), v = await view(), t = v.today;
  const people = (await loadDoers(pool)).filter((d) => !d.admin).map((d) => ({ name: d.name, steps: d.steps, planned: 0, onTime: 0, late: 0, notDone: 0, lateDays: 0, score: null as number | null }));
  for (const r of v.lines) {
    const c2 = v.calc.get(r.id)!;
    if (!r.po || c2.stage === STAGE.cancelled) continue;
    for (const s of STEPS) {
      const plan = c2.plans[s.id] || null;
      if (!plan || plan < a || plan > end || day(plan)! > t) continue;
      const act = r.steps[s.id].act, late = act ? diffDays(act, plan) : diffDays(t, plan);
      const res = !act ? "notDone" : late > 0 ? "late" : "onTime";
      people.filter((p) => p.steps.includes(s.id)).forEach((p) => {
        p.planned++;
        p[res]++;
        if (res !== "onTime") p.lateDays += Math.max(0, late);
      });
    }
  }
  people.forEach((p) => (p.score = p.planned ? Math.round((p.onTime / p.planned) * 1000) / 10 : null));
  people.sort((x, y) => (y.score || -1) - (x.score || -1));
  return { people };
}

/* ═════════════════════════════ ADMIN / USERS ═════════════════════════════ */
async function adminRun(c: Call, what: unknown) {
  needAdmin(await session(c));
  if (what === "recalc" || what === "archive") return refresh();
  if (what === "cache") return "Cache cleared.";
  if (what === "dashboard") return "The dashboard is calculated live from the database.";
  throw new Error("Unknown action.");
}
async function getAdminInfo(c: Call) {
  needAdmin(await session(c));
  return { version: CFG.VERSION, lastDerive: fmt(new Date(), "dd/MM/yyyy HH:mm") + " (live)", lastArchive: (await setting(pool, "lastArchive")) || "never", archiveUrl: "",
    url: appUrl(c), triggers: ["autoRun (old indents with a PO closed, every 30 min)", "dailyDigest (09:00, not Sunday)"], sheet: "" };
}
async function getUsersAdmin(c: Call) {
  const s = await session(c);
  needDirector(s);
  const users = await rows(pool, "SELECT ps_name, ps_access, active FROM users WHERE ps_name IS NOT NULL ORDER BY id");
  const audits = await rows(pool, "SELECT at, username, action, message FROM audit_log WHERE action IN ('ps.userOn', 'ps.userOff', 'ps.password') ORDER BY id DESC LIMIT 40");
  return {
    users: users.map((r) => ({ name: str(r.ps_name), access: str(r.ps_access), active: Number(r.active) === 1, director: isDirectorName(r.ps_name), self: key(r.ps_name) === key(s.name) })),
    audit: audits.map((a) => ({ t: fmt(toDate(a.at), "dd-MM-yyyy HH:mm"), by: str(a.username), what: a.action === "ps.password" ? "password changed" : a.action === "ps.userOn" ? "switched on" : "switched off", target: str(a.message) })),
  };
}
async function setUserActive(c: Call, name: unknown, active: unknown) {
  const s = await session(c);
  needDirector(s);
  const [r] = await rows(pool, "SELECT id, ps_name FROM users WHERE ps_name = ?", [str(name)]);
  if (!r) throw new Error("User not found in the Doer sheet.");
  if (isDirectorName(r.ps_name)) throw new Error("Director logins cannot be switched off here.");
  await exec(pool, "UPDATE users SET active = ? WHERE id = ?", [active ? 1 : 0, r.id]);
  if (!active) await exec(pool, "DELETE FROM sessions WHERE user_id = ?", [r.id]);
  await audit(c.req, { action: active ? "ps.userOn" : "ps.userOff", outcome: "ok", message: str(r.ps_name) });
  return str(r.ps_name) + (active ? " is active." : " is switched off.");
}
async function setUserPassword(c: Call, name: unknown, pw: unknown) {
  const s = await session(c);
  needDirector(s);
  const [r] = await rows(pool, "SELECT id, ps_name FROM users WHERE ps_name = ?", [str(name)]);
  if (!r) throw new Error("User not found in the Doer sheet.");
  if (isDirectorName(r.ps_name) && key(r.ps_name) !== key(s.name)) throw new Error("A Director password can only be changed by that Director.");
  const p = String(pw === null || pw === undefined ? "" : pw);
  if (p.length < 8 || p.length > 64 || p !== p.trim()) throw new Error("Password must be 8 to 64 characters with no space at the start or end.");
  await exec(pool, "UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, password_changed_at = NOW(3) WHERE id = ?", [await hashPassword(p), r.id]);
  await exec(pool, "DELETE FROM sessions WHERE user_id = ? AND user_id <> ?", [r.id, s.id]);
  await audit(c.req, { action: "ps.password", outcome: "ok", message: str(r.ps_name) });
  return "Password changed for " + str(r.ps_name) + ".";
}

/* ═════════════════════════════ AUTO RUN ═════════════════════════════ */
/**
 * Code.gs closeIndentsWithPo_: old indents that already have a PO are closed ("PO ALREADY MADE"), or get a
 * "POSSIBLE PO" hint. Runs every 30 min (like autoRun) and from Admin ▸ Recalculate.
 */
export async function refresh(): Promise<string> {
  return withLock(async (db) => {
    const lines = await loadLines(db);
    const poRows = (await rows(db, "SELECT p.po_no, pl.item_name, pl.item_code, p.po_date, pl.qty, pl.indent_no, p.approval FROM ps_po_lines pl JOIN ps_pos p ON p.po_no = pl.po_no ORDER BY pl.id")).filter((r) => str(r.approval).toUpperCase() !== "CANCELLED");
    const same = (a: unknown, b: unknown) => {
      const x = key(a), y = key(b);
      return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))));
    };
    const poByInd: Record<string, { po: string; it: string }[]> = {};
    const poLines = poRows.map((r) => ({ po: str(r.po_no), it: key(r.item_name) || key(r.item_code), d: day(toDate(r.po_date)), q: num(r.qty), used: false }));
    poRows.forEach((r) => (str(r.indent_no).toUpperCase().match(/IND\s*-?\s*\d+/g) || []).forEach((x) => {
      const k = "IND" + Number(x.replace(/\D/g, ""));
      (poByInd[k] ??= []).push({ po: str(r.po_no), it: str(r.item_name) || str(r.item_code) });
    }));
    const sec = (d2: Date | null) => (d2 ? Math.round(d2.getTime() / 1000) : 0), indOf: Record<string, string> = {};
    for (const r of await rows(db, "SELECT ts, IF(register_no <> '', register_no, indent_no) AS indent_no, item FROM ps_lines WHERE in_register = 1")) {
      const t = sec(toDate(r.ts)), id = str(r.indent_no).toUpperCase();
      if (!t || !/^IND\d+$/.test(id)) continue;
      [t - 1, t, t + 1].forEach((x) => (indOf[x + "|" + key(r.item)] = id));
    }
    const stamp = fmt(new Date(), "dd/MM/yyyy HH:mm"), done = new Set<string>();
    let closed = 0;
    const close = async (l: Line, note: string) => {
      await exec(db, "UPDATE ps_lines SET override = 'CLOSED', note = ? WHERE line_id = ?", [note, l.id]);
      l.override = "CLOSED";
      l.note = note;
      done.add(l.id);
      closed++;
    };
    for (const l of lines) {
      const own = l.ind.toUpperCase();
      if (l.po || !/^IND\d+$/.test(own) || l.override) continue;
      const cands = [own, indOf[sec(l.ts) + "|" + key(l.item)]].filter(Boolean);
      let hit: { po: string; ind: string } | null = null;
      cands.some((c2) => (poByInd[c2] || []).some((x) => {
        if (same(x.it, l.item)) hit = { po: x.po, ind: c2 };
        return !!hit;
      }));
      if (hit) await close(l, "PO ALREADY MADE: " + (hit as { po: string }).po + " (indent " + (hit as { ind: string }).ind + " in PO, auto) · " + stamp);
    }
    const claimed: Record<string, 1> = {};
    lines.forEach((l) => {
      if (l.po) claimed[normPo(l.po) + "|" + key(l.code || l.item)] = 1;
      const m = /^PO ALREADY MADE: (\S+)/.exec(l.note);
      if (m) claimed[normPo(m[1]) + "|" + key(l.item)] = 1;
    });
    const seenL: Record<string, 1> = {};
    const free = poLines.filter((x) => {
      const k = normPo(x.po) + "|" + x.it;
      if (!x.it || !x.d || claimed[k] || seenL[k]) return false;
      seenL[k] = 1;
      return true;
    });
    for (const l of lines) {
      if (done.has(l.id) || l.po || !/^IND\d+$/i.test(l.ind) || l.override) continue;
      const t = day(l.ts), k = key(l.item), q = num(qtyParse(l.iqty).q || l.iqty);
      if (!t || !k) continue;
      const cand = free.filter((x) => !x.used && x.it === k && x.d! >= t && x.d!.getTime() - t.getTime() <= CFG.MATCH_DAYS * 864e5).sort((a, b) => a.d!.getTime() - b.d!.getTime());
      if (!cand.length) continue;
      const exact = cand.find((x) => q > 0 && x.q === q);
      if (exact) {
        exact.used = true;
        await close(l, "PO ALREADY MADE: " + exact.po + " (same item + qty, auto) · " + stamp);
        continue;
      }
      const hint = "POSSIBLE PO: " + Array.from(new Set(cand.map((x) => x.po))).slice(0, 3).join(", ") + " (same item, qty differs – check and close)";
      if ((!l.note || /^POSSIBLE PO/.test(l.note)) && l.note !== hint) await exec(db, "UPDATE ps_lines SET note = ? WHERE line_id = ?", [hint, l.id]);
    }
    const msg = fmt(new Date(), "dd/MM/yyyy HH:mm") + " – checked " + lines.length + " lines" + (closed ? ", " + closed + " old indents auto-closed (PO already made)" : "");
    await setSetting(db, "lastArchive", msg);
    return msg;
  }, 60);
}

/** 09:00 every day except Sunday: each non-admin doer with an email gets their overdue + today tasks */
export async function dailyDigest(origin: string): Promise<string> {
  if (new Date().getDay() === 0) return "Sunday";
  const v = await view(), im = itemMap(await loadItems(pool)), keys = await doerTypeKeys(), sent: string[] = [];
  for (const d of (await loadDoers(pool)).filter((x) => !x.admin && x.email)) {
    const sess: Sess = { ...d, canPo: d.steps.includes(1) };
    const t = taskList(v, d.steps, sess, im, keys).filter((x) => x.b === "overdue" || x.b === "today");
    if (!t.length) continue;
    const cellS = 'style="padding:5px;border:1px solid #ddd"';
    const rowsHtml = t.slice(0, 60).map((x) => `<tr><td ${cellS}>Step ${x.s}</td><td ${cellS}>${esc(x.po)}</td><td ${cellS}>${esc(x.ve)}</td><td ${cellS}>${esc(x.it)}</td><td ${cellS}>` +
      fmt(new Date((x.nx || x.pl) as number)) + `</td><td style="padding:5px;border:1px solid #ddd;color:${x.b === "overdue" ? "#a12a36" : "#7a5a00"}">${esc(x.dl)}</td></tr>`).join("");
    try {
      await sendMail({ to: d.email, subject: "Purchase tasks pending today – " + t.length, fromName: CFG.PORTAL,
        html: '<div style="font-family:Arial"><p>Hello ' + esc(d.name) + ', your pending tasks for today:</p><table style="border-collapse:collapse;font-size:13px">' + rowsHtml +
          '</table><p><a href="' + esc(origin + "/ps") + '">Open Purchase System</a></p></div>' });
      sent.push(d.name);
    } catch (e) {
      console.warn("digest " + d.name + ": " + (e as Error).message);
    }
  }
  return "Digest sent: " + (sent.join(", ") || "nobody");
}

/* ═════════════════════════════ dispatch ═════════════════════════════ */
type Fn = (c: Call, ...a: never[]) => Promise<unknown>;
/** name → [handler, number of arguments the page sends]; the first argument of token calls is the page's token */
export const FUNCTIONS: Record<string, Fn> = {
  getLoginBoot: () => getLoginBoot(),
  login: (c, name: unknown, pass: unknown) => login(c, name, pass),
  logout: (c) => logout(c),
  indentLogin: (_c, pass: unknown) => indentLogin(pass),
  getPublicBoot: (_c, itok: unknown) => getPublicBoot(itok),
  getAppBoot: (c) => getAppBoot(c),
  getHome: (c) => getHome(c),
  getIndents: (c, tok: unknown) => getIndents(c, tok),
  getIndentVisibility: (c) => getIndentVisibility(c),
  checkRepeat: (_c, name: unknown) => checkRepeat(name),
  submitIndent: (c, tok: unknown, p: never) => submitIndent(c, tok, p),
  closeIndents: (c, _t: unknown, ids: unknown, mode: unknown, reason: unknown) => closeIndents(c, ids, mode, reason),
  getPoMakerData: (c, _t: unknown, ids: unknown) => getPoMakerData(c, ids),
  createPo: (c, _t: unknown, p: never) => createPo(c, p),
  getPoVisibility: (c) => getPoVisibility(c),
  approvePo: (c, _t: unknown, po: unknown) => approvePo(c, po),
  cancelPo: (c, _t: unknown, po: unknown, reason: unknown) => cancelPo(c, po, reason),
  getMailDraft: (c, _t: unknown, po: unknown) => getMailDraft(c, po),
  sendPoMail: (c, _t: unknown, req: never) => sendPoMail(c, req),
  uploadSigned: (c, _t: unknown, req: never) => uploadSigned(c, req),
  getTallyXml: (c, _t: unknown, pos: unknown) => getTallyXml(c, pos),
  getTasks: (c) => getTasks(c),
  updateTasks: (c, _t: unknown, req: never) => updateTasks(c, req),
  getGrnList: (c) => getGrnList(c),
  getAnalytics: (c) => getAnalytics(c),
  getPerformance: (c, _t: unknown, from: unknown, to: unknown) => getPerformance(c, from, to),
  getAdminInfo: (c) => getAdminInfo(c),
  adminRun: (c, _t: unknown, what: unknown) => adminRun(c, what),
  getUsersAdmin: (c) => getUsersAdmin(c),
  setUserActive: (c, _t: unknown, name: unknown, active: unknown) => setUserActive(c, name, active),
  setUserPassword: (c, _t: unknown, name: unknown, pw: unknown) => setUserPassword(c, name, pw),
  getItemPhoto: (_c, name: unknown, big: unknown) => getItemPhoto(name, big),
  setItemPhoto: (c, tok: unknown, name: unknown, ph: never) => setItemPhoto(c, tok, name, ph),
};
