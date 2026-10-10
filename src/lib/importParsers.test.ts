// Pruebas de la importación de inmuebles y gastos/ingresos (JSON y hojas de cálculo).
// Ejecutar con: npm test  (node:test + tsx; no requiere red ni Firebase)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_ACCEPT,
  IMPORT_EXTENSIONS,
  validateImportFileName,
  parseFlexibleNumber,
  detectImportStructure,
  parsePropertiesFromText,
  parsePropertiesFromRows,
  parseExpensesFromText,
  parseExpensesFromRows,
} from "./importParsers";
import { portfolioBody } from "./portfolioPayload";
import { AppState, PropertyExpense } from "../types";

// --- Selección y validación de archivos -----------------------------------

test("validación tras selección: admite JSON, XLSX, XLS y CSV sin distinguir mayúsculas", () => {
  for (const name of ["datos.json", "datos.JSON", "datos.xlsx", "datos.XLSX", "datos.xls", "datos.csv", "copia.de.seguridad.json"]) {
    assert.equal(validateImportFileName(name), null, name);
  }
});

test("rechazo claro de formatos no admitidos, con los formatos soportados en el mensaje", () => {
  for (const name of ["datos.pdf", "datos.txt", "virus.exe", "foto.png", "sin_extension", "datos.json.exe"]) {
    const msg = validateImportFileName(name);
    assert.notEqual(msg, null, name);
    assert.match(msg!, /JSON, XLSX, XLS o CSV/);
    assert.match(msg!, /Formato no admitido/);
  }
});

