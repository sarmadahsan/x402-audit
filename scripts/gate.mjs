// Runs the full test suite (unit + anvil integration) and, only if it passes, writes data/.gate.json
// recording the git commit it passed on. `buy run --live` and `stress ... --live` on mainnet refuse
// unless that marker matches the current HEAD and is less than 24 h old (src/gate.ts).
import { spawnSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
const r = spawnSync("pnpm", ["vitest", "run"], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("gate: tests failed; no marker written");
  process.exit(r.status ?? 1);
}
mkdirSync("data", { recursive: true });
const marker = { commit, dirty, passedAt: Date.now(), node: process.version };
writeFileSync("data/.gate.json", JSON.stringify(marker, null, 2));
console.log(`gate: passed on ${commit.slice(0, 10)}${dirty ? " (dirty tree)" : ""}; marker written to data/.gate.json`);
