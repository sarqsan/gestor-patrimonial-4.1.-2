import React, { useState, useEffect } from "react";
import Onboarding from "./components/Onboarding";
import Dashboard from "./components/Dashboard";
import Properties from "./components/Properties";
import RentControl from "./components/RentControl";
import TaxCalculator from "./components/TaxCalculator";
import SyncStatus from "./components/SyncStatus";
import AuthScreen from "./components/AuthScreen";
import Expenses from "./components/Expenses";
import ContractCreator from "./components/ContractCreator";
import { AppState, Property, RentPayment, SyncEvent, PropertyExpense, getThemeColors } from "./types";
import { db, doc, getDoc, setDoc, onSnapshot } from "./lib/firebase";
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

  // Save to LocalStorage and handle automated sync events
  const updateState = (updater: (prev: AppState) => AppState) => {
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
              parseInt(e.date.split("-")[0] || "0") === year
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

      if (next.currentUser) {
        localStorage.setItem(`rentasync_state_${next.currentUser}`, JSON.stringify(next));

        // Asynchronously persist to Firebase Firestore
        try {
          const userDocRef = doc(db, "users", next.currentUser, "data", "portfolio");
          setDoc(userDocRef, {
            user1: next.user1,
            user2: next.user2,
            properties: next.properties || [],
            payments: next.payments || [],
            expenses: next.expenses || [],
            contracts: next.contracts || [],
            syncEvents: next.syncEvents || [],
            syncEnabled: next.syncEnabled,
            isOnboarded: next.isOnboarded,
            currentYear: next.currentYear || 2026,
            yearlyProfiles: next.yearlyProfiles || {},
            theme: next.theme || "slate-indigo",
            updatedAt: new Date().toISOString()
          }, { merge: true }).catch((err) => {
            console.error("Firestore persistence error:", err);
          });
        } catch (e) {
          console.error("Firestore save error:", e);
        }
      } else {
        localStorage.setItem("rentasync_state", JSON.stringify(next));
      }
      return next;
    });
  };

  // Load and listen to Firestore changes for active logged in user
  useEffect(() => {
    if (!state.isAuthenticated || !state.currentUser) return;

    const userDocRef = doc(db, "users", state.currentUser, "data", "portfolio");

    // Initial fetch from Firestore
    getDoc(userDocRef).then((snapshot) => {
      if (snapshot.exists()) {
        const cloudData = snapshot.data();
        setState((prev) => ({
          ...prev,
          properties: cloudData.properties || prev.properties,
          payments: cloudData.payments || prev.payments,
          expenses: cloudData.expenses || prev.expenses,
          contracts: cloudData.contracts || prev.contracts,
          syncEvents: cloudData.syncEvents || prev.syncEvents,
          yearlyProfiles: cloudData.yearlyProfiles || prev.yearlyProfiles,
          currentYear: cloudData.currentYear || prev.currentYear || 2026,
          isOnboarded: cloudData.isOnboarded !== undefined ? cloudData.isOnboarded : prev.isOnboarded,
          user1: cloudData.user1 || prev.user1,
          user2: cloudData.user2 || prev.user2
        }));
      }
    }).catch((err) => {
      console.warn("Firestore sync fetch warning:", err);
    });

    // Subscribe to real-time updates
    const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const cloudData = docSnap.data();
        setState((prev) => ({
          ...prev,
          properties: cloudData.properties || prev.properties,
          payments: cloudData.payments || prev.payments,
          expenses: cloudData.expenses || prev.expenses,
          contracts: cloudData.contracts || prev.contracts,
          syncEvents: cloudData.syncEvents || prev.syncEvents,
          yearlyProfiles: cloudData.yearlyProfiles || prev.yearlyProfiles,
          currentYear: cloudData.currentYear || prev.currentYear || 2026
        }));
      }
    }, (err) => {
      console.warn("Firestore real-time subscription error:", err);
    });

    return () => unsubscribe();
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

    triggerNotification(`🔄 Auto-Sincronización: ${action}`);
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
      const oldProp = prev.properties.find((p) => p.id === updatedProp.id);
      let updatedExpenses = prev.expenses || [];
      const year = prev.currentYear || 2026;

      if (oldProp) {
        // Helper to sync edited static field back to actual expenses
        const syncFieldToExpense = (
          field: "expensesCommunity" | "expensesIBI" | "expensesInsurance" | "expensesRepairs",
          category: "community" | "ibi" | "insurance" | "repairs",
          catLabel: string
        ) => {
          if (updatedProp[field] !== oldProp[field]) {
            // Find existing expenses of this category for this property in this year
            const existingCatExpenses = updatedExpenses.filter(
              (e) =>
                e.propertyId === updatedProp.id &&
                e.category === category &&
                e.type === "gasto" &&
                parseInt(e.date.split("-")[0] || "0") === year
            );

            if (updatedProp[field] === 0) {
              // Delete all expenses of this category
              updatedExpenses = updatedExpenses.filter(
                (e) =>
                  !(
                    e.propertyId === updatedProp.id &&
                    e.category === category &&
                    e.type === "gasto" &&
                    parseInt(e.date.split("-")[0] || "0") === year
                  )
              );
            } else {
              // Replace all existing ones with a single representative one
              const otherExpenses = updatedExpenses.filter(
                (e) =>
                  !(
                    e.propertyId === updatedProp.id &&
                    e.category === category &&
                    e.type === "gasto" &&
                    parseInt(e.date.split("-")[0] || "0") === year
                  )
              );

              const newExpense: PropertyExpense = {
                id: existingCatExpenses[0]?.id || `exp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                propertyId: updatedProp.id,
                category,
                type: "gasto",
                amount: updatedProp[field],
                date: existingCatExpenses[0]?.date || `${year}-01-15`,
                description: existingCatExpenses[0]?.description || `Gasto de ${catLabel} (Sincronizado desde Ficha)`
              };

              updatedExpenses = [...otherExpenses, newExpense];
            }
          }
        };

        syncFieldToExpense("expensesCommunity", "community", "Comunidad");
        syncFieldToExpense("expensesIBI", "ibi", "IBI");
        syncFieldToExpense("expensesInsurance", "insurance", "Seguro de Hogar/Impago");
        syncFieldToExpense("expensesRepairs", "repairs", "Reparación/Conservación");
      }

      // Update monthly rent inside existing payments if it changed
      const updatedPayments = prev.payments.map((p) => {
        if (p.propertyId === updatedProp.id && p.status === 'pending') {
          return { ...p, amount: updatedProp.monthlyRent };
        }
        return p;
      });

      return {
        ...prev,
        expenses: updatedExpenses,
        properties: prev.properties.map((p) => p.id === updatedProp.id ? updatedProp : p),
        payments: updatedPayments
      };
    });

    addSyncEvent(
      "Cartera Inmuebles",
      "Dashboard & Simulador IRPF",
      `Actualización inmueble ${updatedProp.address.split(",")[0]}`,
      `Modificados parámetros fiscales y renta del inmueble. Gastos e IRPF sincronizados en tiempo real.`
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

  // ADD EXPENSE
  const handleAddExpense = (newExpense: PropertyExpense) => {
    updateState((prev) => ({
      ...prev,
      expenses: [...(prev.expenses || []), newExpense]
    }));

    const prop = state.properties.find(p => p.id === newExpense.propertyId);
    addSyncEvent(
      "Gestión de Gastos",
      "Simulador de Impuestos (Modelo 100)",
      `Gasto registrado: ${newExpense.amount}€`,
      `Registrado gasto de ${newExpense.amount}€ en concepto de "${newExpense.category}" para el inmueble en ${prop ? prop.address.split(",")[0] : "Desconocido"}. Sincronizado para deducción del IRPF.`
    );
  };

  // DELETE EXPENSE
  const handleDeleteExpense = (id: string) => {
    const expense = (state.expenses || []).find(e => e.id === id);
    if (!expense) return;

    updateState((prev) => {
      const updatedExpenses = (prev.expenses || []).filter((e) => e.id !== id);
      const year = prev.currentYear || 2026;
      const expenseYear = parseInt(expense.date.split("-")[0] || "0");

      let updatedProperties = prev.properties;
      if (expenseYear === year) {
        updatedProperties = prev.properties.map((p) => {
          if (p.id === expense.propertyId) {
            const hasMoreOfSameCategory = updatedExpenses.some(
              (e) =>
                e.propertyId === p.id &&
                e.category === expense.category &&
                e.type === "gasto" &&
                parseInt(e.date.split("-")[0] || "0") === year
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
    dashboard: { label: "Dashboard Patrimonial y de Renta", icon: LayoutDashboard },
    properties: { label: "Cartera de Inmuebles (Mis Inmuebles)", icon: Building },
    expenses: { label: "Gestión de Gastos de Alquiler", icon: Receipt },
    contracts: { label: "Redactor de Contratos (Ley Vivienda 2024)", icon: FileText },
    taxes: { label: "Simulador e Impuestos (Modelo 100)", icon: Calculator },
    sync: { label: "Centro de Sincronización Automática", icon: Activity },
  };

  const ActiveIconComponent = tabConfig[activeTab].icon;

  return (
    <div id="app-workspace" className={`min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased theme-${state.theme || "slate-indigo"}`}>
      
      {/* HEADER BAR */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 sm:px-6 py-3.5 flex justify-between items-center shadow-lg">
        <div className="flex items-center space-x-3">
          <div className={`${themeColors.primaryBgLight} ${themeColors.primaryText} p-2 rounded-xl border ${themeColors.primaryBorder}`}>
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className={`text-[10px] uppercase font-mono tracking-wider font-extrabold ${themeColors.primaryText} block leading-tight`}>Agencia Inteligente</span>
              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold flex items-center gap-1">
                <Database className="w-2.5 h-2.5 text-amber-400" /> Firebase Firestore
              </span>
            </div>
            <h1 className="text-sm font-black text-white tracking-tight">RentaSync</h1>
          </div>
        </div>

        {/* REVOLUTIONARY MODULE SELECTOR DROPDOWN (Fuera del Dashboard en desplegable) */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="inline-flex items-center justify-between px-4 py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700/60 rounded-xl text-xs font-semibold text-slate-200 transition-all cursor-pointer min-w-[240px] shadow-sm select-none"
          >
            <div className="flex items-center space-x-2 truncate">
              <ActiveIconComponent className={`w-4 h-4 ${themeColors.primaryText} shrink-0`} />
              <span className="truncate">{tabConfig[activeTab].label}</span>
            </div>
            <ChevronDown className={`w-4 h-4 ml-2 text-slate-500 transition-transform duration-200 ${dropdownOpen ? "rotate-180" : ""}`} />
          </button>

          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setDropdownOpen(false)}></div>
              <div className="absolute right-0 mt-2 w-72 bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl py-2 z-40 animate-slide-in">
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
            properties={state.properties} 
            onAddProperty={handleAddProperty}
            onEditProperty={handleEditProperty}
            onDeleteProperty={handleDeleteProperty}
            onDeleteExpense={handleDeleteExpense}
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
            onDeleteExpense={handleDeleteExpense}
            user1Name={state.user1.name}
          />
        )}

        {activeTab === "taxes" && <TaxCalculator state={state} />}

        {activeTab === "contracts" && (
          <ContractCreator 
            state={state} 
            onEditProperty={handleEditProperty} 
            addSyncEvent={addSyncEvent} 
          />
        )}

        {activeTab === "sync" && (
          <SyncStatus 
            state={state} 
            onToggleSync={handleToggleSync} 
            onClearLog={handleClearLog} 
          />
        )}

      </main>

    </div>
  );
}
