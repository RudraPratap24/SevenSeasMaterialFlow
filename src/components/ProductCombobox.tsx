import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BomProduct } from "../lib/types";

interface Props {
  products: BomProduct[];
  /** Called with the product's index in the BOM array. */
  onSelect: (pid: number) => void;
  /** Selected pid, or null when the field is empty. */
  value: number | null;
  /** Fired after a selection so the caller can move focus to the quantity field. §7.1 */
  onSelected?: () => void;
}

/**
 * §7.1 — filters on product name and FG code, fully keyboard driven:
 * ↓ ↑ to move, Enter to select, Esc to close.
 */
export function ProductCombobox({ products, onSelect, value, onSelected }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const withIndex = products.map((p, pid) => ({ p, pid }));
    if (!q) return withIndex;
    return withIndex.filter(
      ({ p }) =>
        p.name.toLowerCase().includes(q) || p.fg.toLowerCase().includes(q),
    );
  }, [products, query]);

  // Keep the highlighted option in range as the list narrows.
  useEffect(() => {
    setActive((a) => (a >= matches.length ? 0 : a));
  }, [matches.length]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // The field mirrors the current selection when the user is not typing.
  useEffect(() => {
    if (value === null) setQuery("");
    else setQuery(products[value]?.name ?? "");
  }, [value, products]);

  function choose(pid: number) {
    onSelect(pid);
    setQuery(products[pid]?.name ?? "");
    setOpen(false);
    onSelected?.();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return;
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open && matches[active]) {
        e.preventDefault();
        choose(matches[active].pid);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(matches.length - 1);
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        className="field"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && matches[active] ? `${listId}-${matches[active].pid}` : undefined
        }
        placeholder="Search product or FG code…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          e.target.select();
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />

      {open && (
        <div
          className="absolute left-0 right-0 top-[36px] z-30 overflow-hidden rounded-[3px] border border-rule bg-card shadow-[0_6px_18px_rgba(22,40,61,.13)]"
          // Keep focus in the input so the click lands as a selection, not a blur.
          onMouseDown={(e) => e.preventDefault()}
        >
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label="Products"
            className="max-h-[286px] overflow-y-auto"
          >
            {matches.length === 0 && (
              <li className="px-3 py-3 text-[12.5px] text-muted">
                No product matches “{query.trim()}”.
              </li>
            )}

            {matches.map(({ p, pid }, i) => (
              <li
                key={pid}
                id={`${listId}-${pid}`}
                role="option"
                aria-selected={i === active}
                className={`cursor-pointer border-b border-rule px-3 py-2 last:border-b-0 ${
                  i === active ? "bg-blue-soft" : "bg-card"
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(pid)}
              >
                <div className="truncate text-[13px] font-semibold leading-tight">
                  {p.name}
                </div>
                <div className="mt-[3px] flex items-center gap-2 text-[10.5px] text-muted">
                  {p.fg && <span className="num">{p.fg}</span>}
                  {p.vendor && (
                    <span className="rounded-[2px] border border-rule px-1 py-[1px] uppercase tracking-[.06em]">
                      {p.vendor}
                    </span>
                  )}
                  <span>
                    {p.comps.length} {p.comps.length === 1 ? "component" : "components"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
