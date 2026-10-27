/**
 * The login page's picture of the whole flow, as a loop of short scenes: store runs short → indent → PO → approval →
 * gate → unloading → GRN/QC → stock → requisition → production → FG → order → dispatch → (store runs short again).
 * Plain SVG + CSS keyframes; each scene remounts so its animations replay. Starts paused for reduced motion.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

const INK = "#111111";
const MUTED = "#666666";
const RULE = "#DCDCDC";
const PAPER = "#F2F2F2";
const GREEN = "#0F7B5A";
const AMBER = "#B45309";
const KRAFT = "#DDB98C";
const KRAFT_DK = "#B8905F";
const SHELF_ORANGE = "#C97A2C";
const STEEL = "#8E949A";
const G = 262; // ground line

const CSS = `
.fs-c{transform-box:fill-box;transform-origin:center}
.fs-paused *{animation-play-state:paused!important}
@keyframes fs-fade{from{opacity:0}to{opacity:1}}
@keyframes fs-pop{0%{opacity:0;transform:scale(.4)}70%{opacity:1;transform:scale(1.06)}100%{opacity:1;transform:scale(1)}}
@keyframes fs-drop{from{opacity:0;transform:translateY(-50px)}to{opacity:1;transform:none}}
@keyframes fs-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes fs-stamp{0%{opacity:0;transform:scale(2.4) rotate(-16deg)}65%{opacity:1;transform:scale(.95) rotate(-8deg)}100%{opacity:1;transform:scale(1) rotate(-8deg)}}
@keyframes fs-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes fs-spin{to{transform:rotate(360deg)}}
@keyframes fs-dash{to{stroke-dashoffset:-12}}
@keyframes fs-blink{50%{opacity:.2}}
@keyframes fs-lift{to{transform:rotate(80deg)}}
@keyframes fs-fill{from{transform:scaleX(var(--a))}to{transform:scaleX(var(--b))}}
@keyframes fs-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes fs-move{from{transform:translate(var(--fx),var(--fy))}to{transform:translate(var(--tx),var(--ty))}}
@keyframes fs-movein{0%{opacity:0;transform:translate(var(--fx),var(--fy))}25%{opacity:1}100%{opacity:1;transform:translate(var(--tx),var(--ty))}}
@keyframes fs-moveout{0%{opacity:1;transform:translate(var(--fx),var(--fy))}70%{opacity:1}100%{opacity:0;transform:translate(var(--tx),var(--ty))}}
@keyframes fs-belt{0%{opacity:0;transform:translateX(0)}8%{opacity:1}90%{opacity:1}100%{opacity:0;transform:translateX(var(--d))}}
`;

const EASE = "cubic-bezier(.2,.8,.2,1)";
const anim = (name: string, ms: number, delay = 0, ease = EASE): CSSProperties => ({
  animation: `${name} ${ms}ms ${ease} ${delay}ms both`,
});

/* ── drawing pieces ─────────────────────────────────────────────────────────── */

/** Slides its children from `from` to `to` (offsets), optionally fading in or out. */
function Move(p: { from: [number, number]; to?: [number, number]; ms: number; delay?: number; ease?: string; fade?: "in" | "out"; children: ReactNode }) {
  const [tx, ty] = p.to ?? [0, 0];
  const name = p.fade === "in" ? "fs-movein" : p.fade === "out" ? "fs-moveout" : "fs-move";
  const style = {
    "--fx": `${p.from[0]}px`,
    "--fy": `${p.from[1]}px`,
    "--tx": `${tx}px`,
    "--ty": `${ty}px`,
    ...anim(name, p.ms, p.delay ?? 0, p.ease ?? "cubic-bezier(.45,.05,.25,1)"),
  } as CSSProperties;
  return <g style={style}>{p.children}</g>;
}

const Pop = ({ delay, children }: { delay: number; children: ReactNode }) => (
  <g className="fs-c" style={anim("fs-pop", 450, delay)}>{children}</g>
);
const Rise = ({ delay, children }: { delay: number; children: ReactNode }) => (
  <g style={anim("fs-rise", 450, delay)}>{children}</g>
);

