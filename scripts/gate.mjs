// Runs the full test suite (unit + anvil integration) and writes data/.gate.json recording the git commit it ran on and
// the tests' outcome: {commit, dirty, ranAt, node, tests: {status, passed, failed, files}}. `buy run --live` and
// `stress ... --live` on mainnet refuse unless that marker matches the current HEAD, the tree is clean and it is less
// than 24 h old (src/gate.ts). Since 2026-11-03 the tests are advisory: a failing test no longer stops a scheduled buy
// (five slots were lost to flaky or environment-dependent tests); the outcome is recorded on the run's row and posted
// to the admin dashboard instead. The money limits are the runtime caps in src/buy/guard.ts, checked before every signature.
// Exit status: 0 whenever the tests ran on a clean tree, whatever they found (the outcome is printed and in the marker);
// 1 for a dirty tree (the marker is still written, with dirty: true, and refuses); 2 when it could not get as far as the tests.
import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const MARKER = "data/.gate.json";
export const REPORT = "data/.gate-report.json";
const MAX_FILES = 10;

/** The tests block from vitest's JSON report (null or unreadable: status error, counts unknown). */
export function testsFromReport(report, vitestStatus, root = process.cwd()) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults))
    return { status: "error", passed: null, failed: null, files: [] };
  const passed = Number.isInteger(report.numPassedTests) ? report.numPassedTests : null;
  const failed = Number.isInteger(report.numFailedTests) ? report.numFailedTests : null;
  // A file can fail with no failing test in it (an import or a hook threw), so files come from each file's own status.
  const files = report.testResults
    .filter((f) => f && f.status === "failed" && typeof f.name === "string")
    .map((f) => relative(root, f.name) || f.name)
    .sort()
    .slice(0, MAX_FILES)
    .map((f) => f.slice(0, 200));
  const ok = vitestStatus === 0 && report.success !== false && (failed ?? 0) === 0 && files.length === 0;
  return { status: ok ? "passed" : "failed", passed, failed, files };
}

function main() {
  // A marker from an earlier run must not stand in for this one: if this run stops before the tests, there is none.
  rmSync(MARKER, { force: true });
  rmSync(REPORT, { force: true });
  let commit, dirty;
  try {
    commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
  } catch (e) {
    console.error(`gate: could not read the git state (${e.message}); no marker written`);
    process.exit(2);
  }
  mkdirSync("data", { recursive: true });
  const ranAt = Date.now();
  const r = spawnSync("pnpm", ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${REPORT}`], { stdio: "inherit" });
  let report = null;
  try {
    if (existsSync(REPORT)) report = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch {
    report = null;
  }
  const tests = testsFromReport(report, r.status, process.cwd());
  const marker = { commit, dirty, ranAt, node: process.version, tests };
  writeFileSync(MARKER, JSON.stringify(marker, null, 2));
  const counts = tests.passed === null ? "counts unknown" : `${tests.failed} failed, ${tests.passed} passed`;
  const where = `${commit.slice(0, 10)}${dirty ? " (dirty tree)" : ""}`;
  if (tests.status === "passed") console.log(`gate: tests passed on ${where} (${counts}); marker written to ${MARKER}`);
  else console.error(`gate: tests ${tests.status.toUpperCase()} on ${where} (${counts}${tests.files.length ? `: ${tests.files.join(" ")}` : ""}); marker written to ${MARKER} (tests are advisory; the run records this outcome)`);
  if (dirty) {
    console.error("gate: working tree is dirty; the marker refuses a live run until you commit and run `pnpm gate` again");
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) main();
