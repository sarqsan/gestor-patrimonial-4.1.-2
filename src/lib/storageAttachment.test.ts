import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { uploadAttachment, uploadBytesVerified, verifyAttachmentReference, __setStorageAttachmentPortForTests, invalidateFirebaseStorageProbe } from "./attachments";
import { __setSignInDriverForTests } from "./firebase";
import { AttachmentError, ATTACHMENT_TIMEOUTS } from "./attachmentErrors";
import { md5Base64, storeStorageAttachment, assertObjectMetadata } from "./storageAttachment";
import { MemoryStorageAttachmentPort, syntheticIbiPdf, PNG_BYTES, JPG_BYTES, WORD_BYTES, TEST_BUCKET } from "./attachmentTestFixtures";

let port: MemoryStorageAttachmentPort;
test.beforeEach(() => {
  port = new MemoryStorageAttachmentPort();
  __setStorageAttachmentPortForTests(port);
  __setSignInDriverForTests(async () => ({ user: { uid: "uid_sintetico" } as any }));
  invalidateFirebaseStorageProbe();
});
test.afterEach(() => { __setStorageAttachmentPortForTests(null); __setSignInDriverForTests(null); invalidateFirebaseStorageProbe(); });
const request = (bytes = syntheticIbiPdf()) => ({ path: "users/prueba/attachments/expenses/att_ibi/ibi.pdf", bucket: TEST_BUCKET, bytes, contentType: "application/pdf" });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("S1. MD5 local contrasta con node:crypto y respeta ventanas de buffer", () => {
  for (const text of ["", "a", "abc", "prueba de integridad".repeat(100)]) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(md5Base64(bytes), createHash("md5").update(bytes).digest("base64"));
  }
  const window = new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4);
  assert.equal(md5Base64(window), createHash("md5").update(window).digest("base64"));
});

test("S2. PDF IBI: uploadAttachment real verifica metadatos antes/después y conserva bytes", async () => {
  const bytes = syntheticIbiPdf();
  const stored = await uploadAttachment({ userId: "prueba", folder: "expenses", file: new File([bytes], "ibi.pdf", { type: "application/pdf" }), movementId: "mov_ibi", propertyId: "prop_ibi" });
  assert.equal(stored.mode, "storage");
  const object = port.objects.get(stored.storagePath!)!;
  assert.deepEqual(object.bytes, bytes);
  assert.equal(object.meta.customMetadata!.rentasyncMovementId, "mov_ibi");
  assert.equal(object.meta.customMetadata!.rentasyncPropertyId, "prop_ibi");
  assert.equal(port.creates.length, 1);
  assert.deepEqual(port.reads, [stored.storagePath, stored.storagePath]);
});

test("S3. PNG, JPG sin MIME y Word generado conservan los formatos admitidos", async () => {
  for (const [name, type, folder, bytes] of [["ibi.png", "image/png", "expenses", PNG_BYTES], ["ibi.jpg", "", "expenses", JPG_BYTES], ["contrato.doc", "application/msword", "contracts", WORD_BYTES]] as const) {
    const stored = await uploadAttachment({ userId: "prueba", folder, file: new File([bytes], name, { type }), allowWordDocument: folder === "contracts" });
    assert.equal(stored.contentType, type || "image/jpeg");
    assert.deepEqual(port.objects.get(stored.storagePath!)!.bytes, bytes);
  }
});

test("S4. Reintentar el mismo documento reutiliza ruta y no sobrescribe ni duplica", async () => {
  const file = new File([syntheticIbiPdf()], "ibi.pdf", { type: "application/pdf" });
  const opts = { userId: "prueba", folder: "expenses" as const, file, movementId: "mov_1", propertyId: "prop_1" };
  const a = await uploadAttachment(opts);
  const b = await uploadAttachment(opts);
  assert.equal(a.storagePath, b.storagePath);
  assert.equal(port.objects.size, 1);
  assert.equal(port.creates.length, 1);
  const other = await uploadAttachment({ ...opts, movementId: "mov_2" });
  assert.notEqual(other.storagePath, a.storagePath, "otra operación no comparte trazabilidad accidentalmente");
});

test("S5. No basta con customMetadata: un MD5 del servidor distinto rechaza la verificación", async () => {
  const req = request();
  const originalCreate = port.create.bind(port);
  port.create = async (...args) => {
    const meta = await originalCreate(...args);
    meta.md5Hash = "checksum-alterado";
    return meta;
  };
  await assert.rejects(() => storeStorageAttachment(port, req), (e: any) => e.code === "attachment/integrity" && e.phase === "verification");
  assert.equal(port.objects.size, 1, "no se borra un archivo por una verificación fallida");
});

