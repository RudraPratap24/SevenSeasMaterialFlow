import "dotenv/config";
import { z } from "zod";

/**
 * Environment configuration, validated once at startup. The process refuses to
 * start with a missing or weak secret rather than run insecurely.
 */
const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** The exact origin the browser uses, e.g. https://flow.sevenseas.in — used for the CSRF origin check. */
  APP_ORIGIN: z.string().url(),
  /** Number of reverse proxies in front (Caddy/Nginx = 1). Needed for correct client IPs and secure cookies. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  TZ: z.string().default("Asia/Kolkata"),

  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "DB_NAME may contain letters, digits and _ only"),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_SSL: bool.default(false),

  /** 32 random bytes, base64 — encrypts sensitive fields at rest (AES-256-GCM). */
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
    message: "DATA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (run: npm run env:init)",
  }),

  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(12),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),

  /** TallyPrime's HTTP port (read only), for "npm run tally -- fetch". */
  TALLY_URL: z.string().url().default("http://localhost:9000"),
  /** The company to read in Tally; empty = the company open in Tally. */
  TALLY_COMPANY: z.string().default(""),
  /** Lets `npm run tally -- push` create POs in Tally. Off unless set — a test copy of Tally only, until Accounts agrees. */
  TALLY_ALLOW_WRITE: bool.default(false),
  /** Test copies only: TallyPrime's Educational mode takes vouchers dated the 1st or 2nd — e.g. 20261001. */
  TALLY_TEST_DATE: z.string().regex(/^(\d{8})?$/, "must be yyyymmdd").default(""),
  /** How often `npm run tally -- watch` syncs, in seconds. */
  TALLY_SYNC_SECONDS: z.coerce.number().int().min(10).max(3600).default(30),
  /** Names of the client's Purchase Order voucher types in Tally (comma-separated). */
  TALLY_PO_VOUCHER_TYPES: z
    .string()
    .default("Purchase Order")
    .transform((v) => v.split(",").map((t) => t.trim()).filter(Boolean)),

  /** Admin-only "Load demo data" / "Clear all" — keep false on the live system. */
  ALLOW_DEMO_RESET: bool.default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:");
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === "production";

if (isProd) {
  const problems: string[] = [];
  if (!config.APP_ORIGIN.startsWith("https://")) problems.push("APP_ORIGIN must be https:// in production");
  if (config.DB_USER === "root") problems.push("DB_USER must not be root in production — use the app account");
  if (config.DB_PASSWORD.length < 16) problems.push("DB_PASSWORD must be at least 16 characters in production");
  if (problems.length) {
    console.error("Refusing to start:\n  " + problems.join("\n  "));
    process.exit(1);
  }
}

// Every date and time the registers stamp is factory-local time.
process.env.TZ = config.TZ;
