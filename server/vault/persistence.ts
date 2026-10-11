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
  VaultFileMeta,
  VaultPersistence,
  VaultUserRecord,
} from "./persistenceTypes.js";
import { VercelBlobPort, blobStoreConfigured } from "./blobPort.js";

export const VAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const VAULT_MAX_BACKUP_BYTES = 50 * 1024 * 1024;

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
  /** Ruta pública del contenido binario (la usa el servidor para subidas directas). */
  contentPath(user: string, id: string): string {
    return path.posix.join(this.user(user), "contents", id);
  }

  private async readJson<T>(pathname: string): Promise<T | null> {
    const got = await this.port.getBytes(pathname);
    if (!got) return null;
    try {
      return JSON.parse(new TextDecoder().decode(got.bytes)) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(pathname: string, value: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    await this.port.putBytes(pathname, bytes, "application/json");
  }

  /** Lista por prefijo y devuelve los pathnames ordenados (paginado en el puerto). */
  private async listPathnames(prefix: string): Promise<BlobObjectInfo[]> {
    return this.port.list(prefix);
  }

  async ensureSecret(): Promise<string> {
    const got = await this.port.getBytes(this.secretPath()).catch(() => null);
    if (got) {
      const value = new TextDecoder().decode(got.bytes).trim();
      if (value) return value;
    }
    const secret = randomBytes(32).toString("hex");
    await this.port.putBytes(this.secretPath(), new TextEncoder().encode(secret), "text/plain");
    return secret;
  }

  async getUser(username: string): Promise<VaultUserRecord | null> {
    return this.readJson<VaultUserRecord>(this.accountPath(username));
  }

  async createUser(username: string, record: VaultUserRecord): Promise<boolean> {
    // El pathname del objeto deriva del usuario: el registro es atómico (crear o fallar).
    const existing = await this.getUser(username);
    if (existing) return false;
    await this.writeJson(this.accountPath(username), record);
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

  async putMovements(username: string, movements: Record<string, any>[]): Promise<number> {
    const map = new Map<string, Record<string, any>>();
    for (const m of movements) {
      const id = safeSegment(m?.id);
      if (!id) continue;
      map.set(id, m);
    }
    for (const [id, m] of map) await this.writeJson(this.movementPath(username, id), m);
    return map.size;
  }

  async listFiles(username: string): Promise<VaultFileMeta[]> {
    const infos = await this.listPathnames(`${this.user(username)}/files/`);
    const out: VaultFileMeta[] = [];
    for (const info of infos) {
      const json = await this.readJson<VaultFileMeta>(info.pathname);
      if (json) out.push(json);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getFileMeta(username: string, fileId: string): Promise<VaultFileMeta | null> {
    const id = safeSegment(fileId);
    if (!id) return null;
    return this.readJson<VaultFileMeta>(this.fileMetaPath(username, id));
  }

  async putFileMeta(username: string, meta: VaultFileMeta): Promise<void> {
    const id = safeSegment(meta.id);
    if (!id) throw new Error("Identificador de archivo no válido.");
    await this.writeJson(this.fileMetaPath(username, id), meta);
  }

  async deleteFileMeta(username: string, fileId: string): Promise<boolean> {
    const id = safeSegment(fileId);
    if (!id) return false;
    const existing = await this.getFileMeta(username, id);
    if (!existing) return false;
    await this.port.del(this.fileMetaPath(username, id));
    return true;
  }

  async readFileBytes(username: string, fileId: string): Promise<Uint8Array | null> {
    const id = safeSegment(fileId);
    if (!id) return null;
    // El pathname del contenido es determinista: se puede leer antes de que existan metadatos
    // (necesario para verificar el objeto recién subido, antes de consolidarlo).
    const meta = await this.getFileMeta(username, id);
    const got = await this.port.getBytes(meta?.blobPathname || this.contentPath(username, id));
    return got ? got.bytes : null;
  }

  async writeFileBytes(username: string, fileId: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const id = safeSegment(fileId);
    if (!id) throw new Error("Identificador de archivo no válido.");
    await this.port.putBytes(this.contentPath(username, id), bytes, contentType);
  }

  async deleteFileBytes(username: string, fileId: string): Promise<void> {
    const id = safeSegment(fileId);
    if (!id) return;
    const meta = await this.getFileMeta(username, id);
    await this.port.del(meta?.blobPathname || this.contentPath(username, id));
  }

  async createBackup(
    username: string,
    id: string,
    portfolio: unknown
  ): Promise<{ id: string; createdAt: string; size: number }> {
    const bytes = new TextEncoder().encode(JSON.stringify(portfolio));
    if (bytes.length > VAULT_MAX_BACKUP_BYTES) throw new Error("La copia supera el límite de 50 MB.");
    await this.port.putBytes(this.backupPath(username, id), bytes, "application/json");
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
    const secretPath = path.join(this.dataDir, "secret.key");
    try {
      return (await fs.readFile(secretPath, "utf8")).trim();
    } catch {
      const secret = randomBytes(32).toString("hex");
      await fs.mkdir(this.dataDir, { recursive: true });
      const tmp = `${secretPath}.tmp`;
      await fs.writeFile(tmp, secret, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, secretPath);
      return secret;
    }
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

  async putMovements(username: string, movements: Record<string, any>[]): Promise<number> {
    const file = path.join(this.userDir(username), "movements.json");
    const current = await readJsonFile<Record<string, Record<string, any>>>(file, {});
    for (const m of movements) {
      const id = safeSegment(m?.id);
      if (!id) continue;
      current[id] = m;
    }
    await atomicWriteJson(file, current);
    return Object.keys(current).length;
  }

  async listFiles(username: string): Promise<VaultFileMeta[]> {
    const idx = await readJsonFile<Record<string, VaultFileMeta>>(path.join(this.userDir(username), "files.json"), {});
    return Object.values(idx).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getFileMeta(username: string, fileId: string): Promise<VaultFileMeta | null> {
    const id = safeSegment(fileId);
    if (!id) return null;
    const idx = await readJsonFile<Record<string, VaultFileMeta>>(path.join(this.userDir(username), "files.json"), {});
    return idx[id] ?? null;
  }

  async putFileMeta(username: string, meta: VaultFileMeta): Promise<void> {
    const id = safeSegment(meta.id);
    if (!id) throw new Error("Identificador de archivo no válido.");
    const file = path.join(this.userDir(username), "files.json");
    const idx = await readJsonFile<Record<string, VaultFileMeta>>(file, {});
    idx[id] = meta;
    await atomicWriteJson(file, idx);
  }

  async deleteFileMeta(username: string, fileId: string): Promise<boolean> {
    const id = safeSegment(fileId);
    if (!id) return false;
    const file = path.join(this.userDir(username), "files.json");
    const idx = await readJsonFile<Record<string, VaultFileMeta>>(file, {});
    if (!idx[id]) return false;
    delete idx[id];
    await atomicWriteJson(file, idx);
    return true;
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

  async writeFileBytes(username: string, fileId: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const id = safeSegment(fileId);
    if (!id) throw new Error("Identificador de archivo no válido.");
    const dir = path.join(this.userDir(username), "files");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
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
