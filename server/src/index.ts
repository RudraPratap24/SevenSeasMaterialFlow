import { createApp } from "./app";
import { config } from "./config";
import { pool } from "./db";
import { purgeExpiredSessions } from "./sessions";

async function main() {
  // Fail fast if the database is unreachable or not set up.
  await pool.query("SELECT 1 FROM app_meta LIMIT 1");

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(
      JSON.stringify({ msg: "Material Flow API listening", host: config.HOST, port: config.PORT, env: config.NODE_ENV }),
    );
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  const purge = setInterval(() => purgeExpiredSessions().catch(() => undefined), 60 * 60 * 1000);
  purge.unref();

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
