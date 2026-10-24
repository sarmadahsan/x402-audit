import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockSeller, type MockSeller } from "../../tools/mock-seller/server.js";
import { openDb, type Db } from "../db/index.js";
import type { FetchImpl } from "../x402/http.js";
import { IDENTITY_A, type ClientIdentity } from "./identities.js";
import { buildProbeSet } from "./set.js";
import { buildRequest, exampleBodyFromInput, modalAmount, runProbeRound, synthesizeBodyFromFields } from "./run.js";
import { probeLoop } from "./schedule.js";
import { probeReport } from "./report.js";
import { insertResource, insertSeller, silentLog } from "./test-helpers.js";

const NET = "eip155:84532";
/** The mock's /fail/price-discriminate quotes 2x when the User-Agent contains "identity-b". */
const TEST_IDENTITIES: ClientIdentity[] = [
  IDENTITY_A,
  { id: "B", headers: { "user-agent": "node identity-b", accept: "*/*" }, description: "test B" },
];

const PATHS = ["/ok", "/fail/overcharge", "/fail/payto-change", "/fail/price-discriminate", "/fail/slow", "/__mock/catalog"] as const;

/** /fail/slow only sleeps after payment; delay its unpaid quote past the declared 1 s so `slow` triggers. */
const slowFetch: FetchImpl = async (input, init) => {
  if (String(input).includes("/fail/slow")) await new Promise((r) => setTimeout(r, 1100));
  return fetch(input, init);
};

let seller: MockSeller;

beforeAll(async () => {
  seller = await startMockSeller({ port: 0, network: NET });
});
afterAll(async () => {
  await seller.close();
});

function seed(db: Db): Record<(typeof PATHS)[number], number> {
  const out = {} as Record<(typeof PATHS)[number], number>;
  PATHS.forEach((p, i) => {
    const s = insertSeller(db, `seller${i}.mock`, { rank: i + 1 });
    out[p] = insertResource(db, { sellerId: s, url: `${seller.url}${p}`, network: NET, declaredPriceAtomic: "10000" });
  });
  return out;
}

interface ProbeRec {
  id: number;
  resource_id: number;
  client_identity: string;
  round_id: string;
  outcome: string | null;
  flags_json: string;
  reference_source: string | null;
  reference_price_atomic: string | null;
  amount_atomic: string | null;
  error: string | null;
  status: number | null;
  requirements_json: string | null;
  accepts_json: string | null;
  request_headers_json: string;
  pay_to: string | null;
  max_timeout_seconds: number | null;
}
const rowsFor = (db: Db, rid: number) =>
  db.prepare(`SELECT * FROM probes WHERE resource_id = ? ORDER BY id`).all(rid) as ProbeRec[];
const flags = (r: ProbeRec) => JSON.parse(r.flags_json) as string[];

