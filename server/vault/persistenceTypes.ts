// Tipos compartidos del almacenamiento remoto del vault (sin dependencias de SDK).

/** Metadatos de un objeto del almacén remoto. */
export interface BlobObjectInfo {
  pathname: string;
  size: number;
  uploadedAt: string;
  etag: string;
}

/** URL de subida directa acotada por el servidor (un pathname, `put`, tamaño y tipo). */
export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
  validUntil: number;
}

/**
 * Puerto del almacén remoto de objetos. Implementaciones:
 *  - `VercelBlobPort` (producción, SDK oficial, almacén privado)
 *  - `MemoryBlobPort` (pruebas, en memoria)
 */
export interface BlobPort {
  readonly kind: string;
  head(pathname: string): Promise<BlobObjectInfo | null>;
  getBytes(pathname: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  putBytes(pathname: string, bytes: Uint8Array, contentType: string): Promise<BlobObjectInfo>;
  del(pathname: string): Promise<void>;
  list(prefix: string): Promise<BlobObjectInfo[]>;
  presignPut?(options: {
    pathname: string;
    contentType: string;
    maxBytes: number;
    validUntil: number;
  }): Promise<PresignedPut>;
}

export interface VaultUserRecord {
  salt: string;
  hash: string;
  createdAt: string;
}

/** Metadatos de un archivo almacenado. `blobPathname` es interno y no se expone al cliente. */
export interface VaultFileMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
  movementId?: string;
  propertyId?: string;
  /** Ruta interna del objeto en el almacén remoto. */
  blobPathname?: string;
  /** Origen de la verificación del hash: el servidor siempre recalcula el suyo. */
  sha256VerifiedBy?: "server";
}

/** Evento de auditoría: solo identificadores y metadatos técnicos, nunca datos fiscales. */
export interface VaultAuditEvent {
  id: string;
  at: string;
  action:
    | "user.register"
    | "user.login"
    | "movements.put"
    | "file.upload"
    | "file.upload.direct"
    | "file.download"
    | "file.delete"
    | "backup.create"
    | "expediente.export";
  actor: string;
  target?: string;
  ok: boolean;
  detail?: string;
}

/** Origen de datos del vault. Una sola interfaz para el almacén remoto y el modo local. */
export interface VaultPersistence {
  readonly driver: "vercel-blob" | "fs" | "unconfigured";
  /** `true` solo si el destino es remoto y persistente entre despliegues. */
  readonly durable: boolean;
  readonly detail?: string;

  ensureSecret(): Promise<string>;

  getUser(username: string): Promise<VaultUserRecord | null>;
  createUser(username: string, record: VaultUserRecord): Promise<boolean>;

  getMovements(username: string): Promise<Record<string, any>[]>;
  putMovements(username: string, movements: Record<string, any>[]): Promise<number>;

  listFiles(username: string): Promise<VaultFileMeta[]>;
  getFileMeta(username: string, fileId: string): Promise<VaultFileMeta | null>;
  putFileMeta(username: string, meta: VaultFileMeta): Promise<void>;
  deleteFileMeta(username: string, fileId: string): Promise<boolean>;

  readFileBytes(username: string, fileId: string): Promise<Uint8Array | null>;
  writeFileBytes(username: string, fileId: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deleteFileBytes(username: string, fileId: string): Promise<void>;

  createBackup(username: string, id: string, portfolio: unknown): Promise<{ id: string; createdAt: string; size: number }>;
  listBackups(username: string): Promise<{ id: string; size: number }[]>;
  getBackup(username: string, id: string): Promise<unknown | null>;

  appendAudit(username: string, event: VaultAuditEvent): Promise<void>;
  listAudit(username: string, limit: number): Promise<VaultAuditEvent[]>;

  /** Comprobación de disponibilidad del destino (sin escribir datos de usuario). */
  probe(): Promise<{ ok: boolean; detail?: string }>;
}
