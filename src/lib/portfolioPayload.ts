// Payload del documento users/{usuario}/data/portfolio.
// Módulo puro (sin Firebase) para poder comprobarlo en pruebas.
import { AppState } from "../types";

export function portfolioBody(s: AppState) {
  return {
    user1: s.user1,
    user2: s.user2,
    properties: s.properties || [],
    payments: s.payments || [],
    expenses: s.expenses || [],
    contracts: s.contracts || [],
    syncEvents: s.syncEvents || [],
    syncEnabled: s.syncEnabled ?? true,
    isOnboarded: s.isOnboarded ?? true,
    currentYear: s.currentYear || 2026,
    yearlyProfiles: s.yearlyProfiles || {},
    theme: s.theme || "slate-indigo",
  };
}
