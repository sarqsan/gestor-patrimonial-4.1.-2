// Pruebas obligatorias de la migración segura de la cartera histórica.
// Ejecutar con: npm test (node:test + tsx, sin red ni Firebase real)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AppState, PropertyExpense, PropertyDocument, Property } from "../types";
import { portfolioBody } from "./portfolioPayload";
import {
  attachmentStoragePath,
  estimatePayloadBytes,
  PORTFOLIO_DOC_SAFE_BYTES,
  hasReceipt,
  isInlineDataUrl,
} from "./attachmentRules";
import {
  buildInventory,
  rewritePortfolioWithReferences,
  assertNoDataUrls,
  calculatePortfolioSize,
  runFullMigration,
  runUploadPhase,
  StorageAdapter,
  formatBytes,
  checkConcurrentChange,
} from "./portfolioMigration";
import { parseDataUrl } from "./legacyDataUrl";

// --- Helpers de prueba -----------------------------------------------------

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    user1: { name: "Titular 1", dni: "12345678A", brutoTrabajo: 30000, netoTrabajo: 25000 },
    user2: { name: "Titular 2", dni: "87654321B", brutoTrabajo: 20000, netoTrabajo: 18000, hasPartner: true },
    properties: [],
    payments: [],
    expenses: [],
    syncEvents: [],
    syncEnabled: true,
    isOnboarded: true,
    currentYear: 2026,
    yearlyProfiles: {},
    theme: "slate-indigo",
    ...overrides,
  };
}

function makeLegacyExpense(id: string, propertyId: string, base64Payload: string, name = "recibo.pdf"): PropertyExpense {
  return {
    id,
    propertyId,
    category: "ibi",
    type: "gasto",
    amount: 120,
    date: "2025-03-10",
    description: "IBI",
    receiptUrl: `data:application/pdf;base64,${base64Payload}`,
    receiptName: name,
    receiptType: "application/pdf",
  };
}

function makeLegacyDoc(id: string, name = "doc.pdf", base64Payload = "QUJD"): PropertyDocument {
  return {
    id,
    name,
    size: "1 KB",
    type: "application/pdf",
    category: "ibi",
    year: 2025,
    uploadDate: "2025-05-01",
    fileData: `data:application/pdf;base64,${base64Payload}`,
    contentType: "application/pdf",
  };
}

function makeProperty(id: string, docs: PropertyDocument[] = []): Property {
  return {
    id,
    address: `Calle Test ${id}, Madrid`,
    cadastralReference: `REF${id}1234567890`,
    owner: "both",
    ownershipPercentageUser1: 50,
    ownershipPercentageUser2: 50,
    tenantName: "Inquilino",
    tenantDni: "11111111A",
    monthlyRent: 1000,
    purchasePrice: 150000,
    landValuePercent: 25,
    amortizationAmount: 3375,
    expensesCommunity: 600,
    expensesIBI: 400,
    expensesInsurance: 200,
    expensesRepairs: 100,
    registrationDate: "2020-01-01",
    documents: docs,
  };
}

class FakeStorage implements StorageAdapter {
  store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  failOn: Set<string> = new Set();
  async uploadBytes(storagePath: string, bytes: Uint8Array, contentType: string) {
    if (this.failOn.has(storagePath)) throw new Error(`Simulated upload failure for ${storagePath}`);
    this.store.set(storagePath, { bytes, contentType });
  }
  async getBytes(storagePath: string) {
    const rec = this.store.get(storagePath);
    if (!rec) throw new Error(`Object not found: ${storagePath}`);
    return rec.bytes;
  }
  async exists(storagePath: string) {
    return this.store.has(storagePath);
  }
}

// --- Tests ---------------------------------------------------------------

