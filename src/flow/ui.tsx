import { useEffect, useRef, useState, type ReactNode } from "react";
import type { QcStatus } from "./types";

/** A quantity in its own unit, decimals kept (Kg, Doz from Tally); "" unit = pcs. */
export const fmtQty = (n: number, unit = ""): string =>
  `${n.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit || "pcs"}`;

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
    muted: { bg: "#F0F0F0", fg: "var(--muted)" },
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
      style={{ background: zebra ? "#FAFAFA" : "var(--card)" }}
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

/** A calendar date picker that holds "dd-mm-yyyy", the format of the registers and the server ("" = no date). */
export function DateInput({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel?: string }) {
  const d = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  return (
    <input
      className="field num h-8"
      type="date"
      value={d ? `${d[3]}-${d[2]}-${d[1]}` : ""}
      aria-label={ariaLabel}
      onChange={(e) => {
        const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.target.value);
        onChange(iso ? `${iso[3]}-${iso[2]}-${iso[1]}` : "");
      }}
    />
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-3 py-5 text-[12.5px] text-muted">{children}</p>;
}

/** A long list shown 10 at a time. Reset to page 1 when the search changes (call setPage(0)). */
export function usePaged<T>(items: T[], size = 10) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(page, pages - 1);
  return { rows: items.slice(p * size, p * size + size), page: p, pages, total: items.length, size, setPage };
}

export function Pager({ page, pages, total, size, setPage }: ReturnType<typeof usePaged<unknown>>) {
  if (total <= size) return null;
  return (
    <div className="flex items-center justify-between border-t border-rule px-3 py-2 text-[12px] text-muted">
      <span className="num">
        {page * size + 1}–{Math.min(total, page * size + size)} of {total}
      </span>
      <span className="flex items-center gap-2">
        <button className="btn h-7 px-2 text-[11.5px]" disabled={page === 0} onClick={() => setPage(page - 1)}>
          ‹ Prev
        </button>
        <span className="num">
          Page {page + 1} of {pages}
        </span>
        <button className="btn h-7 px-2 text-[11.5px]" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
          Next ›
        </button>
      </span>
    </div>
  );
}

/**
 * A text box with a searchable list under it, in the app's own style (the gate's PO search look): type to
 * narrow (matches the value or its grey hint), click or Enter to pick, arrows to move, Esc to close. The list
 * floats above the page, so a table's scroll area can't clip it; it follows the box when the page scrolls.
 */
export function SearchPicker({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  minWidth = 0,
  className = "field h-8 w-full",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; hint?: string }[];
  placeholder?: string;
  ariaLabel: string;
  minWidth?: number;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const term = value.trim().toLowerCase();
  const matches = options
    .filter((o) => !term || o.value.toLowerCase().includes(term) || (o.hint ?? "").toLowerCase().includes(term))
    .slice(0, 50);
  const show = () => setAt(input.current?.getBoundingClientRect() ?? null);
  const pick = (v: string) => {
    onChange(v);
    setAt(null);
  };
  const isOpen = at !== null;
  useEffect(() => {
    if (!isOpen) return;
    // Scrolling the list itself is just scrolling; scrolling the page moves the list along with the box.
    const follow = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) show();
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", show);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", show);
    };
  }, [isOpen]);
  return (
    <>
      <input
        ref={input}
        className={className}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={at !== null}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          show();
          setActive(0);
        }}
        onFocus={show}
        onBlur={() => setAt(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, matches.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && at && matches[active]) pick(matches[active].value);
          else if (e.key === "Escape") setAt(null);
          else return;
          e.preventDefault();
        }}
      />
      {at && matches.length > 0 && (
        <div
          ref={list}
          role="listbox"
          className="fixed z-50 max-h-72 overflow-y-auto rounded border border-rule bg-white text-left shadow-md"
          style={{ top: at.bottom + 4, left: at.left, width: Math.max(at.width, minWidth) }}
        >
          {matches.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={i === active}
              // mousedown, not click: picks before the box loses focus and closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.value);
              }}
              onMouseEnter={() => setActive(i)}
              className={`block w-full border-b border-rule px-3 py-2 text-left last:border-b-0 ${i === active ? "bg-zebra" : "bg-white"}`}
            >
              <span className="block text-[12.5px] font-semibold text-ink">{o.value}</span>
              {o.hint && <span className="block text-[11px] font-normal text-muted">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Line icons for the header, the pending strip and the glance tiles (24-unit paths, drawn with currentColor). */
const ICON_PATHS = {
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9c1.5-4 4.5-6 8-6s6.5 2 8 6",
  key: "M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-4.5 2.5L4 18v2h3v-2h2v-2h2l1.5-1.5",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4h4",
  box: "M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Zm0 0 9 4.5 9-4.5M12 12v9",
  pause: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2-12v6m4-6v6",
  reject: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-12 6 6m0-6-6 6",
  doc: "M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6M9 16h6",
  truck: "M2 6h12v10H2V6Zm12 4h4l3 3v3h-7v-6ZM6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  exit: "M14 4H5v16h9M10 12h11m-3-3 3 3-3 3",
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
