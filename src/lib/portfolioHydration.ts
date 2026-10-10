/**
 * Lógica pura de hidratación y reconciliación de la cartera entre la nube y el cliente local.
 * 
 * Reglas de hidratación:
 * 1. Si la nube devuelve registros válidos, son la fuente remota de verdad para esos IDs.
 * 2. Si el cliente local tiene movimientos adicionales no sincronizados aún con la nube,
 *    se conservan y se integran (no se descartan).
 * 3. Si la nube devuelve un array vacío (por purga o documento nuevo) pero el cliente local
 *    tiene movimientos válidos retenidos, se preservan los movimientos locales para evitar
 *    aniquilación de datos por falsos vacíos.
 */

import { Property, PropertyExpense } from "../types";

export function mergeExpensesOnHydration(
  cloudExpenses?: PropertyExpense[],
  localExpenses?: PropertyExpense[]
): PropertyExpense[] {
  if (!cloudExpenses || cloudExpenses.length === 0) {
    return localExpenses || [];
  }
  if (!localExpenses || localExpenses.length === 0) {
    return cloudExpenses;
  }
  const cloudIds = new Set(cloudExpenses.map((e) => e.id));
  const localPending = localExpenses.filter((e) => !cloudIds.has(e.id));
  return [...cloudExpenses, ...localPending];
}

export function mergePropertiesOnHydration(
  cloudProps?: Property[],
  localProps?: Property[]
): Property[] {
  if (!cloudProps || cloudProps.length === 0) {
    return localProps || [];
  }
  if (!localProps || localProps.length === 0) {
    return cloudProps;
  }
  const cloudIds = new Set(cloudProps.map((p) => p.id));
  const localPending = localProps.filter((p) => !cloudIds.has(p.id));
  return [...cloudProps, ...localPending];
}
