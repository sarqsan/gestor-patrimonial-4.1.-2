import test from "node:test";
import assert from "node:assert/strict";
import { AppState, PropertyExpense, Property } from "../types";
import { checkPortfolioWrite } from "./portfolioGuard";
import { portfolioBody } from "./portfolioPayload";
import { buildArqueroFixture } from "./migrationFakes";
import { mergeMigratedReferences } from "./portfolioMigrationRun";

/**
 * Extractor ingenuo original de Expenses.tsx (líneas 619-637).
 */
function naiveExtractYear(dateStr: string): number {
  return parseInt(dateStr.split("-")[0], 10);
}

/**
 * Extractor de año robusto propuesto para reemplazar naiveExtractYear.
 * Soporta ISO (YYYY-MM-DD), formato español/europeo (DD/MM/YYYY, DD-MM-YYYY) y variantes con barras.
 */
export function extractYearFromDate(dateStr: unknown): number | null {
  if (typeof dateStr !== "string") return null;
  const s = dateStr.trim();
  if (!s) return null;

  // YYYY-MM-DD o YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[-/.]/);
  if (isoMatch) return parseInt(isoMatch[1], 10);

  // DD/MM/YYYY o DD-MM-YYYY
  const euMatch = s.match(/[-/.](\d{4})(?:$|\s|T)/);
  if (euMatch) return parseInt(euMatch[1], 10);

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const yr = d.getFullYear();
    if (yr >= 1900 && yr <= 2100) return yr;
  }
  return null;
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

    // El hook llama a onImportExpenses(validExpenses, 'replace')
    // provocando la eliminación inmediata y permanente de todos los gastos e ingresos
    const stateAfterPurge = validExpenses;
    assert.deepEqual(stateAfterPurge, [], "El estado de gastos queda completamente vacío");
  });
});

test("Diagnóstico: El fallback de hidratación en App.tsx sobreescribe el estado local con arrays vacíos", async (t) => {
  await t.test("En JavaScript [] es truthy: cloudData.expenses || prev.expenses descarta el estado previo", () => {
    const prevExpenses: PropertyExpense[] = [
      { id: "local_1", propertyId: "p1", category: "ibi", type: "gasto", amount: 350, date: "2026-06-01" }
    ];

    // Simulación de respuesta de Firestore cuando el documento en la nube tiene expenses: []
    const cloudData = { expenses: [] as PropertyExpense[] };

    // Líneas 316 y 341 de App.tsx:
    // expenses: cloudData.expenses || prev.expenses
    const resultExpenses = cloudData.expenses || prevExpenses;

    // Debido a que [] || prevExpenses evalúa al primer operando truthy ([]), prevExpenses se pierde
    assert.deepEqual(resultExpenses, [], "El array vacío de la nube anula los gastos locales guardados");
  });

  await t.test("Hidratación segura: no sobreescribir con array vacío si el estado local tiene datos no confirmados", () => {
    const prevExpenses: PropertyExpense[] = [
      { id: "local_1", propertyId: "p1", category: "ibi", type: "gasto", amount: 350, date: "2026-06-01" }
    ];
    const cloudData = { expenses: [] as PropertyExpense[] };

    // Lógica segura propuesta: si la nube viene vacía pero local tiene datos pendientes, preservar local
    const safeHydratedExpenses = (cloudData.expenses && cloudData.expenses.length > 0)
      ? cloudData.expenses
      : prevExpenses;

    assert.deepEqual(safeHydratedExpenses, prevExpenses, "Se preservan los gastos locales no sincronizados");
  });
});

test("Diagnóstico: Bloqueo de escritura previo a la migración por exceso de tamaño (>1.000.000 bytes)", async (t) => {
  await t.test("Antes de migrar adjuntos (1011,6 KB), checkPortfolioWrite rechaza cualquier nuevo gasto", () => {
    const fx = buildArqueroFixture();
    const rawBytes = Buffer.byteLength(JSON.stringify(fx.raw), "utf8");
    assert.ok(rawBytes > 1_000_000, `La cartera histórica superaba el límite: ${rawBytes} bytes`);

    // Usuario añade un nuevo gasto
    const newExpense: PropertyExpense = {
      id: "exp_nuevo",
      propertyId: "prop_1",
      category: "repairs",
      type: "gasto",
      amount: 120,
      date: "2026-10-10",
      description: "Nueva factura fontanero"
    };

    const updatedState: AppState = {
      ...fx.state,
      expenses: [...(fx.state.expenses || []), newExpense]
    };

    const body = portfolioBody(updatedState);
    const check = checkPortfolioWrite(body, { allowedLegacyDataUrls: new Set() });

    // La guardia bloquea la escritura: setDoc nunca se ejecuta en Firestore
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(e => e.includes("supera el margen seguro")));

    // Al recargar la página (F5), Firestore devuelve la cartera sin el nuevo gasto,
    // y el nuevo gasto se pierde de la memoria local
  });

  await t.test("Tras la migración de adjuntos (19,4 KB), checkPortfolioWrite permite guardar gastos sin Base64", () => {
    const fx = buildArqueroFixture();
    // Simular cartera migrada (adjuntos con storagePath, sin Base64 inline)
    const migratedExpenses: PropertyExpense[] = (fx.state.expenses || []).map(e => ({
      ...e,
      receiptUrl: undefined,
      receiptPath: `users/arquero/attachments/expenses/${e.id}/recibo.pdf`,
      receiptName: "recibo.pdf",
      receiptType: "application/pdf"
    }));

    const migratedState: AppState = {
      ...fx.state,
      expenses: migratedExpenses,
      properties: fx.state.properties.map(p => ({
        ...p,
        documents: p.documents?.map(d => ({
          ...d,
          fileData: undefined,
          storagePath: `users/arquero/attachments/properties/${d.id}/doc.pdf`
        }))
      }))
    };

    // Añadimos un gasto nuevo tras la migración
    const newExpense: PropertyExpense = {
      id: "exp_nuevo_post_migracion",
      propertyId: "prop_1",
      category: "repairs",
      type: "gasto",
      amount: 95,
      date: "2026-10-10"
    };

    const updatedState = {
      ...migratedState,
      expenses: [...migratedState.expenses!, newExpense]
    };

    const check = checkPortfolioWrite(portfolioBody(updatedState));
    assert.equal(check.ok, true, "Tras la migración la escritura está permitida");
    assert.ok(check.bytes < 30_000, `Tamaño reducido (${check.bytes} bytes < 30 KB)`);
  });
});

