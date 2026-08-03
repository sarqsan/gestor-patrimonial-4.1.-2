import React from "react";
import { AppState, SyncEvent } from "../types";
import { 
  RefreshCw, 
  Activity, 
  ShieldCheck, 
  CheckCircle, 
  Clock,
  Settings,
  XCircle
} from "lucide-react";

interface SyncStatusProps {
  state: AppState;
  onToggleSync: () => void;
  onClearLog: () => void;
}

export default function SyncStatus({ state, onToggleSync, onClearLog }: SyncStatusProps) {
  const { syncEvents, syncEnabled } = state;

  return (
    <div id="sync-status-root" className="space-y-8 animate-fade-in text-slate-100">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Centro de Sincronización Automática</h1>
          <p className="text-sm text-slate-400 mt-1">
            Supervisa la sincronización instantánea de tus rentas, gastos y cambios de amortización entre todos los módulos activos.
          </p>
        </div>
      </div>

      {/* SYNC CONFIG STATUS CARD */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center space-y-4 md:space-y-0 gap-6">
        <div className="flex items-center space-x-4">
          <div className={`p-3 rounded-xl ${
            syncEnabled ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
          }`}>
            {syncEnabled ? <RefreshCw className="w-6 h-6 animate-spin" style={{ animationDuration: '4s' }} /> : <XCircle className="w-6 h-6" />}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="font-bold text-white text-md">Sincronizador Multimódulo</h3>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase font-mono ${
                syncEnabled ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"
              }`}>
                {syncEnabled ? "Activo" : "Pausado"}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5 leading-normal">
              Cuando está activo, cualquier edición en un inmueble o registro de cobro recalcula el IRPF, actualiza los ratios de rendimiento en el Dashboard y refresca las amortizaciones del usuario.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggleSync}
          className={`px-5 py-2 rounded-xl text-xs font-semibold cursor-pointer transition-all shrink-0 ${
            syncEnabled 
              ? "bg-red-950/40 hover:bg-red-900/30 text-red-300 border border-red-500/20" 
              : "bg-emerald-950/40 hover:bg-emerald-900/30 text-emerald-300 border border-emerald-500/20"
          }`}
        >
          {syncEnabled ? "Desactivar Sincronización Automática" : "Activar Sincronización Automática"}
        </button>
      </div>

      {/* FIREBASE CLOUD DATABASE STATUS CARD */}
      <div className="bg-slate-800/40 border border-amber-500/30 rounded-2xl p-6 shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center space-y-4 md:space-y-0 gap-6">
        <div className="flex items-center space-x-4">
          <div className="p-3 bg-amber-500/20 text-amber-400 rounded-xl border border-amber-500/30 shrink-0">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="font-bold text-white text-md">Persistencia en Nube Firebase Firestore</h3>
              <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] px-2 py-0.5 rounded font-mono font-bold uppercase">
                En línea & Sincronizado
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 leading-normal">
              Tus inmuebles, gastos, cobros, contratos y perfiles fiscales se almacenan y sincronizan automáticamente en tu base de datos cloud de Firebase Firestore.
            </p>
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase font-mono text-slate-400">Usuario de Datos</div>
          <div className="text-xs font-bold text-amber-300 font-mono mt-0.5">{state.currentUser || "rentasync"}</div>
        </div>
      </div>

      {/* SYNC EVENTS AUDIT LOG */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 shadow-lg space-y-6">
        <div className="flex justify-between items-center">
          <h3 className="text-md font-bold text-white flex items-center">
            <Activity className="w-4.5 h-4.5 text-indigo-400 mr-2" />
            Registro de Eventos de Sincronización en Tiempo Real
          </h3>
          {syncEvents.length > 0 && (
            <button
              onClick={onClearLog}
              className="text-xs text-slate-400 hover:text-white transition-all font-semibold cursor-pointer hover:underline"
            >
              Limpiar Historial
            </button>
          )}
        </div>

        <div className="space-y-3.5 max-h-[400px] overflow-y-auto pr-2">
          {syncEvents.length > 0 ? (
            syncEvents.map((evt) => (
              <div key={evt.id} className="p-4 bg-slate-900/60 rounded-xl border border-slate-800 flex items-start space-x-3 text-xs">
                <div className="p-1.5 bg-indigo-600/10 text-indigo-400 rounded-lg shrink-0 mt-0.5">
                  <Clock className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex flex-col sm:flex-row justify-between text-[10px]">
                    <span className="font-mono text-indigo-300 uppercase tracking-wide">
                      {evt.sourceModule} ➔ {evt.targetModule}
                    </span>
                    <span className="text-slate-500 font-mono mt-0.5 sm:mt-0">{evt.timestamp}</span>
                  </div>
                  <h4 className="font-bold text-slate-200">{evt.action}</h4>
                  <p className="text-slate-400 text-xs font-sans leading-relaxed">{evt.details}</p>
                </div>
              </div>
            ))
          ) : (
            <div className="text-center text-slate-500 py-16 flex flex-col items-center justify-center space-y-2">
              <ShieldCheck className="w-10 h-10 text-slate-600" />
              <p className="text-sm font-medium">No se han registrado eventos de sincronización todavía.</p>
              <p className="text-xs text-slate-500">Realiza algún cambio en Inmuebles o Cobros para comprobar la sincronización automática.</p>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