test("el atributo accept incluye extensiones y tipos MIME genéricos de Android para que el selector no muestre los JSON en gris", () => {
  assert.ok(IMPORT_ACCEPT.includes(".json"));
  assert.ok(IMPORT_ACCEPT.includes("application/json"));
  assert.ok(IMPORT_ACCEPT.includes("application/octet-stream"));
  assert.ok(IMPORT_ACCEPT.includes("text/plain"));
  assert.ok(IMPORT_ACCEPT.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  assert.deepEqual([...IMPORT_EXTENSIONS], [".json", ".xlsx", ".xls", ".csv"]);
});

// --- Números flexibles (sin inventar) -------------------------------------

test("parseFlexibleNumber interpreta formatos españoles e ingleses y no inventa ante entradas ilegibles", () => {
  assert.equal(parseFlexibleNumber(1234.56), 1234.56);
  assert.equal(parseFlexibleNumber("1234.56"), 1234.56);
  assert.equal(parseFlexibleNumber("1234,56"), 1234.56);
  assert.equal(parseFlexibleNumber("1.234,56"), 1234.56);
  assert.equal(parseFlexibleNumber("1.234"), 1234);
  assert.equal(parseFlexibleNumber("1 234,56"), 1234.56);
  assert.equal(parseFlexibleNumber("0"), 0);
  assert.equal(parseFlexibleNumber("-15,5"), -15.5);
  assert.equal(parseFlexibleNumber("abc"), null);
  assert.equal(parseFlexibleNumber(""), null);
  assert.equal(parseFlexibleNumber(null), null);
});

// --- Reconocimiento de estructuras ----------------------------------------

const propertyFixture = {
  id: "prop_1",
  address: "Calle Mayor 1, Madrid",
  cadastralReference: "1234567890123456789",
  owner: "both" as const,
  ownershipPercentageUser1: 60,
  ownershipPercentageUser2: 40,
  tenantName: "Ana",
  tenantDni: "12345678A",
  monthlyRent: 950,
  purchasePrice: 180000,
  currentValue: 210000,
  mortgageDebt: 90000,
  monthlyMortgagePayment: 620,
  mortgageInterestRate: 2.5,
  mortgageStartDate: "2021-01-15",
  mortgageTermYears: 25,
  landValuePercent: 25,
  amortizationAmount: 3600,
  expensesCommunity: 600,
  expensesIBI: 450,
  expensesInsurance: 180,
  expensesRepairs: 200,
  registrationDate: "2021-02-01",
  contract: { startDate: "2021-02-01", monthlyRent: 950 },
  tenantHistory: [{ id: "tc_1", tenantName: "Ana", tenantDni: "12345678A", startDate: "2021-02-01", monthlyRent: 950 }],
  yearlyFinancials: { 2025: { currentValue: 205000, purchasePrice: 180000 } },
  documents: [{ id: "doc_1", name: "IBI.pdf", size: "1 MB", type: "application/pdf", category: "ibi", year: 2025, uploadDate: "2025-05-01" }],
};

const expenseFixture: PropertyExpense = {
  id: "exp_1",
  propertyId: "prop_1",
  category: "ibi",
  type: "gasto",
  amount: 450.25,
  date: "2025-09-12",
  description: "IBI 2025",
  receiptUrl: "data:application/pdf;base64,AAAA",
  receiptPath: "users/rentasync/attachments/expenses/exp_1/IBI.pdf",
  receiptName: "IBI_2025.pdf",
  receiptType: "application/pdf",
};

test("lista aislada de inmuebles (exportación JSON de la aplicación) se importa completa", () => {
  const res = parsePropertiesFromText(JSON.stringify([propertyFixture]));
  assert.equal(res.error, null);
  assert.equal(res.structure.kind, "property-list");
  assert.equal(res.properties.length, 1);
  assert.deepEqual(res.rejected, []);
});

test("lista aislada de gastos/ingresos (exportación JSON de la aplicación) se importa completa", () => {
  const res = parseExpensesFromText(JSON.stringify([expenseFixture]));
  assert.equal(res.error, null);
  assert.equal(res.structure.kind, "expense-list");
  assert.equal(res.expenses.length, 1);
  assert.deepEqual(res.rejected, []);
});

test("una copia de seguridad integral se reconoce como tal y no como lista aislada", () => {
  const backup = portfolioBody({
    user1: { name: "A", dni: "1", brutoTrabajo: 1, netoTrabajo: 1 },
    user2: { name: "B", dni: "2", brutoTrabajo: 1, netoTrabajo: 1, hasPartner: true },
    properties: [propertyFixture],
    payments: [],
    expenses: [expenseFixture],
    contracts: [],
    syncEvents: [],
    syncEnabled: true,
    isOnboarded: true,
    currentYear: 2026,
    yearlyProfiles: {},
    theme: "slate-indigo",
  } as AppState);

  const struct = detectImportStructure(backup);
  assert.equal(struct.kind, "portfolio-backup");
  assert.match(struct.label, /Copia de seguridad integral/);

  const props = parsePropertiesFromText(JSON.stringify(backup));
  assert.equal(props.error, null);
  assert.equal(props.structure.kind, "portfolio-backup");
  assert.equal(props.properties.length, 1, "toma los inmuebles del respaldo");
  assert.equal(props.properties[0].address, "Calle Mayor 1, Madrid");

  const exps = parseExpensesFromText(JSON.stringify(backup));
  assert.equal(exps.error, null);
  assert.equal(exps.structure.kind, "portfolio-backup");
  assert.equal(exps.expenses.length, 1, "toma gastos/ingresos del respaldo, no inmuebles");
  assert.equal(exps.expenses[0].amount, 450.25);
});

test("una copia integral sin gastos no genera importaciones inventadas y lo informa", () => {
  const backup = { properties: [propertyFixture], payments: [], user1: {}, user2: {} };
  const exps = parseExpensesFromText(JSON.stringify(backup));
  assert.equal(exps.expenses.length, 0);
  assert.match(exps.error!, /no contiene gastos\/ingresos/);
});

test("un listado de gastos no se confunde con inmuebles (y viceversa) con mensajes claros", () => {
  const asProps = parsePropertiesFromText(JSON.stringify([expenseFixture]));
  assert.equal(asProps.properties.length, 0);
  assert.match(asProps.error!, /lista de gastos\/ingresos, no de inmuebles/);

  const asExps = parseExpensesFromText(JSON.stringify([propertyFixture]));
  assert.equal(asExps.expenses.length, 0);
  assert.match(asExps.error!, /lista de inmuebles, no de gastos\/ingresos/);
});

test("envoltorios comunes ({properties}, {inmuebles}, {data}, {state}, objeto único) se reconocen", () => {
  assert.equal(parsePropertiesFromText(JSON.stringify({ properties: [propertyFixture] })).properties.length, 1);
  assert.equal(parsePropertiesFromText(JSON.stringify({ inmuebles: [propertyFixture] })).properties.length, 1);
  assert.equal(parsePropertiesFromText(JSON.stringify({ data: { properties: [propertyFixture] } })).properties.length, 1);
  assert.equal(parsePropertiesFromText(JSON.stringify({ state: { properties: [propertyFixture] } })).properties.length, 1);
  assert.equal(parsePropertiesFromText(JSON.stringify(propertyFixture)).properties.length, 1);
  assert.equal(parseExpensesFromText(JSON.stringify({ expenses: [expenseFixture] })).expenses.length, 1);
  assert.equal(parseExpensesFromText(JSON.stringify({ gastos: [expenseFixture] })).expenses.length, 1);
  assert.equal(parseExpensesFromText(JSON.stringify({ gastos: [expenseFixture], ingresos: [{ ...expenseFixture, id: "exp_2", type: "ingreso", category: "rent" }] })).expenses.length, 2);
  assert.equal(parseExpensesFromText(JSON.stringify(expenseFixture)).expenses.length, 1);
  // Claves ambiguas ({items}) se clasifican por la forma de las filas, no por el nombre.
  assert.equal(parsePropertiesFromText(JSON.stringify({ items: [propertyFixture] })).properties.length, 1);
  assert.equal(parseExpensesFromText(JSON.stringify({ items: [expenseFixture] })).expenses.length, 1);
});

test("JSON inválido u estructura desconocida dan error claro sin lanzar excepciones", () => {
  const broken = parsePropertiesFromText("{esto no es json");
  assert.equal(broken.properties.length, 0);
  assert.match(broken.error!, /no es JSON válido/);

  const unknown = parsePropertiesFromText(JSON.stringify({ foo: 42, bar: "hola" }));
  assert.equal(unknown.properties.length, 0);
  assert.match(unknown.error!, /inmuebles/);

  const unknownExp = parseExpensesFromText(JSON.stringify({ foo: 42 }));
  assert.equal(unknownExp.expenses.length, 0);
  assert.match(unknownExp.error!, /gastos\/ingresos/);
});

// --- Fidelidad de datos: conservar sin inventar ---------------------------

test("la titularidad 'both' de la exportación se conserva (no se degrada a user1)", () => {
  const res = parsePropertiesFromText(JSON.stringify([propertyFixture]));
  assert.equal(res.properties[0].owner, "both");
  assert.equal(res.properties[0].ownershipPercentageUser1, 60);
  assert.equal(res.properties[0].ownershipPercentageUser2, 40);
});

test("alias legado 'joint' se normaliza a 'both' sin perder la titularidad conjunta", () => {
  const res = parsePropertiesFromText(JSON.stringify([{ ...propertyFixture, owner: "joint" }]));
  assert.equal(res.properties[0].owner, "both");
});

test("se conservan los campos compatibles de la exportación: hipoteca, contrato, historial, datos anuales y documentos", () => {
  const p = parsePropertiesFromText(JSON.stringify([propertyFixture])).properties[0];
  assert.equal(p.currentValue, 210000);
  assert.equal(p.mortgageDebt, 90000);
  assert.equal(p.monthlyMortgagePayment, 620);
  assert.equal(p.mortgageInterestRate, 2.5);
  assert.equal(p.mortgageStartDate, "2021-01-15");
  assert.equal(p.mortgageTermYears, 25);
  assert.deepEqual(p.contract, propertyFixture.contract);
  assert.deepEqual(p.tenantHistory, propertyFixture.tenantHistory);
  assert.deepEqual(p.yearlyFinancials, propertyFixture.yearlyFinancials);
  assert.deepEqual(p.documents, propertyFixture.documents);
});

test("los comprobantes de los gastos se conservan (URL, ruta, nombre y tipo)", () => {
  const e = parseExpensesFromText(JSON.stringify([expenseFixture])).expenses[0];
  assert.equal(e.receiptUrl, "data:application/pdf;base64,AAAA");
  assert.equal(e.receiptPath, "users/rentasync/attachments/expenses/exp_1/IBI.pdf");
  assert.equal(e.receiptName, "IBI_2025.pdf");
  assert.equal(e.receiptType, "application/pdf");
});

test("no se inventa la relación operación-inmueble: sin propertyId se importa sin asignar y con aviso", () => {
  const { id, propertyId, ...sinRelacion } = expenseFixture;
  const res = parseExpensesFromText(JSON.stringify([sinRelacion]));
  assert.equal(res.expenses.length, 1, "el registro se conserva");
  assert.equal(res.expenses[0].propertyId, "", "sin inmueble inventado");
  assert.ok(res.warnings.some((w) => w.key === "propertyId"));
});

test("no se inventan fechas: sin fecha el registro se rechaza con motivo (no se pone la de hoy)", () => {
  const { id, date, ...sinFecha } = expenseFixture;
  const res = parseExpensesFromText(JSON.stringify([sinFecha]));
  assert.equal(res.expenses.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /fecha no informada/);
});

test("no se inventan importes: sin importe se rechaza con motivo y los negativos se conservan", () => {
  const { id, amount, ...sinImporte } = expenseFixture;
  const res = parseExpensesFromText(JSON.stringify([sinImporte]));
  assert.equal(res.expenses.length, 0);
  assert.match(res.rejected[0].reason, /importe no informado/);

  const neg = parseExpensesFromText(JSON.stringify([{ ...expenseFixture, amount: -30 }]));
  assert.equal(neg.expenses[0].amount, -30);
});

test("no se inventa amortización: si no viene, se importa a 0 con aviso (sin fórmulas ocultas)", () => {
  const { amortizationAmount, ...sinAmort } = propertyFixture;
  const res = parsePropertiesFromText(JSON.stringify([sinAmort]));
  assert.equal(res.properties[0].amortizationAmount, 0);
  assert.equal(res.properties[0].purchasePrice, 180000);
  assert.ok(res.warnings.some((w) => w.key === "amortizationAmount"));
});

test("no se inventa la fecha de registro: si no viene, queda vacía con aviso", () => {
  const { registrationDate, ...sinFecha } = propertyFixture;
  const res = parsePropertiesFromText(JSON.stringify([sinFecha]));
  assert.equal(res.properties[0].registrationDate, "");
  assert.ok(res.warnings.some((w) => w.key === "registrationDate"));
});

test("no se inventan titulares: titularidad ausente o desconocida se rechaza con motivo", () => {
  const { owner, ...sinTitular } = propertyFixture;
  const res = parsePropertiesFromText(JSON.stringify([sinTitular]));
  assert.equal(res.properties.length, 0);
  assert.match(res.rejected[0].reason, /titularidad no informada/);

  const raro = parsePropertiesFromText(JSON.stringify([{ ...propertyFixture, owner: "banco" }]));
  assert.match(raro.rejected[0].reason, /no reconocida/);
});

test("nada se descarta en silencio: los registros no importables aparecen en rejected con su motivo", () => {
  const res = parsePropertiesFromText(JSON.stringify([
    propertyFixture,
    { ...propertyFixture, id: "prop_bad", address: "" },
    { ...propertyFixture, id: "prop_bad2", monthlyRent: "no-númerico" },
  ]));
  assert.equal(res.properties.length, 1);
  assert.equal(res.rejected.length, 2);
  assert.ok(res.rejected.every((r) => r.reason.length > 0));
});

test("el contenido original no se muta al importar", () => {
  const original = JSON.stringify([propertyFixture]);
  const snapshot = JSON.parse(original);
  parsePropertiesFromText(original);
  assert.deepEqual(JSON.parse(original), snapshot);
});

// --- Hojas de cálculo (exportación Excel de la aplicación) -----------------

test("las filas de la exportación Excel de inmuebles se mapean por sus cabeceras en español", () => {
  const rows = [{
    "ID Inmueble": "prop_x",
    "Dirección Completa": "Avda. del Sol 2, Valencia",
    "Referencia Catastral": "9876543210987654321",
    "Titularidad": "both",
    "% Propietario 1": 50,
    "% Propietario 2": 50,
    "Inquilino": "Luis",
    "DNI Inquilino": "87654321B",
    "Renta Mensual (€)": 800,
    "Precio Adquisición (€)": 150000,
    "% Suelo Catastral": 30,
    "Amortización Anual (€)": 2800,
    "Gastos Comunidad (€)": 500,
    "Gastos IBI (€)": 400,
    "Gastos Seguro (€)": 150,
    "Gastos Reparaciones (€)": 90,
    "Fecha Registro": "2022-03-01",
  }];
  const res = parsePropertiesFromRows(rows);
  assert.equal(res.properties.length, 1);
  const p = res.properties[0];
  assert.equal(p.id, "prop_x");
  assert.equal(p.address, "Avda. del Sol 2, Valencia");
  assert.equal(p.owner, "both");
  assert.equal(p.monthlyRent, 800);
  assert.equal(p.landValuePercent, 30);
  assert.equal(p.amortizationAmount, 2800);
  assert.equal(p.registrationDate, "2022-03-01");
  assert.deepEqual(res.rejected, []);
});

test("las filas de la exportación Excel de gastos se mapean por sus cabeceras y etiquetas de categoría", () => {
  const rows = [{
    "ID Transacción": "exp_x",
    "ID Inmueble": "prop_x",
    "Inmueble / Dirección": "Avda. del Sol 2",
    "Tipo Registro": "ingreso",
    "Categoría Fiscal": "Ingresos por Alquiler",
    "Importe (€)": "1.200,50",
    "Fecha": "2025-01-31",
    "Descripción / Concepto": "Renta enero",
    "Nombre Comprobante": "recibo_enero.pdf",
  }];
  const res = parseExpensesFromRows(rows);
  assert.equal(res.expenses.length, 1);
  const e = res.expenses[0];
  assert.equal(e.id, "exp_x");
  assert.equal(e.propertyId, "prop_x");
  assert.equal(e.category, "rent");
  assert.equal(e.type, "ingreso");
  assert.equal(e.amount, 1200.5);
  assert.equal(e.date, "2025-01-31");
  assert.equal(e.receiptName, "recibo_enero.pdf");
});

test("las fechas seriales de Excel se convierten sin inventar (serial 45000 → 2023-03-15)", () => {
  const res = parseExpensesFromRows([{ amount: 10, date: 45000 }]);
  assert.equal(res.expenses[0].date, "2023-03-15");
});

test("filas de hoja de cálculo sin dirección/importe no se importan en silencio: van a rejected", () => {
  const props = parsePropertiesFromRows([{ "Inquilino": "X" }]);
  assert.equal(props.properties.length, 0);
  assert.equal(props.rejected.length, 1);

  const exps = parseExpensesFromRows([{ "Fecha": "2025-01-01" }]);
  assert.equal(exps.expenses.length, 0);
  assert.equal(exps.rejected.length, 1);
  assert.match(exps.rejected[0].reason, /importe no informado/);
});
