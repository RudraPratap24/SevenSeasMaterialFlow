import { z } from "zod";
import { reducers, nowHHMM, todayLabel, dateKey, FlowError, type ActionName } from "../../src/flow/logic";
import type { Action } from "../../src/flow/perms";
import type { FlowState, Supplier } from "../../src/flow/types";
import type { MasterData } from "./repository";
import type { SessionUser } from "./sessions";

/**
 * Every state change the browser can ask for. Each entry says who may do it
 * (`perm`, checked against the shared PERMS table), the exact shape of its input
 * (strict zod schemas — unknown fields, wrong types and oversized values are
 * refused) and `prepare`, where the server takes over everything the client
 * must not decide: document dates and times come from the server clock, names
 * and codes from the master data, totals are recomputed, and approvals are
 * signed with the logged-in identity.
 */

export interface ActionContext {
  user: SessionUser;
  state: FlowState;
  suppliers: Supplier[];
  /** Components, products, BOM — from the database, as of this transaction. */
  masters: MasterData;
  today: string;
  now: string;
}

type AnyArgs = unknown[];

interface ActionDef {
  perm: Action;
  args: z.ZodType<AnyArgs>;
  prepare?: (args: AnyArgs, ctx: ActionContext) => AnyArgs;
  /** Loads the supplier master into the context. */
  needsSuppliers?: boolean;
}

/* ── field rules ────────────────────────────────────────────────────────────── */

const text = (max = 120) => z.string().trim().max(max);
const required = (max = 120) => z.string().trim().min(1, "is required").max(max);
const docNo = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9\-/_ .]*$/, "is not a valid document number");
const dateLabel = z
  .string()
  .trim()
  .regex(/^(\d{2}-\d{2}-\d{4})?$/, "must be dd-mm-yyyy")
  .refine((d) => {
    if (!d) return true;
    const [dd, mm, yyyy] = d.split("-").map(Number);
    const t = new Date(Date.UTC(yyyy, mm - 1, dd));
    return t.getUTCDate() === dd && t.getUTCMonth() === mm - 1;
  }, "is not a real date");
const requiredTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "is required (hh:mm)");
const qty = z.number().int("must be a whole number").min(0).max(100_000_000);
const positiveQty = qty.min(1, "must be more than zero");
/** A quantity in the PO's unit (Kg, Doz …): up to 3 decimals. */
const threeDecimals = (n: number) => Math.round(n * 1000) / 1000 === n;
const unitQtyOrZero = z.number().min(0).max(100_000_000).refine(threeDecimals, "has more than 3 decimals");
const unitQty = z.number().positive("must be more than zero").max(100_000_000).refine(threeDecimals, "has more than 3 decimals");
const componentCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,16}$/, "is not a valid component code");
const productName = required(160);
const remark = text(500);
const sign = required(80);

/** Master lookups — an unknown code or product is a user-facing refusal, checked against the database. */
function component(ctx: ActionContext, code: string) {
  const c = ctx.masters.componentByCode.get(code);
  if (!c) throw new FlowError(`${code} is not a known component code.`);
  return c;
}
function product(ctx: ActionContext, name: string) {
  const p = ctx.masters.productByName.get(name);
  if (!p) throw new FlowError(`"${name}" is not a known product.`);
  return p;
}

/**
 * An approved supplier — and, once vendors come from Tally, one that is a ledger in Tally, so every PO can be created
 * there. (A database with no Tally vendors yet — demo, tests — keeps using the approved list.)
 */
function tallyVendor(ctx: ActionContext, name: string) {
  const s = ctx.suppliers.find((x) => x.name === name);
  if (!s) throw new FlowError(`${name} is not an approved supplier.`);
  if (!s.fromTally && ctx.suppliers.some((x) => x.fromTally)) throw new FlowError(`${name} is not a vendor in Tally — pick a Tally vendor.`);
}

/* ── the registry ───────────────────────────────────────────────────────────── */

