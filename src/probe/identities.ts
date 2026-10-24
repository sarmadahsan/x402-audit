/**
 * Client identities used by `probe`. Each round sends the same unpaid request once
 * per identity, back to back, so price discrimination by client fingerprint shows up
 * as two different quotes within the same minute.
 *
 * What an identity can and cannot be: an unpaid x402 request carries no buyer wallet.
 * The protocol only identifies the payer inside the PAYMENT-SIGNATURE header, which is
 * sent after the 402 and requires signing (docs/protocol-notes.md §1, §3). There is no
 * standard header that exposes a buyer wallet on the first request, so we do not invent
 * one. Identities therefore differ only in HTTP fingerprint (User-Agent, Accept).
 * A seller that discriminates by wallet would not be detected by `probe`.
 */

export interface ClientIdentity {
  /** Stored in probes.client_identity. */
  id: string;
  /** Request headers sent with every probe from this identity (lowercase names). */
  headers: Readonly<Record<string, string>>;
  /** Human description for reports. */
  description: string;
}

/** A: openly identifies itself as this research harness. */
export const IDENTITY_A: ClientIdentity = {
  id: "A",
  headers: {
    "user-agent": "x402-audit/0.1 (research probe; +https://github.com/sarmadahsan/x402-audit)",
    accept: "application/json",
  },
  description: "self-identified research probe",
};

/** B: looks like a default Node fetch / x402-fetch agent (undici sends User-Agent "node", Accept "*\/*"). */
export const IDENTITY_B: ClientIdentity = {
  id: "B",
  headers: {
    "user-agent": "node",
    accept: "*/*",
  },
  description: "default Node fetch / x402-fetch agent",
};

export const CLIENT_IDENTITIES: readonly ClientIdentity[] = [IDENTITY_A, IDENTITY_B];

/** Statement for reports: what the identities can and cannot reveal. */
export const IDENTITY_NOTE =
  "Identities differ only in HTTP headers. The unpaid x402 request carries no buyer wallet " +
  "(the payer appears only in the signed PAYMENT-SIGNATURE header), so wallet-based price " +
  "discrimination is not observable by probing.";
