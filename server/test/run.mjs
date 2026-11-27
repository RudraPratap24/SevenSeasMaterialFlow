// Runs every test against its OWN database and server — never the working database.
// Each run drops and recreates <DB_NAME>_test (from baseline.sql + migrations), starts an API on port 4001,
// runs the core suite and every module's tests (modules/*/test/*.mjs) and stops the API. Usage: npm test
import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import mysql from "mysql2/promise";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run tests with NODE_ENV=production.");
  process.exit(1);
}
const TEST_DB = `${process.env.DB_NAME}_test`;
// Children (setup, demo, the API, the tests) inherit these; dotenv never overrides a variable already set.
Object.assign(process.env, {
  DB_NAME: TEST_DB,
  DB_USER: "flow_test",
  DB_PASSWORD: "flow-test-only-local-password",
  HOST: "127.0.0.1",
  PORT: "4001",
  APP_ORIGIN: "http://localhost:4001",
});
const BASE = "http://127.0.0.1:4001";
const SUITES = ["server/test/core.mjs", ...readdirSync("modules").flatMap((m) =>
  existsSync(`modules/${m}/test`) ? readdirSync(`modules/${m}/test`).filter((f) => f.endsWith(".mjs")).map((f) => `modules/${m}/test/${f}`) : [])];
const node = (args, opts = {}) => execFileSync(process.execPath, args, { stdio: "pipe", encoding: "utf8", ...opts });

const admin = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_ADMIN_USER, password: process.env.DB_ADMIN_PASSWORD ?? "",
});
if (!TEST_DB.endsWith("_test")) throw new Error(`not a test database: ${TEST_DB}`);
await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
await admin.end();
console.log(`test database ${TEST_DB}: setting up…`);
node(["--import", "tsx", "server/scripts/setup.ts", "--dev-passwords"]);

const api = spawn(process.execPath, ["--import", "tsx", "server/src/index.ts"], { stdio: "ignore" });
for (let i = 0; ; i++) {
  if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) break;
  if (i > 60) throw new Error("test API did not start");
  await new Promise((r) => setTimeout(r, 500));
}

let failed = 0;
for (const suite of SUITES) {
  let out;
  try {
    out = node(["--import", "tsx", suite, BASE]);
  } catch (e) {
    failed++;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const summary = out.trim().split("\n").filter((l) => /FAIL|passed|Error/.test(l));
  console.log(`== ${suite}\n${summary.join("\n") || out.trim().split("\n").at(-1)}`);
}
api.kill();
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
