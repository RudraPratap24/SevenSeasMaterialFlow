/** Login roles (the users.role column). Modules decide their own finer rights; `admin` opens the admin page. */
export const ROLES = ["gate", "store", "qc", "packing", "fgwh", "accounts", "purchase", "security", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  gate: "Gate Entry",
  store: "Store",
  qc: "QC",
  packing: "Packing / Production",
  fgwh: "FG Warehouse",
  accounts: "Accounts",
  purchase: "Purchase",
  security: "Security",
  admin: "Admin (Owner)",
};
