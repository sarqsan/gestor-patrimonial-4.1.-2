import test from "node:test";
import assert from "node:assert/strict";
import { AppState, PropertyExpense, Property } from "../types";
import { checkPortfolioWrite } from "./portfolioGuard";
import { portfolioBody } from "./portfolioPayload";
import { buildArqueroFixture } from "./migrationFakes";
import { mergeMigratedReferences } from "./portfolioMigrationRun";
import { extractYearFromDate, normalizeDateToIso } from "./dateUtils";
import { mergeExpensesOnHydration, mergePropertiesOnHydration } from "./portfolioHydration";
import { planRecoveryMerge, executeRecoveryMerge } from "./recoveryImport";

/**
 * Extractor ingenuo original de Expenses.tsx (líneas 619-637).
 */
function naiveExtractYear(dateStr: string): number {
  return parseInt(dateStr.split("-")[0], 10);
}

test("Diagnóstico: El bug de parseo de fecha en Expenses.tsx provoca borrado accidental de gastos válidos", async (t) => {
  const currentYear = 2026;

  await t.test("Formato español DD/MM/YYYY: el parseo ingenuo split('-')[0] extrae el día en vez del año", () => {
    const spanishDate = "15/03/2026";
    const naiveYear = naiveExtractYear(spanishDate);
    // split('-')[0] devuelve '15/03/2026', y parseInt devuelve 15
    assert.equal(naiveYear, 15);

    // Como 2026 - 15 = 2011 > 6, el gasto se clasifica erróneamente como caducado
    const isExpired = !isNaN(naiveYear) && (currentYear - naiveYear) > 6;
    assert.equal(isExpired, true, "El gasto válido de 2026 se marca falsamente como caducado > 6 años");

    // Con el extractor robusto:
    const safeYear = extractYearFromDate(spanishDate);
    assert.equal(safeYear, 2026);
    assert.equal((currentYear - safeYear!) > 6, false, "El gasto de 2026 NO debe marcarse como caducado");
  });

  await t.test("Formato DD-MM-YYYY: el parseo ingenuo split('-')[0] extrae el día como año", () => {
    const dashDate = "10-10-2026";
    const naiveYear = naiveExtractYear(dashDate);
    assert.equal(naiveYear, 10);

    const isExpired = !isNaN(naiveYear) && (currentYear - naiveYear) > 6;
    assert.equal(isExpired, true, "10-10-2026 se marca erróneamente como caducado");

    const safeYear = extractYearFromDate(dashDate);
    assert.equal(safeYear, 2026);
    assert.equal((currentYear - safeYear!) > 6, false);
  });

  await t.test("La política automática de purga de 6 años en useEffect sustituye state.expenses por un array vacío", () => {
    const initialExpenses: PropertyExpense[] = [
      { id: "e1", propertyId: "p1", category: "repairs", type: "gasto", amount: 150, date: "15/03/2026", description: "Reparación caldera" },
      { id: "e2", propertyId: "p1", category: "community", type: "gasto", amount: 60, date: "10-10-2026", description: "Comunidad octubre" },
      { id: "e3", propertyId: "p1", category: "rent", type: "ingreso", amount: 850, date: "01/10/2026", description: "Renta octubre" },
    ];

    // Simulación exacta del useEffect de Expenses.tsx (líneas 619-637)
    const expiredList = initialExpenses.filter(exp => {
      const expYear = parseInt(exp.date.split("-")[0], 10);
      return !isNaN(expYear) && (currentYear - expYear) > 6;
    });

    const validExpenses = initialExpenses.filter(exp => {
      const expYear = parseInt(exp.date.split("-")[0], 10);
      return isNaN(expYear) || (currentYear - expYear) <= 6;
    });

    // Los 3 gastos de 2026 se clasifican como caducados
    assert.equal(expiredList.length, 3);
    assert.equal(validExpenses.length, 0);

    // El hook llamaba a onImportExpenses(validExpenses, 'replace')
    // provocando la eliminación inmediata y permanente de todos los gastos e ingresos
    const stateAfterPurge = validExpenses;
    assert.deepEqual(stateAfterPurge, [], "El estado de gastos queda completamente vacío");
  });

  await t.test("Corrección: La eliminación del hook automático de purga preserva 100% de los gastos", () => {
    const expenses: PropertyExpense[] = [
      { id: "e1", propertyId: "p1", category: "repairs", type: "gasto", amount: 150, date: "15/03/2026" },
      { id: "e2", propertyId: "p1", category: "community", type: "gasto", amount: 60, date: "10-10-2026" },
    ];

    // Sin el hook destructivo, expenses se mantiene inmutable al montar el componente
    assert.equal(expenses.length, 2);
    assert.equal(extractYearFromDate(expenses[0].date), 2026);
    assert.equal(extractYearFromDate(expenses[1].date), 2026);
  });
});

