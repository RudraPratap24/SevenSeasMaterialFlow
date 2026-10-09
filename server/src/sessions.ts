import type { CookieOptions, NextFunction, Request, Response } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { ROLE_PROFILES, type Role } from "../../src/flow/perms";
import { config, isProd } from "./config";
import { hashToken, newToken } from "./crypto";
import { pool } from "./db";

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  label: string;
  mustChangePassword: boolean;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/** `__Host-` pins the cookie to this exact host over HTTPS, path "/" — no subdomain can set or read it. */
export const COOKIE_NAME = isProd ? "__Host-flow_sid" : "flow_sid";

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true, // unreadable from JavaScript — an XSS cannot steal the session
    secure: isProd,
    sameSite: "strict", // never sent on cross-site requests — first line of CSRF defence
    path: "/",
    maxAge: config.SESSION_ABSOLUTE_HOURS * 3600 * 1000,
  };
}

export async function createSession(req: Request, res: Response, userId: number): Promise<void> {
  const token = newToken();
  await pool.execute(
    "INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL ? HOUR), ?, ?)",
    [
      hashToken(token),
      userId,
      config.SESSION_ABSOLUTE_HOURS,
      req.ip?.slice(0, 45) ?? null,
      (req.get("user-agent") ?? "").slice(0, 255),
    ],
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

/** Deletes the session the request's cookie points at (if any) from the database. */
export async function dropSessionRow(req: Request): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token === "string" && token) {
    await pool.execute("DELETE FROM sessions WHERE id = ?", [hashToken(token)]);
  }
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  await dropSessionRow(req);
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

/** Signs the user out everywhere else — used after a password change or reset. */
export async function destroyOtherSessions(userId: number, keepSessionId: string | null): Promise<void> {
  if (keepSessionId) {
    await pool.execute("DELETE FROM sessions WHERE user_id = ? AND id <> ?", [userId, keepSessionId]);
  } else {
    await pool.execute("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }
}

/** Resolves the session cookie to a user. Expired, idle or disabled → anonymous. */
export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return next();
  const id = hashToken(token);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT s.id AS sid, TIMESTAMPDIFF(SECOND, s.last_seen_at, NOW(3)) AS idle,
            u.id, u.username, u.role, u.label, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > NOW(3) AND u.active = 1`,
    [id],
  );
  const r = rows[0];
  if (!r) return next();
  if (Number(r.idle) > config.SESSION_IDLE_MINUTES * 60) {
    await pool.execute("DELETE FROM sessions WHERE id = ?", [id]);
    return next();
  }
  if (Number(r.idle) > 60) {
    await pool.execute("UPDATE sessions SET last_seen_at = NOW(3) WHERE id = ?", [id]);
  }
  req.user = {
    id: Number(r.id),
    username: r.username,
    role: r.role as Role,
    label: r.label,
    mustChangePassword: Number(r.must_change_password) === 1,
    sessionId: r.sid,
  };
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Please log in." });
    return;
  }
  next();
}

/** Blocks register access until a temporary password has been replaced. */
export function requirePasswordCurrent(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.mustChangePassword) {
    res.status(403).json({ error: "Please set a new password first.", code: "PASSWORD_CHANGE_REQUIRED" });
    return;
  }
  next();
}

export function publicUser(u: SessionUser) {
  const profile = ROLE_PROFILES[u.role];
  return {
    username: u.username,
    role: u.role,
    label: u.label,
    tabs: profile.tabs,
    viewOnly: profile.viewOnly,
    mustChangePassword: u.mustChangePassword,
  };
}

/** Housekeeping: drop expired sessions. */
export async function purgeExpiredSessions(): Promise<void> {
  await pool.execute("DELETE FROM sessions WHERE expires_at <= NOW(3)");
}
