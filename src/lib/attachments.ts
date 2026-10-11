// Firebase Storage operations for attachments.
// New attachments are stored in Storage and referenced from Firestore by storagePath only.
// Legacy attachments (data: URLs stored inside the portfolio document) keep working unchanged.
import { ref, uploadBytes, getDownloadURL, getBlob, getBytes as getStorageBytes } from "firebase/storage";
import { storage, authReady, auth, ensureFirebaseAuth, describeAuthError, isAdministrativeAuthError, isTransientNetworkAuthError } from "./firebase";
import {
  AttachmentFolder,
  attachmentStoragePath,
  isInlineDataUrl,
  newAttachmentId,
  resolveContentType,
  validateAttachment,
  MAX_ATTACHMENT_BYTES,
} from "./attachmentRules";
import { ObjectConflictError, storeVerifiedObject, VerifiedObjectPort } from "./verifiedObjectStore";
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
} from "./vaultClient";
import type { PropertyExpense } from "../types";

export class AttachmentError extends Error {}

/**
 * Fallo de sesión por restricción ADMINISTRATIVA del proyecto Firebase
 * (auth/admin-restricted-operation). No es un fallo de red: reintentar no lo resuelve.
 */
export class AdminRestrictedAttachmentError extends AttachmentError {}

const AUTH_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;

/** Evita esperas indefinidas (p. ej. sin red): si no responde a tiempo, el error es visible. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttachmentError(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function ensureSignedIn(): Promise<void> {
  if (auth?.currentUser) {
    return;
  }

  try {
    await withTimeout(
      ensureFirebaseAuth(),
      AUTH_TIMEOUT_MS,
      "No se ha podido conectar con Firebase (tiempo de espera agotado). Comprueba la conexión e inténtalo de nuevo."
    );
  } catch (err: any) {
    if (err instanceof AttachmentError) {
      throw err;
    }
    const code = err?.code || "";
    const detail = describeAuthError(err);
    if (isAdministrativeAuthError(err)) {
      // Rechazo administrativo del servicio (p. ej. auth/admin-restricted-operation):
      // NO es un fallo transitorio de red y ningún reintento de cliente puede resolverlo.
      // Se comunica como bloqueo de configuración del proyecto Firebase, sin confundirlo
      // con problemas de conexión ni agotar el tiempo de espera.
      throw new AdminRestrictedAttachmentError(
        `Firebase Auth ha rechazado la sesión por una restricción administrativa del proyecto Firebase ` +
          `(${code}: ${detail}). Este bloqueo no puede resolverse desde la ` +
          `aplicación: requiere revisar la configuración de Authentication/Identity Platform del proyecto ` +
          `en la consola de Firebase.`
      );
    }
    const msg = code
      ? `No se ha podido iniciar la sesión anónima de Firebase (${code}: ${detail}); el archivo no se ha subido.`
      : `No se ha podido iniciar la sesión anónima de Firebase (${detail}); el archivo no se ha subido.`;
    throw new AttachmentError(msg);
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
 * vault → receiptVaultId; Storage → receiptPath; cola local → receiptUrl (legado).
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
 * Sube un adjunto nuevo a users/{usuario}/attachments/{carpeta}/{id}/{nombre}.
 * Lanza AttachmentError con un mensaje visible si la validación o la subida fallan.
 */
/**
 * ¿Firebase Storage es realmente utilizable ahora mismo? Comprueba la sesión y, ante un
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
}

let firebaseProbe: Promise<FirebaseProbe> | null = null;
function ensureFirebaseProbe(): Promise<FirebaseProbe> {
  if (!firebaseProbe) {
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
    return { usable: false, reason, transient: isTransientNetworkAuthError(err) };
  }
}

/** Reintenta la comprobación de Firebase (tras un fallo transitorio, por ejemplo). */
export function invalidateFirebaseStorageProbe(): void {
  firebaseProbe = null;
}

