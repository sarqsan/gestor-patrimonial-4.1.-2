// Pruebas de la lógica de adjuntos y del documento de cartera.
// Ejecutar con: npm test  (node:test + tsx; no requiere red ni Firebase)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ATTACHMENT_BYTES,
  PORTFOLIO_DOC_SAFE_BYTES,
  attachmentStoragePath,
  estimatePayloadBytes,
  findInlineDataPaths,
  hasReceipt,
  listLegacyInlineAttachments,
  newAttachmentId,
  resolveContentType,
  sanitizeFileName,
  validateAttachment,
} from "./attachmentRules";
import { portfolioBody } from "./portfolioPayload";
import { AppState, PropertyExpense } from "../types";

const ROOT = join(import.meta.dirname, "..", "..");

// --- Validación de nuevos adjuntos ---------------------------------------
test("acepta PDF, JPG, PNG y WEBP dentro de límite", () => {
  assert.equal(validateAttachment({ name: "f.pdf", size: 1000, type: "application/pdf" }), null);
  assert.equal(validateAttachment({ name: "f.jpg", size: 1000, type: "image/jpeg" }), null);
  assert.equal(validateAttachment({ name: "f.png", size: 1000, type: "" }), null);
  assert.equal(validateAttachment({ name: "f.webp", size: 1000, type: "image/webp" }), null);
});

test("rechaza formatos no admitidos, ficheros vacíos y superiores a 10 MB", () => {
  assert.notEqual(validateAttachment({ name: "x.exe", size: 10, type: "application/x-msdownload" }), null);
  assert.notEqual(validateAttachment({ name: "x.pdf", size: 0, type: "application/pdf" }), null);
  assert.notEqual(validateAttachment({ name: "x.pdf", size: MAX_ATTACHMENT_BYTES + 1, type: "application/pdf" }), null);
  assert.equal(validateAttachment({ name: "x.pdf", size: MAX_ATTACHMENT_BYTES, type: "application/pdf" }), null);
});

test("deduce el tipo MIME por extensión cuando el navegador no lo informa", () => {
  assert.equal(resolveContentType("factura.PDF", ""), "application/pdf");
  assert.equal(resolveContentType("foto.jpeg", ""), "image/jpeg");
  assert.equal(resolveContentType("datos.bin", ""), "application/octet-stream");
});

// --- Rutas de Storage ----------------------------------------------------
test("la ruta es por usuario, determinista y sin separadores inyectados", () => {
  const p1 = attachmentStoragePath("rentasync", "expenses", "rcpt_1", "Factura IBI 2026.pdf");
  const p2 = attachmentStoragePath("rentasync", "expenses", "rcpt_1", "Factura IBI 2026.pdf");
  assert.equal(p1, p2);
  assert.equal(p1, "users/rentasync/attachments/expenses/rcpt_1/Factura_IBI_2026.pdf");

  const evil = attachmentStoragePath("../otro/usuario", "contracts", "ctr_1", "c.pdf");
  assert.ok(evil.startsWith("users/..%2Fotro%2Fusuario/"), evil);
  assert.equal(evil.split("/").length, 6);
});

test("el nombre de fichero se sanea y se limita", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "etc_passwd");
  assert.equal(sanitizeFileName(".hidden.pdf"), "hidden.pdf");
  assert.ok(sanitizeFileName("a".repeat(500)).length <= 120);
  assert.equal(sanitizeFileName("   "), "archivo");
});

test("los identificadores nuevos son únicos (nunca se reutiliza una ruta)", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newAttachmentId("rcpt")));
  assert.equal(ids.size, 200);
});