type Pose = "stand" | "stop" | "phone" | "clip" | "point";
const ARMS: Record<Pose, ReactNode> = {
  stand: <path d="M-11 -54 L-15 -31 M11 -54 L15 -31" fill="none" />,
  stop: (
    <>
      <path d="M-11 -54 L-15 -31 M11 -54 L21 -76" fill="none" />
      <circle cx={22} cy={-80} r={4} />
    </>
  ),
  phone: (
    <>
      <path d="M-11 -54 L-15 -31 M11 -54 L19 -62 L10 -70" fill="none" />
      <rect x={6} y={-79} width={6} height={12} rx={1.5} fill={INK} />
    </>
  ),
  clip: (
    <>
      <path d="M-11 -54 L6 -42 M11 -54 L18 -44" fill="none" />
      <rect x={8} y={-54} width={15} height={19} rx={1.5} />
      <rect x={12} y={-56} width={7} height={4} fill={INK} strokeWidth={1} />
      <path d="M11 -47 H20 M11 -42 H18" strokeWidth={1.2} />
    </>
  ),
  point: <path d="M-11 -54 L-15 -31 M11 -54 L32 -58" fill="none" />,
};

/** A person standing on the ground at x, facing right (or left with `flip`). */
function Person({ x, role = "store", pose = "stand", flip }: { x: number; role?: "store" | "guard" | "admin" | "worker"; pose?: Pose; flip?: boolean }) {
  return (
    <g transform={`translate(${x},${G})${flip ? " scale(-1,1)" : ""}`} stroke={INK} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="#fff">
      <path d="M-5 -30 L-7 0 M5 -30 L7 0" fill="none" strokeWidth={2.5} />
      <rect x={-11} y={-58} width={22} height={30} rx={7} fill={role === "guard" ? INK : "#fff"} />
      {role === "admin" && <path d="M0 -56 L-3 -48 L0 -36 L3 -48 Z" fill={INK} strokeWidth={1} />}
      {ARMS[pose]}
      <circle cx={0} cy={-68} r={9} />
      {role === "guard" && <path d="M-10 -71 Q0 -84 10 -71 L14 -70 L-10 -70 Z" fill={INK} />}
      {role === "worker" && <path d="M-11 -70 A11 10 0 0 1 11 -70 L13 -70 L-13 -70 Z" fill={AMBER} />}
    </g>
  );
}

function Wheel({ cx, spin }: { cx: number; spin?: string }) {
  return (
    <g transform={`translate(${cx},-10)`}>
      <circle r={11} fill={INK} />
      <g className="fs-c" style={spin ? { animation: spin } : undefined}>
        <path d="M-6 0 H6 M0 -6 V6" stroke="#fff" strokeWidth={1.6} />
      </g>
      <circle r={2.4} fill="#fff" />
    </g>
  );
}

/** A truck, rear at x=0 on the ground, facing right, 206 long. */
function Truck({ spin }: { spin?: string }) {
  return (
    <g stroke={INK} strokeWidth={2.5} strokeLinejoin="round" fill="#fff">
      <rect x={0} y={-92} width={146} height={70} rx={3} />
      {[24, 48, 72, 96, 120].map((x) => (
        <line key={x} x1={x} y1={-86} x2={x} y2={-28} stroke={RULE} strokeWidth={1.5} />
      ))}
      <path d="M150 -22 V-66 Q150 -70 154 -70 H182 L204 -46 V-22 Z" />
      <path d="M160 -64 H180 L195 -48 H160 Z" fill={PAPER} strokeWidth={1.5} />
      <rect x={0} y={-24} width={206} height={6} fill={INK} />
      <rect x={199} y={-36} width={6} height={5} fill={AMBER} strokeWidth={1} />
      {[30, 62, 178].map((cx) => (
        <Wheel key={cx} cx={cx} spin={spin} />
      ))}
    </g>
  );
}

/** A carton standing on (x, y): raw material (white) or finished goods (black). */
function Box({ x = 0, y = 0, fg }: { x?: number; y?: number; fg?: boolean }) {
  const c = fg ? "#fff" : INK;
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={0} y={-36} width={46} height={36} rx={2} fill={fg ? INK : KRAFT} stroke={INK} strokeWidth={2} />
      <rect x={19} y={-36} width={8} height={9} fill={fg ? "#fff" : KRAFT_DK} opacity={fg ? 0.25 : 1} />
      <text x={23} y={-17} textAnchor="middle" fontSize={6.6} fontWeight={800} letterSpacing=".04em" fill={c}>
        {fg ? "FINISHED" : "RAW"}
      </text>
      <text x={23} y={-9} textAnchor="middle" fontSize={6.6} fontWeight={800} letterSpacing=".04em" fill={c}>
        {fg ? "GOODS" : "MATERIAL"}
      </text>
    </g>
  );
}

function Bottle({ x = 0 }: { x?: number }) {
  return (
    <g transform={`translate(${x},0)`} stroke={INK} strokeWidth={1.8} fill="#fff">
      <rect x={-3} y={-34} width={6} height={5} fill={INK} />
      <path d="M-3 -29 V-25 Q-9 -22 -9 -16 V-2 Q-9 0 -7 0 H7 Q9 0 9 -2 V-16 Q9 -22 3 -25 V-29 Z" />
      <rect x={-6} y={-15} width={12} height={7} fill={PAPER} strokeWidth={1} />
    </g>
  );
}

