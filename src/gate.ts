import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface GateMarker { commit: string; dirty: boolean; passedAt: number; node?: string }

/** Why a live mainnet run is refused by the integration-suite gate, or null if it may proceed. */
export function gateReason(marker: GateMarker | undefined, headCommit: string, treeDirty: boolean, now = Date.now()): string | null {
  if (!marker) return "no passing integration suite recorded; run `pnpm gate`";
  if (marker.commit !== headCommit) return `integration suite passed on ${marker.commit.slice(0, 10)} but HEAD is ${headCommit.slice(0, 10)}; run \`pnpm gate\``;
  if (marker.dirty || treeDirty) return "working tree was or is dirty; commit, then run `pnpm gate`";
  if (now - marker.passedAt > GATE_MAX_AGE_MS) return "integration suite pass is older than 24 h; run `pnpm gate`";
  return null;
}

export function readGate(root = process.cwd()): { marker: GateMarker | undefined; head: string; dirty: boolean } {
  const p = resolve(root, "data", ".gate.json");
  const marker = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as GateMarker) : undefined;
  const head = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim().length > 0;
  return { marker, head, dirty };
}

export function assertGate(root = process.cwd()): void {
  const { marker, head, dirty } = readGate(root);
  const reason = gateReason(marker, head, dirty);
  if (reason) throw new Error(`refusing live mainnet run: ${reason}`);
}
