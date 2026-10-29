import type { Command } from "commander";
import { erc20Abi, formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildBuyPlan, renderPlan, assertPlanWithinCaps, planToJSON } from "../buy/plan.js";
import { runBuy } from "../buy/run.js";
import { loadServiceConfigs, serviceLookup } from "../buy/services.js";
import { blockAtTimestamp, makeChainClient, usdcFor } from "../chain/client.js";
import { makeChainLookupFactory, makeChainSettlementLookup, resolvePendingIndeterminate, resolveUnconfirmedSettlements } from "../chain/confirm.js";
import { atomicToUsd, capsFromEnv, loadEnv, loadFileConfigs, MAINNET, usdToAtomic, type Env, type Network } from "../config/index.js";
import { candidateAllocations, expensiveAllocations } from "../buy/lanes.js";
import type { RunLimits } from "../buy/guard.js";
import { openDb, type Db } from "../db/index.js";
import { log } from "../log.js";
import { runStressDuplicate, runStressTimeout, stressReport, selectStressResources } from "../stress/index.js";
import { createPayer, type Payer } from "../x402/pay.js";
import { finishRun, startRun } from "./runs.js";
import { reclassifyCalls } from "../pipeline/reclassify.js";
import { reconcileOrphans } from "../pipeline/reconcile.js";
import { assertGate } from "../gate.js";

export interface MoneyGlobals { network: Network; db: string; live: boolean; dryRun: boolean }

function rpcFor(env: Env, network: Network): string {
  return network === MAINNET ? env.BASE_LOGS_RPC_URL : env.BASE_SEPOLIA_RPC_URL;
}

/** Wallet pool from .env. Keys never leave this function except inside Payer objects; nothing logs them. */
export function payersFromEnv(env: Env, network: Network, perCallCapAtomic: bigint): Payer[] {
  const keys = env.X402_AUDIT_WALLET_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("X402_AUDIT_WALLET_KEYS is empty; see README 'Wallets'");
  return keys.map((k) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("a wallet key in X402_AUDIT_WALLET_KEYS is not a 32-byte hex string");
    return createPayer({ privateKey: k as `0x${string}`, network, maxAmountAtomic: perCallCapAtomic, timeoutMs: 60_000 });
  });
}

/** Dry runs sign nothing; they get throwaway in-memory keys so wallet rotation can be shown without any real key loaded. */
export function ephemeralPayers(network: Network, perCallCapAtomic: bigint, n = 3): Payer[] {
  return Array.from({ length: n }, () => createPayer({ privateKey: generatePrivateKey(), network, maxAmountAtomic: perCallCapAtomic }));
}

/** The gate every money-moving command passes through. Throws unless dry-run or every live condition holds. */
export function moneyGate(g: MoneyGlobals, requireLive: (g: MoneyGlobals) => { live: boolean; reason: string | null }): { live: boolean } {
  const gate = requireLive(g);
  if (!g.dryRun && !gate.live) throw new Error(`refusing to move money: ${gate.reason}`);
  if (gate.live && g.network === MAINNET) {
    assertGate(); // a passing integration suite recorded by `pnpm gate` for this exact commit
    log.warn("LIVE MAINNET RUN: real USDC will be spent under the caps in .env");
  }
  return { live: gate.live };
}

