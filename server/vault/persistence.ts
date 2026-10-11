// Persistencia del vault. Una única interfaz (`VaultPersistence`) con tres implementaciones:
//
//  - `BlobVaultPersistence`: ALMACENAMIENTO REMOTO PERSISTENTE (Vercel Blob privado). Es el
//    destino de producción: los datos estructurados (cuentas, movimientos, metadatos,
//    copias y auditoría) y el contenido binario viven en el almacén remoto, no en el sistema
//    de ficheros efímero de la función serverless.
//  - `FsVaultPersistence`: SOLO desarrollo local y pruebas. Nunca se selecciona en Vercel.
//  - `UnconfiguredVaultPersistence`: sin destino remoto: las lecturas devuelven vacío y las
//    escrituras fallan con un error explícito (jamás se declara un guardado que no existe).
//
// Los objetos se guardan de forma atómica por entidad (`<entidad>/<id>.json`), de modo que
// reintentar una operación es idempotente por identificador y no hay índices compartidos que
// puedan perder escrituras concurrentes.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  BlobObjectInfo,
  BlobPort,
  PresignedPut,
  VaultAuditEvent,
  VaultEntityRecord,
  VaultEntityType,
  VaultFileMeta,
  VaultPersistence,
  VaultUserRecord,
} from "./persistenceTypes.js";
import { isVaultEntityType } from "./persistenceTypes.js";
import { VaultConflictError, assertReferencesRetained, assertFileMetadataTransition, propertyReferences, expenseReferences, type RemoteDocumentReference } from "./attachmentSafety.js";
import type { VaultWriteOptions, VaultSessionRevocation } from "./persistenceTypes.js";
import { VercelBlobPort, blobStoreConfigured } from "./blobPort.js";

export const VAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const VAULT_MAX_BACKUP_BYTES = 50 * 1024 * 1024;
/** Límite de una entidad estructurada serializada (JSON). */
export const VAULT_MAX_ENTITY_BYTES = 1024 * 1024;

/** Error de destino no disponible: la operación NO se ha completado. */
export class VaultStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultStorageUnavailableError";
  }
}

/** Identificadores seguros (sin separadores de ruta ni traversal). */
export function safeSegment(id: unknown): string | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return id;
}

