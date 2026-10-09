"""Seven Seas Material Flow — system overview PDF (what was built, how the logic works)."""
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, KeepTogether, CondPageBreak)
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon

OUT = sys.argv[1]

F = "C:/Windows/Fonts/"
pdfmetrics.registerFont(TTFont("UI", F + "segoeui.ttf"))
pdfmetrics.registerFont(TTFont("UI-B", F + "segoeuib.ttf"))
pdfmetrics.registerFont(TTFont("UI-L", F + "segoeuisl.ttf"))
pdfmetrics.registerFont(TTFont("Mono", F + "consola.ttf"))
pdfmetrics.registerFontFamily("UI", normal="UI", bold="UI-B", italic="UI", boldItalic="UI-B")

# The app's own palette — red is reserved for refusals.
INK = colors.HexColor("#16283D"); PAPER = colors.HexColor("#E9EEF3"); RULE = colors.HexColor("#D8E0E8")
MUTED = colors.HexColor("#64798F"); BLUE = colors.HexColor("#1B4D8F"); BLUE_SOFT = colors.HexColor("#EAF1F9")
RED = colors.HexColor("#B3261E"); RED_SOFT = colors.HexColor("#FBEAE8"); AMBER = colors.HexColor("#B45309")
AMBER_SOFT = colors.HexColor("#FDF3E5"); GREEN = colors.HexColor("#0F7B5A"); GREEN_SOFT = colors.HexColor("#E7F4EF")
WHITE = colors.white; ZEBRA = colors.HexColor("#F6F8FA")
TEAL = colors.HexColor("#0E6E7E"); TEAL_SOFT = colors.HexColor("#E3F2F4")
PLUM = colors.HexColor("#6B3E8E"); PLUM_SOFT = colors.HexColor("#F1EAF7")

W, H = A4
M = 17 * mm
CW = W - 2 * M  # content width

ss = {
    "h1": ParagraphStyle("h1", fontName="UI-B", fontSize=17, leading=21, textColor=INK, spaceBefore=4, spaceAfter=6),
    "h2": ParagraphStyle("h2", fontName="UI-B", fontSize=12.5, leading=16, textColor=INK, spaceBefore=10, spaceAfter=4),
    "body": ParagraphStyle("body", fontName="UI", fontSize=9.6, leading=13.6, textColor=INK, spaceAfter=5),
    "small": ParagraphStyle("small", fontName="UI", fontSize=8.4, leading=11.4, textColor=MUTED, spaceAfter=4),
    "cell": ParagraphStyle("cell", fontName="UI", fontSize=8.4, leading=11, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="UI-B", fontSize=8.4, leading=11, textColor=INK),
    "head": ParagraphStyle("head", fontName="UI-B", fontSize=7.8, leading=10, textColor=WHITE),
    "bullet": ParagraphStyle("bullet", fontName="UI", fontSize=9.6, leading=13.4, textColor=INK, leftIndent=12,
                             bulletIndent=2, spaceAfter=2.5),
    "caption": ParagraphStyle("caption", fontName="UI", fontSize=8, leading=10.5, textColor=MUTED, alignment=TA_CENTER,
                              spaceBefore=3, spaceAfter=8),
    "mono": ParagraphStyle("mono", fontName="Mono", fontSize=8.2, leading=11, textColor=INK, leftIndent=8,
                           backColor=ZEBRA, borderPadding=(5, 6, 5, 6), spaceBefore=3, spaceAfter=8),
}
P = lambda t, s="body": Paragraph(t, ss[s])
B = lambda t: Paragraph(t, ss["bullet"], bulletText="•")


def table(rows, widths, head=True, zebra=True):
    data = []
    for i, r in enumerate(rows):
        style = "head" if head and i == 0 else "cell"
        data.append([c if not isinstance(c, str) else Paragraph(c, ss[style]) for c in r])
    t = Table(data, colWidths=[w * CW for w in widths], repeatRows=1 if head else 0)
    st = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 5),
          ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 3.2),
          ("BOTTOMPADDING", (0, 0), (-1, -1), 3.2), ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE)]
    if head:
        st += [("BACKGROUND", (0, 0), (-1, 0), INK)]
    if zebra:
        for i in range(1 if head else 0, len(rows)):
            if i % 2 == 0:
                st.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    t.setStyle(TableStyle(st))
    return t


# ── drawing helpers ───────────────────────────────────────────────────────────

def wrap(text, font, size, width):
    lines = []
    for para in text.split("\n"):
        words, cur = para.split(" "), ""
        for w_ in words:
            t = (cur + " " + w_).strip()
            if stringWidth(t, font, size) <= width or not cur:
                cur = t
            else:
                lines.append(cur)
                cur = w_
        lines.append(cur)
    return lines