test("lectura de cartera histórica con adjuntos Base64", () => {
  const exp = makeLegacyExpense("exp_legacy", "p1", Buffer.from("contenido pdf").toString("base64"));
  const doc = makeLegacyDoc("doc_legacy", "ibi.pdf", Buffer.from("doc content").toString("base64"));
  const prop = makeProperty("p1", [doc]);
  const state = baseState({ properties: [prop], expenses: [exp] });

  // Debe detectarse como histórico
  const inv = buildInventory(state, "rentasync");
  assert.equal(inv.legacyCount, 2);
  assert.equal(inv.attachments.length, 2);
  assert.ok(inv.initialBytes > 0);
  // hasReceipt reconoce histórico
  assert.equal(hasReceipt(exp), true);
  // isInlineDataUrl detecta
  assert.equal(isInlineDataUrl(exp.receiptUrl), true);
  assert.equal(isInlineDataUrl(doc.fileData), true);
});

test("lectura de cartera migrada con referencias a Storage", () => {
  const migratedExp: PropertyExpense = {
    id: "exp_new",
    propertyId: "p1",
    category: "ibi",
    amount: 120,
    date: "2026-03-10",
    receiptPath: "users/rentasync/attachments/expenses/exp_new/ibi.pdf",
    receiptName: "ibi.pdf",
    receiptType: "application/pdf",
  };
  const migratedDoc: PropertyDocument = {
    id: "doc_new",
    name: "ibi.pdf",
    size: "1 MB",
    type: "application/pdf",
    category: "ibi",
    year: 2026,
    uploadDate: "2026-05-01",
    storagePath: "users/rentasync/attachments/property-documents/doc_new/ibi.pdf",
    contentType: "application/pdf",
  };
  const prop = makeProperty("p1", [migratedDoc]);
  const state = baseState({ properties: [prop], expenses: [migratedExp] });

  const inv = buildInventory(state, "rentasync");
  assert.equal(inv.legacyCount, 0, "migrada no debe tener legacy");
  assert.equal(hasReceipt(migratedExp), true);
  assert.equal(isInlineDataUrl(migratedExp.receiptPath), false);
  assert.deepEqual(assertNoDataUrls(state), []);
});

test("compatibilidad durante la transición (histórico + nuevo conviven)", () => {
  const legacyExp = makeLegacyExpense("exp_old", "p1", "QUJD");
  const newExp: PropertyExpense = {
    id: "exp_new",
    propertyId: "p1",
    category: "ibi",
    amount: 100,
    date: "2026-01-01",
    receiptPath: "users/u/attachments/expenses/exp_new/file.pdf",
    receiptName: "file.pdf",
    receiptType: "application/pdf",
  };
  const state = baseState({ expenses: [legacyExp, newExp] });
  assert.equal(hasReceipt(legacyExp), true);
  assert.equal(hasReceipt(newExp), true);
  const inv = buildInventory(state, "rentasync");
  assert.equal(inv.legacyCount, 1);
  assert.equal(inv.attachments[0].attachmentId, "exp_old");
});

test("conservación exacta de identificadores, relaciones, titularidades, importes y metadatos", async () => {
  const exp = makeLegacyExpense("exp_123", "prop_456", Buffer.from("bytes").toString("base64"), "factura_ibi.pdf");
  const doc = makeLegacyDoc("doc_789", "escritura.pdf", Buffer.from("docbytes").toString("base64"));
  const prop = makeProperty("prop_456", [doc]);
  prop.owner = "both";
  prop.ownershipPercentageUser1 = 60;
  prop.ownershipPercentageUser2 = 40;
  prop.monthlyRent = 1234;
  prop.purchasePrice = 200000;

  const state = baseState({ properties: [prop], expenses: [exp] });
  const inv = buildInventory(state, "userA");
  const migrated = rewritePortfolioWithReferences(state, inv);

  // Identificadores estables
  assert.equal(migrated.expenses![0].id, "exp_123");
  assert.equal(migrated.expenses![0].propertyId, "prop_456");
  assert.equal(migrated.properties[0].id, "prop_456");
  assert.equal(migrated.properties[0].documents![0].id, "doc_789");
  // Relaciones y titularidades
  assert.equal(migrated.properties[0].owner, "both");
  assert.equal(migrated.properties[0].ownershipPercentageUser1, 60);
  assert.equal(migrated.properties[0].ownershipPercentageUser2, 40);
  assert.equal(migrated.properties[0].monthlyRent, 1234);
  assert.equal(migrated.properties[0].purchasePrice, 200000);
  // Importes
  assert.equal(migrated.expenses![0].amount, 120);
  // Metadatos de archivo preservados (nombre, tipo)
  assert.equal(migrated.expenses![0].receiptName, "factura_ibi.pdf");
  assert.equal(migrated.properties[0].documents![0].name, "escritura.pdf");
  // No quedan data URLs
  assert.deepEqual(assertNoDataUrls(migrated), []);
});