test("S6. Referencia, bucket, generación, tamaño y tipo son obligatorios para confirmar", async () => {
  const req = request();
  const meta = await storeStorageAttachment(port, req);
  const expected = { ...req, size: req.bytes.length, md5Hash: meta.md5Hash!, sha256: meta.customMetadata!.rentasyncSHA256 };
  for (const altered of [{ fullPath: "otra/ruta" }, { bucket: "otro-bucket" }, { generation: "" }, { size: 1 }, { contentType: "image/png" }]) {
    assert.throws(() => assertObjectMetadata({ ...meta, ...altered }, expected), AttachmentError);
  }
});

test("S7. Permisos denegados en consulta previa: código y causa original, sin intentar subir", async () => {
  const original = Object.assign(new Error("Firebase Storage: permission denied"), { code: "storage/unauthorized" });
  port.metadata = async () => { throw original; };
  await assert.rejects(() => storeStorageAttachment(port, request()), (e: any) => e.phase === "preflight" && e.code === original.code && e.cause === original && !e.retryable);
  assert.equal(port.creates.length, 0);
});

test("S8. Permisos denegados en subida no se ocultan con una lectura o un falso éxito", async () => {
  const original = Object.assign(new Error("write forbidden"), { code: "storage/unauthorized" });
  port.create = async () => { throw original; };
  await assert.rejects(() => storeStorageAttachment(port, request()), (e: any) => e.phase === "upload" && e.cause === original);
  assert.equal(port.reads.length, 1);
});

test("S9. Red/Storage fallidos conservan código; se puede reintentar con la misma referencia", async () => {
  const create = port.create.bind(port);
  let first = true;
  port.create = async (...args) => { if (first) { first = false; throw Object.assign(new Error("retry budget exhausted"), { code: "storage/retry-limit-exceeded" }); } return create(...args); };
  await assert.rejects(() => storeStorageAttachment(port, request()), (e: any) => e.phase === "upload" && e.retryable && e.code === "storage/retry-limit-exceeded");
  await storeStorageAttachment(port, request());
  assert.equal(port.objects.size, 1);
});

test("S10. Timeout previo NO se etiqueta como subida ni permite una creación tardía", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ready = deferred<void>();
  const late = deferred<any>();
  port.metadata = async () => { ready.resolve(); return late.promise; };
  const result = storeStorageAttachment(port, request());
  const rejection = assert.rejects(result, (e: any) => e.phase === "preflight" && e.code === "attachment/timeout");
  await ready.promise;
  t.mock.timers.tick(ATTACHMENT_TIMEOUTS.preflight);
  await rejection;
  late.resolve(null);
  await Promise.resolve();
  assert.equal(port.creates.length, 0);
});

test("S11. Timeout de subida aborta el transporte; una respuesta tardía no confirma nada", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ready = deferred<void>();
  const late = deferred<any>();
  let signal!: AbortSignal;
  let canceled = false;
  port.create = async (_path, _bytes, _meta, s) => { signal = s; s.addEventListener("abort", () => { canceled = true; }); ready.resolve(); return late.promise; };
  const rejection = assert.rejects(storeStorageAttachment(port, request()), (e: any) => e.phase === "upload" && e.code === "attachment/timeout");
  await ready.promise;
  t.mock.timers.tick(ATTACHMENT_TIMEOUTS.upload);
  await rejection;
  assert.equal(signal.aborted, true);
  assert.equal(canceled, true);
  late.resolve({});
  await Promise.resolve();
  assert.equal(port.reads.length, 1, "no verificación posterior ni éxito tras cancelar");
});

test("S12. Timeout posterior: no éxito, objeto conservado y reintento sin duplicar", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalMetadata = port.metadata.bind(port);
  const ready = deferred<void>();
  let calls = 0;
  port.metadata = async (path) => { if (++calls === 2) { ready.resolve(); return new Promise(() => {}); } return originalMetadata(path); };
  const rejection = assert.rejects(storeStorageAttachment(port, request()), (e: any) => e.phase === "verification" && e.code === "attachment/timeout");
  await ready.promise;
  t.mock.timers.tick(ATTACHMENT_TIMEOUTS.verification);
  await rejection;
  assert.equal(port.objects.size, 1);
  await storeStorageAttachment(port, request());
  assert.equal(port.creates.length, 1);
});

test("S13. Importación usa la misma verificación fiable y no depende de descargas ni URL temporal", async () => {
  const opts = { userId: "prueba", folder: "expenses" as const, attachmentId: "imp_ibi", fileName: "ibi.pdf", contentType: "application/pdf", bytes: syntheticIbiPdf() };
  const first = await uploadBytesVerified(opts);
  assert.equal((await uploadBytesVerified(opts)).storagePath, first.storagePath);
  assert.equal(port.creates.length, 1);
});