type Line = string | { t: string; c?: string; b?: boolean; at?: number };

/** A paper document; its lines appear one by one (`at: -1` = shown at once). */
function Doc({ x, y, w = 190, title, lines, start = 400, step = 300 }: { x: number; y: number; w?: number; title: string; lines: Line[]; start?: number; step?: number }) {
  const h = 46 + lines.length * 20;
  return (
    <g transform={`translate(${x},${y})`}>
      <path d={`M0 0 H${w - 16} L${w} 16 V${h} H0 Z`} fill="#fff" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
      <path d={`M${w - 16} 0 V16 H${w}`} fill={PAPER} stroke={INK} strokeWidth={1.5} strokeLinejoin="round" />
      <text x={12} y={22} fontSize={10} fontWeight={800} letterSpacing=".08em" fill={INK}>
        {title}
      </text>
      <line x1={12} y1={30} x2={w - 12} y2={30} stroke={INK} strokeWidth={1.5} />
      {lines.map((raw, i) => {
        const l = typeof raw === "string" ? { t: raw } : raw;
        const at = l.at ?? start + i * step;
        const text = (
          <text x={12} y={50 + i * 20} fontSize={10.5} fontWeight={l.b ? 800 : 500} fill={l.c ?? INK}>
            {l.t}
          </text>
        );
        return at < 0 ? <g key={i}>{text}</g> : <Rise key={i} delay={at}>{text}</Rise>;
      })}
    </g>
  );
}

function Rack({ x, label }: { x: number; label: string }) {
  return (
    <g transform={`translate(${x},${G})`}>
      <rect x={-3} y={-156} width={6} height={156} fill={STEEL} />
      <rect x={157} y={-156} width={6} height={156} fill={STEEL} />
      {[-52, -104, -152].map((y) => (
        <rect key={y} x={-3} y={y - 1} width={166} height={5} rx={1} fill={SHELF_ORANGE} />
      ))}
      <rect x={30} y={-178} width={100} height={20} rx={2} fill={INK} />
      <text x={80} y={-164} textAnchor="middle" fontSize={9.5} fontWeight={800} letterSpacing=".1em" fill="#fff">
        {label}
      </text>
    </g>
  );
}

function Gauge({ x, y, label, from, to, color = GREEN, delay = 400, note }: { x: number; y: number; label: string; from: number; to: number; color?: string; delay?: number; note?: string }) {
  const fill = { transformBox: "fill-box", transformOrigin: "left center", "--a": from, "--b": to, ...anim("fs-fill", 1300, delay, "cubic-bezier(.4,0,.2,1)") } as CSSProperties;
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={-12} y={-14} width={200} height={42} rx={8} fill="#fff" stroke={RULE} />
      <g stroke={INK} strokeWidth={1.6} fill="none" strokeLinejoin="round">
        <path d="M0 -3 L9 -8 L18 -3 V9 L9 14 L0 9 Z M0 -3 L9 2 L18 -3 M9 2 V14" />
      </g>
      <text x={28} y={-1} fontSize={9.5} fontWeight={800} letterSpacing=".06em" fill={INK}>
        {label}
      </text>
      <rect x={28} y={6} width={118} height={8} rx={4} fill={PAPER} />
      <rect x={28} y={6} width={118} height={8} rx={4} fill={color} style={fill} />
      <text x={176} y={14} textAnchor="end" fontSize={10} fontWeight={800} fill={note ? color : INK} style={note ? { animation: "fs-blink 1s steps(2) infinite" } : undefined}>
        {note ?? `${Math.round(to * 100)}%`}
      </text>
    </g>
  );
}

/** A speech bubble whose tail points at (x, y). */
function Bubble({ x, y, text, delay = 300, right }: { x: number; y: number; text: string; delay?: number; right?: boolean }) {
  const w = text.length * 6.3 + 22;
  const bx = right ? -18 : -w + 18;
  return (
    <g transform={`translate(${x},${y})`}>
      <Pop delay={delay}>
        <rect x={bx} y={-40} width={w} height={28} rx={14} fill={INK} />
        <path d="M-6 -14 L0 0 L6 -14 Z" fill={INK} />
        <text x={bx + w / 2} y={-22} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">
          {text}
        </text>
      </Pop>
    </g>
  );
}

