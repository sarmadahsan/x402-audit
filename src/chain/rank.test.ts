import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { assignSellerVolumes, topPayTos } from "./rank.js";

const NET = "eip155:8453";
const A = "0x7284D41b5b852F2bd4c99bDf95043D84452d299C";
const B = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const C = "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const D = "0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";

describe("assignSellerVolumes / topPayTos", () => {
  it("joins checksummed resource pay-tos to lowercase volumes and ranks with bigint sums", () => {
    const db = openDb(":memory:");
    const seller = db.prepare("INSERT INTO sellers (domain, first_seen_at, last_seen_at) VALUES (?, 0, 0)");
    const res = db.prepare("INSERT INTO resources (seller_id, url, source, pay_to, network, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, 'bazaar', ?, ?, '{}', 0, 0)");
    const big = seller.run("big.example").lastInsertRowid;
    const tieMore = seller.run("b-tie.example").lastInsertRowid;
    const tieLess = seller.run("a-tie.example").lastInsertRowid;
    const none = seller.run("none.example").lastInsertRowid;
    const none2 = seller.run("aaa-none.example").lastInsertRowid;
    res.run(big, "https://big.example/1", A, NET); // checksummed
    res.run(big, "https://big.example/2", A.toLowerCase(), NET); // same pay-to again: counted once
    res.run(big, "https://big.example/3", B, "base"); // v1 network name still joins
    res.run(tieMore, "https://b-tie.example/1", C, NET);
    res.run(tieLess, "https://a-tie.example/1", D, NET);
    res.run(none, "https://none.example/1", "0x9999999999999999999999999999999999999999", NET);

    const pv = db.prepare(
      "INSERT INTO payto_volume (network, pay_to, from_block, to_block, from_ts, to_ts, transfer_count, sum_atomic, dust_count, dust_floor_atomic, unique_payers, computed_at) VALUES (?, ?, 100, 200, 0, 0, ?, ?, 0, '100', 1, 0)",
    );
    // Beyond 2^53 so float summation would be wrong.
    pv.run(NET, A.toLowerCase(), 10, "9007199254740993");
    pv.run(NET, B.toLowerCase(), 5, "9007199254740993");
    pv.run(NET, C, 7, "5000");
    pv.run(NET, D, 3, "5000");
    // A different window must be ignored.
    db.prepare(
      "INSERT INTO payto_volume (network, pay_to, from_block, to_block, from_ts, to_ts, transfer_count, sum_atomic, dust_count, dust_floor_atomic, unique_payers, computed_at) VALUES (?, ?, 0, 50, 0, 0, 99, '99999999999999999999', 0, '100', 1, 0)",
    ).run(NET, D);

    expect(assignSellerVolumes(db, { network: NET, fromBlock: 100n, toBlock: 200n })).toEqual({ sellersRanked: 5, shadows: 0 });
    const rows = db.prepare("SELECT domain, volume_30d_atomic AS v, volume_30d_calls AS c, volume_30d_source AS src, rank_30d AS r, volume_30d_computed_at AS at FROM sellers ORDER BY rank_30d").all() as any[];
    expect(rows.map((r) => [r.domain, r.v, r.c, r.r])).toEqual([
      ["big.example", "18014398509481986", 15, 1],
      ["b-tie.example", "5000", 7, 2],
      ["a-tie.example", "5000", 3, 3],
      ["aaa-none.example", "0", 0, 4],
      ["none.example", "0", 0, 5],
    ]);
    expect(rows.every((r) => r.src === "chain" && r.at > 0)).toBe(true);

    const top = topPayTos(db, { network: NET, n: 3 });
    expect(top.map((t) => [t.payTo, t.sumAtomic, t.sellerDomains])).toEqual([
      [A.toLowerCase(), "9007199254740993", ["big.example"]],
      [B.toLowerCase(), "9007199254740993", ["big.example"]],
      [C, "5000", ["b-tie.example"]],
    ]);
  });
});

describe("shared pay-to canonicalisation", () => {
  it("gives rank only to the canonical seller of a shared pay-to", async () => {
    const { openDb } = await import("../db/index.js");
    const db = openDb(":memory:");
    db.exec(`INSERT INTO sellers (id, domain, calls_30d_bazaar, first_seen_at, last_seen_at) VALUES (1,'main.example',1000,0,0),(2,'staging.example',3,0,0),(3,'other.example',50,0,0);
             INSERT INTO resources (seller_id, url, source, pay_to, raw_json, first_seen_at, last_seen_at) VALUES
               (1,'https://main.example/a','bazaar','0xAAAA','{}',0,0),(2,'https://staging.example/a','bazaar','0xaaaa','{}',0,0),(3,'https://other.example/a','bazaar','0xbbbb','{}',0,0);
             INSERT INTO payto_volume (network, pay_to, from_block, to_block, from_ts, to_ts, transfer_count, sum_atomic, dust_count, dust_floor_atomic, unique_payers, computed_at) VALUES
               ('eip155:8453','0xaaaa',1,2,0,0,10,'500000',0,'100',5,0),('eip155:8453','0xbbbb',1,2,0,0,3,'100000',0,'100',2,0);`);
    const r = assignSellerVolumes(db, { network: "eip155:8453", fromBlock: 1n, toBlock: 2n });
    expect(r).toEqual({ sellersRanked: 2, shadows: 1 });
    const rows = db.prepare("SELECT domain, rank_30d, volume_30d_source, volume_30d_atomic FROM sellers ORDER BY id").all();
    expect(rows).toEqual([
      { domain: "main.example", rank_30d: 1, volume_30d_source: "chain", volume_30d_atomic: "500000" },
      { domain: "staging.example", rank_30d: null, volume_30d_source: "chain:shadow_of:main.example", volume_30d_atomic: "500000" },
      { domain: "other.example", rank_30d: 2, volume_30d_source: "chain", volume_30d_atomic: "100000" },
    ]);
  });
});