test("S14. Referencia Firebase de otra cuenta, operación o inmueble no se asocia", async () => {
  const stored = await uploadAttachment({ userId: "prueba", folder: "expenses", file: new File([syntheticIbiPdf()], "ibi.pdf", { type: "application/pdf" }),
    movementId: "mov_ibi", propertyId: "prop_ibi" });
  const source = { storagePath: stored.storagePath, movementId: "mov_ibi", propertyId: "prop_ibi" };
  await verifyAttachmentReference("prueba", source);
  for (const changed of [{ movementId: "otro_movimiento" }, { propertyId: "otro_inmueble" }]) {
    await assert.rejects(() => verifyAttachmentReference("prueba", { ...source, ...changed }), (e: any) => e.phase === "association" && e.code === "attachment/association-conflict");
  }
  await assert.rejects(() => verifyAttachmentReference("otra_cuenta", source), (e: any) => e.code === "attachment/invalid-reference");
  assert.equal(port.objects.size, 1);
});


// Regresión puntual del mensaje original. Se ejecuta la función del commit base
// con SDK falso y reloj virtual: ninguna configuración o servicio Firebase real.
test("S15. Timeout original: GET de bytes previo bloqueaba upload; el flujo actual verifica metadatos sin esa descarga", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { runInNewContext } = await import("node:vm");
  const ts = await import("typescript");
  const rules = await import("./attachmentRules");
  const verified = await import("./verifiedObjectStore");
  const baseline = execFileSync("git", ["show", "3a71b97495e98f250681b8280e4592958c5439d8:src/lib/attachments.ts"], { encoding: "utf8" });
  const exactMessage = "La verificación del archivo ha superado el tiempo de espera. No se ha guardado la operación.";
  assert.ok(baseline.includes(exactMessage), "reproducir la fuente original, no un mensaje inventado");
  const javascript = ts.transpileModule(baseline, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reached = deferred<void>();
  let mediaReads = 0, uploads = 0;
  const sdk = {
    ref: (_storage: unknown, path?: string) => ({ fullPath: path, bucket: TEST_BUCKET }),
    getBytes: async () => { mediaReads++; reached.resolve(); return new Promise<Uint8Array>(() => {}); },
    uploadBytes: async () => { uploads++; throw new Error("la primera lectura bloqueada no debe permitir subir"); },
  };
  const legacyModule = { exports: {} as Record<string, any> };
  runInNewContext(javascript, {
    module: legacyModule, exports: legacyModule.exports,
    require: (id: string) => {
      if (id === "firebase/storage") return sdk;
      if (id === "./firebase") return { storage: {}, auth: { currentUser: { uid: "uid_sintetico" } } };
      if (id === "./attachmentRules") return rules;
      if (id === "./verifiedObjectStore") return verified;
      if (id === "./vaultClient") return {}; // no usado por uploadBytesVerified original
      throw new Error(`Dependencia no autorizada en reproducción local: ${id}`);
    },
    Uint8Array, Blob, Promise, setTimeout, clearTimeout,
    console: { error() {}, warn() {} },
  });
  const opts = { userId: "prueba", folder: "expenses" as const, attachmentId: "reg_ibi_timeout", fileName: "ibi.pdf",
    contentType: "application/pdf", bytes: syntheticIbiPdf(), movementId: "mov_ibi", propertyId: "prop_ibi" };
  const rejection = assert.rejects(legacyModule.exports.uploadBytesVerified(opts), (e: any) => e.message === exactMessage);
  await reached.promise;
  t.mock.timers.tick(60_000); // plazo ORIGINAL; nunca se aumenta el presupuesto de la aplicación
  await rejection;
  assert.equal(mediaReads, 1, "primera operación Storage: descarga previa de bytes");
  assert.equal(uploads, 0, "no se llegó a invocar upload en el fallo reproducido");

  const stored = await uploadBytesVerified(opts); // implementación actual, mismo documento/contexto
  assert.equal(port.creates.length, 1);
  assert.deepEqual(port.reads, [stored.storagePath, stored.storagePath]);
  assert.deepEqual(port.objects.get(stored.storagePath)!.bytes, opts.bytes);
  assert.equal(port.objects.get(stored.storagePath)!.meta.customMetadata!.rentasyncMovementId, opts.movementId);
  assert.equal(port.objects.get(stored.storagePath)!.meta.customMetadata!.rentasyncPropertyId, opts.propertyId);
  assert.equal(mediaReads, 1, "la corrección no vuelve a depender del GET de media previo");
});
