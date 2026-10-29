import type { Command } from "commander";
import { erc20Abi } from "viem";
import { evaluateTriggers, fetchDemand, fetchReported, measuredSeries, sellerIdsByHost } from "../audit/triggers.js";
import { planAudits, recordDecisions, renderAuditPlan, runAudits, type AuditPlanItem } from "../audit/run.js";
import { loadServiceConfigs, serviceLookup } from "../buy/services.js";
import { makeChainClient, usdcFor } from "../chain/client.js";
import { makeChainLookupFactory } from "../chain/confirm.js";
import { capsFromEnv, loadEnv, loadFileConfigs, MAINNET } from "../config/index.js";
import { openDb } from "../db/index.js";
import { log } from "../log.js";
import { ephemeralPayers, moneyGate, payersFromEnv, type MoneyGlobals } from "./buy.js";
import { finishRun, startRun } from "./runs.js";

export function registerAudit(program: Command, globals: (cmd: Command) => MoneyGlobals, requireLive: (g: MoneyGlobals) => { live: boolean; reason: string | null }) {
  program
    .command("audit-triggers")
    .description(
      "decide which sellers to audit (series disagree, reported mature and ours thin, reported failures on an ok seller, demand on thin data); " +
        "records every decision in audit_triggers, then buys only with --live, X402_AUDIT_LIVE=1 and AUDIT_TRIGGERS_ENABLED=1",
    )
    .option("--index <url>", "index origin (default PAIDFOR_INDEX_URL)")
    .option("--json", "print the plan as JSON", false)
    .action(async function (this: Command, o: { index?: string; json: boolean }) {
      const g = globals(this);
      const env = loadEnv();
      const files = loadFileConfigs();
      const caps = capsFromEnv(env);
      const db = openDb(g.db);
      const index = o.index ?? env.PAIDFOR_INDEX_URL;
      const now = Date.now();
      const enabled = env.AUDIT_TRIGGERS_ENABLED === "1";
      const [reported, demand] = await Promise.all([fetchReported(index), fetchDemand(index)]);
      const triggers = evaluateTriggers({ reported, demand, measured: measuredSeries(db, { network: g.network, now }), sellers: sellerIdsByHost(db), now });
      const planned = planAudits(db, triggers, {
        caps,
        network: g.network,
        now,
        maxSellersPerDay: env.AUDIT_MAX_SELLERS_PER_DAY,
        maxCallsPerSeller: env.AUDIT_MAX_CALLS_PER_SELLER,
        exclude: files.exclude,
      });
      // Spend only when every gate holds; otherwise the planned rows are recorded as what they are.
      const wantsLive = g.live && enabled;
      const items: AuditPlanItem[] = planned.map((it) =>
        it.decision !== "planned" || wantsLive
          ? it
          : { ...it, decision: g.live ? "disabled" : "dry_run", decisionReason: g.live ? "AUDIT_TRIGGERS_ENABLED is not 1; nothing bought" : "dry run; nothing bought" },
      );
      const runId = startRun(db, "audit-triggers", { index, live: g.live, enabled, reported: reported.length, demand: demand.length }, g.network, !wantsLive);
      const ids = recordDecisions(db, items, { now, runId });
      console.log(o.json ? JSON.stringify(items.map((i) => ({ ...i.trigger, decision: i.decision, decision_reason: i.decisionReason, planned_calls: i.plannedCalls, planned_usdc: i.plannedAtomic.toString(), allocations: i.allocations.map((a) => ({ url: a.url, calls: a.calls, price_atomic: a.priceAtomic.toString() })) })), null, 2) : renderAuditPlan(items));
      if (!wantsLive) {
        finishRun(db, runId, "ok", { triggered: items.length, planned: planned.filter((p) => p.decision === "planned").length, spent: "0" });
        if (g.live && !enabled) log.warn("audit-triggers: AUDIT_TRIGGERS_ENABLED is not 1; decisions recorded, nothing bought");
        return;
      }
      const { live } = moneyGate(g, requireLive);
      const client = makeChainClient({ rpcUrl: g.network === MAINNET ? env.BASE_LOGS_RPC_URL : env.BASE_SEPOLIA_RPC_URL, network: g.network });
      const receiptClient = g.network === MAINNET && env.BASE_RPC_URL !== env.BASE_LOGS_RPC_URL ? makeChainClient({ rpcUrl: env.BASE_RPC_URL, network: g.network }) : undefined;
      const payers = live ? payersFromEnv(env, g.network, caps.perCallAtomic) : ephemeralPayers(g.network, caps.perCallAtomic);
      try {
        const results = await runAudits(db, items, {
          index,
          secret: env.AUDIT_SECRET,
          triggerIds: ids,
          payers,
          caps,
          network: g.network,
          settlementLookupFactory: makeChainLookupFactory({ client, network: g.network, ...(receiptClient ? { receiptClient } : {}) }),
          walletBalance: async (address) => (receiptClient ?? client).readContract({ address: usdcFor(g.network), abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] }),
          services: serviceLookup(loadServiceConfigs()),
          minSecondsBetweenCallsPerResource: files.sample.min_seconds_between_calls_per_resource,
          confirmIntervalMs: 3_000,
          startRun: (host) => startRun(db, "audit", { host }, g.network, !live),
          log,
          dryRun: !live,
        });
        finishRun(db, runId, "ok", { audits: results.length, results });
        console.log(JSON.stringify(results, null, 2));
      } catch (e) {
        finishRun(db, runId, "error", { error: (e as Error).message });
        throw e;
      }
    });
}
