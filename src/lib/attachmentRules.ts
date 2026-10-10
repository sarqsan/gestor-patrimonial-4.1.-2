// Pure helpers for attachments (receipts, property documents, contracts).
// This module must NOT import firebase: it is unit-tested with node:test.

/** Límite por fichero aceptado para nuevos adjuntos (coincide con storage.rules). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Límite de seguridad para el documento monolítico users/{u}/data/portfolio.
 * Firestore admite 1 MiB (1.048.576 bytes) por documento; dejamos margen porque
 * el tamaño que calculamos es una aproximación del JSON, no del formato interno.
 */
export const PORTFOLIO_DOC_SAFE_BYTES = 1_000_000;

/** Límite duro de Firestore por documento (1 MiB). Solo se usa para mensajes. */
export const PORTFOLIO_DOC_HARD_BYTES = 1_048_576;

/** Tamaño máximo de una copia de seguridad JSON en Storage (la cartera completa). */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export type AttachmentFolder = "expenses" | "property-documents" | "contracts";

/** Lista de contenidos aceptados para nuevos adjuntos. */
const ALLOWED_MIME_PREFIXES = ["image/"];
const ALLOWED_MIME_EXACT = ["application/pdf"];
/** Contratos generados en la aplicación (.doc de Word). Solo se admite en la carpeta de contratos. */
export const WORD_DOCUMENT_MIME = "application/msword";

/** Deduce el tipo MIME de un fichero, usando la extensión si el navegador no lo informa. */
export function resolveContentType(name: string, declaredType?: string): string {
  if (declaredType) return declaredType;
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/** Valida tamaño y tipo de un nuevo adjunto antes de subirlo. Devuelve null si es válido. */
export function validateAttachment(
  file: { name: string; size: number; type?: string },
  opts: { allowWordDocument?: boolean } = {}
): string | null {
  if (file.size <= 0) return "El archivo está vacío.";
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `El archivo supera el límite de ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`;
  }
  const type = resolveContentType(file.name, file.type);
  const allowed =
    ALLOWED_MIME_EXACT.includes(type) ||
    ALLOWED_MIME_PREFIXES.some((p) => type.startsWith(p)) ||
    (!!opts.allowWordDocument && type === WORD_DOCUMENT_MIME);
  if (!allowed) return "Formato no admitido. Usa JPG, PNG, WEBP o PDF.";
  return null;
}

/**
 * Comprueba un objeto ya existente (p. ej. un adjunto histórico) contra las mismas condiciones
 * que storage.rules para `create`. Devuelve null si cabe, o el motivo. Un tamaño 0 sí se admite
 * (la regla no lo rechaza) y la validación de "archivo vacío" es solo de la UI.
 */
export function storageRuleProblem(file: { size: number; contentType: string }): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `supera el límite de ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`;
  }
  const t = file.contentType;
  const allowed = t === "application/pdf" || t === WORD_DOCUMENT_MIME || t.startsWith("image/");
  return allowed ? null : `tipo no admitido por las reglas de Storage (${t || "sin tipo"})`;
}

/** Nombre de fichero seguro para usar en una ruta de Storage. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, ""); // sin puntos/guiones bajos iniciales (evita "..", ocultos o traversal)
  return cleaned.slice(-120) || "archivo";
}

/**
 * Ruta de Storage determinista: users/{usuario}/attachments/{carpeta}/{id}/{nombre}.
 * El usuario se codifica para que nunca pueda introducir separadores de ruta.
 * Al ser determinista, reejecutar una migración sobreescribe el mismo objeto
 * en lugar de crear duplicados.
 */
export function attachmentStoragePath(
  userId: string,
  folder: AttachmentFolder,
  attachmentId: string,
  fileName: string
): string {
  return [
    "users",
    encodeURIComponent(userId),
    "attachments",
    folder,
    sanitizeFileName(attachmentId),
    sanitizeFileName(fileName),
  ].join("/");
}

/**
 * Ruta de la copia de seguridad de una cartera. Direccionada por contenido (SHA-256):
 * la misma cartera produce siempre la misma ruta, así que repetir una copia no duplica objetos.
 * Vive fuera de attachments/ para que nunca se confunda con un adjunto.
 */
export function portfolioBackupStoragePath(userId: string, sha256Hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256Hex)) throw new Error("Hash de copia de seguridad no válido.");
  return ["users", encodeURIComponent(userId), "backups", "portfolio", `${sha256Hex}.json`].join("/");
}

/** Identificador nuevo para un adjunto (no depende de Date.now() en migraciones). */
export function newAttachmentId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rnd}`;
}

/** Un valor es un Base64 incrustado si es una data URL. */
export function isInlineDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/** Recorre cualquier estructura JSON y devuelve las rutas donde hay data URLs incrustadas. */
export function findInlineDataPaths(value: unknown, path = "$", out: string[] = []): string[] {
  if (isInlineDataUrl(value)) {
    out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findInlineDataPaths(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      findInlineDataPaths(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Tamaño aproximado en bytes (UTF-8) del JSON que se escribiría en Firestore. */
export function estimatePayloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/** Un registro tiene comprobante si tiene referencia a Storage o un archivo histórico. */
export function hasReceipt(exp: { receiptUrl?: string; receiptPath?: string }): boolean {
  return !!(exp.receiptPath || exp.receiptUrl);
}

/** Lista los adjuntos históricos incrustados en la cartera (solo lectura, sin escribir nada). */
export function listLegacyInlineAttachments(portfolio: {
  properties?: Array<{ id: string; documents?: Array<{ id: string; fileData?: string }>; contract?: { pdfName?: string } }>;
  expenses?: Array<{ id: string; receiptUrl?: string }>;
}): Array<{ kind: "expense" | "property-document"; id: string; bytes: number }> {
  const result: Array<{ kind: "expense" | "property-document"; id: string; bytes: number }> = [];
  for (const e of portfolio.expenses ?? []) {
    if (isInlineDataUrl(e.receiptUrl)) result.push({ kind: "expense", id: e.id, bytes: e.receiptUrl.length });
  }
  for (const p of portfolio.properties ?? []) {
    for (const d of p.documents ?? []) {
      if (isInlineDataUrl(d.fileData)) result.push({ kind: "property-document", id: d.id, bytes: d.fileData.length });
    }
  }
  return result;
}
