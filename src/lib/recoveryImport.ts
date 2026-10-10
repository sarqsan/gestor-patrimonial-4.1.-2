/**
 * Módulo de recuperación segura de movimientos históricos.
 *
 * Principios:
 * 1. Fusión no destructiva: los movimientos actuales se conservan 100% intactos
 *    (nada creado o modificado posteriormente se borra).
 * 2. Deduplicación estricta por ID y firma contable normalizada.
 * 3. Detección de ambigüedades: discrepancias entre backup y cartera actual
 *    se marcan para revisión manual en lugar de fusionarse o descartarse a ciegas.
 * 4. Preservación y enriquecimiento de justificantes: clasifica referencias
 *    recuperables (Storage o Base64) y no verificables.
 * 5. Pura en memoria: solo lectura para simulaciones, sin escrituras en producción.
 */

import { PropertyExpense } from "../types";
import { normalizeDateToIso } from "./dateUtils";
import { hasReceipt, isInlineDataUrl } from "./attachmentRules";

export type RecoveryItemAction =
  | "keep-current"        // Movimiento actual que se conserva
  | "restore-missing"     // Movimiento del backup ausente que se recuperará
  | "skip-duplicate"      // Duplicado exacto del backup que se omitirá
  | "enrich-receipt"      // Movimiento actual que recuperará su justificante del backup
  | "ambiguous-review";   // Conflicto o discrepancia marcado para revisión humana

export interface RecoveryItemDetail {
  id: string;
  propertyId: string;
  category: string;
  type: "gasto" | "ingreso";
  amount: number;
  date: string;
  description?: string;
  receiptStatus: "storage-reference" | "legacy-base64" | "unverifiable" | "none";
  action: RecoveryItemAction;
  source: "current" | "backup";
  ambiguityReason?: string;
}

export interface FinancialSummary {
  incomes: number;
  expenses: number;
  net: number;
}

export interface RecoveryPlan {
  totalBackupExpenses: number;
  totalCurrentExpenses: number;
  restoredCount: number;
  keptCurrentCount: number;
  skippedDuplicatesCount: number;
  enrichedReceiptsCount: number;
  ambiguousCount: number;
  resultingTotalExpenses: number;
  
  // Justificantes
  recoverableReceiptsCount: number;
  unverifiableReceiptsCount: number;
  hasLegacyBase64Receipts: boolean;

  // Fechas extremas
  minDateBackup: string | null;
  maxDateBackup: string | null;

  // Resumen económico comparativo
  currentFinancials: FinancialSummary;
  simulatedFinancials: FinancialSummary;
  differenceFinancials: FinancialSummary;

  warnings: string[];
  items: RecoveryItemDetail[];
}

function expenseSignature(e: PropertyExpense): string {
  const normDate = normalizeDateToIso(e.date) || e.date;
  const t = e.type || (e.category === "rent" ? "ingreso" : "gasto");
  return `${e.propertyId}__${normDate}__${e.category}__${e.amount}__${t}`;
}

function isIncome(e: PropertyExpense): boolean {
  return e.type === "ingreso" || e.category === "rent";
}

function getReceiptStatus(e: PropertyExpense): "storage-reference" | "legacy-base64" | "unverifiable" | "none" {
  if (e.receiptPath) {
    // Referencia válida en Firebase Storage
    if (typeof e.receiptPath === "string" && e.receiptPath.startsWith("users/")) {
      return "storage-reference";
    }
    return "unverifiable";
  }
  const url = e.receiptUrl;
  if (typeof url === "string" && url) {
    if (url.startsWith("data:")) return "legacy-base64";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return "storage-reference"; // URL externa válida
    }
    return "unverifiable";
  }
  return "none";
}

