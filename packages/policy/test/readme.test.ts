import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createFetchWithPayment } from "./readme-snippet.js";
import { AVOID_HOST, OK_HOST, freshState, mockFetch, throwawaySigner } from "./mock.js";

const here = (p: string) => new URL(p, import.meta.url);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the README snippet", () => {
  it("is exactly the code in test/readme-snippet.ts", () => {
    const readme = readFileSync(here("../README.md"), "utf8");
    const snippet = readFileSync(here("./readme-snippet.ts"), "utf8");
    const region = snippet.split("// README-START\n")[1]!.split("// README-END")[0]!;
    const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const shown = blocks.find((b) => b.includes("// the one added line"));
    expect(shown).toBeDefined();
    expect(shown).toBe(region);
  });

  it("runs: refuses the avoid seller with nothing signed, pays the ok seller once and reports it", async () => {
    const st = freshState();
    globalThis.fetch = mockFetch(st);
    const signer = throwawaySigner();
    const fetchWithPayment = createFetchWithPayment(signer);
    // The snippet does not wait for the set; the resource check still refuses an avoid seller on the first call.
    await expect(fetchWithPayment(`https://${AVOID_HOST}/v1/thing`)).rejects.toThrow(/rated avoid|filtered out by policies/);
    expect(st.signatures).toEqual([]);
    const res = await fetchWithPayment(`https://${OK_HOST}/v1/data`);
    expect(res.status).toBe(200);
    expect(st.signatures).toHaveLength(1);
    expect(st.signatures[0]).toMatchObject({ payer: signer.address.toLowerCase(), valid: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(st.telemetryPosts).toHaveLength(1);
    expect(st.telemetryPosts[0]!.body).toMatchObject({ outcome: "ok", client: "x402-policy/0.1.0", proof: { payer: signer.address.toLowerCase() } });
  });
});
