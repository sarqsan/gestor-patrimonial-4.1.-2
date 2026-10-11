import test from "node:test";
import assert from "node:assert/strict";
import { persistAttachedExpense, persistAttachedProperty, AttachmentPersistencePort } from "./attachmentPersistence";
import { AttachmentError, ATTACHMENT_TIMEOUTS } from "./attachmentErrors";
import { TEST_PROPERTY } from "./attachmentTestFixtures";
import type { PropertyExpense } from "../types";

const movement: PropertyExpense = {
  id: "mov_ibi", propertyId: TEST_PROPERTY.id, category: "ibi", type: "gasto", amount: 12.34,
  date: "2026-10-11", description: "PRUEBA IBI", receiptVaultId: "file_ibi", receiptName: "ibi.pdf", receiptType: "application/pdf",
};
function setup() {
  const saved = new Map<string, Record<string, any>>();
  const verified: any[] = [];
  const propertyWrites: any[] = [];
  let firebaseWrites = 0;
  const port: AttachmentPersistencePort = {
    hasVaultSession: () => true, assertDurableVault: async () => {},
    verify: async (user, source) => { verified.push({ user, source }); },
    saveVaultMovement: async (_user, m) => { saved.set(m.id, { ...m }); return { ...m }; },
    saveFirebaseMovement: async (_user, m) => { firebaseWrites++; saved.set(m.id, { ...m }); return { ...m }; },
    saveVaultProperty: async (user, p, ids) => { propertyWrites.push({ user, p, ids }); return { ...p }; },
    saveFirebaseProperty: async (user, p) => { propertyWrites.push({ user, p }); return { ...p }; },
  };
  return { port, saved, verified, propertyWrites, firebaseWrites: () => firebaseWrites };
}

test("C1. Solo confirma cuando objeto, asociación y lectura persistida corresponden a cuenta/operación/inmueble", async () => {
  const { port, saved, verified } = setup();
  const input = structuredClone(movement);
  const confirmed = await persistAttachedExpense("cuenta_prueba", input, port);
  assert.equal(confirmed.status, "synced");
  assert.equal(saved.get(input.id)?.receiptVaultId, input.receiptVaultId);
  assert.deepEqual(verified[0], { user: "cuenta_prueba", source: { vaultId: input.receiptVaultId, storagePath: undefined, movementId: input.id, propertyId: input.propertyId } });
  assert.deepEqual(input, movement, "no se mutan los datos del formulario");
});

test("C2. Sin documento obligatorio remoto no hay escrituras ni éxito local", async () => {
  const { port, saved } = setup();
  await assert.rejects(() => persistAttachedExpense("cuenta_prueba", { ...movement, receiptVaultId: undefined, receiptUrl: "data:application/pdf;base64,QUJD" }, port), (e: any) => e.code === "attachment/required");
  assert.equal(saved.size, 0);
});

test("C3. Rechazo de autorización al verificar no persiste ni prueba otra identidad/proveedor", async () => {
  const { port, saved, firebaseWrites } = setup();
  const original = Object.assign(new Error("access denied"), { code: "storage/unauthorized" });
  port.verify = async () => { throw new AttachmentError("No autorizado", { phase: "verification", backend: "firebase", code: original.code, cause: original }); };
  await assert.rejects(() => persistAttachedExpense("cuenta_prueba", movement, port), (e: any) => e.phase === "verification" && e.code === original.code && e.cause === original);
  assert.equal(saved.size, 0);
  assert.equal(firebaseWrites(), 0);
});

test("C4. Un objeto no recuperable o con integridad fallida impide confirmar la operación", async () => {
  const { port, saved } = setup();
  port.verify = async () => { throw new AttachmentError("hash incorrecto", { phase: "verification", code: "attachment/integrity" }); };
  await assert.rejects(() => persistAttachedExpense("cuenta_prueba", movement, port), (e: any) => e.code === "attachment/integrity");
  assert.equal(saved.size, 0);
});

test("C5. Datos/ref distintos en lectura posterior no son éxito aunque el servidor responda 200", async () => {
  const { port } = setup();
  for (const changed of [{ receiptVaultId: "otro" }, { propertyId: "otro" }, { amount: 999 }, { receiptUrl: "data:invalido" }]) {
    port.saveVaultMovement = async (_user, m) => ({ ...m, ...changed });
    await assert.rejects(() => persistAttachedExpense("cuenta_prueba", movement, port), (e: any) => e.phase === "persistence" && e.code === "attachment/association-conflict");
  }
});

