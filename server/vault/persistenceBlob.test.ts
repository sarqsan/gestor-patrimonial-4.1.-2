// Pruebas de la persistencia sobre el almacén remoto (Vercel Blob), con un puerto en memoria
// que reproduce el comportamiento del almacén: objetos por ruta, sobrescritura controlada y
// persistencia entre instancias del backend.
//
// Lo que se demuestra aquí:
//  1. Los datos viven en el almacén remoto, no en el sistema de ficheros (nueva instancia del
//     backend = mismos datos, sin depender de ningún directorio local).
//  2. Aislamiento estricto entre cuentas en todas las entidades.
//  3. Integridad SHA-256 verificada por el servidor, también en las subidas directas.
//  4. Sin destino remoto, las escrituras fallan de forma explícita (nunca falso éxito).
// Ejecutar con: npm test
import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHash } from "node:crypto";

import { createApiApp } from "../apiApp.js";
import {
  BlobVaultPersistence,
  UnconfiguredVaultPersistence,
  FsVaultPersistence,
  selectVaultPersistence,
} from "./persistence.js";
import type { BlobObjectInfo, BlobPort, PresignedPut } from "./persistenceTypes.js";
import { MemoryBlobPort } from "./memoryBlobPort.js";

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------
/** Servidores abiertos por las pruebas: se cierran siempre, aunque una aserción falle. */
const openServers: Server[] = [];

async function startApp(port: BlobPort): Promise<{ server: Server; base: string; stop: () => Promise<void> }> {
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  process.env.VERCEL = "1"; // nunca debe usarse el sistema de ficheros
  process.env.RENTASYNC_VAULT_DIR = "/tmp/no-se-usa-en-vercel";

  // El almacén remoto simulado se inyecta explícitamente (misma ruta de código que producción).
  const app = createApiApp({ vaultPersistence: new BlobVaultPersistence(port) });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  openServers.push(server);
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    server,
    base,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    },
  };
}

async function json(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function registerAndLogin(base: string, user: string, password: string): Promise<string> {
  await json(base, "POST", "/api/vault/auth/register", { username: user, password });
  const login = await json(base, "POST", "/api/vault/auth/login", { username: user, password });
  assert.equal(login.status, 200);
  return login.body.token as string;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------
// 1. Persistencia remota real (no hay ningún directorio local implicado)
// ---------------------------------------------------------------------------
test("P1. Los datos viven en el almacén remoto: instancias nuevas del backend los recuperan", async () => {
  const port = new MemoryBlobPort();

  // --- primera ejecución del backend ---
  const first = await startApp(port);
  const token1 = await registerAndLogin(first.base, "cuenta_remota", "clave_r_1");
  const bytes = new TextEncoder().encode("%PDF-1.4 recibo sintético de prueba");
  const upload = await json(
    first.base,
    "POST",
    "/api/vault/files",
    { name: "recibo.pdf", contentType: "application/pdf", bytesBase64: Buffer.from(bytes).toString("base64"), movementId: "mov_1", propertyId: "prop_1" },
    token1
  );
  assert.equal(upload.status, 201);
  assert.equal(upload.body.file.sha256, sha(bytes), "el servidor calcula el SHA-256 del contenido");
  assert.equal(upload.body.file.blobPathname, undefined, "la ruta interna del almacén no se expone al cliente");
  const fileId = upload.body.file.id as string;
  assert.equal((await json(first.base, "PUT", "/api/vault/movimientos", { movements: [{ id: "mov_1", amount: 10, date: "2026-05-01" }] }, token1)).status, 200);
  await json(first.base, "POST", "/api/vault/backups", { id: "backup_p1", portfolio: { properties: [{ id: "prop_1" }] } }, token1);
  await first.stop();

  // --- segunda ejecución: proceso y objetos de aplicación NUEVOS, mismo almacén remoto ---
  const second = await startApp(port);
  const login2 = await json(second.base, "POST", "/api/vault/auth/login", { username: "cuenta_remota", password: "clave_r_1" });
  assert.equal(login2.status, 200, "la cuenta persiste en el almacén remoto");
  const token2 = login2.body.token as string;

  const download = await fetch(`${second.base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${token2}` } });
  assert.equal(download.status, 200);
  assert.equal(sha(new Uint8Array(await download.arrayBuffer())), sha(bytes), "el documento se recupera íntegro tras reiniciar el backend");
  assert.equal(download.headers.get("x-vault-sha256"), sha(bytes));

  const movements = await json(second.base, "GET", "/api/vault/movimientos", undefined, token2);
  assert.deepEqual((movements.body.movements as any[]).map((m) => m.id), ["mov_1"]);
  const backup = await json(second.base, "GET", "/api/vault/backups/backup_p1", undefined, token2);
  assert.equal(backup.status, 200);
  assert.equal((backup.body.portfolio as any).properties[0].id, "prop_1");

  // Trazabilidad de las operaciones relevantes (solo identificadores y metadatos técnicos)
  const audit = await json(second.base, "GET", "/api/vault/audit", undefined, token2);
  const actions = (audit.body.events as any[]).map((e) => e.action);
  assert.ok(actions.includes("file.upload") && actions.includes("file.download") && actions.includes("backup.create"), `auditoría incompleta: ${actions}`);
  assert.ok(!JSON.stringify(audit.body.events).includes("%PDF-1.4"), "la auditoría no contiene contenido de los documentos");

  await second.stop();
});

