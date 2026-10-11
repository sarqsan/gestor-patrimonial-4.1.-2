// Adjuntos remotos verificados (Vault privado o Firebase Storage por referencia estable).
// Nunca se considera definitivo un archivo que solo existe en el navegador.
// Legacy attachments (data: URLs stored inside the portfolio document) keep working unchanged.
import { ref, uploadBytesResumable, getMetadata, getBlob } from "firebase/storage";
import { storage, auth, ensureFirebaseAuth, describeAuthError, isAdministrativeAuthError, isTransientNetworkAuthError } from "./firebase";
import {
  AttachmentFolder,
  attachmentStoragePath,
  isInlineDataUrl,
  resolveContentType,
  validateAttachment,
  MAX_ATTACHMENT_BYTES,
} from "./attachmentRules";
import { storeStorageAttachment, StorageAttachmentPort } from "./storageAttachment";
import { AttachmentError, attachmentFailure, attachmentPhase, ATTACHMENT_TIMEOUTS, logAttachmentFailure } from "./attachmentErrors";
import { sha256Hex, utf8Bytes } from "./stableHash";
export { AttachmentError } from "./attachmentErrors";
import {
  VaultAuthError,
  VaultError,
  VaultUnavailableError,
  getActiveVaultUser,
  getVaultToken,
  invalidateVaultCapabilities,
  vaultCapabilities,
  vaultDownloadFile,
  vaultUnavailableMessage,
  vaultUploadFileAuto,
  vaultVerifyFile,
} from "./vaultClient";
import type { PropertyExpense } from "../types";

/**
 * Fallo de sesión por restricción ADMINISTRATIVA del proyecto Firebase
 * (auth/admin-restricted-operation). No es un fallo de red: reintentar no lo resuelve.
 */
export class AdminRestrictedAttachmentError extends AttachmentError {}

async function ensureSignedIn(): Promise<void> {
  if (auth?.currentUser) {
    return;
  }

  try {
    await attachmentPhase("session", "firebase", ATTACHMENT_TIMEOUTS.session, () => ensureFirebaseAuth());
  } catch (err: any) {
    if (err instanceof AttachmentError && err.code === "attachment/timeout") throw err;
    const original = err instanceof AttachmentError && err.cause ? err.cause : err;
    const code = original?.code || "";
    const detail = describeAuthError(original);
    if (isAdministrativeAuthError(original)) {
      // Rechazo administrativo del servicio (p. ej. auth/admin-restricted-operation):
      // NO es un fallo transitorio de red y ningún reintento de cliente puede resolverlo.
      // Se comunica como bloqueo de configuración del proyecto Firebase, sin confundirlo
      // con problemas de conexión ni agotar el tiempo de espera.
      throw new AdminRestrictedAttachmentError(
        `Firebase Auth ha rechazado la sesión por una restricción administrativa del proyecto Firebase ` +
          `(${code}: ${detail}). Este bloqueo no puede resolverse desde la ` +
          `aplicación: requiere revisar la configuración de Authentication/Identity Platform del proyecto ` +
          `en la consola de Firebase.`,
        { phase: "session", backend: "firebase", code, cause: original }
      );
    }
    const msg = code
      ? `No se ha podido iniciar la sesión anónima de Firebase (${code}: ${detail}); el archivo no se ha subido.`
      : `No se ha podido iniciar la sesión anónima de Firebase (${detail}); el archivo no se ha subido.`;
    throw new AttachmentError(msg, { phase: "session", backend: "firebase", code, cause: original, retryable: isTransientNetworkAuthError(original) });
  }
}

export interface StoredAttachment {
  /** Ruta en Firebase Storage (solo en modo "storage"). */
  storagePath?: string;
  /** Referencia al vault, el almacenamiento remoto propio (solo en modo "vault"). */
  vaultId?: string;
  /**
   * "vault": almacenamiento remoto persistente propio (destino definitivo).
   *   En producción es un almacén Blob PRIVADO de Vercel; el navegador nunca recibe su URL.
   * "storage": Firebase Storage (solo si el proyecto Firebase vuelve a autorizar la sesión).
   *
   * No existe un modo "local": el navegador no es un destino de almacenamiento definitivo
   * y una subida que no llega al almacén remoto NO se declara completada.
   */
  mode: "vault" | "storage";
  name: string;
  contentType: string;
  size: number;
}

/**
 * Campos de comprobante de operación a partir del resultado de una subida.
 * Cada modo escribe SU referencia y limpia las demás para no mezclar orígenes:
 * vault → receiptVaultId; Storage → receiptPath. Inline solo para lectura del legado.
 */
