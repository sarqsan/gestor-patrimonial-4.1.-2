import React, { useState, useEffect, useRef } from "react";
import Onboarding from "./components/Onboarding";
import Dashboard from "./components/Dashboard";
import Properties from "./components/Properties";
import RentControl from "./components/RentControl";
import TaxCalculator from "./components/TaxCalculator";
import SyncStatus from "./components/SyncStatus";
import AuthScreen from "./components/AuthScreen";
import Expenses from "./components/Expenses";
import ContractCreator from "./components/ContractCreator";
import { AppState, Property, RentPayment, SyncEvent, PropertyExpense, SaveStatus, getThemeColors } from "./types";
import { checkPortfolioWrite, legacyDataUrlSet } from "./lib/portfolioGuard";
import { mergeMigratedReferences } from "./lib/portfolioMigrationRun";
import { portfolioBody } from "./lib/portfolioPayload";
import { extractYearFromDate, normalizeDateToIso } from "./lib/dateUtils";
import { mergeExpensesOnHydration, mergePropertiesOnHydration } from "./lib/portfolioHydration";
import { 
  saveMovement, 
  deleteMovement, 
  batchSaveMovements, 
  subscribeMovements, 
  reconcileMovements, 
  migrateLegacyPortfolioExpenses, 
  movementSignature 
} from "./lib/movementService";
import { db, doc, getDoc, setDoc, onSnapshot, handleFirestoreError, OperationType } from "./lib/firebase";
import { AlertTriangle, RotateCw, Loader2 } from "lucide-react";
import { 
  Menu, 
  ChevronDown, 
  Sparkles, 
  Activity, 
  LayoutDashboard, 
  Building, 
  Calendar, 
  Calculator, 
  LogOut,
  RefreshCw,
  Bell,
  Trash2,
  Receipt,
  FileText,
  Database
} from "lucide-react";

// Standard Spanish lease months
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

