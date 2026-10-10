// Adaptadores reales de Firebase para la migración de adjuntos (portfolioMigrationRun.ts).
// Este módulo NO ejecuta nada por sí mismo: solo expone adaptadores que el panel de
// migración usa tras una confirmación explícita del usuario.

import { ref, uploadBytes, getBytes as getStorageBytes } from "firebase/storage";
import { doc, getDoc, setDoc, runTransaction } from "firebase/firestore";
import { db, storage } from "./firebase";
import { ensureFirebaseSession } from "./attachments";
import { MAX_BACKUP_BYTES } from "./attachmentRules";
import { assertPortfolioWritable } from "./portfolioGuard";
import { portfolioRawHash } from "./stableHash";
import {
  BackupIndexEntry,
  ConcurrentChangeError,
  MigrationRecord,
  MigrationStorage,
  MigrationStore,
} from "./portfolioMigrationRun";

export const MIGRATION_RECORD_ID = "portfolio-attachments-v1";

function withoutUpdatedAt(raw: Record<string, unknown>): Record<string, unknown> {
  const { updatedAt: _ignored, ...rest } = raw;
  return rest;
}

export function createFirebaseMigrationStorage(): MigrationStorage {
  return {
    async uploadBytes(path, bytes, contentType) {
      await ensureFirebaseSession();
      await uploadBytes(ref(storage, path), new Blob([bytes], { type: contentType }), { contentType });
    },
    async readBytes(path) {
      await ensureFirebaseSession();
      try {
        const buf = await getStorageBytes(ref(storage, path), MAX_BACKUP_BYTES);
        return new Uint8Array(buf);
      } catch (err) {
        if ((err as { code?: string })?.code === "storage/object-not-found") return null;
        throw err;
      }
    },
  };
}

export function createFirebaseMigrationStore(): MigrationStore {
  const portfolioRef = (userId: string) => doc(db, "users", userId, "data", "portfolio");

  return {
    async readRaw(userId) {
      const snap = await getDoc(portfolioRef(userId));
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    },

    async replaceIfUnchanged(userId, expectedHash, next, opts) {
      // JSON puro: sin undefined (Firestore los rechaza).
      const payload = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
      if (opts?.enforceGuard !== false) assertPortfolioWritable(withoutUpdatedAt(payload));
      // Transacción: la comprobación del hash y la escritura son atómicas.
      await runTransaction(db, async (tx) => {
        const ref = portfolioRef(userId);
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          if (expectedHash !== "") throw new ConcurrentChangeError("La cartera ya no existe en Firestore. No se ha escrito nada.");
        } else {
          const current = await portfolioRawHash(snap.data() as Record<string, unknown>);
          if (current !== expectedHash) throw new ConcurrentChangeError();
        }
        tx.set(ref, payload);
      });
    },

    async writeBackupIndex(userId, entry: BackupIndexEntry) {
      // Solo metadatos: el contenido voluminoso está en Storage.
      await setDoc(doc(db, "users", userId, "backups", entry.backupId), JSON.parse(JSON.stringify(entry)));
    },

    async readBackupIndex(userId, backupId) {
      const snap = await getDoc(doc(db, "users", userId, "backups", backupId));
      return snap.exists() ? (snap.data() as BackupIndexEntry) : null;
    },

    async readMigrationRecord(userId) {
      const snap = await getDoc(doc(db, "users", userId, "migrations", MIGRATION_RECORD_ID));
      return snap.exists() ? (snap.data() as MigrationRecord) : null;
    },

    async writeMigrationRecord(userId, record) {
      await setDoc(doc(db, "users", userId, "migrations", MIGRATION_RECORD_ID), JSON.parse(JSON.stringify(record)));
    },
  };
}