// --- Compatibilidad con histórico ----------------------------------------
const legacyExpense: PropertyExpense = {
  id: "exp_legacy",
  propertyId: "p1",
  category: "ibi",
  amount: 120,
  date: "2025-03-10",
  receiptUrl: "data:application/pdf;base64,QUJD",
  receiptName: "ibi.pdf",
  receiptType: "application/pdf",
};
const newExpense: PropertyExpense = {
  id: "exp_new",
  propertyId: "p1",
  category: "ibi",
  amount: 120,
  date: "2026-03-10",
  receiptPath: "users/u/attachments/expenses/rcpt_1/ibi.pdf",
  receiptName: "ibi.pdf",
  receiptType: "application/pdf",
};

test("hasReceipt reconoce adjuntos históricos y nuevos", () => {
  assert.equal(hasReceipt(legacyExpense), true);
  assert.equal(hasReceipt(newExpense), true);
  assert.equal(hasReceipt({}), false);
});

test("listLegacyInlineAttachments solo lista los Base64 históricos (solo lectura)", () => {
  const found = listLegacyInlineAttachments({
    expenses: [legacyExpense, newExpense],
    properties: [
      {
        id: "p1",
        documents: [
          { id: "doc_legacy", fileData: "data:image/png;base64,iVBOR" },
          { id: "doc_new" },
        ],
      },
    ],
  });
  assert.deepEqual(
    found.map((f) => `${f.kind}:${f.id}`),
    ["expense:exp_legacy", "property-document:doc_legacy"]
  );
});

// --- Documento de cartera: no debe contener Base64 de adjuntos nuevos ----
function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    user1: { name: "A", dni: "1", brutoTrabajo: 0, netoTrabajo: 0 },
    user2: { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false },
    properties: [],
    payments: [],
    expenses: [],
    syncEvents: [],
    syncEnabled: true,
    isOnboarded: true,
    ...overrides,
  };
}

test("el payload de la cartera no contiene data: URLs al añadir adjuntos nuevos", () => {
  const body = portfolioBody(baseState({ expenses: [newExpense] }));
  assert.deepEqual(findInlineDataPaths(body), []);
});

test("el payload detecta cualquier data: URL incrustada (protección de regresión)", () => {
  const body = portfolioBody(baseState({ expenses: [legacyExpense] }));
  assert.equal(findInlineDataPaths(body).length, 1);
});

test("una referencia a un comprobante en Storage ocupa menos de 10 KB dentro de la cartera", () => {
  const withRef = portfolioBody(baseState({ expenses: [newExpense] }));
  const withRefBytes = estimatePayloadBytes(withRef);
  assert.ok(withRefBytes < 10_000, `payload con referencia: ${withRefBytes} bytes`);
});

test("la guardia de tamaño bloquea documentos sobre el límite de Firestore", () => {
  const big = "data:application/pdf;base64," + "A".repeat(PORTFOLIO_DOC_SAFE_BYTES);
  const body = portfolioBody(baseState({ expenses: [{ ...legacyExpense, receiptUrl: big }] }));
  assert.ok(estimatePayloadBytes(body) > PORTFOLIO_DOC_SAFE_BYTES);
  assert.ok(PORTFOLIO_DOC_SAFE_BYTES < 1_048_576, "margen por debajo de 1 MiB");
});

// --- Comprobaciones estáticas sobre el código ----------------------------
test("los formularios de adjuntos ya no convierten ficheros nuevos a Base64", () => {
  for (const rel of ["src/components/Expenses.tsx", "src/components/Properties.tsx"]) {
    const src = readFileSync(join(ROOT, rel), "utf-8");
    assert.equal(src.includes("readAsDataURL"), false, `${rel} todavía usa readAsDataURL`);
  }
});

test("App mantiene persistPortfolio como único punto de escritura de la cartera", () => {
  const app = readFileSync(join(ROOT, "src/App.tsx"), "utf-8");
  assert.ok(app.includes("const persistPortfolio"));
  assert.equal(app.split("setDoc(").length - 1, 1, "solo debe existir una llamada a setDoc");
  assert.ok(!/Sincronizado exitosamente|Sincronización instantánea completada/.test(app));
});