export function auditId(): string {
  return `aud_${new Date().toISOString().replace(/[^0-9]/g, "")}_${randomBytes(3).toString("hex")}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const attachmentPin = (source: RemoteDocumentReference) => sha256Hex(new TextEncoder().encode(JSON.stringify([
  source.vaultId ?? null, source.storagePath ?? null, source.propertyId ?? null, source.movementId ?? null,
])));

// ---------------------------------------------------------------------------
// Persistencia sobre almacén remoto de objetos (Vercel Blob)
// ---------------------------------------------------------------------------

const BLOB_ROOT = "vault";

export class BlobVaultPersistence implements VaultPersistence {
  readonly driver = "vercel-blob" as const;
  readonly durable = true;
  readonly detail = "Vercel Blob (almacén privado)";

  constructor(private readonly port: BlobPort) {}

  private user(user: string): string {
    const u = safeSegment(user);
    if (!u) throw new Error("Usuario no válido");
    return path.posix.join(BLOB_ROOT, "users", u);
  }
  private secretPath(): string {
    return path.posix.join(BLOB_ROOT, "secret.key");
  }
  private accountPath(user: string): string {
    return path.posix.join(this.user(user), "account.json");
  }
  private movementPath(user: string, id: string): string {
    return path.posix.join(this.user(user), "movements", `${id}.json`);
  }
  private fileMetaPath(user: string, id: string): string {
    return path.posix.join(this.user(user), "files", `${id}.json`);
  }
  private backupPath(user: string, id: string): string {
    return path.posix.join(this.user(user), "backups", `${id}.json`);
  }
  private auditPath(user: string, id: string): string {
    return path.posix.join(this.user(user), "audit", `${id}.json`);
  }
  private entityPath(user: string, type: string, id: string): string {
    return path.posix.join(this.user(user), "entities", type, `${id}.json`);
  }
  /** Ruta pública del contenido binario (la usa el servidor para subidas directas). */
  contentPath(user: string, id: string): string {
    return path.posix.join(this.user(user), "contents", id);
  }

  /**
   * Traduce cualquier fallo del almacén a `VaultStorageUnavailableError`: la operación NO se ha
   * confirmado y el error que recibe la aplicación es explícito (nunca un 500 genérico ni un
   * éxito falso).
   */
  private async storage<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VaultStorageUnavailableError || err instanceof VaultConflictError) throw err;
      if (["BlobPreconditionFailedError", "BlobAlreadyExistsError"].includes((err as any)?.name)) throw new VaultConflictError();
      throw new VaultStorageUnavailableError(
        `El almacenamiento remoto no ha confirmado la operación (${op}): ${String((err as any)?.message || err)}. No se ha guardado nada.`
      );
    }
  }

  private async readJson<T>(pathname: string): Promise<T | null> {
    const got = await this.storage("lectura", () => this.port.getBytes(pathname));
    if (!got) return null;
    try {
      return JSON.parse(new TextDecoder().decode(got.bytes)) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(pathname: string, value: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    await this.storage("escritura", () => this.port.putBytes(pathname, bytes, "application/json"));
  }

  private async versionedJson<T>(pathname: string): Promise<{ data: T; version: string } | null> {
    const got = await this.storage("lectura", () => this.port.getBytes(pathname));
    if (!got) return null;
    if (!got.etag) throw new VaultStorageUnavailableError("El almacén no proporciona una versión para una escritura segura.");
    try { return { data: JSON.parse(new TextDecoder().decode(got.bytes)) as T, version: got.etag }; }
    catch { throw new VaultStorageUnavailableError("El JSON persistido no es íntegro; no se sobrescribe."); }
  }

  private async conditionalJson(pathname: string, value: unknown, options: VaultWriteOptions & { createOnly?: boolean } = {}, guard?: (previous: any | null) => void): Promise<void> {
    const previous = await this.versionedJson<any>(pathname);
    if (options.createOnly && previous) throw new VaultConflictError();
    if (options.expectedVersion && previous?.version !== options.expectedVersion) throw new VaultConflictError();
    guard?.(previous?.data ?? null);
    await options.validate?.(previous?.data ?? null);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    await this.storage("escritura condicional", () => this.port.putBytes(pathname, bytes, "application/json",
      previous ? { ifMatch: previous.version, allowOverwrite: true } : { allowOverwrite: false }));
  }

  private sessionPath(username: string, tokenHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error("Huella de sesión no válida");
    return path.posix.join(this.user(username), "session-revocations", `${tokenHash}.json`);
  }
  async isSessionRevoked(username: string, tokenHash: string): Promise<boolean> {
    const record = await this.versionedJson<VaultSessionRevocation>(this.sessionPath(username, tokenHash));
    if (!record) return false; // solo ausencia acreditada significa no revocada
    const got = record.data;
    if (!got || got.username !== username || got.tokenHash !== tokenHash || !Number.isFinite(got.expiresAt))
      throw new VaultStorageUnavailableError("No se puede acreditar el estado de revocación de esta sesión.");
    return true;
  }
  async revokeSession(record: VaultSessionRevocation): Promise<void> {
    const pathname = this.sessionPath(record.username, record.tokenHash);
    try { await this.conditionalJson(pathname, record, { createOnly: true }); }
    catch (err) { if (!(err instanceof VaultConflictError) || !await this.isSessionRevoked(record.username, record.tokenHash)) throw err; }
    if (!await this.isSessionRevoked(record.username, record.tokenHash)) throw new VaultStorageUnavailableError("El cierre de sesión no está confirmado.");
  }

  /** Lista por prefijo y devuelve los pathnames ordenados (paginado en el puerto). */
  private async listPathnames(prefix: string): Promise<BlobObjectInfo[]> {
    return this.storage("listado", () => this.port.list(prefix));
  }

  async ensureSecret(): Promise<string> {
    const got = await this.storage("lectura", () => this.port.getBytes(this.secretPath()));
    if (got) {
      const value = new TextDecoder().decode(got.bytes).trim();
      if (!value) throw new VaultStorageUnavailableError("La clave persistida no es válida; no se rota automáticamente.");
      return value;
    }
    const secret = randomBytes(32).toString("hex");
    try { await this.storage("creación exclusiva", () => this.port.putBytes(this.secretPath(), new TextEncoder().encode(secret), "text/plain", { allowOverwrite: false })); }
    catch (err) {
      if (!(err instanceof VaultConflictError)) throw err;
      const existing = await this.storage("lectura", () => this.port.getBytes(this.secretPath()));
      if (!existing) throw err;
      const value = new TextDecoder().decode(existing.bytes).trim();
      if (!value) throw err;
      return value;
    }
    return secret;
  }

  async getUser(username: string): Promise<VaultUserRecord | null> {
    return this.readJson<VaultUserRecord>(this.accountPath(username));
  }

  async createUser(username: string, record: VaultUserRecord): Promise<boolean> {
    // El pathname del objeto deriva del usuario: el registro es atómico (crear o fallar).
    const existing = await this.getUser(username);
    if (existing) return false;
    try { await this.conditionalJson(this.accountPath(username), record, { createOnly: true }); }
    catch (err) { if (err instanceof VaultConflictError) return false; throw err; }
    const now = await this.getUser(username);
    if (!now) throw new VaultStorageUnavailableError("No se ha podido crear la cuenta en el almacenamiento remoto.");
    if (now.salt !== record.salt) return false; // otra alta simultánea ganó
    return true;
  }

  async getMovements(username: string): Promise<Record<string, any>[]> {
    const infos = await this.listPathnames(`${this.user(username)}/movements/`);
    const out: Record<string, any>[] = [];
    for (const info of infos) {
      const json = await this.readJson<Record<string, any>>(info.pathname);
      if (json) out.push(json);
    }
    return out;
  }

  /** Protección monótona SIN leases: un fallo conserva la reserva, y el retry la reutiliza.
   * El pin cambia el ETag DEL PADRE antes del commit hijo: un DELETE ya prevalidado
   * falla su CAS. No se muta data ni se hace un barrido/migración de datos existentes.
   */
  private async protectMovementReferences(username: string, movement: any): Promise<void> {
    const refs = expenseReferences(movement); if (!refs.length) return;
    const id = safeSegment(movement.propertyId); if (!id) throw new VaultConflictError();
    const pathname = this.entityPath(username, "properties", id);
    const before = await this.versionedJson<VaultEntityRecord>(pathname);
    if (!before || (before.data.data as any)?.id !== id) throw new VaultConflictError("El padre ya no existe; no se confirma la operación.");
    const pins = [...new Set([...(before.data.attachmentPins ?? []), ...refs.map(attachmentPin)])].sort();
    if (JSON.stringify(pins) !== JSON.stringify(before.data.attachmentPins ?? [])) {
      const record = { ...before.data, attachmentPins: pins };
      if (JSON.stringify(record).length > VAULT_MAX_ENTITY_BYTES) throw new VaultStorageUnavailableError("El inmueble supera el límite al proteger el vínculo.");
      await this.conditionalJson(pathname, record, { expectedVersion: before.version });
    }
    await this.protectFileReferences(username, refs);
  }
  private async protectFileReferences(username: string, refs: RemoteDocumentReference[]): Promise<void> {
    for (const source of refs) {
      if (!source.vaultId) continue;
      const id = safeSegment(source.vaultId); if (!id) throw new VaultConflictError();
      const pathname = this.fileMetaPath(username, id);
      const before = await this.versionedJson<VaultFileMeta>(pathname);
      if (!before || before.data.deletedAt || !before.data.sha256) throw new VaultConflictError("El documento no está disponible; no se confirma el vínculo.");
      if (!before.data.attachmentProtected)
        await this.conditionalJson(pathname, { ...before.data, attachmentProtected: true }, { expectedVersion: before.version });
    }
  }

  async getMovement(username: string, id: string): Promise<{ data: Record<string, any>; version: string } | null> {
    const clean = safeSegment(id); return clean ? this.versionedJson(this.movementPath(username, clean)) : null;
  }
  async putMovements(username: string, movements: Record<string, any>[], options: VaultWriteOptions = {}): Promise<number> {
    const map = new Map<string, Record<string, any>>();
    for (const m of movements) {
      const id = safeSegment(m?.id);
      if (!id) continue;
      map.set(id, m);
    }
    for (const [id, m] of map) await this.conditionalJson(this.movementPath(username, id), m, {
      ...options, validate: async (previous) => {
        await options.validate?.(previous);
        await this.protectMovementReferences(username, m);
      },
    }, (previous) => assertReferencesRetained(previous, m, "movement", Boolean(options.expectedVersion)));
    return map.size;
  }

  async listEntities(username: string, type: VaultEntityType): Promise<VaultEntityRecord[]> {
    if (!isVaultEntityType(type)) return [];
    const infos = await this.listPathnames(`${this.user(username)}/entities/${type}/`);
    const out: VaultEntityRecord[] = [];
    for (const info of infos) {
      if (!info.pathname.endsWith(".json")) continue;
      const json = await this.readJson<VaultEntityRecord>(info.pathname);
      if (json && typeof json.id === "string") out.push(json);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async getEntity(username: string, type: VaultEntityType, id: string): Promise<VaultEntityRecord | null> {
    const clean = safeSegment(id); if (!clean || !isVaultEntityType(type)) return null;
    const got = await this.versionedJson<VaultEntityRecord>(this.entityPath(username, type, clean));
    return got ? { ...got.data, version: got.version } : null;
  }
  async putEntity(username: string, type: VaultEntityType, id: string, data: unknown, options: VaultWriteOptions = {}): Promise<VaultEntityRecord> {
    if (!isVaultEntityType(type)) throw new Error("Tipo de entidad no admitido por el almacenamiento remoto.");
    const clean = safeSegment(id);
    if (!clean) throw new Error("Identificador de entidad no válido.");
    const record: VaultEntityRecord = { id: clean, updatedAt: new Date().toISOString(), data };
    const json = JSON.stringify(record);
    if (json.length > VAULT_MAX_ENTITY_BYTES) {
      throw new Error("La entidad supera el límite de 1 MB del almacenamiento remoto; divide o limpia sus datos.");
    }
    await this.conditionalJson(this.entityPath(username, type, clean), record, {
      ...options, validate: async (previous) => {
        await options.validate?.(previous);
        if (type === "properties") await this.protectFileReferences(username, propertyReferences(data));
      },
    }, (previous) => {
      if (type === "properties") {
        assertReferencesRetained(previous?.data, data, "property", Boolean(options.expectedVersion));
        if (previous?.attachmentPins) record.attachmentPins = previous.attachmentPins;
      }
    });
    return record;
  }

  async deleteEntity(username: string, type: VaultEntityType, id: string, options: VaultWriteOptions = {}): Promise<boolean> {
    if (!isVaultEntityType(type)) return false;
    const clean = safeSegment(id);
    if (!clean) return false;
    const pathname = this.entityPath(username, type, clean);
    const existing = await this.versionedJson<VaultEntityRecord>(pathname);
    if (!existing) return false;
    if (options.expectedVersion && options.expectedVersion !== existing.version) throw new VaultConflictError();
    if (type === "properties" && (propertyReferences(existing.data.data).length || existing.data.attachmentPins?.length)) throw new VaultConflictError("El inmueble tiene documentos remotos; no se borra desde un snapshot.");
    await options.validate?.(existing.data);
    await this.storage("borrado condicional", () => this.port.del(pathname, { ifMatch: existing.version }));
    return true;
  }

  async listFiles(username: string): Promise<VaultFileMeta[]> {
    const infos = await this.listPathnames(`${this.user(username)}/files/`);
    const out: VaultFileMeta[] = [];
    for (const info of infos) {
      const json = await this.readJson<VaultFileMeta>(info.pathname);
      if (json && !json.deletedAt) out.push(json);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getFileMeta(username: string, fileId: string): Promise<VaultFileMeta | null> {
    const id = safeSegment(fileId);
    if (!id) return null;
    const meta = await this.readJson<VaultFileMeta>(this.fileMetaPath(username, id));
    return meta && !meta.deletedAt ? meta : null;
  }

  async putFileMeta(username: string, meta: VaultFileMeta): Promise<void> {
    const id = safeSegment(meta.id);
    if (!id) throw new Error("Identificador de archivo no válido.");
    await this.conditionalJson(this.fileMetaPath(username, id), meta, {}, (previous) => assertFileMetadataTransition(previous, meta));
  }

  async deleteFileMeta(username: string, fileId: string): Promise<boolean> {
    const id = safeSegment(fileId);
    if (!id) return false;
    const pathname = this.fileMetaPath(username, id);
    const existing = await this.versionedJson<VaultFileMeta>(pathname);
    if (!existing || existing.data.deletedAt) return false;
    if (existing.data.attachmentProtected) throw new VaultConflictError("El documento está asociado o reservado; no se retira.");
    // Tombstone CAS en el MISMO objeto que protege el enlace. No borrar bytes ni
    // liberar el ID: evita la carrera retirar/reintentar/consolidar entre instancias.
    await this.conditionalJson(pathname, { ...existing.data, deletedAt: new Date().toISOString() }, { expectedVersion: existing.version });
    return true;
  }

  async readFileBytes(username: string, fileId: string): Promise<Uint8Array | null> {
    const id = safeSegment(fileId);
    if (!id) return null;
    // El pathname del contenido es determinista: se puede leer antes de que existan metadatos
    // (necesario para verificar el objeto recién subido, antes de consolidarlo).
    const meta = await this.getFileMeta(username, id);
    const got = await this.storage("lectura", () => this.port.getBytes(meta?.blobPathname || this.contentPath(username, id)));
    return got ? got.bytes : null;
  }

  async writeFileBytes(username: string, fileId: string, bytes: Uint8Array, contentType: string, createOnly = false): Promise<void> {
    const id = safeSegment(fileId);
    if (!id) throw new Error("Identificador de archivo no válido.");
    await this.storage("escritura", () => this.port.putBytes(this.contentPath(username, id), bytes, contentType, { allowOverwrite: !createOnly }));
  }

  async deleteFileBytes(username: string, fileId: string): Promise<void> {
    const id = safeSegment(fileId);
    if (!id) return;
    const meta = await this.getFileMeta(username, id);
    await this.storage("borrado", () => this.port.del(meta?.blobPathname || this.contentPath(username, id)));
  }

  async createBackup(
    username: string,
    id: string,
    portfolio: unknown
  ): Promise<{ id: string; createdAt: string; size: number }> {
    const bytes = new TextEncoder().encode(JSON.stringify(portfolio));
    if (bytes.length > VAULT_MAX_BACKUP_BYTES) throw new Error("La copia supera el límite de 50 MB.");
    await this.storage("escritura", () => this.port.putBytes(this.backupPath(username, id), bytes, "application/json"));
    return { id, createdAt: new Date().toISOString(), size: bytes.length };
  }

  async listBackups(username: string): Promise<{ id: string; size: number }[]> {
    const infos = await this.listPathnames(`${this.user(username)}/backups/`);
    return infos
      .map((i) => ({ id: i.pathname.slice(i.pathname.lastIndexOf("/") + 1).replace(/\.json$/, ""), size: i.size }))
      .filter((b) => safeSegment(b.id) !== null)
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  async getBackup(username: string, id: string): Promise<unknown | null> {
    const clean = safeSegment(id);
    if (!clean) return null;
    return this.readJson<unknown>(this.backupPath(username, clean));
  }

  async appendAudit(username: string, event: VaultAuditEvent): Promise<void> {
    await this.writeJson(this.auditPath(username, event.id), event);
  }

  async listAudit(username: string, limit: number): Promise<VaultAuditEvent[]> {
    const infos = await this.listPathnames(`${this.user(username)}/audit/`);
    const ordered = infos.map((i) => i.pathname).sort().reverse().slice(0, Math.max(0, limit));
    const out: VaultAuditEvent[] = [];
    for (const pathname of ordered) {
      const json = await this.readJson<VaultAuditEvent>(pathname);
      if (json) out.push(json);
    }
    return out;
  }

  async probe(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.port.head(this.secretPath());
      return { ok: true, detail: `almacén remoto accesible (${this.port.kind})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Firma una subida directa para un archivo concreto (solo servidor). */
  async presignContentUpload(opts: {
    username: string;
    fileId: string;
    contentType: string;
    maxBytes: number;
    validUntil: number;
  }): Promise<PresignedPut | null> {
    if (!this.port.presignPut) return null;
    return this.port.presignPut({
      pathname: this.contentPath(opts.username, opts.fileId),
      contentType: opts.contentType,
      maxBytes: opts.maxBytes,
      validUntil: opts.validUntil,
    });
  }

  contentPathFor(username: string, fileId: string): string {
    return this.contentPath(username, fileId);
  }
}

