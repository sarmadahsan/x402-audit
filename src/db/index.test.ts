import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";

describe("db", () => {
  it("creates the schema and enforces append-only attempts", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    for (const t of ["sellers", "resources", "probes", "attempts", "calls", "validator_results", "settlements", "halts", "chain_transfers", "telemetry_calls", "runs"]) {
      expect(tables).toContain(t);
    }
    db.prepare("INSERT INTO sellers (domain, first_seen_at, last_seen_at) VALUES ('s', 0, 0)").run();
    db.prepare("INSERT INTO resources (seller_id, url, source, raw_json, first_seen_at, last_seen_at) VALUES (1, 'http://s/x', 'manual', '{}', 0, 0)").run();
    db.prepare("INSERT INTO attempts (intent_id, source, ts, resource_id, wallet, pay_to, network, asset, amount_atomic, phase) VALUES ('i', 'buy', 0, 1, '0xa', '0xb', 'eip155:84532', '0xc', '1000', 'planned')").run();
    expect(() => db.prepare("UPDATE attempts SET phase = 'sent'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM attempts").run()).toThrow(/append-only/);
  });
});
