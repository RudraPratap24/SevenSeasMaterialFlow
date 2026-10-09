import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config";

/* ── field encryption at rest: AES-256-GCM ──────────────────────────────────── */

const KEY = Buffer.from(config.DATA_ENCRYPTION_KEY, "base64");
const PREFIX = "enc:v1:";

/** Encrypts any JSON-serialisable value to an opaque string. Authenticated: tampering is detected. */
export function encryptValue(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptValue<T = unknown>(blob: string): T {
  if (!blob.startsWith(PREFIX)) throw new Error("Not an encrypted value");
  const [ivB64, tagB64, ctB64] = blob.slice(PREFIX.length).split(":");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

export function isEncrypted(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PREFIX);
}

/**
 * Blind index: a keyed hash of a normalised value, so an encrypted column (e.g. a
 * customer name) can be matched and kept unique without being decrypted. Uses its
 * own key derived from the master key, so it reveals nothing about the ciphertext.
 */
const INDEX_KEY = Buffer.from(hkdfSync("sha256", KEY, Buffer.alloc(0), "flow/blind-index/v1", 32));

export function normaliseName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function blindIndex(value: string): string {
  return createHmac("sha256", INDEX_KEY).update(normaliseName(value)).digest("hex");
}

/* ── tokens ─────────────────────────────────────────────────────────────────── */

/** A 256-bit random token, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Session tokens are stored only as their SHA-256 — a database leak does not leak live sessions. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ── passwords: scrypt (memory-hard), per-password salt ─────────────────────── */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Burns the same time as a real check — so unknown usernames cannot be told apart by timing. */
let dummyHash: Promise<string> | null = null;
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, await dummyHash);
}

/** A readable random password: 4 groups of 4 from an unambiguous alphabet (~80 bits). */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += alphabet[randomInt(alphabet.length)]; // unbiased
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}