test("C6. Escritura denegada conserva código/causa; no marca synced ni modifica la entrada", async () => {
  const { port } = setup();
  const original = Object.assign(new Error("Firestore denied write"), { code: "permission-denied" });
  port.saveVaultMovement = async () => { throw original; };
  const input = { ...movement, status: "pending" as const };
  await assert.rejects(() => persistAttachedExpense("cuenta_prueba", input, port), (e: any) => e.phase === "persistence" && e.code === "permission-denied" && e.cause === original);
  assert.equal(input.status, "pending");
});

test("C7. Timeout de persistencia aborta HTTP y una respuesta tardía no confirma el movimiento", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { port } = setup();
  let ready!: () => void;
  const started = new Promise<void>((r) => { ready = r; });
  let resolve!: (v: any) => void;
  let signal!: AbortSignal;
  port.saveVaultMovement = async (_u, m, s) => { signal = s; ready(); return new Promise((r) => { resolve = r; }); };
  const rejection = assert.rejects(persistAttachedExpense("cuenta_prueba", movement, port), (e: any) => e.phase === "persistence" && e.code === "attachment/timeout");
  await started;
  t.mock.timers.tick(ATTACHMENT_TIMEOUTS.persistence);
  await rejection;
  assert.equal(signal.aborted, true);
  resolve(movement);
  await Promise.resolve();
});

test("C8. Respuesta de escritura perdida: reintentar conserva ID, documento y una sola operación", async () => {
  const { port, saved } = setup();
  const write = port.saveVaultMovement;
  let first = true;
  port.saveVaultMovement = async (...args) => { const value = await write(...args); if (first) { first = false; throw Object.assign(new Error("response lost"), { code: "vault/network-unavailable" }); } return value; };
  await assert.rejects(() => persistAttachedExpense("cuenta_prueba", movement, port));
  await persistAttachedExpense("cuenta_prueba", movement, port);
  assert.equal(saved.size, 1);
  assert.equal(saved.get(movement.id)?.receiptVaultId, movement.receiptVaultId);
});

test("C9. Documento de inmueble: solo escribe su entidad y conserva campos/referencias patrimoniales", async () => {
  const { port, propertyWrites, verified } = setup();
  const property = { ...TEST_PROPERTY, documents: [{ id: "doc_ibi", name: "ibi.pdf", size: "1 KB", type: "application/pdf", category: "ibi" as const, year: 2026, uploadDate: "2026-10-11", vaultId: "file_ibi" }] };
  await persistAttachedProperty("cuenta_prueba", property, [TEST_PROPERTY], [{ vaultId: "file_ibi" }], port);
  assert.deepEqual(propertyWrites, [{ user: "cuenta_prueba", p: property, ids: ["file_ibi"] }]);
  assert.equal(verified[0].source.propertyId, property.id);
  assert.equal(property.purchasePrice, TEST_PROPERTY.purchasePrice);
});

test("C10. No se guarda un documento no asociado al inmueble", async () => {
  const { port, propertyWrites } = setup();
  await assert.rejects(() => persistAttachedProperty("cuenta_prueba", TEST_PROPERTY, [TEST_PROPERTY], [{ vaultId: "file_ajeno" }], port), (e: any) => e.phase === "association");
  assert.equal(propertyWrites.length, 0);
});

test("C11. Compatibilidad Firebase: sin Vault, la referencia Storage y la operación se confirman en Firestore", async () => {
  const { port, firebaseWrites, verified } = setup();
  port.hasVaultSession = () => false;
  const input = { ...movement, receiptVaultId: undefined, receiptPath: "users/cuenta_prueba/attachments/expenses/r/ibi.pdf" };
  const confirmed = await persistAttachedExpense("cuenta_prueba", input, port);
  assert.equal(firebaseWrites(), 1);
  assert.equal(confirmed.receiptPath, input.receiptPath);
  assert.equal(verified[0].source.storagePath, input.receiptPath);
});

test("C12. Vault no duradero y sesión caducada no tienen contingencia local ni bypass Firebase", async () => {
  const { port, saved, firebaseWrites } = setup();
  port.assertDurableVault = async () => { throw new AttachmentError("destino no permanente", { code: "vault/not-durable", phase: "persistence", backend: "vault" }); };
  await assert.rejects(() => persistAttachedExpense("cuenta_prueba", movement, port), (e: any) => e.code === "vault/not-durable");
  assert.equal(saved.size, 0);
  assert.equal(firebaseWrites(), 0);
});
