import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { stressCalls } from "./index.js";

const H = (c: string) => "0x" + c.repeat(64);
const A = (c: string) => "0x" + c.repeat(40);
const EXPLORER = "https://basescan.org/tx/";

function seed() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 's.example', 0, 0)").run();
  db.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, pay_to, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (7, 1, 'https://s.example/paid', 'bazaar', 'eip155:8453', 'exact', ?, '1000', '{}', 0, 0)").run(A("a"));
  const call = db.prepare(
    "INSERT INTO calls (id, intent_id, source, resource_id, seller_id, ts, wallet, quote_pay_to, paid, amount_paid_atomic, request_json, nonce, outcome, error) VALUES (?,?,?,?,?,?,?,?,?,?,'{}',?,?,?)",
  );
  // Duplicate test: one intent, two calls, two signatures, two settlements.
  call.run(1, "dup-intent-0001", "stress_duplicate", 7, 1, 1_700_000_000_000, A("f"), A("a"), 1, "1000", H("1"), "duplicate", null);
  call.run(2, "dup-intent-0001", "stress_duplicate", 7, 1, 1_700_000_001_000, A("f"), A("a"), 1, "1000", H("2"), "duplicate", null);
  // Timeout test: call 1 aborted by us, settled anyway; the retry settled too.
  call.run(3, "to-intent-00002", "stress_timeout", 7, 1, 1_700_000_002_000, A("f"), A("a"), 1, "1000", H("3"), "duplicate", "aborted: after 2000ms");
  call.run(4, "to-intent-00002", "stress_timeout", 7, 1, 1_700_000_003_000, A("f"), A("a"), 1, "1000", H("4"), "duplicate", null);
  const st = db.prepare(
    "INSERT INTO settlements (call_id, intent_id, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, nonce, source, found_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)",
  );
  st.run(1, "dup-intent-0001", H("a"), 3, 100, 1_700_000_000, A("f"), A("a"), "1000", H("1"), "chain");
  st.run(2, "dup-intent-0001", H("b"), 0, 101, 1_700_000_001, A("f"), A("a"), "1000", H("2"), "chain");
  st.run(3, "to-intent-00002", H("c"), 1, 102, null, A("f"), A("a"), "1000", null, "facilitator_header");
  st.run(4, "to-intent-00002", H("d"), 2, 103, 1_700_000_003, A("f"), A("a"), "1000", H("4"), "chain");
  // A settlement the lookup matched to the intent but to no call.
  st.run(null, "to-intent-00002", H("e"), 0, 104, 1_700_000_004, A("f"), A("a"), "1000", null, "x402scan");
  // A buy call with a settlement: never part of the stress records.
  call.run(5, "buy-intent-00003", "buy", 7, 1, 1_700_000_005_000, A("f"), A("a"), 1, "1000", H("5"), "delivered", null);
  st.run(5, "buy-intent-00003", H("9"), 0, 105, 1_700_000_005, A("f"), A("a"), "1000", H("5"), "chain");
  return db;
}

describe("stressCalls", () => {
  it("lists every stress call with its signed nonce and its settlements, in call order within the intent", () => {
    const { calls } = stressCalls(seed(), EXPLORER);
    expect(calls.map((c) => [c.test, c.intent_short, c.call])).toEqual([
      ["duplicate", "dup-inte", 1],
      ["duplicate", "dup-inte", 2],
      ["timeout", "to-inten", 1],
      ["timeout", "to-inten", 2],
    ]);
    expect(calls[0]).toEqual({
      test: "duplicate",
      intent: "dup-intent-0001",
      intent_short: "dup-inte",
      call: 1,
      resource: "https://s.example/paid",
      called_at: "2023-11-14T22:13:20.000Z",
      aborted_by_us: false,
      paid: true,
      amount_usdc: "0.001000",
      pay_to: A("a"),
      signed_nonce: H("1"),
      outcome: "duplicate",
      settlements: [
        {
          tx_hash: H("a"),
          log_index: 3,
          block_number: 100,
          block_at: "2023-11-14T22:13:20.000Z",
          to: A("a"),
          value_usdc: "0.001000",
          nonce: H("1"),
          source: "chain",
          explorer_url: EXPLORER + H("a"),
        },
      ],
    });
    expect(calls[2]).toMatchObject({ aborted_by_us: true, signed_nonce: H("3"), settlements: [{ tx_hash: H("c"), block_at: null, nonce: null, source: "facilitator_header" }] });
    expect(calls[3]).toMatchObject({ aborted_by_us: false, settlements: [{ tx_hash: H("d") }] });
  });

  it("gives each intent its distinct settlement count, the double-settled flag and any settlement no call owns", () => {
    const { intents } = stressCalls(seed(), EXPLORER);
    expect(intents).toHaveLength(2);
    expect(intents[0]).toMatchObject({ test: "duplicate", intent: "dup-intent-0001", calls: 2, settlements: 2, double_settled: true, unattributed_settlements: [] });
    expect(intents[1]).toMatchObject({ test: "timeout", intent: "to-intent-00002", calls: 2, settlements: 3, double_settled: true });
    expect(intents[1]!.unattributed_settlements.map((s) => s.tx_hash)).toEqual([H("e")]);
  });

  it("never writes our wallet address", () => {
    const out = JSON.stringify(stressCalls(seed(), EXPLORER));
    expect(out).not.toContain(A("f"));
    expect(out).not.toMatch(/from_addr|"from"|wallet/);
  });

  it("is empty when no stress call exists", () => {
    const db = openDb(":memory:");
    expect(stressCalls(db, EXPLORER)).toEqual({ intents: [], calls: [] });
  });
});