// ---------------------------------------------------------------------------
// 2. Aislamiento entre cuentas
// ---------------------------------------------------------------------------
test("P2. Aislamiento estricto: ninguna entidad de una cuenta es accesible desde otra", async () => {
  const port = new MemoryBlobPort();
  const { base, stop } = await startApp(port);
  const tokenA = await registerAndLogin(base, "titular_a", "clave_a_1");
  const tokenB = await registerAndLogin(base, "titular_b", "clave_b_1");
  const bytes = new TextEncoder().encode("documento de A");

  const up = await json(base, "POST", "/api/vault/files", { name: "a.pdf", contentType: "application/pdf", bytesBase64: Buffer.from(bytes).toString("base64") }, tokenA);
  const fileId = up.body.file.id as string;
  await json(base, "PUT", "/api/vault/movimientos", { movements: [{ id: "mov_a", amount: 1, date: "2026-01-01" }] }, tokenA);
  await json(base, "POST", "/api/vault/backups", { id: "backup_a", portfolio: { secreto: "de A" } }, tokenA);

  const readAsB = await fetch(`${base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(readAsB.status, 404, "B no puede descargar el documento de A");
  assert.equal((await json(base, "GET", "/api/vault/files", undefined, tokenB)).body.files.length, 0);
  assert.equal((await json(base, "GET", "/api/vault/movimientos", undefined, tokenB)).body.movements.length, 0);
  assert.equal((await json(base, "GET", "/api/vault/backups/backup_a", undefined, tokenB)).status, 404);
  const auditB = (await json(base, "GET", "/api/vault/audit", undefined, tokenB)).body.events as any[];
  assert.ok(auditB.length > 0, "B tiene su propia trazabilidad");
  assert.ok(auditB.every((e) => e.actor === "titular_b" && e.target !== fileId), "la trazabilidad de A no es visible para B");
  const auditA = (await json(base, "GET", "/api/vault/audit", undefined, tokenA)).body.events as any[];
  assert.ok(auditA.some((e) => e.target === fileId), "A ve sus propias operaciones sobre el documento");

  // El objeto remoto de A sigue intacto y accesible para A.
  const readAsA = await fetch(`${base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(readAsA.status, 200);

  // Rutas manipuladas y tokens inválidos
  assert.equal((await fetch(`${base}/api/vault/files/../../vault/users/titular_a/account.json`, { headers: { authorization: `Bearer ${tokenA}` } })).status, 404);
  assert.equal((await json(base, "GET", "/api/vault/files", undefined, "token-falso")).status, 401);
  await stop();
});

// ---------------------------------------------------------------------------
// 3. Subida directa: firma acotada + integridad verificada por el servidor
// ---------------------------------------------------------------------------
test("P3. Subida directa: el servidor firma, descarga, recalcula el hash y solo entonces consolida", async () => {
  const port = new MemoryBlobPort();
  const { base, stop } = await startApp(port);
  const token = await registerAndLogin(base, "cuenta_directa", "clave_d_1");
  const bytes = new TextEncoder().encode("%PDF-1.4 contrato sintético de prueba");

  const presign = await json(
    base,
    "POST",
    "/api/vault/files/presign",
    { id: "file_directo_ensayo", sha256: sha(bytes), name: "contrato.pdf", contentType: "application/pdf", size: bytes.length, movementId: "mov_d" },
    token
  );
  assert.equal(presign.status, 201);
  const fileId = presign.body.fileId as string;
  assert.ok(presign.body.upload.url.startsWith("https://"), "se emite una URL firmada de subida");
  assert.equal(JSON.stringify(presign.body).includes("BLOB_READ_WRITE_TOKEN"), false, "el cliente no recibe credenciales del almacén");

  // Aún sin subir el contenido: la lectura no debe servir nada y el commit debe fallar.
  assert.equal((await fetch(`${base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  const earlyCommit = await json(base, "POST", `/api/vault/files/${fileId}/commit`, { size: bytes.length }, token);
  assert.equal(earlyCommit.status, 409, "sin archivo en el almacén la subida no se declara completada");

  // Hash incorrecto: NO se consolida, pero ningún objeto/reserva se borra.
  await port.directPut(`vault/users/cuenta_directa/contents/${fileId}`, bytes, "application/pdf");
  const badCommit = await json(base, "POST", `/api/vault/files/${fileId}/commit`, { size: bytes.length, sha256: "0".repeat(64) }, token);
  assert.equal(badCommit.status, 400);
  assert.ok(await port.head(`vault/users/cuenta_directa/contents/${fileId}`), "el archivo se conserva protegido, sin confirmarlo");
  const pendingFiles = (await json(base, "GET", "/api/vault/files", undefined, token)).body.files;
  assert.equal(pendingFiles.length, 1);
  assert.equal(pendingFiles[0].sha256, "");
  assert.equal((await fetch(`${base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${token}` } })).status, 404);

  // Reintento correcto (idempotente): misma reserva, contenido válido y hash correcto.
  const presign2 = await json(base, "POST", "/api/vault/files/presign", { id: fileId, sha256: sha(bytes), name: "contrato.pdf", contentType: "application/pdf", size: bytes.length, movementId: "mov_d" }, token);
  const fileId2 = presign2.body.fileId as string;
  assert.equal(fileId2, fileId, "reutiliza la reserva, no crea otro documento");
  assert.equal(presign2.body.readyToCommit, true, "no vuelve a subir un objeto ya íntegro");
  const commit = await json(base, "POST", `/api/vault/files/${fileId2}/commit`, { size: bytes.length, sha256: sha(bytes) }, token);
  assert.equal(commit.status, 200);
  assert.equal(commit.body.file.sha256, sha(bytes));

  const again = await json(base, "POST", `/api/vault/files/${fileId2}/commit`, { size: bytes.length, sha256: sha(bytes) }, token);
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyCommitted, true, "repetir la confirmación no duplica ni falla");

  const download = await fetch(`${base}/api/vault/files/${fileId2}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(sha(new Uint8Array(await download.arrayBuffer())), sha(bytes));
  await stop();
});

// ---------------------------------------------------------------------------
// 4. Integridad a la salida: si el objeto almacenado se altera, no se sirve
// ---------------------------------------------------------------------------
test("P4. Un objeto alterado en el almacén no se sirve (verificación de integridad a la salida)", async () => {
  const port = new MemoryBlobPort();
  const { base, stop } = await startApp(port);
  const token = await registerAndLogin(base, "cuenta_integridad", "clave_i_1");
  const bytes = new TextEncoder().encode("contenido original verificado");
  const up = await json(base, "POST", "/api/vault/files", { name: "d.pdf", contentType: "application/pdf", bytesBase64: Buffer.from(bytes).toString("base64") }, token);
  const fileId = up.body.file.id as string;

  // Alteración posterior del objeto en el almacén remoto (simulación de corrupción).
  await port.putBytes(`vault/users/cuenta_integridad/contents/${fileId}`, new TextEncoder().encode("contenido manipulado"), "application/pdf");

  const res = await fetch(`${base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 502, "no se entrega un archivo que no supera la verificación");
  await stop();
});

// ---------------------------------------------------------------------------
// 5. Sin destino remoto: nunca se escribe localmente ni se declara éxito
// ---------------------------------------------------------------------------
test("P5. Sin almacén remoto configurado, las escrituras fallan y las lecturas están vacías", async () => {
  const persistence = new UnconfiguredVaultPersistence();
  assert.equal(persistence.durable, false);
  assert.deepEqual(await persistence.getMovements("u"), []);
  assert.deepEqual(await persistence.listFiles("u"), []);
  assert.equal((await persistence.getUser("u")), null);
  await assert.rejects(() => persistence.putMovements("u", [{ id: "m1" }]), /no está configurado/i);
  await assert.rejects(() => persistence.writeFileBytes("u", "file_1", new Uint8Array([1]), "application/pdf"), /no está configurado/i);
  await assert.rejects(() => persistence.createUser("u", { salt: "s", hash: "h", createdAt: "x" }), /no está configurado/i);
  const probe = await persistence.probe();
  assert.equal(probe.ok, false);
});

test("P6. Selección de destino: en Vercel nunca se usa el sistema de ficheros", () => {
  const onVercelNoStore = selectVaultPersistence({ VERCEL: "1", RENTASYNC_VAULT_DIR: "/tmp/x" } as NodeJS.ProcessEnv);
  assert.equal(onVercelNoStore.driver, "unconfigured", "en Vercel sin almacén conectado no se usa un directorio efímero");

  const withToken = selectVaultPersistence({ VERCEL: "1", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fake" } as NodeJS.ProcessEnv, { blob: new MemoryBlobPort() });
  assert.equal(withToken.driver, "vercel-blob");
  assert.equal(withToken.durable, true);

  const local = selectVaultPersistence({ RENTASYNC_VAULT_DIR: "/tmp/vault-dev", NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.equal(local.driver, "fs");
  assert.equal(local.durable, false, "el directorio local se declara NO duradero");

  const injected = selectVaultPersistence({ VERCEL: "1" } as NodeJS.ProcessEnv, { blob: new MemoryBlobPort() });
  assert.equal(injected.driver, "vercel-blob");
});

test("P7. Persistencia sobre el almacén remoto: aislamiento por entidad y copias/auditoría", async () => {
  const port = new MemoryBlobPort();
  const a = new BlobVaultPersistence(port);
  const b = new BlobVaultPersistence(port); // nueva instancia = nueva ejecución del backend

  await a.createUser("u1", { salt: "s1", hash: "h1", createdAt: "t" });
  await a.putMovements("u1", [{ id: "m1", amount: 5 }, { id: "m2", amount: 7 }]);
  await a.writeFileBytes("u1", "file_x", new TextEncoder().encode("bytes de u1"), "application/pdf");
  await a.putFileMeta("u1", { id: "file_x", name: "x.pdf", contentType: "application/pdf", size: 11, sha256: "h", createdAt: "t" });
  await a.createBackup("u1", "backup_x", { datos: "de u1" });
  await a.appendAudit("u1", { id: "aud_1", at: "t", action: "file.upload", actor: "u1", ok: true });

  // Otra ejecución del backend (instancia b) ve lo mismo de u1 y NADA de u2.
  assert.equal((await b.getMovements("u1")).length, 2);
  assert.deepEqual((await b.getFileMeta("u1", "file_x"))?.name, "x.pdf");
  assert.equal(new TextDecoder().decode((await b.readFileBytes("u1", "file_x"))!), "bytes de u1");
  assert.deepEqual(await b.getBackup("u1", "backup_x"), { datos: "de u1" });
  assert.equal((await b.listAudit("u1", 10)).length, 1);
  assert.equal((await b.getMovements("u2")).length, 0);
  assert.equal((await b.getFileMeta("u2", "file_x")), null);
  assert.equal((await b.readFileBytes("u2", "file_x")), null);
  assert.equal((await b.getBackup("u2", "backup_x")), null);

  // Idempotencia: repetir una escritura no duplica entidades.
  await b.putMovements("u1", [{ id: "m1", amount: 5 }]);
  assert.equal((await b.getMovements("u1")).length, 2);
  assert.equal((await b.createUser("u1", { salt: "s2", hash: "h2", createdAt: "t" })), false, "no se re-crea una cuenta existente");

  // Borrado de una cuenta no afecta a las demás ni borra objetos ajenos.
  await a.deleteFileMeta("u1", "file_x");
  await a.deleteFileBytes("u1", "file_x");
  assert.equal(await b.getFileMeta("u1", "file_x"), null);
  assert.equal(await b.readFileBytes("u1", "file_x"), null);
});

test("P8. Sin almacén remoto real, la sonda informa del fallo (nunca 'todo correcto')", async () => {
  const brokenPort: BlobPort = {
    kind: "broken",
    head: async () => {
      throw new Error("almacén inaccesible (sintético)");
    },
    getBytes: async () => {
      throw new Error("almacén inaccesible (sintético)");
    },
    putBytes: async () => {
      throw new Error("almacén inaccesible (sintético)");
    },
    del: async () => undefined,
    list: async () => {
      throw new Error("almacén inaccesible (sintético)");
    },
  };
  const persistence = new BlobVaultPersistence(brokenPort);
  const probe = await persistence.probe();
  assert.equal(probe.ok, false);
  assert.match(String(probe.detail), /inaccesible/);
  await assert.rejects(() => persistence.putMovements("u", [{ id: "m" }]), /inaccesible/);
});

test("P9. El driver local de desarrollo sigue operativo (no se usa en Vercel)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vault-fs-"));
  const persistence = new FsVaultPersistence(dir);
  await persistence.createUser("dev", { salt: "s", hash: "h", createdAt: "t" });
  await persistence.putMovements("dev", [{ id: "m1" }]);
  const again = new FsVaultPersistence(dir);
  assert.equal((await again.getMovements("dev")).length, 1);
  assert.equal(again.durable, false);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

// Cierre garantizado de los servidores abiertos por las pruebas.
test.after(async () => {
  for (const server of openServers.splice(0, openServers.length)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});
