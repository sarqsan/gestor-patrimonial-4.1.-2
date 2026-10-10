// Orquestador de la migración de adjuntos históricos de la cartera (portfolio-attachments-v1).
// Módulo puro: Storage y Firestore entran por puertos (MigrationStorage / MigrationStore).
// En la app se usan los adaptadores reales de firebaseMigration.ts; en pruebas, adaptadores en memoria.
//
// Orden de operaciones (cada paso es idempotente y reanudable):
//  1. Lee la cartera original de Firestore y calcula su hash.
//  2. Crea la copia recuperable en Storage (objeto JSON direccionado por hash) y verifica su contenido.
//     Solo después escribe el índice pequeño en Firestore (users/{u}/backups/{hash}).
//  3. Sube cada adjunto a una ruta estable y verifica byte a byte. Si el objeto ya existe con el
//     mismo contenido se reutiliza; si existe con otro contenido NO se sobrescribe.
//  4. Prepara el documento final en memoria (sin tocar el original) y comprueba la guardia de tamaño.
//  5. Escribe en una transacción que compara el hash del documento: si alguien modificó la cartera
//     desde el paso 1, se aborta sin escribir.
//  6. Verifica el resultado leyendo de nuevo Firestore y Storage. Si algo no cuadra, restaura el
//     original automáticamente (solo si el documento sigue siendo el migrado).
//  7. Nunca borra datos ni objetos antiguos.

import { AppState, PropertyDocument, PropertyExpense } from "../types";
import { isDataUrl } from "./legacyDataUrl";
import { portfolioBody } from "./portfolioPayload";
import {
  buildInventory,
  assertNoDataUrls,
  rewritePortfolioWithReferences,
  MigrationInventory,
} from "./portfolioMigration";
import { checkPortfolioWrite, collectInlineDataUrls } from "./portfolioGuard";
import { parseDataUrl } from "./legacyDataUrl";
import { MAX_BACKUP_BYTES, portfolioBackupStoragePath } from "./attachmentRules";
import { portfolioRawHash, sha256Hex, stableStringify, utf8Bytes } from "./stableHash";

export const MIGRATION_SCHEMA = "rentasync.portfolio-attachments-v1";
export const BACKUP_SCHEMA = "rentasync.portfolio-backup.v1";

export class ConcurrentChangeError extends Error {
  constructor(message = "La cartera se ha modificado durante la migración. No se ha escrito nada; vuelve a intentarlo.") {
    super(message);
    this.name = "ConcurrentChangeError";
  }
}

export interface MigrationStorage {
  uploadBytes(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Bytes del objeto, o null si no existe. Cualquier otro error debe lanzarse. */
  readBytes(path: string): Promise<Uint8Array | null>;
}

export interface BackupIndexEntry {
  backupId: string;
  storagePath: string;
  sha256: string;
  bytes: number;
  sourceHash: string;
  sourceUpdatedAt: string | null;
  createdAt: string;
  reason: string;
  schema: string;
}

export interface MigrationRecordAttachment {
  attachmentId: string;
  storagePath: string;
  bytes: number;
  sha256: string;
  status: "pending" | "verified";
}

export interface MigrationRecord {
  schema: string;
  userId: string;
  status: "running" | "completed" | "failed" | "rolled-back";
  sourceHash: string;
  backupId?: string;
  targetHash?: string;
  attachments: MigrationRecordAttachment[];
  startedAt: string;
  updatedAt: string;
  finalBytes?: number;
  error?: string;
}

export interface MigrationStore {
  /** Documento raw users/{u}/data/portfolio (incluye updatedAt), o null si no existe. */
  readRaw(userId: string): Promise<Record<string, unknown> | null>;
  /**
   * Reemplaza el documento solo si su hash actual coincide con expectedHash
   * ("" = el documento no debe existir). Si no coincide lanza ConcurrentChangeError.
   * Debe ser atómico (transacción). Con enforceGuard (por defecto) aplica la guardia de escritura
   * (sin Base64 nuevos y dentro del margen seguro). La restauración de un original lo desactiva.
   */
  replaceIfUnchanged(
    userId: string,
    expectedHash: string,
    next: Record<string, unknown>,
    opts?: { enforceGuard?: boolean }
  ): Promise<void>;
  writeBackupIndex(userId: string, entry: BackupIndexEntry): Promise<void>;
  readBackupIndex(userId: string, backupId: string): Promise<BackupIndexEntry | null>;
  readMigrationRecord(userId: string): Promise<MigrationRecord | null>;
  writeMigrationRecord(userId: string, record: MigrationRecord): Promise<void>;
}

export type MigrationStatus = "nothing-to-migrate" | "completed" | "failed" | "rolled-back";

export interface MigrationOutcome {
  status: MigrationStatus;
  userId: string;
  legacyCount: number;
  initialBytes: number;
  finalBytes?: number;
  backupId?: string;
  backupPath?: string;
  attachments: Array<{ attachmentId: string; storagePath: string; bytes: number; sha256: string; verified: boolean }>;
  /** Documento final tal como quedó en Firestore (sin updatedAt duplicado). Solo si completed. */
  migratedRaw?: Record<string, unknown>;
  error?: string;
  steps: string[];
}

// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function withoutUpdatedAt(raw: Record<string, unknown>): Record<string, unknown> {
  const { updatedAt: _ignored, ...rest } = raw;
  return rest;
}

