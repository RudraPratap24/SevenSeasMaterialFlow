/**
 * One-time (and re-runnable) database setup, using the admin account from .env:
 *   1. creates the database (utf8mb4),
 *   2. applies pending schema migrations,
 *   3. creates the least-privilege app account the server runs as,
 *   4. loads the supplier price master (rates encrypted),
 *   5. creates one login per department if there are no users yet.
 *
 *   npm run db:setup                     → random passwords, printed once, must be changed on first login
 *   npm run db:setup -- --dev-passwords  → seven@<department> (local development only)
 */
import mysql, { type RowDataPacket } from "mysql2/promise";
import { ROLES, ROLE_PROFILES } from "../../src/flow/perms";
import { config, isProd } from "../src/config";
import { encryptValue, generatePassword, hashPassword } from "../src/crypto";
import { MIGRATIONS, appGrants } from "../src/schema";
import { installStageLocks } from "../src/stageLocks";
import { SEED_SUPPLIERS } from "../seed/suppliers";

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
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      for (const sql of m.statements) await admin.query(sql);
      if (m.run) await m.run(admin);
      await admin.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [m.version, m.name]);
      console.log(`Applied migration ${m.version}: ${m.name}`);
    }

    // Stage locks follow the current table definitions — re-installed on every setup.
    await installStageLocks(admin);
    console.log("Stage locks installed (passed stages cannot be altered; registers cannot be deleted).");

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
        for (const g of appGrants(config.ALLOW_DEMO_RESET)) {
          await admin.query(`GRANT ${g.privileges} ON ${q(db)}.${q(g.table)} TO ?@?`, [config.DB_USER, host]);
        }
        console.log(
          `App account ${config.DB_USER}@${host} ready (table-level privileges only; ` +
            `${config.ALLOW_DEMO_RESET ? "DELETE allowed for the demo reset" : "no DELETE on registers"}).`,
        );
      }
    }

    // ── supplier price master ─────────────────────────────────────────────────
    const [supCount] = await admin.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM suppliers");
    if (Number(supCount[0].n) === 0) {
      for (const s of SEED_SUPPLIERS) {
        const [r] = await admin.query<import("mysql2/promise").ResultSetHeader>(
          "INSERT INTO suppliers (name, city, approved) VALUES (?, ?, 1)",
          [s.name, s.city],
        );
        for (const [code, rate] of Object.entries(s.rates)) {
          await admin.query("INSERT INTO supplier_rates (supplier_id, component_code, rate_enc) VALUES (?, ?, ?)", [
            r.insertId,
            code,
            encryptValue(String(rate)),
          ]);
        }
      }
      console.log(`Loaded ${SEED_SUPPLIERS.length} suppliers (rates encrypted).`);
    }

    // ── department logins ─────────────────────────────────────────────────────
    const [userCount] = await admin.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM users");
    if (Number(userCount[0].n) === 0) {
      const created: { username: string; password: string }[] = [];
      for (const role of ROLES) {
        const password = devPasswords ? `seven@${role}` : generatePassword();
        await admin.query(
          "INSERT INTO users (username, password_hash, role, label, must_change_password) VALUES (?, ?, ?, ?, ?)",
          [role, await hashPassword(password), role, ROLE_PROFILES[role].label, devPasswords ? 0 : 1],
        );
        created.push({ username: role, password });
      }
      console.log("\nDepartment logins created:");
      for (const c of created) console.log(`  ${c.username.padEnd(10)} ${c.password}`);
      console.log(
        devPasswords
          ? "\nDEV PASSWORDS — for local testing only. Never use these on a live server."
          : "\nThese temporary passwords are shown ONCE. Hand each to its department; each must set a new one at first login.",
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
