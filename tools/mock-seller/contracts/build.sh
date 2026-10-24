#!/usr/bin/env bash
# Compiles TestUSDC.sol once into the committed artifact TestUSDC.json {abi, bytecode, compiler, sourceSha256}.
# Tests read the JSON and never need a compiler. Re-run only when TestUSDC.sol changes.
# Requires forge (Foundry). forge fetches solc 0.8.26 via svm on first use.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FORGE="${FORGE:-$(command -v forge || echo /opt/homebrew/bin/forge)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"
cp "$HERE/TestUSDC.sol" "$WORK/src/TestUSDC.sol"
cat > "$WORK/foundry.toml" <<TOML
[profile.default]
src = "src"
out = "out"
solc_version = "0.8.26"
optimizer = true
optimizer_runs = 200
evm_version = "cancun"
bytecode_hash = "none"
cbor_metadata = false

[lint]
lint_on_build = false
TOML
(cd "$WORK" && "$FORGE" build --root "$WORK" >/dev/null)
SHA="$(shasum -a 256 "$HERE/TestUSDC.sol" | awk '{print $1}')"
FORGE_VERSION="$("$FORGE" --version | head -1)"
node -e '
const fs = require("fs");
const [art, out, sha, forgeV] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(art, "utf8"));
const solcV = a.metadata?.compiler?.version ?? "0.8.26";
const res = {
  contractName: "TestUSDC",
  abi: a.abi,
  bytecode: a.bytecode.object,
  compiler: { solc: solcV, via: forgeV, optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  sourceSha256: sha,
};
fs.writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
' "$WORK/out/TestUSDC.sol/TestUSDC.json" "$HERE/TestUSDC.json" "$SHA" "$FORGE_VERSION"
echo "wrote $HERE/TestUSDC.json (sourceSha256 $SHA)"
