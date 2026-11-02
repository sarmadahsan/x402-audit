/**
 * paidforPolicy(): a synchronous `PaymentPolicy` for @x402/core's client. It removes every payment requirement
 * whose `payTo` belongs to a seller the paidfor index rates `avoid` (or any verdict in `refuseVerdicts`), so the
 * client finds no acceptable requirement and refuses before anything is signed.
 *
 * The hook is synchronous and receives only the payment requirements (no resource URL), so the policy keys on
 * pay-to addresses and keeps an in-memory set refreshed in the background. The resource-level check is done by
 * paidforExtension().
 */
import type { PaymentPolicy } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { loadAvoidSet, type AvoidEntry, type AvoidSnapshot } from "./avoid-set.js";
import { DEFAULT_INDEX_URL, DEFAULT_SELLERS_DATA_URL, errMsg, type FailMode, type FetchLike, type Verdict } from "./constants.js";

export const DEFAULT_REFRESH_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

export interface PaidforPolicyOptions {
  /** Default https://paidfor.dev/v1. */
  indexUrl?: string;
  /** Where pay-to addresses come from while /v1/sellers rows lack them. `false` disables the join. */
  sellersDataUrl?: string | false;
  /** fetch used for index requests. Default globalThis.fetch. */
  fetch?: FetchLike;
  /** How often the avoid set is reloaded. Default one hour. */
  refreshMs?: number;
  /** Timeout for one load of the set. Default 10 s. */
  timeoutMs?: number;
  /**
   * "open" (default): while the set has never loaded, or is older than maxStaleMs, every requirement passes; an
   * unreachable index never blocks a payment. "closed": in the same situations every requirement is removed, so no
   * payment goes out unchecked.
   */
  failMode?: FailMode;
  /** Age after which a loaded set no longer counts as current. Default 24 h. */
  maxStaleMs?: number;
  /** Verdicts whose sellers are refused. Default ["avoid"]. */
  refuseVerdicts?: Verdict[];
  /** Called when the policy removes requirements (or everything, in fail-closed mode). Errors are swallowed. */
  onRefuse?: (r: PaidforRefusal) => void;
  /** Called after each load attempt. Errors are swallowed. */
  onRefresh?: (s: PolicyStatus) => void;
  /** One line per refusal. Default console.warn; pass false for silence. */
  warn?: ((message: string) => void) | false;
  /** Start the background refresh on construction. Default true; pass false and call refresh()/ready() yourself. */
  autoStart?: boolean;
}

export type PaidforRefusal =
  | {
      kind: "avoid_pay_to";
      /** The requirements removed, with the seller each pay-to belongs to. */
      removed: Array<{ requirement: PaymentRequirements; seller: AvoidEntry }>;
      /** How many requirements were left for the client to choose from. 0 means the payment is refused. */
      remaining: number;
      at: number;
    }
  | {
      kind: "index_unavailable";
      /** Why nothing could be checked: never loaded, or the last load is older than maxStaleMs. */
      reason: "not_loaded" | "stale";
      removed: PaymentRequirements[];
      remaining: 0;
      at: number;
    };

export interface PolicyStatus {
  /** True when a set is loaded and younger than maxStaleMs. */
  current: boolean;
  loadedAt: number | null;
  /** Pay-to addresses in the set. */
  addresses: number;
  /** Sellers with a refused verdict matched to at least one address. */
  sellers: number;
  /** Sellers with a refused verdict the policy cannot filter because no pay-to address is known. */
  unmatched: string[];
  joinedFromData: boolean;
  lastError: string | null;
  lastAttemptAt: number | null;
  failMode: FailMode;
}

export interface PaidforPolicy extends PaymentPolicy {
  /** Resolves after the first load attempt (success or failure). Never rejects. */
  ready(): Promise<PolicyStatus>;
  /** Load the set now. Never rejects. */
  refresh(): Promise<PolicyStatus>;
  status(): PolicyStatus;
  /** Look a pay-to address up in the current set. */
  lookup(payTo: string): AvoidEntry | undefined;
  /** Stop the background refresh. The policy keeps filtering against the last set. */
  stop(): void;
  readonly lastRefusal: PaidforRefusal | null;
}