def box(d, x, y, w, h, title, sub=None, fill=BLUE_SOFT, stroke=BLUE, tc=INK, ts=8.4, ss_=7.2, r=4, bold=True):
    d.add(Rect(x, y, w, h, rx=r, ry=r, fillColor=fill, strokeColor=stroke, strokeWidth=0.9))
    tl = wrap(title, "UI-B" if bold else "UI", ts, w - 8)
    sl = wrap(sub, "UI", ss_, w - 8) if sub else []
    total = len(tl) * (ts + 1.6) + len(sl) * (ss_ + 1.4)
    cy = y + h / 2 + total / 2 - ts * 0.82
    for line in tl:
        d.add(String(x + w / 2, cy, line, fontName="UI-B" if bold else "UI", fontSize=ts, fillColor=tc, textAnchor="middle"))
        cy -= ts + 1.6
    for line in sl:
        d.add(String(x + w / 2, cy, line, fontName="UI", fontSize=ss_, fillColor=MUTED, textAnchor="middle"))
        cy -= ss_ + 1.4


def arrow(d, x1, y1, x2, y2, c=INK, wdt=1.0, label=None, lx=0, ly=0, head=5.5, dash=None):
    d.add(Line(x1, y1, x2, y2, strokeColor=c, strokeWidth=wdt, strokeDashArray=dash))
    import math
    a = math.atan2(y2 - y1, x2 - x1)
    p1 = (x2 - head * math.cos(a - 0.38), y2 - head * math.sin(a - 0.38))
    p2 = (x2 - head * math.cos(a + 0.38), y2 - head * math.sin(a + 0.38))
    d.add(Polygon([x2, y2, p1[0], p1[1], p2[0], p2[1]], fillColor=c, strokeColor=c, strokeWidth=0.5))
    if label:
        d.add(String((x1 + x2) / 2 + lx, (y1 + y2) / 2 + ly, label, fontName="UI", fontSize=6.8, fillColor=MUTED,
                     textAnchor="middle"))


def text(d, x, y, s, size=7.5, c=MUTED, font="UI", anchor="start"):
    d.add(String(x, y, s, fontName=font, fontSize=size, fillColor=c, textAnchor=anchor))


def caption(t):
    return P(t, "caption")


# ── diagrams ──────────────────────────────────────────────────────────────────

def d_architecture():
    w, h = CW, 300
    d = Drawing(w, h)
    # browser
    box(d, 0, 236, w, 56, "Browser — the existing React register screens (one login per department)",
        "Gate · Store · QC · Packing · FG Warehouse · Accounts · Purchase · Security · Admin", fill=WHITE, stroke=INK)
    arrow(d, w / 2, 236, w / 2, 214, label="HTTPS · httpOnly session cookie · same domain", lx=88, ly=2)
    # server frame
    d.add(Rect(0, 72, w, 140, rx=5, ry=5, fillColor=PAPER, strokeColor=INK, strokeWidth=0.9))
    text(d, 8, 200, "Node.js + Express server (TypeScript)  —  one process serves the app and /api", 8, INK, "UI-B")
    bw = (w - 16 - 5 * 6) / 6
    steps = [("Auth", "login, sessions, lockout"), ("CSRF guard", "header + origin"), ("Permission", "role vs PERMS"),
             ("Validation", "strict zod schemas"), ("Plan + locks", "targets, stock, batch"), ("Audit", "every attempt")]
    for i, (t, s_) in enumerate(steps):
        box(d, 8 + i * (bw + 6), 140, bw, 46, t, s_, fill=WHITE, stroke=BLUE, ts=8)
        if i < 5:
            arrow(d, 8 + i * (bw + 6) + bw, 163, 8 + (i + 1) * (bw + 6), 163, c=BLUE, head=4)
    box(d, 8, 82, w * 0.55, 48, "Shared business rules  (src/flow/logic.ts)",
        "stock limits · PDI before dispatch · invoice before gate-out · QC finality — same code as the browser uses",
        fill=GREEN_SOFT, stroke=GREEN)
    box(d, w * 0.55 + 16, 82, w * 0.45 - 24, 48, "Repository",
        "tables → screen data (JSON only on the way out) · rows written inside one transaction", fill=WHITE, stroke=BLUE)
    arrow(d, w * 0.55 + 8, 106, w * 0.55 + 16, 106, c=GREEN, head=4)
    arrow(d, w / 2, 72, w / 2, 56, label="least-privilege account (flow_app)", lx=70, ly=0)
    # database
    box(d, 0, 0, w, 54, "MySQL 8 — relational registers, masters, audit log, snapshots",
        "foreign keys · CHECK constraints · generated totals · stage-lock triggers · encrypted sensitive columns",
        fill=TEAL_SOFT, stroke=TEAL)
    return d


ROLE = {"Purchase": (PLUM_SOFT, PLUM), "Owner": (PLUM_SOFT, PLUM), "Gate": (BLUE_SOFT, BLUE), "Store": (TEAL_SOFT, TEAL),
        "QC": (AMBER_SOFT, AMBER), "Packing": (GREEN_SOFT, GREEN), "FG WH": (BLUE_SOFT, BLUE),
        "Accounts": (PLUM_SOFT, PLUM), "Security": (BLUE_SOFT, INK), "System": (WHITE, MUTED)}


