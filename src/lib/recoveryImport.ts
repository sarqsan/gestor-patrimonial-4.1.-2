/**
 * Módulo de recuperación segura de movimientos históricos.
 *
 * Principios:
 * 1. Fusión no destructiva: los movimientos actuales se conservan 100% intactos
 *    (nada creado o modificado posteriormente se borra).
 * 2. Deduplicación estricta por ID y firma contable (inmueble + fecha + categoría + importe + tipo).
 * 3. Preservación y enriquecimiento de justificantes: si un gasto actual perdió su recibo
 *    pero el backup lo tenía, se restaura la referencia de Storage o URL sin duplicar el apunte.
 * 4. Pura en memoria: no ejecuta escrituras automáticas en producción.
 */

import { AppState, PropertyExpense } from "../types";
import { normalizeDateToIso } from "./dateUtils";
import { hasReceipt, isInlineDataUrl } from "./attachmentRules";

export interface RecoveryItemDetail {
  id: string;
  propertyId: string;
  category: string;
  type: "gasto" | "ingreso";
  amount: number;
  date: string;
  description?: string;
  receiptStatus: "storage-reference" | "legacy-base64" | "none";
  action: "keep-current" | "restore-missing" | "skip-duplicate" | "enrich-receipt";
}

export interface RecoveryPlan {
  totalBackupExpenses: number;
  totalCurrentExpenses: number;
  restoredCount: number;
  keptCurrentCount: number;
  skippedDuplicatesCount: number;
  enrichedReceiptsCount: number;
  resultingTotalExpenses: number;
  hasLegacyBase64Receipts: boolean;
  warnings: string[];
  items: RecoveryItemDetail[];
}

function expenseSignature(e: PropertyExpense): string {
  const normDate = normalizeDateToIso(e.date) || e.date;
  const t = e.type || (e.category === "rent" ? "ingreso" : "gasto");
  return `${e.propertyId}__${normDate}__${e.category}__${e.amount}__${t}`;
}

function getReceiptStatus(e: PropertyExpense): "storage-reference" | "legacy-base64" | "none" {
  if (e.receiptPath) return "storage-reference";
  if (isInlineDataUrl(e.receiptUrl)) return "legacy-base64";
  if (e.receiptUrl) return "storage-reference"; // URL externa / storage download URL
  return "none";
}

/**
 * Analiza en modo de solo lectura la cartera actual frente a una instantánea de backup
 * y produce un plan detallado de recuperación.
 */
