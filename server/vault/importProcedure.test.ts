// FASE F — Procedimiento de importación de los datos descargados por el propietario.
//
// Se ejercitan las funciones REALES que usa la interfaz, contra el almacén remoto:
//  - recuperación de movimientos (`planRecoveryMerge` / `executeRecoveryMerge`),
//  - externalización de los adjuntos incrustados (data URL legado) hacia el almacén remoto,
//  - idempotencia: reimportar no duplica,
//  - informes de recuentos y de lo rechazado.
//
// Ejecutar con: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planRecoveryMerge, executeRecoveryMerge } from "../../src/lib/recoveryImport.js";
import { externalizeImportedExpenses, externalizeImportedProperties, ImportAttachmentError } from "../../src/lib/importAttachments.js";
import type { Property, PropertyDocument, PropertyExpense } from "../../src/types.js";

const dataUrl = (content: string, type = "application/pdf") =>
  `data:${type};base64,${Buffer.from(content).toString("base64")}`;

function gastoSintetico(id: string, propertyId: string, name: string, content: string): PropertyExpense {
  return {
    id,
    propertyId,
    category: "ibi",
    amount: 100,
    date: "2026-03-15",
    type: "gasto",
    receiptUrl: dataUrl(content),
    receiptName: name,
    receiptType: "application/pdf",
  };
}

test("F1. Los movimientos descargados se importan con sus identificadores y sin duplicar", () => {
  const descargados: PropertyExpense[] = [
    { id: "exp_001", propertyId: "prop_001", category: "ibi", amount: 320.5, date: "2026-03-15", type: "gasto" },
    { id: "exp_002", propertyId: "prop_001", category: "rent", amount: 900, date: "2026-06-01", type: "ingreso" },
    { id: "exp_003", propertyId: "prop_002", category: "community", amount: 65, date: "2026-06-05", type: "gasto" },
  ];

  // Plan previo: el usuario ve el recuento y el detalle antes de aplicar nada.
  const plan = planRecoveryMerge([], descargados);
  assert.equal(plan.totalBackupExpenses, 3, "se informa del recuento de movimientos del expediente descargado");
  assert.equal(plan.restoredCount, 3, "los tres movimientos ausentes quedan listos para recuperar");
  assert.equal(plan.ambiguousCount, 0, "sin ambigüedades en una importación limpia");
  assert.equal(plan.resultingTotalExpenses, 3, "el resultado previsto es el expediente completo");

  const { mergedExpenses } = executeRecoveryMerge([], descargados);
  assert.equal(mergedExpenses.length, 3);
  assert.deepEqual(mergedExpenses.map((m) => m.id).sort(), ["exp_001", "exp_002", "exp_003"], "se respetan los identificadores originales");
  assert.deepEqual(mergedExpenses.map((m) => m.propertyId), ["prop_001", "prop_001", "prop_002"], "se conservan las relaciones con los inmuebles");

  // Reimportación sobre lo ya importado: ni un registro nuevo.
  const plan2 = planRecoveryMerge(mergedExpenses, descargados);
  assert.equal(plan2.restoredCount, 0, "reimportar no recupera nada nuevo");
  assert.equal(plan2.skippedDuplicatesCount, 3, "los tres movimientos se reconocen como ya presentes");
  const segunda = executeRecoveryMerge(mergedExpenses, descargados).mergedExpenses;
  assert.equal(segunda.length, 3, "el recuento final no crece");
});

test("F2. Los conflictos se señalan y no se fusionan a ciegas", () => {
  const existente: PropertyExpense[] = [
    { id: "exp_001", propertyId: "prop_001", category: "ibi", amount: 999, date: "2026-03-15", type: "gasto" },
  ];
  const descargados: PropertyExpense[] = [
    { id: "exp_001", propertyId: "prop_001", category: "ibi", amount: 320.5, date: "2026-03-15", type: "gasto" },
  ];
  const plan = planRecoveryMerge(existente, descargados);
  const conflicto = plan.items.find((i) => i.id === "exp_001" && i.source === "backup");
  assert.ok(conflicto, "el movimiento con el mismo id y datos distintos se lista");
  assert.equal(conflicto!.action, "ambiguous-review", "se marca para revisión del usuario, no se fusiona solo");
  assert.ok(String(conflicto!.ambiguityReason ?? "").length > 0, "el motivo se explica al usuario");
  assert.equal(plan.ambiguousCount, 1, "el recuento de conflictos se comunica");
  // Y el movimiento actual no se sobrescribe.
  const { mergedExpenses } = executeRecoveryMerge(existente, descargados);
  assert.equal(mergedExpenses.length, 1);
  assert.equal(mergedExpenses[0].amount, 999, "un conflicto no pisa el dato existente sin decisión del usuario");
});

