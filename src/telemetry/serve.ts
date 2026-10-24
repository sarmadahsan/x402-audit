/**
 * `telemetry serve`: ingest server for records posted by @x402-audit/client.
 * POST /v1/calls (one JSON record), GET /healthz.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Db } from "../db/index.js";
import type { log as defaultLog } from "../log.js";
import { TelemetryRecordSchema, type IngestRecord } from "./schema.js";

export const INGEST_BODY_LIMIT_BYTES = 32 * 1024;
export const RATE_LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

export interface ServeTelemetryOptions {
  /** host:port; port 0 picks a free port. Default 127.0.0.1:8787. */
  bind?: string;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
  log: Pick<typeof defaultLog, "info" | "warn" | "debug" | "error">;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Override for tests. */
  ratePerMinute?: number;
}

export interface TelemetryServer {
  url: string;
  close(): Promise<void>;
}

export function parseBind(bind: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(bind.trim());
  if (!m) throw new Error(`invalid bind ${JSON.stringify(bind)} (want host:port)`);
  const port = Number(m[3]);
  if (port > 65535) throw new Error(`invalid port in bind ${bind}`);
  return { host: (m[1] ?? m[2])!, port };
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]!, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fixed one-minute window per source_id, in memory. */
class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= WINDOW_MS) {
      if (this.windows.size > 10_000) this.sweep(t);
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }
  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= WINDOW_MS) this.windows.delete(k);
  }
}

export function createTelemetryApp(db: Db, opts: Omit<ServeTelemetryOptions, "bind">): Hono {
  const now = opts.now ?? Date.now;
  const limiter = new RateLimiter(opts.ratePerMinute ?? RATE_LIMIT_PER_MINUTE, now);
  const upsertSource = db.prepare(
    "INSERT INTO telemetry_sources (source_id, first_seen_at) VALUES (?, ?) ON CONFLICT(source_id) DO NOTHING",
  );
  const insertCall = db.prepare(
    `INSERT INTO telemetry_calls (source_id, received_at, client_ts, resource_hash, seller_domain, network, outcome,
       flags_json, amount_atomic, latency_ms, wallet, client_version, raw_json)
     VALUES (@source_id, @received_at, @client_ts, @resource_hash, @seller_domain, @network, @outcome,
       @flags_json, @amount_atomic, @latency_ms, @wallet, @client_version, @raw_json)`,
  );
  const store = db.transaction((r: IngestRecord, receivedAt: number) => {
    upsertSource.run(r.source_id, receivedAt);
    return insertCall.run({
      source_id: r.source_id,
      received_at: receivedAt,
      client_ts: r.ts,
      resource_hash: r.resource_hash,
      seller_domain: r.seller_domain,
      network: r.network ?? null,
      outcome: r.outcome,
      flags_json: JSON.stringify(r.flags),
      amount_atomic: r.amount_atomic ?? null,
      latency_ms: r.latency_ms,
      wallet: r.wallet ?? null,
      client_version: r.client_version,
      raw_json: JSON.stringify(r),
    }).lastInsertRowid;
  });

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.post(
    "/v1/calls",
    async (c, next) => {
      if (opts.token && !tokenOk(c.req.header("authorization"), opts.token)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    },
    bodyLimit({
      maxSize: INGEST_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "payload_too_large", limit_bytes: INGEST_BODY_LIMIT_BYTES }, 413),
    }),
    async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      const parsed = TelemetryRecordSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        opts.log.debug("telemetry: rejected record", { issues });
        return c.json({ error: "invalid_record", issues }, 400);
      }
      const r = parsed.data;
      if (!limiter.allow(r.source_id)) {
        return c.json({ error: "rate_limited", limit_per_minute: opts.ratePerMinute ?? RATE_LIMIT_PER_MINUTE }, 429);
      }
      try {
        const id = store(r, now());
        return c.json({ ok: true, id: Number(id) }, 201);
      } catch (e) {
        opts.log.error("telemetry: insert failed", { error: e instanceof Error ? e.message : String(e) });
        return c.json({ error: "internal" }, 500);
      }
    },
  );
  return app;
}

export async function serveTelemetry(db: Db, opts: ServeTelemetryOptions): Promise<TelemetryServer> {
  const { host, port } = parseBind(opts.bind ?? "127.0.0.1:8787");
  const app = createTelemetryApp(db, opts);
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
    s.once("error", reject);
  });
  const actual = (server.address() as AddressInfo).port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = `http://${urlHost}:${actual}`;
  opts.log.info(`telemetry ingest listening on ${url} (POST /v1/calls)${opts.token ? " [token required]" : ""}`);
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
