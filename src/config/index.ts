import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const MAINNET = "eip155:8453";
export const SEPOLIA = "eip155:84532";
export const NETWORKS = [MAINNET, SEPOLIA] as const;
export type Network = (typeof NETWORKS)[number];

/** Load .env from the repo root into process.env without overriding existing values. Never logs values. */
export function loadDotenv(root = process.cwd()): void {
  const p = resolve(root, ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const usd = z.coerce.number().nonnegative();
const EnvSchema = z.object({
  X402_AUDIT_DB: z.string().default("data/audit.sqlite"),
  X402_AUDIT_NETWORK: z.enum(NETWORKS).default(SEPOLIA),
  X402_AUDIT_LIVE: z.string().default("0"),
  BASE_RPC_URL: z.string().url().default("https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  X402_AUDIT_WALLET_KEYS: z.string().default(""),
  MAX_PER_CALL_USD: usd.default(0.5),
  MAX_PER_SELLER_PER_DAY_USD: usd.default(20),
  MAX_PER_DAY_USD: usd.default(100),
  MAX_TOTAL_USD: usd.default(300),
  STRESS_MAX_TOTAL_USD: usd.default(30),
  CDP_API_KEY_ID: z.string().default(""),
  CDP_API_KEY_SECRET: z.string().default(""),
  X402SCAN_API_KEY: z.string().default(""),
  TELEMETRY_BIND: z.string().default("127.0.0.1:8787"),
  TELEMETRY_INGEST_TOKEN: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  loadDotenv();
  return EnvSchema.parse(process.env);
}

/** Caps in USDC atomic units (6 dp), as bigint, so cap arithmetic is exact. */
export interface Caps {
  perCallAtomic: bigint;
  perSellerPerDayAtomic: bigint;
  perDayAtomic: bigint;
  totalAtomic: bigint;
  stressTotalAtomic: bigint;
}
export const USDC_DECIMALS = 6;
export function usdToAtomic(usd: number): bigint {
  // Avoid float drift: work in micro-dollars via string math.
  const [whole = "0", frac = ""] = usd.toFixed(USDC_DECIMALS).split(".");
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}
export function atomicToUsd(atomic: bigint | string): string {
  const a = BigInt(atomic);
  const whole = a / 10n ** BigInt(USDC_DECIMALS);
  const frac = (a % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}
export function capsFromEnv(env: Env): Caps {
  return {
    perCallAtomic: usdToAtomic(env.MAX_PER_CALL_USD),
    perSellerPerDayAtomic: usdToAtomic(env.MAX_PER_SELLER_PER_DAY_USD),
    perDayAtomic: usdToAtomic(env.MAX_PER_DAY_USD),
    totalAtomic: usdToAtomic(env.MAX_TOTAL_USD),
    stressTotalAtomic: usdToAtomic(env.STRESS_MAX_TOTAL_USD),
  };
}

const ExcludeSchema = z.object({
  sellers: z.array(z.object({ domain: z.string(), reason: z.string().default("") })).default([]),
  resource_prefixes: z.array(z.string()).default([]),
});
export type ExcludeConfig = z.infer<typeof ExcludeSchema>;

const SampleSchema = z.object({
  target_calls: z.number().int().positive(),
  max_total_usd: z.number().positive(),
  tiers: z.object({
    top: z.object({ size: z.number().int().positive(), share: z.number().min(0).max(1) }),
    tail: z.object({ size: z.number().int().positive(), share: z.number().min(0).max(1) }),
  }),
  categories: z.array(z.string()).min(1),
  price_floor_usd: z.number().positive(),
  max_share_per_resource: z.number().min(0).max(1),
  seed: z.number().int(),
  min_seconds_between_calls_per_resource: z.number().int().positive().default(60),
});
export type SampleConfig = z.infer<typeof SampleSchema>;

const ManualResource = z.object({
  url: z.string().url(),
  method: z.string().default("GET"),
  seller_domain: z.string(),
  category: z.string().default("other"),
  declared_price_atomic: z.string().regex(/^\d+$/).optional(),
  asset: z.string().optional(),
  network: z.string().optional(),
  pay_to: z.string().optional(),
  description: z.string().default(""),
});
const ManualSchema = z.object({ resources: z.array(ManualResource).default([]) });
export type ManualResourceConfig = z.infer<typeof ManualResource>;

export interface FileConfigs {
  root: string;
  exclude: ExcludeConfig;
  sample: SampleConfig;
  manual: z.infer<typeof ManualSchema>;
  /** SHA-256 over the raw bytes of every config file and config/schemas/*, sorted by path. */
  configHash: string;
}

function readYaml<T>(path: string, schema: z.ZodType<T>): { value: T; raw: string } {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const parsed = raw.trim() ? parseYaml(raw) : {};
  return { value: schema.parse(parsed), raw };
}

export function loadFileConfigs(root = process.cwd()): FileConfigs {
  const cfg = resolve(root, "config");
  const exclude = readYaml(resolve(cfg, "exclude.yaml"), ExcludeSchema);
  const sample = readYaml(resolve(cfg, "sample.yaml"), SampleSchema);
  const manual = readYaml(resolve(cfg, "manual-sellers.yaml"), ManualSchema);
  const h = createHash("sha256");
  const parts: [string, string][] = [
    ["config/exclude.yaml", exclude.raw],
    ["config/sample.yaml", sample.raw],
    ["config/manual-sellers.yaml", manual.raw],
  ];
  const schemasDir = resolve(cfg, "schemas");
  if (existsSync(schemasDir)) {
    for (const f of readdirSync(schemasDir).filter((f) => f.endsWith(".json")).sort()) {
      parts.push([`config/schemas/${f}`, readFileSync(resolve(schemasDir, f), "utf8")]);
    }
  }
  for (const [p, raw] of parts.sort((a, b) => a[0].localeCompare(b[0]))) h.update(p).update("\0").update(raw).update("\0");
  return { root, exclude: exclude.value, sample: sample.value, manual: manual.value, configHash: h.digest("hex") };
}

export function isExcluded(exclude: ExcludeConfig, sellerDomain: string, resourceUrl?: string): string | null {
  const s = exclude.sellers.find((e) => e.domain.toLowerCase() === sellerDomain.toLowerCase());
  if (s) return s.reason || "excluded";
  if (resourceUrl) {
    const p = exclude.resource_prefixes.find((pre) => resourceUrl.startsWith(pre));
    if (p) return `prefix:${p}`;
  }
  return null;
}
