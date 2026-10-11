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
  getBytes(pathname: string): Promise<{ bytes: Uint8Array; contentType: string; etag?: string } | null>;
  putBytes(pathname: string, bytes: Uint8Array, contentType: string, options?: { allowOverwrite?: boolean; ifMatch?: string }): Promise<BlobObjectInfo>;
  del(pathname: string, options?: { ifMatch?: string }): Promise<void>;
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
  /** Resumen de la reserva directa. Interno: nunca sustituye la lectura/verificación del servidor. */
  uploadSha256?: string;
  /** Solo servidor: vínculo/reserva protegido antes de confirmar la operación. */
  attachmentProtected?: boolean;
  /** Retirada lógica por CAS; conserva bytes privados y no permite resucitar el ID. */
  deletedAt?: string;
}

/**
 * Tipos de entidad patrimonial estructurada admitidos en el almacén remoto. Una entidad es un
 * objeto JSON por identificador bajo la carpeta de la cuenta: reintentar es idempotente y dos
 * escrituras concurrentes sobre entidades distintas no se pisan.
 */
export const VAULT_ENTITY_TYPES = ["owners", "properties", "contracts", "payments", "settings"] as const;
export type VaultEntityType = (typeof VAULT_ENTITY_TYPES)[number];

export function isVaultEntityType(value: unknown): value is VaultEntityType {
  return typeof value === "string" && (VAULT_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Entidad estructurada persistida. `data` es el objeto de dominio (sin datos fiscales ocultos). */
export interface VaultEntityRecord {
  id: string;
  updatedAt: string;
  data: unknown;
  /** ETag de transporte; nunca se incluye en el JSON persistido. */
  version?: string;
  /** Huellas técnicas de referencias reservadas; fuera de data y de los campos financieros. */
  attachmentPins?: string[];
}

/** Evento de auditoría: solo identificadores y metadatos técnicos, nunca datos fiscales. */
export interface VaultAuditEvent {
  id: string;
  at: string;
  action:
    | "user.register"
    | "user.login"
    | "movements.put"
    | "entity.put"
    | "entity.delete"
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
export interface VaultWriteOptions {
  expectedVersion?: string;
  validate?: (previous: any | null) => Promise<void>;
}

/** Registro técnico autorizado: sin token en claro ni modificación de credenciales. */
export interface VaultSessionRevocation {
  username: string;
  tokenHash: string;
  expiresAt: number;
}

export interface VaultPersistence {
  readonly driver: "vercel-blob" | "fs" | "unconfigured";
  /** `true` solo si el destino es remoto y persistente entre despliegues. */
  readonly durable: boolean;
  readonly detail?: string;

  ensureSecret(): Promise<string>;

  isSessionRevoked(username: string, tokenHash: string): Promise<boolean>;
  revokeSession(record: VaultSessionRevocation): Promise<void>;

  getUser(username: string): Promise<VaultUserRecord | null>;
  createUser(username: string, record: VaultUserRecord): Promise<boolean>;

  getMovements(username: string): Promise<Record<string, any>[]>;
  getMovement(username: string, id: string): Promise<{ data: Record<string, any>; version: string } | null>;
  putMovements(username: string, movements: Record<string, any>[], options?: VaultWriteOptions): Promise<number>;

  /** Entidades estructuradas de la cartera (una por identificador, idempotentes). */
  listEntities(username: string, type: VaultEntityType): Promise<VaultEntityRecord[]>;
  getEntity(username: string, type: VaultEntityType, id: string): Promise<VaultEntityRecord | null>;
  putEntity(username: string, type: VaultEntityType, id: string, data: unknown, options?: VaultWriteOptions): Promise<VaultEntityRecord>;
  deleteEntity(username: string, type: VaultEntityType, id: string, options?: VaultWriteOptions): Promise<boolean>;

  listFiles(username: string): Promise<VaultFileMeta[]>;
  getFileMeta(username: string, fileId: string): Promise<VaultFileMeta | null>;
  putFileMeta(username: string, meta: VaultFileMeta): Promise<void>;
  deleteFileMeta(username: string, fileId: string): Promise<boolean>;

  readFileBytes(username: string, fileId: string): Promise<Uint8Array | null>;
  writeFileBytes(username: string, fileId: string, bytes: Uint8Array, contentType: string, createOnly?: boolean): Promise<void>;
  deleteFileBytes(username: string, fileId: string): Promise<void>;

  createBackup(username: string, id: string, portfolio: unknown): Promise<{ id: string; createdAt: string; size: number }>;
  listBackups(username: string): Promise<{ id: string; size: number }[]>;
  getBackup(username: string, id: string): Promise<unknown | null>;

  appendAudit(username: string, event: VaultAuditEvent): Promise<void>;
  listAudit(username: string, limit: number): Promise<VaultAuditEvent[]>;

  /** Comprobación de disponibilidad del destino (sin escribir datos de usuario). */
  probe(): Promise<{ ok: boolean; detail?: string }>;
}