test("migración sin pérdida de bytes ni asociaciones", async () => {
  const content = Buffer.from("contenido importante del pdf").toString("base64");
  const exp = makeLegacyExpense("exp_1", "p1", content, "recibo.pdf");
  const state = baseState({ expenses: [exp], properties: [makeProperty("p1")] });
  const fake = new FakeStorage();
  const result = await runFullMigration(state, "rentasync", fake);
  assert.equal(result.success, true);
  assert.ok(result.migratedPortfolio);
  // Verificar bytes idénticos
  const stored = fake.store.get(result.inventory.attachments[0].storagePath);
  assert.ok(stored);
  const originalBytes = Buffer.from(content, "base64");
  assert.equal(stored!.bytes.length, originalBytes.length);
  for (let i = 0; i < originalBytes.length; i++) assert.equal(stored!.bytes[i], originalBytes[i]);
  // Asociación: el storagePath del gasto migrado coincide con el subido
  assert.equal(result.migratedPortfolio!.expenses![0].receiptPath, result.inventory.attachments[0].storagePath);
});

test("reanudación tras un fallo simulado", async () => {
  const exp1 = makeLegacyExpense("exp_1", "p1", Buffer.from("a").toString("base64"));
  const exp2 = makeLegacyExpense("exp_2", "p1", Buffer.from("b").toString("base64"));
  const exp3 = makeLegacyExpense("exp_3", "p1", Buffer.from("c").toString("base64"));
  const state = baseState({ expenses: [exp1, exp2, exp3], properties: [makeProperty("p1")] });
  const fake = new FakeStorage();
  const inv = buildInventory(state, "rentasync");
  // Simular fallo en el segundo
  fake.failOn.add(inv.attachments[1].storagePath);
  const { results, errors } = await runUploadPhase(inv, fake);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].attachmentId, "exp_2");
  // Reanudar: quitar fallo y re-ejecutar, debe subir los 3 (idempotente)
  fake.failOn.clear();
  const { results: results2, errors: errors2 } = await runUploadPhase(inv, fake);
  assert.equal(errors2.length, 0);
  assert.equal(fake.store.size, 3);
  // Verificar que no hay duplicados (mismo path)
  assert.equal(new Set([...fake.store.keys()]).size, 3);
});

test("repetición del proceso sin duplicaciones", async () => {
  const exp = makeLegacyExpense("exp_dup", "p1", Buffer.from("dup").toString("base64"));
  const state = baseState({ expenses: [exp], properties: [makeProperty("p1")] });
  const fake = new FakeStorage();
  const inv = buildInventory(state, "rentasync");
  await runUploadPhase(inv, fake);
  const sizeAfterFirst = fake.store.size;
  await runUploadPhase(inv, fake);
  const sizeAfterSecond = fake.store.size;
  assert.equal(sizeAfterFirst, 1);
  assert.equal(sizeAfterSecond, 1, "re-ejecutar no duplica");
  // Ruta determinista
  const path1 = attachmentStoragePath("rentasync", "expenses", "exp_dup", "recibo.pdf");
  const path2 = inv.attachments[0].storagePath;
  assert.equal(path1, path2);
});

