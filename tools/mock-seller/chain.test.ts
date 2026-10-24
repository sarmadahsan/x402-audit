/** Chain mode of the mock seller: TestUSDC on anvil, real transferWithAuthorization settlements. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { anvilAvailable, deployTestUsdc, startAnvil, testUsdcArtifact, ANVIL_DEFAULT_KEYS, type Anvil, type TestUsdc } from "./anvil.js";
import { startMockSeller, type MockSeller } from "./server.js";
import { signExactPayment } from "./sign.js";
import { settleErrorFromRevert } from "./facilitator.js";

const NETWORK = "eip155:84532";

describe("TestUSDC artifact", () => {
  it("matches the committed source", () => {
    const src = readFileSync(new URL("./contracts/TestUSDC.sol", import.meta.url));
    expect(testUsdcArtifact().sourceSha256).toBe(createHash("sha256").update(src).digest("hex"));
    expect(testUsdcArtifact().bytecode).toMatch(/^0x[0-9a-f]+$/);
  });
  it("maps FiatTokenV2 revert strings to SDK error codes", () => {
    expect(settleErrorFromRevert("execution reverted: FiatTokenV2: authorization is used or canceled")).toBe("invalid_exact_evm_nonce_already_used");
    expect(settleErrorFromRevert("FiatTokenV2: authorization is expired")).toBe("invalid_exact_evm_payload_authorization_valid_before");
    expect(settleErrorFromRevert("weird")).toBe("unexpected_settle_error");
  });
});

describe.skipIf(!anvilAvailable())("mock seller in chain mode (anvil)", () => {
  let anvil: Anvil;
  let token: TestUsdc;
  let seller: MockSeller;
  let pub: PublicClient;
  const buyerKey = generatePrivateKey();
  const buyer = privateKeyToAccount(buyerKey);

  beforeAll(async () => {
    anvil = await startAnvil({ chainId: 84532 });
    expect(anvil.accounts[0]!.address).toBe(privateKeyToAccount(ANVIL_DEFAULT_KEYS[0]!).address);
    token = await deployTestUsdc(anvil.rpcUrl, anvil.accounts[0]!.privateKey);
    await token.mint(buyer.address, 1_000_000n);
    seller = await startMockSeller({
      port: 0,
      network: NETWORK,
      asset: token.address,
      chain: { rpcUrl: anvil.rpcUrl, tokenAddress: token.address, facilitatorPrivateKey: anvil.accounts[1]!.privateKey },
    });
    pub = createPublicClient({ chain: anvil.chain, transport: http(anvil.rpcUrl) }) as PublicClient;
  }, 30_000);
  afterAll(async () => {
    await seller?.close();
    await anvil?.close();
  });

  async function quote(path: string) {
    const r = await fetch(seller.url + path);
    expect(r.status).toBe(402);
    return decodePaymentRequiredHeader(r.headers.get("payment-required")!);
  }

  it("settles /ok with a real transferWithAuthorization; replay is rejected as nonce reuse", async () => {
    expect(seller.facilitator.mode).toBe("chain");
    const pr = await quote("/ok?symbol=BTC");
    const req = pr.accepts[0]!;
    const payload = await signExactPayment({ account: buyer, requirements: req, resource: pr.resource });
    const header = encodePaymentSignatureHeader(payload);
    const r = await fetch(seller.url + "/ok?symbol=BTC", { headers: { "payment-signature": header } });
    expect(r.status).toBe(200);
    const s = seller.settlements();
    expect(s).toHaveLength(1);
    const receipt = await pub.getTransactionReceipt({ hash: s[0]!.txHash });
    expect(receipt.status).toBe("success");
    expect(await token.balanceOf(buyer.address)).toBe(1_000_000n - BigInt(req.amount));
    expect(await token.balanceOf(req.payTo)).toBe(BigInt(req.amount));

    const again = await fetch(seller.url + "/ok?symbol=BTC", { headers: { "payment-signature": header } });
    expect(again.status).toBe(402);
    expect(again.headers.get("payment-required")).toBeTruthy();
    const pr2 = decodePaymentRequiredHeader(again.headers.get("payment-required")!);
    expect(pr2.error).toBe("invalid_exact_evm_nonce_already_used");
    // Settling the same payload directly on the facilitator also hits the on-chain nonce check.
    seller.reset();
    const direct = await seller.facilitator.settle(payload, req);
    expect(direct.success).toBe(false);
    expect(direct.errorReason).toBe("invalid_exact_evm_nonce_already_used");
  });

  it("/fail/double-settle answers 501 in chain mode", async () => {
    const r = await fetch(seller.url + "/fail/double-settle");
    expect(r.status).toBe(501);
    expect(((await r.json()) as { note: string }).note).toMatch(/impossible/);
  });
});
