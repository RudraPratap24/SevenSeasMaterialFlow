import { Router } from "express";
import { z } from "zod";
import { FlowError } from "../../src/flow/logic";
import { CUSTOMER_ROLES, roleCan } from "../../src/flow/perms";
import { audit } from "./audit";
import { pool } from "./db";
import { withLocks } from "./flowRoutes";
import { listCustomers, updateCustomer } from "./repository";
import { requirePasswordCurrent, requireUser } from "./sessions";

/** Customer master — read by roles that see customer details, edited by Accounts/Admin. */
export const customerRouter = Router();
customerRouter.use(requireUser, requirePasswordCurrent);

customerRouter.get("/", async (req, res) => {
  if (!CUSTOMER_ROLES.includes(req.user!.role)) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  res.json({ customers: await listCustomers(pool) });
});

const EditBody = z.strictObject({
  name: z.string().trim().min(1, "Party name is required.").max(120),
  address: z.string().trim().max(300),
  version: z.string().min(1).max(40),
});

customerRouter.post("/:id", async (req, res) => {
  const user = req.user!;
  const id = Number(req.params.id);
  if (!roleCan(user.role, "customer.edit")) {
    await audit(req, { action: "customer.edit", outcome: "denied", message: `role ${user.role}` });
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = EditBody.safeParse(req.body);
  if (!Number.isInteger(id) || id <= 0 || !body.success) {
    await audit(req, { action: "customer.edit", outcome: "invalid" });
    res.status(400).json({ error: body.success ? "Invalid customer." : body.error.issues[0].message });
    return;
  }
  try {
    await withLocks([`customer:${id}`], async (conn) => {
      await updateCustomer(conn, id, body.data.name, body.data.address, body.data.version);
      // The payload holds a customer's name and address — encrypted in the audit log.
      await audit(req, { action: "customer.edit", outcome: "ok", message: `customer #${id}`, payload: body.data }, conn);
    });
    res.json({ customers: await listCustomers(pool) });
  } catch (err) {
    if (err instanceof FlowError) {
      await audit(req, { action: "customer.edit", outcome: "rejected", message: err.message });
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});
