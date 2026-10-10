import test from "node:test";
import assert from "node:assert/strict";
import { PropertyExpense } from "../types";
import { planRecoveryMerge, executeRecoveryMerge } from "./recoveryImport";

test("recoveryImport: planificación y ejecución de recuperación sin duplicados", async (t) => {
  const currentExpenses: PropertyExpense[] = [
    {
      id: "exp_actual_1",
      propertyId: "prop_1",
      category: "repairs",
      type: "gasto",
      amount: 120,
      date: "2026-10-10",
      description: "Reparación fontanería reciente",
      receiptPath: "users/arquero/attachments/expenses/exp_actual_1/factura.pdf",
    },
    {
      id: "exp_compartido",
      propertyId: "prop_1",
      category: "ibi",
      type: "gasto",
      amount: 400,
      date: "2026-06-15",
      description: "IBI 2026 ya existente",
    },
    {
      id: "rent_actual",
      propertyId: "prop_1",
      category: "rent",
      type: "ingreso",
      amount: 900,
      date: "2026-10-01",
      description: "Renta octubre actual",
    },
  ];

  const backupExpenses: PropertyExpense[] = [
    // 1. Movimiento idéntico en backup (debe detectarse como duplicado y saltarse)
    {
      id: "exp_compartido",
      propertyId: "prop_1",
      category: "ibi",
      type: "gasto",
      amount: 400,
      date: "2026-06-15",
      description: "IBI 2026 copia histórica",
      receiptPath: "users/arquero/attachments/expenses/exp_compartido/recibo_ibi.pdf",
    },
    // 2. Movimiento histórico ausente en la cartera actual (debe restaurarse)
    {
      id: "exp_historico_2",
      propertyId: "prop_2",
      category: "community",
      type: "gasto",
      amount: 85,
      date: "15/03/2026", // Fecha en formato español
      description: "Comunidad marzo",
      receiptPath: "users/arquero/attachments/expenses/exp_historico_2/comunidad.pdf",
    },
    // 3. Ingreso histórico de alquiler ausente (debe restaurarse como ingreso)
    {
      id: "rent_historico_1",
      propertyId: "prop_1",
      category: "rent",
      type: "ingreso",
      amount: 850,
      date: "2026-01-05",
      description: "Renta enero",
    },
    // 4. Movimiento con firma idéntica pero ID distinto (ej. reimportado con ID nuevo)
    {
      id: "exp_firma_dup_backup",
      propertyId: "prop_1",
      category: "repairs",
      type: "gasto",
      amount: 120,
      date: "2026-10-10",
      description: "Misma reparación",
    },
  ];

  await t.test("planRecoveryMerge clasifica correctamente cada apunte y calcula totales", () => {
    const plan = planRecoveryMerge(currentExpenses, backupExpenses);

    assert.equal(plan.totalCurrentExpenses, 3);
    assert.equal(plan.totalBackupExpenses, 4);
    assert.equal(plan.keptCurrentCount, 3);
    assert.equal(plan.restoredCount, 2, "Restaura exp_historico_2 y rent_historico_1");
    assert.equal(plan.skippedDuplicatesCount, 1, "Omite el duplicado por firma");
    assert.equal(plan.enrichedReceiptsCount, 1, "Enriquece exp_compartido con el recibo del backup");
    assert.equal(plan.resultingTotalExpenses, 5, "3 actuales + 2 restaurados = 5");

    // Totales económicos
    assert.equal(plan.currentFinancials.incomes, 900);
    assert.equal(plan.currentFinancials.expenses, 520); // 120 + 400
    assert.equal(plan.currentFinancials.net, 380);

    assert.equal(plan.differenceFinancials.incomes, 850);
    assert.equal(plan.differenceFinancials.expenses, 85);
    assert.equal(plan.differenceFinancials.net, 765);

    assert.equal(plan.simulatedFinancials.incomes, 1750); // 900 + 850
    assert.equal(plan.simulatedFinancials.expenses, 605); // 520 + 85
    assert.equal(plan.simulatedFinancials.net, 1145);

    // Fechas extremas
    assert.equal(plan.minDateBackup, "2026-01-05");
    assert.equal(plan.maxDateBackup, "2026-10-10");
  });

  await t.test("Detección de ambigüedad: mismo ID con importe discrepante no se fusiona a ciegas", () => {
    const conflictingBackup: PropertyExpense[] = [
      {
        id: "exp_actual_1", // Mismo ID que el actual
        propertyId: "prop_1",
        category: "repairs",
        type: "gasto",
        amount: 250, // Importe contradictorio (actual tiene 120)
        date: "2026-10-10",
        description: "Versión contradictoria en backup",
      },
    ];

    const plan = planRecoveryMerge(currentExpenses, conflictingBackup);
    assert.equal(plan.ambiguousCount, 1, "Debe marcarse como ambiguo");
    assert.equal(plan.restoredCount, 0, "No debe restaurarse automáticamente");
    assert.ok(plan.warnings.some((w) => w.includes("discrepancias")));

    const { mergedExpenses } = executeRecoveryMerge(currentExpenses, conflictingBackup);
    // El importe actual de 120 € se conserva intacto
    assert.equal(mergedExpenses.find((e) => e.id === "exp_actual_1")?.amount, 120);
  });

  await t.test("executeRecoveryMerge conserva actuales, restaura ausentes y enriquece recibos", () => {
    const { mergedExpenses, plan } = executeRecoveryMerge(currentExpenses, backupExpenses);

    assert.equal(mergedExpenses.length, 5);

    // 1. Gasto reciente se conserva intacto
    const exp1 = mergedExpenses.find((e) => e.id === "exp_actual_1");
    assert.ok(exp1);
    assert.equal(exp1.receiptPath, "users/arquero/attachments/expenses/exp_actual_1/factura.pdf");

    // 2. Gasto compartido se conserva y recupera su recibo del backup
    const expComp = mergedExpenses.find((e) => e.id === "exp_compartido");
    assert.ok(expComp);
    assert.equal(expComp.receiptPath, "users/arquero/attachments/expenses/exp_compartido/recibo_ibi.pdf");

    // 3. Gasto histórico ausente se restaura con fecha normalizada a ISO
    const expHist = mergedExpenses.find((e) => e.id === "exp_historico_2");
    assert.ok(expHist);
    assert.equal(expHist.date, "2026-03-15", "Fecha 15/03/2026 normalizada a ISO 2026-03-15");
    assert.equal(expHist.amount, 85);

    // 4. Inmutabilidad: el array original currentExpenses no se modificó
    assert.equal(currentExpenses.length, 3);
  });
});
