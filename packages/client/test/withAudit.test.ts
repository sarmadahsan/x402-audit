import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resourceKey, withAudit, type TelemetryRecord } from "../src/index.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const SELLER_BODY = { symbol: "ETH", price: 3123.45, asOf: "2026-10-23T12:00:00Z", note: "x".repeat(5000) };

function settlementHeader(o: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(o), "utf8").toString("base64");
}

interface Running {
  url: string;
  close(): Promise<void>;
}

async function start(app: Hono): Promise<Running> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

let seller: Running;
let ingest: Running;
const posts: Array<{ body: unknown; auth: string | undefined }> = [];

beforeAll(async () => {
  const s = new Hono();
  s.get("/v1/quote", (c) => {
    c.header(
      "PAYMENT-RESPONSE",
      settlementHeader({ success: true, transaction: "0xabc", network: "eip155:84532", payer: PAYER, amount: "10000" }),
    );
    return c.json(SELLER_BODY);
  });
  s.get("/free", (c) => c.json({ free: true }));
  seller = await start(s);

  const i = new Hono();
  i.post("/v1/calls", async (c) => {
    posts.push({ body: await c.req.json(), auth: c.req.header("authorization") });
    return c.json({ ok: true });
  });
  ingest = await start(i);
});

afterAll(async () => {
  await seller.close();
  await ingest.close();
});

beforeEach(() => {
  posts.length = 0;
});
afterEach(() => {
  delete process.env.X402_AUDIT_TELEMETRY;
});

const EXPECTED_KEYS = [
  "amount_atomic",
  "client_version",
  "flags",
  "latency_ms",
  "network",
  "outcome",
  "resource_hash",
  "seller_domain",
  "source_id",
  "status",
  "ts",
  "v",
  "validators",
];

describe("withAudit", () => {
  it("returns the full body unchanged and posts exactly one anonymised record", async () => {
    const audited = withAudit(fetch, { endpoint: `${ingest.url}/v1/calls`, sourceId: "agent-1", token: "t0k" });
    const res = await audited(`${seller.url}/v1/quote?symbol=ETH&secret=hunter2`, { headers: { "x-api-key": "k" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SELLER_BODY);
    await audited.flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]!.auth).toBe("Bearer t0k");
    const rec = posts[0]!.body as TelemetryRecord;
    expect(Object.keys(rec).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(rec.validators).sort()).toMatchInlineSnapshot(`
      [
        "content_type",
        "entity_matches",
        "freshness",
        "http_status",
        "injection_scan",
        "json_schema",
        "non_empty",
        "not_truncated",
      ]
    `);
    for (const s of Object.values(rec.validators)) expect(["pass", "fail", "skipped"]).toContain(s);
    expect(rec).toMatchObject({
      v: 1,
      source_id: "agent-1",
      seller_domain: "127.0.0.1",
      network: "eip155:84532",
      outcome: "ok",
      amount_atomic: "10000",
      status: 200,
    });
    expect(rec.flags).toContain("schema_missing");
    expect(rec).not.toHaveProperty("wallet");

    const raw = JSON.stringify(rec);
    for (const leak of ["hunter2", "symbol=", "secret", "x-api-key", "3123.45", "xxxxxxxx", "0xabc", PAYER, "?"]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("resource_hash is stable and excludes the query string", async () => {
    const audited = withAudit(fetch, { endpoint: `${ingest.url}/v1/calls`, sourceId: "agent-1" });
    await (await audited(`${seller.url}/v1/quote?symbol=ETH`)).text();
    await (await audited(`${seller.url}/v1/quote?symbol=BTC&x=1`)).text();
    await audited.flush();
    expect(posts).toHaveLength(2);
    const [a, b] = posts.map((p) => (p.body as TelemetryRecord).resource_hash);
    expect(a).toBe(b);
    const expected = createHash("sha256").update(`GET ${seller.url}/v1/quote`).digest("hex");
    expect(a).toBe(expected);
    expect(resourceKey("get", `${seller.url}/v1/quote?a=1#frag`)).toBe(`GET ${seller.url}/v1/quote`);
  });

  it("X402_AUDIT_TELEMETRY=off sends nothing and returns the response untouched", async () => {
    process.env.X402_AUDIT_TELEMETRY = "off";
    const audited = withAudit(fetch, { endpoint: `${ingest.url}/v1/calls`, sourceId: "agent-1" });
    const res = await audited(`${seller.url}/v1/quote`);
    expect(await res.json()).toEqual(SELLER_BODY);
    await audited.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(0);
  });

  it("ingest down: caller unaffected, no throw", async () => {
    const audited = withAudit(fetch, { endpoint: "http://127.0.0.1:9/v1/calls", sourceId: "agent-1" });
    const res = await audited(`${seller.url}/v1/quote`);
    expect(await res.json()).toEqual(SELLER_BODY);
    await expect(audited.flush()).resolves.toBeUndefined();
  });

  it("includeWallet copies the settlement payer", async () => {
    const seen: TelemetryRecord[] = [];
    const audited = withAudit(fetch, {
      endpoint: `${ingest.url}/v1/calls`,
      sourceId: "agent-1",
      includeWallet: true,
      onRecord: (r) => seen.push(r),
    });
    await (await audited(`${seller.url}/v1/quote`)).text();
    await audited.flush();
    expect((posts[0]!.body as TelemetryRecord).wallet).toBe(PAYER);
    expect(seen[0]!.wallet).toBe(PAYER);
  });

  it("does not report calls with no evidence of payment", async () => {
    const audited = withAudit(fetch, { endpoint: `${ingest.url}/v1/calls`, sourceId: "agent-1" });
    expect(await (await audited(`${seller.url}/free`)).json()).toEqual({ free: true });
    await audited.flush();
    expect(posts).toHaveLength(0);
  });

  it("rethrows inner fetch errors unchanged", async () => {
    const boom = new Error("network down");
    const audited = withAudit(async () => Promise.reject(boom), { endpoint: `${ingest.url}/v1/calls`, sourceId: "a" });
    await expect(audited("http://seller.invalid/x", { headers: { "PAYMENT-SIGNATURE": "sig" } })).rejects.toBe(boom);
    await audited.flush();
    expect(posts).toHaveLength(1);
    const rec = posts[0]!.body as TelemetryRecord;
    expect(rec.outcome).toBe("indeterminate");
    expect(rec.status).toBe(0);
    expect(rec.validators).toEqual({});
  });
});
