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
import { AttachmentError, attachmentPhase, ATTACHMENT_TIMEOUTS } from "./attachmentErrors";
import { sha256Hex, utf8Bytes } from "./stableHash";

export class VaultError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, detail: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message, { cause: detail.cause });
    this.name = "VaultError";
    this.code = detail.code ?? "vault/error";
    this.status = detail.status;
  }
}
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
  opts: { id?: string; method?: string; body?: unknown; token?: string; tolerate401?: boolean; signal?: AbortSignal; headers?: Record<string, string> } = {}
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(vaultOperationUrl(op, opts.id), {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    opts.signal?.throwIfAborted();
    throw new VaultUnavailableError(
      "No se ha podido conectar con el almacenamiento remoto de la aplicación. No se ha confirmado la operación.",
      { code: "vault/network-unavailable", cause: err }
    );
  }
  // El 401 de auth.login es un resultado esperado (usuario aún no registrado):
  // solo se traduce a VaultAuthError en operaciones con sesión.
  if (res.status === 401 && !opts.tolerate401) {
    throw new VaultAuthError("La sesión del almacenamiento remoto no es válida o ha caducado. Inicia sesión de nuevo.",
      { code: "vault/unauthorized", status: res.status });
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
  const value = await attachmentPhase("preflight", "vault", ATTACHMENT_TIMEOUTS.preflight, async (signal) => {
    const res = await vaultFetch("health", { signal });
    if (!res.ok) throw new VaultUnavailableError(`El almacenamiento remoto ha respondido con un error (${res.status}).`,
      { code: `vault/http-${res.status}`, status: res.status });
    const body = (await res.json()) as Partial<VaultCapabilities>;
    signal.throwIfAborted();
    return {
      durable: body.durable === true,
      driver: String(body.driver ?? "desconocido"),
      storageOk: body.storageOk === true,
      detail: body.detail,
      maxFileBytes: Number(body.maxFileBytes) || 10 * 1024 * 1024,
      directUpload: body.directUpload === true,
    } satisfies VaultCapabilities;
  });
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
  if (!caps.storageOk || !caps.durable) {
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

/** Revoca SOLO esta sesión en servidor antes de retirar la credencial del navegador. */
export async function vaultLogoutSession(username: string): Promise<void> {
  const token = getVaultToken(username);
  if (!token) { setActiveVaultUser(null); return; }
  await attachmentPhase("session", "vault", ATTACHMENT_TIMEOUTS.persistence, async (signal) => {
    try {
      const response = await vaultFetch("auth.logout", { method: "POST", token, signal, tolerate401: true });
      if (response.status !== 204 && response.status !== 401) throw new VaultError(await parseError(response), { code: `vault/http-${response.status}`, status: response.status });
    } catch (err) { signal.throwIfAborted(); throw err; }
  });
  clearVaultToken(username);
  if (getActiveVaultUser() === username) setActiveVaultUser(null);
}

interface VaultUploadOptions {
  username: string;
  name: string;
  contentType: string;
  movementId?: string;
  propertyId?: string;
  fileId?: string;
  signal?: AbortSignal;
}

async function uploadIdentity(opts: VaultUploadOptions, bytes: Uint8Array): Promise<{ fileId: string; sha256: string }> {
  const sha256 = await sha256Hex(bytes);
  const fileId = opts.fileId ?? `file_${await sha256Hex(utf8Bytes(JSON.stringify([
    opts.name, opts.contentType, opts.movementId ?? "", opts.propertyId ?? "", sha256,
  ])))}`;
  return { fileId, sha256 };
}

function assertVaultFile(meta: VaultFileMeta | undefined, expected: {
  fileId: string; sha256?: string; size?: number; contentType?: string; movementId?: string; propertyId?: string;
}): asserts meta is VaultFileMeta {
  if (!meta || meta.id !== expected.fileId || !/^[a-f0-9]{64}$/.test(meta.sha256) ||
      (expected.sha256 !== undefined && meta.sha256 !== expected.sha256) ||
      (expected.size !== undefined && meta.size !== expected.size) ||
      (expected.contentType !== undefined && meta.contentType !== expected.contentType) ||
      (expected.movementId !== undefined && meta.movementId !== expected.movementId) ||
      (expected.propertyId !== undefined && meta.propertyId !== expected.propertyId)) {
    throw new AttachmentError("La referencia, asociación o SHA-256 del archivo remoto no coincide. No se confirma el guardado.",
      { phase: "verification", backend: "vault", code: "attachment/integrity" });
  }
}

async function checkedFileResponse(res: Response): Promise<VaultFileMeta> {
  if (!res.ok) throw new VaultError(await parseError(res), { code: `vault/http-${res.status}`, status: res.status });
  const body = await res.json();
  if (body.ok !== true || body.storageOk !== true || !body.file) {
    throw new VaultError("El almacén no ha confirmado el archivo.", { code: "vault/unconfirmed" });
  }
  return body.file as VaultFileMeta;
}

/** Consulta autenticada por ID. El servidor lee el objeto y recalcula SHA-256, sin URLs temporales. */
export async function vaultVerifyFile(username: string, fileId: string, parentSignal?: AbortSignal): Promise<VaultFileMeta> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.", { code: "vault/unauthorized" });
  return attachmentPhase("verification", "vault", ATTACHMENT_TIMEOUTS.verification, async (signal) => {
    const res = await vaultFetch("files.verify", { id: fileId, token, signal });
    const meta = await checkedFileResponse(res);
    signal.throwIfAborted();
    assertVaultFile(meta, { fileId });
    return meta;
  }, parentSignal);
}

/** Bytes enviados con ID estable; respuesta y objeto persistido contrastados con el original. */
export async function vaultUploadFile(opts: VaultUploadOptions & { bytes: Uint8Array }): Promise<VaultFileMeta> {
  const token = getVaultToken(opts.username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.", { code: "vault/unauthorized" });
  const identity = await uploadIdentity(opts, opts.bytes);
  const expected = { ...identity, size: opts.bytes.length, contentType: opts.contentType, movementId: opts.movementId, propertyId: opts.propertyId };
  const returned = await attachmentPhase("upload", "vault", ATTACHMENT_TIMEOUTS.upload, async (signal) => {
    const res = await vaultFetch("files.upload", {
      method: "POST", token, signal,
      body: {
        id: identity.fileId, name: opts.name, contentType: opts.contentType,
        bytesBase64: bytesToBase64(opts.bytes), movementId: opts.movementId, propertyId: opts.propertyId,
      },
    });
    const meta = await checkedFileResponse(res);
    signal.throwIfAborted();
    assertVaultFile(meta, expected);
    return meta;
  }, opts.signal);
  const persisted = await vaultVerifyFile(opts.username, returned.id, opts.signal);
  assertVaultFile(persisted, expected);
  return persisted;
}

/** Firma acotada → PUT cancelable → commit de hash en servidor → verificación por ID. */
export async function vaultUploadFileDirect(opts: VaultUploadOptions & { file: Blob & { name?: string } }): Promise<VaultFileMeta> {
  const token = getVaultToken(opts.username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.", { code: "vault/unauthorized" });
  const bytes = new Uint8Array(await opts.file.arrayBuffer());
  const identity = await uploadIdentity(opts, bytes);
  const expected = { ...identity, size: bytes.length, contentType: opts.contentType, movementId: opts.movementId, propertyId: opts.propertyId };
  const reservation = await attachmentPhase("preflight", "vault", ATTACHMENT_TIMEOUTS.preflight, async (signal) => {
    const res = await vaultFetch("files.presign", {
      method: "POST", token, signal,
      body: { id: identity.fileId, sha256: identity.sha256, name: opts.name, contentType: opts.contentType,
        size: bytes.length, movementId: opts.movementId, propertyId: opts.propertyId },
    });
    if (!res.ok) throw new VaultError(await parseError(res), { code: `vault/http-${res.status}`, status: res.status });
    const body = await res.json();
    signal.throwIfAborted();
    if (body.ok !== true || body.fileId !== identity.fileId) {
      throw new VaultError("La reserva no corresponde al archivo solicitado.", { code: "vault/invalid-reservation" });
    }
    return body as { fileId: string; alreadyCommitted?: boolean; readyToCommit?: boolean;
      upload?: { url: string; headers: Record<string, string>; validUntil: number } };
  }, opts.signal);

  if (!reservation.alreadyCommitted && !reservation.readyToCommit) {
    const signed = reservation.upload;
    if (!signed || !/^https:\/\//.test(signed.url) || signed.validUntil <= Date.now()) {
      throw new VaultError("La firma de subida no es válida o ha caducado.", { code: "vault/invalid-reservation" });
    }
    await attachmentPhase("upload", "vault", ATTACHMENT_TIMEOUTS.upload, async (signal) => {
      const res = await fetch(signed.url, {
        method: "PUT", headers: { ...signed.headers, "content-type": opts.contentType }, body: opts.file, signal,
      }).catch((cause) => {
        signal.throwIfAborted();
        throw new VaultUnavailableError("La subida directa ha fallado por red.", { code: "vault/network-unavailable", cause });
      });
      signal.throwIfAborted();
      if (!res.ok) throw new VaultError(`El almacén ha rechazado la subida directa (${res.status}).`,
        { code: `vault/http-${res.status}`, status: res.status });
    }, opts.signal);
  }
  const committed = await attachmentPhase("verification", "vault", ATTACHMENT_TIMEOUTS.verification, async (signal) => {
    const res = await vaultFetch("files.commit", { id: identity.fileId, method: "POST", token, signal,
      body: { size: bytes.length, sha256: identity.sha256 } });
    const meta = await checkedFileResponse(res);
    signal.throwIfAborted();
    assertVaultFile(meta, expected);
    return meta;
  }, opts.signal);
  const persisted = await vaultVerifyFile(opts.username, committed.id, opts.signal);
  assertVaultFile(persisted, expected);
  return persisted;
}

export const DIRECT_UPLOAD_THRESHOLD_BYTES = 2_500_000;

/** Ningún transporte declara éxito si el destino no es remoto/persistente. */
export async function vaultUploadFileAuto(opts: VaultUploadOptions & {
  file: Blob & { name?: string }; capabilities?: VaultCapabilities;
}): Promise<VaultFileMeta> {
  const caps = opts.capabilities ?? await vaultCapabilities();
  if (!caps.storageOk || !caps.durable) throw new VaultNotConfiguredError(vaultUnavailableMessage(caps), { code: "vault/not-durable" });
  if (opts.file.size > caps.maxFileBytes) throw new VaultError("El archivo supera el límite del almacén.", { code: "vault/http-413", status: 413 });
  if (caps.directUpload && opts.file.size > DIRECT_UPLOAD_THRESHOLD_BYTES) return vaultUploadFileDirect(opts);
  try {
    return await vaultUploadFile({ ...opts, bytes: new Uint8Array(await opts.file.arrayBuffer()) });
  } catch (err) {
    // Solo un 413 explícito permite cambiar transporte, con la MISMA identidad y proveedor.
    if (caps.directUpload && (err as { code?: string })?.code === "vault/http-413") return vaultUploadFileDirect(opts);
    throw err;
  }
}

/** Descarga autenticada, cancelable y con integridad comprobada también en el cliente. */
export async function vaultDownloadFile(username: string, fileId: string): Promise<Blob> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.", { code: "vault/unauthorized" });
  return attachmentPhase("download", "vault", ATTACHMENT_TIMEOUTS.download, async (signal) => {
    const res = await vaultFetch("files.get", { id: fileId, token, signal });
    if (!res.ok) throw new VaultError(await parseError(res), { code: `vault/http-${res.status}`, status: res.status });
    const blob = await res.blob();
    signal.throwIfAborted();
    const expectedSha = res.headers.get("x-vault-sha256");
    if (!expectedSha || expectedSha !== await sha256Hex(new Uint8Array(await blob.arrayBuffer()))) {
      throw new AttachmentError("El documento descargado no supera la verificación SHA-256.",
        { phase: "download", backend: "vault", code: "attachment/integrity" });
    }
    signal.throwIfAborted();
    return blob;
  });
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
export async function vaultPutMovements(username: string, movements: Record<string, any>[], signal?: AbortSignal): Promise<number> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await vaultFetch("movimientos", { method: "PUT", token, body: { movements }, signal });
  if (!res.ok) throw new VaultError(await parseError(res));
  const body = await res.json();
  return body.saved as number;
}

export async function vaultGetMovements(username: string, signal?: AbortSignal): Promise<Record<string, any>[]> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const res = await vaultFetch("movimientos", { token, signal });
  if (!res.ok) throw new VaultError(await parseError(res));
  const body = await res.json();
  return (body.movements ?? []) as Record<string, any>[];
}

/** Commit de una sola operación con adjunto: el backend verifica objeto, asociación y lectura posterior.
 * No se consigue un ETag nuevo para legitimar un snapshot viejo. Sin una versión capturada
 * con el formulario, el servidor conserva las referencias anteriores y rechaza sustituciones.
 */
export async function vaultSaveAttachmentMovement(username: string, movement: Record<string, any>, signal: AbortSignal): Promise<Record<string, any>> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto.", { code: "vault/unauthorized" });
  const res = await vaultFetch("movimientos.save", { id: movement.id, method: "PUT", token, body: { movement }, signal });
  if (!res.ok) throw new VaultError(await parseError(res), { code: `vault/http-${res.status}`, status: res.status });
  const body = await res.json();
  signal.throwIfAborted();
  if (body.ok !== true || body.storageOk !== true || !body.movement) throw new VaultError("La operación no está confirmada.", { code: "vault/unconfirmed" });
  return body.movement;
}

/** Solo modifica la entidad del inmueble al que se vincula el adjunto; no sincroniza toda la cartera. */
export async function vaultSaveAttachmentProperty(username: string, property: Record<string, any>, attachmentIds: string[], signal: AbortSignal): Promise<Record<string, any>> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto.", { code: "vault/unauthorized" });
  const res = await vaultFetch("entities.put", { method: "POST", token, signal,
    body: { type: "properties", id: property.id, entity: property, attachmentIds } });
  if (!res.ok) throw new VaultError(await parseError(res), { code: `vault/http-${res.status}`, status: res.status });
  const body = await res.json();
  signal.throwIfAborted();
  if (body.ok !== true || !body.entity?.data) throw new VaultError("El documento no está asociado al inmueble en el almacén.", { code: "vault/unconfirmed" });
  return body.entity.data;
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
  expenses: Array<{ id?: string; propertyId?: string; receiptUrl?: string; receiptPath?: string; receiptVaultId?: string }>,
  signal?: AbortSignal
): Promise<number> {
  const token = getVaultToken(username);
  if (!token) return 0;
  let flushed = 0;
  for (const exp of expenses) {
    signal?.throwIfAborted();
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
      movementId: exp.id, propertyId: exp.propertyId, signal,
    });
    signal?.throwIfAborted();
    exp.receiptVaultId = meta.id;
    exp.receiptUrl = undefined;
    flushed++;
  }
  return flushed;
}