/** Permite decidir si el botón de migración debe estar habilitado. Sin efectos. */
export function canStartMigration(input: { legacyCount: number; running: boolean }): { enabled: boolean; reason: string | null } {
  if (input.running) return { enabled: false, reason: "Hay una migración en curso." };
  if (input.legacyCount <= 0) return { enabled: false, reason: "No hay adjuntos Base64 históricos que migrar." };
  return { enabled: true, reason: null };
}

interface PreparedAttachment {
  attachmentId: string;
  storagePath: string;
  contentType: string;
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
}

export async function runPortfolioAttachmentMigration(params: {
  userId: string;
  /** Estado en pantalla: cartera de trabajo (incluye cambios locales aún no guardados). */
  working: AppState;
  storage: MigrationStorage;
  store: MigrationStore;
  now?: () => Date;
}): Promise<MigrationOutcome> {
  const { userId, working, storage, store } = params;
  const now = params.now ?? (() => new Date());
  const steps: string[] = [];
  let inventory: MigrationInventory | null = null;
  let initialBytes = 0;
  let record: MigrationRecord | null = null;
  // Copia creada (si existe): siempre se devuelve para que el usuario sepa dónde está el original.
  let backupInfo: { backupId: string; backupPath: string } | undefined;

  const base = (status: MigrationStatus, extra: Partial<MigrationOutcome> = {}): MigrationOutcome => ({
    status,
    userId,
    legacyCount: inventory?.legacyCount ?? 0,
    initialBytes,
    attachments: [],
    steps,
    ...extra,
  });

  const failed = async (error: string, extra: Partial<MigrationOutcome> = {}) => {
    if (backupInfo && !extra.backupId) extra = { ...extra, ...backupInfo };
    if (record) {
      try {
        record = { ...record, status: "failed", error, updatedAt: now().toISOString() };
        await store.writeMigrationRecord(userId, record);
      } catch {
        // El registro es informativo: un fallo al escribirlo no cambia el resultado.
      }
    }
    return base("failed", { error, ...extra });
  };

  try {
    // 1. Original
    const cloudRaw = await store.readRaw(userId);
    if (!cloudRaw) return failed("No se encontró la cartera en Firestore.");
    const cloudHash = await portfolioRawHash(cloudRaw);
    steps.push("read-original");

    inventory = buildInventory(working, userId);
    initialBytes = inventory.initialBytes;

    // Ningún adjunto de la nube puede perderse: la copia en pantalla debe contenerlo.
    const workingInline = new Set(collectInlineDataUrls(portfolioBody(working)).map((d) => d.value));
    const missing = collectInlineDataUrls(cloudRaw).filter((d) => !workingInline.has(d.value));
    if (missing.length > 0) {
      return failed(
        `La copia en pantalla no contiene ${missing.length} adjunto(s) que sí están en la nube. Recarga la página antes de migrar.`
      );
    }

    if (inventory.legacyCount === 0) {
      return base("nothing-to-migrate", { initialBytes });
    }

    // 2. Preparación de bytes (validación previa, sin escribir nada)
    const prepared: PreparedAttachment[] = [];
    for (const att of inventory.attachments) {
      const parsed = parseDataUrl(att.dataUrl);
      if (!parsed) return failed(`El adjunto ${att.attachmentId} no es un Base64 válido. No se ha escrito nada.`);
      prepared.push({
        attachmentId: att.attachmentId,
        storagePath: att.storagePath,
        contentType: att.contentType,
        fileName: att.fileName,
        bytes: parsed.bytes,
        sha256: await sha256Hex(parsed.bytes),
      });
    }

    // 3. Copia recuperable en Storage (antes que cualquier otra escritura)
    const backupDoc = {
      schema: BACKUP_SCHEMA,
      userId,
      sourceHash: cloudHash,
      sourceUpdatedAt: (cloudRaw.updatedAt as string | undefined) ?? null,
      raw: cloudRaw,
    };
    const backupBytes = utf8Bytes(stableStringify(backupDoc));
    if (backupBytes.length > MAX_BACKUP_BYTES) return failed("La copia de seguridad supera el tamaño máximo permitido.");
    const backupId = await sha256Hex(backupBytes);
    const backupPath = portfolioBackupStoragePath(userId, backupId);
    const existingBackup = await storage.readBytes(backupPath);
    if (!existingBackup) await storage.uploadBytes(backupPath, backupBytes, "application/json");
    const backupBack = await storage.readBytes(backupPath);
    if (!backupBack || !bytesEqual(backupBack, backupBytes)) {
      return failed("La copia de seguridad no se ha verificado en Storage. La cartera NO se ha modificado.", { backupId, backupPath });
    }
    backupInfo = { backupId, backupPath };
    const createdAt = now().toISOString();
    await store.writeBackupIndex(userId, {
      backupId,
      storagePath: backupPath,
      sha256: backupId,
      bytes: backupBytes.length,
      sourceHash: cloudHash,
      sourceUpdatedAt: backupDoc.sourceUpdatedAt,
      createdAt,
      reason: "pre-migration portfolio-attachments-v1",
      schema: BACKUP_SCHEMA,
    });
    steps.push("backup-verified");

    // 4. Registro de migración (reanudable)
    record = {
      schema: MIGRATION_SCHEMA,
      userId,
      status: "running",
      sourceHash: cloudHash,
      backupId,
      attachments: prepared.map((p) => ({ attachmentId: p.attachmentId, storagePath: p.storagePath, bytes: p.bytes.length, sha256: p.sha256, status: "pending" })),
      startedAt: createdAt,
      updatedAt: createdAt,
    };
    await store.writeMigrationRecord(userId, record);

    // 5. Subida y verificación byte a byte
    for (const item of prepared) {
      const existing = await storage.readBytes(item.storagePath);
      if (existing) {
        if (!bytesEqual(existing, item.bytes)) {
          return failed(`Ya existe un objeto distinto en ${item.storagePath}; no se sobrescribe. Revísalo manualmente.`, { backupId, backupPath });
        }
        steps.push(`reuse-verified:${item.attachmentId}`);
      } else {
        await storage.uploadBytes(item.storagePath, item.bytes, item.contentType);
        const back = await storage.readBytes(item.storagePath);
        if (!back || !bytesEqual(back, item.bytes)) {
          return failed(`Verificación fallida para ${item.attachmentId}: el contenido en Storage no coincide con el original.`, { backupId, backupPath });
        }
        steps.push(`uploaded-verified:${item.attachmentId}`);
      }
      record = {
        ...record,
        attachments: record.attachments.map((a) => (a.attachmentId === item.attachmentId ? { ...a, status: "verified" } : a)),
        updatedAt: now().toISOString(),
      };
      await store.writeMigrationRecord(userId, record);
    }

    // 6. Documento final en memoria (el original sigue intacto)
    const migratedWorking = rewritePortfolioWithReferences(working, inventory);
    const leftovers = assertNoDataUrls(migratedWorking);
    if (leftovers.length > 0) return failed(`Quedan adjuntos Base64 tras la reescritura: ${leftovers.join(", ")}`, { backupId, backupPath });

    const targetBody = JSON.parse(JSON.stringify(portfolioBody(migratedWorking)));
    const targetCheck = checkPortfolioWrite(targetBody);
    if (!targetCheck.ok) return failed(targetCheck.errors.join(" "), { backupId, backupPath });

    const updatedAt = now().toISOString();
    const targetRaw: Record<string, unknown> = { ...withoutUpdatedAt(cloudRaw), ...targetBody, updatedAt };
    const targetHash = await portfolioRawHash(targetRaw);
    steps.push("target-prepared");

    // 7. Escritura atómica con comprobación de concurrencia
    try {
      await store.replaceIfUnchanged(userId, cloudHash, targetRaw);
      steps.push("written");
    } catch (err) {
      if (err instanceof ConcurrentChangeError) {
        return failed(err.message, { backupId, backupPath });
      }
      // Resultado incierto (p. ej. tiempo de espera): comprobar si la escritura llegó a aplicarse.
      const current = await store.readRaw(userId);
      if (!current || (await portfolioRawHash(current)) !== targetHash) throw err;
      steps.push("written-after-uncertain-response");
    }

    // 8. Verificación posterior
    const verifyProblems = await verifyAfterWrite(userId, targetHash, prepared, store, storage);
    if (verifyProblems.length > 0) {
      const reason = `Verificación posterior fallida: ${verifyProblems.join("; ")}`;
      const restored = await rollbackIfUnchanged(userId, targetHash, cloudRaw, cloudHash, store);
      if (record) {
        record = { ...record, status: restored ? "rolled-back" : "failed", targetHash, error: reason, updatedAt: now().toISOString() };
        await store.writeMigrationRecord(userId, record).catch(() => undefined);
      }
      return base(restored ? "rolled-back" : "failed", {
        error: restored
          ? `${reason}. El documento original se ha restaurado automáticamente; la copia ${backupId} sigue disponible.`
          : `${reason}. NO se pudo restaurar automáticamente: usa la copia ${backupId} (no se ha borrado nada).`,
        backupId,
        backupPath,
      });
    }
    steps.push("verified");

    const finalBytes = targetCheck.bytes;
    record = { ...record, status: "completed", targetHash, finalBytes, updatedAt: now().toISOString(), error: undefined };
    await store.writeMigrationRecord(userId, record).catch(() => undefined);

    return base("completed", {
      finalBytes,
      backupId,
      backupPath,
      migratedRaw: targetRaw,
      attachments: prepared.map((p) => ({ attachmentId: p.attachmentId, storagePath: p.storagePath, bytes: p.bytes.length, sha256: p.sha256, verified: true })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failed(`Error durante la migración: ${msg}. La cartera original no se ha modificado salvo que aparezca un estado posterior explícito.`);
  }
}

async function verifyAfterWrite(
  userId: string,
  targetHash: string,
  prepared: PreparedAttachment[],
  store: MigrationStore,
  storage: MigrationStorage
): Promise<string[]> {
  const problems: string[] = [];
  const after = await store.readRaw(userId);
  if (!after) return ["el documento no existe tras escribir"];
  if ((await portfolioRawHash(after)) !== targetHash) problems.push("el documento leído no coincide con el escrito");
  const check = checkPortfolioWrite(withoutUpdatedAt(after));
  if (!check.ok) problems.push(check.errors.join(" "));
  const inlineLeft = collectInlineDataUrls(after);
  if (inlineLeft.length > 0) problems.push(`quedan ${inlineLeft.length} adjunto(s) Base64`);

  const expenses = (after.expenses as Array<{ id: string; receiptPath?: string }> | undefined) ?? [];
  const properties = (after.properties as Array<{ documents?: Array<{ id: string; storagePath?: string }> }> | undefined) ?? [];
  for (const item of prepared) {
    const isExpense = item.storagePath.includes("/expenses/");
    const refOk = isExpense
      ? expenses.find((e) => e.id === item.attachmentId)?.receiptPath === item.storagePath
      : properties.some((p) => (p.documents ?? []).some((d) => d.id === item.attachmentId && d.storagePath === item.storagePath));
    if (!refOk) problems.push(`referencia rota para ${item.attachmentId}`);
    const bytes = await storage.readBytes(item.storagePath);
    if (!bytes || !bytesEqual(bytes, item.bytes)) problems.push(`contenido en Storage no verificado para ${item.attachmentId}`);
  }
  return problems;
}

async function rollbackIfUnchanged(
  userId: string,
  migratedHash: string,
  originalRaw: Record<string, unknown>,
  originalHash: string,
  store: MigrationStore
): Promise<boolean> {
  try {
    await store.replaceIfUnchanged(userId, migratedHash, originalRaw, { enforceGuard: false });
    const back = await store.readRaw(userId);
    return !!back && (await portfolioRawHash(back)) === originalHash;
  } catch {
    return false;
  }
}

/**
 * Restaura la cartera desde una copia de seguridad verificada (acción administrativa explícita).
 * Comprueba hash del objeto y del índice; no escribe si la copia está corrupta.
 */
export async function restorePortfolioFromBackup(params: {
  userId: string;
  backupId: string;
  storage: MigrationStorage;
  store: MigrationStore;
}): Promise<{ restoredHash: string; raw: Record<string, unknown> }> {
  const { userId, backupId, storage, store } = params;
  const index = await store.readBackupIndex(userId, backupId);
  if (!index) throw new Error("No existe el índice de la copia de seguridad.");
  const bytes = await storage.readBytes(index.storagePath);
  if (!bytes) throw new Error("No se encuentra el archivo de la copia de seguridad en Storage.");
  const digest = await sha256Hex(bytes);
  if (digest !== backupId || digest !== index.sha256) throw new Error("La copia de seguridad está corrupta (hash no coincide). No se ha restaurado nada.");
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  if (doc.schema !== BACKUP_SCHEMA || doc.userId !== userId || !doc.raw) throw new Error("La copia de seguridad no corresponde a esta cartera.");
  const current = await store.readRaw(userId);
  const expected = current ? await portfolioRawHash(current) : "";
  await store.replaceIfUnchanged(userId, expected, doc.raw as Record<string, unknown>, { enforceGuard: false });
  const raw = doc.raw as Record<string, unknown>;
  return { restoredHash: await portfolioRawHash(raw), raw };
}

/**
 * Aplica al estado en pantalla SOLO las referencias a Storage del documento migrado.
 * Preserva cualquier edición hecha mientras la migración estaba en curso.
 * Un adjunto sin referencia migrada conserva su Base64 (y la guardia lo seguirá contando).
 */
export function mergeMigratedReferences(current: AppState, migrated: Record<string, unknown>): AppState {
  const migratedExpenses = new Map(
    ((migrated.expenses as Array<PropertyExpense & { receiptPath?: string }> | undefined) ?? [])
      .filter((e) => !!e.receiptPath)
      .map((e) => [e.id, e])
  );
  const migratedDocs = new Map<string, PropertyDocument>();
  for (const p of (migrated.properties as Array<{ documents?: PropertyDocument[] }> | undefined) ?? []) {
    for (const d of p.documents ?? []) if (d.storagePath) migratedDocs.set(d.id, d);
  }

  return {
    ...current,
    expenses: (current.expenses ?? []).map((e) => {
      const ref = migratedExpenses.get(e.id);
      if (!ref || !isDataUrl(e.receiptUrl)) return e;
      const { receiptUrl: _legacy, ...rest } = e;
      return { ...rest, receiptPath: ref.receiptPath, receiptName: ref.receiptName ?? e.receiptName, receiptType: ref.receiptType ?? e.receiptType };
    }),
    properties: current.properties.map((p) => ({
      ...p,
      documents: p.documents?.map((d) => {
        const ref = migratedDocs.get(d.id);
        if (!ref || !isDataUrl(d.fileData)) return d;
        const { fileData: _legacy, ...rest } = d;
        return { ...rest, storagePath: ref.storagePath, contentType: ref.contentType ?? d.contentType };
      }),
    })),
  };
}
