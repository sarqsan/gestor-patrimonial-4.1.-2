// Almacén persistente del vault: usuarios, movimientos, archivos y copias de seguridad.
// Diseño sin dependencias: índices JSON + ficheros binarios bajo un directorio de datos
// (volumen persistente en producción), con escrituras atómicas (tmp + rename).
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "./auth.js";

/** Límite por archivo: idéntico a storage.rules (10 MB). */
export const VAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Tipos admitidos: espejo de storage.rules (PDF, imágenes y .doc de contratos). */
export function vaultContentTypeProblem(contentType: string): string | null {
  const t = (contentType || "").toLowerCase();
  if (t === "application/pdf" || t === "application/msword") return null;
  if (t.startsWith("image/")) return null;
  return `Tipo no admitido por el vault (${t || "sin tipo"}). Usa PDF, imágenes o .doc de contratos.`;
}

/** Identificadores seguros para rutas (sin separadores ni traversal). */
export function safeId(id: string): string | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return id;
}

export function vaultFileId(): string {
  return `file_${Date.now()}_${randomBytes(6).toString("hex")}`;
}

export interface VaultUserRecord {
  salt: string;
  hash: string;
  createdAt: string;
}

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

interface UsersIndex {
  [username: string]: VaultUserRecord;
}
interface FilesIndex {
  [fileId: string]: VaultFileMeta;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(value), "utf8");
  await fs.rename(tmp, filePath);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class VaultStore {
  constructor(private readonly dataDir: string) {}

  get root(): string {
    return this.dataDir;
  }

  private userDir(username: string): string {
    const u = safeId(username);
    if (!u) throw new Error("Usuario no válido");
    return path.join(this.dataDir, "users", u);
  }

  // ---------- secreto de firma de sesiones ----------
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

  // ---------- usuarios ----------
  private usersPath(): string {
    return path.join(this.dataDir, "users.json");
  }

  async getUser(username: string): Promise<VaultUserRecord | null> {
    const users = await readJson<UsersIndex>(this.usersPath(), {});
    return users[username] ?? null;
  }

  /** Crea el usuario. Devuelve false si ya existe. */
  async createUser(username: string, password: string): Promise<boolean> {
    const u = safeId(username);
    if (!u) throw new Error("Usuario no válido");
    const users = await readJson<UsersIndex>(this.usersPath(), {});
    if (users[u]) return false;
    const { salt, hash } = hashPassword(password);
    users[u] = { salt, hash, createdAt: new Date().toISOString() };
    await atomicWriteJson(this.usersPath(), users);
    await fs.mkdir(this.userDir(u), { recursive: true });
    return true;
  }

  async verifyUser(username: string, password: string): Promise<boolean> {
    const record = await this.getUser(username);
    if (!record) return false;
    return verifyPassword(password, record.salt, record.hash);
  }

  // ---------- movimientos ----------
  private movementsPath(username: string): string {
    return path.join(this.userDir(username), "movements.json");
  }

  async getMovements(username: string): Promise<Record<string, any>[]> {
    const map = await readJson<Record<string, Record<string, any>>>(this.movementsPath(username), {});
    return Object.values(map);
  }

  /** Reemplaza el conjunto de movimientos del usuario (idempotente por id). */
  async putMovements(username: string, movements: Record<string, any>[]): Promise<number> {
    const map: Record<string, Record<string, any>> = {};
    for (const m of movements) {
      const id = typeof m?.id === "string" && m.id ? safeId(m.id) : null;
      if (!id) continue;
      map[id] = m;
    }
    await atomicWriteJson(this.movementsPath(username), map);
    return Object.keys(map).length;
  }

  // ---------- archivos ----------
  private filesIndexPath(username: string): string {
    return path.join(this.userDir(username), "files.json");
  }
  private fileBlobPath(username: string, fileId: string): string {
    return path.join(this.userDir(username), "files", fileId);
  }

  async listFiles(username: string): Promise<VaultFileMeta[]> {
    const idx = await readJson<FilesIndex>(this.filesIndexPath(username), {});
    return Object.values(idx).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getFile(username: string, fileId: string): Promise<{ meta: VaultFileMeta; bytes: Uint8Array } | null> {
    const id = safeId(fileId);
    if (!id) return null;
    const idx = await readJson<FilesIndex>(this.filesIndexPath(username), {});
    const meta = idx[id];
    if (!meta) return null;
    try {
      const bytes = await fs.readFile(this.fileBlobPath(username, id));
      return { meta, bytes };
    } catch {
      return null;
    }
  }

  async putFile(
    username: string,
    opts: { id?: string; name: string; contentType: string; bytes: Uint8Array; movementId?: string; propertyId?: string }
  ): Promise<VaultFileMeta> {
    if (opts.bytes.length > VAULT_MAX_FILE_BYTES) throw new Error("El archivo supera el límite de 10 MB del vault.");
    const typeProblem = vaultContentTypeProblem(opts.contentType);
    if (typeProblem) throw new Error(typeProblem);
    const id = opts.id ? safeId(opts.id) : vaultFileId();
    if (!id) throw new Error("Identificador de archivo no válido.");

    const idx = await readJson<FilesIndex>(this.filesIndexPath(username), {});
    if (idx[id]) {
      // Idempotencia: si ya existe con el mismo hash, se reutiliza (importaciones/reintentos).
      const sha = createHash("sha256").update(opts.bytes).digest("hex");
      if (idx[id].sha256 === sha && idx[id].size === opts.bytes.length) return idx[id];
      throw new Error("Ya existe un archivo distinto con ese identificador; no se sobrescribe.");
    }

    const dir = path.dirname(this.fileBlobPath(username, id));
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.fileBlobPath(username, id)}.tmp-${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, opts.bytes);
    await fs.rename(tmp, this.fileBlobPath(username, id));

    const meta: VaultFileMeta = {
      id,
      name: String(opts.name || "archivo").slice(0, 200),
      contentType: opts.contentType,
      size: opts.bytes.length,
      sha256: createHash("sha256").update(opts.bytes).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    if (opts.movementId) meta.movementId = String(opts.movementId).slice(0, 128);
    if (opts.propertyId) meta.propertyId = String(opts.propertyId).slice(0, 128);
    idx[id] = meta;
    await atomicWriteJson(this.filesIndexPath(username), idx);
    return meta;
  }

  async deleteFile(username: string, fileId: string): Promise<boolean> {
    const id = safeId(fileId);
    if (!id) return false;
    const idx = await readJson<FilesIndex>(this.filesIndexPath(username), {});
    if (!idx[id]) return false;
    delete idx[id];
    await atomicWriteJson(this.filesIndexPath(username), idx);
    try {
      await fs.unlink(this.fileBlobPath(username, id));
    } catch {
      // El índice manda; el blob huérfano no compromete datos.
    }
    return true;
  }

  // ---------- copias de seguridad de la cartera ----------
  private backupsDir(username: string): string {
    return path.join(this.userDir(username), "backups");
  }

  async createBackup(username: string, portfolio: unknown): Promise<{ id: string; createdAt: string; size: number }> {
    const json = JSON.stringify(portfolio);
    if (json.length > 50 * 1024 * 1024) throw new Error("La copia supera el límite de 50 MB.");
    const createdAt = new Date().toISOString();
    const id = `backup_${createdAt.replace(/[^0-9]/g, "")}_${randomBytes(4).toString("hex")}`;
    await fs.mkdir(this.backupsDir(username), { recursive: true });
    await atomicWriteJson(path.join(this.backupsDir(username), `${id}.json`), portfolio);
    return { id, createdAt, size: json.length };
  }

  async listBackups(username: string): Promise<{ id: string; size: number }[]> {
    try {
      const entries = await fs.readdir(this.backupsDir(username));
      const out: { id: string; size: number }[] = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const id = e.slice(0, -5);
        if (!safeId(id)) continue;
        const stat = await fs.stat(path.join(this.backupsDir(username), e));
        out.push({ id, size: stat.size });
      }
      return out.sort((a, b) => (a.id < b.id ? 1 : -1));
    } catch {
      return [];
    }
  }

  async getBackup(username: string, id: string): Promise<unknown | null> {
    const clean = safeId(id);
    if (!clean) return null;
    return readJson<unknown | null>(path.join(this.backupsDir(username), `${clean}.json`), null);
  }
}

/** Comprueba (solo lectura) si un directorio existe y es escribible; informativo. */
export function vaultDirExists(dir: string): boolean {
  try {
    fsSync.accessSync(dir);
    return true;
  } catch {
    return false;
  }
}
