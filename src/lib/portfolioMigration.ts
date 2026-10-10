// Migración segura de la cartera histórica: extrae adjuntos Base64 a Storage y deja referencias.
// Módulo puro + adaptadores para Storage y Firestore. No escribe en Firebase real sin adaptador.
//
// Principios:
// - Idempotente y reanudable: la misma entrada produce las mismas rutas; re-ejecutar no duplica.
// - No destructivo: primero copia a Storage, verifica, luego reescribe referencias.
// - Dry-run: inventario sin escrituras.
// - Verificación: compara bytes subidos.
// - Detección de cambios concurrentes: compara updatedAt antes de escribir.
// - Preserva identificadores, relaciones, titularidades, importes, metadatos.

import { AppState, Property, PropertyDocument, PropertyExpense } from "../types";
import { portfolioBody } from "./portfolioPayload";
import {
  attachmentStoragePath,
  AttachmentFolder,
  estimatePayloadBytes,
  PORTFOLIO_DOC_SAFE_BYTES,
  sanitizeFileName,
} from "./attachmentRules";
import { isDataUrl, parseDataUrl, estimateDataUrlBytes } from "./legacyDataUrl";

export type LegacyKind = "expense-receipt" | "property-document";

export interface LegacyAttachmentRecord {
  kind: LegacyKind;
  /** Identificador estable del adjunto (id del gasto o del documento) */
  attachmentId: string;
  /** Para trazabilidad */
  propertyId?: string;
  expenseId?: string;
  docId?: string;
  fileName: string;
  contentType: string;
  dataUrl: string;
  dataBytes: number; // tamaño binario estimado/decodificado
  dataUrlLength: number; // longitud de la cadena data URL (lo que ocupa en Firestore)
  storagePath: string;
  folder: AttachmentFolder;
}

export interface MigrationInventory {
  userId: string;
  initialBytes: number;
  estimatedFinalBytes: number;
  totalLegacyDataUrlChars: number;
  totalLegacyBinaryBytes: number;
  legacyCount: number;
  attachments: LegacyAttachmentRecord[];
  /** Si la cartera ya está por debajo del límite, pero con margen pequeño */
  nearLimit: boolean;
  blocked: boolean;
}

export interface MigrationProgress {
  phase: "inventory" | "upload" | "verify" | "rewrite" | "done";
  total: number;
  uploaded: number;
  verified: number;
  errors: Array<{ attachmentId: string; error: string }>;
  pending: LegacyAttachmentRecord[];
}

export interface UploadResult {
  attachmentId: string;
  storagePath: string;
  bytesUploaded: number;
  verified: boolean;
  error?: string;
}

