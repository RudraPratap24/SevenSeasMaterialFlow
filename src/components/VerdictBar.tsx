import { fmt, plural } from "../lib/format";
import type { PlanSummary } from "../lib/calc";

/**
 * §6.4 — the sentence the client reads out loud, stated before any numbers.
 */
export function VerdictBar({ summary }: { summary: PlanSummary }) {
  const { total, short, tight, shortUnits } = summary;

  const tone: "short" | "tight" | "ok" =
    short > 0 ? "short" : tight > 0 ? "tight" : "ok";

  const skin = {
    short: { bg: "var(--red-soft)", edge: "var(--red)", text: "var(--red)" },
    tight: { bg: "var(--amber-soft)", edge: "var(--amber)", text: "var(--amber)" },
    ok: { bg: "var(--green-soft)", edge: "var(--green)", text: "var(--green)" },
  }[tone];

  const sentence =
    short > 0
      ? `This plan cannot run — ${fmt(short)} ${plural(short, "component", "components")} short.`
      : tight > 0
        ? `This plan can run, but ${fmt(tight)} ${plural(tight, "component has", "components have")} less than 10% headroom.`
        : `This plan can run — all ${fmt(total)} ${plural(total, "component is", "components are")} in stock.`;

  const detail =
    short > 0
      ? `${fmt(shortUnits)} ${plural(shortUnits, "unit", "units")} to buy across ${fmt(short)} ${plural(short, "component", "components")}. ${fmt(total - short)} of ${fmt(total)} covered.`
      : tight > 0
        ? `${fmt(total)} ${plural(total, "component", "components")} in this plan, all covered — ${fmt(tight)} with little room to spare.`
        : `${fmt(total)} ${plural(total, "component", "components")} in this plan, every one with headroom.`;

  return (
    <div
      className="rounded-[4px] border border-rule px-4 py-3"
      style={{ background: skin.bg, borderLeft: `3px solid ${skin.edge}` }}
      role="status"
      aria-live="polite"
    >
      <p
        className="text-[18px] font-bold leading-tight"
        style={{ color: tone === "ok" ? "var(--ink)" : skin.text }}
      >
        {sentence}
      </p>
      <p className="mt-1 text-[12px] text-muted">{detail}</p>
    </div>
  );
}