describe("runProbeRound against the mock seller", () => {
  const db = openDb(":memory:");
  let ids: ReturnType<typeof seed>;
  const stats: Awaited<ReturnType<typeof runProbeRound>>[] = [];

  beforeAll(async () => {
    seller.reset();
    ids = seed(db);
    const built = buildProbeSet(db, { topSellers: 3, tailResources: 10, seed: 7, network: NET });
    expect(built.top + built.tail).toBe(PATHS.length);
    for (let i = 0; i < 2; i++) {
      stats.push(
        await runProbeRound(db, { network: NET, identities: TEST_IDENTITIES, fetchImpl: slowFetch, perRequestGapMs: 0, log: silentLog, timeoutMs: 5000 }),
      );
    }
  }, 30_000);

  it("writes one row per resource x identity x round", () => {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM probes`).get() as { n: number }).n;
    expect(n).toBe(PATHS.length * 2 * 2);
    expect(stats[0]?.requests).toBe(PATHS.length * 2);
    expect(stats[0]?.got402).toBe((PATHS.length - 1) * 2);
    expect(stats[0]?.notProbeable).toBe(2);
    expect(stats[0]?.halted).toBe(false);
    expect(new Set((db.prepare(`SELECT DISTINCT round_id FROM probes`).all() as { round_id: string }[]).map((r) => r.round_id)).size).toBe(2);
  });

  it("/ok is ok and stores the full quote", () => {
    const rows = rowsFor(db, ids["/ok"]);
    for (const r of rows) {
      expect(r.outcome).toBe("ok");
      expect(flags(r)).toEqual([]);
      expect(r.status).toBe(402);
      expect(r.amount_atomic).toBe("10000");
      expect(JSON.parse(r.requirements_json ?? "{}").scheme).toBe("exact");
      expect(JSON.parse(r.accepts_json ?? "[]")).toHaveLength(1);
      expect(r.reference_source).toBe("bazaar");
    }
    expect(JSON.parse(rows[0]?.request_headers_json ?? "{}")["user-agent"]).toContain("x402-audit");
  });

  it("/fail/overcharge is overcharge against the bazaar reference", () => {
    for (const r of rowsFor(db, ids["/fail/overcharge"])) {
      expect(r.outcome).toBe("overcharge");
      expect(r.reference_source).toBe("bazaar");
      expect(r.reference_price_atomic).toBe("10000");
      expect(r.amount_atomic).toBe("100000");
    }
    // 2 from /fail/overcharge + identity B's 2x quote on /fail/price-discriminate
    expect(stats[0]?.overcharge).toBe(3);
  });

  it("/fail/payto-change flags the second quote and writes a price event", () => {
    const rows = rowsFor(db, ids["/fail/payto-change"]);
    expect(flags(rows[0] as ProbeRec)).not.toContain("payto_changed");
    expect(flags(rows[1] as ProbeRec)).toContain("payto_changed");
    const ev = db.prepare(`SELECT * FROM price_events WHERE resource_id = ? AND kind = 'payto_changed' ORDER BY id`).all(ids["/fail/payto-change"]) as {
      old_value: string;
      new_value: string;
      probe_id: number;
    }[];
    expect(ev.length).toBe(3); // every quote after the first alternates
    expect(ev[0]?.probe_id).toBe(rows[1]?.id);
    expect(ev[0]?.old_value.toLowerCase()).toBe(rows[0]?.pay_to?.toLowerCase());
    expect(ev[0]?.new_value.toLowerCase()).toBe(rows[1]?.pay_to?.toLowerCase());
  });

  it("/fail/price-discriminate flags both rows and writes an event", () => {
    const rows = rowsFor(db, ids["/fail/price-discriminate"]);
    const round1 = rows.filter((r) => r.round_id === rows[0]?.round_id);
    expect(round1.map((r) => r.amount_atomic).sort()).toEqual(["10000", "20000"]);
    for (const r of rows) expect(flags(r)).toContain("price_discrimination");
    const ev = db.prepare(`SELECT * FROM price_events WHERE resource_id = ? AND kind = 'price_discrimination'`).all(ids["/fail/price-discriminate"]) as {
      details_json: string;
    }[];
    expect(ev.length).toBe(2);
    expect(JSON.parse(ev[0]?.details_json ?? "{}")).toMatchObject({ A: "10000", B: "20000" });
    // per-identity drift: same identity, same price -> no quote drift
    const drift = db.prepare(`SELECT COUNT(*) AS n FROM price_events WHERE resource_id = ? AND kind = 'quote_drift'`).get(ids["/fail/price-discriminate"]) as { n: number };
    expect(drift.n).toBe(0);
    // /ok never discriminates
    for (const r of rowsFor(db, ids["/ok"])) expect(flags(r)).not.toContain("price_discrimination");
  });

  it("/fail/slow is flagged slow (declared maxTimeoutSeconds 1)", () => {
    for (const r of rowsFor(db, ids["/fail/slow"])) {
      expect(r.max_timeout_seconds).toBe(1);
      expect(flags(r)).toContain("slow");
      expect(r.outcome).toBe("ok");
    }
    expect(stats[0]?.slow).toBe(2);
  });

  it("a non-402 resource is not probeable (outcome NULL, error no_402)", () => {
    for (const r of rowsFor(db, ids["/__mock/catalog"])) {
      expect(r.outcome).toBeNull();
      expect(r.error).toMatch(/^no_402:200/);
    }
  });

  it("probeReport renders and mentions the pay-to change", () => {
    const md = probeReport(db);
    expect(md).toContain("# Probe report");
    expect(md).toContain("Rounds: 2");
    expect(md).toContain("## Pay-to changes (3)");
    expect(md).toContain("/fail/payto-change");
    expect(md).toContain("no_402:200");
    expect(md).toMatch(/seller\d\.mock/);
  });
});

describe("halt", () => {
  it("halt file stops a round early", async () => {
    const db = openDb(":memory:");
    seed(db);
    buildProbeSet(db, { topSellers: 10, tailResources: 0, seed: 1, network: NET });
    const root = mkdtempSync(join(tmpdir(), "probe-halt-"));
    try {
      let calls = 0;
      const haltAfterFirst: FetchImpl = async (input, init) => {
        calls++;
        if (calls === 1) writeFileSync(join(root, "halt"), "");
        return fetch(input, init);
      };
      const s = await runProbeRound(db, { network: NET, identities: TEST_IDENTITIES, fetchImpl: haltAfterFirst, perRequestGapMs: 0, log: silentLog, haltRoot: root });
      expect(s.halted).toBe(true);
      expect(s.resources).toBe(1);
      expect(s.requests).toBe(2);
      // probeLoop refuses to start while halted
      const rounds = await probeLoop(db, { network: NET, log: silentLog, haltRoot: root, maxRounds: 3 });
      expect(rounds).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reference price fallback", () => {
  it("uses first_seen then modal_7d when the declared price is NULL", async () => {
    seller.reset();
    const db = openDb(":memory:");
    const s = insertSeller(db, "modal.mock", { rank: 1 });
    const rid = insertResource(db, { sellerId: s, url: `${seller.url}/ok`, network: NET });
    buildProbeSet(db, { topSellers: 1, tailResources: 0, seed: 1, network: NET });
    db.prepare(`UPDATE resources SET declared_price_atomic = NULL WHERE id = ?`).run(rid);
    for (let i = 0; i < 3; i++) {
      await runProbeRound(db, { network: NET, identities: TEST_IDENTITIES, perRequestGapMs: 0, log: silentLog });
    }
    const rows = rowsFor(db, rid);
    expect(rows).toHaveLength(6);
    expect(rows[0]?.reference_source).toBe("first_seen");
    for (const r of rows.slice(1)) {
      expect(r.reference_source).toBe("modal_7d");
      expect(r.reference_price_atomic).toBe("10000");
      expect(r.outcome).toBe("ok");
    }
  });
});

describe("probeLoop", () => {
  it("runs maxRounds and is cancellable", async () => {
    const db = openDb(":memory:");
    const s = insertSeller(db, "loop.mock", { rank: 1 });
    insertResource(db, { sellerId: s, url: `${seller.url}/ok`, network: NET });
    buildProbeSet(db, { topSellers: 1, tailResources: 0, seed: 1, network: NET });
    const root = mkdtempSync(join(tmpdir(), "probe-loop-"));
    try {
      const n = await probeLoop(db, { network: NET, log: silentLog, perRequestGapMs: 0, everyMs: 50, maxRounds: 2, haltRoot: root });
      expect(n).toBe(2);
      const ac = new AbortController();
      const p = probeLoop(db, { network: NET, log: silentLog, perRequestGapMs: 0, everyMs: 3_600_000, haltRoot: root, signal: ac.signal });
      setTimeout(() => ac.abort(), 200);
      expect(await p).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("modalAmount ties toward the lower price", () => {
    expect(modalAmount(["20", "10", "20", "10", "30"])).toBe("10");
    expect(modalAmount(["5", "7", "7"])).toBe("7");
    expect(modalAmount([])).toBeUndefined();
  });

  it("POST uses a bazaar body example when present, else {}", () => {
    const input = JSON.stringify({ extensions: { bazaar: { info: { input: { type: "http", method: "POST", body: { q: "BTC" } } } } } });
    expect(exampleBodyFromInput(input)).toEqual({ q: "BTC" });
    const r = buildRequest({ method: "POST", inputJson: input }, IDENTITY_A);
    expect(r.body).toBe('{"q":"BTC"}');
    expect(r.headers["content-type"]).toBe("application/json");
    expect(buildRequest({ method: "post", inputJson: null }, IDENTITY_A).body).toBe("{}");
    expect(buildRequest({ method: "GET", inputJson: input }, IDENTITY_A).body).toBeUndefined();
  });
});

describe("synthesizeBodyFromFields", () => {
  it("builds a minimal chat-completions body from a blockrun-style descriptor", () => {
    const input = JSON.stringify({
      bodyFields: {
        max_tokens: { description: "Maximum tokens to generate", type: "integer" },
        messages: { description: "Array of chat messages with role and content", type: "array" },
        model: { description: "AI model ID (e.g., gpt-4o-mini, claude-haiku-4.5)", type: "string" },
        stream: { description: "Enable streaming responses", type: "boolean" },
        temperature: { description: "Sampling temperature (0-2)", type: "number" },
      },
      method: "POST",
      type: "http",
    });
    expect(exampleBodyFromInput(input)).toEqual({ max_tokens: 1, messages: [{ role: "user", content: "ping" }], model: "gpt-4o-mini", stream: false, temperature: 1 });
    expect(synthesizeBodyFromFields({ q: { type: "string" }, n: { enum: [5, 6] }, flag: { type: "boolean", default: true } })).toEqual({ q: "x402-audit", n: 5, flag: true });
  });
});
