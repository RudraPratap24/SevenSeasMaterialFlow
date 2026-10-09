import type { ReactNode } from "react";
import type { QcStatus } from "./types";

export const fmt = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : Math.round(n).toLocaleString("en-IN");

/** Status chip — red is reserved for REJECTED alone. */
export function StatusChip({ status }: { status: QcStatus }) {
  const skin: Record<QcStatus, { bg: string; fg: string; label: string }> = {
    UNDER_TEST: { bg: "var(--blue-soft)", fg: "var(--blue-dk)", label: "UNDER TEST" },
    APPROVED: { bg: "var(--green-soft)", fg: "var(--green)", label: "APPROVED" },
    HOLD: { bg: "var(--amber-soft)", fg: "var(--amber)", label: "HOLD" },
    REJECTED: { bg: "var(--red-soft)", fg: "var(--red)", label: "REJECTED" },
  };
  const s = skin[status];
  return (
    <span
      className="inline-block rounded-[2px] px-1.5 py-[2px] text-[10px] font-bold tracking-[.05em]"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

export function Chip({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "blue" | "green" | "amber" | "red";
}) {
  const colors: Record<string, { bg: string; fg: string }> = {
    muted: { bg: "#EFF3F7", fg: "var(--muted)" },
    blue: { bg: "var(--blue-soft)", fg: "var(--blue-dk)" },
    green: { bg: "var(--green-soft)", fg: "var(--green)" },
    amber: { bg: "var(--amber-soft)", fg: "var(--amber)" },
    red: { bg: "var(--red-soft)", fg: "var(--red)" },
  };
  const c = colors[tone];
  return (
    <span
      className="inline-block whitespace-nowrap rounded-[2px] px-1.5 py-[2px] text-[10px] font-bold tracking-[.05em]"
      style={{ background: c.bg, color: c.fg }}
    >
      {label}
    </span>
  );
}

/** Uppercase role tag, as in the SOP's "Kaun" column. */
export function RoleTag({ role }: { role: string }) {
  return (
    <span className="whitespace-nowrap rounded-[2px] border border-rule px-1.5 py-[2px] text-[9.5px] font-bold uppercase tracking-[.07em] text-muted">
      {role}
    </span>
  );
}

export function Card({
  title,
  role,
  step,
  right,
  children,
}: {
  title: string;
  role?: string;
  step?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
        <h2 className="text-[13px] font-bold">{title}</h2>
        {step && <Chip label={step} tone="blue" />}
        {role && <RoleTag role={role} />}
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </header>
      {children}
    </section>
  );
}

export function Table({
  headers,
  children,
  minWidth,
}: {
  headers: (string | { label: string; align?: "right" })[];
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full border-collapse"
        style={minWidth ? { minWidth } : undefined}
      >
        <thead>
          <tr className="border-b border-rule">
            {headers.map((h, i) => {
              const o = typeof h === "string" ? { label: h, align: undefined } : h;
              return (
                <th
                  key={i}
                  className={`col-head whitespace-nowrap px-2 py-1.5 ${
                    o.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {o.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Tr({ children, zebra }: { children: ReactNode; zebra?: boolean }) {
  return (
    <tr
      className="border-b border-rule align-top last:border-b-0"
      style={{ background: zebra ? "#FBFCFD" : "var(--card)" }}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  right,
  num,
  strong,
  muted,
}: {
  children: ReactNode;
  right?: boolean;
  num?: boolean;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={[
        "px-2 py-2 text-[12.5px]",
        right ? "text-right" : "",
        num ? "num" : "",
        strong ? "font-bold" : "",
        muted ? "text-muted" : "",
      ].join(" ")}
    >
      {children}
    </td>
  );
}

export function Field({
  label,
  children,
  width,
}: {
  label: string;
  children: ReactNode;
  width?: number | string;
}) {
  return (
    <label className="block" style={width ? { width } : undefined}>
      <span className="col-head">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  numeric,
  ariaLabel,
  list,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  numeric?: boolean;
  ariaLabel?: string;
  list?: string;
}) {
  return (
    <input
      className={`field h-8 ${numeric ? "num text-right" : ""}`}
      type="text"
      inputMode={numeric ? "numeric" : undefined}
      value={value}
      placeholder={placeholder}
      // No placeholder fallback: unless a caller passes an explicit ariaLabel,
      // the wrapping <Field> label names the control for assistive tech.
      aria-label={ariaLabel}
      list={list}
      onChange={(e) =>
        onChange(numeric ? e.target.value.replace(/[^\d]/g, "") : e.target.value)
      }
    />
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-3 py-5 text-[12.5px] text-muted">{children}</p>;
}
