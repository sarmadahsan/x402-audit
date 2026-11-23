import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { usdToAtomic, type Caps } from "../config/index.js";
import { buildCoveragePlan } from "../buy/allocate.js";
import { addAllSellersToProbeSet, buildProbeSet, listProbeSet, mulberry32 } from "./set.js";
import { insertResource, insertSeller } from "./test-helpers.js";

const NET = "eip155:8453";

function fixture() {
  const db = openDb(":memory:");
  const s1 = insertSeller(db, "one.example", { rank: 1 });
  const s2 = insertSeller(db, "two.example", { rank: 2 });
  const s3 = insertSeller(db, "unranked-busy.example", { rank: null, calls: 500 });
  const sx = insertSeller(db, "excluded.example", { rank: 3, excluded: true });
  const sp = insertSeller(db, "permit2.example", { rank: 4 });
  const ids = {
    s1low: insertResource(db, { sellerId: s1, url: "https://one.example/a", network: NET, bazaarCalls: 10 }),
    s1high: insertResource(db, { sellerId: s1, url: "https://one.example/b", network: NET, bazaarCalls: 99, declaredPriceAtomic: "500" }),
    s1tieCheap: insertResource(db, { sellerId: s1, url: "https://one.example/c", network: NET, bazaarCalls: 99, declaredPriceAtomic: "20" }),
    s2: insertResource(db, { sellerId: s2, url: "https://two.example/a", network: NET }),
    s3: insertResource(db, { sellerId: s3, url: "https://busy.example/a", network: NET }),
    sx: insertResource(db, { sellerId: sx, url: "https://excluded.example/a", network: NET }),
    sp: insertResource(db, { sellerId: sp, url: "https://permit2.example/a", network: NET, transferMethod: "permit2" }),
    otherNet: insertResource(db, { sellerId: s2, url: "https://two.example/sol", network: "solana:mainnet" }),
    noPayTo: insertResource(db, { sellerId: s2, url: "https://two.example/nopay", network: NET, payTo: null }),
  };
  const tailSellers: number[] = [];
  for (let i = 0; i < 10; i++) {
    const s = insertSeller(db, `tail${i}.example`);
    tailSellers.push(s);
    insertResource(db, { sellerId: s, url: `https://tail${i}.example/a`, network: NET });
    insertResource(db, { sellerId: s, url: `https://tail${i}.example/b`, network: NET });
  }
  return { db, ids };
}

