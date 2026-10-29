/**
 * Stratified buy plan (docs/PLAN.md "Sampling design"): seller tier (top N by rank_30d, seeded random
 * tail) x category, calls weighted toward cheap resources, with planned spend per stratum.
 */
import type { Db } from "../db/index.js";
import { atomicToUsd, isExcluded, usdToAtomic, type Caps, type ExcludeConfig, type SampleConfig } from "../config/index.js";

export type Tier = "top" | "tail";

export interface PlanAllocation {
  resourceId: number;
  sellerId: number;
  sellerDomain: string;
  url: string;
  method: string;
  /** resources.input_json (Bazaar input info) so POST bodies can be built from the seller's own example. */
  inputJson: string | null;
  /** Stratified tier, or the lane an extra allocation came from (audit, user candidate, expensive-sellers list). */
  tier: Tier | "audit" | "candidate" | "expensive";
  category: string;
  priceAtomic: bigint;
  calls: number;
  /** Per-call cap for this allocation when it differs from MAX_PER_CALL_USD (config/expensive-sellers.yaml). */
  perCallCapAtomic?: bigint;
}

export interface PlanStratum {
  tier: Tier;
  category: string;
  /** Seller ids in this stratum. */
  sellers: number[];
  /** Eligible resource ids in this stratum (including any allocated 0 calls). */
  resources: number[];
  targetCalls: number;
  calls: number;
  plannedSpendAtomic: bigint;
}

export interface BuyPlan {
  network: string;
  seed: number;
  createdAt: number;
  targetCalls: number;
  strata: PlanStratum[];
  totalCalls: number;
  totalSpendAtomic: bigint;
  /** sample.max_total_usd in atomic units, checked by assertPlanWithinCaps. */
  sampleMaxTotalAtomic: bigint;
  allocations: PlanAllocation[];
  notes: string[];
}

export interface BuildPlanOptions {
  sample: SampleConfig;
  caps: Caps;
  network: string;
  seed?: number;
  now?: number;
  exclude?: ExcludeConfig;
  /** Persist sellers.tier for the chosen sellers (default true). */
  persistTiers?: boolean;
}

/** mulberry32: small seeded PRNG, so the tail sample is reproducible from the recorded seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Largest-remainder split of `total` into integer parts proportional to `weights`. */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

interface EligibleRow {
  resource_id: number;
  seller_id: number;
  domain: string;
  url: string;
  method: string;
  input_json: string | null;
  price: string;
  seller_category: string | null;
  rank_30d: number | null;
}

