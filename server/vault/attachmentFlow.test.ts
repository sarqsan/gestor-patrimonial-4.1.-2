// HTTP real + cliente de producción + adaptador Blob, con proveedor SIMULADO en memoria.
// Demuestra el flujo controlado, NO una subida a Firebase/Vercel Blob reales.
import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApiApp } from "../apiApp.js";
import { BlobVaultPersistence } from "./persistence.js";
import { MemoryBlobPort } from "./memoryBlobPort.js";
import { uploadAttachment, getAttachmentBlob, expenseReceiptFieldsFromStored } from "../../src/lib/attachments.js";
import { persistAttachedExpense, persistAttachedProperty } from "../../src/lib/attachmentPersistence.js";
import { vaultEnsureSession, vaultGetMovements, vaultListFiles, vaultUploadFileDirect, vaultPutMovements, DIRECT_UPLOAD_THRESHOLD_BYTES, __resetVaultCapabilitiesCacheForTests, getVaultToken } from "../../src/lib/vaultClient.js";
import { __setSignInDriverForTests } from "../../src/lib/firebase.js";
import { syntheticIbiPdf, PNG_BYTES, JPG_BYTES, installTestLocalStorage, sha256, TEST_PROPERTY } from "../../src/lib/attachmentTestFixtures.js";
import { AttachmentWriteCoordinator } from "../../src/lib/attachmentWriteCoordinator.js";
import type { PropertyExpense } from "../../src/types.js";

const nativeFetch = globalThis.fetch;
const password = "soloPruebas_123";
const account = "cuenta_pruebas_ibi";
let port: MemoryBlobPort;
let server: Server;
let base: string;
let store: Map<string, string>;
let firebaseCalls = 0;
let directPuts = 0;

async function startServer() {
  const app = createApiApp({ vaultPersistence: new BlobVaultPersistence(port) });
  server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
}
async function stopServer() { if (server?.listening) await new Promise<void>((r) => server.close(() => r())); }

const transport: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("/api/")) return nativeFetch(base + url, init);
  if (url.startsWith("https://blob.invalid/")) {
    directPuts++;
    const pathname = new URL(url).pathname.slice(1);
    await port.directPut(pathname, new Uint8Array(await (init?.body as Blob).arrayBuffer()), new Headers(init?.headers).get("content-type")!);
    return new Response(null, { status: 200 });
  }
  throw new Error(`La prueba bloquea todo proveedor externo: ${url.split("?")[0]}`);
};