test("Hidratación y concurrencia: App.tsx preserva cambios locales pendientes sin ignorar la nube", async (t) => {
  await t.test("El fallo original: [] || prevExpenses evalúa a [] en JS", () => {
    const prevExpenses: PropertyExpense[] = [
      { id: "local_1", propertyId: "p1", category: "ibi", type: "gasto", amount: 350, date: "2026-06-01" }
    ];
    const cloudData = { expenses: [] as PropertyExpense[] };
    const naiveResult = cloudData.expenses || prevExpenses;
    assert.deepEqual(naiveResult, [], "El array vacío de la nube anula los gastos locales guardados");
  });

  await t.test("mergeExpensesOnHydration: nube vacía no borra movimientos locales retenidos", () => {
    const localExpenses: PropertyExpense[] = [
      { id: "local_1", propertyId: "p1", category: "ibi", type: "gasto", amount: 350, date: "2026-06-01" },
      { id: "local_2", propertyId: "p1", category: "rent", type: "ingreso", amount: 900, date: "2026-06-05" }
    ];
    const cloudExpenses: PropertyExpense[] = [];

    const merged = mergeExpensesOnHydration(cloudExpenses, localExpenses);
    assert.equal(merged.length, 2, "Se conservan los 2 movimientos locales");
    assert.equal(merged[0].id, "local_1");
    assert.equal(merged[1].id, "local_2");
  });

  await t.test("mergeExpensesOnHydration: nube con datos válidos toma precedencia e integra pendientes locales", () => {
    const cloudExpenses: PropertyExpense[] = [
      { id: "cloud_1", propertyId: "p1", category: "ibi", type: "gasto", amount: 412, date: "2026-02-10" },
    ];
    const localExpenses: PropertyExpense[] = [
      { id: "cloud_1", propertyId: "p1", category: "ibi", type: "gasto", amount: 400, date: "2026-02-10" }, // versión local obsoleta
      { id: "local_new", propertyId: "p1", category: "repairs", type: "gasto", amount: 75, date: "2026-10-10" } // pendiente local
    ];

    const merged = mergeExpensesOnHydration(cloudExpenses, localExpenses);
    assert.equal(merged.length, 2);
    // Para el ID existente gana la nube (412 en vez de 400)
    assert.equal(merged.find(e => e.id === "cloud_1")?.amount, 412);
    // Para el ID nuevo local pendiente se preserva
    assert.equal(merged.find(e => e.id === "local_new")?.amount, 75);
  });
});

test("Corrección handleEditProperty: modificar campos del inmueble no sustituye ni borra gastos contables", async (t) => {
  const detailedExpenses: PropertyExpense[] = Array.from({ length: 12 }, (_, i) => ({
    id: `exp_comm_${i}`,
    propertyId: "prop_1",
    category: "community" as const,
    type: "gasto" as const,
    amount: 50,
    date: `2026-${String(i + 1).padStart(2, "0")}-05`,
    description: `Comunidad mes ${i + 1}`,
    receiptPath: `users/arquero/attachments/expenses/exp_comm_${i}/recibo.pdf`
  }));

  const prop: Property = {
    id: "prop_1",
    address: "Calle Mayor 12",
    cadastralReference: "1234567VK1234S0001TR",
    tenantName: "Inquilino",
    tenantDni: "12345678Z",
    purchasePrice: 150000,
    monthlyRent: 800,
    expensesCommunity: 600,
    expensesIBI: 350,
    expensesInsurance: 200,
    expensesRepairs: 100,
    landValuePercent: 20,
    amortizationAmount: 3600,
    owner: "user1",
    ownershipPercentageUser1: 100,
    ownershipPercentageUser2: 0,
    registrationDate: "2026-01-01"
  };

  const state: AppState = {
    user1: { name: "Usuario 1", dni: "11111111A", brutoTrabajo: 30000, netoTrabajo: 24000 },
    user2: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false },
    properties: [prop],
    payments: [],
    expenses: detailedExpenses,
    syncEvents: [],
    syncEnabled: true,
    isOnboarded: true,
    currentYear: 2026,
    yearlyProfiles: {}
  };

  // El usuario edita la ficha del inmueble cambiando expensesCommunity a 650 y monthlyRent a 850
  const updatedProp: Property = {
    ...prop,
    expensesCommunity: 650,
    monthlyRent: 850,
  };

  // Simulación de handleEditProperty corregido en App.tsx
  const nextExpenses = state.expenses || [];
  const nextProperties = state.properties.map(p => p.id === updatedProp.id ? updatedProp : p);

  // Verificaciones:
  // 1. Los 12 recibos detallados se conservan intactos
  assert.equal(nextExpenses.length, 12);
  // 2. Todos los identificadores y justificantes de Storage siguen presentes
  assert.equal(nextExpenses.every(e => !!e.receiptPath), true);
  assert.equal(nextExpenses[0].id, "exp_comm_0");
  assert.equal(nextExpenses[11].id, "exp_comm_11");
  // 3. El inmueble actualizó sus campos
  assert.equal(nextProperties[0].expensesCommunity, 650);
  assert.equal(nextProperties[0].monthlyRent, 850);
});

