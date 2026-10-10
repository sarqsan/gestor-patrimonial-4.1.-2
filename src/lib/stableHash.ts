// Serialización estable y hash SHA-256 (WebCrypto en navegador y Node 22). Sin dependencias de Firebase.

/** JSON con claves ordenadas y sin valores undefined: misma entrada lógica => misma cadena. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Hash del contenido de un documento de cartera, excluyendo updatedAt (metadato de escritura). */
export async function portfolioRawHash(raw: Record<string, unknown>): Promise<string> {
  const { updatedAt: _ignored, ...rest } = raw;
  return sha256Hex(utf8Bytes(stableStringify(rest)));
}
