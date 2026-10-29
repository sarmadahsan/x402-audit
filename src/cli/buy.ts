import type { Command } from "commander";
import { erc20Abi, formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildBuyPlan, renderPlan, assertPlanWithinCaps, planToJSON, type BuyPlan, type PlanAllocation } from "../buy/plan.js";
import { runBuy } from "../buy/run.js";
import { loadServiceConfigs, serviceLookup } from "../buy/services.js";
import { blockAtTimestamp, makeChainClient, usdcFor } from "../chain/client.js";
import { makeChainLookupFactory, makeChainSettlementLookup, resolvePendingIndeterminate, resolveUnconfirmedSettlements } from "../chain/confirm.js";
import { atomicToUsd, capsFromEnv, loadEnv, loadFileConfigs, MAINNET, usdToAtomic, type Env, type Network } from "../config/index.js";
import { breadthAllocations, candidateAllocations, expensiveAllocations } from "../buy/lanes.js";
import { fetchDemand } from "../audit/triggers.js";
import { buildCoveragePlan, planPrice, projectCoverage, renderCoverage, rowsFromAllocations, sellerUniverse, writeRunAllocations, type AllocationRow } from "../buy/allocate.js";
import { CALL_SOURCES } from "../taxonomy.js";
import type { RunLimits } from "../buy/guard.js";
import { openDb, type Db } from "../db/index.js";
import { log } from "../log.js";
import { runStressDuplicate, runStressTimeout, stressReport, selectStressResources } from "../stress/index.js";
import { createPayer, type Payer } from "../x402/pay.js";
import { finishRun, startRun } from "./runs.js";
import { reclassifyCalls } from "../pipeline/reclassify.js";
import { reconcileOrphans } from "../pipeline/reconcile.js";
import { assertGate } from "../gate.js";

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

/** A run's budget caps ending it is the plan working, not an alarm: `cap_reached`. `halted` keeps meaning the halt file,
 * an error, or a cap that should never be reached in routine running (MAX_PER_DAY_USD, MAX_TOTAL_USD). */
export const ROUTINE_CAPS = new Set(["cap_per_run", "cap_buy_day_budget", "cap_audit_per_day"]);
export function runStatus(s: { halted: boolean; haltReason?: string }): "ok" | "cap_reached" | "halted" {
  if (!s.halted) return "ok";
  return s.haltReason && ROUTINE_CAPS.has(s.haltReason) ? "cap_reached" : "halted";
}