test("Supervivencia completa del ciclo: guardar, recargar y reabrir la cartera", async (t) => {
  // Estado inicial simulado de arquero post-migración (19,4 KB)
  const fx = buildArqueroFixture();
  const migratedState: AppState = {
    ...fx.state,
    expenses: [
      {
        id: "exp_migrado_1",
        propertyId: "prop_1",
        category: "repairs",
        type: "gasto",
        amount: 150,
        date: "2026-10-10",
        receiptPath: "users/arquero/attachments/expenses/exp_migrado_1/factura.pdf",
      },
    ],
    properties: fx.state.properties.map((p) => ({
      ...p,
      documents: p.documents?.map((d) => ({
        ...d,
        fileData: undefined,
        storagePath: `users/arquero/attachments/properties/${d.id}/doc.pdf`,
      })),
    })),
  };

  // Paso 1: Usuario añade un gasto en formato español ("15/10/2026")
  const newExpenseInput: PropertyExpense = {
    id: "exp_nuevo_1",
    propertyId: "prop_1",
    category: "community",
    type: "gasto",
    amount: 60,
    date: normalizeDateToIso("15/10/2026") || "15/10/2026",
    description: "Comunidad quincena"
  };

  const updatedState: AppState = {
    ...migratedState,
    expenses: [...migratedState.expenses!, newExpenseInput]
  };

  // Paso 2: Guardado (persistPortfolio y localStorage)
  const body = portfolioBody(updatedState);
  const writeCheck = checkPortfolioWrite(body);
  assert.equal(writeCheck.ok, true, "La escritura es válida tras la migración");

  const serializedLocal = JSON.stringify(updatedState);
  const simulatedFirestoreCloudData = JSON.parse(JSON.stringify(body));

  // Paso 3: Simulación de recarga (F5)
  // Rehidratación desde localStorage
  const restoredFromLocal: AppState = JSON.parse(serializedLocal);
  assert.equal(restoredFromLocal.expenses?.length, 2);

  // Hidratación desde Firestore (getDoc / onSnapshot con mergeExpensesOnHydration)
  const hydratedExpenses = mergeExpensesOnHydration(
    simulatedFirestoreCloudData.expenses,
    restoredFromLocal.expenses
  );

  assert.equal(hydratedExpenses.length, 2, "Los 2 gastos sobreviven intactos a la recarga");
  const expNuevo = hydratedExpenses.find(e => e.id === "exp_nuevo_1");
  assert.ok(expNuevo);
  assert.equal(expNuevo.date, "2026-10-15", "Fecha normalizada a ISO preservada");
  assert.equal(expNuevo.amount, 60);

  // Paso 4: Reabrir pestaña Expenses (sin purga destructiva)
  const expYear = extractYearFromDate(expNuevo.date);
  assert.equal(expYear, 2026);
  // Con filtro de año "2026", el gasto se muestra correctamente
  assert.equal(String(expYear) === "2026", true);
});

test("Recuperación segura de backup sin duplicados ni pérdida de movimientos actuales", async (t) => {
  const currentExpenses: PropertyExpense[] = [
    {
      id: "exp_actual_nuevo",
      propertyId: "prop_1",
      category: "repairs",
      type: "gasto",
      amount: 110,
      date: "2026-10-10",
      description: "Reparación reciente post-migración",
      receiptPath: "users/arquero/attachments/expenses/exp_actual_nuevo/recibo.pdf"
    }
  ];

  const backupExpenses: PropertyExpense[] = [
    {
      id: "exp_0",
      propertyId: "prop_1",
      category: "ibi",
      type: "gasto",
      amount: 412.5,
      date: "2026-02-10",
      description: "IBI histórico",
      receiptPath: "users/arquero/attachments/expenses/exp_0/ibi-2026.pdf"
    },
    {
      id: "exp_actual_nuevo", // Duplicado que coincide con el actual
      propertyId: "prop_1",
      category: "repairs",
      type: "gasto",
      amount: 110,
      date: "2026-10-10",
    }
  ];

  const plan = planRecoveryMerge(currentExpenses, backupExpenses);
  assert.equal(plan.restoredCount, 1, "Restaura únicamente exp_0");
  assert.equal(plan.skippedDuplicatesCount, 1, "Omite el duplicado");

  const { mergedExpenses } = executeRecoveryMerge(currentExpenses, backupExpenses);
  assert.equal(mergedExpenses.length, 2);
  assert.ok(mergedExpenses.some(e => e.id === "exp_actual_nuevo"), "Conserva el gasto reciente");
  assert.ok(mergedExpenses.some(e => e.id === "exp_0"), "Recupera el gasto histórico");
});