export function expenseReceiptFieldsFromStored(stored: StoredAttachment): Partial<PropertyExpense> {
  if (stored.mode === "vault") {
    return {
      receiptVaultId: stored.vaultId,
      receiptName: stored.name,
      receiptType: stored.contentType,
      receiptPath: undefined,
      receiptUrl: undefined,
    };
  }
  return {
    receiptPath: stored.storagePath,
    receiptName: stored.name,
    receiptType: stored.contentType,
    receiptUrl: undefined,
    receiptVaultId: undefined,
  };
}

/** Traduce códigos de Firebase Storage a mensajes que el usuario puede entender. */
export function describeStorageError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "storage/unauthorized":
      return "Firebase Storage ha rechazado la operación. Revisa que Storage esté habilitado y que las reglas (storage.rules) estén publicadas.";
    case "storage/unauthenticated":
      return "No hay sesión válida en Firebase. Recarga la página e inténtalo de nuevo.";
    case "storage/quota-exceeded":
      return "Se ha superado la cuota de Firebase Storage.";
    case "storage/retry-limit-exceeded":
      return "Sin conexión o tiempo de espera agotado. El archivo no se ha subido; inténtalo de nuevo.";
    case "storage/object-not-found":
      return "El archivo adjunto no existe en Firebase Storage.";
    case "storage/canceled":
      return "La subida del archivo se ha cancelado.";
    default:
      return err instanceof Error ? `Error de Firebase Storage: ${err.message}` : "Error desconocido de Firebase Storage.";
  }
}

/**
 * Comprueba SOLO la sesión Firebase, no los permisos de Storage/Firestore. Ante un
 * rechazo administrativo del proyecto (auth/admin-restricted-operation), informa en lugar de
 * degradar a un almacenamiento local que no es persistente. La sesión se memoiza: si ya está
 * activa no se repite la comprobación en cada subida.
 */
interface FirebaseProbe {
  usable: boolean;
  /** Motivo técnico del fallo (incluye el código del servicio cuando existe). */
  reason?: string;
  /** `true` si el fallo es transitorio (red): no se memoriza y se reintenta. */
  transient?: boolean;
  error?: AttachmentError;
}

let firebaseProbe: Promise<FirebaseProbe> | null = null;
let firebaseProbeAt = 0;
function ensureFirebaseProbe(): Promise<FirebaseProbe> {
  // Una sesión recuperada o una configuración corregida no queda bloqueada por una sonda antigua.
  if (auth?.currentUser) return Promise.resolve({ usable: true });
  if (Date.now() - firebaseProbeAt > 20_000) firebaseProbe = null;
  if (!firebaseProbe) {
    firebaseProbeAt = Date.now();
    const probe = checkFirebaseStorageUsable();
    firebaseProbe = probe;
    // Un fallo transitorio (red) NO se memoriza: el siguiente intento debe poder volver a probar.
    probe.then((result) => {
      if (!result.usable && result.transient) firebaseProbe = null;
    });
  }
  return firebaseProbe;
}
async function checkFirebaseStorageUsable(): Promise<FirebaseProbe> {
  try {
    await ensureSignedIn();
    return { usable: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[attachments] Firebase Storage no utilizable:", reason);
    // Un bloqueo administrativo no se resuelve reintentando; una caída de red sí.
    const error = attachmentFailure(err, "session", "firebase");
    return { usable: false, reason, error, transient: error.retryable };
  }
}

/** Reintenta la comprobación de Firebase (tras un fallo transitorio, por ejemplo). */
export function invalidateFirebaseStorageProbe(): void {
  firebaseProbe = null;
}

const firebaseAttachmentPort: StorageAttachmentPort = {
  async metadata(path) {
    try { return await getMetadata(ref(storage, path)); }
    catch (err) {
      if ((err as { code?: string })?.code === "storage/object-not-found") return null;
      throw err;
    }
  },
  async create(path, bytes, metadata, signal) {
    signal.throwIfAborted();
    const task = uploadBytesResumable(ref(storage, path), bytes, metadata);
    const cancel = () => task.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) { task.cancel(); signal.throwIfAborted(); }
      const snapshot = await task;
      signal.throwIfAborted();
      // La consulta posterior usa snapshot.ref (no una URL ni una ruta ajena a lo subido).
      return { ...snapshot.metadata, fullPath: snapshot.ref.fullPath, bucket: snapshot.ref.bucket };
    } finally { signal.removeEventListener("abort", cancel); }
  },
};
let activeStoragePort = firebaseAttachmentPort;
/** SOLO PRUEBAS: inyección del transporte, no cambia proyecto/credenciales/reglas. */
export function __setStorageAttachmentPortForTests(port: StorageAttachmentPort | null): void {
  activeStoragePort = port ?? firebaseAttachmentPort;
}

