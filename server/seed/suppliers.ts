import type { Supplier } from "../../src/flow/types";

/**
 * Approved vendor list with fixed rates — the client's "price master".
 * Demo values until the client's real list arrives. Loaded into the `suppliers`
 * table by `npm run db:setup` (rates encrypted); never shipped to the browser.
 */
export const SEED_SUPPLIERS: Supplier[] = [
  {
    name: "MAXCOMM INDIA PVT LTD",
    city: "Delhi",
    rates: { PMS0158: 2.1, PMS0159: 0.35, PMS0160: 1.6, PMS0164: 3.5, PMS0848: 4.0 },
  },
  { name: "Aplay Creation", city: "Delhi", rates: { PMS0849: 0.09, PMS0161: 0.12 } },
  { name: "Shree Packwell", city: "Noida", rates: { PMS0002: 1.2, PMS0003: 0.4, PMS0165: 2.8 } },
  { name: "China Imports Co", city: "Mumbai", rates: { PMS0014: 38.0 } },
];