def d_flow():
    rows = [
        [("Purchase", "Indent", "below min level or manual"), ("Purchase", "Raise PO", "approved supplier, fixed rate"),
         ("Owner", "Approve PO", "admin only"), ("Gate", "Gate entry", "picks approved PO, vehicle, invoice"),
         ("Store", "GRN", "UNDER TEST — quarantine")],
        [("Store", "Send to QC", "QC slip; qty now locked"), ("QC", "A.R. decision", "Approve · Hold (once) · Reject"),
         ("System", "Store stock", "only APPROVED counts"), ("Packing", "Requisition", "from the product BOM"),
         ("Store", "Issue", "never more than stock")],
        [("Packing", "MRN return", "≤ what was issued"), ("Packing", "FG transfer", "batch, boxes, loose"),
         ("FG WH", "Receive", "location; FG stock"), ("QC", "PDI", "pass before dispatch"),
         ("FG WH", "Dispatch slip", "≤ batch stock, PDI passed")],
        [("Accounts", "Invoice", "once"), ("Security", "Verify + gate out", "needs invoice"),
         ("System", "Order balance", "open until fully dispatched"), None, None],
    ]
    cols, bw, bh, gx, gy = 5, (CW - 4 * 14) / 5, 46, 14, 26
    h = len(rows) * (bh + gy) + 22
    d = Drawing(CW, h)
    pos = {}
    for r, row in enumerate(rows):
        y = h - (r + 1) * (bh + gy) + gy - 16
        order = range(cols) if r % 2 == 0 else range(cols - 1, -1, -1)
        for k, c in enumerate(order):
            item = row[k]
            if not item:
                continue
            role, t, s_ = item
            fill, stroke = ROLE[role]
            x = c * (bw + gx)
            box(d, x, y, bw, bh, t, s_, fill=fill, stroke=stroke, ts=8.2, ss_=6.8)
            text(d, x + 4, y + bh + 2.5, role.upper(), 6.4, stroke, "UI-B")
            pos[(r, k)] = (x, y)
    seq = [(r, k) for r in range(len(rows)) for k in range(cols) if rows[r][k]]
    for a, b in zip(seq, seq[1:]):
        (x1, y1), (x2, y2) = pos[a], pos[b]
        if a[0] == b[0]:
            if x2 > x1:
                arrow(d, x1 + bw, y1 + bh / 2, x2, y2 + bh / 2, head=4.5)
            else:
                arrow(d, x1, y1 + bh / 2, x2 + bw, y2 + bh / 2, head=4.5)
        else:
            arrow(d, x1 + bw / 2, y1, x2 + bw / 2, y2 + bh + 9, head=4.5)
    return d


def d_request():
    w = CW
    steps = [
        ("Session valid?", "httpOnly cookie → hashed token → user, role", "401 Please log in"),
        ("Request from this app?", "custom header + Origin = APP_ORIGIN", "403 Request blocked"),
        ("Role allowed?", "PERMS table, e.g. purchase.approve = admin", "403 + audit 'denied'"),
        ("Input valid?", "strict schema: fields, types, sizes, codes, dates", "400 + audit 'invalid'"),
        ("Plan the action", "documents it changes · stock/batch it draws on · data slice · number series", None),
        ("Take locks (sorted)", "only those documents / that stock — unrelated work runs in parallel", "409 busy (after 10 s)"),
        ("Screen still current?", "row_version of each target ≤ the screen's basis", "409 STALE — screen refreshed"),
        ("Load slice · allocate number", "indexed queries; next number of the series (gap-free)", None),
        ("Server prepares", "server date/time, names from masters, totals recomputed, approver = login", None),
        ("Business rule (logic.ts)", "e.g. issue ≤ stock, dispatch needs PDI, final QC is final", "409 + reason, audit 'rejected'"),
        ("Write rows + audit", "inside the same transaction", None),
        ("Database checks", "foreign keys · CHECK · generated totals · stage-lock triggers", "rollback — nothing saved"),
        ("Stamp change number · COMMIT", "last step; numbers follow commit order", None),
        ("Answer: only what changed", "since the screen's basis, read after COMMIT", None),
    ]
    bh, gap = 30, 9
    h = len(steps) * (bh + gap) + 4
    d = Drawing(w, h)
    mw, rx = w * 0.58, w * 0.66
    for i, (t, s_, ref) in enumerate(steps):
        y = h - (i + 1) * (bh + gap) + gap - 2
        last = i == len(steps) - 1
        box(d, 0, y, mw, bh, t, s_, fill=GREEN_SOFT if last else WHITE, stroke=GREEN if last else BLUE, ts=8.2, ss_=6.8)
        text(d, -2, y + bh - 9, f"{i + 1}", 7, MUTED, "UI-B", "end")
        if i < len(steps) - 1:
            arrow(d, mw / 2, y, mw / 2, y - gap + 1, head=4)
        if ref:
            box(d, rx, y + 3, w - rx, bh - 6, ref, fill=RED_SOFT, stroke=RED, tc=RED, ts=7.4)
            arrow(d, mw, y + bh / 2, rx, y + bh / 2, c=RED, head=4, dash=[2, 2])
    return d


