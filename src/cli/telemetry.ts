import type { Command } from "commander";
import { loadEnv, type Network } from "../config/index.js";
import { openDb } from "../db/index.js";
import { log } from "../log.js";
import { serveTelemetry, telemetryReport } from "../telemetry/index.js";

export function registerTelemetry(program: Command, globals: (cmd: Command) => { network: Network; db: string }) {
  const t = program.command("telemetry").description("opt-in telemetry from other operators' agents (@x402-audit/client)");
  t.command("serve")
    .description("run the ingest server (POST /v1/calls) writing to telemetry_calls")
    .option("--bind <host:port>", "listen address (default TELEMETRY_BIND)")
    .action(async function (this: Command, o: { bind?: string }) {
      const g = globals(this);
      const env = loadEnv();
      const db = openDb(g.db);
      const server = await serveTelemetry(db, { bind: o.bind ?? env.TELEMETRY_BIND, ...(env.TELEMETRY_INGEST_TOKEN ? { token: env.TELEMETRY_INGEST_TOKEN } : {}), log });
      log.info(`telemetry ingest listening at ${server.url} (token ${env.TELEMETRY_INGEST_TOKEN ? "required" : "not set"})`);
      await new Promise<void>((resolve) => {
        const stop = () => void server.close().then(resolve);
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
    });
  t.command("report").description("records and failure rates per operator source").action(function (this: Command) {
    const g = globals(this);
    console.log(telemetryReport(openDb(g.db)));
  });
  return t;
}