describe("buildProbeSet", () => {
  it("picks one top resource per ranked seller, a seeded tail, and skips excluded/permit2", () => {
    const { db, ids } = fixture();
    const r = buildProbeSet(db, { topSellers: 3, tailResources: 4, seed: 42, network: NET, now: 1000 });
    expect(r).toEqual({ top: 3, tail: 4, skippedExcluded: 1, skippedPermit2: 1 });
    const set = listProbeSet(db);
    const top = set.filter((s) => s.stratum === "top").map((s) => s.resourceId);
    // highest bazaar calls, tie broken by lower declared price
    expect(top).toContain(ids.s1tieCheap);
    expect(top).toContain(ids.s2);
    expect(top).toContain(ids.s3); // rank NULL sorts last but still fills the third slot
    const tail = set.filter((s) => s.stratum === "tail");
    expect(new Set(tail.map((t) => t.sellerId)).size).toBe(4);
    for (const t of tail) expect(t.sellerDomain).toMatch(/^tail\d\.example$/);
    for (const s of set) expect(s.seed).toBe(42);

    // Same seed -> same selection.
    const again = buildProbeSet(db, { topSellers: 3, tailResources: 4, seed: 42, network: NET, now: 2000 });
    expect(again.tail).toBe(4);
    expect(listProbeSet(db).map((s) => s.resourceId).sort()).toEqual(set.map((s) => s.resourceId).sort());
  });

  it("rebuild deactivates old rows without deleting them", () => {
    const { db } = fixture();
    buildProbeSet(db, { topSellers: 3, tailResources: 4, seed: 1, network: NET, now: 1000 });
    buildProbeSet(db, { topSellers: 1, tailResources: 0, seed: 2, network: NET, now: 2000 });
    const all = db.prepare(`SELECT * FROM probe_set`).all() as { active: number; seed: number }[];
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.filter((r) => r.active === 1)).toHaveLength(1);
    expect(listProbeSet(db)).toHaveLength(1);
    expect(listProbeSet(db)[0]?.seed).toBe(2);
  });

  it("mulberry32 is deterministic", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("addAllSellersToProbeSet (stratum all)", () => {
  /** The production shape in small: a top seller, a tail draw that misses most sellers, one discovery row, and sellers
   * that were listed from day one but never drawn, among them one with only ineligible resources and one on exclude.yaml. */
  function dayOne() {
    const db = openDb(":memory:");
    const top = insertSeller(db, "top.example", { rank: 1 });
    insertResource(db, { sellerId: top, url: "https://top.example/a", network: NET });
    const drawn = insertSeller(db, "drawn.example", { rank: 2 });
    insertResource(db, { sellerId: drawn, url: "https://drawn.example/a", network: NET });
    buildProbeSet(db, { topSellers: 1, tailResources: 1, seed: 3, network: NET, now: 1000 });
    const disc = insertSeller(db, "discovered.example");
    const discRes = insertResource(db, { sellerId: disc, url: "https://discovered.example/a", network: NET });
    db.prepare("INSERT INTO probe_set (resource_id, stratum, seed, selected_at, active, note) VALUES (?, 'discovery', 0, 2000, 1, 'discover refresh')").run(discRes);
    // oceanalt-like: listed on day one with several eligible resources, never drawn; picks the busiest, then cheapest.
    const ocean = insertSeller(db, "oceanalt.example", { calls: 40 });
    db.prepare("UPDATE sellers SET category = 'data' WHERE id = ?").run(ocean);
    const oceanPick = insertResource(db, { sellerId: ocean, url: "https://oceanalt.example/busy-cheap", network: NET, bazaarCalls: 30, declaredPriceAtomic: "2000" });
    insertResource(db, { sellerId: ocean, url: "https://oceanalt.example/busy-dear", network: NET, bazaarCalls: 30, declaredPriceAtomic: "100000" });
    insertResource(db, { sellerId: ocean, url: "https://oceanalt.example/quiet", network: NET, bazaarCalls: 1, declaredPriceAtomic: "10" });
    insertResource(db, { sellerId: ocean, url: "https://oceanalt.example/t/{id}", network: NET, bazaarCalls: 999, declaredPriceAtomic: "10" });
    const quiet = insertSeller(db, "quiet.example");
    db.prepare("UPDATE sellers SET category = 'inference' WHERE id = ?").run(quiet);
    const quietPick = insertResource(db, { sellerId: quiet, url: "https://quiet.example/a", network: NET });
    // Nothing eligible: permit2, another network, no pay-to, a path template, a non-numeric price.
    const none = insertSeller(db, "nothing.example");
    insertResource(db, { sellerId: none, url: "https://nothing.example/p2", network: NET, transferMethod: "permit2" });
    insertResource(db, { sellerId: none, url: "https://nothing.example/sol", network: "solana:mainnet" });
    insertResource(db, { sellerId: none, url: "https://nothing.example/nopay", network: NET, payTo: null });
    insertResource(db, { sellerId: none, url: "https://nothing.example/u/:id", network: NET });
    insertResource(db, { sellerId: none, url: "https://nothing.example/price", network: NET, declaredPriceAtomic: "free" });
    const flagged = insertSeller(db, "flagged.example", { excluded: true });
    insertResource(db, { sellerId: flagged, url: "https://flagged.example/a", network: NET });
    const listed = insertSeller(db, "listed-out.example");
    insertResource(db, { sellerId: listed, url: "https://listed-out.example/a", network: NET });
    return { db, ids: { top, drawn, disc, ocean, oceanPick, quiet, quietPick, none, flagged, listed } };
  }
  const exclude = { sellers: [{ domain: "listed-out.example", reason: "test" }], resource_prefixes: [] };

  it("dry run reports who would join, by category, and the round size without writing", () => {
    const { db } = dayOne();
    const before = db.prepare("SELECT resource_id, stratum, active FROM probe_set ORDER BY id").all();
    const r = addAllSellersToProbeSet(db, { network: NET, now: 5000, exclude, dryRun: true });
    expect(r).toEqual({
      sellers: 8,
      excludedSellers: 1,
      coveredBefore: 3,
      coveredByStratum: { top: 1, tail: 1, discovery: 1 },
      joining: 2,
      joiningByCategory: { data: 1, inference: 1 },
      noEligibleResource: 1,
      excludedByConfig: 1,
      roundBefore: 3,
      roundAfter: 5,
      requestsPerRound: 10,
      added: 0,
      dryRun: true,
    });
    expect(db.prepare("SELECT resource_id, stratum, active FROM probe_set ORDER BY id").all()).toEqual(before);
  });

  it("adds one resource per uncovered seller as stratum all, by the discovery pick order, and is idempotent", () => {
    const { db, ids } = dayOne();
    const r = addAllSellersToProbeSet(db, { network: NET, now: 5000, exclude });
    expect([r.added, r.joining, r.dryRun]).toEqual([2, 2, false]);
    const all = listProbeSet(db).filter((s) => s.stratum === "all");
    expect(all.map((s) => s.resourceId).sort()).toEqual([ids.oceanPick, ids.quietPick].sort());
    expect(all.find((s) => s.sellerId === ids.ocean)?.url).toBe("https://oceanalt.example/busy-cheap");
    expect(all.every((s) => s.selectedAt === 5000)).toBe(true);
    expect(listProbeSet(db)).toHaveLength(5);
    // Every other stratum is untouched; one resource per seller.
    expect(listProbeSet(db).filter((s) => s.stratum !== "all")).toHaveLength(3);
    expect(new Set(listProbeSet(db).map((s) => s.sellerId)).size).toBe(5);
    const again = addAllSellersToProbeSet(db, { network: NET, now: 6000, exclude });
    expect([again.added, again.joining, again.coveredBefore, again.coveredByStratum["all"]]).toEqual([0, 0, 5, 2]);
    expect(listProbeSet(db)).toHaveLength(5);
  });

  it("prefers a listed resource over a user candidate, so the pick is one the buy lanes can price", () => {
    const { db } = dayOne();
    const mixed = insertSeller(db, "mixed.example");
    // The candidate probe filled price and pay-to on the user row, and it is cheaper; neither has Bazaar calls.
    const userRow = insertResource(db, { sellerId: mixed, url: "https://mixed.example/checked", network: NET, source: "user", declaredPriceAtomic: "100" });
    const listed = insertResource(db, { sellerId: mixed, url: "https://mixed.example/listed", network: NET, source: "bazaar", declaredPriceAtomic: "5000" });
    addAllSellersToProbeSet(db, { network: NET, now: 5000, exclude });
    const pick = listProbeSet(db).filter((s) => s.sellerId === mixed);
    expect(pick.map((s) => s.resourceId)).toEqual([listed]);
    expect(pick[0]!.resourceId).not.toBe(userRow);
    // A seller with only a user row is still probed on it (the candidate lane buys it under its own gate).
    const only = insertSeller(db, "only-user.example");
    const onlyRow = insertResource(db, { sellerId: only, url: "https://only-user.example/checked", network: NET, source: "user" });
    addAllSellersToProbeSet(db, { network: NET, now: 6000, exclude });
    expect(listProbeSet(db).find((s) => s.sellerId === only)?.resourceId).toBe(onlyRow);
  });

  it("covers a seller that arrives later and never deletes a row", () => {
    const { db, ids } = dayOne();
    addAllSellersToProbeSet(db, { network: NET, now: 5000, exclude });
    const late = insertSeller(db, "late.example");
    const lateRes = insertResource(db, { sellerId: late, url: "https://late.example/a", network: NET });
    const r = addAllSellersToProbeSet(db, { network: NET, now: 7000, exclude });
    expect([r.added, r.roundBefore, r.roundAfter]).toEqual([1, 5, 6]);
    expect(listProbeSet(db).find((s) => s.resourceId === lateRes)?.stratum).toBe("all");
    // A rebuild by `probe plan` deactivates rows; select reactivates its seller's pick as `all`, deleting nothing.
    const rowsBefore = (db.prepare("SELECT COUNT(*) n FROM probe_set").get() as { n: number }).n;
    buildProbeSet(db, { topSellers: 1, tailResources: 0, seed: 3, network: NET, now: 8000 });
    expect(listProbeSet(db)).toHaveLength(1);
    const after = addAllSellersToProbeSet(db, { network: NET, now: 9000, exclude });
    expect(after.added).toBe(5); // drawn, discovered, oceanalt, quiet and late come back as `all`
    expect((db.prepare("SELECT COUNT(*) n FROM probe_set").get() as { n: number }).n).toBe(rowsBefore);
    // The old tail row was reactivated in place, as `all`, not duplicated.
    expect(listProbeSet(db).find((s) => s.sellerId === ids.drawn)?.stratum).toBe("all");
    expect(listProbeSet(db).filter((s) => s.stratum === "all")).toHaveLength(5);
  });

  it("a seller it adds becomes buyable by the coverage lane once a round records its 402", () => {
    const { db, ids } = dayOne();
    const caps: Caps = { perCallAtomic: usdToAtomic(0.1), perSellerPerDayAtomic: usdToAtomic(20), perDayAtomic: usdToAtomic(100), totalAtomic: usdToAtomic(300), stressTotalAtomic: usdToAtomic(30), auditPerDayAtomic: usdToAtomic(5) };
    const now = 10_000_000;
    const plan = () => buildCoveragePlan(db, { network: NET, caps, budgetAtomic: usdToAtomic(1), runBudgetAtomic: usdToAtomic(1), coverageShare: 0.7, seed: 1, now, tiersSince: 0 });
    // The covered sellers have probes; the day-one seller has none, so the lane cannot see it.
    for (const rid of listProbeSet(db).map((s) => s.resourceId)) db.prepare("INSERT INTO probes (resource_id, client_identity, ts, status, amount_atomic, network) VALUES (?, 'A', ?, 402, '10000', ?)").run(rid, now - 3_600_000, NET);
    expect(plan().plan.allocations.some((a) => a.sellerId === ids.ocean)).toBe(false);
    // `probe select` adds its resource; the next hourly round records a 402 at the listed price.
    addAllSellersToProbeSet(db, { network: NET, now: now - 1_800_000, exclude });
    db.prepare("INSERT INTO probes (resource_id, client_identity, ts, status, amount_atomic, network) VALUES (?, 'A', ?, 402, '2000', ?)").run(ids.oceanPick, now - 1_700_000, NET);
    const a = plan().plan.allocations.filter((x) => x.sellerId === ids.ocean);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]!.tier).toBe("admit");
    expect(a[0]!.resourceId).toBe(ids.oceanPick);
    expect([a[0]!.priceAtomic, a[0]!.planAtomic]).toEqual([2000n, 2400n]);
  });
});
