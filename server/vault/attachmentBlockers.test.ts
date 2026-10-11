// Invariantes de seguridad/consistencia: HTTP local, proveedor SIMULADO, nunca servicios reales.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createApiApp } from "../apiApp.js";
import { BlobVaultPersistence } from "./persistence.js";
import { MemoryBlobPort } from "./memoryBlobPort.js";
import { TEST_PROPERTY, syntheticIbiPdf, PNG_BYTES } from "../../src/lib/attachmentTestFixtures.js";

const bytes = syntheticIbiPdf();
const owner = "test_blockers_owner", other = "test_blockers_other";
let port: MemoryBlobPort, persistence: BlobVaultPersistence, server: Server, base: string;
let credential: string, otherCredential: string;
async function call(op: string, method = "GET", body?: unknown, bearer = credential, id?: string, extraHeaders: Record<string, string> = {}) {
  const [operation, ...extra] = op.split("&");
  const q = new URLSearchParams({ op: operation });
  for (const [k, v] of new URLSearchParams(extra.join("&"))) q.set(k, v);
  if (id) q.set("id", id);
  const res = await fetch(`${base}/api/vault?${q}`, { method,
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (res.headers.get("content-type") ?? "").includes("application/json") ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
}
async function login(username: string, password: string) {
  const r = await call("auth.login", "POST", { username, password }, "");
  assert.equal(r.status, 200); return r.data.token as string;
}
async function register(username: string) {
  const password = randomBytes(24).toString("hex");
  assert.equal((await call("auth.register", "POST", { username, password }, "")).status, 201);
  return { password, bearer: await login(username, password) };
}
async function start() {
  const app = createApiApp({ vaultPersistence: persistence });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function stop() { if (server?.listening) await new Promise<void>((r) => server.close(() => r())); }
test.beforeEach(async () => {
  port = new MemoryBlobPort(); persistence = new BlobVaultPersistence(port); await start();
  credential = (await register(owner)).bearer; otherCredential = (await register(other)).bearer;
  assert.equal((await call("entities.put", "POST", { type: "properties", id: TEST_PROPERTY.id, entity: TEST_PROPERTY })).status, 201);
});
test.afterEach(stop);
async function upload(id?: string, movementId = "m_good", propertyId = TEST_PROPERTY.id, bearer = credential, content = bytes) {
  return call("files.upload", "POST", { ...(id ? { id } : {}), name: "IBI_FICTICIO.pdf", contentType: "application/pdf",
    bytesBase64: Buffer.from(content).toString("base64"), movementId, propertyId }, bearer);
}
const movement = (id: string, receipt: Record<string, unknown>): Record<string, any> => ({ id, propertyId: TEST_PROPERTY.id, category: "ibi", type: "gasto", amount: 1,
  date: "2026-10-11", description: "PRUEBA SIN VALIDEZ FISCAL", ...receipt });
async function linked() {
  assert.equal((await upload("file_good")).status, 201);
  const m = movement("m_good", { receiptVaultId: "file_good" });
  assert.equal((await call("movimientos.save", "PUT", { movement: m }, credential, m.id)).status, 200);
  return m;
}
const attachedProperty = (file = "file_good") => ({ ...TEST_PROPERTY, documents: [{ id: "doc_good", name: "FICTICIO.pdf", type: "application/pdf",
  size: "1 KB", category: "ibi", year: 2026, uploadDate: "2026-10-11", vaultId: file }] });

test("B01 (L06). Referencia Storage inexistente se rechaza sin confirmar gasto", async () => {
  const m = movement("m_missing", { receiptPath: `users/${owner}/attachments/expenses/missing/a.pdf` });
  const r = await call("movimientos.save", "PUT", { movement: m }, credential, m.id);
  assert.ok(r.status >= 400); assert.equal((await call("movimientos")).data.movements.length, 0);
});
test("B02 (L06). Referencia Storage de otra cuenta no se autoriza por datos del cliente", async () => {
  const m = movement("m_foreign", { receiptPath: `users/${other}/attachments/expenses/foreign/a.pdf` });
  assert.ok((await call("movimientos.save", "PUT", { movement: m }, credential, m.id)).status >= 400);
  assert.equal((await call("movimientos")).data.movements.length, 0);
});
test("B03 (L07). Documento válido no permite asociar un gasto a inmueble remoto inexistente", async () => {
  assert.equal((await upload("file_orphan", "m_orphan", "prop_missing")).status, 201);
  const m: Record<string, any> = { ...movement("m_orphan", { receiptVaultId: "file_orphan" }), propertyId: "prop_missing" };
  assert.ok((await call("movimientos.save", "PUT", { movement: m }, credential, m.id)).status >= 400);
  assert.equal((await call("movimientos")).data.movements.length, 0);
});
test("B04 (L07). Inmueble existente solo en otra cuenta no sirve como padre autorizado", async () => {
  await call("entities.put", "POST", { type: "properties", id: "prop_only_other", entity: { ...TEST_PROPERTY, id: "prop_only_other" } }, otherCredential);
  await upload("file_cross_parent", "m_cross_parent", "prop_only_other");
  const m: Record<string, any> = { ...movement("m_cross_parent", { receiptVaultId: "file_cross_parent" }), propertyId: "prop_only_other" };
  assert.ok((await call("movimientos.save", "PUT", { movement: m }, credential, m.id)).status >= 400);
});
test("B05 (L09). Omisión de attachmentIds no evita verificar el documento privado", async () => {
  await upload("file_only_other", "", TEST_PROPERTY.id, otherCredential);
  const r = await call("entities.put", "POST", { type: "properties", id: TEST_PROPERTY.id, entity: attachedProperty("file_only_other") });
  assert.ok(r.status >= 400);
});
test("B06 (L09). attachmentIds vacío tampoco evita comprobar TODOS los documentos", async () => {
  const r = await call("entities.put", "POST", { type: "properties", id: TEST_PROPERTY.id, entity: attachedProperty("file_missing"), attachmentIds: [] });
  assert.ok(r.status >= 400);
});
test("B07 (L08). Snapshot legacy del mismo gasto no retira una referencia confirmada", async () => {
  const confirmed = await linked();
  const r = await call("movimientos", "PUT", { movements: [movement(confirmed.id, {})] });
  assert.ok(r.status >= 400);
  assert.equal((await call("movimientos")).data.movements.find((m: any) => m.id === confirmed.id).receiptVaultId, confirmed.receiptVaultId);
});
test("B08 (L10). Snapshot viejo de inmueble se rechaza conservando documento y datos", async () => {
  await upload("file_good");
  assert.equal((await call("entities.put", "POST", { type: "properties", id: TEST_PROPERTY.id, entity: attachedProperty(), attachmentIds: ["file_good"] })).status, 201);
  assert.ok((await call("entities.put", "POST", { type: "properties", id: TEST_PROPERTY.id, entity: TEST_PROPERTY })).status >= 400);
  const p = (await call("entities.list&type=properties")).data.entities.find((e: any) => e.id === TEST_PROPERTY.id).data;
  assert.equal(p.documents[0].vaultId, "file_good"); assert.equal(p.purchasePrice, TEST_PROPERTY.purchasePrice);
});
test("B09 (L11). Logout revoca la credencial conservada; otra sesión/cuenta sigue válida", async () => {
  await upload("file_good");
  const second = await register("test_session_independent");
  const res = await call("auth.logout", "POST"); assert.ok(res.status === 200 || res.status === 204);
  assert.equal((await call("files.get", "GET", undefined, credential, "file_good")).status, 401);
  assert.equal((await call("session", "GET", undefined, second.bearer)).status, 200);
  assert.equal((await call("session", "GET", undefined, otherCredential)).status, 200);
  await stop(); persistence = new BlobVaultPersistence(port); await start();
  assert.equal((await call("files.get", "GET", undefined, credential, "file_good")).status, 401, "revocación conservada al cambiar instancia");
});
test("B10 (L11). Otro usuario no puede revocar una credencial ajena desde el body", async () => {
  const res = await call("auth.logout", "POST", { token: otherCredential }); assert.ok(res.status === 200 || res.status === 204);
  assert.equal((await call("session", "GET", undefined, otherCredential)).status, 200);
});
test("B11 (L13). ZIP rechaza bytes alterados, sin modificar ni borrar el original", async () => {
  await linked();
  await port.putBytes(persistence.contentPathFor(owner, "file_good"), PNG_BYTES, "application/pdf");
  assert.ok((await call("files.get", "GET", undefined, credential, "file_good")).status >= 400);
  assert.ok((await call("expediente.zip")).status >= 400);
  assert.deepEqual((await port.getBytes(persistence.contentPathFor(owner, "file_good")))!.bytes, PNG_BYTES);
});
test("B12 (L13). ZIP no incluye una reserva de upload aún no confirmada", async () => {
  const res = await call("files.presign", "POST", { id: "file_pending", name: "FICTICIO.pdf", contentType: "application/pdf", size: bytes.length, propertyId: TEST_PROPERTY.id });
  assert.equal(res.status, 201); await port.directPut(persistence.contentPathFor(owner, "file_pending"), bytes, "application/pdf");
  assert.ok((await call("expediente.zip")).status >= 400);
});
test("B13 (L14). Reintentos legacy sin ID reutilizan contenido/contexto y una operación", async () => {
  const a = await upload(undefined, "m_legacy"), b = await upload(undefined, "m_legacy");
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.data.file.id, b.data.file.id);
  assert.equal((await call("files.list")).data.files.length, 1);
});
test("B14 (L14). Legacy concurrente en dos instancias no duplica ni sustituye objeto", async () => {
  const app2 = createApiApp({ vaultPersistence: new BlobVaultPersistence(port) });
  const server2 = await new Promise<Server>((resolve) => { const x = app2.listen(0, "127.0.0.1", () => resolve(x)); });
  let outcomes;
  try {
    const base2 = `http://127.0.0.1:${(server2.address() as { port: number }).port}`;
    outcomes = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      if (i % 2 === 0) return upload(undefined, "m_concurrent");
      const r = await fetch(`${base2}/api/vault?op=files.upload`, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify({ name: "IBI_FICTICIO.pdf", contentType: "application/pdf", bytesBase64: Buffer.from(bytes).toString("base64"), movementId: "m_concurrent", propertyId: TEST_PROPERTY.id }) });
      return { status: r.status, data: await r.json() };
    }));
  } finally { await new Promise<void>((resolve) => server2.close(() => resolve())); }
  assert.ok(outcomes.every((r) => r.status === 201), "el concurrente idéntico debe reconciliar la respuesta");
  assert.equal(new Set(outcomes.map((r) => r.data.file?.id)).size, 1);
  assert.equal((await call("files.list")).data.files.length, 1);
});
test("B15 (L14). Nombre/tamaño iguales no fusionan bytes ni intenciones diferentes", async () => {
  const changed = bytes.slice(); changed[20] ^= 1;
  const a = await upload(undefined, "m_same"), b = await upload(undefined, "m_same", TEST_PROPERTY.id, credential, changed);
  const c = await upload(undefined, "m_other");
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(c.status, 201);
  assert.notEqual(a.data.file.id, b.data.file.id); assert.notEqual(a.data.file.id, c.data.file.id);
});
test("B16. Recuperación intacta y no acceso cruzado después de commit/retry", async () => {
  await linked(); const r = await call("files.get", "GET", undefined, credential, "file_good");
  assert.equal(r.status, 200); assert.deepEqual(r.data, bytes);
  assert.equal((await call("files.get", "GET", undefined, otherCredential, "file_good")).status, 404);
});

