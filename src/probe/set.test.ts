import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { buildProbeSet, listProbeSet, mulberry32 } from "./set.js";
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