/** Misma cuenta, operación, inmueble y bytes => misma referencia en los dos transportes. */
async function stableAttachmentId(opts: {
  folder: AttachmentFolder; fileName: string; bytes: Uint8Array; movementId?: string; propertyId?: string;
}): Promise<string> {
  const contentHash = await sha256Hex(opts.bytes);
  return `att_${await sha256Hex(utf8Bytes(JSON.stringify([
    opts.folder, opts.fileName, opts.movementId ?? "", opts.propertyId ?? "", contentHash,
  ])))}`;
}

export async function uploadAttachment(opts: {
  userId: string;
  folder: AttachmentFolder;
  file: File;
  attachmentId?: string;
  movementId?: string;
  propertyId?: string;
  allowWordDocument?: boolean;
}): Promise<StoredAttachment> {
  const invalid = validateAttachment(opts.file, { allowWordDocument: opts.allowWordDocument });
  if (invalid) throw new AttachmentError(invalid, { phase: "validation", code: "attachment/invalid-file" });
  const contentType = resolveContentType(opts.file.name, opts.file.type);
  const bytes = new Uint8Array(await opts.file.arrayBuffer());
  const attachmentId = opts.attachmentId ?? await stableAttachmentId({ ...opts, fileName: opts.file.name, bytes });

  // Elegir destino ANTES de escribir. Una subida iniciada o un 401/403 nunca degrada a
  // otra identidad/proveedor: podría completar tarde y generar una copia huérfana.
  if (getVaultToken(opts.userId)) {
    let capabilities: Awaited<ReturnType<typeof vaultCapabilities>> | null = null;
    try { capabilities = await vaultCapabilities(); }
    catch (err) { console.warn("[attachments] Sonda del almacén remoto fallida:", err instanceof Error ? err.message : String(err)); }
    if (capabilities?.storageOk && capabilities.durable) {
      try {
        const meta = await vaultUploadFileAuto({
          username: opts.userId, file: opts.file, name: opts.file.name, contentType,
          fileId: attachmentId, movementId: opts.movementId, propertyId: opts.propertyId, capabilities,
        });
        return { mode: "vault", vaultId: meta.id, name: meta.name, contentType: meta.contentType, size: meta.size };
      } catch (err) {
        invalidateVaultCapabilities();
        const failure = attachmentFailure(err, "upload", "vault");
        logAttachmentFailure(failure);
        throw failure;
      }
    }
    const probe = await ensureFirebaseProbe();
    if (!probe.usable) {
      throw new AttachmentError(`${vaultUnavailableMessage(capabilities)}${probe.reason ? ` Firebase Storage tampoco está disponible: ${probe.reason}` : ""}`,
        { phase: probe.error?.phase, backend: "firebase", code: probe.error?.code, cause: probe.error, retryable: probe.error?.retryable });
    }
  } else {
    const probe = await ensureFirebaseProbe();
    if (!probe.usable) {
      throw new AttachmentError("El almacenamiento remoto de la aplicación no está activo en esta sesión: cierra sesión y vuelve " +
        "a entrar para activarlo." + (probe.reason ? ` Motivo: ${probe.reason}` : "") + " El archivo no se ha guardado.",
        { phase: "session", backend: "firebase", code: probe.error?.code, cause: probe.error, retryable: probe.error?.retryable });
    }
  }
  return uploadBytesVerified({
    userId: opts.userId, folder: opts.folder, attachmentId, fileName: opts.file.name, contentType,
    bytes, movementId: opts.movementId, propertyId: opts.propertyId,
  });
}

/** Espera a la sesión de Firebase (necesaria antes de cualquier operación de Storage). */
export async function ensureFirebaseSession(): Promise<void> {
  await ensureSignedIn();
}

/** Resultado de una subida confirmada a Firebase Storage (importaciones, subidas verificadas). */
export interface StorageStoredAttachment extends StoredAttachment {
  mode: "storage";
  storagePath: string;
}

/** Bytes ya decodificados: la misma verificación de objeto que en el formulario manual. */
export async function uploadBytesVerified(opts: {
  userId: string;
  folder: AttachmentFolder;
  attachmentId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  movementId?: string;
  propertyId?: string;
}): Promise<StorageStoredAttachment> {
  const invalid = validateAttachment({ name: opts.fileName, type: opts.contentType, size: opts.bytes.length },
    { allowWordDocument: opts.folder === "contracts" });
  if (invalid) throw new AttachmentError(invalid, { phase: "validation", code: "attachment/invalid-file" });
  await ensureSignedIn();
  const storagePath = attachmentStoragePath(opts.userId, opts.folder, opts.attachmentId, opts.fileName);
  try {
    await storeStorageAttachment(activeStoragePort, {
      path: storagePath, bucket: ref(storage).bucket, bytes: opts.bytes, contentType: opts.contentType,
      movementId: opts.movementId, propertyId: opts.propertyId,
    });
  } catch (err) {
    const failure = attachmentFailure(err, "verification", "firebase");
    logAttachmentFailure(failure);
    throw failure;
  }
  return { mode: "storage", storagePath, name: opts.fileName, contentType: opts.contentType, size: opts.bytes.length };
}

