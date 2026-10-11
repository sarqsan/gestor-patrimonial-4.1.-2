// Pruebas del contrato de persistencia del cliente:
//  - la subida va al almacén remoto, con transporte automático (cuerpo JSON o subida directa);
//  - si el almacén remoto no está disponible, NO se guarda nada en el navegador y el error es
//    explícito (no hay fallback local silencioso ni falso éxito);
//  - los adjuntos históricos incrustados (data URL) siguen leyéndose.
// Ejecutar con: npm test  (fetch y localStorage se sustituyen; sin red real)
import test from "node:test";
import assert from "node:assert/strict";
import {
  DIRECT_UPLOAD_THRESHOLD_BYTES,
  VaultUnavailableError,
  vaultCapabilities,
  vaultUploadFileAuto,
  vaultUploadFileDirect,
  storeVaultToken,
  __resetVaultCapabilitiesCacheForTests,
} from "./vaultClient";
import { AttachmentError, getAttachmentBlob, uploadAttachment } from "./attachments";
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
const HEALTH_OK = {
  ok: true,
  durable: true,
  driver: "vercel-blob",
  storageOk: true,
  directUpload: true,
  maxFileBytes: 10 * 1024 * 1024,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test.beforeEach(() => {
  installLocalStorage();
  __resetVaultCapabilitiesCacheForTests();
});

test.afterEach(() => {
  (globalThis as any).fetch = NATIVE_FETCH;
});

test("C1. Las capacidades describen el destino real y se cachean unos segundos", async () => {
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    return jsonResponse(200, HEALTH_OK);
  };

  const caps = await vaultCapabilities(true);
  assert.equal(caps.durable, true);
  assert.equal(caps.driver, "vercel-blob");
  assert.equal(caps.storageOk, true);
  assert.equal(caps.directUpload, true);
  await vaultCapabilities(); // dentro de la ventana de caché
  assert.equal(calls.length, 1, "la sonda no se repite en cada operación");
});

test("C2. Sin destino remoto conectado, la subida falla y no se guarda nada en el navegador", async () => {
  const storage = installLocalStorage();
  storeVaultToken("ana", "tok-ana");
  const posts: string[] = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (url === "/api/vault?op=health") {
      return jsonResponse(200, { ...HEALTH_OK, storageOk: false, durable: false, driver: "unconfigured", detail: "sin almacén conectado" });
    }
    posts.push(`${init?.method ?? "GET"} ${url}`);
    return jsonResponse(200, { file: { id: "no_deberia", name: "x", contentType: "application/pdf", size: 3, sha256: "h" } });
  };

  const file = new File([new Uint8Array([1, 2, 3])], "recibo.pdf", { type: "application/pdf" });
  await assert.rejects(
    () => uploadAttachment({ userId: "ana", folder: "expenses", file }),
    (err: any) => {
      assert.ok(err instanceof AttachmentError);
      assert.match(err.message, /no está conectado|no ha guardado nada/i);
      return true;
    }
  );
  assert.deepEqual(posts, [], "no se intenta ninguna escritura cuando el destino remoto no está conectado");
  // En el navegador solo queda el token de sesión: ningún contenido de archivo.
  assert.deepEqual([...storage.keys()], ["rentasync_vault_token_ana"], "el navegador no almacena el archivo por su cuenta");
});

test("C3. Almacén remoto caído (sin respuesta): error explícito y ninguna escritura local", async () => {
  const storage = installLocalStorage();
  storeVaultToken("ana", "tok-ana");
  (globalThis as any).fetch = async (url: string) => {
    if (url === "/api/vault?op=health") throw new Error("red caída (sintético)");
    return jsonResponse(200, { file: { id: "x", name: "x", contentType: "application/pdf", size: 1, sha256: "h" } });
  };
  const file = new File([new Uint8Array([1, 2, 3])], "recibo.pdf", { type: "application/pdf" });
  await assert.rejects(
    () => uploadAttachment({ userId: "ana", folder: "expenses", file }),
    (err: any) => err instanceof AttachmentError && /no se ha guardado nada|no está disponible/i.test(err.message)
  );
  assert.deepEqual([...storage.keys()], ["rentasync_vault_token_ana"], "solo queda el token de sesión, ningún contenido");
});

test("C4. La subida directa la usa el navegador solo con una firma acotada, y el servidor confirma el hash", async () => {
  storeVaultToken("ana", "tok-ana");
  const calls: Array<{ url: string; method?: string; body?: any }> = [];
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const payload = new File([bytes], "grande.pdf", { type: "application/pdf" });

  (globalThis as any).fetch = async (url: string, init?: any) => {
    calls.push({ url, method: init?.method, body: init?.body ? String(init.body).slice(0, 120) : undefined });
    if (url === "/api/vault?op=files.presign") {
      return jsonResponse(201, {
        ok: true,
        fileId: "file_directo_1",
        upload: { url: "https://blob.invalid/vault/users/ana/contents/file_directo_1?sig=1", headers: { "content-type": "application/pdf" }, validUntil: Date.now() + 600000 },
      });
    }
    if (String(url).startsWith("https://blob.invalid/")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url === "/api/vault?op=files.commit&id=file_directo_1") {
      return jsonResponse(200, { ok: true, file: { id: "file_directo_1", name: "grande.pdf", contentType: "application/pdf", size: 5, sha256: "abc" } });
    }
    throw new Error(`llamada inesperada: ${url}`);
  };

  const meta = await vaultUploadFileDirect({ username: "ana", file: payload, name: "grande.pdf", contentType: "application/pdf", movementId: "mov_1" });
  assert.equal(meta.id, "file_directo_1");
  assert.equal(calls.length, 3, "firma → escritura directa en el almacén → confirmación");
  assert.equal(calls[0].url, "/api/vault?op=files.presign");
  assert.ok(String(calls[1].url).startsWith("https://blob.invalid/"), "el contenido no atraviesa la función serverless");
  assert.equal(calls[2].url, "/api/vault?op=files.commit&id=file_directo_1");
  assert.match(String(calls[2].body), /"sha256":"[0-9a-f]+"/, "la confirmación incluye el hash calculado en el navegador");
  assert.ok(!JSON.stringify(calls).includes("BLOB_READ_WRITE_TOKEN"), "no se maneja ninguna credencial del almacén");
});