test("B17. ETag obsoleto no puede sustituir una asociación nueva, tampoco en el commit individual", async () => {
  const original = await linked();
  const read = await call("movimientos.get", "GET", undefined, credential, original.id);
  assert.equal(read.status, 200);
  await upload("file_replacement", original.id);
  const updated = { ...original, receiptVaultId: "file_replacement" };
  assert.equal((await call("movimientos.save", "PUT", { movement: updated }, credential, original.id, { "if-match": read.data.version })).status, 200);
  const stale = await call("movimientos.save", "PUT", { movement: original }, credential, original.id, { "if-match": read.data.version });
  assert.equal(stale.status, 409);
  assert.equal((await call("movimientos.get", "GET", undefined, credential, original.id)).data.movement.receiptVaultId, updated.receiptVaultId);
});

test("B18. Dos escritores CAS contra la misma versión solo confirman uno y conservan el documento", async () => {
  const confirmed = await linked();
  const version = (await call("movimientos.get", "GET", undefined, credential, confirmed.id)).data.version;
  const results = await Promise.all([2, 3].map((amount) => call("movimientos.save", "PUT", { movement: { ...confirmed, amount } }, credential, confirmed.id, { "if-match": version })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await call("movimientos.get", "GET", undefined, credential, confirmed.id)).data.movement.receiptVaultId, confirmed.receiptVaultId);
});