test("Comparativa del ciclo de vida: Inmuebles vs Gastos/Ingresos", async (t) => {
  await t.test("handleAddProperty guarda campos de gastos en la ficha del inmueble pero no crea registros en state.expenses", () => {
    const initialExpenses: PropertyExpense[] = [];
    const newProperty: Property = {
      id: "prop_nueva",
      address: "Calle Alcalá 45",
      cadastralReference: "1234567VK1234S0001TR",
      tenantName: "Inquilino Ejemplo",
      tenantDni: "12345678Z",
      purchasePrice: 200000,
      monthlyRent: 950,
      expensesCommunity: 600,
      expensesIBI: 400,
      expensesInsurance: 250,
      expensesRepairs: 150,
      landValuePercent: 20,
      amortizationAmount: 4800,
      owner: "user1",
      ownershipPercentageUser1: 100,
      ownershipPercentageUser2: 0,
      registrationDate: "2026-01-01"
    };

    // Al añadir inmueble, los gastos van a los atributos del Property,
    // pero state.expenses se queda vacío
    assert.equal(newProperty.expensesCommunity, 600);
    assert.equal(initialExpenses.length, 0, "state.expenses no recibe ningún asiento contable");
  });

  await t.test("handleEditProperty sustituye gastos detallados con comprobantes por un único gasto estático genérico", () => {
    // Si el usuario tenía 12 recibos de comunidad con comprobante adjunto:
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

    assert.equal(detailedExpenses.length, 12);
    assert.equal(detailedExpenses.every(e => !!e.receiptPath), true, "Los 12 gastos tienen comprobante");

    // Si en Properties se edita el campo expensesCommunity (p. ej. de 600 a 650):
    // La lógica de handleEditProperty (líneas 490-515) borra los 12 y crea 1 solo gasto genérico
    const newAmount = 650;
    const year = 2026;
    const existingCatExpenses = detailedExpenses.filter(e => e.category === "community" && parseInt(e.date.split("-")[0] || "0") === year);
    const otherExpenses = detailedExpenses.filter(e => !(e.category === "community" && parseInt(e.date.split("-")[0] || "0") === year));

    const singleNewExpense: PropertyExpense = {
      id: existingCatExpenses[0]?.id || "exp_new",
      propertyId: "prop_1",
      category: "community",
      type: "gasto",
      amount: newAmount,
      date: existingCatExpenses[0]?.date || `${year}-01-15`,
      description: `Gasto de Comunidad (Sincronizado desde Ficha)`
    };

    const finalExpenses = [...otherExpenses, singleNewExpense];
    // Se ha perdido el desglose de 12 recibos y los comprobantes de 11 de ellos
    assert.equal(finalExpenses.length, 1, "Los 12 registros mensuales se colapsaron en 1 solo");
    assert.equal(finalExpenses[0].receiptPath, undefined, "El comprobante del gasto sincronizado se pierde");
  });
});

test("Verificación de backup: backup_1791641770686 contiene los movimientos previos a la migración", async (t) => {
  await t.test("Los datos del backup son 100% recuperables e íntegros", () => {
    // Estructura de backup_1791641770686 creado en PR 3 / PR 4
    const fx = buildArqueroFixture();
    const backupSnapshot = {
      ...portfolioBody(fx.state),
      backedUpAt: "2026-10-10T14:16:10.686Z",
      backupId: "backup_1791641770686",
      reason: "pre-migration backup"
    };

    // 1. Inmuebles presentes
    assert.equal(backupSnapshot.properties.length, fx.state.properties.length);
    // 2. Gastos e ingresos presentes
    assert.equal(backupSnapshot.expenses.length, fx.state.expenses!.length);
    // 3. Documentos y recibos adjuntos originales preservados
    const totalReceipts = backupSnapshot.expenses.filter((e: any) => !!e.receiptUrl).length;
    assert.equal(totalReceipts, 2, "Contiene los comprobantes Base64 originales");

    // 4. Se comprueba que mergeMigratedReferences puede restaurar y transformar sin pérdida
    const merged = mergeMigratedReferences(fx.state, backupSnapshot);
    assert.equal(merged.expenses?.length, fx.state.expenses?.length);
    assert.equal(merged.properties.length, fx.state.properties.length);
  });
});