// Traduce errores de Firestore a mensajes visibles para el usuario.
function describePersistenceError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? "";
  if (code === "permission-denied") {
    return "Firestore ha rechazado la escritura (permisos). Los cambios no se han guardado en la nube.";
  }
  if (/exceeds|maximum size|1 ?MiB/i.test(msg)) {
    return "El documento de la cartera supera el tamaño máximo de Firestore (1 MiB). Los cambios no se han guardado en la nube.";
  }
  if (code === "unavailable") {
    return "Firestore no está disponible ahora mismo. Los cambios se conservan en este navegador; pulsa Reintentar.";
  }
  return `No se ha podido guardar en la nube (${msg}). Pulsa Reintentar.`;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    user1: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0 },
    user2: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false },
    properties: [],
    payments: [],
    expenses: [],
    syncEvents: [],
    syncEnabled: true,
    isOnboarded: false,
    isAuthenticated: false,
    currentUser: "",
    registeredUsers: {},
    currentYear: 2026,
    yearlyProfiles: {},
    theme: "slate-indigo"
  });

  const themeColors = getThemeColors(state.theme);

  const [activeTab, setActiveTab] = useState<"dashboard" | "properties" | "payments" | "expenses" | "taxes" | "sync" | "contracts">("dashboard");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  // Load initial session and users list
  useEffect(() => {
    const usersStr = localStorage.getItem("rentasync_users");
    const sessionStr = localStorage.getItem("rentasync_session");
    
    let registeredUsers: Record<string, string> = {};
    if (usersStr) {
      try {
        registeredUsers = JSON.parse(usersStr);
      } catch (e) {
        console.error(e);
      }
    }
    
    if (sessionStr) {
      try {
        const session = JSON.parse(sessionStr);
        if (session.isAuthenticated && session.currentUser) {
          const userStateStr = localStorage.getItem(`rentasync_state_${session.currentUser}`);
          if (userStateStr) {
            const parsed = JSON.parse(userStateStr);
            for (const v of legacyDataUrlSet(parsed)) legacyBaselineRef.current.add(v);
            setState({
              currentYear: 2026,
              yearlyProfiles: {},
              ...parsed,
              isAuthenticated: true,
              currentUser: session.currentUser,
              registeredUsers
            });
            return;
          }
        }
      } catch (e) {
        console.error("Error restoring session:", e);
      }
    }
    
    setState((prev) => ({
      ...prev,
      registeredUsers
    }));
  }, []);

  // ---- Persistencia ---------------------------------------------------------
  // updateState solo calcula el nuevo estado (sin efectos secundarios dentro del updater).
  // El guardado (localStorage + Firestore) ocurre en un efecto que solo actúa sobre
  // cambios locales (localChangeRef). Los datos recibidos de la nube nunca se reescriben.
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const localChangeRef = useRef(false);
  const dirtyRef = useRef(false); // hay cambios locales aún no confirmados por Firestore
  const lastSavedJsonRef = useRef<string | null>(null);
  // Base64 históricos conocidos (ya en la nube o cargados de la copia local). Se toleran
  // mientras existan; cualquier Base64 NUEVO se rechaza antes de escribir.
  const legacyBaselineRef = useRef<Set<string>>(new Set());
  const writeSeqRef = useRef(0);
  const lastOkSeqRef = useRef(0);


  const persistPortfolio = (userId: string, s: AppState) => {
    // Se mide el JSON exacto que se escribirá (sin undefined, como en Firestore).
    const body = JSON.parse(JSON.stringify(portfolioBody(s)));
    const json = JSON.stringify(body);
    const seq = ++writeSeqRef.current;

    // Guardia centralizada: rechaza Base64 nuevos y documentos sobre el margen seguro.
    const check = checkPortfolioWrite(body, { allowedLegacyDataUrls: legacyBaselineRef.current });
    if (!check.ok) {
      dirtyRef.current = true;
      setSaveStatus({ kind: "error", message: check.errors.join(" "), blocked: true, at: Date.now() });
      return;
    }

    // Evita escrituras idénticas a la última confirmada.
    if (json === lastSavedJsonRef.current) {
      dirtyRef.current = false;
      setSaveStatus({ kind: "saved", at: Date.now() });
      return;
    }

    setSaveStatus({ kind: "saving", at: Date.now() });
    const path = `users/${userId}/data/portfolio`;
    const userDocRef = doc(db, "users", userId, "data", "portfolio");

    // Si Firestore no confirma la escritura (p. ej. sin conexión) no se muestra "Guardando…" para siempre.
    let settled = false;
    const slowTimer = setTimeout(() => {
      if (!settled && seq === writeSeqRef.current) {
        dirtyRef.current = true;
        setSaveStatus({
          kind: "error",
          message: "La nube no ha confirmado el guardado tras 20 segundos (¿sin conexión?). Los cambios siguen en este navegador y Firestore seguirá intentando enviarlos.",
          at: Date.now(),
        });
      }
    }, 20000);

    setDoc(userDocRef, { ...body, updatedAt: new Date().toISOString() }, { merge: true })
      .then(() => {
        settled = true;
        clearTimeout(slowTimer);
        if (seq > lastOkSeqRef.current) {
          lastOkSeqRef.current = seq;
          lastSavedJsonRef.current = json;
          // Los Base64 de esta escritura ya están en la nube: pasan a ser conocidos.
          for (const v of legacyDataUrlSet(body)) legacyBaselineRef.current.add(v);
        }
        if (seq === writeSeqRef.current) {
          dirtyRef.current = false;
          setSaveStatus({ kind: "saved", at: Date.now() });
        }
      })
      .catch((err) => {
        settled = true;
        clearTimeout(slowTimer);
        dirtyRef.current = true;
        handleFirestoreError(err, OperationType.WRITE, path);
        if (seq === writeSeqRef.current) {
          setSaveStatus({ kind: "error", message: describePersistenceError(err), at: Date.now() });
        }
      });
  };

  // Efecto de guardado: copia local siempre que cambie el estado; nube solo ante cambios locales.
  useEffect(() => {
    if (!state.currentUser) return;
    try {
      localStorage.setItem(`rentasync_state_${state.currentUser}`, JSON.stringify(state));
    } catch (e) {
      console.error("Local copy save error:", e);
      setSaveStatus({
        kind: "error",
        message: "No se ha podido guardar la copia local de este navegador (almacenamiento lleno). La nube no se ha modificado por este motivo.",
        at: Date.now(),
      });
    }
    if (!localChangeRef.current) return;
    localChangeRef.current = false;
    persistPortfolio(state.currentUser, state);
  }, [state]);

  // Tras migrar o restaurar, la pantalla adopta el resultado de la nube.
  // - Migración: solo se aplican las referencias a Storage sobre el estado actual (no se pierden
  //   ediciones hechas durante la migración) y se guarda una vez el estado combinado.
  // - Restauración: la copia es el original, así que reemplaza el estado (sin escribir de nuevo).
  const handlePortfolioApplied = (raw: Record<string, unknown>, mode: "migrated" | "restored") => {
    const { updatedAt: _ignored, ...body } = raw as Record<string, unknown> & { updatedAt?: string };
    dirtyRef.current = false;
    lastSavedJsonRef.current = null;
    if (mode === "migrated") {
      legacyBaselineRef.current = new Set();
      localChangeRef.current = true; // guarda una vez el estado combinado (limpio) en la nube
      setState((prev) => mergeMigratedReferences(prev, body));
      return;
    }
    legacyBaselineRef.current = legacyDataUrlSet(body);
    localChangeRef.current = false;
    setState((prev) => ({
      ...prev,
      properties: (body.properties as Property[]) ?? prev.properties,
      payments: (body.payments as RentPayment[]) ?? prev.payments,
      expenses: (body.expenses as PropertyExpense[]) ?? prev.expenses,
      contracts: (body.contracts as any[]) ?? prev.contracts,
      syncEvents: (body.syncEvents as SyncEvent[]) ?? prev.syncEvents,
      yearlyProfiles: (body.yearlyProfiles as AppState["yearlyProfiles"]) ?? prev.yearlyProfiles,
      currentYear: (body.currentYear as number) ?? prev.currentYear,
      isOnboarded: (body.isOnboarded as boolean) ?? prev.isOnboarded,
      user1: (body.user1 as AppState["user1"]) ?? prev.user1,
      user2: (body.user2 as AppState["user2"]) ?? prev.user2,
    }));
    setSaveStatus({ kind: "saved", at: Date.now() });
  };

  const retrySave = () => {
    if (!state.currentUser) return;
    persistPortfolio(state.currentUser, state);
  };

  const updateState = (updater: (prev: AppState) => AppState) => {
    localChangeRef.current = true;
    setState((prev) => {
      let next = updater(prev);

      // Perform automated synchronization from actual registered expenses to property fields for the selected currentYear
      const year = next.currentYear || 2026;
      if (next.properties && next.properties.length > 0) {
        next.properties = next.properties.map((p) => {
          const propertyExpenses = (next.expenses || []).filter(
            (e) =>
              e.propertyId === p.id &&
              e.type === "gasto" &&
              extractYearFromDate(e.date) === year
          );

          const hasCommunity = propertyExpenses.some((e) => e.category === "community");
          const hasIBI = propertyExpenses.some((e) => e.category === "ibi");
          const hasInsurance = propertyExpenses.some((e) => e.category === "insurance");
          const hasRepairs = propertyExpenses.some((e) => e.category === "repairs");

          return {
            ...p,
            expensesCommunity: hasCommunity
              ? propertyExpenses.filter((e) => e.category === "community").reduce((sum, e) => sum + e.amount, 0)
              : p.expensesCommunity,
            expensesIBI: hasIBI
              ? propertyExpenses.filter((e) => e.category === "ibi").reduce((sum, e) => sum + e.amount, 0)
              : p.expensesIBI,
            expensesInsurance: hasInsurance
              ? propertyExpenses.filter((e) => e.category === "insurance").reduce((sum, e) => sum + e.amount, 0)
              : p.expensesInsurance,
            expensesRepairs: hasRepairs
              ? propertyExpenses.filter((e) => e.category === "repairs").reduce((sum, e) => sum + e.amount, 0)
              : p.expensesRepairs
          };
        });
      }

      return next;
    });
  };

  // Load and listen to Firestore changes for active logged in user
  useEffect(() => {
    if (!state.isAuthenticated || !state.currentUser) return;

    const path = `users/${state.currentUser}/data/portfolio`;
    const userDocRef = doc(db, "users", state.currentUser, "data", "portfolio");

    // Initial fetch from Firestore
    getDoc(userDocRef)
      .then((snapshot) => {
        if (dirtyRef.current) return; // cambios locales pendientes: no sobrescribir con la nube
        if (snapshot.exists()) {
          const cloudData = snapshot.data();
          for (const v of legacyDataUrlSet(cloudData)) legacyBaselineRef.current.add(v);
          setState((prev) => {
            const mergedExpenses = mergeExpensesOnHydration(cloudData.expenses, prev.expenses);
            const mergedProperties = mergePropertiesOnHydration(cloudData.properties, prev.properties);
            if (mergedExpenses.length > (cloudData.expenses?.length || 0)) {
              localChangeRef.current = true;
            }
            return {
              ...prev,
              properties: mergedProperties,
              payments: cloudData.payments || prev.payments,
              expenses: mergedExpenses,
              contracts: cloudData.contracts || prev.contracts,
              syncEvents: cloudData.syncEvents || prev.syncEvents,
              yearlyProfiles: cloudData.yearlyProfiles || prev.yearlyProfiles,
              currentYear: cloudData.currentYear || prev.currentYear || 2026,
              isOnboarded: cloudData.isOnboarded !== undefined ? cloudData.isOnboarded : prev.isOnboarded,
              user1: cloudData.user1 || prev.user1,
              user2: cloudData.user2 || prev.user2,
            };
          });
        }
      })
      .catch((err) => {
        handleFirestoreError(err, OperationType.GET, path);
        setSaveStatus({
          kind: "error",
          message: `Error al leer de la nube (${describePersistenceError(err)}). Se mantienen los datos locales de este dispositivo.`,
          at: Date.now(),
        });
      });

    // Subscribe to real-time updates for portfolio master document
    const unsubscribe = onSnapshot(
      userDocRef,
      (docSnap) => {
        // Si hay cambios locales sin confirmar, no los reemplazamos silenciosamente por la nube.
        if (dirtyRef.current) return;
        if (docSnap.exists()) {
          const cloudData = docSnap.data();
          for (const v of legacyDataUrlSet(cloudData)) legacyBaselineRef.current.add(v);
          setState((prev) => {
            const mergedExpenses = mergeExpensesOnHydration(cloudData.expenses, prev.expenses);
            const mergedProperties = mergePropertiesOnHydration(cloudData.properties, prev.properties);
            return {
              ...prev,
              properties: mergedProperties,
              payments: cloudData.payments || prev.payments,
              expenses: mergedExpenses,
              contracts: cloudData.contracts || prev.contracts,
              syncEvents: cloudData.syncEvents || prev.syncEvents,
              yearlyProfiles: cloudData.yearlyProfiles || prev.yearlyProfiles,
              currentYear: cloudData.currentYear || prev.currentYear || 2026,
            };
          });
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, path);
        setSaveStatus({
          kind: "error",
          message: `Error en la sincronización en tiempo real (${describePersistenceError(err)}).`,
          at: Date.now(),
        });
      }
    );

    // Subscribe to movements subcollection (users/{currentUser}/expenses)
    const unsubscribeMovements = subscribeMovements(
      state.currentUser,
      (remoteMovements) => {
        if (remoteMovements.length > 0) {
          setState((prev) => ({
            ...prev,
            expenses: reconcileMovements(prev.expenses, remoteMovements),
          }));
        }
      },
      (err) => {
        console.warn("Subcolección de gastos no disponible en tiempo real:", err);
      }
    );

    return () => {
      unsubscribe();
      unsubscribeMovements();
    };
  }, [state.currentUser, state.isAuthenticated]);

  // Toast notifier
  const triggerNotification = (message: string) => {
    setNotification(message);
    setTimeout(() => setNotification(null), 4000);
  };

  // Sync logger helper
  const addSyncEvent = (source: string, target: string, action: string, details: string) => {
    if (!state.syncEnabled) return;
    
    const newEvent: SyncEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toLocaleTimeString('es-ES'),
      sourceModule: source,
      targetModule: target,
      action,
      details
    };

    updateState((prev) => ({
      ...prev,
      syncEvents: [newEvent, ...prev.syncEvents].slice(0, 100) // Keep last 100 events
    }));

    triggerNotification(`📝 ${action}`);
  };

  // ONBOARDING COMPLETE
  const handleOnboardingComplete = (extracted: Partial<AppState>) => {
    // Generate pre-populated payments for past months of the current year (2026) to make it interactive and realistic
    const generatedPayments: RentPayment[] = [];
    const generatedExpenses: PropertyExpense[] = [];
    const currentYear = 2026;
    
    if (extracted.properties) {
      extracted.properties.forEach((prop) => {
        // Pre-fill Enero to Diciembre as Pending
        MONTHS.forEach((m) => {
          generatedPayments.push({
            id: `pay_${prop.id}_${m}`,
            propertyId: prop.id,
            month: m,
            year: currentYear,
            amount: prop.monthlyRent,
            status: 'pending'
          });
        });
      });
    }

    updateState((prev) => {
      const next: AppState = {
        ...prev,
        user1: extracted.user1 || { name: "Usuario 1", dni: "12345678A", brutoTrabajo: 36200, netoTrabajo: 31800 },
        user2: extracted.user2 || { name: "Usuario 2", dni: "87654321K", brutoTrabajo: 29500, netoTrabajo: 25100, hasPartner: true },
        properties: extracted.properties || [],
        payments: generatedPayments,
        expenses: generatedExpenses,
        syncEvents: [
          {
            id: `evt_onboard`,
            timestamp: new Date().toLocaleTimeString('es-ES'),
            sourceModule: "Agencia Tributaria (AI Extraction)",
            targetModule: "Dashboard Consolidado",
            action: "Perfil fiscal y cartera cargada",
            details: `Importado con éxito. Se detectaron ${extracted.properties?.length || 0} inmuebles arrendados y datos laborales de ambos cónyuges.`
          },
          ...(prev.syncEvents || [])
        ],
        syncEnabled: true,
        isOnboarded: true
      };
      return next;
    });

    setActiveTab("dashboard");
    triggerNotification("🚀 Perfil fiscal e inmuebles importados con éxito!");
  };

  // ADD PROPERTY
  const handleAddProperty = (newProp: Property) => {
    updateState((prev) => {
      // Create payments for this new property
      const currentYear = 2026;
      const newPayments = MONTHS.map((m) => ({
        id: `pay_${newProp.id}_${m}`,
        propertyId: newProp.id,
        month: m,
        year: currentYear,
        amount: newProp.monthlyRent,
        status: 'pending' as const
      }));

      return {
        ...prev,
        properties: [...prev.properties, newProp],
        payments: [...prev.payments, ...newPayments]
      };
    });

    addSyncEvent(
      "Cartera Inmuebles",
      "Matriz de Cobros & Simulador Fiscal",
      `Nuevo inmueble en ${newProp.address.split(",")[0]}`,
      `Se ha añadido el inmueble con una renta mensual de ${newProp.monthlyRent}€ y calculado su amortización fiscal anual (${newProp.amortizationAmount}€).`
    );
  };

  // EDIT PROPERTY
  const handleEditProperty = (updatedProp: Property) => {
    updateState((prev) => {
      // Actualizar la renta mensual en los cobros pendientes si se modificó
      const updatedPayments = prev.payments.map((p) => {
        if (p.propertyId === updatedProp.id && p.status === "pending") {
          return { ...p, amount: updatedProp.monthlyRent };
        }
        return p;
      });

      return {
        ...prev,
        // Los movimientos contables detallados, sus justificantes e IDs se conservan íntegros:
        // modificar importes estimados en la ficha jamás destruye ni colapsa recibos registrados.
        expenses: prev.expenses || [],
        properties: prev.properties.map((p) => (p.id === updatedProp.id ? updatedProp : p)),
        payments: updatedPayments,
      };
    });

    addSyncEvent(
      "Cartera Inmuebles",
      "Dashboard & Simulador IRPF",
      `Actualización inmueble ${updatedProp.address.split(",")[0]}`,
      `Modificados parámetros fiscales y renta del inmueble sin alterar los movimientos contables registrados.`
    );
  };

  // DELETE PROPERTY
  const handleDeleteProperty = (id: string) => {
    const prop = state.properties.find(p => p.id === id);
    if (!prop) return;

    updateState((prev) => ({
      ...prev,
      properties: prev.properties.filter((p) => p.id !== id),
      payments: prev.payments.filter((p) => p.propertyId !== id)
    }));

    addSyncEvent(
      "Cartera Inmuebles",
      "Matriz de Cobros",
      `Inmueble eliminado: ${prop.address.split(",")[0]}`,
      "Retirado de la cartera. Se han purgado todos sus registros de cobro pendientes e históricos."
    );
  };

  // UPDATE PAYMENT STATUS
  const handleUpdatePaymentStatus = (propertyId: string, month: string, year: number, status: 'paid' | 'pending' | 'late') => {
    const prop = state.properties.find(p => p.id === propertyId);
    if (!prop) return;

    updateState((prev) => {
      const updatedPayments = prev.payments.map((p) => {
        if (p.propertyId === propertyId && p.month === month && p.year === year) {
          return { 
            ...p, 
            status, 
            datePaid: status === 'paid' ? new Date().toLocaleDateString('es-ES') : undefined 
          };
        }
        return p;
      });
      return { ...prev, payments: updatedPayments };
    });

    addSyncEvent(
      "Matriz de Cobros",
      "Dashboard Financiero",
      `Cobro ${status === 'paid' ? 'Recibido' : status === 'late' ? 'Demorado' : 'Pendiente'} - ${month}`,
      `El alquiler de ${prop.address.split(",")[0]} para el mes de ${month} se ha marcado como ${status.toUpperCase()}.`
    );
  };

  const handleToggleSync = () => {
    updateState((prev) => ({ ...prev, syncEnabled: !prev.syncEnabled }));
    triggerNotification(`Sincronización automática ${!state.syncEnabled ? "ACTIVADA" : "DESACTIVADA"}`);
  };

  const handleClearLog = () => {
    updateState((prev) => ({ ...prev, syncEvents: [] }));
    triggerNotification("Historial de sincronización purgado");
  };

  // ADD EXPENSE OR INCOME
  const handleAddExpense = (newExpense: PropertyExpense) => {
    const expenseWithStatus: PropertyExpense = {
      ...newExpense,
      status: "pending",
      date: normalizeDateToIso(newExpense.date) || newExpense.date,
      type: newExpense.type || (newExpense.category === "rent" ? "ingreso" : "gasto"),
    };

    updateState((prev) => ({
      ...prev,
      expenses: [...(prev.expenses || []).filter((e) => e.id !== newExpense.id), expenseWithStatus]
    }));

    if (state.currentUser) {
      saveMovement(state.currentUser, expenseWithStatus)
        .then((res) => {
          if (res.ok) {
            updateState((prev) => ({
              ...prev,
              expenses: (prev.expenses || []).map((e) =>
                e.id === newExpense.id ? { ...e, status: "synced" } : e
              ),
            }));
            triggerNotification(`✓ Guardado en Firebase: ${newExpense.amount}€ (${newExpense.category})`);
          } else {
            updateState((prev) => ({
              ...prev,
              expenses: (prev.expenses || []).map((e) =>
                e.id === newExpense.id ? { ...e, status: "error" } : e
              ),
            }));
            triggerNotification(`⚠ Error al guardar en Firebase: ${res.error}`);
          }
        })
        .catch((err) => {
          updateState((prev) => ({
            ...prev,
            expenses: (prev.expenses || []).map((e) =>
              e.id === newExpense.id ? { ...e, status: "error" } : e
            ),
          }));
          triggerNotification(`⚠ Error de conexión: ${err.message || String(err)}`);
        });
    }

    const prop = state.properties.find(p => p.id === newExpense.propertyId);
    addSyncEvent(
      "Gestión de Gastos",
      "Simulador de Impuestos (Modelo 100)",
      `${newExpense.type === "ingreso" ? "Ingreso" : "Gasto"} registrado: ${newExpense.amount}€`,
      `Registrado apunte de ${newExpense.amount}€ en concepto de "${newExpense.category}" para el inmueble en ${prop ? prop.address.split(",")[0] : "Desconocido"}. Sincronizado para deducción del IRPF.`
    );
  };

  // EDIT EXPENSE OR INCOME
  const handleEditExpense = (updatedExpense: PropertyExpense) => {
    const withStatus: PropertyExpense = {
      ...updatedExpense,
      status: "pending",
      date: normalizeDateToIso(updatedExpense.date) || updatedExpense.date,
      type: updatedExpense.type || (updatedExpense.category === "rent" ? "ingreso" : "gasto"),
    };

    updateState((prev) => ({
      ...prev,
      expenses: (prev.expenses || []).map((e) => (e.id === updatedExpense.id ? withStatus : e)),
    }));

    if (state.currentUser) {
      saveMovement(state.currentUser, withStatus)
        .then((res) => {
          if (res.ok) {
            updateState((prev) => ({
              ...prev,
              expenses: (prev.expenses || []).map((e) =>
                e.id === updatedExpense.id ? { ...e, status: "synced" } : e
              ),
            }));
            triggerNotification(`✓ Modificación guardada en Firebase: ${updatedExpense.amount}€`);
          } else {
            updateState((prev) => ({
              ...prev,
              expenses: (prev.expenses || []).map((e) =>
                e.id === updatedExpense.id ? { ...e, status: "error" } : e
              ),
            }));
            triggerNotification(`⚠ Error al actualizar en Firebase: ${res.error}`);
          }
        })
        .catch((err) => {
          triggerNotification(`⚠ Error de conexión: ${err.message || String(err)}`);
        });
    }

    addSyncEvent(
      "Gestión de Gastos",
      "Libro Diario Unificado",
      `Movimiento editado: ${updatedExpense.amount}€`,
      `Actualizada operación ${updatedExpense.id} en ${updatedExpense.category}.`
    );
  };

  // UPDATE RECEIPT REFERENCE OF AN EXISTING EXPENSE (functional update, no stale list)
  const handleUpdateExpenseReceipt = (id: string, patch: Partial<PropertyExpense>) => {
    updateState((prev) => ({
      ...prev,
      expenses: (prev.expenses || []).map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));

    if (state.currentUser) {
      const exp = (state.expenses || []).find((e) => e.id === id);
      if (exp) {
        saveMovement(state.currentUser, { ...exp, ...patch }).catch((err) => {
          console.warn("Error persistiendo referencia de comprobante:", err);
        });
      }
    }
  };

  // DELETE EXPENSE
  const handleDeleteExpense = (id: string) => {
    const expense = (state.expenses || []).find(e => e.id === id);
    if (!expense) return;

    if (state.currentUser) {
      deleteMovement(state.currentUser, id).catch((err) => {
        console.error("Error eliminando movimiento en Firestore:", err);
      });
    }

    updateState((prev) => {
      const updatedExpenses = (prev.expenses || []).filter((e) => e.id !== id);
      const year = prev.currentYear || 2026;
      const expenseYear = extractYearFromDate(expense.date) || 0;

      let updatedProperties = prev.properties;
      if (expenseYear === year) {
        updatedProperties = prev.properties.map((p) => {
          if (p.id === expense.propertyId) {
            const hasMoreOfSameCategory = updatedExpenses.some(
              (e) =>
                e.propertyId === p.id &&
                e.category === expense.category &&
                e.type === "gasto" &&
                extractYearFromDate(e.date) === year
            );

            if (!hasMoreOfSameCategory) {
              const fieldMap: Record<string, string> = {
                community: "expensesCommunity",
                ibi: "expensesIBI",
                insurance: "expensesInsurance",
                repairs: "expensesRepairs"
              };
              const field = fieldMap[expense.category];
              if (field) {
                return {
                  ...p,
                  [field]: 0
                };
              }
            }
          }
          return p;
        });
      }

      return {
        ...prev,
        properties: updatedProperties,
        expenses: updatedExpenses
      };
    });

    addSyncEvent(
      "Gestión de Gastos",
      "Simulador de Impuestos",
      `Gasto de ${expense.amount}€ eliminado`,
      `Se ha eliminado el gasto de ${expense.amount}€ y actualizado la base imponible deducible.`
    );
  };

  // BULK IMPORT EXPENSES & INCOMES
  const handleImportExpenses = async (newExpenses: PropertyExpense[], mode: 'merge' | 'replace'): Promise<{ ok: boolean; savedCount: number; errors: string[] }> => {
    let finalExpenses: PropertyExpense[] = [];
    let toSaveInDb: PropertyExpense[] = [];

    updateState((prev) => {
      if (mode === 'replace') {
        finalExpenses = newExpenses.map(e => ({ ...e, status: "pending" as const }));
        toSaveInDb = finalExpenses;
      } else {
        // Conciliación idempotente por ID y firma contable: NUNCA duplicar
        const existingIds = new Set((prev.expenses || []).map(e => e.id));
        const existingSigs = new Set((prev.expenses || []).map(movementSignature));
        const deduplicatedNew: PropertyExpense[] = [];

        for (const e of newExpenses) {
          const sig = movementSignature(e);
          if (!existingIds.has(e.id) && !existingSigs.has(sig)) {
            deduplicatedNew.push({ ...e, status: "pending" });
            existingIds.add(e.id);
            existingSigs.add(sig);
          }
        }
        finalExpenses = [...(prev.expenses || []), ...deduplicatedNew];
        toSaveInDb = deduplicatedNew;
      }

      return {
        ...prev,
        expenses: finalExpenses
      };
    });

    // Guardar lote en Firestore subcolección esperando confirmación
    if (state.currentUser && toSaveInDb.length > 0) {
      try {
        const res = await batchSaveMovements(state.currentUser, toSaveInDb);
        if (res.ok) {
          updateState((p) => ({
            ...p,
            expenses: (p.expenses || []).map((e) => ({ ...e, status: "synced" })),
          }));
          triggerNotification(`✓ ${res.savedCount} movimientos persistidos en Firebase`);
          addSyncEvent(
            "Gestión de Gastos",
            "Perfil & Firestore Cloud",
            `Importadas ${newExpenses.length} operaciones`,
            `Se han integrado masivamente ${newExpenses.length} gastos/ingresos en el perfil activo.`
          );
          return { ok: true, savedCount: res.savedCount, errors: [] };
        } else {
          triggerNotification(`⚠ Importación guardada parcialmente: ${res.errors.join(", ")}`);
          return { ok: false, savedCount: res.savedCount, errors: res.errors };
        }
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Error en batchSaveMovements:", err);
        return { ok: false, savedCount: 0, errors: [msg] };
      }
    }

    addSyncEvent(
      "Gestión de Gastos",
      "Perfil & Firestore Cloud",
      `Importadas ${newExpenses.length} operaciones`,
      `Se han integrado masivamente ${newExpenses.length} gastos/ingresos en el perfil activo.`
    );
    return { ok: true, savedCount: toSaveInDb.length, errors: [] };
  };

  // BULK IMPORT PROPERTIES
  const handleImportProperties = (newProps: Property[], mode: 'merge' | 'replace') => {
    updateState((prev) => {
      let finalProps: Property[];
      if (mode === 'replace') {
        finalProps = newProps;
      } else {
        const existingIds = new Set(prev.properties.map(p => p.id));
        const existingRefs = new Set(prev.properties.map(p => p.cadastralReference).filter(Boolean));

        const deduplicatedNew = newProps.map(p => {
          if (existingIds.has(p.id) || (p.cadastralReference && existingRefs.has(p.cadastralReference))) {
            return { ...p, id: `prop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}` };
          }
          return p;
        });
        finalProps = [...prev.properties, ...deduplicatedNew];
      }

      // Generate clean payment schedules for 2026 for imported properties that don't have them yet
      const currentYear = prev.currentYear || 2026;
      const existingPaymentKeys = new Set(prev.payments.map(pay => `${pay.propertyId}_${pay.month}_${pay.year}`));
      const newPayments: RentPayment[] = [];

      finalProps.forEach(prop => {
        MONTHS.forEach(m => {
          const key = `${prop.id}_${m}_${currentYear}`;
          if (!existingPaymentKeys.has(key)) {
            newPayments.push({
              id: `pay_${prop.id}_${m}_${currentYear}`,
              propertyId: prop.id,
              month: m,
              year: currentYear,
              amount: prop.monthlyRent || 0,
              status: 'pending'
            });
          }
        });
      });

      return {
        ...prev,
        properties: finalProps,
        payments: [...prev.payments, ...newPayments]
      };
    });

    addSyncEvent(
      "Cartera Inmuebles",
      "Perfil & Firestore Cloud",
      `Importados ${newProps.length} inmuebles`,
      `Se han integrado masivamente ${newProps.length} inmuebles en el perfil activo.`
    );

    triggerNotification(`🏢 ¡${newProps.length} inmuebles importados con éxito!`);
  };

  const handleUpdateCurrentYear = (year: number) => {
    updateState((prev) => ({
      ...prev,
      currentYear: year
    }));
    triggerNotification(`📅 Ejercicio fiscal cambiado al año ${year}`);
  };

  const handleLoadTaxDeclarationForYear = (
    year: number,
    u1?: { brutoTrabajo: number; netoTrabajo: number },
    u2?: { brutoTrabajo: number; netoTrabajo: number },
    newProperties?: Property[]
  ) => {
    updateState((prev) => {
      // Retrieve existing profile for the year if any
      const existingProfile = prev.yearlyProfiles?.[year];

      const newUser1 = u1
        ? { ...(existingProfile?.user1 || prev.user1), brutoTrabajo: u1.brutoTrabajo, netoTrabajo: u1.netoTrabajo }
        : (existingProfile?.user1 || { ...prev.user1, brutoTrabajo: 0, netoTrabajo: 0 });

      const newUser2 = u2
        ? { ...(existingProfile?.user2 || prev.user2), brutoTrabajo: u2.brutoTrabajo, netoTrabajo: u2.netoTrabajo, hasPartner: prev.user2.hasPartner }
        : (existingProfile?.user2 || { ...prev.user2, brutoTrabajo: 0, netoTrabajo: 0, hasPartner: prev.user2.hasPartner });

      // Merge user work incomes for this specific year
      const updatedYearlyProfiles = {
        ...(prev.yearlyProfiles || {}),
        [year]: {
          user1: newUser1,
          user2: newUser2
        }
      };

      // Also merge any new properties detected, de-duplicating by address/cadastral reference
      let mergedProperties = [...prev.properties];
      let addedPropertiesCount = 0;
      if (newProperties && newProperties.length > 0) {
        newProperties.forEach((newP) => {
          const exists = prev.properties.some(
            (p) => p.cadastralReference === newP.cadastralReference || p.address.toLowerCase() === newP.address.toLowerCase()
          );
          if (!exists) {
            mergedProperties.push({
              ...newP,
              id: `prop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
            });
            addedPropertiesCount++;
          }
        });
      }

      // Generate clean pending payments for the selected year (no automatic expenses or paid rents)
      const generatedPayments: RentPayment[] = [];
      const generatedExpenses: PropertyExpense[] = [];
      
      mergedProperties.forEach((prop) => {
        // Only generate if they don't already exist for this year
        const paymentsExist = prev.payments.some((p) => p.propertyId === prop.id && p.year === year);
        if (!paymentsExist) {
          // All months start as pending by default, with NO pre-filled expenses or incomes
          MONTHS.forEach((m) => {
            generatedPayments.push({
              id: `pay_${prop.id}_${m}_${year}`,
              propertyId: prop.id,
              month: m,
              year: year,
              amount: prop.monthlyRent,
              status: "pending"
            });
          });
        }
      });

      return {
        ...prev,
        currentYear: year,
        yearlyProfiles: updatedYearlyProfiles,
        properties: mergedProperties,
        payments: [...prev.payments, ...generatedPayments],
        expenses: [...(prev.expenses || []), ...generatedExpenses]
      };
    });

    addSyncEvent(
      "Declaración Ejercicio Fiscal",
      "Dashboard Consolidado",
      `Cargado ejercicio ${year}`,
      `Se han integrado con éxito los datos laborales del ejercicio ${year}. Los cobros del año se han inicializado limpios en estado pendiente, listos para su gestión manual.`
    );

    triggerNotification(`📊 ¡Declaración fiscal del ejercicio ${year} integrada correctamente!`);
  };

  const handleLoginSuccess = (username: string, updatedRegisteredUsers: Record<string, string>) => {
    // 1. Save users list globally
    localStorage.setItem("rentasync_users", JSON.stringify(updatedRegisteredUsers));
    
    // 2. Load the specific user state or fall back to empty state
    const savedUserKey = `rentasync_state_${username}`;
    const savedUserStateStr = localStorage.getItem(savedUserKey);
    let loadedState: AppState;
    if (savedUserStateStr) {
      try {
        const parsed = JSON.parse(savedUserStateStr);
        loadedState = {
          currentYear: 2026,
          yearlyProfiles: {},
          ...parsed,
          currentUser: username,
          isAuthenticated: true,
          registeredUsers: updatedRegisteredUsers
        };
      } catch (e) {
        loadedState = {
          user1: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0 },
          user2: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false },
          properties: [],
          payments: [],
          expenses: [],
          syncEvents: [],
          syncEnabled: true,
          isOnboarded: false,
          isAuthenticated: true,
          currentUser: username,
          registeredUsers: updatedRegisteredUsers,
          currentYear: 2026,
          yearlyProfiles: {}
        };
      }
    } else {
      loadedState = {
        user1: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0 },
        user2: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false },
        properties: [],
        payments: [],
        expenses: [],
        syncEvents: [],
        syncEnabled: true,
        isOnboarded: false,
        isAuthenticated: true,
        currentUser: username,
        registeredUsers: updatedRegisteredUsers,
        currentYear: 2026,
        yearlyProfiles: {}
      };
    }
    
    // 3. Update state
    setState(loadedState);
    localStorage.setItem("rentasync_session", JSON.stringify({ currentUser: username, isAuthenticated: true }));
    triggerNotification(`🔑 ¡Sesión iniciada como ${username}!`);
  };

  const handleRegisterSuccess = (updatedRegisteredUsers: Record<string, string>) => {
    localStorage.setItem("rentasync_users", JSON.stringify(updatedRegisteredUsers));
    setState((prev) => ({
      ...prev,
      registeredUsers: updatedRegisteredUsers
    }));
    triggerNotification("👤 Nueva cuenta registrada con éxito.");
  };

  const handleLogout = () => {
    if (dirtyRef.current && !confirm("Hay cambios que NO se han guardado en la nube. Si cierras sesión ahora, solo quedarán en este navegador. ¿Cerrar sesión de todos modos?")) {
      return;
    }
    // Save current user state before clearing
    if (state.currentUser) {
      localStorage.setItem(`rentasync_state_${state.currentUser}`, JSON.stringify(state));
    }
    
    // Clear session in localStorage
    localStorage.removeItem("rentasync_session");
    
    setState((prev) => ({
      user1: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0 },
      user2: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false },
      properties: [],
      payments: [],
      expenses: [],
      syncEvents: [],
      syncEnabled: true,
      isOnboarded: false,
      isAuthenticated: false,
      currentUser: "",
      registeredUsers: prev.registeredUsers
    }));
    
    triggerNotification("🔒 Sesión cerrada correctamente.");
  };

  const handleResetData = () => {
    if (confirm("¿Estás seguro de que quieres reiniciar la cartera? Se borrarán todos los inmuebles, cobros y gastos registrados, pero se conservará tu cuenta de usuario.")) {
      updateState((prev) => ({
        ...prev,
        user1: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0 },
        user2: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false },
        properties: [],
        payments: [],
        expenses: [],
        syncEvents: [],
        syncEnabled: true,
        isOnboarded: false
      }));
      setActiveTab("dashboard");
      triggerNotification("⚠️ Cartera reiniciada. Completa el onboarding de nuevo.");
    }
  };

  // Auth Guard
  if (!state.isAuthenticated) {
    return (
      <AuthScreen 
        onLoginSuccess={handleLoginSuccess} 
        onRegisterSuccess={handleRegisterSuccess}
        registeredUsersInitial={state.registeredUsers || {}} 
      />
    );
  }

  // Onboarding Tab
  if (!state.isOnboarded) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  // Dropdown list
  const tabConfig = {
    dashboard: { label: "Panel de Control", icon: LayoutDashboard },
    properties: { label: "Cartera de Inmuebles (Mis Inmuebles)", icon: Building },
    expenses: { label: "Gestión de Gastos de Alquiler", icon: Receipt },
    contracts: { label: "Redactor de Contratos (Ley Vivienda 2024)", icon: FileText },
    taxes: { label: "Simulador e Impuestos (Modelo 100)", icon: Calculator },
    sync: { label: "Centro de Sincronización Automática", icon: Activity },
  };

  const ActiveIconComponent = tabConfig[activeTab].icon;

  return (
    <div id="app-workspace" className={`min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased max-w-full overflow-x-hidden theme-${state.theme || "slate-indigo"}`}>
      
      {/* HEADER BAR */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-3 sm:px-6 py-3 flex items-center justify-between gap-2 shadow-lg max-w-full">
        <div className="flex items-center space-x-2.5 min-w-0 shrink">
          <div className={`${themeColors.primaryBgLight} ${themeColors.primaryText} p-1.5 sm:p-2 rounded-xl border ${themeColors.primaryBorder} shrink-0`}>
            <Sparkles className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center space-x-1.5">
              <span className={`text-[9px] sm:text-[10px] uppercase font-mono tracking-wider font-extrabold ${themeColors.primaryText} hidden sm:block leading-tight`}>Agencia Inteligente</span>
              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[8px] sm:text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold hidden xs:flex items-center gap-1 shrink-0">
                <Database className="w-2.5 h-2.5 text-amber-400" /> Firebase
              </span>
            </div>
            <h1 className="text-xs sm:text-sm font-black text-white tracking-tight truncate">RentaSync</h1>
          </div>
        </div>

        {/* REVOLUTIONARY MODULE SELECTOR DROPDOWN */}
        <div className="relative shrink-0 min-w-0 z-50">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="inline-flex items-center justify-between px-2.5 sm:px-4 py-1.5 sm:py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700/60 rounded-xl text-xs font-semibold text-slate-200 transition-all cursor-pointer min-w-0 max-w-[170px] xs:max-w-[220px] sm:max-w-xs sm:min-w-[220px] shadow-sm select-none"
          >
            <div className="flex items-center space-x-1.5 sm:space-x-2 truncate min-w-0">
              <ActiveIconComponent className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${themeColors.primaryText} shrink-0`} />
              <span className="truncate text-[11px] sm:text-xs">{tabConfig[activeTab].label}</span>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ml-1 text-slate-500 shrink-0 transition-transform duration-200 ${dropdownOpen ? "rotate-180" : ""}`} />
          </button>

          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)}></div>
              <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-1.5rem)] bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl py-2 z-50 animate-slide-in">
                <div className="px-3 py-2 border-b border-slate-800">
                  <span className="text-[10px] uppercase font-mono tracking-wider font-bold text-slate-500">Módulos Activos y Sincronizados</span>
                </div>
                {Object.entries(tabConfig).map(([key, value]) => {
                  const Icon = value.icon;
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setActiveTab(key as any);
                        setDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-3 text-xs flex items-center space-x-3 transition-colors hover:bg-slate-800/60 ${
                        activeTab === key ? `${themeColors.primaryText} font-bold ${themeColors.primaryBgLight}` : "text-slate-300"
                      }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${activeTab === key ? themeColors.primaryText : "text-slate-400"}`} />
                      <span>{value.label}</span>
                    </button>
                  );
                })}
                <div className="border-t border-slate-800 mt-1 pt-1 space-y-0.5">
                  <button
                    onClick={() => { setDropdownOpen(false); handleLogout(); }}
                    className="w-full text-left px-4 py-2 text-xs text-amber-400 hover:bg-amber-950/20 flex items-center space-x-3 transition-colors"
                  >
                    <LogOut className="w-4 h-4 shrink-0 text-amber-400" />
                    <span>Cerrar Sesión (Sign Out)</span>
                  </button>
                  <button
                    onClick={() => { setDropdownOpen(false); handleResetData(); }}
                    className="w-full text-left px-4 py-2 text-xs text-red-400 hover:bg-red-950/20 flex items-center space-x-3 transition-colors"
                  >
                    <Trash2 className="w-4 h-4 shrink-0 text-red-400" />
                    <span>Reiniciar Cartera (Wipe Data)</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </header>

      {/* NOTIFICATION FLOATING BANNER */}
      {notification && (
        <div className="fixed bottom-4 right-4 z-50 bg-slate-900 border border-indigo-500/40 text-slate-200 px-4 py-3 rounded-xl flex items-center space-x-3 shadow-2xl animate-slide-in font-sans text-xs">
          <div className={`p-1 ${themeColors.primaryBgLight} ${themeColors.primaryText} rounded-lg animate-bounce`}>
            <Bell className="w-4 h-4" />
          </div>
          <span>{notification}</span>
        </div>
      )}

      {/* PERSISTENCE STATUS BANNER (errores reales de guardado) */}
      {(saveStatus.kind === "error" || saveStatus.kind === "saving") && (
        <div
          role={saveStatus.kind === "error" ? "alert" : "status"}
          className={`mx-auto max-w-7xl w-full px-4 sm:px-6 pt-4`}
        >
          <div className={`flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3 text-xs ${
            saveStatus.kind === "error"
              ? "bg-red-950/40 border-red-500/40 text-red-200"
              : "bg-slate-900 border-slate-700 text-slate-300"
          }`}>
            {saveStatus.kind === "error" ? (
              <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
            ) : (
              <Loader2 className="w-4 h-4 shrink-0 animate-spin text-indigo-400 mt-0.5" />
            )}
            <span className="flex-1 min-w-[200px]">
              {saveStatus.kind === "error" ? saveStatus.message : "Guardando cambios en la nube…"}
            </span>
            {saveStatus.kind === "error" && !saveStatus.blocked && (
              <button
                type="button"
                onClick={retrySave}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-100 font-semibold cursor-pointer"
              >
                <RotateCw className="w-3.5 h-3.5" /> Reintentar
              </button>
            )}
          </div>
        </div>
      )}

      {/* PRIMARY WORKSPACE */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        
        {/* Render Active Tab */}
        {activeTab === "dashboard" && (
          <Dashboard 
            state={state} 
            onAddExpense={handleAddExpense} 
            onUpdateCurrentYear={handleUpdateCurrentYear}
            onLoadTaxDeclarationForYear={handleLoadTaxDeclarationForYear}
            onUpdateTheme={(theme) => updateState(prev => ({ ...prev, theme }))}
          />
        )}
        
        {activeTab === "properties" && (
          <Properties 
            currentUser={state.currentUser}
            properties={state.properties} 
            onAddProperty={handleAddProperty}
            onEditProperty={handleEditProperty}
            onDeleteProperty={handleDeleteProperty}
            onDeleteExpense={handleDeleteExpense}
            onImportProperties={handleImportProperties}
            user1Name={state.user1.name}
            user2Name={state.user2.name}
            hasPartner={state.user2.hasPartner}
            expenses={state.expenses || []}
            currentYear={state.currentYear || 2026}
          />
        )}

        {activeTab === "expenses" && (
          <Expenses 
            properties={state.properties} 
            expenses={state.expenses || []} 
            onAddExpense={handleAddExpense}
            onEditExpense={handleEditExpense}
            onDeleteExpense={handleDeleteExpense}
            onImportExpenses={handleImportExpenses}
            onUpdateExpenseReceipt={handleUpdateExpenseReceipt}
            currentUser={state.currentUser}
            user1Name={state.user1.name}
            currentYear={state.currentYear || 2026}
          />
        )}

        {activeTab === "taxes" && <TaxCalculator state={state} />}

        {activeTab === "contracts" && (
          <ContractCreator 
            state={state} 
            onEditProperty={handleEditProperty} 
            addSyncEvent={addSyncEvent} 
            currentUser={state.currentUser}
          />
        )}

        {activeTab === "sync" && (
          <SyncStatus 
            state={state} 
            saveStatus={saveStatus}
            onRetrySave={retrySave}
            onToggleSync={handleToggleSync} 
            onClearLog={handleClearLog} 
            onMigrationApplied={handlePortfolioApplied}
          />
        )}

      </main>

    </div>
  );
}
