/**
 * scripts/loop.sh, the scheduled buy's gates: when one fails the slot must still leave a `buy skipped` row, a health post
 * and an export (2026-10-30 00:00 UTC: `pnpm gate` failed, the slot passed with one log line, and the export kept showing
 * the 18:04 run). The script is sourced with LOOP_SOURCE_ONLY=1; `pnpm` and the CLI are stand-ins on PATH that record
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

function scheduledBuy(o: { gateExit: number; pool?: string; gateOutput?: string; dirty?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "loop-skip-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  mkdirSync(bin); mkdirSync(work);
  // Stand-ins. `pnpm gate` exits as the case says; the CLI records its arguments and answers `buy balances` with a pool.
  if (o.gateOutput !== undefined) writeFileSync(join(dir, "gate-output"), o.gateOutput);
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash\necho "pnpm $*" >> "${dir}/calls.log"\n[ "$1" = gate ] && { [ -f "${dir}/gate-output" ] && cat "${dir}/gate-output"; exit ${o.gateExit}; }\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, "fake-cli.sh"), `#!/usr/bin/env bash\necho "cli $*" >> "${dir}/calls.log"\ncase " $* " in *" buy balances "*) echo '{"wallets":[{"label":"a","usdc":"${o.pool ?? "10.000000"}"}]}' ;; esac\nexit 0\n`, { mode: 0o755 });
  const git = (...a: string[]) => { const r = spawnSync("git", a, { cwd: work, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }); if (r.status !== 0) throw new Error(r.stderr); };
  git("init", "-q"); writeFileSync(join(work, "f"), "x\n"); git("add", "f"); git("commit", "-q", "-m", "clean");
  if (o.dirty) { writeFileSync(join(work, "f"), "changed\n"); writeFileSync(join(work, "g"), "new\n"); }
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

describe("loop.sh scheduled buy gates", () => {
  it("a failed `pnpm gate` records the skip as a buy run row, posts health and exports; nothing is bought", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 1 });
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

  it("a failed gate's reason names the failing test files and the counts, read from vitest's output", () => {
    // The shape of the server's output on 2026-10-30 06:28 and 2026-10-31 06:35 UTC, colours included.
    const esc = "\u001b";
    const out = [
      ` ${esc}[32m✓${esc}[39m src/buy/allocate.test.ts ${esc}[2m(${esc}[22m${esc}[2m9 tests${esc}[22m${esc}[2m)${esc}[22m 171ms`,
      ` ${esc}[31m❯${esc}[39m src/cli/skipped.test.ts (1 test | 1 failed) 90ms`,
      `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m src/cli/skipped.test.ts${esc}[2m > ${esc}[22mskipped scheduled run${esc}[2m > ${esc}[22mis one finished row with the reason`,
      `${esc}[31m${esc}[1mAssertionError${esc}[22m: expected 1793341685474 to be 1793341685473 // Object.is equality${esc}[39m`,
      ` Test Files  1 failed | 48 passed (49)`,
      `      Tests  1 failed | 388 passed (389)`,
      `gate: tests failed; no marker written`,
      "",
    ].join("\n");
    const { r, calls, log } = scheduledBuy({ gateExit: 1, gateOutput: out });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("skipped, pnpm gate failed: 1 of 389 tests failed (src/cli/skipped.test.ts)");
    expect(calls).toContain("cli buy skipped --slot 2026-10-30T00 --reason pnpm gate failed: 1 of 389 tests failed (src/cli/skipped.test.ts)");
    expect(log).toContain("run: pnpm gate"); // the gate's output still reaches the loop log, after the marker line
    expect(log).toContain("gate: tests failed; no marker written");
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
    const written = ["data/loop.log", "data/loop-state/last-buy-slot", "data/loop-state/gate.log", "data/loop-state/audit-2026-10-31.sqlite.gz", "data/loop-state/backup-2026-10-31", "data/.gate.json", "data/audit.sqlite", "data/audit.sqlite-wal", "data/paidfor-data/summary.json", "public-data/summary.json", "halt", "halt-buy", "halt-probe", ".env"];
    const r = spawnSync("git", ["check-ignore", "--no-index", "-v", ...written], { cwd: REPO, encoding: "utf8" });
    const ignored = r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t").pop());
    expect(written.filter((p) => !ignored.includes(p)), "paths the loop writes that git would see as changes").toEqual([]);
  });

  it("a wallet pool below the run cap is a skip too, with the figures in the reason", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 0, pool: "0.500000" });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("skipped, wallet pool holds 0.500000 USDC, less than the run cap 1.00");
    expect(calls).toContain("cli buy skipped --slot 2026-10-30T00 --reason wallet pool holds 0.500000 USDC, less than the run cap 1.00");
    expect(calls.some((c) => /--live buy run/.test(c))).toBe(false);
  });

  it("with every gate passing the run goes ahead and no skip row is written", () => {
    const { r, calls, log } = scheduledBuy({ gateExit: 0 });
    expect(r.status, r.stderr).toBe(0);
    expect(log).toContain("scheduled buy 2026-10-30 00:00: wallet pool 10.000000 USDC, seed");
    expect(calls.some((c) => /^cli --live buy run --seed \d{10} --no-persist-tiers --budget-usd 1\.00 --run-usd 1\.00 --per-call-usd 0\.10 --runs-per-day 4 --day-budget-usd 4\.00 --resume-since 2026-10-30T00:00:00Z .*--allocation coverage$/.test(c))).toBe(true);
    expect(calls.some((c) => /buy skipped/.test(c))).toBe(false);
    expect(calls.some((c) => /^cli discover refresh$/.test(c))).toBe(true); // the 00:00 slot
    expect(log).toContain("scheduled buy 2026-10-30 00:00: done");
  });
});
