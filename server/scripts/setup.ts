/**
 * One-time (and re-runnable) database setup, using the admin account from .env:
 *   1. creates the database (utf8mb4),
 *   2. applies pending schema migrations,
 *      (an empty database starts from baseline.sql = old migrations 1–43, then the newer ones),
 *   3. creates the least-privilege app account the server runs as (core + every module's grants),
 *   4. creates the `admin` login if there are no users yet (everyone else is added on the admin page).
 *
 *   npm run db:setup                     → random admin password, printed once, must be changed on first login
 *   npm run db:setup -- --dev-passwords  → seven@admin (local development only)
 */
import mysql, { type RowDataPacket } from "mysql2/promise";
import { config, isProd } from "../src/config";
import { generatePassword, hashPassword } from "../src/crypto";
import { ROLE_LABELS } from "../src/roles";
import { BASELINE_VERSION, MIGRATIONS, appGrants, baselineStatements } from "../src/schema";

const devPasswords = process.argv.includes("--dev-passwords");
if (devPasswords && isProd) {
  console.error("--dev-passwords is not allowed with NODE_ENV=production.");
  process.exit(1);
}

const q = (id: string) => `\`${id.replace(/`/g, "``")}\``;

async function main() {
  const adminUser = process.env.DB_ADMIN_USER;
  if (!adminUser) throw new Error("Set DB_ADMIN_USER (and DB_ADMIN_PASSWORD) in .env for setup.");

  const admin = await mysql.createConnection({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: adminUser,
    password: process.env.DB_ADMIN_PASSWORD ?? "",
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
    charset: "utf8mb4",
    multipleStatements: false,
  });

  try {
    const db = config.DB_NAME;
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${q(db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await admin.query(`USE ${q(db)}`);
    console.log(`Database ${db} ready.`);

    // ── migrations ────────────────────────────────────────────────────────────
    await admin.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [applied] = await admin.query<RowDataPacket[]>("SELECT version FROM schema_migrations");
    const done = new Set(applied.map((r) => Number(r.version)));
    if (done.size === 0) {
      const [tables] = await admin.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name <> 'schema_migrations'", [db]);
      if (Number(tables[0].n) > 0) throw new Error(`${db} has tables but no migration record — not touching it.`);
      for (const sql of baselineStatements()) await admin.query(sql);
      for (let v = 1; v <= BASELINE_VERSION; v++) {
        await admin.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [v, "baseline"]);
        done.add(v);
      }
      console.log(`Created the schema from baseline.sql (migrations 1–${BASELINE_VERSION}).`);
    }
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      for (const sql of m.statements) await admin.query(sql);
      if (m.run) await m.run(admin);
      await admin.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [m.version, m.name]);
      console.log(`Applied migration ${m.version}: ${m.name}`);
    }

    // ── least-privilege app account ───────────────────────────────────────────
    if (config.DB_USER === adminUser) {
      console.warn("WARNING: DB_USER is the admin account — the app should run as its own restricted user.");
    } else {
      const hosts = (process.env.DB_APP_HOSTS ?? "localhost,127.0.0.1")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      for (const host of hosts) {
        await admin.query("CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?", [config.DB_USER, host, config.DB_PASSWORD]);
        await admin.query("ALTER USER ?@? IDENTIFIED BY ?", [config.DB_USER, host, config.DB_PASSWORD]);
        // Start from nothing, then grant table by table.
        await admin.query("REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@?", [config.DB_USER, host]);
        for (const g of appGrants()) {
          await admin.query(`GRANT ${g.privileges} ON ${q(db)}.${q(g.table)} TO ?@?`, [config.DB_USER, host]);
        }
        console.log(`App account ${config.DB_USER}@${host} ready (table-level privileges only).`);
      }
    }

    // ── first login ───────────────────────────────────────────────────────────
    const [userCount] = await admin.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM users");
    if (Number(userCount[0].n) === 0) {
      const password = devPasswords ? "seven@admin" : generatePassword();
      await admin.query(
        "INSERT INTO users (username, password_hash, role, label, must_change_password) VALUES ('admin', ?, 'admin', ?, ?)",
        [await hashPassword(password), ROLE_LABELS.admin, devPasswords ? 0 : 1],
      );
      console.log(`
Login created:  admin  ${password}`);
      console.log(
        devPasswords
          ? "DEV PASSWORD — for local testing only. Never use it on a live server."
          : "Shown ONCE. Set a new one at first login, then add everyone else on the admin page (/admin).",
      );
    } else {
      console.log("Users already exist — left unchanged (use npm run user -- … to manage them).");
    }
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