export function registerBuy(program: Command, globals: (cmd: Command) => MoneyGlobals, requireLive: (g: MoneyGlobals) => { live: boolean; reason: string | null }) {
  const b = program.command("buy").description("make real purchases under hard caps (dry-run by default)");

  b.command("plan")
    .description("stratified sampling plan with planned spend per stratum; refuses if it exceeds MAX_TOTAL_USD")
    .option("--seed <n>", "PRNG seed (default: config/sample.yaml)", (v) => parseInt(v, 10))
    .option("--json", "print JSON", false)
    .action(function (this: Command, o: { seed?: number; json: boolean }) {
      const g = globals(this);
      const env = loadEnv();
      const files = loadFileConfigs();
      const db = openDb(g.db);
      const plan = buildBuyPlan(db, { sample: files.sample, caps: capsFromEnv(env), network: g.network, ...(o.seed !== undefined ? { seed: o.seed } : {}), exclude: files.exclude, persistTiers: true });
      console.log(o.json ? JSON.stringify(planToJSON(plan), null, 2) : renderPlan(plan));
      assertPlanWithinCaps(plan, capsFromEnv(env));
      console.log(`\nPlanned total: ${plan.totalCalls} calls, ${atomicToUsd(plan.totalSpendAtomic)} USDC (cap MAX_TOTAL_USD=${env.MAX_TOTAL_USD})`);
    });

  b.command("balances")
    .description("on-chain USDC balance of every pool wallet (moves nothing)")
    .action(async function (this: Command) {
      const g = globals(this);
      const env = loadEnv();
      const client = makeChainClient({ rpcUrl: rpcFor(env, g.network), network: g.network });
      const keys = env.X402_AUDIT_WALLET_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
      const rows = [];
      for (const k of keys) {
        const addr = privateKeyToAccount(k as `0x${string}`).address;
        const bal = await client.readContract({ address: usdcFor(g.network), abi: erc20Abi, functionName: "balanceOf", args: [addr] });
        rows.push({ address: addr, usdc: formatUnits(bal, 6) });
      }
      console.log(JSON.stringify({ network: g.network, wallets: rows }, null, 2));
    });

  b.command("run")
    .description("execute the plan; dry-run unless --live AND X402_AUDIT_LIVE=1 AND (for mainnet) --network eip155:8453")
    .option("--seed <n>", "PRNG seed (default: config/sample.yaml)", (v) => parseInt(v, 10))
    .option("--max-calls <n>", "stop after N calls this run", (v) => parseInt(v, 10))
    .option("--confirm-minutes <n>", "settlement confirmation window", (v) => parseInt(v, 10), 10)
    .option("--confirm-interval-seconds <n>", "how often to re-check the chain while waiting for a settlement", (v) => parseInt(v, 10), 3)
    .option("--resume-since <iso>", "only subtract calls made at or after this time from the plan (start of this phase); default: all earlier calls")
    .option("--concurrency <n>", "concurrent calls, each to a different seller (default 1)", (v) => parseInt(v, 10), 1)
    .option("--no-persist-tiers", "do not rewrite sellers.tier from this plan's seed (keeps the published tiers stable across daily reseeds)")
    .option("--budget-usd <usd>", "size this run's plan to this budget: overrides sample.max_total_usd, scales target_calls to match, and trims the plan to fit (the MAX_* caps still apply)", parseFloat)
    .option("--per-call-usd <usd>", "this run's per-call cap (scheduled runs: 0.10); may lower MAX_PER_CALL_USD, never raise it", parseFloat)
    .option("--run-usd <usd>", "per-run cap, checked before every signature (scheduled runs: 0.75)", parseFloat)
    .option("--runs-per-day <n>", "scale MAX_PER_SELLER_PER_DAY_USD to a per-seller cap for this run (scheduled runs: 4)", (v) => parseInt(v, 10))
    .option("--day-budget-usd <usd>", "scheduled-buy budget for the UTC day over source buy (LOOP_DAILY_USD); MAX_PER_DAY_USD stays the all-sources backstop", parseFloat)
    .option("--expensive", "add config/expensive-sellers.yaml: one call per listed seller under its weekly frequency, at its own cap clamped to MAX_PER_CALL_USD", false)
    .option("--candidates", "add one call per queued user candidate (only when CANDIDATE_BUYS_ENABLED=1; otherwise they are listed and skipped)", false)
    .action(async function (this: Command, o: { seed?: number; maxCalls?: number; confirmMinutes: number; confirmIntervalSeconds: number; resumeSince?: string; concurrency: number; budgetUsd?: number; persistTiers: boolean; perCallUsd?: number; runUsd?: number; runsPerDay?: number; dayBudgetUsd?: number; expensive: boolean; candidates: boolean }) {
      const g = globals(this);
      const { live } = moneyGate(g, requireLive);
      const env = loadEnv();
      const files = loadFileConfigs();
      const envCaps = capsFromEnv(env);
      if (o.perCallUsd !== undefined && !(o.perCallUsd > 0)) throw new Error(`--per-call-usd must be > 0, got ${o.perCallUsd}`);
      if (o.perCallUsd !== undefined && usdToAtomic(o.perCallUsd) > envCaps.perCallAtomic)
        throw new Error(`--per-call-usd ${o.perCallUsd} is above MAX_PER_CALL_USD ${env.MAX_PER_CALL_USD}; a run may lower the cap, never raise it`);
      const caps = o.perCallUsd !== undefined ? { ...envCaps, perCallAtomic: usdToAtomic(o.perCallUsd) } : envCaps;
      const db = openDb(g.db);
      const runStart = Date.now();
      let sample = files.sample;
      if (o.budgetUsd !== undefined) {
        if (!(o.budgetUsd > 0)) throw new Error(`--budget-usd must be > 0, got ${o.budgetUsd}`);
        const target = Math.max(1, Math.round((files.sample.target_calls * o.budgetUsd) / files.sample.max_total_usd));
        sample = { ...files.sample, max_total_usd: o.budgetUsd, target_calls: target };
      }
      const plan = buildBuyPlan(db, { sample, caps, network: g.network, ...(o.seed !== undefined ? { seed: o.seed } : {}), exclude: files.exclude, persistTiers: o.persistTiers, ...(live ? { recordTooExpensive: true } : {}) });
      const addLane = (allocs: typeof plan.allocations, label: string) => {
        for (const a of allocs) {
          plan.allocations.push(a);
          plan.totalCalls += a.calls;
          plan.totalSpendAtomic += a.priceAtomic * BigInt(a.calls);
        }
        if (allocs.length) plan.notes.push(`${label}: ${allocs.length} call(s) added (${allocs.map((a) => a.sellerDomain).join(", ")}).`);
      };
      if (o.expensive) {
        // Each listed seller's own cap, clamped to MAX_PER_CALL_USD: this list can never raise a cap.
        const list = files.expensive.sellers.map((e) => ({ ...e, per_call_usd: Math.min(e.per_call_usd, env.MAX_PER_CALL_USD) }));
        const lane = expensiveAllocations(db, list, { network: g.network, now: runStart });
        addLane(lane.allocations, "expensive-sellers lane");
        for (const sk of lane.skipped) plan.notes.push(`expensive-sellers lane: ${sk.domain} skipped, ${sk.reason}.`);
      }
      if (o.candidates) {
        const lane = candidateAllocations(db, { perCallCapAtomic: caps.perCallAtomic, network: g.network });
        if (env.CANDIDATE_BUYS_ENABLED === "1") addLane(lane, "candidate lane");
        else if (lane.length) plan.notes.push(`candidate lane: ${lane.length} queued candidate(s) not bought, CANDIDATE_BUYS_ENABLED is not 1 (${lane.map((a) => a.url).join(", ")}).`);
      }
      if (o.budgetUsd !== undefined && plan.totalSpendAtomic > plan.sampleMaxTotalAtomic) {
        // Trim one call at a time from the largest stratified allocations until the plan fits the budget; the
        // expensive and candidate lanes keep their single call.
        while (plan.totalSpendAtomic > plan.sampleMaxTotalAtomic) {
          const a = [...plan.allocations].filter((x) => x.calls > 0 && (x.tier === "top" || x.tier === "tail")).sort((x, y) => y.calls - x.calls || (y.priceAtomic > x.priceAtomic ? 1 : -1))[0];
          if (!a) break;
          a.calls -= 1;
          plan.totalCalls -= 1;
          plan.totalSpendAtomic -= a.priceAtomic;
        }
        plan.allocations = plan.allocations.filter((x) => x.calls > 0);
        plan.notes.push(`plan trimmed to fit --budget-usd ${o.budgetUsd}`);
      }
      assertPlanWithinCaps(plan, caps);
      if (o.maxCalls) {
        // Partial run: take calls round-robin across allocations so a short run still spans sellers and strata.
        // The full plan is re-derived from the same seed next time; spent calls are visible in the calls table.
        const counts = new Map(plan.allocations.map((a) => [a.resourceId, 0]));
        let left = o.maxCalls;
        let progressed = true;
        while (left > 0 && progressed) {
          progressed = false;
          for (const a of plan.allocations) {
            if (left === 0) break;
            const c = counts.get(a.resourceId)!;
            if (c < a.calls) { counts.set(a.resourceId, c + 1); left -= 1; progressed = true; }
          }
        }
        plan.allocations = plan.allocations.map((a) => ({ ...a, calls: counts.get(a.resourceId)! })).filter((a) => a.calls > 0);
        plan.totalCalls = plan.allocations.reduce((s, a) => s + a.calls, 0);
      }
      // Resume: calls already made for a resource (any earlier live run, any outcome) count against its allocation,
      // so a halted or crashed run can be restarted without resampling the first resources.
      if (live) {
        const sinceMs = o.resumeSince ? Date.parse(o.resumeSince) : 0;
        if (o.resumeSince && !Number.isFinite(sinceMs)) throw new Error(`--resume-since is not a date: ${o.resumeSince}`);
        const done = new Map(
          // our_error rows are excluded from the denominator, so they do not consume the resource's allocation.
          (db.prepare("SELECT resource_id, COUNT(*) n FROM calls WHERE source = 'buy' AND outcome != 'our_error' AND ts >= ? GROUP BY resource_id").all(sinceMs) as { resource_id: number; n: number }[]).map((r) => [r.resource_id, r.n]),
        );
        const before = plan.totalCalls;
        plan.allocations = plan.allocations.map((a) => ({ ...a, calls: Math.max(0, a.calls - (done.get(a.resourceId) ?? 0)) })).filter((a) => a.calls > 0);
        plan.totalCalls = plan.allocations.reduce((s, a) => s + a.calls, 0);
        if (plan.totalCalls !== before) log.info(`resume: ${before - plan.totalCalls} call(s) already made in earlier runs are subtracted from the plan`);
      }
      console.log(renderPlan(plan));
      const runId = startRun(db, "buy run", { seed: o.seed, maxCalls: o.maxCalls, budgetUsd: o.budgetUsd, perCallUsd: o.perCallUsd, runUsd: o.runUsd, runsPerDay: o.runsPerDay, dayBudgetUsd: o.dayBudgetUsd, expensive: o.expensive, candidates: o.candidates, live }, g.network, !live);
      // The payer refuses anything above the largest cap any allocation in this plan carries (never above MAX_PER_CALL_USD).
      const payerCap = plan.allocations.reduce((m, a) => (a.perCallCapAtomic !== undefined && a.perCallCapAtomic > m ? a.perCallCapAtomic : m), caps.perCallAtomic);
      const payers = live ? payersFromEnv(env, g.network, payerCap) : ephemeralPayers(g.network, payerCap);
      const runLimits: RunLimits | undefined =
        o.runUsd !== undefined || o.runsPerDay !== undefined || o.dayBudgetUsd !== undefined
          ? {
              since: runStart,
              ...(o.runUsd !== undefined ? { perRunAtomic: usdToAtomic(o.runUsd) } : {}),
              ...(o.runsPerDay !== undefined && o.runsPerDay > 0 ? { perSellerPerRunAtomic: caps.perSellerPerDayAtomic / BigInt(o.runsPerDay) } : {}),
              ...(o.dayBudgetUsd !== undefined ? { dayBudgetAtomic: usdToAtomic(o.dayBudgetUsd) } : {}),
            }
          : undefined;
      const client = makeChainClient({ rpcUrl: rpcFor(env, g.network), network: g.network });
      // Receipts for seller-reported tx hashes come from the canonical-head RPC (BASE_RPC_URL); logs from the logs RPC.
      const receiptClient = g.network === MAINNET && env.BASE_RPC_URL !== env.BASE_LOGS_RPC_URL ? makeChainClient({ rpcUrl: env.BASE_RPC_URL, network: g.network }) : undefined;
      try {
        const stats = await runBuy(db, {
          plan,
          payers,
          caps,
          network: g.network,
          settlementLookupFactory: makeChainLookupFactory({ client, network: g.network, ...(receiptClient ? { receiptClient } : {}) }),
          // Balance-aware rotation: skip wallets that cannot cover the next call; end cleanly when the pool is empty.
          walletBalance: async (address) => (receiptClient ?? client).readContract({ address: usdcFor(g.network), abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] }),
          services: serviceLookup(loadServiceConfigs()),
          minSecondsBetweenCallsPerResource: files.sample.min_seconds_between_calls_per_resource,
          confirmTimeoutMs: o.confirmMinutes * 60_000,
          confirmIntervalMs: o.confirmIntervalSeconds * 1_000,
          concurrency: o.concurrency,
          ...(runLimits ? { runLimits } : {}),
          runId,
          configHash: files.configHash,
          log,
          dryRun: !live,
        });
        finishRun(db, runId, stats.halted ? "halted" : "ok", { ...stats, callIds: undefined, schedule: undefined });
        console.log(JSON.stringify({ ...stats, spentUsdc: atomicToUsd(stats.spentAtomic), callIds: undefined, schedule: undefined }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      } catch (e) {
        finishRun(db, runId, "error", { error: (e as Error).message });
        throw e;
      }
    });

  b.command("reclassify")
    .description("re-run validators and classification on stored rows (after a validator fix); shows changes, writes only with --apply")
    .requiredOption("--reason <text>", "why (recorded in the reclassifications audit table)")
    .option("--apply", "write the changes", false)
    .option("--ids <n...>", "restrict to call ids", (v, acc: number[] = []) => [...acc, parseInt(v, 10)])
    .action(async function (this: Command, o: { reason: string; apply: boolean; ids?: number[] }) {
      const g = globals(this);
      const db = openDb(g.db);
      const r = await reclassifyCalls(db, { reason: o.reason, apply: o.apply, ...(o.ids ? { callIds: o.ids } : {}), services: serviceLookup(loadServiceConfigs()) });
      for (const c of r.changed) console.log(`${c.callId}\t${c.oldOutcome} -> ${c.newOutcome}\t[${c.oldFlags}] -> [${c.newFlags}]\t${c.url}`);
      console.log(JSON.stringify({ examined: r.examined, changed: r.changed.length, applied: r.applied }));
    });

  b.command("reconcile")
    .description("turn signed ledger rows with no call row (crash/halt after signing) into call rows after checking the chain; writes only with --apply")
    .option("--apply", "write the rows", false)
    .action(async function (this: Command, o: { apply: boolean }) {
      const g = globals(this);
      const env = loadEnv();
      const db = openDb(g.db);
      const client = makeChainClient({ rpcUrl: rpcFor(env, g.network), network: g.network });
      const oldest = db.prepare("SELECT MIN(ts) t FROM attempts a WHERE a.phase='signed' AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.nonce = a.nonce)").get() as { t: number | null };
      if (!oldest.t) { console.log(JSON.stringify({ orphans: 0 })); return; }
      const fromBlock = await blockAtTimestamp(client, Math.floor(oldest.t / 1000) - 600);
      const lookup = makeChainSettlementLookup({ client, network: g.network, fromBlock, maxBlockRange: 50_000n });
      console.log(JSON.stringify(await reconcileOrphans(db, { lookup, apply: o.apply })));
    });

  b.command("resolve")
    .description("re-check indeterminate calls against the chain (run periodically for 24 h after a buy run)")
    .action(async function (this: Command) {
      const g = globals(this);
      const env = loadEnv();
      const db = openDb(g.db);
      const client = makeChainClient({ rpcUrl: rpcFor(env, g.network), network: g.network });
      const oldest = db.prepare("SELECT MIN(ts) t FROM calls WHERE outcome = 'indeterminate' OR (paid = 1 AND settlement_count = 0 AND ts >= ?)").get(Date.now() - 24 * 3_600_000) as { t: number | null };
      if (!oldest.t) { console.log(JSON.stringify({ checked: 0, unconfirmedChecked: 0 })); return; }
      const fromBlock = await blockAtTimestamp(client, Math.floor(oldest.t / 1000) - 600);
      const lookup = makeChainSettlementLookup({ client, network: g.network, fromBlock, maxBlockRange: 50_000n });
      const r = await resolvePendingIndeterminate(db, { lookup, defaultMaxTimeoutSeconds: 30 });
      // Late settlements show up within minutes; re-checking only the last 2 h keeps this pass cheap on the RPC.
      const u = await resolveUnconfirmedSettlements(db, { lookup, maxAgeMs: 2 * 3_600_000 });
      console.log(JSON.stringify({ ...r, unconfirmedChecked: u.checked, unconfirmedFound: u.found }));
      if (u.found.length) log.info(`settlements found late for ${u.found.length} row(s); run \`buy reclassify --apply --reason "late settlement"\` to update outcomes with an audit trail`);
    });
  return b;
}

export function registerStress(program: Command, globals: (cmd: Command) => MoneyGlobals, requireLive: (g: MoneyGlobals) => { live: boolean; reason: string | null }) {
  const s = program.command("stress").description("duplicate and timeout tests on ~10 sellers; own caps, never in the headline");
  const common = (cmd: Command) =>
    cmd
      .option("--count <n>", "number of sellers", (v) => parseInt(v, 10), 10)
      .option("--max-rank <n>", "choose among sellers ranked 1..N by volume", (v) => parseInt(v, 10), 30)
      .option("--confirm-minutes <n>", "settlement confirmation window", (v) => parseInt(v, 10), 10);
  async function setup(cmd: Command, o: { count: number; maxRank: number }) {
    const g = globals(cmd);
    const { live } = moneyGate(g, requireLive);
    const env = loadEnv();
    const files = loadFileConfigs();
    const caps = capsFromEnv(env);
    const db = openDb(g.db);
    const client = makeChainClient({ rpcUrl: rpcFor(env, g.network), network: g.network });
    const resources = selectStressResources(db, { network: g.network, caps, count: o.count, maxRank: o.maxRank, exclude: files.exclude });
    console.log(resources.map((r) => `${r.sellerDomain}\t${r.url}\t${r.priceAtomic !== undefined ? atomicToUsd(r.priceAtomic) : "?"}`).join("\n"));
    return { g, live, env, files, caps, db, client, resources, payers: live ? payersFromEnv(env, g.network, caps.perCallAtomic) : ephemeralPayers(g.network, caps.perCallAtomic) };
  }
  common(s.command("duplicate").description("same intent twice back to back with fresh signatures; does it settle twice?")).action(async function (this: Command, o: { count: number; maxRank: number; confirmMinutes: number }) {
    const c = await setup(this, o);
    const runId = startRun(c.db, "stress duplicate", o, c.g.network, !c.live);
    const r = await runStressDuplicate(c.db, { payers: c.payers, caps: c.caps, network: c.g.network, settlementLookupFactory: makeChainLookupFactory({ client: c.client, network: c.g.network }), resources: c.resources, services: serviceLookup(loadServiceConfigs()), confirmTimeoutMs: o.confirmMinutes * 60_000, runId, configHash: c.files.configHash, log, dryRun: !c.live });
    finishRun(c.db, runId, "ok", r);
    console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  });
  common(s.command("timeout").description("sign, send, drop the connection after 2 s, check the chain, then retry like a naive client")).action(async function (this: Command, o: { count: number; maxRank: number; confirmMinutes: number }) {
    const c = await setup(this, o);
    const runId = startRun(c.db, "stress timeout", o, c.g.network, !c.live);
    const r = await runStressTimeout(c.db, { payers: c.payers, caps: c.caps, network: c.g.network, settlementLookupFactory: makeChainLookupFactory({ client: c.client, network: c.g.network }), resources: c.resources, services: serviceLookup(loadServiceConfigs()), confirmTimeoutMs: o.confirmMinutes * 60_000, runId, configHash: c.files.configHash, log, dryRun: !c.live });
    finishRun(c.db, runId, "ok", r);
    console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  });
  s.command("report").description("duplicate and timeout results per resource").action(function (this: Command) {
    const g = globals(this);
    console.log(stressReport(openDb(g.db)));
  });
  return s;
}

export type { Db };
