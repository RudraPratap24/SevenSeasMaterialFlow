/** Purchase System — the client's sheet + Apps Script, served by our backend. Details: ../MODULE.md */
import { config } from "../../../server/src/config";
import type { ModuleDef } from "../../../server/src/module";
import { dailyDigest, FUNCTIONS, refresh } from "./api";
import { psRoutes } from "./routes";
import { PS_GRANTS, PS_MIGRATIONS } from "./schema";

export const purchaseSystem: ModuleDef = {
  id: "ps",
  title: "Purchase System",
  page: {
    file: "modules/purchase-system/source/Index.html",
    // doGet: ?page=indent opens the public indent form
    vars: (req) => ({ mode: /^indent$/i.test(String(req.query.page ?? "")) ? "indent" : "app" }),
    patches: [
      {
        why: "item photos uploaded here are our files (F…), older ones stay on Google Drive",
        find: "const thumb = (id, sz) => 'https://drive.google.com/thumbnail?id='",
        replace: "const thumb = (id, sz) => /^F[0-9a-f]{18}$/.test(id) ? '/api/ps/file/' + id : 'https://drive.google.com/thumbnail?id='",
      },
    ],
    csp: { "img-src": ["https://drive.google.com", "https://*.googleusercontent.com"] },
  },
  functions: FUNCTIONS,
  guarded: ["login", "indentLogin"],
  routes: psRoutes,
  bodyLimit: "16mb", // photos and signed POs up to 10 MB, sent as base64
  jobs: [
    { name: "autoRun", everyMinutes: 30, run: refresh }, // closes old indents that already have a PO
    { name: "dailyDigest", at: "09:00", run: () => dailyDigest(config.APP_ORIGIN) }, // task mail to each Doer
  ],
  grants: PS_GRANTS,
  migrations: PS_MIGRATIONS,
};