export function paidforPolicy(options: PaidforPolicyOptions = {}): PaidforPolicy {
  const indexUrl = options.indexUrl ?? DEFAULT_INDEX_URL;
  const sellersDataUrl = options.sellersDataUrl ?? DEFAULT_SELLERS_DATA_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const failMode: FailMode = options.failMode ?? "open";
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const verdicts: ReadonlySet<Verdict> = new Set(options.refuseVerdicts ?? ["avoid"]);
  const warn = options.warn === undefined ? (m: string) => console.warn(m) : options.warn;

  let snapshot: AvoidSnapshot | null = null;
  let lastError: string | null = null;
  let lastAttemptAt: number | null = null;
  let inFlight: Promise<PolicyStatus> | null = null;
  let first: Promise<PolicyStatus> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRefusal: PaidforRefusal | null = null;

  const isCurrent = (now: number): boolean => snapshot !== null && now - snapshot.fetchedAt <= maxStaleMs;

  const status = (): PolicyStatus => ({
    current: isCurrent(Date.now()),
    loadedAt: snapshot?.fetchedAt ?? null,
    addresses: snapshot?.byPayTo.size ?? 0,
    sellers: snapshot?.matched ?? 0,
    unmatched: snapshot?.unmatched ?? [],
    joinedFromData: snapshot?.joinedFromData ?? false,
    lastError,
    lastAttemptAt,
    failMode,
  });

  const safe = (fn: (() => void) | undefined): void => {
    try {
      fn?.();
    } catch {
      /* caller hooks never break the policy */
    }
  };

  const refresh = (): Promise<PolicyStatus> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      lastAttemptAt = Date.now();
      try {
        snapshot = await loadAvoidSet({ indexUrl, sellersDataUrl, fetch: fetchImpl, timeoutMs, verdicts });
        lastError = null;
      } catch (e) {
        lastError = errMsg(e);
      }
      const s = status();
      safe(() => options.onRefresh?.(s));
      return s;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const start = (): void => {
    if (timer || refreshMs <= 0) return;
    timer = setInterval(() => void refresh(), refreshMs);
    // A background refresh must never keep a short-lived process alive.
    (timer as { unref?: () => void }).unref?.();
  };

  const refuse = (r: PaidforRefusal): void => {
    lastRefusal = r;
    safe(() => options.onRefuse?.(r));
    if (warn) {
      const line =
        r.kind === "avoid_pay_to"
          ? `paidfor: refused ${r.removed.length} payment option(s) rated ${[...verdicts].join("/")}: ${r.removed
              .map(({ seller }) => `${seller.domain} (${seller.payTo})${seller.evidenceUrl ? ` evidence ${seller.evidenceUrl}` : ""}`)
              .join("; ")}${r.remaining ? `; ${r.remaining} other option(s) kept` : "; nothing signed"}`
          : `paidfor: refused ${r.removed.length} payment option(s): the index set is ${r.reason === "stale" ? "stale" : "not loaded"} and failMode is "closed"; nothing signed`;
      safe(() => warn(line));
    }
  };

  const fn = ((_x402Version: number, requirements: PaymentRequirements[]): PaymentRequirements[] => {
    const now = Date.now();
    if (!isCurrent(now)) {
      if (failMode === "closed" && requirements.length) {
        refuse({ kind: "index_unavailable", reason: snapshot ? "stale" : "not_loaded", removed: requirements, remaining: 0, at: now });
        return [];
      }
      return requirements;
    }
    const set = snapshot!.byPayTo;
    const removed: Array<{ requirement: PaymentRequirements; seller: AvoidEntry }> = [];
    const kept = requirements.filter((r) => {
      const payTo = typeof r.payTo === "string" ? r.payTo.toLowerCase() : "";
      const seller = set.get(payTo);
      if (!seller) return true;
      removed.push({ requirement: r, seller });
      return false;
    });
    if (removed.length) refuse({ kind: "avoid_pay_to", removed, remaining: kept.length, at: now });
    return kept;
  }) as PaidforPolicy;

  Object.defineProperties(fn, {
    ready: {
      value: () => {
        if (!first) first = snapshot ? Promise.resolve(status()) : refresh();
        return first;
      },
    },
    refresh: { value: refresh },
    status: { value: status },
    lookup: { value: (payTo: string) => snapshot?.byPayTo.get(payTo.toLowerCase()) },
    stop: {
      value: () => {
        if (timer) clearInterval(timer);
        timer = null;
      },
    },
    lastRefusal: { get: () => lastRefusal },
  });

  if (options.autoStart !== false) {
    first = refresh();
    start();
  }
  return fn;
}