// ---------------------------------------------------------------------------
// Persistencia local (SOLO desarrollo/pruebas; nunca en Vercel)
// ---------------------------------------------------------------------------

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(value), "utf8");
  await fs.rename(tmp, filePath);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function withLocalFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let handle;
  try { handle = await fs.open(`${file}.lock`, "wx", 0o600); }
  catch (err) { if ((err as any)?.code === "EEXIST") throw new VaultConflictError(); throw err; }
  try { return await work(); }
  finally { await handle.close(); await fs.unlink(`${file}.lock`); }
}
const localVersion = (value: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(value)));

export class FsVaultPersistence implements VaultPersistence {
  readonly driver = "fs" as const;
  readonly durable = false;
  readonly detail = "sistema de ficheros local (solo desarrollo: no persiste en despliegues)";

  constructor(private readonly dataDir: string) {}

  get root(): string {
    return this.dataDir;
  }

  private userDir(username: string): string {
    const u = safeSegment(username);
    if (!u) throw new Error("Usuario no válido");
    return path.join(this.dataDir, "users", u);
  }

  async ensureSecret(): Promise<string> {
    const file = path.join(this.dataDir, "secret.key");
    try { const value = (await fs.readFile(file, "utf8")).trim(); if (!value) throw new Error("Clave local no válida"); return value; }
    catch (err) { if ((err as any)?.code !== "ENOENT") throw err; }
    await fs.mkdir(this.dataDir, { recursive: true });
    const secret = randomBytes(32).toString("hex");
    try { await fs.writeFile(file, secret, { flag: "wx", mode: 0o600 }); return secret; }
    catch (err) { if ((err as any)?.code !== "EEXIST") throw err; return (await fs.readFile(file, "utf8")).trim(); }
  }
  private sessionPath(username: string, tokenHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error("Huella de sesión no válida");
    return path.join(this.userDir(username), "session-revocations", `${tokenHash}.json`);
  }
  async isSessionRevoked(username: string, tokenHash: string): Promise<boolean> {
    try {
      const value = JSON.parse(await fs.readFile(this.sessionPath(username, tokenHash), "utf8")) as VaultSessionRevocation;
      return value.username === username && value.tokenHash === tokenHash;
    } catch (err) { if ((err as any)?.code === "ENOENT") return false; throw err; }
  }
  async revokeSession(record: VaultSessionRevocation): Promise<void> {
    const file = this.sessionPath(record.username, record.tokenHash); await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
    catch (err) { if ((err as any)?.code !== "EEXIST") throw err; }
    if (!await this.isSessionRevoked(record.username, record.tokenHash)) throw new VaultStorageUnavailableError("El cierre de sesión no está confirmado.");
  }

