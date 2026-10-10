/**
 * movementService.ts
 *
 * Servicio de persistencia duradera para movimientos contables (gastos e ingresos)
 * en Cloud Firestore.
 *
 * Arquitectura:
 * - Subcolección dedicada por usuario: `users/{userId}/expenses/{movementId}`
 * - Cada movimiento es un documento independiente en Firestore, eliminando
 *   la limitación del tamaño máximo de 1 MiB del documento central de cartera.
 * - Operaciones idempotentes: creación, edición, borrado e importación por lotes.
 * - Conciliación segura contra respuestas vacías o sincronizaciones parciales.
 * - Preservación estricta de referencias a Firebase Storage (receiptPath).
 */

import { PropertyExpense } from "../types";
import { normalizeDateToIso } from "./dateUtils";
import { 
  collection, 
  doc, 
  getDocs, 
  setDoc, 
  deleteDoc, 
  writeBatch, 
  onSnapshot, 
  Firestore 
} from "firebase/firestore";
import { db as defaultDb, auth } from "./firebase";

function resolveDb(provided?: Firestore): Firestore {
  return provided || defaultDb;
}

export interface MovementValidationResult {
  valid: boolean;
  errors: string[];
}

export interface MovementSaveResult {
  ok: boolean;
  movement?: PropertyExpense;
  error?: string;
  code?: string;
}

export interface MovementBatchResult {
  ok: boolean;
  savedCount: number;
  skippedCount: number;
  errors: string[];
}

/**
 * Genera la firma contable de un movimiento para deduplicación semántica
 */
export function movementSignature(m: PropertyExpense): string {
  const normDate = normalizeDateToIso(m.date) || m.date;
  const t = m.type || (m.category === "rent" ? "ingreso" : "gasto");
  return `${m.propertyId}__${normDate}__${m.category}__${Number(m.amount).toFixed(2)}__${t}`;
}

/**
 * Valida un movimiento antes de permitir su escritura en Firestore
 */
export function validateMovement(movement: Partial<PropertyExpense>): MovementValidationResult {
  const errors: string[] = [];

  if (!movement.id || typeof movement.id !== "string" || movement.id.trim() === "") {
    errors.push("El identificador del movimiento es obligatorio y debe ser un texto no vacío.");
  }

  if (!movement.propertyId || typeof movement.propertyId !== "string" || movement.propertyId.trim() === "") {
    errors.push("Debe asociarse a un inmueble válido (propertyId obligatorio).");
  }

  const amt = Number(movement.amount);
  if (isNaN(amt) || amt <= 0) {
    errors.push("El importe debe ser un número estrictamente mayor que cero.");
  }

  if (!movement.date || typeof movement.date !== "string") {
    errors.push("La fecha es obligatoria.");
  } else {
    const normDate = normalizeDateToIso(movement.date);
    if (!normDate) {
      errors.push(`Formato de fecha inválido (${movement.date}). Debe ser una fecha válida.`);
    }
  }

  // Protección de tamaño: no permitir inserción de cadenas Base64 gigantes en Firestore
  if (movement.receiptUrl && typeof movement.receiptUrl === "string" && movement.receiptUrl.startsWith("data:")) {
    if (movement.receiptUrl.length > 2048) {
      errors.push("Los justificantes deben subirse a Firebase Storage (receiptPath), no incrustarse como Base64 en Firestore.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Prepara un objeto PropertyExpense para ser almacenado de forma limpia en Firestore
 */
export function sanitizeMovementForFirestore(
  movement: PropertyExpense,
  userId: string,
  ownerUid?: string
): Record<string, any> {
  const normDate = normalizeDateToIso(movement.date) || movement.date;
  const t = movement.type || (movement.category === "rent" ? "ingreso" : "gasto");

  const docData: Record<string, any> = {
    id: movement.id,
    userId,
    ownerUid: ownerUid || auth?.currentUser?.uid || userId,
    propertyId: movement.propertyId,
    category: movement.category,
    type: t,
    amount: Number(movement.amount),
    date: normDate,
    updatedAt: new Date().toISOString(),
  };

  if (movement.description) docData.description = movement.description.trim();
  if (movement.receiptPath) docData.receiptPath = movement.receiptPath;
  if (movement.receiptName) docData.receiptName = movement.receiptName;
  if (movement.receiptType) docData.receiptType = movement.receiptType;
  if (movement.receiptUrl && !movement.receiptPath) docData.receiptUrl = movement.receiptUrl;

  return docData;
}

/**
 * Guarda o actualiza un movimiento contable en la subcolección de Firestore de forma atómica e idempotente
 */
export async function saveMovement(
  userId: string,
  movement: PropertyExpense,
  firestore?: Firestore
): Promise<MovementSaveResult> {
  if (!userId || typeof userId !== "string") {
    return { ok: false, error: "Identificador de usuario no válido para guardar en Firestore." };
  }

  const validation = validateMovement(movement);
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join(" ") };
  }

  try {
    const db = resolveDb(firestore);
    const docRef = doc(db, "users", userId, "expenses", movement.id);
    const dataToSave = sanitizeMovementForFirestore(movement, userId);

    await setDoc(docRef, dataToSave, { merge: true });

    return {
      ok: true,
      movement: {
        ...movement,
        date: dataToSave.date,
        type: dataToSave.type,
      },
    };
  } catch (err: any) {
    const code = err?.code || "unknown";
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[movementService] Error al guardar movimiento ${movement.id}:`, err);
    return {
      ok: false,
      code,
      error: `Error al persistir en Firestore: ${msg}`,
    };
  }
}

/**
 * Elimina un movimiento contable de la subcolección de Firestore
 */
export async function deleteMovement(
  userId: string,
  movementId: string,
  firestore?: Firestore
): Promise<{ ok: boolean; error?: string }> {
  if (!userId || !movementId) {
    return { ok: false, error: "Parámetros insuficientes para eliminar el movimiento." };
  }

  try {
    const db = await resolveDb(firestore);
    const docRef = doc(db, "users", userId, "expenses", movementId);
    await deleteDoc(docRef);
    return { ok: true };
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[movementService] Error al eliminar movimiento ${movementId}:`, err);
    return { ok: false, error: `Error al eliminar de Firestore: ${msg}` };
  }
}

/**
 * Consulta todos los movimientos persistidos de un usuario en Firestore
 */
export async function fetchMovements(
  userId: string,
  firestore?: Firestore
): Promise<PropertyExpense[]> {
  if (!userId) return [];

  try {
    const db = await resolveDb(firestore);
    const expensesCol = collection(db, "users", userId, "expenses");
    const snapshot = await getDocs(expensesCol);

    const movements: PropertyExpense[] = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      movements.push({
        id: data.id || docSnap.id,
        propertyId: data.propertyId,
        category: data.category,
        amount: Number(data.amount),
        date: data.date,
        description: data.description,
        receiptPath: data.receiptPath,
        receiptName: data.receiptName,
        receiptType: data.receiptType,
        receiptUrl: data.receiptUrl,
        type: data.type || (data.category === "rent" ? "ingreso" : "gasto"),
      });
    });

    // Ordenar de forma descendente por fecha
    return movements.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  } catch (err) {
    console.error(`[movementService] Error al consultar movimientos de ${userId}:`, err);
    throw err;
  }
}

