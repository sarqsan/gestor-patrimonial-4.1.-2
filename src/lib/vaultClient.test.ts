// Pruebas del cliente del vault (almacenamiento remoto propio de la aplicación).
// Ejecutar con: npm test  (node:test + tsx; fetch y localStorage se stubban, sin red real)
import test from "node:test";
import assert from "node:assert/strict";
import {
  VaultAuthError,
  VaultError,
  clearVaultToken,
  flushQueuedReceiptsToVault,
  getActiveVaultUser,
  getVaultToken,
  setActiveVaultUser,
  storeVaultToken,
  vaultDownloadFile,
  vaultEnsureSession,
  vaultPutMovements,
  vaultUploadFile,
} from "./vaultClient";

/** localStorage en memoria (el runner de Node 22 no tiene almacenamiento web). */
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

type FetchHandler = (url: string, init?: any) => any;
function installFetch(handler: FetchHandler): { calls: Array<{ url: string; init?: any }> } {
  const calls: Array<{ url: string; init?: any }> = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob([]),
  };
}

const NATIVE_FETCH = (globalThis as any).fetch;

test.beforeEach(() => {
  installLocalStorage();
});

test.afterEach(() => {
  delete (globalThis as any).localStorage;
  // Se restaura (no se borra) para no afectar a pruebas de otros ficheros en el mismo proceso.
  (globalThis as any).fetch = NATIVE_FETCH;
});

// --- Sesión -----------------------------------------------------------------

test("C1. Primer uso: login 401 → alta → re-login guarda el token y marca el usuario activo", async () => {
  let loginCalls = 0;
  const { calls } = installFetch((url: string) => {
    if (url === "/api/vault?op=auth.login") {
      loginCalls++;
      return loginCalls === 1
        ? jsonResponse(401, { error: "credenciales inválidas" })
        : jsonResponse(200, { token: "tok-u" });
    }
    if (url === "/api/vault?op=auth.register") return jsonResponse(201, { ok: true });
    return jsonResponse(404, { error: "no encontrado" });
  });

  const token = await vaultEnsureSession("alice", "secret");
  assert.equal(token, "tok-u");
  assert.equal(getVaultToken("alice"), "tok-u");
  assert.equal(getActiveVaultUser(), "alice");
  assert.equal(loginCalls, 2);
  // El alta se hace con las credenciales de la app (cuerpo username/password).
  const register = calls.find((c) => c.url === "/api/vault?op=auth.register");
  assert.ok(register, "se debe llamar a op=auth.register");
  const body = JSON.parse(register!.init.body);
  assert.equal(body.username, "alice");
  assert.equal(body.password, "secret");
});

test("C2. Token existente válido: se reutiliza sin volver a hacer login", async () => {
  storeVaultToken("alice", "tok-prev");
  let sessionChecks = 0;
  let loginCalls = 0;
  installFetch((url: string) => {
    if (url === "/api/vault?op=session") {
      sessionChecks++;
      return jsonResponse(200, { ok: true });
    }
    if (url === "/api/vault?op=auth.login") {
      loginCalls++;
      return jsonResponse(200, { token: "tok-new" });
    }
    return jsonResponse(404, { error: "?" });
  });

  const token = await vaultEnsureSession("alice", "secret");
  assert.equal(token, "tok-prev");
  assert.equal(sessionChecks, 1);
  assert.equal(loginCalls, 0);
});

test("C3. clearVaultToken elimina la sesión del usuario", () => {
  storeVaultToken("alice", "tok-u");
  assert.equal(getVaultToken("alice"), "tok-u");
  clearVaultToken("alice");
  assert.equal(getVaultToken("alice"), null);
});

// --- Subida / descarga -------------------------------------------------------