  async getUser(username: string): Promise<VaultUserRecord | null> {
    const users = await readJsonFile<Record<string, VaultUserRecord>>(path.join(this.dataDir, "users.json"), {});
    return users[username] ?? null;
  }

  async createUser(username: string, record: VaultUserRecord): Promise<boolean> {
    const u = safeSegment(username);
    if (!u) throw new Error("Usuario no válido");
    const file = path.join(this.dataDir, "users.json");
    const users = await readJsonFile<Record<string, VaultUserRecord>>(file, {});
    if (users[u]) return false;
    users[u] = record;
    await atomicWriteJson(file, users);
    await fs.mkdir(this.userDir(u), { recursive: true });
    return true;
  }

  async getMovements(username: string): Promise<Record<string, any>[]> {
    const map = await readJsonFile<Record<string, Record<string, any>>>(
      path.join(this.userDir(username), "movements.json"),
      {}
    );
    return Object.values(map);
  }

  async getMovement(username: string, id: string): Promise<{ data: Record<string, any>; version: string } | null> {
    const data = (await this.getMovements(username)).find((m) => m.id === id);
    return data ? { data, version: localVersion(data) } : null;
  }
  async putMovements(username: string, movements: Record<string, any>[], options: VaultWriteOptions = {}): Promise<number> {
    const file = path.join(this.userDir(username), "movements.json");
    return withLocalFileLock(file, async () => {
      const current = await readJsonFile<Record<string, Record<string, any>>>(file, {});
      for (const m of movements) {
        const id = safeSegment(m?.id); if (!id) continue;
        if (options.expectedVersion && (!current[id] || localVersion(current[id]) !== options.expectedVersion)) throw new VaultConflictError();
        assertReferencesRetained(current[id], m, "movement", Boolean(options.expectedVersion));
        await options.validate?.(current[id] ?? null);
        await this.protectMovementReferences(username, m);
        current[id] = m;
      }
      await atomicWriteJson(file, current); return Object.keys(current).length;
    });
  }