export function planRecoveryMerge(
  currentExpenses: PropertyExpense[] = [],
  backupExpenses: PropertyExpense[] = []
): RecoveryPlan {
  const currentById = new Map<string, PropertyExpense>();
  const currentBySig = new Map<string, PropertyExpense>();

  for (const exp of currentExpenses) {
    currentById.set(exp.id, exp);
    currentBySig.set(expenseSignature(exp), exp);
  }

  const items: RecoveryItemDetail[] = [];
  const warnings: string[] = [];
  let restoredCount = 0;
  let skippedDuplicatesCount = 0;
  let enrichedReceiptsCount = 0;
  let hasLegacyBase64Receipts = false;

  // 1. Marcar todos los gastos actuales como conservados
  for (const cur of currentExpenses) {
    items.push({
      id: cur.id,
      propertyId: cur.propertyId,
      category: cur.category,
      type: cur.type || "gasto",
      amount: cur.amount,
      date: cur.date,
      description: cur.description,
      receiptStatus: getReceiptStatus(cur),
      action: "keep-current",
    });
  }

  // 2. Evaluar cada gasto del backup
  for (const bkp of backupExpenses) {
    const rStatus = getReceiptStatus(bkp);
    if (rStatus === "legacy-base64") {
      hasLegacyBase64Receipts = true;
    }

    const matchById = currentById.get(bkp.id);
    const matchBySig = currentBySig.get(expenseSignature(bkp));
    const existing = matchById || matchBySig;

    if (existing) {
      // Duplicado encontrado
      if (!hasReceipt(existing) && hasReceipt(bkp)) {
        // Enriquecer: el gasto actual no tiene justificante pero la copia histórica sí
        enrichedReceiptsCount++;
        items.push({
          id: bkp.id,
          propertyId: bkp.propertyId,
          category: bkp.category,
          type: bkp.type || "gasto",
          amount: bkp.amount,
          date: bkp.date,
          description: bkp.description,
          receiptStatus: rStatus,
          action: "enrich-receipt",
        });
      } else {
        skippedDuplicatesCount++;
        items.push({
          id: bkp.id,
          propertyId: bkp.propertyId,
          category: bkp.category,
          type: bkp.type || "gasto",
          amount: bkp.amount,
          date: bkp.date,
          description: bkp.description,
          receiptStatus: rStatus,
          action: "skip-duplicate",
        });
      }
    } else {
      // Gasto histórico ausente en la cartera actual -> restaurar
      restoredCount++;
      items.push({
        id: bkp.id,
        propertyId: bkp.propertyId,
        category: bkp.category,
        type: bkp.type || "gasto",
        amount: bkp.amount,
        date: bkp.date,
        description: bkp.description,
        receiptStatus: rStatus,
        action: "restore-missing",
      });
    }
  }

  if (hasLegacyBase64Receipts) {
    warnings.push(
      "El backup contiene justificantes en formato Base64 histórico. Al recuperar, se conservarán sus metadatos sin superar el límite de Firestore."
    );
  }

  return {
    totalBackupExpenses: backupExpenses.length,
    totalCurrentExpenses: currentExpenses.length,
    restoredCount,
    keptCurrentCount: currentExpenses.length,
    skippedDuplicatesCount,
    enrichedReceiptsCount,
    resultingTotalExpenses: currentExpenses.length + restoredCount,
    hasLegacyBase64Receipts,
    warnings,
    items,
  };
}

/**
 * Ejecuta en memoria la fusión de la cartera actual con el backup, sin modificar producción.
 */
export function executeRecoveryMerge(
  currentExpenses: PropertyExpense[] = [],
  backupExpenses: PropertyExpense[] = []
): { mergedExpenses: PropertyExpense[]; plan: RecoveryPlan } {
  const plan = planRecoveryMerge(currentExpenses, backupExpenses);

  const currentById = new Map<string, PropertyExpense>();
  const currentBySig = new Map<string, PropertyExpense>();

  // Clon profundo inmutable
  const result: PropertyExpense[] = currentExpenses.map((e) => ({ ...e }));

  for (let i = 0; i < result.length; i++) {
    currentById.set(result[i].id, result[i]);
    currentBySig.set(expenseSignature(result[i]), result[i]);
  }

  for (const bkp of backupExpenses) {
    const matchById = currentById.get(bkp.id);
    const matchBySig = currentBySig.get(expenseSignature(bkp));
    const existing = matchById || matchBySig;

    if (existing) {
      // Si el existente no tiene recibo y el del backup sí, enriquecerlo
      if (!hasReceipt(existing) && hasReceipt(bkp)) {
        if (bkp.receiptPath) existing.receiptPath = bkp.receiptPath;
        if (bkp.receiptName) existing.receiptName = bkp.receiptName;
        if (bkp.receiptType) existing.receiptType = bkp.receiptType;
        if (bkp.receiptUrl && !existing.receiptPath) existing.receiptUrl = bkp.receiptUrl;
      }
    } else {
      // Añadir movimiento histórico ausente
      const restored: PropertyExpense = {
        ...bkp,
        date: normalizeDateToIso(bkp.date) || bkp.date,
      };
      result.push(restored);
      currentById.set(restored.id, restored);
      currentBySig.set(expenseSignature(restored), restored);
    }
  }

  return {
    mergedExpenses: result,
    plan,
  };
}