const Tick = ({ x, y, delay }: { x: number; y: number; delay: number }) => (
  <path
    transform={`translate(${x},${y})`}
    d="M0 5 L4 9 L12 0"
    fill="none"
    stroke={GREEN}
    strokeWidth={2.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    pathLength={1}
    strokeDasharray={1}
    style={anim("fs-draw", 400, delay, "ease-out")}
  />
);

/** A black pill with white text, centred on x. */
const Chip = ({ x, y, text, color = INK }: { x: number; y: number; text: string; color?: string }) => {
  const w = text.length * 6.2 + 24;
  return (
    <g>
      <rect x={x - w / 2} y={y} width={w} height={24} rx={12} fill={color} />
      <text x={x} y={y + 16} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#fff">
        {text}
      </text>
    </g>
  );
};

const Desk = ({ x }: { x: number }) => (
  <path d={`M${x} ${G - 44} H${x + 150} M${x + 10} ${G - 44} V${G} M${x + 140} ${G - 44} V${G}`} stroke={INK} strokeWidth={3} strokeLinecap="round" />
);

function Gate() {
  return (
    <g stroke={INK} strokeWidth={2.5} strokeLinejoin="round">
      <rect x={500} y={G - 110} width={90} height={110} fill="#fff" />
      <rect x={494} y={G - 118} width={102} height={10} fill={INK} />
      <rect x={515} y={G - 88} width={60} height={30} fill={PAPER} strokeWidth={2} />
      <rect x={560} y={G - 50} width={20} height={50} fill="#fff" strokeWidth={2} />
      <text x={545} y={G - 94} textAnchor="middle" fontSize={8.5} fontWeight={800} letterSpacing=".12em" fill={INK} stroke="none">
        SECURITY
      </text>
      <rect x={470} y={G - 76} width={12} height={76} fill={INK} />
    </g>
  );
}

function Barrier({ lift }: { lift?: number }) {
  const style: CSSProperties | undefined =
    lift === undefined ? undefined : { transformBox: "view-box", transformOrigin: `476px ${G - 66}px`, ...anim("fs-lift", 900, lift, "cubic-bezier(.5,0,.3,1)") };
  return (
    <g style={style}>
      <rect x={310} y={G - 70} width={166} height={8} rx={2} fill="#fff" stroke={INK} strokeWidth={1.5} />
      <line x1={312} y1={G - 66} x2={474} y2={G - 66} stroke={INK} strokeWidth={6} strokeDasharray="14 10" />
    </g>
  );
}

/* ── the scenes ─────────────────────────────────────────────────────────────── */

const UNLOADED: [number, number][] = [[300, G], [350, G], [400, G], [325, G - 36], [375, G - 36]];
const SHELF: [number, number][] = [[502, G - 3], [552, G - 3], [452, G - 53], [502, G - 53], [552, G - 53]];
const SPIN = (delay: number, turns: number) => `fs-spin .42s linear ${delay}ms ${turns}`;

/** The parked truck of the unloading scenes: facing left, rear (open) at x=256. */
const DockTruck = () => (
  <>
    <g transform={`translate(256,${G}) scale(-1,1)`}>
      <Truck />
    </g>
    <path d={`M256 ${G - 92} L274 ${G - 99} V${G - 30} L256 ${G - 24}`} fill="#fff" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
  </>
);

interface Scene {
  tag: string;
  title: string;
  note: string;
  ms: number;
  draw: () => ReactNode;
}

const SCENES: Scene[] = [
  {
    tag: "Store",
    title: "Stock is running low",
    note: "The store spots a shortage and calls for raw material.",
    ms: 3600,
    draw: () => (
      <>
        <Rack x={400} label="RM STORE" />
        <Box x={412} y={G - 3} />
        <Gauge x={410} y={34} label="RM STOCK" from={0.3} to={0.12} color={AMBER} note="LOW" />
        <Person x={290} pose="phone" />
        <path d={`M306 ${G - 80} q4 6 0 12 M311 ${G - 84} q6 10 0 20`} fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" style={{ animation: "fs-blink .5s steps(2) infinite" }} />
        <Bubble x={284} y={G - 90} text="We need raw material!" delay={500} />
      </>
    ),
  },
  {
    tag: "Purchase",
    title: "Indent raised",
    note: "An indent records the item, quantity and rate.",
    ms: 3400,
    draw: () => (
      <>
        <Person x={130} />
        <Desk x={70} />
        <rect x={150} y={G - 62} width={34} height={18} rx={2} fill="#fff" stroke={INK} strokeWidth={2} />
        <Move from={[-190, 120]} ms={900} delay={200} fade="in">
          <Doc x={340} y={36} title="PURCHASE INDENT" start={900} lines={["IND-0012", "Raw material · 500 kg", "Rate ₹120 / kg", { t: "Raised by Store", c: MUTED }]} />
        </Move>
      </>
    ),
  },
  {
    tag: "Purchase",
    title: "Purchase order created",
    note: "Indents for the same vendor go on one PO.",
    ms: 3600,
    draw: () => (
      <>
        <Move from={[0, 0]} to={[230, 10]} ms={900} delay={300} fade="out">
          <Doc x={50} y={60} w={120} title="INDENT" lines={[{ t: "IND-0012", at: -1 }]} />
        </Move>
        <Move from={[0, 0]} to={[200, -20]} ms={900} delay={450} fade="out">
          <Doc x={80} y={130} w={120} title="INDENT" lines={[{ t: "IND-0013", at: -1 }]} />
        </Move>
        <Pop delay={900}>
          <Doc x={300} y={34} w={220} title="PURCHASE ORDER" start={1300} step={280} lines={["26SEV1261", "Vendor · ABC Chemicals", "2 indents · ₹60,000", { t: "Waiting for approval", c: AMBER, b: true }]} />
        </Pop>
      </>
    ),
  },
  {
    tag: "Admin",
    title: "Admin approves",
    note: "The approved PO is also created in Tally.",
    ms: 3600,
    draw: () => (
      <>
        <Doc x={300} y={34} w={220} title="PURCHASE ORDER" lines={[{ t: "26SEV1261", at: -1 }, { t: "Vendor · ABC Chemicals", at: -1 }, { t: "2 indents · ₹60,000", at: -1 }, { t: "Approved by Admin", c: GREEN, b: true, at: 1200 }]} />
        <g className="fs-c" style={anim("fs-stamp", 600, 700, "cubic-bezier(.3,.7,.3,1)")}>
          <rect x={420} y={138} width={130} height={34} rx={4} fill="#fff" fillOpacity={0.85} stroke={GREEN} strokeWidth={3} />
          <text x={485} y={161} textAnchor="middle" fontSize={17} fontWeight={900} letterSpacing=".14em" fill={GREEN}>
            APPROVED
          </text>
        </g>
        <Person x={585} role="admin" pose="point" flip />
        <Rise delay={1900}>
          <Chip x={360} y={190} text="Created in Tally ✓" />
        </Rise>
      </>
    ),
  },
  {
    tag: "Gate",
    title: "Truck at the gate",
    note: "The vendor arrives with the PO and invoice — the guard stops it.",
    ms: 3600,
    draw: () => (
      <>
        <Gate />
        <g transform={`translate(30,${G})`}>
          <Move from={[-420, 0]} ms={2200} ease="cubic-bezier(.15,.6,.3,1)">
            <Truck spin={SPIN(0, 5)} />
          </Move>
        </g>
        <Barrier />
        <Person x={282} role="guard" pose="stop" flip />
        <Bubble x={296} y={G - 92} text="STOP" right delay={1700} />
      </>
    ),
  },
  {
    tag: "Gate",
    title: "Gate entry",
    note: "Security checks the PO and invoice, logs the vehicle in and lifts the barrier.",
    ms: 4400,
    draw: () => (
      <>
        <Gate />
        <g transform={`translate(30,${G})`}>
          <Move from={[0, 0]} to={[640, 0]} ms={1700} delay={2600} ease="cubic-bezier(.55,0,.8,.4)">
            <Truck spin={SPIN(2600, 5)} />
          </Move>
        </g>
        <Barrier lift={1800} />
        <Person x={282} role="guard" pose="clip" flip />
        <Doc x={70} y={18} w={200} title="GATE ENTRY" lines={["PO 26SEV1261", "Invoice INV-884", { t: "Vehicle in 10:42", b: true }]} />
        <Tick x={240} y={58} delay={700} />
        <Tick x={240} y={78} delay={1000} />
      </>
    ),
  },
  {
    tag: "Store",
    title: "Unloading",
    note: "Boxes of raw material come off the truck.",
    ms: 3800,
    draw: () => (
      <>
        <DockTruck />
        {UNLOADED.map(([x, y], i) => (
          <g key={i} transform={`translate(${x},${y})`}>
            <Move from={[210 - x, G - 24 - y]} ms={800} delay={300 + 520 * i} fade="in">
              <Box />
            </Move>
          </g>
        ))}
        <Person x={505} role="worker" pose="point" flip />
      </>
    ),
  },
  {
    tag: "GRN · QC",
    title: "GRN and QC",
    note: "The store counts against the PO; QC approves the material.",
    ms: 4200,
    draw: () => (
      <>
        <DockTruck />
        {UNLOADED.map(([x, y], i) => (
          <g key={i}>
            <Box x={x} y={y} />
            <Pop delay={300 + 380 * i}>
              <rect x={x + 6} y={y - 27} width={34} height={22} rx={4} fill={INK} />
              <text x={x + 23} y={y - 12} textAnchor="middle" fontSize={11} fontWeight={800} fill="#fff">
                {i + 1}
              </text>
            </Pop>
          </g>
        ))}
        <Person x={520} pose="clip" flip />
        <Doc x={430} y={22} w={190} title="GRN-0042" lines={[{ t: "Counted 5 / 5 boxes", at: 2300 }, { t: "QC approved", c: GREEN, b: true, at: 2900 }]} />
        <Tick x={594} y={62} delay={2500} />
        <Tick x={594} y={82} delay={3100} />
      </>
    ),
  },
  {
    tag: "PM stock",
    title: "Into stock",
    note: "Accepted material is added to stock.",
    ms: 3400,
    draw: () => (
      <>
        <Rack x={440} label="RM STORE" />
        <Box x={452} y={G - 3} />
        {UNLOADED.map(([x, y], i) => (
          <g key={i} transform={`translate(${SHELF[i][0]},${SHELF[i][1]})`}>
            <Move from={[x - SHELF[i][0], y - SHELF[i][1]]} ms={900} delay={200 + 260 * i}>
              <Box />
            </Move>
          </g>
        ))}
        <Gauge x={440} y={34} label="RM STOCK" from={0.12} to={0.85} delay={1700} />
        <Rise delay={2300}>
          <text x={440} y={76} fontSize={11} fontWeight={800} fill={GREEN}>
            +500 kg in stock
          </text>
        </Rise>
        <Person x={250} pose="point" />
      </>
    ),
  },
  {
    tag: "Requisition",
    title: "Requisition",
    note: "Production asks the store for material, and the store issues it.",
    ms: 3800,
    draw: () => (
      <>
        <Rack x={440} label="RM STORE" />
        {[[452, G - 3] as [number, number], SHELF[0], SHELF[1], SHELF[4]].map(([x, y]) => (
          <Box key={x * 1000 + y} x={x} y={y} />
        ))}
        {[SHELF[2], SHELF[3]].map(([x, y], i) => (
          <g key={i} transform={`translate(${x},${y})`}>
            <Move from={[0, 0]} to={[200 - x + 50 * i, G - y]} ms={1300} delay={1500 + 300 * i} fade="out">
              <Box />
            </Move>
          </g>
        ))}
        <Gauge x={440} y={34} label="RM STOCK" from={0.85} to={0.6} delay={1700} />
        <Person x={120} role="worker" />
        <Bubble x={128} y={G - 90} text="Need 2 boxes for batch B-118" right delay={300} />
        <Person x={385} pose="clip" flip />
        <Rise delay={1200}>
          <Chip x={385} y={142} text="REQ-031 · issued" />
        </Rise>
      </>
    ),
  },
  {
    tag: "Production",
    title: "Production",
    note: "Raw material goes in, finished goods come out.",
    ms: 4600,
    draw: () => (
      <>
        {[60, 200, 440, 580].map((x) => (
          <line key={x} x1={x} y1={G - 30} x2={x} y2={G} stroke={INK} strokeWidth={3} />
        ))}
        <rect x={20} y={G - 40} width={600} height={14} rx={7} fill="#fff" stroke={INK} strokeWidth={2} />
        <line x1={27} y1={G - 33} x2={613} y2={G - 33} stroke={INK} strokeWidth={2} strokeDasharray="6 6" style={{ animation: "fs-dash .5s linear infinite" }} />
        {[0, 1, 2].map((k) => (
          <g key={k} style={{ "--d": "220px", animation: `fs-belt 3s linear ${-k * 1000}ms infinite` } as CSSProperties}>
            <g transform={`translate(30,${G - 40}) scale(.62)`}>
              <Box />
            </g>
          </g>
        ))}
        {[0, 1, 2, 3].map((k) => (
          <g key={k} style={{ "--d": "190px", animation: `fs-belt 3s linear ${-k * 750}ms infinite` } as CSSProperties}>
            <g transform={`translate(412,${G - 40})`}>
              <Bottle />
            </g>
          </g>
        ))}
        <g stroke={INK} strokeWidth={2.5} strokeLinejoin="round">
          <rect x={250} y={G - 150} width={150} height={118} rx={4} fill="#fff" />
          <rect x={250} y={G - 72} width={12} height={32} fill={INK} />
          <rect x={388} y={G - 72} width={12} height={32} fill={INK} />
          <text x={325} y={G - 132} textAnchor="middle" fontSize={8.5} fontWeight={800} letterSpacing=".12em" fill={INK} stroke="none">
            MANUFACTURING
          </text>
          <g className="fs-c" style={{ animation: "fs-spin 2.4s linear infinite" }}>
            <circle cx={325} cy={G - 92} r={17} fill="none" strokeWidth={7} strokeDasharray="5 4.2" />
          </g>
          <circle cx={325} cy={G - 92} r={11} fill="#fff" />
          <circle cx={325} cy={G - 92} r={3} fill={INK} />
          <circle cx={384} cy={G - 136} r={4} fill={GREEN} stroke="none" style={{ animation: "fs-blink 1s steps(2) infinite" }} />
        </g>
      </>
    ),
  },
  {
    tag: "FG",
    title: "FG warehouse",
    note: "Finished goods are packed and stored in the FG warehouse.",
    ms: 3800,
    draw: () => (
      <>
        <Rack x={440} label="FG WAREHOUSE" />
        <Box x={452} y={G - 3} fg />
        <Box x={502} y={G - 3} fg />
        <Person x={80} role="worker" />
        <Desk x={110} />
        {[150, 172, 194, 216].map((x, i) => (
          <g key={x} transform={`translate(${x},${G - 44})`}>
            <Move from={[0, 0]} to={[196 - x, 6]} ms={800} delay={200 + 150 * i} fade="out">
              <Bottle />
            </Move>
          </g>
        ))}
        <g transform={`translate(552,${G - 3})`}>
          <Move from={[173 - 552, -41]} ms={1100} delay={1900}>
            <Pop delay={1200}>
              <Box fg />
            </Pop>
          </Move>
        </g>
        <Gauge x={440} y={34} label="FG STOCK" from={0.3} to={0.6} delay={2600} />
      </>
    ),
  },
  {
    tag: "Dispatch",
    title: "Order packed",
    note: "A customer order arrives; goods are picked from FG and packed.",
    ms: 3800,
    draw: () => (
      <>
        <Rack x={440} label="FG WAREHOUSE" />
        <Box x={452} y={G - 3} fg />
        <g style={anim("fs-drop", 600, 200)}>
          <Doc x={30} y={20} w={180} title="SALES ORDER" start={700} lines={["SO-0219", "Customer · 240 pcs", { t: "Dispatch today", c: AMBER, b: true }]} />
        </g>
        {[[502, G - 3], [552, G - 3]].map(([sx, sy], i) => {
          const dx = 250 + 46 * i;
          return (
            <g key={i} transform={`translate(${dx},${G})`}>
              <Move from={[sx - dx, sy - G]} ms={1000} delay={1400 + 300 * i}>
                <Box fg />
              </Move>
            </g>
          );
        })}
        <path d={`M250 ${G - 36} H342`} stroke={AMBER} strokeWidth={4} pathLength={1} strokeDasharray={1} style={anim("fs-draw", 500, 2500, "ease-out")} />
        <Pop delay={2800}>
          <Chip x={296} y={G - 72} text="PACKED · INV-1187" color={GREEN} />
        </Pop>
        <Person x={400} pose="clip" flip />
      </>
    ),
  },
  {
    tag: "Dispatch",
    title: "Dispatched",
    note: "Loaded on the truck and on its way — then the store calls for raw material again.",
    ms: 4800,
    draw: () => (
      <>
        {[14, 60].map((x, i) => (
          <g key={x} transform={`translate(${x},${G})`}>
            <Move from={[0, 0]} to={[140 - x, -24]} ms={1000} delay={300 + 400 * i} fade="out">
              <Box fg />
            </Move>
          </g>
        ))}
        <g transform={`translate(120,${G})`}>
          <Move from={[0, 0]} to={[600, 0]} ms={1700} delay={1900} ease="cubic-bezier(.55,0,.8,.4)">
            <Truck spin={SPIN(1900, 5)} />
          </Move>
        </g>
        <Pop delay={3000}>
          <text x={320} y={118} textAnchor="middle" fontSize={26} fontWeight={900} letterSpacing=".08em" fill={GREEN}>
            DISPATCHED ✓
          </text>
        </Pop>
        <Rise delay={3500}>
          <text x={320} y={144} textAnchor="middle" fontSize={11.5} fontWeight={600} fill={MUTED}>
            Next: the store needs raw material again…
          </text>
        </Rise>
      </>
    ),
  },
];

/** The warehouse behind every scene: wall, windows, columns, hanging lamps and the floor. Kept faint. */
function Backdrop() {
  return (
    <g aria-hidden="true">
      <defs>
        <linearGradient id="fs-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F8F4EE" />
          <stop offset="1" stopColor="#EDE5D9" />
        </linearGradient>
        <linearGradient id="fs-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E4DACC" />
          <stop offset="1" stopColor="#D8CCBC" />
        </linearGradient>
        <radialGradient id="fs-glow">
          <stop offset="0" stopColor="#FFF4D8" stopOpacity=".95" />
          <stop offset="1" stopColor="#FFF4D8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={640} height={G} fill="url(#fs-wall)" />
      {[30, 190, 350].map((x) => (
        <g key={x} fill="#FCFAF6" stroke="#E3D9CB" strokeWidth={1.5}>
          <rect x={x} y={104} width={130} height={74} rx={2} />
          <path d={`M${x + 43} 104 V178 M${x + 87} 104 V178 M${x} 141 H${x + 130}`} fill="none" />
        </g>
      ))}
      {[0, 170, 340, 510].map((x) => (
        <rect key={x} x={x} y={14} width={8} height={G - 14} fill="#E6DDD0" />
      ))}
      <rect width={640} height={14} fill="#D3CABE" />
      {[90, 270].map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={74} rx={80} ry={44} fill="url(#fs-glow)" />
          <line x1={x} y1={14} x2={x} y2={40} stroke="#8E8A84" strokeWidth={1.5} />
          <path d={`M${x - 13} 53 L${x - 6} 40 H${x + 6} L${x + 13} 53 Z`} fill="#55514B" />
          <ellipse cx={x} cy={54} rx={9} ry={2.5} fill="#FFF0C8" />
        </g>
      ))}
      <rect y={G} width={640} height={290 - G} fill="url(#fs-floor)" />
    </g>
  );
}