export function buildBuyPlan(db: Db, o: BuildPlanOptions): BuyPlan {
  const { sample, caps, network } = o;
  const seed = o.seed ?? sample.seed;
  const now = o.now ?? Date.now();
  const notes: string[] = [];

  const probeCount = (db.prepare(`SELECT COUNT(*) n FROM probes`).get() as { n: number }).n;
  const requireProbe = probeCount > 0;
  if (!requireProbe) notes.push("No probes in the database: the '402-probeable' eligibility filter was skipped.");

  const rows = db
    .prepare(
      `SELECT r.id resource_id, r.seller_id, s.domain, r.url, r.method, r.input_json, r.declared_price_atomic price, s.category seller_category, s.rank_30d
       FROM resources r JOIN sellers s ON s.id = r.seller_id
       WHERE r.network = ? AND r.scheme = 'exact' AND COALESCE(r.transfer_method, 'eip3009') != 'permit2'
         AND r.declared_price_atomic IS NOT NULL AND s.excluded = 0
         ${requireProbe ? "AND EXISTS (SELECT 1 FROM probes p JOIN resources pr ON pr.id = p.resource_id WHERE pr.seller_id = r.seller_id AND p.status = 402)" : ""}
       ORDER BY r.seller_id, CAST(r.declared_price_atomic AS INTEGER) ASC, r.id`,
    )
    .all(network) as EligibleRow[];

  let overCap = 0;
  let excludedByConfig = 0;
  let templated = 0;
  const eligible = rows.filter((r) => {
    // A path template (/coin/:symbol, /users/{id}) cannot be fetched literally; every call would be not_paid.
    if (/\/:[A-Za-z_]+|\{[^}]+\}/.test(r.url)) {
      templated++;
      return false;
    }
    if (!/^\d+$/.test(r.price) || BigInt(r.price) > caps.perCallAtomic) {
      overCap++;
      return false;
    }
    if (o.exclude && isExcluded(o.exclude, r.domain, r.url)) {
      excludedByConfig++;
      return false;
    }
    return true;
  });
  if (overCap) notes.push(`${overCap} resource(s) dropped: declared price above the per-call cap (${atomicToUsd(caps.perCallAtomic)} USD) or not an integer.`);
  if (excludedByConfig) notes.push(`${excludedByConfig} resource(s) dropped by config/exclude.yaml.`);
  if (templated) notes.push(`${templated} resource(s) dropped: URL is a path template (e.g. /:symbol) that cannot be fetched literally.`);

  // Up to max_resources_per_seller resources per seller (cheapest first; a probed resource is always kept),
  // so a seller with hundreds of listings cannot dominate a stratum and a seller with one listing still counts.
  const maxPerSeller = sample.max_resources_per_seller;
  const probedIds = new Set(
    requireProbe ? (db.prepare("SELECT DISTINCT resource_id FROM probes WHERE status = 402").all() as { resource_id: number }[]).map((r) => r.resource_id) : [],
  );
  const bySeller = new Map<number, EligibleRow[]>();
  for (const r of eligible) {
    const l = bySeller.get(r.seller_id);
    if (l) l.push(r);
    else bySeller.set(r.seller_id, [r]);
  }
  let trimmed = 0;
  for (const [id, list] of bySeller) {
    if (list.length <= maxPerSeller) continue;
    const keep = [...list.filter((r) => probedIds.has(r.resource_id)), ...list.filter((r) => !probedIds.has(r.resource_id))].slice(0, maxPerSeller);
    trimmed += list.length - keep.length;
    bySeller.set(id, keep.sort((a, b) => a.resource_id - b.resource_id));
  }
  if (trimmed) notes.push(`${trimmed} resource(s) trimmed: at most ${maxPerSeller} resources per seller (cheapest first, probed ones kept).`);
  const sellerIds = [...bySeller.keys()].sort((a, b) => a - b);
  const rankOf = (id: number) => bySeller.get(id)![0]!.rank_30d;
  const top = sellerIds.filter((id) => {
    const r = rankOf(id);
    return r !== null && r <= sample.tiers.top.size;
  });
  const rest = sellerIds.filter((id) => !top.includes(id));
  const tail = shuffle(rest, seededRandom(seed)).slice(0, sample.tiers.tail.size).sort((a, b) => a - b);
  if (top.length < sample.tiers.top.size) notes.push(`Top tier: ${top.length} of ${sample.tiers.top.size} ranked sellers have an eligible resource.`);
  if (tail.length < sample.tiers.tail.size) notes.push(`Tail tier: only ${tail.length} eligible sellers outside the top ${sample.tiers.top.size} (wanted ${sample.tiers.tail.size}).`);

  const categoryOf = (sellerId: number) => {
    const c = bySeller.get(sellerId)![0]!.seller_category ?? "other";
    return sample.categories.includes(c) ? c : sample.categories.includes("other") ? "other" : c;
  };

  // Tier call targets by share; an empty tier hands its share to the other tier.
  const tiers: { tier: Tier; sellers: number[]; share: number }[] = [
    { tier: "top", sellers: top, share: sample.tiers.top.share },
    { tier: "tail", sellers: tail, share: sample.tiers.tail.share },
  ];
  const live = tiers.filter((t) => t.sellers.length > 0);
  for (const t of tiers) if (t.sellers.length === 0) notes.push(`Tier ${t.tier} has no eligible sellers; its share goes to the other tier.`);
  const tierTargets = apportion(sample.target_calls, live.map((t) => t.share));

  const floorAtomic = usdToAtomic(sample.price_floor_usd);
  const strata: PlanStratum[] = [];
  const allocations: PlanAllocation[] = [];

  live.forEach((t, ti) => {
    const cats = sample.categories
      .concat([...new Set(t.sellers.map(categoryOf))].filter((c) => !sample.categories.includes(c)))
      .filter((c) => t.sellers.some((s) => categoryOf(s) === c));
    const emptyCats = sample.categories.filter((c) => !cats.includes(c));
    if (emptyCats.length) notes.push(`Tier ${t.tier}: no eligible sellers in ${emptyCats.join(", ")}; calls redistributed across ${cats.join(", ")}.`);
    const catTargets = apportion(tierTargets[ti]!, cats.map(() => 1));
    // D'Hondt-style apportionment by weight 1/max(price, floor). Caps: each resource at max_share_per_resource of
    // its stratum target, each seller at max_calls_per_seller across the tier. A category that cannot absorb its
    // target (few sellers, or one seller hitting its cap) leaves the remainder to the tier's other categories.
    const tierRes = cats.flatMap((cat) => t.sellers.filter((s) => categoryOf(s) === cat).flatMap((s) => bySeller.get(s)!));
    const count = new Map<number, number>(tierRes.map((r) => [r.resource_id, 0]));
    const perSeller = new Map<number, number>();
    const weightOf = (r: EligibleRow) => {
      const p = BigInt(r.price) > floorAtomic ? BigInt(r.price) : floorAtomic;
      return 1 / Number(p > 0n ? p : 1n);
    };
    const fill = (res: EligibleRow[], n: number, resCap: number): number => {
      let placed = 0;
      for (let k = 0; k < n; k++) {
        let best: EligibleRow | undefined;
        let bestQ = -1;
        for (const r of res) {
          const c = count.get(r.resource_id)!;
          if (c >= resCap) continue;
          if ((perSeller.get(r.seller_id) ?? 0) >= sample.max_calls_per_seller) continue;
          const q = weightOf(r) / (c + 1);
          if (q > bestQ) { bestQ = q; best = r; }
        }
        if (!best) break;
        count.set(best.resource_id, count.get(best.resource_id)! + 1);
        perSeller.set(best.seller_id, (perSeller.get(best.seller_id) ?? 0) + 1);
        placed++;
      }
      return placed;
    };
    const catRes = new Map<string, EligibleRow[]>();
    const catCap = new Map<string, number>();
    let leftover = 0;
    cats.forEach((cat, ci) => {
      const res = t.sellers.filter((s) => categoryOf(s) === cat).flatMap((s) => bySeller.get(s)!);
      const target = catTargets[ci]!;
      const cap = Math.max(1, Math.floor(sample.max_share_per_resource * target));
      catRes.set(cat, res);
      catCap.set(cat, cap);
      const got = fill(res, target, cap);
      if (got < target) {
        leftover += target - got;
        notes.push(`Stratum ${t.tier}/${cat}: ${res.length} resource(s) from ${new Set(res.map((r) => r.seller_id)).size} seller(s) absorb ${got} of ${target} target calls (caps: ${cap} per resource, ${sample.max_calls_per_seller} per seller); remainder offered to the tier's other categories.`);
      }
    });
    if (leftover > 0) {
      // Second pass: the tier's remainder goes to categories with headroom, same caps (per-resource cap re-derived
      // from each category's own target so a flood cannot land on one resource).
      let moved = 0;
      for (const cat of cats) {
        if (leftover - moved <= 0) break;
        const res = catRes.get(cat)!;
        moved += fill(res, leftover - moved, catCap.get(cat)!);
      }
      notes.push(`Tier ${t.tier}: ${moved} of ${leftover} unabsorbed call(s) redistributed across categories with headroom.`);
    }
    cats.forEach((cat, ci) => {
      const res = catRes.get(cat)!;
      const sellers = [...new Set(res.map((r) => r.seller_id))];
      const target = catTargets[ci]!;
      const calls = res.map((r) => count.get(r.resource_id)!);
      const got = calls.reduce((s, x) => s + x, 0);
      let spend = 0n;
      res.forEach((r, i) => {
        if (calls[i]! === 0) return;
        const price = BigInt(r.price);
        spend += price * BigInt(calls[i]!);
        allocations.push({
          resourceId: r.resource_id,
          sellerId: r.seller_id,
          sellerDomain: r.domain,
          url: r.url,
          method: r.method,
          inputJson: r.input_json ?? null,
          tier: t.tier,
          category: cat,
          priceAtomic: price,
          calls: calls[i]!,
        });
      });
      strata.push({ tier: t.tier, category: cat, sellers, resources: res.map((r) => r.resource_id), targetCalls: target, calls: got, plannedSpendAtomic: spend });
    });
  });

  if (o.persistTiers !== false) {
    db.transaction(() => {
      db.prepare(`UPDATE sellers SET tier = NULL WHERE tier IS NOT NULL`).run();
      const up = db.prepare(`UPDATE sellers SET tier = ? WHERE id = ?`);
      for (const s of top) up.run("top", s);
      for (const s of tail) up.run("tail", s);
    })();
  }

  return {
    network,
    seed,
    createdAt: now,
    targetCalls: sample.target_calls,
    strata,
    totalCalls: strata.reduce((s, x) => s + x.calls, 0),
    totalSpendAtomic: strata.reduce((s, x) => s + x.plannedSpendAtomic, 0n),
    sampleMaxTotalAtomic: usdToAtomic(sample.max_total_usd),
    allocations,
    notes,
  };
}

