import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { AUTHORIZATION_USED_TOPIC0, TRANSFER_TOPIC0, USDC_BY_NETWORK } from "../chain/client.js";
import { addNewSellersToProbeSet, runRefresh, type RefreshChainClient } from "./refresh.js";

const NET = "eip155:8453";
const USDC = USDC_BY_NETWORK[NET];
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const FAC = "0x" + "f".repeat(40);
const PAYER = "0x" + "1".repeat(40);
const KNOWN = "0x" + "a".repeat(40);
const NEW = "0x" + "b".repeat(40);
const log = { info() {}, warn() {} };

function fakeChain(txs: Record<string, { from: string; to: string }>): RefreshChainClient {
  return {
    getBlockNumber: async () => 1000n,
    getBlock: async (a?: { blockNumber?: bigint }) => ({ number: a?.blockNumber ?? 1000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) - (1000n - (a?.blockNumber ?? 1000n)) * 2n }),
    getLogs: async () => [],
    request: async () => Object.keys(txs).map((h) => ({ transactionHash: h })),
    getTransaction: async () => ({ from: FAC }),
    getTransactionReceipt: async ({ hash }) => ({
      from: txs[hash]!.from,
      logs: [
        { address: USDC, topics: [AUTHORIZATION_USED_TOPIC0, pad(PAYER), "0x" + "0".repeat(64)], data: "0x" },
        { address: USDC, topics: [TRANSFER_TOPIC0, pad(PAYER), pad(txs[hash]!.to)], data: "0x" + (1000).toString(16).padStart(64, "0") },
      ],
    }),
  };
}

describe("discover refresh", () => {
  it("puts one resource per new seller into the probe set", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'n.example', 0, 0)").run();
    db.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, pay_to, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (5, 1, 'https://n.example/a', 'bazaar', ?, 'exact', ?, '1000', '{}', 0, 0), (6, 1, 'https://n.example/{id}', 'bazaar', ?, 'exact', ?, '10', '{}', 0, 0)").run(NET, KNOWN, NET, KNOWN);
    expect(addNewSellersToProbeSet(db, [1], { network: NET, now: 0, max: 10 })).toBe(1);
    expect(db.prepare("SELECT resource_id, stratum, active FROM probe_set").all()).toEqual([{ resource_id: 5, stratum: "discovery", active: 1 }]);
  });

  it("records payees of facilitator settlements that no seller claims, and maps them once a listing names them", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'k.example', 0, 0)").run();
    db.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, pay_to, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (1, 1, 'https://k.example/a', 'bazaar', ?, 'exact', ?, '1000', '{}', 0, 0)").run(NET, KNOWN);
    db.prepare("INSERT INTO settlements (tx_hash, from_addr, to_addr, value_atomic, source, found_at) VALUES (?, ?, ?, '1000', 'chain', 0)").run("0x" + "e".repeat(64), PAYER, KNOWN);
    const h = (c: string) => "0x" + c.repeat(64);
    const chain = fakeChain({ [h("1")]: { from: FAC, to: KNOWN }, [h("2")]: { from: FAC, to: NEW }, [h("3")]: { from: "0x" + "9".repeat(40), to: "0x" + "c".repeat(40) } });
    const st = await runRefresh(db, { network: NET, log, manual: [], exclude: { sellers: [], resource_prefixes: [] }, seeds: [], skipBazaar: true, chain, maxInflowScans: 0 });
    expect(st.errors).toEqual([]);
    expect(st.chain).toMatchObject({ facilitators: 1, authorizations: 3, sampled: 3, facilitatorSettlements: 2, payeesSeen: 2, newUnmapped: 1 });
    expect(db.prepare("SELECT pay_to, facilitator, sampled_settlements FROM unmapped_payees").all()).toEqual([{ pay_to: NEW, facilitator: FAC, sampled_settlements: 1 }]);
    db.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, pay_to, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (2, 1, 'https://k.example/b', 'bazaar', ?, 'exact', ?, '1000', '{}', 0, 0)").run(NET, NEW);
    const again = await runRefresh(db, { network: NET, log, manual: [], exclude: { sellers: [], resource_prefixes: [] }, seeds: [], skipBazaar: true, chain, maxInflowScans: 0 });
    expect(again.chain?.matchedNow).toBe(1);
    expect(db.prepare("SELECT matched_seller_id FROM unmapped_payees").get()).toEqual({ matched_seller_id: 1 });
  });
});
