// Verificación por referencia al objeto, sin GET alt=media ni URL de descarga.
// md5Hash es el checksum que calcula Storage, NO un hash declarado en customMetadata.
// Se contrasta con los bytes originales; SHA-256 se usa además para identidad estable.
import SparkMD5 from "spark-md5";
import { AttachmentError, attachmentPhase, ATTACHMENT_TIMEOUTS } from "./attachmentErrors";
import { sha256Hex } from "./stableHash";

export interface StoredObjectMetadata {
  fullPath: string;
  bucket: string;
  size: number;
  contentType?: string;
  md5Hash?: string;
  generation: string;
  customMetadata?: Record<string, string>;
}

export interface StorageAttachmentPort {
  /** Solo object-not-found se traduce a null; permisos y red deben propagarse. */
  metadata(path: string): Promise<StoredObjectMetadata | null>;
  /** Subida cancelable. La referencia devuelta debe ser la del objeto efectivamente subido. */
  create(path: string, bytes: Uint8Array, metadata: {
    contentType: string; md5Hash: string; customMetadata: Record<string, string>;
  }, signal: AbortSignal): Promise<StoredObjectMetadata>;
}

export function md5Base64(bytes: Uint8Array): string {
  // Copia exacta: un Uint8Array puede ser una ventana de un buffer mayor.
  return btoa(SparkMD5.ArrayBuffer.hash(bytes.slice().buffer, true));
}

export function assertObjectMetadata(meta: StoredObjectMetadata | null, expected: {
  path: string; bucket: string; size: number; contentType: string; md5Hash: string; sha256: string;
  movementId?: string; propertyId?: string;
}): asserts meta is StoredObjectMetadata {
  if (!meta || meta.fullPath !== expected.path || meta.bucket !== expected.bucket || !meta.generation ||
      meta.size !== expected.size || meta.contentType !== expected.contentType ||
      meta.md5Hash !== expected.md5Hash ||
      (expected.movementId !== undefined && meta.customMetadata?.rentasyncMovementId !== expected.movementId) ||
      (expected.propertyId !== undefined && meta.customMetadata?.rentasyncPropertyId !== expected.propertyId) ||
      (meta.customMetadata?.rentasyncSHA256 && meta.customMetadata.rentasyncSHA256 !== expected.sha256)) {
    throw new AttachmentError(
      "El objeto almacenado no coincide con el archivo original (referencia, tamaño, tipo o checksum). No se confirma la operación y no se sobrescribe ni elimina ningún documento.",
      { phase: "verification", backend: "firebase", code: "attachment/integrity" }
    );
  }
}

/** Idempotente incluso si el upload terminó pero se perdió su respuesta/verificación. */
export async function storeStorageAttachment(port: StorageAttachmentPort, opts: {
  path: string;
  bucket: string;
  bytes: Uint8Array;
  contentType: string;
  movementId?: string;
  propertyId?: string;
}): Promise<StoredObjectMetadata> {
  const expected = { ...opts, size: opts.bytes.length, md5Hash: md5Base64(opts.bytes), sha256: await sha256Hex(opts.bytes) };
  const existing = await attachmentPhase("preflight", "firebase", ATTACHMENT_TIMEOUTS.preflight,
    () => port.metadata(opts.path));
  if (existing) {
    assertObjectMetadata(existing, expected);
    return existing;
  }

  const uploaded = await attachmentPhase("upload", "firebase", ATTACHMENT_TIMEOUTS.upload, (signal) =>
    port.create(opts.path, opts.bytes, {
      contentType: opts.contentType, md5Hash: expected.md5Hash,
      customMetadata: {
        rentasyncSHA256: expected.sha256,
        ...(opts.movementId ? { rentasyncMovementId: opts.movementId } : {}),
        ...(opts.propertyId ? { rentasyncPropertyId: opts.propertyId } : {}),
      },
    }, signal));
  assertObjectMetadata(uploaded, expected);
  // GET metadata autenticado sobre la referencia real. No basta con una promesa de subida resuelta.
  const persisted = await attachmentPhase("verification", "firebase", ATTACHMENT_TIMEOUTS.verification,
    () => port.metadata(uploaded.fullPath));
  assertObjectMetadata(persisted, expected);
  if (persisted.generation !== uploaded.generation) {
    throw new AttachmentError("La generación del archivo cambió durante la verificación. No se confirma la operación.",
      { phase: "verification", backend: "firebase", code: "attachment/generation-conflict" });
  }
  return persisted;
}