/** Throws when the planned spend exceeds MAX_TOTAL_USD (caps.totalAtomic) or sample.max_total_usd. */
export function assertPlanWithinCaps(plan: BuyPlan, caps: Caps): void {
  if (plan.totalSpendAtomic > caps.totalAtomic)
    throw new Error(`planned spend ${atomicToUsd(plan.totalSpendAtomic)} USD exceeds MAX_TOTAL_USD ${atomicToUsd(caps.totalAtomic)} USD`);
  if (plan.totalSpendAtomic > plan.sampleMaxTotalAtomic)
    throw new Error(`planned spend ${atomicToUsd(plan.totalSpendAtomic)} USD exceeds sample.max_total_usd ${atomicToUsd(plan.sampleMaxTotalAtomic)} USD`);
  for (const a of plan.allocations)
    if (a.priceAtomic > (a.perCallCapAtomic ?? caps.perCallAtomic))
      throw new Error(`resource ${a.resourceId} price ${atomicToUsd(a.priceAtomic)} USD exceeds ${a.perCallCapAtomic !== undefined ? "its own per-call cap" : "MAX_PER_CALL_USD"}`);
}

const usd = (a: bigint) => {
  const s = atomicToUsd(a);
  return `$${s.replace(/0{1,4}$/, "")}`;
};