/**
 * Planifica y simula la recuperación comparando la cartera actual frente al backup.
 * Función pura que no escribe nada en Firestore ni en Storage.
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
  let ambiguousCount = 0;
  let recoverableReceiptsCount = 0;
  let unverifiableReceiptsCount = 0;
  let hasLegacyBase64Receipts = false;

  let minDateBackup: string | null = null;
  let maxDateBackup: string | null = null;

  // 1. Conservar todos los gastos actuales
  for (const cur of currentExpenses) {
    const rStatus = getReceiptStatus(cur);
    if (rStatus === "storage-reference" || rStatus === "legacy-base64") recoverableReceiptsCount++;
    if (rStatus === "unverifiable") unverifiableReceiptsCount++;

    items.push({
      id: cur.id,
      propertyId: cur.propertyId,
      category: cur.category,
      type: isIncome(cur) ? "ingreso" : "gasto",
      amount: cur.amount,
      date: normalizeDateToIso(cur.date) || cur.date,
      description: cur.description,
      receiptStatus: rStatus,
      action: "keep-current",
      source: "current",
    });
  }

  // 2. Analizar apuntes del backup
  for (const bkp of backupExpenses) {
    const normDate = normalizeDateToIso(bkp.date) || bkp.date;
    if (!minDateBackup || normDate < minDateBackup) minDateBackup = normDate;
    if (!maxDateBackup || normDate > maxDateBackup) maxDateBackup = normDate;

    const rStatus = getReceiptStatus(bkp);
    if (rStatus === "legacy-base64") hasLegacyBase64Receipts = true;
    if (rStatus === "storage-reference" || rStatus === "legacy-base64") recoverableReceiptsCount++;
    if (rStatus === "unverifiable") unverifiableReceiptsCount++;

    const matchById = currentById.get(bkp.id);
    const matchBySig = currentBySig.get(expenseSignature(bkp));

    // Detección de ambigüedad: mismo ID pero importes o inmuebles contradictorios
    if (matchById && matchById.amount !== bkp.amount) {
      ambiguousCount++;
      items.push({
        id: bkp.id,
        propertyId: bkp.propertyId,
        category: bkp.category,
        type: isIncome(bkp) ? "ingreso" : "gasto",
        amount: bkp.amount,
        date: normDate,
        description: bkp.description,
        receiptStatus: rStatus,
        action: "ambiguous-review",
        source: "backup",
        ambiguityReason: `Mismo ID (${bkp.id}) pero importe discrepante: actual ${matchById.amount} € vs backup ${bkp.amount} €. Requiere revisión humana.`,
      });
      continue;
    }

    const existing = matchById || matchBySig;

    if (existing) {
      // Duplicado exacto
      if (!hasReceipt(existing) && hasReceipt(bkp)) {
        enrichedReceiptsCount++;
        items.push({
          id: bkp.id,
          propertyId: bkp.propertyId,
          category: bkp.category,
          type: isIncome(bkp) ? "ingreso" : "gasto",
          amount: bkp.amount,
          date: normDate,
          description: bkp.description,
          receiptStatus: rStatus,
          action: "enrich-receipt",
          source: "backup",
        });
      } else {
        skippedDuplicatesCount++;
        items.push({
          id: bkp.id,
          propertyId: bkp.propertyId,
          category: bkp.category,
          type: isIncome(bkp) ? "ingreso" : "gasto",
          amount: bkp.amount,
          date: normDate,
          description: bkp.description,
          receiptStatus: rStatus,
          action: "skip-duplicate",
          source: "backup",
        });
      }
    } else {
      // Movimiento histórico ausente -> recuperar
      restoredCount++;
      items.push({
        id: bkp.id,
        propertyId: bkp.propertyId,
        category: bkp.category,
        type: isIncome(bkp) ? "ingreso" : "gasto",
        amount: bkp.amount,
        date: normDate,
        description: bkp.description,
        receiptStatus: rStatus,
        action: "restore-missing",
        source: "backup",
      });
    }
  }

  // Cálculos económicos
  const currentIncomes = currentExpenses.filter(isIncome).reduce((sum, e) => sum + e.amount, 0);
  const currentExpensesSum = currentExpenses.filter((e) => !isIncome(e)).reduce((sum, e) => sum + e.amount, 0);

  const restoredItems = items.filter((i) => i.action === "restore-missing");
  const restoredIncomes = restoredItems.filter((i) => i.type === "ingreso").reduce((sum, i) => sum + i.amount, 0);
  const restoredExpensesSum = restoredItems.filter((i) => i.type === "gasto").reduce((sum, i) => sum + i.amount, 0);

  const simulatedIncomes = currentIncomes + restoredIncomes;
  const simulatedExpensesSum = currentExpensesSum + restoredExpensesSum;

  if (hasLegacyBase64Receipts) {
    warnings.push("La copia contiene justificantes en Base64 histórico. La simulación no los escribe en Firestore.");
  }
  if (unverifiableReceiptsCount > 0) {
    warnings.push(`Se detectaron ${unverifiableReceiptsCount} comprobante(s) con formato o ruta no estándar.`);
  }
  if (ambiguousCount > 0) {
    warnings.push(`${ambiguousCount} apunte(s) presentan discrepancias y han sido marcados para revisión sin fusionar.`);
  }

  return {
    totalBackupExpenses: backupExpenses.length,
    totalCurrentExpenses: currentExpenses.length,
    restoredCount,
    keptCurrentCount: currentExpenses.length,
    skippedDuplicatesCount,
    enrichedReceiptsCount,
    ambiguousCount,
    resultingTotalExpenses: currentExpenses.length + restoredCount,
    recoverableReceiptsCount,
    unverifiableReceiptsCount,
    hasLegacyBase64Receipts,
    minDateBackup,
    maxDateBackup,
    currentFinancials: {
      incomes: currentIncomes,
      expenses: currentExpensesSum,
      net: currentIncomes - currentExpensesSum,
    },
    simulatedFinancials: {
      incomes: simulatedIncomes,
      expenses: simulatedExpensesSum,
      net: simulatedIncomes - simulatedExpensesSum,
    },
    differenceFinancials: {
      incomes: restoredIncomes,
      expenses: restoredExpensesSum,
      net: restoredIncomes - restoredExpensesSum,
    },
    warnings,
    items,
  };
}

/**
 * Fusión de simulación en memoria (devuelve el resultado sin persistir).
 */
