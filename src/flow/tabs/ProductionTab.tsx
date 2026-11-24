import { useState, type ReactNode } from "react";
import {
  BarChart3,
  Boxes,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Cog,
  Factory,
  FileText,
  FlaskConical,
  HardHat,
  Layers,
  TrendingUp,
  Truck,
  Undo2,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Card, EmptyNote } from "../ui";
import { ProductionPlanning } from "./ProductionPlanning";
import { RequisitionBomList } from "./RequisitionBomList";
import { BomIssueSlip } from "./BomIssueSlip";
import { SupervisorBomVerify } from "./SupervisorBomVerify";
import { ProductionReport } from "./ProductionReport";
import { BulkManufacturing } from "./BulkManufacturing";
import { BulkQualityTest } from "./BulkQualityTest";
import { BulkProductionPlan } from "./BulkProductionPlan";
import { BulkStockCard } from "./PmStockTab";
import { FgMaster } from "./FgMaster";
import { FgTransferNote } from "./FgTransferNote";
import { IndentRequests, BelowMinimumCard } from "./IndentRequests";
import { MrnForm, MrnVerify } from "./BomReturns";

const TONES = {
  green: { fg: "#15803d", soft: "#e7f6ec" },
  blue: { fg: "#1d6fd1", soft: "#e7f0fc" },
  purple: { fg: "#6b4fc9", soft: "#efebfb" },
  amber: { fg: "#b7791f", soft: "#fdf3df" },
  rose: { fg: "#c2364b", soft: "#fcebee" },
};

export interface Node {
  title: string;
  tone: keyof typeof TONES;
  icon: LucideIcon;
  /** the large faded picture on the card's right */
  art: LucideIcon;
  children?: Node[];
  /** The working screen; leaves without one show "coming soon". */
  view?: () => ReactNode;
}

// shortcut: leaves without a view are placeholders — each gets its own working view once its rules are agreed.
const CARDS: Node[] = [
  { title: "Production Planning", tone: "green", icon: CalendarDays, art: ClipboardList, view: () => <ProductionPlanning /> },
  { title: "Production Report", tone: "blue", icon: BarChart3, art: TrendingUp, view: () => <ProductionReport /> },
  { title: "Requisition BOM List", tone: "purple", icon: Layers, art: Cog, view: () => <RequisitionBomList /> },
  { title: "FG Master / BOM", tone: "blue", icon: FileText, art: Boxes, view: () => <FgMaster /> },
  {
    title: "Production Supervisor",
    tone: "green",
    icon: Users,
    art: HardHat,
    children: [
      { title: "Supervisor BOM Verify", tone: "green", icon: ClipboardCheck, art: ClipboardCheck, view: () => <SupervisorBomVerify /> },
      { title: "MRN", tone: "amber", icon: Undo2, art: Undo2, view: () => <MrnForm /> },
      { title: "FG Transfer Note", tone: "blue", icon: Truck, art: Truck, view: () => <FgTransferNote /> },
    ],
  },
  {
    title: "Bulk Production",
    tone: "rose",
    icon: Factory,
    art: Boxes,
    children: [
      { title: "Bulk Production Plan", tone: "green", icon: CalendarDays, art: ClipboardList, view: () => <BulkProductionPlan /> },
      { title: "Quality Testing", tone: "purple", icon: FlaskConical, art: FlaskConical, view: () => <BulkQualityTest /> },
      { title: "Bulk Manufacturing", tone: "rose", icon: Factory, art: Factory, view: () => <BulkManufacturing /> },
      { title: "Bulk Stock", tone: "blue", icon: Boxes, art: Boxes, view: () => <BulkStockCard /> },
    ],
  },
];

// Store's own steps (store login and admin)
const STORE_CARDS: Node[] = [
  { title: "BOM Issue Slip", tone: "amber", icon: FileText, art: ClipboardCheck, view: () => <BomIssueSlip /> },
  { title: "MRN Verify", tone: "green", icon: Undo2, art: Undo2, view: () => <MrnVerify /> },
  {
    title: "Indent Requests",
    tone: "purple",
    icon: ShoppingCart,
    art: ShoppingCart,
    view: () => (
      <div className="space-y-3">
        <BelowMinimumCard />
        <IndentRequests />
      </div>
    ),
  },
];

function FlowCard({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const t = TONES[node.tone];
  const Icon = node.icon;
  const Art = node.art;
  return (
    <button
      className="group relative flex min-h-[132px] items-start gap-4 overflow-hidden rounded-xl border border-rule bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = t.fg)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
      onClick={onOpen}
    >
      {/* soft colour wash and a large faded picture on the right */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-3/5"
        style={{ background: `linear-gradient(110deg, transparent 15%, ${t.soft} 85%)` }}
      />
      <Art
        aria-hidden
        className="pointer-events-none absolute -bottom-3 right-3 h-28 w-28 -rotate-6 transition group-hover:rotate-0"
        style={{ color: t.fg, opacity: 0.16 }}
        strokeWidth={1.3}
      />
      <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: t.soft, color: t.fg }}>
        <Icon className="h-6 w-6" />
      </span>
      <span className="relative flex flex-col gap-3">
        <span className="text-[17px] font-bold leading-tight text-ink">{node.title}</span>
        <span className="w-fit rounded-full px-3 py-1 text-[12.5px] font-bold" style={{ background: t.soft, color: t.fg }}>
          {node.children ? `${node.children.length} sections ›` : "Open ›"}
        </span>
      </span>
    </button>
  );
}

export const ProductionTab = () => <CardFlow root="Production Flow" top={CARDS} />;
export const StoreTab = () => <CardFlow root="Store" top={STORE_CARDS} />;

/** Cards that open a group of further cards, or the screen for that step. */
export function CardFlow({ root, top }: { root: string; top: Node[] }) {
  const [path, setPath] = useState<Node[]>([]);
  const current = path[path.length - 1];
  const cards = current ? current.children : top;

  return (
    <div className="space-y-3">
      <nav className="flex flex-wrap items-center gap-1 text-[12px] font-semibold" aria-label={`${root} path`}>
        {path.length > 0 && (
          <button
            className="order-last ml-auto flex h-8 items-center rounded-md bg-[#c2364b] px-4 font-bold text-white shadow-sm hover:bg-[#a52a3d]"
            onClick={() => setPath(path.slice(0, -1))}
          >
            ‹ Back
          </button>
        )}
        <button className="text-muted hover:text-ink" onClick={() => setPath([])}>
          {root}
        </button>
        {path.map((n, i) => (
          <span key={n.title} className="flex items-center gap-1">
            <span className="text-muted">›</span>
            <button className="text-muted hover:text-ink" onClick={() => setPath(path.slice(0, i + 1))}>
              {n.title}
            </button>
          </span>
        ))}
      </nav>

      {cards ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((n) => (
            <FlowCard key={n.title} node={n} onOpen={() => setPath([...path, n])} />
          ))}
        </div>
      ) : current.view ? (
        current.view()
      ) : (
        <Card title={current.title}>
          <EmptyNote>Coming soon — this step will be built once its working is agreed.</EmptyNote>
        </Card>
      )}
    </div>
  );
}
