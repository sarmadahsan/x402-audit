import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const GATE_TEST_STATUSES = ["passed", "failed", "error"] as const;
export type GateTestStatus = (typeof GATE_TEST_STATUSES)[number];

export interface GateTests { status: GateTestStatus; passed: number | null; failed: number | null; files: string[] }

/** data/.gate.json as `pnpm gate` writes it. `passedAt` is the shape before 2026-11-03 (written only on a pass), still
 * accepted for one deploy so a marker written by the old gate does not refuse the first run after the fast-forward. */
export interface GateMarker { commit: string; dirty: boolean; ranAt?: number; passedAt?: number; node?: string; tests?: GateTests }

/** When the marker's tests ran: `ranAt`, else the old shape's `passedAt`. */
export const gateRanAt = (m: GateMarker): number | undefined => (typeof m.ranAt === "number" ? m.ranAt : typeof m.passedAt === "number" ? m.passedAt : undefined);

/** The marker's test outcome; the old shape was written only on a pass. */
export function gateTests(m: GateMarker | undefined): GateTests | null {
  if (!m) return null;
  if (m.tests && (GATE_TEST_STATUSES as readonly string[]).includes(m.tests.status)) return m.tests;
  if (m.tests === undefined && typeof m.passedAt === "number") return { status: "passed", passed: null, failed: null, files: [] };
  return { status: "error", passed: null, failed: null, files: [] };
}

/** Why a live mainnet run is refused by the gate, or null if it may proceed. The tests are advisory since 2026-11-03:
 * the gate still needs `pnpm gate` to have run on this exact, clean commit within 24 h, whatever the tests found; their
 * outcome is recorded on the run's row (`buy run --gate-file`). The money limit is the caps in src/buy/guard.ts. */
export function gateReason(marker: GateMarker | undefined, headCommit: string, treeDirty: boolean, now = Date.now()): string | null {
  if (!marker) return "no gate run recorded; run `pnpm gate`";
  if (marker.commit !== headCommit) return `gate ran on ${String(marker.commit).slice(0, 10)} but HEAD is ${headCommit.slice(0, 10)}; run \`pnpm gate\``;
  if (marker.dirty || treeDirty) return "working tree was or is dirty; commit, then run `pnpm gate`";
  const at = gateRanAt(marker);
  if (at === undefined) return "gate marker has no run time; run `pnpm gate`";
  if (now - at > GATE_MAX_AGE_MS) return "gate run is older than 24 h; run `pnpm gate`";
  return null;
}

export function readGateMarker(path: string): GateMarker | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as GateMarker) : undefined;
}

export function readGate(root = process.cwd()): { marker: GateMarker | undefined; head: string; dirty: boolean } {
  const marker = readGateMarker(resolve(root, "data", ".gate.json"));
  const head = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim().length > 0;
  return { marker, head, dirty };
}

export function assertGate(root = process.cwd()): void {
  const { marker, head, dirty } = readGate(root);
  const reason = gateReason(marker, head, dirty);
  if (reason) throw new Error(`refusing live mainnet run: ${reason}`);
}

/** What a run's notes record of the gate (`buy run --gate-file`, `buy skipped --gate-file`): the tests' outcome and the
 * commit they ran on. An unreadable file is status error with nothing known. */
export function gateNote(path: string): GateTests & { commit: string | null } {
  try {
    const m = readGateMarker(path);
    const t = gateTests(m);
    if (m && t) return { ...t, commit: typeof m.commit === "string" ? m.commit : null };
  } catch {
    // unreadable marker: below
  }
  return { status: "error", passed: null, failed: null, files: [], commit: null };
}
