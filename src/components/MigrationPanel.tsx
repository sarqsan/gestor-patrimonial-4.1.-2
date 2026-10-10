import React, { useEffect, useMemo, useState } from "react";
import { AppState } from "../types";
import { buildInventory, formatBytes, inventoryReport, calculatePortfolioSize } from "../lib/portfolioMigration";
import {
  canStartMigration,
  MigrationOutcome,
  MigrationRecord,
  restorePortfolioFromBackup,
  runPortfolioAttachmentMigration,
} from "../lib/portfolioMigrationRun";
import { createFirebaseMigrationStorage, createFirebaseMigrationStore } from "../lib/firebaseMigration";
import { AlertTriangle, CheckCircle, Database, HardDrive, Loader2, RotateCcw, ShieldCheck, Upload } from "lucide-react";

interface Props {
  state: AppState;
  currentUser: string;
  /** Tras una migración o restauración correcta, la pantalla adopta el documento de la nube. */
  onApplied: (raw: Record<string, unknown>, mode: "migrated" | "restored") => void;
}

export default function MigrationPanel({ state, currentUser, onApplied }: Props) {
  // El diagnóstico se calcula en vivo desde el estado de la app (no depende de un clic previo).
  const inventory = useMemo(() => buildInventory(state, currentUser), [state, currentUser]);
  const sizeInfo = calculatePortfolioSize(state);

  const [isRunning, setIsRunning] = useState(false);
  const [liveStep, setLiveStep] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MigrationOutcome | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [record, setRecord] = useState<MigrationRecord | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restoreText, setRestoreText] = useState("");

  const gate = canStartMigration({ legacyCount: inventory.legacyCount, running: isRunning });

  useEffect(() => {
    let cancelled = false;
    createFirebaseMigrationStore()
      .readMigrationRecord(currentUser)
      .then((r) => { if (!cancelled) setRecord(r); })
      .catch(() => { /* sin registro previo o sin conexión: no bloquea el panel */ });
    return () => { cancelled = true; };
  }, [currentUser]);

  const handleStartMigration = async () => {
    if (confirmText !== `MIGRAR ${currentUser}`) {
      setErrorMsg(`Para confirmar, escribe exactamente: MIGRAR ${currentUser}`);
      return;
    }
    setIsRunning(true);
    setErrorMsg(null);
    setResultMsg(null);
    setOutcome(null);
    setLiveStep("Creando copia de seguridad verificada…");
    try {
      const result = await runPortfolioAttachmentMigration({
        userId: currentUser,
        working: state,
        storage: createFirebaseMigrationStorage(),
        store: createFirebaseMigrationStore(),
      });
      setOutcome(result);
      if (result.status === "completed" && result.migratedRaw) {
        onApplied(result.migratedRaw, "migrated");
        setResultMsg(
          `Migración completada y verificada. ${result.attachments.length} adjunto(s) en Storage. ` +
            `Copia de seguridad: ${result.backupId}. Tamaño de la cartera: ${formatBytes(result.finalBytes || 0)} ` +
            `(antes ${formatBytes(result.initialBytes)}). No se ha eliminado ningún dato original.`
        );
        setRecord(await createFirebaseMigrationStore().readMigrationRecord(currentUser).catch(() => null));
      } else if (result.status === "nothing-to-migrate") {
        setResultMsg("No hay adjuntos Base64 que migrar. La cartera ya está migrada.");
      } else {
        setErrorMsg(
          `${result.status === "rolled-back" ? "Migración revertida" : "Migración no completada"}: ${result.error ?? "error desconocido"}`
        );
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
      setLiveStep(null);
      setShowConfirm(false);
      setConfirmText("");
    }
  };

  const handleRestore = async () => {
    const backupId = record?.backupId;
    if (!backupId) return;
    if (restoreText !== `RESTAURAR ${currentUser}`) {
      setErrorMsg(`Para restaurar, escribe exactamente: RESTAURAR ${currentUser}`);
      return;
    }
    setIsRunning(true);
    setErrorMsg(null);
    setResultMsg(null);
    try {
      const restored = await restorePortfolioFromBackup({
        userId: currentUser,
        backupId,
        storage: createFirebaseMigrationStorage(),
        store: createFirebaseMigrationStore(),
      });
      onApplied(restored.raw, "restored");
      setResultMsg(`Cartera restaurada desde la copia ${backupId}. La copia sigue disponible.`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
      setRestoreConfirm(false);
      setRestoreText("");
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
            Mueve los comprobantes y documentos Base64 históricos a Firebase Storage y deja solo referencias en la cartera.
            Requiere confirmación explícita.
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
          <span className="text-sm font-bold text-slate-200">
            {isRunning ? "Migrando…" : `${inventory.legacyCount} adjunto(s) Base64 históricos`}
          </span>
        </div>
      </div>

      <pre className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-300 overflow-x-auto whitespace-pre-wrap">
        {inventoryReport(inventory)}
      </pre>

      {isRunning && liveStep && (
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs flex items-center gap-2">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
          <span className="font-semibold text-slate-200">{liveStep}</span>
        </div>
      )}

      {outcome && outcome.steps.length > 0 && !isRunning && (
        <details className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-400">
          <summary className="cursor-pointer text-slate-300">Detalle de la última ejecución ({outcome.steps.length} pasos)</summary>
          <ul className="mt-2 space-y-0.5 font-mono">{outcome.steps.map((s) => <li key={s}>{s}</li>)}</ul>
        </details>
      )}

      {record?.backupId && (
        <div className="text-[11px] text-slate-400 font-mono break-all">
          Última copia de seguridad: {record.backupId} (estado de migración: {record.status})
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

      <div className="flex flex-wrap gap-2 items-center">
        <span className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 text-slate-300 border border-slate-700 rounded-xl text-xs font-semibold">
          <HardDrive className="w-4 h-4 text-indigo-400" />
          Diagnóstico en vivo
        </span>

        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          disabled={!gate.enabled}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 rounded-xl text-xs font-bold cursor-pointer"
        >
          <Upload className="w-4 h-4" />
          Migrar a Storage (con confirmación)
        </button>
        {!gate.enabled && gate.reason && <span className="text-[11px] text-slate-500">{gate.reason}</span>}

        {record?.backupId && record.status !== "running" && (
          <button
            type="button"
            onClick={() => setRestoreConfirm(true)}
            disabled={isRunning}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-40"
          >
            <RotateCcw className="w-4 h-4 text-indigo-400" />
            Restaurar desde la copia
          </button>
        )}
      </div>

      {showConfirm && (
        <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-4 space-y-3">
          <div className="flex gap-2 text-amber-300 text-xs">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>
              Se creará una copia de seguridad verificada en Storage, se subirán {inventory.legacyCount} archivo(s), se verificará cada uno
              byte a byte y solo entonces se actualizará la cartera (con comprobación de cambios concurrentes). Los originales no se borran.
              Escribe exactamente <code className="bg-slate-900 px-1 py-0.5 rounded font-mono">MIGRAR {currentUser}</code> para confirmar.
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
            <button type="button" onClick={() => setShowConfirm(false)} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs cursor-pointer">
              Cancelar
            </button>
            <button type="button" onClick={handleStartMigration} disabled={isRunning} className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold cursor-pointer disabled:opacity-50">
              Confirmar migración
            </button>
          </div>
        </div>
      )}

      {restoreConfirm && (
        <div className="bg-slate-950 border border-slate-700 rounded-xl p-4 space-y-3">
          <p className="text-xs text-slate-300">
            Restaurará la cartera al estado de la copia {record?.backupId}. Escribe <code className="bg-slate-900 px-1 py-0.5 rounded font-mono">RESTAURAR {currentUser}</code> para confirmar.
          </p>
          <input
            type="text"
            value={restoreText}
            onChange={(e) => setRestoreText(e.target.value)}
            placeholder={`RESTAURAR ${currentUser}`}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setRestoreConfirm(false)} className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg text-xs cursor-pointer">Cancelar</button>
            <button type="button" onClick={handleRestore} disabled={isRunning} className="px-4 py-1.5 bg-slate-200 text-slate-900 rounded-lg text-xs font-bold cursor-pointer disabled:opacity-50">Restaurar</button>
          </div>
        </div>
      )}

      <div className="text-[10px] text-slate-500 leading-normal">
        La migración nunca se inicia automáticamente: solo se ejecuta tras confirmar aquí. Antes de escribir, la copia de seguridad y cada adjunto se verifican;
        si la cartera cambia durante el proceso, no se escribe nada.
      </div>
    </div>
  );
}