  private async protectMovementReferences(username: string, movement: any): Promise<void> {
    const refs = expenseReferences(movement); if (!refs.length) return;
    const id = safeSegment(movement.propertyId); if (!id) throw new VaultConflictError();
    const file = this.entitiesFile(username, "properties");
    await withLocalFileLock(file, async () => {
      const map = await readJsonFile<Record<string, VaultEntityRecord>>(file, {}), parent = map[id];
      if (!parent || (parent.data as any)?.id !== id) throw new VaultConflictError("El padre ya no existe; no se confirma la operación.");
      parent.attachmentPins = [...new Set([...(parent.attachmentPins ?? []), ...refs.map(attachmentPin)])].sort();
      if (JSON.stringify(parent).length > VAULT_MAX_ENTITY_BYTES) throw new VaultStorageUnavailableError("El inmueble supera el límite al proteger el vínculo.");
      await atomicWriteJson(file, map);
    });
    await this.protectFileReferences(username, refs);
  }
  private async protectFileReferences(username: string, refs: RemoteDocumentReference[]): Promise<void> {
    const vaultRefs = refs.filter((r) => r.vaultId); if (!vaultRefs.length) return;
    const file = path.join(this.userDir(username), "files.json");
    await withLocalFileLock(file, async () => {
      const map = await readJsonFile<Record<string, VaultFileMeta>>(file, {});
      for (const ref of vaultRefs) {
        const id = safeSegment(ref.vaultId), meta = id ? map[id] : null;
        if (!meta || meta.deletedAt || !meta.sha256) throw new VaultConflictError("El documento no está disponible; no se confirma el vínculo.");
        meta.attachmentProtected = true;
      }
      await atomicWriteJson(file, map);
    });
  }

