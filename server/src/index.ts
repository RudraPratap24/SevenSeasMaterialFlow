import { createApp } from "./app";
import { config } from "./config";
import { pool } from "./db";
import { MODULES } from "./modules";
import { purgeExpiredSessions } from "./sessions";

async function main() {
  // Fail fast if the database is unreachable or not set up.
  await pool.query("SELECT 1 FROM app_meta LIMIT 1");

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(
      JSON.stringify({ msg: "Seven Seas API listening", host: config.HOST, port: config.PORT, env: config.NODE_ENV }),
    );
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  const purge = setInterval(() => purgeExpiredSessions().catch(() => undefined), 60 * 60 * 1000);
  purge.unref();

  // module jobs (what Apps Script time triggers used to do)
  for (const m of MODULES) {
    for (const j of m.jobs ?? []) {
      const run = () =>
        j.run().then(
          (r) => console.log(JSON.stringify({ msg: "job", module: m.id, job: j.name, result: r })),
          (e) => console.error(JSON.stringify({ msg: "job failed", module: m.id, job: j.name, error: String(e) })),
        );
      if (j.everyMinutes) setInterval(run, j.everyMinutes * 60 * 1000).unref();
      if (j.at) {
        let last = "";
        setInterval(() => {
          const now = new Date();
          const hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
          if (hm === j.at && last !== now.toDateString()) {
            last = now.toDateString();
            run();
          }
        }, 30 * 1000).unref();
      }
    }
  }

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ msg: "shutting down", signal }));
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Startup failed:", err instanceof Error ? err.message : err);
  console.error("Has the database been set up? Run: npm run db:setup");
  process.exit(1);
});
