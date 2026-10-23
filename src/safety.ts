import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MAINNET, type Network } from "./config/index.js";

export interface LiveGateInput {
  liveFlag: boolean;
  envLive: string;
  network: Network;
  dryRun: boolean;
}

/**
 * Real money moves only when ALL of: --live, X402_AUDIT_LIVE=1, --network eip155:8453, and not --dry-run.
 * Returns null when live mainnet spending is allowed, otherwise the reason it is not.
 */
export function liveGateReason(i: LiveGateInput): string | null {
  if (i.dryRun) return "dry-run (default); pass --live to spend";
  if (!i.liveFlag) return "--live not given";
  if (i.envLive !== "1") return "X402_AUDIT_LIVE is not 1";
  if (i.network !== MAINNET) return `network is ${i.network}, mainnet requires --network ${MAINNET}`;
  return null;
}

/** True when a file named `halt` exists in the repo root. Checked once per loop iteration by every job. */
export function haltRequested(root = process.cwd()): boolean {
  return existsSync(resolve(root, "halt"));
}

export class HaltError extends Error {
  constructor(public readonly reason: string, public readonly details?: unknown) {
    super(`halt: ${reason}`);
  }
}
