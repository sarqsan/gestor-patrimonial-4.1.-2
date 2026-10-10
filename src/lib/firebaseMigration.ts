// Adaptadores reales de Firebase para la migración.
// Este módulo NO ejecuta nada automáticamente; solo expone funciones que deben
// ser llamadas desde un panel administrativo con confirmación explícita.

import { ref, uploadBytes, getBlob } from "firebase/storage";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db, storage } from "./firebase";
import { AppState } from "../types";
import { StorageAdapter, FirestoreAdapter } from "./portfolioMigration";

export function createRealStorageAdapter(): StorageAdapter {
  return {
    async uploadBytes(storagePath: string, bytes: Uint8Array, contentType: string) {
      const storageRef = ref(storage, storagePath);
      const blob = new Blob([bytes], { type: contentType });
      await uploadBytes(storageRef, blob, { contentType });
    },
    async getBytes(storagePath: string) {
      const storageRef = ref(storage, storagePath);
      const blob = await getBlob(storageRef);
      const arr = await blob.arrayBuffer();
      return new Uint8Array(arr);
    },
    async exists(storagePath: string) {
      try {
        const storageRef = ref(storage, storagePath);
        await getBlob(storageRef);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createRealFirestoreAdapter(): FirestoreAdapter {
  return {
    async getPortfolio(userId: string) {
      const refDoc = doc(db, "users", userId, "data", "portfolio");
      const snap = await getDoc(refDoc);
      if (!snap.exists()) return null;
      const data = snap.data() as any;
      const { updatedAt, ...rest } = data;
      // Reconstruir AppState mínimo para migración (el resto de campos se preservan)
      // portfolioBody no incluye updatedAt, así que lo separamos.
      return {
        portfolio: {
          user1: rest.user1,
          user2: rest.user2,
          properties: rest.properties || [],
          payments: rest.payments || [],
          expenses: rest.expenses || [],
          contracts: rest.contracts || [],
          syncEvents: rest.syncEvents || [],
          syncEnabled: rest.syncEnabled ?? true,
          isOnboarded: rest.isOnboarded ?? true,
          currentYear: rest.currentYear || 2026,
          yearlyProfiles: rest.yearlyProfiles || {},
          theme: rest.theme || "slate-indigo",
        } as AppState,
        updatedAt: updatedAt as string | undefined,
      };
    },
    async setPortfolio(userId: string, portfolio: AppState, expectedUpdatedAt?: string) {
      const refDoc = doc(db, "users", userId, "data", "portfolio");
      const snap = await getDoc(refDoc);
      const currentUpdatedAt = snap.exists() ? (snap.data() as any).updatedAt : undefined;
      if (expectedUpdatedAt && currentUpdatedAt && currentUpdatedAt !== expectedUpdatedAt) {
        throw new Error(
          `Cambio concurrente detectado: la cartera se modificó después de iniciar la migración (esperado ${expectedUpdatedAt}, actual ${currentUpdatedAt}). Abortando para evitar sobrescritura.`
        );
      }
      const newUpdatedAt = new Date().toISOString();
      // Guardamos el portfolio migrado + nuevo updatedAt
      const body = {
        ...portfolio,
        // portfolioBody fields are inside portfolio, but we need to persist via same shape as App.tsx
        // App.tsx uses portfolioBody(s) + updatedAt. So we mimic that.
        user1: portfolio.user1,
        user2: portfolio.user2,
        properties: portfolio.properties,
        payments: portfolio.payments,
        expenses: portfolio.expenses,
        contracts: portfolio.contracts,
        syncEvents: portfolio.syncEvents,
        syncEnabled: portfolio.syncEnabled,
        isOnboarded: portfolio.isOnboarded,
        currentYear: portfolio.currentYear,
        yearlyProfiles: portfolio.yearlyProfiles,
        theme: portfolio.theme,
        updatedAt: newUpdatedAt,
      };
      await setDoc(refDoc, body, { merge: true });
      return { updatedAt: newUpdatedAt };
    },
    async createBackup(userId: string, portfolio: AppState) {
      const backupId = `backup_${Date.now()}`;
      const backupRef = doc(db, "users", userId, "backups", backupId);
      await setDoc(backupRef, {
        ...portfolio,
        backedUpAt: new Date().toISOString(),
        reason: "pre-migration backup",
      });
      return backupId;
    },
  };
}
