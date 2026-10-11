// Cliente del vault: el backend persistente propio de la aplicación (server/vault).
//
// - URLs RELATIVAS al mismo origen y en la FORMA COMPATIBLE con Vercel
//   (`/api/vault?op=<operación>[&id=…]`): las rutas anidadas (/api/vault/archivos/…) devuelven
//   404 de la propia plataforma antes de alcanzar Express; la forma de un solo segmento de
//   ruta con la operación en la consulta llega siempre al router, en el despliegue real y tras
//   el proxy de previsualización, sin hardcodear hosts.
// - El navegador solo posee el TOKEN DE SESIÓN del usuario (mismo nivel de protección que
//   el estado local ya existente). Ninguna clave de servicio ni credencial privilegiada
//   llega al cliente.
// - El token se guarda por usuario (rentasync_vault_token_{usuario}): el aislamiento entre
//   cuentas es el mismo que el del resto de la copia local.

import { parseDataUrl } from "./legacyDataUrl";

export class VaultError extends Error {}
/** El vault no responde (red/despliegue): la app puede seguir en modo degradado. */
export class VaultUnavailableError extends VaultError {}
/** Credenciales o sesión inválidas. */
export class VaultAuthError extends VaultError {}

export interface VaultFileMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  movementId?: string;
  propertyId?: string;
  createdAt: string;
}

const tokenKey = (username: string) => `rentasync_vault_token_${username}`;
const ACTIVE_USER_KEY = "rentasync_vault_active_user";

/** Usuario con sesión vault activa (para resolver descargas por referencia sin hilo de usuario). */
export function getActiveVaultUser(): string | null {
  try {
    return localStorage.getItem(ACTIVE_USER_KEY);
  } catch {
    return null;
  }
}

export function setActiveVaultUser(username: string | null): void {
  try {
    if (username) localStorage.setItem(ACTIVE_USER_KEY, username);
    else localStorage.removeItem(ACTIVE_USER_KEY);
  } catch {
    // ignorado
  }
}

export function getVaultToken(username: string): string | null {
  try {
    return localStorage.getItem(tokenKey(username));
  } catch {
    return null;
  }
}

export function storeVaultToken(username: string, token: string): void {
  try {
    localStorage.setItem(tokenKey(username), token);
  } catch {
    // Sin almacenamiento local no hay sesión persistente: modo degradado.
  }
}

