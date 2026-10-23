import { describe, expect, it } from "vitest";
import { nonEmpty } from "./non_empty.js";
import { makeCtx } from "./test-helpers.js";

describe("non_empty", () => {
  it("passes on a non-empty body", async () => {
    expect(await nonEmpty.run(makeCtx({ response: { body: "{}" } }))).toEqual({ status: "pass", evidence: { bytes: 2 } });
  });
  it("fails on zero bytes", async () => {
    const r = await nonEmpty.run(makeCtx({ response: { body: "" } }));
    expect(r).toMatchObject({ status: "fail", reason: "empty_body", evidence: { bytes: 0 } });
  });
  it("fails on whitespace only", async () => {
    const r = await nonEmpty.run(makeCtx({ response: { body: " \n\t\r " } }));
    expect(r).toMatchObject({ status: "fail", reason: "whitespace_only", evidence: { bytes: 5 } });
  });
});
