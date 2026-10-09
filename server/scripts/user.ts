/**
 * User management from the server's command line (deliberately not exposed over the web).
 *   npm run user -- list
 *   npm run user -- create <login-id> <role> ["Label shown in the app"]
 *   npm run user -- reset <login-id>        new temporary password, signs out everywhere
 *   npm run user -- disable <login-id>      blocks login, signs out everywhere
 *   npm run user -- enable <login-id>
 *   npm run user -- unlock <login-id>       clears a lockout after wrong passwords
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ROLES, ROLE_PROFILES, type Role } from "../../src/flow/perms";
import { generatePassword, hashPassword } from "../src/crypto";
import { pool } from "../src/db";

const [cmd, username, roleArg, labelArg] = process.argv.slice(2);

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`Missing ${what}. See the usage at the top of server/scripts/user.ts.`);
  return v;
}

async function changed(sql: string, params: unknown[]): Promise<void> {
  const [r] = await pool.execute<ResultSetHeader>(sql, params as never[]);
  if (r.affectedRows === 0) throw new Error(`No user "${username}".`);
}

async function cliAudit(action: string, target: string) {
  await pool.execute(
    "INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', ?, 'ok', ?)",
    [action, `target ${target}`],
  );
}

async function main() {
  switch (cmd) {
    case "list": {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT username, role, label, active, must_change_password, locked_until, last_login_at FROM users ORDER BY id",
      );
      console.table(
        rows.map((r) => ({
          login: r.username,
          role: r.role,
          label: r.label,
          active: Number(r.active) === 1,
          mustChange: Number(r.must_change_password) === 1,
          lockedUntil: r.locked_until ?? "",
          lastLogin: r.last_login_at ?? "",
        })),
      );
      break;
    }
    case "create": {
      const id = need(username, "login id").toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(id)) throw new Error("Login id: 3–40 of a-z 0-9 . _ -");
      const role = need(roleArg, "role") as Role;
      if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
      const password = generatePassword();
      await pool.execute(
        "INSERT INTO users (username, password_hash, role, label, must_change_password) VALUES (?, ?, ?, ?, 1)",
        [id, await hashPassword(password), role, (labelArg ?? ROLE_PROFILES[role].label).slice(0, 80)],
      );
      await cliAudit("user.create", id);
      console.log(`Created ${id} (${role}). Temporary password: ${password}`);
      break;
    }
    case "reset": {
      const id = need(username, "login id");
      const password = generatePassword();
      await changed(
        "UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE username = ?",
        [await hashPassword(password), id],
      );
      await pool.execute("DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?", [id]);
      await cliAudit("user.reset", id);
      console.log(`New temporary password for ${id}: ${password}`);
      break;
    }
    case "disable":
    case "enable": {
      const id = need(username, "login id");
      await changed("UPDATE users SET active = ? WHERE username = ?", [cmd === "enable" ? 1 : 0, id]);
      if (cmd === "disable") {
        await pool.execute("DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?", [id]);
      }
      await cliAudit(`user.${cmd}`, id);
      console.log(`${id} ${cmd}d.`);
      break;
    }
    case "unlock": {
      const id = need(username, "login id");
      await changed("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username = ?", [id]);
      await cliAudit("user.unlock", id);
      console.log(`${id} unlocked.`);
      break;
    }
    default:
      throw new Error("Usage: npm run user -- list | create <id> <role> [label] | reset <id> | disable <id> | enable <id> | unlock <id>");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
