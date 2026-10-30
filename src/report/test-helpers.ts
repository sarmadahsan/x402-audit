/** Synthetic database for the report tests. Only used by *.test.ts. */
import { openDb, type Db } from "../db/index.js";
import { MAINNET } from "../config/index.js";

export const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
export const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
export const P1 = "0x00000000000000000000000000000000000000p1";
export const P2 = "0x00000000000000000000000000000000000000p2";

export interface SeedCall {
  source?: string;
  seller: number;
  outcome: string | null;
  paid?: 0 | 1;
  amount?: string | null;
  settlementCount?: number;
  header?: Record<string, unknown> | null;
  quote?: string;
  reference?: string;
  flags?: string[];
  intent?: string;
  error?: string;
  ts?: number;
}

export function seedDb(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO runs (id, subcommand, args_json, config_hash, network, dry_run, started_at, finished_at, status) VALUES (1, 'buy', '{}', 'cfg-abc123', ?, 0, ?, ?, 'ok')").run(MAINNET, T0, T0 + 86_400_000);
  db.prepare("INSERT INTO halts (run_id, ts, reason) VALUES (1, ?, 'cap_per_day')").run(T0 + 3_600_000);
  const seller = db.prepare("INSERT INTO sellers (id, domain, category, tier, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)");
  seller.run(1, "big.example", "data", "top", T0, T0);
  seller.run(2, "almost.example", "inference", "tail", T0, T0);
  seller.run(3, "misc.example", null, "tail", T0, T0);
  const res = db.prepare("INSERT INTO resources (id, seller_id, url, source, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'manual', '{}', ?, ?)");
  for (const id of [1, 2, 3]) res.run(id, id, `https://s${id}.example/r`, T0, T0);

  const ins = db.prepare(`INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, wallet, quote_amount_atomic, quote_network,
      reference_price_atomic, paid, amount_paid_atomic, request_json, settlement_header_json, settlement_count, outcome, flags_json, error)
    VALUES (@intent, 1, @source, @seller, @seller, @ts, @wallet, @quote, @network, @reference, @paid, @amount, '{}', @header, @sc, @outcome, @flags, @error)`);
  let i = 0;
  const add = (c: SeedCall, times = 1) => {
    for (let k = 0; k < times; k++) {
      i++;
      ins.run({
        intent: c.intent ?? `buy-${i}`,
        source: c.source ?? "buy",
        seller: c.seller,
        ts: c.ts ?? T0 + i * 60_000,
        wallet: `0xwallet${i % 3}`,
        quote: c.quote ?? "10000",
        network: MAINNET,
        reference: c.reference ?? "10000",
        paid: c.paid ?? 1,
        amount: c.amount === undefined ? "10000" : c.amount,
        header: c.header == null ? null : JSON.stringify(c.header),
        sc: c.settlementCount ?? 1,
        error: c.error ?? null,
        outcome: c.outcome,
        flags: JSON.stringify(c.flags ?? []),
      });
    }
  };

  // seller 1: exactly 30 denominator rows, 6 failures
  add({ seller: 1, outcome: "ok" }, 24);
  add({ seller: 1, outcome: "non_delivery" }, 3);
  add({ seller: 1, outcome: "duplicate", settlementCount: 2 });
  add({ seller: 1, outcome: "overcharge", quote: "105000", reference: "100000", amount: "105000" }); // ratio 1.05
  add({ seller: 1, outcome: "overcharge", quote: "150000", reference: "100000", amount: "150000" }); // ratio 1.5
  // seller 2: 29 denominator rows, 5 failures, 2 injection, 2 delivered without a visible settlement
  add({ seller: 2, outcome: "ok" }, 20);
  add({ seller: 2, outcome: "ok", settlementCount: 0, header: { amount: "7000", success: true } });
  add({ seller: 2, outcome: "ok", settlementCount: 0 });
  add({ seller: 2, outcome: "wrong_goods" }, 2);
  add({ seller: 2, outcome: "injection", flags: ["injection_hit"] }, 2);
  add({ seller: 2, outcome: "non_delivery" }, 3);
  // seller 3: one denominator row plus everything excluded
  add({ seller: 3, outcome: "non_delivery", flags: ["injection_hit", "resolved_late"] });
  add({ seller: 3, outcome: "our_error", paid: 0, amount: null, settlementCount: 0 }, 2);
  add({ seller: 3, outcome: "indeterminate", settlementCount: 0 }, 2);
  add({ seller: 3, outcome: "not_paid", paid: 0, amount: null, settlementCount: 0 }, 2);
  add({ seller: 3, outcome: "overcharge", paid: 0, amount: null, settlementCount: 0, quote: "900000", reference: "10000", flags: ["unpaid_overcharge"] });

  // stress_duplicate: d1 two settlements on the call row, d2 two settlements rows, d3 one
  add({ source: "stress_duplicate", seller: 1, outcome: "duplicate", intent: "d1", settlementCount: 2 });
  add({ source: "stress_duplicate", seller: 1, outcome: "ok", intent: "d2", settlementCount: 1 });
  add({ source: "stress_duplicate", seller: 1, outcome: "ok", intent: "d3", settlementCount: 1 });
  const st = db.prepare("INSERT INTO settlements (intent_id, tx_hash, log_index, from_addr, to_addr, value_atomic, source, found_at) VALUES (?, ?, 0, '0xw', ?, '10000', 'chain', ?)");
  st.run("d2", "0xd2a", P1, T0);
  st.run("d2", "0xd2b", P1, T0);
  // stress_timeout: t1 aborted, settled anyway, retried with a second settlement; t2 answered before the
  // abort (settled, but not "despite abort"); t3 aborted and nothing settled
  add({ source: "stress_timeout", seller: 2, outcome: "indeterminate", intent: "t1", settlementCount: 1, error: "aborted: paid request" });
  add({ source: "stress_timeout", seller: 2, outcome: "duplicate", intent: "t1", settlementCount: 2 });
  add({ source: "stress_timeout", seller: 2, outcome: "ok", intent: "t2", settlementCount: 1 });
  add({ source: "stress_timeout", seller: 2, outcome: "not_paid", intent: "t3", settlementCount: 0, paid: 0, amount: null, error: "aborted: paid request" });

  // chain transfers
  const ct = db.prepare("INSERT INTO chain_transfers (network, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic) VALUES (?, ?, 0, ?, ?, ?, ?, ?)");
  let tx = 0;
  const tr = (ts: number, from: string, to: string, value: string) => {
    tx++;
    ct.run(MAINNET, `0xtx${tx}`, tx, ts, from, to, value);
  };
  for (let k = 0; k < 10; k++) tr(T0 + k * 600_000, `0xpayer${k}`, P1, "10000");
  tr(T0 + 20 * 600_000, "0xspiker", P1, "50000"); // overcharge spike
  tr(T0 + 30 * 600_000, "0xdup", P1, "10000"); // duplicate run: 3 transfers within 120 s
  tr(T0 + 30 * 600_000 + 30_000, "0xdup", P1, "10000");
  tr(T0 + 30 * 600_000 + 60_000, "0xdup", P1, "10000");
  tr(T0 + 40 * 600_000, "0xrepeat", P1, "10000"); // same triple but 300 s apart: not a duplicate
  tr(T0 + 40 * 600_000 + 300_000, "0xrepeat", P1, "10000");
  tr(T0 + 50 * 600_000, "0xdust", P1, "1"); // dust, below the floor
  tr(T0 + 50 * 600_000 + 10_000, "0xdust", P1, "1");
  for (let k = 0; k < 5; k++) tr(T0 + k * 600_000, `0xbuyer${k}`, P2, "20000");

  // telemetry
  const ts = db.prepare("INSERT INTO telemetry_sources (source_id, label, first_seen_at) VALUES (?, ?, ?)");
  ts.run("op-a", "Operator A", T0);
  ts.run("op-b", "Operator B", T0);
  const tc = db.prepare("INSERT INTO telemetry_calls (source_id, received_at, resource_hash, seller_domain, network, outcome, amount_atomic, raw_json) VALUES (?, ?, 'h', 'x.example', ?, ?, '10000', '{}')");
  const tel = (src: string, outcome: string, times: number) => {
    for (let k = 0; k < times; k++) tc.run(src, T0 + k, MAINNET, outcome);
  };
  tel("op-a", "ok", 8);
  tel("op-a", "non_delivery", 2);
  tel("op-a", "our_error", 1);
  tel("op-b", "ok", 4);
  tel("op-b", "injection", 1);
  tel("op-b", "duplicate", 1);

  // probes
  const pr = db.prepare("INSERT INTO probes (resource_id, client_identity, round_id, ts, network, outcome) VALUES (1, ?, ?, ?, ?, ?)");
  pr.run("A", "r1", T0, MAINNET, "ok");
  pr.run("B", "r1", T0, MAINNET, "overcharge");
  pr.run("A", "r2", T0 + 3_600_000, MAINNET, "ok");
  db.prepare("INSERT INTO price_events (resource_id, ts, kind) VALUES (1, ?, 'payto_changed')").run(T0);
  db.prepare("INSERT INTO price_events (resource_id, ts, kind) VALUES (1, ?, 'price_discrimination')").run(T0);
  return db;
}