  private entitiesFile(username: string, type: VaultEntityType): string {
    return path.join(this.userDir(username), `entities_${type}.json`);
  }

  async listEntities(username: string, type: VaultEntityType): Promise<VaultEntityRecord[]> {
    if (!isVaultEntityType(type)) return [];
    const map = await readJsonFile<Record<string, VaultEntityRecord>>(this.entitiesFile(username, type), {});
    return Object.values(map)
      .filter((e) => e && typeof e.id === "string")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async getEntity(username: string, type: VaultEntityType, id: string): Promise<VaultEntityRecord | null> {
    const found = (await this.listEntities(username, type)).find((e) => e.id === id);
    return found ? { ...found, version: localVersion(found) } : null;
  }
  async putEntity(username: string, type: VaultEntityType, id: string, data: unknown, options: VaultWriteOptions = {}): Promise<VaultEntityRecord> {
    if (!isVaultEntityType(type)) throw new Error("Tipo de entidad no admitido por el almacenamiento remoto.");
    const clean = safeSegment(id); if (!clean) throw new Error("Identificador de entidad no válido.");
    const record: VaultEntityRecord = { id: clean, updatedAt: new Date().toISOString(), data };
    if (JSON.stringify(record).length > VAULT_MAX_ENTITY_BYTES) throw new Error("La entidad supera el límite de 1 MB del almacenamiento remoto.");
    const file = this.entitiesFile(username, type);
    return withLocalFileLock(file, async () => {
      const current = await readJsonFile<Record<string, VaultEntityRecord>>(file, {});
      if (options.expectedVersion && (!current[clean] || localVersion(current[clean]) !== options.expectedVersion)) throw new VaultConflictError();
      if (type === "properties") assertReferencesRetained(current[clean]?.data, data, "property", Boolean(options.expectedVersion));
      await options.validate?.(current[clean] ?? null);
      if (type === "properties") {
        if (current[clean]?.attachmentPins) record.attachmentPins = current[clean].attachmentPins;
        await this.protectFileReferences(username, propertyReferences(data));
      }
      current[clean] = record;
      await atomicWriteJson(file, current); return record;
    });
  }
  async deleteEntity(username: string, type: VaultEntityType, id: string, options: VaultWriteOptions = {}): Promise<boolean> {
    if (!isVaultEntityType(type)) return false;
    const clean = safeSegment(id); if (!clean) return false;
    const file = this.entitiesFile(username, type);
    return withLocalFileLock(file, async () => {
      const current = await readJsonFile<Record<string, VaultEntityRecord>>(file, {});
      if (!current[clean]) return false;
      if (options.expectedVersion && localVersion(current[clean]) !== options.expectedVersion) throw new VaultConflictError();
      if (type === "properties" && (propertyReferences(current[clean].data).length || current[clean].attachmentPins?.length)) throw new VaultConflictError("El inmueble tiene documentos remotos; no se borra desde un snapshot.");
      await options.validate?.(current[clean]); delete current[clean]; await atomicWriteJson(file, current); return true;
    });
  }

  async listFiles(username: string): Promise<VaultFileMeta[]> {
    const idx = await readJsonFile<Record<string, VaultFileMeta>>(path.join(this.userDir(username), "files.json"), {});
    return Object.values(idx).filter((f) => !f.deletedAt).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getFileMeta(username: string, fileId: string): Promise<VaultFileMeta | null> {
    const id = safeSegment(fileId);
    if (!id) return null;
    const idx = await readJsonFile<Record<string, VaultFileMeta>>(path.join(this.userDir(username), "files.json"), {});
    return idx[id] && !idx[id].deletedAt ? idx[id] : null;
  }

  async putFileMeta(username: string, meta: VaultFileMeta): Promise<void> {
    const id = safeSegment(meta.id); if (!id) throw new Error("Identificador de archivo no válido.");
    const file = path.join(this.userDir(username), "files.json");
    await withLocalFileLock(file, async () => {
      const idx = await readJsonFile<Record<string, VaultFileMeta>>(file, {});
      assertFileMetadataTransition(idx[id], meta); idx[id] = meta; await atomicWriteJson(file, idx);
    });
  }

  async deleteFileMeta(username: string, fileId: string): Promise<boolean> {
    const id = safeSegment(fileId);
    if (!id) return false;
    const file = path.join(this.userDir(username), "files.json");
    return withLocalFileLock(file, async () => {
      const idx = await readJsonFile<Record<string, VaultFileMeta>>(file, {}), meta = idx[id];
      if (!meta || meta.deletedAt) return false;
      if (meta.attachmentProtected) throw new VaultConflictError("El documento está asociado o reservado; no se retira.");
      meta.deletedAt = new Date().toISOString();
      await atomicWriteJson(file, idx); return true;
    });
  }

  async readFileBytes(username: string, fileId: string): Promise<Uint8Array | null> {
    const id = safeSegment(fileId);
    if (!id) return null;
    try {
      return new Uint8Array(await fs.readFile(path.join(this.userDir(username), "files", id)));
    } catch {
      return null;
    }
  }

  async writeFileBytes(username: string, fileId: string, bytes: Uint8Array, _contentType: string, createOnly = false): Promise<void> {
    const id = safeSegment(fileId);
    if (!id) throw new Error("Identificador de archivo no válido.");
    const dir = path.join(this.userDir(username), "files");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, bytes);
    try {
      if (createOnly) await fs.link(tmp, target); // creación exclusiva y atómica, nunca reemplazar
      else await fs.rename(tmp, target);
    } finally { await fs.rm(tmp, { force: true }); }
  }

  async deleteFileBytes(username: string, fileId: string): Promise<void> {
    const id = safeSegment(fileId);
    if (!id) return;
    await fs.rm(path.join(this.userDir(username), "files", id), { force: true });
  }

  async createBackup(
    username: string,
    id: string,
    portfolio: unknown
  ): Promise<{ id: string; createdAt: string; size: number }> {
    const json = JSON.stringify(portfolio);
    if (json.length > VAULT_MAX_BACKUP_BYTES) throw new Error("La copia supera el límite de 50 MB.");
    const createdAt = new Date().toISOString();
    const dir = path.join(this.userDir(username), "backups");
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJson(path.join(dir, `${id}.json`), portfolio);
    return { id, createdAt, size: json.length };
  }

  async listBackups(username: string): Promise<{ id: string; size: number }[]> {
    try {
      const dir = path.join(this.userDir(username), "backups");
      const entries = await fs.readdir(dir);
      const out: { id: string; size: number }[] = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const id = e.slice(0, -5);
        if (!safeSegment(id)) continue;
        out.push({ id, size: (await fs.stat(path.join(dir, e))).size });
      }
      return out.sort((a, b) => (a.id < b.id ? 1 : -1));
    } catch {
      return [];
    }
  }