def d_database():
    w = CW
    h = 262
    d = Drawing(w, h)

    def cluster(x, y, cw, ch, title, items, fill, stroke):
        d.add(Rect(x, y, cw, ch, rx=5, ry=5, fillColor=fill, strokeColor=stroke, strokeWidth=0.9))
        text(d, x + 6, y + ch - 12, title, 8.2, stroke, "UI-B")
        for i, it in enumerate(items):
            text(d, x + 8, y + ch - 25 - i * 10.4, it, 7.3, INK, "Mono" if not it.startswith("(") else "UI")

    cw3 = (w - 2 * 10) / 3
    cluster(0, 148, cw3, 108, "Masters (stored once)",
            ["components", "products", "bom_lines", "suppliers + supplier_rates", "customers (name encrypted)",
             "production_batches", "locations", "stock_settings"], WHITE, INK)
    cluster(cw3 + 10, 148, cw3, 108, "Purchase + Inward + QC",
            ["purchase_indents", "purchase_orders + lines", "gate_entries", "goods_receipts (GRN)", "qc_intimations",
             "qc_results (A.R.)", "(view) v_grn_qc_status"], BLUE_SOFT, BLUE)
    cluster(2 * (cw3 + 10), 148, cw3, 108, "Production",
            ["requisitions + lines", "material_returns + lines", "", "(status ISSUED = issued_at set)",
             "(return qty = sum of MRN lines)"], GREEN_SOFT, GREEN)
    cluster(0, 30, cw3, 108, "System",
            ["users · sessions", "audit_log (append-only)", "state_snapshots", "document_sequences", "app_meta",
             "schema_migrations"], PAPER, MUTED)
    cluster(cw3 + 10, 30, cw3, 108, "Finished goods",
            ["fg_transfers + lines", "pdi_records", "", "(line total = generated column)",
             "(status RECEIVED = received_on set)"], AMBER_SOFT, AMBER)
    cluster(2 * (cw3 + 10), 30, cw3, 108, "Sales + dispatch",
            ["customer_orders + lines", "dispatch_slips + lines", "", "(gate out = gate_out_at set)",
             "(balance = ordered − dispatched)"], PLUM_SOFT, PLUM)
    # key references
    arrow(d, cw3, 205, cw3 + 10, 205, c=MUTED, head=4)
    arrow(d, cw3 * 2 + 10, 205, cw3 * 2 + 20, 205, c=MUTED, head=4)
    arrow(d, 2 * (cw3 + 10) + cw3 / 2, 148, 2 * (cw3 + 10) + cw3 / 2, 138, c=MUTED, head=4)
    arrow(d, cw3 + 10 + cw3 / 2, 138, cw3 + 10 + cw3 / 2, 148, c=MUTED, head=4)
    text(d, w / 2, 12, "Every document refers to masters by key (code / id) — names live only in the master tables.",
         7.6, INK, "UI-B", "middle")
    text(d, w / 2, 1, "Statuses, line totals, stock and balances are computed, never stored twice.", 7.4, MUTED, "UI", "middle")
    return d


def d_lifecycles():
    w = CW
    h = 250
    d = Drawing(w, h)

    def lane(y, label, states, colors_):
        text(d, 0, y + 34, label, 8.2, INK, "UI-B")
        n = len(states)
        bw = (w - (n - 1) * 16) / n
        for i, ((t, s_), (f, st)) in enumerate(zip(states, colors_)):
            x = i * (bw + 16)
            box(d, x, y, bw, 28, t, s_, fill=f, stroke=st, ts=7.8, ss_=6.4)
            if i < n - 1:
                arrow(d, x + bw, y + 14, x + bw + 16, y + 14, head=4)

    W1, B1, A1, G1, R1 = (WHITE, BLUE), (BLUE_SOFT, BLUE), (AMBER_SOFT, AMBER), (GREEN_SOFT, GREEN), (PAPER, INK)
    lane(200, "GRN", [("Received", "UNDER TEST · qty can be corrected"), ("Sent to QC", "qty LOCKED"),
                      ("Hold (once)", "re-test"), ("Approved / Rejected", "FINAL"), ("Barcode", "recorded once")],
         [W1, B1, A1, G1, R1])
    lane(140, "Requisition", [("Pending", "from BOM"), ("Issued", "≤ stock · qty + sign set once"),
                              ("MRN returns", "≤ issued − returned"), ("Locked", "lines never change")], [W1, G1, B1, R1])
    lane(80, "FG + dispatch", [("FG transfer", "in transit"), ("Received", "set once · stock"),
                               ("PDI", "must be PASSED"), ("Dispatch", "≤ batch stock"), ("Invoice", "set once"),
                               ("Gate out", "set once · needs invoice")], [W1, G1, A1, B1, B1, G1])
    lane(20, "Purchase", [("Indent", "open"), ("PO raised", "indent linked once"), ("Approved", "owner, set once"),
                          ("Received", "via GRNs"), ("Closed", "fully received")], [W1, B1, G1, B1, R1])
    return d


