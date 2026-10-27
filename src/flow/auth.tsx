import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, onUnauthorized } from "./api";
import { FlowStory } from "./FlowStory";
import logo from "./logo.png";
import splash from "./splash.png";
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

const GOLD = "#B08A52";

/**
 * The company logo (white on black, 200×200), cropped to the lettering. On a light background it is inverted and
 * multiplied, so the black square disappears and the letters turn black.
 */
export function Wordmark({ light, size = 34 }: { light?: boolean; size?: number }) {
  const w = size * 5.6;
  return (
    <div className="overflow-hidden" style={{ width: w, height: w * 0.35 }} role="img" aria-label="Seven Seas Pro-Beauty">
      <img
        src={logo}
        alt=""
        draggable={false}
        style={{
          width: w * 1.124,
          maxWidth: "none",
          margin: `${-w * 0.393}px 0 0 ${-w * 0.067}px`,
          // the file's black is not pure black: contrast makes it so, then the blend drops it out
          ...(light ? { filter: "contrast(1.4)", mixBlendMode: "screen" } : { filter: "invert(1) contrast(1.4)", mixBlendMode: "multiply" }),
        }}
      />
    </div>
  );
}

/** The product splash in the dark header; a fade from the left keeps the logo and title readable over it. */
function Splash() {
  return (
    <>
      <img src={splash} alt="" aria-hidden="true" draggable={false} className="pointer-events-none absolute -right-28 -top-4 h-[125%] w-auto max-w-none select-none" />
      <span className="pointer-events-none absolute inset-y-0 left-0 w-[62%] bg-gradient-to-r from-[#0E0D0C] via-[#0E0D0C]/80 to-transparent" />
    </>
  );
}

const icon = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const UserIcon = () => (
  <svg {...icon}>
    <circle cx={12} cy={8} r={4} />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </svg>
);
const LockIcon = () => (
  <svg {...icon}>
    <rect x={5} y={11} width={14} height={10} rx={2} />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const EyeIcon = ({ off }: { off: boolean }) => (
  <svg {...icon}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx={12} cy={12} r={3} />
    {off && <path d="M4 4l16 16" />}
  </svg>
);

/** The sign-in page: the flow picture beside the login card (under it on phones, so the login stays on top). */
export function LoginScreen() {
  const { login } = useAuth();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [forgot, setForgot] = useState(false);
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

  const field =
    "h-[46px] w-full rounded-lg border border-[#DEDAD4] bg-white pl-11 pr-11 text-[14px] text-ink outline-none transition placeholder:text-[#A39E97] hover:border-[#C9C3BA] focus:border-[#B08A52] focus:ring-2 focus:ring-[#B08A52]/20";

  return (
    <div
      className="flex min-h-full flex-col px-4 py-6 sm:px-8 lg:px-12"
      style={{
        background:
          "radial-gradient(900px 500px at 8% 85%, rgba(214,190,150,.35), transparent 60%), radial-gradient(700px 420px at 92% 10%, rgba(226,206,170,.35), transparent 60%), linear-gradient(135deg, #FAF6F0 0%, #F1EAE0 100%)",
      }}
    >
      <div className="mx-auto my-auto w-full max-w-[1360px]">
        <header className="flex items-start justify-between pb-6 lg:pb-8">
          <Wordmark />
          <div className="hidden text-right sm:block">
            <p className="text-[15px] leading-snug tracking-[.14em] text-[#3A3631]">
              BEAUTY MOVES
              <br />
              WITH PRECISION
            </p>
            <span className="ml-auto mt-2 block h-[2px] w-12" style={{ background: GOLD }} />
          </div>
        </header>

        <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-7">
          <div className="order-2 min-w-0 lg:order-1">
            <FlowStory />
          </div>

          <section className="order-1 flex flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_60px_-24px_rgba(90,64,30,.32)] ring-1 ring-black/5 lg:order-2">
            <div className="relative overflow-hidden bg-[#0E0D0C] px-8 pb-6 pt-8 text-white">
              <Splash />
              <div className="relative">
                <Wordmark light size={38} />
                <h1 className="mt-6 text-[16px] font-semibold">Department-wise Login</h1>
                <p className="num mt-1 text-[12px] text-white/60">SOP/SCM/001 v2.1</p>
              </div>
            </div>

            <form
              className="flex flex-1 flex-col px-8 pb-7 pt-7"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label className="block">
                <span className="text-[12px] font-bold uppercase tracking-[.08em] text-ink">Login ID</span>
                <span className="relative mt-2 block">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#3A3631]">
                    <UserIcon />
                  </span>
                  <input
                    className={field}
                    value={id}
                    onChange={(e) => { setId(e.target.value); setError(""); }}
                    placeholder="e.g. store"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-label="Login ID"
                  />
                </span>
              </label>
              <label className="mt-5 block">
                <span className="text-[12px] font-bold uppercase tracking-[.08em] text-ink">Password</span>
                <span className="relative mt-2 block">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#3A3631]">
                    <LockIcon />
                  </span>
                  <input
                    className={field}
                    type={show ? "text" : "password"}
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(""); }}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    aria-label="Password"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-[#3A3631] hover:bg-[#F3F0EC]"
                    onClick={() => setShow(!show)}
                    aria-label={show ? "Hide password" : "Show password"}
                    aria-pressed={show}
                  >
                    <EyeIcon off={show} />
                  </button>
                </span>
              </label>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  className="text-[12.5px] font-bold hover:underline"
                  style={{ color: GOLD }}
                  onClick={() => setForgot(!forgot)}
                  aria-expanded={forgot}
                >
                  Forgot password?
                </button>
              </div>
              {forgot && (
                <p className="mt-1 rounded-lg bg-[#F7F1E7] px-3 py-2 text-[12px] text-[#5A4A33]">
                  Ask the administrator to reset it — you get a temporary password and choose a new one at login.
                </p>
              )}
              {error && (
                <p className="mt-3 text-[12.5px] font-bold" style={{ color: "var(--red)" }} role="alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                className="mt-5 flex h-[50px] w-full items-center justify-center gap-2.5 rounded-lg text-[16px] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(140,100,40,.8)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                style={{ background: "linear-gradient(90deg, #C9A46A 0%, #A9814A 100%)" }}
                disabled={busy || !id.trim() || !password}
              >
                <UserIcon />
                {busy ? "Checking…" : "Log in"}
              </button>
              <div className="mt-auto pt-6">
                <div className="flex items-center gap-3 text-[12.5px] text-muted">
                  <span className="h-px flex-1 bg-[#E6E2DC]" />
                  <span className="flex items-center gap-1.5">
                    <LockIcon /> Every department sees only its own work.
                  </span>
                  <span className="h-px flex-1 bg-[#E6E2DC]" />
                </div>
                <p className="mt-3 text-center text-[12px] leading-relaxed text-muted">
                  After 5 wrong attempts the login is locked for a few minutes.
                </p>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
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