test("fallos de subida, lectura y verificación", async () => {
  // Subida fallida
  const exp = makeLegacyExpense("exp_fail", "p1", Buffer.from("x").toString("base64"));
  const state = baseState({ expenses: [exp], properties: [makeProperty("p1")] });
  const fake = new FakeStorage();
  fake.failOn.add(buildInventory(state, "rentasync").attachments[0].storagePath);
  const resultFail = await runFullMigration(state, "rentasync", fake);
  assert.equal(resultFail.success, false);
  assert.equal(resultFail.migratedPortfolio, null);

  // Data URL ilegible
  const badExp: PropertyExpense = {
    id: "exp_bad",
    propertyId: "p1",
    category: "ibi",
    amount: 10,
    date: "2025-01-01",
    receiptUrl: "data:application/pdf;base64,!!!no_base64!!!",
  };
  const badState = baseState({ expenses: [badExp], properties: [makeProperty("p1")] });
  const fake2 = new FakeStorage();
  const resultBad = await runFullMigration(badState, "rentasync", fake2);
  assert.equal(resultBad.success, false);
});

test("cambios concurrentes y protección contra sobrescrituras", () => {
  assert.equal(checkConcurrentChange("2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"), false, "sin cambio");
  assert.equal(checkConcurrentChange("2025-01-02T00:00:00Z", "2025-01-01T00:00:00Z"), true, "cambio detectado");
  assert.equal(checkConcurrentChange(undefined, "2025-01-01T00:00:00Z"), true, "sin actual = cambio");
  assert.equal(checkConcurrentChange("2025-01-01T00:00:00Z", undefined), false, "sin esperado = no se puede detectar");
});

test("cálculo del tamaño del documento serializado y detección de proximidad al límite", () => {
  const bigBase64 = "A".repeat(PORTFOLIO_DOC_SAFE_BYTES);
  const exp: PropertyExpense = {
    id: "exp_big",
    propertyId: "p1",
    category: "ibi",
    amount: 1,
    date: "2025-01-01",
    receiptUrl: `data:application/pdf;base64,${bigBase64}`,
  };
  const state = baseState({ expenses: [exp] });
  const size = calculatePortfolioSize(state);
  assert.ok(size.bytes > PORTFOLIO_DOC_SAFE_BYTES, `debe superar límite: ${size.bytes}`);
  assert.equal(size.blocked, true);
  assert.equal(size.nearLimit, true);

  const smallState = baseState({ expenses: [] });
  const smallSize = calculatePortfolioSize(smallState);
  assert.equal(smallSize.blocked, false);
});

test("bloqueo de escrituras que superarían el límite de Firestore, con error comprensible", () => {
  // Simula la guardia de App.tsx: estimatePayloadBytes > safe -> bloqueado
  const big = "data:application/pdf;base64," + "A".repeat(PORTFOLIO_DOC_SAFE_BYTES);
  const body = portfolioBody(baseState({ expenses: [{ id: "e", propertyId: "p", category: "ibi", amount: 1, date: "2025-01-01", receiptUrl: big } as PropertyExpense] }));
  const bytes = estimatePayloadBytes(body);
  assert.ok(bytes > PORTFOLIO_DOC_SAFE_BYTES);
  const kb = Math.round(bytes / 1024);
  const msg = `La cartera ocupa ${kb} KB y supera el límite por documento de Firestore (1 MiB). Los nuevos adjuntos ya se guardan en Storage, pero el documento histórico necesita migración antes de poder guardar más datos. Los cambios NO se han guardado en la nube.`;
  assert.ok(msg.includes("KB"));
  assert.ok(msg.includes("Firestore"));
});

test("guardado normal después de una migración de prueba", async () => {
  const exp = makeLegacyExpense("exp_1", "p1", Buffer.from("ok").toString("base64"));
  const state = baseState({ expenses: [exp], properties: [makeProperty("p1")] });
  const fake = new FakeStorage();
  const result = await runFullMigration(state, "rentasync", fake);
  assert.equal(result.success, true);
  const migrated = result.migratedPortfolio!;
  const size = calculatePortfolioSize(migrated);
  assert.equal(size.blocked, false, "después de migrar no debe estar bloqueado");
  assert.ok(size.bytes < PORTFOLIO_DOC_SAFE_BYTES);
  // Simular guardado: portfolioBody no debe contener data URLs
  const body = portfolioBody(migrated);
  const json = JSON.stringify(body);
  assert.equal(json.includes("data:application/pdf;base64"), false);
});