test.beforeEach(async () => {
  port = new MemoryBlobPort();
  store = installTestLocalStorage();
  firebaseCalls = 0; directPuts = 0;
  __resetVaultCapabilitiesCacheForTests();
  __setSignInDriverForTests(async () => { firebaseCalls++; throw Object.assign(new Error("ADMIN_ONLY_OPERATION simulado"), { code: "auth/admin-restricted-operation" }); });
  await startServer();
  globalThis.fetch = transport;
  await vaultEnsureSession(account, password);
  // Padre remoto sintético real: coincidir propertyId no basta para confirmar asociación.
  const seeded = await transport("/api/vault?op=entities.put", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${getVaultToken(account)}` },
    body: JSON.stringify({ type: "properties", id: TEST_PROPERTY.id, entity: TEST_PROPERTY }),
  });
  assert.equal(seeded.status, 201);
});
test.afterEach(async () => {
  globalThis.fetch = nativeFetch;
  __setSignInDriverForTests(null);
  __resetVaultCapabilitiesCacheForTests();
  delete (globalThis as any).localStorage;
  await stopServer();
});

function operation(id: string, receipt: Partial<PropertyExpense>): PropertyExpense {
  return { id, propertyId: TEST_PROPERTY.id, category: "ibi", type: "gasto", amount: 12.34,
    date: "2026-10-11", description: "PRUEBA SIN VALIDEZ FISCAL", ...receipt };
}
const uploadOpts = (id: string, bytes = syntheticIbiPdf(), type = "application/pdf", name = "ibi-prueba.pdf") => ({
  userId: account, folder: "expenses" as const, file: new File([bytes], name, { type }), movementId: id, propertyId: TEST_PROPERTY.id,
});

async function graphAndDownload(id: string, vaultId: string, bytes: Uint8Array) {
  const movements = await vaultGetMovements(account);
  const movement = movements.find((m) => m.id === id)!;
  assert.equal(movement.propertyId, TEST_PROPERTY.id);
  assert.equal(movement.receiptVaultId, vaultId);
  const meta = (await vaultListFiles(account)).find((f) => f.id === vaultId)!;
  assert.equal(meta.movementId, id);
  assert.equal(meta.propertyId, TEST_PROPERTY.id);
  assert.equal(meta.sha256, sha256(bytes));
  const recovered = await getAttachmentBlob({ vaultUsername: account, vaultId });
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), bytes);
}

test("E1. PDF IBI completo: subir → verificar → asociar → guardar → recuperar tras nuevo backend y navegador limpio", async () => {
  const opts = uploadOpts("mov_ibi_pdf");
  const bytes = new Uint8Array(await opts.file.arrayBuffer());
  const stored = await uploadAttachment(opts);
  assert.equal(stored.mode, "vault");
  await persistAttachedExpense(account, operation(opts.movementId, expenseReceiptFieldsFromStored(stored)));
  await graphAndDownload(opts.movementId, stored.vaultId!, bytes);
  assert.equal(firebaseCalls, 0, "el Vault conserva compatibilidad sin depender de Anonymous");
  assert.ok([...store.keys()].every((k) => k.includes("token") || k.includes("active_user")), "el navegador no guarda bytes ni operaciones como prueba de persistencia");
  await stopServer();
  await startServer(); // otra instancia real de API/persistencia, mismo proveedor simulado
  store.clear(); // no caché de cartera, ni token, ni archivo en el navegador
  await vaultEnsureSession(account, password);
  await graphAndDownload(opts.movementId, stored.vaultId!, bytes);
});

test("E2. PNG admitido: persistencia y recuperación byte a byte con operación/inmueble correctos", async () => {
  const opts = uploadOpts("mov_ibi_png", PNG_BYTES, "image/png", "ibi-prueba.png");
  const stored = await uploadAttachment(opts);
  await persistAttachedExpense(account, operation(opts.movementId, expenseReceiptFieldsFromStored(stored)));
  await graphAndDownload(opts.movementId, stored.vaultId!, PNG_BYTES);
});

test("E3. Documento patrimonial: misma entidad de inmueble, mismo ID, sin cambios financieros ni registros ajenos", async () => {
  const stored = await uploadAttachment({ userId: account, folder: "property-documents", propertyId: TEST_PROPERTY.id,
    file: new File([syntheticIbiPdf()], "ibi-inmueble.pdf", { type: "application/pdf" }) });
  const property = { ...TEST_PROPERTY, documents: [{ id: "doc_ibi", name: stored.name, type: stored.contentType, size: `${stored.size} B`,
    category: "ibi" as const, year: 2026, uploadDate: "2026-10-11", vaultId: stored.vaultId }] };
  const untouched = { ...TEST_PROPERTY, id: "prop_ajeno", address: "OTRO INMUEBLE SINTETICO", monthlyRent: 25 };
  await transport("/api/vault?op=entities.put", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${getVaultToken(account)}` },
    body: JSON.stringify({ type: "properties", id: untouched.id, entity: untouched }) });
  await persistAttachedProperty(account, property, [TEST_PROPERTY, untouched], [{ vaultId: stored.vaultId }]);
  await persistAttachedProperty(account, property, [TEST_PROPERTY], [{ vaultId: stored.vaultId }]);
  const response = await transport("/api/vault?op=entities.list&type=properties", { headers: { authorization: `Bearer ${getVaultToken(account)}` } });
  const entities = (await response.json()).entities;
  assert.equal(entities.length, 2);
  assert.deepEqual(entities.find((e: any) => e.id === property.id).data, property);
  assert.deepEqual(entities.find((e: any) => e.id === untouched.id).data, untouched, "el inmueble ajeno no se escribe ni se borra");
  assert.equal(entities.find((e: any) => e.id === property.id).data.documents.length, 1);
  assert.deepEqual(new Uint8Array(await (await getAttachmentBlob({ vaultUsername: account, vaultId: stored.vaultId })).arrayBuffer()), syntheticIbiPdf());
});

