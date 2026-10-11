// Pruebas del modo vault de los adjuntos: prioridad de destino (vault → Storage),
// campos por modo, resolución de descargas por referencia y compatibilidad con los
// adjuntos históricos incrustados (data URL).
// Ejecutar con: npm test  (node:test + tsx; fetch y localStorage se stubban, sin red real)
import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentError, expenseReceiptFieldsFromStored, getAttachmentBlob, uploadAttachment } from "./attachments";
import { setActiveVaultUser, storeVaultToken } from "./vaultClient";
import { receiptSource } from "./attachmentRules";

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

const NATIVE_FETCH = (globalThis as any).fetch;

test.beforeEach(() => {
  installLocalStorage();
});

test.afterEach(() => {
  delete (globalThis as any).localStorage;
  // Se restaura (no se borra): pruebas como A7 usan el fetch nativo para data: URLs.
  (globalThis as any).fetch = NATIVE_FETCH;
});

// --- Campos por modo ---------------------------------------------------------

test("A1. modo vault escribe solo la referencia del vault (limpia Storage y cola local)", () => {
  const f = expenseReceiptFieldsFromStored({
    mode: "vault",
    vaultId: "file_1",
    name: "ibi.pdf",
    contentType: "application/pdf",
    size: 3,
  });
  assert.equal(f.receiptVaultId, "file_1");
  assert.equal(f.receiptName, "ibi.pdf");
  assert.equal(f.receiptType, "application/pdf");
  assert.equal(f.receiptPath, undefined);
  assert.equal(f.receiptUrl, undefined);
});

test("A2. modo storage escribe solo receiptPath (limpia vault y cola local)", () => {
  const f = expenseReceiptFieldsFromStored({
    mode: "storage",
    storagePath: "users/alice/attachments/expenses/r1/ibi.pdf",
    name: "ibi.pdf",
    contentType: "application/pdf",
    size: 3,
  });
  assert.equal(f.receiptPath, "users/alice/attachments/expenses/r1/ibi.pdf");
  assert.equal(f.receiptVaultId, undefined);
  assert.equal(f.receiptUrl, undefined);
});

test("A3. los comprobantes históricos (data URL) siguen leyéndose sin reescribirse", async () => {
  const dataUrl = "data:application/pdf;base64,QUJD";
  const blob = await getAttachmentBlob({ inlineData: dataUrl });
  assert.equal(blob.size, 3, "el comprobante histórico se recupera igual que antes");
  // Y la resolución de origen lo reconoce como adjunto legado (compatibilidad hacia atrás).
  const source = receiptSource({ receiptUrl: dataUrl });
  assert.equal(source.inlineData, dataUrl);
  assert.equal(source.vaultId, undefined);
  assert.equal(source.storagePath, undefined);
});

// --- Prioridad de subida ------------------------------------------------------

test("A4. uploadAttachment usa el vault cuando hay sesión (sin tocar Firebase ni la cola local)", async () => {
  storeVaultToken("alice", "tok-u");
  const calls: Array<{ url: string; init?: any }> = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    calls.push({ url, init });
    if (url === "/api/vault/health") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, durable: true, driver: "vercel-blob", storageOk: true, directUpload: true, maxFileBytes: 10485760 }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        file: { id: "file_77", name: "factura.pdf", contentType: "application/pdf", size: 4, sha256: "h" },
      }),
    };
  };

  const file = new File([new Uint8Array([1, 2, 3, 4])], "factura.pdf", { type: "application/pdf" });
  const stored = await uploadAttachment({
    userId: "alice",
    folder: "expenses",
    file,
    movementId: "exp_1",
    propertyId: "prop_1",
  });

  assert.equal(stored.mode, "vault");
  assert.equal(stored.vaultId, "file_77");
  assert.equal(stored.storagePath, undefined);
  // Red: sonda de capacidades + subida. Firebase Storage no se invoca en ningún caso.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/vault/health");
  assert.equal(calls[1].url, "/api/vault/files");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.movementId, "exp_1");
  assert.equal(body.propertyId, "prop_1");
  assert.equal(body.contentType, "application/pdf");
});

// --- Prioridad de lectura -------------------------------------------------------

test("A5. getAttachmentBlob resuelve por referencia vault con el usuario activo", async () => {
  storeVaultToken("alice", "tok-u");
  setActiveVaultUser("alice");
  let authHeader: string | undefined;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    assert.equal(url, "/api/vault/files/file_77");
    authHeader = init?.headers?.authorization;
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([7])]),
      json: async () => ({}),
    };
  };

  const blob = await getAttachmentBlob({ vaultId: "file_77" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [7]);
  assert.equal(authHeader, "Bearer tok-u");
});

test("A6. getAttachmentBlob con referencia vault pero sin sesión lanza error claro", async () => {
  setActiveVaultUser(null);
  await assert.rejects(
    () => getAttachmentBlob({ vaultId: "file_77" }),
    (err: unknown) => err instanceof AttachmentError
  );
});

test("A7. getAttachmentBlob sigue leyendo el histórico incrustado (data URL) sin sesión", async () => {
  const blob = await getAttachmentBlob({ inlineData: "data:application/pdf;base64,QUJD" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [65, 66, 67]); // "ABC"
});

test("A8. getAttachmentBlob sin ninguna fuente disponible lanza error claro", async () => {
  await assert.rejects(() => getAttachmentBlob({}), (err: unknown) => err instanceof AttachmentError);
});
