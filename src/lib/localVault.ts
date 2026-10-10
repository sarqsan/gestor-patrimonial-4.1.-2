// Bóveda local para adjuntos nuevos cuando el proyecto Firebase bloquea la sesión
// (auth/admin-restricted-operation, rechazo administrativo del servicio).
//
// La aplicación nació con los adjuntos incrustados como data URL (formato LEGADO que
// TODAS las pantallas siguen leyendo y descargando). Este módulo reutiliza ese formato
// como vía de contingencia: el contenido queda en la copia local del usuario actual
// (localStorage, clave rentasync_state_{usuario}), con el MISMO aislamiento que el resto
// de su cartera. No toca Firebase, no modifica reglas, no migra ni reasigna nada.
//
// Cuando la restricción administrativa se levante, la vía de salida ya existe:
// externalizeImportedExpenses (src/lib/importAttachments.ts) convierte receiptUrl Base64
// en referencias receiptPath de Storage.

import { parseDataUrl } from "./legacyDataUrl";

/**
 * Presupuesto por archivo para la vía local. Las copias locales de la cartera viven en
 * localStorage (~5 MB por origen en la mayoría de navegadores), así que el presupuesto es
 * conservador: ~1 MB crudo (~1,35 MB como data URL). Las imágenes mayores se intentan
 * reducir antes de guardar (maybeDownscaleImage).
 */
export const LOCAL_INLINE_MAX_RAW_BYTES = 1_000_000;

/** Estimación de caracteres de data URL para N bytes crudos (cabecera + base64). */
export function dataUrlApproxChars(rawBytes: number): number {
  return 22 + Math.ceil(rawBytes / 3) * 4;
}

/** Comprueba el presupuesto de la vía local. Devuelve el motivo o null si cabe. */
export function localInlineBudgetProblem(
  file: { size: number },
  limitBytes: number = LOCAL_INLINE_MAX_RAW_BYTES
): string | null {
  if (file.size <= 0) return "El archivo está vacío.";
  if (file.size > limitBytes) {
    return (
      `supera el presupuesto local de ${Math.round(limitBytes / 1024)} KB para adjuntos guardados en este ` +
      `navegador mientras Firebase permanezca bloqueado por administración. Reduce el tamaño del archivo ` +
      `o restablece el acceso a Firebase Storage.`
    );
  }
  return null;
}

/**
 * Convierte un Blob a data URL. Usa arrayBuffer + btoa (disponibles en navegadores y en
 * Node >= 16), sin depender de FileReader.
 */
export async function blobToDataUrl(blob: Blob, contentType?: string): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  const type = contentType || blob.type || "application/octet-stream";
  return `data:${type};base64,${btoa(binary)}`;
}

/** Bytes crudos de una data URL generada por este módulo (reutiliza el parser legado). */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const parsed = parseDataUrl(dataUrl);
  return parsed ? parsed.bytes : null;
}

/**
 * Cuota conservadora de localStorage por origen, en caracteres UTF-16.
 * La mayoría de navegadores dan ~5 MB por origen (1 char UTF-16 = 2 bytes) →
 * 2,5 M caracteres. Se usa como estimación para NO confirmar un guardado local
 * que el navegador vaya a rechazar por cuota (evita falsos éxitos).
 */
export const LOCAL_STORAGE_QUOTA_CHARS = 2_500_000;

/** Margen adicional (JSON de la cartera, claves, cabeceras) sobre la data URL. */
export const LOCAL_INLINE_CAPACITY_MARGIN_CHARS = 8_192;

/**
 * Estima los caracteres libres de localStorage. Devuelve null si no se puede
 * estimar (p. ej. sin entorno navegador): en ese caso la confirmación se fía al
 * try/catch de escritura del estado (backstop existente en App.tsx).
 */
export function estimateLocalFreeChars(): number | null {
  if (typeof localStorage === "undefined") return null;
  try {
    let used = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key == null) continue;
      used += key.length + (localStorage.getItem(key) ?? "").length;
    }
    return Math.max(0, LOCAL_STORAGE_QUOTA_CHARS - used);
  } catch {
    return null;
  }
}

/**
 * Decisión pura de capacidad: ¿cabe una data URL de `dataUrlChars` caracteres en
 * `freeChars` libres? Devuelve el motivo o null si cabe. freeChars === null ⇒ no
 * estimable ⇒ se permite continuar (el backstop de escritura sigue protegiendo).
 */
export function localInlineCapacityProblem(opts: {
  dataUrlChars: number;
  freeChars: number | null;
  marginChars?: number;
}): string | null {
  if (opts.freeChars === null) return null;
  const margin = opts.marginChars ?? LOCAL_INLINE_CAPACITY_MARGIN_CHARS;
  if (opts.dataUrlChars + margin > opts.freeChars) {
    return (
      `el almacenamiento local de este navegador no tiene espacio suficiente para guardarlo ` +
      `(quedan ~${Math.max(0, Math.round(opts.freeChars / 1024))} KB y el archivo necesita ` +
      `~${Math.round(opts.dataUrlChars / 1024)} KB). Libera espacio eliminando datos de navegación ` +
      `o restablece el acceso a Firebase Storage.`
    );
  }
  return null;
}

/**
 * Intenta reducir una imagen en el navegador (canvas + JPEG) hasta que quepa en el
 * presupuesto. Devuelve null si no es posible o si no hay entorno de navegador.
 * Nunca lanza: la vía local degrada a error claro si no puede comprimir.
 */
export async function maybeDownscaleImage(file: Blob, limitBytes: number): Promise<Blob | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const maxDim = 1600;
    const initialScale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height, 1));
    let w = Math.max(1, Math.round(bitmap.width * initialScale));
    let h = Math.max(1, Math.round(bitmap.height * initialScale));
    let best: Blob | null = null;
    for (let quality = 0.85; quality >= 0.4; quality -= 0.15) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob) {
        if (blob.size <= limitBytes) return blob;
        if (!best || blob.size < best.size) best = blob;
      }
      // Reducir dimensiones para el siguiente intento
      w = Math.max(320, Math.round(w * 0.75));
      h = Math.max(320, Math.round(h * 0.75));
    }
    return null;
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}