/** Antes de asociar una referencia existente, confirma que el objeto sigue disponible. */
export async function verifyAttachmentReference(userId: string, source: {
  vaultId?: string; storagePath?: string; movementId?: string; propertyId?: string;
}, parentSignal?: AbortSignal): Promise<void> {
  parentSignal?.throwIfAborted();
  if (source.vaultId) {
    const meta = await vaultVerifyFile(userId, source.vaultId, parentSignal);
    if ((meta.movementId && source.movementId && meta.movementId !== source.movementId) ||
        (meta.propertyId && source.propertyId && meta.propertyId !== source.propertyId)) {
      throw new AttachmentError("El adjunto corresponde a otra operación o inmueble. No se confirma el guardado.",
        { phase: "association", backend: "vault", code: "attachment/association-conflict" });
    }
    return;
  }
  if (!source.storagePath || !source.storagePath.startsWith(`users/${encodeURIComponent(userId)}/attachments/`)) {
    throw new AttachmentError("La referencia del adjunto no pertenece a esta cuenta.",
      { phase: "association", backend: "firebase", code: "attachment/invalid-reference" });
  }
  await ensureSignedIn();
  const meta = await attachmentPhase("verification", "firebase", ATTACHMENT_TIMEOUTS.verification,
    () => activeStoragePort.metadata(source.storagePath!), parentSignal);
  if (!meta || meta.fullPath !== source.storagePath || meta.bucket !== ref(storage).bucket || !meta.generation || !meta.md5Hash || meta.size <= 0) {
    throw new AttachmentError("El adjunto no está disponible en Firebase Storage. No se confirma el guardado.",
      { phase: "verification", backend: "firebase", code: "storage/object-not-found" });
  }
  if ((meta.customMetadata?.rentasyncMovementId && source.movementId && meta.customMetadata.rentasyncMovementId !== source.movementId) ||
      (meta.customMetadata?.rentasyncPropertyId && source.propertyId && meta.customMetadata.rentasyncPropertyId !== source.propertyId)) {
    throw new AttachmentError("El adjunto corresponde a otra operación o inmueble. No se confirma el guardado.",
      { phase: "association", backend: "firebase", code: "attachment/association-conflict" });
  }
}

/** URL LOCAL temporal, tras descarga autenticada. El llamante debe revocarla al cerrar el visor. */
export async function getAttachmentPreviewUrl(storagePath: string): Promise<string> {
  return URL.createObjectURL(await getAttachmentBytes(storagePath));
}

/** Descarga autenticada por referencia. El SDK requiere CORS para alt=media en el navegador. */
export async function getAttachmentBytes(storagePath: string): Promise<Blob> {
  await ensureSignedIn();
  try {
    return await attachmentPhase("download", "firebase", ATTACHMENT_TIMEOUTS.download,
      () => getBlob(ref(storage, storagePath), MAX_ATTACHMENT_BYTES));
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw attachmentFailure(err, "download", "firebase");
  }
}

/**
 * Devuelve el Blob de un adjunto. Prioridad de lectura (compatibilidad histórica):
 *   1. vault (referencia vaultId del almacenamiento remoto propio)
 *   2. Firebase Storage (storagePath)
 *   3. legado incrustado (inlineData / receiptUrl / fileData, data URL)
 */
export async function getAttachmentBlob(source: {
  vaultId?: string;
  vaultUsername?: string;
  storagePath?: string;
  inlineData?: string;
}): Promise<Blob> {
  if (source.vaultId) {
    const username = source.vaultUsername ?? getActiveVaultUser();
    if (!username) throw new AttachmentError("No hay sesión del almacenamiento remoto para recuperar este archivo.");
    try {
      return await vaultDownloadFile(username, source.vaultId);
    } catch (err) {
      if (err instanceof AttachmentError) throw err;
      throw attachmentFailure(err, "download", "vault");
    }
  }
  if (source.storagePath) return getAttachmentBytes(source.storagePath);
  if (source.inlineData && isInlineDataUrl(source.inlineData)) {
    const res = await fetch(source.inlineData);
    return res.blob();
  }
  throw new AttachmentError("El adjunto no tiene contenido disponible.");
}

/** Descarga un adjunto con el nombre original. */
export async function downloadAttachment(opts: {
  vaultId?: string;
  vaultUsername?: string;
  storagePath?: string;
  inlineData?: string;
  fileName: string;
}): Promise<void> {
  const blob = await getAttachmentBlob({
    vaultId: opts.vaultId,
    vaultUsername: opts.vaultUsername,
    storagePath: opts.storagePath,
    inlineData: opts.inlineData,
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = opts.fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}
