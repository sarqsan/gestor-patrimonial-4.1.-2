import React, { useState } from "react";
import { AppState, PropertyExpense } from "../types";
import { db, doc, getDoc, authReady, auth, storage } from "../lib/firebase";
import { collection, getDocs } from "firebase/firestore";
import { ref, getBytes } from "firebase/storage";
import { planRecoveryMerge, RecoveryPlan } from "../lib/recoveryImport";
import { 
  Database, 
  ShieldCheck, 
  AlertTriangle, 
  CheckCircle, 
  Loader2, 
  Search, 
  Lock, 
  FileText, 
  DollarSign, 
  TrendingUp, 
  TrendingDown, 
  Eye, 
  Filter,
  Receipt,
  HelpCircle,
  Clock,
  ExternalLink
} from "lucide-react";

interface Props {
  state: AppState;
  currentUser: string;
}

export type CheckStatus =
  | "idle"
  | "checking"
  | "found"
  | "not-found"
  | "permission-denied"
  | "connection-error"
  | "error";

export default function RecoveryPreviewPanel({ state, currentUser }: Props) {
  const targetBackupId = "backup_1791641770686";
  const userTarget = currentUser || "arquero";
  const firestorePath = `users/${userTarget}/backups/${targetBackupId}`;
  const storagePath = `users/${userTarget}/backups/${targetBackupId}.json`;

  const [firestoreStatus, setFirestoreStatus] = useState<CheckStatus>("idle");
  const [firestoreError, setFirestoreError] = useState<{ code?: string; message: string } | null>(null);

  const [storageStatus, setStorageStatus] = useState<CheckStatus>("idle");
  const [storageError, setStorageError] = useState<{ code?: string; message: string } | null>(null);

  const [backupExpenses, setBackupExpenses] = useState<PropertyExpense[] | null>(null);
  const [backupSource, setBackupSource] = useState<"firestore-direct" | "firestore-storage-ref" | "storage-file" | null>(null);
  const [discoveredBackups, setDiscoveredBackups] = useState<string[]>([]);
  const [discoveredMigration, setDiscoveredMigration] = useState<{ backupId?: string; status?: string } | null>(null);
  const [backupMetadata, setBackupMetadata] = useState<{
    totalProperties?: number;
    totalPayments?: number;
    totalExpenses?: number;
    backedUpAt?: string;
    format?: string;
  } | null>(null);

  const [recoveryPlan, setRecoveryPlan] = useState<RecoveryPlan | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<"all" | "restore-missing" | "skip-duplicate" | "enrich-receipt" | "ambiguous-review">("all");

  const runVerification = async () => {
    setFirestoreStatus("checking");
    setFirestoreError(null);
    setStorageStatus("idle");
    setStorageError(null);
    setBackupExpenses(null);
    setBackupSource(null);
    setBackupMetadata(null);
    setRecoveryPlan(null);

    let loadedExpenses: PropertyExpense[] | null = null;
    let foundSource: "firestore-direct" | "firestore-storage-ref" | "storage-file" | null = null;
    let meta: any = {};

    try {
      await authReady;

      // 1. Comprobación en Cloud Firestore
      try {
        const docRef = doc(db, "users", userTarget, "backups", targetBackupId);
        const snapshot = await getDoc(docRef);

        if (snapshot.exists()) {
          setFirestoreStatus("found");
          const data = snapshot.data() as Record<string, any>;
          meta.backedUpAt = data.backedUpAt || data.updatedAt || data.createdAt;

          if (Array.isArray(data.expenses)) {
            loadedExpenses = data.expenses;
            foundSource = "firestore-direct";
            meta.totalExpenses = data.expenses.length;
            meta.totalProperties = Array.isArray(data.properties) ? data.properties.length : 0;
            meta.totalPayments = Array.isArray(data.payments) ? data.payments.length : 0;
          } else if (data.storagePath) {
            // Documento Firestore actúa como puntero al JSON en Storage
            foundSource = "firestore-storage-ref";
            try {
              const storageFileRef = ref(storage, data.storagePath);
              const bytes = await getBytes(storageFileRef);
              const jsonStr = new TextDecoder().decode(bytes);
              const parsed = JSON.parse(jsonStr);
              if (Array.isArray(parsed.expenses)) {
                loadedExpenses = parsed.expenses;
                meta.totalExpenses = parsed.expenses.length;
                meta.totalProperties = Array.isArray(parsed.properties) ? parsed.properties.length : 0;
                meta.totalPayments = Array.isArray(parsed.payments) ? parsed.payments.length : 0;
              }
            } catch (sErr: any) {
              console.warn("Error leyendo storagePath apuntado por Firestore:", sErr);
            }
          }
        } else {
          setFirestoreStatus("not-found");
          setFirestoreError({
            code: "not-found",
            message: `Documento no existe en Firestore (${firestorePath})`,
          });

          // Explorar si existen otras copias registradas en Firestore
          try {
            const bkpCol = collection(db, "users", userTarget, "backups");
            const bkpSnap = await getDocs(bkpCol);
            const foundIds = bkpSnap.docs.map((d) => d.id);
            setDiscoveredBackups(foundIds);

            const migDoc = await getDoc(doc(db, "users", userTarget, "migrations", "portfolio-attachments-v1"));
            if (migDoc.exists()) {
              const migData = migDoc.data() as any;
              setDiscoveredMigration({ backupId: migData.backupId, status: migData.status });
            }
          } catch (listErr) {
            console.warn("No se pudieron listar backups alternativos:", listErr);
          }
        }
      } catch (fErr: any) {
        console.error("Error comprobando Firestore:", fErr);
        const code = fErr?.code || "";
        const msg = fErr instanceof Error ? fErr.message : String(fErr);
        if (code === "permission-denied") {
          setFirestoreStatus("permission-denied");
        } else if (code === "unavailable" || msg.includes("offline") || msg.includes("network")) {
          setFirestoreStatus("connection-error");
        } else {
          setFirestoreStatus("error");
        }
        setFirestoreError({ code, message: msg });
      }

      // 2. Si no se cargaron gastos desde Firestore, comprobar directamente en Firebase Storage
      if (!loadedExpenses) {
        setStorageStatus("checking");
        try {
          const fileRef = ref(storage, storagePath);
          const bytes = await getBytes(fileRef);
          setStorageStatus("found");
          const jsonStr = new TextDecoder().decode(bytes);
          const parsed = JSON.parse(jsonStr);

          if (Array.isArray(parsed.expenses)) {
            loadedExpenses = parsed.expenses;
            foundSource = "storage-file";
            meta.totalExpenses = parsed.expenses.length;
            meta.totalProperties = Array.isArray(parsed.properties) ? parsed.properties.length : 0;
            meta.totalPayments = Array.isArray(parsed.payments) ? parsed.payments.length : 0;
            meta.backedUpAt = parsed.updatedAt || parsed.backedUpAt;
          }
        } catch (sErr: any) {
          const sCode = sErr?.code || "";
          const sMsg = sErr instanceof Error ? sErr.message : String(sErr);
          if (sCode === "storage/object-not-found") {
            setStorageStatus("not-found");
          } else if (sCode === "storage/unauthorized" || sMsg.includes("permission")) {
            setStorageStatus("permission-denied");
          } else if (sMsg.includes("network") || sMsg.includes("offline")) {
            setStorageStatus("connection-error");
          } else {
            setStorageStatus("error");
          }
          setStorageError({ code: sCode, message: sMsg });
        }
      }

      // 3. Si se obtuvieron los datos del backup, calcular la simulación de recuperación (Pura y en memoria)
      if (loadedExpenses) {
        setBackupExpenses(loadedExpenses);
        setBackupSource(foundSource);
        setBackupMetadata(meta);

        const currentExpenses = state.expenses || [];
        const plan = planRecoveryMerge(currentExpenses, loadedExpenses);
        setRecoveryPlan(plan);
      }
    } catch (globalErr: any) {
      console.error("Error global en verificación:", globalErr);
    }
  };

  const isChecking = firestoreStatus === "checking" || storageStatus === "checking";

  const filteredItems = recoveryPlan?.items.filter((item) => {
    if (selectedFilter === "all") return true;
    return item.action === selectedFilter;
  }) || [];

  return (
    <div className="bg-slate-900/60 border border-indigo-500/30 rounded-2xl p-6 space-y-6">
      
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-500/20 text-indigo-400 rounded-xl border border-indigo-500/30">
            <Search className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-white text-base">Verificación Real del Backup y Vista Previa</h3>
              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] px-2 py-0.5 rounded font-mono font-bold uppercase">
                Solo Lectura
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Inspecciona el backup real de producción con el SDK de Firebase y simula la recuperación sin modificar datos.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={runVerification}
          disabled={isChecking}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold cursor-pointer disabled:opacity-50 transition-all shrink-0"
        >
          {isChecking ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Verificando en Firebase…
            </>
          ) : (
            <>
              <Search className="w-4 h-4" />
              Verificar Backup Real
            </>
          )}
        </button>
      </div>

      {/* RUTA Y METADATOS DE SEGURIDAD */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <span className="text-[10px] text-slate-500 uppercase font-mono block">Rutas Inspeccionadas</span>
          <span className="text-[11px] font-mono text-slate-300 block truncate">Firestore: {firestorePath}</span>
          <span className="text-[11px] font-mono text-slate-400 block truncate">Storage: {storagePath}</span>
        </div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <span className="text-[10px] text-slate-500 uppercase font-mono block">Estado de Autenticación Firebase</span>
          <span className="text-xs font-mono font-bold text-indigo-300">
            {auth.currentUser ? `UID: ${auth.currentUser.uid.slice(0, 10)}… (Anónimo)` : "Inicializando auth…"}
          </span>
          <span className="text-[10px] text-slate-400 block mt-0.5">Usuario local: {currentUser}</span>
        </div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <span className="text-[10px] text-slate-500 uppercase font-mono block">Protección de Escrituras</span>
          <span className="text-xs font-bold text-emerald-400 flex items-center gap-1 mt-0.5">
            <Lock className="w-3.5 h-3.5" /> Modo 100% Solo Lectura
          </span>
          <span className="text-[10px] text-slate-400 block mt-0.5">Sin mutaciones en Firestore ni Storage</span>
        </div>
      </div>

      {/* RESULTADO DE LA VERIFICACIÓN EN FIRESTORE */}
      {firestoreStatus !== "idle" && (
        <div className="space-y-3">
          <div className="text-xs font-bold font-mono uppercase tracking-wider text-slate-400">
            1. Resultado de Verificación en Cloud Firestore
          </div>

          {firestoreStatus === "not-found" && (
            <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-4 text-xs text-amber-200 space-y-2">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <AlertTriangle className="w-4 h-4" />
                Documento no encontrado en Firestore
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                No existe ningún documento en <code className="font-mono bg-slate-900 px-1 py-0.5 rounded text-amber-300">{firestorePath}</code>.
                Esto ocurre porque las copias integrales de más de 1 MiB se respaldan en Firebase Storage para no violar el límite de 1.048.576 bytes de Firestore.
              </p>
              {discoveredBackups.length > 0 && (
                <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 text-[11px] text-slate-300">
                  <span className="text-slate-400 font-bold block mb-1">Copias alternativas detectadas en la colección users/{userTarget}/backups:</span>
                  <ul className="list-disc list-inside font-mono text-indigo-300 space-y-0.5">
                    {discoveredBackups.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </div>
              )}
              {discoveredMigration?.backupId && (
                <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 text-[11px] text-slate-300">
                  <span className="text-slate-400 font-bold block mb-1">Copia registrada en la migración de cartera (portfolio-attachments-v1):</span>
                  <span className="font-mono text-emerald-400">{discoveredMigration.backupId}</span> (estado: {discoveredMigration.status})
                </div>
              )}
            </div>
          )}

          {firestoreStatus === "permission-denied" && (
            <div className="bg-red-950/30 border border-red-500/40 rounded-xl p-4 text-xs text-red-200 space-y-2">
              <div className="flex items-center gap-2 font-bold text-red-300">
                <Lock className="w-4 h-4" />
                Permiso denegado por reglas de seguridad de Firestore (permission-denied)
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Las reglas de seguridad de Firestore impiden leer esta ruta con el token de sesión actual. Las reglas permanecen intactas para no vulnerar la seguridad del sistema.
              </p>
              <div className="text-[10px] font-mono text-red-400 bg-slate-950 p-2 rounded border border-red-900/50">
                Código: {firestoreError?.code} | Error: {firestoreError?.message}
              </div>
            </div>
          )}

          {firestoreStatus === "connection-error" && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 space-y-2">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <Clock className="w-4 h-4" />
                Error de conexión con Cloud Firestore (Cliente sin conexión)
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                El cliente SDK no pudo conectar con el endpoint de Firestore desde este navegador. Detalle: {firestoreError?.message}
              </p>
            </div>
          )}

          {firestoreStatus === "found" && (
            <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-xl p-3 text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              <span>Documento localizado en Firestore: <code className="font-mono text-slate-200">{firestorePath}</code></span>
            </div>
          )}
        </div>
      )}

      {/* RESULTADO DE LA VERIFICACIÓN EN FIREBASE STORAGE */}
      {storageStatus !== "idle" && (
        <div className="space-y-3">
          <div className="text-xs font-bold font-mono uppercase tracking-wider text-slate-400">
            2. Resultado de Verificación en Firebase Storage
          </div>

          {storageStatus === "not-found" && (
            <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-4 text-xs text-amber-200 space-y-1">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <AlertTriangle className="w-4 h-4" />
                Fichero no encontrado en Firebase Storage
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                No existe el objeto en Storage en la ruta <code className="font-mono bg-slate-900 px-1 py-0.5 rounded text-amber-300">{storagePath}</code>.
              </p>
            </div>
          )}

          {storageStatus === "permission-denied" && (
            <div className="bg-red-950/30 border border-red-500/40 rounded-xl p-4 text-xs text-red-200 space-y-2">
              <div className="flex items-center gap-2 font-bold text-red-300">
                <Lock className="w-4 h-4" />
                Permiso denegado por reglas de seguridad de Storage (storage/unauthorized)
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Las reglas de seguridad de Storage impiden acceder al bucket con el usuario actual. Las reglas no se debilitan.
              </p>
            </div>
          )}

          {storageStatus === "connection-error" && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 space-y-2">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <Clock className="w-4 h-4" />
                Error de red con Firebase Storage
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                El SDK no pudo conectar con el endpoint de Storage. Detalle: {storageError?.message}
              </p>
            </div>
          )}

          {storageStatus === "found" && (
            <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-xl p-3 text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              <span>Copia de seguridad localizada en Storage: <code className="font-mono text-slate-200">{storagePath}</code></span>
            </div>
          )}
        </div>
      )}

      {/* DETALLES DEL BACKUP ENCONTRADO Y SIMULACIÓN */}
      {backupMetadata && backupExpenses && (
        <div className="space-y-6">
          {/* DIAGNÓSTICO DEL DOCUMENTO ENCONTRADO */}
          <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 font-bold text-emerald-300 text-xs">
              <CheckCircle className="w-4 h-4" />
              Backup real localizado en Firestore ({backupMetadata.format === "direct-portfolio" ? "Copia integral pre-migración" : "Índice de Storage"})
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              <div className="bg-slate-950 p-2 rounded border border-slate-800">
                <span className="text-[9px] text-slate-500 block uppercase">Fecha del Backup</span>
                <span className="text-slate-200 font-bold">{backupMetadata.backedUpAt || "No informada"}</span>
              </div>
              <div className="bg-slate-950 p-2 rounded border border-slate-800">
                <span className="text-[9px] text-slate-500 block uppercase">Total Inmuebles</span>
                <span className="text-slate-200 font-bold">{backupMetadata.totalProperties ?? "N/A"}</span>
              </div>
              <div className="bg-slate-950 p-2 rounded border border-slate-800">
                <span className="text-[9px] text-slate-500 block uppercase">Total Cobros</span>
                <span className="text-slate-200 font-bold">{backupMetadata.totalPayments ?? "N/A"}</span>
              </div>
              <div className="bg-slate-950 p-2 rounded border border-slate-800">
                <span className="text-[9px] text-slate-500 block uppercase">Total Gastos/Ingresos</span>
                <span className="text-indigo-400 font-bold">{backupMetadata.totalExpenses ?? "N/A"}</span>
              </div>
            </div>
          </div>

          {/* SIMULACIÓN DE RECUPERACIÓN */}
          {recoveryPlan && (
            <div className="space-y-5">
              
              {/* RESUMEN DE CONCILIACIÓN */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <span className="text-[10px] text-slate-500 uppercase font-mono block">Movimientos Actuales</span>
                  <span className="text-base font-bold text-white">{recoveryPlan.totalCurrentExpenses}</span>
                  <span className="text-[10px] text-emerald-400 block mt-0.5">Se conservan al 100%</span>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <span className="text-[10px] text-slate-500 uppercase font-mono block">A Recuperar (Ausentes)</span>
                  <span className="text-base font-bold text-indigo-400">{recoveryPlan.restoredCount}</span>
                  <span className="text-[10px] text-indigo-300 block mt-0.5">Movimientos perdidos</span>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <span className="text-[10px] text-slate-500 uppercase font-mono block">Duplicados Omitidos</span>
                  <span className="text-base font-bold text-slate-400">{recoveryPlan.skippedDuplicatesCount}</span>
                  <span className="text-[10px] text-slate-500 block mt-0.5">Ya presentes en cartera</span>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
                  <span className="text-[10px] text-slate-500 uppercase font-mono block">Justificantes Rescatables</span>
                  <span className="text-base font-bold text-amber-400">{recoveryPlan.recoverableReceiptsCount}</span>
                  <span className="text-[10px] text-amber-300 block mt-0.5">
                    {recoveryPlan.enrichedReceiptsCount} reasociados
                  </span>
                </div>
              </div>

              {/* COMPARATIVA ECONÓMICA */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-indigo-400" />
                  Comparativa Económica de la Simulación
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs font-sans">
                  {/* Ingresos */}
                  <div className="border border-slate-800 bg-slate-900/40 rounded-xl p-3 space-y-1">
                    <div className="flex justify-between text-slate-400 text-[11px]">
                      <span>Total Ingresos Actuales:</span>
                      <span className="font-mono">{recoveryPlan.currentFinancials.incomes.toLocaleString("es-ES")} €</span>
                    </div>
                    <div className="flex justify-between text-indigo-300 text-[11px]">
                      <span>Ingresos a Recuperar:</span>
                      <span className="font-mono">+{recoveryPlan.differenceFinancials.incomes.toLocaleString("es-ES")} €</span>
                    </div>
                    <div className="border-t border-slate-800 pt-1 flex justify-between font-bold text-white">
                      <span>Resultado Simulado:</span>
                      <span className="font-mono text-emerald-400">{recoveryPlan.simulatedFinancials.incomes.toLocaleString("es-ES")} €</span>
                    </div>
                  </div>

                  {/* Gastos */}
                  <div className="border border-slate-800 bg-slate-900/40 rounded-xl p-3 space-y-1">
                    <div className="flex justify-between text-slate-400 text-[11px]">
                      <span>Total Gastos Actuales:</span>
                      <span className="font-mono">{recoveryPlan.currentFinancials.expenses.toLocaleString("es-ES")} €</span>
                    </div>
                    <div className="flex justify-between text-amber-300 text-[11px]">
                      <span>Gastos a Recuperar:</span>
                      <span className="font-mono">+{recoveryPlan.differenceFinancials.expenses.toLocaleString("es-ES")} €</span>
                    </div>
                    <div className="border-t border-slate-800 pt-1 flex justify-between font-bold text-white">
                      <span>Resultado Simulado:</span>
                      <span className="font-mono text-rose-400">{recoveryPlan.simulatedFinancials.expenses.toLocaleString("es-ES")} €</span>
                    </div>
                  </div>

                  {/* Rendimiento Neto */}
                  <div className="border border-slate-800 bg-slate-900/40 rounded-xl p-3 space-y-1">
                    <div className="flex justify-between text-slate-400 text-[11px]">
                      <span>Rendimiento Actual:</span>
                      <span className="font-mono">{recoveryPlan.currentFinancials.net.toLocaleString("es-ES")} €</span>
                    </div>
                    <div className="flex justify-between text-slate-300 text-[11px]">
                      <span>Diferencia Neta:</span>
                      <span className="font-mono">{recoveryPlan.differenceFinancials.net > 0 ? "+" : ""}{recoveryPlan.differenceFinancials.net.toLocaleString("es-ES")} €</span>
                    </div>
                    <div className="border-t border-slate-800 pt-1 flex justify-between font-bold text-white">
                      <span>Rendimiento Simulado:</span>
                      <span className="font-mono text-indigo-300">{recoveryPlan.simulatedFinancials.net.toLocaleString("es-ES")} €</span>
                    </div>
                  </div>
                </div>

                {/* Fechas Extremas */}
                {recoveryPlan.minDateBackup && (
                  <div className="text-[11px] text-slate-400 pt-1">
                    Rango de fechas de los apuntes del backup: <strong className="text-slate-200 font-mono">{recoveryPlan.minDateBackup}</strong> hasta <strong className="text-slate-200 font-mono">{recoveryPlan.maxDateBackup}</strong>.
                  </div>
                )}
              </div>

              {/* LISTA DETALLADA DE MOVIMIENTOS SIMULADOS */}
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                  <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider font-mono">
                    Desglose de Movimientos para la Simulación ({filteredItems.length} registros)
                  </h4>

                  {/* FILTROS */}
                  <div className="flex flex-wrap gap-1.5 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setSelectedFilter("all")}
                      className={`px-2.5 py-1 rounded-lg border font-semibold cursor-pointer ${
                        selectedFilter === "all" ? "bg-indigo-600 text-white border-indigo-500" : "bg-slate-950 text-slate-400 border-slate-800 hover:text-white"
                      }`}
                    >
                      Todos ({recoveryPlan.items.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedFilter("restore-missing")}
                      className={`px-2.5 py-1 rounded-lg border font-semibold cursor-pointer ${
                        selectedFilter === "restore-missing" ? "bg-indigo-600 text-white border-indigo-500" : "bg-slate-950 text-indigo-300 border-slate-800 hover:text-white"
                      }`}
                    >
                      A Recuperar ({recoveryPlan.restoredCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedFilter("skip-duplicate")}
                      className={`px-2.5 py-1 rounded-lg border font-semibold cursor-pointer ${
                        selectedFilter === "skip-duplicate" ? "bg-indigo-600 text-white border-indigo-500" : "bg-slate-950 text-slate-400 border-slate-800 hover:text-white"
                      }`}
                    >
                      Omitir Duplicados ({recoveryPlan.skippedDuplicatesCount})
                    </button>
                    {recoveryPlan.ambiguousCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedFilter("ambiguous-review")}
                        className={`px-2.5 py-1 rounded-lg border font-semibold cursor-pointer ${
                          selectedFilter === "ambiguous-review" ? "bg-amber-600 text-white border-amber-500" : "bg-slate-950 text-amber-300 border-slate-800 hover:text-white"
                        }`}
                      >
                        ⚠ Revisión ({recoveryPlan.ambiguousCount})
                      </button>
                    )}
                  </div>
                </div>

                <div className="max-h-[350px] overflow-y-auto space-y-2 pr-1">
                  {filteredItems.map((item, idx) => (
                    <div
                      key={`${item.id}-${idx}`}
                      className={`p-3 rounded-xl border text-xs flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 ${
                        item.action === "restore-missing"
                          ? "bg-indigo-950/20 border-indigo-500/30"
                          : item.action === "skip-duplicate"
                          ? "bg-slate-950/40 border-slate-800 text-slate-400"
                          : item.action === "enrich-receipt"
                          ? "bg-amber-950/20 border-amber-500/30 text-amber-200"
                          : item.action === "ambiguous-review"
                          ? "bg-red-950/20 border-red-500/30 text-red-200"
                          : "bg-slate-900/40 border-slate-800 text-slate-300"
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-[10px] text-slate-400">{item.date}</span>
                          <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold uppercase font-mono ${
                            item.type === "ingreso" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                          }`}>
                            {item.type}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">ID: {item.id}</span>
                          {item.receiptStatus === "storage-reference" && (
                            <span className="text-[9px] text-emerald-400 bg-emerald-950/40 px-1.5 py-0.2 rounded font-mono">
                              Justificante en Storage
                            </span>
                          )}
                          {item.receiptStatus === "legacy-base64" && (
                            <span className="text-[9px] text-amber-400 bg-amber-950/40 px-1.5 py-0.2 rounded font-mono">
                              Justificante Base64
                            </span>
                          )}
                        </div>
                        <p className="font-medium text-slate-200">{item.description || `Operación de ${item.category}`}</p>
                        {item.ambiguityReason && (
                          <p className="text-[10px] text-amber-300 font-sans">{item.ambiguityReason}</p>
                        )}
                      </div>

                      <div className="flex sm:flex-col items-center sm:items-end justify-between w-full sm:w-auto gap-1">
                        <span className={`font-mono font-bold text-sm ${item.type === "ingreso" ? "text-emerald-400" : "text-slate-100"}`}>
                          {item.amount.toLocaleString("es-ES")} €
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase font-mono ${
                          item.action === "restore-missing"
                            ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                            : item.action === "skip-duplicate"
                            ? "bg-slate-800 text-slate-400"
                            : item.action === "enrich-receipt"
                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                            : item.action === "ambiguous-review"
                            ? "bg-red-500/20 text-red-300 border border-red-500/30"
                            : "bg-slate-800 text-emerald-400"
                        }`}>
                          {item.action === "restore-missing" && "+ A recuperar"}
                          {item.action === "skip-duplicate" && "Duplicado (omitir)"}
                          {item.action === "enrich-receipt" && "+ Recuperar recibo"}
                          {item.action === "ambiguous-review" && "⚠ Revisión manual"}
                          {item.action === "keep-current" && "Actual conservado"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* AVISO FINAL DE BLOQUEO DE ESCRITURA */}
              <div className="bg-slate-950/80 border border-amber-500/30 rounded-xl p-4 text-xs text-slate-300 flex items-start gap-3">
                <ShieldCheck className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1 text-[11px] leading-relaxed">
                  <strong className="text-white block text-xs">Simulación de Solo Lectura</strong>
                  Esta vista previa no aplica ningún cambio a Firestore ni a Storage. Para aplicar la recuperación real en producción se requerirá tu confirmación expresa tras revisar los importes y apuntes propuestos.
                </div>
              </div>

            </div>
          )}

        </div>
      )}

    </div>
  );
}