test("B19. Reserva directa legacy sin ID ni SHA se rechaza; con SHA reintenta la misma reserva", async () => {
  const request = { name: "FICTICIO.pdf", contentType: "application/pdf", size: bytes.length, movementId: "m_direct_legacy", propertyId: TEST_PROPERTY.id };
  assert.equal((await call("files.presign", "POST", request)).status, 400);
  const { sha256Hex } = await import("./persistence.js");
  const input = { ...request, sha256: sha256Hex(bytes) };
  const a = await call("files.presign", "POST", input), b = await call("files.presign", "POST", input);
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.data.fileId, b.data.fileId);
  await port.directPut(persistence.contentPathFor(owner, a.data.fileId), bytes, "application/pdf");
  const committed = await call("files.commit", "POST", { size: bytes.length, sha256: input.sha256 }, credential, a.data.fileId);
  assert.equal(committed.status, 200);
  const retry = await call("files.presign", "POST", input);
  assert.equal(retry.status, 200); assert.equal(retry.data.alreadyCommitted, true);
});

test("B20. Revocación no cambia el secreto ni otra sesión de la MISMA cuenta", async () => {
  const password = randomBytes(24).toString("hex"), name = "test_two_sessions_same_owner";
  assert.equal((await call("auth.register", "POST", { username: name, password }, "")).status, 201);
  const a = await login(name, password), b = await login(name, password);
  assert.ok(a !== b, "cada login tiene identidad de sesión única");
  const oldSecret = await persistence.ensureSecret();
  assert.equal((await call("auth.logout", "POST", undefined, a)).status, 204);
  assert.equal((await call("session", "GET", undefined, a)).status, 401);
  assert.equal((await call("session", "GET", undefined, b)).status, 200);
  assert.ok((await persistence.ensureSecret()) === oldSecret, "no se rota secreto global ni credenciales");
});

