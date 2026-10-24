import type { Command } from "commander";
import { blockAtTimestamp, makeChainClient } from "../chain/client.js";
import { assignSellerVolumes, topPayTos } from "../chain/rank.js";
import { scanPayToVolume } from "../chain/volume.js";
import { atomicToUsd, loadEnv, loadFileConfigs, MAINNET, type Network } from "../config/index.js";
import { openDb, type Db } from "../db/index.js";
import { log } from "../log.js";

export interface ChainCtx { db: Db; network: Network; rpcUrl: string }

export function chainCtx(network: Network, dbPath: string): ChainCtx {
  const env = loadEnv();
  const rpcUrl = network === MAINNET ? env.BASE_LOGS_RPC_URL : env.BASE_SEPOLIA_RPC_URL;
  return { db: openDb(dbPath), network, rpcUrl };
}

/** Distinct pay-to addresses for exact-scheme resources on the network (v1 "base" names included). */
export function payTosForNetwork(db: Db, network: Network, minBazaarCalls = 0): string[] {
  const legacy = network === MAINNET ? "base" : "base-sepolia";
  const rows = db
    .prepare(
      `SELECT LOWER(r.pay_to) p, COALESCE(SUM(r.bazaar_calls_30d),0) c
         FROM resources r JOIN sellers s ON s.id = r.seller_id
        WHERE r.pay_to IS NOT NULL AND r.scheme = 'exact' AND (r.network = ? OR r.network = ?) AND s.excluded = 0
        GROUP BY LOWER(r.pay_to) HAVING c >= ? ORDER BY c DESC`,
    )
    .all(network, legacy, minBazaarCalls) as { p: string }[];
  return rows.map((r) => r.p);
}

export async function scanVolume(ctx: ChainCtx, o: { days: number; maxPayTos?: number; minBazaarCalls?: number; runId?: number }) {
  const client = makeChainClient({ rpcUrl: ctx.rpcUrl, network: ctx.network });
  const toBlock = await client.getBlockNumber();
  const toTs = Number((await client.getBlock({ blockNumber: toBlock })).timestamp);
  const fromTs = toTs - o.days * 86_400;
  const fromBlock = await blockAtTimestamp(client, fromTs);
  let payTos = payTosForNetwork(ctx.db, ctx.network, o.minBazaarCalls ?? 0);
  if (o.maxPayTos) payTos = payTos.slice(0, o.maxPayTos);
  log.info(`chain scan-volume: ${payTos.length} pay-tos, blocks ${fromBlock}..${toBlock} (${o.days} days), rpc ${ctx.rpcUrl}`);
  const stats = await scanPayToVolume(ctx.db, {
    client,
    network: ctx.network,
    payTos,
    fromBlock,
    toBlock,
    log,
    onProgress: (p) => log.info(`  progress`, p),
  });
  const ranked = assignSellerVolumes(ctx.db, { network: ctx.network, fromBlock, toBlock });
  const setMeta = ctx.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  setMeta.run(`volume_window_${ctx.network}`, JSON.stringify({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), fromTs, toTs, days: o.days, computedAt: Date.now(), payTos: payTos.length }));
  log.info(`chain scan-volume done`, { ...stats, sellersRanked: ranked.sellersRanked });
  return { stats, ranked, fromBlock, toBlock, payTos: payTos.length };
}

export function renderTopPayTos(ctx: ChainCtx, n: number): string {
  const rows = topPayTos(ctx.db, { network: ctx.network, n });
  const lines = [`| # | pay-to | 30d USDC | transfers | unique payers | dust | sellers |`, `|---|---|---|---|---|---|---|`];
  rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.payTo} | $${atomicToUsd(r.sumAtomic)} | ${r.transferCount} | ${r.uniquePayers} | ${r.dustCount} | ${r.sellerDomains.join(", ")} |`));
  return lines.join("\n");
}

export function registerChain(program: Command, globals: (cmd: Command) => { network: Network; db: string }) {
  const chain = program.command("chain").description("passive on-chain measurement (free; never moves money)");
  chain
    .command("scan-volume")
    .description("scan USDC transfers to every known pay-to over N days and rank sellers by volume")
    .option("--days <n>", "window in days", (v) => parseInt(v, 10), 30)
    .option("--max-paytos <n>", "limit to the first N pay-tos by bazaar calls", (v) => parseInt(v, 10))
    .option("--min-bazaar-calls <n>", "skip pay-tos whose resources have fewer bazaar 30d calls", (v) => parseInt(v, 10), 0)
    .action(async function (this: Command, o: { days: number; maxPaytos?: number; minBazaarCalls: number }) {
      const g = globals(this);
      const ctx = chainCtx(g.network, g.db);
      loadFileConfigs();
      const r = await scanVolume(ctx, { days: o.days, ...(o.maxPaytos ? { maxPayTos: o.maxPaytos } : {}), minBazaarCalls: o.minBazaarCalls });
      console.log(JSON.stringify({ ...r.stats, sellersRanked: r.ranked.sellersRanked, fromBlock: r.fromBlock.toString(), toBlock: r.toBlock.toString(), payTos: r.payTos }));
    });
  chain
    .command("top")
    .description("print the top N pay-to addresses by scanned volume")
    .option("--n <n>", "how many", (v) => parseInt(v, 10), 60)
    .action(function (this: Command, o: { n: number }) {
      const g = globals(this);
      console.log(renderTopPayTos(chainCtx(g.network, g.db), o.n));
    });
  return chain;
}
