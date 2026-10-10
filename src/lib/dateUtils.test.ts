import test from "node:test";
import assert from "node:assert/strict";
import { extractYearFromDate, normalizeDateToIso, isDateOlderThanYears } from "./dateUtils";

test("dateUtils: extractYearFromDate", async (t) => {
  await t.test("fechas ISO estándar (YYYY-MM-DD)", () => {
    assert.equal(extractYearFromDate("2026-10-10"), 2026);
    assert.equal(extractYearFromDate("2023-01-01"), 2023);
    assert.equal(extractYearFromDate("2019-12-31"), 2019);
  });

  await t.test("fechas españolas con barras (DD/MM/YYYY) jamás interpretan el día como año", () => {
    assert.equal(extractYearFromDate("15/03/2026"), 2026);
    assert.equal(extractYearFromDate("01/12/2025"), 2025);
    assert.equal(extractYearFromDate("31/01/2024"), 2024);
    assert.equal(extractYearFromDate("5/4/2026"), 2026);
  });

  await t.test("fechas españolas con guiones (DD-MM-YYYY) jamás interpretan el día como año", () => {
    assert.equal(extractYearFromDate("10-10-2026"), 2026);
    assert.equal(extractYearFromDate("28-02-2023"), 2023);
    assert.equal(extractYearFromDate("05-08-2022"), 2022);
  });

  await t.test("fechas con puntos (DD.MM.YYYY)", () => {
    assert.equal(extractYearFromDate("15.03.2026"), 2026);
  });

  await t.test("timestamps ISO completos", () => {
    assert.equal(extractYearFromDate("2026-10-10T14:16:10.686Z"), 2026);
  });

  await t.test("números seriales de Excel", () => {
    // 46000 ≈ año 2025
    assert.equal(extractYearFromDate(46000), 2025);
  });

  await t.test("entradas nulas, vacías o inválidas devuelven null sin lanzar error", () => {
    assert.equal(extractYearFromDate(""), null);
    assert.equal(extractYearFromDate(null), null);
    assert.equal(extractYearFromDate(undefined), null);
    assert.equal(extractYearFromDate("no-es-fecha"), null);
  });
});

test("dateUtils: normalizeDateToIso", async (t) => {
  await t.test("convierte DD/MM/YYYY a YYYY-MM-DD con relleno de ceros", () => {
    assert.equal(normalizeDateToIso("15/03/2026"), "2026-03-15");
    assert.equal(normalizeDateToIso("5/4/2026"), "2026-04-05");
    assert.equal(normalizeDateToIso("01/01/2025"), "2025-01-01");
  });

  await t.test("convierte DD-MM-YYYY a YYYY-MM-DD", () => {
    assert.equal(normalizeDateToIso("10-10-2026"), "2026-10-10");
    assert.equal(normalizeDateToIso("1-2-2024"), "2024-02-01");
  });

  await t.test("mantiene YYYY-MM-DD intacto", () => {
    assert.equal(normalizeDateToIso("2026-10-10"), "2026-10-10");
  });

  await t.test("recorta timestamp ISO a YYYY-MM-DD", () => {
    assert.equal(normalizeDateToIso("2026-10-10T14:16:10.686Z"), "2026-10-10");
  });
});

test("dateUtils: isDateOlderThanYears", async (t) => {
  const refYear = 2026;
  await t.test("un gasto de 2026 o 2021 no tiene más de 6 años respecto a 2026", () => {
    assert.equal(isDateOlderThanYears("2026-05-01", 6, refYear), false);
    assert.equal(isDateOlderThanYears("15/03/2026", 6, refYear), false);
    assert.equal(isDateOlderThanYears("10-10-2020", 6, refYear), false); // 2026 - 2020 = 6 (no mayor a 6)
  });

  await t.test("un gasto de 2019 tiene más de 6 años respecto a 2026", () => {
    assert.equal(isDateOlderThanYears("2019-12-31", 6, refYear), true);
    assert.equal(isDateOlderThanYears("15/06/2018", 6, refYear), true);
  });
});
