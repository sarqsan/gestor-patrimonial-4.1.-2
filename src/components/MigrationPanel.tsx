import React, { useState } from "react";
import { AppState } from "../types";
import {
  buildInventory,
  formatBytes,
  inventoryReport,
  runFullMigration,
  MigrationInventory,
  MigrationProgress,
  StorageAdapter,
  calculatePortfolioSize,
} from "../lib/portfolioMigration";
import { createRealStorageAdapter, createRealFirestoreAdapter } from "../lib/firebaseMigration";
import { AlertTriangle, CheckCircle, Database, HardDrive, Loader2, ShieldCheck, Upload } from "lucide-react";

interface Props {
  state: AppState;
  currentUser: string;
}

export default function MigrationPanel({ state, currentUser }: Props) {
  const [inventory, setInventory] = useState<MigrationInventory | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const sizeInfo = calculatePortfolioSize(state);

  const handleDiagnose = () => {
    setErrorMsg(null);
    setResultMsg(null);
    try {
      const inv = buildInventory(state, currentUser);
      setInventory(inv);
      setResultMsg(`Diagnóstico completado. ${inv.legacyCount} adjuntos históricos detectados.`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handleStartMigration = async () => {
    if (!inventory) {
      setErrorMsg("Ejecuta primero el diagnóstico.");
      return;
    }
    if (confirmText !== `MIGRAR ${currentUser}`) {
      setErrorMsg(`Para confirmar, escribe exactamente: MIGRAR ${currentUser}`);
      return;
    }
    setIsRunning(true);
    setErrorMsg(null);
    setResultMsg(null);
    setProgress({ phase: "inventory", total: inventory.legacyCount, uploaded: 0, verified: 0, errors: [], pending: inventory.attachments });

    try {
      const storageAdapter: StorageAdapter = createRealStorageAdapter();
      const firestoreAdapter = createRealFirestoreAdapter();

      // 1. Leer portfolio actual con updatedAt para detección concurrente
      const current = await firestoreAdapter.getPortfolio(currentUser);
      if (!current) {
        throw new Error("No se encontró la cartera en Firestore.");
      }
      const expectedUpdatedAt = current.updatedAt;

      // 2. Ejecutar migración (subida + verificación + reescritura en memoria)
      const migrationResult = await runFullMigration(current.portfolio, currentUser, storageAdapter, {
        onProgress: setProgress,
      });

      if (!migrationResult.success || !migrationResult.migratedPortfolio) {
        throw new Error(
          `Migración fallida: ${migrationResult.errors.map((e) => `${e.attachmentId}: ${e.error}`).join("; ")}`
        );
      }

      // 3. Crear backup antes de escribir
      const backupId = await firestoreAdapter.createBackup!(currentUser, current.portfolio);

      // 4. Escribir portfolio migrado con protección concurrente
      const { updatedAt } = await firestoreAdapter.setPortfolio(
        currentUser,
        migrationResult.migratedPortfolio,
        expectedUpdatedAt
      );

      setResultMsg(
        `Migración completada. Backup: ${backupId}. Nuevo tamaño: ${formatBytes(migrationResult.finalBytes || 0)} (antes ${formatBytes(inventory.initialBytes)}). Nuevo updatedAt: ${updatedAt}`
      );
      setProgress({ phase: "done", total: inventory.legacyCount, uploaded: inventory.legacyCount, verified: inventory.legacyCount, errors: [], pending: [] });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
      setShowConfirm(false);
      setConfirmText("");
    }
  };

  return (
    <div className="bg-slate-900/60 border border-amber-500/30 rounded-2xl p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2.5 bg-amber-500/20 text-amber-400 rounded-xl border border-amber-500/30">
          <Database className="w-5 h-5" />
        </div>
        <div>
          <h3 className="font-bold text-white text-sm">Migración segura de adjuntos históricos</h3>
          <p className="text-xs text-slate-400">
            Extrae los comprobantes y documentos Base64 históricos a Firebase Storage. No se ejecuta automáticamente.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <span className="text-[10px] text-slate-500 uppercase font-mono block">Tamaño actual del documento</span>
          <span className={`text-sm font-bold ${sizeInfo.blocked ? "text-red-400" : sizeInfo.nearLimit ? "text-amber-400" : "text-emerald-400"}`}>
            {formatBytes(sizeInfo.bytes)} ({sizeInfo.bytes} bytes)
          </span>
          {sizeInfo.blocked && <span className="block text-[10px] text-red-300 mt-1">Bloqueado: supera límite seguro</span>}
          {sizeInfo.nearLimit && !sizeInfo.blocked && <span className="block text-[10px] text-amber-300 mt-1">Cerca del límite (80%)</span>}
        </div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <span className="text-[10px] text-slate-500 uppercase font-mono block">Usuario</span>
          <span className="text-sm font-bold text-white font-mono">{currentUser}</span>
        </div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <span className="text-[10px] text-slate-500 uppercase font-mono block">Estado</span>
          <span className="text-sm font-bold text-slate-200">{isRunning ? "Migrando…" : inventory ? `${inventory.legacyCount} históricos` : "Sin diagnóstico"}</span>
        </div>
      </div>

      {inventory && (
        <pre className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-300 overflow-x-auto whitespace-pre-wrap">
          {inventoryReport(inventory)}
        </pre>
      )}

      {progress && (
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs space-y-2">
          <div className="flex items-center gap-2">
            <Loader2 className={`w-4 h-4 ${progress.phase === "done" ? "text-emerald-400" : "text-indigo-400 animate-spin"}`} />
            <span className="font-semibold text-slate-200">
              Fase: {progress.phase} — {progress.uploaded}/{progress.total} subidos, {progress.verified} verificados
            </span>
          </div>
          {progress.errors.length > 0 && (
            <div className="text-red-300">
              Errores: {progress.errors.map((e) => `${e.attachmentId}: ${e.error}`).join("; ")}
            </div>
          )}
        </div>
      )}

      {resultMsg && (
        <div className="bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 rounded-xl p-3 text-xs flex gap-2">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{resultMsg}</span>
        </div>
      )}
      {errorMsg && (
        <div className="bg-red-950/30 border border-red-500/30 text-red-300 rounded-xl p-3 text-xs flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleDiagnose}
          disabled={isRunning}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-50"
        >
          <HardDrive className="w-4 h-4 text-indigo-400" />
          Diagnosticar (dry-run)
        </button>

        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          disabled={isRunning || !inventory || inventory.legacyCount === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-slate-950 rounded-xl text-xs font-bold cursor-pointer"
        >
          <Upload className="w-4 h-4" />
          Migrar a Storage (con confirmación)
        </button>
      </div>

      {showConfirm && (
        <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-4 space-y-3">
          <div className="flex gap-2 text-amber-300 text-xs">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>
              Esta acción subirá {inventory?.legacyCount} archivos a Storage, verificará cada uno, creará un backup y actualizará la cartera. No se borrará el contenido histórico hasta verificar. Escribe exactamente{" "}
              <code className="bg-slate-900 px-1 py-0.5 rounded font-mono">MIGRAR {currentUser}</code> para confirmar.
            </span>
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={`MIGRAR ${currentUser}`}
            className="w-full bg-slate-950 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-white focus:ring-1 focus:ring-amber-500"
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleStartMigration}
              disabled={isRunning}
              className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold cursor-pointer disabled:opacity-50"
            >
              Confirmar migración
            </button>
          </div>
        </div>
      )}

      <div className="text-[10px] text-slate-500 leading-normal">
        La migración no se inicia automáticamente. Solo se ejecuta cuando un administrador autenticado lo confirma aquí. No se han escrito ni eliminado datos de producción durante esta sesión de código.
      </div>
    </div>
  );
}