test("E4. Falta de autorización y acceso cruzado se rechazan; no se escriben movimientos", async () => {
  const stored = await uploadAttachment(uploadOpts("mov_privado"));
  const url = `/api/vault?op=files.verify&id=${stored.vaultId}`;
  assert.equal((await transport(url)).status, 401);
  assert.equal((await transport(url, { headers: { authorization: "Bearer manipulado" } })).status, 401);
  const other = "otra_cuenta_pruebas";
  await vaultEnsureSession(other, password);
  assert.equal((await transport(url, { headers: { authorization: `Bearer ${getVaultToken(other)}` } })).status, 404);
  const wrong = { ...operation("mov_privado", expenseReceiptFieldsFromStored(stored)), propertyId: "otro_inmueble" };
  await assert.rejects(() => persistAttachedExpense(account, wrong), (e: any) => e.code === "attachment/association-conflict");
  assert.equal((await vaultGetMovements(account)).length, 0);
  const absent = operation("mov_inexistente", { receiptVaultId: "file_inexistente" });
  const response = await transport(`/api/vault?op=movimientos.save&id=${absent.id}`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${getVaultToken(account)}` }, body: JSON.stringify({ movement: absent }),
  });
  assert.equal(response.status, 409);
  assert.equal((await vaultGetMovements(account)).length, 0);
});

test("E5. Respuesta de upload JSON perdida: reintentar reutiliza objeto y asociación, sin duplicados", async () => {
  const opts = uploadOpts("mov_retry_json");
  let lose = true;
  globalThis.fetch = async (input, init) => {
    const res = await transport(input, init);
    if (String(input) === "/api/vault?op=files.upload" && res.ok && lose) { lose = false; throw new TypeError("respuesta perdida simulada"); }
    return res;
  };
  await assert.rejects(() => uploadAttachment(opts), (e: any) => e.phase === "upload" && e.code === "vault/network-unavailable");
  const firstIds = (await vaultListFiles(account)).map((f) => f.id);
  const stored = await uploadAttachment(opts);
  assert.deepEqual((await vaultListFiles(account)).map((f) => f.id), firstIds);
  const movement = operation(opts.movementId, expenseReceiptFieldsFromStored(stored));
  await persistAttachedExpense(account, movement);
  await persistAttachedExpense(account, movement);
  assert.equal((await vaultGetMovements(account)).length, 1);
  assert.equal((await port.list(`vault/users/${account}/contents/`)).length, 1);
  await graphAndDownload(opts.movementId, stored.vaultId!, syntheticIbiPdf());
});

test("E6. Commit directo perdido: misma reserva, sin otro PUT ni documentos/operaciones duplicados", async () => {
  const bytes = syntheticIbiPdf();
  const opts = { username: account, file: new File([bytes], "ibi-directo.pdf", { type: "application/pdf" }), name: "ibi-directo.pdf",
    contentType: "application/pdf", movementId: "mov_directo", propertyId: TEST_PROPERTY.id };
  let lose = true;
  globalThis.fetch = async (input, init) => {
    const res = await transport(input, init);
    if (String(input).startsWith("/api/vault?op=files.commit") && res.ok && lose) { lose = false; throw new TypeError("commit response lost"); }
    return res;
  };
  await assert.rejects(() => vaultUploadFileDirect(opts), (e: any) => e.phase === "verification" && e.code === "vault/network-unavailable");
  const stored = await vaultUploadFileDirect(opts);
  assert.equal(directPuts, 1);
  assert.equal((await vaultListFiles(account)).length, 1);
  await persistAttachedExpense(account, operation(opts.movementId, { receiptVaultId: stored.id, receiptName: stored.name, receiptType: stored.contentType }));
  await graphAndDownload(opts.movementId, stored.id, bytes);
});

test("E7. Subida directa incompleta y hash incorrecto: no éxito y ninguna eliminación", async () => {
  const bytes = syntheticIbiPdf();
  const body = { id: "file_incompleto", name: "ibi.pdf", contentType: "application/pdf", size: bytes.length, sha256: sha256(bytes), propertyId: TEST_PROPERTY.id };
  const headers = { "content-type": "application/json", authorization: `Bearer ${getVaultToken(account)}` };
  await transport("/api/vault?op=files.presign", { method: "POST", headers, body: JSON.stringify(body) });
  const commitUrl = "/api/vault?op=files.commit&id=file_incompleto";
  const init = { method: "POST", headers, body: JSON.stringify({ size: bytes.length, sha256: sha256(bytes) }) };
  assert.equal((await transport(commitUrl, init)).status, 409);
  await port.directPut(`vault/users/${account}/contents/file_incompleto`, bytes, "application/pdf");
  assert.equal((await transport(commitUrl, { ...init, body: JSON.stringify({ size: bytes.length, sha256: "0".repeat(64) }) })).status, 400);
  assert.ok(await port.head(`vault/users/${account}/contents/file_incompleto`));
  assert.equal((await transport("/api/vault?op=files.get&id=file_incompleto", { headers })).status, 404);
  assert.equal((await transport(commitUrl, init)).status, 200);
  assert.equal((await transport(commitUrl, { ...init, body: JSON.stringify({ size: bytes.length, sha256: "0".repeat(64) }) })).status, 400,
    "un commit ya confirmado no acepta después el hash de otro archivo");
});

test("E8. Objeto alterado no se reutiliza, no se asocia ni se descarga como válido", async () => {
  const opts = uploadOpts("mov_integridad");
  const stored = await uploadAttachment(opts);
  await port.putBytes(`vault/users/${account}/contents/${stored.vaultId}`, PNG_BYTES, "application/pdf"); // corrupción simulada del proveedor
  await assert.rejects(() => uploadAttachment(opts), (e: any) => e.code === "vault/http-400" || e.code === "vault/http-503");
  await assert.rejects(() => persistAttachedExpense(account, operation(opts.movementId, expenseReceiptFieldsFromStored(stored))));
  await assert.rejects(() => getAttachmentBlob({ vaultUsername: account, vaultId: stored.vaultId }));
  assert.equal((await vaultGetMovements(account)).length, 0);
  assert.ok(await port.head(`vault/users/${account}/contents/${stored.vaultId}`));
});


test("E9. Snapshot antiguo en segundo plano no borra una asociación confirmada (HTTP real)", async () => {
  const queue = new AttachmentWriteCoordinator();
  const opts = uploadOpts("mov_snapshot");
  const stored = await uploadAttachment(opts);
  const oldEpoch = queue.capture(account);
  const pending = queue.attachment(account, () => persistAttachedExpense(account, operation(opts.movementId, expenseReceiptFieldsFromStored(stored))));
  let bulkWrites = 0;
  const staleSnapshot = queue.snapshot(account, oldEpoch, async () => { bulkWrites++; await vaultPutMovements(account, []); });
  await pending;
  assert.equal(await staleSnapshot, false);
  assert.equal(bulkWrites, 0);
  await graphAndDownload(opts.movementId, stored.vaultId!, syntheticIbiPdf());
});

test("E10. JPEG válido admitido: asociación y descarga intacta", async () => {
  const opts = uploadOpts("mov_ibi_jpg", JPG_BYTES, "image/jpeg", "ibi-prueba.jpg");
  const stored = await uploadAttachment(opts);
  await persistAttachedExpense(account, operation(opts.movementId, expenseReceiptFieldsFromStored(stored)));
  await graphAndDownload(opts.movementId, stored.vaultId!, JPG_BYTES);
});

test("E11. PDF válido mayor que el umbral JSON usa transporte directo y se recupera completo", async () => {
  const bytes = syntheticIbiPdf(DIRECT_UPLOAD_THRESHOLD_BYTES + 1);
  const opts = uploadOpts("mov_pdf_grande", bytes);
  const stored = await uploadAttachment(opts);
  assert.equal(directPuts, 1);
  await persistAttachedExpense(account, operation(opts.movementId, expenseReceiptFieldsFromStored(stored)));
  await graphAndDownload(opts.movementId, stored.vaultId!, bytes);
});

test("E12. Respuesta de persistencia perdida: no falso éxito y mismo movimiento/documento al reintentar", async () => {
  const opts = uploadOpts("mov_retry_persistencia");
  const stored = await uploadAttachment(opts);
  const movement = operation(opts.movementId, expenseReceiptFieldsFromStored(stored));
  let lose = true;
  globalThis.fetch = async (input, init) => {
    const response = await transport(input, init);
    if (String(input).startsWith("/api/vault?op=movimientos.save") && response.ok && lose) { lose = false; throw new TypeError("respuesta de escritura perdida"); }
    return response;
  };
  await assert.rejects(() => persistAttachedExpense(account, movement), (e: any) => e.phase === "persistence" && e.code === "vault/network-unavailable");
  assert.equal(movement.status, undefined, "el input no se transforma en un éxito local");
  await persistAttachedExpense(account, movement);
  assert.equal((await vaultGetMovements(account)).length, 1);
  assert.equal((await vaultListFiles(account)).length, 1);
  await graphAndDownload(opts.movementId, stored.vaultId!, syntheticIbiPdf());
});


test("E13. Reintento de cliente histórico sin propertyId conserva la asociación; ID ajeno explícito se rechaza", async () => {
  const opts = uploadOpts("mov_compatible");
  const stored = await uploadAttachment(opts);
  const headers = { "content-type": "application/json", authorization: `Bearer ${getVaultToken(account)}` };
  const body = { id: stored.vaultId, name: stored.name, contentType: stored.contentType,
    bytesBase64: Buffer.from(syntheticIbiPdf()).toString("base64"), movementId: opts.movementId };
  const retry = await transport("/api/vault?op=files.upload", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).file.propertyId, opts.propertyId);
  const conflicting = await transport("/api/vault?op=files.upload", { method: "POST", headers, body: JSON.stringify({ ...body, propertyId: "otro_inmueble" }) });
  assert.equal(conflicting.status, 400);
  assert.equal((await vaultListFiles(account)).length, 1);
  await persistAttachedExpense(account, operation(opts.movementId, expenseReceiptFieldsFromStored(stored)));
  await graphAndDownload(opts.movementId, stored.vaultId!, syntheticIbiPdf());
});