def d_concurrency():
    w = CW
    h = 205
    d = Drawing(w, h)
    lanes = [("QC 1", 0.16), ("Server + database", 0.5), ("QC 2", 0.84)]
    for name, fx in lanes:
        x = w * fx
        box(d, x - 55, h - 24, 110, 20, name, fill=PAPER, stroke=INK, ts=8)
        d.add(Line(x, h - 24, x, 8, strokeColor=RULE, strokeWidth=1.2, strokeDashArray=[3, 3]))
    x1, xs, x2 = w * 0.16, w * 0.5, w * 0.84
    text(d, xs + 8, h - 38, "both screens loaded at change no. 120 — slip shows UNDER TEST", 7.2, MUTED, "UI", "start")
    arrow(d, x1, h - 52, xs, h - 52, label="Hold, basis 120", ly=3)
    box(d, xs - 70, h - 82, 140, 22, "GRN changed → no. 121", "lock · check · save · commit", fill=GREEN_SOFT, stroke=GREEN, ts=7.4, ss_=6.4)
    arrow(d, x2, h - 100, xs, h - 100, label="Reject, basis 120", ly=3)
    box(d, xs - 70, h - 130, 140, 22, "121 > 120 → refused", "nothing saved", fill=RED_SOFT, stroke=RED, tc=RED, ts=7.4, ss_=6.4)
    arrow(d, xs, h - 140, x2, h - 140, c=RED, label="409 STALE + latest data", ly=3)
    text(d, x2 - 8, h - 158, "QC 2's screen now shows HOLD", 7.2, INK, "UI-B", "end")
    arrow(d, x2, h - 172, xs, h - 172, label="Approve, basis 121", ly=3)
    box(d, xs - 70, h - 200, 140, 22, "accepted → no. 122", "re-test decision recorded", fill=GREEN_SOFT, stroke=GREEN, ts=7.4, ss_=6.4)
    return d


def d_sync():
    w = CW
    h = 120
    d = Drawing(w, h)
    bw = (w - 3 * 18) / 4
    items = [("Every 10 s", "GET /api/version (tiny)"), ("Changed?", "compare with the screen's number"),
             ("GET /api/changes?since=N", "only documents changed after N"), ("Merge into screen", "replace in place, append new")]
    for i, (t, s_) in enumerate(items):
        box(d, i * (bw + 18), 64, bw, 44, t, s_, fill=WHITE if i < 3 else GREEN_SOFT, stroke=BLUE if i < 3 else GREEN)
        if i < 3:
            arrow(d, i * (bw + 18) + bw, 86, (i + 1) * (bw + 18), 86, head=4)
    box(d, 0, 4, w * 0.48, 44, "Full reload only when needed", "login · demo reset · restore · renames · customer edit (resync)",
        fill=PAPER, stroke=MUTED)
    box(d, w * 0.52, 4, w * 0.48, 44, "After your own action", "the answer already carries everything changed since your screen",
        fill=PAPER, stroke=MUTED)
    return d


def d_deploy():
    w = CW
    h = 92
    d = Drawing(w, h)
    bw = (w - 3 * 18) / 4
    items = [("Staff browsers", "phones / PCs", WHITE, INK), ("Caddy :443", "HTTPS, certificates", BLUE_SOFT, BLUE),
             ("Node app 127.0.0.1:4000", "API + built frontend", GREEN_SOFT, GREEN),
             ("MySQL 127.0.0.1:3306", "never on the internet", TEAL_SOFT, TEAL)]
    for i, (t, s_, f, st) in enumerate(items):
        box(d, i * (bw + 18), 44, bw, 42, t, s_, fill=f, stroke=st)
        if i < 3:
            arrow(d, i * (bw + 18) + bw, 65, (i + 1) * (bw + 18), 65, head=4)
    box(d, w - bw, 0, bw, 32, "Daily backup off-server", "+ encryption key kept separately", fill=PAPER, stroke=MUTED, ts=7.6, ss_=6.4)
    arrow(d, w - bw / 2, 44, w - bw / 2, 32, head=4)
    return d


# ── document ──────────────────────────────────────────────────────────────────

def on_page(c, doc):
    c.saveState()
    c.setFillColor(INK)
    c.rect(0, H - 9 * mm, W, 9 * mm, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont("UI-B", 8.5)
    c.drawString(M, H - 6 * mm, "Seven Seas Beauty — Material Flow")
    c.setFont("UI", 8)
    c.drawRightString(W - M, H - 6 * mm, "System overview · what was built and how it works")
    c.setFillColor(MUTED)
    c.setFont("UI", 7.5)
    c.drawString(M, 9 * mm, "SOP/SCM/001 v2.1 · 9 October 2026")
    c.drawRightString(W - M, 9 * mm, f"Page {doc.page}")
    c.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=M, rightMargin=M, topMargin=16 * mm, bottomMargin=16 * mm,
                      title="Seven Seas Material Flow — System Overview", author="Seven Seas Beauty",
                      subject="What was built and how the logic works")
