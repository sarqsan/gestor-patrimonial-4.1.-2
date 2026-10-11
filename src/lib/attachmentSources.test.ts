// Pruebas de la resolución del origen de lectura de un adjunto (vault → Storage → legado).
// Regla de negocio: la interfaz debe poder recuperar CUALQUIER adjunto existente, sea cual
// sea el modo con el que se guardó, y no debe ofrecer descargas de adjuntos que no existen.
// Ejecutar con: npm test  (node:test + tsx; no requiere red ni Firebase)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AttachmentSource,
  contractPdfSource,
  documentSource,
  hasAttachmentSource,
  hasReceipt,
  receiptSource,
} from "./attachmentRules";

const DATA_URL = "data:application/pdf;base64,JVBERi0xLjQK";

test("el comprobante del vault tiene prioridad sobre Storage y sobre el legado", () => {
  assert.deepEqual(
    receiptSource({ receiptVaultId: "file_1", receiptPath: "users/u/expenses/a.pdf", receiptUrl: DATA_URL }),
    { vaultId: "file_1" }
  );
});

test("sin vault se lee la copia de Storage; sin remote, el archivo histórico incrustado", () => {
  assert.deepEqual(receiptSource({ receiptPath: "users/u/expenses/a.pdf", receiptUrl: DATA_URL }), {
    storagePath: "users/u/expenses/a.pdf",
  });
  assert.deepEqual(receiptSource({ receiptUrl: DATA_URL }), { inlineData: DATA_URL });
});

test("un comprobante del vault es un comprobante para la interfaz (icono/acciones)", () => {
  assert.equal(hasReceipt({ receiptVaultId: "file_1" }), true);
  assert.equal(hasReceipt({}), false);
});

test("una ruta suelta no se presenta como archivo incrustado descargable", () => {
  const source = receiptSource({ receiptUrl: "users/u/expenses/a.pdf" });
  assert.equal(source.inlineData, undefined);
  assert.equal(hasAttachmentSource(source), false);
});

test("los documentos de inmueble siguen la misma prioridad (vault → Storage → fileData)", () => {
  assert.deepEqual(documentSource({ vaultId: "file_2", storagePath: "users/u/d/a.pdf", fileData: DATA_URL }), {
    vaultId: "file_2",
  });
  assert.deepEqual(documentSource({ storagePath: "users/u/d/a.pdf", fileData: DATA_URL }), {
    storagePath: "users/u/d/a.pdf",
  });
  assert.deepEqual(documentSource({ fileData: DATA_URL }), { inlineData: DATA_URL });
  assert.equal(hasAttachmentSource(documentSource({})), false);
});

test("el PDF de un contrato se recupera desde el vault aunque no haya pdfPath", () => {
  assert.deepEqual(contractPdfSource({ pdfVaultId: "file_3" }), { vaultId: "file_3" });
  assert.deepEqual(contractPdfSource({ pdfPath: "users/u/contracts/c.doc" }), {
    storagePath: "users/u/contracts/c.doc",
  });
  assert.deepEqual(contractPdfSource({}), {});
  // Un contrato sin archivo (registro anterior o generado sin adjunto) no ofrece descarga.
  assert.equal(hasAttachmentSource(contractPdfSource({})), false);
});

test("adjunto nulo o indefinido no produce origen ni promete descarga", () => {
  const empty: AttachmentSource = receiptSource({});
  assert.equal(hasAttachmentSource(empty), false);
  assert.equal(hasAttachmentSource(receiptSource({ receiptUrl: "" })), false);
});
