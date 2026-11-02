// The exact code README.md shows under "Add it". test/readme.test.ts checks that the README block and the region
// between the two markers are identical, and runs this function against the mocked index and sellers.
import type { ClientEvmSigner } from "@x402/evm";
// README-START
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { usePaidfor } from "@paidfor/x402-policy";

export function createFetchWithPayment(signer: ClientEvmSigner) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer }); // your existing setup, unchanged
  const paidfor = usePaidfor(client); // the one added line
  return wrapFetchWithPayment(paidfor.fetch, client); // paidfor.fetch where you passed fetch
}
// README-END
