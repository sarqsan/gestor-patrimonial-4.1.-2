// Firebase Storage operations for attachments.
// New attachments are stored in Storage and referenced from Firestore by storagePath only.
// Legacy attachments (data: URLs stored inside the portfolio document) keep working unchanged.
import { ref, uploadBytes, getDownloadURL, getBlob, getBytes as getStorageBytes } from "firebase/storage";
import { storage, authReady, auth, ensureFirebaseAuth, describeAuthError, isAdministrativeAuthError } from "./firebase";
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

export class AttachmentError extends Error {}

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
      throw new AttachmentError(
        `Firebase Auth ha rechazado la sesión por una restricción administrativa del proyecto Firebase ` +
          `(${code}: ${detail}). El archivo no se ha subido. Este bloqueo no puede resolverse desde la ` +
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
  storagePath: string;
  name: string;
  contentType: string;
  size: number;
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
export async function uploadAttachment(opts: {
  userId: string;
  folder: AttachmentFolder;
  file: File;
  attachmentId?: string;
  /** Solo para contratos generados (.doc). */
  allowWordDocument?: boolean;
}): Promise<StoredAttachment> {
  const invalid = validateAttachment(opts.file, { allowWordDocument: opts.allowWordDocument });
  if (invalid) throw new AttachmentError(invalid);

  await ensureSignedIn();

  const contentType = resolveContentType(opts.file.name, opts.file.type);
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

  return { storagePath, name: opts.file.name, contentType, size: opts.file.size };
}

/** Espera a la sesión de Firebase (necesaria antes de cualquier operación de Storage). */
export async function ensureFirebaseSession(): Promise<void> {
  await ensureSignedIn();
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
}): Promise<StoredAttachment> {
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
  return { storagePath, name: opts.fileName, contentType: opts.contentType, size: opts.bytes.length };
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

/** Devuelve el Blob de un adjunto nuevo (Storage) o histórico (data URL). */
export async function getAttachmentBlob(source: { storagePath?: string; inlineData?: string }): Promise<Blob> {
  if (source.storagePath) return getAttachmentBytes(source.storagePath);
  if (source.inlineData && isInlineDataUrl(source.inlineData)) {
    const res = await fetch(source.inlineData);
    return res.blob();
  }
  throw new AttachmentError("El adjunto no tiene contenido disponible.");
}

/** Descarga un adjunto con el nombre original. */
export async function downloadAttachment(opts: {
  storagePath?: string;
  inlineData?: string;
  fileName: string;
}): Promise<void> {
  const blob = await getAttachmentBlob({ storagePath: opts.storagePath, inlineData: opts.inlineData });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = opts.fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}
