import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/index.js";
import { computeReport } from "./compute.js";
import { QUERY_NAMES } from "./queries.js";
import { SECTION_HEADERS, bigintReplacer, rateCi, renderMarkdown, writeReport } from "./render.js";
import { NOW, seedDb } from "./test-helpers.js";

const data = computeReport(seedDb(), { network: MAINNET, now: NOW, dustFloorAtomic: 100n });

describe("renderMarkdown", () => {
  const md = renderMarkdown(data);

  it("contains every section header in order", () => {
    let at = -1;
    for (const h of Object.values(SECTION_HEADERS)) {
      const idx = md.indexOf(h);
      expect(idx, h).toBeGreaterThan(at);
      at = idx;
    }
  });

  it("formats rates, dollars and the separate lines", () => {
    expect(rateCi({ rate: 0.123, lo: 0.081, hi: 0.18 })).toBe("12.3% [8.1%, 18.0%]");
    expect(md).toContain(rateCi(data.headline.count));
    expect(md).toContain("0.822000 USDC");
    expect(md).toContain("0.900000 USDC"); // unpaid overcharge exposure
    expect(md).toContain("Flagged for human review");
    expect(md).toContain("delivery is invisible on-chain; these are floors");
    expect(md).toContain("big.example");
    expect(md).not.toMatch(/\| almost\.example \|/);
  });

  it("has the reproducibility and how-to-reproduce blocks", () => {
    expect(md).toContain("cfg-abc123");
    expect(md).toContain("0.915000 USDC (915000 atomic)");
    expect(md).toContain(`pnpm cli report --network ${MAINNET}`);
    expect(md).toContain("src/report/queries.ts");
    for (const name of new Set(Object.values(data.queries_used).flat())) expect(md).toContain(name);
  });
});

describe("writeReport", () => {
  it("writes both files and the JSON parses back", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-report-"));
    const { mdPath, jsonPath } = writeReport(data, dir);
    expect(mdPath).toBe(join(dir, "2026-10-23.md"));
    expect(jsonPath).toBe(join(dir, "2026-10-23.json"));
    expect(existsSync(mdPath)).toBe(true);
    const back = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(back).toEqual(JSON.parse(JSON.stringify(data)));
    expect(back.headline.dollar.total_atomic).toBe("822000");
    for (const name of back.reproducibility.query_names) expect(QUERY_NAMES).toContain(name);
  });
  it("rejects a malformed date and serialises bigint", () => {
    expect(() => writeReport(data, "/nonexistent", "23-10-2026")).toThrow();
    expect(JSON.stringify({ a: 5n }, bigintReplacer)).toBe('{"a":"5"}');
  });
});