/** This week's index demand (host -> checks), for the admit lane; empty (and logged) when the index cannot be read. */
async function demandMap(index: string): Promise<Map<string, number>> {
  try {
    return new Map((await fetchDemand(index)).filter((d) => d.checks > 0).map((d) => [d.host.toLowerCase().replace(/^www\./, ""), d.checks]));
  } catch (e) {
    log.warn(`demand: ${(e as Error).message}; the admit lane ranks by inflow and price only`);
    return new Map();
  }
}

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

  b.command("projection")
    .description("tiered targets (30 for measured or important sellers, 5 for the rest) costed at quote x1.2, and a run-by-run simulation at today's caps and at a given daily budget; reads only")
    .option("--per-call-usd <usd>", "scheduled per-call cap (default LOOP_PER_CALL_USD, else 0.10)", parseFloat)
    .option("--run-usd <usd>", "per-run cap (default LOOP_RUN_USD, else 1.00)", parseFloat)
    .option("--day-budget-usd <usd>", "scheduled-buy day budget (default LOOP_DAILY_USD, else 4.00)", parseFloat)
    .option("--alt-day-budget-usd <usd>", "a second scenario: this daily budget (per-run budget scaled to it) for --alt-days days", parseFloat, 8)
    .option("--alt-days <n>", "days in the second scenario", (v) => parseInt(v, 10), 7)
    .option("--json", "print JSON", false)
    .action(async function (this: Command, o: { perCallUsd?: number; runUsd?: number; dayBudgetUsd?: number; altDayBudgetUsd: number; altDays: number; json: boolean }) {
      const g = globals(this);
      const env = loadEnv();
      const files = loadFileConfigs();
      const db = openDb(g.db);
      const now = Date.now();
      const cap = usdToAtomic(o.perCallUsd ?? Number(process.env.LOOP_PER_CALL_USD ?? "0.10"));
      const runAtomic = usdToAtomic(o.runUsd ?? Number(process.env.LOOP_RUN_USD ?? "1.00"));
      const dailyAtomic = usdToAtomic(o.dayBudgetUsd ?? Number(process.env.LOOP_DAILY_USD ?? "4.00"));
      const runsPerDay = Math.max(1, Number(dailyAtomic / (runAtomic > 0n ? runAtomic : 1n)));
      const demand = await demandMap(env.PAIDFOR_INDEX_URL);
      const lane = expensiveAllocations(db, files.expensive.sellers.map((e) => ({ ...e, per_call_usd: Math.min(e.per_call_usd, env.MAX_PER_CALL_USD) })), { network: g.network, now, scheduledCapAtomic: cap });
      const laneAtomicPerRun = lane.allocations.reduce((a, x) => a + planPrice(x.priceAtomic), 0n);
      const p = projectCoverage(db, {
        network: g.network, capAtomic: cap, now, exclude: files.exclude, coverageShare: env.COVERAGE_SHARE, demand, expensiveDomains: files.expensive.sellers.map((e) => e.domain), tiersSince: Date.parse(env.COVERAGE_TIERS_SINCE), laneAtomicPerRun,
        scenarios: [
          { label: `today's caps (${atomicToUsd(runAtomic)} per run, ${atomicToUsd(dailyAtomic)} per day)`, runAtomic, runsPerDay, days: 7 },
          { label: `${o.altDayBudgetUsd.toFixed(2)} per day for ${o.altDays} days (${(o.altDayBudgetUsd / runsPerDay).toFixed(2)} per run)`, runAtomic: usdToAtomic(o.altDayBudgetUsd / runsPerDay), runsPerDay, days: o.altDays },
        ],
      });
      const teSellers = new Set((db.prepare("SELECT DISTINCT r.seller_id s FROM resource_states rs JOIN resources r ON r.id = rs.resource_id WHERE rs.state = 'too_expensive'").all() as { s: number }[]).map((r) => r.s));
      const uni = sellerUniverse(db, { network: g.network, capAtomic: cap, now, exclude: files.exclude });
      const reenter = uni.filter((s) => teSellers.has(s.sellerId) && s.eligible.length > 0);
      const out = { ...p, demandHosts: demand.size, tooExpensiveSellers: teSellers.size, tooExpensiveSellersWithEligible: reenter.length };
      if (o.json) return void console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      console.log(`# Tiered projection (${new Date(now).toISOString()}; demand hosts read: ${demand.size})\n`);
      console.log(`- sellers below their target: ${p.sellersBelowTarget} (${p.fullTarget} at the 30-call target, ${p.admitTarget} at the 5-call target)`);
      console.log(`- calls to reach every target: ${p.callsToTargets}; USDC at each seller's cheapest quote x1.2: ${p.usdcToTargets}`);
      for (const sc of p.scenarios) {
        console.log(`\n## ${sc.label}\n`);
        console.log(`- sellers at target, start then end of each day: ${sc.atTargetByDay.join(", ")}`);
        console.log(`- sellers at 30+ (sellers_with_min_calls, upper bound): ${sc.at30ByDay.join(", ")}`);
        console.log(`- every target reached after: ${sc.daysToAllTargets === null ? "more than the simulated horizon" : `${sc.daysToAllTargets} day(s)`}`);
      }
      console.log(`\n- too_expensive today: ${teSellers.size} seller(s); ${reenter.length} have an endpoint quoting at or under ${atomicToUsd(cap)} and are bought on it`);
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
    .option("--allocation <mode>", "stratified (the study design) or coverage (scheduled runs: sellers below 30 calls first, then maintenance)", "stratified")
    .option("--breadth", "the weekly breadth run instead of a scheduled run: one call per seller with no resource under --per-call-usd, at BREADTH_MAX_PER_CALL_USD, under BREADTH_WEEKLY_USD; buys only when BREADTH_RUN_ENABLED=1", false)
    .action(async function (this: Command, o: { seed?: number; maxCalls?: number; confirmMinutes: number; confirmIntervalSeconds: number; resumeSince?: string; concurrency: number; budgetUsd?: number; persistTiers: boolean; perCallUsd?: number; runUsd?: number; runsPerDay?: number; dayBudgetUsd?: number; expensive: boolean; candidates: boolean; allocation: string; breadth: boolean }) {
      const g = globals(this);
      const gate = moneyGate(g, requireLive);
      const env = loadEnv();
      const files = loadFileConfigs();
      const envCaps = capsFromEnv(env);
      if (o.allocation !== "stratified" && o.allocation !== "coverage") throw new Error(`--allocation must be stratified or coverage, got ${o.allocation}`);
      // The breadth run buys only with its own flag on top of every live gate; otherwise it prints its plan.
      const live = gate.live && (!o.breadth || env.BREADTH_RUN_ENABLED === "1");
      if (gate.live && !live) log.warn("breadth run: BREADTH_RUN_ENABLED is not 1; printing the plan, buying nothing");
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
      const ownCapDomains = files.expensive.sellers.map((e) => e.domain);
      let backoffRows: AllocationRow[] = [];
      let coverageText = "";
      const lanes: PlanAllocation[] = [];
      const laneNotes: string[] = [];
      let breadthRemaining: bigint | undefined;
      if (o.expensive && !o.breadth) {
        // Each listed seller's own cap, clamped to MAX_PER_CALL_USD: this list can never raise a cap.
        const list = files.expensive.sellers.map((e) => ({ ...e, per_call_usd: Math.min(e.per_call_usd, env.MAX_PER_CALL_USD) }));
        const lane = expensiveAllocations(db, list, { network: g.network, now: runStart, scheduledCapAtomic: caps.perCallAtomic });
        lanes.push(...lane.allocations);
        if (lane.allocations.length) laneNotes.push(`expensive-sellers lane: ${lane.allocations.length} call(s) added (${lane.allocations.map((a) => a.sellerDomain).join(", ")}).`);
        for (const sk of lane.skipped) laneNotes.push(`expensive-sellers lane: ${sk.domain} skipped, ${sk.reason}.`);
      }
      if (o.candidates && !o.breadth) {
        const lane = candidateAllocations(db, { perCallCapAtomic: caps.perCallAtomic, network: g.network });
        if (env.CANDIDATE_BUYS_ENABLED === "1") {
          lanes.push(...lane);
          if (lane.length) laneNotes.push(`candidate lane: ${lane.length} call(s) added (${lane.map((a) => a.sellerDomain).join(", ")}).`);
        } else if (lane.length) laneNotes.push(`candidate lane: ${lane.length} queued candidate(s) not bought, CANDIDATE_BUYS_ENABLED is not 1 (${lane.map((a) => a.url).join(", ")}).`);
      }
      let plan: BuyPlan;
      if (o.breadth) {
        const breadthCap = usdToAtomic(Math.min(env.BREADTH_MAX_PER_CALL_USD, env.MAX_PER_CALL_USD));
        const lane = breadthAllocations(db, { network: g.network, now: runStart, scheduledCapAtomic: caps.perCallAtomic, breadthCapAtomic: breadthCap, weeklyBudgetAtomic: usdToAtomic(env.BREADTH_WEEKLY_USD), exclude: files.exclude, skipDomains: ownCapDomains, recordTooExpensive: live });
        breadthRemaining = lane.remainingAtomic;
        const spend = lane.allocations.reduce((a, x) => a + x.priceAtomic, 0n);
        plan = { network: g.network, seed: o.seed ?? 0, createdAt: runStart, targetCalls: lane.allocations.length, strata: [], totalCalls: lane.allocations.length, totalSpendAtomic: spend, sampleMaxTotalAtomic: lane.remainingAtomic, allocations: lane.allocations, notes: lane.skipped.map((k) => `breadth: ${k.domain} skipped, ${k.reason}.`) };
        coverageText = `# Breadth run\n\n${lane.universe} seller(s) have no resource at or under ${atomicToUsd(caps.perCallAtomic)} USDC; ${lane.allocations.length} planned, one call each at most ${atomicToUsd(breadthCap)} USDC, ${atomicToUsd(spend)} USDC of the ${atomicToUsd(lane.remainingAtomic)} left this week (BREADTH_WEEKLY_USD ${env.BREADTH_WEEKLY_USD}).\n`;
      } else if (o.allocation === "coverage") {
        // Lanes first; coverage and maintenance plan what is left of the run budget, with 5% headroom for quotes that
        // move between the last probe and the call (the per-run cap is still checked before every signature).
        const runBudget = usdToAtomic(o.budgetUsd ?? files.sample.max_total_usd);
        // Lanes are planned at their quote x1.2 too.
        for (const a of lanes) a.planAtomic = planPrice(a.priceAtomic);
        const laneSpend = lanes.reduce((a, x) => a + (x.planAtomic ?? x.priceAtomic) * BigInt(x.calls), 0n);
        const budget = (runBudget * 95n) / 100n - laneSpend;
        const demand = await demandMap(env.PAIDFOR_INDEX_URL);
        const cov = buildCoveragePlan(db, { network: g.network, caps, budgetAtomic: budget > 0n ? budget : 0n, runBudgetAtomic: runBudget, coverageShare: env.COVERAGE_SHARE, seed: o.seed ?? files.sample.seed, now: runStart, exclude: files.exclude, inflowFloorUsd: env.MAINTENANCE_INFLOW_FLOOR_USD, ownCapDomains, demand, tiersSince: Date.parse(env.COVERAGE_TIERS_SINCE), ...(live ? { recordTooExpensive: true } : {}) });
        for (const b of cov.backoffs) log.info(`back-off: resource ${b.resourceId} ${b.url} (${b.outcomes.join(", ")}) until ${new Date(b.until).toISOString()}`);
        backoffRows = cov.rows.filter((r) => r.pool === "backoff");
        coverageText = renderCoverage(cov, { lanes, runBudgetAtomic: runBudget });
        plan = cov.plan;
        plan.sampleMaxTotalAtomic = runBudget;
      } else {
        plan = buildBuyPlan(db, { sample, caps, network: g.network, ...(o.seed !== undefined ? { seed: o.seed } : {}), exclude: files.exclude, persistTiers: o.persistTiers, ...(live ? { recordTooExpensive: true } : {}) });
      }
      // The expensive and candidate lanes ride along with every scheduled plan.
      for (const a of lanes) {
        plan.allocations.push(a);
        plan.totalCalls += a.calls;
        plan.totalSpendAtomic += (a.planAtomic ?? a.priceAtomic) * BigInt(a.calls);
      }
      plan.notes.push(...laneNotes);
      if (o.budgetUsd !== undefined && plan.totalSpendAtomic > plan.sampleMaxTotalAtomic) {
        // Trim one call at a time from the largest stratified allocations until the plan fits the budget; the
        // expensive and candidate lanes keep their single call.
        while (plan.totalSpendAtomic > plan.sampleMaxTotalAtomic) {
          const a = [...plan.allocations].filter((x) => x.calls > 0 && x.tier !== "expensive" && x.tier !== "candidate").sort((x, y) => y.calls - x.calls || (y.priceAtomic > x.priceAtomic ? 1 : -1))[0];
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
      if (live && !o.breadth) {
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
      console.log(coverageText || renderPlan(plan));
      if (coverageText && plan.notes.length && o.breadth) console.log(plan.notes.map((n) => `- ${n}`).join("\n"));
      const runId = startRun(db, "buy run", { seed: o.seed, maxCalls: o.maxCalls, budgetUsd: o.budgetUsd, perCallUsd: o.perCallUsd, runUsd: o.runUsd, runsPerDay: o.runsPerDay, dayBudgetUsd: o.dayBudgetUsd, expensive: o.expensive, candidates: o.candidates, allocation: o.breadth ? "breadth" : o.allocation, live }, g.network, !live);
      // Every planned call (and every back-off) is on record before the first signature.
      const allocRows = [...backoffRows, ...rowsFromAllocations(plan.allocations)];
      writeRunAllocations(db, runId, allocRows, Date.now());
      log.info(`run ${runId}: ${allocRows.length} run_allocations row(s) written (${plan.totalCalls} planned call(s), ${atomicToUsd(plan.totalSpendAtomic)} USDC estimated)`);
      // The payer refuses anything above the largest cap any allocation in this plan carries (never above MAX_PER_CALL_USD).
      const payerCap = plan.allocations.reduce((m, a) => (a.perCallCapAtomic !== undefined && a.perCallCapAtomic > m ? a.perCallCapAtomic : m), caps.perCallAtomic);
      const payers = live ? payersFromEnv(env, g.network, payerCap) : ephemeralPayers(g.network, payerCap);
      const runLimits: RunLimits | undefined = o.breadth
        ? { since: runStart, source: CALL_SOURCES.BREADTH, perRunAtomic: breadthRemaining ?? 0n }
        : o.runUsd !== undefined || o.runsPerDay !== undefined || o.dayBudgetUsd !== undefined
          ? {
              since: runStart,
              ...(o.runUsd !== undefined ? { perRunAtomic: usdToAtomic(o.runUsd) } : {}),
              // Per seller per run: the daily per-seller cap over the runs, and never more than 15% of this run (a quote
              // above the plan cannot let one seller take the run, as keyring-agent did at 12:17 on 2026-10-29).
              ...(o.runsPerDay !== undefined && o.runsPerDay > 0
                ? { perSellerPerRunAtomic: minBig(caps.perSellerPerDayAtomic / BigInt(o.runsPerDay), o.runUsd !== undefined ? (usdToAtomic(o.runUsd) * 15n) / 100n : caps.perSellerPerDayAtomic) }
                : {}),
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
          ...(o.breadth ? { source: CALL_SOURCES.BREADTH } : {}),
          runId,
          configHash: files.configHash,
          log,
          dryRun: !live,
        });
        finishRun(db, runId, runStatus(stats), { ...stats, callIds: undefined, schedule: undefined });
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