doc.addPageTemplates([PageTemplate(id="p", frames=[Frame(M, 16 * mm, CW, H - 32 * mm, id="f")], onPage=on_page)])

s = []
# 1 — summary
s += [P("System overview", "h1"),
      P("The client's Material Management SOP — 22 steps from a supplier's vehicle at the gate to finished goods "
        "leaving the gate — turned from a browser-only demo into a secure, multi-user web application with a real "
        "database. This document explains what was built, why, and how the logic works."),
      Spacer(1, 4)]
s.append(table([
    ["", "Where it started", "Where it is now"],
    ["Data", "Kept in the browser's memory — gone on refresh, one copy per tab", "MySQL 8, relational; shared live by every department"],
    ["Logins", "Passwords inside the web page", "Server-side accounts, hashed passwords, secure sessions, lockout"],
    ["Rules", "Checked only on screen", "Enforced on the server and, for passed stages, by the database itself"],
    ["Many users", "Not possible", "Parallel work; conflicts detected; no double stock; gap-free numbers"],
    ["Traceability", "In the browser only", "Every document, every attempt and every login in an append-only audit log"],
], [0.17, 0.39, 0.44]))
s += [Spacer(1, 8), P("At a glance", "h2")]
s.append(table([
    ["Built", "Count / detail"],
    ["Register tables (relational)", "18 business tables + 9 master tables + 7 system tables, 1 view"],
    ["Database migrations", "6 — each applied once, in order, recorded in schema_migrations"],
    ["Stage-lock triggers", "40 — passed stages cannot be altered, registers cannot be deleted"],
    ["Actions (each permission-checked, validated, locked, audited)", "19 register actions + customer edit + protected demo reset"],
    ["Automated checks", "104 across 5 suites — security, parallel use, data integrity, reset protection, concurrency"],
], [0.42, 0.58]))

# 2 — architecture
s += [PageBreak(), P("1. Architecture", "h1"),
      P("One server hosts both the screens and the API on the same domain. That keeps the login cookie strict and "
        "removes cross-site configuration. Every request passes the same chain of checks; the business rules are "
        "written once and shared by the server (which enforces them) and the browser (which only displays figures)."),
      d_architecture(), caption("Figure 1 — the parts of the system and what each one is responsible for"),
      P("Why this shape", "h2"),
      B("<b>The screens stayed as they were</b> — users already know them and they mirror the client's paper forms. Only the data layer underneath changed."),
      B("<b>One action endpoint</b> (<font face='Mono'>POST /api/actions/&lt;name&gt;</font>) instead of dozens of URLs: every change goes through the same permission → validation → lock → transaction → audit path, so no URL can forget a check."),
      B("<b>Shared rules</b> (<font face='Mono'>logic.ts</font>): the rules are not rewritten for the server — the same functions run there, inside a transaction, and the server decides."),
      B("<b>TypeScript</b> on both sides, compiled to plain JavaScript for production — a renamed field breaks the build instead of the factory floor.")]

# 3 — the material flow
s += [PageBreak(), P("2. The material flow — who does what", "h1"),
      P("Each box is a register action; the label above it is the login that performs it. The arrows follow the "
        "material. Every step is a document with its own number, and every step checks the one before it."),
      d_flow(), caption("Figure 2 — the 22-step SOP as registers and logins (read left-to-right, then right-to-left)")]
s.append(table([
    ["Department login", "Can do", "Can view (read-only)"],
    ["Gate", "Gate entry (picks approved PO)", "—"],
    ["Store", "GRN, quantity correction until sent to QC, send to QC, barcode, issue, MRN", "—"],
    ["QC", "A.R. decision (approve / hold once / reject), PDI", "GRN"],
    ["Packing", "Requisition, FG transfer, MRN", "QC"],
    ["FG Warehouse", "Receive transfers, customer orders, dispatch slips", "—"],
    ["Accounts", "Invoice on dispatch, customer orders, edit customer master", "—"],
    ["Purchase", "Indents, purchase orders", "PM stock"],
    ["Security", "Verify and gate out", "Gate register"],
    ["Admin (Owner)", "Everything above + approve POs; demo reset only where switched on", "—"],
], [0.18, 0.56, 0.26]))
s += [P("Every login lands on its own pending work (e.g. QC: materials waiting for a decision; Security: vehicles "
        "awaiting gate-out). Each role receives only the registers its screens need; prices and customer details are "
        "blanked for roles that have no business seeing them.", "small")]

