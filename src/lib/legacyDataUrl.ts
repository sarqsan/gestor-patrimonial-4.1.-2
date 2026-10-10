// Utilidades puras para decodificar data URLs históricas (Base64 incrustado).
// No depende de Firebase ni del DOM.

export interface ParsedDataUrl {
  mimeType: string;
  base64: string;
  bytes: Uint8Array;
  sizeBytes: number;
}

const DATA_URL_RE = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i;

export function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(DATA_URL_RE);
  if (!m) return null;
  const mimeType = (m[1] || "application/octet-stream").toLowerCase();
  const base64 = m[2] || "";
  if (base64.length === 0) return null;
  // Validación estricta de Base64: solo caracteres válidos y padding correcto
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  if (base64.length % 4 !== 0) return null;
  try {
    let bytes: Uint8Array;
    if (typeof Buffer !== "undefined") {
      bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    } else {
      const bin = atob(base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    if (bytes.length === 0) return null;
    return { mimeType, base64, bytes, sizeBytes: bytes.length };
  } catch {
    return null;
  }
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/** Tamaño aproximado del contenido binario de una data URL (sin decodificar completamente si no hace falta). */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  // Base64: 4 chars -> 3 bytes, menos padding.
  const padding = (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return Math.floor((b64.length * 3) / 4) - padding;
}
