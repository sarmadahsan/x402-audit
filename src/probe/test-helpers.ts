/** Shared fixtures for probe tests. */
import type { Db } from "../db/index.js";
import type { Logger } from "./run.js";

export const silentLog: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

export function insertSeller(db: Db, domain: string, extra: { rank?: number | null; calls?: number | null; excluded?: boolean } = {}): number {
  const now = Date.now();
  return Number(
    db
      .prepare(
        `INSERT INTO sellers (domain, rank_30d, calls_30d_bazaar, excluded, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(domain, extra.rank ?? null, extra.calls ?? null, extra.excluded ? 1 : 0, now, now).lastInsertRowid,
  );
}

export interface ResourceFixture {
  sellerId: number;
  url: string;
  network: string;
  method?: string;
  source?: string;
  scheme?: string;
  declaredPriceAtomic?: string | null;
  payTo?: string | null;
  transferMethod?: string | null;
  bazaarCalls?: number | null;
  asset?: string | null;
  inputJson?: string | null;
}

export function insertResource(db: Db, r: ResourceFixture): number {
  const now = Date.now();
  return Number(
    db
      .prepare(
        `INSERT INTO resources (seller_id, url, method, source, x402_version, scheme, network, asset, declared_price_atomic,
           pay_to, transfer_method, bazaar_calls_30d, input_json, raw_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        r.sellerId,
        r.url,
        r.method ?? "GET",
        r.source ?? "bazaar",
        r.scheme ?? "exact",
        r.network,
        r.asset ?? null,
        r.declaredPriceAtomic === undefined ? "10000" : r.declaredPriceAtomic,
        r.payTo === undefined ? "0x000000000000000000000000000000000000A402" : r.payTo,
        r.transferMethod ?? null,
        r.bazaarCalls ?? null,
        r.inputJson ?? null,
        now,
        now,
      ).lastInsertRowid,
  );
}