export async function uploadAttachment(opts: {
  userId: string;
  folder: AttachmentFolder;
  file: File;
  attachmentId?: string;
  /** Vincula el archivo a su movimiento en el índice del vault (trazabilidad). */
  movementId?: string;
  /** Vincula el archivo a su inmueble en el índice del vault (trazabilidad). */
  propertyId?: string;
  /** Solo para contratos generados (.doc). */
  allowWordDocument?: boolean;
}): Promise<StoredAttachment> {
  const invalid = validateAttachment(opts.file, { allowWordDocument: opts.allowWordDocument });
  if (invalid) throw new AttachmentError(invalid);

  const contentType = resolveContentType(opts.file.name, opts.file.type);

  // ---- 1) VAULT: almacenamiento remoto persistente propio (destino definitivo). ----
  // No depende de la sesión anónima de Firebase. Si hay sesión del vault para este
  // usuario, el archivo viaja al backend de la aplicación y queda disponible entre
  // sesiones y dispositivos.
  if (getVaultToken(opts.userId)) {
    let capabilities: Awaited<ReturnType<typeof vaultCapabilities>> | null = null;
    try {
      capabilities = await vaultCapabilities();
      if (capabilities.storageOk) {
        const meta = await withTimeout(
          vaultUploadFileAuto({
            username: opts.userId,
            file: opts.file,
            name: opts.file.name,
            contentType,
            movementId: opts.movementId,
            propertyId: opts.propertyId,
            capabilities,
          }),
          UPLOAD_TIMEOUT_MS,
          "La subida al almacenamiento remoto ha superado el tiempo de espera. El archivo no se ha guardado; inténtalo de nuevo."
        );
        return { mode: "vault", vaultId: meta.id, name: opts.file.name, contentType, size: meta.size };
      }
    } catch (err) {
      if (!(err instanceof VaultAuthError || err instanceof VaultError || err instanceof AttachmentError)) {
        throw err instanceof Error ? err : new AttachmentError(String(err));
      }
      // El almacén remoto no está disponible: se registra el motivo real y NO se sustituye
      // por almacenamiento del navegador. Se intenta Firebase y, si tampoco, error explícito.
      console.warn("[attachments] Almacenamiento remoto no disponible en esta subida:", err);
      invalidateVaultCapabilities();
    }
    // Con el almacén remoto inutilizable no se simula un guardado local: se informa y se para.
    const probe = await ensureFirebaseProbe();
    if (!probe.usable) {
      throw new AttachmentError(
        `${vaultUnavailableMessage(capabilities)}${probe.reason ? ` Firebase Storage tampoco está disponible: ${probe.reason}` : ""}`
      );
    }
  } else {
    // Sesión remota aún no establecida (p. ej. acceso anterior a esta función): se intenta
    // Firebase y, si no está disponible, se explica el motivo real y qué hacer.
    const probe = await ensureFirebaseProbe();
    if (!probe.usable) {
      throw new AttachmentError(
        "El almacenamiento remoto de la aplicación no está activo en esta sesión: cierra sesión y vuelve " +
          "a entrar para activarlo." +
          (probe.reason ? ` Motivo: ${probe.reason}` : "") +
          " El archivo no se ha guardado."
      );
    }
  }

  // ---- 2) FIREBASE STORAGE: solo si el proyecto Firebase autoriza la sesión. ----

  const attachmentId = opts.attachmentId ?? newAttachmentId("att");
  const storagePath = attachmentStoragePath(opts.userId, opts.folder, attachmentId, opts.file.name);

  try {
    await withTimeout(
      uploadBytes(ref(storage, storagePath), opts.file, { contentType }),
      UPLOAD_TIMEOUT_MS,
      "La subida del archivo ha superado el tiempo de espera. No se ha guardado la operación; inténtalo de nuevo."
    );
  } catch (err) {
    console.error("Attachment upload failed:", storagePath, err);
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(describeStorageError(err));
  }

  return { mode: "storage", storagePath, name: opts.file.name, contentType, size: opts.file.size };
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

/**
 * Sube bytes ya decodificados (importaciones, contratos generados) y verifica que el objeto
 * en Storage coincide byte a byte con lo enviado. Si no coincide, lanza AttachmentError.
 */
export async function uploadBytesVerified(opts: {
  userId: string;
  folder: AttachmentFolder;
  attachmentId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<StorageStoredAttachment> {
  await ensureSignedIn();
  const storagePath = attachmentStoragePath(opts.userId, opts.folder, opts.attachmentId, opts.fileName);
  // Sin `update` en las reglas: si el objeto ya existe con el mismo contenido (reimportación),
  // se reutiliza; si existe con otro contenido, se aborta sin sobrescribir.
  const port: VerifiedObjectPort = {
    async read(path) {
      try {
        return new Uint8Array(
          await withTimeout(
            getStorageBytes(ref(storage, path), MAX_ATTACHMENT_BYTES),
            UPLOAD_TIMEOUT_MS,
            "La verificación del archivo ha superado el tiempo de espera. No se ha guardado la operación."
          )
        );
      } catch (err) {
        if ((err as { code?: string })?.code === "storage/object-not-found") return null;
        throw err;
      }
    },
    async create(path, bytes, contentType) {
      await withTimeout(
        uploadBytes(ref(storage, path), new Blob([bytes], { type: contentType }), { contentType }),
        UPLOAD_TIMEOUT_MS,
        "La subida del archivo ha superado el tiempo de espera. No se ha guardado la operación; inténtalo de nuevo."
      );
    },
  };
  try {
    await storeVerifiedObject(port, { path: storagePath, bytes: opts.bytes, contentType: opts.contentType });
  } catch (err) {
    console.error("Verified upload failed:", storagePath, err);
    if (err instanceof AttachmentError) throw err;
    if (err instanceof ObjectConflictError) throw new AttachmentError(err.message);
    throw new AttachmentError(describeStorageError(err));
  }
  return { mode: "storage", storagePath, name: opts.fileName, contentType: opts.contentType, size: opts.bytes.length };
}

/** URL temporal para previsualizar (img/iframe). No se persiste en Firestore. */
export async function getAttachmentPreviewUrl(storagePath: string): Promise<string> {
  await ensureSignedIn();
  try {
    return await getDownloadURL(ref(storage, storagePath));
  } catch (err) {
    throw new AttachmentError(describeStorageError(err));
  }
}

/** Descarga los bytes de un adjunto de Storage (usa el SDK, sin depender de CORS en fetch). */
export async function getAttachmentBytes(storagePath: string): Promise<Blob> {
  await ensureSignedIn();
  try {
    return await withTimeout(
      getBlob(ref(storage, storagePath), MAX_ATTACHMENT_BYTES),
      UPLOAD_TIMEOUT_MS,
      "La descarga del archivo ha superado el tiempo de espera."
    );
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(describeStorageError(err));
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
      return await withTimeout(
        vaultDownloadFile(username, source.vaultId),
        UPLOAD_TIMEOUT_MS,
        "La descarga del archivo ha superado el tiempo de espera."
      );
    } catch (err) {
      if (err instanceof AttachmentError) throw err;
      throw new AttachmentError(err instanceof Error ? err.message : String(err));
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
