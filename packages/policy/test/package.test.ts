import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; dependencies?: unknown; peerDependencies: Record<string, string> };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("the package", () => {
  it("has one version", () => {
    expect(pkg.version).toBe(VERSION);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`x402-policy/${VERSION}`);
  });

  it("holds no key, reads no environment, signs nothing, and depends only on @x402/core", () => {
    const src = files(join(root, "src")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const forbidden of [/private[_ ]?key/i, /mnemonic/i, /seed ?phrase/i, /process\.env/, /signTypedData/, /signTransaction/, /sign\(/, /privateKeyToAccount/, /from "viem/]) {
      expect(src).not.toMatch(forbidden);
    }
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies)).toEqual(["@x402/core"]);
  });

  it("never uses the forbidden word", () => {
    const forbidden = new RegExp(["pro", "tect"].join(""), "i");
    const text = [join(root, "README.md"), join(root, "package.json"), ...files(join(root, "src")), ...files(join(root, "demo")), ...files(join(root, "test"))]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(text).not.toMatch(forbidden);
  });
});
