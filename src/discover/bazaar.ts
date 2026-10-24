/**
 * CDP Bazaar discovery crawler. See docs/protocol-notes.md Part 2 §A.
 *
 * Endpoint: GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=&offset=
 * Public, keyless. Live quirks (2026-10-23): `limit` is clamped to [20, 1000]; an offset past the end
 * returns `items: []`; ordering is not stable, so we page to the end and de-duplicate on `resource`.
 * Rate limit is undocumented, so we throttle to ~1 req/s and retry 429/5xx/network errors.
 */
import { z } from "zod";

export const BAZAAR_RESOURCES_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

export interface DiscoverLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  debug?(msg: string, data?: unknown): void;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Optional field that never rejects the item: a malformed value becomes undefined. */
const opt = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);

const QualitySchema = z.looseObject({
  l30DaysTotalCalls: opt(z.number()),
  l30DaysUniquePayers: opt(z.number()),
  lastCalledAt: opt(z.string()),
});

/**
 * Tolerant item schema. Only `resource`, `type` and `x402Version` are required (as in the CDP OpenAPI);
 * any other field that is malformed is dropped rather than rejecting the item. `accepts` keeps only
 * object entries; per-entry validation happens later in selectAccept (index.ts).
 */
export const BazaarItemSchema = z.looseObject({
  resource: z.string().refine(isHttpUrl, { message: "resource must be an http(s) URL" }),
  type: z.string(),
  x402Version: z.number().int(),
  description: opt(z.string()),
  lastUpdated: opt(z.string()),
  mimeType: opt(z.string()),
  accepts: opt(
    z.array(z.unknown()).transform((arr) =>
      arr.filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null && !Array.isArray(a)),
    ),
  ),
  extensions: opt(z.record(z.string(), z.unknown())),
  quality: opt(QualitySchema),
  serviceName: opt(z.string()),
  tags: opt(z.array(z.string())),
  curated: opt(z.boolean()),
  iconUrl: opt(z.string()),
  bundleSlugs: opt(z.array(z.string())),
});

/** A parsed Bazaar item plus the item exactly as received (for resources.raw_json). */
export type BazaarItem = z.output<typeof BazaarItemSchema> & { raw: unknown };

const PageSchema = z.looseObject({
  items: z.array(z.unknown()),
  pagination: z
    .looseObject({ limit: z.number().optional(), offset: z.number().optional(), total: z.number().optional() })
    .optional(),
});

export interface FetchAllOptions {
  fetchImpl?: typeof fetch;
  pageSize?: number;
  throttleMs?: number;
  log: DiscoverLogger;
  onPage?: (info: { page: number; offset: number; received: number; accepted: number; total: number | undefined }) => void;
  /** Backoff schedule for retries (ms). Default [2000, 8000, 30000]. */
  retryDelaysMs?: number[];
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** Hard stop on pages, a guard against a server that never ends. Default 500. */
  maxPages?: number;
}

export interface FetchAllResult {
  items: BazaarItem[];
  pages: number;
  totalReported: number;
  fetchedAt: number;
  /** Raw items received (before de-duplication), items rejected by the schema, duplicates dropped. */
  received: number;
  rejected: number;
  duplicates: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function lastUpdatedMs(i: { lastUpdated?: string | undefined }): number {
  const t = i.lastUpdated ? Date.parse(i.lastUpdated) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

class RetryableError extends Error {}

/**
 * Page through the whole Bazaar index. Throws only if a page still fails after all retries
 * (a partial universe would silently bias every downstream number).
 */
export async function fetchAllBazaarResources(opts: FetchAllOptions): Promise<FetchAllResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? 1000;
  const throttleMs = opts.throttleMs ?? 1000;
  const delays = opts.retryDelaysMs ?? [2000, 8000, 30000];
  const sleep = opts.sleep ?? defaultSleep;
  const baseUrl = opts.baseUrl ?? BAZAAR_RESOURCES_URL;
  const maxPages = opts.maxPages ?? 500;
  const { log } = opts;

  const byResource = new Map<string, BazaarItem>();
  let offset = 0;
  let pages = 0;
  let totalReported = 0;
  let received = 0;
  let rejected = 0;
  let duplicates = 0;
  let lastRequestAt = -Infinity;

  const getPage = async (url: string): Promise<z.output<typeof PageSchema>> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + throttleMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      try {
        let res: Response;
        try {
          res = await fetchImpl(url, { headers: { accept: "application/json" } });
        } catch (e) {
          throw new RetryableError(`network error: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        let body: unknown;
        try {
          body = await res.json();
        } catch (e) {
          throw new RetryableError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
        const parsed = PageSchema.safeParse(body);
        if (!parsed.success) throw new RetryableError(`unexpected page shape: ${parsed.error.issues[0]?.message ?? "?"}`);
        return parsed.data;
      } catch (e) {
        if (!(e instanceof RetryableError) || attempt >= delays.length) throw e;
        const d = delays[attempt]!;
        log.warn(`bazaar page failed (${e.message}); retry ${attempt + 1}/${delays.length} in ${d} ms`, { url });
        await sleep(d);
      }
    }
  };

  for (;;) {
    if (pages >= maxPages) {
      log.warn(`bazaar: stopping at maxPages=${maxPages}`);
      break;
    }
    const url = `${baseUrl}?limit=${pageSize}&offset=${offset}`;
    const page = await getPage(url);
    pages++;
    const total = page.pagination?.total;
    if (typeof total === "number") totalReported = total;
    let accepted = 0;
    for (const raw of page.items) {
      received++;
      const r = BazaarItemSchema.safeParse(raw);
      if (!r.success) {
        rejected++;
        const res = (raw as { resource?: unknown } | null)?.resource;
        log.warn("bazaar: rejected item", { resource: typeof res === "string" ? res : null, issue: r.error.issues[0]?.message });
        continue;
      }
      accepted++;
      const item: BazaarItem = { ...r.data, raw };
      const prev = byResource.get(item.resource);
      if (prev) {
        duplicates++;
        if (lastUpdatedMs(item) > lastUpdatedMs(prev)) byResource.set(item.resource, item);
      } else byResource.set(item.resource, item);
    }
    opts.onPage?.({ page: pages, offset, received: page.items.length, accepted, total });
    log.debug?.(`bazaar page ${pages} offset=${offset} items=${page.items.length} total=${total ?? "?"}`);
    if (page.items.length === 0) break;
    offset += page.items.length;
    if (typeof total === "number" && offset >= total) break;
  }

  if (rejected > 0) log.warn(`bazaar: ${rejected} of ${received} items rejected by schema`);
  log.info(`bazaar: ${byResource.size} unique resources from ${pages} pages (reported total ${totalReported}, ${duplicates} duplicates)`);
  return { items: [...byResource.values()], pages, totalReported, fetchedAt: Date.now(), received, rejected, duplicates };
}