export function executeRecoveryMerge(
  currentExpenses: PropertyExpense[] = [],
  backupExpenses: PropertyExpense[] = []
): { mergedExpenses: PropertyExpense[]; plan: RecoveryPlan } {
  const plan = planRecoveryMerge(currentExpenses, backupExpenses);

  const currentById = new Map<string, PropertyExpense>();
  const currentBySig = new Map<string, PropertyExpense>();

  const result: PropertyExpense[] = currentExpenses.map((e) => ({ ...e }));

  for (let i = 0; i < result.length; i++) {
    currentById.set(result[i].id, result[i]);
    currentBySig.set(expenseSignature(result[i]), result[i]);
  }

  for (const bkp of backupExpenses) {
    const matchById = currentById.get(bkp.id);
    const matchBySig = currentBySig.get(expenseSignature(bkp));

    // Si es ambiguo, jamás se fusiona automáticamente
    if (matchById && matchById.amount !== bkp.amount) {
      continue;
    }

    const existing = matchById || matchBySig;

    if (existing) {
      // Enriquecer recibo si faltaba
      if (!hasReceipt(existing) && hasReceipt(bkp)) {
        if (bkp.receiptPath) existing.receiptPath = bkp.receiptPath;
        if (bkp.receiptName) existing.receiptName = bkp.receiptName;
        if (bkp.receiptType) existing.receiptType = bkp.receiptType;
        if (bkp.receiptUrl && !existing.receiptPath) existing.receiptUrl = bkp.receiptUrl;
      }
    } else {
      // Restaurar movimiento ausente
      result.push({
        ...bkp,
        date: normalizeDateToIso(bkp.date) || bkp.date,
        type: isIncome(bkp) ? "ingreso" : "gasto",
      });
      currentById.set(bkp.id, bkp);
      currentBySig.set(expenseSignature(bkp), bkp);
    }
  }

  return {
    mergedExpenses: result,
    plan,
  };
}