# 4 — one action, end to end
s += [PageBreak(), P("3. What happens when someone clicks Save", "h1"),
      P("Every change — a gate entry, a QC decision, an issue, a dispatch — goes through these steps on the server. "
        "If any check fails, nothing is saved and the user sees the reason (red boxes)."),
      d_request(), caption("Figure 3 — the life of one action (steps 6–13 run inside one database transaction)")]

# 5 — security
s += [PageBreak(), P("4. Security — layer by layer", "h1")]
s.append(table([
    ["Concern", "What protects it"],
    ["Passwords", "scrypt hashes with a per-user salt; policy ≥ 10 characters and 3 character classes; temporary passwords must be changed at first login; never logged"],
    ["Sessions", "256-bit random token in an httpOnly, SameSite=Strict, Secure cookie — scripts on the page cannot read it; only its SHA-256 is stored; 2 h idle / 12 h maximum; new token on every login; password change signs out other devices"],
    ["Password guessing", "5 wrong passwords lock the login for 15 minutes (atomic counter); 20 failed logins per network per 15 minutes; unknown and real users get the same answer in the same time"],
    ["Forged requests", "strict cookie + a required custom header + Origin must equal the app's address; cross-site access (CORS) is never enabled"],
    ["Who may do what", "every action checked on the server against the permission table; hidden buttons are only cosmetic"],
    ["Who may see what", "each role gets only its registers; PO rates and supplier prices only for Purchase/Admin; customer names, addresses and invoice numbers only for FG WH, Accounts, Security, Admin; product recipes only for roles that raise requisitions — nothing is compiled into the public web page"],
    ["Bad input", "strict schemas: unknown fields, wrong types, oversized values, unknown codes and bad dates are refused"],
    ["Tampering with facts", "the server sets dates/times, names, totals and the approver; the browser cannot back-date or inflate"],
    ["Encryption at rest", "AES-256-GCM: customer name/address/PO, invoice numbers, PO and supplier rates, vehicle and LR numbers, audit details, snapshots"],
    ["Database account", "table-level privileges only; no DELETE on registers on the live system; masters read-only; audit log insert-only"],
    ["Destructive reset", "only where switched on, admin only, admin's password + typed phrase, rate-limited, automatic encrypted snapshot first"],
    ["Audit", "every login, logout, password change and action — allowed, refused, denied or invalid — with user, role, IP and time"],
    ["HTTP", "strict Content-Security-Policy, HSTS, no framing, no-sniff; API answers never cached; errors never reveal internals"],
], [0.2, 0.8]))

# 6 — database
s += [PageBreak(), P("5. Database — each fact stored once", "h1"),
      P("Every register is its own table with typed columns; document lines are child tables. Documents point to "
        "masters by key, so renaming a product, component, supplier or customer changes one row and every document "
        "shows the new name at once. Nothing derived is stored."),
      d_database(), caption("Figure 4 — table groups and how they refer to each other")]
s.append(table([
    ["Shown on screen", "Where it actually lives"],
    ["Supplier, invoice and PO on a GRN", "the GRN's gate entry"],
    ["Component name on any document", "components (by code)"],
    ["Quantity on a QC slip", "the GRN it was raised for"],
    ["QC status of a GRN", "its latest A.R. result (database view)"],
    ["Returned quantity on a requisition", "the sum of its MRN lines"],
    ["Customer name and address on orders/dispatches", "customers (encrypted), found by a keyed hash"],
    ["Line totals (boxes × per box + loose)", "computed by MySQL itself (generated column)"],
    ["Store stock, FG stock, PO pending, order balance", "computed from the documents — never a second ledger"],
], [0.45, 0.55]))
s += [P("Conversion of the existing data was verified before the old storage was dropped: document counts, store "
        "stock, FG stock, PO and order balances had to match exactly, or nothing was kept.", "small")]

# 7 — stage locks
s += [PageBreak(), P("6. Passed stages are locked", "h1"),
      P("Once a document passes a stage, the facts of that stage cannot be altered — enforced twice: by the business "
        "rules (with a clear message) and by MySQL triggers (so not even a bug, a direct SQL edit or a compromised "
        "app account can alter them)."),
      d_lifecycles(), caption("Figure 5 — document lifecycles; every arrow is one-way")]
s.append(table([
    ["Rule", "Applies to"],
    ["Written once, never edited", "gate entries, QC slips, QC results, MRNs, PDI, customer orders, every document line, PO lines"],
    ["Filled in once, then frozen", "PO approval, indent → PO link, issued quantities and store sign, FG receipt, invoice, gate-out"],
    ["Locked from a stage on", "GRN quantity once sent to QC"],
    ["Never deleted", "register entries (only the protected demo reset, where switched on)"],
    ["Append-only for every account", "audit log and safety snapshots — even the database administrator"],
], [0.32, 0.68]))
s += [P("Corrections after a stage need a cancelling / reversing document with a reason — planned, not yet built.", "small")]

