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
    // 3. Movimiento con firma idéntica pero ID distinto (ej. reimportado con ID nuevo)
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

  await t.test("planRecoveryMerge clasifica correctamente cada apunte", () => {
    const plan = planRecoveryMerge(currentExpenses, backupExpenses);

    assert.equal(plan.totalCurrentExpenses, 2);
    assert.equal(plan.totalBackupExpenses, 3);
    assert.equal(plan.keptCurrentCount, 2);
    assert.equal(plan.restoredCount, 1, "Solo debe restaurar el gasto ausente exp_historico_2");
    assert.equal(plan.skippedDuplicatesCount, 1, "Debe omitir el duplicado por firma");
    assert.equal(plan.enrichedReceiptsCount, 1, "Debe enriquecer exp_compartido con el recibo del backup");
    assert.equal(plan.resultingTotalExpenses, 3, "2 actuales + 1 restaurado = 3");
  });

  await t.test("executeRecoveryMerge conserva actuales, restaura ausentes y enriquece recibos", () => {
    const { mergedExpenses, plan } = executeRecoveryMerge(currentExpenses, backupExpenses);

    assert.equal(mergedExpenses.length, 3);

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
    assert.equal(currentExpenses.length, 2);
  });
});
