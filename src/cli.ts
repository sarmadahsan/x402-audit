import { Command } from "commander";
import { atomicToUsd, capsFromEnv, loadEnv, loadFileConfigs, MAINNET, NETWORKS, SEPOLIA, type Network } from "./config/index.js";
import { openDb } from "./db/index.js";
import { log } from "./log.js";
import { sampleSizeForHalfWidth, wilsonInterval } from "./report/wilson.js";
import { liveGateReason } from "./safety.js";
import { registerChain } from "./cli/chain.js";
import { registerDiscover } from "./cli/discover.js";
import { registerProbe } from "./cli/probe.js";
import { registerTelemetry } from "./cli/telemetry.js";
import { registerReport } from "./cli/report.js";
import { registerExport } from "./cli/export.js";
import { registerBuy, registerStress } from "./cli/buy.js";
import { registerAudit } from "./cli/audit.js";
import { registerHealth } from "./cli/health.js";

export interface GlobalOpts {
  dryRun: boolean;
  live: boolean;
  network: Network;
  db: string;
}

function globalOpts(cmd: Command): GlobalOpts {
  const o = cmd.optsWithGlobals() as { dryRun?: boolean; live?: boolean; network?: string; db?: string };
  const env = loadEnv();
  const network = (o.network ?? env.X402_AUDIT_NETWORK) as Network;
  if (!NETWORKS.includes(network)) throw new Error(`unknown network ${network}; expected one of ${NETWORKS.join(", ")}`);
  // --live flips dry-run off; otherwise dry-run is the default.
  const live = Boolean(o.live);
  return { dryRun: !live, live, network, db: o.db ?? env.X402_AUDIT_DB };
}

/** Subcommands that can move money call this; it throws unless every gate passes. Probe/discover/chain/report never call it. */
export function requireLiveOrDryRun(g: GlobalOpts): { live: boolean; reason: string | null } {
  const env = loadEnv();
  const reason = liveGateReason({ liveFlag: g.live, envLive: env.X402_AUDIT_LIVE, network: g.network, dryRun: g.dryRun });
  if (reason && g.live && g.network === MAINNET) throw new Error(`refusing live mainnet run: ${reason}`);
  return { live: reason === null, reason };
}

export function buildProgram(): Command {
  const program = new Command("x402-audit")
    .description("Measurement harness: share of paid x402 calls on Base that fail the buyer")
    .option("--dry-run", "do not move money (default)", true)
    .option("--live", "allow real payments (also needs X402_AUDIT_LIVE=1 and --network eip155:8453 for mainnet)", false)
    .option("--network <caip2>", `network id, one of ${NETWORKS.join(", ")} (default from env, else ${SEPOLIA})`)
    .option("--db <path>", "sqlite file (default from env)");

  program
    .command("status")
    .description("print effective config, caps, network, live gate, and row counts")
    .action(function (this: Command) {
      const g = globalOpts(this);
      const env = loadEnv();
      const caps = capsFromEnv(env);
      const files = loadFileConfigs();
      const gate = requireLiveOrDryRun(g);
      const db = openDb(g.db);
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
      console.log(
        JSON.stringify(
          {
            network: g.network,
            dryRun: g.dryRun,
            liveAllowed: gate.live,
            liveBlockedBecause: gate.reason,
            db: g.db,
            configHash: files.configHash,
            caps: {
              perCallUsd: atomicToUsd(caps.perCallAtomic),
              perSellerPerDayUsd: atomicToUsd(caps.perSellerPerDayAtomic),
              perDayUsd: atomicToUsd(caps.perDayAtomic),
              totalUsd: atomicToUsd(caps.totalAtomic),
              stressTotalUsd: atomicToUsd(caps.stressTotalAtomic),
            },
            walletsConfigured: env.X402_AUDIT_WALLET_KEYS ? env.X402_AUDIT_WALLET_KEYS.split(",").filter(Boolean).length : 0,
            rows: Object.fromEntries(["sellers", "resources", "probes", "attempts", "calls", "settlements", "halts", "chain_transfers", "telemetry_calls"].map((t) => [t, count(t)])),
          },
          null,
          2,
        ),
      );
    });

  program
    .command("samplesize")
    .description("calls needed for a target failure rate and 95% Wilson half-width")
    .requiredOption("--rate <p>", "expected failure rate, e.g. 0.10", parseFloat)
    .requiredOption("--halfwidth <h>", "desired half-width, e.g. 0.01", parseFloat)
    .option("--n <n>", "instead: print the half-width at this n", (v) => parseInt(v, 10))
    .action((o: { rate: number; halfwidth: number; n?: number }) => {
      if (o.n) {
        const w = wilsonInterval(Math.round(o.rate * o.n), o.n);
        console.log(JSON.stringify({ rate: o.rate, n: o.n, lo: w.lo, hi: w.hi, halfWidth: w.halfWidth }));
        return;
      }
      const n = sampleSizeForHalfWidth(o.rate, o.halfwidth);
      console.log(JSON.stringify({ rate: o.rate, halfWidth: o.halfwidth, callsNeeded: n }));
    });

  registerDiscover(program, (cmd) => globalOpts(cmd));
  registerProbe(program, (cmd) => globalOpts(cmd));
  registerBuy(program, (cmd) => globalOpts(cmd), requireLiveOrDryRun);
  registerStress(program, (cmd) => globalOpts(cmd), requireLiveOrDryRun);
  registerAudit(program, (cmd) => globalOpts(cmd), requireLiveOrDryRun);
  registerChain(program, (cmd) => globalOpts(cmd));
  registerTelemetry(program, (cmd) => globalOpts(cmd));
  registerReport(program, (cmd) => globalOpts(cmd));
  registerExport(program, (cmd) => globalOpts(cmd));
  registerHealth(program, (cmd) => globalOpts(cmd));
  return program;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv, { from: "user" });
  } catch (e) {
    log.error((e as Error).message);
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && /src\/cli\.ts$|dist\/src\/cli\.js$/.test(process.argv[1]);
if (isDirect) void main(process.argv.slice(2));
