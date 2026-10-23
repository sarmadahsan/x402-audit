import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_FLAGS, ALL_OUTCOMES, ALL_VALIDATORS, OUTCOME_PRECEDENCE, VALIDATOR_FAILS_INTO } from "./taxonomy.js";

const doc = readFileSync(new URL("../docs/taxonomy.md", import.meta.url), "utf8");

function tableConstants(section: string, next: string): string[] {
  const start = doc.indexOf(section);
  const end = doc.indexOf(next, start + 1);
  const body = doc.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/^\|\s*(?:\d+\s*\|\s*)?`([a-z_]+)`\s*\|/gm)].map((m) => m[1]!);
}

describe("taxonomy constants mirror docs/taxonomy.md", () => {
  it("primary outcomes", () => {
    expect(tableConstants("## Primary outcomes", "### Precedence").sort()).toEqual([...ALL_OUTCOMES].sort());
  });
  it("precedence order", () => {
    const start = doc.indexOf("### Precedence");
    const end = doc.indexOf("### Reference price");
    const order = [...doc.slice(start, end).matchAll(/^\d+\. `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(order).toEqual(OUTCOME_PRECEDENCE);
  });
  it("secondary flags", () => {
    expect(tableConstants("## Secondary flags", "## Validators").sort()).toEqual([...ALL_FLAGS].sort());
  });
  it("validators and their failure outcomes", () => {
    const start = doc.indexOf("## Validators");
    const rows = [...doc.slice(start).matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*`([a-z_]+)`/gm)];
    const fromDoc = Object.fromEntries(rows.map((m) => [m[1], m[2]]));
    expect(Object.keys(fromDoc).sort()).toEqual([...ALL_VALIDATORS].sort());
    expect(fromDoc).toEqual(VALIDATOR_FAILS_INTO);
  });
});
