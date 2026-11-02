/**
 * The in-memory set the policy filters against: pay-to address -> seller verdict.
 *
 * Verdicts come from the index (`GET {indexUrl}/sellers`, one row per rated seller with `verdict`). Pay-to
 * addresses come from the same rows when they carry `pay_to_addresses`; until the index adds that field,
 * from the public data repo's sellers.json, joined on `domain`.
 */
import { ADDRESS_RE, CLIENT_HEADER, CLIENT_ID, errMsg, trimSlash, type FetchLike, type Verdict } from "./constants.js";

export interface AvoidEntry {
  /** Lowercase 0x address the seller asks to be paid at. */
  payTo: string;
  domain: string;
  verdict: Verdict;
  evidenceUrl: string | null;
  sellerUrl: string | null;
}

export interface AvoidSnapshot {
  byPayTo: ReadonlyMap<string, AvoidEntry>;
  /** Client clock, ms since epoch, when the set was loaded. */
  fetchedAt: number;
  /** Rated sellers in the index answer. */
  sellers: number;
  /** Sellers with a refused verdict whose pay-to addresses were found. */
  matched: number;
  /** Sellers with a refused verdict and no known pay-to address (cannot be filtered by this policy). */
  unmatched: string[];
  /** True when sellers.json had to be read because /v1/sellers rows carry no pay_to_addresses. */
  joinedFromData: boolean;
  generatedAt: string | null;
}

export interface LoadOptions {
  indexUrl: string;
  /** false: never read sellers.json; rows without pay_to_addresses are then left unmatched. */
  sellersDataUrl: string | false;
  fetch: FetchLike;
  timeoutMs: number;
  verdicts: ReadonlySet<Verdict>;
}

interface SellerRow {
  domain?: unknown;
  verdict?: unknown;
  pay_to_addresses?: unknown;
  evidence_url?: unknown;
  url?: unknown;
}

const VERDICTS: ReadonlySet<string> = new Set<Verdict>(["avoid", "caution", "ok", "unknown"]);

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json", [CLIENT_HEADER]: CLIENT_ID },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    throw new Error(`${url} answered ${res.status}`);
  }
  return res.json();
}

function addresses(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const a of v) {
    if (typeof a !== "string") continue;
    const l = a.toLowerCase();
    if (ADDRESS_RE.test(l)) out.push(l);
  }
  return out;
}

/** domain -> pay-to addresses from sellers.json (`sellers` and `low_sample` rows alike). */
export function payToByDomain(data: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const d = data as { sellers?: unknown; low_sample?: unknown } | null;
  for (const list of [d?.sellers, d?.low_sample]) {
    if (!Array.isArray(list)) continue;
    for (const row of list as SellerRow[]) {
      if (typeof row?.domain !== "string") continue;
      const addrs = addresses(row.pay_to_addresses);
      if (addrs.length) out.set(row.domain.toLowerCase(), addrs);
    }
  }
  return out;
}

/** Build the snapshot from the two documents. Exported for tests; `loadAvoidSet` fetches them. */
export function buildSnapshot(sellersAnswer: unknown, data: unknown | undefined, verdicts: ReadonlySet<Verdict>, now = Date.now()): AvoidSnapshot {
  const a = sellersAnswer as { sellers?: unknown; generated_at?: unknown } | null;
  const rows = Array.isArray(a?.sellers) ? (a!.sellers as SellerRow[]) : [];
  const fromData = data === undefined ? null : payToByDomain(data);
  const byPayTo = new Map<string, AvoidEntry>();
  const unmatched: string[] = [];
  let matched = 0;
  for (const row of rows) {
    if (typeof row?.domain !== "string" || typeof row.verdict !== "string" || !VERDICTS.has(row.verdict)) continue;
    const verdict = row.verdict as Verdict;
    if (!verdicts.has(verdict)) continue;
    const domain = row.domain.toLowerCase();
    let addrs = addresses(row.pay_to_addresses);
    if (!addrs.length && fromData) addrs = fromData.get(domain) ?? [];
    if (!addrs.length) {
      unmatched.push(domain);
      continue;
    }
    matched++;
    for (const payTo of addrs) {
      byPayTo.set(payTo, {
        payTo,
        domain,
        verdict,
        evidenceUrl: typeof row.evidence_url === "string" ? row.evidence_url : null,
        sellerUrl: typeof row.url === "string" ? row.url : null,
      });
    }
  }
  return {
    byPayTo,
    fetchedAt: now,
    sellers: rows.length,
    matched,
    unmatched,
    joinedFromData: fromData !== null,
    generatedAt: typeof a?.generated_at === "string" ? a.generated_at : null,
  };
}

/** True when at least one row with a refused verdict has no pay_to_addresses of its own. */
export function needsDataJoin(sellersAnswer: unknown, verdicts: ReadonlySet<Verdict>): boolean {
  const a = sellersAnswer as { sellers?: unknown } | null;
  if (!Array.isArray(a?.sellers)) return false;
  return (a!.sellers as SellerRow[]).some((r) => typeof r?.verdict === "string" && verdicts.has(r.verdict as Verdict) && addresses(r.pay_to_addresses).length === 0);
}

/** Fetch the index answer (and sellers.json only when needed) and build the snapshot. Throws on any failure. */
export async function loadAvoidSet(o: LoadOptions): Promise<AvoidSnapshot> {
  const sellers = await getJson(o.fetch, `${trimSlash(o.indexUrl)}/sellers`, o.timeoutMs);
  let data: unknown | undefined;
  if (o.sellersDataUrl !== false && needsDataJoin(sellers, o.verdicts)) {
    try {
      data = await getJson(o.fetch, o.sellersDataUrl, o.timeoutMs);
    } catch (e) {
      throw new Error(`pay-to addresses unavailable: ${errMsg(e)}`);
    }
  }
  return buildSnapshot(sellers, data, o.verdicts);
}
