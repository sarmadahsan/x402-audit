/**
 * `audit-post`: a stored audit result (audit-host, audit-triggers) is re-sent to the index's POST /v1/audits with the
 * same signing as the original post, from the environment's secret, spending nothing. The body is built from the stored
 * row (triggered_at = the stored finished_at), so a repeat is a replay for the index and the command is idempotent.
 * 2026-11-02: the two audit-host results of 07:38 and 07:42 UTC answered 400 because the index did not yet accept
 * reason "operator"; once it does, they are re-posted with this.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAINNET } from "../config/index.js";
import { openDb, type Db } from "../db/index.js";
import { buildProgram } from "../cli.js";
import { latestStoredAuditResult, repostAuditResult, signAuditBody, storedAuditBody, storedAuditResult } from "./run.js";
import type { FetchImpl } from "./triggers.js";

const SECRET = "test-secret-never-printed";
const FINISHED = Date.UTC(2026, 10, 2, 7, 38, 12, 345);

function seed(db: Db): void {
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'api.fade.example', 0, 0), (2, 'api.site.example', 0, 0)").run();
  db.prepare("INSERT INTO runs (id, subcommand, args_json, config_hash, network, dry_run, started_at, finished_at, status) VALUES (7, 'audit', '{}', '', ?, 0, ?, ?, 'ok')").run(MAINNET, FINISHED - 60_000, FINISHED);
  const trig = db.prepare("INSERT INTO audit_triggers (id, evaluated_at, run_id, host, seller_id, reasons_json, source, priority, inputs_json, decision, planned_calls, planned_atomic) VALUES (?, ?, 7, ?, ?, ?, 'audit_operator', 0, '{}', 'planned', 33, '66000')");
  trig.run(11, FINISHED - 120_000, "api.fade.example", 1, '["operator"]');
  trig.run(12, FINISHED - 120_000, "api.site.example", 2, '["operator"]');
  const res = db.prepare("INSERT INTO audit_results (id, trigger_id, run_id, host, source, finished_at, calls, failures, rate, wilson_low, wilson_high, post_status, posted_at) VALUES (?, ?, 7, ?, 'audit_operator', ?, ?, ?, ?, ?, ?, ?, NULL)");
  res.run(1, 11, "api.fade.example", FINISHED, 33, 0, 0, 0, 0.105, "failed:400");
  res.run(2, 12, "api.site.example", FINISHED + 4 * 60_000, 33, 5, 0.1515, 0.0663, 0.3115, "failed:400");
  // An older result for the same host, already posted: --host picks the newest, --id 3 is skipped without --force.
  res.run(3, 12, "api.site.example", FINISHED - 86_400_000, 10, 1, 0.1, 0.0179, 0.4041, "posted");
  db.prepare("UPDATE audit_results SET posted_at = finished_at WHERE id = 3").run();
}

describe("repostAuditResult", () => {
  it("re-sends the stored row as the nine-field body, signed like the original, and records the index's answer", async () => {
    const db = openDb(":memory:");
    seed(db);
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
      return new Response('{"ok":true}', { status: 201 });
    };
    const now = FINISHED + 3 * 3_600_000;
    const r = storedAuditResult(db, 1)!;
    expect(r).toMatchObject({ id: 1, host: "api.fade.example", reason: "operator", calls: 33, failures: 0, post_status: "failed:400" });
    const out = await repostAuditResult(db, r, { index: "https://index.example/", secret: SECRET, fetchImpl, now });
    expect(out).toMatchObject({ id: 1, host: "api.fade.example", status: "posted", http: 201 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://index.example/v1/audits");
    const body = JSON.parse(seen[0]!.body);
    expect(Object.keys(body)).toEqual(["host", "triggered_at", "reason", "calls", "failures", "rate", "wilson_low", "wilson_high", "evidence_url"]);
    expect(body).toEqual({
      host: "api.fade.example",
      triggered_at: new Date(FINISHED).toISOString(),
      reason: "operator",
      calls: 33,
      failures: 0,
      rate: 0,
      wilson_low: 0,
      wilson_high: 0.105,
      evidence_url: "https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/evidence/api.fade.example.json",
    });
    const ts = seen[0]!.headers["x-paidfor-audit-timestamp"]!;
    expect(ts).toBe(String(Math.floor(now / 1000)));
    expect(seen[0]!.headers["x-paidfor-audit-signature"]).toBe(signAuditBody(SECRET, ts, seen[0]!.body));
    expect(seen[0]!.body).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const row = db.prepare("SELECT post_status, posted_at FROM audit_results WHERE id = 1").get() as { post_status: string; posted_at: number };
    expect(row).toEqual({ post_status: "posted", posted_at: now });
  });

  it("is idempotent: the same row makes the same body, a replay (200) is still posted, and a posted row is skipped without --force", async () => {
    const db = openDb(":memory:");
    seed(db);
    const r = latestStoredAuditResult(db, "API.Site.example.")!;
    expect(r.id).toBe(2);
    expect(storedAuditBody(r)).toEqual(storedAuditBody(storedAuditResult(db, 2)!));
    let status = 201;
    const fetchImpl: FetchImpl = async () => new Response("{}", { status });
    expect((await repostAuditResult(db, r, { index: "https://index.example", secret: SECRET, fetchImpl })).status).toBe("posted");
    status = 200;
    const again = await repostAuditResult(db, storedAuditResult(db, 2)!, { index: "https://index.example", secret: SECRET, fetchImpl, force: true });
    expect(again).toMatchObject({ status: "posted", http: 200 });
    const skipped = await repostAuditResult(db, storedAuditResult(db, 3)!, { index: "https://index.example", secret: SECRET, fetchImpl });
    expect(skipped).toMatchObject({ id: 3, status: "already_posted", http: null });
  });

  it("records a refusal and sends nothing without a secret", async () => {
    const db = openDb(":memory:");
    seed(db);
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls++;
      return new Response("bad", { status: 400 });
    };
    const refused = await repostAuditResult(db, storedAuditResult(db, 1)!, { index: "https://index.example", secret: SECRET, fetchImpl });
    expect(refused).toMatchObject({ status: "failed:400", http: 400 });
    expect((db.prepare("SELECT post_status, posted_at FROM audit_results WHERE id = 1").get() as { post_status: string; posted_at: null })).toEqual({ post_status: "failed:400", posted_at: null });
    const none = await repostAuditResult(db, storedAuditResult(db, 1)!, { index: "https://index.example", secret: "", fetchImpl });
    expect(none).toMatchObject({ status: "skipped_no_secret", http: null });
    expect(calls).toBe(1);
  });
});

describe("audit-post (CLI) against a mock index", () => {
  let server: Server;
  let origin: string;
  const received: { sig: string; ts: string; body: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ sig: String(req.headers["x-paidfor-audit-signature"]), ts: String(req.headers["x-paidfor-audit-timestamp"]), body });
        const ok = req.url === "/v1/audits" && signAuditBody(SECRET, String(req.headers["x-paidfor-audit-timestamp"]), body) === req.headers["x-paidfor-audit-signature"];
        res.writeHead(ok ? 201 : 401, { "content-type": "application/json" }).end(ok ? '{"ok":true}' : '{"error":"bad signature"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address() as { port: number };
    origin = `http://127.0.0.1:${a.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("posts the two stored results by --host and prints the HTTP status, never the secret", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dbPath = join(mkdtempSync(join(tmpdir(), "audit-post-")), "audit.sqlite");
    seed(openDb(dbPath));
    const prev = process.env.AUDIT_SECRET;
    process.env.AUDIT_SECRET = SECRET;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await buildProgram().parseAsync(["--db", dbPath, "--network", MAINNET, "audit-post", "--host", "api.fade.example", "--host", "api.site.example", "--latest", "--index", origin], { from: "user" });
    } finally {
      console.log = orig;
      if (prev === undefined) delete process.env.AUDIT_SECRET;
      else process.env.AUDIT_SECRET = prev;
    }
    expect(received).toHaveLength(2);
    expect(received.map((r) => JSON.parse(r.body).host)).toEqual(["api.fade.example", "api.site.example"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^audit-post #1 api\.fade\.example \(operator, 33 calls, 0 failures, triggered_at 2026-11-02T07:38:12\.345Z\): posted \(HTTP 201\)$/);
    expect(lines[1]).toMatch(/^audit-post #2 api\.site\.example .*: posted \(HTTP 201\)$/);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
