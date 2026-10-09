import type { Request } from "express";
import { encryptValue } from "./crypto";
import { pool, type Queryable } from "./db";
import type { SessionUser } from "./sessions";

export type Outcome = "ok" | "rejected" | "denied" | "invalid" | "error";

/**
 * Append-only audit trail: who did what, when, from where, and whether it was
 * allowed. The app's database account can INSERT here but never UPDATE/DELETE.
 * Payloads are encrypted, since they can carry customer and price details.
 */
export async function audit(
  req: Request,
  entry: {
    action: string;
    outcome: Outcome;
    message?: string;
    payload?: unknown;
    user?: SessionUser | null;
    username?: string;
  },
  db: Queryable = pool,
): Promise<void> {
  const user = entry.user ?? req.user ?? null;
  try {
    await db.execute(
      "INSERT INTO audit_log (user_id, username, role, action, outcome, message, payload, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        user?.id ?? null,
        (user?.username ?? entry.username ?? null)?.slice(0, 40) ?? null,
        user?.role ?? null,
        entry.action.slice(0, 60),
        entry.outcome,
        entry.message?.slice(0, 500) ?? null,
        entry.payload === undefined ? null : encryptValue(entry.payload),
        req.ip?.slice(0, 45) ?? null,
      ],
    );
  } catch (err) {
    // Never let an audit failure crash a request, but make it loud.
    console.error(JSON.stringify({ level: "error", msg: "audit write failed", err: String(err) }));
  }
}
