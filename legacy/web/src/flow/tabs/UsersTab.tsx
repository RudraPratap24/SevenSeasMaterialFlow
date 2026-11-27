import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ROLES, ROLE_PROFILES, type Role } from "../perms";
import { Card, Chip, Field, Table, Td, TextInput, Tr } from "../ui";

interface UserRow {
  username: string;
  role: Role;
  label: string;
  name: string;
  active: boolean;
  lastLogin: string;
}

/** Same rule as the server and `npm run user -- create`. */
const LOGIN = /^[a-z0-9._-]{3,40}$/;
const blank = { username: "", role: "gate" as Role, label: ROLE_PROFILES.gate.label, name: "", password: "" };

/** Admin adds logins with a starting password; the person sets their own at first login. */
export function UsersTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState(blank);
  const [taken, setTaken] = useState<boolean | null>(null);
  const [made, setMade] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { user: me } = useAuth();
  const [listError, setListError] = useState("");
  /** The user whose role is being changed, with the new role and label. */
  const [editing, setEditing] = useState<{ username: string; role: Role; label: string } | null>(null);

  async function saveRole() {
    if (!editing) return;
    setListError("");
    try {
      await api("POST", `/users/${encodeURIComponent(editing.username)}/role`, { role: editing.role, label: editing.label });
      setEditing(null);
      void load();
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }

  async function setActive(u: UserRow, active: boolean) {
    if (!active && !window.confirm(`Disable ${u.username}${u.name ? ` (${u.name})` : ""}? They are signed out and cannot log in.`)) return;
    setListError("");
    try {
      await api("POST", `/users/${encodeURIComponent(u.username)}/active`, { active });
      void load();
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }

  const load = () => api<{ users: UserRow[] }>("GET", "/users").then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => void load(), []);

  const login = form.username.trim().toLowerCase();
  const validLogin = LOGIN.test(login);
  useEffect(() => {
    setTaken(null);
    if (!validLogin) return;
    // wait for a pause in typing, so each keystroke is not a request
    const t = setTimeout(() => {
      api<{ taken: boolean }>("GET", `/users/check?username=${encodeURIComponent(login)}`)
        .then((r) => setTaken(r.taken))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [login, validLogin]);

  const ready = validLogin && taken === false && form.label.trim() !== "" && form.name.trim() !== "" && form.password.length >= 10 && !busy;

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ username: string }>("POST", "/users", { ...form, username: login });
      setMade(r.username);
      setShow(false);
      setForm(blank);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Add user" role="admin">
        <div className="space-y-3 px-3 py-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
            <Field label="Username (login id) *">
              <input
                className="field h-8 w-full"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
                placeholder="e.g. rudra_342_"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="username-status"
                style={
                  taken === null ? undefined : { borderColor: taken ? "var(--red)" : "var(--green)" }
                }
              />
              <span id="username-status" className="mt-1 block text-[11px] font-semibold" aria-live="polite">
                {login === "" ? (
                  <span className="text-muted">3–40 of a-z 0-9 . _ -</span>
                ) : !validLogin ? (
                  <span style={{ color: "var(--red)" }}>Only a-z 0-9 . _ - (3–40)</span>
                ) : taken === null ? (
                  <span className="text-muted">Checking…</span>
                ) : taken ? (
                  <span style={{ color: "var(--red)" }}>✗ Taken</span>
                ) : (
                  <span style={{ color: "var(--green)" }}>✓ Available</span>
                )}
              </span>
            </Field>
            <Field label="Role (what they can open) *">
              <select
                className="field h-8 w-full"
                value={form.role}
                // the label follows the role unless it was typed
                onChange={(e) => {
                  const role = e.target.value as Role;
                  setForm({
                    ...form,
                    role,
                    label: form.label === ROLE_PROFILES[form.role].label ? ROLE_PROFILES[role].label : form.label,
                  });
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_PROFILES[r].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Label (the job) *">
              <TextInput value={form.label} onChange={(v) => setForm({ ...form, label: v })} placeholder="e.g. Gate Entry" />
            </Field>
            <Field label="Name (the person) *">
              <TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Rudra" />
            </Field>
            <Field label="Starting password *">
              <div className="flex gap-1">
                <input
                  className="field h-8 min-w-0 flex-1"
                  type={show ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  autoComplete="new-password"
                  aria-describedby="password-rule"
                />
                <button type="button" className="btn h-8 px-2 text-[11px]" onClick={() => setShow(!show)} aria-pressed={show}>
                  {show ? "Hide" : "Show"}
                </button>
              </div>
              <span id="password-rule" className="mt-1 block text-[11px] text-muted">
                10+ characters, mix 3 of: a-z, A-Z, 0-9, symbol. Not the username.
              </span>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary h-8 px-4" disabled={!ready} onClick={() => void save()}>
              {busy ? "Adding…" : "Add user"}
            </button>
            {error && <span className="text-[12px] font-semibold" style={{ color: "var(--red)" }}>{error}</span>}
          </div>
          {made && (
            <div
              className="rounded-[3px] px-3 py-2 text-[12px]"
              style={{ background: "var(--green-soft)", borderLeft: "3px solid var(--green)" }}
              role="status"
            >
              Created <b>{made}</b>. Give them the starting password; they must set their own at first login.
              <button className="btn ml-3 h-6 px-2 text-[11px]" onClick={() => setMade("")}>
                Done
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card title="Users" right={<span className="text-[11px] text-muted">{users.length} logins</span>}>
        {listError && <p className="px-3 py-2 text-[12px] font-semibold" style={{ color: "var(--red)" }}>{listError}</p>}
        <Table headers={["Username", "Name", "Label", "Role", "Status", "Last login", ""]}>
          {users.map((u, i) => (
            <Tr key={u.username} zebra={i % 2 === 1}>
              <Td num strong>{u.username}</Td>
              <Td>{u.name || "—"}</Td>
              <Td>{u.label}</Td>
              <Td>
                {editing?.username === u.username ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <select
                      className="field h-7"
                      value={editing.role}
                      aria-label={`New role for ${u.username}`}
                      // the label follows the role unless it was typed
                      onChange={(e) => {
                        const role = e.target.value as Role;
                        setEditing({ ...editing, role, label: editing.label === ROLE_PROFILES[editing.role].label ? ROLE_PROFILES[role].label : editing.label });
                      }}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_PROFILES[r].label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="field h-7 w-[140px]"
                      value={editing.label}
                      onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                      aria-label={`Label for ${u.username}`}
                      placeholder="Label (the job)"
                    />
                    <button
                      className="btn btn-primary h-7 px-2 text-[11px]"
                      disabled={!editing.label.trim() || (editing.role === u.role && editing.label.trim() === u.label)}
                      onClick={() => {
                        if (window.confirm(`Change ${u.username} to ${ROLE_PROFILES[editing.role].label}? They are signed out and see the new tabs at next login.`)) void saveRole();
                      }}
                    >
                      Save
                    </button>
                    <button className="btn h-7 px-2 text-[11px]" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    {ROLE_PROFILES[u.role]?.label ?? u.role}
                    {u.username !== me?.username && (
                      <button
                        className="btn h-6 px-2 text-[11px]"
                        onClick={() => setEditing({ username: u.username, role: u.role, label: u.label })}
                      >
                        Change role
                      </button>
                    )}
                  </span>
                )}
              </Td>
              <Td>{u.active ? <Chip label="ACTIVE" tone="green" /> : <Chip label="DISABLED" tone="red" />}</Td>
              <Td num>{u.lastLogin || "—"}</Td>
              <Td>
                {u.username === me?.username ? (
                  <span className="text-[11px] text-muted">you</span>
                ) : u.active ? (
                  <button
                    className="btn h-6 px-2 text-[11px]"
                    style={{ borderColor: "var(--red)", color: "var(--red)" }}
                    onClick={() => void setActive(u, false)}
                  >
                    Disable
                  </button>
                ) : (
                  <button
                    className="btn h-6 px-2 text-[11px]"
                    style={{ borderColor: "var(--green)", color: "var(--green)" }}
                    onClick={() => void setActive(u, true)}
                  >
                    Enable
                  </button>
                )}
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>
      <p className="text-[11px] text-muted">
        Reset a password or unlock a login from the server: <code>npm run user -- reset|unlock &lt;username&gt;</code>
      </p>
    </div>
  );
}