test("B21. Fallo de lectura de revocación falla cerrado; no reutiliza una sesión por caché", async () => {
  const originalRead = port.getBytes.bind(port);
  port.getBytes = async (path) => { if (path.includes("session-revocations")) throw new Error("almacén simulado no disponible"); return originalRead(path); };
  assert.equal((await call("session")).status, 503);
  port.getBytes = originalRead;
  assert.equal((await call("session")).status, 200);
});

test("B22. Registro de usuario concurrente no cambia la cuenta ganadora ni su credencial", async () => {
  // API/server side only; records never contain a password or session in clear.
  const p2 = new BlobVaultPersistence(port);
  const a = { salt: randomBytes(16).toString("hex"), hash: randomBytes(64).toString("hex"), createdAt: "2026-10-11" };
  const b = { salt: randomBytes(16).toString("hex"), hash: randomBytes(64).toString("hex"), createdAt: "2026-10-11" };
  const results = await Promise.all([persistence.createUser("test_registration_race", a), p2.createUser("test_registration_race", b)]);
  assert.equal(results.filter(Boolean).length, 1);
  const stored = await persistence.getUser("test_registration_race");
  assert.ok(stored?.salt === (results[0] ? a.salt : b.salt));
});

test("B23. Snapshot de borrado no elimina un inmueble que conserva documentos", async () => {
  await upload("file_good");
  assert.equal((await call("entities.put", "POST", { type: "properties", id: TEST_PROPERTY.id, entity: attachedProperty() })).status, 201);
  assert.equal((await call("entities.delete&type=properties", "DELETE", undefined, credential, TEST_PROPERTY.id)).status, 409);
  assert.equal((await call("entities.get&type=properties", "GET", undefined, credential, TEST_PROPERTY.id)).status, 200);
});