export interface MigrationResult {
  inventory: MigrationInventory;
  uploadResults: UploadResult[];
  migratedPortfolio: AppState | null; // null si la fase de subida falló
  finalBytes: number | null;
  success: boolean;
  errors: Array<{ attachmentId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Inventario puro (sin I/O)
// ---------------------------------------------------------------------------

function safeFileNameFromExpense(exp: PropertyExpense): string {
  if (exp.receiptName && exp.receiptName.trim()) return exp.receiptName.trim();
  const ext = exp.receiptType?.includes("pdf") ? ".pdf" : exp.receiptType?.includes("png") ? ".png" : exp.receiptType?.includes("jpeg") || exp.receiptType?.includes("jpg") ? ".jpg" : ".pdf";
  return `comprobante_${exp.id}${ext}`;
}

function safeFileNameFromDoc(doc: PropertyDocument): string {
  if (doc.name && doc.name.trim()) return doc.name.trim();
  const ext = doc.type?.includes("pdf") ? ".pdf" : ".png";
  return `documento_${doc.id}${ext}`;
}

function contentTypeFromExpense(exp: PropertyExpense, parsed: { mimeType: string } | null): string {
  if (exp.receiptType) return exp.receiptType;
  if (parsed?.mimeType) return parsed.mimeType;
  return "application/pdf";
}

function contentTypeFromDoc(doc: PropertyDocument, parsed: { mimeType: string } | null): string {
  if (doc.type) return doc.type;
  if (doc.contentType) return doc.contentType;
  if (parsed?.mimeType) return parsed.mimeType;
  return "application/pdf";
}

export function buildInventory(portfolio: AppState, userId: string): MigrationInventory {
  const body = portfolioBody(portfolio);
  const initialBytes = estimatePayloadBytes(body);

  const attachments: LegacyAttachmentRecord[] = [];

  for (const exp of portfolio.expenses || []) {
    if (isDataUrl(exp.receiptUrl)) {
      const dataUrl = exp.receiptUrl as string;
      const parsed = parseDataUrl(dataUrl);
      const binaryBytes = parsed ? parsed.sizeBytes : estimateDataUrlBytes(dataUrl);
      const fileName = safeFileNameFromExpense(exp);
      const folder: AttachmentFolder = "expenses";
      const storagePath = attachmentStoragePath(userId, folder, exp.id, fileName);
      attachments.push({
        kind: "expense-receipt",
        attachmentId: exp.id,
        propertyId: exp.propertyId,
        expenseId: exp.id,
        fileName: sanitizeFileName(fileName),
        contentType: contentTypeFromExpense(exp, parsed),
        dataUrl,
        dataBytes: binaryBytes,
        dataUrlLength: dataUrl.length,
        storagePath,
        folder,
      });
    }
  }

  for (const prop of portfolio.properties || []) {
    for (const doc of prop.documents || []) {
      if (isDataUrl(doc.fileData)) {
        const dataUrl = doc.fileData as string;
        const parsed = parseDataUrl(dataUrl);
        const binaryBytes = parsed ? parsed.sizeBytes : estimateDataUrlBytes(dataUrl);
        const fileName = safeFileNameFromDoc(doc);
        const folder: AttachmentFolder = "property-documents";
        const storagePath = attachmentStoragePath(userId, folder, doc.id, fileName);
        attachments.push({
          kind: "property-document",
          attachmentId: doc.id,
          propertyId: prop.id,
          docId: doc.id,
          fileName: sanitizeFileName(fileName),
          contentType: contentTypeFromDoc(doc, parsed),
          dataUrl,
          dataBytes: binaryBytes,
          dataUrlLength: dataUrl.length,
          storagePath,
          folder,
        });
      }
    }
  }

  const totalLegacyDataUrlChars = attachments.reduce((s, a) => s + a.dataUrlLength, 0);
  const totalLegacyBinaryBytes = attachments.reduce((s, a) => s + a.dataBytes, 0);

  // Estimación del tamaño final: restamos el tamaño de las data URLs y sumamos referencias.
  // Una referencia ocupa ~ 150-300 bytes JSON (storagePath + name + contentType).
  const avgRefBytes = 250;
  const estimatedFinalBytes = Math.max(
    0,
    initialBytes - totalLegacyDataUrlChars + attachments.length * avgRefBytes
  );

  const nearLimit = initialBytes > PORTFOLIO_DOC_SAFE_BYTES * 0.8;
  const blocked = initialBytes > PORTFOLIO_DOC_SAFE_BYTES;

  return {
    userId,
    initialBytes,
    estimatedFinalBytes,
    totalLegacyDataUrlChars,
    totalLegacyBinaryBytes,
    legacyCount: attachments.length,
    attachments,
    nearLimit,
    blocked,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function inventoryReport(inv: MigrationInventory): string {
  return [
    `Usuario: ${inv.userId}`,
    `Tamaño inicial: ${formatBytes(inv.initialBytes)} (${inv.initialBytes} bytes)`,
    `Tamaño estimado final: ${formatBytes(inv.estimatedFinalBytes)} (${inv.estimatedFinalBytes} bytes)`,
    `Adjuntos históricos Base64: ${inv.legacyCount}`,
    `Total caracteres Base64 en documento: ${formatBytes(inv.totalLegacyDataUrlChars)}`,
    `Total binario real: ${formatBytes(inv.totalLegacyBinaryBytes)}`,
    `Cerca del límite: ${inv.nearLimit ? "sí" : "no"}`,
    `Bloqueado (> safe): ${inv.blocked ? "sí" : "no"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reescritura pura del portfolio (sin I/O): sustituye data URLs por referencias
// ---------------------------------------------------------------------------

export function rewritePortfolioWithReferences(
  portfolio: AppState,
  inventory: MigrationInventory
): AppState {
  const pathByExpenseId = new Map<string, LegacyAttachmentRecord>();
  const pathByDocId = new Map<string, LegacyAttachmentRecord>();
  for (const a of inventory.attachments) {
    if (a.kind === "expense-receipt") pathByExpenseId.set(a.expenseId!, a);
    else pathByDocId.set(a.docId!, a);
  }

  const newExpenses = (portfolio.expenses || []).map((exp) => {
    const rec = pathByExpenseId.get(exp.id);
    if (!rec) return exp;
    // Conserva id, propertyId, amount, date, description, etc. Sustituye solo adjunto.
    return {
      ...exp,
      receiptUrl: undefined,
      receiptPath: rec.storagePath,
      receiptName: rec.fileName,
      receiptType: rec.contentType,
    };
  });

  const newProperties = (portfolio.properties || []).map((prop) => {
    const newDocs = (prop.documents || []).map((doc) => {
      const rec = pathByDocId.get(doc.id);
      if (!rec) return doc;
      return {
        ...doc,
        fileData: undefined,
        storagePath: rec.storagePath,
        name: rec.fileName,
        contentType: rec.contentType,
      };
    });
    return { ...prop, documents: newDocs };
  });

  return {
    ...portfolio,
    expenses: newExpenses,
    properties: newProperties,
  };
}

// ---------------------------------------------------------------------------
// Validaciones puras
// ---------------------------------------------------------------------------

export function assertNoDataUrls(portfolio: AppState): string[] {
  const found: string[] = [];
  for (const exp of portfolio.expenses || []) {
    if (isDataUrl(exp.receiptUrl)) found.push(`expenses.${exp.id}.receiptUrl`);
  }
  for (const prop of portfolio.properties || []) {
    for (const doc of prop.documents || []) {
      if (isDataUrl(doc.fileData)) found.push(`properties.${prop.id}.documents.${doc.id}.fileData`);
    }
  }
  return found;
}

export function calculatePortfolioSize(portfolio: AppState): { bytes: number; blocked: boolean; nearLimit: boolean } {
  const bytes = estimatePayloadBytes(portfolioBody(portfolio));
  return {
    bytes,
    blocked: bytes > PORTFOLIO_DOC_SAFE_BYTES,
    nearLimit: bytes > PORTFOLIO_DOC_SAFE_BYTES * 0.8,
  };
}

// ---------------------------------------------------------------------------
// Adaptador de Storage (interfaz para real y para pruebas)
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  uploadBytes(storagePath: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getBytes(storagePath: string): Promise<Uint8Array>;
  exists?(storagePath: string): Promise<boolean>;
}

export interface FirestoreAdapter {
  getPortfolio(userId: string): Promise<{ portfolio: AppState; updatedAt?: string } | null>;
  setPortfolio(userId: string, portfolio: AppState, expectedUpdatedAt?: string): Promise<{ updatedAt: string }>;
  createBackup?(userId: string, portfolio: AppState): Promise<string>;
}

// ---------------------------------------------------------------------------
// Fases de migración con I/O
// ---------------------------------------------------------------------------

export async function runUploadPhase(
  inventory: MigrationInventory,
  storage: StorageAdapter,
  onProgress?: (p: MigrationProgress) => void
): Promise<{ results: UploadResult[]; errors: Array<{ attachmentId: string; error: string }> }> {
  const results: UploadResult[] = [];
  const errors: Array<{ attachmentId: string; error: string }> = [];
  let uploaded = 0;
  let verified = 0;

  for (const att of inventory.attachments) {
    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) {
      const err = `No se pudo decodificar data URL de ${att.attachmentId}`;
      errors.push({ attachmentId: att.attachmentId, error: err });
      results.push({ attachmentId: att.attachmentId, storagePath: att.storagePath, bytesUploaded: 0, verified: false, error: err });
      continue;
    }

    try {
      await storage.uploadBytes(att.storagePath, parsed.bytes, att.contentType);
      uploaded++;
      // Verificación: leer de vuelta y comparar tamaño y contenido
      const retrieved = await storage.getBytes(att.storagePath);
      if (retrieved.length !== parsed.bytes.length) {
        const err = `Verificación fallida: tamaño no coincide para ${att.attachmentId} (esperado ${parsed.bytes.length}, obtenido ${retrieved.length})`;
        errors.push({ attachmentId: att.attachmentId, error: err });
        results.push({ attachmentId: att.attachmentId, storagePath: att.storagePath, bytesUploaded: parsed.bytes.length, verified: false, error: err });
        continue;
      }
      // Comparación byte a byte (muestral para no ser costoso, pero aquí completo por seguridad)
      let mismatch = false;
      for (let i = 0; i < parsed.bytes.length; i++) {
        if (parsed.bytes[i] !== retrieved[i]) { mismatch = true; break; }
      }
      if (mismatch) {
        const err = `Verificación fallida: contenido no coincide para ${att.attachmentId}`;
        errors.push({ attachmentId: att.attachmentId, error: err });
        results.push({ attachmentId: att.attachmentId, storagePath: att.storagePath, bytesUploaded: parsed.bytes.length, verified: false, error: err });
        continue;
      }
      verified++;
      results.push({ attachmentId: att.attachmentId, storagePath: att.storagePath, bytesUploaded: parsed.bytes.length, verified: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ attachmentId: att.attachmentId, error: msg });
      results.push({ attachmentId: att.attachmentId, storagePath: att.storagePath, bytesUploaded: 0, verified: false, error: msg });
    }

    if (onProgress) {
      onProgress({
        phase: "upload",
        total: inventory.attachments.length,
        uploaded,
        verified,
        errors: [...errors],
        pending: inventory.attachments.slice(uploaded + errors.length),
      });
    }
  }

  return { results, errors };
}

export async function runFullMigrationDryRun(
  portfolio: AppState,
  userId: string
): Promise<MigrationInventory> {
  return buildInventory(portfolio, userId);
}

export async function runFullMigration(
  portfolio: AppState,
  userId: string,
  storage: StorageAdapter,
  opts?: { onProgress?: (p: MigrationProgress) => void }
): Promise<MigrationResult> {
  const inventory = buildInventory(portfolio, userId);
  const { results, errors } = await runUploadPhase(inventory, storage, opts?.onProgress);

  if (errors.length > 0) {
    return {
      inventory,
      uploadResults: results,
      migratedPortfolio: null,
      finalBytes: null,
      success: false,
      errors,
    };
  }

  const migrated = rewritePortfolioWithReferences(portfolio, inventory);
  const finalSize = calculatePortfolioSize(migrated);
  // Verificación final: no debe quedar ninguna data URL
  const remaining = assertNoDataUrls(migrated);
  if (remaining.length > 0) {
    return {
      inventory,
      uploadResults: results,
      migratedPortfolio: null,
      finalBytes: finalSize.bytes,
      success: false,
      errors: remaining.map((r) => ({ attachmentId: r, error: "Queda data URL tras reescritura" })),
    };
  }

  return {
    inventory,
    uploadResults: results,
    migratedPortfolio: migrated,
    finalBytes: finalSize.bytes,
    success: true,
    errors: [],
  };
}

// Protección contra sobrescritura concurrente
export function checkConcurrentChange(currentUpdatedAt: string | undefined, expectedUpdatedAt: string | undefined): boolean {
  if (!expectedUpdatedAt) return false; // sin referencia previa, no se puede detectar
  if (!currentUpdatedAt) return true; // si no hay actual, asumimos cambio
  return currentUpdatedAt !== expectedUpdatedAt;
}