export function clearVaultToken(username: string): void {
  try {
    localStorage.removeItem(tokenKey(username));
  } catch {
    // ignorado
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * URL de la forma compatible con Vercel: `/api/vault?op=<operación>[&id=…]`. Un solo segmento
 * de ruta: en Vercel las rutas anidadas devolvían 404 de la plataforma antes de alcanzar
 * Express, mientras que esta forma llega siempre al router (que la traduce a su ruta interna).
 */
export function vaultOperationUrl(op: string, id?: string): string {
  const params = new URLSearchParams();
  params.set("op", op);
  if (id !== undefined && id !== "") params.set("id", id);
  return `/api/vault?${params.toString()}`;
}

async function vaultFetch(
  op: string,
  opts: { id?: string; method?: string; body?: unknown; token?: string; tolerate401?: boolean } = {}
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(vaultOperationUrl(op, opts.id), {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new VaultUnavailableError(
      "No se ha podido conectar con el almacenamiento remoto de la aplicación. Los cambios siguen en este dispositivo y se sincronizarán cuando vuelva a estar disponible."
    );
  }
  // El 401 de auth.login es un resultado esperado (usuario aún no registrado):
  // solo se traduce a VaultAuthError en operaciones con sesión.
  if (res.status === 401 && !opts.tolerate401) {
    throw new VaultAuthError("La sesión del almacenamiento remoto no es válida o ha caducado. Inicia sesión de nuevo.");
  }
  return res;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error || `Error ${res.status} del almacenamiento remoto.`;
  } catch {
    return `Error ${res.status} del almacenamiento remoto.`;
  }
}

/** ¿El vault está desplegado y responde? (no exige sesión) */
export async function vaultHealth(): Promise<boolean> {
  try {
    const res = await fetch(vaultOperationUrl("health"), { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Capacidades del almacenamiento remoto, tal y como las declara el backend. */
export interface VaultCapabilities {
  /** El destino es remoto y sobrevive a nuevos despliegues/ejecuciones. */
  durable: boolean;
  /** Motor real: `vercel-blob` en producción. */
  driver: string;
  /** El almacén remoto responde y es escribible. */
  storageOk: boolean;
  detail?: string;
  maxFileBytes: number;
  /** La subida directa (sin pasar por la función serverless) está disponible. */
  directUpload: boolean;
}

export class VaultNotConfiguredError extends VaultError {}

let capabilitiesCache: { at: number; value: VaultCapabilities } | null = null;

/**
 * Consulta las capacidades del almacén remoto (con caché corta para no repetir la sonda
 * en cada subida). Si el backend no responde, el resultado es "no disponible": la
 * aplicación nunca lo interpreta como almacenamiento local válido.
 */
export async function vaultCapabilities(force = false): Promise<VaultCapabilities> {
  if (!force && capabilitiesCache && Date.now() - capabilitiesCache.at < 20_000) return capabilitiesCache.value;
  let res: Response;
  try {
    res = await fetch(vaultOperationUrl("health"), { method: "GET" });
  } catch {
    throw new VaultUnavailableError(
      "No se ha podido contactar con el almacenamiento remoto de la aplicación. El archivo no se ha guardado."
    );
  }
  if (!res.ok) {
    throw new VaultUnavailableError(
      `El almacenamiento remoto ha respondido con un error (${res.status}). El archivo no se ha guardado.`
    );
  }
  const body = (await res.json()) as Partial<VaultCapabilities> & { ok?: boolean };
  const value: VaultCapabilities = {
    durable: Boolean(body.durable),
    driver: String(body.driver ?? "desconocido"),
    storageOk: Boolean(body.storageOk),
    detail: body.detail,
    maxFileBytes: Number(body.maxFileBytes) || 10 * 1024 * 1024,
    directUpload: Boolean(body.directUpload),
  };
  capabilitiesCache = { at: Date.now(), value };
  return value;
}

/** Descarta la caché de capacidades (tras un fallo real de escritura conviene volver a sondear). */
export function invalidateVaultCapabilities(): void {
  capabilitiesCache = null;
}

/** SOLO PRUEBAS: deja la sonda de capacidades sin caché. */
export function __resetVaultCapabilitiesCacheForTests(): void {
  capabilitiesCache = null;
}

/** Mensaje único y explícito cuando no existe almacenamiento remoto utilizable. */
export function vaultUnavailableMessage(caps: VaultCapabilities | null): string {
  const suffix =
    "No se ha guardado nada y no se ha usado el almacenamiento del navegador como sustituto: " +
    "hace falta un almacenamiento remoto persistente configurado en el despliegue.";
  if (!caps) return `El almacenamiento remoto de la aplicación no responde. ${suffix}`;
  if (!caps.storageOk) {
    return `El almacenamiento remoto no está conectado en este despliegue (${caps.detail || caps.driver}). ${suffix}`;
  }
  return `El almacenamiento remoto no está disponible. ${suffix}`;
}

/**
 * Garantiza una sesión del vault para el usuario de la app.
 * Primer uso: registra la cuenta en el vault con las MISMAS credenciales de la aplicación
 * (el servidor guarda solo hash scrypt). Devuelve el token.
 */
export async function vaultEnsureSession(username: string, password: string): Promise<string> {
  const existing = getVaultToken(username);
  if (existing) {
    try {
      const res = await vaultFetch("session", { token: existing });
      if (res.ok) return existing;
    } catch (err) {
      if (err instanceof VaultUnavailableError) throw err;
      // Token caducado/inválido: continuar a login.
    }
  }

  const login = await vaultFetch("auth.login", { method: "POST", body: { username, password }, tolerate401: true });
  if (login.ok) {
    const body = await login.json();
    storeVaultToken(username, body.token);
    setActiveVaultUser(username);
    return body.token;
  }
  if (login.status !== 401) throw new VaultError(await parseError(login));

  // Aún no existe en el vault: alta con las credenciales de la app y login inmediato.
  const reg = await vaultFetch("auth.register", { method: "POST", body: { username, password } });
  if (!reg.ok && reg.status !== 409) throw new VaultError(await parseError(reg));
  const retry = await vaultFetch("auth.login", { method: "POST", body: { username, password }, tolerate401: true });
  if (!retry.ok) throw new VaultAuthError(await parseError(retry));
  const body = await retry.json();
  storeVaultToken(username, body.token);
  setActiveVaultUser(username);
  return body.token;
}

/** Sube bytes al vault. Devuelve la referencia persistente (fileId + metadatos). */
export async function vaultUploadFile(opts: {
  username: string;
  bytes: Uint8Array;
  name: string;
  contentType: string;
  movementId?: string;
  propertyId?: string;
  fileId?: string;
}): Promise<VaultFileMeta> {
  const token = getVaultToken(opts.username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await vaultFetch("files.upload", {
    method: "POST",
    token,
    body: {
      name: opts.name,
      contentType: opts.contentType,
      bytesBase64: bytesToBase64(opts.bytes),
      movementId: opts.movementId,
      propertyId: opts.propertyId,
      id: opts.fileId,
    },
  });
  if (!res.ok) throw new VaultError(await parseError(res));
  const body = await res.json();
  return body.file as VaultFileMeta;
}

/**
 * Sube un archivo por la vía directa: el servidor firma una subida de UN solo objeto
 * (operación, tipo, tamaño y caducidad acotados) y el navegador escribe el contenido
 * directamente en el almacén privado, sin atravesar el límite de cuerpo de la función
 * serverless y sin recibir ninguna credencial del almacén. Después, el servidor descarga
 * el objeto, recalcula su SHA-256 y solo entonces consolida los metadatos.
 */
export async function vaultUploadFileDirect(opts: {
  username: string;
  file: Blob & { name?: string };
  name: string;
  contentType: string;
  movementId?: string;
  propertyId?: string;
}): Promise<VaultFileMeta> {
  const token = getVaultToken(opts.username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");

  const bytes = new Uint8Array(await opts.file.arrayBuffer());
  const presign = await vaultFetch("files.presign", {
    method: "POST",
    token,
    body: {
      name: opts.name,
      contentType: opts.contentType,
      size: bytes.length,
      movementId: opts.movementId,
      propertyId: opts.propertyId,
    },
  });
  if (!presign.ok) throw new VaultError(await parseError(presign));
  const reservation = (await presign.json()) as {
    fileId: string;
    upload: { url: string; headers: Record<string, string>; validUntil: number };
  };

  // Escritura directa en el almacén remoto (URL firmada y acotada por el servidor).
  let putRes: Response;
  try {
    putRes = await fetch(reservation.upload.url, {
      method: "PUT",
      headers: { ...reservation.upload.headers, "content-type": opts.contentType },
      body: opts.file,
    });
  } catch {
    throw new VaultUnavailableError(
      "La subida directa al almacenamiento remoto ha fallado por red. El archivo no se ha guardado."
    );
  }
  if (!putRes.ok) {
    throw new VaultError(
      `El almacenamiento remoto ha rechazado la subida directa (${putRes.status}). El archivo no se ha guardado.`
    );
  }

  const sha256 = await sha256Hex(bytes);
  const commit = await vaultFetch("files.commit", {
    id: reservation.fileId,
    method: "POST",
    token,
    body: { size: bytes.length, sha256 },
  });
  if (!commit.ok) throw new VaultError(await parseError(commit));
  const body = await commit.json();
  return body.file as VaultFileMeta;
}

/** Umbral a partir del cual conviene la vía directa (el cuerpo JSON viaja en Base64). */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 2_500_000;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sube un archivo al almacén remoto eligiendo el transporte: directo (grandes, sin límite de
 * cuerpo) o en el cuerpo JSON (pequeños, con el hash calculado por el servidor). Si la vía
 * JSON rechaza el tamaño pero la directa está disponible, se reintenta por la directa.
 */
export async function vaultUploadFileAuto(opts: {
  username: string;
  file: Blob & { name?: string };
  name: string;
  contentType: string;
  movementId?: string;
  propertyId?: string;
  capabilities?: VaultCapabilities;
}): Promise<VaultFileMeta> {
  const caps = opts.capabilities ?? (await vaultCapabilities());
  const size = opts.file.size;
  const useDirect = caps.directUpload && size > DIRECT_UPLOAD_THRESHOLD_BYTES;

  if (useDirect) {
    return vaultUploadFileDirect({
      username: opts.username,
      file: opts.file,
      name: opts.name,
      contentType: opts.contentType,
      movementId: opts.movementId,
      propertyId: opts.propertyId,
    });
  }

  try {
    const bytes = new Uint8Array(await opts.file.arrayBuffer());
    return await vaultUploadFile({
      username: opts.username,
      bytes,
      name: opts.name,
      contentType: opts.contentType,
      movementId: opts.movementId,
      propertyId: opts.propertyId,
    });
  } catch (err) {
    // Cuerpo demasiado grande para la función: se reintenta por la vía directa si está disponible.
    if (caps.directUpload && err instanceof VaultError && /tamaño|supera|413/i.test(err.message)) {
      return vaultUploadFileDirect({
        username: opts.username,
        file: opts.file,
        name: opts.name,
        contentType: opts.contentType,
        movementId: opts.movementId,
        propertyId: opts.propertyId,
      });
    }
    throw err;
  }
}

/** Descarga un archivo del vault por su referencia. */export async function vaultDownloadFile(username: string, fileId: string): Promise<Blob> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await fetch(vaultOperationUrl("files.get", fileId), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new VaultAuthError("La sesión del almacenamiento remoto ha caducado. Inicia sesión de nuevo.");
  if (!res.ok) throw new VaultError(await parseError(res));
  return res.blob();
}

export async function vaultListFiles(username: string): Promise<VaultFileMeta[]> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await vaultFetch("files.list", { token });
  if (!res.ok) throw new VaultError(await parseError(res));
  const body = await res.json();
  return (body.files ?? []) as VaultFileMeta[];
}

/** Sincroniza el conjunto completo de movimientos del usuario (idempotente). */
export async function vaultPutMovements(username: string, movements: Record<string, any>[]): Promise<number> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await vaultFetch("movimientos", { method: "PUT", token, body: { movements } });
  if (!res.ok) throw new VaultError(await parseError(res));
  const body = await res.json();
  return body.saved as number;
}

export async function vaultGetMovements(username: string): Promise<Record<string, any>[]> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await vaultFetch("movimientos", { token });
  if (!res.ok) throw new VaultError(await parseError(res));
  const body = await res.json();
  return (body.movements ?? []) as Record<string, any>[];
}

/** Copia de seguridad de la cartera en el vault. */
export async function vaultCreateBackup(username: string, portfolio: unknown): Promise<{ id: string }> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await vaultFetch("backups.create", { method: "POST", token, body: { portfolio } });
  if (!res.ok) throw new VaultError(await parseError(res));
  const body = await res.json();
  return { id: body.id };
}

// ---------- Cola de sincronización local → remoto ----------

/** Extensión por tipo MIME para nombrar los comprobantes externalizados. */
function extensionForContentType(contentType: string): string {
  const t = (contentType || "").toLowerCase();
  if (t === "application/pdf") return "pdf";
  if (t === "application/msword") return "doc";
  if (t === "image/png") return "png";
  if (t === "image/jpeg") return "jpg";
  if (t === "image/webp") return "webp";
  if (t.startsWith("image/")) return "img";
  return "bin";
}

/**
 * Externaliza al vault los comprobantes que quedaron en la COLA LOCAL (receiptUrl Base64)
 * cuando el almacenamiento remoto no estaba disponible. Es idempotente: solo toca los
 * registros sin referencia remota, y sustituye receiptUrl por receiptVaultId una vez
 * confirmada la subida. Devuelve cuántos comprobantes se externalizaron.
 */
export async function flushQueuedReceiptsToVault(
  username: string,
  expenses: Array<{ id?: string; receiptUrl?: string; receiptPath?: string; receiptVaultId?: string }>
): Promise<number> {
  const token = getVaultToken(username);
  if (!token) return 0;
  let flushed = 0;
  for (const exp of expenses) {
    // Ya tiene destino remoto (vault o Storage): no se toca.
    if (exp.receiptPath || exp.receiptVaultId) continue;
    if (typeof exp.receiptUrl !== "string" || !exp.receiptUrl.startsWith("data:")) continue;
    const parsed = parseDataUrl(exp.receiptUrl);
    if (!parsed) continue;
    const meta = await vaultUploadFile({
      username,
      bytes: parsed.bytes,
      name: `comprobante_${exp.id || "local"}.${extensionForContentType(parsed.mimeType)}`,
      contentType: parsed.mimeType,
      movementId: exp.id,
    });
    exp.receiptVaultId = meta.id;
    exp.receiptUrl = undefined;
    flushed++;
  }
  return flushed;
}
