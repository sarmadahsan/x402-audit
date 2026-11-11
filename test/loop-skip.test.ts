/**
 * scripts/loop.sh, the scheduled buy's gates: when one fails the slot must still leave a `buy skipped` row, a health post
 * and an export (2026-10-30 00:00 UTC: `pnpm gate` failed, the slot passed with one log line, and the export kept showing
 * the 18:04 run). Since 2026-11-03 failing tests are advisory: `pnpm gate` still runs before every buy and its marker's
 * outcome goes to `buy run --gate-file`, but only a gate that could not reach the tests (or found a dirty tree) skips.
 * The script is sourced with LOOP_SOURCE_ONLY=1; `pnpm` and the CLI are stand-ins on PATH that record
 * what they were called with; the working tree is a clean throwaway git repository.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function scheduledBuy(o: { gateExit: number; pool?: string; gateOutput?: string; dirty?: boolean; halt?: boolean; tests?: "passed" | "failed" | "none" }) {
  const dir = mkdtempSync(join(tmpdir(), "loop-skip-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  mkdirSync(bin); mkdirSync(work);
  // Stand-ins. `pnpm gate` writes the marker as the case says (default: the tests ran and passed; "none": it stopped
  // before the tests) and exits as the case says; the CLI records its arguments and answers `buy balances` with a pool.
  if (o.gateOutput !== undefined) writeFileSync(join(dir, "gate-output"), o.gateOutput);
  const tests = o.tests ?? (o.gateExit === 0 ? "passed" : "none");
  if (tests !== "none") {
    const marker = { commit: "c".repeat(40), dirty: false, ranAt: 1, node: "v22", tests: tests === "passed" ? { status: "passed", passed: 389, failed: 0, files: [] } : { status: "failed", passed: 388, failed: 1, files: ["src/cli/skipped.test.ts"] } };
    writeFileSync(join(dir, "marker.json"), JSON.stringify(marker));
  }
  const writeMarker = tests === "none" ? "" : `mkdir -p data; cp "${dir}/marker.json" data/.gate.json; `;
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash\necho "pnpm $*" >> "${dir}/calls.log"\n[ "$1" = gate ] && { ${writeMarker}[ -f "${dir}/gate-output" ] && cat "${dir}/gate-output"; exit ${o.gateExit}; }\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, "fake-cli.sh"), `#!/usr/bin/env bash\necho "cli $*" >> "${dir}/calls.log"\ncase " $* " in *" buy balances "*) echo '{"wallets":[{"label":"a","usdc":"${o.pool ?? "10.000000"}"}]}' ;; esac\nexit 0\n`, { mode: 0o755 });
  const git = (...a: string[]) => { const r = spawnSync("git", a, { cwd: work, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }); if (r.status !== 0) throw new Error(r.stderr); };
  git("init", "-q"); writeFileSync(join(work, "f"), "x\n"); git("add", "f"); git("commit", "-q", "-m", "clean");
  if (o.dirty) { writeFileSync(join(work, "f"), "changed\n"); writeFileSync(join(work, "g"), "new\n"); }
  if (o.halt) writeFileSync(join(work, "halt-buy"), "");
  const script = `
    LOOP_SOURCE_ONLY=1 . "${REPO}/scripts/loop.sh" || exit 9
    export PATH="${bin}:$PATH"   # the script puts the system directories first; the stand-ins must win
    cd "${work}" || exit 9
    STATE="${dir}/state"; LOG="${dir}/loop.log"; mkdir -p "$STATE"
    CLI=(bash "${bin}/fake-cli.sh")
    LOOP_PUBLISH=0
    scheduled_buy 2026-10-30 00
  `;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, X402_AUDIT_LIVE: "1", LOOP_RUN_USD: "1.00", LOOP_DAILY_USD: "4.00" },
  });
  const calls = existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : [];
  const log = existsSync(join(dir, "loop.log")) ? readFileSync(join(dir, "loop.log"), "utf8") : "";
  return { r, calls, log };
}

function archiveRaw(env: Record<string, string>, marker = false) {
  const dir = mkdtempSync(join(tmpdir(), "loop-archive-"));
  dirs.push(dir);
  writeFileSync(join(dir, "cli.sh"), `#!/usr/bin/env bash\necho "cli $*" >> "${dir}/calls.log"\nexit \${CLI_EXIT:-0}\n`);
  const script = `
    LOOP_SOURCE_ONLY=1 . "${REPO}/scripts/loop.sh" || exit 9
    STATE="${dir}/state"; LOG="${dir}/loop.log"; mkdir -p "$STATE"
    ${marker ? `touch "$STATE/archive-2026-11-20"` : ""}
    CLI=(bash "${dir}/cli.sh")
    archive_raw 2026-11-20
  `;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, X402_AUDIT_LIVE: "1", LOOP_RUN_USD: "1.00", LOOP_DAILY_USD: "4.00", ...env } });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { r, calls: read("calls.log"), log: read("loop.log"), done: existsSync(join(dir, "state/archive-2026-11-20")) };
}

describe("loop.sh archive_raw", () => {
  it("does nothing unless PROBE_ARCHIVE_ENABLED=1", () => {
    const { r, calls } = archiveRaw({ BACKUP_BUCKET: "b" });
    expect(r.status, r.stderr).toBe(0);
    expect(calls).toBe("");
  });
  it("runs once a day against the backup bucket, and a failure leaves it to retry", () => {
    const ok = archiveRaw({ PROBE_ARCHIVE_ENABLED: "1", BACKUP_BUCKET: "b" });
    expect(ok.calls).toContain("cli probe archive-raw --apply --bucket b --keep-days 7 --max-days 3");
    expect(ok.done).toBe(true);
    expect(archiveRaw({ PROBE_ARCHIVE_ENABLED: "1", BACKUP_BUCKET: "b" }, true).calls).toBe("");
    const failed = archiveRaw({ PROBE_ARCHIVE_ENABLED: "1", BACKUP_BUCKET: "b", CLI_EXIT: "1" });
    expect(failed.r.status, failed.r.stderr).toBe(0);
    expect(failed.done).toBe(false);
    expect(failed.log).toContain("archive 2026-11-20: failed");
  });
});

describe("loop.sh scheduled buy gates", () => {
  it("a `pnpm gate` that could not reach the tests (no marker) records the skip as a buy run row, posts health and exports; nothing is bought", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 2 });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("scheduled buy 2026-10-30 00:00: skipped, pnpm gate failed");
    expect(log).toContain("scheduled buy 2026-10-30 00:00: done (skipped)");
    expect(calls).toContain("pnpm gate");
    expect(calls).toContain("cli buy skipped --slot 2026-10-30T00 --reason pnpm gate failed");
    expect(calls).toContain("cli health --trigger buy");
    expect(calls.some((c) => /^cli export --out /.test(c))).toBe(true);
    expect(calls.some((c) => /--live buy run/.test(c))).toBe(false);
    // The row is written before the health post and the export, so both see it.
    expect(calls.indexOf("cli buy skipped --slot 2026-10-30T00 --reason pnpm gate failed")).toBeLessThan(calls.indexOf("cli health --trigger buy"));
  });

  it("failing tests no longer skip: the buy goes ahead, the log names the failing tests, and `buy run` gets the marker to record", () => {
    // The shape of the server's output on 2026-10-30 06:28 and 2026-10-31 06:35 UTC, colours included.
    const esc = "\u001b";
    const out = [
      ` ${esc}[32m✓${esc}[39m src/buy/allocate.test.ts ${esc}[2m(${esc}[22m${esc}[2m9 tests${esc}[22m${esc}[2m)${esc}[22m 171ms`,
      ` ${esc}[31m❯${esc}[39m src/cli/skipped.test.ts (1 test | 1 failed) 90ms`,
      `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m src/cli/skipped.test.ts${esc}[2m > ${esc}[22mskipped scheduled run${esc}[2m > ${esc}[22mis one finished row with the reason`,
      `${esc}[31m${esc}[1mAssertionError${esc}[22m: expected 1793341685474 to be 1793341685473 // Object.is equality${esc}[39m`,
      ` Test Files  1 failed | 48 passed (49)`,
      `      Tests  1 failed | 388 passed (389)`,
      `gate: tests FAILED on cccccccccc (1 failed, 388 passed: src/cli/skipped.test.ts); marker written to data/.gate.json`,
      "",
    ].join("\n");
    const { r, calls, log } = scheduledBuy({ gateExit: 0, tests: "failed", gateOutput: out });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("scheduled buy 2026-10-30 00:00: tests failed, pnpm gate failed: 1 of 389 tests failed (src/cli/skipped.test.ts); tests are advisory, the buy goes ahead and records the outcome");
    expect(log).toContain("run: pnpm gate"); // the gate's output still reaches the loop log
    expect(log).toContain("gate: tests FAILED on cccccccccc");
    expect(calls.some((c) => /^cli --live buy run --seed \d{10} .*--allocation coverage --slot 2026-10-30T00 --gate-file data\/\.gate\.json$/.test(c))).toBe(true);
    expect(calls.some((c) => /buy skipped/.test(c))).toBe(false);
    expect(log).toContain("scheduled buy 2026-10-30 00:00: done");
    expect(log).not.toContain("done (skipped)");
  });

  it("a dirty tree found by `pnpm gate` itself still skips, and the skip row records the tests that ran", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 1, tests: "passed", gateOutput: "gate: working tree is dirty; the marker refuses a live run until you commit and run `pnpm gate` again\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("skipped, pnpm gate: working tree is dirty (the commit gate needs a clean, committed HEAD)");
    expect(calls).toContain("cli buy skipped --slot 2026-10-30T00 --reason pnpm gate: working tree is dirty (the commit gate needs a clean, committed HEAD) --gate-file data/.gate.json");
    expect(calls.some((c) => /--live buy run/.test(c))).toBe(false);
  });

  it("a halt-buy file still skips before the gate; nothing is bought and no gate outcome is recorded", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 0, halt: true });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("skipped, halt or halt-buy file present");
    expect(calls).toContain("cli buy skipped --slot 2026-10-30T00 --reason halt or halt-buy file present");
    expect(calls).not.toContain("pnpm gate");
    expect(calls.some((c) => /--live buy run/.test(c))).toBe(false);
  });

  it("a dirty working tree is a skip whose reason lists the dirty paths; nothing is bought and the gate does not run", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 0, dirty: true });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("skipped, working tree is dirty:  M f;?? g (the commit gate needs a clean, committed HEAD)");
    expect(calls.some((c) => /^cli buy skipped --slot 2026-10-30T00 --reason working tree is dirty:  M f;\?\? g/.test(c))).toBe(true);
    expect(calls).not.toContain("pnpm gate");
    expect(calls.some((c) => /--live buy run/.test(c))).toBe(false);
  });

  it("every path the loop writes is git-ignored, so no step (probe, buy, discover refresh, backup, gate marker, publish worktree, halt files) can dirty the tree for the commit gate", () => {
    const written = ["data/loop.log", "data/loop-state/last-buy-slot", "data/loop-state/gate.log", "data/loop-state/audit-2026-10-31.sqlite.gz", "data/loop-state/backup-2026-10-31", "data/.gate.json", "data/.gate-report.json", "data/audit.sqlite", "data/audit.sqlite-wal", "data/paidfor-data/summary.json", "public-data/summary.json", "halt", "halt-buy", "halt-probe", ".env"];
    const r = spawnSync("git", ["check-ignore", "--no-index", "-v", ...written], { cwd: REPO, encoding: "utf8" });
    const ignored = r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t").pop());
    expect(written.filter((p) => !ignored.includes(p)), "paths the loop writes that git would see as changes").toEqual([]);
  });

  it("a wallet pool below the run cap is a skip too, with the figures in the reason", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 0, pool: "0.500000" });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("skipped, wallet pool holds 0.500000 USDC, less than the run cap 1.00");
    // The tests ran before this skip, so the row records their outcome.
    expect(calls).toContain("cli buy skipped --slot 2026-10-30T00 --reason wallet pool holds 0.500000 USDC, less than the run cap 1.00 --gate-file data/.gate.json");
    expect(calls.some((c) => /--live buy run/.test(c))).toBe(false);
  });

  it("with every gate passing the run goes ahead and no skip row is written", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 0 });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("scheduled buy 2026-10-30 00:00: wallet pool 10.000000 USDC, seed");
    expect(calls.some((c) => /^cli --live buy run --seed \d{10} --no-persist-tiers --budget-usd 1\.00 --run-usd 1\.00 --per-call-usd 0\.10 --runs-per-day 4 --day-budget-usd 4\.00 --resume-since 2026-10-30T00:00:00Z .*--allocation coverage --slot 2026-10-30T00 --gate-file data\/\.gate\.json$/.test(c))).toBe(true);
    expect(log).not.toContain("tests are advisory"); // passing tests add no line
    expect(calls.some((c) => /buy skipped/.test(c))).toBe(false);
    expect(calls.some((c) => /^cli discover refresh$/.test(c))).toBe(true); // the 00:00 slot
    expect(log).toContain("scheduled buy 2026-10-30 00:00: done");
  });
});