export function renderPlan(plan: BuyPlan): string {
  const lines = [
    `# Buy plan (${plan.network}, seed ${plan.seed})`,
    "",
    `Target ${plan.targetCalls} calls; planned ${plan.totalCalls} calls, ${usd(plan.totalSpendAtomic)} total.`,
    "",
    "| tier | category | sellers | resources | target calls | planned calls | planned spend | mean price |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const s of plan.strata) {
    const mean = s.calls > 0 ? s.plannedSpendAtomic / BigInt(s.calls) : 0n;
    lines.push(`| ${s.tier} | ${s.category} | ${s.sellers.length} | ${s.resources.length} | ${s.targetCalls} | ${s.calls} | ${usd(s.plannedSpendAtomic)} | ${usd(mean)} |`);
  }
  const sellers = new Set(plan.strata.flatMap((s) => s.sellers)).size;
  const resources = plan.strata.reduce((n, s) => n + s.resources.length, 0);
  lines.push(`| **total** | | ${sellers} | ${resources} | ${plan.strata.reduce((n, s) => n + s.targetCalls, 0)} | ${plan.totalCalls} | ${usd(plan.totalSpendAtomic)} | ${usd(plan.totalCalls ? plan.totalSpendAtomic / BigInt(plan.totalCalls) : 0n)} |`);
  if (plan.notes.length) {
    lines.push("", "Notes:", "");
    for (const n of plan.notes) lines.push(`- ${n}`);
  }
  return lines.join("\n") + "\n";
}

/** JSON-safe copy (bigints as decimal strings), e.g. for runs.args_json. */
export function planToJSON(plan: BuyPlan): unknown {
  return JSON.parse(JSON.stringify(plan, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}
