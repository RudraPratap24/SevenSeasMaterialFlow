import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, onUnauthorized } from "./api";
import { roleCan, type Action, type Role, type TabId } from "./perms";

export type { Action, Role } from "./perms";

/**
 * Login state. The server owns accounts, passwords and sessions (an httpOnly
 * cookie this code never sees); the browser only learns who is logged in and
 * which tabs that role may open. Every action is checked again on the server —
 * the checks here only decide which buttons to show.
 */

export interface Account {
  username: string;
  role: Role;
  label: string;
  tabs: TabId[];
  viewOnly: TabId[];
  mustChangePassword: boolean;
}

interface MeResponse {
  user: Account;
  demoReset: boolean;
}

interface AuthApi {
  user: Account | null;
  /** True while the first "who am I" check runs — avoids flashing the login card. */
  checking: boolean;
  /** Server allows the admin's demo reset buttons (development / demo systems only). */
  demoReset: boolean;
  /** Resolves to an error message, or null on success. */
  login(id: string, password: string): Promise<string | null>;
  logout(): Promise<void>;
  changePassword(current: string, next: string): Promise<string | null>;
  can(action: Action): boolean;
  /** True when the current login may open this tab at all. */
  canSee(tab: TabId): boolean;
  /** True when the tab is open for viewing only — no action buttons. */
  isViewOnly(tab: TabId): boolean;
}

const Ctx = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside provider");
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Account | null>(null);
  const [demoReset, setDemoReset] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api<MeResponse>("GET", "/auth/me")
      .then((r) => {
        setUser(r.user);
        setDemoReset(r.demoReset);
      })
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
    return onUnauthorized(() => setUser(null));
  }, []);

  const login = useCallback(async (id: string, password: string) => {
    try {
      const r = await api<MeResponse>("POST", "/auth/login", { username: id.trim(), password });
      setUser(r.user);
      setDemoReset(r.demoReset);
      return null;
    } catch (e) {
      return e instanceof ApiError ? e.message : "Login failed.";
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("POST", "/auth/logout");
    } finally {
      setUser(null);
    }
  }, []);

  const changePassword = useCallback(async (current: string, next: string) => {
    try {
      const r = await api<MeResponse>("POST", "/auth/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      setUser(r.user);
      return null;
    } catch (e) {
      return e instanceof ApiError ? e.message : "Could not change the password.";
    }
  }, []);

  const value: AuthApi = {
    user,
    checking,
    demoReset,
    login,
    logout,
    changePassword,
    can: (action) => user !== null && roleCan(user.role, action),
    canSee: (tab) => user !== null && user.tabs.includes(tab),
    isViewOnly: (tab) => user !== null && user.viewOnly.includes(tab),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function Frame({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-paper p-4">
      <div className="w-full max-w-[420px]">
        <div className="rounded-t-[6px] bg-ink px-5 py-4 text-white">
          <h1 className="text-[16px] font-bold">Seven Seas Beauty — Material Flow</h1>
          <p className="num mt-0.5 text-[11px] text-white/60">{subtitle}</p>
        </div>
        <div className="rounded-b-[6px] border border-t-0 border-rule bg-card px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

/** The sign-in card. */
export function LoginScreen() {
  const { login } = useAuth();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy || !id.trim() || !password) return;
    setBusy(true);
    const err = await login(id, password);
    setBusy(false);
    if (err) {
      setError(err);
      setPassword("");
    }
  }

  return (
    <Frame subtitle="SOP/SCM/001 v2.1 · department-wise login">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block">
          <span className="col-head">Login ID</span>
          <input
            className="field mt-1"
            value={id}
            onChange={(e) => { setId(e.target.value); setError(""); }}
            placeholder="e.g. store"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="Login ID"
          />
        </label>
        <label className="mt-3 block">
          <span className="col-head">Password</span>
          <input
            className="field mt-1"
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(""); }}
            placeholder="••••••••"
            autoComplete="current-password"
            aria-label="Password"
          />
        </label>
        {error && (
          <p className="mt-2 text-[12px] font-bold" style={{ color: "var(--red)" }} role="alert">{error}</p>
        )}
        <button
          type="submit"
          className="btn btn-primary mt-4 w-full justify-center"
          disabled={busy || !id.trim() || !password}
        >
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
      <p className="mt-4 text-[10.5px] leading-relaxed text-muted">
        Every department sees only its own work. Forgot your password? Ask the administrator to
        reset it — after 5 wrong attempts the login is locked for a few minutes.
      </p>
    </Frame>
  );
}

/** Set a new password — forced after a temporary one, or chosen from the header. */
export function ChangePasswordScreen({ onDone }: { onDone?: () => void }) {
  const { user, changePassword, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const forced = user?.mustChangePassword ?? false;

  async function submit() {
    if (next !== repeat) {
      setError("The two new passwords do not match.");
      return;
    }
    setBusy(true);
    const err = await changePassword(current, next);
    setBusy(false);
    if (err) setError(err);
    else onDone?.();
  }

  return (
    <Frame subtitle={`${user?.label ?? ""} · ${forced ? "set your own password to continue" : "change password"}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {forced && (
          <p className="mb-3 text-[12px] text-muted">
            You logged in with a temporary password. Choose your own before using the registers.
          </p>
        )}
        <label className="block">
          <span className="col-head">Current password</span>
          <input className="field mt-1" type="password" value={current} autoComplete="current-password"
            onChange={(e) => { setCurrent(e.target.value); setError(""); }} aria-label="Current password" />
        </label>
        <label className="mt-3 block">
          <span className="col-head">New password</span>
          <input className="field mt-1" type="password" value={next} autoComplete="new-password"
            onChange={(e) => { setNext(e.target.value); setError(""); }} aria-label="New password" />
        </label>
        <label className="mt-3 block">
          <span className="col-head">New password again</span>
          <input className="field mt-1" type="password" value={repeat} autoComplete="new-password"
            onChange={(e) => { setRepeat(e.target.value); setError(""); }} aria-label="Repeat new password" />
        </label>
        <p className="mt-2 text-[10.5px] text-muted">
          At least 10 characters, mixing three of: lower case, upper case, digits, symbols (or 16+ characters).
        </p>
        {error && (
          <p className="mt-2 text-[12px] font-bold" style={{ color: "var(--red)" }} role="alert">{error}</p>
        )}
        <div className="mt-4 flex gap-2">
          <button type="submit" className="btn btn-primary flex-1 justify-center"
            disabled={busy || !current || !next || !repeat}>
            {busy ? "Saving…" : "Save new password"}
          </button>
          <button type="button" className="btn" onClick={() => (forced ? void logout() : onDone?.())}>
            {forced ? "Log out" : "Cancel"}
          </button>
        </div>
      </form>
    </Frame>
  );
}
