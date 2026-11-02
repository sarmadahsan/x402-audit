function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** sha256 hex via Web Crypto, falling back to node:crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return toHex(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const nodeCrypto = (await import("node:crypto")) as typeof import("node:crypto");
  return nodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The index's path_hash: sha256 hex of the URL path with any trailing slash removed ("/" for the root). */
export async function pathHash(url: string): Promise<string> {
  const p = new URL(url).pathname.replace(/\/$/, "") || "/";
  return sha256Hex(p);
}