test("C4. vaultUploadFile envía bytes Base64, trazabilidad y token Bearer; devuelve la referencia", async () => {
  storeVaultToken("alice", "tok-u");
  let captured: { url: string; init: any } | null = null;
  installFetch((url: string, init: any) => {
    captured = { url, init };
    return jsonResponse(200, {
      file: { id: "file_1", name: "a.pdf", contentType: "application/pdf", size: 3, sha256: "abc" },
    });
  });

  const meta = await vaultUploadFile({
    username: "alice",
    bytes: new Uint8Array([1, 2, 3]),
    name: "a.pdf",
    contentType: "application/pdf",
    movementId: "exp_9",
    propertyId: "p_1",
  });
  assert.equal(meta.id, "file_1");
  assert.equal(captured!.url, "/api/vault?op=files.upload");
  assert.equal(captured!.init.method, "POST");
  assert.equal(captured!.init.headers.authorization, "Bearer tok-u");
  const body = JSON.parse(captured!.init.body);
  assert.equal(body.bytesBase64, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(body.name, "a.pdf");
  assert.equal(body.contentType, "application/pdf");
  assert.equal(body.movementId, "exp_9");
  assert.equal(body.propertyId, "p_1");
});

test("C5. Sin sesión, las operaciones del vault fallan con VaultAuthError y sin llamadas de red", async () => {
  const { calls } = installFetch(() => jsonResponse(200, {}));
  await assert.rejects(
    () => vaultUploadFile({ username: "bob", bytes: new Uint8Array([1]), name: "x.pdf", contentType: "application/pdf" }),
    (err: unknown) => err instanceof VaultAuthError
  );
  await assert.rejects(() => vaultPutMovements("bob", []), (err: unknown) => err instanceof VaultAuthError);
  await assert.rejects(() => vaultDownloadFile("bob", "file_1"), (err: unknown) => err instanceof VaultAuthError);
  assert.equal(calls.length, 0);
});

test("C6. vaultDownloadFile traduce 401 a sesión caducada y 404 a error de vault", async () => {
  storeVaultToken("alice", "tok-u");
  installFetch((_url: string) => jsonResponse(401, { error: "token inválido" }));
  await assert.rejects(() => vaultDownloadFile("alice", "file_1"), (err: unknown) => err instanceof VaultAuthError);

  installFetch((_url: string) => jsonResponse(404, { error: "no encontrado" }));
  await assert.rejects(() => vaultDownloadFile("alice", "file_1"), (err: unknown) => err instanceof VaultError);

  const expected = new Uint8Array([9, 8, 7]);
  installFetch((_url: string) => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([expected]),
    json: async () => ({}),
  }));
  const blob = await vaultDownloadFile("alice", "file_1");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), Array.from(expected));
});

// --- Cola local → remoto ------------------------------------------------------

test("C7. flushQueuedReceiptsToVault externaliza solo los comprobantes en cola local", async () => {
  storeVaultToken("alice", "tok-u");
  let uploads = 0;
  installFetch((url: string) => {
    assert.equal(url, "/api/vault?op=files.upload");
    uploads++;
    return jsonResponse(200, {
      file: { id: `file_${uploads}`, name: "c.jpg", contentType: "image/jpeg", size: 3, sha256: "s" },
    });
  });

  const expenses: Array<{ id?: string; receiptUrl?: string; receiptPath?: string; receiptVaultId?: string }> = [
    { id: "e1", receiptUrl: "data:image/jpeg;base64,QUJD" }, // en cola: se externaliza
    { id: "e2", receiptUrl: "data:image/jpeg;base64,QUJD", receiptPath: "users/alice/attachments/x.jpg" }, // ya en Storage
    { id: "e3", receiptVaultId: "file_prev" }, // ya en vault
    { id: "e4", receiptUrl: "https://legado.example/x.png" }, // URL externa histórica: no es cola
    { id: "e5" }, // sin comprobante
  ];

  const flushed = await flushQueuedReceiptsToVault("alice", expenses);
  assert.equal(flushed, 1);
  assert.equal(uploads, 1);
  assert.equal(expenses[0].receiptVaultId, "file_1");
  assert.equal(expenses[0].receiptUrl, undefined);
  // El resto queda intacto.
  assert.equal(expenses[1].receiptPath, "users/alice/attachments/x.jpg");
  assert.equal(expenses[1].receiptVaultId, undefined);
  assert.equal(expenses[2].receiptVaultId, "file_prev");
  assert.equal(expenses[3].receiptUrl, "https://legado.example/x.png");
});

test("C8. flushQueuedReceiptsToVault sin sesión no toca nada (devuelve 0, sin red)", async () => {
  const { calls } = installFetch(() => jsonResponse(200, {}));
  const expenses: Array<{ id?: string; receiptUrl?: string; receiptPath?: string; receiptVaultId?: string }> = [
    { id: "e1", receiptUrl: "data:image/jpeg;base64,QUJD" },
  ];
  const flushed = await flushQueuedReceiptsToVault("bob", expenses);
  assert.equal(flushed, 0);
  assert.equal(calls.length, 0);
  assert.equal(expenses[0].receiptUrl, "data:image/jpeg;base64,QUJD");
  assert.equal(expenses[0].receiptVaultId, undefined);
});