/* ── the player ─────────────────────────────────────────────────────────────── */

export function FlowStory() {
  const [step, setStep] = useState(0);
  const [run, setRun] = useState(0);
  const [paused, setPaused] = useState(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (paused) return;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % SCENES.length), SCENES[step].ms);
    return () => window.clearTimeout(t);
  }, [step, paused, run]);

  const scene = SCENES[step];
  const restart = (i: number) => {
    setStep(i);
    setRun((r) => r + 1);
  };

  return (
    <section
      className={`rounded-2xl bg-white/95 p-4 shadow-[0_24px_60px_-24px_rgba(90,64,30,.28)] ring-1 ring-black/5 sm:p-5 ${paused ? "fs-paused" : ""}`}
      aria-label="How material moves through Seven Seas"
    >
      <style>{CSS}</style>
      <div className="flex items-start justify-between gap-3 px-1 pb-4">
        <div>
          <h2 className="text-[18px] uppercase tracking-[.06em] text-ink sm:text-[20px]">
            How <span className="font-extrabold">material moves</span>
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted">Follow the journey of material from indent to dispatch.</p>
        </div>
        <button
          type="button"
          className="flex shrink-0 items-center gap-2 rounded-lg bg-[#EFEDEA] px-3.5 py-2 text-[12px] font-bold text-ink hover:bg-[#E5E2DE]"
          aria-pressed={paused}
          onClick={() => {
            if (paused) restart(step);
            setPaused(!paused);
          }}
        >
          {paused ? "▶ Play" : "❚❚ Pause"}
        </button>
      </div>
      <svg viewBox="0 0 640 290" className="block w-full overflow-hidden rounded-xl" role="img" aria-label={`${scene.title}: ${scene.note}`} style={{ fontFamily: "inherit" }}>
        <Backdrop />
        <line x1={0} y1={G} x2={640} y2={G} stroke="#3A3631" strokeWidth={2} />
        <g key={`${step}-${run}`} style={anim("fs-fade", 350)}>
          {scene.draw()}
        </g>
      </svg>
      <div className="px-1 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="num text-[13px] font-semibold text-muted">
            {step + 1}/{SCENES.length}
          </span>
          <span className="rounded-[4px] bg-ink px-2 py-1 text-[10px] font-bold uppercase tracking-[.1em] text-white">{scene.tag}</span>
          <span className="text-[17px] font-bold text-ink">{scene.title}</span>
        </div>
        <p className="mt-1.5 text-[13px] text-muted">{scene.note}</p>
        <div className="mt-3 flex gap-1.5">
          {SCENES.map((s, i) => (
            <button key={i} type="button" className="flex-1 py-1.5" aria-label={`Step ${i + 1}: ${s.title}`} onClick={() => restart(i)}>
              <span className="block h-[5px] overflow-hidden rounded-full bg-[#E3E0DC]">
                <span
                  key={i === step ? `${step}-${run}` : "idle"}
                  className="block h-full origin-left bg-ink"
                  style={i < step ? undefined : i === step ? anim("fs-grow", s.ms, 0, "linear") : { transform: "scaleX(0)" }}
                />
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