  async getBackup(username: string, id: string): Promise<unknown | null> {
    const clean = safeSegment(id);
    if (!clean) return null;
    return readJsonFile<unknown | null>(path.join(this.userDir(username), "backups", `${clean}.json`), null);
  }

  async appendAudit(username: string, event: VaultAuditEvent): Promise<void> {
    await atomicWriteJson(path.join(this.userDir(username), "audit", `${event.id}.json`), event);
  }

  async listAudit(username: string, limit: number): Promise<VaultAuditEvent[]> {
    try {
      const dir = path.join(this.userDir(username), "audit");
      const entries = (await fs.readdir(dir)).filter((e) => e.endsWith(".json")).sort().reverse();
      const out: VaultAuditEvent[] = [];
      for (const e of entries.slice(0, Math.max(0, limit))) {
        const json = await readJsonFile<VaultAuditEvent | null>(path.join(dir, e), null);
        if (json) out.push(json);
      }
      return out;
    } catch {
      return [];
    }
  }

  async probe(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.access(this.dataDir);
      return { ok: true, detail: `directorio local ${this.dataDir} (no persistente en Vercel)` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Sin destino configurado: lecturas vacías y escrituras que fallan (nunca falso éxito)
// ---------------------------------------------------------------------------

export class UnconfiguredVaultPersistence implements VaultPersistence {
  readonly driver = "unconfigured" as const;
  readonly durable = false;
  readonly detail =
    "sin almacenamiento remoto configurado: conecta el almacén Blob al proyecto (BLOB_READ_WRITE_TOKEN/BLOB_STORE_ID)";

  private fail(): never {
    throw new VaultStorageUnavailableError(
      "El almacenamiento remoto no está configurado en este despliegue. No se ha guardado nada: " +
        "conecta el almacén Blob privado al proyecto de Vercel y vuelve a intentarlo."
    );
  }

  async ensureSecret(): Promise<string> {
    return this.fail();
  }
  async isSessionRevoked(_username: string, _tokenHash: string): Promise<boolean> { return this.fail(); }
  async revokeSession(_record: VaultSessionRevocation): Promise<void> { this.fail(); }
  async getMovement(_username: string, _id: string): Promise<{ data: Record<string, any>; version: string } | null> { return null; }
  async getEntity(_username: string, _type: VaultEntityType, _id: string): Promise<VaultEntityRecord | null> { return null; }
  async getUser(_username: string): Promise<VaultUserRecord | null> {
    return null;
  }
  async createUser(_username: string, _record: VaultUserRecord): Promise<boolean> {
    return this.fail();
  }
  async getMovements(_username: string): Promise<Record<string, any>[]> {
    return [];
  }
  async putMovements(_username: string, _movements: Record<string, any>[]): Promise<number> {
    return this.fail();
  }
  async listEntities(_username: string, _type: VaultEntityType): Promise<VaultEntityRecord[]> {
    return [];
  }
  async putEntity(_username: string, _type: VaultEntityType, _id: string, _data: unknown): Promise<VaultEntityRecord> {
    return this.fail();
  }
  async deleteEntity(_username: string, _type: VaultEntityType, _id: string): Promise<boolean> {
    return this.fail();
  }
  async listFiles(_username: string): Promise<VaultFileMeta[]> {
    return [];
  }
  async getFileMeta(_username: string, _fileId: string): Promise<VaultFileMeta | null> {
    return null;
  }
  async putFileMeta(_username: string, _meta: VaultFileMeta): Promise<void> {
    this.fail();
  }
  async deleteFileMeta(_username: string, _fileId: string): Promise<boolean> {
    return this.fail();
  }
  async readFileBytes(_username: string, _fileId: string): Promise<Uint8Array | null> {
    return null;
  }
  async writeFileBytes(_username: string, _fileId: string, _bytes: Uint8Array, _contentType: string): Promise<void> {
    this.fail();
  }
  async deleteFileBytes(_username: string, _fileId: string): Promise<void> {
    this.fail();
  }
  async createBackup(
    _username: string,
    _id: string,
    _portfolio: unknown
  ): Promise<{ id: string; createdAt: string; size: number }> {
    return this.fail();
  }
  async listBackups(_username: string): Promise<{ id: string; size: number }[]> {
    return [];
  }
  async getBackup(_username: string, _id: string): Promise<unknown | null> {
    return null;
  }
  async appendAudit(_username: string, _event: VaultAuditEvent): Promise<void> {
    this.fail();
  }
  async listAudit(_username: string, _limit: number): Promise<VaultAuditEvent[]> {
    return [];
  }
  async probe(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: this.detail };
  }
}

// ---------------------------------------------------------------------------
// Selección de destino según el entorno
// ---------------------------------------------------------------------------

/**
 * Selección de destino, en este orden:
 *  1. Almacén remoto (Vercel Blob) si el despliegue lo tiene conectado.
 *  2. Directorio local SOLO fuera de Vercel (desarrollo y pruebas).
 *  3. Sin destino: las escrituras fallan con error explícito.
 *
 * En Vercel (`VERCEL=1`) NUNCA se usa el sistema de ficheros: es efímero y daría una
 * falsa sensación de persistencia.
 */
export function selectVaultPersistence(
  env: NodeJS.ProcessEnv = process.env,
  ports: { blob?: BlobPort } = {}
): VaultPersistence {
  if (ports.blob) return new BlobVaultPersistence(ports.blob);
  if (blobStoreConfigured(env)) return new BlobVaultPersistence(new VercelBlobPort());
  const onVercel = Boolean(env.VERCEL || env.VERCEL_ENV);
  if (!onVercel && env.RENTASYNC_VAULT_DIR) return new FsVaultPersistence(env.RENTASYNC_VAULT_DIR);
  if (!onVercel && env.NODE_ENV !== "production") {
    return new FsVaultPersistence(path.join(process.cwd(), "data", "vault"));
  }
  return new UnconfiguredVaultPersistence();
}