for (const mode of ["valid", "missing", "foreign", "corrupted", "context", "no-generation"] as const) {
  test(`B24 Storage-verifier AUTORITATIVO simulado: ${mode}; body no decide el resultado`, async () => {
    await stop();
    const { sha256Hex } = await import("./persistence.js");
    const path = `users/${owner}/attachments/expenses/m_verified/fixture.pdf`;
    let reads = 0;
    const verifier = { async readAuthorized(actor: string, requested: string) {
      reads++; assert.equal(actor, owner); assert.equal(requested, path);
      if (mode === "missing") return null;
      return { owner: mode === "foreign" ? other : owner, path, bytes: mode === "corrupted" ? new Uint8Array([1, 2, 3]) : bytes,
        sha256: sha256Hex(bytes), generation: mode === "no-generation" ? "" : "synthetic-generation-1", propertyId: TEST_PROPERTY.id,
        movementId: mode === "context" ? "other_intention" : "m_verified" };
    } };
    const app = createApiApp({ vaultPersistence: persistence, vaultStorageVerifier: verifier });
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const m = movement("m_verified", { receiptPath: path, owner, sha256: sha256Hex(bytes), validated: true });
    const r = await call("movimientos.save", "PUT", { movement: m, verify: false }, credential, m.id);
    if (mode === "valid") { assert.equal(r.status, 200); assert.equal(r.data.movement.receiptPath, path); }
    else { assert.ok(r.status >= 400); assert.equal((await call("movimientos")).data.movements.length, 0); }
    assert.ok(reads >= 1, "verificación servidor es obligatoria independientemente del flag del body");
  });
}

test("B25. ZIP rechaza fichero con metadatos válidos cuyo documento ya no figura en su inmueble", async () => {
  await upload("file_property_unlinked", "", TEST_PROPERTY.id);
  const before = await persistence.getFileMeta(owner, "file_property_unlinked");
  const r = await call("expediente.zip&propertyId=" + TEST_PROPERTY.id);
  assert.ok(r.status >= 400, "no exportar un documento que carece de asociación confirmada");
  assert.equal((await persistence.getFileMeta(owner, "file_property_unlinked"))?.sha256, before?.sha256);
});

test("B26. Revocación ilegible/corrupta falla cerrado, no revalida una credencial retenida", async () => {
  assert.equal((await call("auth.logout", "POST")).status, 204);
  const [ledger] = (await port.list("")).filter((o) => o.pathname.includes("session-revocations"));
  assert.ok(ledger);
  await port.putBytes(ledger.pathname, new TextEncoder().encode("{JSON SINTÉTICO CORRUPTO"), "application/json");
  assert.equal((await call("session")).status, 503, "una lectura indeterminada no significa sesión no revocada");
});

test("B27. Borrado HTTP de objeto definitivo no deja una referencia confirmada colgante", async () => {
  const m = await linked();
  const deleted = await call("files.delete", "DELETE", undefined, credential, m.receiptVaultId);
  assert.equal(deleted.status, 409, "no ejecutar borrado de documento consolidado desde endpoint legado");
  assert.equal((await call("files.get", "GET", undefined, credential, m.receiptVaultId)).status, 200);
  assert.equal((await call("movimientos.get", "GET", undefined, credential, m.id)).data.movement.receiptVaultId, m.receiptVaultId);
});

