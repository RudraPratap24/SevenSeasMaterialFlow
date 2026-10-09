/**
 * Writes a .env with freshly generated secrets. Never overwrites an existing file.
 *   npm run env:init                 → local development (Laragon MySQL)
 *   npm run env:init -- --production → production template (fill in APP_ORIGIN, DB host)
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), ".env");
if (existsSync(file)) {
  console.error(".env already exists — not touching it. Delete it first if you really want new secrets.");
  console.error("WARNING: a new DATA_ENCRYPTION_KEY makes existing encrypted data unreadable.");
  process.exit(1);
}

const prod = process.argv.includes("--production");
const key = randomBytes(32).toString("base64");
const dbPassword = randomBytes(24).toString("base64url");

const env = `# Seven Seas Material Flow — server configuration.
# Keep this file private: never commit it, never send it over chat or email.

NODE_ENV=${prod ? "production" : "development"}
HOST=127.0.0.1
PORT=4000
# The exact address people open in the browser.
APP_ORIGIN=${prod ? "https://flow.example.com" : "http://localhost:5173"}
# Number of reverse proxies in front of the app (Caddy/Nginx = 1).
TRUST_PROXY=${prod ? 1 : 0}
TZ=Asia/Kolkata

# Database — the app connects with this least-privilege account (created by db:setup).
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=seven_seas_flow
DB_USER=flow_app
DB_PASSWORD=${dbPassword}
DB_SSL=false
# MySQL host patterns the app account may connect from.
DB_APP_HOSTS=localhost,127.0.0.1

# Admin account used ONLY by "npm run db:setup" to create the database and the app account.
# Remove these two lines after setup on a production server.
DB_ADMIN_USER=root
DB_ADMIN_PASSWORD=

# Encrypts sensitive fields at rest. BACK THIS UP SEPARATELY — without it the
# encrypted data in the database (and in its backups) cannot be read.
DATA_ENCRYPTION_KEY=${key}

SESSION_IDLE_MINUTES=120
SESSION_ABSOLUTE_HOURS=12
LOGIN_MAX_FAILURES=5
LOGIN_LOCK_MINUTES=15

# Lets the admin's "Load demo data" / "Clear all" buttons wipe the registers. Keep false on the live system.
ALLOW_DEMO_RESET=${prod ? "false" : "true"}
`;

writeFileSync(file, env, { mode: 0o600 });
console.log(`Wrote ${file} with new secrets.`);
console.log("Back up DATA_ENCRYPTION_KEY somewhere safe (password manager) — it cannot be recovered.");