export const ACTIONS: Record<ActionName, ActionDef> = {
  addGateEntry: {
    perm: "gate.create",
    args: z.tuple([
      z.strictObject({
        date: text(10),
        // Required only without a PO (checked in the reducer); against a PO both come from the PO.
        supplierName: text(120),
        productDesc: text(300),
        // Not compulsory: free material (e.g. POP with a PO) arrives without an invoice.
        invoiceNo: text(60),
        invoiceDate: dateLabel,
        poNo: text(40),
        invoiceQty: qty.nullable(),
        transportName: text(120),
        lrNo: text(60),
        vehicleNo: required(30),
        timeIn: requiredTime,
        timeOut: z.literal(""), // recorded later, by recordVehicleOut
        driverSign: z.boolean(),
        remark,
        // Name/code/unit are replaced by the PO's own in the reducer; qty and remark are the guard's.
        lines: z
          .array(
            z.strictObject({
              itemName: required(160),
              itemCode: text(16),
              unit: text(16),
              qty: unitQty,
              remark: text(300),
            }),
          )
          .max(200),
      }),
    ]),
    prepare: ([e], ctx) => {
      const g = e as { invoiceDate: string; timeIn: string };
      if (dateKey(g.invoiceDate) > dateKey(ctx.today)) throw new FlowError("Invoice date cannot be after today.");
      if (g.timeIn > ctx.now) throw new FlowError(`Time in cannot be later than now (${ctx.now}).`);
      return [{ ...(e as object), date: ctx.today }];
    },
  },

  recordVehicleOut: {
    perm: "gate.create",
    args: z.tuple([docNo, z.boolean(), text(5)]),
    prepare: ([id, signed], ctx) => [id, signed, ctx.now], // the server clock, not the browser's
  },

  addGrnLine: {
    perm: "grn.create",
    args: z.tuple([
      z.strictObject({
        gateEntryId: docNo,
        gateLineNo: z.number().int().min(1).max(200).nullable(),
        componentCode,
        componentName: text(160),
        type: text(40),
        brandName: text(60),
        receivedDate: text(10),
        poNo: text(40),
        poQty: unitQty.nullable(),
        invoiceNo: text(60),
        supplierName: text(120),
        qtyPerBox: positiveQty.nullable(),
        totalBoxes: positiveQty.nullable(),
        totalQty: unitQty,
        unit: text(16), // set by the reducer from the gate-checked item
        remarkStore: remark,
        location: text(80),
      }),
    ]),
    prepare: ([l], ctx) => {
      const line = l as Record<string, unknown> & { componentCode: string; gateEntryId: string };
      const comp = component(ctx, line.componentCode);
      const gate = ctx.state.gateEntries.find((g) => g.id === line.gateEntryId);
      if (!gate) throw new FlowError(`Gate entry ${line.gateEntryId} not found.`);
      const perBox = line.qtyPerBox as number | null;
      const boxes = line.totalBoxes as number | null;
      return [
        {
          ...line,
          componentName: comp.name,
          type: comp.type,
          receivedDate: ctx.today,
          // The GRN carries forward from its gate entry — never retyped.
          poNo: gate.poNo,
          invoiceNo: gate.invoiceNo,
          supplierName: gate.supplierName,
          totalQty: perBox !== null && boxes !== null ? perBox * boxes : line.totalQty,
        },
      ];
    },
  },

  updateGrnQty: { perm: "grn.qty", args: z.tuple([docNo, unitQtyOrZero]) },

  sendToQc: {
    perm: "grn.sendqc",
    args: z.tuple([
      docNo,
      z.strictObject({ batchNo: text(40), mfgDate: dateLabel, expiryDate: dateLabel }),
    ]),
  },

  recordAr: {
    perm: "qc.decide",
    args: z.tuple([docNo, z.enum(["APPROVED", "HOLD", "REJECTED"]), remark]),
  },

  setBarcoded: { perm: "grn.barcode", args: z.tuple([docNo, z.boolean()]) },

  addRequisition: {
    perm: "req.create",
    args: z.tuple([
      z.strictObject({
        date: text(10),
        department: required(40),
        productName: z.union([z.literal(""), productName]),
        batchNo: text(40),
        lines: z
          .array(
            z.strictObject({
              materialName: text(160),
              materialCode: componentCode,
              unit: text(12),
              qtyRequired: positiveQty,
              qtyIssued: qty.nullable(),
              returnQty: qty.nullable(),
              remark,
            }),
          )
          .min(1)
          .max(200),
        packingSign: text(80),
        storeSign: text(80),
      }),
    ]),
    prepare: ([r], ctx) => {
      const req = r as { productName: string; lines: { materialCode: string }[] } & Record<string, unknown>;
      if (req.productName) product(ctx, req.productName);
      return [
        {
          ...req,
          date: ctx.today,
          storeSign: "", // the store signs when it issues
          lines: req.lines.map((l) => ({
            ...l,
            materialName: component(ctx, l.materialCode).name,
            qtyIssued: null,
            returnQty: null,
          })),
        },
      ];
    },
  },

  issueRequisition: {
    perm: "req.issue",
    args: z.tuple([docNo, z.array(qty).max(200), sign]),
  },

  addMrn: {
    perm: "mrn.create",
    args: z.tuple([
      z.strictObject({
        date: text(10),
        requisitionId: docNo,
        lines: z
          .array(z.strictObject({ componentCode, componentName: text(160), qty: positiveQty }))
          .min(1)
          .max(200),
        sign,
        remark,
      }),
    ]),
    prepare: ([m], ctx) => {
      const mrn = m as { lines: { componentCode: string }[] } & Record<string, unknown>;
      return [
        {
          ...mrn,
          date: ctx.today,
          lines: mrn.lines.map((l) => ({ ...l, componentName: component(ctx, l.componentCode).name })),
        },
      ];
    },
  },

  addFgTransfer: {
    perm: "fg.create",
    args: z.tuple([
      z.strictObject({
        date: text(10),
        lines: z
          .array(
            z.strictObject({
              productCode: text(80),
              productName,
              sku: text(80),
              batchNo: required(40),
              mfgDate: text(10),
              qtyPerBox: positiveQty,
              totalBoxes: qty,
              looseQty: qty,
              totalQty: positiveQty,
              remark,
            }),
          )
          .min(1)
          .max(50),
        submittedBy: text(80),
        checkedBy: text(80),
        location: text(80),
      }),
    ]),
    prepare: ([t], ctx) => {
      const tr = t as { lines: { productName: string; totalBoxes: number; looseQty: number }[] } & Record<string, unknown>;
      return [
        {
          ...tr,
          date: ctx.today,
          checkedBy: "", // FG warehouse signs on receiving
          location: "",
          lines: tr.lines.map((l) => {
            const p = product(ctx, l.productName);
            const perBox = p.boxSize ?? 12;
            const totalQty = l.totalBoxes * perBox + l.looseQty;
            if (totalQty <= 0) throw new FlowError("Transfer quantity must be more than zero.");
            return { ...l, productCode: p.fg, sku: p.fg, qtyPerBox: perBox, totalQty, mfgDate: ctx.today.slice(3) };
          }),
        },
      ];
    },
  },

  receiveFgTransfer: {
    perm: "fg.receive",
    args: z.tuple([docNo, sign, text(10), required(80)]),
    prepare: ([id, checkedBy, , location], ctx) => [id, checkedBy, ctx.today, location],
  },

  recordPdi: {
    perm: "qc.pdi",
    args: z.tuple([productName, required(40), z.enum(["PASSED", "FAILED"]), remark]),
  },

  addOrder: {
    perm: "order.create",
    args: z.tuple([
      z.strictObject({
        date: text(10),
        partyName: required(120),
        partyAddress: text(300),
        custPoNo: text(60),
        deliveryDate: dateLabel,
        lines: z
          .array(z.strictObject({ productName, productCode: text(80), qty: positiveQty }))
          .min(1)
          .max(50),
        remark,
      }),
    ]),
    prepare: ([o], ctx) => {
      const order = o as { lines: { productName: string }[] } & Record<string, unknown>;
      return [
        {
          ...order,
          date: ctx.today,
          lines: order.lines.map((l) => ({ ...l, productCode: product(ctx, l.productName).fg })),
        },
      ];
    },
  },

  addDispatch: {
    perm: "dispatch.create",
    args: z.tuple([
      z.strictObject({
        date: text(10),
        orderId: z.union([z.literal(""), docNo]),
        partyName: required(120),
        partyAddress: text(300),
        lines: z
          .array(
            z.strictObject({
              productName,
              productCode: text(80),
              batchNo: required(40),
              qtyPerBox: positiveQty,
              totalBoxes: positiveQty,
              totalQty: positiveQty,
            }),
          )
          .min(1)
          .max(50),
        dispatchSign: text(80),
        remark,
      }),
    ]),
    prepare: ([d], ctx) => {
      const slip = d as { lines: { productName: string; batchNo: string; totalBoxes: number }[] } & Record<string, unknown>;
      return [
        {
          ...slip,
          date: ctx.today,
          lines: slip.lines.map((l) => {
            // Pack size comes from the batch's own FG transfer, as on the screen.
            const tl = ctx.state.fgTransfers
              .flatMap((t) => t.lines)
              .find((x) => x.productName === l.productName && x.batchNo === l.batchNo);
            const perBox = tl?.qtyPerBox ?? 12;
            return {
              ...l,
              productCode: tl?.productCode ?? product(ctx, l.productName).fg,
              qtyPerBox: perBox,
              totalQty: l.totalBoxes * perBox,
            };
          }),
        },
      ];
    },
  },

  addInvoice: {
    perm: "invoice.add",
    args: z.tuple([docNo, required(60), text(10)]),
    prepare: ([id, no], ctx) => [id, no, ctx.today],
  },

  gateOut: {
    perm: "gateout",
    args: z.tuple([docNo, sign, text(5)]),
    prepare: ([id, s], ctx) => [id, s, ctx.now],
  },

  addIndent: {
    perm: "purchase.indent",
    needsSuppliers: true,
    args: z.tuple([
      z.strictObject({
        date: text(10),
        componentCode,
        componentName: text(160),
        qty: positiveQty,
        reason: text(200),
        supplierName: required(120),
        rate: z.number().positive("is required (₹ per unit)").max(10_000_000),
      }),
    ]),
    prepare: ([i], ctx) => {
      const ind = i as { componentCode: string; supplierName: string } & Record<string, unknown>;
      tallyVendor(ctx, ind.supplierName);
      return [{ ...ind, date: ctx.today, componentName: component(ctx, ind.componentCode).name }];
    },
  },

  raisePo: {
    perm: "purchase.po",
    needsSuppliers: true,
    args: z.tuple([
      z.strictObject({
        date: text(10),
        supplierName: required(120),
        lines: z
          .array(
            z.strictObject({
              componentCode,
              componentName: text(160),
              qty: positiveQty,
              // Every new PO line has its rate, so every PO has a total.
              rate: z.number().positive("is required (₹ per unit)").max(10_000_000),
            }),
          )
          .min(1)
          .max(100),
        expectedDate: dateLabel,
        indentIds: z.array(docNo).max(50),
      }),
    ]),
    prepare: ([p], ctx) => {
      const po = p as { supplierName: string; lines: { componentCode: string }[] } & Record<string, unknown>;
      tallyVendor(ctx, po.supplierName);
      return [
        {
          ...po,
          date: ctx.today,
          lines: po.lines.map((l) => ({ ...l, componentName: component(ctx, l.componentCode).name })),
        },
      ];
    },
  },

  approvePo: {
    perm: "purchase.approve",
    args: z.tuple([docNo, text(80)]),
    // Signed with the identity of whoever is logged in — not whatever the client typed.
    prepare: ([id], ctx) => [id, ctx.user.label],
  },

  // Closing, reopening and the cut-over are dated and signed by the server.
  closePo: {
    perm: "purchase.close",
    args: z.tuple([docNo, required(200), text(10), text(80)]),
    prepare: ([po, reason], ctx) => [po, reason, ctx.today, ctx.user.label],
  },

  reopenPo: {
    perm: "purchase.close",
    args: z.tuple([docNo, text(10), text(80)]),
    prepare: ([po], ctx) => [po, ctx.today, ctx.user.label],
  },

  closePosBefore: {
    perm: "purchase.cutover",
    args: z.tuple([dateLabel.refine((d) => d !== "", "is required"), required(200), text(10), text(80)]),
    prepare: ([before, reason], ctx) => [before, reason, ctx.today, ctx.user.label],
  },
};

export function isActionName(name: string): name is ActionName {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

/** Validates and prepares an action, then runs the shared reducer. Throws FlowError on a rule breach. */
export function applyAction(name: ActionName, args: AnyArgs, ctx: ActionContext): FlowState {
  const def = ACTIONS[name];
  const prepared = def.prepare ? def.prepare(args, ctx) : args;
  const reducer = reducers[name] as (s: FlowState, ...a: unknown[]) => FlowState;
  return reducer(ctx.state, ...prepared);
}

export function context(user: SessionUser, state: FlowState, suppliers: Supplier[], masters: MasterData): ActionContext {
  return { user, state, suppliers, masters, today: todayLabel(), now: nowHHMM() };
}

/** Turns zod issues into one readable line — field names only, never echoing values back. */
export function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((i) => {
    const field = i.path.filter((p) => typeof p === "string").pop();
    return field ? `${String(field)} ${i.message}` : i.message;
  });
  return `Invalid input: ${parts.join("; ")}.`;
}
