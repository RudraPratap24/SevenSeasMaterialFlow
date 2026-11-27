import { useRef, useState } from "react";
import { X } from "lucide-react";
import { ProductCombobox } from "./ProductCombobox";
import { fmt } from "../lib/format";
import { normaliseQty } from "../lib/calc";
import type { BomProduct, PlanLine } from "../lib/types";

interface Props {
  products: BomProduct[];
  plan: PlanLine[];
  onAdd: (pid: number, qty: number) => void;
  onQty: (index: number, qty: number) => void;
  onRemove: (index: number) => void;
  onLoadExample: () => void;
  onClear: () => void;
}

const digitsOnly = (s: string) => s.replace(/[^\d]/g, "");

export function PlanBuilder({
  products,
  plan,
  onAdd,
  onQty,
  onRemove,
  onLoadExample,
  onClear,
}: Props) {
  const [pid, setPid] = useState<number | null>(null);
  const [qty, setQty] = useState("5,000");
  const qtyRef = useRef<HTMLInputElement>(null);

  function add() {
    if (pid === null) return;
    onAdd(pid, normaliseQty(Number(digitsOnly(qty))));
    setPid(null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-rule px-4 py-3">
        <h2 className="col-head">Production plan</h2>

        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="col-head">Product</span>
            <div className="mt-1">
              <ProductCombobox
                products={products}
                value={pid}
                onSelect={setPid}
                onSelected={() => {
                  // §7.1 — hand the user straight to the quantity field.
                  window.setTimeout(() => {
                    qtyRef.current?.focus();
                    qtyRef.current?.select();
                  }, 0);
                }}
              />
            </div>
          </label>

          <label className="block">
            <span className="col-head">Units to produce</span>
            <input
              ref={qtyRef}
              className="field num mt-1 text-right font-bold"
              type="text"
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(digitsOnly(e.target.value))}
              onFocus={(e) => {
                setQty(digitsOnly(e.target.value));
                window.setTimeout(() => e.target.select(), 0);
              }}
              onBlur={() => setQty(fmt(normaliseQty(Number(digitsOnly(qty)))))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              aria-label="Units to produce"
            />
          </label>

          <button
            className="btn btn-primary w-full justify-center"
            onClick={add}
            disabled={pid === null}
          >
            Add to plan
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
          <h2 className="col-head">
            In this plan{plan.length > 0 ? ` · ${plan.length}` : ""}
          </h2>
          {plan.length > 0 && (
            <button
              className="text-[11px] font-semibold text-muted underline underline-offset-2 hover:text-blue"
              onClick={onClear}
            >
              Clear
            </button>
          )}
        </div>

        {plan.length === 0 ? (
          <div className="px-4 pb-4 pt-2">
            <p className="text-[12.5px] leading-relaxed text-muted">
              No products in the plan yet — choose a product and enter how many units
              you want to produce.
            </p>
            <button className="btn mt-3 w-full justify-center" onClick={onLoadExample}>
              Load example plan
            </button>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {plan.map((line, i) => {
              const p = products[line.pid];
              if (!p) return null;
              return (
                <li
                  key={`${line.pid}-${i}`}
                  className="border-t border-rule px-4 py-2.5 first:border-t-0"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold leading-snug">
                        {p.name}
                      </div>
                      <div className="mt-[2px] flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted">
                        {p.fg && <span className="num">{p.fg}</span>}
                        {p.vendor && <span>{p.vendor}</span>}
                        <span>{p.comps.length} components</span>
                      </div>
                    </div>
                    <button
                      className="-mr-1 shrink-0 rounded-[2px] p-1 text-muted hover:bg-blue-soft hover:text-ink"
                      onClick={() => onRemove(i)}
                      aria-label={`Remove ${p.name} from plan`}
                      title="Remove from plan"
                    >
                      <X size={14} strokeWidth={2.25} />
                    </button>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <QtyField
                      value={line.qty}
                      onCommit={(v) => onQty(i, v)}
                      label={`Units of ${p.name}`}
                    />
                    <span className="text-[11px] text-muted">units</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Inline quantity on a plan line — edits recalculate immediately. §7.2 */
function QtyField({
  value,
  onCommit,
  label,
}: {
  value: number;
  onCommit: (v: number) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? fmt(value);

  return (
    <input
      className="num h-8 w-[112px] rounded-[3px] border border-rule px-2 text-right text-[14.5px] font-bold hover:border-[#9e9e9e]"
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={shown}
      onChange={(e) => {
        const next = digitsOnly(e.target.value);
        setDraft(next);
        onCommit(normaliseQty(Number(next)));
      }}
      onFocus={(e) => {
        setDraft(digitsOnly(String(value)));
        window.setTimeout(() => e.target.select(), 0);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