test("B28. Dos instancias: borrado prevalidado del padre pierde CAS tras confirmar un adjunto", async () => {
  await upload("file_parent_race", "m_parent_race");
  const secondary = createApiApp({ vaultPersistence: new BlobVaultPersistence(port) });
  const s = await new Promise<Server>((r) => { const instance = secondary.listen(0, "127.0.0.1", () => r(instance)); });
  const otherBase = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  let reached!: () => void, release!: () => void;
  const deletingReached = new Promise<void>((r) => { reached = r; }), wait = new Promise<void>((r) => { release = r; });
  const originalDelete = port.del.bind(port);
  port.del = async (path, options) => {
    if (path.includes("/entities/properties/")) { reached(); await wait; }
    return originalDelete(path, options);
  };
  try {
    const deletion = fetch(otherBase + `/api/vault?op=entities.delete&type=properties&id=${TEST_PROPERTY.id}`, { method: "DELETE", headers: { authorization: `Bearer ${credential}` } });
    await deletingReached;
    const m = movement("m_parent_race", { receiptVaultId: "file_parent_race" });
    const committed = await call("movimientos.save", "PUT", { movement: m }, credential, m.id);
    release();
    assert.equal(committed.status, 200);
    assert.equal((await deletion).status, 409, "el ETag viejo del padre ya no autoriza borrado después de confirmar vínculo");
    assert.equal((await call("entities.get&type=properties", "GET", undefined, credential, TEST_PROPERTY.id)).status, 200);
    assert.equal((await call("movimientos.get", "GET", undefined, credential, m.id)).data.movement.receiptVaultId, m.receiptVaultId);
  } finally { release(); port.del = originalDelete; await new Promise<void>((r) => s.close(() => r())); }
});

test("B29. Retirada lógica y commit concurrentes: la reserva protegida gana CAS sin perder bytes", async () => {
  await upload("file_delete_race", "m_delete_race");
  let reached!: () => void, release!: () => void;
  const atRetirement = new Promise<void>((r) => { reached = r; }), wait = new Promise<void>((r) => { release = r; });
  const originalPut = port.putBytes.bind(port);
  port.putBytes = async (path, data, contentType, options) => {
    if (path.endsWith("/files/file_delete_race.json") && JSON.parse(new TextDecoder().decode(data)).deletedAt) { reached(); await wait; }
    return originalPut(path, data, contentType, options);
  };
  try {
    const deleting = call("files.delete", "DELETE", undefined, credential, "file_delete_race");
    const first = await Promise.race([atRetirement.then(() => "paused"), deleting.then(() => "ended")]);
    assert.equal(first, "paused", "la prueba alcanza una retirada real, no un rechazo incondicional de todos los DELETE");
    const m = movement("m_delete_race", { receiptVaultId: "file_delete_race" });
    const committed = await call("movimientos.save", "PUT", { movement: m }, credential, m.id);
    release();
    assert.equal(committed.status, 200); assert.equal((await deleting).status, 409);
    const recovered = await call("files.get", "GET", undefined, credential, m.receiptVaultId);
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.data, bytes);
  } finally { release(); port.putBytes = originalPut; }
});

test("B30. Retirada lógica anterior al enlace: no resucita el ID ni confirma un gasto colgante", async () => {
  await upload("file_retired", "m_retired");
  assert.equal((await call("files.delete", "DELETE", undefined, credential, "file_retired")).status, 204);
  assert.equal((await call("files.get", "GET", undefined, credential, "file_retired")).status, 404);
  assert.ok(!(await call("files.list")).data.files.some((f: any) => f.id === "file_retired"));
  const m = movement("m_retired", { receiptVaultId: "file_retired" });
  assert.equal((await call("movimientos.save", "PUT", { movement: m }, credential, m.id)).status, 409);
  assert.equal((await call("movimientos.get", "GET", undefined, credential, m.id)).status, 404);
  assert.equal((await upload("file_retired", m.id)).status, 409, "retry no borra tombstone ni recrea ID retirado");
  assert.deepEqual((await port.getBytes(persistence.contentPathFor(owner, "file_retired")))?.bytes, bytes, "original privado sigue intacto");
});

test("B31. Snapshot de inmueble conserva pins técnicos aunque no haya documents en data", async () => {
  const m = await linked();
  assert.equal((await call("entities.put", "POST", { type: "properties", id: TEST_PROPERTY.id, entity: TEST_PROPERTY })).status, 201);
  const stored = await persistence.getEntity(owner, "properties", TEST_PROPERTY.id);
  assert.ok(stored?.attachmentPins?.length);
  assert.equal((await call("entities.delete&type=properties", "DELETE", undefined, credential, TEST_PROPERTY.id)).status, 409);
  assert.equal((await call("files.get", "GET", undefined, credential, m.receiptVaultId)).status, 200);
});
