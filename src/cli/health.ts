import type { Command } from "commander";
import { erc20Abi } from "viem";
import { resolve } from "node:path";
import { makeChainClient, usdcFor } from "../chain/client.js";
import { loadEnv, MAINNET, type Network } from "../config/index.js";
import { openDb } from "../db/index.js";
import { buildHealthBody, HEALTH_TRIGGERS, readLogEnd, type HealthTrigger } from "../health/body.js";
import { postHealth } from "../health/post.js";

export function registerHealth(program: Command, globals: (cmd: Command) => { network: Network; db: string }) {
  program
    .command("health")
    .description(
      "post machine and loop health (unit, disk, memory, halt files, runs, caps and spend, pool balances, the last run's redacted log lines) " +
        "to {index}/v1/admin/health, signed like the audit callback; moves no money, and a failed post is a warning, never an error",
    )
    .option("--trigger <t>", `what ran just before: ${HEALTH_TRIGGERS.join(", ")}`, "manual")
    .option("--index <url>", "index origin (default PAIDFOR_INDEX_URL)")
    .option("--log <path>", "loop log to tail", "data/loop.log")
    .action(async function (this: Command, o: { trigger: string; index?: string; log: string }) {
      const g = globals(this);
      // The global --dry-run defaults to true for every command; here only an explicit --dry-run means "print, do not post".
      const dryRun = this.getOptionValueSourceWithGlobals("dryRun") === "cli";
      if (!(HEALTH_TRIGGERS as readonly string[]).includes(o.trigger)) throw new Error(`--trigger must be one of ${HEALTH_TRIGGERS.join(", ")}, got ${o.trigger}`);
      const env = loadEnv();
      const index = o.index ?? env.PAIDFOR_INDEX_URL;
      if (!dryRun && !env.AUDIT_SECRET) {
        console.log("health: AUDIT_SECRET not set, not posting");
        return;
      }
      const db = openDb(g.db);
      const client = makeChainClient({ rpcUrl: g.network === MAINNET ? env.BASE_LOGS_RPC_URL : env.BASE_SEPOLIA_RPC_URL, network: g.network, timeoutMs: 10_000 });
      const body = await buildHealthBody({
        db,
        env,
        procEnv: process.env,
        network: g.network,
        repo: process.cwd(),
        trigger: o.trigger as HealthTrigger,
        now: Date.now(),
        logLines: readLogEnd(resolve(o.log)),
        balances: (addresses) =>
          Promise.all(
            addresses.map((a) =>
              client.readContract({ address: usdcFor(g.network), abi: erc20Abi, functionName: "balanceOf", args: [a as `0x${string}`] }).then(
                (b) => b,
                () => null,
              ),
            ),
          ),
      });
      if (dryRun) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      const result = await postHealth(index, env.AUDIT_SECRET, JSON.stringify(body));
      // One line either way; a failed post never fails the caller (the loop, the timer).
      if (result.startsWith("posted")) console.log(`health: ${result} (${o.trigger})`);
      else console.warn(`health: warning, post to ${index}/v1/admin/health ${result}; continuing`);
    });
}