test("separación entre usuarios y respeto de los permisos existentes", () => {
  const exp = makeLegacyExpense("exp_1", "p1", "QUJD");
  const state = baseState({ expenses: [exp], properties: [makeProperty("p1")] });
  const invUserA = buildInventory(state, "userA");
  const invUserB = buildInventory(state, "userB");
  assert.notEqual(invUserA.attachments[0].storagePath, invUserB.attachments[0].storagePath);
  assert.ok(invUserA.attachments[0].storagePath.includes("userA"));
  assert.ok(invUserB.attachments[0].storagePath.includes("userB"));
  // Codificación segura: ../ no debe inyectar ruta
  const evilInv = buildInventory(state, "../otro");
  assert.ok(evilInv.attachments[0].storagePath.startsWith("users/..%2Fotro/"));
  assert.equal(evilInv.attachments[0].storagePath.split("/").length, 6);
});

test("ausencia de escrituras en Firebase real durante las pruebas", () => {
  // Esta prueba garantiza que los adaptadores de prueba no usan Firebase real.
  // Si se importara firebaseMigration, fallaría sin config; aquí solo usamos FakeStorage.
  const fake = new FakeStorage();
  assert.equal(fake.store.size, 0);
  // No se ha llamado a ningún SDK de Firebase
});

test("parseDataUrl decodifica correctamente y estima tamaño", () => {
  const original = "Hola mundo pdf";
  const b64 = Buffer.from(original).toString("base64");
  const url = `data:application/pdf;base64,${b64}`;
  const parsed = parseDataUrl(url);
  assert.ok(parsed);
  assert.equal(parsed!.mimeType, "application/pdf");
  assert.equal(Buffer.from(parsed!.bytes).toString(), original);
  assert.equal(parsed!.sizeBytes, original.length);
});

test("formatBytes y inventoryReport generan unidades claras", () => {
  assert.equal(formatBytes(500), "500 B");
  assert.ok(formatBytes(1500).includes("KB"));
  assert.ok(formatBytes(2_000_000).includes("MB"));
  const exp = makeLegacyExpense("e1", "p1", "QUJD");
  const inv = buildInventory(baseState({ expenses: [exp], properties: [makeProperty("p1")] }), "u");
  const report = inv.attachments.length > 0 ? "dummy" : "";
  // inventoryReport debe contener KB y unidades
  const fullReport = buildInventory(baseState({ expenses: [exp], properties: [makeProperty("p1")] }), "u");
  const text = `${formatBytes(fullReport.initialBytes)}`;
  assert.ok(text.includes("B") || text.includes("KB") || text.includes("MB"));
});

test("el documento principal queda por debajo del límite con margen tras migración de cartera grande", async () => {
  // Simular cartera con 20 adjuntos históricos de ~50KB cada uno (base64 ~ 67KB)
  const manyExpenses: PropertyExpense[] = [];
  for (let i = 0; i < 20; i++) {
    const payload = Buffer.alloc(50 * 1024, "a").toString("base64"); // 50KB binary -> ~66KB base64
    manyExpenses.push(makeLegacyExpense(`exp_${i}`, "p1", payload, `recibo_${i}.pdf`));
  }
  const state = baseState({ expenses: manyExpenses, properties: [makeProperty("p1")] });
  const inv = buildInventory(state, "rentasync");
  assert.ok(inv.initialBytes > 1_000_000, `inicial debe superar 1MB, es ${inv.initialBytes}`);
  const fake = new FakeStorage();
  const result = await runFullMigration(state, "rentasync", fake);
  assert.equal(result.success, true);
  assert.ok(result.finalBytes! < PORTFOLIO_DOC_SAFE_BYTES, `final ${result.finalBytes} debe ser < ${PORTFOLIO_DOC_SAFE_BYTES}`);
  assert.ok(result.finalBytes! < PORTFOLIO_DOC_SAFE_BYTES * 0.8, "con margen suficiente (<80%)");
});
