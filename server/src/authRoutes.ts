import { Router } from "express";
import rateLimit from "express-rate-limit";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { audit } from "./audit";
import { config } from "./config";
import { hashPassword, verifyDummy, verifyPassword } from "./crypto";
import { pool } from "./db";
import {
  createSession,
  destroyOtherSessions,
  destroySession,
  dropSessionRow,
  publicUser,
  requireUser,
} from "./sessions";

export const authRouter = Router();

/** Per-IP brake on password guessing, on top of the per-account lockout below. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts from this network. Try again in 15 minutes." },
});

const LoginBody = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(40),
  password: z.string().min(1).max(200),
});

const WRONG = "Wrong ID or password.";

authRouter.post("/login", loginLimiter, async (req, res) => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: WRONG });
    return;
  }
  const { username, password } = body.data;

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, username, password_hash, role, label, active, must_change_password,
            failed_logins, (locked_until IS NOT NULL AND locked_until > NOW(3)) AS locked,
            CEIL(TIMESTAMPDIFF(SECOND, NOW(3), locked_until) / 60) AS lock_minutes
       FROM users WHERE username = ?`,
    [username],
  );
  const u = rows[0];

  if (!u || Number(u.active) !== 1) {
    await verifyDummy(password);
    await audit(req, { action: "auth.login", outcome: "denied", message: "unknown or disabled user", username });
    res.status(401).json({ error: WRONG });
    return;
  }
  if (Number(u.locked) === 1) {
    await verifyDummy(password);
    await audit(req, { action: "auth.login", outcome: "denied", message: "account locked", username });
    res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.max(1, Number(u.lock_minutes))} min.` });
    return;
  }

  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) {
    // Atomic increment, so parallel guesses cannot slip past the lockout.
    await pool.execute("UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?", [u.id]);
    const [locked] = await pool.execute<ResultSetHeader>(
      `UPDATE users SET failed_logins = 0, locked_until = DATE_ADD(NOW(3), INTERVAL ? MINUTE)
        WHERE id = ? AND failed_logins >= ?`,
      [config.LOGIN_LOCK_MINUTES, u.id, config.LOGIN_MAX_FAILURES],
    );
    const lock = locked.affectedRows > 0;
    await audit(req, {
      action: "auth.login",
      outcome: "denied",
      message: lock ? "wrong password — account locked" : "wrong password",
      username,
    });
    res.status(401).json({ error: WRONG });
    return;
  }

  await pool.execute(
    "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(3) WHERE id = ?",
    [u.id],
  );
  // Always a fresh token on login — no session fixation.
  await dropSessionRow(req);
  await createSession(req, res, Number(u.id));
  const user = {
    id: Number(u.id),
    username: u.username,
    role: u.role,
    label: u.label,
    mustChangePassword: Number(u.must_change_password) === 1,
    sessionId: "",
  };
  await audit(req, { action: "auth.login", outcome: "ok", user });
  res.json({ user: publicUser(user), demoReset: config.ALLOW_DEMO_RESET });
});

authRouter.post("/logout", async (req, res) => {
  if (req.user) await audit(req, { action: "auth.logout", outcome: "ok" });
  await destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get("/me", requireUser, (req, res) => {
  res.json({ user: publicUser(req.user!), demoReset: config.ALLOW_DEMO_RESET });
});

/* ── password change ────────────────────────────────────────────────────────── */

export function passwordProblem(password: string, username: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  const lower = password.toLowerCase();
  if (lower.includes(username.toLowerCase())) return "The password must not contain the login ID.";
  if (/^seven@/.test(lower) || /^(.)\1+$/.test(password) || /^(password|12345|qwerty)/.test(lower)) {
    return "That password is too easy to guess.";
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3 && password.length < 16) {
    return "Mix at least three of: lower case, upper case, digits, symbols — or use 16+ characters.";
  }
  return null;
}

const ChangeBody = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

authRouter.post("/change-password", requireUser, async (req, res) => {
  const body = ChangeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter the current and the new password." });
    return;
  }
  const { currentPassword, newPassword } = body.data;
  const user = req.user!;

  const [rows] = await pool.execute<RowDataPacket[]>("SELECT password_hash FROM users WHERE id = ?", [user.id]);
  if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
    await audit(req, { action: "auth.change-password", outcome: "denied", message: "wrong current password" });
    res.status(400).json({ error: "The current password is wrong." });
    return;
  }
  if (currentPassword === newPassword) {
    res.status(400).json({ error: "The new password must be different." });
    return;
  }
  const problem = passwordProblem(newPassword, user.username);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  await pool.execute(
    "UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = NOW(3) WHERE id = ?",
    [await hashPassword(newPassword), user.id],
  );
  await destroyOtherSessions(user.id, user.sessionId);
  await audit(req, { action: "auth.change-password", outcome: "ok" });
  res.json({ user: publicUser({ ...user, mustChangePassword: false }), demoReset: config.ALLOW_DEMO_RESET });
});