# 8 — simultaneous users
s += [PageBreak(), P("7. Many people at the same time", "h1"),
      P("<b>Locks only where needed.</b> An action locks just the documents it changes, the stock of the components it "
        "issues, or the FG batch it ships or inspects. Admin approving a PO and QC approving a GRN never wait for each "
        "other; two issues of the same component take turns, so stock can never be overdrawn. Locks are always taken "
        "in the same order, so two actions can never wait on each other forever."),
      P("<b>Stale screens are refused.</b> Every document carries the change number of its last change; every action "
        "carries the change number its screen was built from. If a document it touches moved on since, the action is "
        "refused and the screen refreshes:"),
      d_concurrency(), caption("Figure 6 — two QC screens act on the same slip at the same moment"),
      P("<b>Numbers never collide or skip.</b> Each document series (GE, GR, QCI, …, PO) has its own sequence row, "
        "locked only while one document of that series is created; a failed action gives its number back."),
      P("<b>Screens stay in sync cheaply:</b>"),
      d_sync(), caption("Figure 7 — how each screen keeps up with the other departments")]

# 9 — tests
s += [PageBreak(), P("8. How it is verified", "h1"),
      P("Five automated suites run against a real server and database. All pass: <b>104 checks</b>.")]
s.append(table([
    ["Suite", "Checks", "What it proves"],
    ["security", "31", "login, lockout, forged requests, role limits on actions and on data, server-set dates/totals, over-issue and over-dispatch refused, gate-out needs invoice, logout"],
    ["parallel", "15", "GRN quantity locked after Send to QC; stale QC decision refused and recovered; hold only once; final QC decision final; barcode once; only changed documents sent; 12 simultaneous saves with gap-free numbers; a busy document does not block another"],
    ["integrity", "36", "product / supplier / customer renames consistent everywhere; customer edit guarded; MySQL rejects broken references, impossible values and every stage-lock violation; even the database admin cannot edit the audit log; failed transactions leave nothing behind"],
    ["reset", "11", "no one-click wipe; wrong phrase or password refused; non-admin refused; snapshot taken"],
    ["concurrency", "11", "parallel GRNs unique; two parallel issues cannot overdraw; lockout; password change signs out other sessions; forged token refused"],
], [0.14, 0.09, 0.77]))

# 10 — production
s += [Spacer(1, 6), P("9. Going live", "h1"),
      d_deploy(), caption("Figure 8 — production layout on one small server in India"),
      table([
          ["Step", "Command / action"],
          ["Configure", "npm run env:init -- --production  → set APP_ORIGIN (https://…) and database admin in .env"],
          ["Database", "npm run db:setup  → tables, triggers, restricted app account, logins with one-time passwords"],
          ["Build + run", "npm run build · npm start behind Caddy (HTTPS); keep ALLOW_DEMO_RESET=false"],
          ["Harden", "remove the DB admin from .env, chmod 600 .env, only ports 80/443 open"],
          ["Backups", "daily mysqldump off the server; keep DATA_ENCRYPTION_KEY separately; test one restore"],
      ], [0.18, 0.82])]

# 11 — journey + next
s += [PageBreak(), P("10. What was built, in order — and why", "h1")]
s.append(table([
    ["#", "Built", "Why"],
    ["1", "Express backend, MySQL, logins, permissions, validation, audit, encryption", "Make the demo a real multi-user system that is secure from the start"],
    ["2", "Protected reset: password + phrase + snapshot", "A one-click wipe of every department's data was too dangerous"],
    ["3", "Relational schema; names in masters only; JSON only at the API", "Renames must stay consistent; no copy of a fact may disagree with another"],
    ["4", "Customer master with safe editing", "Name/address corrections apply everywhere; no lost updates"],
    ["5", "Stale-screen guard, per-document locks, number sequences, change-only sync", "Departments act at the same time without waiting or overwriting each other"],
    ["6", "Stage locks in rules and database triggers", "A passed stage must never be altered — whoever tries"],
], [0.05, 0.5, 0.45]))
s += [P("Next steps", "h2")]
for t in [
    "<b>Fit into the client's Google Forms / Sheets flow</b>: map each form to its register, import masters and the go-live opening position, pilot Gate + Store, then switch departments over one by one and close each form.",
    "<b>Order reservation</b>: show available stock at order entry and reserve on save (back-order when short) — awaiting the client's policy.",
    "<b>Cancel / reverse documents</b> with a reason — the correct way to correct a passed stage.",
    "<b>Lot-level traceability</b>: allocate each issue to specific GRN lots, so a defective supplier lot leads to the exact FG batches.",
    "<b>Gate completeness</b>: inward vehicle time-out; outward vehicle, driver and transporter on dispatch.",
    "<b>Purchase fixes</b>: count only QC-approved quantity against a PO; flag over-delivery; capture supplier lot, MFG and expiry at Send to QC.",
    "<b>Growth</b>: server-side stock figures and page-by-page history for many years of data; printable forms.",
]:
    s.append(B(t))

doc.build(s)
print("written", OUT)
