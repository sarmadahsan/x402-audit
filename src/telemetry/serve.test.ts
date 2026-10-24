import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { parseBind, serveTelemetry, type TelemetryServer } from "./serve.js";
import { telemetryReport } from "./report.js";

const quiet = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function record(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    source_id: "agent-1",
    client_version: "0.1.0",
    ts: 1_761_220_800_000,
    resource_hash: "a".repeat(64),
    seller_domain: "api.example.com",
    network: "eip155:8453",
    outcome: "ok",
    flags: ["schema_missing"],
    amount_atomic: "10000",
    latency_ms: 120,
    status: 200,
    validators: { http_status: "pass", non_empty: "pass", json_schema: "skipped" },
    ...o,
  };
}

let server: TelemetryServer | undefined;
let db: Db;
afterEach(async () => {
  await server?.close();
  server = undefined;
  db?.close();
});

async function start(token?: string): Promise<string> {
  db = openDb(":memory:");
  server = await serveTelemetry(db, { bind: "127.0.0.1:0", log: quiet, ...(token ? { token } : {}) });
  return server.url;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/calls`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("serveTelemetry", () => {
  it("healthz", async () => {
    const url = await start();
    const r = await fetch(`${url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("stores a valid record in telemetry_calls and upserts the source", async () => {
    const url = await start();
    expect((await post(url, record())).status).toBe(201);
    expect((await post(url, record({ outcome: "non_delivery", status: 500, wallet: "0xabc" }))).status).toBe(201);
    const sources = db.prepare("SELECT * FROM telemetry_sources").all() as Array<{ source_id: string }>;
    expect(sources.map((s) => s.source_id)).toEqual(["agent-1"]);
    const rows = db.prepare("SELECT * FROM telemetry_calls ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source_id: "agent-1",
      client_ts: 1_761_220_800_000,
      resource_hash: "a".repeat(64),
      seller_domain: "api.example.com",
      network: "eip155:8453",
      outcome: "ok",
      flags_json: '["schema_missing"]',
      amount_atomic: "10000",
      latency_ms: 120,
      wallet: null,
      client_version: "0.1.0",
    });
    expect(typeof rows[0]!.received_at).toBe("number");
    expect(JSON.parse(rows[0]!.raw_json as string)).toEqual(record());
    expect(rows[1]!.wallet).toBe("0xabc");

    const md = telemetryReport(db);
    expect(md).toContain("## agent-1");
    expect(md).toContain("Records: 2");
    expect(md).toContain("Failure rate: 50.0% (1/2)");
    expect(md).toContain("| non_delivery | 1 | 50.0% |");
  });

  it("rejects schema failures with 400 and stores nothing", async () => {
    const url = await start();
    const bad = [
      record({ outcome: "great" }),
      record({ resource_hash: "xyz" }),
      record({ body: "leaked" }),
      record({ flags: ["not_a_flag"] }),
      record({ v: 2 }),
      record({ validators: { http_status: "maybe" } }),
      "not json",
    ];
    for (const b of bad) expect((await post(url, b)).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM telemetry_calls").get()).toEqual({ n: 0 });
  });

  it("enforces the bearer token when configured", async () => {
    const url = await start("s3cret");
    expect((await post(url, record())).status).toBe(401);
    expect((await post(url, record(), { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(url, record(), { authorization: "s3cret" })).status).toBe(401);
    expect((await post(url, record(), { authorization: "Bearer s3cret" })).status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS n FROM telemetry_calls").get()).toEqual({ n: 1 });
  });

  it("rejects bodies over 32 KB with 413", async () => {
    const url = await start();
    const r = await post(url, record({ client_version: "x".repeat(40 * 1024) }));
    expect(r.status).toBe(413);
  });

  it("rate limits at 60 requests per minute per source_id", async () => {
    const url = await start();
    for (let i = 0; i < 60; i++) expect((await post(url, record())).status).toBe(201);
    expect((await post(url, record())).status).toBe(429);
    // A different source is unaffected.
    expect((await post(url, record({ source_id: "agent-2" }))).status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS n FROM telemetry_calls").get()).toEqual({ n: 61 });
  });

  it("parseBind", () => {
    expect(parseBind("127.0.0.1:8787")).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(parseBind("[::1]:0")).toEqual({ host: "::1", port: 0 });
    expect(() => parseBind("nope")).toThrow();
  });

  it("report with no data", () => {
    db = openDb(":memory:");
    expect(telemetryReport(db)).toContain("No telemetry records received.");
  });
});

describe("client -> ingest end to end", () => {
  it("a record produced by @x402-audit/client passes the ingest schema", async () => {
    const { withAudit } = await import("../../packages/client/src/index.js");
    const url = await start("tok");
    const settlement = Buffer.from(
      JSON.stringify({ success: true, transaction: "0x1", network: "eip155:84532", payer: "0x2222", amount: "5000" }),
    ).toString("base64");
    const sellerFetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settlement },
      });
    const audited = withAudit(sellerFetch, { endpoint: `${url}/v1/calls`, sourceId: "e2e", token: "tok", includeWallet: true });
    await (await audited("https://seller.example/v1/thing?q=1")).text();
    await audited.flush();
    const rows = db.prepare("SELECT source_id, seller_domain, outcome, wallet, amount_atomic FROM telemetry_calls").all();
    expect(rows).toEqual([{ source_id: "e2e", seller_domain: "seller.example", outcome: "ok", wallet: "0x2222", amount_atomic: "5000" }]);
  });
});
