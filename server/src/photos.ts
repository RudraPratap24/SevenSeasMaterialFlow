/**
 * Item photos (components.ps_photo / products.ps_photo) hold a file id: a Google Drive file id (old photos, shown from
 * Drive — the file must be shared "anyone with the link") or our own stored file "F…" (uploaded on the page).
 */

/** the file id in a Drive link, a bare Drive id or one of our file ids; "" for empty; null when it is none of these */
export function photoId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^F[0-9a-f]{18}$/.test(s)) return s;
  const m = /\/d\/([-\w]{20,})/.exec(s) || /[?&]id=([-\w]{20,})/.exec(s) || /^([-\w]{20,})$/.exec(s);
  return m ? m[1] : null;
}
