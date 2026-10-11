// Pruebas de cableado: todas las rutas de entrada de archivos usan Storage y las reglas no se debilitan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { externalizeImportedExpenses, externalizeImportedProperties, AttachmentUploader, ImportAttachmentError } from "./importAttachments";
import { Property, PropertyExpense } from "../types";
import { deterministicBytes, toDataUrl } from "./migrationFakes";
import { attachmentStoragePath, sanitizeFileName } from "./attachmentRules";
import { sha256Hex } from "./stableHash";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

function fakeUploader(calls: Array<{ folder: string; attachmentId: string; fileName: string; contentType: string; bytes: Uint8Array }>): AttachmentUploader {
  return async (req) => {
    calls.push(req);
    return {
      storagePath: attachmentStoragePath("arquero", req.folder, req.attachmentId, req.fileName),
      name: req.fileName,
      contentType: req.contentType,
      size: req.bytes.length,
    };
  };
}

test("importación: un comprobante Base64 se sube a Storage y la operación guarda solo la referencia", async () => {
  const bytes = deterministicBytes(5000, 11);
  const exp: PropertyExpense = { id: "imp_1", propertyId: "p1", category: "ibi", type: "gasto", amount: 10, date: "2026-01-02", description: "IBI", receiptUrl: toDataUrl(bytes, "application/pdf"), receiptName: "ibi.pdf" };
  const calls: any[] = [];
  const out = await externalizeImportedExpenses([exp], fakeUploader(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].folder, "expenses");
  assert.equal(calls[0].contentType, "application/pdf");
  assert.ok(calls[0].bytes.every((b: number, i: number) => b === bytes[i]), "bytes idénticos");
  assert.equal(out[0].receiptUrl, undefined);
  assert.equal(out[0].receiptName, "ibi.pdf");
  assert.match(out[0].receiptPath!, /^users\/arquero\/attachments\/expenses\//);
  assert.equal(out[0].amount, 10, "datos estructurados conservados");
  assert.equal(out[0].description, "IBI");
});

test("importación: la identidad del archivo es su contenido (repetir la importación no duplica)", async () => {
  const bytes = deterministicBytes(2000, 5);
  const exp: PropertyExpense = { id: "a", propertyId: "p", category: "ibi", amount: 1, date: "2026-01-01", receiptUrl: toDataUrl(bytes, "image/png"), receiptName: "f.png" };
  const c1: any[] = [];
  const c2: any[] = [];
  const o1 = await externalizeImportedExpenses([exp], fakeUploader(c1));
  const o2 = await externalizeImportedExpenses([{ ...exp, id: "b" }], fakeUploader(c2));
  assert.equal(c1[0].attachmentId, c2[0].attachmentId);
  assert.equal(o1[0].receiptPath, o2[0].receiptPath);
  assert.equal(c1[0].attachmentId, `imp_${(await sha256Hex(bytes)).slice(0, 32)}`);
});

test("importación: documentos de inmuebles Base64 se externalizan con storagePath", async () => {
  const bytes = deterministicBytes(3000, 9);
  const prop: Property = {
    id: "p1", address: "Calle 1", cadastralReference: "", owner: "both", ownershipPercentageUser1: 50, ownershipPercentageUser2: 50,
    tenantName: "", tenantDni: "", monthlyRent: 0, purchasePrice: 0, landValuePercent: 30, amortizationAmount: 0,
    expensesCommunity: 0, expensesIBI: 0, expensesInsurance: 0, expensesRepairs: 0, registrationDate: "2025-01-01",
    documents: [{ id: "d1", name: "IBI.pdf", size: "3 KB", type: "application/pdf", category: "ibi", year: 2026, uploadDate: "x", fileData: toDataUrl(bytes, "application/pdf") }],
  };
  const calls: any[] = [];
  const out = await externalizeImportedProperties([prop], fakeUploader(calls));
  assert.equal(calls[0].folder, "property-documents");
  const d = out[0].documents![0];
  assert.equal(d.fileData, undefined);
  assert.match(d.storagePath!, /property-documents/);
  assert.equal(d.name, "IBI.pdf");
});

test("importación: Base64 corrupto o tipo no admitido cancela la importación con error claro", async () => {
  const bad: PropertyExpense = { id: "x", propertyId: "p", category: "ibi", amount: 1, date: "2026-01-01", receiptUrl: "data:application/pdf;base64,@@@" };
  await assert.rejects(externalizeImportedExpenses([bad], fakeUploader([])), ImportAttachmentError);
  const exe: PropertyExpense = { id: "y", propertyId: "p", category: "ibi", amount: 1, date: "2026-01-01", receiptUrl: toDataUrl(new Uint8Array([1, 2]), "application/x-msdownload"), receiptName: "virus.exe" };
  await assert.rejects(externalizeImportedExpenses([exe], fakeUploader([])), (e: Error) => e instanceof ImportAttachmentError && /no se puede guardar/.test(e.message));
});

test("importación: sin Base64 los registros pasan intactos (URLs externas o referencias)", async () => {
  const exp: PropertyExpense = { id: "z", propertyId: "p", category: "ibi", amount: 1, date: "2026-01-01", receiptPath: "users/u/attachments/expenses/a/b.pdf", receiptUrl: "https://example.com/f.pdf" };
  const calls: any[] = [];
  const out = await externalizeImportedExpenses([exp], fakeUploader(calls));
  assert.equal(calls.length, 0);
  assert.deepEqual(out[0], exp);
});

test("nombres de fichero seguros para rutas de Storage", () => {
  assert.equal(sanitizeFileName("../../x.pdf").includes(".."), false);
  assert.equal(sanitizeFileName("ibi 2026 (final).pdf"), "ibi_2026_final_.pdf");
});

test("cableado: todas las rutas de entrada de archivos usan Storage y no escriben Base64 en la cartera", () => {
  const expenses = read("src/components/Expenses.tsx");
  const properties = read("src/components/Properties.tsx");
  const dashboard = read("src/components/Dashboard.tsx");
  const contracts = read("src/components/ContractCreator.tsx");
  // Importaciones: externalización antes del callback
  assert.match(expenses, /externalizeImportedExpenses\(importPreviewData/);
  assert.match(properties, /externalizeImportedProperties\(importPreviewData/);
  // Ningún componente de cartera convierte ficheros a data URL para guardarlos
  for (const src of [expenses, properties, contracts]) {
    assert.doesNotMatch(src, /readAsDataURL/, "sin FileReader->Base64 en formularios de cartera");
  }
  // Alta por IA: la factura escaneada se guarda en Storage
  assert.match(dashboard, /uploadAttachment\(\{[\s\S]*?folder: "expenses"/);
  // Contratos generados: se guardan como archivo en Storage
  assert.match(contracts, /folder: "contracts"[\s\S]*?allowWordDocument: true/);
  assert.match(contracts, /pdfPath: stored\.storagePath/);
  // Descarga real del contrato (no simulada)
  assert.doesNotMatch(properties, /\(Simulado\)/);
});

test("cableado: App mantiene un único punto de escritura de la cartera con la guardia", () => {
  const app = read("src/App.tsx");
  assert.equal(app.split("setDoc(").length - 1, 1, "solo una llamada a setDoc en App.tsx");
  assert.match(app, /checkPortfolioWrite\(body/);
  assert.match(app, /allowedLegacyDataUrls: legacyBaselineRef\.current/);
});

test("cableado: el panel usa el diagnóstico en vivo y el flujo verificado (sin createBackup en el documento)", () => {
  const panel = read("src/components/MigrationPanel.tsx");
  assert.match(panel, /useMemo\(\(\) => buildInventory/);
  assert.match(panel, /runPortfolioAttachmentMigration/);
  assert.match(panel, /canStartMigration/);
  assert.doesNotMatch(panel, /createBackup/);
  const fbm = read("src/lib/firebaseMigration.ts");
  assert.doesNotMatch(fbm, /collection\(|"backups",\s*backupId[^)]*\)\s*,\s*\{\s*\.\.\.portfolio/);
  assert.match(fbm, /"backups"/);
});

test("reglas de Storage: copias solo crear/leer, sin borrado ni acceso público", () => {
  const rules = read("storage.rules");
  assert.doesNotMatch(rules, /allow read: if true/);
  assert.match(rules, /backups\/\{allPaths=\*\*\}[\s\S]*?allow update, delete: if false/);
  assert.match(rules, /contentType == 'application\/json'/);
  assert.match(rules, /request\.auth != null/);
});

test("reglas de Storage: adjuntos solo crear; nunca sobrescribir ni borrar", () => {
  const rules = read("storage.rules");
  const attachments = rules.match(/attachments\/\{allPaths=\*\*\}\s*\{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(attachments.length > 0, "bloque de adjuntos presente");
  assert.match(attachments, /allow create: if request\.auth != null/);
  assert.doesNotMatch(attachments, /allow create, update/);
  assert.doesNotMatch(attachments, /allow [^:]*update[^:]*:\s*if (?!false)/, "ningún allow de update con condición");
  assert.match(attachments, /allow update, delete: if false/);
  assert.match(attachments, /request\.resource\.size <= 10 \* 1024 \* 1024/);
});

test("importación reutiliza objetos idénticos: ninguna ruta de adjuntos depende de sobrescribir", () => {
  const attachments = read("src/lib/attachments.ts");
  assert.match(attachments, /storeStorageAttachment\(activeStoragePort/);
  assert.match(attachments, /getMetadata\(ref\(storage/);
  assert.doesNotMatch(attachments, /getStorageBytes/, "no usar descargas de bytes como sonda de existencia");
  const migration = read("src/lib/portfolioMigrationRun.ts");
  // La migración lee antes de subir y nunca sube sobre un objeto existente.
  assert.match(migration, /const existing = await storage\.readBytes\(item\.storagePath\)/);
  assert.match(migration, /if \(!bytesEqual\(existing, item\.bytes\)\)/);
  // La comprobación de tipo y tamaño se hace antes de crear la copia de seguridad.
  const precheck = migration.indexOf("storageRuleProblem(");
  const backup = migration.indexOf("// 3. Copia recuperable");
  assert.ok(precheck > 0 && backup > precheck, "precheck antes de la copia");
});