/**
 * Suscribe un listener en tiempo real a los movimientos de la subcolección de Firestore
 */
export function subscribeMovements(
  userId: string,
  onUpdate: (movements: PropertyExpense[]) => void,
  onError: (err: any) => void,
  firestore?: Firestore
): () => void {
  if (!userId) {
    return () => {};
  }

  const db = resolveDb(firestore);
  const expensesCol = collection(db, "users", userId, "expenses");

  return onSnapshot(
    expensesCol,
    (snapshot) => {
      const movements: PropertyExpense[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        movements.push({
          id: data.id || docSnap.id,
          propertyId: data.propertyId,
          category: data.category,
          amount: Number(data.amount),
          date: data.date,
          description: data.description,
          receiptPath: data.receiptPath,
          receiptName: data.receiptName,
          receiptType: data.receiptType,
          receiptUrl: data.receiptUrl,
          type: data.type || (data.category === "rent" ? "ingreso" : "gasto"),
        });
      });
      movements.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
      onUpdate(movements);
    },
    (err) => {
      console.error(`[movementService] Error en snapshot de movimientos para ${userId}:`, err);
      onError(err);
    }
  );
}

/**
 * Guarda un lote de movimientos contables de forma atómica e idempotente
 */
export async function batchSaveMovements(
  userId: string,
  movements: PropertyExpense[],
  firestore?: Firestore
): Promise<MovementBatchResult> {
  if (!userId || movements.length === 0) {
    return { ok: true, savedCount: 0, skippedCount: 0, errors: [] };
  }

  const errors: string[] = [];
  let savedCount = 0;
  let skippedCount = 0;

  // Deduplicación previa dentro del propio lote para evitar operaciones redundantes
  const uniqueMovements: PropertyExpense[] = [];
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();

  for (const m of movements) {
    const val = validateMovement(m);
    if (!val.valid) {
      errors.push(`Movimiento ${m.id || "sin-id"} inválido: ${val.errors.join(", ")}`);
      skippedCount++;
      continue;
    }

    const sig = movementSignature(m);
    if (seenIds.has(m.id) || seenSignatures.has(sig)) {
      skippedCount++;
      continue;
    }

    seenIds.add(m.id);
    seenSignatures.add(sig);
    uniqueMovements.push(m);
  }

  const db = resolveDb(firestore);

  // Firestore soporta hasta 500 operaciones por lote
  const CHUNK_SIZE = 450;
  for (let i = 0; i < uniqueMovements.length; i += CHUNK_SIZE) {
    const chunk = uniqueMovements.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);

    for (const mov of chunk) {
      const docRef = doc(db, "users", userId, "expenses", mov.id);
      const data = sanitizeMovementForFirestore(mov, userId);
      batch.set(docRef, data, { merge: true });
    }

    try {
      await batch.commit();
      savedCount += chunk.length;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Error en lote [${i}..${i + chunk.length}]: ${msg}`);
    }
  }

  return {
    ok: errors.length === 0,
    savedCount,
    skippedCount,
    errors,
  };
}

// Reconciliación pura y no destructiva entre movimientos locales y remotos
export function reconcileMovements(
  localMovements: PropertyExpense[] = [],
  remoteMovements: PropertyExpense[] = []
): PropertyExpense[] {
  // Si la respuesta remota está vacía pero tenemos movimientos locales, conservamos los locales ordenados
  if (remoteMovements.length === 0 && localMovements.length > 0) {
    return [...localMovements].sort((a, b) =>
      b.date > a.date ? 1 : b.date < a.date ? -1 : 0
    );
  }

  const resultMap = new Map<string, PropertyExpense>();
  const signatureMap = new Map<string, string>(); // signature -> id

  // 1. Incorporar primero todos los movimientos remotos (fuente de verdad confirmada)
  for (const rem of remoteMovements) {
    const norm: PropertyExpense = {
      ...rem,
      date: normalizeDateToIso(rem.date) || rem.date,
      type: rem.type || (rem.category === "rent" ? "ingreso" : "gasto"),
    };
    resultMap.set(norm.id, norm);
    signatureMap.set(movementSignature(norm), norm.id);
  }

  // 2. Incorporar movimientos locales que aún no estén en el servidor (ej. creados offline o pendientes)
  for (const loc of localMovements) {
    const normLoc: PropertyExpense = {
      ...loc,
      date: normalizeDateToIso(loc.date) || loc.date,
      type: loc.type || (loc.category === "rent" ? "ingreso" : "gasto"),
    };

    const existingById = resultMap.get(normLoc.id);
    const sig = movementSignature(normLoc);
    const existingBySig = signatureMap.has(sig);

    if (!existingById && !existingBySig) {
      // Movimiento local nuevo que todavía no ha sido confirmado por el servidor -> conservar
      resultMap.set(normLoc.id, normLoc);
      signatureMap.set(sig, normLoc.id);
    } else if (existingById) {
      // Si el local tiene un justificante recién añadido y el remoto no lo tiene aún, conservarlo
      if (normLoc.receiptPath && !existingById.receiptPath) {
        existingById.receiptPath = normLoc.receiptPath;
        existingById.receiptName = normLoc.receiptName;
        existingById.receiptType = normLoc.receiptType;
      }
    }
  }

  return Array.from(resultMap.values()).sort((a, b) =>
    b.date > a.date ? 1 : b.date < a.date ? -1 : 0
  );
}

/**
 * Migra de forma transparente e idempotente los gastos históricos que estuvieran
 * en el documento único de cartera (portfolio.expenses) hacia la subcolección dedicada.
 */
export async function migrateLegacyPortfolioExpenses(
  userId: string,
  portfolioExpenses: PropertyExpense[] = [],
  firestore?: Firestore
): Promise<{ migratedCount: number; skippedCount: number; errors: string[] }> {
  if (!userId || portfolioExpenses.length === 0) {
    return { migratedCount: 0, skippedCount: 0, errors: [] };
  }

  try {
    const db = resolveDb(firestore);
    // 1. Leer los movimientos ya existentes en la subcolección
    const existing = await fetchMovements(userId, db);
    const existingIds = new Set(existing.map((e) => e.id));
    const existingSignatures = new Set(existing.map(movementSignature));

    // 2. Filtrar únicamente los que faltan en la subcolección
    const toMigrate: PropertyExpense[] = [];
    let skippedCount = 0;

    for (const pExp of portfolioExpenses) {
      const sig = movementSignature(pExp);
      if (existingIds.has(pExp.id) || existingSignatures.has(sig)) {
        skippedCount++;
      } else {
        toMigrate.push(pExp);
      }
    }

    if (toMigrate.length === 0) {
      return { migratedCount: 0, skippedCount, errors: [] };
    }

    // 3. Guardar por lotes sin alterar nada existente
    const batchRes = await batchSaveMovements(userId, toMigrate, db);

    return {
      migratedCount: batchRes.savedCount,
      skippedCount: skippedCount + batchRes.skippedCount,
      errors: batchRes.errors,
    };
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[movementService] Error al migrar gastos históricos de ${userId}:`, err);
    return {
      migratedCount: 0,
      skippedCount: 0,
      errors: [msg],
    };
  }
}