test("F3. Los adjuntos incrustados se externalizan al almacén remoto y quedan enlazados", async () => {
  const subidos: Array<{ id: string; name: string; sha: string }> = [];
  // Cargador equivalente al de la interfaz: en producción escribe en el almacén remoto.
  const uploader = async (req: { attachmentId: string; fileName: string; bytes: Uint8Array }) => {
    const sha = createHash("sha256").update(req.bytes).digest("hex");
    const yaEstaba = subidos.find((s) => s.sha === sha);
    if (!yaEstaba) subidos.push({ id: `file_${subidos.length + 1}`, name: req.fileName, sha });
    const ref = yaEstaba ?? subidos[subidos.length - 1];
    return { storagePath: `vault/${ref.id}`, name: req.fileName, contentType: "application/pdf", size: req.bytes.length };
  };

  const movimientos = [
    gastoSintetico("exp_001", "prop_001", "ibi_2026.pdf", "recibo IBI sintético 2026"),
    gastoSintetico("exp_002", "prop_002", "comunidad_2026.pdf", "recibo comunidad sintético"),
  ];
  const importados = await externalizeImportedExpenses(movimientos, uploader);

  assert.equal(importados.length, 2, "no se pierde ningún movimiento en la importación");
  assert.ok(importados.every((m) => !m.receiptUrl), "el data URL legado se sustituye por la referencia remota");
  assert.ok(importados.every((m) => m.propertyId && m.receiptName), "se conservan la relación con el inmueble y el nombre del documento");
  assert.equal(subidos.length, 2, "cada documento se sube una vez al almacén remoto");
  assert.notEqual(importados[0].receiptUrl, movimientos[0].receiptUrl, "el contenido ya no vive incrustado en el navegador");

  // Reimportación del mismo expediente: los mismos hashes no vuelven a subirse ni se duplican.
  const segunda = await externalizeImportedExpenses(movimientos, uploader);
  assert.equal(subidos.length, 2, "reimportar no duplica documentos en el almacén remoto");
  assert.equal(segunda.length, 2);
});

test("F4. Un adjunto ilegible se rechaza con su motivo y no se importa a medias", async () => {
  const uploader = async () => ({ storagePath: "vault/file_1", name: "x.pdf", contentType: "application/pdf", size: 1 });
  const roto: PropertyExpense[] = [
    { id: "exp_roto", propertyId: "prop_001", category: "ibi", amount: 10, date: "2026-03-15", type: "gasto", receiptUrl: "data:application/pdf;base64,%%%no-es-base64%%%" },
  ];
  await assert.rejects(
    () => externalizeImportedExpenses(roto, uploader),
    (err: any) => {
      assert.ok(err instanceof ImportAttachmentError, "el rechazo se comunica como error de importación");
      assert.match(err.message, /exp_roto/, "el mensaje identifica el registro problemático");
      return true;
    }
  );
});

test("F5. Los documentos de inmueble también se externalizan y conservan su categoría y año", async () => {
  const uploader = async (req: { fileName: string; bytes: Uint8Array }) => ({
    storagePath: `vault/file_${createHash("sha256").update(req.bytes).digest("hex").slice(0, 8)}`,
    name: req.fileName,
    contentType: "application/pdf",
    size: req.bytes.length,
  });
  const documentos: PropertyDocument[] = [
    {
      id: "doc_ibi_2026",
      name: "ibi_2026.pdf",
      category: "ibi",
      year: 2026,
      uploadDate: "2026-03-02",
      fileData: dataUrl("escritura sintética del IBI"),
      contentType: "application/pdf",
      size: "1 KB",
      type: "application/pdf",
    },
  ];
  const propiedades: Property[] = [{ id: "prop_001", address: "Calle Mayor 1", documents: documentos } as unknown as Property];

  const [importada] = await externalizeImportedProperties(propiedades, uploader);
  assert.equal(importada.id, "prop_001", "el inmueble conserva su identificador");
  assert.equal(importada.documents.length, 1);
  assert.equal(importada.documents[0].category, "ibi", "la categoría documental se conserva");
  assert.equal(importada.documents[0].year, 2026, "el ejercicio se conserva");
  assert.ok(!importada.documents[0].fileData, "el documento deja de viajar incrustado en la cartera");
});