test("C5. El transporte se elige por tamaño: pequeño por JSON, grande por subida directa", async () => {
  storeVaultToken("ana", "tok-ana");
  const usedPaths: string[] = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    usedPaths.push(url);
    if (url === "/api/vault?op=files.upload") {
      return jsonResponse(201, { ok: true, file: { id: "file_json", name: "p.pdf", contentType: "application/pdf", size: 4, sha256: "h" } });
    }
    if (url === "/api/vault?op=files.presign") {
      return jsonResponse(201, { ok: true, fileId: "file_grande", upload: { url: "https://blob.invalid/x", headers: {}, validUntil: Date.now() + 600000 } });
    }
    if (String(url).startsWith("https://blob.invalid/")) return { ok: true, status: 200, json: async () => ({}) };
    if (url === "/api/vault?op=files.commit&id=file_grande") {
      return jsonResponse(200, { ok: true, file: { id: "file_grande", name: "g.pdf", contentType: "application/pdf", size: 4, sha256: "h" } });
    }
    throw new Error(`llamada inesperada: ${url}`);
  };

  const caps = { ...HEALTH_OK };
  const small = new File([new Uint8Array([1, 2, 3, 4])], "p.pdf", { type: "application/pdf" });
  const r1 = await vaultUploadFileAuto({ username: "ana", file: small, name: "p.pdf", contentType: "application/pdf", capabilities: caps });
  assert.equal(r1.id, "file_json");

  const big = new File([new Uint8Array(DIRECT_UPLOAD_THRESHOLD_BYTES + 1)], "g.pdf", { type: "application/pdf" });
  const r2 = await vaultUploadFileAuto({ username: "ana", file: big, name: "g.pdf", contentType: "application/pdf", capabilities: caps });
  assert.equal(r2.id, "file_grande");
  assert.ok(usedPaths.includes("/api/vault?op=files.upload"), "el archivo pequeño usa la vía JSON");
  assert.ok(usedPaths.includes("/api/vault?op=files.presign"), "el archivo grande usa la vía directa");
});

test("C6. La firma caducada o rechazada por el almacén no se declara como guardado", async () => {
  storeVaultToken("ana", "tok-ana");
  (globalThis as any).fetch = async (url: string) => {
    if (url === "/api/vault?op=files.presign") {
      return jsonResponse(201, { ok: true, fileId: "file_x", upload: { url: "https://blob.invalid/x", headers: {}, validUntil: Date.now() + 1000 } });
    }
    if (String(url).startsWith("https://blob.invalid/")) return { ok: false, status: 403, json: async () => ({}) };
    return jsonResponse(500, {});
  };
  await assert.rejects(
    () => vaultUploadFileDirect({ username: "ana", file: new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" }), name: "x.pdf", contentType: "application/pdf" }),
    /no se ha guardado/i
  );
});

test("C7. Los adjuntos históricos incrustados siguen leyéndose y se resuelven por su origen", async () => {
  const dataUrl = "data:application/pdf;base64,QUJD";
  const blob = await getAttachmentBlob({ inlineData: dataUrl });
  assert.equal(blob.size, 3);
  assert.deepEqual(receiptSource({ receiptUrl: dataUrl }), { inlineData: dataUrl });
  // Una ruta de Storage manda sobre el legado; el vault manda sobre todo lo demás.
  assert.deepEqual(receiptSource({ receiptPath: "users/a/x.pdf", receiptUrl: dataUrl }), { storagePath: "users/a/x.pdf" });
  assert.deepEqual(receiptSource({ receiptVaultId: "file_1", receiptPath: "users/a/x.pdf" }), { vaultId: "file_1" });
});

test("C8. Sin sesión remota, la subida no se inventa un destino local", async () => {
  const storage = installLocalStorage();
  (globalThis as any).fetch = async () => jsonResponse(200, HEALTH_OK);
  await assert.rejects(() => vaultUploadFileAuto({ username: "sin_sesion", file: new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" }), name: "x.pdf", contentType: "application/pdf" }), /No hay sesión/i);
  assert.equal(storage.size, 0);
});

test("C9. El error de destino no disponible es reconocible como tal (no un fallo genérico)", async () => {
  (globalThis as any).fetch = async () => {
    throw new Error("red caída");
  };
  await assert.rejects(() => vaultCapabilities(true), (err: any) => err instanceof VaultUnavailableError);
});
