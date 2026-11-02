import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
const shutdown = () => {
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// One broken backend stream must fail that one reply, never the whole app. A stream closed
// mid-answer surfaces as an unhandled rejection from inside the runtime's run loop (undici
// "terminated" / UND_ERR_SOCKET); Node's default for that is death, and that hard death is
// what has been corrupting this app's database on every stall (2026-11-02, same signature
// as the Dots crashes). Logged loudly rather than swallowed; the process keeps serving.
process.on("unhandledRejection", (reason) => {
  console.error(
    `[unhandled-rejection] ${
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    } — server kept running`,
  );
});
